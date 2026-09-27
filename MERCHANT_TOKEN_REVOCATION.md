# Token Revocation Implementation for Merchant Portal

## Overview

Implemented a comprehensive token revocation system to prevent compromised merchant portal tokens from remaining valid after rotation. This addresses the critical security issue where old tokens would remain valid indefinitely after being rotated.

## Problem Statement

Previously, merchant portal tokens could be rotated, but old tokens remained valid. Compromised tokens never expired, creating a security vulnerability.

## Solution Architecture

### 1. Token Revocation Service (`src/services/tokenRevocationService.ts`)

Core service managing revocation list in Redis with the following operations:

#### Key Functions:

- **`isTokenRevoked(tokenId: string): Promise<boolean>`**
  - Checks if a token has been added to the revocation list
  - Returns false if Redis is unavailable (fail-open)
  - Used before allowing any token-based request

- **`revokeToken(tokenId, merchantId, expiresAt, reason, type): Promise<void>`**
  - Adds token to revocation list with automatic TTL
  - TTL = token expiration time + 60-second buffer
  - Tracks reason for revocation (rotation, manual_revoke, compromise, other)
  - Maintains audit trail in merchant's revoked token set

- **`getMerchantRevokedTokens(merchantId): Promise<Array>`**
  - Returns all revoked tokens for a merchant
  - Used for audit and compliance purposes

- **`revokeAllMerchantTokens(merchantId, reason): Promise<void>`**
  - Revokes all tokens for a merchant
  - Useful for account compromise scenarios

- **`manuallyRevokeToken(tokenId, merchantId, expiresAt, reason): Promise<void>`**
  - Allows manual revocation if token is suspected to be compromised

#### Redis Structure:

```
token:revoked:{tokenId}
  - Stores: { tokenId, type, merchantId, revokedAt, reason }
  - TTL: Token expiration + 60 seconds

merchant:tokens:{merchantId}
  - Set of all revoked tokens for merchant
  - TTL: Token expiration + 60 seconds
```

### 2. Merchant Portal Service Updates (`src/services/merchantPortalService.ts`)

Enhanced the existing service with revocation support:

#### Modified Functions:

- **`verifyPortalToken(token: string): Promise<PortalTokenPayload | null>`**
  - Changed to async to support revocation checking
  - Returns null if token is in revocation list
  - Maintains existing signature validation

#### New Functions:

- **`rotatePortalToken(merchantId, oldTokenJti, oldTokenExp, options): Promise<PortalUrlResult>`**
  - Atomically revokes old token and generates new one
  - Ensures token belongs to merchant before rotation
  - Returns new portal URL with updated expiration

### 3. Portal Token Revocation Middleware (`src/middleware/portalTokenRevocation.ts`)

Validates tokens aren't revoked before processing requests:

#### Key Middleware:

- **`verifyPortalTokenNotRevoked(req, res, next)`**
  - Extracted tokens from multiple sources:
    - Authorization header (Bearer scheme)
    - x-portal-token header
    - Query parameter (?token=)
  - Returns 401 Unauthorized if token is revoked
  - Gracefully continues if token parsing fails or Redis is down

- **`attachPortalTokenId(req, res, next)`**
  - Extracts and attaches token ID (jti) to request
  - Attaches merchant ID for audit logging
  - Silently ignores errors to avoid blocking requests

### 4. Routes Enhancement (`src/routes/merchantPortal.ts`)

Added new endpoint for token rotation:

#### POST `/merchants/:id/portal-url/rotate`

- Accepts old token in request body
- Validates old token is valid and belongs to merchant
- Revokes old token and generates new one
- Returns new portal URL

Example Request:

```json
{
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "expirySeconds": 3600
}
```

Example Response:

```json
{
  "portalUrl": "https://portal.proxypay.app/session?token=...",
  "expiresAt": "2026-09-27T09:59:42.082Z",
  "merchantId": "m1",
  "message": "Token rotated successfully"
}
```

## Implementation Details

### Token Lifecycle

1. **Generation**: Token created with unique ID (jti) and expiration
2. **Use**: Token verified, checked against revocation list
3. **Rotation**: Old token added to revocation list, new token generated
4. **Expiration**: Token automatically removed from revocation list after TTL
5. **Compromise**: Token manually revoked if suspected compromise

### Security Properties

- **Atomic Operations**: Revocation happens immediately before new token issued
- **TTL Management**: Tokens auto-expire from revocation list when legitimate TTL passes
- **Audit Trail**: All revocations tracked with reason and timestamp
- **Graceful Degradation**: Service continues if Redis unavailable (fail-open)
- **No Duplicate Revocation**: Redis handles duplicate revocation idempotently

