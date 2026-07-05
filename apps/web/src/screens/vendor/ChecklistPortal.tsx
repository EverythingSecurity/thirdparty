/**
 * Vendor Portal — Wireframe 1a (Stacked Cards + Domain Rail).
 *
 * Data flow:
 *   - GET /vendor/session for the assessment shell + per-domain progress.
 *   - GET /vendor/checklist?domain_id=... for the selected domain's questions.
 *   - PATCH /vendor/responses/:qid — debounced ~500ms; the "Saving.../Saved"
 *     indicator reflects the pending vs. resolved autosave state.
 *   - POST /vendor/evidence/:qid — multipart upload; DELETE for pre-submit removal.
 *   - GET /vendor/submit/validate → POST /vendor/submit.
 *
 * Guardrails implemented client-side that the server ALSO enforces:
 *   - Not Applicable requires a non-empty justification.
 *   - No writes after submission (UI disables inputs when `is_locked`).
 *   - Mime allow-list check before hitting the upload endpoint.
 */
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { api, ApiError } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { ErrorMessage } from '../../components/ErrorMessage';
import { useDebouncedCallback } from '../../hooks/useDebouncedCallback';

// ------------------------------------------------------------
// Types (mirror the API contract in blueprint §4)
// ------------------------------------------------------------

interface SessionDomain {
  control_domain_id: string;
  name: string;
  answered_count: number;
  total_count: number;
}
interface VendorSession {
  assessment_id: string;
  vendor_name: string;
  status: string;
  expires_at: string;
  domains: SessionDomain[];
}

interface EvidenceMeta {
  file_id: string;
  file_name: string;
  file_size_bytes: number;
  mime_type: string;
  uploaded_at: string;
}
interface ResponseState {
  response_value: 'compliant' | 'non_compliant' | 'not_applicable' | null;
  justification: string | null;
  evidence: EvidenceMeta[];
  is_locked: boolean;
}
interface ChecklistQuestion {
  question_id: string;
  control_id: string;
  control_domain_id: string;
  control_code: string;
  weight: number;
  question_text: string;
  requires_evidence: boolean;
  response: ResponseState;
}

const ALLOWED_MIME = [
  'application/pdf',
  'image/png',
  'image/jpeg',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
];

// ------------------------------------------------------------
// Screen
// ------------------------------------------------------------

