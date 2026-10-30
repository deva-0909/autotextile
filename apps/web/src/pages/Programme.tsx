import { clsx } from 'clsx';
import { CheckCircle2, CircleDashed, Construction, Flag, ListChecks, PenTool, Target } from 'lucide-react';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import programme from '../lib/programme.json';
import { Badge, Card, EmptyState, PageHeader, Segmented } from '../components/ui';

type Status = 'delivered' | 'in_delivery' | 'planned';
/** Delivery status of each phase. P0 artefacts and P1 software ship in this release. */
const PHASE_STATUS: Record<string, Status> = { P0: 'in_delivery', P1: 'in_delivery' };
/** Requirement-level status for the current release (see docs/traceability.md). */
const REQ_STATUS: Record<string, Status> = {
  'REQ-0007': 'delivered', 'REQ-0008': 'delivered', 'REQ-0009': 'delivered', 'REQ-0010': 'delivered', 'REQ-0011': 'delivered', 'REQ-0012': 'delivered',
  'REQ-0002': 'in_delivery', 'REQ-0004': 'in_delivery', 'REQ-0005': 'in_delivery',
};
const SCREEN_STATUS: Record<string, Status> = { 'FIG-001': 'delivered', 'FIG-002': 'delivered', 'FIG-003': 'delivered', 'FIG-004': 'delivered', 'FIG-005': 'delivered', 'FIG-006': 'delivered', 'FIG-007': 'delivered' };

const STATUS_BADGE: Record<Status, React.ReactNode> = {
  delivered: <Badge tone="success" dot>Built</Badge>,
  in_delivery: <Badge tone="brand" dot>In progress</Badge>,
  planned: <Badge dot>Planned</Badge>,
};

const SCREEN_ROUTES: Record<string, string> = { 'FIG-001': '/login', 'FIG-002': '/', 'FIG-003': '/organisation/entities', 'FIG-004': '/organisation/warehouses', 'FIG-005': '/security/users', 'FIG-006': '/governance/audit', 'FIG-007': '/partners/customer' };

export function ProgrammePage() {
  const total = programme.requirements.length;
  const done = programme.requirements.filter((r) => REQ_STATUS[r.id] === 'delivered').length;
  return (
    <>
      <PageHeader title="Programme tracker" description="Phase-wise plan, requirements and screens imported from the Development & Figma Tracker workbook. Nothing deferred is dropped — every item stays here with its phase." breadcrumbs={[{ label: 'Programme' }]} />
      <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
        {[
          { label: 'Phases', value: programme.phases.length, icon: <Flag className="size-4" /> },
          { label: 'Requirements', value: `${done} / ${total} built`, icon: <ListChecks className="size-4" /> },
          { label: 'Screens', value: `${Object.keys(SCREEN_STATUS).length} / ${programme.screens.length} built`, icon: <PenTool className="size-4" /> },
          { label: 'Current release', value: 'P1 · built, awaiting UAT', icon: <Target className="size-4" /> },
        ].map((k) => (
          <div key={k.label} className="card p-4"><p className="flex items-center gap-2 text-[12.5px] text-slate-500">{k.icon}{k.label}</p><p className="mt-1 text-[18px] font-semibold">{k.value}</p></div>
        ))}
      </div>
      <ol className="relative space-y-3 before:absolute before:top-4 before:bottom-4 before:left-[19px] before:w-0.5 before:bg-slate-200">
        {programme.phases.map((p) => {
          const st = PHASE_STATUS[p.id] ?? 'planned';
          const reqs = programme.requirements.filter((r) => r.phase === p.id);
          const screens = programme.screens.filter((s) => s.phase === p.id);
          return (
            <li key={p.id} className="relative pl-14">
              <span className={clsx('absolute top-4 left-0 flex size-10 items-center justify-center rounded-full border-4 border-slate-50 text-[12px] font-bold', st === 'delivered' ? 'bg-emerald-500 text-white' : st === 'in_delivery' ? 'bg-brand-600 text-white' : 'bg-white text-slate-500 ring-1 ring-slate-300')}>{p.id}</span>
              <Link to={`/roadmap/${p.id}`} className="card block p-4 transition hover:border-slate-300">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-[14.5px] font-semibold text-slate-900">{p.name}</p>
                  <span className="flex items-center gap-2">{STATUS_BADGE[st]}<span className="text-[12px] text-slate-500">{p.timing}</span></span>
                </div>
                <p className="mt-1 text-[13px] text-slate-600">{p.scope}</p>
                <p className="mt-2 text-[12px] text-slate-500">{reqs.length} requirements · {screens.length} screens</p>
              </Link>
            </li>
          );
        })}
      </ol>
    </>
  );
}