### Performance Characteristics

- **Redis Check**: Single lookup per request (~1ms)
- **Memory**: Each revoked token ~200 bytes in Redis
- **Automatic Cleanup**: TTL prevents memory bloat
- **Horizontal Scaling**: Shared Redis revocation list across all instances

## Testing

Comprehensive test coverage with 38 tests across three test files:

### tokenRevocationService.test.ts (17 tests)

- `isTokenRevoked`: 4 tests (normal, revoked, Redis down, error)
- `revokeToken`: 4 tests (TTL calculation, Redis unavailable, tracking, reasons)
- `getMerchantRevokedTokens`: 4 tests (empty, populated, Redis down, error)
- `manuallyRevokeToken`: 1 test
- `revokeAllMerchantTokens`: 2 tests
- `clearRevokedToken`: 2 tests

### portalTokenRevocation.test.ts (13 tests)

- `verifyPortalTokenNotRevoked`: 7 tests
  - No token present
  - Non-revoked token allowed through
  - Revoked token returns 401
  - Multiple token sources (Bearer, header, query)
  - Error handling
- `attachPortalTokenId`: 6 tests
  - Token extraction from multiple sources
  - Silent error handling

### merchantPortalService.test.ts (8 tests)

- `generatePortalUrl`: 2 tests
- `verifyPortalToken`: 4 tests (including revocation check)
- `rotatePortalToken`: 2 tests (basic rotation, custom expiry)

All tests passing: **38/38 ✓**

## Usage Examples

### Generate Portal URL

```typescript
const result = await generatePortalUrl("merchant-123");
// Returns: { url, token, expiresAt, merchantId }
```

### Verify Token (with revocation check)

```typescript
const payload = await verifyPortalToken(token);
if (!payload) {
  // Token invalid, expired, or revoked
}
```

### Rotate Token

```typescript
const newResult = await rotatePortalToken(
  merchantId,
  oldTokenPayload.jti,
  oldTokenPayload.exp,
  { expirySeconds: 3600 },
);
// Old token automatically revoked
// Returns: { url: new_portal_url, ... }
```

### Check Revocation Status

```typescript
const isRevoked = await isTokenRevoked(tokenId);
if (isRevoked) {
  // Token is in revocation list
}
```

### Manually Revoke Token

```typescript
await manuallyRevokeToken(
  tokenId,
  merchantId,
  expiresAt,
  "User reported token compromised",
);
```

## Acceptance Criteria

✅ **Implement token revocation on rotation**

- New `rotatePortalToken` function revokes old token before issuing new one
- Atomic operation ensures security

✅ **Add revocation list to Redis**

- Revocation list stored in Redis with keys: `token:revoked:{tokenId}`
- Audit trail in: `merchant:tokens:{merchantId}`
- TTL automatically manages cleanup

✅ **Check revocation list on every request**

- `verifyPortalTokenNotRevoked` middleware checks revocation before processing
- Integrated into token verification flow
- Returns 401 Unauthorized if revoked

## Backward Compatibility

- Existing `generatePortalUrl` function remains unchanged
- Existing `consumePortalToken` function remains unchanged
- `verifyPortalToken` now async (must update all callers)
- New middleware can be optionally added to routes

## Deployment Notes

1. **Redis Required**: Revocation list requires Redis (uses existing deployment)
2. **No Database Schema Changes**: Revocation tracked entirely in Redis
3. **Gradual Rollout**: Can enable revocation check middleware per-route
4. **Monitoring**: Watch Redis memory usage for revoked token accumulation (auto-cleanup via TTL)

## Future Enhancements

1. **Dashboard**: Admin UI to view/manage revoked tokens per merchant
2. **Metrics**: Prometheus metrics for revocation rates
3. **Notifications**: Alert merchant of token revocation events
4. **Bulk Operations**: Revoke multiple tokens/merchants in one operation
5. **Token Versioning**: Support multiple active tokens per merchant

## Files Modified

- ✅ `src/services/tokenRevocationService.ts` - New revocation service
- ✅ `src/middleware/portalTokenRevocation.ts` - New revocation middleware
- ✅ `src/services/merchantPortalService.ts` - Updated for revocation
- ✅ `src/routes/merchantPortal.ts` - Added rotation endpoint
- ✅ `src/services/__tests__/tokenRevocationService.test.ts` - New test suite
- ✅ `src/middleware/__tests__/portalTokenRevocation.test.ts` - New test suite
- ✅ `src/services/__tests__/merchantPortalService.test.ts` - Updated tests
