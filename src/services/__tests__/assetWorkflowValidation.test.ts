import {
  ASSET_CODE_MAX_LENGTH,
  ASSET_CODE_MIN_LENGTH,
  AssetCreationRateLimiter,
  AssetCreationRateLimitError,
  getApprovedIssuers,
  isIssuerApproved,
  isIssuerWhitelistEnforced,
  isValidAssetCode,
  isValidStellarAccount,
  validateAssetConfiguration,
} from "../assetWorkflowValidation";

import { Keypair } from "stellar-sdk";

// Generated rather than hardcoded: StrKey validates the checksum, so a made-up
// "G..." string is not a public key at all.
const ISSUER = Keypair.random().publicKey();
const DISTRIBUTION = Keypair.random().publicKey();
const UNAPPROVED_ISSUER = Keypair.random().publicKey();

const base = { assetCode: "USD", name: "USD Coin", limit: "1000000" };

describe("assetWorkflowValidation — asset code", () => {
  it("accepts 3-12 alphanumeric codes", () => {
    for (const code of ["USD", "USDCOIN", "ABCDEFGHIJKL", "USDC2"]) {
      expect(isValidAssetCode(code)).toBe(true);
      expect(validateAssetConfiguration({ ...base, assetCode: code }).isValid).toBe(true);
    }
  });

  it("rejects codes shorter than the Stellar minimum of 3", () => {
    for (const code of ["", "U", "US"]) {
      const result = validateAssetConfiguration({ ...base, assetCode: code });
      expect(result.isValid).toBe(false);
      expect(result.errors.join(" ")).toMatch(
        new RegExp(`${ASSET_CODE_MIN_LENGTH}-${ASSET_CODE_MAX_LENGTH}|between ${ASSET_CODE_MIN_LENGTH} and ${ASSET_CODE_MAX_LENGTH}`),
      );
    }
  });

  it("rejects codes longer than 12 characters", () => {
    const result = validateAssetConfiguration({ ...base, assetCode: "ABCDEFGHIJKLM" });
    expect(result.isValid).toBe(false);
    expect(result.errors.join(" ")).toMatch(/between 3 and 12/);
  });

  it("rejects non-alphanumeric and unicode codes", () => {
    for (const code of ["US-D", "USD ", "USD$", "ÜSD", "USD\u0000", "usd\u200b"]) {
      const result = validateAssetConfiguration({ ...base, assetCode: code });
      expect(result.isValid).toBe(false);
    }
  });

  it("rejects the reserved native asset code in any casing", () => {
    for (const code of ["XLM", "xlm"]) {
      const result = validateAssetConfiguration({ ...base, assetCode: code });
      expect(result.isValid).toBe(false);
      expect(result.errors.join(" ")).toMatch(/reserved/i);
    }
  });
});

describe("assetWorkflowValidation — name and limit", () => {
  it("requires a non-blank name and rejects control characters", () => {
    expect(validateAssetConfiguration({ ...base, name: "   " }).isValid).toBe(false);
    expect(validateAssetConfiguration({ ...base, name: "bad\u0007name" }).errors.join(" ")).toMatch(
      /control characters/,
    );
    expect(validateAssetConfiguration({ ...base, name: "x".repeat(101) }).isValid).toBe(false);
  });

  it("accepts only positive decimal limits", () => {
    for (const limit of ["0", "-1", "", "abc", "1e5", "Infinity", "10,5"]) {
      const result = validateAssetConfiguration({ ...base, limit });
      expect(result.isValid).toBe(false);
      expect(result.errors).toContain("Limit must be a positive number");
    }
    for (const limit of ["1", "0.0000001", "1000000", "999999999.9"]) {
      expect(validateAssetConfiguration({ ...base, limit }).isValid).toBe(true);
    }
  });

  it("warns on very large limits and rejects supplies above 1e12", () => {
    const warned = validateAssetConfiguration({ ...base, limit: "5000000000" });
    expect(warned.isValid).toBe(true);
    expect(warned.warnings.join(" ")).toMatch(/very high/);

    const tooBig = validateAssetConfiguration({ ...base, limit: "1000000000001" });
    expect(tooBig.isValid).toBe(false);
  });

  it("warns when the limit carries more precision than Stellar stores", () => {
    const result = validateAssetConfiguration({ ...base, limit: "1.12345678" });
    expect(result.warnings.join(" ")).toMatch(/decimal places/);
  });
});

