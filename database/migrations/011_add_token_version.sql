-- Up Migration
ALTER TABLE users ADD COLUMN token_version INTEGER DEFAULT 0 NOT NULL;

-- Down Migration
ALTER TABLE users DROP COLUMN token_version;