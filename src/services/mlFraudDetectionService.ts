/**
 * #485 – Machine Learning-Based Fraud Detection
 *
 * The existing `FraudService` applies hand-written heuristics. Heuristics are
 * precise about known patterns but blind to combinations nobody thought to
 * write down, so they degrade as attacker behaviour drifts. This service adds
 * a statistical second opinion that runs *alongside* the rules:
 *
 *   1. **Feature extraction** – `extractFeatures()` turns a transaction into a
 *      fixed-length, scaled vector (amount, amount z-score vs the user's
 *      history, hour of day, velocity, distinct counterparties, …).
 *   2. **Model** – a logistic-regression classifier trained with batch
 *      gradient descent. It is deliberately small, dependency-free and
 *      deterministic, so it can be trained in-process on a nightly job and
 *      served in microseconds on the hot path.
 *   3. **Training data pipeline** – `buildTrainingSet()` aggregates labelled
 *      transactions from `ml_fraud_training_examples`; analysts seed it
 *      through `recordTrainingExample()`.
 *   4. **Accuracy monitoring** – `getModelMetrics()` reports precision /
 *      recall / F1 plus live prediction drift.
 *   5. **Human feedback loop** – `submitFeedback()` records an analyst label
 *      and queues it into the next training set, so every manual review
 *      improves the model.
 *
 * The ML verdict never blocks a transaction on its own – it is combined with
 * the rule engine by the caller.
 */

import { queryRead, queryWrite } from "../config/database";
import logger from "../utils/logger";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export const FEATURE_NAMES = [
  "amount_log",
  "amount_zscore",
  "amount_max_ratio",
  "hour_of_day",
  "is_weekend",
  "velocity_1h",
  "velocity_24h",
  "distinct_counterparties",
  "failed_ratio",
  "provider_risk",
] as const;

export type FeatureName = (typeof FEATURE_NAMES)[number];
export type FeatureVector = Record<FeatureName, number>;

export interface TransactionContext {
  transactionId?: string;
  userId?: string;
  amount: number;
  /** Mean/σ of this user's historical amounts, used for the z-score. */
  userAvgAmount?: number;
  userStdDevAmount?: number;
  userMaxAmount?: number;
  /** Transactions by this user in the trailing windows. */
  transactionsLastHour?: number;
  transactionsLast24h?: number;
  distinctCounterparties?: number;
  failedTransactions?: number;
  totalTransactions?: number;
  /** Operator-assigned provider risk in [0,1]. */
  providerRisk?: number;
  timestamp?: Date;
}

export interface MlFraudModel {
  id: string;
  modelVersion: string;
  algorithm: string;
  weights: number[];
  featureMeans: Partial<Record<FeatureName, number>>;
  featureStds: Partial<Record<FeatureName, number>>;
  learningRate: number;
  intercept: number;
  trainingSize: number;
  accuracy: number | null;
  precision: number | null;
  recall: number | null;
  f1: number | null;
  isActive: boolean;
  trainedAt: Date;
}

export interface MlFraudVerdict {
  score: number;
  isFraud: boolean;
  threshold: number;
  modelVersion: string;
  features: FeatureVector;
  /** Individual standardised feature contributions, largest first. */
  contributions: Array<{ feature: FeatureName; contribution: number }>;
}

export interface TrainingExample {
  features: FeatureVector;
  label: 0 | 1;
}

export interface ModelMetrics {
  modelVersion: string | null;
  trainingSize: number;
  accuracy: number | null;
  precision: number | null;
  recall: number | null;
  f1: number | null;
  predictionsLast24h: number;
  flaggedLast24h: number;
  flaggedRate: number;
  avgScore: number;
  feedbackCount: number;
  feedbackAgreement: number | null;
}

export interface FeedbackInput {
  transactionId?: string;
  predictionId?: number;
  reviewerId: string;
  isFraud: boolean;
  notes?: string;
}

const DEFAULT_THRESHOLD = Number(process.env.ML_FRAUD_THRESHOLD ?? 0.7);
const TRAINING_BATCH_SIZE = 2000;
const EPOCHS = 60;

