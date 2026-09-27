-- Rollback: 20260908_compliance_training
-- Removes the compliance training curriculum, assignments, attempts and
-- issued certificates.
--
-- WARNING: this deletes issued certification records, which are compliance
-- evidence. Export `compliance_certifications` before running this in any
-- environment that has real training history.

DROP VIEW IF EXISTS v_compliance_certification_status;

DROP TRIGGER IF EXISTS compliance_assignments_updated_at ON compliance_training_assignments;
DROP TRIGGER IF EXISTS compliance_modules_updated_at ON compliance_training_modules;
DROP FUNCTION IF EXISTS update_compliance_training_updated_at();

DROP TABLE IF EXISTS compliance_certifications;
DROP TABLE IF EXISTS compliance_training_completions;
DROP TABLE IF EXISTS compliance_training_assignments;
DROP TABLE IF EXISTS compliance_training_modules;
