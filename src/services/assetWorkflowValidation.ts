/**
 * Validation rules for asset issuance/configuration requests (issue #571).
 *
 * Kept separate from `AssetWorkflowService` so the rules can be unit-tested
 * without a database and reused by callers that only want to pre-check input.
 */
import { StrKey } from "stellar-sdk";

/** Stellar asset codes: 1-12 alphanumeric, but anything shorter than 3 is a
 *  typo magnet, so the workflow requires 3-12 (Stellar's own docs use 3+). */
export const ASSET_CODE_MIN_LENGTH = 3;
export const ASSET_CODE_MAX_LENGTH = 12;

/** The native asset is not issuable — `XLM` must never reach trustline setup. */
const RESERVED_ASSET_CODES = new Set(["XLM"]);

const ASSET_CODE_PATTERN = /^[A-Za-z0-9]+$/;

export interface AssetConfigurationInput {
  assetCode: string;
  name: string;
  limit: string;
  /** Issuer account that will sign the asset; validated when provided. */
  issuerPublicKey?: string | null;
  /** Destination (distribution) account that receives the trustline. */
  distributionAccount?: string | null;
  description?: string;
}

export interface AssetConfigurationValidation {
  isValid: boolean;
  errors: string[];
  warnings: string[];
}

export function isValidAssetCode(assetCode: unknown): boolean {
  return (
    typeof assetCode === "string" &&
    assetCode.length >= ASSET_CODE_MIN_LENGTH &&
    assetCode.length <= ASSET_CODE_MAX_LENGTH &&
    ASSET_CODE_PATTERN.test(assetCode)
  );
}

export function isValidStellarAccount(account: unknown): boolean {
  return typeof account === "string" && StrKey.isValidEd25519PublicKey(account);
}

/** Issuers explicitly allowed to issue assets, from ASSET_ISSUER_WHITELIST. */
export function getApprovedIssuers(): string[] {
  return (process.env.ASSET_ISSUER_WHITELIST || "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

/**
 * The whitelist is enforced on mainnet/production (or when explicitly turned
 * on) and advisory elsewhere, so testnet flows are not blocked by config that
 * only exists in production.
 */
export function isIssuerWhitelistEnforced(): boolean {
  if (process.env.ASSET_ISSUER_WHITELIST_ENFORCED === "true") return true;
  if (process.env.ASSET_ISSUER_WHITELIST_ENFORCED === "false") return false;
  return (
    process.env.NODE_ENV === "production" ||
    process.env.STELLAR_NETWORK === "mainnet"
  );
}

export function isIssuerApproved(
  issuerPublicKey: string,
  approved: string[] = getApprovedIssuers(),
): boolean {
  return approved.includes(issuerPublicKey);
}

function isPositiveDecimal(value: string): boolean {
  if (typeof value !== "string" || value.trim() === "") return false;
  if (!/^\d+(\.\d+)?$/.test(value.trim())) return false;
  return Number(value) > 0;
}

export function validateAssetConfiguration(
  input: AssetConfigurationInput,
): AssetConfigurationValidation {
  const errors: string[] = [];
  const warnings: string[] = [];

  // --- asset code -----------------------------------------------------------
  const code = typeof input.assetCode === "string" ? input.assetCode : "";
  if (!code) {
    errors.push(
      `Asset code is required and must be ${ASSET_CODE_MIN_LENGTH}-${ASSET_CODE_MAX_LENGTH} alphanumeric characters`,
    );
  } else if (!ASSET_CODE_PATTERN.test(code)) {
    errors.push("Asset code must contain only alphanumeric characters (A-Z, a-z, 0-9)");
  } else if (
    code.length < ASSET_CODE_MIN_LENGTH ||
    code.length > ASSET_CODE_MAX_LENGTH
  ) {
    errors.push(
      `Asset code must be between ${ASSET_CODE_MIN_LENGTH} and ${ASSET_CODE_MAX_LENGTH} characters`,
    );
  } else if (RESERVED_ASSET_CODES.has(code.toUpperCase())) {
    errors.push("Asset code XLM is reserved for the native asset and cannot be issued");
  }

  // --- name -----------------------------------------------------------------
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name) {
    errors.push("Asset name is required");
  } else if (name.length > 100) {
    errors.push("Asset name must be at most 100 characters");
  } else if (/[\u0000-\u001f\u007f]/.test(name)) {
    errors.push("Asset name must not contain control characters");
  }

  // --- limit ----------------------------------------------------------------
  if (!isPositiveDecimal(input.limit)) {
    errors.push("Limit must be a positive number");
  } else {
    const limitNum = Number(input.limit);
    if (limitNum > 1_000_000_000_000) {
      errors.push("Limit exceeds the maximum supported asset supply (1e12)");
    } else if (limitNum > 1_000_000_000) {
      warnings.push("Limit is very high, please verify");
    }
    if (/\.\d{8,}$/.test(input.limit.trim())) {
      warnings.push("Limit has more than 7 decimal places and will be rounded");
    }
  }

  // --- issuer ---------------------------------------------------------------
  const issuer = input.issuerPublicKey ?? null;
  if (issuer) {
    if (!isValidStellarAccount(issuer)) {
      errors.push("Issuer account is not a valid Stellar public key");
    } else {
      const approved = getApprovedIssuers();
      if (!isIssuerApproved(issuer, approved)) {
        if (isIssuerWhitelistEnforced()) {
          errors.push(
            "Issuer account is not on the approved issuer whitelist for this environment",
          );
        } else {
          warnings.push("Issuer account is not on the approved issuer whitelist");
        }
      }
    }
  } else if (isIssuerWhitelistEnforced()) {
    warnings.push("No issuer account supplied; it will be generated at issuance time");
  }

  // --- distribution account -------------------------------------------------
  const distribution = input.distributionAccount ?? null;
  if (distribution) {
    if (!isValidStellarAccount(distribution)) {
      errors.push("Distribution account is not a valid Stellar public key");
    }
    if (issuer && distribution === issuer) {
      errors.push(
        "Distribution account must differ from the issuer account (a self-issued trustline is invalid)",
      );
    }
  }

  // --- description ----------------------------------------------------------
  if (
    input.description !== undefined &&
    typeof input.description === "string" &&
    input.description.length > 2000
  ) {
    errors.push("Description must be at most 2000 characters");
  }

  return { isValid: errors.length === 0, errors, warnings };
}

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterMs: number;
}

