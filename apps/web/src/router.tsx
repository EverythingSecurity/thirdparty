import { createBrowserRouter, Navigate } from 'react-router-dom';
import { StaffLayout } from './components/Layout';
import { ProtectedRoute } from './components/ProtectedRoute';
import { Login } from './screens/Login';
import { VendorEntry } from './screens/vendor/VendorEntry';
import { ChecklistPortal } from './screens/vendor/ChecklistPortal';
import { ReviewerWindow } from './screens/reviewer/ReviewerWindow';
import { Portfolio } from './screens/risk/Portfolio';
import { VendorVerdict } from './screens/risk/VendorVerdict';
import { AdminConsole } from './screens/admin/ControlLibrary';

/**
 * Route table.
 *
 * Vendor surface: `/vendor` (portal) + `/vendor/enter` (token exchange).
 * Staff surface: everything else, wrapped in `StaffLayout` + `ProtectedRoute`.
 * Role gating on staff routes is UX-only — API is the enforcement point.
 */
export const router = createBrowserRouter([
  { path: '/login', element: <Login /> },

  // Vendor surface — no StaffLayout, no ProtectedRoute (uses vendor token).
  { path: '/vendor/enter', element: <VendorEntry /> },
  { path: '/vendor', element: <ChecklistPortal /> },

  // Staff surface
  {
    element: <StaffLayout><div /></StaffLayout>,
    children: [],
  },
  {
    path: '/',
    element: <ProtectedRoute><StaffLayout><HomeRedirect /></StaffLayout></ProtectedRoute>,
  },
  {
    path: '/review',
    element: (
      <ProtectedRoute roles={['cyber_reviewer', 'legal_reviewer', 'admin', 'risk_manager']}>
        <StaffLayout>
          <ReviewerWindow />
        </StaffLayout>
      </ProtectedRoute>
    ),
  },
  {
    path: '/risk',
    element: (
      <ProtectedRoute roles={['risk_manager', 'admin']}>
        <StaffLayout>
          <Portfolio />
        </StaffLayout>
      </ProtectedRoute>
    ),
  },
  {
    path: '/risk/:vendorId',
    element: (
      <ProtectedRoute roles={['risk_manager', 'admin']}>
        <StaffLayout>
          <VendorVerdict />
        </StaffLayout>
      </ProtectedRoute>
    ),
  },
  {
    path: '/admin/controls',
    element: (
      <ProtectedRoute roles={['admin']}>
        <StaffLayout>
          <AdminConsole />
        </StaffLayout>
      </ProtectedRoute>
    ),
  },

  {
    path: '/unauthorized',
    element: (
      <StaffLayout>
        <div className="max-w-md mx-auto mt-24 px-4 text-center">
          <h1 className="text-lg font-semibold">Not authorized</h1>
          <p className="text-sm text-slate-600 mt-2">
            Your role can't access that page. Contact an admin if you think this is wrong.
          </p>
        </div>
      </StaffLayout>
    ),
  },
  { path: '*', element: <Navigate to="/" replace /> },
]);

function HomeRedirect() {
  // Send staff to their role-appropriate default landing.
  const role = (() => {
    try {
      const raw = localStorage.getItem('vsa.staff.jwt');
      if (!raw) return null;
      const claim = JSON.parse(atob(raw.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/')));
      return claim.role as string | null;
    } catch {
      return null;
    }
  })();
  if (role === 'admin') return <Navigate to="/admin/controls" replace />;
  if (role === 'cyber_reviewer' || role === 'legal_reviewer') return <Navigate to="/review" replace />;
  return <Navigate to="/risk" replace />;
}
