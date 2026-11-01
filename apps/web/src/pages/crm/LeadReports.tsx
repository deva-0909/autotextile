import { useQuery, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { useState } from 'react';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { fmtDate, fmtINR, humanize } from '../../lib/format';
import { SimpleTable } from '../../components/DataTable';
import { Modal, useToast } from '../../components/overlay';
import { Badge, Button, Card, ErrorState, Input, Notice, PageHeader, Skeleton, Stat, Tabs } from '../../components/ui';

const iso = (d: Date) => d.toISOString().slice(0, 10);
const pct = (n: number | null | undefined) => (n == null ? '—' : `${n}%`);
const mins = (n: number | null | undefined) => (n == null ? '—' : n < 60 ? `${n} min` : `${Math.floor(n / 60)} h ${n % 60} min`);
const short = (n: number | null | undefined) => (n == null ? '—' : Math.abs(n) >= 1e7 ? `₹${(n / 1e7).toFixed(2)} Cr` : Math.abs(n) >= 1e5 ? `₹${(n / 1e5).toFixed(1)} L` : fmtINR(n));

function Bar({ value, max, tone = 'bg-brand-500' }: { value: number; max: number; tone?: string }) {
  return <div className="h-2 w-full rounded bg-slate-100"><div className={clsx('h-2 rounded', tone)} style={{ width: `${max ? Math.max(2, (value / max) * 100) : 0}%` }} /></div>;
}

export function LeadReportsPage() {
  const [tab, setTab] = useState<'team' | 'sources' | 'lost' | 'forecast'>('team');
  const [from, setFrom] = useState(iso(new Date(Date.now() - 89 * 86_400_000)));
  const [to, setTo] = useState(iso(new Date()));
  return (
    <>
      <PageHeader title="Sales reports" description="How each salesperson and each lead source is doing, why leads are lost, and what the open pipeline should bring in."
        breadcrumbs={[{ label: 'Sales & CRM', to: '/crm' }, { label: 'Sales reports' }]}
        actions={tab !== 'forecast' && <div className="flex items-end gap-2"><Input label="From" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /><Input label="To" type="date" value={to} onChange={(e) => setTo(e.target.value)} /></div>} />
      <Tabs className="mb-5" value={tab} onChange={setTab} tabs={[{ value: 'team', label: 'Team leaderboard' }, { value: 'sources', label: 'Sources & ROI' }, { value: 'lost', label: 'Why we lose' }, { value: 'forecast', label: 'Forecast' }]} />
      {tab === 'team' && <Leaderboard from={from} to={to} />}
      {tab === 'sources' && <Sources from={from} to={to} />}
      {tab === 'lost' && <Lost from={from} to={to} />}
      {tab === 'forecast' && <Forecast />}
    </>
  );
}

interface LbRow { user_id: string; name: string; active: boolean; assigned: number; contacted: number; contact_rate: number | null; avg_first_response_min: number | null; never_contacted: number; overdue: number; no_progress: number; calls: number; samples: number; visits: number; quotes_sent: number; quotes_won: number; won_value: number; won: number; lost: number; overrides_in: number; target_revenue: number; target_pct: number | null }

function Leaderboard({ from, to }: { from: string; to: string }) {
  const q = useQuery({ queryKey: ['crm-lb', from, to], queryFn: () => api.get<{ rows: LbRow[] }>(`/crm/leaderboard?from=${from}&to=${to}`) });
  const target = useSettingsTarget();
  if (q.isError) return <ErrorState error={q.error} />;
  if (!q.data) return <Skeleton className="h-72" />;
  return (
    <Card padded={false} title="Team leaderboard" description={`Leads assigned in the period, and what each person did with them. Red marks are against the ${target}-minute response target or the team’s targets.`}>
      <SimpleTable rows={q.data.rows} rowKey={(r) => r.user_id} csvName="sales-leaderboard" columns={[
        { key: 'n', header: 'Salesperson', render: (r) => <span className={clsx('font-medium', !r.active && 'text-slate-400')}>{r.name}{!r.active && ' (inactive)'}</span> },
        { key: 'a', header: 'Assigned', align: 'right', render: (r) => r.assigned },
        { key: 'nc', header: 'Never contacted', align: 'right', render: (r) => <span className={clsx(r.never_contacted && 'font-semibold text-rose-600')}>{r.never_contacted}</span> },
        { key: 'o', header: 'Overdue', align: 'right', render: (r) => <span className={clsx(r.overdue && 'font-semibold text-amber-600')}>{r.overdue}</span> },
        { key: 'np', header: 'No progress', align: 'right', render: (r) => <span className={clsx(r.no_progress && 'font-semibold text-rose-600')}>{r.no_progress}</span> },
        { key: 'cr', header: 'Contact rate', align: 'right', render: (r) => <span className={clsx(r.contact_rate != null && r.contact_rate < 70 ? 'text-rose-600' : 'text-emerald-700')}>{pct(r.contact_rate)}</span> },
        { key: 'fr', header: 'First call, avg', align: 'right', render: (r) => <span className={clsx(r.avg_first_response_min != null && r.avg_first_response_min > target && 'text-rose-600')}>{mins(r.avg_first_response_min)}</span> },
        { key: 'c', header: 'Calls', align: 'right', render: (r) => r.calls },
        { key: 's', header: 'Samples · visits', align: 'right', render: (r) => `${r.samples} · ${r.visits}` },
        { key: 'q', header: 'Quotes sent · won', align: 'right', render: (r) => `${r.quotes_sent} · ${r.quotes_won}` },
        { key: 'w', header: 'Won · lost', align: 'right', render: (r) => `${r.won} · ${r.lost}` },
        { key: 'rv', header: 'Revenue vs target', align: 'right', render: (r) => <span>{short(r.won_value)}{r.target_pct != null && <span className={clsx('block text-[11.5px]', r.target_pct >= 100 ? 'text-emerald-700' : 'text-rose-600')}>{r.target_pct}% of {short(r.target_revenue)}</span>}</span> },
      ]} />
    </Card>
  );
}
function useSettingsTarget() {
  const s = useQuery({ queryKey: ['crm-settings'], queryFn: () => api.get<{ first_response_minutes: number }>('/crm/settings'), staleTime: 60_000 });
  return s.data?.first_response_minutes ?? 15;
}

interface SrcRow { source_id: string; code: string; name: string; kind: string; cost_per_lead: number; monthly_fee: number; leads: number; contacted: number; qualified: number; samples: number; quoted: number; won: number; lost: number; reenquired: number; avg_response_min: number | null; contact_rate: number | null; conversion: number | null; spend: number; cost_per_lead_actual: number | null; cost_per_win: number | null; revenue: number; paying_customers: number; return_multiple: number | null; roi_pct: number | null }

function Sources({ from, to }: { from: string; to: string }) {
  const { can } = useAuth();
  const q = useQuery({ queryKey: ['crm-src-perf', from, to], queryFn: () => api.get<{ attribution_months: number; rows: SrcRow[]; totals: { leads: number; won: number; spend: number; revenue: number; return_multiple: number | null; cost_per_win: number | null } }>(`/crm/source-performance?from=${from}&to=${to}`) });
  const [edit, setEdit] = useState<SrcRow | null>(null);
  if (q.isError) return <ErrorState error={q.error} />;
  if (!q.data) return <Skeleton className="h-72" />;
  const d = q.data;
  const maxLeads = Math.max(1, ...d.rows.map((r) => r.leads));
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <Stat label="Leads" value={d.totals.leads} />
        <Stat label="Won" value={d.totals.won} />
        <Stat label="Spend on sources" value={short(d.totals.spend)} />
        <Stat label="Revenue from those customers" value={short(d.totals.revenue)} tone="success" />
        <Stat label="Return on spend" value={d.totals.return_multiple == null ? '—' : `${d.totals.return_multiple}×`} sub={d.totals.cost_per_win ? `${short(d.totals.cost_per_win)} per win` : undefined} />
      </div>
      <Card padded={false} title="Performance and return by source" description={`Spend = cost per lead × leads + monthly fee × months + spend entered (ads, exhibitions). Revenue = invoiced sales (before GST) to customers whose first lead came from the source, for ${d.attribution_months} months after that lead.`}>
        <SimpleTable rows={d.rows} rowKey={(r) => r.source_id} csvName="lead-source-roi" columns={[
          { key: 'n', header: 'Source', render: (r) => <div><p className="font-medium">{r.name}</p><p className="text-[11.5px] text-slate-500">{r.cost_per_lead ? `${fmtINR(r.cost_per_lead)}/lead` : ''}{r.cost_per_lead && r.monthly_fee ? ' · ' : ''}{r.monthly_fee ? `${fmtINR(r.monthly_fee)}/month` : ''}{!r.cost_per_lead && !r.monthly_fee ? 'No fixed cost set' : ''}</p></div> },
          { key: 'l', header: 'Leads', render: (r) => <div className="w-28"><span className="text-[12.5px]">{r.leads}</span><Bar value={r.leads} max={maxLeads} /></div> },
          { key: 'f', header: 'Contacted · qualified · quoted · won', render: (r) => <span className="text-[12.5px]">{r.contacted} · {r.qualified} · {r.quoted} · <b>{r.won}</b></span> },
          { key: 'cv', header: 'Conversion', align: 'right', render: (r) => pct(r.conversion) },
          { key: 'rt', header: 'First call', align: 'right', render: (r) => mins(r.avg_response_min) },
          { key: 'sp', header: 'Spend', align: 'right', render: (r) => short(r.spend) },
          { key: 'cpl', header: 'Per lead · per win', align: 'right', render: (r) => <span className="text-[12.5px]">{short(r.cost_per_lead_actual)} · {short(r.cost_per_win)}</span> },
          { key: 'rv', header: 'Revenue', align: 'right', render: (r) => <span>{short(r.revenue)}<span className="block text-[11.5px] text-slate-500">{r.paying_customers} customers</span></span> },
          { key: 'roi', header: 'Return', align: 'right', render: (r) => (r.return_multiple == null ? <span className="text-slate-400">no spend</span> : <Badge tone={r.return_multiple >= 10 ? 'success' : r.return_multiple >= 3 ? 'info' : 'danger'}>{r.return_multiple}×</Badge>) },
          { key: 'e', header: '', render: (r) => can('crm.config.manage') ? <Button size="sm" onClick={() => setEdit(r)}>Costs</Button> : null },
        ]} />
      </Card>
      {edit && <CostsModal row={edit} onClose={() => setEdit(null)} onDone={() => { setEdit(null); q.refetch(); }} />}
    </div>
  );
}

