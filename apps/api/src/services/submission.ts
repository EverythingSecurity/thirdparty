/**
 * Assessment submission — validation, canonicalization, tamper-evident hash,
 * and row locking. Everything runs in ONE database transaction so a partial
 * commit can't leave an assessment "half-submitted".
 *
 * Design (blueprint §3.5 & §5.4):
 *   - On submit, we canonicalize the response set to a stable byte string,
 *     SHA-256 it, and store as `submission_hash`. Any later mutation (which
 *     shouldn't happen because responses are also locked) is detectable by
 *     re-computing the hash.
 *   - Every `responses` row for this assessment flips `is_locked = true`;
 *     downstream mutating routes reject writes to locked rows.
 *   - Status transitions to `submitted`. AI generation (Sprint 6) will be
 *     kicked off by a Service Bus message from the caller.
 *
 * Canonicalization contract:
 *   - Responses sorted by question_id (uuid string sort — deterministic).
 *   - Each response serialized as a fixed-order tuple of scalar fields.
 *   - Evidence file IDs sorted, included as an array of ids only (not names /
 *     sizes — those can be renamed without changing the substantive answer).
 *   - Output is a UTF-8 JSON string with no whitespace variance. This is NOT
 *     the same as arbitrary JSON.stringify (which preserves insertion order);
 *     the canonicalizer here uses explicit field ordering.
 */
import { createHash } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import type { VendorPrincipal } from '@vsa/shared';
import { BusinessRuleError, ConflictError, NotFoundError } from '@vsa/shared';
import type { PrismaTx } from './audit.js';
import { writeAudit } from './audit.js';
import { persistScoreSnapshot } from './risk-persist.js';
import { generateForAssessment } from './ai/generate.js';

export interface ValidationReport {
  complete: boolean;
  incomplete_controls: string[]; // control_code list, deduped
}

export interface SubmitResult {
  assessment_id: string;
  status: 'submitted';
  submitted_at: string;
  submission_hash: string; // "sha256:..." prefix per blueprint §4 example
}

interface CanonicalResponse {
  question_id: string;
  control_id: string;
  weight_at_response: number;
  response_value: string; // enum name
  justification: string; // "" when absent
  evidence_file_ids: string[]; // sorted asc
}

// ------------------------------------------------------------
// Validation
// ------------------------------------------------------------

/**
 * Report which template questions are missing a valid response. A question
 * is considered incomplete if:
 *   - no response row exists, or
 *   - response_value is null, or
 *   - N/A with empty justification (should be impossible due to CHECK, but
 *     we surface a clear field-level error rather than trusting the DB).
 *
 * Returned control codes are deduped: if 3 questions in TPM-06 are missing,
 * the client only sees "TPM-06" once (blueprint §4 example).
 */
export async function validateAssessmentForSubmit(
  prisma: PrismaClient,
  principal: VendorPrincipal,
): Promise<ValidationReport> {
  const assessment = await prisma.assessment.findUnique({
    where: { id: principal.assessmentId },
    select: {
      status: true,
      checklistTemplate: {
        select: {
          templateQuestions: {
            select: {
              question: {
                select: {
                  id: true,
                  control: { select: { controlCode: true } },
                },
              },
            },
          },
        },
      },
      responses: {
        select: {
          questionId: true,
          responseValue: true,
          justification: true,
        },
      },
    },
  });
  if (!assessment) throw new NotFoundError('Assessment not found');

  const respByQ = new Map(assessment.responses.map((r) => [r.questionId, r]));
  const incompleteCodes = new Set<string>();

  for (const tq of assessment.checklistTemplate.templateQuestions) {
    const q = tq.question;
    const r = respByQ.get(q.id);
    const answered =
      !!r &&
      r.responseValue !== null &&
      (r.responseValue !== 'not_applicable' ||
        (r.justification !== null && r.justification.trim().length > 0));
    if (!answered) incompleteCodes.add(q.control.controlCode);
  }

  return {
    complete: incompleteCodes.size === 0,
    incomplete_controls: [...incompleteCodes].sort(),
  };
}

// ------------------------------------------------------------
// Canonicalization + hash
// ------------------------------------------------------------

/**
 * Deterministic serialization of a response set for hashing. Exported so
 * tests can pin the exact byte string.
 */
export function canonicalizeResponses(responses: CanonicalResponse[]): string {
  // Sort by question_id (UUID string sort is deterministic and stable across
  // Postgres/Node without locale surprises).
  const sorted = [...responses].sort((a, b) => (a.question_id < b.question_id ? -1 : 1));
  // Serialize each response in a fixed field order — do NOT rely on
  // JSON.stringify key order, which is spec'd as insertion-order but that
  // gives us a soft dep on producer code paths.
  const parts = sorted.map((r) =>
    JSON.stringify([
      r.question_id,
      r.control_id,
      r.weight_at_response,
      r.response_value,
      r.justification,
      [...r.evidence_file_ids].sort(),
    ]),
  );
  return `[${parts.join(',')}]`;
}

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

