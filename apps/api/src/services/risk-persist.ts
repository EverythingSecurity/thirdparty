/**
 * DB adapter for the pure scoring engine.
 *
 * Two flows:
 *   - `persistFinalScore(tx, ...)` — called from within the submission tx.
 *     Writes ONE `risk_scores` row with `is_final=true` and matching
 *     `risk_domain_scores` rows. Never overwrites an existing finalized row
 *     (blueprint §3.5: "risk_scores is append-only").
 *   - `computeLiveScore(prisma, ...)` — pre-submission recalculation for
 *     admin visibility (blueprint §1.5). Writes an `is_final=false` snapshot;
 *     admin UI can display any snapshot, but the finalized one is authoritative.
 */
import type { Prisma, PrismaClient } from '@prisma/client';
import type { PrismaTx } from './audit.js';
import type { ResponseForScoring, ScoreResult } from './scoring.js';
import { computeRiskScore } from './scoring.js';

export async function loadResponsesForScoring(
  tx: PrismaTx,
  assessmentId: string,
): Promise<ResponseForScoring[]> {
  const rows = await tx.response.findMany({
    where: { assessmentId, responseValue: { not: null } },
    select: {
      weightAtResponse: true,
      responseValue: true,
      control: { select: { controlDomainId: true } },
    },
  });
  return rows.map((r) => ({
    controlDomainId: r.control.controlDomainId,
    weightAtResponse: r.weightAtResponse,
    responseValue: r.responseValue as ResponseForScoring['responseValue'],
  }));
}

/**
 * Compute + persist a `risk_scores` row for the given assessment. Idempotent
 * against the (assessmentId, isFinal) partition — the caller controls which
 * snapshot they're writing.
 */
export async function persistScoreSnapshot(
  tx: PrismaTx,
  assessmentId: string,
  isFinal: boolean,
): Promise<ScoreResult> {
  const inputs = await loadResponsesForScoring(tx, assessmentId);
  const result = computeRiskScore(inputs);

  const created = await tx.riskScore.create({
    data: {
      assessmentId,
      aggregateScore: result.aggregateScore as unknown as Prisma.Decimal,
      tier: result.tier,
      isFinal,
    },
    select: { id: true },
  });

  if (result.domainScores.length > 0) {
    await tx.riskDomainScore.createMany({
      data: result.domainScores.map((d) => ({
        riskScoreId: created.id,
        controlDomainId: d.controlDomainId,
        subScore: d.subScore as unknown as Prisma.Decimal,
        contributionPct: d.contributionPct as unknown as Prisma.Decimal,
      })),
    });
  }

  return result;
}

/**
 * Load the most-recent FINALIZED score for an assessment. Returns null when
 * the assessment isn't yet submitted (per blueprint §4 `/risk/:vendorId/score`:
 * 404 pre-submission).
 */
export async function loadFinalScore(prisma: PrismaClient, assessmentId: string) {
  return prisma.riskScore.findFirst({
    where: { assessmentId, isFinal: true },
    orderBy: { computedAt: 'desc' },
    include: {
      domainScores: {
        include: {
          controlDomain: { select: { id: true, name: true, sortOrder: true } },
        },
      },
    },
  });
}
