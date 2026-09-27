import { Command } from "commander";
import { getTelemetryEnabled, setTelemetryEnabled } from "../config";

export function registerConfigCommand(program: Command): void {
  const config = program
    .command("config")
    .description("Manage CLI configuration");

  const telemetry = config
    .command("telemetry")
    .description("Configure anonymous telemetry collection");

  telemetry
    .command("on")
    .description("Enable anonymous telemetry")
    .action(() => {
      setTelemetryEnabled(true);
      console.log("✓ Telemetry enabled. Thank you for helping improve momo-cli!");
      console.log("  Preference saved to ~/.momorc");
    });

  telemetry
    .command("off")
    .description("Disable anonymous telemetry")
    .action(() => {
      setTelemetryEnabled(false);
      console.log("✓ Telemetry disabled. No usage data will be collected.");
      console.log("  Preference saved to ~/.momorc");
    });

  telemetry
    .command("status")
    .description("Show current telemetry setting")
    .action(() => {
      const enabled = getTelemetryEnabled();
      if (enabled === undefined) {
        console.log("Telemetry status: not configured (first run)");
        console.log("  Run 'momo-cli config telemetry on' or 'momo-cli config telemetry off'");
      } else {
        console.log(`Telemetry status: ${enabled ? "enabled ✓" : "disabled ✗"}`);
      }
    });

  telemetry
    .command("what")
    .description("Show what data is collected by telemetry")
    .action(() => {
      console.log("\n📋 Telemetry Data Collection Policy\n");
      console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
      console.log("\n✅ WHAT WE COLLECT:");
      console.log("  • Command name (e.g., auth.check, status, retry)");
      console.log("  • Command success/failure status");
      console.log("  • Command execution duration in milliseconds");
      console.log("  • Anonymous machine ID (hashed hostname:username)");
      console.log("  • CLI version and Node.js version");
      console.log("  • Platform (linux, darwin, win32)\n");
      console.log("❌ WHAT WE NEVER COLLECT:");
      console.log("  • Phone numbers or personal data");
      console.log("  • Transaction details, amounts, or IDs");
      console.log("  • API keys or credentials");
      console.log("  • IP addresses");
      console.log("  • File paths or directory names");
      console.log("  • Any personally identifiable information (PII)\n");
      console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
      console.log("\nYour privacy is protected. You can opt out anytime with:");
      console.log("  momo-cli config telemetry off\n");
    });
}
