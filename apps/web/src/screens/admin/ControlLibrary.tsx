/**
 * Admin Console — Wireframe 1j (Control Library, Weights & Routing).
 *
 * Sprint 4 renders the tabbed shell + placeholders. The GET/PATCH/POST endpoints
 * for controls/questions/assignments/routing land in Sprint 5 (blueprint §4
 * admin section). Wiring is deliberate — layout stabilizes now so Sprint 5
 * only needs to plug in mutation calls.
 */
import { useState } from 'react';

type Tab = 'controls' | 'questions' | 'assignments' | 'routing';

const TABS: Array<{ key: Tab; label: string }> = [
  { key: 'controls', label: 'Control Library' },
  { key: 'questions', label: 'Question Bank' },
  { key: 'assignments', label: 'Assignments' },
  { key: 'routing', label: 'Routing' },
];

export function AdminConsole() {
  const [tab, setTab] = useState<Tab>('controls');
  return (
    <div className="max-w-7xl mx-auto px-4 py-6">
      <h1 className="text-lg font-semibold mb-4">Admin console</h1>
      <div className="card overflow-hidden">
        <div className="flex border-b border-slate-200">
          {TABS.map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px ${
                tab === t.key
                  ? 'border-slate-900 text-slate-900'
                  : 'border-transparent text-slate-500 hover:text-slate-800'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div className="p-6">
          {tab === 'controls' && <ControlsPane />}
          {tab === 'questions' && <Placeholder feature="Question Bank" endpoints="/admin/questions" />}
          {tab === 'assignments' && (
            <Placeholder feature="Vendor Assignments" endpoints="/admin/vendors/:vendorId/assign-checklist" />
          )}
          {tab === 'routing' && (
            <Placeholder feature="Routing Rules" endpoints="/admin/routing-rules" />
          )}
        </div>
      </div>
    </div>
  );
}

function ControlsPane() {
  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <p className="text-sm text-slate-600">
          SCF controls with editable weight and routing.
        </p>
        <button className="btn" disabled title="POST /admin/controls lands in Sprint 5">
          + Custom control (pending)
        </button>
      </div>
      <Placeholder feature="Control Library" endpoints="/admin/controls, PATCH /admin/controls/:id" />
    </div>
  );
}

function Placeholder({ feature, endpoints }: { feature: string; endpoints: string }) {
  return (
    <div className="border border-dashed border-slate-300 rounded-md p-6 bg-slate-50">
      <h2 className="text-sm font-semibold">{feature}</h2>
      <p className="text-sm text-slate-600 mt-1">
        Backend endpoints (<code className="text-xs">{endpoints}</code>) land in Sprint 5.
      </p>
    </div>
  );
}
