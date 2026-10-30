import { useQuery, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { CheckCircle2, Circle, CircleDot, Lock, PackageCheck, Plus, Send, ShieldAlert, Trash2, XCircle } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, invalidatePrefix } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { fmtDate, fmtDateTime, fmtINR, fmtNum } from '../../lib/format';
import { DataTable, FilterSelect, SimpleTable } from '../../components/DataTable';
import { useParties, useProducts, useWarehouses } from '../../components/business';
import { ConfirmDialog, Drawer, Modal, useToast } from '../../components/overlay';
import { DocumentsPanel } from '../../components/Documents';
import { AuditTimeline } from '../../components/AuditTrail';
import { Badge, Button, Card, ErrorState, IconButton, Input, KeyValue, Notice, PageHeader, Progress, Select, Skeleton, StatusBadge, Tabs, Textarea } from '../../components/ui';

interface OrderRow { id: string; number: string; mill_name: string; process_name: string; status: string; issue_date: string | null; expected_return_date: string; kg_sent: number; kg_good: number; kg_balance: number; current_stage: string | null }
export interface Stage { code: string; name: string }
export interface StageUpdate { id: number; stage_code: string; stage_name: string; status: string; kg: number | null; note: string | null; source: string; by_name: string; at: string }
export interface JobDetail extends OrderRow {
  mill_id: string; mill_code: string; mill_gstin: string | null; process_code: string; stages: Stage[]; instructions: string | null; internal_due_date: string | null; statutory_due_date: string | null;
  transporter_name: string | null; lr_number: string | null; eway_bill_no: string | null; estimated_charge: number; processing_charge: number; rate_summary: string | null;
  ack_at: string | null; ack_kg: number | null; ack_discrepancy_kg: number | null; ack_remarks: string | null; ack_by_name: string | null; ack_source: string | null; ready_at: string | null; created_by_name: string; close_reason: string | null;
  lines: { id: string; line_no: number; source: string; warehouse_name: string | null; sku: string; product_name: string; lot_ref: string | null; rolls: number | null; kg_sent: number; estimated_charge: number }[];
  stage_updates: StageUpdate[];
  returns: { id: string; return_date: string; warehouse_name: string; mill_challan_no: string | null; kg_good: number; kg_rejected: number; kg_damaged: number; kg_process_loss: number; rolls: number | null; lot_ref: string | null; loss_reason: string | null; charge: number; created_by_name: string }[];
  claims: { id: string; number: string; status: string; kg_affected: number; amount: number; claim_type: string }[];
  exceptions: { id: string; kind: string; severity: string; message: string }[];
  reconciliation: { kg_sent: number; kg_good: number; kg_rejected: number; kg_damaged: number; kg_process_loss: number; kg_balance_at_mill: number; yield_pct: number | null; loss_pct: number | null };
}

