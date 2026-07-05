/**
 * Reviewer Window — Wireframe 1d (Three-Column Sidecar).
 *
 * Layout: [ Vendor picker / domain rail ] | [ Read-only vendor response ] | [ AI panel ]
 *
 * Sprint 4 scope:
 *   - Full read of vendor responses + AI content (blueprint §4 review endpoints).
 *   - Regenerate button (calls POST /ai/regenerate).
 *   - Accept / Edit / Override UI is present but the "Save verdict" action is
 *     DISABLED — the POST /review/:vendorId/control/:controlId/verdict endpoint
 *     lands in Sprint 5. The intent is captured in the UI so the flow is real.
 *
 * The AiDisclosure banner is always visible over any AI content region.
 */
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { AiDisclosure } from '../../components/AiDisclosure';
import { ErrorMessage } from '../../components/ErrorMessage';

interface PortfolioRow {
  vendor_id: string;
  name: string;
  status: string;
}
interface AiSummary {
  kind: string;
  generated_at: string;
  is_stale: boolean;
  model: string;
  content: string;
  disclosure: string;
}
interface AiGap {
  control_id: string;
  control_code: string;
  weight: number;
  gap_narrative: string;
  remediation: string;
  is_stale: boolean;
  generated_at: string;
  disclosure: string;
}

export function ReviewerWindow() {
  const { principal } = useAuth();
  const role = principal?.kind === 'staff' ? principal.role : null;
  const isReviewer = role === 'cyber_reviewer' || role === 'legal_reviewer';

  // Vendor list — reuse portfolio endpoint (RBAC filters org-scope server-side).
  // Reviewers won't hit /risk/portfolio directly (blueprint routes it to
  // risk_manager/admin), so we fall back to a lightweight vendor listing via
  // an admin endpoint in Sprint 5. For now we let admin/risk_manager preview
  // this screen and use their portfolio call.
  const vendors = useQuery<{ vendors: PortfolioRow[] }>({
    queryKey: ['reviewer-vendors'],
    queryFn: () => api.get('/risk/portfolio?page_size=50'),
    enabled: !!role,
  });

  const [selectedVendor, setSelectedVendor] = useState<string | null>(null);
  const currentVendor = selectedVendor ?? vendors.data?.vendors[0]?.vendor_id ?? null;

  return (
    <div className="max-w-7xl mx-auto px-4 py-4">
      <div className="mb-3 flex items-baseline justify-between">
        <div>
          <h1 className="text-lg font-semibold">Reviewer window</h1>
          {isReviewer ? (
            <p className="text-sm text-slate-600">Reviewing controls routed to {role}.</p>
          ) : (
            <p className="text-sm text-slate-600">Previewing as {role}.</p>
          )}
        </div>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-[220px_1fr_1fr] gap-4">
        <VendorList
          rows={vendors.data?.vendors ?? []}
          selected={currentVendor}
          onSelect={setSelectedVendor}
        />
        {currentVendor ? (
          <>
            <VendorResponsesPane vendorId={currentVendor} />
            <AiPanel vendorId={currentVendor} />
          </>
        ) : (
          <div className="md:col-span-2 card p-6 text-sm text-slate-600">
            Select a vendor to begin.
          </div>
        )}
      </div>
    </div>
  );
}

function VendorList({
  rows,
  selected,
  onSelect,
}: {
  rows: PortfolioRow[];
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <aside className="card p-2 h-fit">
      <div className="text-xs font-medium text-slate-500 uppercase tracking-wide px-2 py-1">
        Vendors
      </div>
      <ul>
        {rows.map((r) => (
          <li key={r.vendor_id}>
            <button
              onClick={() => onSelect(r.vendor_id)}
              className={`w-full text-left px-2 py-2 rounded ${
                selected === r.vendor_id ? 'bg-slate-900 text-white' : 'hover:bg-slate-100'
              }`}
            >
              <div className="text-sm font-medium">{r.name}</div>
              <div className={`text-xs ${selected === r.vendor_id ? 'text-slate-300' : 'text-slate-500'}`}>
                {r.status}
              </div>
            </button>
          </li>
        ))}
      </ul>
    </aside>
  );
}

// ------------------------------------------------------------
// Vendor responses pane — Sprint 4 uses AI /gaps as the driver
// (per-control list). A dedicated GET /review/:vendorId/domain endpoint
// lands in Sprint 5 with the full read-only vendor response payload.
// ------------------------------------------------------------

function VendorResponsesPane({ vendorId }: { vendorId: string }) {
  const gaps = useQuery<{ items: AiGap[] }>({
    queryKey: ['ai-gaps', vendorId],
    queryFn: () => api.get(`/ai/gaps/${vendorId}`),
  });

  return (
    <section className="card p-4">
      <h2 className="text-sm font-semibold text-slate-700 mb-3">Vendor responses (worst-first)</h2>
      {gaps.isLoading && <p className="text-sm text-slate-600">Loading…</p>}
      {gaps.error && <ErrorMessage error={gaps.error} />}
      <ol className="space-y-3">
        {gaps.data?.items.map((g) => (
          <li key={g.control_id} className="border border-slate-200 rounded p-3">
            <div className="flex items-baseline justify-between">
              <div className="text-xs font-mono text-slate-500">
                {g.control_code} · weight {g.weight}
              </div>
              {g.is_stale && (
                <span className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-1.5">
                  stale
                </span>
              )}
            </div>
            <div className="text-sm mt-1">Non-compliant — see AI panel for gap detail.</div>
          </li>
        ))}
        {gaps.data && gaps.data.items.length === 0 && (
          <li className="text-sm text-slate-600">No non-compliant controls in this reviewer's scope.</li>
        )}
      </ol>
    </section>
  );
}

