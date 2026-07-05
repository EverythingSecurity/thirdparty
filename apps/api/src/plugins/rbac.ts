/**
 * Route-level RBAC preHandlers.
 *
 * These are thin wrappers around `@vsa/shared`'s `requireRole` / `requireVendor`
 * that plug into Fastify's preHandler chain. Business-logic RBAC (e.g.
 * scoping a query to routed controls for a reviewer) lives in the route
 * handler itself, using `reviewerScopeRole()` from `@vsa/shared`.
 */
import type { FastifyRequest } from 'fastify';
import { requireRole, requireVendor, UnauthenticatedError } from '@vsa/shared';
import type { UserRole } from '@vsa/shared';

/** Returns a preHandler that fails with 403 unless the caller has one of `roles`. */
export function requireStaffRole(...roles: UserRole[]) {
  return async (req: FastifyRequest): Promise<void> => {
    if (!req.principal) throw new UnauthenticatedError();
    requireRole(req.principal, ...roles);
  };
}

/** PreHandler: caller must be a valid vendor principal. */
export async function requireVendorPrincipal(req: FastifyRequest): Promise<void> {
  if (!req.principal) throw new UnauthenticatedError();
  requireVendor(req.principal);
}
