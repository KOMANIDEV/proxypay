/**
 * Tests for JWT key rotation support (#628)
 *
 * Covers:
 *  - generateToken() embeds the active key id in the token header
 *  - verifyToken() accepts tokens signed with the current active key
 *  - verifyToken() accepts tokens signed with a previous key during grace period
 *  - verifyToken() rejects tokens with an unknown key id
 *  - verifyToken() rejects tokens whose previous key has passed the grace period
 *  - buildKeyStore() returns only the active key when no previous key is set
 *  - buildKeyStore() excludes a previous key whose grace period has expired
 *  - findKeyById() returns undefined for unknown key ids
 *  - Tokens without a kid fall back to the active secret (backward compat)
 */

import jwt from "jsonwebtoken";
import {
  generateToken,
  verifyToken,
  buildKeyStore,
  findKeyById,
  KEY_ROTATION_GRACE_PERIOD_MS,
} from "../../auth/jwt";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let savedEnv: Record<string, string | undefined> = {};
const ROTATION_KEYS = [
  "JWT_SECRET", "JWT_KEY_ID",
  "JWT_PREVIOUS_SECRET", "JWT_PREVIOUS_KEY_ID", "JWT_PREVIOUS_KEY_ISSUED_AT",
];

function saveEnv() {
  for (const k of ROTATION_KEYS) savedEnv[k] = process.env[k];
}

