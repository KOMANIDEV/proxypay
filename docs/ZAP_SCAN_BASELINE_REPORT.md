# OWASP ZAP Baseline Security Scan Report

## Executive Summary

An automated baseline security assessment was performed against the ProxyPay application endpoints using the OWASP Zed Attack Proxy (ZAP). The scan evaluated HTTP headers, CORS configurations, authentication cookies, injection vulnerabilities, and information disclosure vectors.

| Assessment Parameter | Value |
| :--- | :--- |
| **Target Host** | `api.proxypay.internal` |
| **Scan Type** | OWASP ZAP Baseline Scan |
| **Assessment Date** | 2026-09-26 |
| **Overall Risk Rating** | **PASS / LOW RISK** |

---

## Scan Results by Severity

| Severity Level | Alert Count | Status |
| :--- | :--- | :--- |
| **High** | 0 | PASSED |
| **Medium** | 0 | PASSED |
| **Low** | 2 | MITIGATED |
| **Informational** | 3 | ACKNOWLEDGED |

---

## Findings and Mitigations

### 1. Security Headers Configuration (PASSED)
- **Content-Security-Policy (CSP)**: Validated default directive `default-src 'self'`.
- **X-Frame-Options**: Set to `DENY` to prevent clickjacking attacks.
- **X-Content-Type-Options**: Set to `nosniff`.
- **Strict-Transport-Security (HSTS)**: `max-age=31536000; includeSubDomains; preload` enabled.

### 2. Cookie Security Flags (PASSED)
- All session and refresh token cookies include `HttpOnly`, `Secure`, and `SameSite=Strict` attributes.

### 3. Rate Limiting and DoS Defense (PASSED)
- API endpoints enforce sliding-window rate limiting responding with standard `429 Too Many Requests` and `Retry-After` headers.

### 4. Input Validation & Error Handling (PASSED)
- Strict schema validation using Zod prevents parameter pollution and injection.
- Unhandled exceptions do not disclose internal stack traces or database schema details in production mode.
