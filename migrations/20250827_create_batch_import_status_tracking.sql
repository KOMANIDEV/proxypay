-- Migration: 20250827_create_batch_import_status_tracking
-- Description: Add batch import status tracking tables for per-item status and retry capability
-- Up migration

-- Batch operations table to track overall batch metadata
CREATE TABLE IF NOT EXISTS batch_operations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_reference VARCHAR(100) UNIQUE NOT NULL,
  provider VARCHAR(50) NOT NULL,
  operation_type VARCHAR(50) NOT NULL DEFAULT 'payout',
  status VARCHAR(20) NOT NULL CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'partial')) DEFAULT 'pending',
  total_items INTEGER NOT NULL DEFAULT 0,
  completed_items INTEGER NOT NULL DEFAULT 0,
  failed_items INTEGER NOT NULL DEFAULT 0,
  started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  completed_at TIMESTAMP,
  webhook_url TEXT,
  webhook_status VARCHAR(20) CHECK (webhook_status IN ('pending', 'sent', 'failed')) DEFAULT 'pending',
  webhook_last_attempt_at TIMESTAMP,
  webhook_last_error TEXT,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create indexes for batch_operations
CREATE INDEX IF NOT EXISTS idx_batch_operations_batch_reference ON batch_operations(batch_reference);
CREATE INDEX IF NOT EXISTS idx_batch_operations_provider ON batch_operations(provider);
CREATE INDEX IF NOT EXISTS idx_batch_operations_status ON batch_operations(status);
CREATE INDEX IF NOT EXISTS idx_batch_operations_created_at ON batch_operations(created_at);

-- Batch items table to track per-item status with retry capability
CREATE TABLE IF NOT EXISTS batch_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id UUID NOT NULL REFERENCES batch_operations(id) ON DELETE CASCADE,
  transaction_id UUID REFERENCES transactions(id) ON DELETE SET NULL,
  reference_id VARCHAR(100) NOT NULL,
  phone_number VARCHAR(20),
  amount DECIMAL(20, 7),
  status VARCHAR(20) NOT NULL CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'retrying')) DEFAULT 'pending',
  error_message TEXT,
  retry_count INTEGER DEFAULT 0,
  max_retries INTEGER DEFAULT 3,
  provider_reference VARCHAR(100),
  processed_at TIMESTAMP,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(batch_id, reference_id)
);

-- Create indexes for batch_items
CREATE INDEX IF NOT EXISTS idx_batch_items_batch_id ON batch_items(batch_id);
CREATE INDEX IF NOT EXISTS idx_batch_items_transaction_id ON batch_items(transaction_id);
CREATE INDEX IF NOT EXISTS idx_batch_items_reference_id ON batch_items(reference_id);
CREATE INDEX IF NOT EXISTS idx_batch_items_status ON batch_items(status);
CREATE INDEX IF NOT EXISTS idx_batch_items_batch_status ON batch_items(batch_id, status);

-- Create trigger function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_batch_timestamps()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Apply triggers to both tables
DROP TRIGGER IF EXISTS batch_operations_updated_at ON batch_operations;
CREATE TRIGGER batch_operations_updated_at
  BEFORE UPDATE ON batch_operations
  FOR EACH ROW EXECUTE FUNCTION update_batch_timestamps();

DROP TRIGGER IF EXISTS batch_items_updated_at ON batch_items;
CREATE TRIGGER batch_items_updated_at
  BEFORE UPDATE ON batch_items
  FOR EACH ROW EXECUTE FUNCTION update_batch_timestamps();

-- Create trigger function to update batch operation counts when items change
CREATE OR REPLACE FUNCTION update_batch_operation_counts()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE batch_operations
    SET total_items = total_items + 1,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = NEW.batch_id;
  ELSIF TG_OP = 'UPDATE' THEN
    IF OLD.status IS DISTINCT FROM NEW.status THEN
      IF NEW.status = 'completed' THEN
        UPDATE batch_operations
        SET completed_items = completed_items + 1,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = NEW.batch_id;
      ELSIF NEW.status = 'failed' THEN
        UPDATE batch_operations
        SET failed_items = failed_items + 1,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = NEW.batch_id;
      END IF;
    END IF;
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

-- Apply trigger to batch_items
DROP TRIGGER IF EXISTS batch_items_counts_trigger ON batch_items;
CREATE TRIGGER batch_items_counts_trigger
  AFTER INSERT OR UPDATE ON batch_items
  FOR EACH ROW EXECUTE FUNCTION update_batch_operation_counts();

-- Create trigger to update batch operation status based on item completion
CREATE OR REPLACE FUNCTION update_batch_operation_status()
RETURNS TRIGGER AS $$
DECLARE
  batch_total INTEGER;
  batch_completed INTEGER;
  batch_failed INTEGER;
BEGIN
  SELECT total_items, completed_items, failed_items
  INTO batch_total, batch_completed, batch_failed
  FROM batch_operations
  WHERE id = NEW.batch_id;

  IF batch_total > 0 AND (batch_completed + batch_failed) >= batch_total THEN
    IF batch_failed = 0 THEN
      UPDATE batch_operations
      SET status = 'completed',
          completed_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = NEW.batch_id;
    ELSIF batch_completed > 0 THEN
      UPDATE batch_operations
      SET status = 'partial',
          completed_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = NEW.batch_id;
    ELSE
      UPDATE batch_operations
      SET status = 'failed',
          completed_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = NEW.batch_id;
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Apply trigger to batch_items
DROP TRIGGER IF EXISTS batch_items_status_trigger ON batch_items;
CREATE TRIGGER batch_items_status_trigger
  AFTER UPDATE OF status ON batch_items
  FOR EACH ROW WHEN (NEW.status IN ('completed', 'failed'))
  EXECUTE FUNCTION update_batch_operation_status();