export function ChecklistPortal() {
  const { principal, logout } = useAuth();
  const nav = useNavigate();
  const qc = useQueryClient();

  const session = useQuery<VendorSession>({
    queryKey: ['vendor-session'],
    queryFn: () => api.get('/vendor/session'),
    enabled: principal?.kind === 'vendor',
  });

  const [selectedDomain, setSelectedDomain] = useState<string | null>(null);
  useEffect(() => {
    if (!selectedDomain && session.data?.domains.length) {
      setSelectedDomain(session.data.domains[0]!.control_domain_id);
    }
  }, [session.data, selectedDomain]);

  const checklist = useQuery<{ questions: ChecklistQuestion[] }>({
    queryKey: ['vendor-checklist', selectedDomain],
    queryFn: () => api.get(`/vendor/checklist?domain_id=${selectedDomain}`),
    enabled: !!selectedDomain,
    placeholderData: keepPreviousData,
  });

  const [expanded, setExpanded] = useState<string | null>(null);

  // Redirect back to entry if vendor logs out or session errors as 401/410.
  useEffect(() => {
    if (session.error instanceof ApiError && [401, 410].includes(session.error.statusCode)) {
      logout();
      nav('/vendor/enter', { replace: true });
    }
  }, [session.error, logout, nav]);

  if (session.isLoading) return <p className="p-8 text-slate-600">Loading assessment…</p>;
  if (session.error) return <div className="p-8"><ErrorMessage error={session.error} /></div>;
  if (!session.data) return null;

  const isSubmitted = ['submitted', 'in_review', 'escalated', 'approved', 'conditional', 'rejected'].includes(
    session.data.status,
  );

  return (
    <div className="min-h-screen">
      <PortalHeader session={session.data} onLogout={logout} />
      {isSubmitted ? (
        <SubmittedNotice session={session.data} />
      ) : (
        <div className="max-w-6xl mx-auto px-4 py-6 grid grid-cols-1 md:grid-cols-[240px_1fr] gap-6">
          <DomainRail
            domains={session.data.domains}
            selected={selectedDomain}
            onSelect={setSelectedDomain}
          />
          <div className="space-y-3">
            {checklist.isLoading && <p className="text-sm text-slate-600">Loading questions…</p>}
            {checklist.data?.questions.map((q) => (
              <QuestionCard
                key={q.question_id}
                q={q}
                open={expanded === q.question_id}
                onToggle={() => setExpanded((v) => (v === q.question_id ? null : q.question_id))}
                onLocalChange={() =>
                  qc.invalidateQueries({ queryKey: ['vendor-session'] })
                }
              />
            ))}
            <SubmitFooter session={session.data} />
          </div>
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------
// Header + expiry badge
// ------------------------------------------------------------

function PortalHeader({ session, onLogout }: { session: VendorSession; onLogout: () => void }) {
  const expiresAt = new Date(session.expires_at);
  const daysLeft = Math.max(0, Math.ceil((expiresAt.getTime() - Date.now()) / 86_400_000));
  return (
    <header className="bg-white border-b border-slate-200">
      <div className="max-w-6xl mx-auto px-4 py-3 flex items-center justify-between">
        <div>
          <div className="text-sm text-slate-500">Vendor Portal</div>
          <div className="font-semibold">{session.vendor_name}</div>
        </div>
        <div className="flex items-center gap-3 text-sm">
          <span className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded border border-amber-300 bg-amber-50 text-amber-900">
            Invite expires in {daysLeft} day{daysLeft === 1 ? '' : 's'}
          </span>
          <button className="btn text-xs" onClick={onLogout}>
            Exit
          </button>
        </div>
      </div>
    </header>
  );
}

// ------------------------------------------------------------
// Domain rail
// ------------------------------------------------------------

function DomainRail({
  domains,
  selected,
  onSelect,
}: {
  domains: SessionDomain[];
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <aside className="card p-3 h-fit sticky top-4">
      <div className="text-xs font-medium text-slate-500 uppercase tracking-wide mb-2 px-2">
        Domains
      </div>
      <nav className="space-y-1">
        {domains.map((d) => {
          const pct = d.total_count === 0 ? 0 : Math.round((d.answered_count / d.total_count) * 100);
          const active = selected === d.control_domain_id;
          return (
            <button
              key={d.control_domain_id}
              onClick={() => onSelect(d.control_domain_id)}
              className={`w-full text-left px-2 py-2 rounded ${
                active ? 'bg-slate-900 text-white' : 'hover:bg-slate-100'
              }`}
            >
              <div className="text-sm font-medium">{d.name}</div>
              <div className={`text-xs mt-0.5 ${active ? 'text-slate-300' : 'text-slate-500'}`}>
                {d.answered_count} / {d.total_count} · {pct}%
              </div>
            </button>
          );
        })}
      </nav>
    </aside>
  );
}

// ------------------------------------------------------------
// Question card (stacked; one expanded at a time)
// ------------------------------------------------------------

type SaveState = 'idle' | 'saving' | 'saved' | 'error';

function QuestionCard({
  q,
  open,
  onToggle,
  onLocalChange,
}: {
  q: ChecklistQuestion;
  open: boolean;
  onToggle: () => void;
  onLocalChange: () => void;
}) {
  const qc = useQueryClient();
  const [state, setState] = useState<ResponseState>(q.response);
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [err, setErr] = useState<Error | null>(null);

  const patch = useMutation({
    mutationFn: (body: { response_value: string; justification?: string }) =>
      api.patch(`/vendor/responses/${q.question_id}`, body),
    onSuccess: () => {
      setSaveState('saved');
      onLocalChange();
    },
    onError: (e) => {
      setSaveState('error');
      setErr(e as Error);
    },
  });

  const flush = useDebouncedCallback((rv: string, just: string) => {
    setSaveState('saving');
    setErr(null);
    patch.mutate({ response_value: rv, justification: just || undefined });
  }, 500);

  function setResponse(rv: 'compliant' | 'non_compliant' | 'not_applicable'): void {
    setState((s) => ({ ...s, response_value: rv }));
    flush(rv, state.justification ?? '');
  }
  function setJustification(v: string): void {
    setState((s) => ({ ...s, justification: v }));
    if (state.response_value) flush(state.response_value, v);
  }

  const naNeedsJustification =
    state.response_value === 'not_applicable' &&
    (!state.justification || state.justification.trim().length === 0);

  return (
    <div className="card">
      <button
        onClick={onToggle}
        className="w-full px-4 py-3 flex items-center justify-between text-left"
      >
        <div>
          <div className="text-xs font-mono text-slate-500">
            {q.control_code} · weight {q.weight}
          </div>
          <div className="mt-0.5 font-medium">{q.question_text}</div>
        </div>
        <div className="flex items-center gap-2">
          <ResponsePill value={state.response_value} />
          <span className="text-slate-400 text-xl leading-none">{open ? '−' : '+'}</span>
        </div>
      </button>
      {open && (
        <div className="border-t border-slate-100 px-4 py-4 space-y-4">
          <div className="flex flex-wrap gap-2">
            {(['compliant', 'non_compliant', 'not_applicable'] as const).map((rv) => (
              <button
                key={rv}
                onClick={() => setResponse(rv)}
                disabled={state.is_locked}
                className={`btn ${state.response_value === rv ? 'btn-primary' : ''}`}
              >
                {rvLabel(rv)}
              </button>
            ))}
          </div>
          <div>
            <label className="text-xs font-medium text-slate-600 block mb-1">
              Justification {state.response_value === 'not_applicable' && <span className="text-red-600">*</span>}
            </label>
            <textarea
              className="field h-24"
              placeholder="Optional context — required for Not Applicable."
              value={state.justification ?? ''}
              onChange={(e) => setJustification(e.target.value)}
              disabled={state.is_locked}
            />
            {naNeedsJustification && (
              <p className="text-xs text-red-600 mt-1">
                Not Applicable responses require a justification.
              </p>
            )}
          </div>

          <EvidenceSection questionId={q.question_id} evidence={state.evidence} locked={state.is_locked}
            onChange={(next) => {
              setState((s) => ({ ...s, evidence: next }));
              qc.invalidateQueries({ queryKey: ['vendor-checklist'] });
            }}
          />

          <div className="flex items-center justify-between text-xs">
            <SaveIndicator state={saveState} />
            {err && <ErrorMessage error={err} />}
          </div>
        </div>
      )}
    </div>
  );
}

function ResponsePill({ value }: { value: ResponseState['response_value'] }) {
  const cls: Record<string, string> = {
    compliant: 'bg-green-100 text-green-800',
    non_compliant: 'bg-red-100 text-red-800',
    not_applicable: 'bg-slate-100 text-slate-700',
  };
  if (!value) return <span className="text-xs text-slate-400">Not answered</span>;
  return (
    <span className={`text-xs px-2 py-0.5 rounded ${cls[value]}`}>{rvLabel(value)}</span>
  );
}

function rvLabel(v: string): string {
  return v === 'compliant' ? 'Compliant' : v === 'non_compliant' ? 'Non-Compliant' : 'Not Applicable';
}

function SaveIndicator({ state }: { state: SaveState }) {
  if (state === 'idle') return <span className="text-slate-400">Autosaves as you type</span>;
  if (state === 'saving') return <span className="text-slate-600">Saving…</span>;
  if (state === 'saved') return <span className="text-green-700">✓ Saved</span>;
  return <span className="text-red-600">Save failed</span>;
}

// ------------------------------------------------------------
// Evidence attachment section
// ------------------------------------------------------------

function EvidenceSection({
  questionId,
  evidence,
  locked,
  onChange,
}: {
  questionId: string;
  evidence: EvidenceMeta[];
  locked: boolean;
  onChange: (next: EvidenceMeta[]) => void;
}) {
  const [uploading, setUploading] = useState(false);
  const [err, setErr] = useState<Error | null>(null);

  async function onPick(file: File): Promise<void> {
    setErr(null);
    if (!ALLOWED_MIME.includes(file.type)) {
      setErr(new Error(`Unsupported file type: ${file.type || 'unknown'}`));
      return;
    }
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const added = await api.upload<EvidenceMeta>(`/vendor/evidence/${questionId}`, fd);
      onChange([...evidence, added]);
    } catch (e) {
      setErr(e as Error);
    } finally {
      setUploading(false);
    }
  }

  async function onRemove(fileId: string): Promise<void> {
    setErr(null);
    try {
      await api.delete(`/vendor/evidence/${fileId}`);
      onChange(evidence.filter((e) => e.file_id !== fileId));
    } catch (e) {
      setErr(e as Error);
    }
  }

  return (
    <div>
      <label className="text-xs font-medium text-slate-600 block mb-1">Evidence</label>
      <div className="rounded-md border border-dashed border-slate-300 p-3 bg-slate-50">
        {evidence.length === 0 && <p className="text-xs text-slate-500">No files attached.</p>}
        <ul className="space-y-1">
          {evidence.map((f) => (
            <li key={f.file_id} className="flex items-center justify-between text-sm">
              <span className="truncate">
                📎 {f.file_name}{' '}
                <span className="text-slate-400 text-xs">({Math.round(f.file_size_bytes / 1024)} KB)</span>
              </span>
              {!locked && (
                <button className="btn text-xs" onClick={() => onRemove(f.file_id)}>
                  Remove
                </button>
              )}
            </li>
          ))}
        </ul>
        {!locked && (
          <label className="btn mt-2 cursor-pointer">
            <input
              type="file"
              className="hidden"
              accept={ALLOWED_MIME.join(',')}
              disabled={uploading}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void onPick(f);
                e.target.value = '';
              }}
            />
            {uploading ? 'Uploading…' : 'Attach file'}
          </label>
        )}
      </div>
      {err && <div className="mt-2"><ErrorMessage error={err} /></div>}
    </div>
  );
}

// ------------------------------------------------------------
// Submit footer
// ------------------------------------------------------------

interface ValidateResult {
  complete: boolean;
  incomplete_controls: string[];
}

function SubmitFooter({ session }: { session: VendorSession }) {
  const [validating, setValidating] = useState(false);
  const [validation, setValidation] = useState<ValidateResult | null>(null);
  const [err, setErr] = useState<Error | null>(null);
  const [confirmSubmit, setConfirmSubmit] = useState(false);
  const qc = useQueryClient();

  async function runValidate(): Promise<void> {
    setValidating(true);
    setErr(null);
    try {
      const v = await api.get<ValidateResult>('/vendor/submit/validate');
      setValidation(v);
    } catch (e) {
      setErr(e as Error);
    } finally {
      setValidating(false);
    }
  }

  const submit = useMutation({
    mutationFn: () => api.post<{ submission_hash: string; submitted_at: string }>('/vendor/submit'),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['vendor-session'] });
    },
    onError: (e) => setErr(e as Error),
  });

  const totalDone = session.domains.reduce((s, d) => s + d.answered_count, 0);
  const totalAll = session.domains.reduce((s, d) => s + d.total_count, 0);

  return (
    <div className="card p-4 mt-4 sticky bottom-4">
      <div className="flex items-center justify-between">
        <div className="text-sm">
          <div className="font-medium">Ready to submit?</div>
          <div className="text-slate-600 text-xs">
            {totalDone} of {totalAll} questions answered. Once submitted the assessment is locked.
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button className="btn" onClick={runValidate} disabled={validating}>
            {validating ? 'Checking…' : 'Check completeness'}
          </button>
          <button
            className="btn btn-primary"
            disabled={!validation?.complete || submit.isPending}
            onClick={() => setConfirmSubmit(true)}
          >
            Submit assessment
          </button>
        </div>
      </div>
      {validation && !validation.complete && (
        <p className="text-xs text-red-700 mt-2">
          Incomplete controls: {validation.incomplete_controls.join(', ')}
        </p>
      )}
      {validation?.complete && (
        <p className="text-xs text-green-700 mt-2">All required questions answered.</p>
      )}
      {err && <div className="mt-2"><ErrorMessage error={err} /></div>}
      {confirmSubmit && (
        <ConfirmModal
          onCancel={() => setConfirmSubmit(false)}
          onConfirm={() => {
            setConfirmSubmit(false);
            submit.mutate();
          }}
        />
      )}
    </div>
  );
}

