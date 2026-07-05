/**
 * Risk Manager — Portfolio (Wireframe 1h).
 *
 * Sortable/filterable vendor table. Server-side sort is authoritative for
 * `score`/`tier`/`status`/`name`; blueprint §4 caps `page_size` at 100.
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../../lib/api';
import { TierBadge } from '../../components/ui/Badge';
import { ErrorMessage } from '../../components/ErrorMessage';

type Tier = 'low' | 'medium' | 'high' | 'critical';
type SortKey = 'score' | 'tier' | 'status' | 'name';

interface PortfolioRow {
  vendor_id: string;
  name: string;
  score: number | null;
  tier: Tier | null;
  worst_domain: { name: string; sub_score: number } | null;
  status: string;
}
interface PortfolioResp {
  page: number;
  page_size: number;
  total: number;
  vendors: PortfolioRow[];
}

export function Portfolio() {
  const [sort, setSort] = useState<SortKey>('score');
  const [filterTier, setFilterTier] = useState<Tier | ''>('');
  const [q, setQ] = useState('');

  const query = useQuery<PortfolioResp>({
    queryKey: ['portfolio', sort, filterTier, q],
    queryFn: () => {
      const params = new URLSearchParams({ sort, page_size: '50' });
      if (filterTier) params.set('filter_tier', filterTier);
      if (q) params.set('q', q);
      return api.get(`/risk/portfolio?${params.toString()}`);
    },
  });

  return (
    <div className="max-w-7xl mx-auto px-4 py-6">
      <div className="flex items-baseline justify-between mb-4">
        <div>
          <h1 className="text-xl font-semibold">Vendor portfolio</h1>
          <p className="text-sm text-slate-600">
            {query.data?.total ?? 0} vendor{query.data?.total === 1 ? '' : 's'} in scope.
          </p>
        </div>
        <div className="flex gap-2">
          <input
            className="field w-64"
            placeholder="Search vendor…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <select
            className="field w-40"
            value={filterTier}
            onChange={(e) => setFilterTier(e.target.value as Tier | '')}
            aria-label="Filter by tier"
          >
            <option value="">All tiers</option>
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
            <option value="critical">Critical</option>
          </select>
        </div>
      </div>

      {query.error && <ErrorMessage error={query.error} />}

      <div className="card overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 border-b border-slate-200 text-slate-600">
            <tr>
              <Th active={sort === 'name'} onClick={() => setSort('name')}>Vendor</Th>
              <Th active={sort === 'score'} onClick={() => setSort('score')}>Score</Th>
              <Th active={sort === 'tier'} onClick={() => setSort('tier')}>Tier</Th>
              <th className="text-left px-3 py-2 font-medium">Worst domain</th>
              <Th active={sort === 'status'} onClick={() => setSort('status')}>Status</Th>
              <th className="text-right px-3 py-2 font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {query.isLoading && (
              <tr>
                <td colSpan={6} className="px-3 py-6 text-center text-slate-500">
                  Loading…
                </td>
              </tr>
            )}
            {query.data?.vendors.map((v) => (
              <tr key={v.vendor_id} className="border-b border-slate-100 hover:bg-slate-50">
                <td className="px-3 py-2 font-medium">{v.name}</td>
                <td className="px-3 py-2 tabular-nums">{v.score ?? '—'}</td>
                <td className="px-3 py-2">
                  <TierBadge tier={v.tier}>{v.tier ?? '—'}</TierBadge>
                </td>
                <td className="px-3 py-2 text-slate-600">
                  {v.worst_domain ? (
                    <>
                      {v.worst_domain.name}{' '}
                      <span className="text-slate-400">({v.worst_domain.sub_score})</span>
                    </>
                  ) : (
                    '—'
                  )}
                </td>
                <td className="px-3 py-2 text-slate-600">{v.status}</td>
                <td className="px-3 py-2 text-right">
                  <Link to={`/risk/${v.vendor_id}`} className="btn text-xs">
                    Open
                  </Link>
                </td>
              </tr>
            ))}
            {query.data && query.data.vendors.length === 0 && (
              <tr>
                <td colSpan={6} className="px-3 py-6 text-center text-slate-500">
                  No vendors match the current filter.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Th({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <th className="text-left px-3 py-2 font-medium">
      <button onClick={onClick} className={active ? 'text-slate-900 underline' : 'hover:text-slate-900'}>
        {children}
      </button>
    </th>
  );
}
