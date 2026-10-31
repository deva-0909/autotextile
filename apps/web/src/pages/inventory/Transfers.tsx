import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, FileText, Plus, Trash2, Truck } from 'lucide-react';
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Link } from '../../components/AppLink';
import { api, invalidatePrefix } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { fmtDate, fmtDateTime, fmtINR, fmtNum, humanize } from '../../lib/format';
import { SimpleTable } from '../../components/DataTable';
import { ConfirmDialog, Modal, useToast } from '../../components/overlay';
import { Bar, ScanInput } from '../../components/scan';
import { useProducts, useWarehouses } from '../../components/business';
import { useForm } from '../../components/form';
import { Badge, Button, Card, EmptyState, ErrorState, Input, KeyValue, Notice, PageHeader, Segmented, Select, Skeleton, StatusBadge, Textarea } from '../../components/ui';

interface TransferRow { id: string; number: string; from_warehouse_name: string; to_warehouse_name: string; from_gstin: string; to_gstin: string; inter_gstin: boolean; document_type: string; document_no: string | null; status: string; reason: string | null; needed_by: string | null; requested_kg: number; dispatched_kg: number; received_kg: number; rolls: number; skus: string; created_by_name: string; created_at: string }
interface Transfer extends Omit<TransferRow, 'rolls'> { from_warehouse_id: string; to_warehouse_id: string; transporter_name: string | null; lr_number: string | null; vehicle_no: string | null; eway_bill_no: string | null; taxable_value: number; cgst: number; sgst: number; igst: number; approved_by_name: string | null; approved_at: string | null; dispatched_at: string | null; received_at: string | null; close_reason: string | null;
  lines: { id: string; sku: string; product_name: string; requested_kg: number; lot_no: string | null; dispatched_kg: number; received_kg: number; available_at_source: number; gst_rate: number | null; hsn_code: string | null }[];
  rolls: { roll_id: string; barcode: string; lot_no: string; sku: string; dispatched_kg: number; received_kg: number | null; value: number; status: string; state: string }[] }

const OPEN = ['requested', 'pending_approval', 'approved', 'in_transit', 'partially_received'];

export function TransfersPage() {
  const nav = useNavigate();
  const { can } = useAuth();
  const [view, setView] = useState<'open' | 'all'>('open');
  const [creating, setCreating] = useState(false);
  const q = useQuery({ queryKey: ['inv-transfers', view], queryFn: () => api.get<TransferRow[]>(`/inventory/transfers${view === 'open' ? `?status=${OPEN.join(',')}` : ''}`) });
  return (
    <>
      <PageHeader title="Warehouse transfers" description="Request, approve, scan onto the vehicle, dispatch on the right GST document, scan in at the destination and close. Transfers between different GSTINs are taxable supplies and always need approval."
        breadcrumbs={[{ label: 'Inventory', to: '/inventory' }, { label: 'Transfers' }]} actions={can('inventory.transfer.request') && <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>Request transfer</Button>} />
      <div className="mb-4"><Segmented value={view} onChange={setView} options={[{ value: 'open', label: 'Open' }, { value: 'all', label: 'All' }]} /></div>
      <Card padded={false}>
        {q.isError ? <ErrorState error={q.error} /> : !q.data ? <Skeleton className="m-5 h-40" /> : (
          <SimpleTable rows={q.data} rowKey={(r) => r.id} onRowClick={(r) => nav(`/inventory/transfers/${r.id}`)} empty={<EmptyState icon={<Truck className="size-5" />} title="No transfers" />} columns={[
            { key: 'n', header: 'Transfer', render: (r) => <div><p className="font-mono text-[12.5px] font-semibold text-slate-900">{r.number}</p><p className="text-[12px] text-slate-500">{fmtDate(r.created_at)} · {r.created_by_name}</p></div> },
            { key: 'r', header: 'Route', render: (r) => <span className="flex items-center gap-1.5 text-[13px]">{r.from_warehouse_name.split(' · ')[0]}<ArrowRight className="size-3.5 text-slate-400" />{r.to_warehouse_name.split(' · ')[0]}</span> },
            { key: 'g', header: 'GST', render: (r) => (r.inter_gstin ? <Badge tone="violet">Between GSTINs · {r.document_type === 'tax_invoice' ? 'tax invoice' : 'challan'}</Badge> : <Badge>Same GSTIN · challan</Badge>) },
            { key: 'sku', header: 'Fabric', render: (r) => <span className="font-mono text-[12.5px]">{r.skus}</span> },
            { key: 'kg', header: 'KG', align: 'right', render: (r) => <span>{fmtNum(r.requested_kg)}{Number(r.dispatched_kg) > 0 && <span className="block text-[11.5px] text-slate-500">{fmtNum(Number(r.dispatched_kg))} sent · {fmtNum(Number(r.received_kg))} in</span>}</span> },
            { key: 'd', header: 'Document', render: (r) => <span className="font-mono text-[12px]">{r.document_no ?? '—'}</span> },
            { key: 's', header: 'Status', render: (r) => <StatusBadge status={r.status} /> },
          ]} />
        )}
      </Card>
      {creating && <NewTransferModal onClose={() => setCreating(false)} onDone={(id) => nav(`/inventory/transfers/${id}`)} />}
    </>
  );
}