// ------------------------------------------------------------
// AI panel — tabbed Summary / Gaps
// ------------------------------------------------------------

function AiPanel({ vendorId }: { vendorId: string }) {
  const [tab, setTab] = useState<'summary' | 'gaps'>('summary');
  const qc = useQueryClient();

  const summary = useQuery<AiSummary>({
    queryKey: ['ai-summary', vendorId],
    queryFn: () => api.get(`/ai/summary/${vendorId}`),
  });
  const gaps = useQuery<{ items: AiGap[] }>({
    queryKey: ['ai-gaps', vendorId],
    queryFn: () => api.get(`/ai/gaps/${vendorId}`),
  });

  const regen = useMutation({
    mutationFn: () => api.post(`/ai/regenerate/${vendorId}`, { force: true }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['ai-summary', vendorId] });
      qc.invalidateQueries({ queryKey: ['ai-gaps', vendorId] });
    },
  });

  return (
    <section className="card overflow-hidden">
      <AiDisclosure />
      <div className="border-b border-slate-200 flex items-center justify-between px-2">
        <div className="flex">
          <TabButton active={tab === 'summary'} onClick={() => setTab('summary')}>
            Summary
          </TabButton>
          <TabButton active={tab === 'gaps'} onClick={() => setTab('gaps')}>
            Gaps
          </TabButton>
        </div>
        <button className="btn text-xs my-1" onClick={() => regen.mutate()} disabled={regen.isPending}>
          {regen.isPending ? 'Regenerating…' : '⟳ Regenerate'}
        </button>
      </div>
      <div className="p-4">
        {tab === 'summary' && (
          <SummaryContent
            data={summary.data ?? null}
            loading={summary.isLoading}
            error={summary.error}
          />
        )}
        {tab === 'gaps' && (
          <GapsContent
            items={gaps.data?.items ?? []}
            loading={gaps.isLoading}
            error={gaps.error}
          />
        )}
        {regen.error && <div className="mt-3"><ErrorMessage error={regen.error} /></div>}
      </div>
    </section>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px ${
        active ? 'border-slate-900 text-slate-900' : 'border-transparent text-slate-500 hover:text-slate-800'
      }`}
    >
      {children}
    </button>
  );
}

function SummaryContent({
  data,
  loading,
  error,
}: {
  data: AiSummary | null;
  loading: boolean;
  error: unknown;
}) {
  if (loading) return <p className="text-sm text-slate-600">Loading AI summary…</p>;
  if (error) return <ErrorMessage error={error} />;
  if (!data) return <p className="text-sm text-slate-600">No summary generated yet.</p>;
  return (
    <div>
      {data.is_stale && (
        <div className="mb-2 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1">
          This summary is stale — evidence has changed since it was generated.
        </div>
      )}
      <pre className="text-sm whitespace-pre-wrap font-sans leading-relaxed">{data.content}</pre>
      <div className="mt-3 text-xs text-slate-500">
        Model: {data.model} · Generated: {new Date(data.generated_at).toLocaleString()}
      </div>
    </div>
  );
}

function GapsContent({
  items,
  loading,
  error,
}: {
  items: AiGap[];
  loading: boolean;
  error: unknown;
}) {
  if (loading) return <p className="text-sm text-slate-600">Loading gaps…</p>;
  if (error) return <ErrorMessage error={error} />;
  if (items.length === 0)
    return <p className="text-sm text-slate-600">No non-compliant gaps in scope.</p>;
  return (
    <ol className="space-y-4">
      {items.map((g) => (
        <li key={g.control_id} className="border border-slate-200 rounded p-3">
          <div className="flex items-baseline justify-between">
            <div className="text-xs font-mono text-slate-500">
              {g.control_code} · weight {g.weight}
            </div>
            <AiDisclosure variant="inline" />
          </div>
          <h3 className="mt-2 text-sm font-semibold">Gap</h3>
          <pre className="text-sm whitespace-pre-wrap font-sans">{g.gap_narrative}</pre>
          <h3 className="mt-3 text-sm font-semibold">Recommended remediation</h3>
          <pre className="text-sm whitespace-pre-wrap font-sans">{g.remediation}</pre>
          <VerdictBar controlId={g.control_id} />
        </li>
      ))}
    </ol>
  );
}

// ------------------------------------------------------------
// Verdict bar — Sprint 4 collects intent locally; POST lands in Sprint 5.
// ------------------------------------------------------------

function VerdictBar({ controlId: _controlId }: { controlId: string }) {
  const [action, setAction] = useState<'accept' | 'edit' | 'override' | null>(null);
  const [comment, setComment] = useState('');
  const needsComment = action === 'override';

  return (
    <div className="mt-3 pt-3 border-t border-slate-100">
      <div className="flex flex-wrap gap-2 items-center">
        {(['accept', 'edit', 'override'] as const).map((a) => (
          <button
            key={a}
            onClick={() => setAction(a)}
            className={`btn text-xs ${action === a ? 'btn-primary' : ''}`}
          >
            {a === 'accept' ? 'Accept AI' : a === 'edit' ? 'Edit' : 'Override'}
          </button>
        ))}
        <button className="btn text-xs" disabled title="Available in Sprint 5">
          Save verdict (pending)
        </button>
      </div>
      {needsComment && (
        <textarea
          className="field h-16 mt-2 text-sm"
          placeholder="Comment required for override…"
          value={comment}
          onChange={(e) => setComment(e.target.value)}
        />
      )}
    </div>
  );
}
