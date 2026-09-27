/**
 * Unit tests for the Transaction Type Classifier service.
 *
 * Coverage:
 *   1. extractFeatures – tokenisation + amount bands + structural features
 *   2. TransactionClassifier – seeded classification, confidence scoring,
 *      training improves predictions, online learning (feedback loop)
 *   3. classifyTransaction – DB-backed pipeline
 *   4. recordTrainingExample – training data collection pipeline
 *   5. submitHumanFeedback – human feedback loop
 *   6. trainModel – batch retrain with versioning
 *   7. getClassificationAccuracy – accuracy monitoring
 */

import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import {
  TransactionClassifier,
  classifyTransaction,
  recordTrainingExample,
  submitHumanFeedback,
  trainModel,
  getClassificationAccuracy,
  getClassifierStats,
  extractFeatures,
  _resetSharedClassifierForTesting,
} from "../transactionClassifierService";

jest.mock("../../config/database", () => ({
  pool: { query: jest.fn() },
}));
jest.mock("../../utils/logger", () => ({
  __esModule: true,
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn() },
}));
jest.mock("../../utils/metrics", () => ({
  transactionClassificationsTotal: {
    labels: jest.fn().mockReturnValue({ inc: jest.fn() }),
  },
  transactionClassificationConfidence: { observe: jest.fn() },
  transactionClassifierAccuracy: { set: jest.fn() },
  transactionClassifierFeedbackTotal: {
    labels: jest.fn().mockReturnValue({ inc: jest.fn() }),
  },
  transactionClassifierTrainingSamples: { set: jest.fn() },
}));

import { pool } from "../../config/database";

const mockQuery = pool.query as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  mockQuery.mockReset();
  _resetSharedClassifierForTesting();
});

// ---------------------------------------------------------------------------
// 1. Feature extraction
// ---------------------------------------------------------------------------

describe("extractFeatures", () => {
  it("tokenises notes and lowercases them", () => {
    const features = extractFeatures({ notes: "Salary Payout for March" });
    expect(features.salary).toBe(1);
    expect(features.payout).toBe(1);
    expect(features.for).toBe(1);
    expect(features.march).toBe(1);
  });

  it("tags small/medium/large amount bands", () => {
    expect(extractFeatures({ amount: 50 }).amountSmall).toBe(1);
    expect(extractFeatures({ amount: "50000" }).amountMedium).toBe(1);
    expect(extractFeatures({ amount: 1000000 }).amountLarge).toBe(1);
  });

  it("records phone presence", () => {
    const features = extractFeatures({ phoneNumber: "+2376..." });
    expect(features.hasPhone).toBe(1);
  });

  it("handles empty input without throwing", () => {
    expect(extractFeatures({})).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// 2. Core model
// ---------------------------------------------------------------------------

describe("TransactionClassifier", () => {
  it("classifies a withdrawal from keywords with high confidence", () => {
    const classifier = new TransactionClassifier();
    const result = classifier.classify(
      extractFeatures({ notes: "cashout withdrawal to mobile" }),
    );
    expect(result.category).toBe("withdraw");
    expect(result.confidence).toBeGreaterThan(0.5);
    // Probabilities are normalised.
    const sum = Object.values(result.probabilities).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1, 5);
  });

  it("classifies a deposit from keywords", () => {
    const classifier = new TransactionClassifier();
    const result = classifier.classify(
      extractFeatures({ notes: "deposit topup from momo" }),
    );
    expect(result.category).toBe("deposit");
  });

  it("improves after training on labelled examples", () => {
    const classifier = new TransactionClassifier();
    // Seed heavy weights toward "payment" for "groceries" style transactions.
    classifier.train([
      {
        label: "payment",
        features: { groceries: 1, supermarket: 1 },
        source: "human",
      },
      {
        label: "payment",
        features: { groceries: 1, market: 1 },
        source: "human",
      },
      {
        label: "payment",
        features: { groceries: 1, store: 1 },
        source: "human",
      },
      {
        label: "payment",
        features: { groceries: 1, checkout: 1 },
        source: "human",
      },
      {
        label: "payment",
        features: { groceries: 1, aisle: 1 },
        source: "human",
      },
      {
        label: "payment",
        features: { groceries: 1, bakery: 1 },
        source: "human",
      },
    ]);

    const before = classifier.classify({ groceries: 1 }).category;
    expect(before).toBe("payment");

    const result = classifier.classify(
      extractFeatures({ notes: "groceries at the supermarket" }),
    );
    expect(result.category).toBe("payment");
    expect(result.confidence).toBeGreaterThan(0.8);
  });

  it("folds feedback corrections into the live model (online learning)", () => {
    const classifier = new TransactionClassifier();
    // Model currently thinks "salary" is a payout (it is) – teach it that
    // this particular pattern should be a fee.
    const before = classifier.classify({ salary: 1 });
    expect(before.category).toBe("payout");

    classifier.updateOnline({
      label: "fee",
      features: { salary: 1 },
      source: "human",
    });
    classifier.updateOnline({
      label: "fee",
      features: { salary: 1 },
      source: "human",
    });
    classifier.updateOnline({
      label: "fee",
      features: { salary: 1 },
      source: "human",
    });

    const after = classifier.classify({ salary: 1 });
    expect(after.category).toBe("fee");
  });

  it("round-trips model weights through serialisation", () => {
    const classifier = new TransactionClassifier();
    classifier.train([
      { label: "refund", features: { chargeback: 2 }, source: "human" },
    ]);
    const weights = classifier.toModelWeights();

    const restored = new TransactionClassifier();
    restored.fromModelWeights(weights);
    const result = restored.classify(extractFeatures({ notes: "chargeback" }));
    expect(result.category).toBe("refund");
  });
});

// ---------------------------------------------------------------------------
// 3. DB-backed classifyTransaction
// ---------------------------------------------------------------------------

describe("classifyTransaction", () => {
  it("classifies using the seeded model when no persisted model exists", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] }); // no persisted model
    const result = await classifyTransaction({
      notes: "withdrawal cashout",
      amount: 5000,
    });
    expect(result.category).toBe("withdraw");
    expect(result.confidence).toBeGreaterThan(0);
    expect(result.modelVersion).toBe(1);
  });

  it("loads the persisted model version when available", async () => {
    // Build a real trained model and persist its serialised form, so the
    // restore path is exercised with genuine weights.
    const trained = new TransactionClassifier();
    trained.train([
      {
        label: "deposit",
        features: { deposit: 1, received: 1 },
        source: "human",
      },
      {
        label: "deposit",
        features: { deposit: 1, credit: 1 },
        source: "human",
      },
      { label: "deposit", features: { deposit: 1, topup: 1 }, source: "human" },
      { label: "deposit", features: { deposit: 1, fund: 1 }, source: "human" },
      {
        label: "deposit",
        features: { deposit: 1, transfer: 1 },
        source: "human",
      },
    ]);
    const weights = trained.toModelWeights();

    mockQuery.mockResolvedValueOnce({
      rows: [
        { version: 3, weights: weights.probabilities, priors: weights.priors },
      ],
    });
    const result = await classifyTransaction({ notes: "deposit received" });
    expect(result.category).toBe("deposit");
    expect(result.modelVersion).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// 4. Training data collection pipeline
// ---------------------------------------------------------------------------

describe("recordTrainingExample", () => {
  it("persists the example and folds it into the live model", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] }); // model load (none persisted)
    mockQuery.mockResolvedValueOnce({ rows: [] }); // INSERT training
    mockQuery.mockResolvedValueOnce({ rows: [] }); // INSERT training (again? no)
    mockQuery.mockResolvedValueOnce({ rows: [{ total: 1 }] }); // gauge refresh

    await recordTrainingExample({
      transactionId: "tx-1",
      label: "payment",
      features: { groceries: 1 },
      source: "auto",
    });

    expect(
      mockQuery.mock.calls.some((call) =>
        call[0].includes("transaction_classifier_training"),
      ),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 5. Human feedback loop
// ---------------------------------------------------------------------------

describe("submitHumanFeedback", () => {
  it("stores the correction and adds a human training example", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] }) // feedback insert
      .mockResolvedValueOnce({ rows: [] }) // model load (none)
      .mockResolvedValueOnce({ rows: [] }) // training insert
      .mockResolvedValueOnce({ rows: [{ total: 1 }] }); // gauge refresh

    await submitHumanFeedback({
      transactionId: "tx-2",
      predictedCategory: "payment",
      correctedCategory: "fee",
      userId: "user-9",
      features: { invoice: 1 },
    });

    const feedbackInsert = mockQuery.mock.calls.find((call) =>
      String(call[0]).includes("transaction_classifier_feedback"),
    );
    expect(feedbackInsert).toBeDefined();
    expect(feedbackInsert![1]).toEqual(["tx-2", "payment", "fee", "user-9"]);
  });
});

