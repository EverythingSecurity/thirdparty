import type { ReactNode } from 'react';

type Tier = 'low' | 'medium' | 'high' | 'critical';

interface Props {
  tier?: Tier | null;
  children: ReactNode;
}

const TIER_CLASS: Record<Tier, string> = {
  low: 'bg-green-100 text-green-800 border-green-200',
  medium: 'bg-yellow-100 text-yellow-800 border-yellow-200',
  high: 'bg-orange-100 text-orange-800 border-orange-200',
  critical: 'bg-red-100 text-red-800 border-red-200',
};

export function TierBadge({ tier, children }: Props) {
  const cls = tier ? TIER_CLASS[tier] : 'bg-slate-100 text-slate-700 border-slate-200';
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium border ${cls}`}
    >
      {children}
    </span>
  );
}
