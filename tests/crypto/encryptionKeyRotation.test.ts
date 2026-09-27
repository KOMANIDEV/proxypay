import {
  DEFAULT_KEY_VERSION,
  deriveKey,
  decryptVersioned,
  encryptAesGcm,
  encryptVersioned,
  getActiveKeyVersion,
  getKeyRing,
  isVersionedCiphertext,
  rotateCiphertext,
  validateKeyRingConfig,
} from "../../src/crypto/encryption";

const ORIGINAL_ENV = { ...process.env };
const KEY_V1 = "pii-key-v1-material-32-characters!!!";
const KEY_V2 = "pii-key-v2-material-32-characters!!!";

const MANAGED_PREFIXES = [
  "PII_ENCRYPTION",
  "ACTIVE_PII_KEY_VERSION",
  "DB_ENCRYPTION",
  "ACTIVE_ENCRYPTION_KEY_VERSION",
];

function clearManagedEnv(): void {
  for (const key of Object.keys(process.env)) {
    if (MANAGED_PREFIXES.some((prefix) => key.startsWith(prefix))) {
      delete process.env[key];
    }
  }
}

describe("crypto/encryption key versioning & rotation", () => {
  beforeEach(() => {
    clearManagedEnv();
  });

  afterAll(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  describe("getKeyRing / getActiveKeyVersion", () => {
    it("resolves the legacy key plus versioned env vars and JSON maps", () => {
      process.env.PII_ENCRYPTION_KEY = KEY_V1;
      process.env.PII_ENCRYPTION_KEY_V2 = KEY_V2;
      process.env.PII_ENCRYPTION_KEYS = JSON.stringify({ v3: "pii-key-v3" });
      process.env.ACTIVE_PII_KEY_VERSION = "v2";

      const ring = getKeyRing();
      expect(ring.get(DEFAULT_KEY_VERSION)).toEqual(deriveKey(KEY_V1));
      expect(ring.get("v2")).toEqual(deriveKey(KEY_V2));
      expect(ring.get("v3")).toEqual(deriveKey("pii-key-v3"));
      expect(getActiveKeyVersion(ring)).toBe("v2");
    });

    it("falls back to the bootstrap version when the requested one is absent", () => {
      process.env.PII_ENCRYPTION_KEY = KEY_V1;
      process.env.ACTIVE_PII_KEY_VERSION = "v9";

      expect(getActiveKeyVersion()).toBe(DEFAULT_KEY_VERSION);
    });
  });

  describe("encryptVersioned / decryptVersioned", () => {
    it("prefixes ciphertext with the active version and round-trips", () => {
      process.env.PII_ENCRYPTION_KEY = KEY_V1;
      process.env.PII_ENCRYPTION_KEY_V2 = KEY_V2;
      process.env.ACTIVE_PII_KEY_VERSION = "v2";

      const ciphertext = encryptVersioned("sensitive-value");
      expect(ciphertext.startsWith("v2:")).toBe(true);
      expect(isVersionedCiphertext(ciphertext)).toBe(true);
      expect(decryptVersioned(ciphertext).toString("utf8")).toBe(
        "sensitive-value",
      );
    });

    it("falls back to another key version when the declared one is missing", () => {
      // Both versions hold the same material, so decryption must succeed even
      // though the payload declares v1 and only v2 is configured.
      process.env.PII_ENCRYPTION_KEYS = JSON.stringify({
        v1: KEY_V1,
        v2: KEY_V1,
      });

      const ciphertext = encryptVersioned("fallback-value", "v1");

      process.env.PII_ENCRYPTION_KEYS = JSON.stringify({ v2: KEY_V1 });
      expect(decryptVersioned(ciphertext).toString("utf8")).toBe(
        "fallback-value",
      );
    });

    it("rejects tampered ciphertext", () => {
      process.env.PII_ENCRYPTION_KEY = KEY_V1;
      const ciphertext = encryptVersioned("tamper-me", DEFAULT_KEY_VERSION);
      const parts = ciphertext.split(":");
      parts[3] = parts[3].replace(/^./, parts[3][0] === "0" ? "1" : "0");

      expect(() => decryptVersioned(parts.join(":"))).toThrow();
    });

    it("throws when no key is configured for the requested version", () => {
      process.env.PII_ENCRYPTION_KEY = KEY_V1;
      expect(() => encryptVersioned("x", "v7")).toThrow(
        /No encryption key configured/,
      );
    });
  });

  describe("rotateCiphertext", () => {
    beforeEach(() => {
      process.env.PII_ENCRYPTION_KEYS = JSON.stringify({
        v1: KEY_V1,
        v2: KEY_V2,
      });
      process.env.ACTIVE_PII_KEY_VERSION = "v2";
    });

    it("re-encrypts a v1 payload under the active version", () => {
      const legacyVersioned = encryptVersioned("rotate-me", "v1");

      const result = rotateCiphertext(legacyVersioned);

      expect(result.rotated).toBe(true);
      expect(result.fromVersion).toBe("v1");
      expect(result.toVersion).toBe("v2");
      expect(result.value.startsWith("v2:")).toBe(true);
      expect(decryptVersioned(result.value).toString("utf8")).toBe("rotate-me");
    });

    it("is idempotent for payloads already on the target version", () => {
      const current = encryptVersioned("already-current", "v2");

      const result = rotateCiphertext(current);

      expect(result.rotated).toBe(false);
      expect(result.value).toBe(current);
    });

    it("upgrades un-versioned legacy ciphertext to the active version", () => {
      const legacyKey = deriveKey(KEY_V1);
      const legacy = encryptAesGcm(
        Buffer.from("legacy-payload", "utf8"),
        legacyKey,
      );
      const legacyCiphertext = `${legacy.iv}:${legacy.authTag}:${legacy.ciphertext}`;

      const result = rotateCiphertext(legacyCiphertext);

      expect(result.rotated).toBe(true);
      expect(result.fromVersion).toBe("v1");
      expect(result.value.startsWith("v2:")).toBe(true);
      expect(decryptVersioned(result.value).toString("utf8")).toBe(
        "legacy-payload",
      );
    });

    it("rejects values that are not decryptable ciphertext", () => {
      expect(() => rotateCiphertext("not:encrypted:data")).toThrow(
        /Unable to rotate/,
      );
    });
  });

  describe("validateKeyRingConfig", () => {
    it("is valid when the active version is present in the ring", () => {
      process.env.PII_ENCRYPTION_KEYS = JSON.stringify({
        v1: KEY_V1,
        v2: KEY_V2,
      });
      process.env.ACTIVE_PII_KEY_VERSION = "v2";

      const result = validateKeyRingConfig();
      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    });

    it("reports an error when the active version is missing", () => {
      process.env.PII_ENCRYPTION_KEY = KEY_V1;
      process.env.ACTIVE_PII_KEY_VERSION = "v5";

      const result = validateKeyRingConfig();
      expect(result.valid).toBe(false);
      expect(result.errors.join(" ")).toMatch(/v5/);
    });

    it("reports an error when no keys are configured at all", () => {
      const result = validateKeyRingConfig();
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });
  });
});
