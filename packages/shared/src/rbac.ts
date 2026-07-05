/**
 * RBAC principals & helpers — the same primitives are consumed by the API
 * middleware layer and (in later sprints) the web SPA route guards.
 *
 * Enforcement guarantee (blueprint §5.2): RBAC lives in the service/query
 * layer, not the UI. Serializers are role-aware — fields the caller's role
 * shouldn't see are absent from the payload, not merely hidden client-side.
 */
import { ForbiddenError } from './errors.js';
import type { UserRole, RoutableRole } from './roles.js';

/**
 * A staff principal — resolved from a validated Entra ID / OIDC JWT.
 * `orgId` is the tenant boundary; every query must be scoped to it.
 */
export interface StaffPrincipal {
  kind: 'staff';
  userId: string;
  orgId: string;
  role: UserRole;
  email: string;
}

/**
 * A vendor principal — resolved from a validated vendor invite token.
 * Note: `assessmentId`/`vendorId`/`orgId` are derived server-side from the
 * token hash lookup. NEVER trust these fields if they appear in a request
 * body/query — always use the values on the resolved principal.
 */
export interface VendorPrincipal {
  kind: 'vendor';
  inviteId: string;
  assessmentId: string;
  vendorId: string;
  orgId: string;
}

export type Principal = StaffPrincipal | VendorPrincipal;

export function isStaff(p: Principal): p is StaffPrincipal {
  return p.kind === 'staff';
}

export function isVendor(p: Principal): p is VendorPrincipal {
  return p.kind === 'vendor';
}

/**
 * Throw ForbiddenError unless the principal is a staff user with one of the
 * allowed roles. Vendors always fail this guard (they have no staff role).
 */
export function requireRole(principal: Principal, ...allowed: UserRole[]): StaffPrincipal {
  if (!isStaff(principal)) {
    throw new ForbiddenError('Staff role required for this endpoint');
  }
  if (!allowed.includes(principal.role)) {
    throw new ForbiddenError(`Role '${principal.role}' not permitted here`);
  }
  return principal;
}

/**
 * Throw ForbiddenError unless the principal is a vendor. Used to gate the
 * `/vendor/*` endpoints — a staff JWT should never satisfy this guard.
 */
export function requireVendor(principal: Principal): VendorPrincipal {
  if (!isVendor(principal)) {
    throw new ForbiddenError('Vendor invite token required for this endpoint');
  }
  return principal;
}

/**
 * Enforce tenant boundary — every DB query using a client-supplied ID must
 * also filter by the principal's `orgId`. This helper is called at the query
 * layer, not the route layer, to prevent cross-org data leakage even if a
 * route forgets to scope.
 */
export function assertSameOrg(principal: Principal, resourceOrgId: string): void {
  if (principal.orgId !== resourceOrgId) {
    throw new ForbiddenError('Cross-organization access denied');
  }
}

/**
 * Reviewer-scope predicate — returns the role a reviewer principal should use
 * when filtering `routing_rules` to controls in their domain. Non-reviewer
 * staff (admin, risk_manager) get `null` meaning "no reviewer scoping"; caller
 * must handle that (typically: admin sees all, risk_manager sees all).
 */
export function reviewerScopeRole(principal: StaffPrincipal): RoutableRole | null {
  if (principal.role === 'cyber_reviewer' || principal.role === 'legal_reviewer') {
    return principal.role;
  }
  return null;
}
