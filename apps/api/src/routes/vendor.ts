/**
 * Vendor routes (blueprint §4 vendor endpoints — screens 1a/1b/1c).
 *
 * Every route in this file:
 *   1. Requires a vendor invite token (attached by the auth plugin).
 *   2. Derives assessment_id/vendor_id from the resolved principal — NEVER
 *      accepts them as request input.
 *   3. Writes to `audit_log` on any state change, synchronously in the same
 *      DB transaction as the mutation.
 */
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { ValidationError } from '@vsa/shared';
import { requireVendorAuth } from '../plugins/auth.js';
import { getPrisma } from '../db.js';
import { getStorage } from '../services/storage.js';
import { loadEnv } from '../env.js';
import {
  loadVendorSession,
  loadVendorChecklist,
} from '../services/vendor-session.js';
import { upsertVendorResponse } from '../services/response.js';
import {
  submitAssessment,
  validateAssessmentForSubmit,
} from '../services/submission.js';
import { uploadEvidence, deleteEvidence } from '../services/evidence.js';

const UuidParam = z.object({ questionId: z.string().uuid() });
const FileIdParam = z.object({ fileId: z.string().uuid() });
const DomainQuery = z.object({ domain_id: z.string().uuid().optional() });
const PatchBody = z.object({
  response_value: z.enum(['compliant', 'non_compliant', 'not_applicable']),
  justification: z.string().max(10_000).optional(),
});

const vendorRoutes: FastifyPluginAsync = async (app) => {
  const prisma = getPrisma();
  const env = loadEnv();
  const storage = getStorage({
    driver: env.EVIDENCE_STORAGE,
    localRoot: env.EVIDENCE_LOCAL_ROOT,
    maxBytes: env.EVIDENCE_MAX_BYTES,
  });

  // All routes below require a vendor principal. Applying at the plugin level
  // is safe because this whole file is the vendor surface.
  app.addHook('preHandler', requireVendorAuth);

  // ---------- Session ----------
  app.get('/vendor/session', async (req) => {
    const principal = req.principal!;
    if (principal.kind !== 'vendor') throw new ValidationError('vendor principal required');
    return loadVendorSession(prisma, principal);
  });

  // ---------- Checklist (all questions, optionally filtered to a domain) ----------
  app.get('/vendor/checklist', async (req) => {
    const principal = req.principal!;
    if (principal.kind !== 'vendor') throw new ValidationError('vendor principal required');
    const query = DomainQuery.parse(req.query);
    return loadVendorChecklist(prisma, principal, query.domain_id);
  });

  // ---------- Autosave a single response ----------
  app.patch('/vendor/responses/:questionId', async (req) => {
    const principal = req.principal!;
    if (principal.kind !== 'vendor') throw new ValidationError('vendor principal required');
    const params = UuidParam.parse(req.params);
    const body = PatchBody.parse(req.body);
    return upsertVendorResponse(prisma, principal, {
      questionId: params.questionId,
      responseValue: body.response_value,
      justification: body.justification ?? null,
    });
  });

  // ---------- Submission validation dry-run ----------
  app.get('/vendor/submit/validate', async (req) => {
    const principal = req.principal!;
    if (principal.kind !== 'vendor') throw new ValidationError('vendor principal required');
    return validateAssessmentForSubmit(prisma, principal);
  });

  // ---------- Submission ----------
  app.post('/vendor/submit', async (req) => {
    const principal = req.principal!;
    if (principal.kind !== 'vendor') throw new ValidationError('vendor principal required');
    return submitAssessment(prisma, principal);
  });

  // ---------- Evidence upload (multipart) ----------
  app.post('/vendor/evidence/:questionId', async (req, reply) => {
    const principal = req.principal!;
    if (principal.kind !== 'vendor') throw new ValidationError('vendor principal required');
    const params = UuidParam.parse(req.params);
    const file = await req.file();
    if (!file) throw new ValidationError('Expected a multipart file part named "file"');

    // @fastify/multipart enforces `limits.fileSize` set at plugin registration.
    // If the stream is truncated we throw — the storage adapter would also
    // catch this but we prefer to surface a 400 here.
    try {
      const result = await uploadEvidence(prisma, storage, principal, {
        questionId: params.questionId,
        fileName: file.filename,
        mimeType: file.mimetype,
        stream: file.file,
      });
      return reply.status(201).send(result);
    } finally {
      // Ensure the multipart stream is fully consumed — otherwise Fastify
      // holds the connection open. `file.file` is the underlying stream.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const s = file.file as any;
      if (s?.readable && !s.readableEnded) s.resume();
    }
  });

  // ---------- Evidence delete ----------
  app.delete('/vendor/evidence/:fileId', async (req, reply) => {
    const principal = req.principal!;
    if (principal.kind !== 'vendor') throw new ValidationError('vendor principal required');
    const params = FileIdParam.parse(req.params);
    await deleteEvidence(prisma, storage, principal, params.fileId);
    return reply.status(204).send();
  });
};

export default vendorRoutes;
