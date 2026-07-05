/**
 * AI generation orchestrator.
 *
 * Data flow on submit (Sprint 3 inline; Sprint 6 async via Service Bus):
 *   1. Load routed controls per reviewer role (via `routing_rules`).
 *   2. For each role:
 *        - Build a single `summary` prompt over all routed controls.
 *        - For each NON-COMPLIANT routed control:
 *            build a `gap_analysis` prompt and a `remediation` prompt.
 *   3. Call the provider; persist each result as an `ai_generations` row.
 *   4. Also build one assessment-scoped `cross_domain_note` for risk-manager
 *      surface (no role scope).
 *
 * Regeneration:
 *   - Marks all prior rows for the same (scope, kind) as `is_stale=true` and
 *     sets `superseded_by` to the new row id. NEVER overwrites prior rows —
 *     blueprint §5.5 requires an immutable version chain for audit.
 *   - Short-circuits with a 409 if the input hash matches the last generation
 *     for the same scope AND the caller didn't pass `force=true`.
 */
import type { Prisma, PrismaClient } from '@prisma/client';
import { ConflictError, NotFoundError } from '@vsa/shared';
import type { Principal } from '@vsa/shared';
import type { PrismaTx } from '../audit.js';
import { writeAudit } from '../audit.js';
import type {
  PersistedPrompt,
  PromptControl,
  PromptEvidenceMetadata,
  ReviewerScopeRole,
} from './prompt.js';
import { buildPrompt, promptInputHash } from './prompt.js';
import type { LlmProvider } from './provider.js';
import { getLlmProvider } from './provider.js';

const REVIEWER_ROLES: ReviewerScopeRole[] = ['cyber_reviewer', 'legal_reviewer'];

interface RoutedControlRow {
  controlId: string;
  controlCode: string;
  controlTitle: string;
  domainName: string;
  weight: number;
  questionText: string;
  responseValue: 'compliant' | 'non_compliant' | 'not_applicable';
  justification: string;
  evidence: PromptEvidenceMetadata[];
}

/**
 * Load the assessment's response set already narrowed to controls routed to
 * `role`. Non-compliance filter is applied by the caller; this returns the
 * full routed slice so summary + gap generators can share one query.
 */
async function loadRoutedControls(
  prisma: PrismaClient,
  assessmentId: string,
  role: ReviewerScopeRole,
): Promise<RoutedControlRow[]> {
  const rows = await prisma.response.findMany({
    where: {
      assessmentId,
      responseValue: { not: null },
      control: { routingRules: { some: { role } } },
    },
    select: {
      weightAtResponse: true,
      responseValue: true,
      justification: true,
      question: { select: { questionText: true } },
      control: {
        select: {
          id: true,
          controlCode: true,
          title: true,
          controlDomain: { select: { name: true } },
        },
      },
      evidenceFiles: {
        where: { deletedAt: null },
        select: { fileName: true, fileSizeBytes: true, mimeType: true },
      },
    },
  });
  return rows.map((r) => ({
    controlId: r.control.id,
    controlCode: r.control.controlCode,
    controlTitle: r.control.title,
    domainName: r.control.controlDomain.name,
    weight: r.weightAtResponse,
    questionText: r.question.questionText,
    responseValue: r.responseValue as RoutedControlRow['responseValue'],
    justification: r.justification ?? '',
    evidence: r.evidenceFiles.map((e) => ({
      file_name: e.fileName,
      file_size_bytes: Number(e.fileSizeBytes),
      mime_type: e.mimeType,
    })),
  }));
}

function toPromptControl(row: RoutedControlRow): PromptControl {
  return {
    control_id: row.controlId,
    control_code: row.controlCode,
    control_title: row.controlTitle,
    domain_name: row.domainName,
    weight: row.weight,
    question_text: row.questionText,
    response_value: row.responseValue,
    justification: row.justification,
    evidence_metadata: row.evidence,
  };
}

// ------------------------------------------------------------
// Persistence helpers
// ------------------------------------------------------------

