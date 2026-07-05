/**
 * Risk reporting routes (blueprint §4 risk-manager surface).
 *
 * RBAC:
 *   - Score / breakdown / reviewer-status / portfolio / export: admin +
 *     risk_manager only.
 *   - Cyber/Legal reviewers do NOT see cross-vendor portfolio or aggregate
 *     score — they operate at the control level via the reviewer surface
 *     (Sprint 4).
 *
 * Every list/detail endpoint here scopes by `principal.orgId`. A caller
 * cannot pass an `org_id` query and read another tenant's data.
 */
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { requireStaffAuth } from '../plugins/auth.js';
import { requireStaffRole } from '../plugins/rbac.js';
import { getPrisma } from '../db.js';
import {
  fetchPortfolio,
  fetchReviewerStatus,
  fetchRiskScore,
  fetchScoreBreakdown,
} from '../services/risk-report.js';
import { buildScoreBreakdownCsv } from '../services/export.js';
import { NotFoundError, ValidationError } from '@vsa/shared';

const VendorParam = z.object({ vendorId: z.string().uuid() });
const PortfolioQuery = z.object({
  sort: z.enum(['score', 'tier', 'status', 'name']).optional(),
  filter_tier: z.enum(['low', 'medium', 'high', 'critical']).optional(),
  q: z.string().max(200).optional(),
  page: z.coerce.number().int().positive().optional(),
  page_size: z.coerce.number().int().positive().max(100).optional(),
});
const ExportQuery = z.object({
  format: z.enum(['csv', 'pdf']).default('csv'),
});

const riskRoutes: FastifyPluginAsync = async (app) => {
  const prisma = getPrisma();
  app.addHook('preHandler', requireStaffAuth);
  const rmGuard = requireStaffRole('admin', 'risk_manager');

  // ---------- GET /risk/:vendorId/score ----------
  app.get('/risk/:vendorId/score', { preHandler: rmGuard }, async (req) => {
    const params = VendorParam.parse(req.params);
    return fetchRiskScore(prisma, params.vendorId, req.principal!.orgId);
  });

  // ---------- GET /risk/:vendorId/score-breakdown ----------
  app.get('/risk/:vendorId/score-breakdown', { preHandler: rmGuard }, async (req) => {
    const params = VendorParam.parse(req.params);
    return fetchScoreBreakdown(prisma, params.vendorId, req.principal!.orgId);
  });

  // ---------- GET /risk/:vendorId/reviewer-status ----------
  app.get('/risk/:vendorId/reviewer-status', { preHandler: rmGuard }, async (req) => {
    const params = VendorParam.parse(req.params);
    return fetchReviewerStatus(prisma, params.vendorId, req.principal!.orgId);
  });

  // ---------- GET /risk/portfolio ----------
  app.get('/risk/portfolio', { preHandler: rmGuard }, async (req) => {
    const q = PortfolioQuery.parse(req.query);
    return fetchPortfolio(prisma, req.principal!.orgId, {
      sort: q.sort,
      filterTier: q.filter_tier,
      q: q.q,
      page: q.page,
      pageSize: q.page_size,
    });
  });

  // ---------- GET /risk/:vendorId/export ----------
  app.get('/risk/:vendorId/export', { preHandler: rmGuard }, async (req, reply) => {
    const params = VendorParam.parse(req.params);
    const query = ExportQuery.parse(req.query);
    if (query.format === 'pdf') {
      throw new ValidationError('PDF export not implemented in Sprint 3', {
        format: 'use format=csv',
      });
    }

    const [score, breakdown, vendor] = await Promise.all([
      fetchRiskScore(prisma, params.vendorId, req.principal!.orgId),
      fetchScoreBreakdown(prisma, params.vendorId, req.principal!.orgId),
      prisma.vendor.findFirst({
        where: { id: params.vendorId, organizationId: req.principal!.orgId },
        select: { name: true },
      }),
    ]);
    if (!vendor) throw new NotFoundError('Vendor not found');

    const csv = buildScoreBreakdownCsv(vendor.name, score, breakdown);
    reply
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header(
        'Content-Disposition',
        `attachment; filename="risk-breakdown-${params.vendorId}.csv"`,
      );

    // Audit exports — blueprint §4: "every export call logged".
    await prisma.auditLog.create({
      data: {
        organizationId: req.principal!.orgId,
        actorUserId: req.principal!.kind === 'staff' ? req.principal!.userId : null,
        action: 'risk.export',
        entityType: 'risk_score',
        entityId: score.assessment_id,
        beforeValue: null,
        afterValue: { format: 'csv', vendor_id: params.vendorId },
      },
    });
    return csv;
  });
};

export default riskRoutes;