function ConfirmModal({ onCancel, onConfirm }: { onCancel: () => void; onConfirm: () => void }) {
  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50" role="dialog" aria-modal="true">
      <div className="card p-6 max-w-md">
        <h2 className="text-lg font-semibold">Submit and lock this assessment?</h2>
        <p className="text-sm text-slate-600 mt-2">
          After submission the responses become read-only and are timestamped
          + hashed for audit integrity. This action cannot be undone from the
          vendor portal.
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <button className="btn" onClick={onCancel}>Cancel</button>
          <button className="btn btn-primary" onClick={onConfirm}>Submit</button>
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------
// Submitted view
// ------------------------------------------------------------

function SubmittedNotice({ session }: { session: VendorSession }) {
  return (
    <div className="max-w-2xl mx-auto px-4 py-12">
      <div className="card p-6">
        <h1 className="text-lg font-semibold">Assessment submitted</h1>
        <p className="text-sm text-slate-600 mt-2">
          {session.vendor_name}'s responses are now locked and under review.
        </p>
        <dl className="mt-4 text-sm grid grid-cols-[100px_1fr] gap-y-1">
          <dt className="text-slate-500">Status</dt>
          <dd className="font-medium">{session.status}</dd>
          <dt className="text-slate-500">Assessment</dt>
          <dd className="font-mono text-xs">{session.assessment_id}</dd>
        </dl>
      </div>
    </div>
  );
}
