import { CrossChainMonitorService } from "../services/crossChainMonitorService";

export async function runCrossChainMonitorJob(): Promise<void> {
  const snapshots = await CrossChainMonitorService.getInstance().snapshot();
  console.log(
    `[cross-chain-monitor] Captured ${snapshots.length} asset snapshot(s)`,
  );
}
