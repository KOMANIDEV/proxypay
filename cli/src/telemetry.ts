import crypto from "crypto";
import os from "os";
import { isTelemetryActive } from "./config";

export interface TelemetryEvent {
  /** Command executed (e.g., "auth.check", "status", "retry") */
  command: string;
  /** Whether the command succeeded */
  success: boolean;
  /** Command execution duration in milliseconds */
  durationMs?: number;
  /** Anonymous machine identifier (hashed, non-PII) */
  machineId?: string;
  /** CLI version */
  cliVersion?: string;
  /** Node.js version */
  nodeVersion?: string;
  /** Platform (e.g., "linux", "darwin", "win32") */
  platform?: string;
}

/**
 * Generates a privacy-preserving anonymous machine identifier.
 * Uses a one-way hash of hostname + username to create a unique
 * but non-reversible identifier. No PII is stored.
 */
function generateAnonymousMachineId(): string {
  const hostname = os.hostname();
  const username = os.userInfo().username;
  // Combine and hash - this creates a consistent but anonymous ID
  const data = `${hostname}:${username}`;
  return crypto.createHash("sha256").update(data).digest("hex").substring(0, 16);
}

/**
 * Tracks an anonymous CLI usage event.
 * No-ops silently if telemetry is disabled (including first-run/undefined state).
 *
 * PRIVACY: Only command name, success status, and duration are collected.
 * No PII, transaction data, or sensitive information is ever sent.
 *
 * Replace the console.debug stub below with a real
 * analytics call (e.g. POST to your ingestion endpoint)
 * when you are ready to collect data.
 */
export function trackEvent(event: Omit<TelemetryEvent, "machineId" | "cliVersion" | "nodeVersion" | "platform">): void {
  // Don't collect if telemetry is disabled or not yet configured (first run)
  if (!isTelemetryActive()) {
    return;
  }

  const enrichedEvent: TelemetryEvent = {
    ...event,
    machineId: generateAnonymousMachineId(),
    cliVersion: "1.0.0", // Should be read from package.json in production
    nodeVersion: process.version,
    platform: process.platform,
  };

  // --- Stub: swap this for a real analytics call ---
  // e.g. axios.post("https://telemetry.example.com/events", enrichedEvent).catch(() => {});
  console.debug("[telemetry]", JSON.stringify(enrichedEvent));
  // -------------------------------------------------
}
