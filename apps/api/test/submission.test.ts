import { describe, it, expect } from 'vitest';
import {
  canonicalizeResponses,
  sha256Hex,
  submissionHash,
} from '../src/services/submission.js';

const R = (over: Partial<Parameters<typeof canonicalizeResponses>[0][number]> = {}) => ({
  question_id: over.question_id ?? '11111111-1111-1111-1111-111111111111',
  control_id: over.control_id ?? '22222222-2222-2222-2222-222222222222',
  weight_at_response: over.weight_at_response ?? 9,
  response_value: over.response_value ?? 'compliant',
  justification: over.justification ?? '',
  evidence_file_ids: over.evidence_file_ids ?? [],
});

describe('canonicalizeResponses', () => {
  it('is deterministic for the same input', () => {
    const set = [R({ question_id: 'a' }), R({ question_id: 'b' })];
    expect(canonicalizeResponses(set)).toBe(canonicalizeResponses(set));
  });

  it('is stable across insertion order (sorted by question_id)', () => {
    const a = R({ question_id: 'aaaaaaaa-0000-0000-0000-000000000001' });
    const b = R({ question_id: 'bbbbbbbb-0000-0000-0000-000000000001' });
    expect(canonicalizeResponses([a, b])).toBe(canonicalizeResponses([b, a]));
  });

  it('is stable across evidence file id order', () => {
    const with1 = R({ evidence_file_ids: ['x', 'y', 'z'] });
    const with2 = R({ evidence_file_ids: ['z', 'x', 'y'] });
    expect(canonicalizeResponses([with1])).toBe(canonicalizeResponses([with2]));
  });

  it('changes when a response_value changes', () => {
    const a = R({ response_value: 'compliant' });
    const b = R({ response_value: 'non_compliant' });
    expect(canonicalizeResponses([a])).not.toBe(canonicalizeResponses([b]));
  });

  it('changes when the weight snapshot differs', () => {
    const a = R({ weight_at_response: 9 });
    const b = R({ weight_at_response: 10 });
    expect(canonicalizeResponses([a])).not.toBe(canonicalizeResponses([b]));
  });

  it('treats null-ish justification as empty string', () => {
    const withEmpty = R({ justification: '' });
    expect(canonicalizeResponses([withEmpty])).toContain('""');
  });
});

describe('submissionHash', () => {
  it('produces the SHA-256 of the canonical form with sha256: prefix', () => {
    const set = [R({ question_id: 'a', response_value: 'compliant' })];
    const expected = `sha256:${sha256Hex(canonicalizeResponses(set))}`;
    expect(submissionHash(set)).toBe(expected);
  });

  it('hash differs when a single field changes (tamper-evidence)', () => {
    const original = [R({ justification: 'original text' })];
    const tampered = [R({ justification: 'tampered text' })];
    expect(submissionHash(original)).not.toBe(submissionHash(tampered));
  });

  it('empty response set hashes to a fixed value', () => {
    expect(submissionHash([])).toBe(`sha256:${sha256Hex('[]')}`);
  });
});