export function JobOrdersPage() {
  const { can } = useAuth();
  const nav = useNavigate();
  const mills = useParties('mill');
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [creating, setCreating] = useState(false);
  return (
    <>
      <PageHeader title="Job-work orders" description="Challans to processing mills. Material can come from grey fabric already at the mill (direct-to-mill purchases) or from our warehouses." breadcrumbs={[{ label: 'Mill job work', to: '/jobwork' }, { label: 'Orders' }]}
        actions={can('jobwork.order.manage') && <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>New job-work order</Button>} />
      <DataTable<OrderRow>
        id="job-orders" endpoint="/jobwork/orders" filters={filters} onFiltersChange={setFilters} defaultSort={{ key: 'created_at', dir: 'desc' }} onRowClick={(r) => nav(`/jobwork/orders/${r.id}`)}
        toolbar={<>
          <FilterSelect placeholder="All statuses" value={filters.status} onChange={(v) => setFilters({ ...filters, status: v })} options={[['draft', 'Draft'], ['issued', 'Issued'], ['acknowledged,in_process', 'At mill'], ['ready', 'Ready'], ['partially_returned,returned', 'Returned'], ['closed', 'Closed']].map(([value, label]) => ({ value: value!, label: label! }))} />
          <FilterSelect placeholder="All mills" value={filters.mill} onChange={(v) => setFilters({ ...filters, mill: v })} options={mills.data?.map((m) => ({ value: m.id, label: m.legal_name })) ?? []} />
        </>}
        columns={[
          { key: 'n', header: 'Order', sort: 'number', csv: (r) => r.number, render: (r) => <span className="font-mono text-[12.5px] font-semibold text-slate-900">{r.number}</span> },
          { key: 'm', header: 'Mill', sort: 'mill_name', csv: (r) => r.mill_name, render: (r) => <div><p className="text-slate-900">{r.mill_name}</p><p className="text-[12px] text-slate-500">{r.process_name}</p></div> },
          { key: 'stage', header: 'Stage', csv: (r) => r.current_stage, render: (r) => r.current_stage ?? '—' },
          { key: 'kg', header: 'Sent / good', csv: (r) => r.kg_sent, render: (r) => <Progress value={r.kg_good} max={r.kg_sent} tone="success" label={`${fmtNum(r.kg_sent)} kg sent · ${fmtNum(r.kg_good)} good`} /> },
          { key: 'bal', header: 'At mill', align: 'right', csv: (r) => r.kg_balance, render: (r) => fmtNum(r.kg_balance, 'kg') },
          { key: 'issue', header: 'Issued', sort: 'issue_date', csv: (r) => r.issue_date, render: (r) => fmtDate(r.issue_date) },
          { key: 'due', header: 'Expected back', sort: 'expected_return_date', csv: (r) => r.expected_return_date, render: (r) => fmtDate(r.expected_return_date) },
          { key: 's', header: 'Status', sort: 'status', csv: (r) => r.status, render: (r) => <StatusBadge status={r.status} /> },
        ]}
        empty={{ title: 'No job-work orders yet' }}
      />
      {creating && <JobOrderForm onClose={() => setCreating(false)} onCreated={(id) => nav(`/jobwork/orders/${id}`)} />}
    </>
  );
}

interface FormLine { source: 'mill_stock' | 'warehouse'; mill_stock_id: string; warehouse_id: string; product_id: string; kg_sent: string; rolls: string; lot_ref: string }

