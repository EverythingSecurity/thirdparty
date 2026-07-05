/**
 * Risk scoring engine (blueprint §1.5, §4.6).
 *
 * Model:
 *   - Each response has a snapshot weight (1–10) from `responses.weight_at_response`.
 *   - Compliant       → contributes weight to the denominator, 0 to the numerator.
 *   - Non-Compliant   → contributes weight to BOTH numerator and denominator.
 *                       (severity_multiplier is 1 in Sprint 3; a per-response
 *                       severity field can extend this without changing the
 *                       shape of `computeRiskScore`.)
 *   - Not Applicable  → excluded from both (blueprint: "neither inflates nor
 *                       deflates the score").
 *
 * Outputs are normalized to 0..100 where 0 = "no risk detected" and 100 =
 * "all applicable answers non-compliant". Tier bands are the standard
 * quartile mapping.
 *
 * This module is INTENTIONALLY dependency-free — no Prisma, no async — so
 * it's trivially unit-testable and pure-function-composable. The DB-backed
 * "load responses + persist scores" adapter lives in `risk-persist.ts`.
 */

export type ResponseValueLite = 'compliant' | 'non_compliant' | 'not_applicable';
export type Tier = 'low' | 'medium' | 'high' | 'critical';

export interface ResponseForScoring {
  controlDomainId: string;
  weightAtResponse: number; // 1..10
  responseValue: ResponseValueLite;
  /** Optional per-response severity multiplier (defaults to 1). */
  severityMultiplier?: number;
}

export interface DomainScoreBreakdown {
  controlDomainId: string;
  subScore: number; // 0..100, 2-decimal precision
  applicableWeight: number;
  riskWeight: number;
  /** % of the total risk numerator contributed by this domain (0..100). */
  contributionPct: number;
}

export interface ScoreResult {
  aggregateScore: number; // 0..100, 2-decimal precision
  tier: Tier;
  totalApplicableWeight: number;
  totalRiskWeight: number;
  domainScores: DomainScoreBreakdown[];
}

/** Standard quartile tier bands. Config-hookable in a later sprint. */
export function tierForScore(score: number): Tier {
  if (score >= 75) return 'critical';
  if (score >= 50) return 'high';
  if (score >= 25) return 'medium';
  return 'low';
}

/**
 * Round to 2 decimal places for stable serialization. We avoid Number.toFixed
 * (returns string) — this keeps numeric type but caps precision.
 */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Compute aggregate + per-domain sub-scores from a response set.
 *
 * Edge behavior:
 *   - Empty input → aggregate 0, tier 'low', empty domainScores.
 *   - All N/A     → aggregate 0, tier 'low' (no applicable denominator).
 *   - Single domain single non-compliant → aggregate 100, tier 'critical'.
 */
export function computeRiskScore(responses: ResponseForScoring[]): ScoreResult {
  interface Bucket {
    applicable: number;
    risk: number;
  }
  const domain = new Map<string, Bucket>();

  let totalApplicable = 0;
  let totalRisk = 0;

  for (const r of responses) {
    if (r.responseValue === 'not_applicable') continue;
    const sev = r.severityMultiplier ?? 1;
    const w = r.weightAtResponse;
    const riskContribution = r.responseValue === 'non_compliant' ? w * sev : 0;
    const b = domain.get(r.controlDomainId) ?? { applicable: 0, risk: 0 };
    b.applicable += w;
    b.risk += riskContribution;
    domain.set(r.controlDomainId, b);
    totalApplicable += w;
    totalRisk += riskContribution;
  }

  // Clamp to [0, 100] — the DB CHECK on risk_scores.aggregate_score enforces
  // the same range. This matters only when a per-response severity multiplier
  // pushes a normalized ratio above 1; without severity, ratios are naturally
  // bounded by weight/weight = 1.
  const rawAggregate =
    totalApplicable === 0 ? 0 : round2((totalRisk / totalApplicable) * 100);
  const aggregate = Math.min(100, Math.max(0, rawAggregate));

  const domainScores: DomainScoreBreakdown[] = [...domain.entries()].map(
    ([controlDomainId, b]) => {
      const raw = b.applicable === 0 ? 0 : round2((b.risk / b.applicable) * 100);
      const subScore = Math.min(100, Math.max(0, raw));
      const contributionPct = totalRisk === 0 ? 0 : round2((b.risk / totalRisk) * 100);
      return {
        controlDomainId,
        subScore,
        applicableWeight: b.applicable,
        riskWeight: b.risk,
        contributionPct,
      };
    },
  );

  return {
    aggregateScore: aggregate,
    tier: tierForScore(aggregate),
    totalApplicableWeight: totalApplicable,
    totalRiskWeight: totalRisk,
    domainScores,
  };
}
