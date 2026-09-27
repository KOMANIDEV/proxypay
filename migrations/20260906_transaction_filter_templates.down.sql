-- Rollback: 20260906_transaction_filter_templates
-- Drops saved filter templates and their usage log.

DROP INDEX IF EXISTS idx_transaction_filter_usage_template;
DROP TABLE IF EXISTS transaction_filter_usage;

DROP INDEX IF EXISTS idx_transaction_filter_templates_shared;
DROP INDEX IF EXISTS idx_transaction_filter_templates_owner_name;
DROP TABLE IF EXISTS transaction_filter_templates;
