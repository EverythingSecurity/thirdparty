# VSA Platform — Security Design

Scope: authentication, authorization, audit logging, data encryption, key management, monitoring, and threat model for the Vendor Security Assessment application. Complements `SOLUTION_BLUEPRINT.md` §5; this document is the detailed reference.

---

## 1. Authentication

### 1.1 Staff Users (Admin, Cyber Reviewer, Legal Reviewer, Risk Manager)
- Federated via **Microsoft Entra ID (OIDC/OAuth 2.0 Authorization Code + PKCE)**. No locally-stored passwords.
- **MFA mandatory**, enforced at the identity provider via Conditional Access policy (block sign-in if MFA not satisfied).
- On successful login, API issues a short-lived **JWT access token** (~15 min TTL; claims: `sub`, `org_id`, `role`, `iat`, `exp`, `jti`) signed with an org-specific key from Key Vault.
- A **rotating refresh token** is stored in an `httpOnly`, `Secure`, `SameSite=Strict` cookie; refresh rotates on every use (reuse of a stale refresh token revokes the whole session chain — detects token theft).
- Conditional Access: block sign-in from disallowed geographies/impossible-travel patterns (configurable per org).
- Session idle timeout: 15 min access token life forces silent refresh; absolute session cap of 12 hours.

### 1.2 Vendor Respondents (no standing account)
- Access is a **single-use, time-bound invite link**: `https://vsa.example.com/respond/{token}`.
- Token is opaque, cryptographically random (≥256-bit entropy), generated server-side. Only a **salted hash** (`vendor_invites.token_hash`) is persisted — the raw token is never logged, stored in plaintext, or emailed in a way that's retrievable after the fact by support staff.
- Token carries no claims itself; it is a lookup key resolved server-side to exactly one `assessment_id` + `vendor_id`. It is never trusted to encode identity — every request re-validates against the DB (expiry, revocation, redemption state).
- Expiry: default 14 days (configurable), enforced both by `expires_at` check and independently at the edge (Front Door rule can reject obviously-expired links to reduce backend load).
- Revocable by Admin at any time (`revoked_at`); revocation takes effect on the next request, no caching of validity.
- No password, no self-service account creation — eliminates credential-stuffing and password-reset attack surface for the respondent population entirely.

### 1.3 Service-to-Service (Worker ↔ API ↔ LLM)
- Background workers and the API authenticate to Azure resources via **Managed Identity** — no static credentials in app config, containers, or source.
- Calls to the LLM endpoint (Azure OpenAI or Anthropic via API Management) use an API key stored in Key Vault, injected at runtime only.

---

## 2. Authorization

### 2.1 Model
Role-Based Access Control (RBAC) with five fixed roles: `vendor` (token-scoped, not a JWT role), `admin`, `cyber_reviewer`, `legal_reviewer`, `risk_manager`. No custom/ad-hoc roles in v1 — keeps the authorization matrix auditable.

### 2.2 Enforcement Layers (defense in depth)
1. **Service/query layer (primary):** every list/detail endpoint's data-access function takes the caller's role + org/vendor scope as a mandatory argument and adds the corresponding predicate to the query. Fields the role shouldn't see are never selected into the response object — not filtered post-hoc.
2. **Postgres Row-Level Security (RLS) (defense in depth):** RLS policies on `responses`, `reviewer_verdicts`, `review_decisions`, `risk_scores`, `dispositions`, and `audit_log` enforce `organization_id` match plus role-specific predicates (e.g. a `cyber_reviewer` DB role can only `SELECT` `responses` joined through `routing_rules` where `role = 'cyber_reviewer'`). This protects against an application-layer bug that forgets a WHERE clause.
3. **API gateway/route layer:** coarse-grained checks (e.g. `/admin/*` requires `role = admin`) reject obviously out-of-scope calls before hitting business logic — cheap first filter, not the source of truth.

### 2.3 Authorization Matrix (summary)

