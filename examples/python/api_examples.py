"""ProxyPay batch, webhook, and subscription examples. Python 3.10+."""

import hashlib
import hmac
import json
import os
import time
import urllib.request

BASE_URL = os.getenv("PROXYPAY_URL", "http://localhost:3000")


def request(method: str, path: str, token: str | None = None, body: bytes | None = None, content_type: str | None = None):
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    if content_type:
        headers["Content-Type"] = content_type
    req = urllib.request.Request(BASE_URL + path, data=body, headers=headers, method=method)
    with urllib.request.urlopen(req) as response:
        return json.loads(response.read())


def upload_batch(csv_text: str, token: str):
    boundary = "proxypay-example-boundary"
    multipart = (f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"transactions.csv\"\r\nContent-Type: text/csv\r\n\r\n{csv_text}\r\n--{boundary}--\r\n").encode()
    job = request("POST", "/api/transactions/bulk", token, multipart, f"multipart/form-data; boundary={boundary}")
    while True:
        status = request("GET", f"/api/transactions/bulk/{job['jobId']}/status")
        if status["status"] in ("completed", "failed"):
            return status
        time.sleep(0.5)


def verify_webhook(raw_body: bytes, signature: str | None, secret: str) -> bool:
    if not signature or not signature.startswith("sha256="):
        return False
    expected = hmac.new(secret.encode(), raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(signature[7:], expected)


def create_subscription(token: str):
    payload = json.dumps({"amount": "25.00", "currency": "USD", "interval": "monthly", "phone_number": "+237670000000"}).encode()
    return request("POST", "/api/subscriptions", token, payload, "application/json")["subscription"]


def pause_subscription(subscription_id: str, token: str):
    return request("POST", f"/api/subscriptions/{subscription_id}/pause", token)


if __name__ == "__main__":
    token = os.environ["PROXYPAY_TOKEN"]
    csv = "amount,phoneNumber,provider,stellarAddress\n10,+237670000000,MTN,GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF\n"
    print(upload_batch(csv, token))
    subscription = create_subscription(token)
    print(pause_subscription(subscription["id"], token))
