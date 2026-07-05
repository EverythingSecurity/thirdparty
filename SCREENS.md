# VSA Platform — Screen Specifications

Reference wireframes: `VSA Wireframes.dc.html`. IDs below match wireframe option IDs (1a–1j).

---

## 1a — Vendor Checklist: Stacked Cards + Domain Rail

**Purpose:** Primary self-assessment surface for vendor respondents; one question expanded at a time within a domain, grouped by control domain, to reduce cognitive load for non-technical users.

**Components:** Domain progress rail (left), expanded question card, collapsed question list, autosave indicator, token expiry badge, submit footer.

**Fields:**
- Response selector: Compliant / Non-Compliant / Not Applicable (single-select)
- Evidence upload (drag-and-drop + browse, multi-file)
- Justification (free text, required if N/A, optional otherwise)

**Buttons:** Save & Exit, Submit (locks), Expand/Collapse question, domain nav items.

**User Actions:** Select response option; upload/remove evidence; enter justification; navigate between domains/questions; save and resume later; final submit.

**Validation Rules:**
- Response is required before a question counts as "answered."
- Justification is mandatory and non-empty when response = Not Applicable.
- Evidence file type/size limits enforced client- and server-side (e.g., pdf/png/jpg/docx, ≤25MB).
- Submit button disabled until all required questions across all domains are answered (or explicitly N/A with justification).
- On submit, all responses become read-only; no further edits accepted by API.

**API Calls:**
- `GET /api/vendor/session/:token` — validate invite token, load assigned checklist + prior draft.
- `PATCH /api/vendor/responses/:questionId` — autosave a single response (debounced).
- `POST /api/vendor/evidence/:questionId` — upload evidence file, returns file metadata (not content) for later AI prompt use.
- `DELETE /api/vendor/evidence/:fileId` — remove uploaded evidence pre-submission.
- `POST /api/vendor/submit` — finalize submission; server generates immutable hash + timestamp, rejects if already submitted or token expired.

---

## 1b — Vendor Checklist: Two-Pane Guided Wizard

**Purpose:** Linear, one-question-at-a-time flow for guided completion; reduces overwhelm for first-time or infrequent respondents.

**Components:** Left question-list rail (done/current/upcoming states), right focused-question panel, per-domain navigation (prev/next domain).

**Fields:** Same as 1a — response radio (Compliant/Non-Compliant/N-A), justification textarea, evidence attach.

**Buttons:** Next Question, Previous Question, prev/next domain, Save & Exit, Submit (on final question).

**User Actions:** Answer current question; attach evidence; move forward/back through the list; jump to any previously-visited question via the rail; submit at end of last domain.

**Validation Rules:**
- "Next" disabled until current question has a valid response (and justification if N/A).
- Rail shows question state (done / in-progress / not started) computed from saved responses.
- Cannot jump ahead of the first unanswered required question (soft guardrail; still resumable).
- Same immutability rule on final submit as 1a.

**API Calls:**
- `GET /api/vendor/session/:token`
- `GET /api/vendor/questions?domain=:domainId` — paginated question fetch per domain.
- `PATCH /api/vendor/responses/:questionId` — autosave on Next/Prev.
- `POST /api/vendor/evidence/:questionId`
- `POST /api/vendor/submit`

---

## 1c — Vendor Checklist: Dense Grid (Power Respondent Mode)

**Purpose:** High-density, all-questions-visible layout for returning vendors or admins-on-behalf-of-vendor completing large checklists quickly.

**Components:** Sortable/filterable question table (control ID, weight, question, response, evidence icon), inline expand-in-place row for justification/evidence.

**Fields:** Inline response dropdown per row (Compliant/Non-Compliant/N-A); expandable justification textarea; evidence dropzone (appears on expand or when N/A selected).

**Buttons:** Row expand/collapse (▾), Submit (locks), evidence icon (📎 upload / ✎ edit justification).

**User Actions:** Set response per row via dropdown; expand a row to add justification/evidence; filter/search questions; bulk-review before submit.

**Validation Rules:**
- Row cannot be marked N/A without expanding and completing justification (auto-expands and flags row).
- Visual warning state (highlighted row) for any incomplete required field.
- Submit blocked with inline error list if any required field is missing, listing offending control IDs.
- Immutable-lock behavior identical to 1a/1b.

