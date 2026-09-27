# Scheduled Jobs

Scheduled background jobs run automatically when the server starts, powered by [node-cron](https://github.com/node-cron/node-cron).

## Jobs

| Job                       | Default Schedule               | Description                                                                      |
| ------------------------- | ------------------------------ | -------------------------------------------------------------------------------- |
| `cleanup`                 | `0 2 * * *` (daily 2 AM)       | Deletes completed/failed transactions older than `LOG_RETENTION_DAYS`            |
| `report`                  | `0 6 * * *` (daily 6 AM)       | Logs a summary of the previous day's transactions                                |
| `status-check`            | `0 * * * *` (every hour)       | Warns about pending transactions stuck longer than `STUCK_TRANSACTION_MINUTES`   |
| `index-reindex`           | `0 3 * * *` (daily 3 AM)       | Reindexes bloated indexes using `REINDEX INDEX CONCURRENTLY` during low traffic  |
| `encryption-key-rotation` | `0 4 * * 0` (weekly, Sun 4 AM) | Validates the PII key ring and re-encrypts data when a new key version is active |

## Configuration

All jobs are configurable via environment variables:

```env
# Override cron schedules
CLEANUP_CRON=0 2 * * *
REPORT_CRON=0 6 * * *
STATUS_CHECK_CRON=0 * * * *
INDEX_REINDEX_CRON=0 3 * * *
ENCRYPTION_KEY_ROTATION_CRON=0 4 * * 0

# Cleanup retention period in days (default: 90)
LOG_RETENTION_DAYS=90

# Minutes before a pending transaction is flagged as stuck (default: 60)
STUCK_TRANSACTION_MINUTES=60

# Encryption key rotation (see docs/ENCRYPTION_KEY_ROTATION.md)
ENCRYPTION_KEY_ROTATION_INTERVAL_DAYS=90
ENCRYPTION_KEY_AUTO_MIGRATE=false
```

## File Structure

```
src/jobs/
├── scheduler.ts       # Registers and starts all cron jobs
├── cleanupJob.ts      # Deletes old terminal-state transactions
├── reportJob.ts       # Generates daily transaction summary
├── statusCheckJob.ts  # Detects stuck pending transactions
└── keyRotationJob.ts  # Watches the PII key ring and triggers re-encryption
```

## Error Handling

Each job runs inside a try/catch. Failures are logged with `console.error` and do not crash the server or affect other jobs.
