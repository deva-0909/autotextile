import { useQuery, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { AlertTriangle, ArrowRight, CheckCircle2, Circle, FileText, GitFork, Package, PackageCheck, Scale, ShieldCheck, Truck, XCircle } from 'lucide-react';
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Link } from '../../components/AppLink';
import { api, invalidatePrefix } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { GST_STATES, fmtDate, fmtDateTime, fmtINR, fmtNum, fmtRelative, humanize } from '../../lib/format';
import { SimpleTable } from '../../components/DataTable';
import { ConfirmDialog, Modal, useToast } from '../../components/overlay';
import { Bar, ScanInput } from '../../components/scan';
import { useParties } from '../../components/business';
import { Badge, Button, Card, EmptyState, ErrorState, Input, KeyValue, Notice, PageHeader, Segmented, Select, Skeleton, Stat, StatusBadge, Textarea } from '../../components/ui';

interface Gates { picked: boolean; packed: boolean; invoiced: boolean; payment: string; paid: boolean; override: string }
interface FRow { id: string; number: string; order_id: string; order_no: string; customer_name: string; warehouse_code: string; status: string; booked: boolean; payment_terms: string; kg_planned: number; picked_kg: number; skus: string; invoice_no: string | null; invoice_total: number; amount_settled: number; shipment_no: string | null; shipment_status: string | null; lr_number: string | null; gates: Gates; created_at: string }
interface Dash { needs_decision: number; split_pending: number; awaiting_booking: number; to_pick: number; to_pack: number; to_invoice: number; awaiting_payment: number; ready_to_dispatch: number; in_transit: number; late: number; open_claims: number; open_returns: number; open_exceptions: number; by_warehouse: { code: string; n: number; kg: number }[] }

function Gate({ ok, label, warn }: { ok: boolean; label: string; warn?: boolean }) {
  return <span className={clsx('inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11.5px]', ok ? 'bg-emerald-50 text-emerald-700' : warn ? 'bg-amber-50 text-amber-800' : 'bg-slate-100 text-slate-500')}>{ok ? <CheckCircle2 className="size-3" /> : <Circle className="size-3" />}{label}</span>;
}
const payLabel = (g: Gates) => (g.payment === 'credit' ? 'Credit' : g.payment === 'override' ? 'Override' : g.payment === 'paid' ? 'Paid' : 'Payment');

/** Dispatch readiness cockpit: every open fulfilment and which gate it is waiting on. */
export function DispatchCockpit() {
  const nav = useNavigate();
  const [view, setView] = useState<'open' | 'shipped'>('open');
  const d = useQuery({ queryKey: ['ful-dash'], queryFn: () => api.get<Dash>('/fulfilment/dashboard') });
  const q = useQuery({ queryKey: ['ful-list', view], queryFn: () => api.get<FRow[]>(`/fulfilment/fulfilments?status=${view === 'open' ? 'reserved,released,picking,picked,packed,invoiced' : 'dispatched,delivered'}`) });
  const v = d.data;
  return (
    <>
      <PageHeader title="Dispatch readiness" description="Each order ships from one warehouse per fulfilment. Dispatch is held until the rolls are picked and packed, the GST invoice exists and payment is verified (or credit approved) — unless a checker approves an override."
        breadcrumbs={[{ label: 'Fulfilment' }]} actions={<Link to="/fulfilment/allocation"><Button icon={<GitFork className="size-4" />}>Allocation decisions{v?.needs_decision ? ` (${v.needs_decision})` : ''}</Button></Link>} />
      <div className="mb-6 grid grid-cols-2 gap-4 md:grid-cols-4 xl:grid-cols-7">
        <Stat label="Need a warehouse decision" value={v?.needs_decision ?? '—'} tone={v?.needs_decision ? 'warning' : undefined} sub={v?.split_pending ? `${v.split_pending} split awaiting approval` : undefined} />
        <Stat label="Waiting for token" value={v?.awaiting_booking ?? '—'} />
        <Stat label="To pick" value={v?.to_pick ?? '—'} />
        <Stat label="To pack / invoice" value={v ? v.to_pack + v.to_invoice : '—'} />
        <Stat label="Awaiting payment" value={v?.awaiting_payment ?? '—'} tone={v?.awaiting_payment ? 'warning' : undefined} />
        <Stat label="Ready to dispatch" value={v?.ready_to_dispatch ?? '—'} tone={v?.ready_to_dispatch ? 'success' : undefined} />
        <Stat label="In transit" value={v?.in_transit ?? '—'} sub={v?.late ? `${v.late} past ETA` : undefined} tone={v?.late ? 'danger' : undefined} />
      </div>
      <div className="mb-4"><Segmented value={view} onChange={setView} options={[{ value: 'open', label: 'Open' }, { value: 'shipped', label: 'Dispatched' }]} /></div>
      <Card padded={false}>
        {!q.data ? <Skeleton className="m-5 h-40" /> : (
          <SimpleTable rows={q.data} rowKey={(r) => r.id} onRowClick={(r) => nav(`/fulfilment/${r.id}`)} empty={<EmptyState icon={<Truck className="size-5" />} title="Nothing here" />} columns={[
            { key: 'n', header: 'Fulfilment', render: (r) => <div><p className="font-mono text-[12.5px] font-semibold">{r.number}</p><p className="text-[12px] text-slate-500">{r.order_no} · {fmtRelative(r.created_at)}</p></div> },
            { key: 'c', header: 'Customer', render: (r) => <span>{r.customer_name}<span className="block text-[12px] text-slate-500">{r.payment_terms === 'credit' ? 'Credit' : 'Advance'}</span></span> },
            { key: 'w', header: 'From', render: (r) => <Badge>{r.warehouse_code}</Badge> },
            { key: 's', header: 'Fabric', render: (r) => <span className="font-mono text-[12px]">{r.skus}</span> },
            { key: 'k', header: 'Picked / planned', render: (r) => <div className="w-32"><div className="mb-1 text-[12px] tabular">{fmtNum(Number(r.picked_kg))} / {fmtNum(Number(r.kg_planned))} kg</div><Bar value={Number(r.picked_kg)} max={Number(r.kg_planned)} tone={Number(r.picked_kg) >= Number(r.kg_planned) - 0.5 ? 'success' : 'brand'} /></div> },
            { key: 'g', header: 'Gates', render: (r) => r.status === 'reserved' ? <Badge tone="warning">Waiting for token</Badge> : ['dispatched', 'delivered'].includes(r.status) ? <span className="text-[12.5px]">{r.shipment_no}{r.lr_number ? ` · LR ${r.lr_number}` : ''}</span> : <div className="flex flex-wrap gap-1"><Gate ok={r.gates.picked} label="Picked" /><Gate ok={r.gates.packed} label="Packed" /><Gate ok={r.gates.invoiced} label="Invoice" /><Gate ok={r.gates.paid} label={payLabel(r.gates)} warn={r.gates.invoiced && !r.gates.paid} /></div> },
            { key: 'st', header: 'Status', render: (r) => <StatusBadge status={r.shipment_status ?? r.status} /> },
          ]} />
        )}
      </Card>
    </>
  );
}

