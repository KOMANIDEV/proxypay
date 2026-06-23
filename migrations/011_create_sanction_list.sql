-- Migration: 011_create_sanction_list
-- Description: Create sanction_list table for AML screening
-- Up migration

CREATE TABLE IF NOT EXISTS sanction_list (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name          VARCHAR(255) NOT NULL,
  country       VARCHAR(100),
  source        VARCHAR(50)  NOT NULL, -- e.g., 'UN', 'OFAC', 'EU'
  category      VARCHAR(50),           -- e.g., 'Individual', 'Entity'
  external_id   VARCHAR(100),          -- ID from the source list
  created_at    TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_sanction_list_name ON sanction_list(name);
CREATE INDEX IF NOT EXISTS idx_sanction_list_external_id ON sanction_list(external_id, source);

-- Trigger to update updated_at
CREATE OR REPLACE FUNCTION update_sanction_list_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS sanction_list_updated_at ON sanction_list;
CREATE TRIGGER sanction_list_updated_at
  BEFORE UPDATE ON sanction_list
  FOR EACH ROW EXECUTE FUNCTION update_sanction_list_updated_at();

-- Down migration
-- DROP TABLE IF EXISTS sanction_list;
