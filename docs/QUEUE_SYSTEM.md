# Queue System Documentation

This document describes the queue system implemented using BullMQ for reliable asynchronous transaction processing.

## Overview

The queue system provides:

- **Reliable Processing**: Jobs are persisted in Redis and processed asynchronously
- **Automatic Retries**: Failed jobs are automatically retried up to 3 times with exponential backoff
- **Progress Tracking**: Real-time job progress updates
- **Monitoring Dashboard**: Bull Board UI for queue monitoring
- **Health Checks**: Queue health status endpoint

## Architecture

```
┌─────────────┐     ┌──────────────┐     ┌─────────────┐
│  API Layer  │────▶│  BullMQ      │────▶│  Worker     │
│  (Express) │     │  Queue       │     │  (Processor)│
└─────────────┘     └──────────────┘     └─────────────┘
                          │
                    ┌─────┴─────┐
                    │  Redis    │
                    │  (Backend)│
                    └───────────┘
```

## Queue Files

| File                                                             | Description                                   |
| ---------------------------------------------------------------- | --------------------------------------------- |
| [`src/queue/config.ts`](src/queue/config.ts)                     | Queue configuration and Redis connection      |
| [`src/queue/transactionQueue.ts`](src/queue/transactionQueue.ts) | Queue definition and job management functions |
| [`src/queue/worker.ts`](src/queue/worker.ts)                     | Worker that processes jobs                    |
| [`src/queue/dashboard.ts`](src/queue/dashboard.ts)               | Bull Board dashboard integration              |
| [`src/queue/health.ts`](src/queue/health.ts)                     | Queue health check endpoints                  |
| [`src/queue/index.ts`](src/queue/index.ts)                       | Public exports                                |

## Usage

### Adding a Transaction Job

```typescript
import { addTransactionJob } from "./queue";

const job = await addTransactionJob({
  transactionId: "tx-123",
  type: "deposit",
  amount: "100",
  phoneNumber: "+1234567890",
  provider: "mtn",
  stellarAddress: "GABC123...",
});

// Get job ID for tracking
console.log("Job ID:", job.id);
```

### Checking Job Progress

```typescript
import { getJobProgress } from "./queue";

const progress = await getJobProgress("job-id");
console.log(`Progress: ${progress}%`);
```

### Getting Queue Stats

```typescript
import { getQueueStats } from "./queue";

const stats = await getQueueStats();
console.log(stats);
// { waiting: 5, active: 2, completed: 100, failed: 3, isPaused: false }
```

## API Endpoints

| Method | Endpoint               | Description             |
| ------ | ---------------------- | ----------------------- |
| GET    | `/health/queue`        | Get queue health status |
| POST   | `/admin/queues/pause`  | Pause the queue         |
| POST   | `/admin/queues/resume` | Resume the queue        |
| GET    | `/admin/queues`        | Bull Board dashboard    |

## Configuration

### Queue Options

The queue is configured with the following default options:

```typescript
{
  attempts: 3,              // Retry up to 3 times
  backoff: {
    type: 'exponential',   // Exponential backoff
    delay: 2000,           // Start with 2 second delay
  },
  removeOnComplete: {
    count: 1000,            // Keep last 1000 completed
    age: 24 * 3600,         // Keep for 24 hours
  },
  removeOnFail: {
    count: 5000,            // Keep last 5000 failed
    age: 7 * 24 * 3600,     // Keep for 7 days
  },
}
```

### Worker Options

- **Concurrency**: 5 concurrent jobs
- **Rate Limiter**: Max 10 jobs per second

## Job Processing

### Deposit Flow

1. Job created with 10% progress
2. Mobile money payment initiated (20% progress)
3. Payment result processed (50% progress)
4. Stellar payment sent (70% progress)
5. Transaction status updated to completed (90% progress)
6. Job marked complete (100% progress)

### Withdraw Flow

1. Job created with 10% progress
2. Mobile money payout initiated (20% progress)
3. Payout result processed (50% progress)
4. Transaction status updated to completed (90% progress)
5. Job marked complete (100% progress)

## Error Handling

### Automatic Retries

Failed jobs are automatically retried with exponential backoff:

- Attempt 1: After 2 seconds
- Attempt 2: After 4 seconds
- Attempt 3: After 8 seconds

### Manual Retry

Failed jobs can be manually retried via the dashboard or API.

## Monitoring

### Bull Board Dashboard

Access the dashboard at `/admin/queues` to:

- View all queues (waiting, active, completed, failed)
- View individual job details
- Retry failed jobs
- Clean old jobs
- Pause/resume queues

### Health Check

The `/health/queue` endpoint returns:

```json
{
  "status": "healthy",
  "timestamp": "2024-01-01T00:00:00.000Z",
  "queue": "transaction-processing",
  "stats": {
    "waiting": 5,
    "active": 2,
    "completed": 100,
    "failed": 3,
    "paused": false
  }
}
```

## Integration with Transaction Controller

The transaction controller has been updated to use the queue:

```typescript
// Deposit - adds job to queue instead of processing immediately
const result = await addTransactionJob({
  transactionId: transaction.id,
  type: "deposit",
  amount,
  phoneNumber,
  provider,
  stellarAddress,
});

// Response includes job ID for progress tracking
res.json({
  transactionId,
  referenceNumber,
  status: "pending",
  jobId: job.id,
});
```

## Acceptance Criteria Status

- ✅ Queue works - BullMQ queue with Redis backend
- ✅ Reliable processing - Jobs persisted in Redis
- ✅ Retry logic - 3 attempts with exponential backoff
- ✅ Documented - This documentation file

## Dependencies

- `bullmq` - Queue processing
- `@bull-board/api` - Dashboard API
- `@bull-board/express` - Dashboard Express adapter
- `ioredis` - Redis client for BullMQ

