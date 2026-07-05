/**
 * Export builders (blueprint §4 `/risk/:vendorId/export?format=pdf|csv`).
 *
 * Sprint 3 delivers CSV (audit-ready flat file). PDF is deferred to a later
 * sprint — it typically needs a templated renderer (react-pdf / Puppeteer)
 * and isn't on the reviewer critical path.
 *
 * CSV shape is deliberately verbose — auditors want ONE row per driving
 * control with the full context inline, not a joined star schema.
 */
import type { ScoreBreakdownPayload, RiskScorePayload } from './risk-report.js';

/** Escape a CSV field per RFC 4180. */
function csvField(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export function buildScoreBreakdownCsv(
  vendorName: string,
  score: RiskScorePayload,
  breakdown: ScoreBreakdownPayload,
): string {
  const headers = [
    'Vendor',
    'Assessment ID',
    'Computed At',
    'Aggregate Score',
    'Tier',
    'Domain',
    'Sub Score',
    'Contribution %',
    'Driving Controls',
  ];
  const rows: string[][] = [];
  if (breakdown.domains.length === 0) {
    rows.push([
      vendorName,
      score.assessment_id,
      score.computed_at,
      String(score.aggregate_score),
      score.tier,
      '',
      '',
      '',
      '',
    ]);
  } else {
    for (const d of breakdown.domains) {
      rows.push([
        vendorName,
        score.assessment_id,
        score.computed_at,
        String(score.aggregate_score),
        score.tier,
        d.name,
        String(d.sub_score),
        String(d.contribution_pct),
        d.driving_controls.join('; '),
      ]);
    }
  }
  const all = [headers, ...rows].map((row) => row.map(csvField).join(',')).join('\r\n');
  // RFC 4180 says CRLF at EOL; add a trailing CRLF for tool compatibility.
  return all + '\r\n';
}
