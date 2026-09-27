import dotenv from "dotenv";
import fs from "fs";
import os from "os";
import path from "path";

// Load .momorc from the cli/ directory, fall back to process.env
const MOMORC_PATH = path.resolve(__dirname, "..", ".momorc");
dotenv.config({ path: MOMORC_PATH });

export interface CliConfig {
  apiUrl: string;
  apiKey: string;
  telemetry: boolean | undefined;
}

export interface Profile {
  name: string;
  apiUrl: string;
  apiKey: string;
}

export interface ProfilesFile {
  profiles: Profile[];
  activeProfile?: string;
}

const PROFILES_FILE = path.resolve(__dirname, "..", ".momo-profiles.json");

/**
 * Path to ~/.momorc for persistent telemetry preference storage.
 * This ensures the preference survives across project directories.
 */
const HOME_MOMORC_PATH = path.join(os.homedir(), ".momorc");

function loadProfiles(): ProfilesFile {
  if (!fs.existsSync(PROFILES_FILE)) {
    return { profiles: [] };
  }
  try {
    const content = fs.readFileSync(PROFILES_FILE, "utf-8");
    return JSON.parse(content);
  } catch {
    return { profiles: [] };
  }
}

function saveProfiles(data: ProfilesFile): void {
  fs.writeFileSync(PROFILES_FILE, JSON.stringify(data, null, 2), "utf-8");
}

export function getConfig(): CliConfig {
  const profiles = loadProfiles();
  let apiKey: string | undefined;
  let apiUrl: string | undefined;

  // If an active profile is set, use it
  if (profiles.activeProfile) {
    const activeProfile = profiles.profiles.find(
      (p) => p.name === profiles.activeProfile,
    );
    if (activeProfile) {
      apiUrl = activeProfile.apiUrl;
      apiKey = activeProfile.apiKey;
    }
  }

  // Fall back to environment variables
  if (!apiKey) {
    apiKey = process.env.MOMO_API_KEY;
  }
  if (!apiUrl) {
    apiUrl = process.env.MOMO_API_URL;
  }

  if (!apiKey) {
    throw new Error(
      "MOMO_API_KEY is required. Set it in cli/.momorc, as an environment variable, or use 'momo-cli profile save'.",
    );
  }

  return {
    apiUrl: apiUrl ?? "http://localhost:3000",
    apiKey,
    telemetry: getTelemetryEnabled(),
  };
}

/**
 * Reads a MOMO_TELEMETRY value from a .momorc file at the given path.
 * Returns undefined if the file or key doesn't exist.
 */
function readTelemetryFromRc(rcPath: string): boolean | undefined {
  if (!fs.existsSync(rcPath)) return undefined;

  try {
    const content = fs.readFileSync(rcPath, "utf-8");
    const line = content.split("\n").find((l) => l.trimStart().startsWith("MOMO_TELEMETRY="));
    if (!line) return undefined;
    const value = line.split("=")[1]?.trim().toLowerCase();
    if (value === "true") return true;
    if (value === "false") return false;
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Checks whether the user has explicitly set a telemetry preference.
 * Returns false if no preference has been stored anywhere.
 */
export function hasTelemetryPreference(): boolean {
  // Check process env first
  if (process.env.MOMO_TELEMETRY === "true" || process.env.MOMO_TELEMETRY === "false") {
    return true;
  }
  // Check local .momorc
  if (readTelemetryFromRc(MOMORC_PATH) !== undefined) return true;
  // Check home directory ~/.momorc
  if (readTelemetryFromRc(HOME_MOMORC_PATH) !== undefined) return true;
  return false;
}

/**
 * Returns whether anonymous telemetry collection is enabled.
 * Returns undefined if no preference has been set (first run).
 * Defaults to true if env var is set but not "false".
 */
export function getTelemetryEnabled(): boolean | undefined {
  // Check process env first
  if (process.env.MOMO_TELEMETRY === "false") return false;
  if (process.env.MOMO_TELEMETRY === "true") return true;

  // Check local .momorc
  const localPref = readTelemetryFromRc(MOMORC_PATH);
  if (localPref !== undefined) return localPref;

  // Check home directory ~/.momorc
  const homePref = readTelemetryFromRc(HOME_MOMORC_PATH);
  if (homePref !== undefined) return homePref;

  // No preference set - first run scenario
  return undefined;
}

/**
 * Returns whether telemetry is enabled, treating undefined (first run) as disabled.
 * Use this in trackEvent to ensure we don't collect data before user consents.
 */
export function isTelemetryActive(): boolean {
  return getTelemetryEnabled() === true;
}

/**
 * Persists the telemetry setting to both local .momorc and ~/.momorc.
 * This ensures the preference is available regardless of working directory.
 */
export function setTelemetryEnabled(enabled: boolean): void {
  const value = enabled ? "true" : "false";
  const key = "MOMO_TELEMETRY";
  const entry = `${key}=${value}`;

  // Update local .momorc
  updateRcFile(MOMORC_PATH, key, entry);

  // Update home directory ~/.momorc
  updateRcFile(HOME_MOMORC_PATH, key, entry);

  // Keep the current process in sync without a restart
  process.env[key] = value;
}

/**
 * Updates a .momorc file with a new key=value entry.
 */
function updateRcFile(rcPath: string, key: string, entry: string): void {
  let lines: string[] = [];

  if (fs.existsSync(rcPath)) {
    lines = fs.readFileSync(rcPath, "utf-8").split("\n");
  }

  const idx = lines.findIndex((l) => l.trimStart().startsWith(`${key}=`));

  if (idx !== -1) {
    lines[idx] = entry;
  } else {
    lines.push(entry);
  }

  const content =
    lines
      .filter((l, i) => l.trim() !== "" || i < lines.length - 1)
      .join("\n")
      .trimEnd() + "\n";
  fs.writeFileSync(rcPath, content, "utf-8");
}

/**
 * What telemetry data is collected (privacy documentation):
 *
 * COLLECTED:
 * - Command name (e.g., "auth.check", "status", "retry")
 * - Command success/failure status
 * - Command execution duration in milliseconds
 * - Anonymous machine identifier (hashed, non-PII)
 *
 * NOT COLLECTED:
 * - Phone numbers or any user-provided data
 * - Transaction details or amounts
 * - API keys or credentials
 * - IP addresses
 * - File paths or directory names
 * - Any personally identifiable information (PII)
 *
 * DATA USAGE:
 * - Telemetry is used solely to improve CLI reliability and performance
 * - Data is aggregated and never shared with third parties
 * - You can opt out at any time with: momo-cli config telemetry off
 */
