jest.mock("../../src/config/database", () => ({
  pool: { query: jest.fn().mockResolvedValue({ rows: [], rowCount: 1 }) },
}));

import { pool } from "../../src/config/database";
import { recordSorobanInteraction } from "../../src/services/stellar/sorobanInteractionLogger";

describe("recordSorobanInteraction", () => {
  it("persists contract, state-change, transaction, and gas metadata", async () => {
    await recordSorobanInteraction({
      contractId: "CXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
      method: "claim",
      sourceAccount: "GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
      stateChange: true,
      arguments: { preimage: "[REDACTED]" },
      transactionHash: "abc123",
      status: "confirmed",
      simulationGasUsed: 1200,
      executionGasUsed: 1300,
      resourceFee: "42",
    });

    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO soroban_interaction_logs"),
      expect.arrayContaining([
        "claim",
        true,
        JSON.stringify({ preimage: "[REDACTED]" }),
        1200,
        1300,
        "42",
      ]),
    );
  });
});
