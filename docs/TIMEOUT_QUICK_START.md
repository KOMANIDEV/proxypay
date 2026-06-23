# Request Timeout Quick Start

## Installation

```bash
npm install connect-timeout@^1.9.0
npm install --save-dev @types/connect-timeout@^0.0.38
```

## Basic Setup

### 1. Configure Environment

Add to `.env`:

```env
REQUEST_TIMEOUT_MS=30000
```

### 2. Apply Global Timeout

Already configured in `src/index.ts`:

```typescript
import {
  globalTimeout,
  haltOnTimedout,
  timeoutErrorHandler,
} from "./middleware/timeout";

app.use(globalTimeout);
app.use(haltOnTimedout);
// ... your routes ...
app.use(timeoutErrorHandler);
```

### 3. Override Per Route

```typescript
import { TimeoutPresets, haltOnTimedout } from "../middleware/timeout";

// 5 second timeout
router.get("/quick", TimeoutPresets.quick, haltOnTimedout, handler);

// 60 second timeout
router.post("/long", TimeoutPresets.long, haltOnTimedout, handler);

// Custom timeout
import { customTimeout } from "../middleware/timeout";
router.post("/custom", customTimeout(45000), haltOnTimedout, handler);
```

## Available Presets

- `TimeoutPresets.quick` - 5 seconds
- `TimeoutPresets.standard` - 30 seconds
- `TimeoutPresets.long` - 60 seconds
- `TimeoutPresets.extended` - 120 seconds

## Response on Timeout

```json
{
  "error": "Request Timeout",
  "message": "The request took too long to process",
  "code": "REQUEST_TIMEOUT"
}
```

Status: `408 Request Timeout`

## Testing

```bash
# Start server
npm run dev

# Test timeout (should return 408 after configured time)
curl -X POST http://localhost:3000/api/transactions/deposit \
  -H "Content-Type: application/json" \
  -d '{"amount":"100","phoneNumber":"+1234567890","provider":"mtn","stellarAddress":"GXXX..."}'
```

## Common Issues

**Timeout not working?**

- Check middleware order (timeout must be before routes)
- Ensure `haltOnTimedout` is used
- Verify `timeoutErrorHandler` is before general error handler

**Requests timing out too fast?**

- Increase `REQUEST_TIMEOUT_MS` in .env
- Use longer preset for specific routes
- Check for slow operations (database, external APIs)

For more details, see [REQUEST_TIMEOUTS.md](./REQUEST_TIMEOUTS.md)

