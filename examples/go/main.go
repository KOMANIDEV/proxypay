package main

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"os"
	"strings"
	"time"
)

var baseURL = getenv("PROXYPAY_URL", "http://localhost:3000")

func api(method, path, token string, body io.Reader, contentType string, out any) error {
	req, err := http.NewRequest(method, baseURL+path, body)
	if err != nil {
		return err
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode >= 300 {
		data, _ := io.ReadAll(res.Body)
		return fmt.Errorf("%s: %s", res.Status, data)
	}
	return json.NewDecoder(res.Body).Decode(out)
}

func uploadBatch(csv, token string) (map[string]any, error) {
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	part, err := writer.CreateFormFile("file", "transactions.csv")
	if err != nil {
		return nil, err
	}
	if _, err = part.Write([]byte(csv)); err != nil {
		return nil, err
	}
	writer.Close()
	var job struct {
		JobID string `json:"jobId"`
	}
	if err = api("POST", "/api/transactions/bulk", token, &body, writer.FormDataContentType(), &job); err != nil {
		return nil, err
	}
	var status map[string]any
	for {
		if err = api("GET", "/api/transactions/bulk/"+job.JobID+"/status", "", nil, "", &status); err != nil {
			return nil, err
		}
		if status["status"] == "completed" || status["status"] == "failed" {
			return status, nil
		}
		time.Sleep(500 * time.Millisecond)
	}
}

func verifyWebhook(rawBody []byte, signature, secret string) bool {
	if !strings.HasPrefix(signature, "sha256=") {
		return false
	}
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(rawBody)
	expected, err := hex.DecodeString(signature[7:])
	if err != nil {
		return false
	}
	return hmac.Equal(mac.Sum(nil), expected)
}

func main() {
	token := os.Getenv("PROXYPAY_TOKEN")
	csv := "amount,phoneNumber,provider,stellarAddress\n10,+237670000000,MTN,GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF\n"
	status, err := uploadBatch(csv, token)
	if err != nil {
		panic(err)
	}
	fmt.Println(status)
	var created struct {
		Subscription struct {
			ID string `json:"id"`
		} `json:"subscription"`
	}
	payload := strings.NewReader(`{"amount":"25.00","currency":"USD","interval":"monthly","phone_number":"+237670000000"}`)
	if err = api("POST", "/api/subscriptions", token, payload, "application/json", &created); err != nil {
		panic(err)
	}
	var paused map[string]any
	if err = api("POST", "/api/subscriptions/"+created.Subscription.ID+"/pause", token, nil, "", &paused); err != nil {
		panic(err)
	}
	fmt.Println(paused)
}

func getenv(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}