function JobOrderForm({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const qc = useQueryClient();
  const mills = useParties('mill');
  const wh = useWarehouses();
  const products = useProducts();
  const templates = useQuery({ queryKey: ['process-templates'], queryFn: () => api.get<{ code: string; name: string; status: string; stages: Stage[] }[]>('/jobwork/process-templates') });
  const [mill, setMill] = useState('');
  const [proc, setProc] = useState('');
  const [expected, setExpected] = useState('');
  const [instructions, setInstructions] = useState('');
  const [transport, setTransport] = useState({ transporter_name: '', lr_number: '', vehicle_no: '', eway_bill_no: '' });
  const [lines, setLines] = useState<FormLine[]>([]);
  const [error, setError] = useState<string | null>(null);
  const stock = useQuery({ queryKey: ['mill-stock', mill], queryFn: () => api.get<{ id: string; sku: string; product_name: string; kg_available: number; po_number: string; supplier_name: string; source_ref: string }[]>(`/jobwork/mill-stock?millId=${mill}`), enabled: !!mill });
  const add = (source: FormLine['source']) => setLines([...lines, { source, mill_stock_id: '', warehouse_id: '', product_id: '', kg_sent: '', rolls: '', lot_ref: '' }]);
  const set = (i: number, patch: Partial<FormLine>) => setLines(lines.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  async function save() {
    try {
      const r = await api.post<{ id: string }>('/jobwork/orders', {
        mill_id: mill, process_code: proc, expected_return_date: expected, instructions, ...transport,
        lines: lines.map((l) => (l.source === 'mill_stock' ? { source: 'mill_stock', mill_stock_id: l.mill_stock_id, kg_sent: Number(l.kg_sent), rolls: l.rolls ? Number(l.rolls) : null, lot_ref: l.lot_ref } : { source: 'warehouse', warehouse_id: l.warehouse_id, product_id: l.product_id, kg_sent: Number(l.kg_sent), rolls: l.rolls ? Number(l.rolls) : null, lot_ref: l.lot_ref })),
      });
      invalidatePrefix(qc, '/jobwork/orders');
      onCreated(r.id);
    } catch (e) { setError((e as Error).message); }
  }
  const tpl = templates.data?.find((t) => t.code === proc);
  return (
    <Drawer open onClose={onClose} width="xl" title="New job-work order" description="Saved as a draft. Issuing the challan starts the three clocks." footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={save}>Save draft</Button></>}>
      <div className="space-y-5">
        {error && <Notice tone="danger">{error}</Notice>}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Select label="Mill" required placeholder="Select mill" value={mill} onChange={(e) => { setMill(e.target.value); setLines([]); }} options={mills.data?.map((m) => ({ value: m.id, label: `${m.legal_name} (${m.code})` })) ?? []} />
          <Select label="Process" required placeholder="Select process" value={proc} onChange={(e) => setProc(e.target.value)} options={templates.data?.filter((t) => t.status === 'active').map((t) => ({ value: t.code, label: t.name })) ?? []} />
          <Input label="Expected return" type="date" required value={expected} onChange={(e) => setExpected(e.target.value)} />
        </div>
        {tpl && <p className="text-[12px] text-slate-500">Stages: {tpl.stages.map((s) => s.name).join(' → ')}</p>}
        <div>
          <div className="mb-2 flex items-center gap-2"><p className="label mb-0 flex-1">Material</p><Button size="xs" disabled={!mill} icon={<Plus className="size-3" />} onClick={() => add('mill_stock')}>Grey already at mill</Button><Button size="xs" icon={<Plus className="size-3" />} onClick={() => add('warehouse')}>From warehouse</Button></div>
          {mill && stock.data?.length === 0 && lines.length === 0 && <p className="mb-2 text-[12px] text-slate-500">No unallocated grey stock at this mill.</p>}
          <div className="space-y-2">
            {lines.map((l, i) => (
              <div key={i} className="grid grid-cols-12 items-end gap-2 rounded-lg border border-slate-200 p-3">
                {l.source === 'mill_stock' ? (
                  <Select className="col-span-6" label="Grey stock at mill" value={l.mill_stock_id} onChange={(e) => { const s = stock.data?.find((x) => x.id === e.target.value); set(i, { mill_stock_id: e.target.value, kg_sent: s ? String(s.kg_available) : '' }); }} placeholder="Select…"
                    options={stock.data?.map((s) => ({ value: s.id, label: `${s.sku} · ${fmtNum(s.kg_available)} kg · ${s.source_ref} from ${s.supplier_name}` })) ?? []} />
                ) : (<>
                  <Select className="col-span-3" label="Warehouse" placeholder="Select…" value={l.warehouse_id} onChange={(e) => set(i, { warehouse_id: e.target.value })} options={wh.data?.map((w) => ({ value: w.id, label: w.code })) ?? []} />
                  <Select className="col-span-3" label="Fabric" placeholder="Select…" value={l.product_id} onChange={(e) => set(i, { product_id: e.target.value })} options={products.data?.map((p) => ({ value: p.id, label: p.sku })) ?? []} />
                </>)}
                <Input className="col-span-2" label="KG" type="number" value={l.kg_sent} onChange={(e) => set(i, { kg_sent: e.target.value })} />
                <Input className="col-span-1" label="Rolls" type="number" value={l.rolls} onChange={(e) => set(i, { rolls: e.target.value })} />
                <Input className="col-span-2" label="Lot ref" value={l.lot_ref} onChange={(e) => set(i, { lot_ref: e.target.value })} />
                <div className="col-span-1 pb-0.5"><IconButton label="Remove" onClick={() => setLines(lines.filter((_, j) => j !== i))}><Trash2 className="size-4" /></IconButton></div>
              </div>
            ))}
          </div>
        </div>
        <Textarea label="Processing instructions" value={instructions} onChange={(e) => setInstructions(e.target.value)} placeholder="Shade, finish, GSM / width targets…" />
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {(['transporter_name', 'lr_number', 'vehicle_no', 'eway_bill_no'] as const).map((k) => <Input key={k} label={{ transporter_name: 'Transporter', lr_number: 'LR no.', vehicle_no: 'Vehicle', eway_bill_no: 'e-Way bill' }[k]} value={transport[k]} onChange={(e) => setTransport({ ...transport, [k]: e.target.value })} />)}
        </div>
      </div>
    </Drawer>
  );
}

/** Stage tracker built from the process template and stage updates. */
export function StageTrack({ stages, updates, current }: { stages: Stage[]; updates: StageUpdate[]; current: string | null }) {
  const statusOf = (code: string) => {
    const u = updates.filter((x) => x.stage_code === code);
    if (!u.length) return 'pending';
    const last = u[u.length - 1]!;
    return last.status === 'qc_failed' ? 'failed' : ['completed', 'qc_passed'].includes(last.status) ? 'done' : 'active';
  };
  return (
    <ol className="flex flex-wrap gap-y-3">
      {stages.map((s, i) => {
        const st = statusOf(s.code);
        return (
          <li key={s.code} className="flex items-center">
            <div className="flex flex-col items-center gap-1 px-1 text-center" style={{ width: 92 }}>
              {st === 'done' ? <CheckCircle2 className="size-5 text-emerald-500" /> : st === 'failed' ? <XCircle className="size-5 text-rose-500" /> : st === 'active' || current === s.name ? <CircleDot className="size-5 text-brand-600" /> : <Circle className="size-5 text-slate-300" />}
              <span className={clsx('text-[11.5px] leading-tight', st === 'pending' ? 'text-slate-400' : 'font-medium text-slate-800')}>{s.name}</span>
            </div>
            {i < stages.length - 1 && <span className={clsx('h-px w-4', st === 'done' ? 'bg-emerald-300' : 'bg-slate-200')} />}
          </li>
        );
      })}
    </ol>
  );
}

export function Reconciliation({ r }: { r: JobDetail['reconciliation'] }) {
  const cells = [['Sent', r.kg_sent, ''], ['Good', r.kg_good, 'text-emerald-700'], ['Rejected', r.kg_rejected, 'text-rose-600'], ['Damaged', r.kg_damaged, 'text-rose-600'], ['Process loss', r.kg_process_loss, 'text-amber-700'], ['Balance at mill', r.kg_balance_at_mill, 'font-semibold']] as const;
  return (
    <div>
      <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">{cells.map(([l, v, c]) => <div key={l} className="rounded-lg border border-slate-200 px-3 py-2"><p className="text-[11px] text-slate-500">{l}</p><p className={clsx('text-[15px] tabular', c)}>{fmtNum(v)} kg</p></div>)}</div>
      <p className="mt-2 text-[12.5px] text-slate-600">Yield {r.yield_pct != null ? <span className="font-semibold">{r.yield_pct}%</span> : '—'} of returned quantity · loss {r.loss_pct != null ? `${r.loss_pct}%` : '—'}</p>
    </div>
  );
}

export function JobOrderDetailPage() {
  const { id = '' } = useParams();
  const { can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['job', id], queryFn: () => api.get<JobDetail>(`/jobwork/orders/${id}`) });
  const [tab, setTab] = useState<'progress' | 'returns' | 'documents' | 'history'>('progress');
  const [modal, setModal] = useState<'ack' | 'stage' | 'return' | 'claim' | 'close' | 'cancel' | null>(null);
  const refresh = () => { q.refetch(); invalidatePrefix(qc, '/jobwork'); qc.invalidateQueries({ queryKey: ['jw-deadlines'] }); };
  const act = async (path: string, body: object = {}, msg = 'Saved') => {
    try { await api.post(`/jobwork/orders/${id}/${path}`, body); refresh(); setModal(null); toast({ tone: 'success', title: msg }); } catch (e) { toast({ tone: 'error', title: (e as Error).message }); }
  };
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  if (!q.data) return <Skeleton className="h-96" />;
  const o = q.data;
  const manage = can('jobwork.order.manage');
  const atMill = ['acknowledged', 'in_process'].includes(o.status);
  return (
    <>
      <PageHeader breadcrumbs={[{ label: 'Mill job work', to: '/jobwork' }, { label: 'Orders', to: '/jobwork/orders' }, { label: o.number }]}
        title={<>{o.number} <StatusBadge status={o.status} /></>}
        meta={<><span>{o.mill_name} <span className="font-mono text-slate-400">{o.mill_gstin}</span></span><span>{o.process_name}</span>{o.rate_summary && <span>Rate {o.rate_summary}</span>}</>}
        actions={<>
          {o.status === 'draft' && manage && <Button variant="primary" icon={<Send className="size-4" />} onClick={() => act('issue', {}, 'Challan issued — clocks started')}>Issue challan</Button>}
          {o.status === 'issued' && manage && <Button onClick={() => setModal('ack')}>Record mill receipt</Button>}
          {atMill && manage && <><Button onClick={() => setModal('stage')}>Update stage</Button><Button onClick={() => act('ready', {}, 'Marked ready for collection')}>Mark ready</Button></>}
          {['acknowledged', 'in_process', 'ready', 'partially_returned'].includes(o.status) && can('jobwork.return.record') && <Button variant="primary" icon={<PackageCheck className="size-4" />} onClick={() => setModal('return')}>Record return</Button>}
          {!['draft', 'cancelled'].includes(o.status) && can('jobwork.claim.manage') && <Button icon={<ShieldAlert className="size-4" />} onClick={() => setModal('claim')}>Raise claim</Button>}
          {['returned', 'partially_returned'].includes(o.status) && manage && <Button icon={<Lock className="size-4" />} onClick={() => setModal('close')}>Close</Button>}
          {['draft', 'issued'].includes(o.status) && manage && <Button variant="ghost" onClick={() => setModal('cancel')}>Cancel</Button>}
        </>} />
      {o.exceptions.map((e) => <div key={e.id} className="mb-3"><Notice tone={e.severity === 'critical' ? 'danger' : 'warning'}>{e.message}</Notice></div>)}
      <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
        {[['Commercial return', o.expected_return_date, 'Agreed with the mill'], ['Operational due', o.internal_due_date, 'Internal follow-up date'], ['Statutory deadline', o.statutory_due_date, 'Job-work return limit (CA to confirm)']].map(([l, d, s]) => (
          <div key={l} className="card p-4"><p className="text-[12px] text-slate-500">{l}</p><p className="text-[16px] font-semibold">{fmtDate(d)}</p><p className="text-[12px] text-slate-500">{s}</p></div>
        ))}
        <div className="card p-4"><p className="text-[12px] text-slate-500">Processing charge</p><p className="text-[16px] font-semibold tabular">{fmtINR(o.processing_charge || o.estimated_charge)}</p><p className="text-[12px] text-slate-500">{o.processing_charge ? 'On returned fabric' : 'Estimated from rate card'}</p></div>
      </div>
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
        <div className="xl:col-span-2">
          <Tabs className="mb-4" value={tab} onChange={setTab} tabs={[{ value: 'progress', label: 'Progress' }, { value: 'returns', label: 'Returns & yield', count: o.returns.length }, { value: 'documents', label: 'Documents' }, { value: 'history', label: 'Audit history' }]} />
          {tab === 'progress' && (
            <div className="space-y-6">
              <Card title="Process stages" description="Updated by the mill on its portal, or by mill operations"><StageTrack stages={o.stages} updates={o.stage_updates} current={o.current_stage} /></Card>
              <Card title="Material sent" padded={false}>
                <SimpleTable rows={o.lines} rowKey={(l) => l.id} columns={[
                  { key: 'sku', header: 'Fabric', render: (l) => <div><p className="font-mono text-[12.5px] font-semibold">{l.sku}</p><p className="text-[12px] text-slate-500">{l.product_name}</p></div> },
                  { key: 'src', header: 'Source', render: (l) => (l.source === 'mill_stock' ? <Badge tone="violet">Grey at mill</Badge> : <span className="text-[12.5px]">{l.warehouse_name}</span>) },
                  { key: 'lot', header: 'Lot', render: (l) => l.lot_ref ?? '—' },
                  { key: 'rolls', header: 'Rolls', align: 'right', render: (l) => l.rolls ?? '—' },
                  { key: 'kg', header: 'KG', align: 'right', render: (l) => fmtNum(l.kg_sent) },
                  { key: 'est', header: 'Est. charge', align: 'right', render: (l) => fmtINR(l.estimated_charge) },
                ]} />
              </Card>
              <Card title="Reconciliation"><Reconciliation r={o.reconciliation} /></Card>
            </div>
          )}
          {tab === 'returns' && (
            <Card padded={false}>
              <SimpleTable rows={o.returns} rowKey={(r) => r.id} columns={[
                { key: 'd', header: 'Date', render: (r) => fmtDate(r.return_date) },
                { key: 'w', header: 'Into', render: (r) => r.warehouse_name },
                { key: 'g', header: 'Good', align: 'right', render: (r) => <span className="text-emerald-700">{fmtNum(r.kg_good)}</span> },
                { key: 'rj', header: 'Rejected / damaged', align: 'right', render: (r) => `${fmtNum(r.kg_rejected)} / ${fmtNum(r.kg_damaged)}` },
                { key: 'l', header: 'Loss', align: 'right', render: (r) => fmtNum(r.kg_process_loss) },
                { key: 'lot', header: 'New lot', render: (r) => r.lot_ref ?? '—' },
                { key: 'c', header: 'Charge', align: 'right', render: (r) => fmtINR(r.charge) },
                { key: 'why', header: 'Reason', render: (r) => <span className="text-[12px]">{r.loss_reason ?? ''}</span> },
              ]} empty={<p className="px-5 py-6 text-center text-[13px] text-slate-500">Nothing returned yet.</p>} />
            </Card>
          )}
          {tab === 'documents' && <Card><DocumentsPanel entityType="job_work_order" entityId={o.id} /></Card>}
          {tab === 'history' && <Card><AuditTimeline entityId={o.id} /></Card>}
        </div>
        <div className="space-y-6">
          <Card title="Mill acknowledgement">
            {o.ack_at ? (
              <div className="text-[13px]">
                <p className="font-medium">{fmtNum(o.ack_kg, 'kg')} received {o.ack_source === 'mill_portal' && <Badge tone="info">Mill portal</Badge>}</p>
                <p className="text-slate-500">{o.ack_by_name} · {fmtDateTime(o.ack_at)}</p>
                {!!o.ack_discrepancy_kg && <p className="mt-2 text-rose-600">Difference {fmtNum(o.ack_discrepancy_kg)} kg — {o.ack_remarks}</p>}
              </div>
            ) : <p className="text-[13px] text-slate-500">{o.status === 'draft' ? 'Challan not issued yet.' : 'Waiting for the mill to confirm receipt.'}</p>}
          </Card>
          <Card title="Activity">
            <ul className="space-y-3">
              {[...o.stage_updates].reverse().map((u) => (
                <li key={u.id} className="text-[12.5px]">
                  <p className="font-medium text-slate-900">{u.stage_name} <span className={clsx('font-normal', u.status === 'qc_failed' ? 'text-rose-600' : 'text-slate-500')}>· {u.status.replace('_', ' ')}</span></p>
                  {u.note && <p className="text-slate-600">{u.note}</p>}
                  <p className="text-slate-400">{u.by_name}{u.source === 'mill_portal' ? ' (mill)' : ''} · {fmtDateTime(u.at)}</p>
                </li>
              ))}
            </ul>
          </Card>
          {o.claims.length > 0 && <Card title="Quality claims" padded={false}><ul className="divide-y divide-slate-100">{o.claims.map((c) => <li key={c.id}><Link to={`/jobwork/claims?open=${c.id}`} className="flex items-center gap-2 px-5 py-3 text-[13px] hover:bg-slate-50"><span className="flex-1 font-mono">{c.number}</span><StatusBadge status={c.status} /><span className="tabular">{fmtINR(c.amount)}</span></Link></li>)}</ul></Card>}
          <Card title="Details"><KeyValue columns={1} items={[{ label: 'Instructions', value: o.instructions }, { label: 'Transport', value: [o.transporter_name, o.lr_number && `LR ${o.lr_number}`, o.eway_bill_no && `e-way ${o.eway_bill_no}`].filter(Boolean).join(' · ') || null }, { label: 'Created by', value: o.created_by_name }, { label: 'Closed', value: o.close_reason }]} /></Card>
        </div>
      </div>
      {modal === 'ack' && <AckModal kgSent={o.kg_sent} onClose={() => setModal(null)} onSubmit={(b) => act('acknowledge', b, 'Receipt recorded')} />}
      {modal === 'stage' && <StageModal stages={o.stages} onClose={() => setModal(null)} onSubmit={(b) => act('stages', b, 'Stage updated')} />}
      {modal === 'return' && <ReturnModal order={o} onClose={() => setModal(null)} onSubmit={(b) => act('returns', b, 'Return recorded')} />}
      {modal === 'claim' && <ClaimModal orderId={o.id} onClose={() => setModal(null)} onDone={() => { setModal(null); refresh(); }} />}
      <ConfirmDialog open={modal === 'close'} onClose={() => setModal(null)} requireReason={o.reconciliation.kg_balance_at_mill > 0.001} title="Close this order?" description={o.reconciliation.kg_balance_at_mill > 0.001 ? `${o.reconciliation.kg_balance_at_mill} kg is unaccounted for.` : 'All fabric is accounted for.'} confirmLabel="Close order" onConfirm={(r) => act('close', { reason: r || null }, 'Order closed')} />
      <ConfirmDialog open={modal === 'cancel'} onClose={() => setModal(null)} requireReason tone="danger" title="Cancel this order?" description="Reserved grey stock is released." confirmLabel="Cancel order" onConfirm={(r) => act('cancel', { reason: r }, 'Order cancelled')} />
    </>
  );
}

