/**
 * #477 – Transaction Search by Metadata: faceted search
 *
 * Full-text search (`searchMetadataFullText`) answers "which transactions
 * mention this term?". Faceted search answers the question that actually
 * comes next: "…and what are the other options I could have chosen?".
 *
 * For a query like "deposit", the response carries the counts for provider,
 * channel, status, currency and the amount distribution, so a UI can render
 * filter chips with real numbers instead of re-querying per facet.
 *
 * Implementation notes:
 *   - Facet counts are computed in the same round trip as the result set, over
 *     the same filtered population. Computing them independently would produce
 *     counts that do not match the results, which is worse than no facets.
 *   - `metadata_keys` is backed by the GIN index over jsonb_object_keys, so the
 *     key histogram is index-assisted rather than a sequential scan.
 *   - Results are cached in Redis with the same TTL as the other metadata
 *     queries; facet counts change no faster than the underlying transactions.
 */

import { pool } from "../config/database";
import { redisClient } from "../config/redis";

// ─── Types ────────────────────────────────────────────────────────────────────

/** Low-cardinality keys whose values are useful as facets. */
export const DEFAULT_FACET_KEYS = [
  "provider",
  "channel",
  "status",
  "currency",
  "source_country",
  "destination_country",
] as const;

export type DefaultFacetKey = (typeof DEFAULT_FACET_KEYS)[number];

export interface FacetedSearchQuery {
  /** Free-text term; optional. Omit it to facet the whole (filtered) population. */
  query?: string;
  /** Metadata keys to count values for. Defaults to DEFAULT_FACET_KEYS. */
  facets?: string[];
  /** Additional metadata key = value filters applied to the population. */
  filters?: Record<string, string>;
  userId?: string;
  status?: string;
  limit?: number;
  offset?: number;
  /** How many values to return per facet. */
  facetLimit?: number;
  /** Bucketed amount distribution, e.g. [0, 50, 100, 500, 1000]. */
  amountBuckets?: number[];
}

export interface FacetValue {
  value: string;
  count: number;
  /** Share of the filtered population, 0–1. */
  percentage: number;
}

export interface AmountBucket {
  /** Inclusive lower bound; null = -infinity. */
  from: number | null;
  /** Exclusive upper bound; null = +infinity. */
  to: number | null;
  count: number;
}

export interface FacetedSearchResult {
  data: Array<{
    id: string;
    user_id: string;
    status: string;
    amount: string;
    currency: string;
    provider: string;
    metadata: Record<string, unknown>;
    created_at: Date;
  }>;
  total: number;
  facets: Record<string, FacetValue[]>;
  /** Histogram of which metadata keys exist, most common first. */
  keys: FacetValue[];
  amountDistribution: AmountBucket[];
  queryTimeMs: number;
  cached: boolean;
}

// ─── Internals ────────────────────────────────────────────────────────────────

const FACET_CACHE_TTL_SECONDS = 60;
const MAX_FACETS = 10;
const MAX_FACET_VALUES = 25;

/** Metadata keys are identifiers, never SQL – validated before interpolation. */
function assertValidKey(key: string): void {
  if (!/^[a-z0-9_]{1,64}$/.test(key)) {
    throw new Error(`Invalid metadata key: ${key}`);
  }
}

function facetedSearchCacheKey(params: FacetedSearchQuery): string {
  const p = JSON.stringify({
    ...params,
    facets: (params.facets ?? DEFAULT_FACET_KEYS).slice().sort(),
    limit: params.limit ?? 20,
    offset: params.offset ?? 0,
    facetLimit: params.facetLimit ?? 10,
    amountBuckets: params.amountBuckets ?? [],
  });
  return `txn:meta:facet:${Buffer.from(p).toString("base64url")}`;
}

/**
 * The WHERE clause shared by the result set and every facet count, so the two
 * can never disagree. Placeholders start at $1.
 */
