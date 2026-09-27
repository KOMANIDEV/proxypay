-- Rollback: 20260428_create_anchored_assets
-- Inverted from 20260428_create_anchored_assets.sql; hand-verified against the up migration.

DROP TRIGGER IF EXISTS update_anchored_assets_updated_at ON anchored_assets;
DROP TABLE IF EXISTS anchored_assets;
DROP INDEX IF EXISTS idx_anchored_assets_code;
DROP FUNCTION IF EXISTS update_anchored_assets_updated_at;
