import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, PackageOpen, Plus, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, invalidatePrefix } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { fmtDate, fmtDateTime, fmtNum, humanize } from '../../lib/format';
import { SimpleTable } from '../../components/DataTable';
import { ConfirmDialog, Modal, useToast } from '../../components/overlay';
import { Bar, PrintLabels, RollLabel, type LabelRoll } from '../../components/scan';
import { useProducts, useWarehouses } from '../../components/business';
import { useForm } from '../../components/form';
import { Badge, Button, Card, EmptyState, ErrorState, Input, KeyValue, Notice, PageHeader, Segmented, Select, Skeleton, StatusBadge, Textarea } from '../../components/ui';

interface InwardRow { id: string; number: string; source_type: string; source_ref: string; party_name: string | null; warehouse_name: string; status: string; expected_date: string; expected_kg: number; weighed_kg: number; rolls_scanned: number; skus: string; created_at: string }
interface Line { id: string; line_no: number; product_id: string; sku: string; product_name: string; expected_kg: number; expected_rolls: number | null; cost_per_kg: number | null; lot_ref: string | null; lot_id: string | null; lot_no: string | null; qc_status: string | null; weighed_kg: number; rolls_scanned: number }
interface RollRow { id: string; barcode: string; roll_no: number; weight_kg: number; state: string; gsm: number | null; width_in: number | null; shade_code: string | null; dye_lot: string | null; grade: string | null; location_path: string | null; lot_no: string; lot_id: string; line_id: string; created_at: string }
interface Inward { id: string; number: string; source_type: string; source_ref: string; party_name: string | null; warehouse_id: string; warehouse_name: string; status: string; expected_date: string; notes: string | null; completed_at: string | null; completed_by_name: string | null; lines: Line[]; rolls: RollRow[] }

const SOURCE: Record<string, string> = { po_receipt: 'Purchase receipt', job_return: 'Mill return', opening: 'Opening / manual' };

export function InwardsPage() {
  const nav = useNavigate();
  const { can } = useAuth();
  const [status, setStatus] = useState<'open' | 'completed'>('open');
  const [creating, setCreating] = useState(false);
  const q = useQuery({ queryKey: ['inwards', status], queryFn: () => api.get<InwardRow[]>(`/inventory/inwards?status=${status}`) });
  return (
    <>
      <PageHeader title="Inward" description="Goods receipts and mill returns arrive here automatically. Weigh each roll, scan it in and print its label; differences against the document are flagged."
        breadcrumbs={[{ label: 'Inventory', to: '/inventory' }, { label: 'Inward' }]}
        actions={can('inventory.inward.record') && <Button icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>Opening / manual inward</Button>} />
      <div className="mb-4"><Segmented value={status} onChange={setStatus} options={[{ value: 'open', label: 'To scan' }, { value: 'completed', label: 'Completed' }]} /></div>
      <Card padded={false}>
        {q.isError ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : !q.data ? <Skeleton className="m-5 h-40" /> : (
          <SimpleTable rows={q.data} rowKey={(r) => r.id} onRowClick={(r) => nav(`/inventory/inward/${r.id}`)} empty={<EmptyState icon={<PackageOpen className="size-5" />} title={status === 'open' ? 'Nothing waiting to be scanned' : 'No completed inwards'} />}
            columns={[
              { key: 'n', header: 'Inward', render: (r) => <div><p className="font-mono text-[12.5px] font-semibold text-slate-900">{r.number}</p><p className="text-[12px] text-slate-500">{fmtDate(r.expected_date)}</p></div> },
              { key: 's', header: 'Source', render: (r) => <div><Badge tone={r.source_type === 'job_return' ? 'violet' : r.source_type === 'po_receipt' ? 'brand' : 'neutral'}>{SOURCE[r.source_type]}</Badge><p className="mt-0.5 text-[12px] text-slate-500">{r.source_ref}{r.party_name ? ` · ${r.party_name}` : ''}</p></div> },
              { key: 'w', header: 'Warehouse', render: (r) => r.warehouse_name },
              { key: 'sku', header: 'Fabric', render: (r) => <span className="font-mono text-[12.5px]">{r.skus}</span> },
              { key: 'p', header: 'Weighed / expected', render: (r) => <div className="w-44"><div className="mb-1 flex justify-between text-[12px] tabular"><span>{fmtNum(r.weighed_kg)} kg</span><span className="text-slate-500">{fmtNum(r.expected_kg)} kg</span></div><Bar value={r.weighed_kg} max={r.expected_kg} tone={r.status === 'completed' ? 'success' : 'brand'} /></div> },
              { key: 'r', header: 'Rolls', align: 'right', render: (r) => r.rolls_scanned },
              { key: 'st', header: 'Status', render: (r) => <StatusBadge status={r.status} /> },
            ]} />
        )}
      </Card>
      {creating && <NewInwardModal onClose={() => setCreating(false)} onDone={(id) => nav(`/inventory/inward/${id}`)} />}
    </>
  );
}

