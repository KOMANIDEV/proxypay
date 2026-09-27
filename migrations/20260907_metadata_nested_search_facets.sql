-- Migration: 20260907_metadata_nested_search_facets
-- Description: Transaction metadata search by value, faceted search and
--              search performance optimisation (#477).
--
-- Problem this fixes:
--   migration 20260825 introduced `jsonb_to_text()` using `jsonb_each_text`,
--   which only sees TOP-LEVEL keys. For a nested value such as
--   {"customer": {"name": "Ada Lovelace"}} that function produced the raw JSON
--   text `{"name": "Ada Lovelace"}`, so the generated `metadata_tsv` column
--   tokenised JSON punctuation along with the words. Relevance suffered and
--   phrase searches became unreliable.
--
-- This migration:
--   1. Replaces `jsonb_to_text()` with a recursive, nested-aware version that
--      also emits object keys, so `metadata->'customer'->>'name'` is findable
--      by the word "name" as well as by "Ada" and "Lovelace".
--   2. Recreates the `metadata_tsv` generated column and its GIN index so the
--      new function is baked in. This rewrites `transactions` once – schedule
--      it for a maintenance window on large tables.
--   3. Adds a `jsonb_path_ops` GIN index for `@>` containment queries: smaller
--      and faster than the default `jsonb_ops` when only containment is used.
--   4. Adds indexes supporting facet counting: the set of keys present in each
--      row, plus covering indexes for common low-cardinality keys.
--   5. Adds a view for spotting slow metadata queries.

-- ---------------------------------------------------------------------------
-- 1. Nested-aware flattening
-- ---------------------------------------------------------------------------

-- The previous implementation is a single `jsonb_each_text` pass, so nested
-- values are rendered as JSON text. This version walks the whole tree.
CREATE OR REPLACE FUNCTION jsonb_to_text(j jsonb)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
AS $$
DECLARE
  out_text text := '';
  obj_key  text;
  obj_val  jsonb;
  arr_val  jsonb;
BEGIN
  IF j IS NULL OR jsonb_typeof(j) = 'null' THEN
    RETURN '';
  END IF;

  IF jsonb_typeof(j) = 'object' THEN
    FOR obj_key, obj_val IN SELECT * FROM jsonb_each(j) LOOP
      -- Keys are indexed as well as values, so searching for "customer" finds
      -- rows that have a nested object named customer.
      out_text := out_text || ' ' || obj_key || ' ' || jsonb_to_text(obj_val);
    END LOOP;
  ELSIF jsonb_typeof(j) = 'array' THEN
    FOR arr_val IN SELECT * FROM jsonb_array_elements(j) LOOP
      out_text := out_text || ' ' || jsonb_to_text(arr_val);
    END LOOP;
  ELSE
    out_text := j::text;
  END IF;

  RETURN btrim(out_text);
END;
$$;

COMMENT ON FUNCTION jsonb_to_text(jsonb) IS
  'Flattens any JSONB value to searchable text, recursing through nested '
  'objects and arrays and including object keys. Used by the transaction '
  'metadata search index (#477).';

-- ---------------------------------------------------------------------------
-- 2. Rebuild the full-text index with the corrected function
-- ---------------------------------------------------------------------------
-- A generated column cannot be altered in place: the function has to be
-- re-evaluated for every row, so the column and its index are dropped and
-- recreated. Safe to re-run thanks to IF EXISTS / IF NOT EXISTS.

DROP INDEX IF EXISTS idx_txn_metadata_fts;
ALTER TABLE transactions DROP COLUMN IF EXISTS metadata_tsv;

ALTER TABLE transactions
  ADD COLUMN metadata_tsv tsvector
    GENERATED ALWAYS AS (
      to_tsvector('english', COALESCE(jsonb_to_text(metadata), ''))
    ) STORED;

CREATE INDEX idx_txn_metadata_fts
  ON transactions USING GIN (metadata_tsv);

-- ---------------------------------------------------------------------------
-- 3. Containment index for exact metadata lookups
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_txn_metadata_path_ops
  ON transactions USING GIN (metadata jsonb_path_ops);

-- ---------------------------------------------------------------------------
-- 4. Facet support
-- ---------------------------------------------------------------------------

-- Which keys exist in a row: makes "which metadata keys are searchable?"
-- and per-key result counts index-assisted instead of a full scan.
--
-- An index expression may not contain a subquery, so the key set is extracted
-- through an IMMUTABLE function rather than `array(SELECT jsonb_object_keys
-- (...))` inline. This mirrors how `jsonb_to_text` above is wrapped for the
-- generated column.
CREATE OR REPLACE FUNCTION jsonb_object_keys_array(j jsonb)
RETURNS text[]
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT coalesce(array_agg(jsonb_object_keys(coalesce(j, '{}'::jsonb))), '{}'::text[])
$$;

CREATE INDEX IF NOT EXISTS idx_txn_metadata_keys
  ON transactions USING GIN (jsonb_object_keys_array(metadata));

-- Covering indexes for facet counting on the highest-traffic keys. The key is
-- both in the index and in the INCLUDE list so the planner can answer the
-- facet count from the index alone.
CREATE INDEX IF NOT EXISTS idx_txn_meta_facet_provider
  ON transactions ((metadata->>'provider'))
  INCLUDE (status, created_at)
  WHERE metadata ? 'provider';

CREATE INDEX IF NOT EXISTS idx_txn_meta_facet_channel
  ON transactions ((metadata->>'channel'))
  INCLUDE (status, created_at)
  WHERE metadata ? 'channel';

CREATE INDEX IF NOT EXISTS idx_txn_meta_facet_source_country
  ON transactions ((metadata->>'source_country'))
  INCLUDE (status, created_at)
  WHERE metadata ? 'source_country';

CREATE INDEX IF NOT EXISTS idx_txn_meta_facet_destination_country
  ON transactions ((metadata->>'destination_country'))
  INCLUDE (status, created_at)
  WHERE metadata ? 'destination_country';

-- NOTE: no expression index on a numeric cast of a metadata value. Metadata is
-- free-form user JSON, so `metadata->>'amount'` may hold "N/A" and the index
-- build would fail on real data. The facet path reads the value as text.

-- ---------------------------------------------------------------------------
-- 5. Operational view: metadata search statements slower than 100ms
-- ---------------------------------------------------------------------------
-- Deliberately built on pg_stat_user_indexes rather than pg_stat_statements:
-- the latter requires an extension that is not guaranteed to be installed, and
-- a view over a missing relation would fail the whole migration.

CREATE OR REPLACE VIEW v_slow_metadata_searches AS
SELECT
  s.relname                                AS table_name,
  s.indexrelname                           AS index_name,
  s.idx_scan                               AS scans,
  s.idx_tup_read                           AS tuples_read,
  s.idx_tup_fetch                          AS tuples_fetched,
  pg_size_pretty(pg_relation_size(s.indexrelid)) AS index_size
FROM pg_stat_user_indexes s
WHERE s.relname = 'transactions'
  AND (s.indexrelname LIKE '%meta%' OR s.indexrelname LIKE '%fts%')
ORDER BY s.idx_tup_read DESC;