interface PlanRow { order_id: string; order_no: string; customer_name: string; status: string; decision_mode: string | null; approval_status: string; booked: boolean; kg: number; warehouses: string | null; created_at: string; decision_reason: string | null }
export function AllocationListPage() {
  const nav = useNavigate();
  const [view, setView] = useState<'open' | 'all'>('open');
  const q = useQuery({ queryKey: ['ful-plans', view], queryFn: () => api.get<PlanRow[]>(`/fulfilment/plans${view === 'open' ? '?status=needs_decision,pending_split_approval' : ''}`) });
  return (
    <>
      <PageHeader title="Warehouse allocation" description="The engine recommends a warehouse for every order — Surat first by default, then the next by priority, comparing stock, quality, distance, freight, ETA and workload. Orders no single warehouse can supply wait here; a split needs management approval."
        breadcrumbs={[{ label: 'Fulfilment', to: '/fulfilment' }, { label: 'Allocation' }]} />
      <div className="mb-4"><Segmented value={view} onChange={setView} options={[{ value: 'open', label: 'Needs a decision' }, { value: 'all', label: 'All orders' }]} /></div>
      <Card padded={false}>
        {!q.data ? <Skeleton className="m-5 h-40" /> : (
          <SimpleTable rows={q.data} rowKey={(r) => r.order_id} onRowClick={(r) => nav(`/fulfilment/orders/${r.order_id}`)} empty={<EmptyState icon={<CheckCircle2 className="size-5" />} title="Every order has a warehouse" />} columns={[
            { key: 'n', header: 'Order', render: (r) => <div><p className="font-mono text-[12.5px] font-semibold">{r.order_no}</p><p className="text-[12px] text-slate-500">{fmtDate(r.created_at)}</p></div> },
            { key: 'c', header: 'Customer', render: (r) => r.customer_name },
            { key: 'k', header: 'KG', align: 'right', render: (r) => fmtNum(r.kg) },
            { key: 'm', header: 'Decision', render: (r) => <span className="text-[12.5px]">{r.decision_mode ? <Badge tone={r.decision_mode === 'override' ? 'warning' : r.decision_mode === 'split' ? 'violet' : 'neutral'}>{humanize(r.decision_mode)}</Badge> : '—'}{r.warehouses && <span className="ml-1.5">{r.warehouses}</span>}</span> },
            { key: 'r', header: 'Why', render: (r) => <span className="line-clamp-2 max-w-[360px] text-[12.5px] text-slate-600">{r.decision_reason ?? '—'}</span> },
            { key: 's', header: 'Status', render: (r) => <StatusBadge status={r.status === 'needs_decision' ? 'pending' : r.status} /> },
          ]} />
        )}
      </Card>
    </>
  );
}

interface Option { warehouse_id: string; code: string; name: string; city: string; state_code: string; priority_rank: number; can_fulfil: boolean; covered_kg: number; total_kg: number; shortages: { sku: string; short_kg: number; note: string }[]; quality_pct: number | null; same_state: boolean; distance_band: number; freight_estimate: number; eta_days: number; workload: number; score: number }
interface Rec { strategy: string; rule: string; recommended_warehouse_id: string | null; options: Option[]; split_suggestion: { warehouse_id: string; code: string; lines: { order_line_id: string; sku: string; kg: number }[] }[] | null; at: string }
interface Plan { order_id: string; order_no: string; customer_name: string; customer_state_code: string | null; status: string; booked: boolean; lines: { order_line_id: string; sku: string; product_name: string; lot_id: string | null; kg: number }[]; recommendation: Rec | null; recommended_warehouse_id: string | null; decision_mode: string | null; selected: { warehouse_id: string; code: string; lines?: { sku: string; kg: number }[] }[] | null; decision_reason: string | null; decided_by_name: string | null; decided_at: string | null; approval_status: string; approved_by_name: string | null; approved_at: string | null; approval_comment: string | null; fulfilments: { id: string; number: string; warehouse_code: string; status: string; reservation_no: string | null }[] }

/** Warehouse recommendation and comparison for one order; confirm, override with a reason, or propose a split. */
export function OrderAllocationPage() {
  const { orderId = '' } = useParams();
  const { can } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const plan = useQuery({ queryKey: ['ful-plan', orderId], queryFn: () => api.get<Plan>(`/fulfilment/plans/${orderId}`) });
  const rec = useQuery({ queryKey: ['ful-rec', orderId], queryFn: () => api.post<Rec>(`/fulfilment/plans/${orderId}/recommend`), enabled: !!plan.data && !['cancelled'].includes(plan.data.status) });
  const [choose, setChoose] = useState<Option | null>(null);
  const [split, setSplit] = useState(false);
  if (plan.isError) return <ErrorState error={plan.error} />;
  const p = plan.data;
  if (!p) return <Skeleton className="h-96" />;
  const r = rec.data ?? p.recommendation;
  const refresh = () => { plan.refetch(); rec.refetch(); invalidatePrefix(qc, 'ful'); };
  const canDecide = can('fulfilment.allocate') && !['cancelled', 'pending_split_approval'].includes(p.status) && !p.fulfilments.some((f) => ['picking', 'picked', 'packed', 'invoiced', 'dispatched', 'delivered'].includes(f.status));
  return (
    <>
      <PageHeader title={`Allocation · ${p.order_no}`} description={`${p.customer_name}${p.customer_state_code ? ` · ${GST_STATES[p.customer_state_code]}` : ''}`} meta={<StatusBadge status={p.status === 'needs_decision' ? 'pending' : p.status} />}
        breadcrumbs={[{ label: 'Fulfilment', to: '/fulfilment' }, { label: 'Allocation', to: '/fulfilment/allocation' }, { label: p.order_no }]}
        actions={can('commerce.read') && <Link to={`/commerce/orders/${p.order_id}`}><Button>Sales order</Button></Link>} />
      {p.status === 'pending_split_approval' && <div className="mb-5"><Notice tone="warning" title="Split waiting for management approval">{p.selected?.map((s) => `${s.code}: ${s.lines?.map((l) => `${l.sku} ${l.kg} kg`).join(', ')}`).join(' | ')} — approve in the <Link className="link" to="/approvals">Approvals inbox</Link>. Nothing is reserved until then.</Notice></div>}
      {p.decision_mode === 'override' && <div className="mb-5"><Notice tone="info" title={`Overridden by ${p.decided_by_name} · ${fmtDateTime(p.decided_at)}`}>Recommended {r?.options.find((o) => o.warehouse_id === p.recommended_warehouse_id)?.code ?? '—'}, chose {p.selected?.map((s) => s.code).join(', ')}: “{p.decision_reason}”</Notice></div>}
      {p.approval_status === 'approved' && <div className="mb-5"><Notice tone="success">Split approved by {p.approved_by_name} · {fmtDateTime(p.approved_at)}{p.approval_comment ? ` — “${p.approval_comment}”` : ''}</Notice></div>}
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
        <Card title="Ordered" padded={false}>
          <SimpleTable rows={p.lines} rowKey={(l) => l.order_line_id} columns={[
            { key: 's', header: 'Fabric', render: (l) => <span className="font-mono text-[12.5px]">{l.sku}<span className="block font-sans text-[12px] text-slate-500">{l.lot_id ? 'Specific lot' : 'Any lot, one shade'}</span></span> },
            { key: 'k', header: 'KG', align: 'right', render: (l) => fmtNum(l.kg) },
          ]} />
          {p.fulfilments.length > 0 && <div className="border-t border-slate-100 px-5 py-3 text-[13px]"><p className="mb-1 font-semibold">Fulfilments</p>{p.fulfilments.map((f) => <Link key={f.id} to={`/fulfilment/${f.id}`} className="flex justify-between py-0.5 hover:underline"><span className="font-mono">{f.number} · {f.warehouse_code}</span><StatusBadge status={f.status} /></Link>)}</div>}
        </Card>
        <Card title="Recommendation" className="xl:col-span-2" description={r ? `${humanize(r.strategy)} · ${fmtRelative(r.at)}` : undefined} actions={<Button size="sm" onClick={() => rec.refetch()}>Refresh</Button>}>
          {!r ? <Skeleton className="h-24" /> : (
            <div className="space-y-3">
              <div className={clsx('rounded-lg px-4 py-3 ring-1 ring-inset', r.recommended_warehouse_id ? 'bg-emerald-50 ring-emerald-600/20' : 'bg-amber-50 ring-amber-600/20')}>
                <p className="font-semibold">{r.recommended_warehouse_id ? `Ship from ${r.options.find((o) => o.warehouse_id === r.recommended_warehouse_id)?.code}` : 'No single warehouse can fulfil this order'}</p>
                <p className="text-[13px] text-slate-700">{r.rule}</p>
              </div>
              {!r.recommended_warehouse_id && r.split_suggestion && (
                <div className="rounded-lg border border-dashed border-slate-300 p-3 text-[13px]"><p className="font-medium">Suggested split</p><p className="text-slate-600">{r.split_suggestion.map((s) => `${s.code}: ${s.lines.map((l) => `${l.sku} ${l.kg} kg`).join(', ')}`).join('  +  ')}</p>
                  {canDecide && p.status === 'needs_decision' && <Button className="mt-2" size="sm" variant="primary" icon={<GitFork className="size-3.5" />} onClick={() => setSplit(true)}>Request split approval</Button>}</div>
              )}
            </div>
          )}
        </Card>
      </div>
      {r && (
        <Card className="mt-6" title="Warehouse comparison" padded={false}>
          <SimpleTable rows={r.options} rowKey={(o) => o.warehouse_id} columns={[
            { key: 'w', header: 'Warehouse', render: (o) => <div className="flex items-center gap-2">{o.warehouse_id === r.recommended_warehouse_id && <Badge tone="success">Recommended</Badge>}<span><span className="font-semibold">{o.code}</span><span className="block text-[12px] text-slate-500">{o.city} · priority {o.priority_rank}</span></span></div> },
            { key: 'c', header: 'Stock', render: (o) => <div className="w-36"><div className="mb-1 text-[12px] tabular">{fmtNum(o.covered_kg)} / {fmtNum(o.total_kg)} kg</div><Bar value={o.covered_kg} max={o.total_kg} tone={o.can_fulfil ? 'success' : 'warning'} />{o.shortages.map((s) => <p key={s.sku} className="mt-0.5 text-[11.5px] text-amber-800">{s.sku}: {s.note}</p>)}</div> },
            { key: 'q', header: 'Grade A', align: 'right', render: (o) => (o.quality_pct === null ? '—' : `${o.quality_pct}%`) },
            { key: 'l', header: 'Distance', render: (o) => <span className="text-[12.5px]">{o.same_state ? 'Same state (CGST+SGST)' : ['Same state', 'Same region', 'Far'][o.distance_band]}</span> },
            { key: 'f', header: 'Freight est.', align: 'right', render: (o) => fmtINR(o.freight_estimate) },
            { key: 'e', header: 'ETA', align: 'right', render: (o) => `${o.eta_days} d` },
            { key: 'wl', header: 'Workload', align: 'right', render: (o) => `${o.workload} open` },
            { key: 'a', header: '', align: 'right', render: (o) => (canDecide && o.can_fulfil && !(p.status === 'reserved' && p.selected?.length === 1 && p.selected[0]!.warehouse_id === o.warehouse_id) ? <Button size="sm" variant={o.warehouse_id === r.recommended_warehouse_id ? 'primary' : 'secondary'} onClick={() => setChoose(o)}>{p.status === 'reserved' ? 'Move here' : 'Ship from here'}</Button> : p.selected?.some((s) => s.warehouse_id === o.warehouse_id) ? <Badge tone="brand">Selected</Badge> : null) },
          ]} />
        </Card>
      )}
      {choose && r && (
        <DecideModal orderId={orderId} option={choose} recommended={r.options.find((o) => o.warehouse_id === r.recommended_warehouse_id) ?? null} onClose={() => setChoose(null)} onDone={() => { setChoose(null); refresh(); toast({ tone: 'success', title: `Reserved in ${choose.code}` }); }} />
      )}
      {split && r?.split_suggestion && <SplitModal orderId={orderId} plan={p} suggestion={r.split_suggestion} options={r.options} onClose={() => setSplit(false)} onDone={() => { setSplit(false); refresh(); }} />}
    </>
  );
}

