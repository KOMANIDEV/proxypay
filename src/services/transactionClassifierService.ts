/**
 * Transaction Type Classifier (ML)
 *
 * Automatically categorises transactions so reporting doesn't depend on
 * manual assignment. The model is a multinomial Naive Bayes classifier
 * with Laplace smoothing, trained on features extracted from real
 * transactions (notes, provider, amount bands, direction keywords).
 *
 * Pipeline:
 *   1. `classifyTransaction(input)`   – extract features, score each
 *      category, return the best category with a calibrated confidence.
 *   2. `recordTrainingExample(...)`   – collect labelled samples from real
 *      transactions (the training data collection pipeline).
 *   3. `submitHumanFeedback(...)`     – when a user corrects a predicted
 *      category, the correction is stored and folded into the model
 *      immediately (online learning) – the human feedback loop.
 *   4. `trainModel()`                 – batch retrain from all stored
 *      samples, producing a new persisted model version.
 *   5. `getClassificationAccuracy()`  – evaluate the current model on
 *      human-labelled samples and export the result to Prometheus
 *      (classification accuracy monitoring).
 *
 * The TypeScript service is framework-agnostic; the Python ML pipeline can
 * consume the same training table and export weights in the same JSONB
 * shape for heavier model variants.
 */

import { pool } from "../config/database";
import logger from "../utils/logger";
import {
  transactionClassificationsTotal,
  transactionClassificationConfidence,
  transactionClassifierAccuracy,
  transactionClassifierFeedbackTotal,
  transactionClassifierTrainingSamples,
} from "../utils/metrics";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export const TRANSACTION_CATEGORIES = [
  "deposit",
  "withdraw",
  "payment",
  "payout",
  "refund",
  "fee",
] as const;

export type TransactionCategory = (typeof TRANSACTION_CATEGORIES)[number];

export interface ClassifierInput {
  notes?: string | null;
  provider?: string | null;
  amount?: number | string | null;
  phoneNumber?: string | null;
  existingType?: string | null;
}

export interface ClassificationResult {
  category: TransactionCategory;
  /** 0..1 – probability mass of the winning category. */
  confidence: number;
  /** Normalised posterior probability per category. */
  probabilities: Record<string, number>;
  modelVersion: number;
}

export interface TrainingExample {
  transactionId?: string;
  label: TransactionCategory;
  features: Record<string, number>;
  source: "auto" | "human";
  confidence?: number;
}

export interface HumanFeedbackInput {
  transactionId: string;
  predictedCategory: TransactionCategory;
  correctedCategory: TransactionCategory;
  userId?: string;
  features: Record<string, number>;
}

export interface AccuracyReport {
  accuracy: number;
  correct: number;
  total: number;
  evaluatedAt: string;
  perCategory: Record<string, { correct: number; total: number }>;
}

interface ModelWeights {
  /** class → feature → smoothed log-probability contribution */
  probabilities: Record<string, Record<string, number>>;
  priors: Record<string, number>;
  vocabulary: string[];
}

// ---------------------------------------------------------------------------
// Seeded prior knowledge (used before any training data exists)
// ---------------------------------------------------------------------------

const SEED_WEIGHTS: Record<string, Record<string, number>> = {
  withdraw: {
    withdraw: 6,
    withdrawal: 6,
    cashout: 5,
    cash: 3,
    send: 2,
    payout: 2,
    atm: 4,
    debit: 3,
  },
  deposit: {
    deposit: 6,
    receive: 4,
    received: 4,
    topup: 5,
    fund: 3,
    funding: 3,
    credit: 4,
    transfer_in: 2,
  },
  payment: {
    payment: 5,
    pay: 4,
    bill: 4,
    invoice: 4,
    purchase: 3,
    merchant: 3,
    subscription: 3,
  },
  payout: {
    payout: 5,
    salary: 5,
    wage: 4,
    disbursement: 4,
    commission: 3,
    bonus: 3,
  },
  refund: { refund: 6, reversal: 5, returned: 4, return: 3, chargeback: 5 },
  fee: {
    fee: 5,
    fees: 5,
    charge: 4,
    charges: 4,
    commission: 3,
    maintenance: 3,
    penalty: 4,
  },
};

const DEFAULT_PRIORS: Record<string, number> = {
  deposit: 0.3,
  withdraw: 0.3,
  payment: 0.2,
  payout: 0.1,
  refund: 0.05,
  fee: 0.05,
};

// ---------------------------------------------------------------------------
// Feature extraction
// ---------------------------------------------------------------------------

function toNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value.replace(/[^\d.-]/g, ""));
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * Extract a bag-of-words + structural feature vector from a transaction.
 * The same function is used at classification and training time so the
 * feature space stays consistent.
 */
