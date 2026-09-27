import { pool } from "../../config/database";
import logger from "../../utils/logger";

export type SorobanInteractionStatus =
  | "built"
  | "simulated"
  | "submitted"
  | "confirmed"
  | "failed";

export interface SorobanInteractionLog {
  contractId: string;
  method: string;
  sourceAccount?: string;
  stateChange: boolean;
  arguments?: Record<string, unknown>;
  transactionXdr?: string;
  transactionHash?: string;
  status: SorobanInteractionStatus;
  simulationGasUsed?: number;
  executionGasUsed?: number;
  resourceFee?: string;
  error?: string;
  metadata?: Record<string, unknown>;
}

export async function recordSorobanInteraction(
  interaction: SorobanInteractionLog,
): Promise<void> {
  const event = {
    event: "soroban_contract_interaction",
    ...interaction,
  };

  logger.audit(event, "Soroban contract interaction");

  try {
    await pool.query(
      `INSERT INTO soroban_interaction_logs (
        contract_id, method, source_account, state_change, arguments,
        transaction_xdr, transaction_hash, status, simulation_gas_used,
        execution_gas_used, resource_fee, error, metadata
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        interaction.contractId,
        interaction.method,
        interaction.sourceAccount ?? null,
        interaction.stateChange,
        JSON.stringify(interaction.arguments ?? {}),
        interaction.transactionXdr ?? null,
        interaction.transactionHash ?? null,
        interaction.status,
        interaction.simulationGasUsed ?? null,
        interaction.executionGasUsed ?? null,
        interaction.resourceFee ?? null,
        interaction.error ?? null,
        JSON.stringify(interaction.metadata ?? {}),
      ],
    );
  } catch (error) {
    logger.error(
      { err: error, contractId: interaction.contractId },
      "Failed to persist Soroban interaction",
    );
  }
}
