-- Post-migrate SQL: adds CHECK constraints and audit_log grants that Prisma
-- cannot express declaratively. Idempotent — safe to run every migrate.
-- Reference: SOLUTION_BLUEPRINT.md §3 (Design Notes) + §5.4 (Audit Integrity).

-- ============================================================
-- CHECK CONSTRAINTS
-- ============================================================

-- controls.current_weight must be 1..10
ALTER TABLE controls DROP CONSTRAINT IF EXISTS chk_controls_weight_range;
ALTER TABLE controls ADD CONSTRAINT chk_controls_weight_range
  CHECK (current_weight BETWEEN 1 AND 10);

-- control_weight_history.weight must be 1..10
ALTER TABLE control_weight_history DROP CONSTRAINT IF EXISTS chk_weight_history_range;
ALTER TABLE control_weight_history ADD CONSTRAINT chk_weight_history_range
  CHECK (weight BETWEEN 1 AND 10);

-- routing_rules.role restricted to the three reviewer/admin roles that can be routed to
ALTER TABLE routing_rules DROP CONSTRAINT IF EXISTS chk_routing_role;
ALTER TABLE routing_rules ADD CONSTRAINT chk_routing_role
  CHECK (role IN ('cyber_reviewer', 'legal_reviewer', 'risk_manager'));

-- responses: N/A requires a non-empty justification (anti-gaming, blueprint §1.4)
ALTER TABLE responses DROP CONSTRAINT IF EXISTS chk_na_requires_justification;
ALTER TABLE responses ADD CONSTRAINT chk_na_requires_justification
  CHECK (
    response_value IS DISTINCT FROM 'not_applicable'
    OR (justification IS NOT NULL AND length(trim(justification)) > 0)
  );

-- reviewer_verdicts: override requires a comment (blueprint §4 review verdict)
ALTER TABLE reviewer_verdicts DROP CONSTRAINT IF EXISTS chk_override_requires_comment;
ALTER TABLE reviewer_verdicts ADD CONSTRAINT chk_override_requires_comment
  CHECK (
    action <> 'override'
    OR (comment IS NOT NULL AND length(trim(comment)) > 0)
  );

-- review_decisions.reviewer_role restricted to actual reviewer roles
ALTER TABLE review_decisions DROP CONSTRAINT IF EXISTS chk_review_decision_role;
ALTER TABLE review_decisions ADD CONSTRAINT chk_review_decision_role
  CHECK (reviewer_role IN ('cyber_reviewer', 'legal_reviewer'));

-- risk_scores.aggregate_score must be 0..100
ALTER TABLE risk_scores DROP CONSTRAINT IF EXISTS chk_aggregate_score_range;
ALTER TABLE risk_scores ADD CONSTRAINT chk_aggregate_score_range
  CHECK (aggregate_score BETWEEN 0 AND 100);

-- risk_domain_scores.sub_score must be 0..100
ALTER TABLE risk_domain_scores DROP CONSTRAINT IF EXISTS chk_sub_score_range;
ALTER TABLE risk_domain_scores ADD CONSTRAINT chk_sub_score_range
  CHECK (sub_score BETWEEN 0 AND 100);

-- dispositions: reject/conditional require a comment; approve does not
ALTER TABLE dispositions DROP CONSTRAINT IF EXISTS chk_disposition_comment;
ALTER TABLE dispositions ADD CONSTRAINT chk_disposition_comment
  CHECK (
    decision = 'approve'
    OR (comment IS NOT NULL AND length(trim(comment)) > 0)
  );

-- ============================================================
-- AUDIT LOG: append-only enforcement at the DB grant level
-- Application connects via role `app_write_role`; UPDATE/DELETE on audit_log
-- is revoked, so tampering is a DB-level error, not just an app-level rule.
-- ============================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_write_role') THEN
    CREATE ROLE app_write_role NOLOGIN;
  END IF;
END
$$;

-- Ensure app_write_role has INSERT/SELECT on audit_log but not UPDATE/DELETE.
GRANT SELECT, INSERT ON audit_log TO app_write_role;
REVOKE UPDATE, DELETE, TRUNCATE ON audit_log FROM app_write_role;

-- Note: real prod also needs GRANT USAGE ON SEQUENCE audit_log_id_seq TO app_write_role
-- once the app role is wired in. Deferred until Sprint 2 (RLS + app role).
