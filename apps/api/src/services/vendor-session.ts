/**
 * Vendor session + checklist read services.
 *
 * These do NOT accept any assessment/vendor identifiers from the client —
 * everything is derived from the resolved `VendorPrincipal` (which was
 * itself derived server-side from the invite token). This is the primary
 * IDOR defense from blueprint §5.2.
 *
 * Serializer scoping: vendor responses never include scores, weights aside
 * from control-input weight (allowed per blueprint §4 vendor checklist
 * example), AI content, or any other vendor's data.
 */
import type { PrismaClient } from '@prisma/client';
import type { VendorPrincipal } from '@vsa/shared';
import { ConflictError, NotFoundError } from '@vsa/shared';

export interface SessionDomainProgress {
  control_domain_id: string;
  name: string;
  answered_count: number;
  total_count: number;
}

export interface VendorSession {
  assessment_id: string;
  vendor_name: string;
  status: string;
  expires_at: string; // ISO
  domains: SessionDomainProgress[];
}

export async function loadVendorSession(
  prisma: PrismaClient,
  principal: VendorPrincipal,
): Promise<VendorSession> {
  const invite = await prisma.vendorInvite.findUnique({
    where: { id: principal.inviteId },
    select: { expiresAt: true },
  });
  if (!invite) throw new NotFoundError('Invite not found');

  const assessment = await prisma.assessment.findUnique({
    where: { id: principal.assessmentId },
    select: {
      id: true,
      status: true,
      vendor: { select: { name: true } },
      checklistTemplate: {
        select: {
          templateQuestions: {
            select: {
              question: {
                select: {
                  id: true,
                  control: {
                    select: {
                      controlDomainId: true,
                      controlDomain: { select: { id: true, name: true, sortOrder: true } },
                    },
                  },
                },
              },
            },
          },
        },
      },
      responses: {
        select: { questionId: true, responseValue: true },
      },
    },
  });
  if (!assessment) throw new NotFoundError('Assessment not found');

  // Client should route to a read-only "already submitted" screen. We still
  // return 200 for GET /vendor/session (blueprint §4) but a 409 is the right
  // signal for follow-up mutating routes; that's enforced at write time.

  const answered = new Map<string, boolean>();
  for (const r of assessment.responses) {
    answered.set(r.questionId, r.responseValue !== null);
  }

  const domainMap = new Map<string, { name: string; sortOrder: number; total: number; done: number }>();
  for (const tq of assessment.checklistTemplate.templateQuestions) {
    const domain = tq.question.control.controlDomain;
    const bucket = domainMap.get(domain.id) ?? {
      name: domain.name,
      sortOrder: domain.sortOrder,
      total: 0,
      done: 0,
    };
    bucket.total += 1;
    if (answered.get(tq.question.id)) bucket.done += 1;
    domainMap.set(domain.id, bucket);
  }

  const domains: SessionDomainProgress[] = [...domainMap.entries()]
    .map(([id, v]) => ({
      control_domain_id: id,
      name: v.name,
      answered_count: v.done,
      total_count: v.total,
      _sort: v.sortOrder,
    }))
    .sort((a, b) => a._sort - b._sort)
    .map(({ _sort: _, ...rest }) => rest);

  return {
    assessment_id: assessment.id,
    vendor_name: assessment.vendor.name,
    status: assessment.status,
    expires_at: invite.expiresAt.toISOString(),
    domains,
  };
}

// ------------------------------------------------------------

export interface EvidenceMetadata {
  file_id: string;
  file_name: string;
  file_size_bytes: number;
  mime_type: string;
  uploaded_at: string;
}

export interface ChecklistResponsePayload {
  response_value: 'compliant' | 'non_compliant' | 'not_applicable' | null;
  justification: string | null;
  evidence: EvidenceMetadata[];
  is_locked: boolean;
}

export interface ChecklistQuestionPayload {
  question_id: string;
  control_id: string;
  control_domain_id: string;
  control_code: string;
  weight: number; // control-input weight, explicitly permitted for vendor scope
  question_text: string;
  requires_evidence: boolean;
  response: ChecklistResponsePayload;
}

export async function loadVendorChecklist(
  prisma: PrismaClient,
  principal: VendorPrincipal,
  domainId?: string,
): Promise<{ questions: ChecklistQuestionPayload[] }> {
  // 1) fetch the assessment + its template questions + responses in one shot.
  const assessment = await prisma.assessment.findUnique({
    where: { id: principal.assessmentId },
    select: {
      status: true,
      checklistTemplate: {
        select: {
          templateQuestions: {
            orderBy: { sortOrder: 'asc' },
            select: {
              sortOrder: true,
              question: {
                select: {
                  id: true,
                  questionText: true,
                  requiresEvidence: true,
                  control: {
                    select: {
                      id: true,
                      controlCode: true,
                      currentWeight: true,
                      controlDomainId: true,
                    },
                  },
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
          isLocked: true,
          weightAtResponse: true,
          evidenceFiles: {
            where: { deletedAt: null },
            orderBy: { uploadedAt: 'asc' },
            select: {
              id: true,
              fileName: true,
              fileSizeBytes: true,
              mimeType: true,
              uploadedAt: true,
            },
          },
        },
      },
    },
  });
  if (!assessment) throw new NotFoundError('Assessment not found');

  const respByQ = new Map(assessment.responses.map((r) => [r.questionId, r]));

  const questions: ChecklistQuestionPayload[] = [];
  for (const tq of assessment.checklistTemplate.templateQuestions) {
    const q = tq.question;
    if (domainId && q.control.controlDomainId !== domainId) continue;
    const r = respByQ.get(q.id);
    questions.push({
      question_id: q.id,
      control_id: q.control.id,
      control_domain_id: q.control.controlDomainId,
      control_code: q.control.controlCode,
      // If a response row exists (rare pre-first-write), surface its snapshot
      // weight so the vendor sees exactly what will be used for scoring;
      // otherwise show current control weight.
      weight: r?.weightAtResponse ?? q.control.currentWeight,
      question_text: q.questionText,
      requires_evidence: q.requiresEvidence,
      response: {
        response_value: (r?.responseValue as ChecklistResponsePayload['response_value']) ?? null,
        justification: r?.justification ?? null,
        evidence: (r?.evidenceFiles ?? []).map((e) => ({
          file_id: e.id,
          file_name: e.fileName,
          file_size_bytes: Number(e.fileSizeBytes),
          mime_type: e.mimeType,
          uploaded_at: e.uploadedAt.toISOString(),
        })),
        is_locked: r?.isLocked ?? false,
      },
    });
  }

  // If a domainId was supplied but nothing matched, that's likely a client
  // sending a domain from another template — 404 is the right signal (the
  // domain isn't part of *this vendor's* assigned checklist).
  if (domainId && questions.length === 0) {
    throw new NotFoundError('Domain not present in this assessment');
  }

  return { questions };
}

/**
 * Throw ConflictError if the assessment is already submitted — used by every
 * mutating vendor endpoint to enforce the immutability contract (blueprint §1.4).
 */
export async function assertAssessmentEditable(
  prisma: PrismaClient,
  assessmentId: string,
): Promise<void> {
  const a = await prisma.assessment.findUnique({
    where: { id: assessmentId },
    select: { status: true, submittedAt: true },
  });
  if (!a) throw new NotFoundError('Assessment not found');
  if (a.submittedAt || ['submitted', 'in_review', 'escalated', 'approved', 'conditional', 'rejected'].includes(a.status)) {
    throw new ConflictError('already_submitted', 'This assessment is locked and no longer editable');
  }
}
