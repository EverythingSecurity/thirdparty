import { Navigate, useLocation } from 'react-router-dom';
import type { ReactNode } from 'react';
import { useAuth } from '../lib/auth';
import type { UserRole } from '@vsa/shared';

interface Props {
  /** If empty, any authenticated staff is allowed. */
  roles?: UserRole[];
  children: ReactNode;
}

/**
 * Route guard for staff surfaces. Vendor routes have their own token flow
 * (see /vendor/:token entrypoint) so this guard does NOT authorize vendors.
 *
 * Note: UI hiding is NEVER the sole authorization mechanism — the API
 * re-checks role on every request (blueprint §5.2). This is just about
 * routing users to the right screen.
 */
export function ProtectedRoute({ roles, children }: Props) {
  const { principal } = useAuth();
  const location = useLocation();

  if (!principal || principal.kind !== 'staff') {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }
  if (roles && !roles.includes(principal.role)) {
    return <Navigate to="/unauthorized" replace />;
  }
  return <>{children}</>;
}
