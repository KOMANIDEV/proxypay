# Mobile-Optimized API Response Format Guide

## Overview

The ProxyPay API supports mobile-optimized payloads to reduce bandwidth consumption and latency over low-connectivity mobile networks.

---

## 1. Automatic Detection & Headers

Clients can declare mobile requests via:
- `X-Client-Type: mobile` HTTP header
- `User-Agent` containing standard mobile identifiers
- Query parameter: `?mobile=true`

Optimized responses include the header:
```http
X-Mobile-Optimized: true
Content-Encoding: gzip (or br)
```

---

## 2. Field Selection (`?fields=...`)

Mobile clients can request only the fields they need using sparse fieldsets:

```http
GET /api/v1/transactions?fields=id,amount,status,reference_number
```

**Response:**
```json
{
  "data": [
    {
      "id": "tx_123",
      "amount": "100.00",
      "status": "completed",
      "reference_number": "REF-9921"
    }
  ]
}
```

---

## 3. Minimal Compact Mode (`?minimal=true`)

Requesting `?minimal=true` strips verbose debug timelines, raw logs, and internal metadata, reducing payload size by up to 75%.
