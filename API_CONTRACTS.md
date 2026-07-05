# VSA Platform — API Contracts (REST)

Base URL: `/api/v1`. All request/response bodies are JSON. All staff endpoints require `Authorization: Bearer <jwt>` (contains `sub`=user id, `org_id`, `role`). Vendor endpoints require `Authorization: Bearer <invite_token>` (opaque, resolved server-side to `vendor_invites.token_hash`; never a JWT, never carries elevated claims). Every state-changing call writes an `audit_log` row per `DB_SCHEMA.md` §5.

Standard error shape:
```json
{ "error": { "code": "string", "message": "string", "fields": { "field": "reason" } } }
```
Standard status codes used throughout: `200` OK, `201` Created, `204` No Content, `400` validation error, `401` unauthenticated, `403` unauthorized (RBAC), `404` not found, `409` conflict (e.g. already submitted), `422` business-rule violation.

---

## Screen 1a/1b/1c — Vendor Checklist (shared contract; all three UI layouts consume the same API)

**Authorization for all endpoints in this section:** Bearer = vendor invite token. Token must resolve to a non-expired, non-revoked `vendor_invites` row. Server derives `assessment_id`/`vendor_id` from the token — **never accepted as client input** (prevents a vendor from requesting another vendor's data). No reviewer/admin payload fields (scores, weights, AI content, other vendors) are ever included in these responses.

### `GET /vendor/session`
Validates token and loads assessment shell + progress.

Request: no body. `Authorization: Bearer <token>`.

Response `200`:
```json
{
  "assessment_id": "uuid",
  "vendor_name": "Acme Corp",
  "status": "in_progress",
  "expires_at": "2026-07-11T00:00:00Z",
  "domains": [
    { "control_domain_id": "uuid", "name": "Third-Party Mgmt", "answered_count": 6, "total_count": 12 }
  ]
}
```
Validation: token format check only (opaque string, expected length).
Errors: `401` invalid/unknown token; `410` (custom) token expired/revoked; `409` if `status` is already `submitted` (client should route to a read-only "already submitted" view).

### `GET /vendor/checklist?domain_id=:uuid`
Fetches questions for a domain (1a/1b) or full flattened set when `domain_id` omitted (1c).

Response `200`:
```json
{
  "questions": [
    {
      "question_id": "uuid",
      "control_code": "TPM-05.1",
      "weight": 9,
      "question_text": "Does the contract require breach notification within a defined SLA?",
      "requires_evidence": false,
      "response": {
        "response_value": "non_compliant",
        "justification": "No formal SLA in current MSA…",
        "evidence": [ { "file_id": "uuid", "file_name": "msa.pdf", "uploaded_at": "…" } ],
        "is_locked": false
      }
    }
  ]
}
```
Validation: `domain_id` must belong to this vendor's assigned checklist template if provided.
Authorization: same as above; 403 if `domain_id` not part of this assessment.

### `PATCH /vendor/responses/:questionId`
Autosaves a single response (debounced client-side).

Request:
```json
{ "response_value": "non_compliant", "justification": "No formal SLA in current MSA…" }
```
Response `200`: echoes saved `response` object (as in checklist fetch) + `saved_at`.

Validation:
- `response_value` ∈ `{compliant, non_compliant, not_applicable}`, required.
- `justification` required, non-empty, when `response_value = not_applicable` → `400` with `fields.justification`.
- Rejected with `409` if the parent assessment is already submitted (`is_locked = true` on the response row) — no silent edits post-submission.
- `question_id` must belong to this assessment's template → `404` otherwise.

Authorization: vendor token only; must own the assessment containing this question.

### `POST /vendor/evidence/:questionId` (multipart/form-data)
Request: `file` (binary), `question_id` path param.
Response `201`:
```json
{ "file_id": "uuid", "file_name": "msa.pdf", "file_size_bytes": 481200, "mime_type": "application/pdf", "uploaded_at": "…" }
```
Validation: mime type ∈ allow-list (`pdf, png, jpg, jpeg, docx`), size ≤ 25MB → `400` otherwise. Rejected `409` if assessment locked.
Authorization: vendor token; question must belong to assessment.

### `DELETE /vendor/evidence/:fileId`
Response `204`. Validation: only allowed pre-submission (`409` if locked). Authorization: file must belong to a response within this vendor's assessment.

### `GET /vendor/submit/validate`
Dry-run completeness check (used by 1c's inline error list).

Response `200`:
```json
{ "complete": false, "incomplete_controls": ["TPM-06", "TPM-09"] }
```

### `POST /vendor/submit`
Request: no body (or `{ "confirm": true }`).
Response `200`:
```json
{ "assessment_id": "uuid", "status": "submitted", "submitted_at": "…", "submission_hash": "sha256:…" }
```
Validation: all required questions answered (N/A justified) → `422` with `incomplete_controls` list otherwise, matching `/submit/validate`.
Side effects: sets all `responses.is_locked = true`, computes `submission_hash`, transitions `assessments.status`, triggers async AI generation batch job (§ AI Integration).
Authorization: vendor token; idempotency — second call returns `409` (`already_submitted`).

---

## Screen 1d/1e/1f — Reviewer Window (Cyber / Legal)

**Authorization for all endpoints in this section:** Bearer = staff JWT with `role ∈ {cyber_reviewer, legal_reviewer}`. Server filters every response to controls where a `routing_rules` row matches the caller's role for that control — enforced in the query itself (`WHERE routing_rules.role = :callerRole`), not stripped client-side. A Cyber Reviewer request for a Legal-only control returns `403`, never a filtered-but-fetched payload.

### `GET /review/:vendorId/domain/:domainRole`
`domainRole` is implicit from JWT role (path uses `:vendorId` only in practice; role scoping is automatic) — shown here as the effective scope.

Response `200`:
```json
{
  "vendor_name": "Acme Corp",
  "criticality_tier": "high",
  "controls": [
    {
      "control_id": "uuid", "control_code": "TPM-05.1", "weight": 9,
      "response_value": "non_compliant",
      "justification": "…",
      "evidence": [ { "file_id": "uuid", "file_name": "msa.pdf" } ],
      "verdict": { "action": "accept", "reviewer_id": "uuid", "created_at": "…" } 
    }
  ]
}
```
Validation: `vendorId` must have a submitted assessment (`404` if no submitted assessment exists yet — reviewers never see in-progress vendor data).
Authorization: 403 if caller's role has zero routed controls for this vendor (nothing to review).

### `GET /ai/summary/:vendorId?domain=:domainRole&format=briefing|tabbed`
Response `200`:
```json
{
  "kind": "summary",
  "generated_at": "…",
  "is_stale": false,
  "content": {
    "executive_summary": "…",
    "gaps": [
      { "control_code": "TPM-05.1", "weight": 9, "severity": "critical", "narrative": "…", "remediation": "…" }
    ]
  },
  "disclosure": "AI-Generated — Human Review Required"
}
```
Validation: returns `404` if no AI generation exists yet for this scope (client should show "pending" state, not an error banner, if assessment just submitted and batch job hasn't completed).
Authorization: same role-scoping as `/review/:vendorId/domain/:domainRole`; AI content for controls outside caller's role is never included.

### `POST /ai/regenerate/:vendorId?domain=:domainRole`
Request: `{ "reason": "vendor updated evidence" }` (optional, logged).
Response `202`:
```json
{ "job_id": "uuid", "status": "queued" }
```
Validation: `409` if evidence/response hash unchanged since last generation (nothing to regenerate) unless `force: true` passed.
Authorization: reviewer or admin role only. Every call logged to `audit_log` with prompt inputs (control id, question text, response, justification, evidence metadata, weight — never raw file bytes) per AI Integration Requirements §5.

### `POST /review/:vendorId/control/:controlId/verdict`
Request:
```json
{ "action": "override", "final_text": "Recommend requiring 72h SLA clause…", "comment": "AI understated legal exposure" }
```
Response `201`:
```json
{ "verdict_id": "uuid", "control_id": "uuid", "action": "override", "created_at": "…" }
```
Validation:
- `action` ∈ `{accept, edit, override}`, required.
- `comment` required, non-empty, when `action = override` → `400` (`fields.comment`).
- `final_text` required when `action ∈ {edit, override}`.
- `control_id` must be in caller's routed scope → `403` otherwise.
- Upserts (unique per `assessment_id + control_id + reviewer_id` — resubmitting updates prior verdict, both versions retained via `audit_log`, not via mutation of history).

### `POST /review/:vendorId/decision`
Request: `{ "decision": "escalate", "comment": "Needs contract renegotiation before approval" }`
Response `201`: `{ "decision_id": "uuid", "decided_at": "…" }`
Validation:
- `decision` ∈ `{approve, request_info, escalate, reject}`.
- `422` if any non-compliant control in caller's routed scope has no `reviewer_verdicts` entry yet ("resolve all gaps before deciding").
- One decision per role per assessment — a second call `409`s unless an explicit `reopen` flag is set by an Admin-only endpoint.

### `GET /audit/log/:vendorId?controlId=:controlId`
Response `200`: paginated list of `audit_log` rows scoped to entities the caller's role can see (a reviewer sees audit entries for controls in their domain only, plus their own actions).
Authorization: reviewers see domain-scoped entries only; Risk Manager/Admin see full trail.

---

## Screen 1g — Risk Manager: Single-Vendor Verdict

**Authorization:** JWT role = `risk_manager` (or `admin`). Full cross-domain visibility for vendors within the caller's organization.

### `GET /risk/:vendorId/score`
Response `200`:
```json
{
  "assessment_id": "uuid",
  "aggregate_score": 71.0,
  "tier": "high",
  "is_final": true,
  "computed_at": "…",
  "domain_scores": [
    { "control_domain_id": "uuid", "name": "Third-Party Mgmt", "sub_score": 82.0 },
    { "control_domain_id": "uuid", "name": "Access Control", "sub_score": 15.0 }
  ]
}
```
Validation: `404` if assessment not yet submitted (no final score exists). Sorted descending by `sub_score` server-side (matches wireframe 1g's "worst first").

### `GET /risk/:vendorId/reviewer-status`
Response `200`:
```json
{ "cyber_reviewer": { "decided": true, "decision": "approve" }, "legal_reviewer": { "decided": false } }
```

### `POST /risk/:vendorId/disposition`
Request: `{ "decision": "conditional", "comment": "Approve pending signed breach-notification addendum" }`
Response `201`: `{ "disposition_id": "uuid", "decided_at": "…" }`
Validation:
- `decision` ∈ `{approve, conditional, reject}`.
- `comment` required, non-empty, unless `decision = approve` → `400`.
- `422` (`reviewers_incomplete`) if either `cyber_reviewer` or `legal_reviewer` decision is missing.
- `409` if a disposition already exists for this assessment (final — requires a formal reopen/re-assessment, not a second POST).
Authorization: `risk_manager` only; write locks the assessment (`status` → `approved|conditional|rejected`) and blocks further vendor/reviewer writes.

---

## Screen 1h — Risk Manager: Vendor Portfolio Table

### `GET /risk/portfolio?sort=score|tier|status&filter_tier=:tier&q=:searchTerm&page=:n&page_size=:n`
Response `200`:
```json
{
  "page": 1, "page_size": 25, "total": 84,
  "vendors": [
    { "vendor_id": "uuid", "name": "Acme Corp", "score": 71.0, "tier": "high", "worst_domain": { "name": "Third-Party Mgmt", "sub_score": 82.0 }, "status": "in_review" },
    { "vendor_id": "uuid", "name": "Delta Sys", "score": null, "tier": null, "worst_domain": null, "status": "sent" }
  ]
}
```
Validation: `sort` and `filter_tier` restricted to enum values → `400` on invalid value. `page_size` capped at 100.
Authorization: `risk_manager`/`admin`; result set implicitly scoped to `organization_id` from JWT — never accepts a client-supplied org filter.

---

## Screen 1i — Risk Manager: Score Contribution Breakdown

### `GET /risk/:vendorId/score-breakdown`
Response `200`:
```json
{
  "aggregate_score": 71.0,
  "domains": [
    { "name": "Third-Party Mgmt", "contribution_pct": 46.0, "driving_controls": ["TPM-05.1", "TPM-06"] },
    { "name": "Incident Response", "contribution_pct": 26.0, "driving_controls": ["TPM-11"] }
  ]
}
```
Validation: `contribution_pct` values computed server-side, sum to 100 (of the risk portion) — never accepted from client. `404` if assessment not finalized (per SCREENS.md, breakdown is post-submission only, not live).

### `GET /ai/cross-domain-note/:vendorId`
Response `200`: `{ "note": "2 of top-3 gaps share a contract-clause root cause", "disclosure": "AI-Generated — Human Review Required" }`

### `GET /risk/:vendorId/export?format=pdf|csv`
Response `200`, `Content-Type: application/pdf` or `text/csv` (binary/file stream, not JSON).
Authorization: `risk_manager`/`admin`; every export call logged to `audit_log` (exports are a common audit ask).

---

## Screen 1j — Admin Console: Control Library, Weights & Routing

**Authorization for all endpoints in this section:** JWT role = `admin` only. Every other role receives `403` regardless of UI state (server-enforced, not hidden-tab).

### `GET /admin/controls?domain_id=:uuid&include_deprecated=false`
Response `200`:
```json
{
  "controls": [
    { "control_id": "uuid", "control_code": "TPM-05.1", "title": "…", "source": "scf", "weight": 9, "routed_to": ["legal_reviewer", "cyber_reviewer"], "is_deprecated": false }
  ]
}
```

### `PATCH /admin/controls/:controlId`
Request:
```json
{ "weight": 8, "routed_to": ["cyber_reviewer"], "reason": "Recalibrated per Q3 SCF update" }
```
Response `200`: updated control object + `{ "weight_history_id": "uuid" }`.
Validation:
- `weight` integer 1–10 → `400` otherwise.
- Change is **non-retroactive**: writes a new `control_weight_history` row; does not touch `responses.weight_at_response` on already-submitted assessments.
- `routed_to` values ∈ `{cyber_reviewer, legal_reviewer, risk_manager}`.

### `POST /admin/controls` (custom control)
Request:
```json
{ "control_domain_id": "uuid", "control_code": "CUS-03", "title": "…", "description": "…", "weight": 7, "routed_to": ["cyber_reviewer"] }
```
Response `201`: created control object.
Validation: `control_code` must match reserved custom prefix (e.g. `^CUS-\d+$`) and be unique within org → `409` on collision; `weight` 1–10.

### `DELETE /admin/controls/:controlId`
Response: `409` (`in_use`) if any `responses` reference this control — soft-delete only. Otherwise `200` sets `is_deprecated = true` (no hard delete, ever).

### `GET /admin/questions?control_id=:uuid`
Response `200`: list of question bank entries for a control.

### `POST /admin/questions`
Request: `{ "control_id": "uuid", "question_text": "…", "requires_evidence": true }`
Response `201`: created question.
Validation: `control_id` must exist and not be deprecated.

### `POST /admin/vendors/:vendorId/assign-checklist`
Request: `{ "checklist_template_id": "uuid", "expires_in_days": 14, "contact_email": "security@vendor.com" }`
Response `201`:
```json
{ "assessment_id": "uuid", "invite_token": "opaque-token-shown-once", "expires_at": "…" }
```
Validation: `expires_in_days` 1–90; vendor must not already have an active (`sent`/`in_progress`) assessment on the same template → `409`.
Side effect: sends invite email (out of band); `invite_token` is returned once and not retrievable again (only re-issuable via a new POST that revokes the prior one).

### `POST /admin/routing-rules`
Request: `{ "control_id": "uuid", "roles": ["legal_reviewer"] }`
Response `200`: updated routing set for the control (idempotent replace, not append).

### `GET /audit/log?scope=admin-config&page=:n`
Response `200`: paginated full change history (control/weight/routing edits) — admin/full-trail view, no domain scoping.

---

## Cross-Cutting Contract Rules

- **RBAC is enforced in the query/service layer**, not the route layer: every list/detail endpoint above adds a role-derived predicate (vendor→own assessment only; reviewer→routed controls only; risk manager/admin→org-wide). A payload never includes fields the caller's role shouldn't see, even redacted — the field is absent from the serializer entirely.
- **Idempotency:** `POST /vendor/submit`, `POST /risk/:vendorId/disposition`, and `POST /review/:vendorId/decision` are one-shot per assessment; retries return `409` rather than creating duplicate finalized state.
- **AI disclosure is contractual, not just visual:** every `ai_generations`-backed response includes a `"disclosure"` field the client must render; no endpoint that returns AI content also accepts a field that would let AI output silently become a `dispositions` or `review_decisions` row without a corresponding `reviewer_verdicts`/human action first.
- **Audit on every mutation:** each `PATCH`/`POST`/`DELETE` above writes one `audit_log` row (`actor`, `action`, `entity_type`, `entity_id`, `before_value`, `after_value`) synchronously in the same transaction as the mutation — never fire-and-forget.
- **Pagination:** all list endpoints accept `page`/`page_size` (default 25, max 100) and return `total` for client-side pagers.
- **Versioning:** all routes are under `/api/v1`; breaking changes ship as `/api/v2` rather than mutating existing contracts.