export function extractFeatures(
  input: ClassifierInput,
): Record<string, number> {
  const features: Record<string, number> = {};
  const text = [input.notes, input.provider, input.existingType]
    .filter((v): v is string => !!v)
    .join(" ")
    .toLowerCase();

  const tokens = text.match(/[a-z][a-z0-9_]{1,}/g) ?? [];
  for (const token of tokens) {
    features[token] = (features[token] ?? 0) + 1;
  }

  // Amount band (one-hot).
  const amount = toNumber(input.amount);
  if (amount !== null) {
    if (amount < 1000) features.amountSmall = 1;
    else if (amount <= 100000) features.amountMedium = 1;
    else features.amountLarge = 1;
  }

  // Phone number presence.
  if (input.phoneNumber) features.hasPhone = 1;

  return features;
}

// ---------------------------------------------------------------------------
// Naive Bayes model
// ---------------------------------------------------------------------------

export class TransactionClassifier {
  private counts: Map<string, Map<string, number>> = new Map();
  private classTotals: Map<string, number> = new Map();
  private classSamples: Map<string, number> = new Map();
  private vocabulary = new Set<string>();
  /** Seed weights behave as pseudo-counts so untrained models still work. */
  private seeded = false;

  modelVersion = 1;

  constructor() {
    this.seedFromDefaults();
  }

  private seedFromDefaults(): void {
    for (const [category, weights] of Object.entries(SEED_WEIGHTS)) {
      const classCounts = this.counts.get(category) ?? new Map();
      let total = 0;
      for (const [feature, count] of Object.entries(weights)) {
        classCounts.set(feature, (classCounts.get(feature) ?? 0) + count);
        total += count;
        this.vocabulary.add(feature);
      }
      this.counts.set(category, classCounts);
      this.classTotals.set(
        category,
        (this.classTotals.get(category) ?? 0) + total,
      );
      this.classSamples.set(
        category,
        (this.classSamples.get(category) ?? 0) + 1,
      );
    }
    this.seeded = true;
  }

  /**
   * Fold a batch of labelled examples into the model counts. Used by the
   * training pipeline (and by online learning for single examples).
   */
  train(examples: TrainingExample[]): void {
    for (const example of examples) {
      this.fold(example);
    }
  }

  /**
   * Online learning: fold a single (usually human-corrected) example into
   * the counts immediately. This is the feedback loop that improves the
   * model without a full retrain.
   */
  updateOnline(example: TrainingExample): void {
    this.fold(example);
  }

  private fold(example: TrainingExample): void {
    const category = example.label;
    const classCounts = this.counts.get(category) ?? new Map();
    let total = 0;
    for (const [feature, count] of Object.entries(example.features)) {
      if (count <= 0) continue;
      classCounts.set(feature, (classCounts.get(feature) ?? 0) + count);
      total += count;
      this.vocabulary.add(feature);
    }
    this.counts.set(category, classCounts);
    this.classTotals.set(
      category,
      (this.classTotals.get(category) ?? 0) + total,
    );
    this.classSamples.set(category, (this.classSamples.get(category) ?? 0) + 1);
  }

