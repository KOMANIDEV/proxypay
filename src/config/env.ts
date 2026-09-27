import dotenv from "dotenv";
import { cleanEnv, str, bool, num } from "envalid";

// Load environment variables first
dotenv.config();

/**
 * Validates required environment variables at server startup.
 * Fails fast with a clear error message if any required vars are missing.
 */
export const env = cleanEnv(process.env, {
  DATABASE_URL: str({
    desc: "PostgreSQL connection string",
    example: "postgresql://user:password@localhost:5432/dbname",
  }),
  SANDBOX_DATABASE_URL: str({
    desc: "PostgreSQL connection string for sandbox environment",
    example: "postgresql://user:password@localhost:5432/dbname_sandbox",
    default: "",
  }),
  IS_SANDBOX: bool({
    desc: "Whether the application is running in sandbox mode",
    default: false,
  }),
  APP_MAINTENANCE_MODE: bool({
    desc: "Whether the application is in maintenance mode (read-only)",
    default: false,
  }),
  INDEX_REINDEX_JOB_ENABLED: bool({
    default: true,
    desc: "Whether the automated index reindex maintenance job should run",
  }),
  INDEX_REINDEX_CRON: str({
    default: "0 3 * * *",
    desc: "Cron schedule for the automated index reindex maintenance job",
    example: "0 3 * * *",
  }),
  INDEX_REINDEX_MIN_SIZE_MB: num({
    default: 100,
    desc: "Minimum size in MB for an index to be eligible for automatic reindexing",
  }),
  INDEX_REINDEX_MAX_SCAN_COUNT: num({
    default: 50,
    desc: "Maximum scan count for an index to still be eligible for automatic reindexing",
  }),
  INDEX_REINDEX_MAX_ACTIVE_CONNECTIONS: num({
    default: 5,
    desc: "Maximum active queries allowed in the database before the automatic index reindex job is skipped",
  }),
  INDEX_BLOAT_MONITOR_ENABLED: bool({
    default: true,
    desc: "Whether the index bloat monitoring job should run",
  }),
  INDEX_BLOAT_MONITOR_CRON: str({
    default: "0 * * * *",
    desc: "Cron schedule for the index bloat monitoring job",
    example: "0 * * * *",
  }),
  INDEX_BLOAT_MIN_SIZE_MB: num({
    default: 10,
    desc: "Minimum size in MB for an index to be evaluated for bloat",
  }),
  INDEX_BLOAT_ALERT_THRESHOLD_PCT: num({
    default: 30,
    desc: "Bloat percentage that triggers an alert",
  }),
  DB_OPTIMIZATION_JOB_ENABLED: bool({
    default: true,
    desc: "Whether the automatic database optimization job should run",
  }),
  DB_OPTIMIZATION_CRON: str({
    default: "30 3 * * *",
    desc: "Cron schedule for the automatic database optimization job",
    example: "30 3 * * *",
  }),
  DB_OPTIMIZATION_MIN_INDEX_SIZE_MB: num({
    default: 1,
    desc: "Minimum size in MB for an index to be measured for fragmentation",
  }),
  DB_OPTIMIZATION_REBUILD_THRESHOLD_PCT: num({
    default: 40,
    desc: "Fragmentation percentage at which an index is automatically reorganized",
  }),
  DB_OPTIMIZATION_REINDEX_COOLDOWN_HOURS: num({
    default: 24,
    desc: "Minimum hours before a reorganized index is eligible again",
  }),
  DB_OPTIMIZATION_PLAN_REGRESSION_RATIO: num({
    default: 1.5,
    desc: "Cost ratio over the cached plan that marks a query plan as regressed",
  }),
  LEDGER_INTEGRITY_JOB_ENABLED: bool({
    default: true,
    desc: "Whether the ledger entry integrity validation job should run",
  }),
  LEDGER_INTEGRITY_CRON: str({
    default: "0 7 * * *",
    desc: "Cron schedule for the ledger entry integrity validation job",
    example: "0 7 * * *",
  }),
  STELLAR_ISSUER_SECRET: str({
    desc: "Stellar secret key for the issuer account",
    example: "S...",
  }),
  REDIS_URL: str({
    desc: "Redis connection URL for queue and locks",
    example: "re8dis://localhost:6379",
  }),
  STELLAR_HORIZON_URL: str({
    default: "https://horizon-testnet.stellar.org",
    desc: "Stellar Horizon server URL, or a comma-separated list of URLs (primary first, then fallbacks) for automatic node rotation/failover",
  }),
  STELLAR_NETWORK: str({
    default: "testnet",
    desc: "Stellar network (testnet or mainnet)",
  }),
  DB_ENCRYPTION_KEY: str({
    default: "development-encryption-key-32-chars-long",
    desc: "Secret key for PII encryption in database (AES-256-GCM global key material)",
  }),
  PII_MASTER_KEY: str({
    default: "development-pii-master-key-32-chars!",
    desc: "Master key for per-user HKDF key derivation. Must be a high-entropy secret in production. Never log or expose this value.",
  }),
  REFRESH_TOKEN_EXPIRES_IN: str({
    default: process.env.REFRESH_TOKEN_EXPIRES_IN,
    desc: "REFRESH_TOKEN_EXPIRES_IN needs to be set in environment file",
  }),
  REFRESH_TOKEN_SECRET: str({
    default: process.env.REFRESH_TOKEN_SECRET,
    desc: "REFRESH_TOKEN_SECRET needs to be set in environment file",
  }),
  REFRESH_TOKEN_ISSUER: str({
    default: process.env.REFRESH_TOKEN_ISSUER,
    desc: "REFRESH_TOKEN_ISSUER needs to be set in environment file",
  }),
  REFRESH_TOKEN_AUDIENCE: str({
    default: process.env.REFRESH_TOKEN_AUDIENCE,
    desc: "REFRESH_TOKEN_AUDIENCE needs to be set in environment file",
  }),
  PAGERDUTY_INTEGRATION_KEY: str({
    default: "",
    desc: "PagerDuty Events API V2 Integration Key for alert routing",
    example: "R1234567890abcdef",
  }),
  PAGERDUTY_DEDUP_KEY: str({
    default: "mobile-money",
    desc: "PagerDuty deduplication key prefix for incident grouping",
  }),
  ADMIN_API_KEY: str({
    default: "",
    desc: "Admin API key for internal tooling",
    example: "admin-secret-key",
  }),
  APQ_TTL_SECONDS: str({
    default: "86400",
    desc: "TTL in seconds for Automatic Persisted Query entries in Redis (default: 86400 = 24h)",
  }),
  AML_API_KEY: str({
    default: "",
    desc: "API key for third-party AML/sanction screening provider (e.g. Elliptic, Chainalysis)",
    example: "ell_live_xxxxxxxxxxxx",
  }),
  QUICKBOOKS_CLIENT_ID: str({
    default: "",
    desc: "QuickBooks Online OAuth 2.0 Client ID",
  }),
  QUICKBOOKS_CLIENT_SECRET: str({
    default: "",
    desc: "QuickBooks Online OAuth 2.0 Client Secret",
  }),
  QUICKBOOKS_REDIRECT_URI: str({
    default: "http://localhost:3000/api/accounting/quickbooks/callback",
    desc: "QuickBooks Online OAuth 2.0 Redirect URI",
  }),
  XERO_CLIENT_ID: str({
    default: "",
    desc: "Xero OAuth 2.0 Client ID",
  }),
  XERO_CLIENT_SECRET: str({
    default: "",
    desc: "Xero OAuth 2.0 Client Secret",
  }),
  XERO_REDIRECT_URI: str({
    default: "http://localhost:3000/api/accounting/xero/callback",
    desc: "Xero Online OAuth 2.0 Redirect URI",
  }),
  DB_POOL_MAX: num({
    default: 1000,
    desc: "Maximum number of connections in the primary read connection pool",
    example: "1000",
  }),
  DB_POOL_MIN: num({
    default: 0,
    desc: "Minimum number of connections kept in the primary read connection pool",
    example: "0",
  }),
  DB_POOL_IDLE_TIMEOUT_MS: num({
    default: 30000,
    desc: "Idle timeout in milliseconds before an idle read-pool connection is closed",
    example: "30000",
  }),
  DB_POOL_CONNECTION_TIMEOUT_MS: num({
    default: 500,
    desc: "Maximum time in milliseconds to wait for a read-pool connection before erroring",
    example: "500",
  }),
  DB_WRITE_POOL_MAX: num({
    default: 1000,
    desc: "Maximum number of connections in the dedicated write connection pool",
    example: "1000",
  }),
  DB_WRITE_POOL_MIN: num({
    default: 0,
    desc: "Minimum number of connections kept in the dedicated write connection pool",
    example: "0",
  }),
  DB_WRITE_POOL_IDLE_TIMEOUT_MS: num({
    default: 30000,
    desc: "Idle timeout in milliseconds before an idle write-pool connection is closed",
    example: "30000",
  }),
  DB_WRITE_POOL_CONNECTION_TIMEOUT_MS: num({
    default: 500,
    desc: "Maximum time in milliseconds to wait for a write-pool connection before erroring",
    example: "500",
  }),
  DB_REPLICA_POOL_MAX: num({
    default: 100,
    desc: "Maximum number of connections per individual read replica pool",
    example: "100",
  }),
  DB_REPLICA_POOL_IDLE_TIMEOUT_MS: num({
    default: 30000,
    desc: "Idle timeout in milliseconds before an idle replica-pool connection is closed",
    example: "30000",
  }),
  DB_REPLICA_POOL_CONNECTION_TIMEOUT_MS: num({
    default: 500,
    desc: "Maximum time in milliseconds to wait for a replica-pool connection before erroring",
    example: "500",
  }),
  DB_POOL_MONITOR_INTERVAL_MS: num({
    default: 5000,
    desc: "How often (ms) pool utilization monitoring samples pool gauges",
    example: "5000",
  }),
});

