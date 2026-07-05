/**
 * Persistent "AI-Generated — Human Review Required" banner.
 *
 * Blueprint §5.5 (AI Safeguards) and §7 cross-cutting notes: any AI-generated
 * content MUST be rendered with a visible disclosure. This component is
 * intentionally NOT dismissible — no `onClose`, no local storage flag, no
 * "show once and hide" logic. The prop surface is deliberately minimal so
 * a future refactor can't accidentally add a dismiss handler.
 */
interface Props {
  /** Optional tighter styling for inline (e.g. inside a gap card). */
  variant?: 'banner' | 'inline';
}

export function AiDisclosure({ variant = 'banner' }: Props) {
  const cls =
    variant === 'inline'
      ? 'inline-flex items-center gap-1.5 text-xs font-medium text-amber-900 bg-amber-50 border border-amber-200 rounded px-2 py-1'
      : 'flex items-center gap-2 text-sm font-medium text-amber-900 bg-amber-50 border-y border-amber-200 px-4 py-2';
  return (
    <div className={cls} role="status" aria-live="polite" data-testid="ai-disclosure">
      <span aria-hidden="true">⚠️</span>
      <span>AI-Generated — Human Review Required</span>
    </div>
  );
}