  /**
   * Classify a feature vector. Returns the argmax category with its
   * normalised posterior probability (confidence).
   */
  classify(features: Record<string, number>): {
    category: TransactionCategory;
    confidence: number;
    probabilities: Record<string, number>;
  } {
    const vocabularySize = this.vocabulary.size + 1; // +1 for Laplace smoothing
    const totalSamples = [...this.classSamples.values()].reduce(
      (a, b) => a + b,
      0,
    );
    const categories = TRANSACTION_CATEGORIES as readonly string[];

    const logScores: Record<string, number> = {};
    for (const category of categories) {
      const classCount = this.classSamples.get(category) ?? 0;
      const prior = (classCount + 1) / (totalSamples + categories.length);
      const classTotals = this.classTotals.get(category) ?? 0;
      const classCounts = this.counts.get(category) ?? new Map();

      let logProb = Math.log(prior);
      for (const [feature, count] of Object.entries(features)) {
        if (count <= 0) continue;
        const featureCount = classCounts.get(feature) ?? 0;
        const smoothed = (featureCount + 1) / (classTotals + vocabularySize);
        logProb += count * Math.log(smoothed);
      }
      logScores[category] = logProb;
    }

    // Softmax to get normalised probabilities.
    const maxLog = Math.max(...Object.values(logScores));
    const expScores = Object.fromEntries(
      Object.entries(logScores).map(([category, score]) => [
        category,
        Math.exp(score - maxLog),
      ]),
    );
    const sum = Object.values(expScores).reduce((a, b) => a + b, 0);
    const probabilities = Object.fromEntries(
      Object.entries(expScores).map(([category, expScore]) => [
        category,
        expScore / sum,
      ]),
    );

    const best = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0];
    return {
      category: best[0] as TransactionCategory,
      confidence: best[1],
      probabilities,
    };
  }

  /** Serialise the model for persistence (weights + priors + vocabulary). */
  toModelWeights(): ModelWeights {
    const probabilities: Record<string, Record<string, number>> = {};
    const totalSamples = [...this.classSamples.values()].reduce(
      (a, b) => a + b,
      0,
    );
    const vocabularySize = this.vocabulary.size + 1;

    for (const category of TRANSACTION_CATEGORIES) {
      const classTotals = this.classTotals.get(category) ?? 0;
      const classCounts = this.counts.get(category) ?? new Map();
      probabilities[category] = {};
      for (const feature of this.vocabulary) {
        const featureCount = classCounts.get(feature) ?? 0;
        probabilities[category][feature] =
          (featureCount + 1) / (classTotals + vocabularySize);
      }
    }

    const priors: Record<string, number> = {};
    for (const category of TRANSACTION_CATEGORIES) {
      const classCount = this.classSamples.get(category) ?? 0;
      priors[category] =
        (classCount + 1) / (totalSamples + TRANSACTION_CATEGORIES.length);
    }

    return {
      probabilities,
      priors,
      vocabulary: [...this.vocabulary],
    };
  }

  /** Load weights produced by toModelWeights() (e.g. from a persisted model). */
  fromModelWeights(weights: ModelWeights): void {
    this.counts.clear();
    this.classTotals.clear();
    this.classSamples.clear();
    this.vocabulary = new Set(weights.vocabulary);

    for (const category of TRANSACTION_CATEGORIES) {
      const classProbs = weights.probabilities[category] ?? {};
      const classCounts = new Map<string, number>();
      let total = 0;
      for (const [feature, prob] of Object.entries(classProbs)) {
        // Invert Laplace smoothing to recover approximate counts.
        const vocabularySize = weights.vocabulary.length + 1;
        const approxCount = prob * (total + vocabularySize) - 1;
        classCounts.set(feature, Math.max(0, Math.round(approxCount)));
        total += approxCount;
      }
      this.counts.set(category, classCounts);
      this.classTotals.set(category, total);
      this.classSamples.set(category, 1);
    }

    // Restore sample distribution from priors where available.
    const totalSamples = Object.values(weights.priors).reduce(
      (a, b) => a + b,
      0,
    );
    if (totalSamples > 0) {
      for (const category of TRANSACTION_CATEGORIES) {
        const prior = weights.priors[category] ?? 0;
        this.classSamples.set(
          category,
          Math.max(1, Math.round(prior * totalSamples)),
        );
      }
    }
    this.seeded = true;
  }

  get isSeeded(): boolean {
    return this.seeded;
  }
}

// ---------------------------------------------------------------------------
// Shared classifier instance (lazy-loaded from the persisted model)
// ---------------------------------------------------------------------------

let sharedClassifier: TransactionClassifier | null = null;
let classifierLoadPromise: Promise<TransactionClassifier> | null = null;

async function getSharedClassifier(): Promise<TransactionClassifier> {
  if (sharedClassifier) return sharedClassifier;
  if (classifierLoadPromise) return classifierLoadPromise;

  classifierLoadPromise = (async () => {
    const classifier = new TransactionClassifier();
    try {
      const { rows } = await pool.query(
        `SELECT version, weights, priors
         FROM transaction_classifier_models
         ORDER BY version DESC
         LIMIT 1`,
      );
      if (rows[0]) {
        classifier.fromModelWeights({
          probabilities: rows[0].weights,
          priors: rows[0].priors,
          vocabulary: Object.keys(rows[0].weights ?? {}).length
            ? Object.keys(Object.values(rows[0].weights)[0] ?? {})
            : [],
        });
        classifier.modelVersion = Number(rows[0].version);
      }
    } catch {
      // No persisted model yet – the seeded classifier is used.
    }
    sharedClassifier = classifier;
    return classifier;
  })();

  return classifierLoadPromise;
}

