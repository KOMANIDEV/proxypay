jest.mock("../../src/config/database", () => ({
  pool: { query: jest.fn() },
}));

import { pool } from "../../src/config/database";
import {
  ProviderPerformanceService,
  ProviderName,
} from "../../src/services/providerPerformanceService";

const mockPool = pool as { query: jest.Mock };

function mockProviderRows(
  provider: string,
  total: number,
  successes: number,
  avgLatency: number | null,
  p95: number | null,
  recentCalls: number,
  lastFailure: string | null,
) {
  return {
    rows: [
      {
        total: String(total),
        successes: String(successes),
        avg_latency: avgLatency != null ? String(avgLatency) : null,
        p95_latency: p95 != null ? String(p95) : null,
        recent_calls: String(recentCalls),
        last_failure: lastFailure,
      },
    ],
  };
}

describe("ProviderPerformanceService (#371)", () => {
  let service: ProviderPerformanceService;

  beforeEach(() => {
    service = new ProviderPerformanceService();
    mockPool.query.mockReset();
  });

  afterEach(() => {
    service.clearAllStickySessions();
  });

  // ---------------------------------------------------------------------------
  // Latency-aware provider selection
  // ---------------------------------------------------------------------------

  describe("selectBestProvider", () => {
    it("selects the provider with best composite score", async () => {
      mockPool.query
        .mockResolvedValueOnce(mockProviderRows("mtn", 100, 90, 200, 400, 30, null))
        .mockResolvedValueOnce(mockProviderRows("airtel", 100, 95, 100, 200, 30, null))
        .mockResolvedValueOnce(mockProviderRows("orange", 100, 80, 500, 1000, 30, null));

      const best = await service.selectBestProvider();
      expect(best).toBe("airtel");
    });

    it("excludes specified providers", async () => {
      mockPool.query
        .mockResolvedValueOnce(mockProviderRows("mtn", 100, 90, 200, 400, 30, null))
        .mockResolvedValueOnce(mockProviderRows("airtel", 100, 95, 100, 200, 30, null))
        .mockResolvedValueOnce(mockProviderRows("orange", 100, 80, 500, 1000, 30, null));

      const best = await service.selectBestProvider(["airtel"]);
      expect(best).toBe("mtn");
    });

    it("falls back to mtn when all providers are excluded", async () => {
      mockPool.query
        .mockResolvedValueOnce(mockProviderRows("mtn", 100, 90, 200, 400, 30, null))
        .mockResolvedValueOnce(mockProviderRows("airtel", 100, 95, 100, 200, 30, null))
        .mockResolvedValueOnce(mockProviderRows("orange", 100, 80, 500, 1000, 30, null));

      const best = await service.selectBestProvider(["mtn", "airtel", "orange"]);
      expect(best).toBe("mtn");
    });

    it("defaults to mtn when no call data exists", async () => {
      mockPool.query
        .mockResolvedValueOnce(mockProviderRows("mtn", 0, 0, null, null, 0, null))
        .mockResolvedValueOnce(mockProviderRows("airtel", 0, 0, null, null, 0, null))
        .mockResolvedValueOnce(mockProviderRows("orange", 0, 0, null, null, 0, null));

      const best = await service.selectBestProvider();
      expect(best).toBe("mtn");
    });
  });

  // ---------------------------------------------------------------------------
  // Sticky sessions
  // ---------------------------------------------------------------------------

  describe("sticky sessions", () => {
    it("returns sticky provider for merchant", async () => {
      mockPool.query
        .mockResolvedValueOnce(mockProviderRows("mtn", 100, 90, 200, 400, 30, null))
        .mockResolvedValueOnce(mockProviderRows("airtel", 100, 95, 100, 200, 30, null))
        .mockResolvedValueOnce(mockProviderRows("orange", 100, 80, 500, 1000, 30, null));

      const first = await service.selectBestProviderForMerchant("merchant-1");
      const second = await service.selectBestProviderForMerchant("merchant-1");
      expect(first).toBe(second);
    });

    it("respects exclusion even for sticky sessions", async () => {
      service.setStickySession("merchant-1", "mtn");

      mockPool.query
        .mockResolvedValueOnce(mockProviderRows("mtn", 100, 90, 200, 400, 30, null))
        .mockResolvedValueOnce(mockProviderRows("airtel", 100, 95, 100, 200, 30, null))
        .mockResolvedValueOnce(mockProviderRows("orange", 100, 80, 500, 1000, 30, null));

      const result = await service.selectBestProviderForMerchant("merchant-1", ["mtn"]);
      expect(result).not.toBe("mtn");
    });

    it("clears individual sticky session", () => {
      service.setStickySession("merchant-1", "mtn");
      expect(service.getStickySession("merchant-1")).not.toBeNull();

      service.clearStickySession("merchant-1");
      expect(service.getStickySession("merchant-1")).toBeNull();
    });

    it("clears all sticky sessions", () => {
      service.setStickySession("m1", "mtn");
      service.setStickySession("m2", "airtel");
      service.clearAllStickySessions();
      expect(service.getStickySession("m1")).toBeNull();
      expect(service.getStickySession("m2")).toBeNull();
    });

    it("returns null for expired sticky sessions", () => {
      service.updateScoringConfig({ stickySessionTtlMs: 0 });
      service.setStickySession("merchant-1", "mtn");

      expect(service.getStickySession("merchant-1")).toBeNull();
    });

    it("manually sets and gets sticky sessions", () => {
      service.setStickySession("merchant-1", "orange");
      const session = service.getStickySession("merchant-1");
      expect(session).not.toBeNull();
      expect(session!.provider).toBe("orange");
      expect(session!.merchantId).toBe("merchant-1");
    });
  });

  // ---------------------------------------------------------------------------
  // Admin configuration
  // ---------------------------------------------------------------------------

  describe("admin configuration", () => {
    it("updates scoring weights", () => {
      service.updateScoringConfig({
        weights: { latencyWeight: 0.5, successRateWeight: 0.3, recencyWeight: 0.1, stickyBonus: 0.1 },
      });
      const config = service.getScoringConfig();
      expect(config.weights.latencyWeight).toBe(0.5);
      expect(config.weights.successRateWeight).toBe(0.3);
    });

    it("updates sticky session TTL", () => {
      service.updateScoringConfig({ stickySessionTtlMs: 60000 });
      const config = service.getScoringConfig();
      expect(config.stickySessionTtlMs).toBe(60000);
    });

    it("updates latency window", () => {
      service.updateScoringConfig({ latencyWindowMs: 120000 });
      const config = service.getScoringConfig();
      expect(config.latencyWindowMs).toBe(120000);
    });

    it("returns a copy of the config", () => {
      const config = service.getScoringConfig();
      config.weights.latencyWeight = 999;
      const original = service.getScoringConfig();
      expect(original.weights.latencyWeight).not.toBe(999);
    });

    it("invalidates cache on config change", async () => {
      mockPool.query
        .mockResolvedValueOnce(mockProviderRows("mtn", 100, 90, 200, 400, 30, null))
        .mockResolvedValueOnce(mockProviderRows("airtel", 100, 95, 100, 200, 30, null))
        .mockResolvedValueOnce(mockProviderRows("orange", 100, 80, 500, 1000, 30, null));

      await service.getPerformanceRankings();

      service.updateScoringConfig({ stickySessionTtlMs: 999 });

      mockPool.query
        .mockResolvedValueOnce(mockProviderRows("mtn", 50, 45, 300, 600, 15, null))
        .mockResolvedValueOnce(mockProviderRows("airtel", 50, 48, 120, 240, 15, null))
        .mockResolvedValueOnce(mockProviderRows("orange", 50, 40, 600, 1200, 15, null));

      const rankings = await service.getPerformanceRankings();
      expect(rankings.rankings[0].provider).toBe("airtel");
    });
  });

  // ---------------------------------------------------------------------------
  // Performance rankings
  // ---------------------------------------------------------------------------

  describe("performance rankings", () => {
    it("returns rankings sorted by composite score", async () => {
      mockPool.query
        .mockResolvedValueOnce(mockProviderRows("mtn", 100, 90, 200, 400, 30, null))
        .mockResolvedValueOnce(mockProviderRows("airtel", 100, 95, 100, 200, 30, null))
        .mockResolvedValueOnce(mockProviderRows("orange", 100, 80, 500, 1000, 30, null));

      const rankings = await service.getPerformanceRankings();
      expect(rankings.rankings).toHaveLength(3);

      for (let i = 1; i < rankings.rankings.length; i++) {
        expect(rankings.rankings[i - 1].compositeScore).toBeGreaterThanOrEqual(
          rankings.rankings[i].compositeScore,
        );
      }
    });

    it("caches rankings until invalidated", async () => {
      mockPool.query
        .mockResolvedValueOnce(mockProviderRows("mtn", 100, 90, 200, 400, 30, null))
        .mockResolvedValueOnce(mockProviderRows("airtel", 100, 95, 100, 200, 30, null))
        .mockResolvedValueOnce(mockProviderRows("orange", 100, 80, 500, 1000, 30, null));

      await service.getPerformanceRankings();
      await service.getPerformanceRankings();

      expect(mockPool.query).toHaveBeenCalledTimes(3);
    });

    it("includes weights and timestamp in rankings", async () => {
      mockPool.query
        .mockResolvedValueOnce(mockProviderRows("mtn", 0, 0, null, null, 0, null))
        .mockResolvedValueOnce(mockProviderRows("airtel", 0, 0, null, null, 0, null))
        .mockResolvedValueOnce(mockProviderRows("orange", 0, 0, null, null, 0, null));

      const rankings = await service.getPerformanceRankings();
      expect(rankings.weights).toBeDefined();
      expect(rankings.generatedAt).toBeTruthy();
    });

    it("handles providers with no call history", async () => {
      mockPool.query
        .mockResolvedValueOnce(mockProviderRows("mtn", 0, 0, null, null, 0, null))
        .mockResolvedValueOnce(mockProviderRows("airtel", 0, 0, null, null, 0, null))
        .mockResolvedValueOnce(mockProviderRows("orange", 0, 0, null, null, 0, null));

      const rankings = await service.getPerformanceRankings();
      expect(rankings.rankings).toHaveLength(3);
      for (const r of rankings.rankings) {
        expect(r.totalCalls).toBe(0);
        expect(r.successRate).toBe(0);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Record provider calls
  // ---------------------------------------------------------------------------

  describe("recordProviderCall", () => {
    it("inserts a record into provider_api_calls", async () => {
      mockPool.query.mockResolvedValue({ rows: [] });
      await service.recordProviderCall("mtn", true, 150);
      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining("INSERT INTO provider_api_calls"),
        ["mtn", true, 150],
      );
    });

    it("invalidates ranking cache on new call", async () => {
      mockPool.query
        .mockResolvedValueOnce(mockProviderRows("mtn", 100, 90, 200, 400, 30, null))
        .mockResolvedValueOnce(mockProviderRows("airtel", 100, 95, 100, 200, 30, null))
        .mockResolvedValueOnce(mockProviderRows("orange", 100, 80, 500, 1000, 30, null));

      await service.getPerformanceRankings();

      mockPool.query.mockResolvedValue({ rows: [] });
      await service.recordProviderCall("mtn", true, 100);

      mockPool.query
        .mockResolvedValueOnce(mockProviderRows("mtn", 101, 91, 195, 390, 31, null))
        .mockResolvedValueOnce(mockProviderRows("airtel", 100, 95, 100, 200, 30, null))
        .mockResolvedValueOnce(mockProviderRows("orange", 100, 80, 500, 1000, 30, null));

      await service.getPerformanceRankings();
      expect(mockPool.query).toHaveBeenCalledTimes(7);
    });
  });

  // ---------------------------------------------------------------------------
  // Latency scoring
  // ---------------------------------------------------------------------------

  describe("latency scoring", () => {
    it("faster providers score higher", async () => {
      mockPool.query
        .mockResolvedValueOnce(mockProviderRows("mtn", 100, 100, 50, 100, 30, null))
        .mockResolvedValueOnce(mockProviderRows("airtel", 100, 100, 500, 1000, 30, null))
        .mockResolvedValueOnce(mockProviderRows("orange", 100, 100, 5000, 8000, 30, null));

      const rankings = await service.getPerformanceRankings();
      expect(rankings.rankings[0].provider).toBe("mtn");
      expect(rankings.rankings[1].provider).toBe("airtel");
      expect(rankings.rankings[2].provider).toBe("orange");
    });
  });

  // ---------------------------------------------------------------------------
  // Success rate scoring
  // ---------------------------------------------------------------------------

  describe("success rate scoring", () => {
    it("higher success rates score higher when latencies are equal", async () => {
      mockPool.query
        .mockResolvedValueOnce(mockProviderRows("mtn", 100, 80, 200, 400, 30, null))
        .mockResolvedValueOnce(mockProviderRows("airtel", 100, 95, 200, 400, 30, null))
        .mockResolvedValueOnce(mockProviderRows("orange", 100, 60, 200, 400, 30, null));

      const rankings = await service.getPerformanceRankings();
      expect(rankings.rankings[0].provider).toBe("airtel");
      expect(rankings.rankings[1].provider).toBe("mtn");
      expect(rankings.rankings[2].provider).toBe("orange");
    });
  });
});
