/**
 * LLM provider interface + stub implementation.
 *
 * Sprint 3 ships only the stub — it produces plausible, deterministic output
 * from the prompt inputs so downstream UI (Sprint 5 reviewer surfaces) has
 * real-looking data to render. The stub NEVER treats vendor free-form text
 * as instructions — its templates are fixed string schedules that interpolate
 * inputs as escaped values (not as source code).
 *
 * Sprint 6 will add `AzureOpenAiProvider` that:
 *   - Formats `PersistedPrompt` into system + user messages (instructions in
 *     system, `inputs` array in a JSON user message).
 *   - Applies retries, timeouts, and safety filter handling.
 *   - Uses Managed Identity → Key Vault for the API key.
 *
 * The API/routes layer only ever sees `LlmProvider` — swapping providers is
 * a factory-level change, not a route-code change.
 */
import type { PersistedPrompt } from './prompt.js';

export interface LlmProviderResponse {
  text: string;
  modelName: string;
  /** Set only when the safety filter blocked the response (blueprint §6.7). */
  blocked?: boolean;
}

export interface LlmProvider {
  readonly name: string;
  generate(prompt: PersistedPrompt): Promise<LlmProviderResponse>;
}

// ------------------------------------------------------------
// Stub provider (deterministic dev output)
// ------------------------------------------------------------

const MODEL_NAME = 'stub-v1';

/** Escape a value for safe inclusion in the output text (mostly cosmetic). */
function esc(v: string | number): string {
  return String(v).replace(/\r?\n/g, ' ').trim();
}

export class StubLlmProvider implements LlmProvider {
  readonly name = MODEL_NAME;

  async generate(prompt: PersistedPrompt): Promise<LlmProviderResponse> {
    const inputs = prompt.inputs;
    const nonCompliant = inputs.filter((c) => c.response_value === 'non_compliant');

    switch (prompt.kind) {
      case 'summary':
        return { modelName: MODEL_NAME, text: renderSummary(prompt, nonCompliant) };
      case 'gap_analysis':
        return { modelName: MODEL_NAME, text: renderGapAnalysis(inputs[0]) };
      case 'remediation':
        return { modelName: MODEL_NAME, text: renderRemediation(inputs[0]) };
      case 'briefing':
        return { modelName: MODEL_NAME, text: renderSummary(prompt, nonCompliant) };
      case 'cross_domain_note':
        return { modelName: MODEL_NAME, text: renderCrossDomain(nonCompliant) };
      default:
        return { modelName: MODEL_NAME, text: '' };
    }
  }
}

function renderSummary(prompt: PersistedPrompt, nonCompliant: unknown[]): string {
  const role = prompt.scope.reviewer_role ?? 'reviewer';
  const domainCount = new Set(prompt.inputs.map((c) => c.domain_name)).size;
  const total = prompt.inputs.length;
  const gaps = nonCompliant.length;
  return [
    `Executive summary for ${esc(role)}:`,
    `- ${total} controls in scope across ${domainCount} domain(s).`,
    `- ${gaps} non-compliant finding(s) identified.`,
    gaps > 0
      ? `- Highest-weight gap: ${esc(
          [...(nonCompliant as { control_code: string; weight: number }[])].sort(
            (a, b) => b.weight - a.weight,
          )[0]?.control_code ?? '',
        )}.`
      : '- No non-compliant controls in this scope.',
  ].join('\n');
}

function renderGapAnalysis(control: unknown): string {
  if (!control) return '';
  const c = control as {
    control_code: string;
    control_title: string;
    weight: number;
    question_text: string;
    justification: string;
  };
  return [
    `Gap analysis for ${esc(c.control_code)} — ${esc(c.control_title)} (weight ${c.weight}):`,
    `Question: ${esc(c.question_text)}`,
    c.justification
      ? `Vendor justification (unverified): ${esc(c.justification)}`
      : 'Vendor provided no justification.',
    `Impact: non-compliance with this control at weight ${c.weight} contributes materially to overall risk.`,
  ].join('\n');
}

function renderRemediation(control: unknown): string {
  if (!control) return '';
  const c = control as { control_code: string; control_title: string };
  return [
    `Recommended remediation for ${esc(c.control_code)}:`,
    `1. Document the current control state and identify the gap owner.`,
    `2. Define a target implementation aligned with ${esc(c.control_title)}.`,
    `3. Set a remediation deadline proportional to the control's weight and criticality tier.`,
    `4. Track evidence of remediation in the next assessment cycle.`,
  ].join('\n');
}

function renderCrossDomain(nonCompliant: unknown[]): string {
  const list = nonCompliant as { control_code: string; domain_name: string }[];
  if (list.length === 0) return 'No non-compliant controls to correlate across domains.';
  const byDomain = new Map<string, string[]>();
  for (const c of list) {
    const arr = byDomain.get(c.domain_name) ?? [];
    arr.push(c.control_code);
    byDomain.set(c.domain_name, arr);
  }
  const top = [...byDomain.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 3);
  return top
    .map(([d, codes]) => `- ${esc(d)}: ${codes.length} gap(s) — ${codes.join(', ')}`)
    .join('\n');
}

// ------------------------------------------------------------
// Factory
// ------------------------------------------------------------

export function getLlmProvider(): LlmProvider {
  // Sprint 6 swaps this to Azure OpenAI based on env config.
  return new StubLlmProvider();
}