// Re-export specific values for convenience
export const {
  DATABASE_URL,
  SANDBOX_DATABASE_URL,
  IS_SANDBOX,
  STELLAR_ISSUER_SECRET,
  REDIS_URL,
  STELLAR_HORIZON_URL,
  STELLAR_NETWORK,
  DB_ENCRYPTION_KEY,
  PII_MASTER_KEY,
  PAGERDUTY_INTEGRATION_KEY,
  PAGERDUTY_DEDUP_KEY,
  ADMIN_API_KEY,
  APP_MAINTENANCE_MODE,
  INDEX_REINDEX_JOB_ENABLED,
  INDEX_REINDEX_CRON,
  INDEX_REINDEX_MIN_SIZE_MB,
  INDEX_REINDEX_MAX_SCAN_COUNT,
  INDEX_REINDEX_MAX_ACTIVE_CONNECTIONS,
  INDEX_BLOAT_MONITOR_ENABLED,
  INDEX_BLOAT_MONITOR_CRON,
  INDEX_BLOAT_MIN_SIZE_MB,
  INDEX_BLOAT_ALERT_THRESHOLD_PCT,
  DB_OPTIMIZATION_JOB_ENABLED,
  DB_OPTIMIZATION_CRON,
  DB_OPTIMIZATION_MIN_INDEX_SIZE_MB,
  DB_OPTIMIZATION_REBUILD_THRESHOLD_PCT,
  DB_OPTIMIZATION_REINDEX_COOLDOWN_HOURS,
  DB_OPTIMIZATION_PLAN_REGRESSION_RATIO,
  LEDGER_INTEGRITY_JOB_ENABLED,
  LEDGER_INTEGRITY_CRON,
  QUICKBOOKS_CLIENT_ID,
  QUICKBOOKS_CLIENT_SECRET,
  QUICKBOOKS_REDIRECT_URI,
  XERO_CLIENT_ID,
  XERO_CLIENT_SECRET,
  XERO_REDIRECT_URI,
  DB_POOL_MAX,
  DB_POOL_MIN,
  DB_POOL_IDLE_TIMEOUT_MS,
  DB_POOL_CONNECTION_TIMEOUT_MS,
  DB_WRITE_POOL_MAX,
  DB_WRITE_POOL_MIN,
  DB_WRITE_POOL_IDLE_TIMEOUT_MS,
  DB_WRITE_POOL_CONNECTION_TIMEOUT_MS,
  DB_REPLICA_POOL_MAX,
  DB_REPLICA_POOL_IDLE_TIMEOUT_MS,
  DB_REPLICA_POOL_CONNECTION_TIMEOUT_MS,
  DB_POOL_MONITOR_INTERVAL_MS,
} = env;