export function AckModal({ kgSent, onClose, onSubmit }: { kgSent: number; onClose: () => void; onSubmit: (b: object) => void }) {
  const [kg, setKg] = useState(String(kgSent));
  const [remarks, setRemarks] = useState('');
  const diff = kgSent - Number(kg || 0);
  return (
    <Modal open onClose={onClose} title="Confirm material received at mill" description={`Challan quantity ${fmtNum(kgSent)} kg. Weigh and record what actually arrived.`}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={Math.abs(diff) > 0.001 && !remarks.trim()} onClick={() => onSubmit({ kg_received: Number(kg), remarks: remarks || null })}>Confirm receipt</Button></>}>
      <div className="space-y-3">
        <Input label="KG received" type="number" value={kg} onChange={(e) => setKg(e.target.value)} hint={Math.abs(diff) > 0.001 ? `${diff > 0 ? 'Short' : 'Excess'} by ${fmtNum(Math.abs(diff))} kg` : 'Matches the challan'} />
        {Math.abs(diff) > 0.001 && <Textarea label="Explain the difference" required value={remarks} onChange={(e) => setRemarks(e.target.value)} />}
      </div>
    </Modal>
  );
}

export function StageModal({ stages, onClose, onSubmit }: { stages: Stage[]; onClose: () => void; onSubmit: (b: object) => void }) {
  const [v, setV] = useState({ stage_code: stages[0]?.code ?? '', status: 'completed', kg: '', note: '' });
  return (
    <Modal open onClose={onClose} title="Update process stage" footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={v.status === 'qc_failed' && !v.note.trim()} onClick={() => onSubmit({ ...v, kg: v.kg ? Number(v.kg) : null, note: v.note || null })}>Save</Button></>}>
      <div className="grid grid-cols-2 gap-3">
        <Select label="Stage" value={v.stage_code} onChange={(e) => setV({ ...v, stage_code: e.target.value })} options={stages.map((s) => ({ value: s.code, label: s.name }))} />
        <Select label="Status" value={v.status} onChange={(e) => setV({ ...v, status: e.target.value })} options={[{ value: 'started', label: 'Started' }, { value: 'completed', label: 'Completed' }, { value: 'qc_passed', label: 'QC passed' }, { value: 'qc_failed', label: 'QC failed' }, { value: 'on_hold', label: 'On hold' }]} />
        <Input label="KG (optional)" type="number" value={v.kg} onChange={(e) => setV({ ...v, kg: e.target.value })} />
        <Textarea className="col-span-2" label="Note" required={v.status === 'qc_failed'} value={v.note} onChange={(e) => setV({ ...v, note: e.target.value })} />
      </div>
    </Modal>
  );
}

