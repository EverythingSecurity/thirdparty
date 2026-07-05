# VSA Platform — Implementation Plan

Derived from `SOLUTION_BLUEPRINT.md`. Scope: full-stack Vendor Security Assessment application (vendor checklist → risk scoring → multi-stakeholder AI-assisted review → final disposition), deployed on Azure.

Sequencing principle: Foundation → Database → Auth → Backend → Frontend → AI Engine → Azure Deployment. Later phases assume earlier phases are complete, but some tracks (e.g. Azure landing zone) can begin in parallel with Database.

Each phase lists: **Objectives**, **Workstreams**, **Deliverables**, **Dependencies**, **Exit criteria**.

---

## Phase 1 — Foundation

**Objective:** Stand up the shared engineering baseline so every downstream phase inherits the same repo, tooling, standards, and CI/CD substrate.

### 1.1 Workstreams
- **Repository & branching model**
  - Mono-repo layout: `/apps/api`, `/apps/web`, `/apps/worker`, `/packages/shared` (types, RBAC helpers, validation schemas), `/infra` (IaC), `/db` (migrations + seeds).
  - Trunk-based development with short-lived feature branches; PR-required reviews; protected `main`.
- **Language & framework selection (confirm)**
  - API: Node.js (TypeScript) on Express/Fastify or NestJS (blueprint calls out Node.js on App Service).
  - Frontend: React SPA (TypeScript) + Vite/Next.js static export.
  - Worker: Node.js container/Azure Function (TypeScript) for AI batch/regeneration jobs.
- **Local dev environment**
  - Dockerized Postgres + Redis + Blob emulator (Azurite) + local API + local worker.
  - `.env.example` with named secrets; real secrets never in repo (Key Vault later).
- **CI/CD skeleton**
  - Lint (ESLint + Prettier), typecheck, unit tests, dependency SCA (npm audit / Snyk), IaC lint (Bicep/tflint) on every PR.
  - Build+publish container images; environment matrix (dev/staging/prod).
- **Shared engineering standards**
  - API versioning under `/api/v1`.
  - Error envelope `{ error: { code, message, fields } }` from blueprint §4.
  - Logging convention (structured JSON, correlation IDs).
  - Audit logging contract shared by API + worker (`actor`, `action`, `entity_type`, `entity_id`, `before_value`, `after_value`).
- **Documentation baseline**
  - `README.md`, `CONTRIBUTING.md`, ADR folder for architectural decisions.

### 1.2 Deliverables
- Populated mono-repo with lint/test/build passing green in CI.
- Local `docker compose up` produces a working (empty) API + web + worker + Postgres + Redis + Azurite.
- CI pipeline gates on lint, typecheck, unit tests, SCA.

### 1.3 Exit criteria
- A trivial "hello world" endpoint deploys through the CI pipeline into a dev environment.
- All engineers can run the full stack locally with a single command.

---

## Phase 2 — Database

**Objective:** Implement the persistence layer exactly as specified in blueprint §3 (DDL + relationships + design notes), with migration tooling and seed data.

### 2.1 Workstreams
- **Migration tooling**
  - Choose: Prisma / Knex / node-pg-migrate / Flyway. Pin choice; migrations live in `/db/migrations`.
  - Enforce forward-only migrations; every schema change ships as a numbered migration reviewed in PR.
- **Schema build-out (in this order)**
  1. Extensions: `pgcrypto`, `citext`.
  2. Enum types (§3.2): `user_role`, `response_value`, `control_source`, `assessment_status`, `reviewer_action`, `review_decision_value`, `disposition_value`, `ai_generation_kind`, `criticality_tier`.
  3. Tenancy & identity: `organizations`, `users`.
  4. Control library: `control_domains`, `controls`, `control_weight_history`, `routing_rules`.
  5. Question bank & templates: `questions`, `checklist_templates`, `checklist_template_questions`.
  6. Vendor & assessment: `vendors`, `assessments`, `vendor_invites` (mind FK order — define `assessments` before `vendor_invites` per note).
  7. Response layer: `responses` (with `weight_at_response` snapshot column and N/A justification CHECK), `evidence_files` (metadata only).
  8. AI + review: `ai_generations`, `reviewer_verdicts` (with `ai_generation_id` pin and override-comment CHECK), `review_decisions`.
  9. Risk output: `risk_scores`, `risk_domain_scores`.
  10. Final disposition: `dispositions` (unique per assessment; comment required unless approve).
  11. Audit: `audit_log` (bigint identity PK, jsonb before/after, polymorphic entity ref).
