import {
  randomBytes,
  createCipheriv,
  createDecipheriv,
  createHash,
  getCipherInfo,
  getCiphers,
} from "crypto";

export interface Encrypted {
  iv: string; // hex
  ciphertext: string; // hex
  authTag: string; // hex
}

/** The only cipher algorithm permitted for PII at rest (Issue #632). */
export const AES_GCM_ALGORITHM = "aes-256-gcm" as const;
/** AES-256 requires a 256-bit (32-byte) key. */
export const AES_KEY_LENGTH_BYTES = 32;
/** GCM recommendation: 96-bit (12-byte) IV. */
export const GCM_IV_LENGTH_BYTES = 12;
/** 128-bit GCM authentication tag. */
export const GCM_AUTH_TAG_LENGTH_BYTES = 16;

/** Algorithms this module will accept. Everything else is rejected. */
const ALLOWED_CIPHER_ALGORITHMS: readonly string[] = [AES_GCM_ALGORITHM];

/**
 * Cipher families that must never be used for PII. These are rejected even
 * when Node.js is capable of constructing them.
 */
const WEAK_CIPHER_PATTERNS: readonly RegExp[] = [
  /-ecb$/i, // ECB leaks plaintext structure
  /^aes-128/i, // 128-bit key — not AES-256
  /^aes-192/i, // 192-bit key — not AES-256
  /-cbc$/i, // unauthenticated encryption
  /-cfb/i,
  /-ofb/i,
  /-ctr$/i,
  /^des/i,
  /^3des/i,
  /^rc2/i,
  /^rc4/i,
  /^blowfish/i,
  /-wrap/i,
];

/**
 * Throws unless `algorithm` is an allow-listed, non-weak cipher.
 * Used to guarantee the module always operates on AES-256-GCM.
 */
export function assertCipherAlgorithm(algorithm: string): void {
  if (!ALLOWED_CIPHER_ALGORITHMS.includes(algorithm)) {
    throw new Error(
      `Unsupported cipher algorithm "${algorithm}". Only ${ALLOWED_CIPHER_ALGORITHMS.join(
        ", ",
      )} is permitted for PII encryption.`,
    );
  }

  const weakPattern = WEAK_CIPHER_PATTERNS.find((pattern) =>
    pattern.test(algorithm),
  );
  if (weakPattern) {
    throw new Error(
      `Weak cipher algorithm "${algorithm}" is not permitted for PII encryption.`,
    );
  }
}

/**
 * Asserts a key is exactly 256 bits. Guards against silently downgrading
 * AES-256 to a shorter key size.
 */
export function assertKeyLength(
  key: Buffer | Uint8Array | null | undefined,
  context = "AES-256-GCM key",
): void {
  if (!key || key.length !== AES_KEY_LENGTH_BYTES) {
    throw new Error(
      `${context} must be exactly ${AES_KEY_LENGTH_BYTES} bytes (256 bits), received ${
        key?.length ?? 0
      }`,
    );
  }
}

/**
 * Verifies the runtime can actually provide the requested cipher with the
 * expected key/IV length. Protects against a build that silently substitutes a
 * weaker cipher implementation.
 */
export function validateCipherAlgorithmSupport(
  algorithm: string = AES_GCM_ALGORITHM,
): void {
  assertCipherAlgorithm(algorithm);

  if (!getCiphers().includes(algorithm)) {
    throw new Error(
      `Cipher algorithm "${algorithm}" is not available in this Node.js build`,
    );
  }

  const info = getCipherInfo(algorithm);
  if (
    info &&
    (info.keyLength !== AES_KEY_LENGTH_BYTES ||
      info.ivLength !== GCM_IV_LENGTH_BYTES)
  ) {
    throw new Error(
      `Cipher "${algorithm}" reported unexpected parameters: keyLength=${
        info.keyLength
      } ivLength=${info.ivLength}. Expected keyLength=${AES_KEY_LENGTH_BYTES} ivLength=${GCM_IV_LENGTH_BYTES}.`,
    );
  }
}

/**
 * Startup validation for the PII encryption configuration. Call this during
 * application bootstrap to fail fast if the cipher cannot be trusted.
 */
