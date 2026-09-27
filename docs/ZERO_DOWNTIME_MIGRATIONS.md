# Zero-Downtime Database Migration Architecture

## Overview

ProxyPay implements an Expand-Contract (Blue-Green dual-write) migration pattern to execute schema evolutions and data model refactors without operational downtime.

---

## 1. Five-Phase Expand-Contract Lifecycle

```
Phase 1: Expand (Add new nullable column/table)
Phase 2: Dual-Write (Application writes to both old and new schema)
Phase 3: Backfill (Background batch job migrates historical rows)
Phase 4: Dual-Read & Validate (Verify parity between old and new stores)
Phase 5: Contract (Application drops read/write to old schema; remove old columns)
```

---

## 2. Dual-Write Management

During Phase 2 & 3, the `ZeroDowntimeMigrationService`:
- Dispatches writes synchronously to primary schema.
- Mirrors writes asynchronously to secondary schema with retry queues.
- Emits parity metrics and logs delta violations.

---

## 3. Automated Rollback Safeguards

If validation errors or dual-write parity failures exceed 0.01%:
1. Automatic dual-write bypass is triggered.
2. System rolls back read traffic to primary schema.
3. Alert dispatched to PagerDuty with root cause report.
