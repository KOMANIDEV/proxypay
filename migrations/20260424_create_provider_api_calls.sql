-- Track last 100 API calls per provider for the internal status page
CREATE TABLE IF NOT EXISTS provider_api_calls (
  id          BIGSERIAL PRIMARY KEY,
  provider    VARCHAR(20)  NOT NULL CHECK (provider IN ('mtn', 'airtel', 'orange')),
  success     BOOLEAN      NOT NULL,
  duration_ms INTEGER,
  error_code  VARCHAR(100),
  called_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pac_provider_called_at
  ON provider_api_calls (provider, called_at DESC);

-- Keep only the last 100 rows per provider automatically
CREATE OR REPLACE FUNCTION trim_provider_api_calls()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM provider_api_calls
  WHERE provider = NEW.provider
    AND id NOT IN (
      SELECT id FROM provider_api_calls
      WHERE provider = NEW.provider
      ORDER BY called_at DESC
      LIMIT 100
    );
  RETURN NULL;
END;
$$;

CREATE TRIGGER trg_trim_provider_api_calls
AFTER INSERT ON provider_api_calls
FOR EACH ROW EXECUTE FUNCTION trim_provider_api_calls();
