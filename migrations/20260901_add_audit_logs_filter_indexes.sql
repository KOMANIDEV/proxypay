-- Migration: 20260901_add_audit_logs_filter_indexes
-- Description: Indexes backing the admin audit log viewer filters (issue #620).
--              Bulk admin operations are filtered by admin, action and time
--              range; created_at ordering is used for the newest-first feed.

CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at
  ON audit_logs(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_audit_logs_action
  ON audit_logs(action);

CREATE INDEX IF NOT EXISTS idx_audit_logs_admin_created_at
  ON audit_logs(admin_id, created_at DESC);
