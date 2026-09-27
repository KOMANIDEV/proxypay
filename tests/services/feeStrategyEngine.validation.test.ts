/**
 * Fee calculation verification tests (Issue #623).
 *
 * Covers the post-calculation safety bounds applied by FeeStrategyEngine:
 *   - calculated fee must be finite and >= 0
 *   - calculated fee must not exceed the effective cap (1% of the transaction
 *     by default, unless the strategy declares its own `feeMaximum`)
 *   - every calculation is logged for the audit trail
 */

// ── Mocks must be declared before imports ────────────────────────────────────
jest.mock("../../src/config/database", () => ({
  pool: { query: jest.fn(), connect: jest.fn() },
}));

jest.mock("../../src/config/redis", () => ({
  redisClient: {
    get: jest.fn().mockResolvedValue(null),
    setEx: jest.fn().mockResolvedValue("OK"),
    del: jest.fn().mockResolvedValue(1),
    keys: jest.fn().mockResolvedValue([]),
    isOpen: true,
  },
}));

import { pool } from "../../src/config/database";
import {
  FeeStrategyEngine,
  FeeStrategy,
  getMaxFeeRate,
  DEFAULT_MAX_FEE_RATE,
} from "../../src/services/feeStrategyEngine";
import logger from "../../src/utils/logger";

const mockPool = pool as jest.Mocked<typeof pool>;

const ADMIN_ID = "00000000-0000-0000-0000-000000000001";

function makeStrategy(overrides: Partial<FeeStrategy> = {}): FeeStrategy {
  return {
    id: "aaaaaaaa-0000-0000-0000-000000000001",
    name: "Validation Strategy",
    strategyType: "percentage",
    scope: "global",
    priority: 100,
    isActive: true,
    createdBy: ADMIN_ID,
    updatedBy: ADMIN_ID,
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
    ...overrides,
  };
}

function pgResult(strategies: FeeStrategy[]) {
  const rows = strategies.map((s) => ({
    id: s.id,
    name: s.name,
    description: s.description ?? null,
    strategy_type: s.strategyType,
    scope: s.scope,
    user_id: s.userId ?? null,
    provider: s.provider ?? null,
    priority: s.priority,
    is_active: s.isActive,
    flat_amount: s.flatAmount ?? null,
    fee_percentage: s.feePercentage ?? null,
    fee_minimum: s.feeMinimum ?? null,
    fee_maximum: s.feeMaximum ?? null,
    days_of_week: s.daysOfWeek ?? null,
    time_start: s.timeStart ?? null,
    time_end: s.timeEnd ?? null,
    override_percentage: s.overridePercentage ?? null,
    override_flat_amount: s.overrideFlatAmount ?? null,
    volume_tiers: s.volumeTiers ?? null,
    created_by: s.createdBy,
    updated_by: s.updatedBy,
    created_at: s.createdAt,
    updated_at: s.updatedAt,
  }));
  return { rows, rowCount: rows.length };
}