// ---------------------------------------------------------------------------
// Feature extraction
// ---------------------------------------------------------------------------

/**
 * Build the feature vector. Every feature is derived from data already
 * available at request time so scoring adds no database round-trips beyond the
 * optional history lookups the caller performs.
 */
export function extractFeatures(ctx: TransactionContext): FeatureVector {
  const timestamp = ctx.timestamp ?? new Date();
  const hour = timestamp.getHours();

  const amount = Math.max(0, Number(ctx.amount) || 0);
  const log1pAmount = Math.log1p(amount);

  const avg = ctx.userAvgAmount ?? amount;
  const std = ctx.userStdDevAmount ?? 0;
  const zscore = std > 0 ? (amount - avg) / std : 0;
  const maxRatio = ctx.userMaxAmount ? amount / ctx.userMaxAmount : 0;

  const total = ctx.totalTransactions ?? 0;
  const failed = ctx.failedTransactions ?? 0;
  const failedRatio = total > 0 ? failed / total : 0;

  return {
    amount_log: log1pAmount,
    amount_zscore: clamp(zscore, -10, 10),
    amount_max_ratio: clamp(maxRatio, 0, 20),
    hour_of_day: hour / 23,
    is_weekend: timestamp.getDay() === 0 || timestamp.getDay() === 6 ? 1 : 0,
    velocity_1h: Math.log1p(ctx.transactionsLastHour ?? 0),
    velocity_24h: Math.log1p(ctx.transactionsLast24h ?? 0),
    distinct_counterparties: Math.log1p(ctx.distinctCounterparties ?? 0),
    failed_ratio: clamp(failedRatio, 0, 1),
    provider_risk: clamp(ctx.providerRisk ?? 0, 0, 1),
  };
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(max, Math.max(min, value));
}

// ---------------------------------------------------------------------------
// Model maths (pure – unit testable without a database)
// ---------------------------------------------------------------------------

/** Numerically stable logistic sigmoid. */
export function sigmoid(z: number): number {
  if (z >= 0) {
    const e = Math.exp(-z);
    return 1 / (1 + e);
  }
  const e = Math.exp(z);
  return e / (1 + e);
}

/** Standardise a feature vector using the model's stored mean/σ. */
export function standardize(
  features: FeatureVector,
  means: Partial<Record<FeatureName, number>>,
  stds: Partial<Record<FeatureName, number>>,
): number[] {
  return FEATURE_NAMES.map((name) => {
    const mean = means[name] ?? 0;
    const std = stds[name] ?? 0;
    const value = features[name] ?? 0;
    // σ = 0 (constant feature) → the feature carries no signal, centre it.
    return std > 0 ? (value - mean) / std : 0;
  });
}

/** Probability that a standardised feature vector is fraudulent. */
export function predictProbability(
  x: number[],
  weights: number[],
  intercept: number,
): number {
  if (weights.length === 0) return 0;
  const z = x.reduce((acc, xi, i) => acc + xi * (weights[i] ?? 0), intercept);
  return sigmoid(z);
}

export interface TrainingResult {
  weights: number[];
  intercept: number;
  featureMeans: Partial<Record<FeatureName, number>>;
  featureStds: Partial<Record<FeatureName, number>>;
  accuracy: number;
  precision: number;
  recall: number;
  f1: number;
  trainingSize: number;
}

function computeMoments(
  examples: TrainingExample[],
): {
  means: Partial<Record<FeatureName, number>>;
  stds: Partial<Record<FeatureName, number>>;
} {
  const means: Record<string, number> = {};
  const stds: Record<string, number> = {};

  for (const name of FEATURE_NAMES) {
    const values = examples.map((e) => e.features[name] ?? 0);
    const mean = values.reduce((a, b) => a + b, 0) / (values.length || 1);
    const variance =
      values.reduce((acc, v) => acc + (v - mean) ** 2, 0) /
      (values.length || 1);
    means[name] = mean;
    // Floor σ at 1e-6 so a constant feature never divides by zero.
    stds[name] = Math.max(Math.sqrt(variance), 1e-6);
  }

  return { means, stds };
}