**API Calls:**
- `GET /api/vendor/session/:token`
- `GET /api/vendor/checklist` — full flattened question set with weights and current responses.
- `PATCH /api/vendor/responses/:questionId`
- `POST /api/vendor/evidence/:questionId`
- `POST /api/vendor/submit`
- `GET /api/vendor/submit/validate` — pre-submit dry-run returning list of incomplete required fields.

---

## 1d — Reviewer Window: Three-Column Sidecar (Cyber/Legal)

**Purpose:** Domain-scoped review workspace where AI analysis sits beside (never replaces) the vendor's raw response, supporting human-in-the-loop verification.

**Components:** My-domains rail (flags non-compliant controls), vendor-response pane (read-only), AI sidecar with Summary/Gaps/Remediation tabs, raw⇄AI toggle, decision control.

**Fields:** None editable in vendor pane (read-only). AI sidecar: editable text area when reviewer chooses "Edit" on AI output. Decision dropdown: Approve / Request More Info / Escalate / Reject. Comment field (free text, logged).

**Buttons:** Accept, Edit, Override (per AI output), Decision ▾, tab switches (Summary/Gaps/Fix), Raw/AI toggle, Regenerate AI (⟳).

**User Actions:** Browse domain-scoped controls; inspect vendor response + evidence metadata; read AI summary/gap/remediation; accept AI text as-is, edit it, or override with own text; record decision + comment; regenerate AI output if evidence changed.

**Validation Rules:**
- Reviewer can only see controls mapped to their role's domain (server-enforced, not just UI filter).
- A decision requires at least Accept/Edit/Override to be resolved on every Non-Compliant control in-domain before the reviewer's overall recommendation can be submitted.
- Every Accept/Edit/Override action is logged with reviewer ID, timestamp, and the exact AI output shown at that time (immutable log entry).
- "Override" requires a comment explaining the deviation from AI output.

**API Calls:**
- `GET /api/review/:vendorId/domain/:domainRole` — scoped controls + vendor responses (RBAC-filtered server-side).
- `GET /api/ai/summary/:vendorId?domain=:domainRole` — fetch cached AI summary/gap/remediation.
- `POST /api/ai/regenerate/:vendorId?domain=:domainRole` — trigger on-demand regeneration (queues LLM call, logs prompt+response).
- `POST /api/review/:vendorId/control/:controlId/verdict` — { action: accept|edit|override, text, comment }.
- `POST /api/review/:vendorId/decision` — { decision, comment }.
- `GET /api/audit/log/:vendorId` — read-only trail for compliance display.

---

## 1e — Reviewer Window: AI-First Briefing

**Purpose:** Executive-style briefing for reviewers who want a synthesized narrative first, with ranked gap cards (weight-sorted) and inline remediation, toggling to raw data only to verify.

**Components:** Executive summary card, ranked gap-card list (severity-ordered), raw/AI toggle, regenerate control, decision footer.

**Fields:** Per-gap-card Accept/Edit/Override state; final decision (Approve/Request Info/Escalate/Reject) + comment.

**Buttons:** Raw/AI View toggle, Regenerate (⟳), Accept/Edit/Override per gap card, Request Info, Escalate, Submit Review.

**User Actions:** Read exec summary; scan ranked gaps by weight/severity; expand a gap card to view underlying raw response (via toggle); action each gap; submit overall review decision.

**Validation Rules:**
- Gap cards are sorted server-side by (weight × non-compliance); order not user-editable, ensuring highest-risk items surface first.
- Submit Review disabled until every "CRITICAL" and "MEDIUM"-flagged gap card has a recorded verdict.
- AI-generated label always visible and cannot be dismissed/hidden permanently (persists per session).
- Regenerate only enabled if vendor evidence/response changed since last AI generation (checked via version/hash comparison).

**API Calls:**
- `GET /api/review/:vendorId/domain/:domainRole`
- `GET /api/ai/summary/:vendorId?domain=:domainRole&format=briefing`
- `POST /api/ai/regenerate/:vendorId?domain=:domainRole`
- `POST /api/review/:vendorId/control/:controlId/verdict`
- `POST /api/review/:vendorId/decision`

---

## 1f — Reviewer Window: Per-Control Accordion

**Purpose:** Densest, most audit-trail-friendly layout — each control is a self-contained row with vendor claim, AI gap+fix, and reviewer verdict together, ideal for methodical control-by-control sign-off.

