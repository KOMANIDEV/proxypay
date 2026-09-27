/**
 * Cipher algorithm verification tests (Issue #632).
 *
 * Ensures the PII encryption module only ever uses AES-256-GCM with a 256-bit
 * key and rejects weak/unauthenticated cipher options.
 */

import crypto from "crypto";
import {
  AES_GCM_ALGORITHM,
  AES_KEY_LENGTH_BYTES,
  GCM_IV_LENGTH_BYTES,
  assertCipherAlgorithm,
  assertKeyLength,
  validateCipherAlgorithmSupport,
  validateEncryptionConfiguration,
  deriveKey,
  encryptAesGcm,
  decryptAesGcm,
} from "../../src/crypto/encryption";

describe("cipher algorithm validation (Issue #632)", () => {
  it("reports the AES-256-GCM configuration on startup validation", () => {
    const config = validateEncryptionConfiguration();
    expect(config.algorithm).toBe("aes-256-gcm");
    expect(config.keyLengthBytes).toBe(32);
  });

  it("accepts aes-256-gcm", () => {
    expect(() => assertCipherAlgorithm(AES_GCM_ALGORITHM)).not.toThrow();
  });

  it.each([
    "aes-128-gcm",
    "aes-192-gcm",
    "aes-256-ecb",
    "aes-128-ecb",
    "aes-256-cbc",
    "des-cbc",
    "des-ede3-cbc",
    "rc4",
    "aes-256-ctr",
    "aes-256-cfb",
  ])("rejects weak or non-AES-256 cipher %s", (algorithm) => {
    expect(() => assertCipherAlgorithm(algorithm)).toThrow(/cipher/i);
  });

  it("rejects unknown algorithms", () => {
    expect(() => assertCipherAlgorithm("not-a-real-cipher")).toThrow(
      /Unsupported cipher/i,
    );
  });

  it("verifies the runtime exposes AES-256-GCM with the expected parameters", () => {
    expect(() => validateCipherAlgorithmSupport()).not.toThrow();

    const info = crypto.getCipherInfo(AES_GCM_ALGORITHM);
    expect(info?.keyLength).toBe(AES_KEY_LENGTH_BYTES);
    expect(info?.ivLength).toBe(GCM_IV_LENGTH_BYTES);
  });

  it("rejects an algorithm the runtime cannot provide", () => {
    expect(() => validateCipherAlgorithmSupport("aes-128-gcm")).toThrow(
      /cipher/i,
    );
  });
});

describe("key length validation (Issue #632)", () => {
  it("accepts a 256-bit (32-byte) key", () => {
    expect(() => assertKeyLength(crypto.randomBytes(32))).not.toThrow();
  });

  it.each([8, 16, 24, 31, 33, 64])("rejects a %i-byte key", (length) => {
    expect(() => assertKeyLength(crypto.randomBytes(length))).toThrow(
      /256 bits/,
    );
  });

  it("rejects missing keys", () => {
    expect(() => assertKeyLength(undefined)).toThrow(/256 bits/);
    expect(() => assertKeyLength(null)).toThrow(/256 bits/);
  });

  it("encrypt/decrypt refuse keys that are not 256 bits", () => {
    const shortKey = crypto.randomBytes(16);
    expect(() => encryptAesGcm(Buffer.from("x"), shortKey)).toThrow(/256 bits/);

    const validKey = deriveKey("correct horse battery staple");
    const payload = encryptAesGcm(Buffer.from("x"), validKey);
    expect(() => decryptAesGcm(payload, shortKey)).toThrow(/256 bits/);
  });

  it("round-trips data using a 256-bit key and a 96-bit IV", () => {
    const key = crypto.randomBytes(32);
    const payload = encryptAesGcm(Buffer.from("sensitive"), key);

    expect(payload.iv).toHaveLength(GCM_IV_LENGTH_BYTES * 2);
    expect(decryptAesGcm(payload, key).toString("utf8")).toBe("sensitive");
  });
});
