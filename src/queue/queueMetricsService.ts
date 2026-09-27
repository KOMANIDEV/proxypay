import { Queue, Worker } from "bullmq";
import {
  queueWaitingJobs,
  queueActiveJobs,
  queueCompletedJobs,
  queueFailedJobs,
  queueDelayedJobs,
  queueIsPaused,
  workerAvailable,
  jobDurationSeconds,
  jobsTotal,
} from "../utils/metrics";
import { syncQueue, SYNC_QUEUE_NAME } from "./syncQueue";
import { accountMergeQueue, ACCOUNT_MERGE_QUEUE_NAME } from "./accountMergeQueue";
import { providerBalanceAlertQueue, PROVIDER_BALANCE_ALERT_QUEUE_NAME } from "./providerBalanceAlertQueue";
import { accountingTokenRefreshQueue, ACCOUNTING_TOKEN_REFRESH_QUEUE_NAME } from "./accountingTokenRefreshQueue";

const BULLMQ_QUEUES: { name: string; queue: Queue }[] = [
  { name: SYNC_QUEUE_NAME, queue: syncQueue },
  { name: ACCOUNT_MERGE_QUEUE_NAME, queue: accountMergeQueue },
  { name: PROVIDER_BALANCE_ALERT_QUEUE_NAME, queue: providerBalanceAlertQueue },
  { name: ACCOUNTING_TOKEN_REFRESH_QUEUE_NAME, queue: accountingTokenRefreshQueue },
];

let collectionInterval: ReturnType<typeof setInterval> | null = null;

const COLLECTION_INTERVAL_MS = Math.max(
  5000,
  parseInt(process.env.QUEUE_METRICS_COLLECTION_INTERVAL_MS || "15000", 10),
);

async function collectQueueMetrics(): Promise<void> {
  await Promise.all(
    BULLMQ_QUEUES.map(async ({ name, queue }) => {
      try {
        const [waiting, active, completed, failed, delayed, paused] =
          await Promise.all([
            queue.getWaitingCount(),
            queue.getActiveCount(),
            queue.getCompletedCount(),
            queue.getFailedCount(),
            queue.getDelayedCount(),
            queue.isPaused(),
          ]);

        queueWaitingJobs.labels(name).set(waiting);
        queueActiveJobs.labels(name).set(active);
        queueCompletedJobs.labels(name).set(completed);
        queueFailedJobs.labels(name).set(failed);
        queueDelayedJobs.labels(name).set(delayed);
        queueIsPaused.labels(name).set(paused ? 1 : 0);
      } catch (err) {
        console.error(`[QueueMetrics] Failed to collect metrics for queue "${name}":`, err);
      }
    }),
  );
}

export function instrumentWorker(queueName: string, worker: Worker): void {
  worker.on("completed", (job) => {
    const jobName = job.name;
    const duration = process.hrtime.bigint
      ? Number(process.hrtime.bigint() - BigInt(job.processedOn ?? job.timestamp)) / 1e9
      : 0;

    if (duration > 0) {
      jobDurationSeconds.labels(queueName, jobName, "completed").observe(duration);
    }
    jobsTotal.labels(queueName, jobName, "completed").inc();
  });

  worker.on("failed", (job, error) => {
    const jobName = job?.name ?? "unknown";
    const duration = job?.processedOn
      ? (Date.now() - job.processedOn) / 1000
      : 0;

    if (duration > 0) {
      jobDurationSeconds.labels(queueName, jobName, "failed").observe(duration);
    }
    jobsTotal.labels(queueName, jobName, "failed").inc();
  });

  workerAvailable.labels(queueName).set(1);

  const originalClose = worker.close.bind(worker);
  worker.close = async () => {
    workerAvailable.labels(queueName).set(0);
    await originalClose();
  };
}

export function startQueueMetricsCollection(): void {
  if (collectionInterval) {
    return;
  }

  collectQueueMetrics();
  collectionInterval = setInterval(collectQueueMetrics, COLLECTION_INTERVAL_MS);
}

export function stopQueueMetricsCollection(): void {
  if (collectionInterval) {
    clearInterval(collectionInterval);
    collectionInterval = null;
  }

  BULLMQ_QUEUES.forEach(({ name }) => {
    workerAvailable.labels(name).set(0);
  });
}
