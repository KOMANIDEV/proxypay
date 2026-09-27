import { rabbitMQManager, EXCHANGES, ROUTING_KEYS, QUEUES } from "./rabbitmq";
import { reprocessingService, ReprocessingJob } from "../services/reprocessingService";
import logger from "../utils/logger";

export const REPROCESSING_QUEUE_NAME = "transaction-reprocessing-queue";

export async function startReprocessingWorker(): Promise<void> {
  await rabbitMQManager.consume<ReprocessingJob>(
    REPROCESSING_QUEUE_NAME,
    async (job) => {
      try {
        logger.info({ jobId: job.id, transactionId: job.transactionId }, "[reprocessing] Processing job");
        const result = await reprocessingService.processJob(job);
        logger.info({ jobId: job.id, success: result.success }, "[reprocessing] Job processed");
      } catch (error) {
        logger.error({ error, jobId: job.id }, "[reprocessing] Worker failed to process job");
      }
    },
    3,
  );
}

export async function scheduleReprocessingPoller(intervalMs = 30000): Promise<void> {
  const poll = async () => {
    try {
      const pendingJobs = await reprocessingService.getPendingJobs(50);
      for (const job of pendingJobs) {
        await rabbitMQManager.publish(EXCHANGES.TRANSACTIONS, ROUTING_KEYS.TRANSACTION_PROCESS, {
          type: "reprocessing",
          jobId: job.id,
          transactionId: job.transactionId,
          provider: job.provider,
          attemptNumber: job.attemptNumber,
          scheduledAt: job.scheduledAt,
        });
      }
    } catch (error) {
      logger.error({ error }, "[reprocessing] Poller failed");
    }
  };

  await poll();
  setInterval(poll, intervalMs);
}
