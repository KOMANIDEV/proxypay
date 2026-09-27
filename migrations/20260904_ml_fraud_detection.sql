-- Migration: 20260904_ml_fraud_detection
-- Description: Persistence for the machine-learning fraud detector (#485).
--
-- The rule-based `FraudService` stays as the fast first line of defence; this
-- migration backs the statistical model that scores it:
--
--   * ml_fraud_models            – trained model artefacts (weights, scaler
--                                  statistics, accuracy) with an active flag
--                                  so a new model can be promoted atomically.
--   * ml_fraud_training_examples – the training data pipeline: feature
--                                  vectors labelled fraudulent/legitimate.
--   * ml_fraud_predictions        – per-transaction model output for drift
--                                  and accuracy monitoring.
--   * ml_fraud_feedback           – the human feedback loop: analyst labels
--                                  that correct the model.

CREATE TABLE IF NOT EXISTS ml_fraud_models (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    model_version    VARCHAR(40) NOT NULL,
    algorithm         VARCHAR(40) NOT NULL DEFAULT 'logistic_regression',
    weights           JSONB NOT NULL DEFAULT '[]'::jsonb,
    feature_means     JSONB NOT NULL DEFAULT '{}'::jsonb,
    feature_stds      JSONB NOT NULL DEFAULT '{}'::jsonb,
    learning_rate     DOUBLE PRECISION NOT NULL DEFAULT 0.05,
    intercept         DOUBLE PRECISION NOT NULL DEFAULT 0,
    training_size     INTEGER NOT NULL DEFAULT 0,
    accuracy          DOUBLE PRECISION,
    precision_score   DOUBLE PRECISION,
    recall_score      DOUBLE PRECISION,
    f1_score          DOUBLE PRECISION,
    is_active         BOOLEAN NOT NULL DEFAULT FALSE,
    trained_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (model_version)
);

-- At most one active model; enforced with a partial unique index so the
-- model can be promoted inside a transaction.
CREATE UNIQUE INDEX IF NOT EXISTS idx_ml_fraud_models_single_active
    ON ml_fraud_models (is_active)
    WHERE is_active;

CREATE TABLE IF NOT EXISTS ml_fraud_training_examples (
    id             BIGSERIAL PRIMARY KEY,
    transaction_id UUID,
    features       JSONB NOT NULL,
    label          SMALLINT NOT NULL,
    source         VARCHAR(30) NOT NULL DEFAULT 'pipeline',
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT ml_fraud_training_label_check CHECK (label IN (0, 1))
);

CREATE INDEX IF NOT EXISTS idx_ml_fraud_training_label
    ON ml_fraud_training_examples (label, created_at DESC);

CREATE TABLE IF NOT EXISTS ml_fraud_predictions (
    id             BIGSERIAL PRIMARY KEY,
    transaction_id UUID,
    model_version  VARCHAR(40) NOT NULL,
    score          DOUBLE PRECISION NOT NULL,
    threshold      DOUBLE PRECISION NOT NULL,
    predicted_fraud BOOLEAN NOT NULL,
    features       JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ml_fraud_predictions_created
    ON ml_fraud_predictions (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ml_fraud_predictions_transaction
    ON ml_fraud_predictions (transaction_id);

CREATE TABLE IF NOT EXISTS ml_fraud_feedback (
    id             BIGSERIAL PRIMARY KEY,
    transaction_id UUID,
    prediction_id  BIGINT REFERENCES ml_fraud_predictions (id) ON DELETE SET NULL,
    reviewer_id    VARCHAR(255) NOT NULL,
    is_fraud       BOOLEAN NOT NULL,
    notes          TEXT,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ml_fraud_feedback_recent
    ON ml_fraud_feedback (created_at DESC);
