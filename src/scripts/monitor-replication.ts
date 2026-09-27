#!/usr/bin/env node
/**
 * Cross-Region Replication Monitor (DR)
 *
 * Connects to the primary, the DR database (if configured) and every read
 * replica (READ_REPLICA_URL, comma-separated) and reports:
 *   - role (primary / replica / promoted-DR)
 *   - recovery state (pg_is_in_recovery)
 *   - replay lag in seconds (pg_last_xact_replay_timestamp)
 *   - per-standby send/replay lag from the primary's pg_stat_replication
 *
 * Exits with code 1 when any configured endpoint is unreachable or its lag
 * exceeds REPLICA_SYNC_LAG_THRESHOLD_SECONDS (default 5) so it can be used
 * directly in a cron/scheduled alert.
 *
 * Usage:
 *   npm run monitor:replication
 *   DATABASE_URL=... READ_REPLICA_URL=... DR_DATABASE_URL=... npm run monitor:replication
 */

import dotenv from "dotenv";
import { Client } from "pg";

dotenv.config();

const LAG_THRESHOLD_SECONDS = (() => {
  const threshold = parseFloat(
    process.env.REPLICA_SYNC_LAG_THRESHOLD_SECONDS || "5",
  );
  return Number.isFinite(threshold) ? threshold : 5;
})();

type EndpointStatus = {
  name: string;
  url: string;
  reachable: boolean;
  inRecovery: boolean | null;
  lagSeconds: number | null;
};

function redact(url: string): string {
  try {
    const u = new URL(url);
    u.password = "***";
    return u.toString();
  } catch {
    return url;
  }
}

async function checkEndpoint(name: string, url: string): Promise<EndpointStatus> {
  const status: EndpointStatus = {
    name,
    url: redact(url),
    reachable: false,
    inRecovery: null,
    lagSeconds: null,
  };

  if (!url) return status;

  const client = new Client({ connectionString: url });
  try {
    await client.connect();
    const result = await client.query<{
      in_recovery: boolean;
      lag_seconds: number | null;
    }>(`
      SELECT pg_is_in_recovery() AS in_recovery,
             CASE
               WHEN pg_is_in_recovery()
                 THEN EXTRACT(EPOCH FROM (now() - pg_last_xact_replay_timestamp()))
               ELSE 0
             END AS lag_seconds
    `);
    status.reachable = true;
    status.inRecovery = result.rows[0]?.in_recovery ?? null;
    status.lagSeconds = result.rows[0]?.lag_seconds ?? null;
  } catch (err) {
    console.error(`[monitor:replication] Failed to reach ${name}:`, err);
  } finally {
    await client.end().catch(() => undefined);
  }

  return status;
}

async function checkPrimaryStandbys(primaryUrl: string) {
  if (!primaryUrl) return [];

  const client = new Client({ connectionString: primaryUrl });
  try {
    await client.connect();
    const result = await client.query<{
      client_addr: string | null;
      application_name: string | null;
      state: string | null;
      replay_bytes_behind: string | null;
    }>(`
      SELECT client_addr,
             application_name,
             state,
             pg_wal_lsn_diff(sent_lsn, replay_lsn) AS replay_bytes_behind
      FROM pg_stat_replication
    `);
    return result.rows;
  } catch (err) {
    console.error("[monitor:replication] Failed to query pg_stat_replication:", err);
    return [];
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function main() {
  const primaryUrl = process.env.DATABASE_URL || "";
  const drUrl = process.env.DR_DATABASE_URL || "";
  const replicaUrls = (process.env.READ_REPLICA_URL || "")
    .split(",")
    .map((u) => u.trim())
    .filter(Boolean);

  console.log("=====================================================");
  console.log("📡 Cross-Region Replication Monitor");
  console.log(`   Threshold: ${LAG_THRESHOLD_SECONDS}s lag`);
  console.log(`   Time: ${new Date().toISOString()}`);
  console.log("=====================================================");

  const endpoints: EndpointStatus[] = [];
  if (primaryUrl) endpoints.push(await checkEndpoint("primary", primaryUrl));
  if (drUrl) endpoints.push(await checkEndpoint("dr (failover target)", drUrl));
  for (let i = 0; i < replicaUrls.length; i += 1) {
    endpoints.push(
      await checkEndpoint(`replica-${i + 1}`, replicaUrls[i]),
    );
  }

  let degraded = false;

  console.log("");
  console.log("Endpoint status:");
  for (const e of endpoints) {
    const role = e.inRecovery === null ? "-" : e.inRecovery ? "replica" : "primary";
    const lag = e.lagSeconds === null ? "-" : `${e.lagSeconds.toFixed(1)}s`;
    const flag =
      e.lagSeconds !== null && e.lagSeconds > LAG_THRESHOLD_SECONDS
        ? " ⚠ LAGGING"
        : "";
    if (!e.reachable || (e.lagSeconds !== null && e.lagSeconds > LAG_THRESHOLD_SECONDS)) {
      degraded = true;
    }
    console.log(
      `  ${e.name.padEnd(20)} ${e.reachable ? "ok  " : "DOWN"} role=${role.padEnd(7)} lag=${lag}${flag}`,
    );
  }

  const standbys = await checkPrimaryStandbys(primaryUrl);
  if (standbys.length > 0) {
    console.log("");
    console.log("Primary → standby replication (pg_stat_replication):");
    for (const s of standbys) {
      console.log(
        `  ${String(s.application_name || "standby").padEnd(20)} state=${String(s.state).padEnd(9)} replay_behind=${String(s.replay_bytes_behind ?? "-")} bytes`,
      );
    }
  }

  console.log("");
  if (degraded) {
    console.error(
      "❌ Degraded: one or more endpoints are unreachable or lagging " +
        `beyond ${LAG_THRESHOLD_SECONDS}s.`,
    );
    process.exit(1);
  }
  console.log("✅ All endpoints healthy.");
}

main().catch((err) => {
  console.error("[monitor:replication] Fatal error:", err);
  process.exit(1);
});