**Components:** Accordion list (one row per in-domain control), split panel per expanded row (vendor claim+evidence | AI gap+fix), verdict action bar per row, top-level AI disclosure banner + control/gap counter.

**Fields:** Per-row verdict (Accept AI / Edit / Override) with optional comment; rows collapse/expand independently.

**Buttons:** Row expand/collapse (▾/▸), Accept AI, Edit, Override (per row), Raw / Raw+AI toggle.

**User Actions:** Expand each control row in turn; compare vendor evidence against AI-flagged gap and suggested fix side-by-side; record verdict per control; collapse once resolved to track progress visually (resolved rows dim/collapse).

**Validation Rules:**
- All Non-Compliant-flagged rows must have a verdict before the reviewer's section is marked "complete" in the parent dashboard.
- Override requires a mandatory comment (same rule as 1d).
- Compliant-rated controls are collapsed by default and read-only (no AI gap generated, per spec — gaps only generated for non-compliant items).
- Every expand/verdict action timestamped in the audit trail (not just final decision).

**API Calls:**
- `GET /api/review/:vendorId/domain/:domainRole`
- `GET /api/ai/gaps/:vendorId?domain=:domainRole` — per-control gap+remediation objects only (lighter payload than full briefing).
- `POST /api/review/:vendorId/control/:controlId/verdict`
- `GET /api/audit/log/:vendorId?controlId=:controlId` — per-control audit detail on demand.

---

## 1g — Risk Manager: Single-Vendor Verdict

**Purpose:** Final disposition screen — normalized aggregate score, tier, and domain sub-scores ranked worst-first so the Risk Manager can see at a glance which domain is driving risk before deciding.

**Components:** Score hero (0–100 + tier badge), aggregate progress track, domain sub-score bars (sorted descending by risk), disposition action bar.

**Fields:** None directly editable except disposition decision + comment (required for Reject/Conditional).

**Buttons:** Approve ▾ (may include sub-options e.g. "Approve with conditions logged"), Conditional, Reject.

**User Actions:** Review aggregate score and per-domain breakdown; drill into a domain bar to jump to that domain's reviewer output; select final disposition; enter justification comment; confirm.

**Validation Rules:**
- Disposition requires all reviewer roles (Cyber, Legal) to have submitted their decisions first (blocked with explanatory message otherwise).
- Reject or Conditional requires a non-empty comment.
- Once disposition is submitted, the vendor record locks (no further checklist or reviewer edits) except through a formal re-assessment cycle.
- Score/tier shown must match the last-finalized calculation; any post-submission evidence change (re-assessment) requires explicit recalculation, never silent update.

**API Calls:**
- `GET /api/risk/:vendorId/score` — aggregate + domain sub-scores (normalized 0–100 + tier).
- `GET /api/risk/:vendorId/reviewer-status` — completion state per reviewer role.
- `POST /api/risk/:vendorId/disposition` — { decision: approve|conditional|reject, comment }.
- `GET /api/audit/log/:vendorId?scope=disposition`.

---

## 1h — Risk Manager: Vendor Portfolio Table

**Purpose:** Risk Manager's queue/landing view across all vendors — score, tier, worst domain, and review status at a glance, to prioritize which vendors need attention.

**Components:** Sortable/filterable vendor table (vendor name, score, tier, worst domain, status), status legend, row click-through to 1g.

**Fields:** Column sort controls; filter by tier/status; search by vendor name.

**Buttons:** Sort headers (Score, Tier, Status), row (opens vendor detail = 1g), "Assign vendor" / "Send checklist" (admin-adjacent action if permitted).

**User Actions:** Sort/filter the portfolio; search for a vendor; click a row to open that vendor's disposition screen; identify vendors stuck in "awaiting vendor" or "escalated" states.

**Validation Rules:**
- Only vendors assigned to or visible under this Risk Manager's scope are listed (org/BU-based RBAC filter, server-enforced).
- Score/tier column shows "—" for vendors with no finalized submission yet (not a fabricated placeholder score).
- Status values constrained to a fixed enum: Sent, Awaiting Vendor, In Review, Escalated, Approved, Conditional, Rejected.

**API Calls:**
- `GET /api/risk/portfolio?sort=:field&filter=:tier` — paginated vendor list with score/tier/status summary.
- `GET /api/risk/:vendorId/score` (on row click, prefetch for 1g).

---

## 1i — Risk Manager: Score Contribution Breakdown

