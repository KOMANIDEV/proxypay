import { Command } from "commander";
import { getTransaction } from "../api";
import { trackEvent } from "../telemetry";

export function registerStatusCommand(program: Command): void {
  program
    .command("status <transactionId>")
    .description("Get transaction details")
    .action(async (transactionId: string) => {
      const start = Date.now();
      try {
        const tx = await getTransaction(transactionId);
        trackEvent({ command: "status", success: true, durationMs: Date.now() - start });
        console.log(`Transaction: ${tx.id}`);
        console.log(`Reference:   ${tx.referenceNumber}`);
        console.log(`Type:        ${tx.type}`);
        console.log(`Amount:      ${tx.amount}`);
        console.log(`Phone:       ${tx.phoneNumber}`);
        console.log(`Provider:    ${tx.provider}`);
        console.log(`Status:      ${tx.status}`);
        console.log(`Retries:     ${tx.retryCount}`);
        console.log(`Created:     ${tx.createdAt}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        trackEvent({ command: "status", success: false, durationMs: Date.now() - start });
        console.error(`✗ ${msg}`);
        process.exit(1);
      }
    });
}
