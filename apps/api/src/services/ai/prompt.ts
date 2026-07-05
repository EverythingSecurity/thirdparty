/**
 * AI prompt construction (blueprint §5.5 — AI Safeguards).
 *
 * Contract:
 *   - The set of fields serialized into a prompt is ALLOW-LISTED at runtime,
 *     not just at compile time. `assertPromptInputSafe` throws if an input
 *     object contains any key outside the allow-list — so a future refactor
 *     that accidentally spreads response bytes / raw file contents / user
 *     PII into a prompt input fails loudly instead of silently leaking.
 *   - Vendor free-form text (justification, evidence file names) is stored
 *     in a dedicated field, NEVER concatenated into an instructions/prompt
 *     template string. Providers that build a final wire prompt string are
 *     responsible for the instructions↔input separation (Azure adapter will
 *     use system + user messages; the stub provider avoids the risk by not
 *     interpolating vendor text into instruction bodies).
 *   - `evidence_metadata` is metadata only — file bytes never leave storage.
 */
import type { AiGenerationKind } from '@prisma/client';

export type ReviewerScopeRole = 'cyber_reviewer' | 'legal_reviewer';

export interface PromptEvidenceMetadata {
  file_name: string;
  file_size_bytes: number;
  mime_type: string;
}

export interface PromptControl {
  control_id: string;
  control_code: string;
  control_title: string;
  domain_name: string;
  weight: number; // weight_at_response snapshot
  question_text: string;
  response_value: 'compliant' | 'non_compliant' | 'not_applicable';
  justification: string; // vendor free-form text — isolated field
  evidence_metadata: PromptEvidenceMetadata[];
}

export interface PromptScope {
  control_id?: string;
  control_domain_id?: string;
  reviewer_role?: ReviewerScopeRole;
}

export interface PersistedPrompt {
  kind: AiGenerationKind;
  instructions_key: string; // versioned prompt-template id
  scope: PromptScope;
  inputs: PromptControl[];
}

// ------------------------------------------------------------
// Allow-list enforcement
// ------------------------------------------------------------

const ALLOWED_INPUT_FIELDS = new Set<keyof PromptControl>([
  'control_id',
  'control_code',
  'control_title',
  'domain_name',
  'weight',
  'question_text',
  'response_value',
  'justification',
  'evidence_metadata',
]);

const ALLOWED_EVIDENCE_FIELDS = new Set<keyof PromptEvidenceMetadata>([
  'file_name',
  'file_size_bytes',
  'mime_type',
]);

/**
 * Runtime validator — throws if any field outside the allow-list is present.
 * Called once per input before the prompt is persisted or sent to a provider.
 */
export function assertPromptInputSafe(input: unknown): asserts input is PromptControl {
  if (typeof input !== 'object' || input === null) {
    throw new Error('Prompt input must be an object');
  }
  const rec = input as Record<string, unknown>;
  for (const key of Object.keys(rec)) {
    if (!ALLOWED_INPUT_FIELDS.has(key as keyof PromptControl)) {
      throw new Error(`Prompt input field '${key}' is not on the allow-list`);
    }
  }
  const ev = rec.evidence_metadata;
  if (!Array.isArray(ev)) {
    throw new Error('Prompt input evidence_metadata must be an array');
  }
  for (const [i, e] of ev.entries()) {
    if (typeof e !== 'object' || e === null) {
      throw new Error(`evidence_metadata[${i}] must be an object`);
    }
    for (const key of Object.keys(e)) {
      if (!ALLOWED_EVIDENCE_FIELDS.has(key as keyof PromptEvidenceMetadata)) {
        throw new Error(`evidence_metadata[${i}] field '${key}' is not on the allow-list`);
      }
    }
  }
}

export function buildPrompt(
  kind: AiGenerationKind,
  instructionsKey: string,
  scope: PromptScope,
  inputs: PromptControl[],
): PersistedPrompt {
  for (const input of inputs) assertPromptInputSafe(input);
  return { kind, instructions_key: instructionsKey, scope, inputs };
}

/**
 * Deterministic hash of the input set. Used to detect whether a regeneration
 * would produce the same output — if the hash matches the prior generation's
 * input hash, we short-circuit unless `force=true` (blueprint §4 /ai/regenerate:
 * "409 if evidence/response hash unchanged").
 */
export async function promptInputHash(inputs: PromptControl[]): Promise<string> {
  const { createHash } = await import('node:crypto');
  const sorted = [...inputs].sort((a, b) => (a.control_id < b.control_id ? -1 : 1));
  const json = JSON.stringify(
    sorted.map((c) => [
      c.control_id,
      c.weight,
      c.response_value,
      c.justification,
      c.evidence_metadata
        .map((e) => `${e.file_name}|${e.file_size_bytes}|${e.mime_type}`)
        .sort(),
    ]),
  );
  return createHash('sha256').update(json, 'utf8').digest('hex');
}