- **Row-Level Security (RLS)**
  - Enable RLS on every tenant-scoped table.
  - Policies: `organization_id = current_setting('app.org_id')::uuid` baseline; role-specific predicates for vendor/reviewer/admin (§5.2).
  - App role: separate `app_write_role` with INSERT-only on `audit_log` (UPDATE/DELETE revoked per §5.4).
- **Index & performance**
  - Indexes as specified: `idx_users_org_role`, `idx_vendors_org`, `idx_invites_expiry`, `idx_controls_domain`, `idx_weight_history_control`, `idx_questions_control`, `idx_assessments_vendor`, `idx_assessments_status`, `idx_responses_assessment`, `idx_responses_control`, `idx_evidence_response`, `idx_ai_gen_assessment`, `idx_verdicts_assessment`, `idx_risk_scores_assessment`, `idx_audit_org_time`, `idx_audit_entity`.
- **Seed data**
  - Reference SCF Third-Party Management controls (TPM-01, 02, 04.1, 04.4, 05, 05.1, 06, 09, 11) with weights from §1.2.
  - One demo organization, one demo checklist template, one demo vendor for dev/QA.
- **Backup & recovery**
  - Point-in-time restore (PITR) enabled on Azure Postgres Flexible Server; zone-redundant HA config confirmed.

