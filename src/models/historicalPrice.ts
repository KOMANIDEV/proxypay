import { queryRead, queryWrite } from "../config/database";

export type CurrencyCode = "USD" | "XLM" | "XAF";

export interface HistoricalPriceSnapshot {
  baseCurrency: CurrencyCode;
  quoteCurrency: CurrencyCode;
  price: number;
  source: string;
  recordedAt: Date;
}

export interface HistoricalPriceRow extends HistoricalPriceSnapshot {
  id: string;
  fetchedAt: Date;
  createdAt: Date;
}

interface DbRow {
  id: string;
  base_currency: string;
  quote_currency: string;
  price: string;
  source: string;
  recorded_at: Date;
  fetched_at: Date;
  created_at: Date;
}

function mapRow(row: DbRow): HistoricalPriceRow {
  return {
    id: row.id,
    baseCurrency: row.base_currency as CurrencyCode,
    quoteCurrency: row.quote_currency as CurrencyCode,
    price: parseFloat(row.price),
    source: row.source,
    recordedAt: new Date(row.recorded_at),
    fetchedAt: new Date(row.fetched_at),
    createdAt: new Date(row.created_at),
  };
}

/**
 * Truncate a Date down to the start of its UTC hour. This is the canonical
 * bucket for `recorded_at`, guaranteeing deterministic deduplication across
 * overlapping cron runs and manual backfills.
 */
export function truncateToHour(date: Date): Date {
  const d = new Date(date);
  d.setUTCMinutes(0, 0, 0);
  return d;
}

/**
 * Upsert a snapshot for (base, quote, recorded_at). Later runs for the same
 * hour bucket overwrite the price — intentional, so corrections from a
 * better source can supersede stale values.
 */
export async function insertSnapshot(
  snapshot: HistoricalPriceSnapshot,
): Promise<HistoricalPriceRow> {
  const result = await queryWrite<DbRow>(
    `INSERT INTO historical_prices
       (base_currency, quote_currency, price, source, recorded_at)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (base_currency, quote_currency, recorded_at)
     DO UPDATE SET
       price = EXCLUDED.price,
       source = EXCLUDED.source,
       fetched_at = NOW()
     RETURNING
       id, base_currency, quote_currency, price::text AS price,
       source, recorded_at, fetched_at, created_at`,
    [
      snapshot.baseCurrency,
      snapshot.quoteCurrency,
      snapshot.price,
      snapshot.source,
      truncateToHour(snapshot.recordedAt).toISOString(),
    ],
  );
  return mapRow(result.rows[0]);
}

/**
 * Return the most recent snapshot for a pair recorded at or before `at`.
 * Used to compute "value at time T" without requiring an exact-hour match.
 */
export async function findNearest(
  base: CurrencyCode,
  quote: CurrencyCode,
  at: Date,
): Promise<HistoricalPriceRow | null> {
  const result = await queryRead<DbRow>(
    `SELECT
       id, base_currency, quote_currency, price::text AS price,
       source, recorded_at, fetched_at, created_at
     FROM historical_prices
     WHERE base_currency = $1
       AND quote_currency = $2
       AND recorded_at <= $3
     ORDER BY recorded_at DESC
     LIMIT 1`,
    [base, quote, at.toISOString()],
  );
  if (result.rows.length === 0) return null;
  return mapRow(result.rows[0]);
}

/**
 * Return all snapshots for a pair in `[from, to]`, oldest first.
 * Callers are expected to cap the range — the caller-supplied `limit`
 * is enforced (default 1000).
 */
export async function findRange(
  base: CurrencyCode,
  quote: CurrencyCode,
  from: Date,
  to: Date,
  limit = 1000,
): Promise<HistoricalPriceRow[]> {
  const effectiveLimit = Math.min(Math.max(1, limit), 1000);
  const result = await queryRead<DbRow>(
    `SELECT
       id, base_currency, quote_currency, price::text AS price,
       source, recorded_at, fetched_at, created_at
     FROM historical_prices
     WHERE base_currency = $1
       AND quote_currency = $2
       AND recorded_at BETWEEN $3 AND $4
     ORDER BY recorded_at ASC
     LIMIT $5`,
    [base, quote, from.toISOString(), to.toISOString(), effectiveLimit],
  );
  return result.rows.map(mapRow);
}

/**
 * Return the latest snapshot for a pair, regardless of time.
 */
export async function findLatest(
  base: CurrencyCode,
  quote: CurrencyCode,
): Promise<HistoricalPriceRow | null> {
  const result = await queryRead<DbRow>(
    `SELECT
       id, base_currency, quote_currency, price::text AS price,
       source, recorded_at, fetched_at, created_at
     FROM historical_prices
     WHERE base_currency = $1
       AND quote_currency = $2
     ORDER BY recorded_at DESC
     LIMIT 1`,
    [base, quote],
  );
  if (result.rows.length === 0) return null;
  return mapRow(result.rows[0]);
}
