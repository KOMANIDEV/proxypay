import {
  Registry,
  Counter,
  Histogram,
  Gauge,
  Summary,
  collectDefaultMetrics,
} from "prom-client";

const register = new Registry();

// Add default metrics (CPU, Memory, etc.)
collectDefaultMetrics({ register });

// HTTP Metrics
export const httpRequestsTotal = new Counter({
  name: "http_requests_total",
  help: "Total number of HTTP requests",
  labelNames: ["method", "route", "status_code"],
  registers: [register],
});

export const httpRequestDurationSeconds = new Histogram({
  name: "http_request_duration_seconds",
  help: "Duration of HTTP requests in seconds",
  labelNames: ["method", "route", "status_code"],
  buckets: [0.1, 0.3, 0.5, 0.7, 1, 3, 5, 7, 10], // standard buckets
  registers: [register],
});

// Business Logic Metrics
export const transactionTotal = new Counter({
  name: "transaction_total",
  help: "Total number of transactions processed",
  labelNames: ["type", "provider", "status"], // type: payment/payout
  registers: [register],
});

export const transactionErrorsTotal = new Counter({
  name: "transaction_errors_total",
  help: "Total number of transaction errors",
  labelNames: ["type", "provider", "error_type"],
  registers: [register],
});

export const providerResponseTimeSeconds = new Histogram({
  name: "provider_response_time_seconds",
  help: "Duration of provider operations in seconds",
  labelNames: ["provider", "operation", "status"],
  buckets: [0.1, 0.3, 0.5, 1, 3, 5, 10, 30],
  registers: [register],
});

export const providerResponseTimeSummary = new Summary({
  name: "provider_response_time_summary",
  help: "Summary of provider operation durations in seconds",
  labelNames: ["provider", "operation"],
  percentiles: [0.5, 0.9, 0.95, 0.99],
  registers: [register],
});

// Provider rate limit header tracking
export const providerRateLimitState = new Gauge({
  name: "provider_rate_limit_remaining",
  help: "Remaining provider API quota as advertised via X-RateLimit-* headers",
  labelNames: ["provider"],
  registers: [register],
});

export const providerRateLimitHitsTotal = new Counter({
  name: "provider_rate_limit_hits_total",
  help: "Number of outbound provider requests throttled based on rate limit headers",
  labelNames: ["provider", "reason"],
  registers: [register],
});

// Failover metrics
export const providerFailoverTotal = new Counter({
  name: "provider_failover_total",
  help: "Total number of automatic provider failovers",
  labelNames: ["type", "from_provider", "to_provider", "reason"],
  registers: [register],
});

export const providerFailoverAlerts = new Counter({
  name: "provider_failover_alerts_total",
  help: "Number of failover alert notifications emitted",
  labelNames: ["provider"],
  registers: [register],
});

export const providerCircuitBreakerTransitionsTotal = new Counter({
  name: "provider_circuit_breaker_transitions_total",
  help: "Total number of provider circuit breaker state transitions",
  labelNames: ["provider", "operation", "state"],
  registers: [register],
});

export const providerCircuitBreakerState = new Gauge({
  name: "provider_circuit_breaker_state",
  help: "Current provider circuit breaker state (0=closed, 0.5=half_open, 1=open)",
  labelNames: ["provider", "operation"],
  registers: [register],
});

// Horizon node rotation / failover metrics
export const horizonNodeFailuresTotal = new Counter({
  name: "horizon_node_failures_total",
  help: "Total number of failed Horizon requests, labelled per node",
  labelNames: ["node", "error_type"],
  registers: [register],
});

export const horizonNodeHealth = new Gauge({
  name: "horizon_node_health",
  help: "Current Horizon node health (1=in rotation, 0=removed/cooldown)",
  labelNames: ["node"],
  registers: [register],
});

export const horizonRequestFailoverTotal = new Counter({
  name: "horizon_request_failover_total",
  help: "Total number of Horizon requests retried on an alternative node",
  labelNames: ["from_node", "to_node", "operation"],
  registers: [register],
});

export const healthCheckResponseTimeSeconds = new Histogram({
  name: "health_check_response_time_seconds",
  help: "Duration of provider health checks in seconds",
  labelNames: ["provider", "status"],
  buckets: [0.05, 0.1, 0.3, 0.5, 1, 3, 5, 10],
  registers: [register],
});

// Batch Payout Metrics
export const batchPayoutTotal = new Counter({
  name: "batch_payout_total",
  help: "Total number of batch payout operations",
  labelNames: ["provider", "status"],
  registers: [register],
});

export const batchPayoutItemsTotal = new Counter({
  name: "batch_payout_items_total",
  help: "Total number of items processed in batch payouts",
  labelNames: ["provider", "status"],
  registers: [register],
});

