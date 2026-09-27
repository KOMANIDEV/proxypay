-- Rollback: 20260825_create_transaction_classifier_tables
-- Inverted from 20260825_create_transaction_classifier_tables.sql; hand-verified against the up migration.

DROP TABLE IF EXISTS transaction_classifier_models;
DROP TABLE IF EXISTS transaction_classifier_feedback;
DROP TABLE IF EXISTS transaction_classifier_training;
DROP INDEX IF EXISTS idx_classifier_training_label;
DROP INDEX IF EXISTS idx_classifier_training_created;
DROP INDEX IF EXISTS idx_classifier_feedback_tx;