export interface AssetCreationRateLimiterOptions {
  /** Requests allowed per window (default 5, or ASSET_CREATION_RATE_LIMIT_MAX). */
  maxRequests?: number;
  /** Window size in ms (default 60000, or ASSET_CREATION_RATE_LIMIT_WINDOW_MS). */
  windowMs?: number;
  /** Clock injection for deterministic tests. */
  now?: () => number;
}

/**
 * In-memory sliding-window limiter keyed by requester.
 *
 * Deliberately not the Redis-backed express middleware: asset creation is a
 * low-volume, authenticated action and keeping the limiter inside the service
 * makes it enforceable from any caller (API, job, CLI) and testable without
 * Redis. A multi-instance deployment should swap the store for the shared one.
 */
export class AssetCreationRateLimiter {
  private readonly maxRequests: number;
  private readonly windowMs: number;
  private readonly now: () => number;
  private readonly hits = new Map<string, number[]>();

  constructor(options: AssetCreationRateLimiterOptions = {}) {
    const envMax = parseInt(process.env.ASSET_CREATION_RATE_LIMIT_MAX || "", 10);
    const envWindow = parseInt(
      process.env.ASSET_CREATION_RATE_LIMIT_WINDOW_MS || "",
      10,
    );
    this.maxRequests = options.maxRequests ?? (envMax > 0 ? envMax : 5);
    this.windowMs = options.windowMs ?? (envWindow > 0 ? envWindow : 60_000);
    this.now = options.now ?? Date.now;
  }

  /** Records an attempt and reports whether it is allowed. */
  consume(key: string): RateLimitResult {
    const now = this.now();
    const windowStart = now - this.windowMs;
    const recent = (this.hits.get(key) || []).filter((t) => t > windowStart);

    if (recent.length >= this.maxRequests) {
      this.hits.set(key, recent);
      const retryAfterMs = recent[0] + this.windowMs - now;
      return { allowed: false, remaining: 0, retryAfterMs: Math.max(retryAfterMs, 0) };
    }

    recent.push(now);
    this.hits.set(key, recent);
    return {
      allowed: true,
      remaining: this.maxRequests - recent.length,
      retryAfterMs: 0,
    };
  }

  reset(key?: string): void {
    if (key) {
      this.hits.delete(key);
      return;
    }
    this.hits.clear();
  }
}

export class AssetCreationRateLimitError extends Error {
  readonly retryAfterMs: number;

  constructor(retryAfterMs: number) {
    super(
      `Asset creation rate limit exceeded, retry in ${Math.ceil(retryAfterMs / 1000)}s`,
    );
    this.name = "AssetCreationRateLimitError";
    this.retryAfterMs = retryAfterMs;
  }
}

export class AssetConfigurationError extends Error {
  readonly errors: string[];
  readonly warnings: string[];

  constructor(errors: string[], warnings: string[] = []) {
    super(`Invalid asset configuration: ${errors.join(", ")}`);
    this.name = "AssetConfigurationError";
    this.errors = errors;
    this.warnings = warnings;
  }
}
