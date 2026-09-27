-- Rollback: 20260904_ml_fraud_detection
-- Drops the ML fraud detection tables in reverse dependency order.

DROP INDEX IF EXISTS idx_ml_fraud_feedback_recent;
DROP TABLE IF EXISTS ml_fraud_feedback;

DROP INDEX IF EXISTS idx_ml_fraud_predictions_transaction;
DROP INDEX IF EXISTS idx_ml_fraud_predictions_created;
DROP TABLE IF EXISTS ml_fraud_predictions;

DROP INDEX IF EXISTS idx_ml_fraud_training_label;
DROP TABLE IF EXISTS ml_fraud_training_examples;

DROP INDEX IF EXISTS idx_ml_fraud_models_single_active;
DROP TABLE IF EXISTS ml_fraud_models;