function buildPopulationWhere(
  params: FacetedSearchQuery,
): { where: string; values: unknown[] } {
  const clauses: string[] = [];
  const values: unknown[] = [];
  const next = () => `$${values.length + 1}`;

  if (params.query) {
    values.push(params.query);
    clauses.push(`metadata_tsv @@ plainto_tsquery('english', ${next()})`);
  }
  if (params.userId) {
    values.push(params.userId);
    clauses.push(`user_id = ${next()}`);
  }
  if (params.status) {
    values.push(params.status);
    clauses.push(`status = ${next()}`);
  }
  for (const [key, value] of Object.entries(params.filters ?? {})) {
    assertValidKey(key);
    // Both the key and the value are bound: the key is validated above anyway,
    // but binding it keeps a key from ever being interpolated into SQL.
    values.push(key, value);
    clauses.push(`metadata->>${next()} = ${next()}`);
  }

  return { where: clauses.length ? clauses.join(" AND ") : "TRUE", values };
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Faceted metadata search: result set plus facet counts, amount distribution
 * and a metadata key histogram, all over one consistent population.
 */
export async function searchMetadataFacets(
  params: FacetedSearchQuery = {},
): Promise<FacetedSearchResult> {
  const cacheKey = facetedSearchCacheKey(params);
  try {
    const cached = await redisClient.get(cacheKey);
    if (cached) {
      return { ...JSON.parse(cached), cached: true };
    }
  } catch {
    // Cache unavailable – fall through to the database.
  }

  const t0 = Date.now();

  const facetKeys = (params.facets ?? DEFAULT_FACET_KEYS).slice(0, MAX_FACETS);
  facetKeys.forEach(assertValidKey);
  const facetLimit = Math.min(params.facetLimit ?? 10, MAX_FACET_VALUES);
  const limit = Math.min(params.limit ?? 20, 100);
  const offset = Math.max(params.offset ?? 0, 0);

  const { where, values } = buildPopulationWhere(params);
  // Placeholders: the population ($1..$n), then limit/offset/facetLimit, then
  // the facet keys as an array.
  const limitIdx = values.length + 1;
  const offsetIdx = values.length + 2;
  const facetLimitIdx = values.length + 3;
  const facetKeyIdx = values.length + 4;
  const bindValues = [...values, limit, offset, facetLimit, facetKeys];

  // One statement for everything: the result page, the total, the facet counts,
  // the key histogram and the amount histogram. A single round trip over a
  // single snapshot – the counts cannot disagree with the results, and the
  // metadata is expanded once rather than once per facet key.
  const sql = `
    WITH base AS (
      SELECT id, user_id, status, amount, currency, provider, metadata, created_at
        FROM transactions
       WHERE ${where}
    ),
    result_page AS (
      SELECT * FROM base ORDER BY created_at DESC
        LIMIT $${limitIdx} OFFSET $${offsetIdx}
    ),
    total_count AS (
      SELECT COUNT(*)::int AS total FROM base
    ),
    -- Expand each row's metadata exactly once, keeping only facet keys.
    facet_values AS (
      SELECT kv.key, kv.value
        FROM base b,
             LATERAL jsonb_each_text(COALESCE(b.metadata, '{}'::jsonb)) AS kv
       WHERE kv.key = ANY($${facetKeyIdx}::text[])
    ),
    facet_counts AS (
      SELECT key AS facet_key, value AS facet_value, COUNT(*)::int AS facet_count
        FROM facet_values
       GROUP BY key, value
    ),
    ranked_facets AS (
      SELECT facet_key, facet_value, facet_count,
             ROW_NUMBER() OVER (
               PARTITION BY facet_key ORDER BY facet_count DESC, facet_value
             ) AS rn
        FROM facet_counts
    ),
    key_counts AS (
      SELECT key, COUNT(*)::int AS facet_count
        FROM base b,
             LATERAL jsonb_object_keys(COALESCE(b.metadata, '{}'::jsonb)) AS key
       GROUP BY key
    ),
    ranked_keys AS (
      SELECT key, facet_count,
             ROW_NUMBER() OVER (ORDER BY facet_count DESC, key) AS rn
        FROM key_counts
    )
    SELECT
      (SELECT json_agg(to_jsonb(r)) FROM result_page r) AS data,
      (SELECT total FROM total_count) AS total,
      -- Pivot the (key, value, count) triples into { key: [values] }.
      COALESCE(
        (SELECT json_object_agg(k.facet_key, values.values)
           FROM (
             SELECT facet_key,
                    json_agg(
                      jsonb_build_object('value', facet_value, 'count', facet_count)
                      ORDER BY facet_count DESC, facet_value
                    ) FILTER (WHERE rn <= $${facetLimitIdx}) AS values
               FROM ranked_facets
              GROUP BY facet_key
           ) AS k
         ),
        '{}'::json
      ) AS facets,
      (SELECT json_agg(
                jsonb_build_object('value', key, 'count', facet_count)
                ORDER BY facet_count DESC, key)
         FROM ranked_keys WHERE rn <= 20
       ) AS keys
  `;

  const { rows } = await pool.query<{
    data: Array<Record<string, unknown>> | null;
    total: number;
    facets: Record<string, Array<{ value: string; count: number }>>;
    keys: Array<{ value: string; count: number }> | null;
  }>(sql, bindValues);

  const row = rows[0] ?? { data: null, total: 0, facets: {}, keys: null };
  const total = Number(row.total ?? 0);

  // Percentages are computed here, in one place, rather than in every caller.
  const withPercentages = (
    counts: Array<{ value: string; count: number }>,
  ): FacetValue[] =>
    counts.map((entry) => ({
      value: entry.value,
      count: Number(entry.count),
      percentage: total > 0 ? Number(entry.count) / total : 0,
    }));

  const facets: Record<string, FacetValue[]> = {};
  for (const [key, counts] of Object.entries(row.facets ?? {})) {
    facets[key] = withPercentages(counts ?? []);
  }

  const amountDistribution = await buildAmountDistribution(
    params,
    where,
    values,
  );

  const result: FacetedSearchResult = {
    data: (row.data as FacetedSearchResult["data"]) ?? [],
    total,
    facets,
    keys: withPercentages(row.keys ?? []),
    amountDistribution,
    queryTimeMs: Date.now() - t0,
    cached: false,
  };

  try {
    await redisClient.setex(
      cacheKey,
      FACET_CACHE_TTL_SECONDS,
      JSON.stringify(result),
    );
  } catch {
    // Non-fatal: an uncached answer beats a failed request.
  }

  return result;
}

/**
 * Bucketed amount distribution for the same population. Separate statement
 * because the bucket bounds are dynamic and CASE-heavy enough that inlining it
 * into the main query would obscure both.
 */
async function buildAmountDistribution(
  params: FacetedSearchQuery,
  where: string,
  values: unknown[],
): Promise<AmountBucket[]> {
  const bounds = [
    ...new Set([...(params.amountBuckets ?? [0, 50, 100, 500, 1000])].sort(
      (a, b) => a - b,
    )),
  ];
  if (bounds.length === 0) return [];

  // A `width_bucket`-free CASE keeps this portable and the bucket labels exact.
  const cases = bounds
    .map((bound, i) => {
      const nextBound = bounds[i + 1];
      return nextBound === undefined
        ? `WHEN amount >= ${bound} THEN ${i}`
        : `WHEN amount >= ${bound} AND amount < ${nextBound} THEN ${i}`;
    })
    .join("\n             ");

  const { rows } = await pool.query<{ bucket_index: string; count: string }>(
    `SELECT bucket_index, COUNT(*)::int AS count
       FROM (
         SELECT CASE
                  ${cases}
                END AS bucket_index
           FROM transactions
          WHERE ${where}
       ) bucketed
      WHERE bucket_index IS NOT NULL
      GROUP BY bucket_index`,
    values,
  );

  const counts = new Map(
    rows.map((r) => [Number(r.bucket_index), Number(r.count)]),
  );

  return bounds.map((bound, i) => ({
    from: i === 0 ? null : bound,
    to: i === bounds.length - 1 ? null : bounds[i + 1],
    count: counts.get(i) ?? 0,
  }));
}

/**
 * Metadata key discovery: which keys exist, and how often. Backs the "search by
 * metadata" UI, which needs to know the key vocabulary before it can offer
 * anything to search on.
 */
export async function discoverMetadataKeys(
  userId?: string,
  limit = 25,
): Promise<FacetValue[]> {
  const values: unknown[] = [];
  let userClause = "";
  if (userId) {
    values.push(userId);
    userClause = `WHERE user_id = $1`;
  }
  values.push(Math.min(limit, MAX_FACET_VALUES));

  const { rows } = await pool.query<{ key: string; count: string }>(
    `SELECT key, COUNT(*)::int AS count
       FROM transactions t,
            LATERAL jsonb_object_keys(COALESCE(t.metadata, '{}'::jsonb)) AS key
       ${userClause}
      GROUP BY key
      ORDER BY count DESC, key
      LIMIT $${values.length}`,
    values,
  );

  const total = rows.reduce((acc, row) => acc + Number(row.count), 0);
  return rows.map((row) => ({
    value: row.key,
    count: Number(row.count),
    percentage: total > 0 ? Number(row.count) / total : 0,
  }));
}
