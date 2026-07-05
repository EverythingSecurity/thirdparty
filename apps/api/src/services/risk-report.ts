/**
 * Risk reporting queries (blueprint §4 risk endpoints, screens 1g / 1h / 1i).
 *
 * All queries scope to the caller's org and read the FINALIZED risk snapshot
 * (`is_final=true`). Pre-submission live snapshots are NOT surfaced to Risk
 * Manager / Reviewer views — they're admin-only.
 */
import type { PrismaClient } from '@prisma/client';
import { NotFoundError } from '@vsa/shared';
import { loadFinalScore } from './risk-persist.js';

// ------------------------------------------------------------
// GET /risk/:vendorId/score
// ------------------------------------------------------------

export interface RiskScorePayload {
  assessment_id: string;
  aggregate_score: number;
  tier: string;
  is_final: boolean;
  computed_at: string;
  domain_scores: Array<{
    control_domain_id: string;
    name: string;
    sub_score: number;
    contribution_pct: number;
  }>;
}

export async function fetchRiskScore(
  prisma: PrismaClient,
  vendorId: string,
  orgId: string,
): Promise<RiskScorePayload> {
  const assessment = await prisma.assessment.findFirst({
    where: { vendorId, organizationId: orgId, submittedAt: { not: null } },
    orderBy: { submittedAt: 'desc' },
    select: { id: true },
  });
  if (!assessment) throw new NotFoundError('No submitted assessment for this vendor');

  const score = await loadFinalScore(prisma, assessment.id);
  if (!score) throw new NotFoundError('Score not yet finalized');

  // Domain scores sorted DESCENDING by sub_score — matches wireframe 1g
  // ("worst-first") and blueprint contract (server-sorted, don't re-sort
  // client-side).
  const domain_scores = score.domainScores
    .map((d) => ({
      control_domain_id: d.controlDomainId,
      name: d.controlDomain.name,
      sub_score: Number(d.subScore),
      contribution_pct: d.contributionPct === null ? 0 : Number(d.contributionPct),
      _sort: d.controlDomain.sortOrder,
    }))
    .sort((a, b) => b.sub_score - a.sub_score)
    .map(({ _sort: _, ...rest }) => rest);

  return {
    assessment_id: assessment.id,
    aggregate_score: Number(score.aggregateScore),
    tier: score.tier,
    is_final: score.isFinal,
    computed_at: score.computedAt.toISOString(),
    domain_scores,
  };
}

// ------------------------------------------------------------
// GET /risk/:vendorId/score-breakdown
// ------------------------------------------------------------

export interface ScoreBreakdownPayload {
  aggregate_score: number;
  tier: string;
  domains: Array<{
    control_domain_id: string;
    name: string;
    contribution_pct: number;
    sub_score: number;
    driving_controls: string[]; // control_code list, non-compliant, worst-first
  }>;
}

export async function fetchScoreBreakdown(
  prisma: PrismaClient,
  vendorId: string,
  orgId: string,
): Promise<ScoreBreakdownPayload> {
  const assessment = await prisma.assessment.findFirst({
    where: { vendorId, organizationId: orgId, submittedAt: { not: null } },
    orderBy: { submittedAt: 'desc' },
    select: { id: true },
  });
  if (!assessment) throw new NotFoundError('No submitted assessment for this vendor');

  const score = await loadFinalScore(prisma, assessment.id);
  if (!score) throw new NotFoundError('Score not yet finalized');

  // For each domain, list the non-compliant control codes ordered by weight desc.
  const drivers = await prisma.response.findMany({
    where: {
      assessmentId: assessment.id,
      responseValue: 'non_compliant',
    },
    select: {
      weightAtResponse: true,
      control: { select: { controlCode: true, controlDomainId: true } },
    },
    orderBy: { weightAtResponse: 'desc' },
  });

  const byDomain = new Map<string, string[]>();
  for (const d of drivers) {
    const arr = byDomain.get(d.control.controlDomainId) ?? [];
    arr.push(d.control.controlCode);
    byDomain.set(d.control.controlDomainId, arr);
  }

  const domains = score.domainScores
    .map((d) => ({
      control_domain_id: d.controlDomainId,
      name: d.controlDomain.name,
      contribution_pct: d.contributionPct === null ? 0 : Number(d.contributionPct),
      sub_score: Number(d.subScore),
      driving_controls: byDomain.get(d.controlDomainId) ?? [],
    }))
    .sort((a, b) => b.contribution_pct - a.contribution_pct);

  return {
    aggregate_score: Number(score.aggregateScore),
    tier: score.tier,
    domains,
  };
}

// ------------------------------------------------------------
// GET /risk/:vendorId/reviewer-status
// ------------------------------------------------------------