function CostsModal({ row, onClose, onDone }: { row: SrcRow; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [c, setC] = useState({ cost_per_lead: String(row.cost_per_lead), monthly_fee: String(row.monthly_fee) });
  const [s, setS] = useState({ month: new Date().toISOString().slice(0, 7), amount: '', note: '' });
  const spend = useQuery({ queryKey: ['crm-src-spend', row.source_id], queryFn: () => api.get<{ id: string; month: string; amount: number; note: string | null; by_name: string }[]>(`/crm/sources/${row.source_id}/spend`) });
  return (
    <Modal open onClose={onClose} size="lg" title={`${row.name}: what it costs`} footer={<Button variant="primary" onClick={onDone}>Done</Button>}>
      <div className="space-y-5">
        <div className="grid grid-cols-3 items-end gap-3">
          <Input label="Cost per lead" prefix="₹" type="number" value={c.cost_per_lead} onChange={(e) => setC({ ...c, cost_per_lead: e.target.value })} hint="e.g. JustDial per enquiry" />
          <Input label="Monthly fee" prefix="₹" type="number" value={c.monthly_fee} onChange={(e) => setC({ ...c, monthly_fee: e.target.value })} hint="e.g. IndiaMART plan ÷ 12" />
          <Button onClick={async () => { try { await api.put(`/crm/sources/${row.source_id}/costs`, { cost_per_lead: Number(c.cost_per_lead), monthly_fee: Number(c.monthly_fee) }); toast({ tone: 'success', title: 'Costs saved' }); qc.invalidateQueries({ queryKey: ['crm-src-perf'] }); } catch (e) { toast({ tone: 'error', title: (e as Error).message }); } }}>Save costs</Button>
        </div>
        <div className="grid grid-cols-4 items-end gap-3 border-t border-slate-100 pt-4">
          <Input label="Month" type="month" value={s.month} onChange={(e) => setS({ ...s, month: e.target.value })} />
          <Input label="Spend" prefix="₹" type="number" value={s.amount} onChange={(e) => setS({ ...s, amount: e.target.value })} />
          <Input label="What for" value={s.note} onChange={(e) => setS({ ...s, note: e.target.value })} placeholder="Meta ads, stall at Knit Show…" />
          <Button disabled={!Number(s.amount)} onClick={async () => { try { await api.post(`/crm/sources/${row.source_id}/spend`, { month: s.month, amount: Number(s.amount), note: s.note || null }); setS({ ...s, amount: '', note: '' }); spend.refetch(); qc.invalidateQueries({ queryKey: ['crm-src-perf'] }); } catch (e) { toast({ tone: 'error', title: (e as Error).message }); } }}>Add spend</Button>
        </div>
        <SimpleTable rows={spend.data ?? []} rowKey={(r) => r.id} csv={false} empty="No spend entered yet" columns={[
          { key: 'm', header: 'Month', render: (r) => new Date(`${r.month}T00:00:00Z`).toLocaleString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' }) },
          { key: 'a', header: 'Amount', align: 'right', render: (r) => fmtINR(r.amount) },
          { key: 'n', header: 'For', render: (r) => r.note ?? '—' },
          { key: 'b', header: 'Entered by', render: (r) => r.by_name },
        ]} />
      </div>
    </Modal>
  );
}

function Lost({ from, to }: { from: string; to: string }) {
  const q = useQuery({ queryKey: ['crm-lost', from, to], queryFn: () => api.get<{ total: number; value: number; by_objection: { objection: string; n: number; value: number; pct: number }[]; by_category: { category: string; objection: string; n: number }[]; by_owner: { owner: string; objection: string; n: number }[]; by_source: { source: string; n: number }[]; competitors: { competitor: string; n: number }[] }>(`/crm/lost-analysis?from=${from}&to=${to}`) });
  if (q.isError) return <ErrorState error={q.error} />;
  if (!q.data) return <Skeleton className="h-72" />;
  const d = q.data;
  const max = Math.max(1, ...d.by_objection.map((x) => x.n));
  const pivot = (rows: { objection: string; n: number }[], key: 'category' | 'owner') => {
    const names = [...new Set(rows.map((r) => (r as unknown as Record<string, string>)[key]))];
    return names.map((n) => ({ name: n, total: rows.filter((r) => (r as unknown as Record<string, string>)[key] === n).reduce((s, r) => s + r.n, 0), top: rows.filter((r) => (r as unknown as Record<string, string>)[key] === n).sort((a, b) => b.n - a.n).slice(0, 3).map((r) => `${r.objection} (${r.n})`).join(', ') }));
  };
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3"><Stat label="Leads lost" value={d.total} /><Stat label="Value lost (estimated)" value={short(d.value)} tone="danger" /><Stat label="Main reason" value={d.by_objection[0]?.objection ?? '—'} sub={d.by_objection[0] ? `${d.by_objection[0].pct}% of lost leads` : undefined} /></div>
      <Card title="Lost leads by objection" description="Revive the leads lost to a reason you have now fixed (Lead tools → Revive lost leads).">
        {d.by_objection.length ? <ul className="space-y-2.5">{d.by_objection.map((o) => (
          <li key={o.objection} className="grid grid-cols-[180px_1fr_120px] items-center gap-3 text-[13px]"><span className="font-medium">{o.objection}</span><Bar value={o.n} max={max} tone="bg-rose-400" /><span className="text-right text-slate-600">{o.n} · {o.pct}% · {short(o.value)}</span></li>
        ))}</ul> : <Notice tone="success">No leads lost in this period.</Notice>}
      </Card>
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
        <Card padded={false} title="By fabric category"><SimpleTable rows={pivot(d.by_category, 'category')} rowKey={(r) => r.name} columns={[{ key: 'n', header: 'Category', render: (r) => r.name }, { key: 't', header: 'Lost', align: 'right', render: (r) => r.total }, { key: 'r', header: 'Top reasons', render: (r) => <span className="text-[12.5px]">{r.top}</span> }]} /></Card>
        <Card padded={false} title="By salesperson"><SimpleTable rows={pivot(d.by_owner, 'owner')} rowKey={(r) => r.name} columns={[{ key: 'n', header: 'Salesperson', render: (r) => r.name }, { key: 't', header: 'Lost', align: 'right', render: (r) => r.total }, { key: 'r', header: 'Top reasons', render: (r) => <span className="text-[12.5px]">{r.top}</span> }]} /></Card>
      </div>
      {d.competitors.length > 0 && <Card padded={false} title="Lost to"><SimpleTable rows={d.competitors} rowKey={(r) => r.competitor} csv={false} columns={[{ key: 'c', header: 'Competitor', render: (r) => r.competitor }, { key: 'n', header: 'Leads', align: 'right', render: (r) => r.n }]} /></Card>}
    </div>
  );
}

interface FcGroup { key: string; open: number; pipeline: number; expected_orders: number; expected_value: number }
function Forecast() {
  const q = useQuery({ queryKey: ['crm-forecast'], queryFn: () => api.get<{ open: number; estimated_values: number; windows: { days: number; expected_orders: number; expected_value: number }[]; by_category: FcGroup[]; by_owner: FcGroup[]; by_stage: FcGroup[] }>('/crm/forecast') });
  if (q.isError) return <ErrorState error={q.error} />;
  if (!q.data) return <Skeleton className="h-72" />;
  const d = q.data;
  const table = (title: string, rows: FcGroup[], label: string, fmt = (k: string) => k) => (
    <Card padded={false} title={title}><SimpleTable rows={rows} rowKey={(r) => r.key} columns={[
      { key: 'k', header: label, render: (r) => fmt(r.key) }, { key: 'o', header: 'Open leads', align: 'right', render: (r) => r.open },
      { key: 'p', header: 'Pipeline', align: 'right', render: (r) => short(r.pipeline) }, { key: 'e', header: 'Expected orders', align: 'right', render: (r) => r.expected_orders }, { key: 'v', header: 'Expected value', align: 'right', render: (r) => <b>{short(r.expected_value)}</b> },
    ]} /></Card>
  );
  return (
    <div className="space-y-6">
      <Notice tone="info" title="An estimate, not a promise">Each open lead counts as its stage’s chance of an order (Lead settings) adjusted by its score, times its value — the value given on the lead, or the category’s average accepted quotation where none was given ({d.estimated_values} of {d.open} leads).</Notice>
      <div className="grid grid-cols-3 gap-3">{d.windows.map((w) => <Stat key={w.days} label={`Next ${w.days} days`} value={short(w.expected_value)} sub={`about ${w.expected_orders} orders`} />)}</div>
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
        {table('By fabric category', d.by_category, 'Category')}
        {table('By salesperson', d.by_owner, 'Salesperson')}
      </div>
      {table('By stage', d.by_stage, 'Stage', humanize)}
      <p className="text-[12px] text-slate-500">As of {fmtDate(new Date().toISOString())}.</p>
    </div>
  );
}
