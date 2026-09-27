-- Migration: 20260901_add_audit_logs_filter_indexes (down)

DROP INDEX IF EXISTS idx_audit_logs_admin_created_at;
DROP INDEX IF EXISTS idx_audit_logs_action;
DROP INDEX IF EXISTS idx_audit_logs_created_at;