function DecideModal({ orderId, option, recommended, onClose, onDone }: { orderId: string; option: Option; recommended: Option | null; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const override = recommended?.warehouse_id !== option.warehouse_id;
  return (
    <Modal open onClose={onClose} title={`Ship from ${option.code}`} description={override ? `This overrides the recommendation (${recommended?.code ?? 'none'}). Both are recorded with your reason.` : 'Confirms the recommended warehouse and reserves the stock.'} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={override && reason.length < 3} onClick={async () => {
      try { await api.post(`/fulfilment/plans/${orderId}/decide`, { warehouse_id: option.warehouse_id, reason: reason || null }); onDone(); } catch (e) { setErr((e as Error).message); }
    }}>{override ? 'Override and reserve' : 'Reserve'}</Button></>}>
      {err && <Notice tone="danger">{err}</Notice>}
      {override && <Textarea label="Reason for overriding" required value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. customer collects from Kolkata; Surat stock earmarked for an export order" />}
    </Modal>
  );
}

function SplitModal({ orderId, plan, suggestion, options, onClose, onDone }: { orderId: string; plan: Plan; suggestion: NonNullable<Rec['split_suggestion']>; options: Option[]; onClose: () => void; onDone: () => void }) {
  const [rows, setRows] = useState(suggestion.map((s) => ({ warehouse_id: s.warehouse_id, lines: s.lines.map((l) => ({ ...l, kg: String(l.kg) })) })));
  const [reason, setReason] = useState('');
  const [err, setErr] = useState<string | null>(null);
  return (
    <Modal open onClose={onClose} size="lg" title="Request a split fulfilment" description="Each warehouse gets its own fulfilment, reservation, invoice and shipment. Management approves before anything is reserved." footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={reason.length < 3} onClick={async () => {
      try { await api.post(`/fulfilment/plans/${orderId}/split`, { reason, allocations: rows.map((r) => ({ warehouse_id: r.warehouse_id, lines: r.lines.map((l) => ({ order_line_id: l.order_line_id, kg: Number(l.kg) })).filter((l) => l.kg > 0) })) }); onDone(); } catch (e) { setErr((e as Error).message); }
    }}>Send for approval</Button></>}>
      <div className="space-y-4">
        {err && <Notice tone="danger">{err}</Notice>}
        {rows.map((r, i) => (
          <div key={r.warehouse_id} className="rounded-lg border border-slate-200 p-3">
            <p className="mb-2 font-semibold">{options.find((o) => o.warehouse_id === r.warehouse_id)?.code} · {options.find((o) => o.warehouse_id === r.warehouse_id)?.city}</p>
            {r.lines.map((l, j) => <div key={l.order_line_id} className="flex items-center gap-2 text-[13px]"><span className="w-32 font-mono">{l.sku}</span><input className="input h-8 w-28" type="number" value={l.kg} onChange={(e) => setRows(rows.map((x, a) => (a === i ? { ...x, lines: x.lines.map((y, b) => (b === j ? { ...y, kg: e.target.value } : y)) } : x)))} /><span className="text-slate-500">kg of {plan.lines.find((x) => x.order_line_id === l.order_line_id)?.kg}</span></div>)}
          </div>
        ))}
        <Textarea label="Why split?" required value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. customer needs the full quantity this week" />
      </div>
    </Modal>
  );
}

interface FDetail extends FRow { warehouse_name: string; warehouse_state_code: string; customer_state_code: string | null; reservation_id: string | null; reservation_no: string | null; packages: number | null; gross_kg: number | null; taxable: number; cgst: number; sgst: number; igst: number; gate_override_status: string; gate_override_reason: string | null; gate_override_by_name: string | null; dispatched_at: string | null;
  lines: { id: string; sku: string; product_name: string; kg_planned: number; price_per_kg: number; lot_id: string | null }[];
  invoice_lines: { line_no: number; sku: string; kg: number; rolls: number; price_per_kg: number; taxable: number; tax: number }[];
  pick_list: { id: string; barcode: string; weight_kg: number; state: string; location_path: string | null; lot_no: string; sku: string; grade: string | null; dye_lot: string | null }[];
  shipment: { id: string; number: string; transporter_name: string; lr_number: string | null; status: string; tracking_token: string; eta_date: string | null } | null;
  plan: { decision_mode: string | null; decision_reason: string | null } | null }

