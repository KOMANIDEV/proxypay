# Distributed Locks Setup Guide

## Installation

### 1. Install Dependencies

```bash
npm install redis@^4.6.12 redlock@^5.0.0-beta.2
npm install --save-dev @types/redis@^4.0.11
```

### 2. Configure Environment

Add to your `.env` file:

```env
REDIS_URL=redis://localhost:6379
```

### 3. Start Redis

Using Docker Compose (recommended):

```bash
docker-compose up -d redis
```

Or install Redis locally:

```bash
# Ubuntu/Debian
sudo apt-get install redis-server

# macOS
brew install redis
brew services start redis
```

### 4. Verify Redis Connection

```bash
redis-cli ping
# Should return: PONG
```

## Quick Start

The lock system is automatically initialized when the server starts. No additional setup required.

## Testing Locks

### Test Lock Acquisition

```typescript
import { lockManager } from "./utils/lock";

// Test basic lock
const lock = await lockManager.acquire("test-resource", 5000);
console.log("Lock acquired!");
await lockManager.release(lock);
console.log("Lock released!");
```

### Test Race Condition Prevention

Run this code in multiple terminals simultaneously:

```typescript
import { lockManager } from "./utils/lock";

async function testRaceCondition() {
  await lockManager.withLock(
    "shared-resource",
    async () => {
      console.log("Process started:", process.pid);
      await new Promise((resolve) => setTimeout(resolve, 2000));
      console.log("Process finished:", process.pid);
    },
    5000,
  );
}

testRaceCondition();
```

Only one process will execute at a time, others will wait.

## Troubleshooting

### Redis Connection Failed

- Verify Redis is running: `redis-cli ping`
- Check REDIS_URL in .env
- Ensure port 6379 is not blocked

### Lock Acquisition Timeout

- Increase TTL value
- Check if locks are being released properly
- Monitor Redis: `redis-cli KEYS "locks:*"`

### Locks Not Releasing

- Ensure release() is in finally block
- Check TTL is appropriate for operation
- Locks auto-expire after TTL

## Monitoring

### View Active Locks

```bash
redis-cli KEYS "locks:*"
```

### Check Lock Details

```bash
redis-cli GET "locks:transaction:123"
```

### Clear All Locks (Development Only)

```bash
redis-cli FLUSHDB
```

## Next Steps

- Review [DISTRIBUTED_LOCKS.md](./DISTRIBUTED_LOCKS.md) for usage patterns
- Implement locks in critical sections
- Monitor lock performance in production

