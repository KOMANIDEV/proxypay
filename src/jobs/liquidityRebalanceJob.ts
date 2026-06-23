import { runLiquidityRebalance } from "../services/liquidityTransferService";

export async function runLiquidityRebalanceJob(): Promise<void> {
  await runLiquidityRebalance();
}