function NewInwardModal({ onClose, onDone }: { onClose: () => void; onDone: (id: string) => void }) {
  const wh = useWarehouses();
  const prods = useProducts();
  const f = useForm({ warehouse_id: '', source_ref: '', party_name: '', received_date: '', product_id: '', expected_kg: '', cost_per_kg: '', lot_ref: '' });
  const [busy, setBusy] = useState(false);
  return (
    <Modal open onClose={onClose} title="Opening or manual inward" description="For opening stock and receipts that do not come from a purchase order or a mill (e.g. a customer return). Purchase and mill receipts arrive on their own."
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} onClick={async () => {
        setBusy(true);
        try {
          const v = f.values;
          const r = await api.post<{ id: string }>('/inventory/inwards', { warehouse_id: v.warehouse_id, source_ref: v.source_ref, party_name: v.party_name || null, received_date: v.received_date || null, lines: [{ product_id: v.product_id, expected_kg: Number(v.expected_kg), cost_per_kg: v.cost_per_kg ? Number(v.cost_per_kg) : null, lot_ref: v.lot_ref || null }] });
          onDone(r.id);
        } catch (e) { f.handleError(e); } finally { setBusy(false); }
      }}>Create inward</Button></>}>
      <div className="grid grid-cols-2 gap-3">
        {f.formError && <div className="col-span-2"><Notice tone="danger">{f.formError}</Notice></div>}
        <Select label="Warehouse" required {...f.bind('warehouse_id')} options={[{ value: '', label: 'Choose…' }, ...(wh.data ?? []).map((w) => ({ value: w.id, label: `${w.code} · ${w.name}` }))]} />
        <Input label="Reference" required placeholder="e.g. OPENING/2026" {...f.bind('source_ref')} />
        <Input label="From (party)" placeholder="Optional" {...f.bind('party_name')} />
        <Input label="Originally received on" type="date" hint="Keeps ageing correct for opening stock" {...f.bind('received_date')} />
        <Select className="col-span-2" label="Fabric" required {...f.bind('product_id')} options={[{ value: '', label: 'Choose…' }, ...(prods.data ?? []).map((p) => ({ value: p.id, label: `${p.sku} · ${p.name}` }))]} />
        <Input label="Expected kg" type="number" required {...f.bind('expected_kg')} />
        <Input label="Cost per kg" type="number" prefix="₹" {...f.bind('cost_per_kg')} />
        <Input label="Supplier / dye lot reference" {...f.bind('lot_ref')} />
      </div>
    </Modal>
  );
}