export function validateEncryptionConfiguration(): {
  algorithm: string;
  keyLengthBytes: number;
} {
  validateCipherAlgorithmSupport(AES_GCM_ALGORITHM);
  return {
    algorithm: AES_GCM_ALGORITHM,
    keyLengthBytes: AES_KEY_LENGTH_BYTES,
  };
}

// Fail fast on module load (i.e. at application startup) if AES-256-GCM is not
// available or does not report the expected parameters.
validateCipherAlgorithmSupport();

/** Derive a 32-byte AES key from a password using a single SHA-256.
 * This is intentionally simple for tests/fuzzing. For production use a
 * proper KDF (PBKDF2/Argon2/ HKDF) with salt and iterations.
 */
export function deriveKey(password: string): Buffer {
  return createHash("sha256").update(password, "utf8").digest();
}

/** Encrypt a buffer with AES-256-GCM. Returns hex-encoded fields. */
export function encryptAesGcm(plaintext: Buffer, key: Buffer): Encrypted {
  assertKeyLength(key);
  const iv = randomBytes(GCM_IV_LENGTH_BYTES);
  const cipher = createCipheriv(AES_GCM_ALGORITHM, key, iv, {
    authTagLength: GCM_AUTH_TAG_LENGTH_BYTES,
  });
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    iv: iv.toString("hex"),
    ciphertext: ciphertext.toString("hex"),
    authTag: authTag.toString("hex"),
  };
}

/** Decrypt AES-256-GCM hex fields. Throws on auth failure. */
export function decryptAesGcm(enc: Encrypted, key: Buffer): Buffer {
  assertKeyLength(key);
  const iv = Buffer.from(enc.iv, "hex");
  const ciphertext = Buffer.from(enc.ciphertext, "hex");
  const authTag = Buffer.from(enc.authTag, "hex");
  const decipher = createDecipheriv(AES_GCM_ALGORITHM, key, iv, {
    authTagLength: GCM_AUTH_TAG_LENGTH_BYTES,
  });
  decipher.setAuthTag(authTag);
  const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plain;
}

// ─── Key versioning & rotation ────────────────────────────────────────────────
//
// Versioned ciphertext is self-describing so old data keeps decrypting after a
// key rotation:
//
//   <version>:<iv_hex>:<authTag_hex>:<ciphertext_hex>
//
// The key ring is resolved dynamically at call time, which lets operators roll
// out a new key without a redeploy. Configure it with any combination of:
//
//   PII_ENCRYPTION_KEY=<secret>                       legacy / bootstrap key
//   PII_ENCRYPTION_KEY_V2=<secret>                    one env var per version
//   PII_ENCRYPTION_KEYS={"v1":"<s>","v2":"<s>"}       JSON map of versions
//   ACTIVE_PII_KEY_VERSION=v2                         key used for new data
//
// DB_ENCRYPTION_KEY / DB_ENCRYPTION_KEY_<VERSION> / DB_ENCRYPTION_KEYS are
// honoured as fallbacks so the PII key ring shares configuration with the
// utilities in src/utils/encryption.ts.

export const DEFAULT_KEY_VERSION = "legacy";

type VersionedParts = {
  version: string;
  iv: string;
  authTag: string;
  ciphertext: string;
};

function normaliseVersion(version: string): string {
  return version.trim().toLowerCase();
}

function parseKeyMap(raw: string | undefined, ring: Map<string, Buffer>): void {
  if (!raw) return;
  try {
    const parsed = JSON.parse(raw) as Record<string, string>;
    for (const [version, material] of Object.entries(parsed)) {
      if (material) ring.set(normaliseVersion(version), deriveKey(material));
    }
  } catch (err) {
    console.error("[crypto] Failed to parse encryption key map:", err);
  }
}

/**
 * Resolves every configured encryption key into a versioned key ring.
 * Versions are lower-cased; the bootstrap key uses `DEFAULT_KEY_VERSION`.
 */
