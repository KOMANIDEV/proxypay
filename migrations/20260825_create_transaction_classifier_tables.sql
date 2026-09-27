-- Migration: 20260825_create_transaction_classifier_tables
-- Description: Storage for the ML transaction type classifier:
--              - labelled training data collected from real transactions
--              - human feedback corrections (the training improvement loop)
--              - persisted model snapshots (weights + priors per version)

CREATE TABLE IF NOT EXISTS transaction_classifier_training (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    transaction_id VARCHAR(255),
    features       JSONB NOT NULL,
    label          VARCHAR(50) NOT NULL,
    source         VARCHAR(20) NOT NULL DEFAULT 'auto'
                   CHECK (source IN ('auto', 'human')),
    confidence     REAL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_classifier_training_label
    ON transaction_classifier_training (label);

CREATE INDEX IF NOT EXISTS idx_classifier_training_created
    ON transaction_classifier_training (created_at DESC);

CREATE TABLE IF NOT EXISTS transaction_classifier_feedback (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    transaction_id   VARCHAR(255) NOT NULL,
    predicted_label  VARCHAR(50) NOT NULL,
    corrected_label  VARCHAR(50) NOT NULL,
    user_id          VARCHAR(255),
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_classifier_feedback_tx
    ON transaction_classifier_feedback (transaction_id);

CREATE TABLE IF NOT EXISTS transaction_classifier_models (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    version      INTEGER NOT NULL,
    weights      JSONB NOT NULL,
    priors       JSONB NOT NULL,
    trained_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    sample_count INTEGER NOT NULL DEFAULT 0
);
