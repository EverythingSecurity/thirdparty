import { describe, it, expect } from 'vitest';
import {
  requireRole,
  requireVendor,
  assertSameOrg,
  reviewerScopeRole,
  ForbiddenError,
  isStaff,
  isVendor,
} from '@vsa/shared';
import type { StaffPrincipal, VendorPrincipal } from '@vsa/shared';

const staff = (role: StaffPrincipal['role']): StaffPrincipal => ({
  kind: 'staff',
  userId: '11111111-1111-1111-1111-111111111111',
  orgId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  role,
  email: 't@test.local',
});

const vendor: VendorPrincipal = {
  kind: 'vendor',
  inviteId: '22222222-2222-2222-2222-222222222222',
  assessmentId: '33333333-3333-3333-3333-333333333333',
  vendorId: '44444444-4444-4444-4444-444444444444',
  orgId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
};

describe('RBAC guards', () => {
  it('requireRole passes when role matches', () => {
    const p = staff('admin');
    expect(() => requireRole(p, 'admin')).not.toThrow();
  });

  it('requireRole passes when role is one of many', () => {
    const p = staff('cyber_reviewer');
    expect(() => requireRole(p, 'cyber_reviewer', 'legal_reviewer')).not.toThrow();
  });

  it('requireRole 403s when role mismatches', () => {
    const p = staff('cyber_reviewer');
    expect(() => requireRole(p, 'admin')).toThrow(ForbiddenError);
  });

  it('requireRole 403s a vendor principal even if roles include admin', () => {
    // Regression: vendor tokens must never satisfy a staff-role guard.
    expect(() => requireRole(vendor, 'admin')).toThrow(ForbiddenError);
  });

  it('requireVendor passes on vendor principal', () => {
    expect(() => requireVendor(vendor)).not.toThrow();
  });

  it('requireVendor 403s a staff principal', () => {
    expect(() => requireVendor(staff('admin'))).toThrow(ForbiddenError);
  });

  it('assertSameOrg 403s cross-org access', () => {
    const p = staff('admin');
    expect(() => assertSameOrg(p, 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb')).toThrow(ForbiddenError);
  });

  it('assertSameOrg passes same-org access', () => {
    const p = staff('admin');
    expect(() => assertSameOrg(p, p.orgId)).not.toThrow();
  });

  it('reviewerScopeRole returns reviewer role for reviewers, null otherwise', () => {
    expect(reviewerScopeRole(staff('cyber_reviewer'))).toBe('cyber_reviewer');
    expect(reviewerScopeRole(staff('legal_reviewer'))).toBe('legal_reviewer');
    expect(reviewerScopeRole(staff('admin'))).toBeNull();
    expect(reviewerScopeRole(staff('risk_manager'))).toBeNull();
  });

  it('type guards discriminate correctly', () => {
    expect(isStaff(staff('admin'))).toBe(true);
    expect(isStaff(vendor)).toBe(false);
    expect(isVendor(vendor)).toBe(true);
    expect(isVendor(staff('admin'))).toBe(false);
  });
});