/** One warehouse’s part of an order: pick list by scan (FIG-048), pack, invoice, gates and dispatch. */
export function FulfilmentDetailPage() {
  const { id = '' } = useParams();
  const { can } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['ful', id], queryFn: () => api.get<FDetail>(`/fulfilment/fulfilments/${id}`) });
  const [weight, setWeight] = useState('');
  const [modal, setModal] = useState<'pack' | 'dispatch' | 'override' | null>(null);
  if (q.isError) return <ErrorState error={q.error} />;
  const f = q.data;
  if (!f) return <Skeleton className="h-96" />;
  const refresh = () => { q.refetch(); invalidatePrefix(qc, 'ful'); };
  const act = async (path: string, msg: string) => { try { await api.post(`/fulfilment/fulfilments/${id}/${path}`); toast({ tone: 'success', title: msg }); refresh(); } catch (e) { toast({ tone: 'error', title: (e as Error).message }); } };
  const g = f.gates;
  const picking = ['released', 'picking', 'picked'].includes(f.status);
  const planned = f.lines.reduce((s, l) => s + Number(l.kg_planned), 0);
  const due = Math.max(0, Number(f.invoice_total) - Number(f.amount_settled));
  return (
    <>
      <PageHeader title={`${f.number} · ${f.warehouse_code}`} description={<span>{f.customer_name} · order <Link className="link" to={`/fulfilment/orders/${f.order_id}`}>{f.order_no}</Link></span>} meta={<StatusBadge status={f.shipment?.status ?? f.status} />}
        breadcrumbs={[{ label: 'Fulfilment', to: '/fulfilment' }, { label: f.number }]}
        actions={<>
          {f.invoice_no && <Link to={`/fulfilment/invoices/${f.id}`}><Button icon={<FileText className="size-4" />}>Invoice {f.invoice_no}</Button></Link>}
          {['picking', 'picked'].includes(f.status) && can('fulfilment.pick') && <Button icon={<Package className="size-4" />} onClick={() => setModal('pack')}>Pack</Button>}
          {f.status === 'packed' && can('fulfilment.invoice') && <Button variant="primary" icon={<FileText className="size-4" />} onClick={() => void act('invoice', 'Invoice generated')}>Generate GST invoice</Button>}
          {['packed', 'invoiced'].includes(f.status) && can('fulfilment.dispatch') && <Button variant={g.invoiced && g.paid ? 'primary' : 'secondary'} icon={<Truck className="size-4" />} onClick={() => setModal('dispatch')}>Dispatch</Button>}
        </>} />
      <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-5">
        {[
          { ok: f.status !== 'reserved', label: 'Booked', sub: f.status === 'reserved' ? 'Waiting for the customer’s token' : f.payment_terms === 'credit' ? 'Credit customer' : 'Token paid' },
          { ok: g.picked && ['picked', 'packed', 'invoiced', 'dispatched', 'delivered'].includes(f.status), label: 'Picked', sub: `${fmtNum(Number(f.picked_kg))} of ${fmtNum(planned)} kg` },
          { ok: g.packed, label: 'Packed', sub: f.packages ? `${f.packages} packages · ${fmtNum(Number(f.gross_kg))} kg gross` : '—' },
          { ok: g.invoiced, label: 'GST invoice', sub: f.invoice_no ?? 'Not generated' },
          { ok: g.paid, label: payLabel(g), sub: !g.invoiced ? '—' : g.payment === 'credit' ? 'Within approved credit' : g.payment === 'override' ? `Override by ${f.gate_override_by_name}` : due > 0 ? `${fmtINR(due)} due` : 'Paid in full' },
        ].map((x) => (
          <div key={x.label} className={clsx('rounded-xl p-4 ring-1 ring-inset', x.ok ? 'bg-emerald-50 ring-emerald-600/20' : 'bg-white ring-slate-200')}>
            <p className="flex items-center gap-1.5 text-[13px] font-semibold">{x.ok ? <CheckCircle2 className="size-4 text-emerald-600" /> : <Circle className="size-4 text-slate-300" />}{x.label}</p>
            <p className="mt-0.5 text-[12px] text-slate-600">{x.sub}</p>
          </div>
        ))}
      </div>
      {g.invoiced && !g.paid && f.status === 'invoiced' && (
        <div className="mb-5"><Notice tone="warning" title={`Dispatch held: ${fmtINR(due)} unpaid on ${f.invoice_no}`} action={<div className="flex gap-2"><Button size="sm" onClick={() => void act('refresh-payment', 'Payment re-checked')}>Re-check payment</Button>{f.gate_override_status === 'none' || f.gate_override_status === 'rejected' ? <Button size="sm" onClick={() => setModal('override')}>Request override</Button> : null}</div>}>
          The customer can pay from their order page in the portal; the gate opens automatically once the bank confirms. {f.gate_override_status === 'pending' && 'An override request is waiting for approval.'}{f.gate_override_status === 'rejected' && ' The last override request was rejected.'}
        </Notice></div>
      )}
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
        <div className="space-y-6 xl:col-span-2">
          {picking && can('fulfilment.pick') && f.status !== 'reserved' && (
            <Card title="Pick by scanning" description="Scan each roll on the pick list. Re-weigh if the scale shows a different weight; anything else is refused.">
              <ScanInput extra={<input className="input h-11 w-28" type="number" placeholder="Weight kg" value={weight} onChange={(e) => setWeight(e.target.value)} />} onScan={async (code) => {
                const r = await api.post<{ kg: number; remaining_rolls: number; picked_kg: number; weight_difference: number }>(`/fulfilment/fulfilments/${id}/pick`, { barcode: code, weight_kg: weight ? Number(weight) : null });
                setWeight(''); refresh();
                return { ok: true, title: `${fmtNum(r.kg)} kg picked${r.weight_difference ? ` (re-weighed ${r.weight_difference > 0 ? '+' : ''}${r.weight_difference} kg)` : ''}`, detail: `${r.remaining_rolls} roll(s) left · ${fmtNum(r.picked_kg)} kg picked` };
              }} />
            </Card>
          )}
          <Card title={`Pick list · ${f.reservation_no ?? ''}`} padded={false}>
            <SimpleTable rows={[...f.pick_list].sort((a, b) => (a.location_path ?? '').localeCompare(b.location_path ?? ''))} rowKey={(r) => r.id} columns={[
              { key: 'l', header: 'Bin', render: (r) => <span className="font-mono text-[12.5px] font-semibold">{r.location_path ?? '—'}</span> },
              { key: 'b', header: 'Roll', render: (r) => <span className="font-mono text-[12.5px]">{r.barcode}</span> },
              { key: 's', header: 'Fabric', render: (r) => <span className="text-[12.5px]">{r.sku}<span className="block text-slate-500">{r.lot_no} · {r.dye_lot ?? '—'} · grade {r.grade ?? '—'}</span></span> },
              { key: 'k', header: 'KG', align: 'right', render: (r) => fmtNum(Number(r.weight_kg)) },
              { key: 'st', header: '', render: (r) => <StatusBadge status={r.state === 'allocated' ? 'picked' : r.state} /> },
            ]} />
          </Card>
          {f.invoice_lines.length > 0 && (
            <Card title={`Invoice ${f.invoice_no}`} padded={false}>
              <SimpleTable rows={f.invoice_lines} rowKey={(l) => String(l.line_no)} columns={[
                { key: 's', header: 'Fabric', render: (l) => <span className="font-mono text-[12.5px]">{l.sku}</span> },
                { key: 'r', header: 'Rolls', align: 'right', render: (l) => l.rolls },
                { key: 'k', header: 'KG', align: 'right', render: (l) => fmtNum(Number(l.kg)) },
                { key: 'p', header: 'Rate', align: 'right', render: (l) => `₹${fmtNum(Number(l.price_per_kg))}` },
                { key: 't', header: 'Taxable', align: 'right', render: (l) => fmtINR(Number(l.taxable)) },
                { key: 'x', header: 'GST', align: 'right', render: (l) => fmtINR(Number(l.tax)) },
              ]} />
              <div className="flex justify-end gap-6 border-t border-slate-100 px-5 py-3 text-[13px]">{Number(f.igst) ? <span>IGST {fmtINR(Number(f.igst))}</span> : <><span>CGST {fmtINR(Number(f.cgst))}</span><span>SGST {fmtINR(Number(f.sgst))}</span></>}<span className="font-semibold">Total {fmtINR(Number(f.invoice_total))}</span></div>
            </Card>
          )}
        </div>
        <div className="space-y-6">
          <Card title="Order lines"><ul className="space-y-1 text-[13px]">{f.lines.map((l) => <li key={l.id} className="flex justify-between"><span className="font-mono">{l.sku}</span><span>{fmtNum(Number(l.kg_planned))} kg · ₹{fmtNum(Number(l.price_per_kg))}</span></li>)}</ul></Card>
          <Card title="GST">
            <KeyValue columns={1} items={[{ label: 'From', value: `${f.warehouse_name} (${GST_STATES[f.warehouse_state_code]})` }, { label: 'To', value: f.customer_state_code ? GST_STATES[f.customer_state_code] : '—' }, { label: 'Tax type', value: f.warehouse_state_code === f.customer_state_code ? 'CGST + SGST (intra-state)' : 'IGST (inter-state)' }]} />
          </Card>
          {f.shipment && (
            <Card title="Shipment" actions={<Link className="link text-[12.5px]" to={`/fulfilment/shipments/${f.shipment.id}`}>Open</Link>}>
              <KeyValue columns={1} items={[{ label: 'Number', value: f.shipment.number }, { label: 'Transporter', value: f.shipment.transporter_name }, { label: 'LR', value: f.shipment.lr_number }, { label: 'ETA', value: fmtDate(f.shipment.eta_date) }, { label: 'Tracking link', value: <Link className="link" to={`/track/${f.shipment.tracking_token}`}>Customer view</Link> }]} />
            </Card>
          )}
          {f.plan?.decision_reason && <Card title="Why this warehouse"><p className="text-[13px] text-slate-700">{humanize(f.plan.decision_mode ?? '')}: {f.plan.decision_reason}</p></Card>}
        </div>
      </div>
      {modal === 'pack' && <PackModal f={f} onClose={() => setModal(null)} onDone={() => { setModal(null); refresh(); }} />}
      {modal === 'dispatch' && <DispatchModal f={f} onClose={() => setModal(null)} onDone={() => { setModal(null); refresh(); }} />}
      <ConfirmDialog open={modal === 'override'} onClose={() => setModal(null)} title="Request dispatch without full payment" description="A checker with dispatch-override rights must approve. Your reason is kept in the audit trail." requireReason confirmLabel="Send for approval"
        onConfirm={async (reason) => { try { await api.post(`/fulfilment/fulfilments/${id}/gate-override`, { reason }); setModal(null); refresh(); } catch (e) { toast({ tone: 'error', title: (e as Error).message }); } }} />
    </>
  );
}

