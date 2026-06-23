# Distributed Locks

## Overview

The system uses Redis-based distributed locks (Redlock algorithm) to prevent race conditions and ensure data consistency across multiple server instances.

## Why Distributed Locks?

In a distributed system with multiple server instances, race conditions can occur when:

- Multiple requests try to process the same transaction simultaneously
- Concurrent operations modify shared resources
- Workers compete for the same job

Distributed locks ensure only one process can access a critical section at a time.

## Implementation

The lock system is built on:

- **Redis**: Fast in-memory data store
- **Redlock**: Distributed lock algorithm with automatic retry and expiration

## Usage

### Basic Lock Acquisition

```typescript
import { lockManager, LockKeys } from "../utils/lock";

// Acquire lock
const lock = await lockManager.acquire("my-resource", 5000); // 5 second TTL

try {
  // Critical section - only one process can execute this
  await processTransaction();
} finally {
  // Always release the lock
  await lockManager.release(lock);
}
```

### Automatic Lock Management (Recommended)

```typescript
// Lock is automatically acquired and released
const result = await lockManager.withLock(
  "my-resource",
  async () => {
    // Critical section code
    return await processTransaction();
  },
  5000,
);
```

### Try Acquire (Non-blocking)

```typescript
// Returns null immediately if lock is not available
const lock = await lockManager.tryAcquire("my-resource", 5000);

if (lock) {
  try {
    await processTransaction();
  } finally {
    await lockManager.release(lock);
  }
} else {
  console.log("Resource is busy, try again later");
}
```

### Extending Lock Duration

```typescript
const lock = await lockManager.acquire("my-resource", 5000);

try {
  // Need more time...
  const extendedLock = await lockManager.extend(lock, 5000); // +5 seconds
  await longRunningOperation();
} finally {
  await lockManager.release(lock);
}
```

## Common Use Cases

### 1. Prevent Duplicate Transactions

```typescript
import { lockManager, LockKeys } from '../utils/lock';

async function createTransaction(phoneNumber: string, amount: string) {
  const lockKey = LockKeys.phoneNumber(phoneNumber);

  return await lockManager.withLock(lockKey, async () => {
    // Check for existing pending transaction
    const existing = await checkPendingTransaction(phoneNumber);
    if (existing) {
      throw new Error('Transaction already in progress');
    }

    // Create new transaction
    return await transactionModel.create({ phoneNumber, amount, ... });
  }, 15000);
}
```

### 2. Ensure Single Processing

```typescript
async function processTransaction(transactionId: string) {
  const lockKey = LockKeys.transaction(transactionId);

  return await lockManager.withLock(
    lockKey,
    async () => {
      const tx = await transactionModel.findById(transactionId);

      if (tx.status !== "pending") {
        throw new Error("Transaction already processed");
      }

      // Process transaction
      await mobileMoneyService.process(tx);
      await stellarService.process(tx);

      return await transactionModel.updateStatus(transactionId, "completed");
    },
    30000,
  );
}
```

### 3. Coordinate Distributed Workers

```typescript
async function processNextJob() {
  const jobId = await getNextJobId();
  const lockKey = `job:${jobId}`;

  const lock = await lockManager.tryAcquire(lockKey, 60000);

  if (!lock) {
    // Another worker is processing this job
    return null;
  }

  try {
    return await executeJob(jobId);
  } finally {
    await lockManager.release(lock);
  }
}
```

### 4. Generate Unique Reference Numbers

```typescript
async function generateReferenceNumber(): Promise<string> {
  const dateStr = getCurrentDateString();
  const lockKey = LockKeys.referenceNumber(dateStr);

  return await lockManager.withLock(
    lockKey,
    async () => {
      // Get next sequence number
      const sequence = await getNextSequence(dateStr);
      return `TXN-${dateStr}-${sequence}`;
    },
    3000,
  );
}
```

## Lock Key Helpers

Pre-defined lock key generators for consistency:

```typescript
import { LockKeys } from "../utils/lock";

LockKeys.transaction("123"); // 'transaction:123'
LockKeys.phoneNumber("+1234567890"); // 'phone:+1234567890'
LockKeys.referenceNumber("20260322"); // 'reference:20260322'
LockKeys.stellarAccount("GXXX..."); // 'stellar:GXXX...'
LockKeys.provider("mtn", "+123..."); // 'provider:mtn:+123...'
```

## Configuration

### Environment Variables

```env
REDIS_URL=redis://localhost:6379
```

### Lock Settings

- **Default TTL**: 10 seconds (auto-release if process crashes)
- **Retry Count**: 3 attempts
- **Retry Delay**: 200ms between attempts
- **Retry Jitter**: ±200ms randomization to prevent thundering herd

## Best Practices

1. **Always use try-finally**: Ensure locks are released even if errors occur
2. **Use withLock()**: Simplest and safest approach for most cases
3. **Set appropriate TTL**: Long enough for operation, short enough to recover from crashes
4. **Use specific lock keys**: Avoid locking more than necessary
5. **Handle lock failures**: Gracefully handle cases where lock cannot be acquired
6. **Monitor lock duration**: Log warnings if operations take longer than expected

## Error Handling

### Lock Acquisition Failure

```typescript
try {
  const lock = await lockManager.acquire("resource", 5000);
  // ...
} catch (error) {
  // Lock could not be acquired after retries
  return { error: "Resource is busy, please try again" };
}
```

### Lock Already Held

```typescript
const lock = await lockManager.tryAcquire("resource", 5000);

if (!lock) {
  return { error: "Operation already in progress" };
}
```

## Monitoring

Lock operations are automatically logged:

- Lock acquired: Resource name and TTL
- Lock released: Resource name
- Lock extended: Resource name and additional time
- Lock errors: Failure details

## Performance Considerations

- Locks add latency (typically 1-5ms for local Redis)
- Use locks only for critical sections
- Keep locked sections as short as possible
- Consider using tryAcquire() for non-critical operations

## Testing

When testing, you can mock the lock manager:

```typescript
jest.mock("../utils/lock", () => ({
  lockManager: {
    withLock: jest.fn(async (resource, fn) => fn()),
  },
}));
```

## Troubleshooting

### Locks Not Releasing

- Check Redis connection
- Verify TTL is set appropriately
- Ensure release() is called in finally block

### High Lock Contention

- Reduce lock scope (use more specific keys)
- Increase retry delay
- Consider queue-based approach for high-volume operations

### Redis Connection Issues

- Check REDIS_URL environment variable
- Verify Redis server is running
- Check network connectivity

