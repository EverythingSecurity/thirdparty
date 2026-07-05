/**
 * Vendor invite token helpers.
 *
 * Design (blueprint §5.1):
 *   - Raw token is cryptographically random ≥256-bit, opaque, base64url-encoded.
 *   - Server never persists or logs the raw token.
 *   - Stored form is HMAC-SHA256(pepper, token) so we can index/lookup in O(1).
 *   - Pepper is a server secret (env `VENDOR_TOKEN_PEPPER`); rotating it invalidates
 *     all existing tokens (acceptable — issue new invites).
 *   - Comparison uses constant-time equality (via `timingSafeEqual`) even though
 *     we look up by hash — belt-and-braces against any future direct compare.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** ≥256-bit entropy — blueprint §5.1. 32 bytes → 43-char base64url string. */
const TOKEN_BYTES = 32;

export interface IssuedToken {
  /** Raw token — returned to the admin ONCE at issue time, never stored. */
  raw: string;
  /** Hash to persist in `vendor_invites.token_hash`. */
  hash: string;
}

export function issueVendorToken(pepper: string): IssuedToken {
  const raw = randomBytes(TOKEN_BYTES).toString('base64url');
  return { raw, hash: hashVendorToken(raw, pepper) };
}

export function hashVendorToken(raw: string, pepper: string): string {
  return createHmac('sha256', pepper).update(raw).digest('hex');
}

/**
 * Constant-time comparison of two hex-encoded hashes. Both must be identical
 * length; a length mismatch returns false without leaking timing info.
 */
export function constantTimeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
  } catch {
    return false;
  }
}

/**
 * Basic shape check on an incoming token before we do a DB lookup — cheap
 * pre-filter that avoids exposing DB latency to obvious garbage.
 */
export function isPlausibleTokenShape(v: unknown): v is string {
  if (typeof v !== 'string') return false;
  // base64url of 32 bytes = 43 chars, no padding. Allow a small margin for
  // future length changes but reject clearly malformed input.
  return v.length >= 32 && v.length <= 128 && /^[A-Za-z0-9_-]+$/.test(v);
}
