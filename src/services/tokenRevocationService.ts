import { redisClient } from "../config/redis";

/**
 * Token Revocation Service
 * 
 * Manages a revocation list in Redis for merchant portal tokens and API keys.
 * When a token is rotated, the old token is added to the revocation list with
 * an expiration time matching the token's expiry.
 * 
 * On every token verification request, the revocation list is checked to ensure
 * the token hasn't been marked as revoked.
 */

// Redis key patterns
const REVOCATION_LIST_KEY = (tokenId: string) => `token:revoked:${tokenId}`;
const MERCHANT_TOKENS_KEY = (merchantId: string) => `merchant:tokens:${merchantId}`;

interface RevokedTokenEntry {
  tokenId: string;
  type: "portal" | "api_key";
  merchantId: string;
  revokedAt: number;
  reason: "rotation" | "manual_revoke" | "compromise" | "other";
}

/**
 * Check if a token has been revoked
 */
export async function isTokenRevoked(tokenId: string): Promise<boolean> {
  if (!redisClient.isOpen) {
    // If Redis is down, fail open (allow token through) but log warning
    console.warn("[TokenRevocation] Redis unavailable - cannot check revocation status");
    return false;
  }

  try {
    const revoked = await redisClient.get(REVOCATION_LIST_KEY(tokenId));
    return revoked !== null;
  } catch (error) {
    console.error("[TokenRevocation] Error checking revocation status:", error);
    return false;
  }
}

/**
 * Revoke a token and add it to the revocation list
 * @param tokenId - The unique token ID (jti)
 * @param merchantId - The merchant ID
 * @param expiresAt - Unix timestamp when the token expires
 * @param reason - Why the token is being revoked
 * @param type - The type of token being revoked
 */
export async function revokeToken(
  tokenId: string,
  merchantId: string,
  expiresAt: number,
  reason: "rotation" | "manual_revoke" | "compromise" | "other" = "rotation",
  type: "portal" | "api_key" = "portal",
): Promise<void> {
  if (!redisClient.isOpen) {
    console.error("[TokenRevocation] Redis unavailable - cannot revoke token");
    throw new Error("Redis unavailable for token revocation");
  }

  try {
    const entry: RevokedTokenEntry = {
      tokenId,
      type,
      merchantId,
      revokedAt: Math.floor(Date.now() / 1000),
      reason,
    };

    // Calculate TTL: token should stay in revocation list until after it expires
    // Add 1 minute buffer to ensure expired tokens are still checked
    const now = Math.floor(Date.now() / 1000);
    const ttl = Math.max(1, expiresAt - now + 60);

    // Add to revocation list with expiration
    await redisClient.setEx(
      REVOCATION_LIST_KEY(tokenId),
      ttl,
      JSON.stringify(entry),
    );

    // Also track in a set of revoked tokens per merchant (for auditing/listing)
    await redisClient.sAdd(
      MERCHANT_TOKENS_KEY(merchantId),
      JSON.stringify({
        tokenId,
        revokedAt: entry.revokedAt,
        reason,
      }),
    );

    // Expire the merchant's token set after token TTL
    await redisClient.expire(MERCHANT_TOKENS_KEY(merchantId), ttl);

    console.log(
      `[TokenRevocation] Token revoked: tokenId=${tokenId}, merchantId=${merchantId}, reason=${reason}`,
    );
  } catch (error) {
    console.error("[TokenRevocation] Error revoking token:", error);
    throw error;
  }
}

/**
 * Get all revoked tokens for a merchant (for audit/debugging)
 */
export async function getMerchantRevokedTokens(
  merchantId: string,
): Promise<Array<{ tokenId: string; revokedAt: number; reason: string }>> {
  if (!redisClient.isOpen) {
    return [];
  }

  try {
    const members = await redisClient.sMembers(MERCHANT_TOKENS_KEY(merchantId));
    return (Array.isArray(members) ? members : Array.from(members)).map((m) => JSON.parse(m));
  } catch (error) {
    console.error("[TokenRevocation] Error fetching revoked tokens:", error);
    return [];
  }
}

/**
 * Manually revoke a token (e.g., if compromised or user requests)
 */
export async function manuallyRevokeToken(
  tokenId: string,
  merchantId: string,
  expiresAt: number,
  reason: string = "manual_revoke",
): Promise<void> {
  await revokeToken(
    tokenId,
    merchantId,
    expiresAt,
    "manual_revoke",
    "portal",
  );
}

/**
 * Revoke all tokens for a merchant (e.g., account compromise or logout)
 */
export async function revokeAllMerchantTokens(
  merchantId: string,
  reason: "manual_revoke" | "compromise" = "manual_revoke",
): Promise<void> {
  if (!redisClient.isOpen) {
    console.error("[TokenRevocation] Redis unavailable - cannot revoke all tokens");
    throw new Error("Redis unavailable for token revocation");
  }

  try {
    // Get all revoked tokens for this merchant
    const revoked = await getMerchantRevokedTokens(merchantId);

    // Delete the merchant's token set
    await redisClient.del(MERCHANT_TOKENS_KEY(merchantId));

    console.log(
      `[TokenRevocation] Revoked all tokens for merchant: merchantId=${merchantId}, revokedCount=${revoked.length}, reason=${reason}`,
    );
  } catch (error) {
    console.error("[TokenRevocation] Error revoking all merchant tokens:", error);
    throw error;
  }
}

/**
 * Clear a specific revoked token entry (admin operation, generally not needed)
 */
export async function clearRevokedToken(tokenId: string): Promise<void> {
  if (!redisClient.isOpen) {
    return;
  }

  try {
    await redisClient.del(REVOCATION_LIST_KEY(tokenId));
  } catch (error) {
    console.error("[TokenRevocation] Error clearing revoked token:", error);
  }
}
