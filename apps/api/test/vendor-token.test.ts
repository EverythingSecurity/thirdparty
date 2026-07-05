import { describe, it, expect } from 'vitest';
import {
  issueVendorToken,
  hashVendorToken,
  constantTimeEqualHex,
  isPlausibleTokenShape,
} from '../src/lib/vendor-token.js';

const PEPPER = 'x'.repeat(64);

describe('vendor-token', () => {
  it('issued tokens have ≥256 bits of entropy (base64url ≥43 chars)', () => {
    const { raw } = issueVendorToken(PEPPER);
    expect(raw.length).toBeGreaterThanOrEqual(43);
    expect(raw).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('hash is deterministic for same (token, pepper)', () => {
    const t = 'test-token-abc123';
    expect(hashVendorToken(t, PEPPER)).toBe(hashVendorToken(t, PEPPER));
  });

  it('hash differs when pepper differs (rotation invalidates existing tokens)', () => {
    const t = 'test-token-abc123';
    expect(hashVendorToken(t, PEPPER)).not.toBe(hashVendorToken(t, 'y'.repeat(64)));
  });

  it('hash differs for different tokens under same pepper', () => {
    const a = issueVendorToken(PEPPER);
    const b = issueVendorToken(PEPPER);
    expect(a.raw).not.toBe(b.raw);
    expect(a.hash).not.toBe(b.hash);
  });

  it('constant-time equal returns true for identical hex, false otherwise', () => {
    const t = 'token-xyz';
    const h = hashVendorToken(t, PEPPER);
    expect(constantTimeEqualHex(h, h)).toBe(true);
    expect(constantTimeEqualHex(h, h.slice(0, -1) + '0')).toBe(false);
  });

  it('constant-time equal returns false on length mismatch without throwing', () => {
    expect(constantTimeEqualHex('deadbeef', 'deadbeefff')).toBe(false);
  });

  it('rejects garbage token shapes cheaply', () => {
    expect(isPlausibleTokenShape('')).toBe(false);
    expect(isPlausibleTokenShape('short')).toBe(false);
    expect(isPlausibleTokenShape('has spaces in it')).toBe(false);
    expect(isPlausibleTokenShape('has/slashes+plus=padding')).toBe(false);
    expect(isPlausibleTokenShape(null)).toBe(false);
    expect(isPlausibleTokenShape(undefined)).toBe(false);
    expect(isPlausibleTokenShape(123)).toBe(false);
  });

  it('accepts plausibly-shaped tokens', () => {
    const { raw } = issueVendorToken(PEPPER);
    expect(isPlausibleTokenShape(raw)).toBe(true);
  });
});
