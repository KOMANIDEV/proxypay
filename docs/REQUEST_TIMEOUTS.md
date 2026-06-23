# Request Timeouts

## Overview

Request timeouts prevent long-running requests from consuming server resources indefinitely. The system implements configurable timeouts at both global and per-route levels.

## Configuration

### Environment Variable

```env
REQUEST_TIMEOUT_MS=30000  # 30 seconds (default)
```

### Global Timeout

All requests are subject to the global timeout unless overridden at the route level.

```typescript
// Configured in src/index.ts
app.use(globalTimeout);
app.use(haltOnTimedout);
```

### Per-Route Timeout

Individual routes can override the global timeout:

```typescript
import {
  TimeoutPresets,
  customTimeout,
  haltOnTimedout,
} from "../middleware/timeout";

// Using presets
router.post("/quick-operation", TimeoutPresets.quick, haltOnTimedout, handler);
router.post(
  "/standard-operation",
  TimeoutPresets.standard,
  haltOnTimedout,
  handler,
);
router.post("/long-operation", TimeoutPresets.long, haltOnTimedout, handler);
router.post(
  "/batch-operation",
  TimeoutPresets.extended,
  haltOnTimedout,
  handler,
);

// Custom timeout
router.post("/custom", customTimeout(45000), haltOnTimedout, handler);
```

## Timeout Presets

| Preset   | Duration   | Use Case                                 |
| -------- | ---------- | ---------------------------------------- |
| quick    | 5 seconds  | Simple queries, health checks            |
| standard | 30 seconds | Default operations                       |
| long     | 60 seconds | Complex transactions, external API calls |
| extended | 2 minutes  | Batch operations, reports                |

## Response Format

When a request times out, the server returns:

```json
{
  "error": "Request Timeout",
  "message": "The request took too long to process",
  "code": "REQUEST_TIMEOUT"
}
```

HTTP Status: `408 Request Timeout`

## Implementation Details

### Middleware Order

```typescript
app.use(timeout("30s")); // 1. Set timeout
app.use(haltOnTimedout); // 2. Check timeout before each middleware
app.use(express.json()); // 3. Your middleware
app.use(haltOnTimedout); // 4. Check timeout again
app.use("/api", routes); // 5. Routes
app.use(timeoutErrorHandler); // 6. Handle timeout errors
app.use(errorHandler); // 7. General error handler
```

### Timeout Checking

The `haltOnTimedout` middleware should be placed:

- After the timeout middleware
- Before route handlers
- Between middleware that might take time

This prevents timed-out requests from continuing through the middleware chain.

## Logging

Timeout events are automatically logged with:

- HTTP method
- Request URL
- Client IP address
- Timestamp

Example log:

```
Request timeout: {
  method: 'POST',
  url: '/api/transactions/deposit',
  ip: '192.168.1.100',
  timestamp: '2026-03-23T10:30:45.123Z'
}
```

## Best Practices

### 1. Set Appropriate Timeouts

```typescript
// Too short - may timeout legitimate requests
router.post("/complex", customTimeout(1000), handler); // ❌

// Appropriate - allows time for external APIs
router.post("/complex", customTimeout(60000), handler); // ✅
```

### 2. Handle Timeouts in Client Code

```typescript
try {
  const response = await fetch("/api/transactions/deposit", {
    method: "POST",
    body: JSON.stringify(data),
    headers: { "Content-Type": "application/json" },
  });

  if (response.status === 408) {
    // Handle timeout
    console.error("Request timed out, please try again");
  }
} catch (error) {
  console.error("Request failed:", error);
}
```

### 3. Clean Up Resources

```typescript
export const handler = async (req: Request, res: Response) => {
  const cleanup = () => {
    // Release locks, close connections, etc.
  };

  req.on("timeout", cleanup);

  try {
    await processRequest(req);
    res.json({ success: true });
  } catch (error) {
    cleanup();
    throw error;
  }
};
```

### 4. Monitor Timeout Rates

Track timeout occurrences to identify:

- Routes that need longer timeouts
- Performance bottlenecks
- External API issues

## Route-Specific Examples

### Transaction Routes

```typescript
// Long timeout for deposit (external API + blockchain)
router.post("/deposit", TimeoutPresets.long, haltOnTimedout, depositHandler);

// Long timeout for withdraw
router.post("/withdraw", TimeoutPresets.long, haltOnTimedout, withdrawHandler);

// Quick timeout for reads
router.get("/:id", TimeoutPresets.quick, haltOnTimedout, getTransactionHandler);
```

### Custom Timeouts

```typescript
// Very long operation
router.post(
  "/batch-process",
  customTimeout(180000),
  haltOnTimedout,
  batchHandler,
);

// Quick health check
router.get("/health", customTimeout(2000), haltOnTimedout, healthHandler);
```

## Testing Timeouts

### Simulate Slow Operation

```typescript
app.get(
  "/test-timeout",
  customTimeout(2000),
  haltOnTimedout,
  async (req, res) => {
    // This will timeout after 2 seconds
    await new Promise((resolve) => setTimeout(resolve, 5000));
    res.json({ message: "This will never be sent" });
  },
);
```

### Test with curl

```bash
# Should timeout after configured duration
curl -X POST http://localhost:3000/api/test-timeout
```

## Troubleshooting

### Requests Timing Out Too Quickly

- Increase `REQUEST_TIMEOUT_MS` in .env
- Use per-route timeout for specific endpoints
- Check for slow database queries or external APIs

### Timeouts Not Working

- Verify timeout middleware is before route handlers
- Ensure `haltOnTimedout` is used after timeout middleware
- Check middleware order in index.ts

### 408 Not Returned

- Ensure `timeoutErrorHandler` is before general error handler
- Verify response hasn't been sent before timeout

## Performance Impact

- Minimal overhead (< 1ms per request)
- Prevents resource exhaustion from hanging requests
- Improves overall system reliability

## Production Recommendations

- Set conservative timeouts (30-60 seconds)
- Monitor timeout rates in logs
- Alert on high timeout rates (> 5%)
- Use longer timeouts for known slow operations
- Implement retry logic in clients for timeout errors