/** Reset the shared classifier (used by tests). */
export function _resetSharedClassifierForTesting(): void {
  sharedClassifier = null;
  classifierLoadPromise = null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Classify a transaction and record monitoring metrics.
 */
export async function classifyTransaction(
  input: ClassifierInput,
): Promise<ClassificationResult> {
  const classifier = await getSharedClassifier();
  const features = extractFeatures(input);
  const { category, confidence, probabilities } = classifier.classify(features);

  transactionClassificationsTotal.labels(category).inc();
  transactionClassificationConfidence.observe(confidence);

  return {
    category,
    confidence,
    probabilities,
    modelVersion: classifier.modelVersion,
  };
}

/**
 * Training data collection pipeline: persist a labelled sample (from a real
 * transaction, or from a human correction) and fold it into the live model.
 */
export async function recordTrainingExample(
  example: TrainingExample,
): Promise<void> {
  await pool.query(
    `INSERT INTO transaction_classifier_training
       (transaction_id, features, label, source, confidence)
     VALUES ($1,$2,$3,$4,$5)`,
    [
      example.transactionId ?? null,
      JSON.stringify(example.features),
      example.label,
      example.source,
      example.confidence ?? null,
    ],
  );

  const classifier = await getSharedClassifier();
  classifier.updateOnline(example);

  await refreshTrainingSampleGauge();
}

/**
 * Human feedback loop: store the correction, add it to the training data
 * and update the live model so the next classification is already better.
 */
export async function submitHumanFeedback(
  input: HumanFeedbackInput,
): Promise<void> {
  await pool.query(
    `INSERT INTO transaction_classifier_feedback
       (transaction_id, predicted_label, corrected_label, user_id)
     VALUES ($1,$2,$3,$4)`,
    [
      input.transactionId,
      input.predictedCategory,
      input.correctedCategory,
      input.userId ?? null,
    ],
  );

  transactionClassifierFeedbackTotal.labels(input.correctedCategory).inc();

  await recordTrainingExample({
    transactionId: input.transactionId,
    label: input.correctedCategory,
    features: input.features,
    source: "human",
  });
}

/**
 * Batch retrain from all stored samples and persist a new model version.
 * Returns the new model version number.
 */
export async function trainModel(): Promise<number> {
  const { rows } = await pool.query(
    `SELECT features, label
     FROM transaction_classifier_training
     ORDER BY created_at ASC`,
  );

  const classifier = new TransactionClassifier();
  classifier.train(
    rows.map((row: any) => ({
      label: row.label as TransactionCategory,
      features: row.features,
      source: "auto" as const,
    })),
  );

  const weights = classifier.toModelWeights();
  const { rows: inserted } = await pool.query(
    `INSERT INTO transaction_classifier_models (version, weights, priors, sample_count)
     VALUES ($1,$2,$3,$4)
     RETURNING version`,
    [
      classifier.modelVersion + 1,
      JSON.stringify(weights.probabilities),
      JSON.stringify(weights.priors),
      rows.length,
    ],
  );

  const newVersion = Number(inserted[0].version);
  classifier.modelVersion = newVersion;
  sharedClassifier = classifier;
  classifierLoadPromise = null;

  await refreshTrainingSampleGauge();
  return newVersion;
}

/**
 * Accuracy monitoring: evaluate the current model against human-labelled
 * samples and publish the result to Prometheus.
 */
export async function getClassificationAccuracy(
  sampleLimit = 200,
): Promise<AccuracyReport> {
  const classifier = await getSharedClassifier();
  const { rows } = await pool.query(
    `SELECT features, label
     FROM transaction_classifier_training
     WHERE source = 'human'
     ORDER BY created_at DESC
     LIMIT $1`,
    [sampleLimit],
  );

  const perCategory: Record<string, { correct: number; total: number }> = {};
  let correct = 0;
  for (const row of rows as any[]) {
    const predicted = classifier.classify(row.features).category;
    const actual = row.label as TransactionCategory;
    const bucket = perCategory[actual] ?? { correct: 0, total: 0 };
    bucket.total += 1;
    if (predicted === actual) {
      bucket.correct += 1;
      correct += 1;
    }
    perCategory[actual] = bucket;
  }

  const total = rows.length;
  const accuracy = total > 0 ? correct / total : 0;
  transactionClassifierAccuracy.set(accuracy);

  return {
    accuracy: Math.round(accuracy * 1000) / 1000,
    correct,
    total,
    evaluatedAt: new Date().toISOString(),
    perCategory,
  };
}

/** Report basic model statistics for dashboards / debugging. */
export async function getClassifierStats(): Promise<{
  modelVersion: number;
  trainingSamples: number;
  feedbackCount: number;
  categories: readonly TransactionCategory[];
}> {
  const classifier = await getSharedClassifier();
  const [trainingRes, feedbackRes] = await Promise.all([
    pool.query(
      `SELECT COUNT(*)::int AS total FROM transaction_classifier_training`,
    ),
    pool.query(
      `SELECT COUNT(*)::int AS total FROM transaction_classifier_feedback`,
    ),
  ]);

  return {
    modelVersion: classifier.modelVersion,
    trainingSamples: Number(trainingRes.rows[0]?.total ?? 0),
    feedbackCount: Number(feedbackRes.rows[0]?.total ?? 0),
    categories: TRANSACTION_CATEGORIES,
  };
}

async function refreshTrainingSampleGauge(): Promise<void> {
  try {
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS total FROM transaction_classifier_training`,
    );
    transactionClassifierTrainingSamples.set(Number(rows[0]?.total ?? 0));
  } catch {
    logger.warn("[classifier] Failed to refresh training sample gauge");
  }
}

// Default priors are exported for downstream consumers of the model format.
export { DEFAULT_PRIORS };