function PackModal({ f, onClose, onDone }: { f: FDetail; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [v, setV] = useState({ packages: String(Math.max(1, Math.ceil(f.pick_list.filter((r) => r.state === 'allocated').length / 4))), gross_kg: String(Math.ceil(Number(f.picked_kg) + 2)) });
  return (
    <Modal open onClose={onClose} title="Pack" description={`${fmtNum(Number(f.picked_kg))} kg picked`} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={async () => { try { await api.post(`/fulfilment/fulfilments/${f.id}/pack`, { packages: Number(v.packages), gross_kg: Number(v.gross_kg) }); onDone(); } catch (e) { toast({ tone: 'error', title: (e as Error).message }); } }}>Packed</Button></>}>
      <div className="grid grid-cols-2 gap-3"><Input label="Packages / bales" type="number" value={v.packages} onChange={(e) => setV({ ...v, packages: e.target.value })} /><Input label="Gross weight" type="number" suffix="kg" value={v.gross_kg} onChange={(e) => setV({ ...v, gross_kg: e.target.value })} /></div>
    </Modal>
  );
}

function DispatchModal({ f, onClose, onDone }: { f: FDetail; onClose: () => void; onDone: () => void }) {
  const transporters = useParties('transporter');
  const quotes = useQuery({ queryKey: ['ful-quotes', f.id], queryFn: () => api.get<{ transporter_id: string; transporter_name: string; mode: string; rate_per_kg: number; eta_days: number; freight: number }[]>(`/fulfilment/fulfilments/${f.id}/freight-quotes`) });
  const [v, setV] = useState({ transporter_id: '', transporter_name: '', mode: 'PTL', vehicle_no: '', driver_name: '', driver_phone: '', lr_number: '', eway_bill_no: '', freight_amount: '', eta_date: '' });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pick = (q: { transporter_id: string; transporter_name: string; mode: string; freight: number; eta_days: number }) => setV({ ...v, transporter_id: q.transporter_id, transporter_name: q.transporter_name, mode: q.mode, freight_amount: String(q.freight), eta_date: new Date(Date.now() + q.eta_days * 86_400_000).toISOString().slice(0, 10) });
  return (
    <Modal open onClose={onClose} size="lg" title={`Dispatch ${f.number}`} description={`${fmtNum(Number(f.picked_kg))} kg${f.invoice_no ? ` on ${f.invoice_no} (${fmtINR(Number(f.invoice_total))})` : ''}`} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} disabled={!v.transporter_name} onClick={async () => {
      setBusy(true); setErr(null);
      try { await api.post(`/fulfilment/fulfilments/${f.id}/dispatch`, { ...v, transporter_id: v.transporter_id || null, freight_amount: Number(v.freight_amount || 0), eta_date: v.eta_date || null, ...Object.fromEntries(['vehicle_no', 'driver_name', 'driver_phone', 'lr_number', 'eway_bill_no'].map((k) => [k, (v as Record<string, string>)[k] || null])) }); onDone(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
    }}>Dispatch</Button></>}>
      <div className="space-y-4">
        {err && <Notice tone="danger" icon={<AlertTriangle className="size-4" />}>{err}</Notice>}
        {quotes.data?.length ? (
          <div><p className="mb-1.5 text-[12.5px] font-medium">Freight comparison</p><div className="grid grid-cols-1 gap-2 md:grid-cols-2">{quotes.data.map((q) => (
            <button key={`${q.transporter_id}${q.mode}`} onClick={() => pick(q)} className={clsx('rounded-lg border px-3 py-2 text-left text-[13px]', v.transporter_id === q.transporter_id && v.mode === q.mode ? 'border-brand-500 bg-brand-50' : 'border-slate-200 hover:border-slate-300')}>
              <p className="font-medium">{q.transporter_name} · {q.mode}</p><p className="text-slate-600">{fmtINR(q.freight)} · ₹{q.rate_per_kg}/kg · {q.eta_days} days</p>
            </button>
          ))}</div></div>
        ) : <p className="text-[12.5px] text-slate-500">No freight rates on this lane yet; enter the transporter and freight manually.</p>}
        <div className="grid grid-cols-2 gap-3">
          <Select label="Transporter" value={v.transporter_id} onChange={(e) => { const t = transporters.data?.find((x) => x.id === e.target.value); setV({ ...v, transporter_id: e.target.value, transporter_name: t?.legal_name ?? '' }); }} options={[{ value: '', label: 'Choose…' }, ...(transporters.data ?? []).map((t) => ({ value: t.id, label: t.legal_name }))]} />
          <Select label="Mode" value={v.mode} onChange={(e) => setV({ ...v, mode: e.target.value })} options={[{ value: 'PTL', label: 'Part truck load' }, { value: 'FTL', label: 'Full truck load' }, { value: 'own_vehicle', label: 'Own vehicle' }, { value: 'customer_pickup', label: 'Customer pickup' }]} />
          <Input label="LR / docket no." value={v.lr_number} onChange={(e) => setV({ ...v, lr_number: e.target.value })} />
          <Input label="E-way bill no." value={v.eway_bill_no} onChange={(e) => setV({ ...v, eway_bill_no: e.target.value })} hint="Needed above the configured invoice value" />
          <Input label="Vehicle no." value={v.vehicle_no} onChange={(e) => setV({ ...v, vehicle_no: e.target.value.toUpperCase() })} />
          <Input label="Driver" value={v.driver_name} onChange={(e) => setV({ ...v, driver_name: e.target.value })} />
          <Input label="Driver phone" value={v.driver_phone} onChange={(e) => setV({ ...v, driver_phone: e.target.value })} />
          <Input label="Freight" type="number" prefix="₹" value={v.freight_amount} onChange={(e) => setV({ ...v, freight_amount: e.target.value })} />
          <Input label="Expected delivery" type="date" value={v.eta_date} onChange={(e) => setV({ ...v, eta_date: e.target.value })} />
        </div>
      </div>
    </Modal>
  );
}

