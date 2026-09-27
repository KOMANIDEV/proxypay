# PII Data Encryption Transparency & Best Practices Guide

## Overview

This document provides complete transparency into Personally Identifiable Information (PII) data encryption across ProxyPay systems. It outlines which fields are encrypted, encryption algorithms used, automatic field detection rules, and security guidelines for handling sensitive data.

---

## 1. Encrypted Fields Catalog

| Data Entity | Field Name | Classification | Encryption Standard | Storage Target |
|-------------|------------|----------------|---------------------|----------------|
| User / Merchant | `tax_id` / `ssn` | High Sensitivity | AES-256-GCM | Encrypted Column |
| User / Merchant | `bank_account_number` | High Sensitivity | AES-256-GCM | Encrypted Column |
| User / Merchant | `routing_number` | Medium Sensitivity | AES-256-GCM | Encrypted Column |
| User / Merchant | `phone_number` | Medium Sensitivity | Deterministic AES / Blind Index | Hash + Ciphertext |
| User / Merchant | `email` | Medium Sensitivity | Deterministic AES / Blind Index | Hash + Ciphertext |
| User / Merchant | `date_of_birth` | Medium Sensitivity | AES-256-GCM | Encrypted Column |
| User / Merchant | `government_id_document` | Critical | Envelope Encryption (KMS) | S3 Encrypted Bucket |
| Transactions | `recipient_account` | High Sensitivity | AES-256-GCM | Encrypted Column |
| Transactions | `memo_text_sensitive` | Medium Sensitivity | AES-256-GCM | Encrypted Column |

---

## 2. Transparency Indicators in API & UI

To ensure customers and compliance reviewers can audit encryption status:
- All sensitive API objects return an `_encryptionStatus` metadata block when requested.
- Fields indicate:
  - `status`: `"encrypted"` | `"masked"` | `"plaintext"`
  - `algorithm`: e.g. `"AES-256-GCM"`
  - `keyVersion`: Active KMS Key rotation identifier
  - `lastRotatedAt`: Timestamp of latest key rotation

---

## 3. PII Auto-Detection Engine

ProxyPay uses regex pattern heuristics and dictionary checks to automatically flag unencrypted PII strings before write:
- **SSN / Tax ID**: Patterns matching `^\d{3}-\d{2}-\d{4}$` or 9 continuous digits.
- **Credit Card / IBAN**: Luhn-validated card numbers, IBAN format checks.
- **Phone Numbers**: E.164 phone formats.
- **Email Addresses**: RFC 5322 compliant regex patterns.

---

## 4. Encryption Best Practices

1. **Envelope Encryption**: Use AWS KMS or HashiCorp Vault to wrap data encryption keys (DEKs).
2. **Never Log Sensitive PII**: Use structured loggers that strip known PII keys automatically.
3. **Key Rotation**: Rotate DEKs every 90 days. Support dual-version decryption during re-encryption windows.
4. **Blind Indexing**: Store cryptographic HMAC hashes with secret salt to support exact-match searches without decrypting the entire database.
