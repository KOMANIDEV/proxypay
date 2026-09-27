import { Command } from "commander";
import { getTransaction, retryTransaction } from "../api";
import { trackEvent } from "../telemetry";

export function registerRetryCommand(program: Command): void {
  program
    .command("retry <transactionId>")
    .description("Force-retry a failed transaction")
    .action(async (transactionId: string) => {
      const start = Date.now();
      try {
        const tx = await getTransaction(transactionId);

        if (tx.status === "pending" || tx.status === "completed") {
          trackEvent({ command: "retry", success: true, durationMs: Date.now() - start });
          console.log(
            `⚠ Transaction ${transactionId} is already ${tx.status} — no action taken.`,
          );
          process.exit(0);
        }

        await retryTransaction(transactionId);
        trackEvent({ command: "retry", success: true, durationMs: Date.now() - start });
        console.log(
          `✓ Transaction ${transactionId} reset to pending — worker will pick it up shortly.`,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        trackEvent({ command: "retry", success: false, durationMs: Date.now() - start });
        console.error(`✗ ${msg}`);
        process.exit(1);
      }
    });
}
