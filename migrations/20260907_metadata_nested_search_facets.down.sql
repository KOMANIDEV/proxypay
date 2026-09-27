-- Rollback: 20260907_metadata_nested_search_facets
-- Removes facet indexes and the search performance view.
--
-- NOTE: `jsonb_to_text` is intentionally NOT reverted. The top-level-only
-- version it replaces produced JSON text for nested values, which silently
-- degraded search relevance; restoring that bug to reverse an index change
-- would be a net loss. Metadata full-text search keeps working with the
-- nested-aware function.

DROP VIEW IF EXISTS v_slow_metadata_searches;

DROP INDEX IF EXISTS idx_txn_meta_facet_destination_country;
DROP INDEX IF EXISTS idx_txn_meta_facet_source_country;
DROP INDEX IF EXISTS idx_txn_meta_facet_channel;
DROP INDEX IF EXISTS idx_txn_meta_facet_provider;
DROP INDEX IF EXISTS idx_txn_metadata_keys;
DROP INDEX IF EXISTS idx_txn_metadata_path_ops;

-- jsonb_object_keys_array is kept alongside jsonb_to_text for the same reason:
-- reverting to the top-level-only flattening would reinstate the search bug.

-- The nested-aware function is kept: see note above.
