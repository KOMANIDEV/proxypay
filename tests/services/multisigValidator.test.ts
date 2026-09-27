import {
  validateMultisigThresholds,
  calculateSignatureWeight,
  meetsThreshold,
  SignerConfig,
  MultisigThresholdConfig,
} from "../../src/services/multisigValidator";

describe("MultisigValidator", () => {
  describe("validateMultisigThresholds", () => {
    const baseSigners: SignerConfig[] = [
      { publicKey: "GBX...", weight: 10 },
      { publicKey: "GAY...", weight: 5 },
    ];

    const validThresholds: MultisigThresholdConfig = {
      low: 5,
      medium: 10,
      high: 15,
    };

    it("returns valid for a correct configuration", () => {
      const result = validateMultisigThresholds(1, baseSigners, validThresholds);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
      expect(result.totalWeight).toBe(16);
    });

    it("detects thresholds exceeding total weight", () => {
      const result = validateMultisigThresholds(1, baseSigners, {
        low: 5,
        medium: 10,
        high: 20,
      });
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.stringContaining("Highest threshold")
      );
    });

    it("warns when master weight is zero", () => {
      const result = validateMultisigThresholds(0, baseSigners, validThresholds);
      expect(result.warnings).toContainEqual(
        expect.stringContaining("Master key weight is zero")
      );
    });

    it("detects duplicate signer keys", () => {
      const dupes: SignerConfig[] = [
        { publicKey: "GBX...", weight: 10 },
        { publicKey: "GBX...", weight: 5 },
      ];
      const result = validateMultisigThresholds(1, dupes, validThresholds);
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.stringContaining("Duplicate signer keys")
      );
    });

    it("warns when low > medium threshold", () => {
      const result = validateMultisigThresholds(1, baseSigners, {
        low: 15,
        medium: 10,
        high: 20,
      });
      expect(result.warnings).toContainEqual(
        expect.stringContaining("Low threshold is greater than medium")
      );
    });

    it("returns zero totalWeight and error when total weight is zero", () => {
      const result = validateMultisigThresholds(0, [], validThresholds);
      expect(result.valid).toBe(false);
      expect(result.totalWeight).toBe(0);
      expect(result.errors).toContainEqual(
        expect.stringContaining("must be greater than zero")
      );
    });
  });

  describe("calculateSignatureWeight", () => {
    const signers: SignerConfig[] = [
      { publicKey: "GA...", weight: 10 },
      { publicKey: "GB...", weight: 5 },
      { publicKey: "GC...", weight: 3 },
    ];

    it("sums weights of provided signatures", () => {
      const weight = calculateSignatureWeight(
        ["GA...", "GC..."],
        signers,
        "SERVER_KEY",
      );
      expect(weight).toBe(13);
    });

    it("excludes server key signature", () => {
      const weight = calculateSignatureWeight(
        ["GA...", "SERVER_KEY"],
        signers,
        "SERVER_KEY",
      );
      expect(weight).toBe(10);
    });

    it("returns zero for empty signatures", () => {
      const weight = calculateSignatureWeight([], signers, "SERVER_KEY");
      expect(weight).toBe(0);
    });
  });

  describe("meetsThreshold", () => {
    const thresholds: MultisigThresholdConfig = { low: 3, medium: 5, high: 10 };

    it("returns true when weight meets low threshold", () => {
      expect(meetsThreshold(3, "low", thresholds)).toBe(true);
    });

    it("returns false when weight is below medium threshold", () => {
      expect(meetsThreshold(4, "medium", thresholds)).toBe(false);
    });

    it("returns true when weight meets high threshold", () => {
      expect(meetsThreshold(10, "high", thresholds)).toBe(true);
    });

    it("returns false for unknown operation type", () => {
      expect(meetsThreshold(100, "critical" as any, thresholds)).toBe(false);
    });
  });
});