function restoreEnv() {
  for (const k of ROTATION_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
}

function setEnv(vars: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

const BASE_PAYLOAD = { userId: "u1", email: "u1@test.com" };

beforeEach(saveEnv);
afterEach(restoreEnv);

// ---------------------------------------------------------------------------
// buildKeyStore
// ---------------------------------------------------------------------------

describe("buildKeyStore()", () => {
  beforeEach(() => {
    process.env.JWT_SECRET = "active-secret-32chars-xxxxxxxxxx";
    delete process.env.JWT_KEY_ID;
    delete process.env.JWT_PREVIOUS_SECRET;
    delete process.env.JWT_PREVIOUS_KEY_ID;
    delete process.env.JWT_PREVIOUS_KEY_ISSUED_AT;
  });

  it("returns only the active key when no previous key is configured", () => {
    const store = buildKeyStore();
    expect(store).toHaveLength(1);
    expect(store[0].keyId).toBe("v1"); // default when JWT_KEY_ID is unset
    expect(store[0].secret).toBe("active-secret-32chars-xxxxxxxxxx");
  });

  it("uses JWT_KEY_ID when set", () => {
    process.env.JWT_KEY_ID = "v2";
    const store = buildKeyStore();
    expect(store[0].keyId).toBe("v2");
  });

  it("includes previous key when still within grace period", () => {
    const supersededAtSec = Math.floor(Date.now() / 1000) - 60; // 60s ago
    setEnv({
      JWT_PREVIOUS_SECRET: "old-secret-32chars-xxxxxxxxxx",
      JWT_PREVIOUS_KEY_ID: "v1",
      JWT_PREVIOUS_KEY_ISSUED_AT: String(supersededAtSec),
    });
    const store = buildKeyStore();
    expect(store).toHaveLength(2);
    expect(store[1].keyId).toBe("v1");
  });

  it("excludes previous key after grace period expires", () => {
    // Set supersededAt to 8 days ago (past the 7-day grace window)
    const eightDaysAgoSec = Math.floor((Date.now() - 8 * 24 * 60 * 60 * 1000) / 1000);
    setEnv({
      JWT_KEY_ID: "v2",
      JWT_PREVIOUS_SECRET: "old-secret-32chars-xxxxxxxxxx",
      JWT_PREVIOUS_KEY_ID: "v1",
      JWT_PREVIOUS_KEY_ISSUED_AT: String(eightDaysAgoSec),
    });
    const store = buildKeyStore();
    // Previous key should be evicted
    expect(store).toHaveLength(1);
    expect(store[0].keyId).toBe("v2");
  });

  it("throws when JWT_SECRET is not set", () => {
    delete process.env.JWT_SECRET;
    expect(() => buildKeyStore()).toThrow(/JWT_SECRET/);
  });
});

// ---------------------------------------------------------------------------
// findKeyById
// ---------------------------------------------------------------------------

describe("findKeyById()", () => {
  beforeEach(() => {
    process.env.JWT_SECRET = "active-secret-32chars-xxxxxxxxxx";
    process.env.JWT_KEY_ID = "v2";
    delete process.env.JWT_PREVIOUS_SECRET;
    delete process.env.JWT_PREVIOUS_KEY_ID;
    delete process.env.JWT_PREVIOUS_KEY_ISSUED_AT;
  });

  it("returns the active key by its id", () => {
    const entry = findKeyById("v2");
    expect(entry).toBeDefined();
    expect(entry!.keyId).toBe("v2");
  });

  it("returns undefined for an unknown key id", () => {
    expect(findKeyById("unknown-key")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// generateToken / verifyToken key rotation
// ---------------------------------------------------------------------------

describe("generateToken() key id in header", () => {
  beforeEach(() => {
    process.env.JWT_SECRET = "active-secret-32chars-xxxxxxxxxx";
    process.env.JWT_KEY_ID = "v2";
    delete process.env.JWT_PREVIOUS_SECRET;
    delete process.env.JWT_PREVIOUS_KEY_ID;
    delete process.env.JWT_PREVIOUS_KEY_ISSUED_AT;
  });

  it("embeds the active key id in the JWT header", () => {
    const token = generateToken(BASE_PAYLOAD);
    const decoded = jwt.decode(token, { complete: true });
    expect((decoded?.header as any)?.kid).toBe("v2");
  });
});

describe("verifyToken() with key rotation", () => {
  const ACTIVE_SECRET = "active-secret-32chars-xxxxxxxxxx";
  const OLD_SECRET    = "old-secret-32chars-xxxxxxxxxxxxxx";

  beforeEach(() => {
    process.env.JWT_SECRET = ACTIVE_SECRET;
    process.env.JWT_KEY_ID = "v2";
    delete process.env.JWT_PREVIOUS_SECRET;
    delete process.env.JWT_PREVIOUS_KEY_ID;
    delete process.env.JWT_PREVIOUS_KEY_ISSUED_AT;
  });

  it("verifies a token signed with the current active key", () => {
    const token = generateToken(BASE_PAYLOAD);
    const decoded = verifyToken(token);
    expect(decoded.userId).toBe("u1");
  });

  it("accepts a token signed with the previous key during grace period", () => {
    // Generate a token using the OLD key directly
    const oldToken = jwt.sign(BASE_PAYLOAD, OLD_SECRET, { expiresIn: "1h", keyid: "v1" });

    // Configure the environment so v1 is still within grace period
    const supersededAtSec = Math.floor(Date.now() / 1000) - 60;
    setEnv({
      JWT_PREVIOUS_SECRET: OLD_SECRET,
      JWT_PREVIOUS_KEY_ID: "v1",
      JWT_PREVIOUS_KEY_ISSUED_AT: String(supersededAtSec),
    });

    const decoded = verifyToken(oldToken);
    expect(decoded.userId).toBe("u1");
  });

  it("rejects a token with an unknown key id", () => {
    const unknownToken = jwt.sign(BASE_PAYLOAD, "some-random-secret", {
      expiresIn: "1h",
      keyid: "unknown-v99",
    });
    expect(() => verifyToken(unknownToken)).toThrow(/unknown key id/i);
  });

  it("rejects a token from a previous key whose grace period has expired", () => {
    const oldToken = jwt.sign(BASE_PAYLOAD, OLD_SECRET, { expiresIn: "1h", keyid: "v1" });

    // Set supersededAt 8 days ago — past the grace window
    const eightDaysAgoSec = Math.floor((Date.now() - 8 * 24 * 60 * 60 * 1000) / 1000);
    setEnv({
      JWT_PREVIOUS_SECRET: OLD_SECRET,
      JWT_PREVIOUS_KEY_ID: "v1",
      JWT_PREVIOUS_KEY_ISSUED_AT: String(eightDaysAgoSec),
    });

    // v1 is evicted, so verifyToken should throw "unknown key id"
    expect(() => verifyToken(oldToken)).toThrow(/unknown key id/i);
  });

  it("falls back to active secret for legacy tokens with no kid header", () => {
    // Token signed without a kid (pre-rotation tokens)
    const legacyToken = jwt.sign(BASE_PAYLOAD, ACTIVE_SECRET, { expiresIn: "1h" });
    // No kid in header — falls back to active secret
    const decoded = verifyToken(legacyToken);
    expect(decoded.userId).toBe("u1");
  });

  it("rejects an expired token regardless of key rotation state", () => {
    // Use a negative expiry to create an already-expired token
    // jsonwebtoken doesn't support negative expiry strings, use numeric seconds
    const expiredToken = jwt.sign(
      { ...BASE_PAYLOAD, iat: Math.floor(Date.now() / 1000) - 7200 },
      ACTIVE_SECRET,
      { expiresIn: 1, keyid: "v2" },
    );
    // Wait is not needed: token exp = iat + 1 which is in the past
    expect(() => verifyToken(expiredToken)).toThrow(/expired/i);
  });
});
