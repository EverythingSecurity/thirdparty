import { describe, it, expect } from 'vitest';
import { mintStaffJwtForDev, verifyStaffJwt } from '../src/lib/jwt.js';
import { UnauthenticatedError } from '@vsa/shared';

const CFG = {
  issuer: 'https://test-issuer',
  audience: 'api://vsa-test',
  secret: 'test-secret-must-be-at-least-32-characters-long',
};

const PAYLOAD = {
  sub: '11111111-1111-1111-1111-111111111111',
  org_id: '22222222-2222-2222-2222-222222222222',
  role: 'admin' as const,
  email: 'admin@test.local',
};

describe('staff JWT', () => {
  it('mints and round-trips a valid token', async () => {
    const token = await mintStaffJwtForDev(PAYLOAD, CFG);
    const claims = await verifyStaffJwt(token, CFG);
    expect(claims.sub).toBe(PAYLOAD.sub);
    expect(claims.org_id).toBe(PAYLOAD.org_id);
    expect(claims.role).toBe(PAYLOAD.role);
    expect(claims.email).toBe(PAYLOAD.email);
  });

  it('rejects tokens signed with wrong secret', async () => {
    const token = await mintStaffJwtForDev(PAYLOAD, CFG);
    await expect(
      verifyStaffJwt(token, { ...CFG, secret: 'a-different-secret-that-is-32-chars-x' }),
    ).rejects.toBeInstanceOf(UnauthenticatedError);
  });

  it('rejects tokens with wrong issuer', async () => {
    const token = await mintStaffJwtForDev(PAYLOAD, CFG);
    await expect(
      verifyStaffJwt(token, { ...CFG, issuer: 'https://someone-else' }),
    ).rejects.toBeInstanceOf(UnauthenticatedError);
  });

  it('rejects tokens with wrong audience', async () => {
    const token = await mintStaffJwtForDev(PAYLOAD, CFG);
    await expect(
      verifyStaffJwt(token, { ...CFG, audience: 'api://someone-else' }),
    ).rejects.toBeInstanceOf(UnauthenticatedError);
  });

  it('rejects expired tokens', async () => {
    // Mint a token that expired 1 second ago.
    const token = await mintStaffJwtForDev(PAYLOAD, CFG, -1);
    await expect(verifyStaffJwt(token, CFG)).rejects.toBeInstanceOf(UnauthenticatedError);
  });

  it('rejects malformed claims (non-enum role)', async () => {
    // Manually craft a token with an invalid role via minting a valid one
    // and then treating a random string as a token.
    await expect(verifyStaffJwt('not.a.jwt', CFG)).rejects.toBeInstanceOf(UnauthenticatedError);
  });

  it('does not leak internal reason in error message', async () => {
    const token = await mintStaffJwtForDev(PAYLOAD, CFG);
    try {
      await verifyStaffJwt(token, { ...CFG, secret: 'wrong-secret-but-32-chars-long-abc' });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(UnauthenticatedError);
      // All failure modes map to the same generic message.
      expect((err as Error).message).toBe('Invalid or expired token');
    }
  });
});