export function submissionHash(responses: CanonicalResponse[]): string {
  return `sha256:${sha256Hex(canonicalizeResponses(responses))}`;
}

// ------------------------------------------------------------
// Submit
// ------------------------------------------------------------

export interface SubmitOptions {
  /**
   * If true (default), kick off AI generation after the submit tx commits.
   * Tests pass `false` to keep the submit path deterministic.
   */
  triggerAi?: boolean;
}

export async function submitAssessment(
  prisma: PrismaClient,
  principal: VendorPrincipal,
  options: SubmitOptions = {},
): Promise<SubmitResult> {
  // Validate first — cheap and gives a clean 422 with the list of missing
  // controls before we open a transaction.
  const report = await validateAssessmentForSubmit(prisma, principal);
  if (!report.complete) {
    throw new BusinessRuleError(
      'incomplete_submission',
      'One or more required controls are incomplete',
      { incomplete_controls: report.incomplete_controls.join(',') },
    );
  }

  return prisma.$transaction(async (tx) => {
    // Re-load with FOR UPDATE-equivalent semantics via a fresh read inside
    // the tx. Prisma doesn't expose FOR UPDATE directly; the unique
    // constraint on `dispositions.assessment_id` + the status check here
    // are sufficient to make double-submit idempotent.
    const current = await tx.assessment.findUnique({
      where: { id: principal.assessmentId },
      select: { id: true, status: true, submittedAt: true },
    });
    if (!current) throw new NotFoundError('Assessment not found');
    const editableStatuses: Array<typeof current.status> = ['draft', 'sent', 'in_progress'];
    const editable = current.submittedAt === null && editableStatuses.includes(current.status);
    if (!editable) {
      throw new ConflictError('already_submitted', 'This assessment has already been submitted');
    }

    // Load all responses + evidence file ids for hashing. Rows with a null
    // response_value (evidence uploaded before answering) are excluded from
    // the hash — validate() has already ensured every *template* question
    // has a valid answer, so any null-value row is an orphan that shouldn't
    // participate in the tamper-evidence digest.
    const responses = await tx.response.findMany({
      where: { assessmentId: principal.assessmentId, responseValue: { not: null } },
      select: {
        questionId: true,
        controlId: true,
        weightAtResponse: true,
        responseValue: true,
        justification: true,
        evidenceFiles: {
          where: { deletedAt: null },
          select: { id: true },
        },
      },
    });

    const canonical: CanonicalResponse[] = responses.map((r) => ({
      question_id: r.questionId,
      control_id: r.controlId,
      weight_at_response: r.weightAtResponse,
      response_value: r.responseValue as string, // narrowed by WHERE clause
      justification: r.justification ?? '',
      evidence_file_ids: r.evidenceFiles.map((e) => e.id),
    }));

    const hash = submissionHash(canonical);
    const now = new Date();

    // Lock all response rows and stamp the assessment.
    await tx.response.updateMany({
      where: { assessmentId: principal.assessmentId },
      data: { isLocked: true },
    });
    const updated = await tx.assessment.update({
      where: { id: principal.assessmentId },
      data: {
        status: 'submitted',
        submittedAt: now,
        submissionHash: hash,
      },
      select: { id: true, submittedAt: true, submissionHash: true },
    });

    // Finalize risk score in the SAME tx as the submission. Blueprint §3.5:
    // `risk_scores` is append-only — this is the FIRST row with is_final=true
    // for this assessment; any pre-existing rows are is_final=false live
    // recalculations and are preserved verbatim.
    const score = await persistScoreSnapshot(tx as PrismaTx, principal.assessmentId, true);

    await writeAudit(tx as PrismaTx, principal, {
      action: 'assessment.submit',
      entityType: 'assessment',
      entityId: updated.id,
      before: { status: current.status },
      after: {
        status: 'submitted',
        submission_hash: hash,
        response_count: canonical.length,
        aggregate_score: score.aggregateScore,
        tier: score.tier,
      },
    });

    return {
      assessment_id: updated.id,
      status: 'submitted' as const,
      submitted_at: (updated.submittedAt ?? now).toISOString(),
      submission_hash: updated.submissionHash!,
    };
  })
    .then(async (result) => {
      // AI generation runs OUTSIDE the submit tx — a provider failure
      // must never roll back the assessment submission. Reviewers can
      // manually retry via POST /ai/regenerate if this call errors.
      if (options.triggerAi !== false) {
        try {
          await generateForAssessment(prisma, principal.assessmentId, principal);
        } catch {
          // Swallow — the submission already succeeded. A production
          // deployment would enqueue a Service Bus message here instead
          // of running inline (Sprint 6).
        }
      }
      return result;
    });
}