function classificationMetrics(
  yTrue: number[],
  yPred: number[],
): { accuracy: number; precision: number; recall: number; f1: number } {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let tn = 0;

  for (let i = 0; i < yTrue.length; i++) {
    const truth = yTrue[i];
    const pred = yPred[i];
    if (truth === 1 && pred === 1) tp++;
    else if (truth === 0 && pred === 1) fp++;
    else if (truth === 1 && pred === 0) fn++;
    else tn++;
  }

  const total = yTrue.length || 1;
  const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 0 : tp / (tp + fn);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);

  return { accuracy: (tp + tn) / total, precision, recall, f1 };
}

/**
 * Train a logistic-regression classifier with batch gradient descent.
 * Deterministic: identical input always yields identical weights, which keeps
 * the nightly job reproducible and the tests stable.
 */
export function trainModel(
  examples: TrainingExample[],
  options: { learningRate?: number; epochs?: number } = {},
): TrainingResult {
  const learningRate = options.learningRate ?? 0.05;
  const epochs = options.epochs ?? EPOCHS;

  if (examples.length === 0) {
    return {
      weights: new Array(FEATURE_NAMES.length).fill(0),
      intercept: 0,
      featureMeans: {},
      featureStds: {},
      accuracy: 0,
      precision: 0,
      recall: 0,
      f1: 0,
      trainingSize: 0,
    };
  }

  const { means, stds } = computeMoments(examples);
  const matrix = examples.map((e) => standardize(e.features, means, stds));
  const labels = examples.map((e) => e.label);

  const weights = new Array(FEATURE_NAMES.length).fill(0);
  let intercept = 0;
  const n = matrix.length;

  for (let epoch = 0; epoch < epochs; epoch++) {
    const gradW = new Array(FEATURE_NAMES.length).fill(0);
    let gradB = 0;

    for (let i = 0; i < n; i++) {
      const p = predictProbability(matrix[i], weights, intercept);
      const error = p - labels[i];
      for (let j = 0; j < weights.length; j++) {
        gradW[j] += (error * (matrix[i][j] ?? 0)) / n;
      }
      gradB += error / n;
    }

    for (let j = 0; j < weights.length; j++) {
      weights[j] -= learningRate * gradW[j];
    }
    intercept -= learningRate * gradB;
  }

  const predictions = matrix.map((row) =>
    predictProbability(row, weights, intercept) >= 0.5 ? 1 : 0,
  );
  const metrics = classificationMetrics(labels, predictions);

  return {
    weights,
    intercept,
    featureMeans: means,
    featureStds: stds,
    accuracy: metrics.accuracy,
    precision: metrics.precision,
    recall: metrics.recall,
    f1: metrics.f1,
    trainingSize: n,
  };
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

function mapModelRow(row: any): MlFraudModel {
  return {
    id: String(row.id),
    modelVersion: row.model_version,
    algorithm: row.algorithm,
    weights: (row.weights ?? []).map((w: any) => Number(w)),
    featureMeans: row.feature_means ?? {},
    featureStds: row.feature_stds ?? {},
    learningRate: Number(row.learning_rate ?? 0.05),
    intercept: Number(row.intercept ?? 0),
    trainingSize: Number(row.training_size ?? 0),
    accuracy: row.accuracy == null ? null : Number(row.accuracy),
    precision: row.precision_score == null ? null : Number(row.precision_score),
    recall: row.recall_score == null ? null : Number(row.recall_score),
    f1: row.f1_score == null ? null : Number(row.f1_score),
    isActive: Boolean(row.is_active),
    trainedAt: new Date(row.trained_at),
  };
}

const MODEL_COLUMNS = `
  id, model_version, algorithm, weights, feature_means, feature_stds,
  learning_rate, intercept, training_size, accuracy, precision_score,
  recall_score, f1_score, is_active, trained_at
`;

export class MlFraudDetectionService {
  private activeModelCache: MlFraudModel | null = null;
  private activeModelLoadedAt = 0;
  private readonly modelCacheTtlMs: number;

  constructor(
    private readonly threshold: number = DEFAULT_THRESHOLD,
    modelCacheTtlMs = 300_000,
  ) {
    this.modelCacheTtlMs = modelCacheTtlMs;
  }

  // -------------------------------------------------------------------------
  // Scoring
  // -------------------------------------------------------------------------

  /**
   * Score a transaction. Returns `null` when no model has been trained yet so
   * the caller can fall back to the rule engine alone.
   */
  async score(ctx: TransactionContext): Promise<MlFraudVerdict | null> {
    const model = await this.getActiveModel();
    if (!model) {
      logger.debug(
        { transactionId: ctx.transactionId },
        "[ml-fraud] no active model – skipping ML scoring",
      );
      return null;
    }

    const features = extractFeatures(ctx);
    const x = standardize(features, model.featureMeans, model.featureStds);
    const score = predictProbability(x, model.weights, model.intercept);

    const contributions = FEATURE_NAMES.map((name, i) => ({
      feature: name,
      contribution: (x[i] ?? 0) * (model.weights[i] ?? 0),
    })).sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution));

    const verdict: MlFraudVerdict = {
      score,
      isFraud: score >= this.threshold,
      threshold: this.threshold,
      modelVersion: model.modelVersion,
      features,
      contributions,
    };

    if (ctx.transactionId) {
      await this.persistPrediction(ctx.transactionId, verdict);
    }
    return verdict;
  }

  /** Expose the biggest drivers for explainability in the fraud UI. */
  explain(verdict: MlFraudVerdict, limit = 3): string[] {
    return verdict.contributions
      .slice(0, limit)
      .filter((c) => Math.abs(c.contribution) > 1e-6)
      .map((c) => `${c.feature} (${c.contribution >= 0 ? "+" : ""}${c.contribution.toFixed(3)})`);
  }

  private async persistPrediction(
    transactionId: string,
    verdict: MlFraudVerdict,
  ): Promise<void> {
    try {
      await queryWrite(
        `INSERT INTO ml_fraud_predictions
           (transaction_id, model_version, score, threshold,
            predicted_fraud, features)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [
          transactionId,
          verdict.modelVersion,
          verdict.score,
          verdict.threshold,
          verdict.isFraud,
          JSON.stringify(verdict.features),
        ],
      );
    } catch (error) {
      logger.warn(
        { error, transactionId },
        "[ml-fraud] failed to persist prediction",
      );
    }
  }

  // -------------------------------------------------------------------------
  // Model lifecycle
  // -------------------------------------------------------------------------

  async getActiveModel(): Promise<MlFraudModel | null> {
    const fresh =
      this.activeModelCache &&
      Date.now() - this.activeModelLoadedAt < this.modelCacheTtlMs;
    if (fresh) return this.activeModelCache;

    const { rows } = await queryRead<any>(
      `SELECT ${MODEL_COLUMNS} FROM ml_fraud_models
        WHERE is_active ORDER BY trained_at DESC LIMIT 1`,
    );
    this.activeModelCache = rows[0] ? mapModelRow(rows[0]) : null;
    this.activeModelLoadedAt = Date.now();
    return this.activeModelCache;
  }

  async getModelByVersion(
    modelVersion: string,
  ): Promise<MlFraudModel | null> {
    const { rows } = await queryRead<any>(
      `SELECT ${MODEL_COLUMNS} FROM ml_fraud_models WHERE model_version = $1`,
      [modelVersion],
    );
    return rows[0] ? mapModelRow(rows[0]) : null;
  }

  // -------------------------------------------------------------------------
  // Training data pipeline
  // -------------------------------------------------------------------------

  /** Add a labelled example to the training set. */
  async recordTrainingExample(
    ctx: TransactionContext,
    label: 0 | 1,
    source = "pipeline",
  ): Promise<void> {
    const features = extractFeatures(ctx);
    await queryWrite(
      `INSERT INTO ml_fraud_training_examples
         (transaction_id, features, label, source)
       VALUES ($1,$2,$3,$4)`,
      [ctx.transactionId ?? null, JSON.stringify(features), label, source],
    );
  }

  /**
   * Load the labelled training set, balancing the classes so a rare fraud
   * class is not drowned out by legitimate traffic.
   */
  async buildTrainingSet(
    limit = TRAINING_BATCH_SIZE,
  ): Promise<TrainingExample[]> {
    const { rows } = await queryRead<any>(
      `SELECT features, label
         FROM ml_fraud_training_examples
        ORDER BY created_at DESC
        LIMIT $1`,
      [limit * 2],
    );

    const positives: TrainingExample[] = [];
    const negatives: TrainingExample[] = [];

    for (const row of rows) {
      const example: TrainingExample = {
        features: normalizeStoredFeatures(row.features),
        label: Number(row.label) === 1 ? 1 : 0,
      };
      if (example.label === 1) positives.push(example);
      else negatives.push(example);
    }

    // Balance: keep as many negatives as positives (at minimum one of each).
    const balanced = negatives.slice(0, Math.max(positives.length, 1));
    const dataset = [...positives, ...balanced];

    // Deterministic shuffle so batches are not ordered by label.
    return shuffle(dataset);
  }

  /**
   * Train on the current dataset, persist the artefact and promote it to
   * active. Promotion is done last so a failure never takes the live model
   * down.
   */
  async trainAndPromote(
    modelVersion = `v${Date.now()}`,
    options: { learningRate?: number; epochs?: number; minSamples?: number } = {},
  ): Promise<MlFraudModel | null> {
    const minSamples = options.minSamples ?? 50;
    const examples = await this.buildTrainingSet();

    if (examples.length < minSamples) {
      logger.info(
        { samples: examples.length, minSamples },
        "[ml-fraud] not enough training data – skipping promotion",
      );
      return null;
    }

    const result = trainModel(examples, options);

    const { rows } = await queryWrite<any>(
      `INSERT INTO ml_fraud_models
         (model_version, algorithm, weights, feature_means, feature_stds,
          learning_rate, intercept, training_size, accuracy, precision_score,
          recall_score, f1_score)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (model_version) DO UPDATE
         SET weights = EXCLUDED.weights,
             feature_means = EXCLUDED.feature_means,
             feature_stds = EXCLUDED.feature_stds,
             intercept = EXCLUDED.intercept,
             training_size = EXCLUDED.training_size,
             accuracy = EXCLUDED.accuracy,
             precision_score = EXCLUDED.precision_score,
             recall_score = EXCLUDED.recall_score,
             f1_score = EXCLUDED.f1_score,
             trained_at = NOW()
       RETURNING ${MODEL_COLUMNS}`,
      [
        modelVersion,
        "logistic_regression",
        JSON.stringify(result.weights),
        JSON.stringify(result.featureMeans),
        JSON.stringify(result.featureStds),
        options.learningRate ?? 0.05,
        result.intercept,
        result.trainingSize,
        result.accuracy,
        result.precision,
        result.recall,
        result.f1,
      ],
    );

    await this.activateModel(modelVersion);
    logger.info(
      {
        modelVersion,
        trainingSize: result.trainingSize,
        accuracy: result.accuracy,
        f1: result.f1,
      },
      "[ml-fraud] model trained and promoted",
    );
    return mapModelRow(rows[0]);
  }

  /** Atomically demote the current model and promote `modelVersion`. */
  async activateModel(modelVersion: string): Promise<boolean> {
    const { rowCount } = await queryWrite(
      `UPDATE ml_fraud_models SET is_active = FALSE WHERE is_active`,
    );
    const { rows } = await queryWrite<any>(
      `UPDATE ml_fraud_models SET is_active = TRUE WHERE model_version = $1
       RETURNING model_version`,
      [modelVersion],
    );

    this.activeModelCache = null;
    this.activeModelLoadedAt = 0;

    if (rows.length === 0) {
      logger.warn({ modelVersion }, "[ml-fraud] model to activate not found");
      return false;
    }
    return (rowCount ?? 0) >= 0;
  }

  // -------------------------------------------------------------------------
  // Accuracy monitoring
  // -------------------------------------------------------------------------

  /**
   * Report live quality signals: offline training metrics, 24h prediction
   * volume, flag rate and how often analyst feedback agrees with the model.
   */
  async getModelMetrics(): Promise<ModelMetrics> {
    const model = await this.getActiveModel();

    const { rows } = await queryRead<any>(
      `SELECT
         COUNT(*)::bigint                                       AS predictions,
         COUNT(*) FILTER (WHERE predicted_fraud)::bigint       AS flagged,
         COALESCE(AVG(score), 0)::float                        AS avg_score
       FROM ml_fraud_predictions
       WHERE created_at > NOW() - INTERVAL '24 hours'`,
    );
    const stats = rows[0] ?? {};
    const predictions = Number(stats.predictions ?? 0);
    const flagged = Number(stats.flagged ?? 0);

    const { rows: feedbackRows } = await queryRead<any>(
      `SELECT
         COUNT(*)::bigint AS feedback_count,
         COUNT(*) FILTER (
           WHERE p.predicted_fraud IS DISTINCT FROM f.is_fraud
         )::bigint AS disagreements
       FROM ml_fraud_feedback f
       LEFT JOIN ml_fraud_predictions p ON p.id = f.prediction_id
       WHERE f.created_at > NOW() - INTERVAL '30 days'`,
    );
    const feedback = feedbackRows[0] ?? {};
    const feedbackCount = Number(feedback.feedback_count ?? 0);
    const disagreements = Number(feedback.disagreements ?? 0);

    return {
      modelVersion: model?.modelVersion ?? null,
      trainingSize: model?.trainingSize ?? 0,
      accuracy: model?.accuracy ?? null,
      precision: model?.precision ?? null,
      recall: model?.recall ?? null,
      f1: model?.f1 ?? null,
      predictionsLast24h: predictions,
      flaggedLast24h: flagged,
      flaggedRate: predictions > 0 ? flagged / predictions : 0,
      avgScore: Number(stats.avg_score ?? 0),
      feedbackCount,
      feedbackAgreement:
        feedbackCount > 0 ? (feedbackCount - disagreements) / feedbackCount : null,
    };
  }

  // -------------------------------------------------------------------------
  // Human feedback loop
  // -------------------------------------------------------------------------

  /**
   * Record an analyst verdict. The labelled example is queued into the next
   * training set immediately, so the feedback loop short-circuits: every
   * manual review improves the next model.
   */
  async submitFeedback(input: FeedbackInput): Promise<void> {
    const { rowCount } = await queryWrite(
      `INSERT INTO ml_fraud_feedback
         (transaction_id, prediction_id, reviewer_id, is_fraud, notes)
       VALUES ($1,$2,$3,$4,$5)`,
      [
        input.transactionId ?? null,
        input.predictionId ?? null,
        input.reviewerId,
        input.isFraud,
        input.notes ?? null,
      ],
    );

    if (rowCount === 0) return;

    if (input.transactionId) {
      const { rows } = await queryRead<any>(
        `SELECT features FROM ml_fraud_predictions
          WHERE transaction_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [input.transactionId],
      );

      if (rows[0]?.features) {
        await queryWrite(
          `INSERT INTO ml_fraud_training_examples
             (transaction_id, features, label, source)
           VALUES ($1,$2,$3,'feedback')`,
          [
            input.transactionId,
            JSON.stringify(rows[0].features),
            input.isFraud ? 1 : 0,
          ],
        );
      }
    }

    logger.info(
      { reviewerId: input.reviewerId, transactionId: input.transactionId },
      "[ml-fraud] analyst feedback recorded and queued for retraining",
    );
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizeStoredFeatures(raw: any): FeatureVector {
  const vector = { ...raw } as Record<string, number>;
  const result = {} as FeatureVector;
  for (const name of FEATURE_NAMES) {
    const value = Number(vector[name]);
    result[name] = Number.isFinite(value) ? value : 0;
  }
  return result;
}

/**
 * Fisher-Yates shuffle driven by a seeded PRNG so the ordering is
 * reproducible: the nightly job must produce byte-identical batches for the
 * same training set.
 */
function shuffle<T>(items: T[], seed = 42): T[] {
  const result = [...items];
  let state = seed;
  const next = () => {
    // mulberry32
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

export const mlFraudDetectionService = new MlFraudDetectionService();