describe("assetWorkflowValidation — accounts", () => {
  it("validates Stellar public keys only", () => {
    expect(isValidStellarAccount(ISSUER)).toBe(true);
    for (const bad of ["", "not-a-key", ISSUER.toLowerCase(), ISSUER.slice(0, -1), null, undefined, 42]) {
      expect(isValidStellarAccount(bad as unknown)).toBe(false);
    }
  });

  it("rejects an invalid issuer account", () => {
    const result = validateAssetConfiguration({ ...base, issuerPublicKey: "GINVALID" });
    expect(result.isValid).toBe(false);
    expect(result.errors.join(" ")).toMatch(/issuer account is not a valid Stellar public key/i);
  });

  it("rejects an invalid distribution account", () => {
    const result = validateAssetConfiguration({ ...base, distributionAccount: "GDISTRIBUTION" });
    expect(result.isValid).toBe(false);
    expect(result.errors.join(" ")).toMatch(/distribution account is not a valid Stellar public key/i);
  });

  it("rejects a distribution account equal to the issuer", () => {
    const result = validateAssetConfiguration({
      ...base,
      issuerPublicKey: ISSUER,
      distributionAccount: ISSUER,
    });
    expect(result.isValid).toBe(false);
    expect(result.errors.join(" ")).toMatch(/must differ from the issuer/i);
  });

  it("warns (but allows) an issuer missing from the whitelist outside production", () => {
    const previous = { ...process.env };
    delete process.env.STELLAR_NETWORK;
    process.env.NODE_ENV = "test";
    process.env.ASSET_ISSUER_WHITELIST = DISTRIBUTION;

    try {
      expect(isIssuerWhitelistEnforced()).toBe(false);
      const result = validateAssetConfiguration({ ...base, issuerPublicKey: ISSUER });
      expect(result.isValid).toBe(true);
      expect(result.warnings.join(" ")).toMatch(/not on the approved issuer whitelist/);
    } finally {
      process.env = previous;
    }
  });

  it("blocks an unapproved issuer in production and allows a whitelisted one", () => {
    const previous = { ...process.env };
    process.env.NODE_ENV = "production";
    process.env.ASSET_ISSUER_WHITELIST = `${DISTRIBUTION}, ${ISSUER}`;

    try {
      expect(isIssuerWhitelistEnforced()).toBe(true);
      expect(getApprovedIssuers()).toEqual([DISTRIBUTION, ISSUER]);
      expect(isIssuerApproved(ISSUER)).toBe(true);
      expect(isIssuerApproved(UNAPPROVED_ISSUER)).toBe(false);

      const blocked = validateAssetConfiguration({ ...base, issuerPublicKey: UNAPPROVED_ISSUER });
      expect(blocked.isValid).toBe(false);
      expect(blocked.errors.join(" ")).toMatch(/whitelist/);

      expect(validateAssetConfiguration({ ...base, issuerPublicKey: ISSUER }).isValid).toBe(true);
    } finally {
      process.env = previous;
    }
  });

  it("enforces the whitelist on mainnet even when NODE_ENV is not production", () => {
    const previous = { ...process.env };
    process.env.NODE_ENV = "test";
    process.env.STELLAR_NETWORK = "mainnet";
    process.env.ASSET_ISSUER_WHITELIST = DISTRIBUTION;

    try {
      expect(isIssuerWhitelistEnforced()).toBe(true);
      expect(validateAssetConfiguration({ ...base, issuerPublicKey: ISSUER }).isValid).toBe(false);
    } finally {
      process.env = previous;
    }
  });
});

describe("AssetCreationRateLimiter", () => {
  let time = 0;
  const limiter = () =>
    new AssetCreationRateLimiter({ maxRequests: 3, windowMs: 60_000, now: () => time });

  beforeEach(() => {
    time = 1_000;
  });

  it("allows exactly maxRequests inside the window and then blocks with a retry hint", () => {
    const rl = limiter();
    for (let i = 1; i <= 3; i++) {
      const result = rl.consume("user-1");
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(3 - i);
    }

    const blocked = rl.consume("user-1");
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterMs).toBeGreaterThan(0);
    expect(blocked.retryAfterMs).toBeLessThanOrEqual(60_000);
  });

  it("lets the caller through again once the oldest hit leaves the window", () => {
    const rl = limiter();
    rl.consume("user-1");
    const later = 60_500;
    const rl2 = new AssetCreationRateLimiter({ maxRequests: 1, windowMs: 60_000, now: () => later });
    expect(rl2.consume("user-1").allowed).toBe(true);
    expect(rl2.consume("user-1").allowed).toBe(false);
  });

  it("slides: a fresh attempt after the window is allowed again", () => {
    let clock = 0;
    const rl = new AssetCreationRateLimiter({ maxRequests: 1, windowMs: 1_000, now: () => clock });
    expect(rl.consume("u").allowed).toBe(true);
    expect(rl.consume("u").allowed).toBe(false);
    clock = 1_001;
    expect(rl.consume("u").allowed).toBe(true);
  });

  it("keeps per-requester buckets independent", () => {
    const rl = limiter();
    expect(rl.consume("user-a").allowed).toBe(true);
    expect(rl.consume("user-a").allowed).toBe(true);
    expect(rl.consume("user-a").allowed).toBe(true);
    expect(rl.consume("user-a").allowed).toBe(false);
    expect(rl.consume("user-b").allowed).toBe(true);
  });

  it("reset() clears one bucket or all of them", () => {
    const rl = limiter();
    rl.consume("a");
    rl.consume("b");
    rl.reset("a");
    expect(rl.consume("a").remaining).toBe(2);
    rl.reset();
    expect(rl.consume("b").remaining).toBe(2);
  });

  it("reads its defaults from the environment", () => {
    const previous = { ...process.env };
    process.env.ASSET_CREATION_RATE_LIMIT_MAX = "1";
    process.env.ASSET_CREATION_RATE_LIMIT_WINDOW_MS = "1000";
    try {
      const rl = new AssetCreationRateLimiter({ now: () => 0 });
      expect(rl.consume("k").allowed).toBe(true);
      expect(rl.consume("k").allowed).toBe(false);
    } finally {
      process.env = previous;
    }
  });

  it("exposes the retry delay through the error type", () => {
    const error = new AssetCreationRateLimitError(4_500);
    expect(error.name).toBe("AssetCreationRateLimitError");
    expect(error.retryAfterMs).toBe(4_500);
    expect(error.message).toMatch(/retry in 5s/);
  });
});