function ReturnModal({ order, onClose, onSubmit }: { order: JobDetail; onClose: () => void; onSubmit: (b: object) => void }) {
  const wh = useWarehouses();
  const bal = order.reconciliation.kg_balance_at_mill;
  const [v, setV] = useState({ return_date: new Date().toISOString().slice(0, 10), warehouse_id: '', mill_challan_no: '', lr_number: '', kg_good: '', kg_rejected: '', kg_damaged: '', kg_process_loss: '', rolls: '', lot_ref: '', loss_reason: '' });
  const n = (k: 'kg_good' | 'kg_rejected' | 'kg_damaged' | 'kg_process_loss') => Number(v[k] || 0);
  const total = n('kg_good') + n('kg_rejected') + n('kg_damaged') + n('kg_process_loss');
  const yieldPct = total ? (n('kg_good') / total) * 100 : null;
  const f = (k: keyof typeof v, label: string, type = 'number') => <Input label={label} type={type} value={v[k]} onChange={(e) => setV({ ...v, [k]: e.target.value })} />;
  return (
    <Modal open onClose={onClose} size="lg" title="Return inward & yield" description={`${fmtNum(bal)} kg still at the mill. Account for every kilogram: good, rejected, damaged or process loss.`}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={() => onSubmit({ ...v, kg_good: n('kg_good'), kg_rejected: n('kg_rejected'), kg_damaged: n('kg_damaged'), kg_process_loss: n('kg_process_loss'), rolls: v.rolls ? Number(v.rolls) : null })}>Record return</Button></>}>
      <div className="space-y-4">
        <div className="grid grid-cols-3 gap-3">
          {f('return_date', 'Return date', 'date')}
          <Select label="Into warehouse" required placeholder="Select…" value={v.warehouse_id} onChange={(e) => setV({ ...v, warehouse_id: e.target.value })} options={wh.data?.map((w) => ({ value: w.id, label: `${w.code} · ${w.name}` })) ?? []} />
          {f('mill_challan_no', 'Mill return challan', 'text')}
          {f('kg_good', 'Good KG')}{f('kg_rejected', 'Rejected KG')}{f('kg_damaged', 'Damaged KG')}{f('kg_process_loss', 'Process loss KG')}{f('rolls', 'Rolls')}{f('lot_ref', 'New lot ref', 'text')}
        </div>
        <div className={clsx('rounded-lg px-4 py-3 text-[13px]', total > bal + 0.001 ? 'bg-rose-50 text-rose-800' : 'bg-slate-50 text-slate-700')}>
          Accounting for {fmtNum(total)} of {fmtNum(bal)} kg{yieldPct != null && <> · yield <span className="font-semibold">{yieldPct.toFixed(1)}%</span></>}
        </div>
        {n('kg_rejected') + n('kg_damaged') + n('kg_process_loss') > 0 && <Textarea label="Reason for rejection, damage or loss" required value={v.loss_reason} onChange={(e) => setV({ ...v, loss_reason: e.target.value })} />}
      </div>
    </Modal>
  );
}

