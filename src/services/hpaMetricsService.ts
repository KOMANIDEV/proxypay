/**
 * Metrics Service for HPA Scaling
 * 
 * This service updates Prometheus metrics that are used for Horizontal Pod Autoscaler
 * scaling decisions. It provides application-level metrics beyond basic CPU/memory.
 * 
 * Metrics provided:
 * - Transaction processing rate (TPS)
 * - Queue depth per provider
 * - Provider-specific transaction rates
 * - Worker utilization ratio
 * - Transaction processing latency
 */

import { Request, Response } from "express";
import {
  register,
  transactionProcessingRate,
  transactionQueueDepth,
  providerTransactionRate,
  providerQueueDepth,
  transactionProcessingLatencyP95,
  workerUtilizationRatio,
} from "../utils/metrics";
import { queryRead } from "../config/database";
import logger from "../utils/logger";

// Track processing rates over time
const processingRateWindow = new Map<string, { count: number; timestamp: number }>();
const RATE_WINDOW_MS = 60000; // 1 minute window

export class HpaMetricsService {
  private static instance: HpaMetricsService;
  private updateInterval: NodeJS.Timeout | null = null;

  static getInstance(): HpaMetricsService {
    if (!HpaMetricsService.instance) {
      HpaMetricsService.instance = new HpaMetricsService();
    }
    return HpaMetricsService.instance;
  }

  /**
   * Start the metrics update loop
   */
  start(updateIntervalMs: number = 15000): void {
    if (this.updateInterval) {
      return; // Already running
    }

    logger.info(`[HPA Metrics] Starting metrics update loop (interval: ${updateIntervalMs}ms)`);

    // Initial update
    this.updateMetrics().catch(err => {
      logger.error(err, "[HPA Metrics] Initial metrics update failed");
    });

    // Periodic updates
    this.updateInterval = setInterval(() => {
      this.updateMetrics().catch(err => {
        logger.error(err, "[HPA Metrics] Periodic metrics update failed");
      });
    }, updateIntervalMs);
  }