// ---------- shipments, transport, claims ----------
interface ShipRow { id: string; number: string; order_no: string; customer_name: string; warehouse_code: string; transporter_name: string; mode: string; lr_number: string | null; kg: number; status: string; eta_date: string | null; dispatched_at: string; delivered_at: string | null; pod_condition: string | null; open_claims: number }
export function ShipmentsPage() {
  const nav = useNavigate();
  const { can } = useAuth();
  const [tab, setTab] = useState<'shipments' | 'rates' | 'claims'>('shipments');
  const ships = useQuery({ queryKey: ['ful-ships'], queryFn: () => api.get<ShipRow[]>('/fulfilment/shipments'), enabled: tab === 'shipments' });
  const rates = useQuery({ queryKey: ['ful-rates'], queryFn: () => api.get<{ id: string; transporter_name: string; mode: string; from_state: string; to_state: string; rate_per_kg: number; min_charge: number; eta_days: number; status: string }[]>('/fulfilment/freight-rates'), enabled: tab === 'rates' });
  const claims = useQuery({ queryKey: ['ful-claims'], queryFn: () => api.get<{ id: string; number: string; shipment_no: string; shipment_id: string; customer_name: string; transporter_name: string; claim_type: string; kg: number | null; amount: number; status: string; description: string; created_at: string }[]>('/fulfilment/claims'), enabled: tab === 'claims' });
  const [addRate, setAddRate] = useState(false);
  const today = new Date().toISOString().slice(0, 10);
  return (
    <>
      <PageHeader title="Transport & tracking" description="Shipments with LR, vehicle and e-way bill; manual milestones until transporters provide a GPS feed; freight rates per lane for comparison; transit claims." breadcrumbs={[{ label: 'Fulfilment', to: '/fulfilment' }, { label: 'Transport' }]}
        actions={tab === 'rates' && can('fulfilment.transport.manage') && <Button variant="primary" onClick={() => setAddRate(true)}>Add rate</Button>} />
      <div className="mb-4"><Segmented value={tab} onChange={setTab} options={[{ value: 'shipments', label: 'Shipments' }, { value: 'rates', label: 'Freight rates' }, { value: 'claims', label: 'Transport claims' }]} /></div>
      {tab === 'shipments' && <Card padded={false}>{!ships.data ? <Skeleton className="m-5 h-40" /> : (
        <SimpleTable rows={ships.data} rowKey={(r) => r.id} onRowClick={(r) => nav(`/fulfilment/shipments/${r.id}`)} empty={<EmptyState title="No shipments" />} columns={[
          { key: 'n', header: 'Shipment', render: (r) => <div><p className="font-mono text-[12.5px] font-semibold">{r.number}</p><p className="text-[12px] text-slate-500">{r.order_no} · {r.warehouse_code}</p></div> },
          { key: 'c', header: 'Customer', render: (r) => r.customer_name },
          { key: 't', header: 'Transporter', render: (r) => <span>{r.transporter_name}<span className="block text-[12px] text-slate-500">{r.mode}{r.lr_number ? ` · LR ${r.lr_number}` : ''}</span></span> },
          { key: 'k', header: 'KG', align: 'right', render: (r) => fmtNum(Number(r.kg)) },
          { key: 'e', header: 'ETA', render: (r) => <span className={r.status !== 'delivered' && r.eta_date && r.eta_date < today ? 'font-semibold text-rose-600' : ''}>{r.delivered_at ? `Delivered ${fmtDate(r.delivered_at)}` : fmtDate(r.eta_date)}</span> },
          { key: 's', header: 'Status', render: (r) => <div className="flex gap-1"><StatusBadge status={r.status} />{r.pod_condition && r.pod_condition !== 'ok' && <Badge tone="danger">{r.pod_condition}</Badge>}{r.open_claims > 0 && <Badge tone="warning">claim</Badge>}</div> },
        ]} />)}</Card>}
      {tab === 'rates' && <Card padded={false}>{!rates.data ? <Skeleton className="m-5 h-40" /> : (
        <SimpleTable rows={rates.data} rowKey={(r) => r.id} empty={<EmptyState title="No freight rates" />} columns={[
          { key: 't', header: 'Transporter', render: (r) => r.transporter_name },
          { key: 'm', header: 'Mode', render: (r) => r.mode },
          { key: 'l', header: 'Lane', render: (r) => `${GST_STATES[r.from_state]} → ${GST_STATES[r.to_state]}` },
          { key: 'r', header: 'Rate', align: 'right', render: (r) => `₹${r.rate_per_kg}/kg` },
          { key: 'mc', header: 'Minimum', align: 'right', render: (r) => fmtINR(Number(r.min_charge)) },
          { key: 'e', header: 'Transit', align: 'right', render: (r) => `${r.eta_days} d` },
          { key: 's', header: 'Status', render: (r) => <StatusBadge status={r.status} /> },
        ]} />)}</Card>}
      {tab === 'claims' && <Card padded={false}>{!claims.data ? <Skeleton className="m-5 h-40" /> : (
        <SimpleTable rows={claims.data} rowKey={(r) => r.id} onRowClick={(r) => nav(`/fulfilment/shipments/${r.shipment_id}`)} empty={<EmptyState title="No transport claims" />} columns={[
          { key: 'n', header: 'Claim', render: (r) => <span className="font-mono text-[12.5px]">{r.number}<span className="block font-sans text-[12px] text-slate-500">{r.shipment_no} · {r.customer_name}</span></span> },
          { key: 't', header: 'Against', render: (r) => r.transporter_name },
          { key: 'ty', header: 'Type', render: (r) => <Badge tone="danger">{humanize(r.claim_type)}</Badge> },
          { key: 'd', header: 'Details', render: (r) => <span className="text-[12.5px]">{r.kg ? `${r.kg} kg · ` : ''}{r.description}</span> },
          { key: 'a', header: 'Amount', align: 'right', render: (r) => fmtINR(Number(r.amount)) },
          { key: 's', header: 'Status', render: (r) => <StatusBadge status={r.status} /> },
        ]} />)}</Card>}
      {addRate && <RateModal onClose={() => setAddRate(false)} onDone={() => { setAddRate(false); rates.refetch(); }} />}
    </>
  );
}

function RateModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const transporters = useParties('transporter');
  const toast = useToast();
  const [v, setV] = useState({ transporter_id: '', mode: 'PTL', from_state: '24', to_state: '33', rate_per_kg: '', min_charge: '', eta_days: '' });
  const states = Object.entries(GST_STATES).map(([k, x]) => ({ value: k, label: x }));
  return (
    <Modal open onClose={onClose} title="Freight rate" description="Replaces the transporter’s current rate on this lane and mode." footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={async () => { try { await api.post('/fulfilment/freight-rates', { ...v, rate_per_kg: Number(v.rate_per_kg), min_charge: Number(v.min_charge || 0), eta_days: Number(v.eta_days) }); onDone(); } catch (e) { toast({ tone: 'error', title: (e as Error).message }); } }}>Save</Button></>}>
      <div className="grid grid-cols-2 gap-3">
        <Select className="col-span-2" label="Transporter" value={v.transporter_id} onChange={(e) => setV({ ...v, transporter_id: e.target.value })} options={[{ value: '', label: 'Choose…' }, ...(transporters.data ?? []).map((t) => ({ value: t.id, label: t.legal_name }))]} />
        <Select label="From" value={v.from_state} onChange={(e) => setV({ ...v, from_state: e.target.value })} options={states} />
        <Select label="To" value={v.to_state} onChange={(e) => setV({ ...v, to_state: e.target.value })} options={states} />
        <Select label="Mode" value={v.mode} onChange={(e) => setV({ ...v, mode: e.target.value })} options={[{ value: 'PTL', label: 'PTL' }, { value: 'FTL', label: 'FTL' }]} />
        <Input label="Rate per kg" type="number" prefix="₹" value={v.rate_per_kg} onChange={(e) => setV({ ...v, rate_per_kg: e.target.value })} />
        <Input label="Minimum charge" type="number" prefix="₹" value={v.min_charge} onChange={(e) => setV({ ...v, min_charge: e.target.value })} />
        <Input label="Transit days" type="number" value={v.eta_days} onChange={(e) => setV({ ...v, eta_days: e.target.value })} />
      </div>
    </Modal>
  );
}

interface ShipD extends ShipRow { warehouse_name?: string | null; fulfilment_id: string; fulfilment_no: string; invoice_no: string | null; vehicle_no: string | null; driver_name: string | null; driver_phone: string | null; eway_bill_no: string | null; freight_amount: number; rolls: number; packages: number | null; tracking_token: string; pod_received_by: string | null; pod_kg: number | null; pod_remarks: string | null; pod_source: string | null; pod_at: string | null; created_by_name: string;
  events: { id: number; milestone: string; location: string | null; note: string | null; by_name: string | null; source: string; at: string }[]; claims: { id: string; number: string; claim_type: string; kg: number | null; amount: number; description: string; status: string; settlement_amount: number | null; resolution: string | null }[] }

