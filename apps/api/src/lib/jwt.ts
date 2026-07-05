/**
 * Staff JWT verification.
 *
 * Sprint 1 uses symmetric HS256 signing with `JWT_DEV_SECRET` so the API can
 * mint + verify its own tokens locally. Sprint 3 will swap the verifier to
 * JWKS-based RS256 verification against Entra ID (`https://login.microsoftonline.com/{tenant}/discovery/v2.0/keys`),
 * with the same claim contract.
 *
 * Contract (blueprint §5.1):
 *   sub     — user id (uuid)
 *   org_id  — tenant id (uuid)
 *   role    — one of user_role enum
 *   iss/aud — issuer + audience must match env
 *   exp     — ≤15 min from issue
 */
import { SignJWT, jwtVerify } from 'jose';
import { z } from 'zod';
import { USER_ROLES } from '@vsa/shared';
import type { UserRole } from '@vsa/shared';
import { UnauthenticatedError } from '@vsa/shared';

export interface StaffJwtPayload {
  sub: string;
  org_id: string;
  role: UserRole;
  email: string;
}

const PayloadSchema = z.object({
  sub: z.string().uuid(),
  org_id: z.string().uuid(),
  role: z.enum(USER_ROLES),
  email: z.string().email(),
});

export interface JwtVerifierConfig {
  issuer: string;
  audience: string;
  secret: string;
}

export async function verifyStaffJwt(
  token: string,
  cfg: JwtVerifierConfig,
): Promise<StaffJwtPayload> {
  const key = new TextEncoder().encode(cfg.secret);
  let claims;
  try {
    const result = await jwtVerify(token, key, {
      issuer: cfg.issuer,
      audience: cfg.audience,
      algorithms: ['HS256'],
    });
    claims = result.payload;
  } catch (err) {
    // Do NOT surface the underlying jose error — treat all failures uniformly
    // to avoid leaking whether the token was expired vs. wrong-signature vs.
    // wrong-audience (each of those leaks information to an attacker).
    throw new UnauthenticatedError('Invalid or expired token');
  }
  const parsed = PayloadSchema.safeParse(claims);
  if (!parsed.success) {
    throw new UnauthenticatedError('Malformed token claims');
  }
  return parsed.data;
}

/**
 * Dev-only helper — mints an HS256 token with the standard claim set.
 * Used by tests and by a dev-only `/dev/token` endpoint in local mode.
 * Never enable this path in production.
 */
export async function mintStaffJwtForDev(
  payload: StaffJwtPayload,
  cfg: JwtVerifierConfig,
  ttlSeconds = 900,
): Promise<string> {
  const key = new TextEncoder().encode(cfg.secret);
  return new SignJWT({ ...payload })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(cfg.issuer)
    .setAudience(cfg.audience)
    .setSubject(payload.sub)
    .setIssuedAt()
    .setExpirationTime(`${ttlSeconds}s`)
    .sign(key);
}