describe("FeeStrategyEngine fee calculation verification (#623)", () => {
  let engine: FeeStrategyEngine;
  const originalRate = process.env.FEE_STRATEGY_MAX_FEE_RATE;

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.FEE_STRATEGY_MAX_FEE_RATE;
    engine = new FeeStrategyEngine();
  });

  afterAll(() => {
    if (originalRate === undefined) delete process.env.FEE_STRATEGY_MAX_FEE_RATE;
    else process.env.FEE_STRATEGY_MAX_FEE_RATE = originalRate;
  });

  it("exposes a 1% default maximum fee rate", () => {
    expect(DEFAULT_MAX_FEE_RATE).toBe(0.01);
    expect(getMaxFeeRate()).toBe(0.01);
  });

  it("clamps fees above the 1% safety cap when no feeMaximum is configured", async () => {
    // 10% of 10_000 = 1_000, but the safety cap for 10_000 is 100
    const strategy = makeStrategy({ feePercentage: 10, scope: "global" });
    mockPool.query.mockResolvedValueOnce(pgResult([strategy]) as any);

    const result = await engine.calculateFee({ amount: 10_000 });

    expect(result.fee).toBe(100);
    expect(result.total).toBe(10_100);
    expect(result.validation.capped).toBe(true);
    expect(result.validation.invalid).toBe(false);
    expect(result.validation.appliedFeeCap).toBe(100);
    expect(result.validation.warnings.join(" ")).toContain("exceeds");
  });

  it("keeps an explicitly configured feeMaximum as the operator-authored cap", async () => {
    const strategy = makeStrategy({
      feePercentage: 1.5,
      feeMinimum: 50,
      feeMaximum: 5000,
    });
    mockPool.query.mockResolvedValueOnce(pgResult([strategy]) as any);

    const result = await engine.calculateFee({ amount: 10_000 });

    expect(result.fee).toBe(150);
    expect(result.validation.capped).toBe(false);
    expect(result.validation.appliedFeeCap).toBe(5000);
  });

  it("clamps negative fees to zero and marks them invalid", async () => {
    const strategy = makeStrategy({ strategyType: "flat", flatAmount: -75 });
    mockPool.query.mockResolvedValueOnce(pgResult([strategy]) as any);

    const result = await engine.calculateFee({ amount: 10_000 });

    expect(result.fee).toBe(0);
    expect(result.total).toBe(10_000);
    expect(result.validation.invalid).toBe(true);
    expect(result.validation.capped).toBe(false);
    expect(result.validation.warnings.join(" ")).toContain("invalid");
  });

  it("accepts fees within the bounds without warnings", async () => {
    const strategy = makeStrategy({ strategyType: "flat", flatAmount: 50 });
    mockPool.query.mockResolvedValueOnce(pgResult([strategy]) as any);

    const result = await engine.calculateFee({ amount: 10_000 });

    expect(result.fee).toBe(50);
    expect(result.validation.capped).toBe(false);
    expect(result.validation.invalid).toBe(false);
    expect(result.validation.warnings).toHaveLength(0);
  });

  it("honours the FEE_STRATEGY_MAX_FEE_RATE override", async () => {
    process.env.FEE_STRATEGY_MAX_FEE_RATE = "0.05";
    expect(getMaxFeeRate()).toBe(0.05);

    const strategy = makeStrategy({ feePercentage: 10 });
    mockPool.query.mockResolvedValueOnce(pgResult([strategy]) as any);

    const result = await engine.calculateFee({ amount: 10_000 });

    // 10% of 10_000 = 1_000 -> capped at 5% of 10_000 = 500
    expect(result.fee).toBe(500);
    expect(result.validation.capped).toBe(true);
  });

  it("writes an audit log line for every applied fee", async () => {
    const infoSpy = jest.spyOn(logger, "info").mockImplementation(() => logger);
    const strategy = makeStrategy({ feePercentage: 0.5 });
    mockPool.query.mockResolvedValueOnce(pgResult([strategy]) as any);

    await engine.calculateFee({ amount: 10_000, userId: "user-1" });

    expect(infoSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "fee_calculation",
        amount: 10_000,
        fee: 50,
        strategyId: strategy.id,
        userId: "user-1",
      }),
      "[FeeStrategyEngine] fee calculation",
    );
    infoSpy.mockRestore();
  });

  it("logs a warning when a fee is adjusted", async () => {
    const warnSpy = jest.spyOn(logger, "warn").mockImplementation(() => logger);
    const strategy = makeStrategy({ strategyType: "flat", flatAmount: -10 });
    mockPool.query.mockResolvedValueOnce(pgResult([strategy]) as any);

    await engine.calculateFee({ amount: 1_000 });

    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ event: "fee_calculation_validation" }),
      expect.stringContaining("failed validation"),
    );
    warnSpy.mockRestore();
  });
});

