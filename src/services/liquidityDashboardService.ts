import { pool } from "../config/database";
import { EventEmitter } from "events";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface LiquidityAsset {
  asset_code: string;
  asset_issuer: string;
  total_balance: number;
  available_balance: number;
  reserved_balance: number;
  utilization_percent: number;
  last_updated: string;
}

export interface LiquidityProvider {
  provider: string;
  assets: LiquidityAsset[];
  total_liquidity: number;
  health_score: number;
  status: "healthy" | "warning" | "critical";
}

export interface LiquidityTrend {
  asset_code: string;
  timestamps: string[];
  balances: number[];
  depletion_rate: number;
  estimated_depletion_at: string | null;
}

export interface LowLiquidityAlert {
  id: string;
  asset_code: string;
  provider: string;
  current_balance: number;
  threshold: number;
  severity: "warning" | "critical";
  message: string;
  created_at: string;
  acknowledged: boolean;
}

export interface LiquidityDashboardSnapshot {
  providers: LiquidityProvider[];
  total_liquidity: number;
  alerts: LowLiquidityAlert[];
  trends: LiquidityTrend[];
  snapshot_at: string;
}

// ─── EventEmitter for Real-time Updates ───────────────────────────────────────

export const liquidityEmitter = new EventEmitter();
liquidityEmitter.setMaxListeners(100);

// ─── Liquidity Status ────────────────────────────────────────────────────────

export async function getLiquidityStatus(): Promise<LiquidityDashboardSnapshot> {
  const providersResult = await pool.query(`
    SELECT
      provider,
      asset_code,
      asset_issuer,
      SUM(balance) AS total_balance,
      SUM(available_balance) AS available_balance,
      SUM(reserved_balance) AS reserved_balance,
      MAX(updated_at) AS last_updated
    FROM liquidity_balances
    GROUP BY provider, asset_code, asset_issuer
    ORDER BY provider, asset_code
  `);

  const providerMap = new Map<string, LiquidityProvider>();
  const totalLiquidity = { value: 0 };

  for (const row of providersResult.rows) {
    const total = parseFloat(row.total_balance);
    const available = parseFloat(row.available_balance);
    const reserved = parseFloat(row.reserved_balance);
    const utilization = total > 0 ? ((total - available) / total) * 100 : 0;

    totalLiquidity.value += total;

    const asset: LiquidityAsset = {
      asset_code: row.asset_code,
      asset_issuer: row.asset_issuer,
      total_balance: total,
      available_balance: available,
      reserved_balance: reserved,
      utilization_percent: Math.round(utilization * 100) / 100,
      last_updated: row.last_updated,
    };

    if (!providerMap.has(row.provider)) {
      providerMap.set(row.provider, {
        provider: row.provider,
        assets: [],
        total_liquidity: 0,
        health_score: 100,
        status: "healthy",
      });
    }

    const provider = providerMap.get(row.provider)!;
    provider.assets.push(asset);
    provider.total_liquidity += total;
  }

  // Calculate health scores
  for (const [, provider] of providerMap) {
    let warningCount = 0;
    let criticalCount = 0;

    for (const asset of provider.assets) {
      if (asset.utilization_percent > 90) criticalCount++;
      else if (asset.utilization_percent > 70) warningCount++;
    }

    provider.health_score = Math.max(
      0,
      100 - criticalCount * 30 - warningCount * 10,
    );

    provider.status =
      provider.health_score < 50
        ? "critical"
        : provider.health_score < 80
          ? "warning"
          : "healthy";
  }

  // Get alerts
  const alertsResult = await pool.query(`
    SELECT * FROM liquidity_alerts
    WHERE acknowledged = false
    ORDER BY created_at DESC
    LIMIT 50
  `);

  const alerts: LowLiquidityAlert[] = alertsResult.rows.map((row) => ({
    id: row.id,
    asset_code: row.asset_code,
    provider: row.provider,
    current_balance: parseFloat(row.current_balance),
    threshold: parseFloat(row.threshold),
    severity: row.severity,
    message: row.message,
    created_at: row.created_at,
    acknowledged: row.acknowledged,
  }));

  // Get trends
  const trends = await getLiquidityTrends();

  return {
    providers: Array.from(providerMap.values()),
    total_liquidity: totalLiquidity.value,
    alerts,
    trends,
    snapshot_at: new Date().toISOString(),
  };
}

// ─── Historical Trends ───────────────────────────────────────────────────────

