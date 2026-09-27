#!/usr/bin/env node
import { Command } from "commander";
import inquirer from "inquirer";
import { registerAuthCommand } from "./commands/auth";
import { registerConfigCommand } from "./commands/config";
import { registerRetryCommand } from "./commands/retry";
import { registerStatusCommand } from "./commands/status";
import { registerDashboardCommand } from "./commands/dashboard";
import { hasTelemetryPreference, setTelemetryEnabled } from "./config";

/**
 * Shows the first-run telemetry consent prompt.
 * This ensures users explicitly opt-in before any data is collected.
 */
async function promptTelemetryConsent(): Promise<void> {
  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("  Welcome to momo-cli! 🚀");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
  console.log("Before you begin, we'd like to ask about telemetry.\n");
  console.log("Telemetry helps us improve the CLI by collecting:");
  console.log("  • Commands used (e.g., auth.check, status)");
  console.log("  • Success/failure rates");
  console.log("  • Performance metrics (execution time)\n");
  console.log("We NEVER collect:");
  console.log("  • Phone numbers or personal data");
  console.log("  • Transaction details or amounts");
  console.log("  • API keys or credentials\n");

  const { consent } = await inquirer.prompt([
    {
      type: "confirm",
      name: "consent",
      message: "Would you like to enable anonymous telemetry?",
      default: false, // Privacy-first: default to opt-out
    },
  ]);

  setTelemetryEnabled(consent);

  if (consent) {
    console.log("\n✓ Telemetry enabled. Thank you for helping improve momo-cli!");
  } else {
    console.log("\n✓ Telemetry disabled. No usage data will be collected.");
  }
  console.log("  You can change this anytime with: momo-cli config telemetry on|off\n");
}

const program = new Command("momo-cli")
  .version("1.0.0")
  .description("Admin maintenance CLI for mobile-money");

// Register commands first
registerAuthCommand(program);
registerStatusCommand(program);
registerRetryCommand(program);
registerConfigCommand(program);
registerDashboardCommand(program);

// Check for first-run consent before parsing commands
async function main(): Promise<void> {
  // Skip consent prompt if user is already configuring telemetry
  const args = process.argv.slice(2);
  const isConfigTelemetry = args.includes("config") && args.includes("telemetry");

  if (!hasTelemetryPreference() && !isConfigTelemetry) {
    await promptTelemetryConsent();
  }

  await program.parseAsync(process.argv);
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`✗ ${msg}`);
  process.exit(1);
});
