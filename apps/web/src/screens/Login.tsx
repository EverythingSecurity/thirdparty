import { useState, type FormEvent } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { ErrorMessage } from '../components/ErrorMessage';

/**
 * Dev-mode login screen — accepts a staff JWT pasted from the
 * `npm run --workspace=@vsa/api dev:tokens` output. Sprint 7 replaces this
 * with an Entra ID OIDC PKCE flow; the shape of the auth context stays the
 * same so this screen swaps out with no other changes.
 */
export function Login() {
  const { loginStaff } = useAuth();
  const nav = useNavigate();
  const loc = useLocation();
  const [token, setToken] = useState('');
  const [err, setErr] = useState<Error | null>(null);

  function onSubmit(e: FormEvent): void {
    e.preventDefault();
    setErr(null);
    try {
      loginStaff(token.trim());
      const from = (loc.state as { from?: { pathname: string } })?.from?.pathname ?? '/';
      nav(from, { replace: true });
    } catch (e) {
      setErr(e as Error);
    }
  }

  return (
    <div className="max-w-md mx-auto mt-24 px-4">
      <div className="card p-6">
        <h1 className="text-lg font-semibold">Sign in</h1>
        <p className="text-sm text-slate-600 mt-1">
          Paste a staff JWT (dev). Get one via <code>npm run --workspace=@vsa/api dev:tokens</code>.
        </p>
        <form onSubmit={onSubmit} className="mt-4 space-y-3">
          <textarea
            className="field h-32 font-mono text-xs"
            placeholder="eyJhbGciOi..."
            value={token}
            onChange={(e) => setToken(e.target.value)}
            aria-label="JWT token"
          />
          <ErrorMessage error={err} />
          <button type="submit" className="btn btn-primary w-full" disabled={!token.trim()}>
            Sign in
          </button>
        </form>
        <p className="text-xs text-slate-500 mt-4">
          Vendors use their invite link, not this form.
        </p>
      </div>
    </div>
  );
}
