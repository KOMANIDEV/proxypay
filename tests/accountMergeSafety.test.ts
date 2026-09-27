import { evaluateAccountMergeCandidate, AccountMergeCandidate } from "../src/jobs/accountMerge";

describe("AccountMergeSafety", () => {
  describe("evaluateAccountMergeCandidate", () => {
    it("should mark candidate as eligible when all conditions are met", () => {
      const candidate: AccountMergeCandidate = {
        nativeBalance: "10.5",
        subentryCount: 0,
        hasNonNativeBalances: false,
        lastActivityAt: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000), // 60 days ago
      };

      const result = evaluateAccountMergeCandidate(candidate, 30);

      expect(result.eligible).toBe(true);
      expect(result.reason).toBeUndefined();
      expect(result.reclaimableBalance).toBeTruthy();
    });

    it("should reject candidate with native balance too low", () => {
      const candidate: AccountMergeCandidate = {
        nativeBalance: "0.5",
        subentryCount: 0,
        hasNonNativeBalances: false,
        lastActivityAt: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000),
      };

      const result = evaluateAccountMergeCandidate(candidate, 30);

      expect(result.eligible).toBe(false);
      expect(result.reason).toContain("native balance is too low");
    });

    it("should reject candidate with subentries", () => {
      const candidate: AccountMergeCandidate = {
        nativeBalance: "100",
        subentryCount: 2,
        hasNonNativeBalances: false,
        lastActivityAt: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000),
      };

      const result = evaluateAccountMergeCandidate(candidate, 30);

      expect(result.eligible).toBe(false);
      expect(result.reason).toContain("2 subentries");
    });

    it("should reject candidate with non-native balances", () => {
      const candidate: AccountMergeCandidate = {
        nativeBalance: "100",
        subentryCount: 0,
        hasNonNativeBalances: true,
        lastActivityAt: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000),
      };

      const result = evaluateAccountMergeCandidate(candidate, 30);

      expect(result.eligible).toBe(false);
      expect(result.reason).toContain("non-native assets");
    });

    it("should reject candidate active within inactivity window", () => {
      const candidate: AccountMergeCandidate = {
        nativeBalance: "100",
        subentryCount: 0,
        hasNonNativeBalances: false,
        lastActivityAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000), // 5 days ago
      };

      const result = evaluateAccountMergeCandidate(candidate, 30);

      expect(result.eligible).toBe(false);
      expect(result.reason).toContain("active within the last 30 day(s)");
    });

    it("should calculate correct reclaimable balance", () => {
      const candidate: AccountMergeCandidate = {
        nativeBalance: "15",
        subentryCount: 0,
        hasNonNativeBalances: false,
        lastActivityAt: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000),
      };

      const result = evaluateAccountMergeCandidate(candidate, 30);

      expect(result.eligible).toBe(true);
      // 15 XLM = 150,000,000 stroops, base fee = 100,000 stroops
      // reclaimable = 150,000,000 - 100,000 = 149,900,000 stroops = 14.99 XLM
      expect(parseFloat(result.reclaimableBalance)).toBeCloseTo(14.99, 2);
    });

    it("should handle candidate with no last activity date", () => {
      const candidate: AccountMergeCandidate = {
        nativeBalance: "50",
        subentryCount: 0,
        hasNonNativeBalances: false,
        lastActivityAt: null,
      };

      const result = evaluateAccountMergeCandidate(candidate, 30);

      expect(result.eligible).toBe(true);
    });

    it("should return zero reclaimable balance when balance is below base fee", () => {
      const candidate: AccountMergeCandidate = {
        nativeBalance: "0.005",
        subentryCount: 0,
        hasNonNativeBalances: false,
        lastActivityAt: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000),
      };

      const result = evaluateAccountMergeCandidate(candidate, 30);

      expect(result.eligible).toBe(false);
      expect(result.reclaimableBalance).toBe("0");
    });

    it("should reject candidate active within custom inactivity window", () => {
      const candidate: AccountMergeCandidate = {
        nativeBalance: "100",
        subentryCount: 0,
        hasNonNativeBalances: false,
        lastActivityAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000), // 2 days ago
      };

      const result = evaluateAccountMergeCandidate(candidate, 7);

      expect(result.eligible).toBe(false);
      expect(result.reason).toContain("active within the last 7 day(s)");
    });
  });
});