function NewTransferModal({ onClose, onDone }: { onClose: () => void; onDone: (id: string) => void }) {
  const wh = useWarehouses();
  const prods = useProducts();
  const f = useForm({ from_warehouse_id: '', to_warehouse_id: '', reason: '', needed_by: '' });
  const [lines, setLines] = useState([{ product_id: '', requested_kg: '' }]);
  const [busy, setBusy] = useState(false);
  const from = wh.data?.find((w) => w.id === f.values.from_warehouse_id);
  const to = wh.data?.find((w) => w.id === f.values.to_warehouse_id);
  const inter = from && to && from.gst_registration_id !== to.gst_registration_id;
  return (
    <Modal open onClose={onClose} size="lg" title="Request a transfer" footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} onClick={async () => {
      setBusy(true);
      try {
        const r = await api.post<{ id: string }>('/inventory/transfers', { ...f.values, needed_by: f.values.needed_by || null, lines: lines.filter((l) => l.product_id).map((l) => ({ product_id: l.product_id, requested_kg: Number(l.requested_kg) })) });
        onDone(r.id);
      } catch (e) { f.handleError(e); } finally { setBusy(false); }
    }}>Submit request</Button></>}>
      <div className="space-y-4">
        {f.formError && <Notice tone="danger">{f.formError}</Notice>}
        <div className="grid grid-cols-2 gap-3">
          <Select label="From" required {...f.bind('from_warehouse_id')} options={[{ value: '', label: 'Choose…' }, ...(wh.data ?? []).map((w) => ({ value: w.id, label: `${w.code} · ${w.name}` }))]} />
          <Select label="To" required {...f.bind('to_warehouse_id')} options={[{ value: '', label: 'Choose…' }, ...(wh.data ?? []).filter((w) => w.id !== f.values.from_warehouse_id).map((w) => ({ value: w.id, label: `${w.code} · ${w.name}` }))]} />
        </div>
        {from && to && (inter
          ? <Notice tone="warning" title="Between different GST registrations">{from.gstin} → {to.gstin}. This is a taxable supply: it needs approval and goes on a tax invoice (as configured with the CA), not a stock adjustment.</Notice>
          : <Notice tone="info">Same GSTIN ({from.gstin}): moves on a delivery challan.</Notice>)}
        <div className="space-y-2">
          <p className="text-[12.5px] font-medium text-slate-700">Fabric</p>
          {lines.map((l, i) => (
            <div key={i} className="flex gap-2">
              <select className="input flex-1" value={l.product_id} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, product_id: e.target.value } : x)))}><option value="">Choose…</option>{(prods.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.sku} · {p.name}</option>)}</select>
              <input className="input w-32" type="number" placeholder="KG" value={l.requested_kg} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, requested_kg: e.target.value } : x)))} />
              {lines.length > 1 && <Button variant="ghost" icon={<Trash2 className="size-4" />} onClick={() => setLines(lines.filter((_, j) => j !== i))} aria-label="Remove" />}
            </div>
          ))}
          <Button size="sm" variant="ghost" icon={<Plus className="size-3.5" />} onClick={() => setLines([...lines, { product_id: '', requested_kg: '' }])}>Add fabric</Button>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Textarea className="col-span-2" label="Reason" required {...f.bind('reason')} />
          <Input label="Needed by" type="date" {...f.bind('needed_by')} />
        </div>
      </div>
    </Modal>
  );
}