// ---------------------------------------------------------------------------
// 6. Batch retrain
// ---------------------------------------------------------------------------

describe("trainModel", () => {
  it("retrains from all stored samples and persists a new version", async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [
          { features: { refund: 1 }, label: "refund" },
          { features: { refund: 1 }, label: "refund" },
        ],
      }) // training samples
      .mockResolvedValueOnce({ rows: [{ version: 2 }] }) // model insert
      .mockResolvedValueOnce({ rows: [{ total: 2 }] }); // gauge refresh

    const version = await trainModel();
    expect(version).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 7. Accuracy monitoring
// ---------------------------------------------------------------------------

describe("getClassificationAccuracy", () => {
  it("evaluates the model against human-labelled samples", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] }) // model load
      .mockResolvedValueOnce({
        rows: [
          { features: { withdraw: 1 }, label: "withdraw" },
          { features: { deposit: 1 }, label: "deposit" },
        ],
      }); // human samples

    const report = await getClassificationAccuracy();
    expect(report.total).toBe(2);
    expect(report.correct).toBeGreaterThanOrEqual(1);
    expect(report.accuracy).toBeGreaterThanOrEqual(0);
    expect(report.accuracy).toBeLessThanOrEqual(1);
  });

  it("returns zero accuracy when no human samples exist", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] }) // model load
      .mockResolvedValueOnce({ rows: [] }); // no samples

    const report = await getClassificationAccuracy();
    expect(report.total).toBe(0);
    expect(report.accuracy).toBe(0);
  });
});

describe("getClassifierStats", () => {
  it("returns model version, sample and feedback counts", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] }) // model load
      .mockResolvedValueOnce({ rows: [{ total: 12 }] }) // training count
      .mockResolvedValueOnce({ rows: [{ total: 3 }] }); // feedback count

    const stats = await getClassifierStats();
    expect(stats.modelVersion).toBe(1);
    expect(stats.trainingSamples).toBe(12);
    expect(stats.feedbackCount).toBe(3);
    expect(stats.categories).toContain("withdraw");
  });
});
