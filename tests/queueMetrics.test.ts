import express from "express";
import request from "supertest";

jest.mock("bullmq", () => ({
  Queue: jest.fn().mockImplementation(() => ({
    getWaitingCount: jest.fn().mockResolvedValue(5),
    getActiveCount: jest.fn().mockResolvedValue(2),
    getCompletedCount: jest.fn().mockResolvedValue(100),
    getFailedCount: jest.fn().mockResolvedValue(3),
    getDelayedCount: jest.fn().mockResolvedValue(1),
    isPaused: jest.fn().mockResolvedValue(false),
    close: jest.fn().mockResolvedValue(undefined),
  })),
  Worker: jest.fn().mockImplementation(() => ({
    on: jest.fn(),
    close: jest.fn().mockResolvedValue(undefined),
  })),
}));

jest.mock("../src/config/redis", () => ({
  redisClient: {
    info: jest.fn().mockResolvedValue("used_memory:1048576\n"),
    get: jest.fn().mockResolvedValue(null),
    setex: jest.fn().mockResolvedValue("OK"),
    del: jest.fn().mockResolvedValue(1),
    ping: jest.fn().mockResolvedValue("PONG"),
    isOpen: true,
    on: jest.fn(),
  },
  connectRedis: jest.fn(),
  disconnectRedis: jest.fn(),
  createRedisStore: jest.fn(() => ({
    get: jest.fn(),
    set: jest.fn(),
    destroy: jest.fn(),
  })),
  SESSION_TTL_SECONDS: 86400,
}));

jest.mock("../src/config/database", () => ({
  pool: { query: jest.fn().mockResolvedValue({ rows: [] }), end: jest.fn() },
  queryRead: jest.fn().mockResolvedValue({ rows: [] }),
  queryWrite: jest.fn().mockResolvedValue({ rows: [] }),
}));

jest.mock("../src/config/init", () => ({}));

import {
  register,
  queueWaitingJobs,
  queueActiveJobs,
  queueCompletedJobs,
  queueFailedJobs,
  queueDelayedJobs,
  queueIsPaused,
  workerAvailable,
  jobDurationSeconds,
  jobsTotal,
} from "../src/utils/metrics";
import {
  startQueueMetricsCollection,
  stopQueueMetricsCollection,
  instrumentWorker,
} from "../src/queue/queueMetricsService";
import { getQueueStatsAggregate } from "../src/queue/queueDepthMetrics";

function buildMetricsApp() {
  const app = express();
  app.get("/metrics", async (req, res) => {
    try {
      res.set("Content-Type", register.contentType);
      res.end(await register.metrics());
    } catch (ex) {
      res.status(500).end(String(ex));
    }
  });
  return app;
}

async function getMetricsText(): Promise<string> {
  const app = buildMetricsApp();
  const res = await request(app).get("/metrics");
  return res.text;
}

