/**
 * Auth plugin — resolves `request.principal` from the Authorization header.
 *
 * The plugin itself is NON-BLOCKING: it attaches a principal if the header
 * validates, and leaves `request.principal` undefined otherwise. Routes then
 * declare their auth requirement explicitly via `requireStaffAuth`/`requireVendorAuth`
 * preHandlers.
 *
 * Two auth paths (blueprint §5.1):
 *   - `Authorization: Bearer <jwt>`  → staff principal (JWT with sub/org_id/role)
 *   - `Authorization: Bearer <opaque_token>` → vendor principal (HMAC-hashed lookup)
 *
 * We distinguish them by token shape: JWTs have three dot-separated base64url
 * segments; vendor tokens do not. On ambiguity we try JWT first, fall back to
 * vendor lookup.
 */
import fp from 'fastify-plugin';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { UnauthenticatedError, GoneError } from '@vsa/shared';
import type { Principal, StaffPrincipal, VendorPrincipal } from '@vsa/shared';
import { verifyStaffJwt } from '../lib/jwt.js';
import { hashVendorToken, isPlausibleTokenShape } from '../lib/vendor-token.js';
import { getPrisma } from '../db.js';
import { loadEnv } from '../env.js';

declare module 'fastify' {
  interface FastifyRequest {
    principal?: Principal;
  }
}

const BEARER_RE = /^Bearer\s+(.+)$/i;
const JWT_SHAPE_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

function extractBearer(req: FastifyRequest): string | null {
  const header = req.headers.authorization;
  if (!header || typeof header !== 'string') return null;
  const match = BEARER_RE.exec(header);
  return match ? (match[1] ?? null) : null;
}

async function resolveStaffPrincipal(token: string): Promise<StaffPrincipal | null> {
  if (!JWT_SHAPE_RE.test(token)) return null;
  const env = loadEnv();
  try {
    const claims = await verifyStaffJwt(token, {
      issuer: env.JWT_ISSUER,
      audience: env.JWT_AUDIENCE,
      secret: env.JWT_DEV_SECRET,
    });
    return {
      kind: 'staff',
      userId: claims.sub,
      orgId: claims.org_id,
      role: claims.role,
      email: claims.email,
    };
  } catch {
    return null;
  }
}

async function resolveVendorPrincipal(token: string): Promise<VendorPrincipal | null> {
  if (!isPlausibleTokenShape(token)) return null;
  const env = loadEnv();
  const hash = hashVendorToken(token, env.VENDOR_TOKEN_PEPPER);
  const invite = await getPrisma().vendorInvite.findUnique({
    where: { tokenHash: hash },
    include: { assessment: { select: { id: true, vendorId: true, organizationId: true } } },
  });
  if (!invite) return null;

  // Check lifecycle. Throw a distinct error (410 Gone) for expired/revoked so
  // the client can route to the "your invite has expired" screen without
  // confusing it with an unknown-token case (which we treat as 401).
  const now = new Date();
  if (invite.revokedAt || invite.expiresAt <= now) {
    throw new GoneError('invite_expired', 'This invite is no longer valid');
  }

  return {
    kind: 'vendor',
    inviteId: invite.id,
    assessmentId: invite.assessment.id,
    vendorId: invite.assessment.vendorId,
    orgId: invite.assessment.organizationId,
  };
}

const authPlugin: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', async (req) => {
    const token = extractBearer(req);
    if (!token) return;

    // Try staff JWT first (cheap, no DB hit). If it fails, try vendor lookup.
    const staff = await resolveStaffPrincipal(token);
    if (staff) {
      req.principal = staff;
      return;
    }
    const vendor = await resolveVendorPrincipal(token);
    if (vendor) {
      req.principal = vendor;
    }
    // If neither matched, we leave `principal` undefined. Guards decide 401.
  });
};

export default fp(authPlugin, { name: 'auth' });

/** Route preHandler: enforce a staff principal is attached. */
export async function requireStaffAuth(req: FastifyRequest): Promise<void> {
  if (!req.principal) throw new UnauthenticatedError();
  if (req.principal.kind !== 'staff') {
    throw new UnauthenticatedError('Staff authentication required');
  }
}

/** Route preHandler: enforce a vendor principal is attached. */
export async function requireVendorAuth(req: FastifyRequest): Promise<void> {
  if (!req.principal) throw new UnauthenticatedError();
  if (req.principal.kind !== 'vendor') {
    throw new UnauthenticatedError('Vendor invite token required');
  }
}