export interface ReviewerStatusPayload {
  cyber_reviewer: { decided: boolean; decision?: string; decided_at?: string };
  legal_reviewer: { decided: boolean; decision?: string; decided_at?: string };
}

export async function fetchReviewerStatus(
  prisma: PrismaClient,
  vendorId: string,
  orgId: string,
): Promise<ReviewerStatusPayload> {
  const assessment = await prisma.assessment.findFirst({
    where: { vendorId, organizationId: orgId, submittedAt: { not: null } },
    orderBy: { submittedAt: 'desc' },
    select: { id: true },
  });
  if (!assessment) throw new NotFoundError('No submitted assessment for this vendor');

  const decisions = await prisma.reviewDecision.findMany({
    where: { assessmentId: assessment.id },
    select: { reviewerRole: true, decision: true, decidedAt: true },
  });

  const build = (role: 'cyber_reviewer' | 'legal_reviewer') => {
    const d = decisions.find((x) => x.reviewerRole === role);
    if (!d) return { decided: false };
    return {
      decided: true,
      decision: d.decision,
      decided_at: d.decidedAt.toISOString(),
    };
  };
  return {
    cyber_reviewer: build('cyber_reviewer'),
    legal_reviewer: build('legal_reviewer'),
  };
}

// ------------------------------------------------------------
// GET /risk/portfolio
// ------------------------------------------------------------

export interface PortfolioRow {
  vendor_id: string;
  name: string;
  score: number | null;
  tier: string | null;
  worst_domain: { name: string; sub_score: number } | null;
  status: string;
}

export interface PortfolioQuery {
  sort?: 'score' | 'tier' | 'status' | 'name';
  filterTier?: 'low' | 'medium' | 'high' | 'critical';
  q?: string;
  page?: number;
  pageSize?: number;
}

export async function fetchPortfolio(
  prisma: PrismaClient,
  orgId: string,
  q: PortfolioQuery,
): Promise<{ page: number; page_size: number; total: number; vendors: PortfolioRow[] }> {
  const pageSize = Math.min(q.pageSize ?? 25, 100);
  const page = Math.max(q.page ?? 1, 1);

  // Base filter: caller's org + optional name search.
  const where = {
    organizationId: orgId,
    ...(q.q ? { name: { contains: q.q, mode: 'insensitive' as const } } : {}),
  };

  const [total, vendors] = await Promise.all([
    prisma.vendor.count({ where }),
    prisma.vendor.findMany({
      where,
      orderBy: q.sort === 'name' ? { name: 'asc' } : { name: 'asc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true,
        name: true,
        assessments: {
          orderBy: { submittedAt: 'desc' },
          take: 1,
          select: {
            status: true,
            submittedAt: true,
            riskScores: {
              where: { isFinal: true },
              orderBy: { computedAt: 'desc' },
              take: 1,
              select: {
                aggregateScore: true,
                tier: true,
                domainScores: {
                  select: {
                    subScore: true,
                    controlDomain: { select: { name: true } },
                  },
                },
              },
            },
          },
        },
      },
    }),
  ]);

  const rows: PortfolioRow[] = vendors.map((v) => {
    const a = v.assessments[0];
    if (!a) {
      return { vendor_id: v.id, name: v.name, score: null, tier: null, worst_domain: null, status: 'unassigned' };
    }
    const rs = a.riskScores[0];
    if (!rs) {
      return {
        vendor_id: v.id,
        name: v.name,
        score: null,
        tier: null,
        worst_domain: null,
        status: a.status,
      };
    }
    const worst = [...rs.domainScores]
      .map((d) => ({ name: d.controlDomain.name, sub_score: Number(d.subScore) }))
      .sort((x, y) => y.sub_score - x.sub_score)[0] ?? null;
    return {
      vendor_id: v.id,
      name: v.name,
      score: Number(rs.aggregateScore),
      tier: rs.tier,
      worst_domain: worst,
      status: a.status,
    };
  });

  // Post-filter by tier (couldn't push into the vendor query cheaply).
  const filtered = q.filterTier ? rows.filter((r) => r.tier === q.filterTier) : rows;

  // Application-level sort — small page size, so cheap.
  const sorted = [...filtered].sort((a, b) => {
    if (q.sort === 'score') return (b.score ?? -1) - (a.score ?? -1);
    if (q.sort === 'tier') return String(a.tier ?? '').localeCompare(String(b.tier ?? ''));
    if (q.sort === 'status') return a.status.localeCompare(b.status);
    return a.name.localeCompare(b.name);
  });

  return {
    page,
    page_size: pageSize,
    total,
    vendors: sorted,
  };
}