**Purpose:** Explainability view — shows exactly how much each domain's non-compliant weight contributes to the final 0–100 score, making the number defensible to auditors/regulators.

**Components:** Aggregate score header, segmented contribution bar (proportional stacked bar by domain), domain contribution legend/list with named controls driving each contribution, AI cross-domain note.

**Fields:** None editable — this is a read-only analytical view.

**Buttons:** Export/print breakdown (for audit record), link-through from each domain segment to underlying controls (1d/1e/1f).

**User Actions:** Inspect which domains and specific controls contributed most to the score; click through to the underlying non-compliant controls; export the breakdown for audit documentation.

**Validation Rules:**
- Contribution percentages must sum to the displayed aggregate score's risk portion (100% of the "risk" bar, not of 100 points) — computed server-side, not client-derived, to prevent tampering.
- AI cross-domain note is labeled AI-generated and does not affect the numeric score (informational only).
- Breakdown is only viewable after checklist submission is finalized (no partial/live breakdown shown to Risk Manager — that's Admin's live-recalc view).

**API Calls:**
- `GET /api/risk/:vendorId/score-breakdown` — per-domain contribution + contributing control IDs.
- `GET /api/ai/cross-domain-note/:vendorId`.
- `GET /api/risk/:vendorId/export` — generates audit-ready PDF/CSV of the breakdown.

---

## 1j — Admin Console: Control Library, Weights & Routing

**Purpose:** Administrative surface for managing the SCF control library, question bank, weightings, vendor assignments, and stakeholder routing — the configuration backbone driving scoring and RBAC across all other screens.

**Components:** Tab bar (Control Library / Question Bank / Assignments / Routing), control table (control ID, description, source, weight slider/input, routed-to role), domain filter, custom-control creation.

**Fields:**
- Weight (1–10, numeric/slider input) per control.
- Source (read-only "SCF" tag for framework controls; editable label for custom controls).
- Routed-to role(s) (multi-select: Cyber / Legal / Risk Manager / both).
- Custom control: ID, name, description, weight, domain, routing (all editable on create).

**Buttons:** + Custom Control, tab switches, domain filter dropdown, per-row save/edit weight, per-row routing edit.

**User Actions:** Filter controls by domain; adjust a control's weight; change which reviewer role a control routes to; add a net-new custom control not in SCF; switch to Question Bank to manage question text mapped to controls; switch to Assignments to assign checklists to vendors; switch to Routing to configure org-wide stakeholder routing rules.

**Validation Rules:**
- Weight must be an integer 1–10.
- Weight changes are versioned, not destructive — historical scores on already-locked vendor submissions are never retroactively recalculated; only future assessments use the new weight.
- A control cannot be deleted if it has any responses tied to it (soft-delete/deprecate only).
- Custom control ID must be unique and follow a reserved prefix (e.g., `CUS-##`) to avoid collision with SCF IDs.
- Only Admin role can access this console; enforced server-side on every endpoint below.

**API Calls:**
- `GET /api/admin/controls?domain=:domainId` — list controls with weights/routing.
- `PATCH /api/admin/controls/:controlId` — update weight/routing (creates a new version record).
- `POST /api/admin/controls` — create custom control.
- `GET /api/admin/questions?controlId=:controlId` — question bank scoped to a control.
- `POST /api/admin/vendors/:vendorId/assign-checklist` — assign checklist + generate invite token.
- `POST /api/admin/routing-rules` — configure domain-to-role routing defaults.
- `GET /api/audit/log?scope=admin-config` — full change history for compliance review.

---

## Cross-Cutting Notes (apply to all screens)

- **RBAC:** every API call above is scoped server-side by role + vendor/domain assignment; a Vendor token can never receive Reviewer/Admin payloads, and a Cyber Reviewer never receives Legal-only control data (and vice versa) regardless of UI state.
- **Audit logging:** all state-changing calls (`PATCH`/`POST`/`DELETE`) write an immutable audit record: actor, timestamp, before/after value, and — for AI-related calls — the exact prompt and response shown to the user.
- **AI disclosure:** any AI-generated content is rendered with a persistent "AI-Generated — Human Review Required" label and is never used to auto-finalize a decision field.
- **Immutability:** once a vendor checklist is submitted, or a Risk Manager disposition is recorded, the underlying record is locked; further changes require a formal, logged re-assessment/reopen action, not a silent edit.
