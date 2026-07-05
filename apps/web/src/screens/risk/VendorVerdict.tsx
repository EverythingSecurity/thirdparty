/**
 * Risk Manager — Single-Vendor Verdict (Wireframe 1g).
 *
 * Score hero + worst-first domain bars + reviewer-status + disposition action bar.
 *
 * Disposition submission is stubbed until Sprint 5 wires POST /risk/:vendorId/disposition.
 * The bar renders and validates client-side so the flow is real; the actual
 * mutation is disabled with a clear tooltip.
 */
import { useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { TierBadge } from '../../components/ui/Badge';
import { ProgressBar } from '../../components/ui/Progress';
import { AiDisclosure } from '../../components/AiDisclosure';
import { ErrorMessage } from '../../components/ErrorMessage';

type Tier = 'low' | 'medium' | 'high' | 'critical';
interface Score {
  assessment_id: string;
  aggregate_score: number;
  tier: Tier;
  is_final: boolean;
  computed_at: string;
  domain_scores: Array<{ control_domain_id: string; name: string; sub_score: number; contribution_pct: number }>;
}
interface ReviewerStatus {
  cyber_reviewer: { decided: boolean; decision?: string };
  legal_reviewer: { decided: boolean; decision?: string };
}
interface CrossDomainNote {
  note: string;
  is_stale: boolean;
  generated_at: string;
  model: string;
}

const TIER_COLOR: Record<Tier, string> = {
  low: 'bg-tier-low',
  medium: 'bg-tier-medium',
  high: 'bg-tier-high',
  critical: 'bg-tier-critical',
};

export function VendorVerdict() {
  const { vendorId } = useParams<{ vendorId: string }>();
  const [decision, setDecision] = useState<'approve' | 'conditional' | 'reject' | null>(null);
  const [comment, setComment] = useState('');

  const score = useQuery<Score>({
    queryKey: ['score', vendorId],
    queryFn: () => api.get(`/risk/${vendorId}/score`),
    enabled: !!vendorId,
  });
  const reviewers = useQuery<ReviewerStatus>({
    queryKey: ['reviewer-status', vendorId],
    queryFn: () => api.get(`/risk/${vendorId}/reviewer-status`),
    enabled: !!vendorId,
  });
  const crossNote = useQuery<CrossDomainNote>({
    queryKey: ['cross-note', vendorId],
    queryFn: () => api.get(`/ai/cross-domain-note/${vendorId}`),
    enabled: !!vendorId,
  });

  const reviewersReady =
    !!reviewers.data?.cyber_reviewer.decided && !!reviewers.data?.legal_reviewer.decided;
  const commentValid = decision === 'approve' || comment.trim().length > 0;
  const canSubmit = decision && commentValid && reviewersReady;

  return (
    <div className="max-w-6xl mx-auto px-4 py-6">
      <Link to="/risk" className="text-sm text-slate-600 hover:text-slate-900">
        ← Back to portfolio
      </Link>

      {score.error && <div className="mt-4"><ErrorMessage error={score.error} /></div>}
      {score.isLoading && <p className="mt-6 text-slate-600">Loading score…</p>}

      {score.data && (
        <>
          <ScoreHero score={score.data} />
          <div className="mt-6 grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="md:col-span-2 card p-4">
              <h2 className="text-sm font-semibold mb-3">Domain sub-scores (worst first)</h2>
              <ul className="space-y-3">
                {score.data.domain_scores.map((d) => (
                  <li key={d.control_domain_id}>
                    <ProgressBar
                      value={d.sub_score}
                      label={`${d.name} — ${d.sub_score}`}
                      colorClass={colorForScore(d.sub_score)}
                    />
                  </li>
                ))}
              </ul>
            </div>
            <div className="space-y-4">
              <ReviewerStatusCard status={reviewers.data ?? null} />
              <CrossDomainNoteCard note={crossNote.data ?? null} />
            </div>
          </div>

          <DispositionBar
            decision={decision}
            setDecision={setDecision}
            comment={comment}
            setComment={setComment}
            reviewersReady={reviewersReady}
            canSubmit={canSubmit}
          />
        </>
      )}
    </div>
  );
}

function ScoreHero({ score }: { score: Score }) {
  return (
    <div className="mt-4 card p-6">
      <div className="flex items-baseline justify-between">
        <div>
          <div className="text-xs text-slate-500">Aggregate risk score</div>
          <div className="flex items-baseline gap-3 mt-1">
            <div className="text-4xl font-semibold tabular-nums">{score.aggregate_score}</div>
            <TierBadge tier={score.tier}>{score.tier.toUpperCase()}</TierBadge>
          </div>
        </div>
        <div className="text-right text-xs text-slate-500">
          Computed {new Date(score.computed_at).toLocaleString()}
          <br />
          Assessment <span className="font-mono">{score.assessment_id.slice(0, 8)}…</span>
        </div>
      </div>
      <div className="mt-4">
        <ProgressBar value={score.aggregate_score} colorClass={colorForScore(score.aggregate_score)} />
      </div>
    </div>
  );
}

function colorForScore(v: number): string {
  if (v >= 75) return 'bg-tier-critical';
  if (v >= 50) return 'bg-tier-high';
  if (v >= 25) return 'bg-tier-medium';
  return 'bg-tier-low';
}

function ReviewerStatusCard({ status }: { status: ReviewerStatus | null }) {
  return (
    <div className="card p-4">
      <h3 className="text-sm font-semibold mb-2">Reviewer decisions</h3>
      <ul className="text-sm space-y-1">
        {(['cyber_reviewer', 'legal_reviewer'] as const).map((k) => {
          const s = status?.[k];
          return (
            <li key={k} className="flex justify-between">
              <span className="text-slate-600">{k.replace('_', ' ')}</span>
              <span className={s?.decided ? 'text-green-700' : 'text-slate-400'}>
                {s?.decided ? s.decision ?? 'decided' : 'awaiting'}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function CrossDomainNoteCard({ note }: { note: CrossDomainNote | null }) {
  return (
    <div className="card overflow-hidden">
      <AiDisclosure variant="inline" />
      <div className="p-3">
        <h3 className="text-sm font-semibold mb-1">Cross-domain note</h3>
        {note ? (
          <pre className="text-xs whitespace-pre-wrap font-sans">{note.note}</pre>
        ) : (
          <p className="text-xs text-slate-600">No cross-domain note generated yet.</p>
        )}
      </div>
    </div>
  );
}

function DispositionBar({
  decision,
  setDecision,
  comment,
  setComment,
  reviewersReady,
  canSubmit,
}: {
  decision: 'approve' | 'conditional' | 'reject' | null;
  setDecision: (d: 'approve' | 'conditional' | 'reject') => void;
  comment: string;
  setComment: (v: string) => void;
  reviewersReady: boolean;
  canSubmit: boolean;
}) {
  return (
    <div className="mt-6 card p-4">
      <div className="flex flex-wrap items-center gap-3">
        {(['approve', 'conditional', 'reject'] as const).map((d) => (
          <button
            key={d}
            className={`btn ${decision === d ? 'btn-primary' : ''}`}
            onClick={() => setDecision(d)}
          >
            {d[0]!.toUpperCase() + d.slice(1)}
          </button>
        ))}
        <div className="ml-auto">
          <button
            className="btn btn-primary"
            disabled
            title="POST /risk/:vendorId/disposition lands in Sprint 5"
          >
            Record disposition (pending)
          </button>
        </div>
      </div>
      {!reviewersReady && (
        <p className="text-xs text-amber-700 mt-2">
          Both cyber and legal reviewer decisions must be recorded before final disposition.
        </p>
      )}
      {decision && decision !== 'approve' && (
        <textarea
          className="field h-20 mt-3 text-sm"
          placeholder="Comment (required for reject/conditional)…"
          value={comment}
          onChange={(e) => setComment(e.target.value)}
        />
      )}
      <p className="mt-2 text-xs text-slate-500">
        {canSubmit
          ? 'Ready to record — awaiting Sprint 5 backend endpoint.'
          : 'Fill in required fields to enable.'}
      </p>
    </div>
  );
}
