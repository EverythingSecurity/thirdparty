/**
 * Response upsert — autosave for vendor checklist.
 *
 * Key invariant (blueprint §3.5, weight snapshot design note):
 *   The FIRST time a vendor writes to a question, we snapshot the control's
 *   current_weight into `responses.weight_at_response`. Subsequent writes DO
 *   NOT re-snapshot — the weight is frozen for scoring, so a later admin
 *   re-weighting cannot silently change this assessment's score.
 *
 * The N/A-requires-justification rule is enforced by both:
 *   - the DB CHECK constraint `chk_na_requires_justification` (defense in depth), and
 *   - this service's `ValidationError` (so we return 400 with the field name,
 *     not 500 from a raw DB constraint violation).
 */
import type { Prisma, PrismaClient, ResponseValue } from '@prisma/client';
import { ConflictError, ValidationError } from '@vsa/shared';
import type { VendorPrincipal } from '@vsa/shared';
import type { PrismaTx } from './audit.js';
import { writeAudit } from './audit.js';
import { assertAssessmentEditable } from './vendor-session.js';

export interface UpsertResponseInput {
  questionId: string;
  responseValue: ResponseValue;
  justification?: string | null;
}

export interface UpsertResponseResult {
  response_id: string;
  question_id: string;
  response_value: ResponseValue;
  justification: string | null;
  is_locked: boolean;
  saved_at: string;
}

export async function upsertVendorResponse(
  prisma: PrismaClient,
  principal: VendorPrincipal,
  input: UpsertResponseInput,
): Promise<UpsertResponseResult> {
  // Validation up front so we return 400 with a field-level message rather
  // than surfacing a DB CHECK violation.
  if (
    input.responseValue === 'not_applicable' &&
    (!input.justification || input.justification.trim().length === 0)
  ) {
    throw new ValidationError('Justification is required for Not Applicable responses', {
      justification: 'required when response_value is not_applicable',
    });
  }

  await assertAssessmentEditable(prisma, principal.assessmentId);

  return prisma.$transaction(async (tx) => {
    // Resolve the question and verify it belongs to this assessment's template.
    // This is the second IDOR gate — an attacker with a valid vendor token
    // still can't PATCH a question outside their own checklist.
    const tq = await tx.checklistTemplateQuestion.findFirst({
      where: {
        questionId: input.questionId,
        checklistTemplate: {
          assessments: { some: { id: principal.assessmentId } },
        },
      },
      select: {
        question: {
          select: {
            id: true,
            control: { select: { id: true, currentWeight: true } },
          },
        },
      },
    });
    if (!tq) {
      throw new ConflictError('question_not_in_assessment', 'This question is not part of your assessment');
    }

    // Existing row? — capture prior state for audit + preserve snapshot weight.
    const prior = await tx.response.findUnique({
      where: {
        assessmentId_questionId: {
          assessmentId: principal.assessmentId,
          questionId: tq.question.id,
        },
      },
      select: {
        id: true,
        weightAtResponse: true,
        responseValue: true,
        justification: true,
        isLocked: true,
      },
    });

    if (prior?.isLocked) {
      // Race: assessment was submitted between the editable check and this
      // upsert. Return 409 with the same code so the client handles it the
      // same way as the pre-check.
      throw new ConflictError('already_submitted', 'Response is locked');
    }

    const now = new Date();
    const justification =
      input.justification && input.justification.trim().length > 0
        ? input.justification.trim()
        : null;

    const saved = await tx.response.upsert({
      where: {
        assessmentId_questionId: {
          assessmentId: principal.assessmentId,
          questionId: tq.question.id,
        },
      },
      create: {
        assessmentId: principal.assessmentId,
        questionId: tq.question.id,
        controlId: tq.question.control.id,
        weightAtResponse: tq.question.control.currentWeight, // snapshot on first write
        responseValue: input.responseValue,
        justification,
        respondedAt: now,
      },
      update: {
        // Snapshot weight is INTENTIONALLY not updated — see design note.
        responseValue: input.responseValue,
        justification,
        respondedAt: now,
      },
    });

    await writeAudit(tx as PrismaTx, principal, {
      action: 'response.update',
      entityType: 'response',
      entityId: saved.id,
      before: prior
        ? {
            response_value: prior.responseValue,
            justification: prior.justification,
          }
        : null,
      after: {
        response_value: saved.responseValue,
        justification: saved.justification,
      },
    });

    return {
      response_id: saved.id,
      question_id: saved.questionId,
      response_value: saved.responseValue!,
      justification: saved.justification,
      is_locked: saved.isLocked,
      saved_at: now.toISOString(),
    };
  });
}
