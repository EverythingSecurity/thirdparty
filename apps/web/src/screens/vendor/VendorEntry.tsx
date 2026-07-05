import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../../lib/auth';

/**
 * Vendor landing — accepts an invite token via ?token=<t> (email link) or
 * manual paste. On success, loads the vendor session and redirects to the
 * checklist portal.
 */
export function VendorEntry() {
  const { loginVendor } = useAuth();
  const [params] = useSearchParams();
  const nav = useNavigate();
  const urlToken = params.get('token');
  const [token, setToken] = useState(urlToken ?? '');

  useEffect(() => {
    if (urlToken) {
      loginVendor(urlToken);
      nav('/vendor', { replace: true });
    }
  }, [urlToken, loginVendor, nav]);

  function onSubmit(e: FormEvent): void {
    e.preventDefault();
    const t = token.trim();
    if (!t) return;
    loginVendor(t);
    nav('/vendor', { replace: true });
  }

  return (
    <div className="max-w-md mx-auto mt-24 px-4">
      <div className="card p-6">
        <h1 className="text-lg font-semibold">Vendor Assessment Portal</h1>
        <p className="text-sm text-slate-600 mt-1">
          Enter the invite token from your email to begin.
        </p>
        <form onSubmit={onSubmit} className="mt-4 space-y-3">
          <input
            className="field font-mono"
            placeholder="Invite token"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            aria-label="Invite token"
          />
          <button type="submit" className="btn btn-primary w-full" disabled={!token.trim()}>
            Continue
          </button>
        </form>
      </div>
    </div>
  );
}