| Resource | Vendor (own token) | Cyber Reviewer | Legal Reviewer | Risk Manager | Admin |
|---|---|---|---|---|---|
| Own checklist (`responses`, `evidence_files`) | Read/Write (pre-submit) | — | — | — | — |
| Other vendors' data | ✗ | ✗ | ✗ | ✗ | ✗ (unless assigned to org) |
| Reviewer verdicts / AI panel — Cyber-routed controls | ✗ | Read/Write | ✗ | Read (audit) | Read |
| Reviewer verdicts / AI panel — Legal-routed controls | ✗ | ✗ | Read/Write | Read (audit) | Read |
| Aggregate score, domain sub-scores, disposition | ✗ | ✗ | ✗ | Read/Write | Read |
| Vendor portfolio (cross-vendor) | ✗ | ✗ | ✗ | Read | Read |
| Control library, weights, routing | ✗ | Read (own domain) | Read (own domain) | Read | Read/Write |
| Vendor assignment / invite issuance | ✗ | ✗ | ✗ | ✗ | Read/Write |
| Full audit log | ✗ (none) | Domain-scoped only | Domain-scoped only | Full (org) | Full (org) |

### 2.4 Key Rules
- A vendor token **never** resolves to another vendor's `assessment_id` — the ID is derived server-side from the token, never accepted as a client-supplied path/query parameter.
- Reviewer domain scoping is **data-driven** via `routing_rules` (control → role mapping), not hardcoded per screen — keeps Cyber/Legal boundaries correct as the control library evolves without a code change.
- Admin-only endpoints return `403` for every other role unconditionally, regardless of any UI state.
- Overriding an AI output requires a mandatory comment (prevents silent unexplained deviations) — enforced by both API validation and a DB check constraint.
- A disposition cannot be recorded until both routed reviewer roles (Cyber, Legal) have submitted a decision — enforced server-side, not just a disabled button.

---

## 3. Audit Logging

### 3.1 What Is Logged
Every state-changing action platform-wide writes one row to the append-only `audit_log` table, in the **same transaction** as the mutation (never fire-and-forget, never eventually-consistent):
- Actor (`actor_user_id` or `actor_vendor_invite_id` — never both null).
- Action (e.g. `response.update`, `evidence.upload`, `ai.regenerate`, `review.verdict.override`, `disposition.record`, `control.weight.update`).
- Entity type + entity ID (polymorphic reference).
- Before/after value (`jsonb`) — full field-level diff, not just "something changed."
- Timestamp.

### 3.2 AI-Specific Logging
- Every `ai_generations` row stores the **exact prompt sent** (`jsonb`: question text, control ID, vendor response, justification, evidence metadata, weight) and the **exact response received**, satisfying the "why did the AI say this" explainability requirement.
- `reviewer_verdicts.ai_generation_id` pins each human verdict to the specific AI output shown at that moment — so a later regeneration doesn't retroactively change what the audit trail says the reviewer saw.
- Regenerations are versioned (`superseded_by`), never overwritten in place — the full generation history for a control survives.

### 3.3 Immutability Guarantees
- `audit_log` grants: the application's DB role has `INSERT` only; `UPDATE`/`DELETE` are `REVOKE`d at the Postgres level, so even a compromised app tier cannot rewrite history via SQL.
- `responses.is_locked` and `assessments.submission_hash` (SHA-256 over the finalized response set) make vendor submissions tamper-evident: any post-hoc edit would require creating a new, separately logged re-assessment cycle, not a mutation of the original row.
- Log retention: minimum aligned to the org's compliance requirement (e.g. 7 years for SOC 2/contractual audit needs), enforced via immutable storage policy (see §4) rather than app-level TTL alone.

### 3.4 Access to Audit Data
- Risk Manager and Admin: full org-wide audit trail.
- Reviewers: audit entries scoped to their routed domain plus their own actions only.
- Vendors: no audit log access (they only see their own checklist state, never review/scoring metadata).

---

## 4. Data Encryption

### 4.1 In Transit
- TLS 1.2+ enforced everywhere; Azure Front Door / Application Gateway terminates public TLS and re-encrypts to backend services (no plaintext hop inside the VNet).
- HSTS enabled on all public endpoints; internal service-to-service calls also run over TLS within the private network.