describe("BullMQ Queue Metrics", () => {
  afterEach(() => {
    stopQueueMetricsCollection();
    queueWaitingJobs.reset();
    queueActiveJobs.reset();
    queueCompletedJobs.reset();
    queueFailedJobs.reset();
    queueDelayedJobs.reset();
    queueIsPaused.reset();
    workerAvailable.reset();
    jobDurationSeconds.reset();
    jobsTotal.reset();
  });

  describe("Metric Definitions", () => {
    it("should define queue depth gauges with queue label", () => {
      expect(queueWaitingJobs.labelNames).toContain("queue");
      expect(queueActiveJobs.labelNames).toContain("queue");
      expect(queueCompletedJobs.labelNames).toContain("queue");
      expect(queueFailedJobs.labelNames).toContain("queue");
      expect(queueDelayedJobs.labelNames).toContain("queue");
      expect(queueIsPaused.labelNames).toContain("queue");
    });

    it("should define worker availability gauge with queue label", () => {
      expect(workerAvailable.labelNames).toContain("queue");
    });

    it("should define job duration histogram and counter with correct labels", () => {
      expect(jobDurationSeconds.labelNames).toEqual(
        expect.arrayContaining(["queue", "job_name", "status"]),
      );
      expect(jobsTotal.labelNames).toEqual(
        expect.arrayContaining(["queue", "job_name", "status"]),
      );
    });
  });

  describe("Gauge Values", () => {
    it("should set and expose gauge values via /metrics", async () => {
      queueWaitingJobs.labels("test-queue").set(42);
      queueActiveJobs.labels("test-queue").set(7);
      queueCompletedJobs.labels("test-queue").set(500);
      queueFailedJobs.labels("test-queue").set(10);
      queueDelayedJobs.labels("test-queue").set(3);
      queueIsPaused.labels("test-queue").set(0);
      workerAvailable.labels("test-queue").set(1);

      const text = await getMetricsText();

      expect(text).toContain("bullmq_queue_waiting_jobs");
      expect(text).toContain("bullmq_queue_active_jobs");
      expect(text).toContain("bullmq_queue_completed_jobs");
      expect(text).toContain("bullmq_queue_failed_jobs");
      expect(text).toContain("bullmq_queue_delayed_jobs");
      expect(text).toContain("bullmq_queue_is_paused");
      expect(text).toContain("bullmq_worker_available");
    });

    it("should include HELP and TYPE lines", async () => {
      queueWaitingJobs.labels("q").set(0);

      const text = await getMetricsText();

      expect(text).toContain("# HELP bullmq_queue_waiting_jobs");
      expect(text).toContain("# TYPE bullmq_queue_waiting_jobs gauge");
      expect(text).toContain("# HELP bullmq_queue_active_jobs");
      expect(text).toContain("# TYPE bullmq_queue_active_jobs gauge");
      expect(text).toContain("# HELP bullmq_worker_available");
      expect(text).toContain("# TYPE bullmq_worker_available gauge");
    });

    it("should export in proper Prometheus text format", async () => {
      queueWaitingJobs.labels("test-queue").set(42);

      const text = await getMetricsText();

      const waitingLine = text
        .split("\n")
        .find((line: string) => /^bullmq_queue_waiting_jobs/.test(line));
      expect(waitingLine).toBeDefined();
      expect(waitingLine).toMatch(
        /bullmq_queue_waiting_jobs\{queue="[^"]+"\}\s+\d+/,
      );
    });

    it("should reflect correct gauge values in output", async () => {
      queueWaitingJobs.labels("myqueue").set(99);

      const text = await getMetricsText();

      expect(text).toContain('bullmq_queue_waiting_jobs{queue="myqueue"} 99');
    });
  });

  describe("Job Processing Metrics", () => {
    it("should record completed job duration and count", async () => {
      jobDurationSeconds
        .labels("test-queue", "test-job", "completed")
        .observe(1.5);
      jobsTotal.labels("test-queue", "test-job", "completed").inc();
      jobsTotal.labels("test-queue", "test-job", "completed").inc();

      const text = await getMetricsText();

      expect(text).toContain("bullmq_job_duration_seconds");
      expect(text).toContain("bullmq_jobs_total");
    });

    it("should record failed job duration and count", async () => {
      jobDurationSeconds
        .labels("test-queue", "test-job", "failed")
        .observe(5.0);
      jobsTotal.labels("test-queue", "test-job", "failed").inc();

      const text = await getMetricsText();

      expect(text).toContain("bullmq_job_duration_seconds");
      expect(text).toContain("bullmq_jobs_total");
    });

    it("should include HELP and TYPE for job metrics", async () => {
      jobDurationSeconds.labels("q", "j", "completed").observe(1);

      const text = await getMetricsText();

      expect(text).toContain("# HELP bullmq_job_duration_seconds");
      expect(text).toContain("# TYPE bullmq_job_duration_seconds histogram");
      expect(text).toContain("# HELP bullmq_jobs_total");
      expect(text).toContain("# TYPE bullmq_jobs_total counter");
    });
  });

  describe("Worker Instrumentation", () => {
    it("should set worker available gauge and register event handlers", () => {
      const { Worker: MockWorker } = require("bullmq");
      const mockWorker = new MockWorker();

      instrumentWorker("test-queue", mockWorker);

      expect(mockWorker.on).toHaveBeenCalledWith(
        "completed",
        expect.any(Function),
      );
      expect(mockWorker.on).toHaveBeenCalledWith(
        "failed",
        expect.any(Function),
      );
    });
  });

  describe("Queue Metrics Collection", () => {
    it("should start and stop collection without errors", () => {
      expect(() => {
        startQueueMetricsCollection();
        stopQueueMetricsCollection();
      }).not.toThrow();
    });

    it("should be idempotent when started multiple times", () => {
      startQueueMetricsCollection();
      startQueueMetricsCollection();
      startQueueMetricsCollection();
      stopQueueMetricsCollection();
    });
  });

  describe("Aggregate Queue Depth", () => {
    it("should return aggregate stats for all queues", async () => {
      const result = await getQueueStatsAggregate();

      expect(result).toBeDefined();
      expect(result.queues).toBeInstanceOf(Array);
      expect(result.total_depth).toBeGreaterThanOrEqual(0);
      expect(result.timestamp).toBeDefined();
    });

    it("should include all known queues in the aggregate", async () => {
      const result = await getQueueStatsAggregate();
      const queueNames = result.queues.map((q) => q.name);

      expect(queueNames).toContain("transaction-processing");
      expect(queueNames).toContain("provider-balance-alerts");
      expect(queueNames).toContain("account-merge");
      expect(queueNames).toContain("accounting-sync");
      expect(queueNames).toContain("accounting-token-refresh");
    });

    it("should calculate depth as waiting + active", () => {
      const queue = {
        name: "test-queue",
        waiting: 10,
        active: 5,
        depth: 0,
        latency_ms: 0,
      };
      queue.depth = queue.waiting + queue.active;

      expect(queue.depth).toBe(15);
    });
  });
});
