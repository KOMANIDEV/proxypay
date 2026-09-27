-- Migration: 20260908_compliance_training
-- Description: Compliance training and certification tracking (#481).
--
-- Regulated operators must evidence that staff were trained and that the
-- training is still current. This adds:
--   * compliance_training_modules   – the curriculum (content + validity period)
--   * compliance_training_assignments – who must take it, and by when
--   * compliance_training_completions  – attempts, scores and the resulting
--                                         certificate
--   * compliance_certifications     – issued certificates with expiry, so an
--                                     expired certificate is a query, not a
--                                     spreadsheet.

CREATE TABLE IF NOT EXISTS compliance_training_modules (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code                VARCHAR(50) NOT NULL UNIQUE,
    title               VARCHAR(200) NOT NULL,
    description         TEXT,
    -- Ordered questions. Shape: [{ "id", "question", "options": [...],
    --                              "correctOption", "explanation" }]
    content             JSONB NOT NULL DEFAULT '[]'::jsonb,
    passing_score       INTEGER NOT NULL DEFAULT 80
                        CHECK (passing_score BETWEEN 0 AND 100),
    -- Months a passed certificate stays valid. 0 = never expires.
    validity_months     INTEGER NOT NULL DEFAULT 12
                        CHECK (validity_months >= 0),
    mandatory_for_roles  TEXT[] NOT NULL DEFAULT '{}',
    is_active           BOOLEAN NOT NULL DEFAULT TRUE,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_compliance_modules_active
    ON compliance_training_modules (is_active, code);

CREATE TABLE IF NOT EXISTS compliance_training_assignments (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    module_id    UUID NOT NULL REFERENCES compliance_training_modules (id) ON DELETE CASCADE,
    user_id      VARCHAR(255) NOT NULL,
    assigned_by  VARCHAR(255),
    due_at       TIMESTAMPTZ,
    -- A revoked assignment must stop counting towards completion stats, so it
    -- is a state rather than a deleted row.
    status       VARCHAR(20) NOT NULL DEFAULT 'assigned'
                 CHECK (status IN ('assigned', 'in_progress', 'completed',
                                   'waived', 'revoked')),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- A module is assigned to a person once; re-assigning reopens the record.
    UNIQUE (module_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_compliance_assignments_user
    ON compliance_training_assignments (user_id, status);

CREATE INDEX IF NOT EXISTS idx_compliance_assignments_due
    ON compliance_training_assignments (due_at)
    WHERE status IN ('assigned', 'in_progress');

CREATE TABLE IF NOT EXISTS compliance_training_completions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    module_id       UUID NOT NULL REFERENCES compliance_training_modules (id) ON DELETE CASCADE,
    user_id         VARCHAR(255) NOT NULL,
    score           INTEGER NOT NULL CHECK (score BETWEEN 0 AND 100),
    passed          BOOLEAN NOT NULL,
    -- Per-question answers, retained for audit of how the score was reached.
    answers         JSONB NOT NULL DEFAULT '[]'::jsonb,
    attempt_number  INTEGER NOT NULL DEFAULT 1,
    time_spent_secs INTEGER,
    completed_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_compliance_completions_user
    ON compliance_training_completions (user_id, module_id, completed_at DESC);

CREATE TABLE IF NOT EXISTS compliance_certifications (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    certificate_number VARCHAR(50) NOT NULL UNIQUE,
    module_id          UUID NOT NULL REFERENCES compliance_training_modules (id) ON DELETE CASCADE,
    user_id            VARCHAR(255) NOT NULL,
    score              INTEGER NOT NULL,
    issued_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at         TIMESTAMPTZ,
    -- Revoked by a compliance officer, e.g. after a policy change.
    revoked_at         TIMESTAMPTZ,
    revoked_reason     TEXT,
    -- Links back to the attempt that earned it.
    completion_id      UUID REFERENCES compliance_training_completions (id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_compliance_certifications_user
    ON compliance_certifications (user_id, expires_at DESC);

-- The compliance dashboard's "expiring soon" and "expired" queries.
CREATE INDEX IF NOT EXISTS idx_compliance_certifications_expiring
    ON compliance_certifications (expires_at)
    WHERE revoked_at IS NULL;

-- Certification state for a person, derived once and indexed. A user holding
-- several certificates for the same module (renewals) resolves to the latest.
CREATE OR REPLACE VIEW v_compliance_certification_status AS
SELECT DISTINCT ON (c.user_id, c.module_id)
       c.user_id,
       c.module_id,
       m.code,
       m.title,
       c.certificate_number,
       c.score,
       c.issued_at,
       c.expires_at,
       CASE
         WHEN c.revoked_at IS NOT NULL THEN 'revoked'
         WHEN c.expires_at IS NULL     THEN 'valid'
         WHEN c.expires_at < NOW()     THEN 'expired'
         WHEN c.expires_at < NOW() + INTERVAL '30 days' THEN 'expiring'
         ELSE 'valid'
       END AS status
  FROM compliance_certifications c
  JOIN compliance_training_modules m ON m.id = c.module_id
 ORDER BY c.user_id, c.module_id, c.issued_at DESC;

-- Automatic updated_at, matching the trigger style used in 001_initial_schema.
CREATE OR REPLACE FUNCTION update_compliance_training_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS compliance_modules_updated_at ON compliance_training_modules;
CREATE TRIGGER compliance_modules_updated_at
  BEFORE UPDATE ON compliance_training_modules
  FOR EACH ROW EXECUTE FUNCTION update_compliance_training_updated_at();

DROP TRIGGER IF EXISTS compliance_assignments_updated_at ON compliance_training_assignments;
CREATE TRIGGER compliance_assignments_updated_at
  BEFORE UPDATE ON compliance_training_assignments
  FOR EACH ROW EXECUTE FUNCTION update_compliance_training_updated_at();

-- ─── Seed content ────────────────────────────────────────────────────────────
-- Seeded with ON CONFLICT DO NOTHING so re-running the migration is safe and
-- a customised module is never silently reset to stock content.

INSERT INTO compliance_training_modules
  (code, title, description, content, passing_score, validity_months, mandatory_for_roles)
VALUES
  ('AML_FUNDAMENTALS', 'AML Fundamentals',
   'Core anti-money-laundering obligations: customer due diligence, ' ||
   'transaction monitoring and suspicious activity reporting.',
   '[
     {"id":"q1","question":"What is the primary purpose of Customer Due Diligence?",
      "options":["Increase revenue","Verify customer identity and assess risk","Reduce network latency","Archive transaction records"],
      "correctOption":1,
      "explanation":"CDD establishes who the customer is and how risky they are, which sets the level of monitoring that applies."},
     {"id":"q2","question":"A transaction is flagged as suspicious. What is the next step?",
      "options":["Process it normally","Delete the record","File a suspicious activity report","Ignore it if under the threshold"],
      "correctOption":2,
      "explanation":"A suspicious activity report is the mechanism for escalating a suspicion to the relevant authority."},
     {"id":"q3","question":"Which is a common indicator of money laundering?",
      "options":["Structuring below reporting thresholds","Consistent payroll deposits","A verified business address","Matching invoice and payment amounts"],
      "correctOption":0,
      "explanation":"Structuring is the deliberate splitting of amounts to stay below reporting thresholds."}
   ]'::jsonb,
   80, 12, ARRAY['compliance_officer','operations','support']),

  ('SANCTIONS_SCREENING', 'Sanctions Screening',
   'Screening customers and counterparties against sanctions and ' ||
   'politically-exposed-person lists, and handling potential matches.',
   '[
     {"id":"q1","question":"What should you do with a confirmed sanctions match?",
      "options":["Notify the customer","Block the activity and escalate to compliance","Retry the payment later","Lower the transaction amount"],
      "correctOption":1,
      "explanation":"A confirmed match must be blocked and escalated; tipping off the customer is itself a violation."},
     {"id":"q2","question":"A potential match is reviewed and cleared as a false positive. What must be recorded?",
      "options":["Nothing","The review decision and its rationale","The customer''s full ID document","The screening vendor contract"],
      "correctOption":1,
      "explanation":"False-positive dispositions are auditable decisions and must be documented with their rationale."}
   ]'::jsonb,
   80, 12, ARRAY['compliance_officer','operations']),

  ('DATA_PROTECTION', 'Data Protection & Privacy',
   'Handling personal data lawfully: lawful basis, minimisation, retention ' ||
   'and data-subject rights.',
   '[
     {"id":"q1","question":"Which principle requires collecting only the personal data you need?",
      "options":["Data minimisation","Data portability","Data localisation","Data pseudonymisation"],
      "correctOption":0,
      "explanation":"Data minimisation limits collection to what is necessary for the stated purpose."},
     {"id":"q2","question":"How long should personal data be retained?",
      "options":["Forever","Until the storage is full","For the period justified by the purpose and law","For exactly one year in all cases"],
      "correctOption":2,
      "explanation":"Retention must be justified by purpose and legal obligation, not by convenience or capacity."}
   ]'::jsonb,
   85, 24, ARRAY['all'])
ON CONFLICT (code) DO NOTHING;
