-- Migration: 20250827_create_batch_import_status_tracking
-- Description: Rollback batch import status tracking tables
-- Down migration

-- Drop triggers
DROP TRIGGER IF EXISTS batch_items_status_trigger ON batch_items;
DROP TRIGGER IF EXISTS batch_items_counts_trigger ON batch_items;
DROP TRIGGER IF EXISTS batch_items_updated_at ON batch_items;
DROP TRIGGER IF EXISTS batch_operations_updated_at ON batch_operations;

-- Drop trigger functions
DROP FUNCTION IF EXISTS update_batch_operation_status;
DROP FUNCTION IF EXISTS update_batch_operation_counts;
DROP FUNCTION IF EXISTS update_batch_timestamps;

-- Drop tables
DROP TABLE IF EXISTS batch_items;
DROP TABLE IF EXISTS batch_operations;