export function InwardDetailPage() {
  const { id = '' } = useParams();
  const { can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['inward', id], queryFn: () => api.get<Inward>(`/inventory/inwards/${id}`) });
  const [lineId, setLineId] = useState('');
  const [w, setW] = useState({ weight_kg: '', gsm: '', width_in: '', shade_code: '', dye_lot: '' });
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState<LabelRoll | null>(null);
  const [completing, setCompleting] = useState(false);
  const [voiding, setVoiding] = useState<RollRow | null>(null);
  const i = q.data;
  useEffect(() => { if (i && !lineId) setLineId(i.lines.find((l) => l.weighed_kg < l.expected_kg)?.id ?? i.lines[0]?.id ?? ''); }, [i, lineId]);
  const line = i?.lines.find((l) => l.id === lineId);
  const totals = useMemo(() => i ? { exp: i.lines.reduce((s, l) => s + Number(l.expected_kg), 0), got: i.lines.reduce((s, l) => s + Number(l.weighed_kg), 0) } : null, [i]);
  if (q.isError) return <ErrorState error={q.error} />;
  if (!i) return <Skeleton className="h-96" />;
  const open = i.status === 'open' && can('inventory.inward.record');
  const refresh = () => { q.refetch(); invalidatePrefix(qc, 'inv'); };

  async function scan() {
    if (!line || !w.weight_kg) return;
    setBusy(true);
    try {
      const r = await api.post<LabelRoll & { lot_no: string }>(`/inventory/inwards/${id}/rolls`, { line_id: line.id, weight_kg: Number(w.weight_kg), gsm: w.gsm ? Number(w.gsm) : null, width_in: w.width_in ? Number(w.width_in) : null, shade_code: w.shade_code || null, dye_lot: w.dye_lot || null });
      setLast(r);
      setW({ ...w, weight_kg: '' });
      refresh();
    } catch (e) { toast({ tone: 'error', title: (e as Error).message }); } finally { setBusy(false); }
  }

  return (
    <>
      <PageHeader title={`${i.number} · ${SOURCE[i.source_type]}`} description={`${i.source_ref}${i.party_name ? ` · ${i.party_name}` : ''} → ${i.warehouse_name}`} meta={<StatusBadge status={i.status} />}
        breadcrumbs={[{ label: 'Inventory', to: '/inventory' }, { label: 'Inward', to: '/inventory/inward' }, { label: i.number }]}
        actions={<>
          <PrintLabels rolls={i.rolls.filter((r) => r.state !== 'written_off').map((r) => ({ ...r, sku: i.lines.find((l) => l.id === r.line_id)?.sku, product_name: i.lines.find((l) => l.id === r.line_id)?.product_name }))}>Print all labels</PrintLabels>
          {open && <Button variant="primary" icon={<CheckCircle2 className="size-4" />} onClick={() => setCompleting(true)}>Complete inward</Button>}
        </>} />
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
        <div className="space-y-6 xl:col-span-2">
          <Card title="Lines" description={totals ? `${fmtNum(totals.got)} of ${fmtNum(totals.exp)} kg weighed` : undefined} padded={false}>
            <SimpleTable rows={i.lines} rowKey={(l) => l.id} onRowClick={open ? (l) => setLineId(l.id) : undefined} columns={[
              { key: 'p', header: 'Fabric', render: (l) => <div className={l.id === lineId && open ? 'border-l-2 border-brand-500 pl-2' : ''}><p className="font-mono text-[12.5px] font-semibold">{l.sku}</p><p className="text-[12px] text-slate-500">{l.product_name}</p></div> },
              { key: 'lot', header: 'Lot', render: (l) => (l.lot_id ? <Link className="link font-mono text-[12.5px]" to={`/inventory/lots/${l.lot_id}`} onClick={(e) => e.stopPropagation()}>{l.lot_no}</Link> : <span className="text-slate-400">created on first roll</span>) },
              { key: 'kg', header: 'Weighed / expected', render: (l) => <div className="w-48"><div className="mb-1 flex justify-between text-[12px] tabular"><span>{fmtNum(l.weighed_kg)} kg · {l.rolls_scanned} rolls</span><span className="text-slate-500">{fmtNum(l.expected_kg)}</span></div><Bar value={l.weighed_kg} max={l.expected_kg} tone={Math.abs(l.weighed_kg - l.expected_kg) / Math.max(1, l.expected_kg) <= 0.01 ? 'success' : 'brand'} /></div> },
              { key: 'c', header: 'Cost / kg', align: 'right', render: (l) => (l.cost_per_kg ? `₹${fmtNum(Number(l.cost_per_kg))}` : '—') },
              { key: 'q', header: 'QC', render: (l) => (l.qc_status ? <StatusBadge status={l.qc_status} /> : '—') },
            ]} />
          </Card>
          <Card title={`Rolls scanned (${i.rolls.length})`} padded={false}>
            <SimpleTable rows={i.rolls} rowKey={(r) => r.id} empty={<EmptyState title="No rolls yet" description="Weigh the first roll and scan it in." />} columns={[
              { key: 'b', header: 'Barcode', render: (r) => <span className="font-mono text-[12.5px] font-semibold">{r.barcode}</span> },
              { key: 'w', header: 'KG', align: 'right', render: (r) => fmtNum(Number(r.weight_kg)) },
              { key: 'spec', header: 'GSM / width', render: (r) => <span className="text-[12.5px] text-slate-600">{r.gsm ?? '—'} / {r.width_in ? `${r.width_in}"` : '—'}</span> },
              { key: 'sh', header: 'Dye lot / shade', render: (r) => <span className="text-[12.5px]">{r.dye_lot ?? '—'}{r.shade_code ? ` · ${r.shade_code}` : ''}</span> },
              { key: 'g', header: 'Grade', render: (r) => r.grade ?? '—' },
              { key: 's', header: 'State', render: (r) => <StatusBadge status={r.state} /> },
              { key: 'l', header: 'Location', render: (r) => <span className="font-mono text-[12px]">{r.location_path ?? '—'}</span> },
              { key: 'x', header: '', align: 'right', render: (r) => (open && ['qc_hold', 'available'].includes(r.state) ? <Button size="sm" variant="ghost" icon={<Trash2 className="size-3.5" />} onClick={() => setVoiding(r)}>Void</Button> : null) },
            ]} />
          </Card>
        </div>
        <div className="space-y-6">
          {open ? (
            <Card title="Weigh & scan" description="One roll at a time. Press Enter to save; a label is ready to print straight away.">
              <div className="space-y-3">
                <Select label="Line" value={lineId} onChange={(e) => setLineId(e.target.value)} options={i.lines.map((l) => ({ value: l.id, label: `${l.sku} · ${fmtNum(l.weighed_kg)}/${fmtNum(l.expected_kg)} kg` }))} />
                <Input label="Roll weight" type="number" step="0.1" suffix="kg" autoFocus required value={w.weight_kg} onChange={(e) => setW({ ...w, weight_kg: e.target.value })} onKeyDown={(e) => { if (e.key === 'Enter') void scan(); }} />
                <div className="grid grid-cols-2 gap-3">
                  <Input label="GSM" type="number" value={w.gsm} onChange={(e) => setW({ ...w, gsm: e.target.value })} />
                  <Input label="Width" type="number" suffix="in" value={w.width_in} onChange={(e) => setW({ ...w, width_in: e.target.value })} />
                  <Input label="Dye lot" placeholder={line?.lot_ref ?? ''} value={w.dye_lot} onChange={(e) => setW({ ...w, dye_lot: e.target.value })} />
                  <Input label="Shade" value={w.shade_code} onChange={(e) => setW({ ...w, shade_code: e.target.value })} />
                </div>
                <Button variant="primary" className="w-full" loading={busy} disabled={!w.weight_kg} onClick={() => void scan()}>Save roll</Button>
              </div>
            </Card>
          ) : (
            <Card title="Completed"><KeyValue columns={1} items={[{ label: 'By', value: i.completed_by_name }, { label: 'At', value: fmtDateTime(i.completed_at) }, { label: 'Note', value: i.notes }]} /></Card>
          )}
          {last && (
            <Card title="Last label" actions={<PrintLabels rolls={[last]}>Print</PrintLabels>}>
              <div className="origin-top-left scale-[0.85]"><RollLabel roll={last} /></div>
            </Card>
          )}
          <Notice tone="info">Rolls land in the receiving bay on <b>QC hold</b>. Grade them in <Link className="link" to="/inventory/qc">Quality inspection</Link>, then put them away.</Notice>
        </div>
      </div>
      {completing && <CompleteModal inward={i} totals={totals!} onClose={() => setCompleting(false)} onDone={() => { setCompleting(false); refresh(); }} />}
      <ConfirmDialog open={!!voiding} onClose={() => setVoiding(null)} title={`Void ${voiding?.barcode}?`} description="The roll is written off with your reason; the ledger keeps both entries." requireReason tone="danger" confirmLabel="Void roll"
        onConfirm={async (reason) => { try { await api.post(`/inventory/inwards/${id}/rolls/${voiding!.id}/void`, { reason }); setVoiding(null); refresh(); } catch (e) { toast({ tone: 'error', title: (e as Error).message }); } }} />
    </>
  );
}

