import { describe, it, expect } from 'vitest';
import { buildScoreBreakdownCsv } from '../src/services/export.js';
import type { RiskScorePayload } from '../src/services/risk-report.js';
import type { ScoreBreakdownPayload } from '../src/services/risk-report.js';

const score: RiskScorePayload = {
  assessment_id: 'a-1',
  aggregate_score: 71.5,
  tier: 'high',
  is_final: true,
  computed_at: '2026-07-05T00:00:00.000Z',
  domain_scores: [],
};

const breakdown: ScoreBreakdownPayload = {
  aggregate_score: 71.5,
  tier: 'high',
  domains: [
    {
      control_domain_id: 'd1',
      name: 'Third-Party Management',
      contribution_pct: 60.0,
      sub_score: 82.0,
      driving_controls: ['TPM-05.1', 'TPM-06'],
    },
    {
      control_domain_id: 'd2',
      name: 'Incident Response, "escalated"',
      contribution_pct: 40.0,
      sub_score: 55.0,
      driving_controls: ['IR-01'],
    },
  ],
};

describe('buildScoreBreakdownCsv', () => {
  it('has a header row and one row per domain', () => {
    const csv = buildScoreBreakdownCsv('Acme Corp', score, breakdown);
    const lines = csv.trimEnd().split('\r\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('Vendor');
    expect(lines[0]).toContain('Domain');
    expect(lines[0]).toContain('Contribution %');
  });

  it('escapes fields with commas and quotes per RFC 4180', () => {
    const csv = buildScoreBreakdownCsv('Acme Corp', score, breakdown);
    // The domain name has both a comma and quotes → must be quoted with doubled inner quotes.
    expect(csv).toContain('"Incident Response, ""escalated"""');
  });

  it('joins driving controls with semicolons (safe inside a CSV cell)', () => {
    const csv = buildScoreBreakdownCsv('Acme Corp', score, breakdown);
    expect(csv).toContain('TPM-05.1; TPM-06');
  });

  it('emits a single row with empty domain fields when breakdown has no domains', () => {
    const csv = buildScoreBreakdownCsv('Acme Corp', score, {
      aggregate_score: 0,
      tier: 'low',
      domains: [],
    });
    const lines = csv.trimEnd().split('\r\n');
    expect(lines).toHaveLength(2); // header + 1 empty-domain row
  });

  it('ends with CRLF for tool compatibility', () => {
    const csv = buildScoreBreakdownCsv('Acme Corp', score, breakdown);
    expect(csv.endsWith('\r\n')).toBe(true);
  });
});