export function getKeyRing(): Map<string, Buffer> {
  const ring = new Map<string, Buffer>();

  const legacy =
    process.env.PII_ENCRYPTION_KEY || process.env.DB_ENCRYPTION_KEY;
  if (legacy) {
    ring.set(DEFAULT_KEY_VERSION, deriveKey(legacy));
  }

  parseKeyMap(process.env.PII_ENCRYPTION_KEYS, ring);
  parseKeyMap(process.env.DB_ENCRYPTION_KEYS, ring);

  const versionedPrefixes = ["PII_ENCRYPTION_KEY_", "DB_ENCRYPTION_KEY_"];
  for (const [name, value] of Object.entries(process.env)) {
    if (!value) continue;
    const prefix = versionedPrefixes.find((candidate) =>
      name.startsWith(candidate),
    );
    if (!prefix) continue;
    const version = normaliseVersion(name.slice(prefix.length));
    ring.set(version, deriveKey(value));
  }

  return ring;
}

/**
 * Returns the version new ciphertext should be encrypted with.
 * Falls back to the bootstrap key when the requested version is not configured.
 */
export function getActiveKeyVersion(
  ring: Map<string, Buffer> = getKeyRing(),
): string {
  const requested = normaliseVersion(
    process.env.ACTIVE_PII_KEY_VERSION ||
      process.env.ACTIVE_ENCRYPTION_KEY_VERSION ||
      "",
  );

  if (requested && ring.has(requested)) return requested;
  return DEFAULT_KEY_VERSION;
}

/** Serialises an encrypted payload with the key version that produced it. */
export function formatVersionedCiphertext(
  version: string,
  encrypted: Encrypted,
): string {
  return `${normaliseVersion(version)}:${encrypted.iv}:${encrypted.authTag}:${encrypted.ciphertext}`;
}

/** Parses `<version>:<iv>:<authTag>:<ciphertext>`, returning null when malformed. */
export function parseVersionedCiphertext(value: string): VersionedParts | null {
  if (!value) return null;
  const parts = value.split(":");
  if (parts.length !== 4) return null;
  const [version, iv, authTag, ciphertext] = parts;
  if (!/^[a-z0-9_-]+$/i.test(version)) return null;
  if (!/^[0-9a-f]+$/i.test(iv) || iv.length !== 24) return null; // 12 bytes hex
  if (!/^[0-9a-f]+$/i.test(authTag) || authTag.length !== 32) return null;
  if (!/^[0-9a-f]*$/i.test(ciphertext) || ciphertext.length % 2 !== 0)
    return null;

  return { version: normaliseVersion(version), iv, authTag, ciphertext };
}

/** True when `value` is a well-formed versioned ciphertext. */
export function isVersionedCiphertext(value: string): boolean {
  return parseVersionedCiphertext(value) !== null;
}

/**
 * Encrypts a value with the active (or explicitly requested) key version.
 * The returned ciphertext carries its version prefix so it stays decryptable
 * after the active key rotates.
 */
export function encryptVersioned(
  plaintext: Buffer | string,
  version?: string,
): string {
  const ring = getKeyRing();
  const target = normaliseVersion(version ?? getActiveKeyVersion(ring));
  const key = ring.get(target);

  if (!key) {
    throw new Error(
      `No encryption key configured for version "${target}". Configure PII_ENCRYPTION_KEY_${target.toUpperCase()} or PII_ENCRYPTION_KEYS.`,
    );
  }

  const buffer =
    typeof plaintext === "string" ? Buffer.from(plaintext, "utf8") : plaintext;
  return formatVersionedCiphertext(target, encryptAesGcm(buffer, key));
}

/**
 * Decrypts a versioned ciphertext. The declared version is tried first and the
 * remaining keys in the ring are used as fallbacks, keeping data readable while
 * a rotation is still in progress.
 */
export function decryptVersioned(payload: string): Buffer {
  const parsed = parseVersionedCiphertext(payload);
  if (!parsed) {
    throw new Error(
      "Invalid versioned ciphertext — expected version:iv:authTag:ciphertext",
    );
  }

  const ring = getKeyRing();
  const order = [
    parsed.version,
    ...Array.from(ring.keys()).filter((version) => version !== parsed.version),
  ];

  for (const version of order) {
    const key = ring.get(version);
    if (!key) continue;
    try {
      return decryptAesGcm(
        {
          iv: parsed.iv,
          authTag: parsed.authTag,
          ciphertext: parsed.ciphertext,
        },
        key,
      );
    } catch {
      // Try the next key in the ring.
    }
  }

  throw new Error(
    `Unable to decrypt versioned ciphertext for version "${parsed.version}" with the configured key ring.`,
  );
}