export function ShipmentDetailPage() {
  const { id = '' } = useParams();
  const { can } = useAuth();
  const toast = useToast();
  const q = useQuery({ queryKey: ['ful-ship', id], queryFn: () => api.get<ShipD>(`/fulfilment/shipments/${id}`) });
  const [ms, setMs] = useState({ milestone: 'in_transit', location: '', note: '' });
  const [pod, setPod] = useState(false);
  const [claim, setClaim] = useState<ShipD['claims'][number] | null>(null);
  if (q.isError) return <ErrorState error={q.error} />;
  const s = q.data;
  if (!s) return <Skeleton className="h-96" />;
  return (
    <>
      <PageHeader title={`Shipment ${s.number}`} description={`${s.customer_name} · ${s.order_no}${s.warehouse_name ?? s.warehouse_code ? ` · from ${s.warehouse_name ?? s.warehouse_code}` : ''}`} meta={<StatusBadge status={s.status} />}
        breadcrumbs={[{ label: 'Fulfilment', to: '/fulfilment' }, { label: 'Transport', to: '/fulfilment/shipments' }, { label: s.number }]}
        actions={<><Link to={`/track/${s.tracking_token}`}><Button icon={<Truck className="size-4" />}>Customer tracking page</Button></Link>{s.status !== 'delivered' && can('fulfilment.dispatch') && <Button variant="primary" icon={<PackageCheck className="size-4" />} onClick={() => setPod(true)}>Record delivery (POD)</Button>}</>} />
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
        <div className="space-y-6 xl:col-span-2">
          <Card title="Milestones">
            <ol className="space-y-3">{s.events.map((e) => <li key={e.id} className="flex gap-3 text-[13px]"><span className="mt-1 size-2.5 shrink-0 rounded-full bg-brand-500" /><div><p className="font-medium">{humanize(e.milestone)}{e.location ? ` · ${e.location}` : ''}</p>{e.note && <p className="text-slate-600">{e.note}</p>}<p className="text-[12px] text-slate-400">{e.by_name} · {e.source === 'customer_portal' ? 'customer portal · ' : ''}{fmtDateTime(e.at)}</p></div></li>)}</ol>
            {s.status !== 'delivered' && can('fulfilment.dispatch') && (
              <div className="mt-5 grid grid-cols-1 gap-2 border-t border-slate-100 pt-4 md:grid-cols-[160px_1fr_1fr_auto]">
                <select className="input" value={ms.milestone} onChange={(e) => setMs({ ...ms, milestone: e.target.value })}>{['picked_up', 'in_transit', 'reached_hub', 'out_for_delivery', 'exception'].map((m) => <option key={m} value={m}>{humanize(m)}</option>)}</select>
                <input className="input" placeholder="Location" value={ms.location} onChange={(e) => setMs({ ...ms, location: e.target.value })} />
                <input className="input" placeholder="Note" value={ms.note} onChange={(e) => setMs({ ...ms, note: e.target.value })} />
                <Button onClick={async () => { try { await api.post(`/fulfilment/shipments/${id}/milestones`, { milestone: ms.milestone, location: ms.location || null, note: ms.note || null }); setMs({ milestone: 'in_transit', location: '', note: '' }); q.refetch(); } catch (e) { toast({ tone: 'error', title: (e as Error).message }); } }}>Add</Button>
              </div>
            )}
          </Card>
          {s.claims.length > 0 && (
            <Card title="Transport claims" padded={false}>
              <SimpleTable rows={s.claims} rowKey={(c) => c.id} onRowClick={can('fulfilment.returns.manage') ? (c) => setClaim(c) : undefined} columns={[
                { key: 'n', header: 'Claim', render: (c) => <span className="font-mono text-[12.5px]">{c.number}</span> },
                { key: 't', header: 'Type', render: (c) => humanize(c.claim_type) },
                { key: 'd', header: 'Details', render: (c) => <span className="text-[12.5px]">{c.kg ? `${c.kg} kg · ` : ''}{c.description}</span> },
                { key: 'a', header: 'Claimed', align: 'right', render: (c) => fmtINR(Number(c.amount)) },
                { key: 's', header: 'Status', render: (c) => <StatusBadge status={c.status} /> },
              ]} />
            </Card>
          )}
        </div>
        <div className="space-y-6">
          <Card title="Consignment">
            <KeyValue columns={1} items={[
              { label: 'Transporter', value: `${s.transporter_name} · ${s.mode}` }, { label: 'LR / docket', value: s.lr_number }, { label: 'Vehicle', value: s.vehicle_no }, { label: 'Driver', value: s.driver_name ? `${s.driver_name}${s.driver_phone ? ` · ${s.driver_phone}` : ''}` : null },
              { label: 'E-way bill', value: s.eway_bill_no }, { label: 'Invoice', value: s.invoice_no ? <Link className="link" to={`/fulfilment/invoices/${s.fulfilment_id}`}>{s.invoice_no}</Link> : null },
              { label: 'Load', value: `${s.rolls} rolls · ${fmtNum(Number(s.kg))} kg${s.packages ? ` · ${s.packages} packages` : ''}` }, { label: 'Freight', value: fmtINR(Number(s.freight_amount)) },
              { label: 'Dispatched', value: `${fmtDateTime(s.dispatched_at)} · ${s.created_by_name}` }, { label: 'ETA', value: fmtDate(s.eta_date) },
            ]} />
          </Card>
          {s.pod_at && <Card title="Proof of delivery"><KeyValue columns={1} items={[{ label: 'Received by', value: s.pod_received_by }, { label: 'KG received', value: `${fmtNum(Number(s.pod_kg))} of ${fmtNum(Number(s.kg))}` }, { label: 'Condition', value: <Badge tone={s.pod_condition === 'ok' ? 'success' : 'danger'}>{humanize(s.pod_condition ?? '')}</Badge> }, { label: 'Remarks', value: s.pod_remarks }, { label: 'Recorded', value: `${s.pod_source === 'customer_portal' ? 'Customer (ePOD)' : 'Internal'} · ${fmtDateTime(s.pod_at)}` }]} /></Card>}
          <Notice tone="info" icon={<ShieldCheck className="size-4" />}>Live GPS needs a transporter API; milestones are entered by dispatch and by the customer’s ePOD.</Notice>
        </div>
      </div>
      {pod && <InternalPod s={s} onClose={() => setPod(false)} onDone={() => { setPod(false); q.refetch(); }} />}
      {claim && <ClaimModal c={claim} onClose={() => setClaim(null)} onDone={() => { setClaim(null); q.refetch(); }} />}
    </>
  );
}

function InternalPod({ s, onClose, onDone }: { s: ShipD; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [v, setV] = useState({ received_by: '', kg_received: String(s.kg), condition: 'ok', remarks: '' });
  return (
    <Modal open onClose={onClose} title="Proof of delivery" description="From the signed LR copy or the transporter’s POD." footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={async () => { try { await api.post(`/fulfilment/shipments/${s.id}/pod`, { ...v, kg_received: Number(v.kg_received), remarks: v.remarks || null }); onDone(); } catch (e) { toast({ tone: 'error', title: (e as Error).message }); } }}>Save</Button></>}>
      <div className="grid grid-cols-2 gap-3">
        <Input label="Received by" value={v.received_by} onChange={(e) => setV({ ...v, received_by: e.target.value })} />
        <Input label="KG received" type="number" value={v.kg_received} onChange={(e) => setV({ ...v, kg_received: e.target.value })} />
        <Select className="col-span-2" label="Condition" value={v.condition} onChange={(e) => setV({ ...v, condition: e.target.value })} options={[{ value: 'ok', label: 'Good' }, { value: 'short', label: 'Short' }, { value: 'damaged', label: 'Damaged' }]} />
        <Textarea className="col-span-2" label="Remarks" value={v.remarks} onChange={(e) => setV({ ...v, remarks: e.target.value })} />
      </div>
    </Modal>
  );
}

function ClaimModal({ c, onClose, onDone }: { c: ShipD['claims'][number]; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [v, setV] = useState({ status: c.status, amount: String(c.amount), settlement_amount: c.settlement_amount ? String(c.settlement_amount) : '', resolution: c.resolution ?? '' });
  return (
    <Modal open onClose={onClose} title={`Claim ${c.number}`} description={c.description} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={async () => { try { await api.patch(`/fulfilment/claims/${c.id}`, { status: v.status, amount: Number(v.amount || 0), settlement_amount: v.settlement_amount ? Number(v.settlement_amount) : null, resolution: v.resolution || null }); onDone(); } catch (e) { toast({ tone: 'error', title: (e as Error).message }); } }}>Save</Button></>}>
      <div className="grid grid-cols-2 gap-3">
        <Select label="Status" value={v.status} onChange={(e) => setV({ ...v, status: e.target.value })} options={['open', 'filed', 'settled', 'rejected', 'closed'].map((x) => ({ value: x, label: humanize(x) }))} />
        <Input label="Claim amount" type="number" prefix="₹" value={v.amount} onChange={(e) => setV({ ...v, amount: e.target.value })} />
        <Input label="Settled for" type="number" prefix="₹" value={v.settlement_amount} onChange={(e) => setV({ ...v, settlement_amount: e.target.value })} />
        <Textarea className="col-span-2" label="Resolution" value={v.resolution} onChange={(e) => setV({ ...v, resolution: e.target.value })} />
      </div>
    </Modal>
  );
}