export const batchPayoutDurationSeconds = new Histogram({
  name: "batch_payout_duration_seconds",
  help: "Duration of batch payout operations in seconds",
  labelNames: ["provider"],
  buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60],
  registers: [register],
});

export const batchPayoutSize = new Histogram({
  name: "batch_payout_size",
  help: "Number of items in each batch payout",
  labelNames: ["provider"],
  buckets: [1, 5, 10, 20, 30, 40, 50],
  registers: [register],
});

// Connection Metrics
export const activeConnections = new Gauge({
  name: "active_connections",
  help: "Number of active HTTP connections",
  registers: [register],
});

export const dbReplicaLagSeconds = new Gauge({
  name: "db_replica_lag_seconds",
  help: "Replication lag in seconds for each read replica",
  labelNames: ["replica_url"],
  registers: [register],
});

export const dbReplicaReadEnabled = new Gauge({
  name: "db_replica_read_enabled",
  help: "Whether the replica is currently enabled for read routing (1=enabled, 0=disabled)",
  labelNames: ["replica_url"],
  registers: [register],
});

export const dbReplicaFailoversTotal = new Counter({
  name: "db_replica_failovers_total",
  help: "Total number of read query failovers from replica to primary",
  registers: [register],
});

// Connection Pool Utilization Metrics
export const dbPoolUtilization = new Gauge({
  name: "db_pool_utilization",
  help: "Fraction of the connection pool currently in use (0–1)",
  labelNames: ["pool", "role"],
  registers: [register],
});

export const dbPoolTotalConnections = new Gauge({
  name: "db_pool_total_connections",
  help: "Total number of connections in the pool",
  labelNames: ["pool", "role"],
  registers: [register],
});

export const dbPoolIdleConnections = new Gauge({
  name: "db_pool_idle_connections",
  help: "Number of idle connections in the pool",
  labelNames: ["pool", "role"],
  registers: [register],
});

export const dbPoolWaitingConnections = new Gauge({
  name: "db_pool_waiting_connections",
  help: "Number of queries waiting for a free connection from the pool",
  labelNames: ["pool", "role"],
  registers: [register],
});

export const dbPoolMaxConnections = new Gauge({
  name: "db_pool_max_connections",
  help: "Configured maximum number of connections in the pool",
  labelNames: ["pool", "role"],
  registers: [register],
});

export const dbPoolConfig = new Gauge({
  name: "db_pool_config",
  help: "Configured connection pool parameters (idle timeout, connection timeout, min)",
  labelNames: ["pool", "role", "param"],
  registers: [register],
});

export const dbDrMode = new Gauge({
  name: "db_dr_mode",
  help: "Disaster recovery mode indicator (1 = failover active, 0 = standby/normal)",
  registers: [register],
});

export { register };

// Cache Metrics
export const cacheHitsTotal = new Counter({
  name: "cache_hits_total",
  help: "Total number of cache hits",
  labelNames: ["route"],
  registers: [register],
});

export const cacheMissesTotal = new Counter({
  name: "cache_misses_total",
  help: "Total number of cache misses",
  labelNames: ["route"],
  registers: [register],
});

// A gauge that mirrors the hit ratio for easier scraping; updated on each hit/miss
export const cacheHitRatio = new Gauge({
  name: "cache_hit_ratio",
  help: "Cache hit ratio (hits / (hits+misses))",
  labelNames: ["route"],
  registers: [register],
});

// Cross-Chain Asset Monitoring Metrics
export const crossChainBalanceGauge = new Gauge({
  name: "cross_chain_balance",
  help: "Current asset balance per chain/address",
  labelNames: ["chain", "asset", "address"],
  registers: [register],
});

export const crossChainAnomalyTotal = new Counter({
  name: "cross_chain_anomaly_total",
  help: "Number of cross-chain balance anomalies detected",
  labelNames: ["chain", "asset", "reason"],
  registers: [register],
});

// Sanctions List Monitoring Metrics
export const sanctionsListLastUpdateTimestamp = new Gauge({
  name: "sanctions_list_last_update_timestamp_seconds",
  help: "Unix timestamp of the last successful sanctions list sync",
  registers: [register],
});

export const sanctionsListRecordCount = new Gauge({
  name: "sanctions_list_record_count",
  help: "Number of records in the sanctions list after the last sync",
  registers: [register],
});

export const sanctionsSyncFailuresTotal = new Counter({
  name: "sanctions_sync_failures_total",
  help: "Total number of failed sanctions list sync attempts",
  registers: [register],
});

// System Heartbeat Metric
export const systemHeartbeat = new Gauge({
  name: "system_heartbeat",
  help: "System heartbeat metric indicating baseline availability state (1=available, 0=unavailable)",
  labelNames: ["service"],
  registers: [register],
});

