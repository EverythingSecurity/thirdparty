/**
 * User roles (mirrors the Postgres `user_role` enum and Prisma `UserRole`).
 * Redeclared here so that packages without a Prisma dependency (e.g. web SPA
 * in a later sprint) can still consume the type without pulling in the client.
 */
export const USER_ROLES = ['admin', 'cyber_reviewer', 'legal_reviewer', 'risk_manager'] as const;
export type UserRole = (typeof USER_ROLES)[number];

/** Roles that can appear in `routing_rules` (blueprint §3, CHECK constraint). */
export const ROUTABLE_ROLES = ['cyber_reviewer', 'legal_reviewer', 'risk_manager'] as const;
export type RoutableRole = (typeof ROUTABLE_ROLES)[number];

/** Roles that can post a `review_decisions` row. */
export const REVIEWER_DECISION_ROLES = ['cyber_reviewer', 'legal_reviewer'] as const;
export type ReviewerDecisionRole = (typeof REVIEWER_DECISION_ROLES)[number];

export function isUserRole(v: unknown): v is UserRole {
  return typeof v === 'string' && (USER_ROLES as readonly string[]).includes(v);
}

export function isRoutableRole(v: unknown): v is RoutableRole {
  return typeof v === 'string' && (ROUTABLE_ROLES as readonly string[]).includes(v);
}