// ---------- returns ----------
interface RetRow { id: string; number: string; order_no: string; customer_name: string; reason: string; status: string; source: string; resolution: string | null; credit_note_no: string | null; credit_total: number | null; rolls: number; kg: number; created_at: string }
export function ReturnsPage() {
  const nav = useNavigate();
  const q = useQuery({ queryKey: ['ful-returns'], queryFn: () => api.get<RetRow[]>('/fulfilment/returns') });
  return (
    <>
      <PageHeader title="Returns (RMA)" description="Request → authorise → receive the rolls into stock → QC disposition (restock, hold, reject) → credit note to the customer’s advance or replacement. Every roll keeps its original barcode." breadcrumbs={[{ label: 'Fulfilment', to: '/fulfilment' }, { label: 'Returns' }]} />
      <Card padded={false}>
        {!q.data ? <Skeleton className="m-5 h-40" /> : (
          <SimpleTable rows={q.data} rowKey={(r) => r.id} onRowClick={(r) => nav(`/fulfilment/returns/${r.id}`)} empty={<EmptyState icon={<XCircle className="size-5" />} title="No returns" />} columns={[
            { key: 'n', header: 'RMA', render: (r) => <span className="font-mono text-[12.5px] font-semibold">{r.number}<span className="block font-sans text-[12px] text-slate-500">{r.order_no} · {r.source === 'customer_portal' ? 'portal' : 'internal'}</span></span> },
            { key: 'c', header: 'Customer', render: (r) => r.customer_name },
            { key: 'r', header: 'Reason', render: (r) => <span className="text-[12.5px]">{r.reason}</span> },
            { key: 'k', header: 'Rolls', align: 'right', render: (r) => `${r.rolls} · ${fmtNum(r.kg)} kg` },
            { key: 'o', header: 'Outcome', render: (r) => (r.credit_note_no ? <span className="text-[12.5px]">{r.credit_note_no} · {fmtINR(Number(r.credit_total))}</span> : r.resolution ? humanize(r.resolution) : '—') },
            { key: 's', header: 'Status', render: (r) => <StatusBadge status={r.status} /> },
          ]} />
        )}
      </Card>
    </>
  );
}

interface RetD extends RetRow { fulfilment_id: string; invoice_no: string; warehouse_id: string; shipped_from: string; authorized_by_name: string | null; decision_note: string | null; received_at: string | null; credit_taxable: number | null; credit_tax: number | null; lines: { id: string; barcode: string; sku: string; kg: number; price_per_kg: number; gst_rate: number; received: boolean; disposition: string | null }[] }
export function ReturnDetailPage() {
  const { id = '' } = useParams();
  const { can } = useAuth();
  const toast = useToast();
  const q = useQuery({ queryKey: ['ful-return', id], queryFn: () => api.get<RetD>(`/fulfilment/returns/${id}`) });
  const [disp, setDisp] = useState<Record<string, string>>({});
  if (q.isError) return <ErrorState error={q.error} />;
  const r = q.data;
  if (!r) return <Skeleton className="h-96" />;
  const manage = can('fulfilment.returns.manage');
  const post = async (path: string, body: object, msg: string) => { try { await api.post(`/fulfilment/returns/${id}/${path}`, body); toast({ tone: 'success', title: msg }); q.refetch(); } catch (e) { toast({ tone: 'error', title: (e as Error).message }); } };
  const value = r.lines.reduce((s, l) => s + Number(l.kg) * Number(l.price_per_kg) * (1 + Number(l.gst_rate) / 100), 0);
  return (
    <>
      <PageHeader title={`Return ${r.number}`} description={`${r.customer_name} · ${r.order_no} · invoice ${r.invoice_no}`} meta={<StatusBadge status={r.status} />}
        breadcrumbs={[{ label: 'Fulfilment', to: '/fulfilment' }, { label: 'Returns', to: '/fulfilment/returns' }, { label: r.number }]}
        actions={manage && <>
          {r.status === 'requested' && <><Button variant="danger" onClick={() => { const note = prompt('Reason for rejecting'); if (note) void post('authorize', { approve: false, note }, 'Rejected'); }}>Reject</Button><Button variant="primary" onClick={() => void post('authorize', { approve: true }, 'Authorised')}>Authorise return</Button></>}
          {r.status === 'authorized' && <Button variant="primary" icon={<Package className="size-4" />} onClick={() => void post('receive', { warehouse_id: r.warehouse_id, barcodes: r.lines.map((l) => l.barcode) }, 'Received into stock (QC hold)')}>Receive all at {r.shipped_from.split(' · ')[0]}</Button>}
          {r.status === 'inspected' && <><Button onClick={() => void post('resolve', { resolution: 'replacement' }, 'Closed for replacement')}>Close for replacement</Button><Button variant="primary" onClick={() => void post('resolve', { resolution: 'credit_note' }, 'Credit note issued')}>Issue credit note ({fmtINR(value)})</Button></>}
        </>} />
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
        <Card title="Rolls" className="xl:col-span-2" padded={false}>
          <SimpleTable rows={r.lines} rowKey={(l) => l.id} columns={[
            { key: 'b', header: 'Roll', render: (l) => <span className="font-mono text-[12.5px]">{l.barcode}</span> },
            { key: 's', header: 'Fabric', render: (l) => l.sku },
            { key: 'k', header: 'KG', align: 'right', render: (l) => fmtNum(Number(l.kg)) },
            { key: 'v', header: 'Value incl. GST', align: 'right', render: (l) => fmtINR(Number(l.kg) * Number(l.price_per_kg) * (1 + Number(l.gst_rate) / 100)) },
            { key: 'r', header: 'Received', render: (l) => (l.received ? <CheckCircle2 className="size-4 text-emerald-600" /> : '—') },
            { key: 'd', header: 'Disposition', render: (l) => (r.status === 'received' && manage && l.received ? <select className="input h-8 w-32" value={disp[l.barcode] ?? ''} onChange={(e) => setDisp({ ...disp, [l.barcode]: e.target.value })}><option value="">Choose…</option><option value="restock">Restock (grade A)</option><option value="hold">Hold</option><option value="reject">Reject</option></select> : l.disposition ? humanize(l.disposition) : '—') },
          ]} />
          {r.status === 'received' && manage && <div className="flex justify-end border-t border-slate-100 px-5 py-3"><Button variant="primary" icon={<Scale className="size-4" />} disabled={!r.lines.filter((l) => l.received).every((l) => disp[l.barcode])} onClick={() => void post('disposition', { lines: r.lines.filter((l) => l.received).map((l) => ({ barcode: l.barcode, disposition: disp[l.barcode] })) }, 'Disposition saved')}>Save QC disposition</Button></div>}
        </Card>
        <Card title="Details">
          <KeyValue columns={1} items={[{ label: 'Reason', value: r.reason }, { label: 'Requested', value: `${r.source === 'customer_portal' ? 'Customer portal' : 'Internal'} · ${fmtDateTime(r.created_at)}` }, { label: 'Authorised', value: r.authorized_by_name ? `${r.authorized_by_name}${r.decision_note ? ` — ${r.decision_note}` : ''}` : '—' }, { label: 'Received', value: fmtDateTime(r.received_at) },
            ...(r.credit_note_no ? [{ label: 'Credit note', value: `${r.credit_note_no} · ${fmtINR(Number(r.credit_total))} (taxable ${fmtINR(Number(r.credit_taxable))} + GST ${fmtINR(Number(r.credit_tax))})` }] : [])]} />
          {r.credit_note_no && <p className="mt-3 text-[12px] text-slate-500">Credited to the customer’s advance. To pay it back, refund from Commerce → Payments.</p>}
        </Card>
      </div>
    </>
  );
}

export { ArrowRight };