export function RoadmapPage() {
  const { phase = 'P2' } = useParams();
  const p = programme.phases.find((x) => x.id === phase);
  const [view, setView] = useState<'requirements' | 'screens'>('requirements');
  if (!p) return <EmptyState title="Unknown phase" />;
  const st = PHASE_STATUS[p.id] ?? 'planned';
  const reqs = programme.requirements.filter((r) => r.phase === p.id);
  const screens = programme.screens.filter((s) => s.phase === p.id);
  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: 'Programme', to: '/programme' }, { label: p.id }]}
        title={<>{p.name} {STATUS_BADGE[st]}</>}
        description={p.scope}
      />
      {st === 'planned' && (
        <div className="mb-6 flex items-start gap-4 rounded-xl border border-brand-200 bg-gradient-to-r from-brand-50 to-white p-5">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-brand-600 text-white"><Construction className="size-5" /></span>
          <div>
            <p className="text-[14px] font-semibold text-slate-900">Planned for the {p.timing.toLowerCase()}</p>
            <p className="mt-1 text-[13px] text-slate-600">This module will be delivered as its own microservice on the platform built in P1, reusing identity, data scope, audit, approvals, documents and the master data you maintain today.</p>
          </div>
        </div>
      )}
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
        <Card title="Exit gate" className="h-fit"><p className="text-[13.5px] leading-relaxed text-slate-700">{p.exit}</p></Card>
        <Card className="xl:col-span-2" padded={false} title={view === 'requirements' ? `Requirements (${reqs.length})` : `Screens (${screens.length})`}
          actions={<Segmented value={view} onChange={setView} options={[{ value: 'requirements', label: 'Requirements' }, { value: 'screens', label: 'Screens' }]} />}>
          {view === 'requirements' ? (
            <ul className="divide-y divide-slate-100">
              {reqs.map((r) => (
                <li key={r.id} className="px-5 py-3.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-[12px] font-semibold text-slate-500">{r.id}</span>
                    <span className="text-[13.5px] font-medium text-slate-900">{r.feature}</span>
                    <Badge>{r.module}</Badge>
                    {r.priority === 'Must' && <Badge tone="danger">Must</Badge>}
                    <span className="ml-auto">{STATUS_BADGE[REQ_STATUS[r.id] ?? 'planned']}</span>
                  </div>
                  <p className="mt-1 text-[12.5px] leading-relaxed text-slate-600">{r.detail}</p>
                </li>
              ))}
            </ul>
          ) : (
            <ul className="divide-y divide-slate-100">
              {screens.map((s) => (
                <li key={s.id} className="flex items-center gap-3 px-5 py-3">
                  {SCREEN_STATUS[s.id] ? <CheckCircle2 className="size-4 text-emerald-500" /> : <CircleDashed className="size-4 text-slate-300" />}
                  <span className="font-mono text-[12px] font-semibold text-slate-500">{s.id}</span>
                  <span className="flex-1 text-[13.5px] text-slate-900">{s.name}</span>
                  <Badge>{s.portal}</Badge>
                  {SCREEN_ROUTES[s.id] && <Link className="link text-[12.5px]" to={SCREEN_ROUTES[s.id]!}>Open</Link>}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}