function CompleteModal({ inward, totals, onClose, onDone }: { inward: Inward; totals: { exp: number; got: number }; onClose: () => void; onDone: () => void }) {
  const [note, setNote] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const diff = totals.got - totals.exp;
  return (
    <Modal open onClose={onClose} title={`Complete ${inward.number}`}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} onClick={async () => {
        setBusy(true);
        try { await api.post(`/inventory/inwards/${inward.id}/complete`, { note: note || null }); onDone(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
      }}>Complete</Button></>}>
      <div className="space-y-4">
        <KeyValue columns={3} items={[{ label: 'Document', value: `${fmtNum(totals.exp)} kg` }, { label: 'Weighed', value: `${fmtNum(totals.got)} kg` }, { label: 'Difference', value: <span className={Math.abs(diff) / Math.max(1, totals.exp) > 0.01 ? 'font-semibold text-rose-600' : ''}>{diff > 0 ? '+' : ''}{fmtNum(Math.round(diff * 10) / 10)} kg</span> }]} />
        {err && <Notice tone="danger">{err}</Notice>}
        <Textarea label="Note" value={note} onChange={(e) => setNote(e.target.value)} hint="Required when weighed kg differs from the document beyond the tolerance; the difference is raised as an exception for purchase." />
      </div>
    </Modal>
  );
}

export { SOURCE, humanize };
