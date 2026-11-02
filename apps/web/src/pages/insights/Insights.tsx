import { useQuery, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { AlertTriangle, Bot, Database, Download, HardDriveDownload, Mic, MicOff, Play, Plus, RefreshCw, Save, Send, ShieldCheck, Sparkles, ThumbsDown, ThumbsUp, Trash2, Volume2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Link } from '../../components/AppLink';
import { api, getAccessToken, invalidatePrefix } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { fmtBytes, fmtDate, fmtDateTime, fmtINR, fmtNum, fmtRelative, humanize } from '../../lib/format';
import { SimpleTable } from '../../components/DataTable';
import { Modal, useToast } from '../../components/overlay';
import { useProducts } from '../../components/business';
import { Badge, Button, Card, Checkbox, EmptyState, ErrorState, Input, Notice, PageHeader, Segmented, Select, Skeleton, Stat, StatusBadge, Tabs } from '../../components/ui';

const errMsg = (e: unknown) => (e as Error).message;
type Row = Record<string, any>;

// ---------------------------------------------------------------- charts
/** Single-series vertical bars: one hue, rounded data ends, hover tooltip, value labels on hover only. */
function BarChart({ data, label, format = fmtINR }: { data: { x: string; y: number }[]; label: string; format?: (n: number) => string }) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(1, ...data.map((d) => d.y));
  const W = 560, H = 180, pad = 24, bw = (W - pad * 2) / data.length;
  return (
    <div className="relative">
      <svg viewBox={`0 0 ${W} ${H + 24}`} className="w-full" role="img" aria-label={label}>
        <line x1={pad} x2={W - pad} y1={H} y2={H} className="stroke-slate-200" />
        {data.map((d, i) => {
          const h = Math.max(d.y > 0 ? 2 : 0, (d.y / max) * (H - 16));
          const x = pad + i * bw + bw * 0.22, w = bw * 0.56;
          return (
            <g key={d.x} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
              <rect x={pad + i * bw} y={0} width={bw} height={H + 24} fill="transparent" />
              <path d={`M${x},${H} v${-h + 4} q0,-4 4,-4 h${w - 8} q4,0 4,4 v${h - 4} z`} className={clsx('transition-colors', hover === i ? 'fill-brand-700' : 'fill-brand-500')} />
              <text x={pad + i * bw + bw / 2} y={H + 16} textAnchor="middle" className="fill-slate-500 text-[11px]">{d.x}</text>
            </g>
          );
        })}
      </svg>
      {hover !== null && (
        <div className="pointer-events-none absolute top-0 rounded-md bg-slate-900 px-2.5 py-1.5 text-[12px] text-white shadow" style={{ left: `${((pad + hover * bw + bw / 2) / W) * 100}%`, transform: 'translateX(-50%)' }}>
          {data[hover]!.x}: <span className="font-semibold">{format(data[hover]!.y)}</span>
        </div>
      )}
    </div>
  );
}
/** Horizontal bars for a ranked list (money tied up), magnitude in one hue, negatives in muted ink. */
function HBars({ rows }: { rows: { label: string; value: number }[] }) {
  const max = Math.max(1, ...rows.map((r) => Math.abs(r.value)));
  return (
    <ul className="space-y-2">
      {rows.map((r) => (
        <li key={r.label} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_auto] items-center gap-3 text-[13px]">
          <span className="truncate text-slate-700">{r.label}</span>
          <div className="h-2.5 rounded-full bg-slate-100"><div className={clsx('h-2.5 rounded-full', r.value >= 0 ? 'bg-brand-500' : 'bg-slate-400')} style={{ width: `${(Math.abs(r.value) / max) * 100}%` }} /></div>
          <span className="w-28 text-right tabular">{fmtINR(r.value)}</span>
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------- control tower
interface Tower { sections: Record<string, Row | null>; trend: { month: string; revenue: number; kg: number }[] | null; exceptions: { total: number; critical: number; top: Row[] } }
export function ControlTowerPage() {
  const q = useQuery({ queryKey: ['ins-tower'], queryFn: () => api.get<Tower>('/insights/control-tower') });
  const brief = useQuery({ queryKey: ['ins-brief'], queryFn: () => api.get<{ mode: string; points: string[]; generated_at: string }>('/insights/brief') });
  const qc = useQueryClient();
  const s = q.data?.sections;
  const tile = (label: string, value: unknown, sub?: string, tone?: 'danger' | 'warning' | 'success') => <Stat label={label} value={value === null || value === undefined ? '—' : String(value)} sub={sub} tone={tone} />;
  return (
    <>
      <PageHeader title="Control tower" description="The whole business on one page — each panel shows only what your role is allowed to see." breadcrumbs={[{ label: 'Insights' }]} actions={<Link to="/insights/assistant"><Button variant="primary" icon={<Sparkles className="size-4" />}>Ask the assistant</Button></Link>} />
      <Card className="mb-4" title="Today’s brief" description={brief.data ? `${brief.data.mode === 'ai' ? 'Written by the AI assistant' : 'Built-in summary'} · ${fmtDateTime(brief.data.generated_at)}` : undefined} actions={<Button size="sm" variant="ghost" icon={<RefreshCw className="size-3.5" />} onClick={async () => { await api.get('/insights/brief?refresh=1'); invalidatePrefix(qc, 'ins-brief'); }}>Refresh</Button>}>
        {!brief.data ? <Skeleton className="h-24" /> : <ul className="list-disc space-y-1.5 pl-5 text-[13.5px]">{brief.data.points.map((p, i) => <li key={i}>{p}</li>)}</ul>}
      </Card>
      {q.isError ? <ErrorState error={q.error} /> : !s ? <Skeleton className="h-96" /> : (
        <div className="space-y-4">
          {s.finance && <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">{tile('Revenue this year', fmtINR(s.finance.revenue_ytd))}{tile('Gross profit this year', fmtINR(s.finance.gross_profit_ytd))}{tile('Cash, bank and gateway', fmtINR(s.finance.cash_and_bank))}{tile('Receivables overdue', fmtINR(s.finance.receivables_overdue), `of ${fmtINR(s.finance.receivables)}`, s.finance.receivables_overdue > 0 ? 'warning' : undefined)}</div>}
          <div className="grid gap-4 lg:grid-cols-3">
            {q.data!.trend && <Card className="lg:col-span-2" title="Sales, last six months" description="Taxable value of invoices less credit notes"><BarChart data={q.data!.trend.map((t) => ({ x: new Date(`${t.month}-01T00:00:00`).toLocaleDateString('en-IN', { month: 'short' }), y: t.revenue }))} label="Monthly sales" /></Card>}
            <Card title="Exceptions" description={`${q.data!.exceptions.total} open · ${q.data!.exceptions.critical} critical`} actions={<Link className="link text-[13px]" to="/insights/exceptions">All</Link>}>
              <ul className="space-y-2 text-[13px]">{q.data!.exceptions.top.map((e, i) => <li key={i} className="flex gap-2"><StatusBadge status={e.severity} /><span><span className="text-slate-500">{e.source}:</span> {e.message}</span></li>)}{!q.data!.exceptions.top.length && <li className="text-slate-500">Nothing open.</li>}</ul>
            </Card>
          </div>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {s.inventory && <Card title="Stock"><dl className="grid grid-cols-2 gap-3 text-[13px]"><Kv k="In stock" v={`${fmtNum(s.inventory.physical_kg)} kg`} /><Kv k="Value at cost" v={fmtINR(s.inventory.value)} /><Kv k="Older than 90 days" v={`${fmtNum(s.inventory.over_90_days_kg)} kg`} warn={s.inventory.over_90_days_kg > 0} /><Kv k="On QC hold" v={`${fmtNum(s.inventory.qc_hold_kg)} kg`} /></dl></Card>}
            {s.sales && <Card title="Sales pipeline"><dl className="grid grid-cols-2 gap-3 text-[13px]"><Kv k="Open leads" v={s.sales.open_leads} /><Kv k="Follow-ups due" v={s.sales.followups_due} warn={s.sales.followups_due > 0} /><Kv k="Open quotations" v={fmtINR(s.sales.quotes_open_value)} /><Kv k="Won this month" v={fmtINR(s.sales.won_this_month)} /></dl></Card>}
            {s.dispatch && <Card title="Dispatch"><dl className="grid grid-cols-2 gap-3 text-[13px]"><Kv k="To pick" v={s.dispatch.to_pick} /><Kv k="Waiting for payment" v={s.dispatch.awaiting_payment} /><Kv k="Ready to dispatch" v={s.dispatch.ready_to_dispatch} /><Kv k="Late shipments" v={s.dispatch.late} warn={s.dispatch.late > 0} /></dl></Card>}
            {s.mills && <Card title="Mills"><dl className="grid grid-cols-2 gap-3 text-[13px]"><Kv k="At mills" v={`${fmtNum(s.mills.at_mill_kg)} kg`} /><Kv k="Open job orders" v={s.mills.open_orders} /><Kv k="Overdue" v={s.mills.overdue} warn={s.mills.overdue > 0} /><Kv k="Statutory due" v={s.mills.statutory_due} /></dl></Card>}
            {s.people && <Card title="People"><dl className="grid grid-cols-2 gap-3 text-[13px]"><Kv k="Headcount" v={s.people.headcount} /><Kv k="Present today" v={s.people.present_today} /><Kv k="On leave" v={s.people.on_leave_today} /><Kv k="Leave to approve" v={s.people.leave_pending} /></dl></Card>}
            {s.work && <Card title="Work"><dl className="grid grid-cols-2 gap-3 text-[13px]"><Kv k="Open tasks" v={s.work.open} /><Kv k="Overdue" v={s.work.overdue} warn={s.work.overdue > 0} /><Kv k="Escalated" v={s.work.escalated} warn={s.work.escalated > 0} /></dl></Card>}
          </div>
        </div>
      )}
    </>
  );
}
const Kv = ({ k, v, warn }: { k: string; v: unknown; warn?: boolean }) => <div><dt className="text-slate-500">{k}</dt><dd className={clsx('text-[16px] font-semibold tabular', warn && 'text-amber-700')}>{v === null || v === undefined ? '—' : String(v)}</dd></div>;

// ---------------------------------------------------------------- exceptions
export function ExceptionsPage() {
  const q = useQuery({ queryKey: ['ins-exc'], queryFn: () => api.get<Row[]>('/insights/exceptions') });
  const [src, setSrc] = useState('');
  const nav = useNavigate();
  const sources = [...new Set((q.data ?? []).map((e) => e.source))];
  const rows = (q.data ?? []).filter((e) => !src || e.source === src);
  return (
    <>
      <PageHeader title="Exception centre" description="Every open alert from every module you can see — financial anomalies, invoice mismatches, mill deadlines, stock problems, lead SLAs and dispatch delays — most severe first. Ask the assistant to explain any of them." breadcrumbs={[{ label: 'Insights', to: '/insights' }, { label: 'Exceptions' }]} />
      <div className="mb-4"><Segmented value={src} onChange={setSrc} options={[{ value: '', label: `All (${q.data?.length ?? 0})` }, ...sources.map((s) => ({ value: s, label: s }))]} /></div>
      <Card padded={false}>{!q.data ? <Skeleton className="m-5 h-40" /> : <SimpleTable rows={rows} rowKey={(e) => `${e.source}${e.kind}${e.message}`} onRowClick={(e) => e.link && nav(e.link)} empty={<EmptyState icon={<ShieldCheck className="size-5" />} title="No open exceptions" />} columns={[
        { key: 's', header: '', width: '90px', render: (e) => <StatusBadge status={e.severity} /> },
        { key: 'm', header: 'Exception', render: (e) => <div><p>{e.message}</p><p className="text-[12px] text-slate-500">{e.source} · {humanize(e.kind)}{e.ref ? ` · ${e.ref}` : ''}</p></div> },
        { key: 'a', header: 'Raised', render: (e) => fmtRelative(e.at) },
        { key: 'x', header: '', render: (e) => <Link onClick={(ev) => ev.stopPropagation()} className="link text-[12.5px]" to={`/insights/assistant?q=${encodeURIComponent(`Explain this alert and what I should do: [${e.source}] ${e.message}`)}`}>Explain</Link> },
      ]} />}</Card>
    </>
  );
}

// ---------------------------------------------------------------- reports
interface Dataset { key: string; label: string; module: string; permission: string; date_field: string | null; description: string }
interface Field { key: string; label: string; type: 'number' | 'date' | 'text' | 'boolean' }
interface RuleD { field: string; op: string; value: string }
interface Def { dataset: string; from?: string | null; to?: string | null; filters?: { logic: 'and' | 'or'; rules: RuleD[] }; columns?: string[]; group_by?: string[]; date_grain?: string | null; measures?: { field: string; agg: string }[]; sort?: { field: string; dir: 'asc' | 'desc' } | null; limit?: number | null }
interface Result { dataset: string; columns: Field[]; rows: Row[]; total_rows: number; result_rows: number; totals: Record<string, number>; truncated: boolean }
const OPS = [['eq', 'is'], ['neq', 'is not'], ['contains', 'contains'], ['gt', '>'], ['gte', '≥'], ['lt', '<'], ['lte', '≤'], ['in', 'one of'], ['empty', 'is empty'], ['not_empty', 'is not empty']];
const fmtCell = (v: unknown, t: string) => (v === null || v === undefined || v === '' ? '—' : t === 'number' ? Number(v).toLocaleString('en-IN', { maximumFractionDigits: 2 }) : t === 'date' ? fmtDate(String(v)) : typeof v === 'boolean' ? (v ? 'Yes' : 'No') : String(v));

export function ReportsPage() {
  const nav = useNavigate();
  const q = useQuery({ queryKey: ['ins-reports'], queryFn: () => api.get<Row[]>('/insights/reports') });
  const ds = useQuery({ queryKey: ['ins-datasets'], queryFn: () => api.get<Dataset[]>('/insights/datasets') });
  return (
    <>
      <PageHeader title="Reports" description="Build your own report from any data you are allowed to see: choose the data, filter with AND/OR, group, total, sort; save it, share it, schedule it, and export to Excel (CSV) or PDF." breadcrumbs={[{ label: 'Insights', to: '/insights' }, { label: 'Reports' }]} actions={<Button variant="primary" icon={<Plus className="size-4" />} onClick={() => nav('/insights/reports/new')}>New report</Button>} />
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2" title="Saved reports" padded={false}>{!q.data ? <Skeleton className="m-5 h-32" /> : <SimpleTable rows={q.data} rowKey={(r) => r.id} onRowClick={(r) => nav(`/insights/reports/${r.id}`)} empty={<EmptyState title="No saved reports yet" />} columns={[
          { key: 'n', header: 'Report', render: (r) => <div><p className="font-medium">{r.name}</p><p className="text-[12px] text-slate-500">{ds.data?.find((d) => d.key === r.dataset)?.label ?? r.dataset} · {r.owner_name}</p></div> },
          { key: 's', header: 'Schedule', render: (r) => (r.schedule === 'none' ? '—' : <Badge tone="info">{r.schedule}</Badge>) },
          { key: 'h', header: 'Shared', render: (r) => (r.shared ? 'Yes' : '—') },
          { key: 'l', header: 'Last run', render: (r) => (r.last_run_at ? fmtRelative(r.last_run_at) : '—') },
        ]} />}</Card>
        <Card title="Data you can report on"><ul className="space-y-2.5 text-[13px]">{(ds.data ?? []).map((d) => <li key={d.key}><Link className="link font-medium" to={`/insights/reports/new?dataset=${d.key}`}>{d.label}</Link><p className="text-[12px] text-slate-500">{d.module} · {d.description}</p></li>)}</ul></Card>
      </div>
    </>
  );
}

export function ReportBuilderPage() {
  const { id = 'new' } = useParams();
  const [sp] = useSearchParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const { user, can } = useAuth();
  const ds = useQuery({ queryKey: ['ins-datasets'], queryFn: () => api.get<Dataset[]>('/insights/datasets') });
  const saved = useQuery({ queryKey: ['ins-report', id], queryFn: () => api.get<Row>(`/insights/reports/${id}`), enabled: id !== 'new' });
  const [def, setDef] = useState<Def>({ dataset: sp.get('dataset') ?? '', filters: { logic: 'and', rules: [] }, group_by: [], measures: [], columns: [] });
  const [meta, setMeta] = useState({ name: '', shared: false, schedule: 'none' });
  const [result, setResult] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => { if (saved.data) { setDef(saved.data.definition); setMeta({ name: saved.data.name, shared: saved.data.shared, schedule: saved.data.schedule }); } }, [saved.data]);
  const snap = sp.get('snapshot');
  useEffect(() => { if (snap && id !== 'new') void api.get<{ result: Result }>(`/insights/reports/${id}/snapshots/${snap}`).then((s) => setResult({ ...s.result, dataset: '', total_rows: s.result.rows.length, result_rows: s.result.rows.length, truncated: false })); }, [snap, id]);
  // Start on the first dataset this person may report on (the list holds only those), never on one they cannot read.
  useEffect(() => { if (ds.data?.length && id === 'new' && !ds.data.some((d) => d.key === def.dataset)) setDef((x) => ({ ...x, dataset: ds.data![0]!.key })); }, [ds.data, id, def.dataset]);
  const fields = useQuery({ queryKey: ['ins-fields', def.dataset], queryFn: () => api.get<Field[]>(`/insights/datasets/${def.dataset}/fields`), enabled: !!ds.data?.some((d) => d.key === def.dataset) });
  const F = fields.data ?? [];
  const nums = F.filter((f) => f.type === 'number');
  const dsx = ds.data?.find((d) => d.key === def.dataset);
  const run = async () => { setBusy(true); setErr(null); try { setResult(await api.post<Result>('/insights/reports/run', def)); } catch (e) { setErr(errMsg(e)); } finally { setBusy(false); } };
  const csv = async () => {
    const r = await fetch('/api/insights/reports/run?format=csv', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${getAccessToken()}` }, body: JSON.stringify(def) });
    const url = URL.createObjectURL(await r.blob()); const a = document.createElement('a'); a.href = url; a.download = `${meta.name || def.dataset}.csv`; a.click(); URL.revokeObjectURL(url);
  };
  const setRule = (i: number, p: Partial<RuleD>) => setDef({ ...def, filters: { logic: def.filters?.logic ?? 'and', rules: (def.filters?.rules ?? []).map((r, j) => (j === i ? { ...r, ...p } : r)) } });
  const mine = id === 'new' || saved.data?.owner_id === user?.id;
  return (
    <>
      <PageHeader title={id === 'new' ? 'New report' : meta.name} breadcrumbs={[{ label: 'Insights', to: '/insights' }, { label: 'Reports', to: '/insights/reports' }, { label: id === 'new' ? 'New' : meta.name }]}
        actions={<div className="flex gap-2 print:hidden"><Button icon={<Play className="size-4" />} variant="primary" loading={busy} onClick={() => void run()}>Run</Button><Button icon={<Download className="size-4" />} onClick={() => void csv()}>Excel (CSV)</Button><Button onClick={() => window.print()}>PDF</Button>{can('insights.report.manage') && mine && <Button icon={<Save className="size-4" />} onClick={() => setSaving(true)}>Save</Button>}</div>} />
      <div className="grid gap-4 lg:grid-cols-[340px_minmax(0,1fr)]">
        <div className="space-y-4 print:hidden">
          <Card title="Data">
            <div className="space-y-3">
              <Select value={def.dataset} onChange={(e) => { setDef({ dataset: e.target.value, filters: { logic: 'and', rules: [] }, group_by: [], measures: [], columns: [] }); setResult(null); }} options={(ds.data ?? []).map((d) => ({ value: d.key, label: d.label }))} />
              {dsx?.date_field && <div className="grid grid-cols-2 gap-2"><Input type="date" label="From" value={def.from ?? ''} onChange={(e) => setDef({ ...def, from: e.target.value || null })} /><Input type="date" label="To" value={def.to ?? ''} onChange={(e) => setDef({ ...def, to: e.target.value || null })} /></div>}
            </div>
          </Card>
          <Card title="Filters" actions={<Segmented value={def.filters?.logic ?? 'and'} onChange={(l) => setDef({ ...def, filters: { logic: l, rules: def.filters?.rules ?? [] } })} options={[{ value: 'and', label: 'All' }, { value: 'or', label: 'Any' }]} />}>
            <div className="space-y-2">
              {(def.filters?.rules ?? []).map((r, i) => (
                <div key={i} className="grid grid-cols-[1fr_92px_1fr_20px] items-center gap-1.5">
                  <Select value={r.field} onChange={(e) => setRule(i, { field: e.target.value })} options={F.map((f) => ({ value: f.key, label: f.label }))} />
                  <Select value={r.op} onChange={(e) => setRule(i, { op: e.target.value })} options={OPS.map(([o, l]) => ({ value: o!, label: l! }))} />
                  <Input value={r.value} disabled={['empty', 'not_empty'].includes(r.op)} onChange={(e) => setRule(i, { value: e.target.value })} />
                  <button className="text-slate-400 hover:text-rose-600" onClick={() => setDef({ ...def, filters: { logic: def.filters!.logic, rules: def.filters!.rules.filter((_, j) => j !== i) } })}><Trash2 className="size-4" /></button>
                </div>
              ))}
              <Button size="sm" icon={<Plus className="size-3.5" />} disabled={!F.length} onClick={() => setDef({ ...def, filters: { logic: def.filters?.logic ?? 'and', rules: [...(def.filters?.rules ?? []), { field: F[0]!.key, op: 'contains', value: '' }] } })}>Add filter</Button>
            </div>
          </Card>
          <Card title="Group and total" description="Leave empty for a plain list.">
            <div className="space-y-3">
              <Select label="Group by" value={def.group_by?.[0] ?? ''} onChange={(e) => setDef({ ...def, group_by: e.target.value ? [e.target.value, ...(def.group_by?.slice(1) ?? [])] : [] })} placeholder="No grouping" options={F.filter((f) => f.type !== 'number').map((f) => ({ value: f.key, label: f.label }))} />
              {!!def.group_by?.length && <Select label="…then by" value={def.group_by[1] ?? ''} onChange={(e) => setDef({ ...def, group_by: e.target.value ? [def.group_by![0]!, e.target.value] : [def.group_by![0]!] })} placeholder="—" options={F.filter((f) => f.type !== 'number' && f.key !== def.group_by![0]).map((f) => ({ value: f.key, label: f.label }))} />}
              {def.group_by?.some((g) => F.find((f) => f.key === g)?.type === 'date') && <Select label="Dates by" value={def.date_grain ?? 'month'} onChange={(e) => setDef({ ...def, date_grain: e.target.value })} options={['day', 'month', 'quarter', 'year'].map((g) => ({ value: g, label: humanize(g) }))} />}
              <div className="space-y-1.5"><p className="text-[12.5px] font-medium text-slate-700">Totals</p>
                {(def.measures ?? []).map((m, i) => <div key={i} className="grid grid-cols-[110px_1fr_20px] gap-1.5"><Select value={m.agg} onChange={(e) => setDef({ ...def, measures: def.measures!.map((x, j) => (j === i ? { ...x, agg: e.target.value } : x)) })} options={['sum', 'avg', 'min', 'max', 'count', 'count_distinct'].map((a) => ({ value: a, label: a === 'count_distinct' ? 'distinct' : a }))} /><Select value={m.field} onChange={(e) => setDef({ ...def, measures: def.measures!.map((x, j) => (j === i ? { ...x, field: e.target.value } : x)) })} options={(m.agg === 'count_distinct' ? F : nums).map((f) => ({ value: f.key, label: f.label }))} /><button className="text-slate-400 hover:text-rose-600" onClick={() => setDef({ ...def, measures: def.measures!.filter((_, j) => j !== i) })}><Trash2 className="size-4" /></button></div>)}
                <Button size="sm" icon={<Plus className="size-3.5" />} disabled={!nums.length} onClick={() => setDef({ ...def, measures: [...(def.measures ?? []), { field: nums[0]!.key, agg: 'sum' }] })}>Add total</Button>
              </div>
            </div>
          </Card>
          {!def.group_by?.length && !def.measures?.length && <Card title="Columns"><div className="grid grid-cols-2 gap-1.5">{F.map((f) => <Checkbox key={f.key} label={f.label} checked={(def.columns ?? []).includes(f.key)} onChange={(e) => setDef({ ...def, columns: e.target.checked ? [...(def.columns ?? []), f.key] : (def.columns ?? []).filter((c) => c !== f.key) })} />)}</div></Card>}
        </div>
        <Card padded={false} title={result ? `${result.result_rows.toLocaleString('en-IN')} rows${result.total_rows !== result.result_rows ? ` from ${result.total_rows.toLocaleString('en-IN')} records` : ''}` : 'Result'} actions={result && <Select className="w-56" value={def.sort ? `${def.sort.field}:${def.sort.dir}` : ''} onChange={(e) => { const [f, d] = e.target.value.split(':'); const nd = { ...def, sort: f ? { field: f, dir: d as 'asc' } : null }; setDef(nd); void api.post<Result>('/insights/reports/run', nd).then(setResult); }} placeholder="Sort" options={result.columns.flatMap((c) => [{ value: `${c.key}:desc`, label: `${c.label} ↓` }, { value: `${c.key}:asc`, label: `${c.label} ↑` }])} />}>
          {err && <div className="p-4"><Notice tone="danger">{err}</Notice></div>}
          {!result ? <EmptyState icon={<Database className="size-5" />} title="Choose the data and press Run" description={dsx?.description} /> : (
            <div className="scrollbar-thin overflow-x-auto">
              <table className="w-full text-[13px]"><thead><tr className="border-b border-slate-200 bg-slate-50">{result.columns.map((c) => <th key={c.key} className={clsx('px-3 py-2 text-[11.5px] font-semibold whitespace-nowrap text-slate-500 uppercase', c.type === 'number' ? 'text-right' : 'text-left')}>{c.label}</th>)}</tr></thead>
                <tbody className="divide-y divide-slate-100">{result.rows.map((r, i) => <tr key={i}>{result.columns.map((c) => <td key={c.key} className={clsx('px-3 py-1.5 whitespace-nowrap', c.type === 'number' && 'text-right tabular')}>{fmtCell(r[c.key], c.type)}</td>)}</tr>)}</tbody>
                {Object.keys(result.totals).length > 0 && <tfoot><tr className="border-t-2 border-slate-300 font-semibold">{result.columns.map((c, i) => <td key={c.key} className={clsx('px-3 py-2', c.type === 'number' && 'text-right tabular')}>{i === 0 ? 'Total' : result.totals[c.key] !== undefined ? fmtCell(result.totals[c.key], 'number') : ''}</td>)}</tr></tfoot>}
              </table>
              {result.truncated && <p className="p-3 text-[12px] text-slate-500">Showing the first 5,000 rows; export to get them all.</p>}
            </div>
          )}
        </Card>
      </div>
      <Modal open={saving} onClose={() => setSaving(false)} title="Save report" footer={<><Button onClick={() => setSaving(false)}>Cancel</Button><Button variant="primary" disabled={meta.name.trim().length < 2} onClick={async () => {
        try { const body = { ...meta, definition: def }; if (id === 'new') { const r = await api.post<{ id: string }>('/insights/reports', body); nav(`/insights/reports/${r.id}`); } else await api.put(`/insights/reports/${id}`, body); invalidatePrefix(qc, 'ins-'); setSaving(false); toast({ tone: 'success', title: 'Report saved' }); } catch (e) { toast({ tone: 'error', title: 'Not saved', body: errMsg(e) }); }
      }}>Save</Button></>}>
        <div className="space-y-3"><Input label="Name" value={meta.name} onChange={(e) => setMeta({ ...meta, name: e.target.value })} /><Checkbox label="Share with everyone who can see this data" checked={meta.shared} onChange={(e) => setMeta({ ...meta, shared: e.target.checked })} />
          <Select label="Run automatically" value={meta.schedule} onChange={(e) => setMeta({ ...meta, schedule: e.target.value })} options={[{ value: 'none', label: 'No' }, { value: 'daily', label: 'Every morning' }, { value: 'weekly', label: 'Every Monday' }, { value: 'monthly', label: 'First of the month' }]} hint="Runs with your access, keeps the result and notifies you. Email delivery needs an email provider." /></div>
      </Modal>
    </>
  );
}

// ---------------------------------------------------------------- intelligence
export function IntelligencePage() {
  const [tab, setTab] = useState<'stock' | 'customers' | 'commercial' | 'suppliers' | 'fabric' | 'finance'>('stock');
  return (
    <>
      <PageHeader title="Textile intelligence" description="Explainable suggestions from your own data — every score shows the facts behind it. Nothing changes until a person acts on the screen the suggestion links to." breadcrumbs={[{ label: 'Insights', to: '/insights' }, { label: 'Intelligence' }]} />
      <Tabs className="mb-4" value={tab} onChange={setTab} tabs={[{ value: 'stock', label: 'Stock' }, { value: 'customers', label: 'Customers' }, { value: 'commercial', label: 'Quotations & pricing' }, { value: 'suppliers', label: 'Suppliers' }, { value: 'fabric', label: 'Fabric substitutes' }, { value: 'finance', label: 'Working capital & margin' }]} />
      {tab === 'stock' ? <StockIntel /> : tab === 'customers' ? <CustomerIntel /> : tab === 'commercial' ? <CommercialIntel /> : tab === 'suppliers' ? <SupplierIntel /> : tab === 'fabric' ? <FabricIntel /> : <FinanceIntel />}
    </>
  );
}
const healthTone = (h: number) => (h >= 70 ? 'success' : h >= 45 ? 'warning' : 'danger');
function StockIntel() {
  const q = useQuery({ queryKey: ['ins-stock'], queryFn: () => api.get<Row | null>('/insights/intel/stock') });
  if (q.data === null) return <EmptyState title="You do not have access to inventory" />;
  if (!q.data) return <Skeleton className="h-80" />;
  const d = q.data;
  return (
    <div className="space-y-4">
      <Card title="Stock health by fabric" description={d.assumptions} padded={false}>
        <SimpleTable rows={d.skus} rowKey={(s: Row) => s.sku} columns={[
          { key: 'h', header: 'Health', render: (s: Row) => <Badge tone={healthTone(s.health)}>{s.health}/100</Badge> },
          { key: 's', header: 'Fabric', render: (s: Row) => <div><p className="font-mono text-[12.5px] font-semibold">{s.sku}</p><p className="text-[12px] text-slate-500">{s.name}</p></div> },
          { key: 'k', header: 'On hand', align: 'right', render: (s: Row) => `${fmtNum(s.kg)} kg` },
          { key: 'c', header: 'Cover', align: 'right', render: (s: Row) => (s.cover_days == null ? '—' : `${s.cover_days} d`) },
          { key: 'f', header: 'Why', render: (s: Row) => <span className="text-[12.5px] text-slate-600">{s.factors.slice(1).join(' · ')}</span> },
          { key: 'a', header: 'Suggested', render: (s: Row) => <span className="text-[12.5px] font-medium">{s.action}</span> },
        ]} />
      </Card>
      <Card title="Transfer suggestions" padded={false} actions={<Link className="link text-[13px]" to="/inventory/transfers">Create a transfer</Link>}>
        {d.transfers.length ? <SimpleTable rows={d.transfers} rowKey={(t: Row) => `${t.sku}${t.from}${t.to}`} columns={[{ key: 's', header: 'Fabric', render: (t: Row) => <span className="font-mono">{t.sku}</span> }, { key: 'r', header: 'Move', render: (t: Row) => `${fmtNum(t.kg)} kg ${t.from} → ${t.to}` }, { key: 'w', header: 'Why', render: (t: Row) => <span className="text-[12.5px]">{t.why}</span> }]} /> : <p className="p-5 text-[13px] text-slate-500">Stock sits where it sells; no transfers suggested.</p>}
      </Card>
    </div>
  );
}
function CustomerIntel() {
  const q = useQuery({ queryKey: ['ins-cust'], queryFn: () => api.get<Row | null>('/insights/intel/customers') });
  if (q.data === null) return <EmptyState title="You do not have access to sales data" />;
  if (!q.data) return <Skeleton className="h-80" />;
  return (
    <Card title="Customers by churn risk" description={q.data.method} padded={false}>
      <SimpleTable rows={q.data.customers} rowKey={(c: Row) => c.customer_id} columns={[
        { key: 'r', header: 'Risk', render: (c: Row) => <Badge tone={c.churn_risk >= 50 ? 'danger' : c.churn_risk >= 25 ? 'warning' : 'success'}>{c.churn_risk}</Badge> },
        { key: 'c', header: 'Customer', render: (c: Row) => <div><Link className="link font-medium" to={`/crm/customers/${c.customer_id}`}>{c.customer}</Link><p className="text-[12px] text-slate-500">{c.factors.join('; ')}</p></div> },
        { key: 'v', header: 'Sales 12 m', align: 'right', render: (c: Row) => fmtINR(c.revenue_12m) },
        { key: 'm', header: 'Margin', align: 'right', render: (c: Row) => (c.margin_pct == null ? '—' : `${c.margin_pct}%`) },
        { key: 'y', header: 'Buys every', align: 'right', render: (c: Row) => (c.cycle_days ? `${c.cycle_days} d` : '—') },
        { key: 'n', header: 'Next order', render: (c: Row) => (c.next_expected ? <span className={c.repeat_due ? 'font-semibold text-amber-700' : ''}>{fmtDate(c.next_expected)}{c.repeat_due ? ' · due' : ''}</span> : '—') },
        { key: 'o', header: 'Overdue', align: 'right', render: (c: Row) => (c.overdue ? fmtINR(c.overdue) : '—') },
      ]} />
    </Card>
  );
}
function CommercialIntel() {
  const q = useQuery({ queryKey: ['ins-com'], queryFn: () => api.get<Row | null>('/insights/intel/commercial') });
  const products = useProducts();
  const [sim, setSim] = useState({ sku: '', list: '', offer: '' });
  const [res, setRes] = useState<Row | null>(null);
  if (q.data === null) return <EmptyState title="You do not have access to quotations" />;
  if (!q.data) return <Skeleton className="h-80" />;
  const d = q.data;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4"><Stat label="Win rate" value={d.totals.win_rate == null ? '—' : `${d.totals.win_rate}%`} sub={`${d.totals.decided} decided`} /><Stat label="Open quotations" value={fmtINR(d.totals.open_value)} /><Stat label="Quotations" value={d.totals.quotes} /><Stat label="Competitor prices noted" value={d.competitors.length} /></div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Win rate by margin" padded={false}><SimpleTable rows={d.margin_bands} rowKey={(b: Row) => b.band} columns={[{ key: 'b', header: 'Margin', render: (b: Row) => b.band }, { key: 'q', header: 'Decided', align: 'right', render: (b: Row) => b.quotes }, { key: 'w', header: 'Won', align: 'right', render: (b: Row) => (b.win_rate == null ? '—' : `${b.win_rate}%`) }]} /></Card>
        <Card title="Negotiation simulator" description="What a price does to margin and to the chance of winning, from past outcomes.">
          <div className="grid grid-cols-3 gap-2"><Select value={sim.sku} onChange={(e) => setSim({ ...sim, sku: e.target.value })} placeholder="Fabric" options={(products.data ?? []).map((p) => ({ value: p.sku, label: p.sku }))} /><Input type="number" prefix="₹" placeholder="List" value={sim.list} onChange={(e) => setSim({ ...sim, list: e.target.value })} /><Input type="number" prefix="₹" placeholder="Offer" value={sim.offer} onChange={(e) => setSim({ ...sim, offer: e.target.value })} /></div>
          <Button className="mt-3" disabled={!sim.sku || !Number(sim.list) || !Number(sim.offer)} onClick={async () => setRes(await api.post('/insights/intel/simulate', { sku: sim.sku, list_price: Number(sim.list), offer_price: Number(sim.offer) }))}>Simulate</Button>
          {res && <div className="mt-3 rounded-lg bg-slate-50 p-3 text-[13px] ring-1 ring-slate-200"><p>Discount <b>{res.discount_pct}%</b> · cost {res.cost_per_kg ? fmtINR(res.cost_per_kg) : 'unknown'}/kg · margin <b className={res.below_minimum_margin ? 'text-rose-600' : ''}>{res.margin_pct ?? '—'}%</b></p><p>Expected win rate <b>{res.expected_win_rate ?? '—'}%</b> ({res.based_on}).</p>{res.below_minimum_margin && <p className="mt-1 text-rose-600">Below the minimum margin — needs price approval.</p>}</div>}
        </Card>
      </div>
      <Card title="Follow up first" description="Open quotations ranked by value × chance of winning, doubled when validity ends within three days." padded={false} actions={<Link className="link text-[13px]" to="/crm/quotations">Quotations</Link>}>
        <SimpleTable rows={d.followups} rowKey={(f: Row) => f.id} empty={<EmptyState title="No open quotations" />} columns={[{ key: 'n', header: 'Quotation', render: (f: Row) => <Link className="link font-mono text-[12.5px]" to={`/crm/quotations/${f.id}`}>{f.number}</Link> }, { key: 'c', header: 'Customer', render: (f: Row) => f.customer }, { key: 'o', header: 'Owner', render: (f: Row) => f.owner }, { key: 't', header: 'Value', align: 'right', render: (f: Row) => fmtINR(f.total) }, { key: 'p', header: 'Chance', align: 'right', render: (f: Row) => (f.win_probability == null ? '—' : `${f.win_probability}%`) }, { key: 'd', header: 'Valid', render: (f: Row) => `${f.days_left} days` }]} />
      </Card>
      {d.competitors.length > 0 && <Card title="Competitor price register" padded={false}><SimpleTable rows={d.competitors} rowKey={(c: Row) => c.quotation} columns={[{ key: 'c', header: 'Competitor', render: (c: Row) => c.competitor }, { key: 'p', header: 'Their price', align: 'right', render: (c: Row) => fmtINR(c.competitor_price) }, { key: 'q', header: 'Our quotation', render: (c: Row) => `${c.quotation} · ${humanize(c.our_status)}` }, { key: 'u', header: 'Customer', render: (c: Row) => c.customer }]} /></Card>}
    </div>
  );
}
function SupplierIntel() {
  const products = useProducts();
  const [pid, setPid] = useState('');
  const q = useQuery({ queryKey: ['ins-sup', pid], queryFn: () => api.get<Row>(`/insights/intel/suppliers${pid ? `?productId=${pid}` : ''}`) });
  return (
    <div className="space-y-4">
      <Card title="Who should we buy this fabric from?" description={q.data?.note}>
        <div className="mb-3 flex gap-2"><Select className="w-80" value={pid} onChange={(e) => setPid(e.target.value)} placeholder="Choose a fabric" options={(products.data ?? []).map((p) => ({ value: p.id, label: `${p.sku} · ${p.name}` }))} /><Link to="/procurement/rfqs"><Button>Start an RFQ</Button></Link></div>
        {pid && (q.data?.recommendation?.length ? <SimpleTable rows={q.data.recommendation} rowKey={(r: Row) => r.supplier_id} columns={[{ key: 's', header: 'Score', render: (r: Row) => <Badge tone="brand">{r.recommendation_score}</Badge> }, { key: 'n', header: 'Supplier', render: (r: Row) => r.supplier_name }, { key: 'w', header: 'Why', render: (r: Row) => <span className="text-[12.5px]">{r.why}</span> }]} /> : <p className="text-[13px] text-slate-500">No purchase history for this fabric yet.</p>)}
      </Card>
      <Card title="Supplier scorecards" padded={false}>{!q.data ? <Skeleton className="m-5 h-32" /> : <SimpleTable rows={q.data.scorecards} rowKey={(r: Row) => r.supplier_id} columns={[{ key: 'n', header: 'Supplier', render: (r: Row) => r.supplier_name }, { key: 's', header: 'Score', align: 'right', render: (r: Row) => r.score ?? '—' }, { key: 'o', header: 'On time', align: 'right', render: (r: Row) => (r.on_time_pct == null ? '—' : `${r.on_time_pct}%`) }, { key: 'r', header: 'Rejected', align: 'right', render: (r: Row) => (r.rejection_pct == null ? '—' : `${r.rejection_pct}%`) }]} />}</Card>
    </div>
  );
}
function FabricIntel() {
  const products = useProducts();
  const [pid, setPid] = useState('');
  const q = useQuery({ queryKey: ['ins-subst', pid], queryFn: () => api.get<Row>(`/insights/intel/substitutes/${pid}`), enabled: !!pid });
  return (
    <Card title="Compatible substitutes" description={q.data?.rule ?? 'Choose the fabric the customer asked for to see what else could fill the order.'}>
      <Select className="mb-3 w-80" value={pid} onChange={(e) => setPid(e.target.value)} placeholder="Fabric asked for" options={(products.data ?? []).map((p) => ({ value: p.id, label: `${p.sku} · ${p.name}` }))} />
      {pid && !q.data ? <Skeleton className="h-32" /> : q.data && <SimpleTable rows={q.data.substitutes} rowKey={(s: Row) => s.product_id} empty={<EmptyState title="No close substitute" />} columns={[
        { key: 'sc', header: 'Match', render: (s: Row) => <Badge tone={s.within_tolerance ? 'success' : 'warning'}>{s.score}</Badge> },
        { key: 'p', header: 'Fabric', render: (s: Row) => <div><p className="font-mono text-[12.5px] font-semibold">{s.sku}</p><p className="text-[12px] text-slate-500">{s.name}</p></div> },
        { key: 'a', header: 'Available', align: 'right', render: (s: Row) => `${fmtNum(s.available_kg)} kg` },
        { key: 'm', header: 'Matches', render: (s: Row) => <span className="text-[12.5px] text-emerald-700">{s.matches.join(', ')}</span> },
        { key: 'd', header: 'Differences', render: (s: Row) => <span className="text-[12.5px] text-amber-700">{s.differences.join(', ') || '—'}</span> },
        { key: 'c', header: '', render: (s: Row) => (s.needs_customer_acceptance ? <Badge tone="warning">Customer must accept</Badge> : <Badge tone="success">Compatible</Badge>) },
      ]} />}
    </Card>
  );
}
function FinanceIntel() {
  const q = useQuery({ queryKey: ['ins-fin'], queryFn: () => api.get<Row | null>('/insights/intel/finance') });
  if (q.data === null) return <EmptyState title="You do not have access to finance" />;
  if (!q.data) return <Skeleton className="h-80" />;
  return (
    <div className="grid gap-4 lg:grid-cols-5">
      <Card className="lg:col-span-2" title="Where the money is tied up" description={`Net working capital ${fmtINR(q.data.net_working_capital)}`}><HBars rows={q.data.blocked.map((b: Row) => ({ label: b.item, value: b.amount }))} /></Card>
      <Card className="lg:col-span-3" title="Margin by invoice, lowest first" description={q.data.method} padded={false}>
        <SimpleTable rows={q.data.order_profitability.slice(0, 25)} rowKey={(o: Row) => o.invoice} columns={[{ key: 'i', header: 'Invoice', render: (o: Row) => <div><p className="font-mono text-[12.5px]">{o.invoice}</p><p className="text-[12px] text-slate-500">{o.customer} · {fmtDate(o.date)}</p></div> }, { key: 'r', header: 'Sales', align: 'right', render: (o: Row) => fmtINR(o.revenue) }, { key: 'c', header: 'Material', align: 'right', render: (o: Row) => fmtINR(o.material_cost) }, { key: 'f', header: 'Freight', align: 'right', render: (o: Row) => fmtINR(o.freight) }, { key: 'm', header: 'Margin', align: 'right', render: (o: Row) => <span className={(o.margin_pct ?? 0) < 8 ? 'font-semibold text-rose-600' : ''}>{o.margin_pct == null ? '—' : `${o.margin_pct}%`}{!o.cost_known && ' *'}</span> }]} />
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------- assistant
interface Msg { role: 'user' | 'assistant'; content: string; actions?: { label: string; path: string }[]; id?: string; mode?: string; tools?: string[] }
type SpeechCtor = new () => { lang: string; interimResults: boolean; onresult: (e: { results: { 0: { transcript: string } }[] }) => void; onend: () => void; start: () => void; stop: () => void };
export function AssistantPage() {
  const [sp] = useSearchParams();
  const nav = useNavigate();
  const status = useQuery({ queryKey: ['ins-ai'], queryFn: () => api.get<{ ai: boolean; model: string | null }>('/insights/assistant/status') });
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [q, setQ] = useState(sp.get('q') ?? '');
  const [busy, setBusy] = useState(false);
  const [listening, setListening] = useState(false);
  const rec = useRef<InstanceType<SpeechCtor> | null>(null);
  const end = useRef<HTMLDivElement>(null);
  const Speech = (window as unknown as { SpeechRecognition?: SpeechCtor; webkitSpeechRecognition?: SpeechCtor }).SpeechRecognition ?? (window as unknown as { webkitSpeechRecognition?: SpeechCtor }).webkitSpeechRecognition;
  useEffect(() => { end.current?.scrollIntoView({ behavior: 'smooth' }); }, [msgs]);
  const send = async (text: string) => {
    if (!text.trim()) return;
    const hist = msgs.map((m) => ({ role: m.role, content: m.content }));
    setMsgs((m) => [...m, { role: 'user', content: text }]); setQ(''); setBusy(true);
    try { const a = await api.post<{ answer: string; actions: Msg['actions']; id: string; mode: string; tools: string[] }>('/insights/assistant/ask', { question: text, history: hist }); setMsgs((m) => [...m, { role: 'assistant', content: a.answer, actions: a.actions, id: a.id, mode: a.mode, tools: a.tools }]); }
    catch (e) { setMsgs((m) => [...m, { role: 'assistant', content: errMsg(e) }]); } finally { setBusy(false); }
  };
  useEffect(() => { const x = sp.get('q'); if (x) void send(x); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);
  const listen = () => {
    if (!Speech) return;
    if (listening) { rec.current?.stop(); return; }
    const r = new Speech(); r.lang = 'en-IN'; r.interimResults = false;
    r.onresult = (e) => { const t = e.results[0]![0].transcript; setQ(t); void send(t); };
    r.onend = () => setListening(false);
    rec.current = r; setListening(true); r.start();
  };
  const speak = (t: string) => { const u = new SpeechSynthesisUtterance(t.replace(/[*_#]/g, '')); u.lang = 'en-IN'; speechSynthesis.cancel(); speechSynthesis.speak(u); };
  const SUGGEST = ['What needs my attention today?', 'Who owes us money and how much is overdue?', 'Which fabrics should we reorder?', 'Which customers have stopped buying?', 'Sales by customer this financial year', 'Which quotations should we follow up first?'];
  return (
    <>
      <PageHeader title="Business assistant" description="Ask in plain words. Answers come from the ERP, with your own access — the assistant can read, never change. Suggested actions open the right screen for you to decide." breadcrumbs={[{ label: 'Insights', to: '/insights' }, { label: 'Assistant' }]}
        meta={status.data && <Badge tone={status.data.ai ? 'success' : 'neutral'}>{status.data.ai ? `AI: ${status.data.model}` : 'Built-in answers (no API key)'}</Badge>} />
      {status.data && !status.data.ai && <div className="mb-4"><Notice tone="info">Free-form questions need an Anthropic API key (ANTHROPIC_API_KEY). Until then the assistant answers common questions — receivables, stock, customers, suppliers, quotations, exceptions — from built-in analyses.</Notice></div>}
      <Card padded={false} className="flex h-[calc(100vh-270px)] min-h-[420px] flex-col">
        <div className="flex-1 space-y-4 overflow-y-auto p-5">
          {!msgs.length && <div className="flex flex-wrap gap-2">{SUGGEST.map((s) => <button key={s} className="rounded-full bg-slate-100 px-3 py-1.5 text-[13px] hover:bg-brand-50" onClick={() => void send(s)}>{s}</button>)}</div>}
          {msgs.map((m, i) => (
            <div key={i} className={clsx('flex gap-3', m.role === 'user' && 'justify-end')}>
              {m.role === 'assistant' && <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-brand-50 text-brand-700"><Bot className="size-4" /></div>}
              <div className={clsx('max-w-3xl rounded-xl px-4 py-3 text-[13.5px] whitespace-pre-wrap', m.role === 'user' ? 'bg-brand-600 text-white' : 'bg-slate-50 ring-1 ring-slate-200')}>
                {m.content}
                {m.actions?.length ? <div className="mt-3 flex flex-wrap gap-2">{m.actions.map((a) => <Button key={a.path + a.label} size="sm" onClick={() => nav(a.path)}>{a.label}</Button>)}</div> : null}
                {m.role === 'assistant' && m.id && <div className="mt-2 flex items-center gap-2 text-[11.5px] text-slate-500">{m.tools?.length ? <span>Looked at: {m.tools.map(humanize).join(', ')}</span> : null}<span className="flex-1" />
                  <button title="Read aloud" onClick={() => speak(m.content)}><Volume2 className="size-3.5" /></button>
                  <button title="Helpful" onClick={() => void api.post(`/insights/assistant/${m.id}/feedback`, { feedback: 'helpful' })}><ThumbsUp className="size-3.5" /></button>
                  <button title="Not helpful" onClick={() => void api.post(`/insights/assistant/${m.id}/feedback`, { feedback: 'not_helpful' })}><ThumbsDown className="size-3.5" /></button></div>}
              </div>
            </div>
          ))}
          {busy && <div className="flex items-center gap-2 text-[13px] text-slate-500"><Bot className="size-4 animate-pulse" />Looking into it…</div>}
          <div ref={end} />
        </div>
        <form className="flex gap-2 border-t border-slate-200 p-3" onSubmit={(e) => { e.preventDefault(); void send(q); }}>
          {Speech && <Button type="button" variant="ghost" aria-label={listening ? 'Stop voice input' : 'Ask by voice'} title={listening ? 'Stop voice input' : 'Ask by voice'} icon={listening ? <MicOff className="size-4" /> : <Mic className="size-4" />} onClick={listen}>{listening ? 'Stop' : ''}</Button>}
          <Input className="flex-1" placeholder="Ask about sales, stock, customers, suppliers, money…" value={q} onChange={(e) => setQ(e.target.value)} />
          <Button type="submit" variant="primary" loading={busy} icon={<Send className="size-4" />}>Ask</Button>
        </form>
      </Card>
    </>
  );
}

// ---------------------------------------------------------------- system health
export function SystemHealthPage() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['ins-sys'], queryFn: () => api.get<Row>('/insights/system/health'), refetchInterval: 15_000 });
  const [busy, setBusy] = useState<string | null>(null);
  const d = q.data;
  const act = async (key: string, path: string) => { setBusy(key); try { await api.post(path); invalidatePrefix(qc, 'ins-sys'); } catch (e) { toast({ tone: 'error', title: 'Failed', body: errMsg(e) }); } finally { setBusy(null); } };
  const sizes = useMemo(() => (d?.database.schemas ?? []).slice(0, 10), [d]);
  if (!d) return <Skeleton className="h-96" />;
  const down = d.services.filter((s: Row) => !s.ok);
  const behind = d.bus.consumers.filter((c: Row) => c.behind > 50);
  const backupStale = d.hours_since_backup === null || d.hours_since_backup > d.rpo_hours;
  return (
    <>
      <PageHeader title="System health and continuity" description={`Services, event bus, database and backups. Recovery targets: data loss no more than ${d.rpo_hours} h (RPO), back in service within ${d.rto_hours} h (RTO). The runbook is in docs/continuity.md.`} breadcrumbs={[{ label: 'Administration' }, { label: 'System health' }]}
        actions={can('system.backup.manage') && <Button variant="primary" loading={busy === 'backup'} icon={<HardDriveDownload className="size-4" />} onClick={() => void act('backup', '/insights/system/backups')}>Back up now</Button>} />
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Services" value={`${d.services.length - down.length} / ${d.services.length} up`} tone={down.length ? 'danger' : 'success'} sub={down.map((s: Row) => s.service).join(', ') || 'all healthy'} />
        <Stat label="Event bus" value={`${fmtNum(d.bus.events.last_hour)} events/hour`} sub={behind.length ? `${behind.length} consumer(s) behind` : 'all consumers current'} tone={behind.length ? 'warning' : undefined} />
        <Stat label="Database" value={d.database.size} sub={`PostgreSQL ${d.database.version} · ${d.database.connections} connections`} />
        <Stat label="Last good backup" value={d.hours_since_backup === null ? 'Never' : `${d.hours_since_backup} h ago`} tone={backupStale ? 'danger' : 'success'} sub={backupStale ? `older than the ${d.rpo_hours} h RPO` : 'within RPO'} />
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Services" padded={false}><ul className="divide-y divide-slate-100 text-[13px]">{d.services.map((s: Row) => <li key={s.service} className="flex items-center justify-between px-4 py-2"><span>{s.service}</span><span className="flex items-center gap-2 text-slate-500">{s.ms} ms<Badge tone={s.ok ? 'success' : 'danger'} dot>{s.ok ? 'up' : 'down'}</Badge></span></li>)}</ul></Card>
        <Card title="Event consumers" padded={false}><ul className="divide-y divide-slate-100 text-[13px]">{d.bus.consumers.map((c: Row) => <li key={c.consumer} className="flex justify-between px-4 py-2"><span>{c.consumer}</span><span className={clsx('tabular', c.behind > 50 && 'font-semibold text-amber-700')}>{c.behind} behind</span></li>)}</ul></Card>
        <Card title="Storage by module">{sizes.map((s: Row) => <div key={s.schema} className="mb-1.5 grid grid-cols-[110px_1fr_70px] items-center gap-2 text-[12.5px]"><span>{s.schema}</span><div className="h-2 rounded-full bg-slate-100"><div className="h-2 rounded-full bg-brand-500" style={{ width: `${(s.bytes / sizes[0].bytes) * 100}%` }} /></div><span className="text-right tabular">{fmtBytes(s.bytes)}</span></div>)}</Card>
      </div>
      <Card className="mt-4" title="Backups and restore tests" description={`pg_dump files in ${d.backup_dir}. A restore test checks the checksum, restores into a scratch database and compares row counts of key tables.`} padded={false}>
        <SimpleTable rows={d.backups} rowKey={(b: Row) => b.id} empty={<EmptyState icon={<Database className="size-5" />} title="No backups yet" description="Schedule `npm run backup` daily on the server as well (see the runbook)." />} columns={[
          { key: 'w', header: 'When', render: (b: Row) => <div><p>{fmtDateTime(b.started_at)}</p><p className="text-[12px] text-slate-500">{b.started_by_name}</p></div> },
          { key: 'f', header: 'File', render: (b: Row) => <div><p className="font-mono text-[12px]">{b.file_name}</p><p className="font-mono text-[11px] text-slate-400">{b.sha256?.slice(0, 16)}</p></div> },
          { key: 's', header: 'Size', align: 'right', render: (b: Row) => (b.size_bytes ? fmtBytes(Number(b.size_bytes)) : '—') },
          { key: 't', header: 'Took', align: 'right', render: (b: Row) => (b.duration_ms ? `${(b.duration_ms / 1000).toFixed(1)} s` : '—') },
          { key: 'x', header: 'Backup', render: (b: Row) => <div><StatusBadge status={b.status} />{b.error && <p className="max-w-xs text-[11.5px] text-rose-600">{b.error}</p>}</div> },
          { key: 'r', header: 'Restore test', render: (b: Row) => b.restore_status ? <div><Badge tone={b.restore_status === 'passed' ? 'success' : 'danger'}>{b.restore_status}</Badge><p className="text-[11.5px] text-slate-500">{b.restore_ms ? `${(b.restore_ms / 1000).toFixed(1)} s · ` : ''}{b.restore_detail?.tables ? `${b.restore_detail.tables} tables checked` : b.restore_detail?.error}</p></div> : b.status === 'completed' && can('system.backup.manage') ? <Button size="sm" loading={busy === b.id} onClick={() => void act(b.id, `/insights/system/backups/${b.id}/restore-test`)}>Test restore</Button> : '—' },
        ]} />
      </Card>
      <Card className="mt-4" title="Parked events" description="Events a module could not process. Fix the cause, then replay — only the module that failed processes it again; postings are idempotent." padded={false}>
        <SimpleTable rows={d.bus.dead_letters} rowKey={(x: Row) => String(x.id)} empty={<EmptyState icon={<ShieldCheck className="size-5" />} title="Nothing parked" />} columns={[
          { key: 'c', header: 'Module', render: (x: Row) => x.consumer }, { key: 't', header: 'Event', render: (x: Row) => <span className="font-mono text-[12px]">{x.type} #{x.event_id}</span> },
          { key: 'e', header: 'Error', render: (x: Row) => <span className="text-[12.5px] text-rose-700">{x.replay_error ?? x.error}</span> }, { key: 'w', header: 'Failed', render: (x: Row) => fmtRelative(x.failed_at) },
          { key: 'a', header: '', render: (x: Row) => x.replayed_at ? <Badge tone="success">Replayed</Badge> : x.replay_requested_at ? <Badge tone="info">Queued</Badge> : can('system.backup.manage') ? <Button size="sm" icon={<AlertTriangle className="size-3.5" />} onClick={() => void act(`dl${x.id}`, `/insights/system/dead-letters/${x.id}/replay`)}>Replay</Button> : null },
        ]} />
      </Card>
    </>
  );
}