// BullMQ Queue Depth Metrics
export const queueWaitingJobs = new Gauge({
  name: "bullmq_queue_waiting_jobs",
  help: "Number of waiting jobs in the BullMQ queue",
  labelNames: ["queue"],
  registers: [register],
});

export const queueActiveJobs = new Gauge({
  name: "bullmq_queue_active_jobs",
  help: "Number of active jobs in the BullMQ queue",
  labelNames: ["queue"],
  registers: [register],
});

export const queueCompletedJobs = new Gauge({
  name: "bullmq_queue_completed_jobs",
  help: "Number of completed jobs in the BullMQ queue",
  labelNames: ["queue"],
  registers: [register],
});

export const queueFailedJobs = new Gauge({
  name: "bullmq_queue_failed_jobs",
  help: "Number of failed jobs in the BullMQ queue",
  labelNames: ["queue"],
  registers: [register],
});

export const queueDelayedJobs = new Gauge({
  name: "bullmq_queue_delayed_jobs",
  help: "Number of delayed jobs in the BullMQ queue",
  labelNames: ["queue"],
  registers: [register],
});

export const queueIsPaused = new Gauge({
  name: "bullmq_queue_is_paused",
  help: "Whether the BullMQ queue is paused (1=paused, 0=not paused)",
  labelNames: ["queue"],
  registers: [register],
});

// Worker Availability Metrics
export const workerAvailable = new Gauge({
  name: "bullmq_worker_available",
  help: "Whether a worker is currently active for the queue (1=active, 0=inactive)",
  labelNames: ["queue"],
  registers: [register],
});

// Job Processing Metrics
export const jobDurationSeconds = new Histogram({
  name: "bullmq_job_duration_seconds",
  help: "Duration of BullMQ job processing in seconds",
  labelNames: ["queue", "job_name", "status"],
  buckets: [0.1, 0.5, 1, 3, 5, 10, 30, 60, 120, 300],
  registers: [register],
});

export const jobsTotal = new Counter({
  name: "bullmq_jobs_total",
  help: "Total number of BullMQ jobs processed",
  labelNames: ["queue", "job_name", "status"],
  registers: [register],
});

// Transaction Type Classifier Metrics (ML auto-categorisation)
export const transactionClassificationsTotal = new Counter({
  name: "transaction_classifications_total",
  help: "Total number of transactions classified by the ML model",
  labelNames: ["category"],
  registers: [register],
});

export const transactionClassificationConfidence = new Histogram({
  name: "transaction_classification_confidence",
  help: "Confidence scores of ML transaction classifications",
  buckets: [0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 0.99],
  registers: [register],
});

export const transactionClassifierAccuracy = new Gauge({
  name: "transaction_classifier_accuracy",
  help: "Accuracy of the transaction type classifier evaluated on human-labelled samples (0–1)",
  registers: [register],
});

export const transactionClassifierFeedbackTotal = new Counter({
  name: "transaction_classifier_feedback_total",
  help: "Total number of human feedback corrections submitted for the classifier",
  labelNames: ["corrected_category"],
  registers: [register],
});

export const transactionClassifierTrainingSamples = new Gauge({
  name: "transaction_classifier_training_samples",
  help: "Number of labelled training samples stored for the transaction classifier",
  registers: [register],
});

// Webhook Circuit Breaker Metrics (#573)
export const WebhookCircuitBreakerTransitionTotal = new Counter({
  name: "webhook_circuit_breaker_transition_total",
  help: "Total number of webhook circuit breaker state transitions",
  labelNames: ["webhook", "from", "to"],
  registers: [register],
});

export const WebhookCircuitBreakerState = new Gauge({
  name: "webhook_circuit_breaker_state",
  help: "Current webhook circuit breaker state (0=open, 0.5=half_open, 1=closed)",
  labelNames: ["state"],
  registers: [register],
});

// Webhook Retry Metrics
export const webhookRetryAttemptsTotal = new Counter({
  name: "webhook_retry_attempts_total",
  help: "Total number of webhook retry attempts",
  labelNames: ["event_type", "attempt", "status_code"],
  registers: [register],
});

export const webhookDeliveryDurationSeconds = new Histogram({
  name: "webhook_delivery_duration_seconds",
  help: "Duration of webhook delivery attempts in seconds",
  labelNames: ["event_type", "status"],
  buckets: [0.1, 0.5, 1, 2, 5, 10, 30],
  registers: [register],
});

export const webhookDeliveryRetriesTotal = new Counter({
  name: "webhook_delivery_retries_total",
  help: "Total number of webhook deliveries that required retries",
  labelNames: ["event_type", "final_status"],
  registers: [register],
});

export const webhookBackoffDelaySeconds = new Histogram({
  name: "webhook_backoff_delay_seconds",
  help: "Backoff delay applied between webhook retry attempts in seconds",
  labelNames: ["event_type", "attempt"],
  buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60],
  registers: [register],
});

