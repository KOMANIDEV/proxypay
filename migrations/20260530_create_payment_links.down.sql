-- Rollback: 20260530_create_payment_links
-- Inverted from 20260530_create_payment_links.sql; hand-verified against the up migration.

DROP TRIGGER IF EXISTS payment_links_updated_at ON payment_links;
DROP TABLE IF EXISTS payment_links;
DROP INDEX IF EXISTS idx_payment_links_token;
DROP INDEX IF EXISTS idx_payment_links_merchant_id;
DROP FUNCTION IF EXISTS update_payment_links_updated_at;
