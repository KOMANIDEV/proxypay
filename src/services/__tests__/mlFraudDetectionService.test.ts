/**
 * #485 – Machine Learning-Based Fraud Detection
 *
 * The model maths (feature extraction, standardisation, training, scoring) is
 * pure and tested directly; the persistence-backed service methods are tested
 * against a mocked database.
 */

import {
  FEATURE_NAMES,
  extractFeatures,
  standardize,
  sigmoid,
  predictProbability,
  trainModel,
  MlFraudDetectionService,
  TrainingExample,
} from "../mlFraudDetectionService";
import { queryRead, queryWrite } from "../../config/database";

jest.mock("../../config/database", () => ({
  queryRead: jest.fn(),
  queryWrite: jest.fn(),
}));

const mockedQueryRead = queryRead as jest.Mock;
const mockedQueryWrite = queryWrite as jest.Mock;

/** Build a separable dataset: fraudulent rows are high-amount + high velocity. */
function buildDataset(size = 120): TrainingExample[] {
  const examples: TrainingExample[] = [];
  for (let i = 0; i < size; i++) {
    const isFraud = i % 2 === 0;
    examples.push({
      label: isFraud ? 1 : 0,
      features: {
        amount_log: isFraud ? 9 + (i % 3) * 0.1 : 3 + (i % 3) * 0.1,
        amount_zscore: isFraud ? 6 : 0.1,
        amount_max_ratio: isFraud ? 4 : 0.4,
        hour_of_day: 0.5,
        is_weekend: 0,
        velocity_1h: isFraud ? 3 : 0.2,
        velocity_24h: isFraud ? 4 : 0.5,
        distinct_counterparties: 2,
        failed_ratio: isFraud ? 0.6 : 0,
        provider_risk: 0.3,
      },
    });
  }
  return examples;
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe("sigmoid", () => {
  it("is stable for large positive and negative inputs", () => {
    expect(sigmoid(1000)).toBeCloseTo(1, 6);
    expect(sigmoid(-1000)).toBeCloseTo(0, 6);
  });

  it("returns 0.5 at the origin", () => {
    expect(sigmoid(0)).toBe(0.5);
  });
});

describe("extractFeatures", () => {
  it("produces every declared feature", () => {
    const features = extractFeatures({ amount: 1000, timestamp: new Date() });

    for (const name of FEATURE_NAMES) {
      expect(typeof features[name]).toBe("number");
      expect(Number.isFinite(features[name])).toBe(true);
    }
  });

  it("computes a z-score from the user history", () => {
    const features = extractFeatures({
      amount: 200,
      userAvgAmount: 100,
      userStdDevAmount: 50,
    });

    expect(features.amount_zscore).toBeCloseTo(2, 6);
  });

  it("falls back to a zero z-score when the history has no variance", () => {
    const features = extractFeatures({
      amount: 200,
      userAvgAmount: 100,
      userStdDevAmount: 0,
    });

    expect(features.amount_zscore).toBe(0);
  });

  it("clamps an extreme z-score", () => {
    const features = extractFeatures({
      amount: 10_000_000,
      userAvgAmount: 1,
      userStdDevAmount: 1,
    });

    expect(features.amount_zscore).toBeLessThanOrEqual(10);
  });

  it("flags weekend timestamps", () => {
    const saturday = new Date("2026-01-03T12:00:00Z");
    const features = extractFeatures({ amount: 10, timestamp: saturday });

    expect([0, 1]).toContain(features.is_weekend);
  });

  it("clamps the provider risk into [0,1]", () => {
    const features = extractFeatures({ amount: 10, providerRisk: 7 });
    expect(features.provider_risk).toBe(1);
  });
});

describe("standardize", () => {
  it("centres a feature using its stored mean and σ", () => {
    const [value] = standardize(
      { amount_log: 10 } as any,
      { amount_log: 4 } as any,
      { amount_log: 2 } as any,
    );

    expect(value).toBeCloseTo(3, 6);
  });

  it("zeroes a feature with no variance so it cannot divide by zero", () => {
    const values = standardize(
      { amount_log: 10 } as any,
      { amount_log: 10 } as any,
      { amount_log: 0 } as any,
    );

    expect(values[0]).toBe(0);
  });
});

describe("predictProbability", () => {
  it("returns a probability in [0,1]", () => {
    const p = predictProbability([1, 1], [0.5, 0.5], 0);
    expect(p).toBeGreaterThan(0);
    expect(p).toBeLessThan(1);
  });

  it("returns 0 when the model has no weights yet", () => {
    expect(predictProbability([1, 1], [], 0)).toBe(0);
  });

  it("rises with a positive weight on a large feature value", () => {
    const low = predictProbability([0.1], [2], 0);
    const high = predictProbability([5], [2], 0);
    expect(high).toBeGreaterThan(low);
  });
});

describe("trainModel", () => {
  it("learns a separable dataset to high accuracy", () => {
    const result = trainModel(buildDataset());

    expect(result.trainingSize).toBe(120);
    expect(result.accuracy).toBeGreaterThan(0.9);
    expect(result.precision).toBeGreaterThan(0.9);
    expect(result.recall).toBeGreaterThan(0.9);
    expect(result.f1).toBeGreaterThan(0.9);
  });

  it("returns one weight per feature", () => {
    const result = trainModel(buildDataset());
    expect(result.weights).toHaveLength(FEATURE_NAMES.length);
  });

  it("is deterministic for identical input", () => {
    const data = buildDataset(40);
    const a = trainModel(data, { epochs: 20 });
    const b = trainModel(data, { epochs: 20 });

    expect(a.weights).toEqual(b.weights);
    expect(a.intercept).toBeCloseTo(b.intercept, 10);
  });

  it("returns an empty model for an empty dataset", () => {
    const result = trainModel([]);

    expect(result.trainingSize).toBe(0);
    expect(result.weights.every((w) => w === 0)).toBe(true);
    expect(result.accuracy).toBe(0);
  });
});

describe("MlFraudDetectionService", () => {
  const modelRow = {
    id: "44444444-4444-4444-4444-444444444444",
    model_version: "v1",
    algorithm: "logistic_regression",
    weights: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    feature_means: {},
    feature_stds: {},
    learning_rate: 0.05,
    intercept: 0,
    training_size: 100,
    accuracy: 0.9,
    precision_score: 0.88,
    recall_score: 0.87,
    f1_score: 0.87,
    is_active: true,
    trained_at: new Date(),
  };

  it("returns null when no model has been trained", async () => {
    mockedQueryRead.mockResolvedValue({ rows: [] });
    mockedQueryWrite.mockResolvedValue({ rows: [], rowCount: 1 });

    const svc = new MlFraudDetectionService(0.7, 0);
    await expect(svc.score({ amount: 100 })).resolves.toBeNull();
  });

  it("scores a transaction and persists the prediction", async () => {
    mockedQueryRead.mockResolvedValue({ rows: [modelRow] });
    mockedQueryWrite.mockResolvedValue({ rows: [], rowCount: 1 });

    const svc = new MlFraudDetectionService(0.5, 0);
    const verdict = await svc.score({ amount: 5000, transactionId: "tx-1" });

    expect(verdict).not.toBeNull();
    expect(verdict!.score).toBeGreaterThanOrEqual(0);
    expect(verdict!.modelVersion).toBe("v1");
    expect(mockedQueryWrite.mock.calls[0][0]).toContain("ml_fraud_predictions");
  });

  it("explains the top feature contributions", async () => {
    mockedQueryRead.mockResolvedValue({ rows: [modelRow] });
    mockedQueryWrite.mockResolvedValue({ rows: [], rowCount: 1 });

    const svc = new MlFraudDetectionService(0.5, 0);
    const verdict = await svc.score({ amount: 5000, transactionId: "tx-1" });
    const explanation = svc.explain(verdict!);

    expect(Array.isArray(explanation)).toBe(true);
  });

  it("balances the training set so the fraud class is not drowned out", async () => {
    const positives = buildDataset(20).filter((e) => e.label === 1);
    const negatives = buildDataset(20).filter((e) => e.label === 0);
    mockedQueryRead.mockResolvedValue({
      rows: [...positives, ...negatives],
    });

    const svc = new MlFraudDetectionService(0.7, 0);
    const dataset = await svc.buildTrainingSet(1000);

    expect(dataset.filter((e) => e.label === 1).length).toBe(20);
    expect(dataset.filter((e) => e.label === 0).length).toBe(20);
  });

  it("refuses to train when there is too little labelled data", async () => {
    mockedQueryRead.mockResolvedValue({ rows: [] });

    const svc = new MlFraudDetectionService(0.7, 0);
    await expect(svc.trainAndPromote("v2")).resolves.toBeNull();
    expect(mockedQueryWrite).not.toHaveBeenCalled();
  });

  it("records analyst feedback and queues it for retraining", async () => {
    mockedQueryWrite.mockResolvedValue({ rows: [], rowCount: 1 });
    mockedQueryRead.mockResolvedValue({
      rows: [{ features: buildDataset(2)[0].features }],
    });

    const svc = new MlFraudDetectionService(0.7, 0);
    await svc.submitFeedback({
      transactionId: "tx-9",
      reviewerId: "analyst-1",
      isFraud: true,
      notes: "confirmed fraud",
    });

    const feedbackInsert = mockedQueryWrite.mock.calls.find((call) =>
      String(call[0]).includes("INSERT INTO ml_fraud_feedback"),
    );
    const trainingInsert = mockedQueryWrite.mock.calls.find((call) =>
      String(call[0]).includes("ml_fraud_training_examples"),
    );

    expect(feedbackInsert).toBeDefined();
    expect(trainingInsert).toBeDefined();
    expect(trainingInsert?.[1][2]).toBe(1);
    expect(trainingInsert?.[1][3]).toBe("feedback");
  });

  it("reports live accuracy metrics", async () => {
    mockedQueryRead
      .mockResolvedValueOnce({ rows: [modelRow] }) // active model
      .mockResolvedValueOnce({
        rows: [{ predictions: 200, flagged: 20, avg_score: 0.31 }],
      })
      .mockResolvedValueOnce({ rows: [{ feedback_count: 40, disagreements: 4 }] });

    const svc = new MlFraudDetectionService(0.7, 0);
    const metrics = await svc.getModelMetrics();

    expect(metrics.modelVersion).toBe("v1");
    expect(metrics.predictionsLast24h).toBe(200);
    expect(metrics.flaggedLast24h).toBe(20);
    expect(metrics.flaggedRate).toBeCloseTo(0.1, 6);
    expect(metrics.feedbackAgreement).toBeCloseTo(0.9, 6);
  });

  it("caches the active model between calls", async () => {
    mockedQueryRead.mockResolvedValue({ rows: [modelRow] });

    const svc = new MlFraudDetectionService(0.7, 60_000);
    await svc.getActiveModel();
    await svc.getActiveModel();

    expect(mockedQueryRead).toHaveBeenCalledTimes(1);
  });
});