async function getLiquidityTrends(limit: number = 50): Promise<LiquidityTrend[]> {
  const result = await pool.query(`
    SELECT
      asset_code,
      provider,
      balance,
      recorded_at
    FROM liquidity_history
    WHERE recorded_at > NOW() - INTERVAL '7 days'
    ORDER BY asset_code, recorded_at ASC
  `);

  const trendMap = new Map<string, LiquidityTrend>();

  for (const row of result.rows) {
    const key = `${row.asset_code}:${row.provider}`;
    if (!trendMap.has(key)) {
      trendMap.set(key, {
        asset_code: row.asset_code,
        timestamps: [],
        balances: [],
        depletion_rate: 0,
        estimated_depletion_at: null,
      });
    }

    const trend = trendMap.get(key)!;
    trend.timestamps.push(row.recorded_at);
    trend.balances.push(parseFloat(row.balance));
  }

  const trends: LiquidityTrend[] = [];

  for (const [, trend] of trendMap) {
    if (trend.balances.length >= 2) {
      const first = trend.balances[0];
      const last = trend.balances[trend.balances.length - 1];
      const daysDiff =
        (new Date(trend.timestamps[trend.timestamps.length - 1]).getTime() -
          new Date(trend.timestamps[0]).getTime()) /
        (24 * 60 * 60 * 1000);

      if (daysDiff > 0) {
        const depletionPerDay = (first - last) / daysDiff;
        trend.depletion_rate = depletionPerDay;

        if (depletionPerDay > 0 && last > 0) {
          const daysUntilDepletion = last / depletionPerDay;
          trend.estimated_depletion_at = new Date(
            Date.now() + daysUntilDepletion * 24 * 60 * 60 * 1000,
          ).toISOString();
        }
      }
    }

    trends.push(trend);
  }

  return trends.slice(0, limit);
}

// ─── Low Liquidity Alert Check ───────────────────────────────────────────────

export async function checkLowLiquidityAlerts(): Promise<LowLiquidityAlert[]> {
  const thresholds = await pool.query(
    `SELECT * FROM liquidity_thresholds ORDER BY asset_code`,
  );

  const newAlerts: LowLiquidityAlert[] = [];

  for (const threshold of thresholds.rows) {
    const balanceResult = await pool.query(
      `SELECT provider, SUM(balance) AS total_balance
       FROM liquidity_balances
       WHERE asset_code = $1
       GROUP BY provider`,
      [threshold.asset_code],
    );

    for (const row of balanceResult.rows) {
      const balance = parseFloat(row.total_balance);
      const warnThreshold = parseFloat(threshold.warning_threshold);
      const critThreshold = parseFloat(threshold.critical_threshold);

      let severity: "warning" | "critical" | null = null;

      if (balance <= critThreshold) {
        severity = "critical";
      } else if (balance <= warnThreshold) {
        severity = "warning";
      }

      if (severity) {
        const id = `alert_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const message = `Low liquidity: ${threshold.asset_code} at ${row.provider} has balance ${balance} (threshold: ${severity === "critical" ? critThreshold : warnThreshold})`;

        await pool.query(
          `INSERT INTO liquidity_alerts
            (id, asset_code, provider, current_balance, threshold, severity, message, created_at, acknowledged)
           VALUES ($1,$2,$3,$4,$5,$6,$7,NOW(),false)`,
          [id, threshold.asset_code, row.provider, balance, severity === "critical" ? critThreshold : warnThreshold, severity, message],
        );

        const alert: LowLiquidityAlert = {
          id,
          asset_code: threshold.asset_code,
          provider: row.provider,
          current_balance: balance,
          threshold: severity === "critical" ? critThreshold : warnThreshold,
          severity,
          message,
          created_at: new Date().toISOString(),
          acknowledged: false,
        };

        newAlerts.push(alert);
        liquidityEmitter.emit("low-liquidity", alert);
      }
    }
  }

  return newAlerts;
}

// ─── WebSocket Subscription ───────────────────────────────────────────────────

export function subscribeToLiquidityUpdates(
  callback: (snapshot: LiquidityDashboardSnapshot) => void,
): () => void {
  const handler = (snapshot: LiquidityDashboardSnapshot) => callback(snapshot);
  liquidityEmitter.on("liquidity-update", handler);
  return () => liquidityEmitter.off("liquidity-update", handler);
}

export function broadcastLiquidityUpdate(
  snapshot: LiquidityDashboardSnapshot,
): void {
  liquidityEmitter.emit("liquidity-update", snapshot);
}