### 2.2 Deliverables
- All migrations apply cleanly against a fresh Postgres 16 database.
- RLS policies verified via test harness (a vendor-role connection cannot SELECT another vendor's rows).
- Seed script produces a runnable demo state.

### 2.3 Dependencies
- Foundation (Phase 1) local stack.

### 2.4 Exit criteria
- ER matches blueprint §3.4 diagram.
- `submission_hash`, `weight_at_response`, and `ai_generation_id`-pinning columns exist and are enforced by CHECK/NOT NULL where specified.
- `audit_log` demonstrably rejects UPDATE/DELETE at the DB role level.

---

## Phase 3 — Authentication

**Objective:** Implement the two distinct auth paths (staff via Entra ID; vendor via opaque time-bound invite tokens) with RBAC middleware ready for the backend to consume.

### 3.1 Workstreams
- **Staff auth (Entra ID / OIDC)**
  - Register the API and SPA as Entra ID applications; configure redirect URIs per environment.
  - Frontend: OIDC PKCE flow to obtain ID + access tokens; refresh via rotating refresh token in httpOnly Secure SameSite=Strict cookie.
  - Backend: JWT validation middleware — verify issuer, audience, signature (JWKS cache), and `exp` (~15 min).
  - Map Entra ID groups/app roles → `users.role` (admin / cyber_reviewer / legal_reviewer / risk_manager); on first login provision the `users` row if the org allows JIT provisioning, else deny.
  - Enforce MFA at the IdP; API asserts `amr`/`acr` claim contains MFA.
- **Vendor token auth**
  - Token generator: cryptographically random ≥256-bit opaque bearer; return raw token to admin **once** at issue time.
  - Storage: salted hash in `vendor_invites.token_hash`; raw token never persisted or logged.
  - Validator middleware: constant-time hash compare; check `expires_at`, `revoked_at`, `redeemed_at`.
  - Rate limiting per token + per IP (Redis-backed) to blunt brute force.
  - On successful validation, server resolves `assessment_id`/`vendor_id` — never accepted from client input.
- **RBAC layer**
  - Central RBAC helper in `/packages/shared` exporting: `requireRole(...)`, `requireVendorToken()`, `scopeToRoutedControls(role)`.
  - Serializers are role-aware: fields the caller's role shouldn't see are absent, not merely nulled (§5.2).
- **Session & CSRF**
  - Staff cookie sessions carry CSRF token; enforce on state-changing endpoints.
  - CORS allow-list restricted to platform frontend origin(s) per environment.
- **Admin ops**
  - Endpoint: reissue vendor invite (revokes prior token, generates new one).
  - Endpoint: revoke vendor invite (sets `revoked_at`).
  - All auth mutations write to `audit_log`.

### 3.2 Deliverables
- Two working auth middlewares (staff JWT, vendor token) with tests covering: expired, revoked, wrong role, wrong org, IDOR attempt.
- Passing test: a valid vendor token for assessment A cannot be used to fetch assessment B by URL manipulation.
- Passing test: a Cyber Reviewer JWT called against a Legal-only control returns 403 (not filtered payload).

### 3.3 Dependencies
- Foundation (repo/CI), Database (`users`, `vendor_invites`, `routing_rules`, `audit_log` tables).

### 3.4 Exit criteria
- All endpoints in Phases 4+ can declaratively state their auth requirement (`requireRole('admin')`, `requireVendorToken()`, etc.).
- Threat-model review signs off on the two auth paths.

---

## Phase 4 — Backend (REST API + Worker Interface)

**Objective:** Implement the full REST API from blueprint §4, with validation, RBAC, audit logging, and asynchronous job dispatch (LLM calls go via the Worker phase).

Deliver in vertical slices grouped by role/surface so each slice can be tested end-to-end before moving to the next.

### 4.1 Cross-cutting infrastructure
- **Validation:** shared schema layer (Zod / Joi) per endpoint — mirrors blueprint's per-endpoint Validation notes.
- **Error handling:** central error middleware returning the standard envelope; map validation → 400, RBAC → 403, not found → 404, conflict → 409, business-rule → 422.
- **Audit middleware:** wraps every `PATCH`/`POST`/`DELETE` handler; writes `audit_log` row in the **same DB transaction** as the mutation (never fire-and-forget, §5.4).
- **Idempotency:** `POST /vendor/submit`, `POST /risk/:vendorId/disposition`, `POST /review/:vendorId/decision` — retry semantics return 409 with `already_submitted`/`already_decided`.
- **Pagination:** default `page_size=25`, cap `100`; every list endpoint returns `total`.
- **Rate limiting:** Redis token-bucket on all vendor and auth endpoints.

### 4.2 Slice A — Admin Console (blueprint 1j, §4 Admin)
- `GET /admin/controls`, `PATCH /admin/controls/:id`, `POST /admin/controls`, `DELETE /admin/controls/:id`.
- `GET /admin/questions`, `POST /admin/questions`.
- `POST /admin/vendors/:vendorId/assign-checklist` — generates invite token, returns opaque token once.
- `POST /admin/routing-rules` (idempotent replace).
- `GET /audit/log?scope=admin-config`.
- Business rules: weight 1–10; weight edits non-retroactive (write `control_weight_history`, never touch `responses.weight_at_response`); soft-delete only when in-use; custom control ID `^CUS-\d+$`.

### 4.3 Slice B — Vendor Checklist (blueprint 1a/1b/1c, §4 Vendor)
- `GET /vendor/session`, `GET /vendor/checklist`, `PATCH /vendor/responses/:questionId`.
- `POST /vendor/evidence/:questionId` (multipart; mime allow-list; ≤25MB) → Blob Storage direct-upload preferred (SAS URL flow) to avoid API disk usage.
- `DELETE /vendor/evidence/:fileId` (pre-submission only).
- `GET /vendor/submit/validate`, `POST /vendor/submit` — computes `submission_hash` (SHA-256 canonicalized response set), sets `is_locked=true`, transitions status, enqueues AI batch job (Service Bus).
- Guardrails: N/A requires justification; server derives `assessment_id` from token; 409 on any post-submission mutation.

### 4.4 Slice C — Reviewer (blueprint 1d/1e/1f, §4 Review)
- `GET /review/:vendorId/domain/:domainRole` — RBAC-filtered at query level (`WHERE routing_rules.role = :callerRole`).
- `GET /ai/summary/:vendorId?domain=…&format=…`, `GET /ai/gaps/:vendorId?domain=…`, `POST /ai/regenerate/:vendorId?domain=…` (returns 202 + job_id).
- `POST /review/:vendorId/control/:controlId/verdict` — upsert per (assessment, control, reviewer); require comment on override; pin `ai_generation_id` shown.
- `POST /review/:vendorId/decision` — one per role; 422 if unresolved non-compliant controls in scope.
- `GET /audit/log/:vendorId?controlId=…` — domain-scoped for reviewers.

### 4.5 Slice D — Risk Manager (blueprint 1g/1h/1i, §4 Risk)
- `GET /risk/:vendorId/score`, `GET /risk/:vendorId/reviewer-status`, `GET /risk/:vendorId/score-breakdown`.
- `POST /risk/:vendorId/disposition` — 422 if reviewers incomplete; 409 if disposition exists; locks assessment on write.
- `GET /risk/portfolio?sort=…&filter_tier=…&q=…&page=…`.
- `GET /risk/:vendorId/export?format=pdf|csv` — streams file; every export logged.
- `GET /ai/cross-domain-note/:vendorId`.

### 4.6 Scoring engine (service module, called by submit + admin recalc)
- Inputs: `responses` for an assessment with `weight_at_response`.
- Rules from §1.5: Compliant = 0 risk; Non-Compliant = weight × severity multiplier; N/A excluded from denominator.
- Outputs: aggregate 0–100, tier mapping (Low / Medium / High / Critical), per-domain sub-scores + `contribution_pct`.
- On submit: write one `risk_scores` row with `is_final=true` and matching `risk_domain_scores` rows.
- Live admin recalc allowed pre-submission (`is_final=false`); append-only, never overwrites finalized snapshot.

### 4.7 File & evidence subsystem
- Direct-to-Blob upload via short-lived SAS (write) URLs; API records metadata in `evidence_files` on completion callback.
- Reviewer downloads via short-lived SAS (read) URL — no proxying file bytes through the API.
- Antivirus scan gate (Defender for Storage) before evidence is retrievable.

### 4.8 Deliverables
- All endpoints in §4 of the blueprint implemented, integration-tested against a real Postgres (per-endpoint validation + RBAC test matrix).
- Scoring engine unit-tested with property tests (invariants: 0 ≤ score ≤ 100; N/A never affects denominator; recomputing a locked assessment does not mutate its final row).

### 4.9 Dependencies
- Database, Authentication, Redis (rate limiting), Service Bus queue (Phase 6 setup can precede AI integration).

### 4.10 Exit criteria
- End-to-end path works with AI stubbed: vendor completes → submits → scoring writes final snapshot → reviewer sees empty AI panel (pending) → reviewer records verdict → risk manager disposes.
- All state-changing calls produce audit rows visible via `GET /audit/log`.

---

## Phase 5 — Frontend (Staff SPA + Vendor Portal)

**Objective:** Deliver the four surfaces (Vendor / Cyber Reviewer / Legal Reviewer / Risk Manager / Admin) matching the 10 wireframe layouts (§7) and consuming the backend APIs.

### 5.1 Shared foundations
- **Frameworks & tooling:** React + TypeScript; Vite; Tailwind or CSS-modules; React Query (TanStack) for data fetching + cache; React Hook Form + Zod for forms/validation.
- **Design system:** primitive components (Button, Input, Select, Modal, Toast, Progress, Badge, Accordion, Tabs, Table) aligned with wireframe visual language.
- **Routing:** role-derived route trees; guarded routes redirect unauthenticated users; vendor route parses invite token from URL.
- **State:** server state via React Query; ephemeral UI state locally; no cross-surface global store beyond auth session.
- **Accessibility:** WCAG AA — keyboard nav on accordion/tab structures, focus management on modal open, ARIA labeling on progress rails.
- **Error UX:** map error envelope codes to user-facing messaging; distinguish expired-token (410) from unauthenticated (401).
- **AI disclosure component:** persistent, non-dismissible "AI-Generated — Human Review Required" banner attached to every rendering of `ai_generations` content (§5.5, §API cross-cutting).

### 5.2 Vendor Portal (surfaces 1a, 1b, 1c)
- Ship one primary layout (1a — Stacked Cards + Domain Rail) as default; 1b (Wizard) and 1c (Dense Grid) can be feature-flagged alternates.
- Autosave on `PATCH /vendor/responses/:questionId` debounced ~500ms with saved-at indicator.
- Token-expiry countdown badge in header (drives from `expires_at`).
- Evidence drag-and-drop with mime/size preflight (mirror server rules).
- Submit flow: `GET /vendor/submit/validate` first → inline completeness list → `POST /vendor/submit` → read-only confirmation screen with hash + timestamp.
- Zero access to scores/AI content/other-vendor data — enforced by the fact the API never returns those fields.

### 5.3 Reviewer Windows (surfaces 1d, 1e, 1f)
- Domain rail scoped to routed controls only (nothing else even shown).
- Layout 1d default (Three-Column Sidecar). 1e (AI-First Briefing) and 1f (Per-Control Accordion) as alternate views selectable per reviewer preference.
- Raw ⇄ AI toggle preserves scroll state.
- Verdict actions (Accept / Edit / Override) inline per control/gap card; Override requires comment enforced in-form.
- Decision footer disabled until all in-scope non-compliant controls have a verdict.
- "Regenerate AI" hits `POST /ai/regenerate/...`; UI shows polling for the returned job_id.

### 5.4 Risk Manager Views (surfaces 1g, 1h, 1i)
- 1h Portfolio table: sortable columns (score, tier, status), search, tier filter; row click navigates to 1g.
- 1g Single-Vendor Verdict: score hero + domain sub-score bars (server-sorted worst-first, don't re-sort client-side); disposition action bar gated by reviewer-completion state.
- 1i Contribution Breakdown: proportional stacked bar; each segment click-throughs to the underlying controls (deep-link into reviewer view read-only for Risk Manager).
- Export button on 1i → `GET /risk/:vendorId/export?format=pdf|csv`; browser download; UI does not need to render the file.

### 5.5 Admin Console (surface 1j)
- Tabbed: Control Library / Question Bank / Assignments / Routing.
- Weight edit input (1–10) with change reason required (drives `control_weight_history.reason`).
- Custom-control creation modal enforcing `CUS-\d+` prefix client-side (server re-validates).
- "Assign checklist" flow shows the invite token exactly once with a copy-to-clipboard + "you cannot see this again" affordance.
- Audit log tab (`GET /audit/log?scope=admin-config`) with filters.

### 5.6 Testing
- Unit: components + hooks (React Testing Library).
- Integration: mocked-API contract tests against the OpenAPI schema exported by the backend.
- E2E: Playwright covering the four golden paths (vendor submit; cyber review; legal review; risk-manager disposition).
- Accessibility: axe-core in CI on key screens.

### 5.7 Deliverables
- Deployed SPA (dev environment) with all four surfaces reachable end-to-end.
- Playwright suite green on golden paths.

### 5.8 Dependencies
- Backend Slices A–D; Auth (OIDC config + vendor token endpoints); AI Engine stubbable via feature flag until Phase 6 lands.

### 5.9 Exit criteria
- User can complete the entire vendor → cyber → legal → risk-manager lifecycle in the SPA.
- No screen ever renders AI content without the disclosure component present.
- Role-based navigation demonstrably hides admin routes from non-admins (and API blocks them regardless).

---

## Phase 6 — AI Engine

**Objective:** Implement the AI generation subsystem (batch on submit + on-demand regeneration) with prompt construction, provider integration, audit logging, staleness tracking, and human-in-the-loop guarantees per §1.7 and §5.5.

### 6.1 Worker service
- Runtime: Azure Container Apps Job or Azure Function (Node.js / TypeScript).
- Trigger: Azure Service Bus queue messages emitted by:
  - `POST /vendor/submit` (batch: generate summary + gap_analysis + remediation for every routed domain).
  - `POST /ai/regenerate/...` (single-domain scoped).
- Idempotency: worker checks response/evidence hash before generating; skips if unchanged unless `force=true` was set.

### 6.2 Prompt construction (server-side, allow-listed fields only)
- Inputs pulled from DB and assembled into `ai_generations.prompt` (jsonb):
  - Question text, control ID + code, response value, justification, evidence **metadata only** (file name, size, mime type), weight, domain.
- Free-form vendor text (justification, evidence file names) is **isolated** from system instructions in the prompt template — never concatenated into the same string as instructions (prompt-injection mitigation, §5.5).
- Template variants per `ai_generation_kind`: `summary`, `gap_analysis`, `remediation`, `briefing`, `cross_domain_note`.

### 6.3 LLM provider integration
- Provider: Azure OpenAI Service (blueprint §6.2 default) or Anthropic via API Management passthrough.
- API key via Managed Identity → Key Vault.
- Timeout, retry with exponential backoff, circuit breaker on repeated failure.
- Cost + rate accounting logged per call.

### 6.4 Persistence
- Every prompt + response written to `ai_generations` (prompt jsonb, response_text, model_name, generated_at).
- Regeneration writes a **new** row and links via `superseded_by`; the old row is marked `is_stale=true` — never overwritten in place (§5.5).
- Job status/completion published via a lightweight status endpoint or Redis pub/sub the API polls.

### 6.5 API integration
- `GET /ai/summary`, `GET /ai/gaps`, `GET /ai/cross-domain-note` read the latest non-superseded row scoped by role.
- Reviewer verdicts (`POST /review/.../verdict`) capture the exact `ai_generation_id` shown → immutable pin for audit.
- No AI-produced value ever lands in `review_decisions` / `dispositions` without a preceding `reviewer_verdicts` row (enforced by the business logic that gates decision endpoints).

### 6.6 Explainability & audit
- `audit_log` receives one row per AI job: actor (user who requested, or "system" for submit-batch), action (`ai.generate` / `ai.regenerate`), entity (`ai_generations.id`), before/after (null → generated row summary).
- Optional: nightly job re-verifies prompt sanitizer allow-list against latest generations; flags any generation whose prompt jsonb contains disallowed fields.

### 6.7 Guardrails
- Model output length caps + safety filter (Azure content safety) → if blocked, worker writes an `ai_generations` row with a `response_text = "[BLOCKED — reviewer to draft manually]"` marker; never silently swallows.
- Explicit non-goal: raw evidence file bytes are **never** sent to the LLM. Confirmed by prompt schema validation before dispatch.

### 6.8 Deliverables
- Worker service consuming Service Bus, producing `ai_generations` rows within SLA (e.g. p95 < 60s per assessment on submission).
- Reviewer surfaces render AI content within the same session as vendor submission (given the queue is warm).
- Regeneration path exercises without duplicating identical outputs.

### 6.9 Dependencies
- Backend (submit endpoint enqueues; review endpoints read); Database (`ai_generations`, `reviewer_verdicts.ai_generation_id`); Azure Service Bus + Key Vault + LLM endpoint provisioned in Phase 7.

### 6.10 Exit criteria
- Submit → within-SLA reviewer sees AI content with disclosure.
- Regenerate path emits a new `ai_generations` row and marks the previous stale, verifiable via `superseded_by`.
- Reviewer verdict rows pin the exact AI generation ID rendered at decision time.

---

## Phase 7 — Azure Deployment

**Objective:** Provision, wire, and operate the Azure architecture from blueprint §6 across dev / staging / prod, with all security controls (§5) enforced by platform config, not just app code.

### 7.1 Landing zone & networking
- Subscriptions: separate for prod (and ideally staging); production Key Vault isolated.
- Resource groups per environment.
- Virtual Network with subnets for: App Service/Container Apps, Postgres, Blob (private endpoints), Redis, Service Bus, Worker.
- Private endpoints for Postgres, Blob, Redis, Service Bus, Key Vault — no public network access.
- Azure Front Door + WAF as the sole public ingress; App Service access restrictions limit inbound to Front Door.

### 7.2 Compute
- SPA hosting: Azure Static Web Apps **or** App Service serving the built React bundle from a CDN-fronted origin.
- REST API: Azure App Service (Linux, Node) or Azure Container Apps. Stateless; autoscale on request queue depth. Deployment slots (blue/green) for zero-downtime releases.
- Worker: Azure Container Apps Jobs or Azure Functions (queue trigger on Service Bus).

### 7.3 Data services
- Azure Database for PostgreSQL Flexible Server:
  - Zone-redundant HA.
  - TDE enabled; CMK via Key Vault if org policy requires customer-managed keys.
  - PITR ≥ 14 days.
  - Private endpoint only.
  - Migrations run as a gated pipeline step before slot swap.
- Azure Blob Storage:
  - Private container, private endpoint, no anonymous access.
  - Lifecycle policy for evidence retention/purge per org config.
  - Defender for Storage antivirus scanning enabled.
  - CMK optional via Key Vault.
- Azure Cache for Redis:
  - Backs staff session store, autosave debounce coalescing, rate limiting counters.
  - Private endpoint; TLS enforced.
- Azure Service Bus:
  - Queues: `assessment-submitted`, `ai-regenerate`, `evidence-scanned`.
  - Dead-letter queues + DLQ alerting.

### 7.4 Identity & secrets
- Microsoft Entra ID: app registrations for API + SPA; app roles/groups mapped to `users.role`.
- Managed Identity per compute resource; grants:
  - API MI → Key Vault (secrets read), Postgres (via AAD auth if enabled), Blob (SAS signing), Redis, Service Bus.
  - Worker MI → Key Vault, Postgres, Service Bus, Azure OpenAI.
- Azure Key Vault: DB creds, JWT signing keys, LLM API keys, Blob CMK; access policies role-scoped; secrets rotated on schedule.

### 7.5 Edge, WAF, and rate limiting
- Azure Front Door with WAF policy: OWASP core rule set + custom rules — bot mitigation on vendor invite endpoints, geographic constraints where applicable.
- TLS 1.2+ enforced; HSTS; standard security headers (CSP, X-Content-Type-Options, Referrer-Policy) set at the edge or app layer.
- Rate limiting at Front Door + app-layer Redis-backed limiter (belt-and-braces).

### 7.6 Observability & SIEM
- Application Insights on API and Worker (traces, exceptions, dependencies).
- Log Analytics workspace as central sink; `audit_log` mirrored via a scheduled export or dual-write for SIEM correlation.
- Alert rules: privilege-escalation anomalies (e.g., admin endpoint 4xx spikes), invite-token brute-force patterns, DLQ depth, LLM error rate.
- Microsoft Defender for Cloud enabled across subscription (WAF, storage AV, DB advanced threat protection).

### 7.7 CI/CD & Infrastructure-as-Code
- IaC: Bicep or Terraform in `/infra`, one module per service, environment values via parameter files.
- Pipeline stages:
  1. Lint + typecheck + unit tests (Phase 1 gates).
  2. Build container images / SPA bundle.
  3. SCA + IaC scan.
  4. Deploy IaC to target env (plan → apply with approval on prod).
  5. Run DB migrations (gated).
  6. Deploy new revision to inactive slot / new revision.
  7. Smoke test the inactive slot.
  8. Slot swap / traffic shift.
- Rollback: swap back to prior slot; DB migrations forward-only, so rollback plan is "roll forward with a fix migration."

### 7.8 Environments & release
- **dev:** shared dev environment; auto-deploy from `main`.
- **staging:** production-mirrored; auto-deploy after CI green on `main`; runs E2E + security scans; manual approval to promote.
- **prod:** manual approval; slot-based release; canary optional.

### 7.9 Compliance & runbooks
- Runbooks: incident response, evidence purge, invite-token compromise, LLM outage.
- Compliance evidence: audit-log export, tamper-evidence hash verification tool, RBAC test suite results.
- Alignment mapping: SOC 2 / ISO 27001 / SCF 2026.1 control coverage matrix (which control is satisfied by which platform mechanism).

### 7.10 Deliverables
- All three environments (dev / staging / prod) provisioned via IaC.
- One green end-to-end release from `main` → prod via the pipeline.
- Documented DR: PITR restore drill executed on a non-prod DB; Blob soft-delete + versioning verified.

### 7.11 Dependencies
- All prior phases produce deployable artifacts.

### 7.12 Exit criteria
- Prod is reachable only via Front Door + WAF; direct access to any backend service from public internet is blocked and demonstrated blocked.
- All secrets accessed via Managed Identity — zero static credentials in app config or source.
- A synthetic vendor + reviewer + risk-manager path completes in prod with disposition recorded, audit trail intact, AI content rendered with disclosure.

---

## Cross-Phase Sequencing & Parallelization

```
Phase 1: Foundation ────────────────────────────────────────────────►
                        │
                        ├──► Phase 2: Database ──────────────────────►
                        │                        │
                        ├──► Phase 3: Auth ──────┤
                        │                        │
                        │                        ├──► Phase 4: Backend (Slices A→D) ──►
                        │                        │                                     │
                        │                        │                                     ├──► Phase 5: Frontend ──►
                        │                        │                                     │
                        │                        │                                     └──► Phase 6: AI Engine ──►
                        │                                                                                        │
                        └──► Phase 7: Azure landing zone (parallel from start) ──► Full env provisioning ────────►
```

- **Phase 7 (Azure)** landing zone (networking, subscriptions, IaC skeleton, Key Vault) can start in parallel with Phase 2 to avoid a serialized critical path.
- **Phase 6 (AI Engine)** can be stubbed inside Phase 4 (a no-op worker that writes a placeholder `ai_generations` row), letting Phase 5 build against realistic shapes before real LLM integration lands.
- **Phase 5 (Frontend)** vendor surfaces can start as soon as Slice B of Phase 4 is contract-frozen (OpenAPI schema exported); reviewer/RM surfaces follow Slices C/D.

---

## Risks & Mitigations (top items)

- **RBAC drift between UI and API.** Mitigation: reference the same `/packages/shared` RBAC helpers on both sides; contract-test payload shape per role.
- **Vendor-token IDOR.** Mitigation: `assessment_id` never accepted as client input on vendor routes; server derives from token. Explicit test case in Phase 3.
- **AI prompt injection via vendor-supplied text.** Mitigation: allow-listed prompt schema in Phase 6; validator rejects any generation whose assembled prompt jsonb contains disallowed keys or interpolates free-form text into instruction blocks.
- **Retroactive weight change corrupts historical scores.** Mitigation: `responses.weight_at_response` snapshot + `is_final` risk-score rows are immutable; admin re-weight writes `control_weight_history` only.
- **LLM outage blocks reviewers.** Mitigation: submit flow does not synchronously wait on LLM; reviewer UI shows "pending" state cleanly; manual verdict path always available without AI content.
- **Audit-log tampering.** Mitigation: DB role has INSERT-only on `audit_log`; nightly hash-chain verification (optional stretch); Log Analytics dual-sink.

---

## Definition of Done (whole program)

- All 10 wireframe surfaces (1a–1j) are reachable in prod behind role-appropriate auth.
- Every endpoint in blueprint §4 is implemented, RBAC-tested, and audit-logged.
- Every design-note guarantee from blueprint §3.5 and §5 is exercised by an automated test.
- A vendor can be invited, self-assess, submit; two reviewers can review with AI assistance; a Risk Manager can dispose — end to end in prod, with a fully reconstructable audit trail including the exact AI outputs the reviewers saw.
