-- #403 – Transaction Metadata Field Indexing
-- Adds targeted expression indexes on common metadata fields,
-- a full-text search index, and query performance helpers.

-- 0. Helper: flatten all string leaves of a JSONB value into a single text string.
--    Created BEFORE the generated column that references it — PostgreSQL
--    resolves the function at parse time, so ordering matters.
CREATE OR REPLACE FUNCTION jsonb_to_text(j jsonb)
RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT string_agg(value, ' ')
  FROM jsonb_each_text(j)
$$;

-- 1. Expression indexes for common metadata top-level keys
--    (supplements the existing GIN index on the whole metadata column)

CREATE INDEX IF NOT EXISTS idx_txn_meta_provider
  ON transactions ((metadata->>'provider'))
  WHERE metadata->>'provider' IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_txn_meta_channel
  ON transactions ((metadata->>'channel'))
  WHERE metadata->>'channel' IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_txn_meta_source_country
  ON transactions ((metadata->>'source_country'))
  WHERE metadata->>'source_country' IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_txn_meta_destination_country
  ON transactions ((metadata->>'destination_country'))
  WHERE metadata->>'destination_country' IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_txn_meta_reference
  ON transactions ((metadata->>'reference'))
  WHERE metadata->>'reference' IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_txn_meta_customer_id
  ON transactions ((metadata->>'customer_id'))
  WHERE metadata->>'customer_id' IS NOT NULL;

-- 2. Full-text search: tsvector generated column + GIN index
--    Covers free-text values stored inside the metadata JSON.

ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS metadata_tsv tsvector
    GENERATED ALWAYS AS (
      to_tsvector('english', COALESCE(
        jsonb_to_text(metadata), ''
      ))
    ) STORED;

CREATE INDEX IF NOT EXISTS idx_txn_metadata_fts
  ON transactions USING GIN (metadata_tsv);

-- 3. Composite index: status + created_at + metadata GIN for range + filter queries
CREATE INDEX IF NOT EXISTS idx_txn_status_meta
  ON transactions (status, created_at DESC)
  INCLUDE (metadata)
  WHERE metadata IS NOT NULL;

-- 4. Partial index for transactions with non-empty metadata
CREATE INDEX IF NOT EXISTS idx_txn_has_metadata
  ON transactions (created_at DESC)
  WHERE metadata IS NOT NULL AND metadata != '{}'::jsonb;

-- 5. Query performance analysis view (operational, not exposed externally)
CREATE OR REPLACE VIEW v_metadata_index_usage AS
SELECT
  indexrelname                             AS index_name,
  idx_scan                                 AS scans,
  idx_tup_read                             AS tuples_read,
  idx_tup_fetch                            AS tuples_fetched,
  pg_size_pretty(pg_relation_size(indexrelid)) AS index_size
FROM pg_stat_user_indexes
WHERE relname = 'transactions'
  AND indexrelname LIKE '%meta%'
ORDER BY idx_scan DESC;