export interface CiphertextRotationResult {
  /** Ciphertext to persist (unchanged when no rotation was required). */
  value: string;
  /** Version the input was decrypted with, or null for unsupported input. */
  fromVersion: string | null;
  /** Version the ciphertext is now encrypted with. */
  toVersion: string;
  /** True when `value` differs from the input. */
  rotated: boolean;
}

/**
 * Re-encrypts one ciphertext with the active (or requested) key version.
 * This is the primitive used by the key rotation migration script.
 */
export function rotateCiphertext(
  payload: string,
  targetVersion?: string,
): CiphertextRotationResult {
  const ring = getKeyRing();
  const target = normaliseVersion(targetVersion ?? getActiveKeyVersion(ring));
  const targetKey = ring.get(target);

  if (!targetKey) {
    throw new Error(`No encryption key configured for version "${target}".`);
  }

  const parsed = parseVersionedCiphertext(payload);
  if (parsed) {
    if (parsed.version === target) {
      return {
        value: payload,
        fromVersion: parsed.version,
        toVersion: target,
        rotated: false,
      };
    }

    const plaintext = decryptVersioned(payload);
    return {
      value: formatVersionedCiphertext(
        target,
        encryptAesGcm(plaintext, targetKey),
      ),
      fromVersion: parsed.version,
      toVersion: target,
      rotated: true,
    };
  }

  // Un-versioned (legacy) ciphertext: try every key in the ring until one
  // authenticates, then persist the value in the versioned format.
  const parts = payload.split(":");
  if (parts.length === 3) {
    const [iv, authTag, ciphertext] = parts;
    for (const version of ring.keys()) {
      try {
        const plaintext = decryptAesGcm(
          { iv, authTag, ciphertext },
          ring.get(version)!,
        );
        return {
          value: formatVersionedCiphertext(
            target,
            encryptAesGcm(plaintext, targetKey),
          ),
          fromVersion: version,
          toVersion: target,
          rotated: true,
        };
      } catch {
        // Try the next key in the ring.
      }
    }
  }

  throw new Error(
    "Unable to rotate ciphertext: value is neither versioned nor a decryptable legacy payload.",
  );
}

export interface KeyRingValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * Validates the key ring / active-version configuration at startup so a
 * misconfigured rotation fails fast instead of silently losing access to PII.
 */
export function validateKeyRingConfig(
  ring: Map<string, Buffer> = getKeyRing(),
): KeyRingValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (ring.size === 0) {
    errors.push(
      "No encryption keys configured. Set PII_ENCRYPTION_KEY or PII_ENCRYPTION_KEYS.",
    );
  }

  const requested = normaliseVersion(
    process.env.ACTIVE_PII_KEY_VERSION ||
      process.env.ACTIVE_ENCRYPTION_KEY_VERSION ||
      "",
  );

  if (requested && !ring.has(requested)) {
    errors.push(
      `ACTIVE_PII_KEY_VERSION="${requested}" is not present in the key ring.`,
    );
  }

  if (!process.env.PII_ENCRYPTION_KEY && !process.env.PII_ENCRYPTION_KEYS) {
    warnings.push(
      "Falling back to DB_ENCRYPTION_KEY* for the PII key ring. Prefer distinct PII_ENCRYPTION_* key material.",
    );
  }

  if (ring.size === 1) {
    warnings.push(
      "Only one encryption key version is configured. Keep the previous version in the ring so rotated data stays readable.",
    );
  }

  return { valid: errors.length === 0, errors, warnings };
}

export default {
  deriveKey,
  encryptAesGcm,
  decryptAesGcm,
  assertCipherAlgorithm,
  assertKeyLength,
  validateCipherAlgorithmSupport,
  validateEncryptionConfiguration,
  AES_GCM_ALGORITHM,
  AES_KEY_LENGTH_BYTES,
};
