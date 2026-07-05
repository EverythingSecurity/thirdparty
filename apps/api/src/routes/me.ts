/**
 * `/me` endpoints — smoke tests for the auth + RBAC wiring.
 *
 * These are intentionally minimal: they prove that a staff JWT resolves to a
 * StaffPrincipal and a vendor token resolves to a VendorPrincipal, and that
 * role guards return 403 for wrong-role callers. Real business endpoints
 * (blueprint §4) land in Sprint 2+.
 */
import type { FastifyPluginAsync } from 'fastify';
import { requireStaffAuth, requireVendorAuth } from '../plugins/auth.js';
import { requireStaffRole } from '../plugins/rbac.js';

const meRoutes: FastifyPluginAsync = async (app) => {
  // Any authenticated staff caller — returns their principal.
  app.get('/me', { preHandler: requireStaffAuth }, async (req) => {
    if (req.principal?.kind !== 'staff') return { error: 'unreachable' };
    return {
      kind: 'staff',
      user_id: req.principal.userId,
      org_id: req.principal.orgId,
      role: req.principal.role,
      email: req.principal.email,
    };
  });

  // Admin-only smoke test.
  app.get('/me/admin', { preHandler: requireStaffRole('admin') }, async () => ({
    ok: true,
    scope: 'admin',
  }));

  // Reviewer-only smoke test (either cyber or legal).
  app.get(
    '/me/reviewer',
    { preHandler: requireStaffRole('cyber_reviewer', 'legal_reviewer') },
    async (req) => {
      if (req.principal?.kind !== 'staff') return { error: 'unreachable' };
      return { ok: true, scope: 'reviewer', role: req.principal.role };
    },
  );

  // Vendor-token smoke test. IMPORTANT: assessment/vendor IDs come from the
  // server-resolved principal, NEVER from a query param or path — this is the
  // IDOR-defense contract from blueprint §5.2.
  app.get('/vendor/me', { preHandler: requireVendorAuth }, async (req) => {
    if (req.principal?.kind !== 'vendor') return { error: 'unreachable' };
    return {
      kind: 'vendor',
      invite_id: req.principal.inviteId,
      assessment_id: req.principal.assessmentId,
      vendor_id: req.principal.vendorId,
      org_id: req.principal.orgId,
    };
  });
};

export default meRoutes;
