/**
 * Unit tests — SettlementStatusService
 *
 * Issue #411 — Real-Time Transaction Settlement Status
 */

import {
  SettlementStatusService,
  SettlementStage,
  stageProgressPercent,
  isValidStageTransition,
  getSettlementHistory,
  settlementStatusService,
} from "../../../src/services/settlementStatus";
import * as database from "../../../src/config/database";
import * as subscriptions from "../../../src/graphql/subscriptions";
import { WebSocketManager } from "../../../src/websocket/websocketManager";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

jest.mock("../../../src/config/database", () => ({
  queryRead: jest.fn(),
  queryWrite: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
}));

jest.mock("../../../src/graphql/subscriptions", () => ({
  pubsub: {
    publish: jest.fn().mockResolvedValue(undefined),
  },
  SubscriptionChannels: {
    TRANSACTION_UPDATED: "transaction.updated",
  },
}));

jest.mock("../../../src/websocket/websocketManager", () => ({
  WebSocketManager: {
    getInstance: jest.fn().mockReturnValue({
      broadcastTransactionUpdate: jest.fn().mockResolvedValue(undefined),
    }),
  },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TX_ID = "00000000-0000-0000-0000-000000000001";

function mockCurrentStage(stage: SettlementStage | null): void {
  (database.queryRead as jest.Mock).mockResolvedValueOnce({
    rows:
      stage !== null
        ? [{ settlement_stage: stage }]
        : [],
  });
}

// ---------------------------------------------------------------------------
// stageProgressPercent
// ---------------------------------------------------------------------------

describe("stageProgressPercent()", () => {
  it("returns 0 for FAILED", () => {
    expect(stageProgressPercent(SettlementStage.FAILED)).toBe(0);
  });

  it("returns 0 for CANCELLED", () => {
    expect(stageProgressPercent(SettlementStage.CANCELLED)).toBe(0);
  });

  it("returns 100 for COMPLETED", () => {
    expect(stageProgressPercent(SettlementStage.COMPLETED)).toBe(100);
  });

  it("returns a value between 1 and 99 for intermediate stages", () => {
    const pct = stageProgressPercent(SettlementStage.STELLAR_SUBMITTED);
    expect(pct).toBeGreaterThan(0);
    expect(pct).toBeLessThan(100);
  });

  it("increases monotonically through the happy-path stage order", () => {
    const stages = [
      SettlementStage.INITIATED,
      SettlementStage.PROVIDER_ACCEPTED,
      SettlementStage.MOBILE_MONEY_CONFIRMED,
      SettlementStage.STELLAR_SUBMITTED,
      SettlementStage.STELLAR_CONFIRMED,
      SettlementStage.PAYOUT_INITIATED,
      SettlementStage.COMPLETED,
    ];
    const pcts = stages.map(stageProgressPercent);
    for (let i = 1; i < pcts.length; i++) {
      expect(pcts[i]).toBeGreaterThan(pcts[i - 1]);
    }
  });
});

// ---------------------------------------------------------------------------
// isValidStageTransition
// ---------------------------------------------------------------------------

describe("isValidStageTransition()", () => {
  it("allows INITIATED as the first stage (from null)", () => {
    expect(isValidStageTransition(null, SettlementStage.INITIATED)).toBe(true);
  });

  it("rejects non-INITIATED stage from null", () => {
    expect(
      isValidStageTransition(null, SettlementStage.PROVIDER_ACCEPTED),
    ).toBe(false);
  });

  it("allows sequential progression", () => {
    expect(
      isValidStageTransition(
        SettlementStage.INITIATED,
        SettlementStage.PROVIDER_ACCEPTED,
      ),
    ).toBe(true);
  });

  it("rejects skipping stages", () => {
    expect(
      isValidStageTransition(
        SettlementStage.INITIATED,
        SettlementStage.STELLAR_SUBMITTED,
      ),
    ).toBe(false);
  });

  it("allows transitioning to FAILED from any non-terminal stage", () => {
    expect(
      isValidStageTransition(
        SettlementStage.STELLAR_SUBMITTED,
        SettlementStage.FAILED,
      ),
    ).toBe(true);
  });

  it("allows transitioning to CANCELLED from any non-terminal stage", () => {
    expect(
      isValidStageTransition(
        SettlementStage.PROVIDER_ACCEPTED,
        SettlementStage.CANCELLED,
      ),
    ).toBe(true);
  });

  it("rejects transitions from COMPLETED (terminal)", () => {
    expect(
      isValidStageTransition(
        SettlementStage.COMPLETED,
        SettlementStage.FAILED,
      ),
    ).toBe(false);
  });

  it("rejects transitions from FAILED (terminal)", () => {
    expect(
      isValidStageTransition(
        SettlementStage.FAILED,
        SettlementStage.INITIATED,
      ),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// SettlementStatusService.advanceStage()
// ---------------------------------------------------------------------------

describe("SettlementStatusService.advanceStage()", () => {
  let service: SettlementStatusService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new SettlementStatusService();
  });

  it("persists the stage transition and returns a payload", async () => {
    mockCurrentStage(null); // no existing stage → first stage

    const payload = await service.advanceStage(TX_ID, SettlementStage.INITIATED);

    expect(payload.transactionId).toBe(TX_ID);
    expect(payload.stage).toBe(SettlementStage.INITIATED);
    expect(payload.previousStage).toBeNull();
    expect(payload.progressPercent).toBeGreaterThan(0);
    expect(payload.isTerminal).toBe(false);
    expect(database.queryWrite).toHaveBeenCalled();
  });

  it("publishes to GraphQL pubsub after a valid transition", async () => {
    mockCurrentStage(null);

    await service.advanceStage(TX_ID, SettlementStage.INITIATED);

    // Allow the fire-and-forget publish to complete
    await new Promise((r) => setImmediate(r));

    expect(subscriptions.pubsub.publish).toHaveBeenCalled();
  });

  it("broadcasts to WebSocket after a valid transition", async () => {
    mockCurrentStage(null);

    await service.advanceStage(TX_ID, SettlementStage.INITIATED);

    const wsInstance = (WebSocketManager.getInstance as jest.Mock).mock.results[0]?.value;
    expect(wsInstance?.broadcastTransactionUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ id: TX_ID }),
    );
  });

  it("throws for an invalid stage transition", async () => {
    // Current stage is INITIATED — skipping to STELLAR_SUBMITTED should fail
    mockCurrentStage(SettlementStage.INITIATED);

    await expect(
      service.advanceStage(TX_ID, SettlementStage.STELLAR_SUBMITTED),
    ).rejects.toThrow("Invalid stage transition");
  });

  it("marks payload as terminal when advancing to COMPLETED", async () => {
    mockCurrentStage(SettlementStage.PAYOUT_INITIATED);

    const payload = await service.advanceStage(
      TX_ID,
      SettlementStage.COMPLETED,
    );

    expect(payload.isTerminal).toBe(true);
    expect(payload.progressPercent).toBe(100);
  });

  it("marks payload as terminal when advancing to FAILED", async () => {
    mockCurrentStage(SettlementStage.STELLAR_SUBMITTED);

    const payload = await service.advanceStage(TX_ID, SettlementStage.FAILED);

    expect(payload.isTerminal).toBe(true);
    expect(payload.progressPercent).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// SettlementStatusService.getHistory() / getSettlementHistory()
// ---------------------------------------------------------------------------

describe("getSettlementHistory()", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns an array of stage records in chronological order", async () => {
    const rows = [
      {
        transaction_id: TX_ID,
        stage: SettlementStage.INITIATED,
        previous_stage: null,
        metadata: {},
        occurred_at: new Date("2024-01-01T00:00:00Z"),
      },
      {
        transaction_id: TX_ID,
        stage: SettlementStage.PROVIDER_ACCEPTED,
        previous_stage: SettlementStage.INITIATED,
        metadata: {},
        occurred_at: new Date("2024-01-01T00:01:00Z"),
      },
    ];
    (database.queryRead as jest.Mock).mockResolvedValueOnce({ rows });

    const history = await getSettlementHistory(TX_ID);
    expect(history).toHaveLength(2);
    expect(history[0].stage).toBe(SettlementStage.INITIATED);
    expect(history[1].stage).toBe(SettlementStage.PROVIDER_ACCEPTED);
  });

  it("returns an empty array when no history exists", async () => {
    (database.queryRead as jest.Mock).mockResolvedValueOnce({ rows: [] });
    const history = await getSettlementHistory(TX_ID);
    expect(history).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Singleton export
// ---------------------------------------------------------------------------

describe("settlementStatusService singleton", () => {
  it("is an instance of SettlementStatusService", () => {
    expect(settlementStatusService).toBeInstanceOf(SettlementStatusService);
  });
});
