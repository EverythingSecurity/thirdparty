/**
 * Auth context — two token kinds, mutually exclusive per browser session:
 *   - Staff JWT (from Entra ID in prod; from `dev-tokens` CLI in dev). Stored
 *     in localStorage for Sprint 4 dev ergonomics. Sprint 7 switches to
 *     httpOnly Secure SameSite=Strict cookies (blueprint §5.1).
 *   - Vendor invite token — kept in memory only, rehydrated from the URL on
 *     each mount. Bearer secrets should NOT survive a browser session.
 *
 * The decoder ONLY inspects the JWT payload for UI purposes (name/role); the
 * server always re-validates on every request (blueprint §5.2 — RBAC lives
 * in the service/query layer, not the UI).
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { UserRole } from '@vsa/shared';
import { setTokenProvider } from './api';

const STORAGE_KEY = 'vsa.staff.jwt';

export interface StaffPrincipal {
  kind: 'staff';
  userId: string;
  orgId: string;
  role: UserRole;
  email: string;
  token: string;
}

export interface VendorPrincipal {
  kind: 'vendor';
  token: string;
}

export type Principal = StaffPrincipal | VendorPrincipal;

interface AuthState {
  principal: Principal | null;
  loginStaff(token: string): void;
  loginVendor(token: string): void;
  logout(): void;
}

const AuthContext = createContext<AuthState | null>(null);

/**
 * Decode a JWT payload UI-side. Returns null on any malformed input — this
 * is UI-only; server re-verifies signature + claims on every request.
 */
function decodeJwt(token: string): {
  sub?: string;
  org_id?: string;
  role?: UserRole;
  email?: string;
} | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const payload = parts[1]!;
    // base64url → base64
    const b64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    const json = atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, '='));
    return JSON.parse(json);
  } catch {
    return null;
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [principal, setPrincipal] = useState<Principal | null>(() => {
    // Rehydrate staff JWT from localStorage.
    if (typeof window === 'undefined') return null;
    const jwt = window.localStorage.getItem(STORAGE_KEY);
    if (!jwt) return null;
    const claims = decodeJwt(jwt);
    if (!claims?.sub || !claims.org_id || !claims.role || !claims.email) return null;
    return {
      kind: 'staff',
      userId: claims.sub,
      orgId: claims.org_id,
      role: claims.role,
      email: claims.email,
      token: jwt,
    };
  });

  // Wire the API client's token provider once — it reads the current principal
  // via a closure so we don't need to prop-drill tokens into every call site.
  useEffect(() => {
    setTokenProvider(() => principal?.token ?? null);
  }, [principal]);

  const loginStaff = useCallback((token: string): void => {
    const claims = decodeJwt(token);
    if (!claims?.sub || !claims.org_id || !claims.role || !claims.email) {
      throw new Error('Invalid staff token');
    }
    window.localStorage.setItem(STORAGE_KEY, token);
    setPrincipal({
      kind: 'staff',
      userId: claims.sub,
      orgId: claims.org_id,
      role: claims.role,
      email: claims.email,
      token,
    });
  }, []);

  const loginVendor = useCallback((token: string): void => {
    // Vendor tokens are memory-only.
    setPrincipal({ kind: 'vendor', token });
  }, []);

  const logout = useCallback((): void => {
    window.localStorage.removeItem(STORAGE_KEY);
    setPrincipal(null);
  }, []);

  const value = useMemo(
    () => ({ principal, loginStaff, loginVendor, logout }),
    [principal, loginStaff, loginVendor, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}

/** Narrowing hook — throws if the caller isn't a staff principal of the given role(s). */
export function useStaff(...allowed: UserRole[]): StaffPrincipal | null {
  const { principal } = useAuth();
  if (!principal || principal.kind !== 'staff') return null;
  if (allowed.length > 0 && !allowed.includes(principal.role)) return null;
  return principal;
}
