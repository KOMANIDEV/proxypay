-- Migration: create dead_letter_queue
-- Stores jobs that have exhausted all retries for manual inspection and replay.

CREATE TABLE IF NOT EXISTS dead_letter_queue (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  original_job_id VARCHAR(255),
  queue_name    VARCHAR(255) NOT NULL,
  job_name      VARCHAR(255) NOT NULL,
  job_data      JSONB NOT NULL,
  failure_reason TEXT NOT NULL,
  attempts_made INTEGER NOT NULL DEFAULT 1,
  replayed_at   TIMESTAMP WITH TIME ZONE,
  replayed_by   VARCHAR(255),
  created_at    TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_dlq_queue_name  ON dead_letter_queue (queue_name);
CREATE INDEX IF NOT EXISTS idx_dlq_created_at  ON dead_letter_queue (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_dlq_failure_reason ON dead_letter_queue USING gin (to_tsvector('english', failure_reason));