// Webhook Circuit Breaker Metrics (#573)
//
// Transitions are counted rather than merely observable as a gauge: what an
// operator needs to know is not "the breaker is open" but "this destination
// opens every few hours", which is the signature of a flaky endpoint that a
// 24-hour cooldown will never fix.
export const webhookCircuitBreakerTransitionsTotal = new Counter({
  name: "webhook_circuit_breaker_transitions_total",
  help: "Webhook circuit breaker state transitions",
  labelNames: ["from", "to", "reason"],
  registers: [register],
});

// Deliveries that were never attempted because the breaker was open. This is
// the number that quantifies the savings, and it is also the number that should
// alarm an operator: it is a count of transaction events a merchant did not
// hear about, so it is a count of events they will have to reconcile by hand.
export const webhookCircuitBreakerSkippedTotal = new Counter({
  name: "webhook_circuit_breaker_skipped_total",
  help: "Webhook deliveries suppressed because the destination circuit was open",
  labelNames: ["event_type"],
  registers: [register],
});

// Three series, one per state: 1 for the current state and 0 for the other two.
// All three are written on every change — setting only the active one would leave
// a stale 1 behind and a dashboard would show open and closed at once. A gauge
// rather than a counter so a restart resets it and the value is always the present
// truth instead of a running total. Not labelled by URL: per-destination detail
// is in the admin circuit-breaker snapshot, which keeps this at a fixed three
// series regardless of how many destinations the process has seen.
export const webhookCircuitBreakerState = new Gauge({
  name: "webhook_circuit_breaker_state",
  help: "Current webhook circuit breaker state (1 for the active state)",
  labelNames: ["state"],
  registers: [register],
});

// Deprecated API Endpoint Usage Metrics (#393)
export const deprecatedEndpointRequestsTotal = new Counter({
  name: "deprecated_endpoint_requests_total",
  help: "Total number of requests to deprecated API endpoints",
  labelNames: ["method", "route", "replacement", "sunset"],
  registers: [register],
});

// ──── Transaction Processing Rate Metrics (for HPA scaling) ────

/**
 * Transaction processing rate (transactions per second).
 * This metric is used for HPA scaling decisions based on application-level metrics.
 */
export const transactionProcessingRate = new Gauge({
  name: "transaction_processing_rate",
  help: "Current transaction processing rate (transactions per second)",
  labelNames: ["provider", "type"],
  registers: [register],
});

/**
 * Transaction queue depth (pending transactions waiting to be processed).
 * This is the primary metric for worker autoscaling.
 */
export const transactionQueueDepth = new Gauge({
  name: "transaction_queue_depth",
  help: "Number of transactions waiting to be processed",
  labelNames: ["queue", "status"],
  registers: [register],
});

/**
 * Provider-specific transaction rate.
 * Allows scaling based on individual provider load.
 */
export const providerTransactionRate = new Gauge({
  name: "provider_transaction_rate",
  help: "Transaction rate per provider (transactions per second)",
  labelNames: ["provider"],
  registers: [register],
});

/**
 * Provider queue depth.
 * Allows scaling based on individual provider queue depth.
 */
export const providerQueueDepth = new Gauge({
  name: "provider_queue_depth",
  help: "Queue depth per provider",
  labelNames: ["provider"],
  registers: [register],
});

/**
 * Transaction processing latency (P95).
 * Used for latency-based scaling decisions.
 */
export const transactionProcessingLatencyP95 = new Gauge({
  name: "transaction_processing_latency_p95_seconds",
  help: "P95 transaction processing latency in seconds",
  registers: [register],
});

/**
 * Worker utilization ratio.
 * Ratio of active workers to total workers. Used for scaling decisions.
 */
export const workerUtilizationRatio = new Gauge({
  name: "worker_utilization_ratio",
  help: "Ratio of active workers to total workers (0-1)",
  registers: [register],
});

/**
 * #479 – Notification system observability
 * Exposes whether notifications are actually being delivered, per channel.
 */
export const notificationDeliveriesTotal = new Counter({
  name: "notification_deliveries_total",
  help: "Notification delivery attempts by channel and outcome",
  labelNames: ["channel", "status"],
  registers: [register],
});

export const notificationDeliveryDurationSeconds = new Histogram({
  name: "notification_delivery_duration_seconds",
  help: "Duration of a single notification channel delivery attempt",
  labelNames: ["channel", "status"],
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
  registers: [register],
});

export const notificationChannelHealthGauge = new Gauge({
  name: "notification_channel_health",
  help: "Notification channel health (1 healthy, 0.5 degraded, 0 down)",
  labelNames: ["channel"],
  registers: [register],
});

export const notificationSystemUp = new Gauge({
  name: "notification_system_up",
  help: "1 when every notification channel is healthy, 0 otherwise",
  registers: [register],
});
