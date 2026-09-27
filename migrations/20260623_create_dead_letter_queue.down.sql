-- Rollback: 20260623_create_dead_letter_queue
-- Inverted from 20260623_create_dead_letter_queue.sql; hand-verified against the up migration.

DROP TABLE IF EXISTS dead_letter_queue;
DROP INDEX IF EXISTS idx_dlq_queue_name;
DROP INDEX IF EXISTS idx_dlq_created_at;
DROP INDEX IF EXISTS idx_dlq_failure_reason;