  /**
   * Stop the metrics update loop
   */
  stop(): void {
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
      logger.info("[HPA Metrics] Stopped metrics update loop");
    }
  }

  /**
   * Record a transaction processing event
   */
  recordTransactionProcessing(provider: string, type: string, durationMs: number): void {
    const key = `${provider}:${type}`;
    const now = Date.now();
    
    const existing = processingRateWindow.get(key) || { count: 0, timestamp: now };
    existing.count++;
    
    // Reset if window expired
    if (now - existing.timestamp > RATE_WINDOW_MS) {
      existing.count = 1;
      existing.timestamp = now;
    }
    
    processingRateWindow.set(key, existing);
    
    // Update rate metric
    const elapsedSeconds = (now - existing.timestamp) / 1000;
    const rate = elapsedSeconds > 0 ? existing.count / elapsedSeconds : 0;
    transactionProcessingRate.set({ provider, type }, rate);
  }

  /**
   * Update all HPA-related metrics
   */
  async updateMetrics(): Promise<void> {
    try {
      await Promise.all([
        this.updateQueueDepths(),
        this.updateProviderMetrics(),
        this.updateWorkerUtilization(),
        this.updateLatencyMetrics(),
      ]);
    } catch (error) {
      logger.error(error, "[HPA Metrics] Failed to update metrics");
    }
  }

  /**
   * Update queue depth metrics
   */
  private async updateQueueDepths(): Promise<void> {
    try {
      // Get queue depths from BullMQ
      const result = await queryRead(`
        SELECT 
          queue_name,
          status,
          COUNT(*) as count
        FROM bullmq_jobs
        WHERE status IN ('waiting', 'active', 'delayed')
        GROUP BY queue_name, status
      `);

      // Reset all queue depth metrics
      transactionQueueDepth.reset();

      for (const row of result.rows) {
        transactionQueueDepth.set(
          { queue: row.queue_name, status: row.status },
          parseInt(row.count)
        );
      }

      // Calculate total depth per provider
      const providerDepths = new Map<string, number>();
      for (const row of result.rows) {
        const provider = this.extractProviderFromQueue(row.queue_name);
        if (provider) {
          providerDepths.set(provider, (providerDepths.get(provider) || 0) + parseInt(row.count));
        }
      }

      // Update provider-specific queue depths
      providerQueueDepth.reset();
      for (const [provider, depth] of providerDepths) {
        providerQueueDepth.set({ provider }, depth);
      }

    } catch (error) {
      // BullMQ tables might not exist, try alternative approach
      logger.debug("[HPA Metrics] BullMQ tables not available, using alternative metrics");
      await this.updateQueueDepthsAlternative();
    }
  }

  /**
   * Alternative queue depth calculation using transaction table
   */
  private async updateQueueDepthsAlternative(): Promise<void> {
    try {
      const result = await queryRead(`
        SELECT 
          provider,
          status,
          COUNT(*) as count
        FROM transactions
        WHERE status IN ('pending', 'review')
          AND created_at > NOW() - INTERVAL '1 hour'
        GROUP BY provider, status
      `);

      transactionQueueDepth.reset();
      providerQueueDepth.reset();

      const providerDepths = new Map<string, number>();

      for (const row of result.rows) {
        transactionQueueDepth.set(
          { queue: row.provider, status: row.status },
          parseInt(row.count)
        );

        providerDepths.set(
          row.provider,
          (providerDepths.get(row.provider) || 0) + parseInt(row.count)
        );
      }

      for (const [provider, depth] of providerDepths) {
        providerQueueDepth.set({ provider }, depth);
      }

    } catch (error) {
      logger.debug(error, "[HPA Metrics] Alternative queue depth calculation failed");
    }
  }

  /**
   * Update provider-specific metrics
   */
  private async updateProviderMetrics(): Promise<void> {
    try {
      // Get transaction rates per provider (last 5 minutes)
      const result = await queryRead(`
        SELECT 
          provider,
          COUNT(*) as count,
          EXTRACT(EPOCH FROM (MAX(created_at) - MIN(created_at))) as time_span_seconds
        FROM transactions
        WHERE created_at > NOW() - INTERVAL '5 minutes'
          AND status = 'completed'
        GROUP BY provider
      `);

      providerTransactionRate.reset();

      for (const row of result.rows) {
        const timeSpan = parseFloat(row.time_span_seconds) || 300; // Default to 5 minutes
        const rate = timeSpan > 0 ? parseInt(row.count) / timeSpan : 0;
        providerTransactionRate.set({ provider: row.provider }, rate);
      }

    } catch (error) {
      logger.debug(error, "[HPA Metrics] Provider metrics update failed");
    }
  }

  /**
   * Update worker utilization metrics
   */
  private async updateWorkerUtilization(): Promise<void> {
    try {
      // Get active vs total workers
      const result = await queryRead(`
        SELECT 
          COUNT(CASE WHEN status = 'active' THEN 1 END) as active_workers,
          COUNT(*) as total_workers
        FROM worker_instances
        WHERE last_heartbeat > NOW() - INTERVAL '30 seconds'
      `);

      if (result.rows.length > 0) {
        const { active_workers, total_workers } = result.rows[0];
        const ratio = total_workers > 0 ? active_workers / total_workers : 0;
        workerUtilizationRatio.set(ratio);
      }

    } catch (error) {
      // Worker instances table might not exist
      logger.debug(error, "[HPA Metrics] Worker utilization update failed");
    }
  }

  /**
   * Update latency metrics
   */
  private async updateLatencyMetrics(): Promise<void> {
    try {
      // Calculate P95 latency from recent transactions
      const result = await queryRead(`
        SELECT 
          PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY 
            EXTRACT(EPOCH FROM (updated_at - created_at))
          ) as p95_latency
        FROM transactions
        WHERE status IN ('completed', 'failed')
          AND created_at > NOW() - INTERVAL '5 minutes'
      `);

      if (result.rows.length > 0 && result.rows[0].p95_latency) {
        transactionProcessingLatencyP95.set(parseFloat(result.rows[0].p95_latency));
      }

    } catch (error) {
      logger.debug(error, "[HPA Metrics] Latency metrics update failed");
    }
  }

  /**
   * Extract provider name from queue name
   */
  private extractProviderFromQueue(queueName: string): string | null {
    const providerPatterns = [
      /mtn/i,
      /airtel/i,
      /orange/i,
      /stellar/i,
    ];

    for (const pattern of providerPatterns) {
      if (pattern.test(queueName)) {
        return queueName.split('_')[0].toUpperCase();
      }
    }

    return null;
  }

  /**
   * Returns all Prometheus formatted metrics including custom HPA metrics
   */
  async getMetrics(): Promise<string> {
    await this.updateMetrics();
    return register.metrics();
  }

  /**
   * Returns Prometheus metrics content type
   */
  getContentType(): string {
    return register.contentType;
  }

  /**
   * Express request handler for Prometheus scraper endpoint (/metrics)
   */
  async metricsHandler(req: Request, res: Response): Promise<void> {
    try {
      res.set("Content-Type", this.getContentType());
      const metrics = await this.getMetrics();
      res.end(metrics);
    } catch (error) {
      logger.error(error, "[HPA Metrics] Failed to expose metrics");
      res.status(500).end(String(error));
    }
  }
}

export const hpaMetricsService = HpaMetricsService.getInstance();
