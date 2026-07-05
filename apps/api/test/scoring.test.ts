import { describe, it, expect } from 'vitest';
import { computeRiskScore, tierForScore } from '../src/services/scoring.js';
import type { ResponseForScoring } from '../src/services/scoring.js';

const D1 = 'd1';
const D2 = 'd2';

const mk = (r: Partial<ResponseForScoring> = {}): ResponseForScoring => ({
  controlDomainId: r.controlDomainId ?? D1,
  weightAtResponse: r.weightAtResponse ?? 5,
  responseValue: r.responseValue ?? 'compliant',
});

describe('tierForScore', () => {
  it('maps to standard quartile bands', () => {
    expect(tierForScore(0)).toBe('low');
    expect(tierForScore(24.99)).toBe('low');
    expect(tierForScore(25)).toBe('medium');
    expect(tierForScore(49.99)).toBe('medium');
    expect(tierForScore(50)).toBe('high');
    expect(tierForScore(74.99)).toBe('high');
    expect(tierForScore(75)).toBe('critical');
    expect(tierForScore(100)).toBe('critical');
  });
});

describe('computeRiskScore', () => {
  it('empty input → 0 aggregate, low tier, no domain scores', () => {
    const r = computeRiskScore([]);
    expect(r.aggregateScore).toBe(0);
    expect(r.tier).toBe('low');
    expect(r.domainScores).toEqual([]);
  });

  it('all compliant → 0 aggregate, low tier', () => {
    const r = computeRiskScore([
      mk({ responseValue: 'compliant', weightAtResponse: 10 }),
      mk({ responseValue: 'compliant', weightAtResponse: 8 }),
    ]);
    expect(r.aggregateScore).toBe(0);
    expect(r.tier).toBe('low');
    expect(r.totalRiskWeight).toBe(0);
    expect(r.totalApplicableWeight).toBe(18);
  });

  it('all non-compliant → 100 aggregate, critical tier', () => {
    const r = computeRiskScore([
      mk({ responseValue: 'non_compliant', weightAtResponse: 10 }),
      mk({ responseValue: 'non_compliant', weightAtResponse: 8 }),
    ]);
    expect(r.aggregateScore).toBe(100);
    expect(r.tier).toBe('critical');
  });

  it('N/A rows are excluded from denominator', () => {
    // 1 non-compliant (weight 10) + 1 N/A (weight 10) → 10/10*100 = 100
    const r = computeRiskScore([
      mk({ responseValue: 'non_compliant', weightAtResponse: 10 }),
      mk({ responseValue: 'not_applicable', weightAtResponse: 10 }),
    ]);
    expect(r.aggregateScore).toBe(100);
  });

  it('N/A alone (no compliant, no non-compliant) → 0 aggregate', () => {
    const r = computeRiskScore([
      mk({ responseValue: 'not_applicable', weightAtResponse: 10 }),
      mk({ responseValue: 'not_applicable', weightAtResponse: 5 }),
    ]);
    expect(r.aggregateScore).toBe(0);
    expect(r.totalApplicableWeight).toBe(0);
  });

  it('mixed: 1 non-compliant weight 9 + 1 compliant weight 1 → 90', () => {
    const r = computeRiskScore([
      mk({ responseValue: 'non_compliant', weightAtResponse: 9 }),
      mk({ responseValue: 'compliant', weightAtResponse: 1 }),
    ]);
    expect(r.aggregateScore).toBe(90);
    expect(r.tier).toBe('critical');
  });

  it('per-domain sub-scores computed independently', () => {
    // D1: 1 non-compliant weight 8 out of 8 → 100
    // D2: 1 non-compliant weight 2 out of 10 → 20
    const r = computeRiskScore([
      mk({ controlDomainId: D1, responseValue: 'non_compliant', weightAtResponse: 8 }),
      mk({ controlDomainId: D2, responseValue: 'non_compliant', weightAtResponse: 2 }),
      mk({ controlDomainId: D2, responseValue: 'compliant', weightAtResponse: 8 }),
    ]);
    const d1 = r.domainScores.find((d) => d.controlDomainId === D1)!;
    const d2 = r.domainScores.find((d) => d.controlDomainId === D2)!;
    expect(d1.subScore).toBe(100);
    expect(d2.subScore).toBe(20);
    // Aggregate: (8+2)/(8+10) = 10/18 = 55.56 → high
    expect(r.aggregateScore).toBe(55.56);
    expect(r.tier).toBe('high');
  });

  it('contribution_pct sums to 100 when any risk exists', () => {
    const r = computeRiskScore([
      mk({ controlDomainId: D1, responseValue: 'non_compliant', weightAtResponse: 3 }),
      mk({ controlDomainId: D2, responseValue: 'non_compliant', weightAtResponse: 7 }),
    ]);
    const total = r.domainScores.reduce((s, d) => s + d.contributionPct, 0);
    expect(Math.abs(total - 100)).toBeLessThan(0.01);
  });

  it('contribution_pct is 0 across the board when no risk exists', () => {
    const r = computeRiskScore([
      mk({ responseValue: 'compliant', weightAtResponse: 10 }),
    ]);
    for (const d of r.domainScores) expect(d.contributionPct).toBe(0);
  });

  it('clamps aggregate to 100 when severity multiplier would exceed it', () => {
    // Non-compliant weight 5 with severity 2 → raw = 200, clamped to 100.
    const r = computeRiskScore([
      { controlDomainId: D1, weightAtResponse: 5, responseValue: 'non_compliant', severityMultiplier: 2 },
    ]);
    expect(r.aggregateScore).toBe(100);
    expect(r.tier).toBe('critical');
  });
});
