/**
 * Evidence upload/delete service.
 *
 * Contract (blueprint §4 vendor evidence + §5.3 data protection):
 *   - Mime allow-list: pdf / png / jpg / jpeg / docx.
 *   - Size cap enforced twice: multipart parser rejects at the wire boundary
 *     (fastify limits), and the storage adapter cross-checks final bytes.
 *   - Both upload and delete are rejected with 409 if the assessment is
 *     locked (post-submission edits require a formal re-assessment cycle).
 *   - Delete is SOFT in the DB (`evidence_files.deleted_at`) — metadata is
 *     retained for audit reconstruction. The underlying bytes are removed
 *     from storage.
 *   - Raw file bytes never touch the LLM prompt path; only metadata does.
 */
import type { PrismaClient } from '@prisma/client';
import type { Readable } from 'node:stream';
import type { VendorPrincipal } from '@vsa/shared';
import { ConflictError, NotFoundError, ValidationError } from '@vsa/shared';
import type { EvidenceStorage } from './storage.js';
import { newStorageKey } from './storage.js';
import type { PrismaTx } from './audit.js';
import { writeAudit } from './audit.js';
import { assertAssessmentEditable } from './vendor-session.js';

export const ALLOWED_MIME = new Set([
  'application/pdf',
  'image/png',
  'image/jpeg', // .jpg + .jpeg both report image/jpeg
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // .docx
]);

export interface EvidenceUploadInput {
  questionId: string;
  fileName: string;
  mimeType: string;
  stream: Readable;
  declaredBytes?: number; // Content-Length hint if present; storage double-checks
}

export interface EvidenceUploadResult {
  file_id: string;
  file_name: string;
  file_size_bytes: number;
  mime_type: string;
  uploaded_at: string;
}

export async function uploadEvidence(
  prisma: PrismaClient,
  storage: EvidenceStorage,
  principal: VendorPrincipal,
  input: EvidenceUploadInput,
): Promise<EvidenceUploadResult> {
  if (!ALLOWED_MIME.has(input.mimeType)) {
    throw new ValidationError('Unsupported file type', {
      file: `mime type '${input.mimeType}' is not allowed`,
    });
  }

  await assertAssessmentEditable(prisma, principal.assessmentId);

  // Verify the target question belongs to this vendor's assessment — same
  // IDOR gate as the response upsert path.
  const tq = await prisma.checklistTemplateQuestion.findFirst({
    where: {
      questionId: input.questionId,
      checklistTemplate: { assessments: { some: { id: principal.assessmentId } } },
    },
    select: {
      question: {
        select: { id: true, control: { select: { id: true, currentWeight: true } } },
      },
    },
  });
  if (!tq) {
    throw new ConflictError('question_not_in_assessment', 'This question is not part of your assessment');
  }

  // Ensure a `responses` row exists to attach the evidence to. If the vendor
  // uploads evidence before choosing a response_value we still record it —
  // the response_value gates completeness on submit, not evidence.
  let response = await prisma.response.findUnique({
    where: {
      assessmentId_questionId: {
        assessmentId: principal.assessmentId,
        questionId: tq.question.id,
      },
    },
    select: { id: true, isLocked: true },
  });
  if (!response) {
    const created = await prisma.response.create({
      data: {
        assessmentId: principal.assessmentId,
        questionId: tq.question.id,
        controlId: tq.question.control.id,
        weightAtResponse: tq.question.control.currentWeight,
      },
      select: { id: true, isLocked: true },
    });
    response = created;
  }
  if (response.isLocked) {
    throw new ConflictError('already_submitted', 'Response is locked');
  }

  // Persist bytes to storage FIRST — if the DB insert fails we can clean the
  // orphan bytes via storage.delete(). If we did DB-first, a storage failure
  // would leave a metadata row pointing at nothing.
  const storageKey = newStorageKey();
  const put = await storage.put(principal.assessmentId, storageKey, input.stream);

  try {
    return await prisma.$transaction(async (tx) => {
      const created = await tx.evidenceFile.create({
        data: {
          responseId: response.id,
          fileName: input.fileName,
          fileSizeBytes: BigInt(put.bytesWritten),
          mimeType: input.mimeType,
          storageUri: put.storageUri,
        },
      });
      await writeAudit(tx as PrismaTx, principal, {
        action: 'evidence.upload',
        entityType: 'evidence_files',
        entityId: created.id,
        before: null,
        after: {
          file_name: created.fileName,
          file_size_bytes: put.bytesWritten,
          mime_type: created.mimeType,
          sha256: put.sha256,
        },
      });
      return {
        file_id: created.id,
        file_name: created.fileName,
        file_size_bytes: Number(created.fileSizeBytes),
        mime_type: created.mimeType,
        uploaded_at: created.uploadedAt.toISOString(),
      };
    });
  } catch (err) {
    // Best-effort cleanup — storage.delete is idempotent.
    await storage.delete(put.storageUri).catch(() => undefined);
    throw err;
  }
}

// ------------------------------------------------------------
// Delete
// ------------------------------------------------------------

export async function deleteEvidence(
  prisma: PrismaClient,
  storage: EvidenceStorage,
  principal: VendorPrincipal,
  fileId: string,
): Promise<void> {
  // Ownership + editability check in one query — join to the assessment via
  // response so an attacker with a valid token can't delete evidence from
  // another vendor's assessment.
  const file = await prisma.evidenceFile.findUnique({
    where: { id: fileId },
    select: {
      id: true,
      storageUri: true,
      deletedAt: true,
      response: {
        select: {
          isLocked: true,
          assessment: { select: { id: true } },
        },
      },
    },
  });
  if (!file || file.deletedAt) throw new NotFoundError('Evidence not found');
  if (file.response.assessment.id !== principal.assessmentId) {
    // Deliberately return 404 (not 403) — do not confirm the existence of a
    // record belonging to another vendor.
    throw new NotFoundError('Evidence not found');
  }
  if (file.response.isLocked) {
    throw new ConflictError('already_submitted', 'Evidence cannot be removed after submission');
  }

  await prisma.$transaction(async (tx) => {
    const updated = await tx.evidenceFile.update({
      where: { id: file.id },
      data: { deletedAt: new Date() },
      select: { id: true, storageUri: true, fileName: true },
    });
    await writeAudit(tx as PrismaTx, principal, {
      action: 'evidence.delete',
      entityType: 'evidence_files',
      entityId: updated.id,
      before: { file_name: updated.fileName },
      after: null,
    });
  });

  // Fire-and-forget: storage cleanup outside the DB tx. If the storage call
  // fails, the metadata row still shows `deleted_at` (correct from a user
  // POV); an orphan blob would be garbage-collected by a scheduled sweep in
  // production (not implemented in Sprint 2).
  await storage.delete(file.storageUri).catch(() => undefined);
}
