import { describe, it, expect } from 'vitest';
import { StubLlmProvider } from '../src/services/ai/provider.js';
import { buildPrompt } from '../src/services/ai/prompt.js';
import type { PromptControl } from '../src/services/ai/prompt.js';

const input = (over: Partial<PromptControl> = {}): PromptControl => ({
  control_id: over.control_id ?? 'c1',
  control_code: over.control_code ?? 'TPM-01',
  control_title: over.control_title ?? 'Third-Party Management',
  domain_name: over.domain_name ?? 'Third-Party Management',
  weight: over.weight ?? 10,
  question_text: over.question_text ?? 'Have a program?',
  response_value: over.response_value ?? 'non_compliant',
  justification: over.justification ?? 'no',
  evidence_metadata: over.evidence_metadata ?? [],
});

describe('StubLlmProvider', () => {
  it('produces non-empty summary text', async () => {
    const p = new StubLlmProvider();
    const prompt = buildPrompt('summary', 'summary_v1', { reviewer_role: 'cyber_reviewer' }, [
      input(),
    ]);
    const r = await p.generate(prompt);
    expect(r.text.length).toBeGreaterThan(0);
    expect(r.modelName).toBe('stub-v1');
  });

  it('summary output mentions the reviewer role', async () => {
    const p = new StubLlmProvider();
    const prompt = buildPrompt('summary', 'summary_v1', { reviewer_role: 'legal_reviewer' }, [
      input({ response_value: 'compliant' }),
    ]);
    const r = await p.generate(prompt);
    expect(r.text).toContain('legal_reviewer');
  });

  it('gap_analysis references the control code and weight', async () => {
    const p = new StubLlmProvider();
    const prompt = buildPrompt('gap_analysis', 'gap_v1', { control_id: 'c1' }, [
      input({ control_code: 'TPM-05.1', weight: 9 }),
    ]);
    const r = await p.generate(prompt);
    expect(r.text).toContain('TPM-05.1');
    expect(r.text).toContain('9');
  });

  it('cross_domain_note gracefully handles empty non-compliant set', async () => {
    const p = new StubLlmProvider();
    const prompt = buildPrompt(
      'cross_domain_note',
      'cross_v1',
      {},
      [input({ response_value: 'compliant' })],
    );
    const r = await p.generate(prompt);
    expect(r.text.length).toBeGreaterThan(0);
  });

  it('remediation output is deterministic for the same input', async () => {
    const p = new StubLlmProvider();
    const prompt = buildPrompt('remediation', 'rem_v1', { control_id: 'c1' }, [input()]);
    const a = await p.generate(prompt);
    const b = await p.generate(prompt);
    expect(a.text).toBe(b.text);
  });
});