export function TransferDetailPage() {
  const { id = '' } = useParams();
  const { can, user } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['inv-transfer', id], queryFn: () => api.get<Transfer>(`/inventory/transfers/${id}`) });
  const [modal, setModal] = useState<'dispatch' | 'close' | 'cancel' | null>(null);
  const [weigh, setWeigh] = useState('');
  if (q.isError) return <ErrorState error={q.error} />;
  const t = q.data;
  if (!t) return <Skeleton className="h-96" />;
  const refresh = () => { q.refetch(); invalidatePrefix(qc, 'inv'); };
  const exec = can('inventory.transfer.execute');
  const inScope = (w: string) => user?.scope.warehouse === '*' || (Array.isArray(user?.scope.warehouse) && user!.scope.warehouse.includes(w));
  const loaded = t.rolls.reduce((s, r) => s + Number(r.dispatched_kg), 0);
  const requested = t.lines.reduce((s, l) => s + Number(l.requested_kg), 0);
  const steps = ['Requested', 'Approved', 'In transit', 'Received', 'Closed'];
  const at = { requested: 0, pending_approval: 0, approved: 1, rejected: 1, in_transit: 2, partially_received: 2, received: 3, closed: 4, cancelled: 0 }[t.status] ?? 0;
  return (
    <>
      <PageHeader title={t.number} description={<span className="flex items-center gap-1.5">{t.from_warehouse_name}<ArrowRight className="size-3.5" />{t.to_warehouse_name}</span>} meta={<StatusBadge status={t.status} />}
        breadcrumbs={[{ label: 'Inventory', to: '/inventory' }, { label: 'Transfers', to: '/inventory/transfers' }, { label: t.number }]}
        actions={<>
          {t.status === 'approved' && exec && inScope(t.from_warehouse_id) && <Button variant="primary" icon={<Truck className="size-4" />} disabled={!t.rolls.length} onClick={() => setModal('dispatch')}>Confirm dispatch</Button>}
          {['in_transit', 'partially_received', 'received'].includes(t.status) && exec && <Button onClick={() => setModal('close')}>Close transfer</Button>}
          {['requested', 'pending_approval', 'approved', 'rejected'].includes(t.status) && can('inventory.transfer.request') && <Button variant="ghost" onClick={() => setModal('cancel')}>Cancel</Button>}
        </>} />
      <div className="mb-6 flex items-center gap-2">
        {steps.map((s, i) => (
          <div key={s} className="flex flex-1 items-center gap-2">
            <div className={`flex size-6 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold ${i <= at && t.status !== 'cancelled' && t.status !== 'rejected' ? 'bg-brand-600 text-white' : 'bg-slate-200 text-slate-500'}`}>{i + 1}</div>
            <span className="text-[12.5px] text-slate-700">{s}</span>
            {i < steps.length - 1 && <div className="h-px flex-1 bg-slate-200" />}
          </div>
        ))}
      </div>
      {t.status === 'pending_approval' && <div className="mb-5"><Notice tone="warning">Waiting for approval in the <Link className="link" to="/approvals">Approvals inbox</Link>.</Notice></div>}
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
        <div className="space-y-6 xl:col-span-2">
          {t.status === 'approved' && exec && inScope(t.from_warehouse_id) && (
            <Card title="Load the vehicle" description={`Scan each roll as it is loaded. ${fmtNum(Math.round(loaded * 10) / 10)} of ${fmtNum(requested)} kg loaded.`}>
              <Bar value={loaded} max={requested} className="mb-4" tone={loaded >= requested * 0.98 ? 'success' : 'brand'} />
              <ScanInput onScan={async (code) => {
                const r = await api.post<{ barcode: string; kg: number; sku: string; loaded_kg: number; requested_kg: number }>(`/inventory/transfers/${id}/scan-out`, { barcode: code });
                refresh();
                return { ok: true, title: `${r.sku} · ${fmtNum(r.kg)} kg loaded`, detail: `${fmtNum(r.loaded_kg)} of ${fmtNum(r.requested_kg)} kg for this fabric` };
              }} />
            </Card>
          )}
          {['in_transit', 'partially_received'].includes(t.status) && exec && inScope(t.to_warehouse_id) && (
            <Card title={`Receive at ${t.to_warehouse_name}`} description="Scan each roll off the vehicle. Re-weigh to record a difference; rolls that never arrive are written off when you close.">
              <ScanInput extra={<input className="input h-11 w-28" type="number" placeholder="Re-weigh kg" value={weigh} onChange={(e) => setWeigh(e.target.value)} />} onScan={async (code) => {
                const r = await api.post<{ barcode: string; kg: number; weight_difference: number; remaining_rolls: number }>(`/inventory/transfers/${id}/scan-in`, { barcode: code, weight_kg: weigh ? Number(weigh) : null });
                setWeigh(''); refresh();
                return { ok: true, title: `${fmtNum(r.kg)} kg received${r.weight_difference ? ` (${r.weight_difference > 0 ? '+' : ''}${r.weight_difference} kg)` : ''}`, detail: `${r.remaining_rolls} roll(s) still to scan` };
              }} />
            </Card>
          )}
          <Card title="Fabric" padded={false}>
            <SimpleTable rows={t.lines} rowKey={(l) => l.id} columns={[
              { key: 's', header: 'Fabric', render: (l) => <div><p className="font-mono text-[12.5px] font-semibold">{l.sku}</p><p className="text-[12px] text-slate-500">{l.lot_no ? `Lot ${l.lot_no}` : 'Any lot'} · HSN {l.hsn_code ?? '—'} · {l.gst_rate ?? '—'}% GST</p></div> },
              { key: 'r', header: 'Requested', align: 'right', render: (l) => fmtNum(Number(l.requested_kg)) },
              { key: 'a', header: 'Available at source', align: 'right', render: (l) => fmtNum(Number(l.available_at_source)) },
              { key: 'd', header: 'Dispatched', align: 'right', render: (l) => fmtNum(Number(l.dispatched_kg)) },
              { key: 'rc', header: 'Received', align: 'right', render: (l) => fmtNum(Number(l.received_kg)) },
            ]} />
          </Card>
          <Card title={`Rolls (${t.rolls.length})`} padded={false}>
            <SimpleTable rows={t.rolls} rowKey={(r) => r.roll_id} empty={<EmptyState title="No rolls loaded yet" />} columns={[
              { key: 'b', header: 'Barcode', render: (r) => <span className="font-mono text-[12.5px]">{r.barcode}</span> },
              { key: 's', header: 'Fabric', render: (r) => <span className="text-[12.5px]">{r.sku} · {r.lot_no}</span> },
              { key: 'd', header: 'Sent kg', align: 'right', render: (r) => fmtNum(Number(r.dispatched_kg)) },
              { key: 'rc', header: 'Received kg', align: 'right', render: (r) => (r.received_kg === null ? '—' : <span className={Math.abs(Number(r.received_kg) - Number(r.dispatched_kg)) > 0.5 ? 'font-semibold text-amber-700' : ''}>{fmtNum(Number(r.received_kg))}</span>) },
              { key: 'v', header: 'Value', align: 'right', render: (r) => fmtINR(Number(r.value)) },
              { key: 'st', header: 'Status', render: (r) => <StatusBadge status={r.status === 'dispatched' ? 'in_transit' : r.status} /> },
              { key: 'x', header: '', align: 'right', render: (r) => (t.status === 'approved' && exec ? <Button size="sm" variant="ghost" onClick={async () => { try { await api.post(`/inventory/transfers/${id}/unload`, { barcode: r.barcode }); refresh(); } catch (e) { toast({ tone: 'error', title: (e as Error).message }); } }}>Unload</Button> : null) },
            ]} />
          </Card>
        </div>
        <div className="space-y-6">
          <Card title="GST document" actions={<FileText className="size-4 text-slate-400" />}>
            <KeyValue columns={1} items={[
              { label: 'Treatment', value: t.inter_gstin ? 'Supply between distinct GST registrations' : 'Same GST registration' },
              { label: 'From → to GSTIN', value: <span className="font-mono text-[12.5px]">{t.from_gstin} → {t.to_gstin}</span> },
              { label: 'Document', value: <span>{t.document_type === 'tax_invoice' ? 'Tax invoice' : 'Delivery challan'}{t.document_no && <span className="ml-1.5 font-mono font-semibold">{t.document_no}</span>}</span> },
              ...(t.document_no ? [
                { label: 'Taxable value (at cost)', value: fmtINR(Number(t.taxable_value)) },
                { label: 'Tax', value: Number(t.igst) ? `IGST ${fmtINR(Number(t.igst))}` : Number(t.cgst) ? `CGST ${fmtINR(Number(t.cgst))} + SGST ${fmtINR(Number(t.sgst))}` : 'Nil (challan)' },
              ] : []),
            ]} />
            {t.inter_gstin && <p className="mt-3 text-[12px] text-slate-500">Valuation and document type follow the CA-approved configuration. Accounting (P8) books this supply from the dispatch event.</p>}
          </Card>
          <Card title="Movement">
            <KeyValue columns={1} items={[
              { label: 'Reason', value: t.reason }, { label: 'Needed by', value: fmtDate(t.needed_by) }, { label: 'Requested', value: `${t.created_by_name} · ${fmtDateTime(t.created_at)}` },
              { label: 'Approved', value: t.approved_by_name ? `${t.approved_by_name} · ${fmtDateTime(t.approved_at)}` : t.inter_gstin || t.status !== 'approved' ? '—' : 'Not required (same GSTIN)' },
              { label: 'Transport', value: t.transporter_name ? `${t.transporter_name}${t.lr_number ? ` · LR ${t.lr_number}` : ''}${t.vehicle_no ? ` · ${t.vehicle_no}` : ''}` : '—' },
              { label: 'E-way bill', value: t.eway_bill_no ?? '—' }, { label: 'Dispatched', value: fmtDateTime(t.dispatched_at) }, { label: 'Received', value: fmtDateTime(t.received_at) },
              ...(t.close_reason ? [{ label: 'Closing note', value: t.close_reason }] : []),
            ]} />
          </Card>
        </div>
      </div>
      {modal === 'dispatch' && <DispatchModal t={t} kg={loaded} onClose={() => setModal(null)} onDone={() => { setModal(null); refresh(); }} />}
      <ConfirmDialog open={modal === 'close'} onClose={() => setModal(null)} title={`Close ${t.number}`} description={t.rolls.some((r) => r.status === 'dispatched') ? `${t.rolls.filter((r) => r.status === 'dispatched').length} roll(s) were not received; they will be written off and flagged.` : 'All rolls are received.'}
        requireReason={t.rolls.some((r) => r.status === 'dispatched')} confirmLabel="Close"
        onConfirm={async (reason) => { try { await api.post(`/inventory/transfers/${id}/close`, { reason: reason || null }); setModal(null); refresh(); } catch (e) { toast({ tone: 'error', title: (e as Error).message }); } }} />
      <ConfirmDialog open={modal === 'cancel'} onClose={() => setModal(null)} title={`Cancel ${t.number}`} requireReason tone="danger" confirmLabel="Cancel transfer"
        onConfirm={async (reason) => { try { await api.post(`/inventory/transfers/${id}/cancel`, { reason }); setModal(null); refresh(); } catch (e) { toast({ tone: 'error', title: (e as Error).message }); } }} />
    </>
  );
}

