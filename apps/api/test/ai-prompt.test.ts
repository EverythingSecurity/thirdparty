import { describe, it, expect } from 'vitest';
import {
  assertPromptInputSafe,
  buildPrompt,
  promptInputHash,
} from '../src/services/ai/prompt.js';
import type { PromptControl } from '../src/services/ai/prompt.js';

const goodInput = (over: Partial<PromptControl> = {}): PromptControl => ({
  control_id: over.control_id ?? 'c-1',
  control_code: over.control_code ?? 'TPM-01',
  control_title: over.control_title ?? 'Third-Party Management',
  domain_name: over.domain_name ?? 'Third-Party',
  weight: over.weight ?? 10,
  question_text: over.question_text ?? 'Do you have a program?',
  response_value: over.response_value ?? 'non_compliant',
  justification: over.justification ?? 'no formal doc',
  evidence_metadata: over.evidence_metadata ?? [],
});

describe('assertPromptInputSafe', () => {
  it('accepts a well-formed input', () => {
    expect(() => assertPromptInputSafe(goodInput())).not.toThrow();
  });

  it('rejects any field outside the allow-list', () => {
    const bad = { ...goodInput(), file_contents: 'raw bytes here' };
    expect(() => assertPromptInputSafe(bad)).toThrow(/allow-list/);
  });

  it('rejects raw file bytes attempting to sneak via evidence_metadata', () => {
    const bad: PromptControl = {
      ...goodInput(),
      evidence_metadata: [
        // @ts-expect-error — intentionally malformed to test runtime guard
        { file_name: 'x.pdf', file_size_bytes: 100, mime_type: 'application/pdf', file_bytes: 'AAA' },
      ],
    };
    expect(() => assertPromptInputSafe(bad)).toThrow(/allow-list/);
  });

  it('rejects non-object inputs', () => {
    expect(() => assertPromptInputSafe(null)).toThrow();
    expect(() => assertPromptInputSafe('string')).toThrow();
    expect(() => assertPromptInputSafe(42)).toThrow();
  });

  it('rejects non-array evidence_metadata', () => {
    const bad = { ...goodInput(), evidence_metadata: 'nope' } as unknown;
    expect(() => assertPromptInputSafe(bad)).toThrow();
  });
});

describe('buildPrompt', () => {
  it('constructs a persisted prompt with all supplied fields', () => {
    const p = buildPrompt(
      'summary',
      'summary_v1',
      { reviewer_role: 'cyber_reviewer' },
      [goodInput()],
    );
    expect(p.kind).toBe('summary');
    expect(p.instructions_key).toBe('summary_v1');
    expect(p.scope.reviewer_role).toBe('cyber_reviewer');
    expect(p.inputs).toHaveLength(1);
  });

  it('throws if any input has a disallowed field', () => {
    expect(() =>
      buildPrompt('summary', 'summary_v1', {}, [
        { ...goodInput(), extra: 'field' } as unknown as PromptControl,
      ]),
    ).toThrow();
  });
});

describe('promptInputHash', () => {
  it('is deterministic for the same input set', async () => {
    const inputs = [goodInput({ control_id: 'a' }), goodInput({ control_id: 'b' })];
    expect(await promptInputHash(inputs)).toBe(await promptInputHash(inputs));
  });

  it('is stable across insertion order', async () => {
    const a = goodInput({ control_id: 'aaa' });
    const b = goodInput({ control_id: 'bbb' });
    expect(await promptInputHash([a, b])).toBe(await promptInputHash([b, a]));
  });

  it('changes when a justification changes', async () => {
    const original = [goodInput({ justification: 'original' })];
    const tampered = [goodInput({ justification: 'tampered' })];
    expect(await promptInputHash(original)).not.toBe(await promptInputHash(tampered));
  });

  it('changes when evidence metadata changes', async () => {
    const original = [
      goodInput({
        evidence_metadata: [{ file_name: 'a.pdf', file_size_bytes: 1, mime_type: 'application/pdf' }],
      }),
    ];
    const withMore = [
      goodInput({
        evidence_metadata: [
          { file_name: 'a.pdf', file_size_bytes: 1, mime_type: 'application/pdf' },
          { file_name: 'b.pdf', file_size_bytes: 2, mime_type: 'application/pdf' },
        ],
      }),
    ];
    expect(await promptInputHash(original)).not.toBe(await promptInputHash(withMore));
  });
});