### 4.2 At Rest
- **Relational data:** Azure Database for PostgreSQL Flexible Server with Transparent Data Encryption (TDE), AES-256, at the storage layer.
- **Evidence files:** stored in Azure Blob Storage (private container, no public access), encrypted at rest with either Microsoft-managed keys or customer-managed keys (CMK) via Key Vault, depending on customer contractual requirement.
- **Backups:** PostgreSQL automated backups and point-in-time restore snapshots inherit the same encryption-at-rest posture; backup storage account also private-endpoint-only.
- **Secrets:** never stored at rest outside Key Vault (see §5).

### 4.3 Application-Level Data Handling
- Evidence files are **never transmitted to the LLM** — only structured metadata (file name, size, mime type) is included in AI prompts, per the AI Integration Requirements. Raw bytes are retrieved by a reviewer only via a short-lived, signed SAS URL generated on demand.
- Vendor justification free-text and evidence metadata are stored as-is (needed for scoring/audit) but are never rendered outside their authorized role scope (§2).
- PII minimization: only a primary contact email is stored per vendor; no vendor personnel PII beyond what TPM-06 (personnel security) responses require as free text (which stays within the vendor's own responses, RBAC-scoped as usual).

---

## 5. Key Management

- **Azure Key Vault** is the single source of truth for: database connection secrets, JWT signing keys, LLM API keys, blob storage customer-managed keys (CMK), and any third-party integration secrets (e.g. email provider for invite delivery).
- **Managed Identity** is used by the API, background workers, and CI/CD pipeline to authenticate to Key Vault — no key/secret is ever embedded in source, container images, or environment files.
- **Key rotation:** JWT signing key rotated on a schedule (e.g. quarterly) with overlap period (both old and new key accepted for verification during rotation window) so in-flight tokens don't fail; DB credentials rotated via Key Vault's managed rotation policy; CMK rotation follows Azure Storage's built-in rotation support.
- **Access policies:** Key Vault access scoped per-identity (API's managed identity can read secrets it needs, cannot list/read secrets belonging to unrelated services); break-glass access for human operators requires just-in-time elevation (Azure PIM), logged.
- **Separation by environment:** dev/staging/prod each have their own Key Vault instance — a staging secret leak cannot compromise production.

---

## 6. Monitoring

### 6.1 What's Monitored
- **Azure Monitor + Application Insights:** request latency/error rates per endpoint, dependency call health (DB, Blob, LLM), custom events for business-critical actions (submission, disposition, AI regeneration).
- **Log Analytics:** centralized structured log sink; `audit_log` inserts are also streamed here (or mirrored) so security/compliance teams have a SIEM-queryable copy independent of the primary transactional DB.
- **Microsoft Defender for Cloud:** WAF alerting (Front Door), storage malware-scan alerts (uploaded evidence), SQL/PostgreSQL advanced threat protection (anomalous query patterns, potential injection attempts).

### 6.2 Alerting Triggers
- Repeated `401`/`403` responses from a single token/IP (possible token brute-force or scraping) → alert + auto rate-limit/backoff.
- Any direct `UPDATE`/`DELETE` attempt against `audit_log` (should be structurally impossible given grants — alerting on the attempt itself signals a compromised credential).
- Disposition or reviewer-decision endpoints called outside expected role → should never occur given RBAC; alert immediately as a potential authorization-bypass attempt.
- AI regeneration volume spikes (possible abuse of LLM spend / prompt injection probing).
- Vendor invite token validation failures spiking from a single source (enumeration attempt).
- Anomalous privilege pattern: a staff account suddenly accessing an unusually large number of vendors/orgs in a short window.

### 6.3 Dashboards & Reporting
- Ops dashboard: API health, queue depth (Service Bus), AI job latency/failure rate.
- Security dashboard: authentication failures, WAF blocks, Defender findings, Key Vault access anomalies.
- Compliance dashboard: audit log volume/integrity checks, overdue re-assessments, disposition SLA tracking.

---

## 7. Threat Model (STRIDE)

| Threat category | Example scenario | Mitigation |
|---|---|---|
| **Spoofing** | Attacker guesses/brute-forces a vendor invite token to access another vendor's checklist. | 256-bit opaque tokens, salted-hash storage, rate limiting + WAF bot rules on the respond endpoint, short expiry, revocation, alerting on repeated invalid-token attempts. |
| **Spoofing** | Stolen staff JWT reused after logout/role change. | Short (~15 min) access-token TTL, refresh-token rotation with reuse detection, Entra ID Conditional Access (device/location checks), immediate revocation path via Entra ID. |
| **Tampering** | Vendor or compromised client attempts to edit a response after submission. | `responses.is_locked` + API `409` rejection on locked assessments; DB constraint backs the API check; `submission_hash` lets any party verify the submitted set wasn't altered post-hoc. |
| **Tampering** | Malicious actor tries to modify `audit_log` rows to hide an override. | `INSERT`-only DB grant on `audit_log` (UPDATE/DELETE revoked), immutable storage policy on the Log Analytics mirror, alert on any denied write attempt. |
| **Tampering** | Reviewer or Admin edits a control's weight to retroactively change a finalized score. | `responses.weight_at_response` snapshots weight at answer time; `risk_scores.is_final` locked snapshot; weight changes only affect future assessments (`control_weight_history` is append-only, never mutates a past response). |
| **Repudiation** | A reviewer denies having overridden an AI recommendation. | Every verdict logged with actor, timestamp, exact AI output shown (`ai_generation_id`), and mandatory comment on override — non-repudiable, queryable audit trail. |
| **Information Disclosure** | A Cyber Reviewer's session/API call returns Legal-only control data (e.g. contract terms) via a missing filter. | RBAC enforced at the query layer (fields never selected, not just hidden) plus Postgres RLS as a second independent layer; automated tests assert cross-role payload shape per endpoint. |
| **Information Disclosure** | Evidence files (e.g. contracts, pen-test reports) exposed via a guessable Blob URL. | Private containers only, no public access, time-limited SAS tokens generated per authorized request, Defender for Storage anomaly alerts on unusual access patterns. |
| **Information Disclosure** | Vendor's free-text justification is used to craft a prompt-injection attack that leaks other vendors' data via the LLM. | Prompts are built server-side from a fixed allow-listed field set with vendor text clearly delimited from system instructions; LLM call is scoped per-vendor with no cross-vendor context ever included in a single prompt; output is treated as untrusted display text, not executed or interpolated back into further privileged instructions. |
| **Denial of Service** | Flood of invite-link requests or AI-regeneration calls exhausts backend/LLM budget. | Front Door WAF rate limiting, per-token/per-JWT rate limits at the API, async queueing (Service Bus) so AI load can't block the request path, `409` short-circuit when regeneration isn't actually needed (unchanged evidence). |
| **Elevation of Privilege** | A vendor token is replayed against a staff-only endpoint. | Staff endpoints require a valid Entra ID-issued JWT with a specific `role` claim; vendor tokens are a structurally different, opaque credential type that staff-endpoint middleware rejects outright (not merely role-checked — wrong credential shape entirely). |
| **Elevation of Privilege** | A reviewer attempts to directly call the disposition endpoint reserved for Risk Manager. | Route-layer role check (`role = risk_manager`) plus service-layer re-check plus RLS — three independent layers must all agree; endpoint additionally validates both reviewer decisions exist before accepting, closing a logic-bypass path even for a legitimately-scoped caller. |

### 7.1 Residual Risk & Assumptions
- Assumes Entra ID tenant itself is properly hardened (Conditional Access, admin account protections) — platform trusts the IdP as a root of trust for staff identity.
- Assumes the LLM provider does not retain or train on submitted prompts beyond the platform's data-processing agreement; contractual controls (equivalent to what this platform recommends to its own users) apply to the LLM vendor relationship as well.
- Physical/host-level security of Azure infrastructure is Microsoft's shared-responsibility boundary; this document covers the application/tenant layer.