async function markSupersededForScope(
  tx: PrismaTx,
  where: Prisma.AiGenerationWhereInput,
  newRowId: string,
): Promise<void> {
  await tx.aiGeneration.updateMany({
    where: { ...where, isStale: false, id: { not: newRowId } },
    data: { isStale: true, supersededById: newRowId },
  });
}

async function insertGeneration(
  tx: PrismaTx,
  data: {
    assessmentId: string;
    controlId?: string | null;
    controlDomainId?: string | null;
    prompt: PersistedPrompt;
    responseText: string;
    modelName: string;
  },
) {
  return tx.aiGeneration.create({
    data: {
      assessmentId: data.assessmentId,
      controlId: data.controlId ?? null,
      controlDomainId: data.controlDomainId ?? null,
      kind: data.prompt.kind,
      modelName: data.modelName,
      prompt: data.prompt as unknown as Prisma.InputJsonValue,
      responseText: data.responseText,
    },
    select: { id: true, kind: true, generatedAt: true },
  });
}

// ------------------------------------------------------------
// Public API — used by submit + regenerate endpoints
// ------------------------------------------------------------

export interface GenerateResult {
  generated: number;
  by_kind: Record<string, number>;
}

/**
 * Full generation pass for a just-submitted assessment. Called out-of-tx from
 * the submit endpoint (Sprint 6 replaces with Service Bus dispatch). Failures
 * here do NOT roll back the submission — the reviewer will see "pending" AI
 * content and can trigger `/ai/regenerate` manually.
 */
export async function generateForAssessment(
  prisma: PrismaClient,
  assessmentId: string,
  actor: Principal,
  provider: LlmProvider = getLlmProvider(),
): Promise<GenerateResult> {
  const counts: Record<string, number> = {
    summary: 0,
    gap_analysis: 0,
    remediation: 0,
    cross_domain_note: 0,
  };

  for (const role of REVIEWER_ROLES) {
    const rows = await loadRoutedControls(prisma, assessmentId, role);
    if (rows.length === 0) continue;

    const summary = await generateForRoleScope(prisma, assessmentId, role, rows, actor, provider);
    counts.summary += summary.summaries;
    counts.gap_analysis += summary.gaps;
    counts.remediation += summary.remediations;
  }

  // Cross-domain note — scope = whole assessment, no role filter.
  const allRows = await prisma.response.findMany({
    where: { assessmentId, responseValue: 'non_compliant' },
    select: {
      control: {
        select: {
          id: true,
          controlCode: true,
          title: true,
          controlDomain: { select: { name: true } },
        },
      },
      weightAtResponse: true,
      justification: true,
      responseValue: true,
      question: { select: { questionText: true } },
    },
  });
  if (allRows.length > 0) {
    const inputs: PromptControl[] = allRows.map((r) =>
      toPromptControl({
        controlId: r.control.id,
        controlCode: r.control.controlCode,
        controlTitle: r.control.title,
        domainName: r.control.controlDomain.name,
        weight: r.weightAtResponse,
        questionText: r.question.questionText,
        responseValue: r.responseValue as RoutedControlRow['responseValue'],
        justification: r.justification ?? '',
        evidence: [],
      }),
    );
    const prompt = buildPrompt('cross_domain_note', 'cross_domain_v1', {}, inputs);
    const provResp = await provider.generate(prompt);
    await prisma.$transaction(async (tx) => {
      const created = await insertGeneration(tx as PrismaTx, {
        assessmentId,
        prompt,
        responseText: provResp.text,
        modelName: provResp.modelName,
      });
      await markSupersededForScope(
        tx as PrismaTx,
        { assessmentId, kind: 'cross_domain_note' },
        created.id,
      );
      await writeAudit(tx as PrismaTx, actor, {
        action: 'ai.generate',
        entityType: 'ai_generations',
        entityId: created.id,
        after: { kind: 'cross_domain_note', model: provResp.modelName },
      });
    });
    counts.cross_domain_note += 1;
  }

  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  return { generated: total, by_kind: counts };
}

interface RoleGenSummary {
  summaries: number;
  gaps: number;
  remediations: number;
}

