/**
 * AI routes (blueprint §4 review + risk-manager sections).
 *
 * Role scoping:
 *   - Reviewers (`cyber_reviewer` / `legal_reviewer`) can only fetch content
 *     scoped to their own role — server-derived from the JWT, NOT accepted
 *     as a query parameter that an attacker could flip.
 *   - `admin` and `risk_manager` may pass an explicit `domain=<role>` query.
 *   - All responses include the persistent AI disclosure string.
 */
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { ForbiddenError, NotFoundError, ValidationError } from '@vsa/shared';
import { requireStaffAuth } from '../plugins/auth.js';
import { requireStaffRole } from '../plugins/rbac.js';
import { getPrisma } from '../db.js';
import {
  getLatestGaps,
  getLatestSummary,
  regenerateForRole,
} from '../services/ai/generate.js';
import type { ReviewerScopeRole } from '../services/ai/prompt.js';

const VendorParam = z.object({ vendorId: z.string().uuid() });
const RoleQuery = z.object({
  domain: z.enum(['cyber_reviewer', 'legal_reviewer']).optional(),
});
const RegenBody = z
  .object({
    reason: z.string().max(500).optional(),
    force: z.boolean().optional(),
  })
  .default({});

function resolveScopeRole(
  principalRole: string,
  requested: ReviewerScopeRole | undefined,
): ReviewerScopeRole {
  if (principalRole === 'cyber_reviewer' || principalRole === 'legal_reviewer') {
    if (requested && requested !== principalRole) {
      // A reviewer trying to view another reviewer role's content — 403.
      throw new ForbiddenError('You may only view your own reviewer scope');
    }
    return principalRole;
  }
  if (!requested) {
    throw new ValidationError('domain query parameter is required for this role', {
      domain: 'required for admin/risk_manager callers',
    });
  }
  return requested;
}

async function resolveSubmittedAssessmentId(vendorId: string): Promise<string> {
  const a = await getPrisma().assessment.findFirst({
    where: { vendorId, submittedAt: { not: null } },
    orderBy: { submittedAt: 'desc' },
    select: { id: true },
  });
  if (!a) throw new NotFoundError('No submitted assessment for this vendor');
  return a.id;
}

const aiRoutes: FastifyPluginAsync = async (app) => {
  const prisma = getPrisma();

  // All AI routes require staff auth.
  app.addHook('preHandler', requireStaffAuth);

  // Reviewers, admin, risk_manager can read AI content.
  const readGuard = requireStaffRole('admin', 'risk_manager', 'cyber_reviewer', 'legal_reviewer');

  // ---------- Summary ----------
  app.get('/ai/summary/:vendorId', { preHandler: readGuard }, async (req) => {
    const params = VendorParam.parse(req.params);
    const query = RoleQuery.parse(req.query);
    const role = resolveScopeRole(req.principal!.kind === 'staff' ? req.principal!.role : '', query.domain);
    const assessmentId = await resolveSubmittedAssessmentId(params.vendorId);
    const result = await getLatestSummary(prisma, assessmentId, role);
    if (!result) throw new NotFoundError('AI summary not yet generated');
    return result;
  });

  // ---------- Per-control gaps + remediation ----------
  app.get('/ai/gaps/:vendorId', { preHandler: readGuard }, async (req) => {
    const params = VendorParam.parse(req.params);
    const query = RoleQuery.parse(req.query);
    const role = resolveScopeRole(req.principal!.kind === 'staff' ? req.principal!.role : '', query.domain);
    const assessmentId = await resolveSubmittedAssessmentId(params.vendorId);
    const items = await getLatestGaps(prisma, assessmentId, role);
    return { items, disclosure: 'AI-Generated — Human Review Required' };
  });

  // ---------- Regenerate ----------
  const regenGuard = requireStaffRole('admin', 'cyber_reviewer', 'legal_reviewer');
  app.post('/ai/regenerate/:vendorId', { preHandler: regenGuard }, async (req, reply) => {
    const params = VendorParam.parse(req.params);
    const query = RoleQuery.parse(req.query);
    const body = RegenBody.parse(req.body ?? {});
    const role = resolveScopeRole(req.principal!.kind === 'staff' ? req.principal!.role : '', query.domain);
    const assessmentId = await resolveSubmittedAssessmentId(params.vendorId);
    const result = await regenerateForRole(prisma, assessmentId, role, req.principal!, {
      force: body.force,
    });
    return reply.status(202).send({
      status: 'completed', // Sprint 6 changes to 'queued' + job_id
      generated: result,
      reason: body.reason,
      disclosure: 'AI-Generated — Human Review Required',
    });
  });

  // ---------- Cross-domain note (risk-manager surface, no role filter) ----------
  const rmGuard = requireStaffRole('admin', 'risk_manager');
  app.get('/ai/cross-domain-note/:vendorId', { preHandler: rmGuard }, async (req) => {
    const params = VendorParam.parse(req.params);
    const assessmentId = await resolveSubmittedAssessmentId(params.vendorId);
    const row = await prisma.aiGeneration.findFirst({
      where: { assessmentId, kind: 'cross_domain_note' },
      orderBy: { generatedAt: 'desc' },
      select: { responseText: true, generatedAt: true, isStale: true, modelName: true },
    });
    if (!row) throw new NotFoundError('Cross-domain note not yet generated');
    return {
      note: row.responseText,
      generated_at: row.generatedAt.toISOString(),
      is_stale: row.isStale,
      model: row.modelName,
      disclosure: 'AI-Generated — Human Review Required',
    };
  });
};

export default aiRoutes;