function DispatchModal({ t, kg, onClose, onDone }: { t: Transfer; kg: number; onClose: () => void; onDone: () => void }) {
  const f = useForm({ transporter_name: '', lr_number: '', vehicle_no: '', eway_bill_no: '' });
  const [busy, setBusy] = useState(false);
  const value = t.rolls.reduce((s, r) => s + Number(r.value), 0);
  return (
    <Modal open onClose={onClose} title={`Dispatch ${t.number}`} description={`${t.rolls.length} rolls · ${fmtNum(Math.round(kg * 10) / 10)} kg · value at cost ${fmtINR(value)}. Issues the ${t.document_type === 'tax_invoice' ? 'tax invoice' : 'delivery challan'} from the ${t.from_warehouse_name.split(' · ')[0]} GSTIN series.`}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} onClick={async () => {
        setBusy(true);
        try { await api.post(`/inventory/transfers/${t.id}/dispatch`, Object.fromEntries(Object.entries(f.values).map(([k, v]) => [k, v || null]))); onDone(); } catch (e) { f.handleError(e); } finally { setBusy(false); }
      }}>Dispatch</Button></>}>
      <div className="grid grid-cols-2 gap-3">
        {f.formError && <div className="col-span-2"><Notice tone="danger">{f.formError}</Notice></div>}
        <Input className="col-span-2" label="Transporter" required {...f.bind('transporter_name')} />
        <Input label="LR number" {...f.bind('lr_number')} />
        <Input label="Vehicle number" {...f.bind('vehicle_no')} />
        <Input className="col-span-2" label="E-way bill number" {...f.bind('eway_bill_no')} hint="Required above the configured consignment value (₹50,000 by default)" />
      </div>
    </Modal>
  );
}

export { humanize };