async function generateForRoleScope(
  prisma: PrismaClient,
  assessmentId: string,
  role: ReviewerScopeRole,
  rows: RoutedControlRow[],
  actor: Principal,
  provider: LlmProvider,
): Promise<RoleGenSummary> {
  const inputs = rows.map(toPromptControl);

  // Summary — one row per (assessment, role).
  const summaryPrompt = buildPrompt('summary', 'summary_v1', { reviewer_role: role }, inputs);
  const summaryResp = await provider.generate(summaryPrompt);
  await prisma.$transaction(async (tx) => {
    const created = await insertGeneration(tx as PrismaTx, {
      assessmentId,
      prompt: summaryPrompt,
      responseText: summaryResp.text,
      modelName: summaryResp.modelName,
    });
    await markSupersededForScope(
      tx as PrismaTx,
      {
        assessmentId,
        kind: 'summary',
        prompt: {
          path: ['scope', 'reviewer_role'],
          equals: role,
        } as Prisma.JsonFilter,
      } as Prisma.AiGenerationWhereInput,
      created.id,
    );
    await writeAudit(tx as PrismaTx, actor, {
      action: 'ai.generate',
      entityType: 'ai_generations',
      entityId: created.id,
      after: { kind: 'summary', role, model: summaryResp.modelName },
    });
  });

  // Per-control gap + remediation (non-compliant only).
  const gaps = rows.filter((r) => r.responseValue === 'non_compliant');
  for (const row of gaps) {
    const gapInputs = [toPromptControl(row)];
    const gapPrompt = buildPrompt(
      'gap_analysis',
      'gap_analysis_v1',
      { control_id: row.controlId, reviewer_role: role },
      gapInputs,
    );
    const gapResp = await provider.generate(gapPrompt);
    const remediationPrompt = buildPrompt(
      'remediation',
      'remediation_v1',
      { control_id: row.controlId, reviewer_role: role },
      gapInputs,
    );
    const remResp = await provider.generate(remediationPrompt);
    await prisma.$transaction(async (tx) => {
      const gapRow = await insertGeneration(tx as PrismaTx, {
        assessmentId,
        controlId: row.controlId,
        prompt: gapPrompt,
        responseText: gapResp.text,
        modelName: gapResp.modelName,
      });
      await markSupersededForScope(
        tx as PrismaTx,
        { assessmentId, controlId: row.controlId, kind: 'gap_analysis' },
        gapRow.id,
      );
      const remRow = await insertGeneration(tx as PrismaTx, {
        assessmentId,
        controlId: row.controlId,
        prompt: remediationPrompt,
        responseText: remResp.text,
        modelName: remResp.modelName,
      });
      await markSupersededForScope(
        tx as PrismaTx,
        { assessmentId, controlId: row.controlId, kind: 'remediation' },
        remRow.id,
      );
      await writeAudit(tx as PrismaTx, actor, {
        action: 'ai.generate',
        entityType: 'ai_generations',
        entityId: gapRow.id,
        after: {
          kind: 'gap_analysis',
          control_id: row.controlId,
          companion_remediation_id: remRow.id,
        },
      });
    });
  }

  return {
    summaries: 1,
    gaps: gaps.length,
    remediations: gaps.length,
  };
}

/**
 * On-demand regeneration for one (assessment, reviewer_role). Returns the
 * new summary row id + generation count; 409 if input hash matches the
 * previous generation for the same scope and `force` is false.
 */