export function ClaimModal({ orderId, onClose, onDone }: { orderId: string; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const types = useQuery({ queryKey: ['defect-types'], queryFn: () => api.get<string[]>('/jobwork/claims/defect-types') });
  const [v, setV] = useState({ defect_types: [] as string[], description: '', kg_affected: '', samples: '', claim_type: 'debit_note', amount: '' });
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal open onClose={onClose} size="lg" title="Raise quality claim" description="The mill is notified on its portal. Attach photos in the order’s Documents tab."
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={async () => {
        try { await api.post('/jobwork/claims', { job_order_id: orderId, ...v, kg_affected: Number(v.kg_affected), amount: Number(v.amount || 0) }); toast({ tone: 'success', title: 'Claim raised' }); onDone(); } catch (e) { setError((e as Error).message); }
      }}>Raise claim</Button></>}>
      <div className="space-y-4">
        {error && <Notice tone="danger">{error}</Notice>}
        <div className="flex flex-wrap gap-1.5">{types.data?.map((t) => { const on = v.defect_types.includes(t); return <button key={t} type="button" onClick={() => setV({ ...v, defect_types: on ? v.defect_types.filter((x) => x !== t) : [...v.defect_types, t] })} className={clsx('rounded-full border px-2.5 py-1 text-[12px]', on ? 'border-rose-400 bg-rose-50 text-rose-700' : 'border-slate-300 text-slate-600')}>{t}</button>; })}</div>
        <Textarea label="What was found" required value={v.description} onChange={(e) => setV({ ...v, description: e.target.value })} />
        <div className="grid grid-cols-3 gap-3">
          <Input label="KG affected" type="number" required value={v.kg_affected} onChange={(e) => setV({ ...v, kg_affected: e.target.value })} />
          <Select label="Claim" value={v.claim_type} onChange={(e) => setV({ ...v, claim_type: e.target.value })} options={[{ value: 'debit_note', label: 'Debit note' }, { value: 'rework', label: 'Rework' }, { value: 'replacement', label: 'Replacement' }, { value: 'none', label: 'Record only' }]} />
          <Input label="Amount" type="number" prefix="₹" value={v.amount} onChange={(e) => setV({ ...v, amount: e.target.value })} />
        </div>
        <Input label="Samples / evidence kept" value={v.samples} onChange={(e) => setV({ ...v, samples: e.target.value })} />
      </div>
    </Modal>
  );
}
