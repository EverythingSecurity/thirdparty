import type { ReactNode } from 'react';
import { Link, NavLink } from 'react-router-dom';
import { useAuth } from '../lib/auth';

interface Props {
  children: ReactNode;
}

/** Staff app shell — header + nav + main content region. Vendor portal renders standalone. */
export function StaffLayout({ children }: Props) {
  const { principal, logout } = useAuth();
  const isStaff = principal?.kind === 'staff';
  const role = isStaff ? principal.role : null;

  return (
    <div className="min-h-screen flex flex-col">
      <header className="bg-white border-b border-slate-200">
        <div className="max-w-7xl mx-auto px-4 py-3 flex items-center justify-between">
          <Link to="/" className="font-semibold tracking-tight">
            VSA <span className="text-slate-400 font-normal">/ Vendor Security Assessment</span>
          </Link>
          {isStaff && (
            <nav className="flex items-center gap-4 text-sm">
              {(role === 'risk_manager' || role === 'admin') && (
                <NavLink to="/risk" className={navClass}>
                  Portfolio
                </NavLink>
              )}
              {(role === 'cyber_reviewer' || role === 'legal_reviewer') && (
                <NavLink to="/review" className={navClass}>
                  Review
                </NavLink>
              )}
              {role === 'admin' && (
                <NavLink to="/admin/controls" className={navClass}>
                  Admin
                </NavLink>
              )}
              <span className="text-slate-500 text-xs">
                {principal.email} · {role}
              </span>
              <button className="btn text-xs" onClick={logout}>
                Log out
              </button>
            </nav>
          )}
        </div>
      </header>
      <main className="flex-1">{children}</main>
    </div>
  );
}

function navClass({ isActive }: { isActive: boolean }): string {
  return `text-sm ${isActive ? 'text-slate-900 font-medium' : 'text-slate-600 hover:text-slate-900'}`;
}