export async function regenerateForRole(
  prisma: PrismaClient,
  assessmentId: string,
  role: ReviewerScopeRole,
  actor: Principal,
  opts: { force?: boolean } = {},
  provider: LlmProvider = getLlmProvider(),
): Promise<RoleGenSummary> {
  const assessment = await prisma.assessment.findUnique({
    where: { id: assessmentId },
    select: { submittedAt: true },
  });
  if (!assessment || !assessment.submittedAt) {
    throw new NotFoundError('Submitted assessment not found');
  }

  const rows = await loadRoutedControls(prisma, assessmentId, role);
  if (rows.length === 0) throw new NotFoundError('No routed controls for this role');
  const inputs = rows.map(toPromptControl);
  const newHash = await promptInputHash(inputs);

  // Compare with the last summary row for this scope.
  const prior = await prisma.aiGeneration.findFirst({
    where: {
      assessmentId,
      kind: 'summary',
      isStale: false,
      prompt: {
        path: ['scope', 'reviewer_role'],
        equals: role,
      } as Prisma.JsonFilter,
    } as Prisma.AiGenerationWhereInput,
    orderBy: { generatedAt: 'desc' },
    select: { id: true, prompt: true },
  });
  if (prior && !opts.force) {
    const priorInputs = ((prior.prompt as unknown) as PersistedPrompt).inputs;
    const priorHash = await promptInputHash(priorInputs);
    if (priorHash === newHash) {
      throw new ConflictError(
        'unchanged_since_last_generation',
        'Inputs are unchanged since the last AI generation; pass force=true to regenerate anyway.',
      );
    }
  }

  return generateForRoleScope(prisma, assessmentId, role, rows, actor, provider);
}

// ------------------------------------------------------------
// Readers (used by /ai/summary + /ai/gaps)
// ------------------------------------------------------------

export interface AiSummaryResponse {
  kind: 'summary';
  generated_at: string;
  is_stale: boolean;
  model: string;
  content: string;
  disclosure: string;
}

export async function getLatestSummary(
  prisma: PrismaClient,
  assessmentId: string,
  role: ReviewerScopeRole,
): Promise<AiSummaryResponse | null> {
  const row = await prisma.aiGeneration.findFirst({
    where: {
      assessmentId,
      kind: 'summary',
      prompt: {
        path: ['scope', 'reviewer_role'],
        equals: role,
      } as Prisma.JsonFilter,
    } as Prisma.AiGenerationWhereInput,
    orderBy: { generatedAt: 'desc' },
    select: { id: true, generatedAt: true, isStale: true, modelName: true, responseText: true },
  });
  if (!row) return null;
  return {
    kind: 'summary',
    generated_at: row.generatedAt.toISOString(),
    is_stale: row.isStale,
    model: row.modelName,
    content: row.responseText,
    disclosure: 'AI-Generated — Human Review Required',
  };
}

export interface AiGapItem {
  control_id: string;
  control_code: string;
  weight: number;
  gap_narrative: string;
  remediation: string;
  gap_ai_generation_id: string;
  remediation_ai_generation_id: string;
  generated_at: string;
  is_stale: boolean;
  disclosure: string;
}

export async function getLatestGaps(
  prisma: PrismaClient,
  assessmentId: string,
  role: ReviewerScopeRole,
): Promise<AiGapItem[]> {
  // Load latest gap_analysis + remediation for each control routed to `role`.
  const controls = await prisma.control.findMany({
    where: {
      routingRules: { some: { role } },
      responses: { some: { assessmentId, responseValue: 'non_compliant' } },
    },
    select: { id: true, controlCode: true, currentWeight: true },
  });

  const items: AiGapItem[] = [];
  for (const c of controls) {
    const [gap, rem] = await Promise.all([
      prisma.aiGeneration.findFirst({
        where: { assessmentId, controlId: c.id, kind: 'gap_analysis' },
        orderBy: { generatedAt: 'desc' },
        select: { id: true, generatedAt: true, isStale: true, responseText: true },
      }),
      prisma.aiGeneration.findFirst({
        where: { assessmentId, controlId: c.id, kind: 'remediation' },
        orderBy: { generatedAt: 'desc' },
        select: { id: true, responseText: true },
      }),
    ]);
    if (!gap || !rem) continue; // both must exist to render a gap card
    items.push({
      control_id: c.id,
      control_code: c.controlCode,
      weight: c.currentWeight,
      gap_narrative: gap.responseText,
      remediation: rem.responseText,
      gap_ai_generation_id: gap.id,
      remediation_ai_generation_id: rem.id,
      generated_at: gap.generatedAt.toISOString(),
      is_stale: gap.isStale,
      disclosure: 'AI-Generated — Human Review Required',
    });
  }
  // Blueprint 1e: sort by weight × severity, worst first. Severity=1 for now.
  items.sort((a, b) => b.weight - a.weight);
  return items;
}
