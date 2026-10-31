import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Ban, CheckCheck, Lock, PackageCheck, Pencil, Plus, RotateCcw, Send, Truck } from 'lucide-react';
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Link } from '../../components/AppLink';
import { api, invalidatePrefix } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { fmtDate, fmtDateTime, fmtINR, fmtNum, humanize } from '../../lib/format';
import { DataTable, FilterSelect, SimpleTable } from '../../components/DataTable';
import { DeliverTo, LineEditor, emptyLine, linesPayload, useParties, type Line } from '../../components/business';
import { ConfirmDialog, Drawer, Modal, useToast } from '../../components/overlay';
import { DocumentsPanel } from '../../components/Documents';
import { AuditTimeline } from '../../components/AuditTrail';
import { Badge, Button, Card, ErrorState, Input, KeyValue, Notice, PageHeader, Progress, Select, Skeleton, StatusBadge, Tabs, Textarea, Timeline } from '../../components/ui';

interface PoRow { id: string; number: string; revision: number; supplier_name: string; deliver_to_type: string; deliver_to_name: string; order_date: string; expected_date: string; total_value: number; status: string; ordered_kg: number; received_kg: number; invoiced_kg: number }
interface PoLine { id: string; line_no: number; product_id: string; sku: string; product_name: string; hsn_code: string; qty_kg: number; rate_per_kg: number; gst_rate: number; taxable: number; tax: number; received_kg: number; rejected_kg: number; invoiced_kg: number }
export interface PoDetail extends PoRow {
  supplier_id: string; supplier_code: string; supplier_gstin: string | null; bill_to_gst_registration_id: string; bill_to_gstin: string; deliver_to_id: string; tax_type: string; taxable_value: number; tax_value: number;
  payment_term: string | null; payment_days: number; freight_terms: string | null; notes: string | null; approved_by_name: string | null; approved_at: string | null; sent_at: string | null;
  supplier_promise_date: string | null; supplier_remarks: string | null; supplier_response_at: string | null; created_by_name: string; version: number; rfq_id: string | null;
  lines: PoLine[]; events: { id: number; event: string; detail: string | null; actor_type: string; actor_name: string | null; at: string }[];
  dispatches: { id: string; dispatch_date: string; kg: number; rolls: number | null; lr_number: string | null; transporter_name: string | null; vehicle_no: string | null; eway_bill_no: string | null; reported_via: string; reported_by_name: string }[];
  receipts: { id: string; number: string; receipt_type: string; location_name: string; receipt_date: string; challan_no: string | null; source: string; recorded_by_name: string; lines: { po_line_id: string; sku: string; received_kg: number; rejected_kg: number; rolls: number | null; remarks: string | null }[] }[];
  invoices: { id: string; invoice_number: string; invoice_date: string; total_value: number; status: string; match_status: string; payment_status: string }[];
  revisions: { id: string; revision: number; reason: string; created_by_name: string; created_at: string }[];
  exceptions: { id: string; kind: string; severity: string; message: string }[];
}

const EVENT_TONE: Record<string, 'brand' | 'success' | 'warning' | 'danger' | 'neutral'> = { approved: 'success', accepted: 'success', received: 'success', received_at_mill: 'success', sent: 'brand', rejected_by_supplier: 'danger', approval_rejected: 'danger', cancelled: 'danger', revised: 'warning', dispatched: 'brand' };

export function PurchaseOrdersPage() {
  const { can } = useAuth();
  const nav = useNavigate();
  const suppliers = useParties('supplier,manufacturer');
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [creating, setCreating] = useState(false);
  return (
    <>
      <PageHeader title="Purchase orders" description="Approved POs are sent to the supplier portal for acceptance. Deliveries can go to a warehouse or directly to a processing mill." breadcrumbs={[{ label: 'Procurement', to: '/procurement' }, { label: 'Purchase orders' }]}
        actions={can('procurement.po.manage') && <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>New purchase order</Button>} />
      <DataTable<PoRow>
        id="purchase-orders" endpoint="/procurement/purchase-orders" filters={filters} onFiltersChange={setFilters} defaultSort={{ key: 'order_date', dir: 'desc' }} onRowClick={(r) => nav(`/procurement/purchase-orders/${r.id}`)}
        searchPlaceholder="Search PO number, supplier, destination…"
        toolbar={<>
          <FilterSelect placeholder="All statuses" value={filters.status} onChange={(v) => setFilters({ ...filters, status: v })} options={['draft', 'pending_approval', 'approved', 'sent', 'accepted', 'partially_received', 'received', 'closed', 'cancelled'].map((s) => ({ value: s, label: humanize(s) }))} />
          <FilterSelect placeholder="All suppliers" value={filters.supplier} onChange={(v) => setFilters({ ...filters, supplier: v })} options={suppliers.data?.map((s) => ({ value: s.id, label: s.legal_name })) ?? []} />
          <FilterSelect placeholder="Any destination" value={filters.deliverTo} onChange={(v) => setFilters({ ...filters, deliverTo: v })} options={[{ value: 'warehouse', label: 'Warehouse' }, { value: 'mill', label: 'Direct to mill' }]} />
        </>}
        columns={[
          { key: 'number', header: 'PO', sort: 'number', csv: (r) => r.number, render: (r) => <span className="font-mono text-[12.5px] font-semibold text-slate-900">{r.number}{r.revision ? <span className="ml-1 text-slate-400">r{r.revision}</span> : null}</span> },
          { key: 'supplier', header: 'Supplier', sort: 'supplier_name', csv: (r) => r.supplier_name, render: (r) => r.supplier_name },
          { key: 'dest', header: 'Deliver to', csv: (r) => r.deliver_to_name, render: (r) => <span className="flex items-center gap-1.5">{r.deliver_to_type === 'mill' && <Badge tone="violet">Mill</Badge>}{r.deliver_to_name}</span> },
          { key: 'date', header: 'Ordered', sort: 'order_date', csv: (r) => r.order_date, render: (r) => fmtDate(r.order_date) },
          { key: 'expected', header: 'Expected', sort: 'expected_date', csv: (r) => r.expected_date, render: (r) => <span className={new Date(r.expected_date) < new Date() && ['sent', 'accepted', 'partially_received'].includes(r.status) ? 'font-medium text-rose-600' : ''}>{fmtDate(r.expected_date)}</span> },
          { key: 'progress', header: 'Received', csv: (r) => r.received_kg, render: (r) => <Progress value={r.received_kg} max={r.ordered_kg} tone={r.received_kg >= r.ordered_kg ? 'success' : 'brand'} label={`${fmtNum(Math.round(r.received_kg))} / ${fmtNum(Math.round(r.ordered_kg))} kg`} /> },
          { key: 'value', header: 'Value', align: 'right', sort: 'total_value', csv: (r) => r.total_value, render: (r) => fmtINR(r.total_value) },
          { key: 'status', header: 'Status', sort: 'status', csv: (r) => r.status, render: (r) => <StatusBadge status={r.status} /> },
        ]}
        empty={{ title: 'No purchase orders yet' }}
      />
      {creating && <PoForm onClose={() => setCreating(false)} onSaved={(id) => nav(`/procurement/purchase-orders/${id}`)} />}
    </>
  );
}

function PoForm({ po, onClose, onSaved }: { po?: PoDetail; onClose: () => void; onSaved: (id: string) => void }) {
  const qc = useQueryClient();
  const suppliers = useParties('supplier,manufacturer');
  const gst = useQuery({ queryKey: ['gst-registrations'], queryFn: () => api.get<{ id: string; gstin: string; state_name: string; status: string }[]>('/organisation/gst-registrations') });
  const [supplier, setSupplier] = useState(po?.supplier_id ?? '');
  const [dest, setDest] = useState<{ type: 'warehouse' | 'mill'; id: string }>({ type: (po?.deliver_to_type as 'warehouse' | 'mill') ?? 'warehouse', id: po?.deliver_to_id ?? '' });
  const [billTo, setBillTo] = useState(po?.bill_to_gst_registration_id ?? '');
  const [expected, setExpected] = useState(po?.expected_date ?? '');
  const [freight, setFreight] = useState(po?.freight_terms ?? '');
  const [notes, setNotes] = useState(po?.notes ?? '');
  const [lines, setLines] = useState<Line[]>(po ? po.lines.map((l) => ({ product_id: l.product_id, qty_kg: String(l.qty_kg), rate: String(l.rate_per_kg) })) : [emptyLine()]);
  const [error, setError] = useState<{ message?: string; fields: Record<string, string> }>({ fields: {} });
  const [saving, setSaving] = useState(false);
  async function save() {
    setSaving(true);
    try {
      const body = { supplier_id: supplier, deliver_to_type: dest.type, deliver_to_id: dest.id, bill_to_gst_registration_id: billTo || null, expected_date: expected, freight_terms: freight, notes, lines: linesPayload(lines, true), version: po?.version };
      const r = po ? (await api.patch(`/procurement/purchase-orders/${po.id}`, body), { id: po.id }) : await api.post<{ id: string }>('/procurement/purchase-orders', body);
      invalidatePrefix(qc, '/procurement/purchase-orders');
      qc.invalidateQueries({ queryKey: ['po'] });
      onSaved(r.id);
      onClose();
    } catch (e) { setError({ message: (e as Error).message, fields: (e as { fields?: Record<string, string> }).fields ?? {} }); } finally { setSaving(false); }
  }
  const s = suppliers.data?.find((x) => x.id === supplier);
  return (
    <Drawer open onClose={onClose} width="xl" title={po ? `Edit ${po.number}${po.revision ? ` (revision ${po.revision})` : ''}` : 'New purchase order'} description="Saved as a draft. Submit it for approval when ready."
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={saving} onClick={save}>Save draft</Button></>}>
      <div className="space-y-5">
        {error.message && <Notice tone="danger">{error.message}</Notice>}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Select label="Supplier" required placeholder="Select supplier" value={supplier} onChange={(e) => setSupplier(e.target.value)} error={error.fields.supplier_id} options={suppliers.data?.map((x) => ({ value: x.id, label: `${x.legal_name} (${x.code})` })) ?? []} hint={s?.gstin ? `GSTIN ${s.gstin}` : undefined} />
          <Input label="Expected delivery" type="date" required value={expected} onChange={(e) => setExpected(e.target.value)} error={error.fields.expected_date} />
        </div>
        <DeliverTo type={dest.type} id={dest.id} onChange={(type, id) => setDest({ type, id })} error={error.fields.deliver_to_id} />
        <Select label="Bill to (our GSTIN)" placeholder="Automatic — receiving warehouse’s registration" value={billTo} onChange={(e) => setBillTo(e.target.value)} options={gst.data?.filter((g) => g.status === 'active').map((g) => ({ value: g.id, label: `${g.gstin} · ${g.state_name}` })) ?? []} hint="Determines CGST+SGST (same state as supplier) or IGST" />
        <LineEditor lines={lines} onChange={setLines} withRate error={error.fields.lines} />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Input label="Freight terms" value={freight} onChange={(e) => setFreight(e.target.value)} />
          <Textarea label="Notes to supplier" value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} />
        </div>
      </div>
    </Drawer>
  );
}

export function PurchaseOrderDetailPage() {
  const { id = '' } = useParams();
  const { can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['po', id], queryFn: () => api.get<PoDetail>(`/procurement/purchase-orders/${id}`) });
  const [tab, setTab] = useState<'lines' | 'receipts' | 'documents' | 'history'>('lines');
  const [modal, setModal] = useState<'edit' | 'receipt' | 'dispatch' | 'revise' | 'cancel' | 'close' | null>(null);
  const refresh = () => { q.refetch(); invalidatePrefix(qc, '/procurement/purchase-orders'); qc.invalidateQueries({ queryKey: ['governance-summary'] }); };
  const act = async (path: string, body: object = {}, msg?: string) => {
    try { const r = await api.post<{ status?: string }>(`/procurement/purchase-orders/${id}/${path}`, body); refresh(); if (msg) toast({ tone: 'success', title: r?.status === 'approved' ? 'Approved automatically (below threshold)' : msg }); setModal(null); } catch (e) { toast({ tone: 'error', title: (e as Error).message }); }
  };
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  if (!q.data) return <Skeleton className="h-96" />;
  const po = q.data;
  const manage = can('procurement.po.manage');
  const receivable = ['sent', 'accepted', 'partially_received'].includes(po.status);
  const ordered = po.lines.reduce((s, l) => s + l.qty_kg, 0);
  const received = po.lines.reduce((s, l) => s + l.received_kg, 0);
  const invoiced = po.lines.reduce((s, l) => s + l.invoiced_kg, 0);

  return (
    <>
      <PageHeader breadcrumbs={[{ label: 'Procurement', to: '/procurement' }, { label: 'Purchase orders', to: '/procurement/purchase-orders' }, { label: po.number }]}
        title={<>{po.number}{po.revision > 0 && <Badge tone="warning">Revision {po.revision}</Badge>} <StatusBadge status={po.status} /></>}
        meta={<><span>{po.supplier_name} <span className="font-mono text-slate-400">{po.supplier_gstin}</span></span><span>Bill to <span className="font-mono">{po.bill_to_gstin}</span> · {po.tax_type === 'intra' ? 'CGST+SGST' : 'IGST'}</span>{po.rfq_id && <Link className="link" to={`/procurement/rfqs/${po.rfq_id}`}>From RFQ</Link>}</>}
        actions={<>
          {po.status === 'draft' && manage && <><Button icon={<Pencil className="size-4" />} onClick={() => setModal('edit')}>Edit</Button><Button variant="primary" icon={<CheckCheck className="size-4" />} onClick={() => act('submit', {}, 'Sent for approval')}>Submit for approval</Button></>}
          {po.status === 'approved' && manage && <Button variant="primary" icon={<Send className="size-4" />} onClick={() => act('send', {}, 'Sent to supplier portal')}>Send to supplier</Button>}
          {receivable && can('procurement.receipt.record') && po.deliver_to_type === 'warehouse' && <Button variant="primary" icon={<PackageCheck className="size-4" />} onClick={() => setModal('receipt')}>Record receipt</Button>}
          {receivable && manage && <Button icon={<Truck className="size-4" />} onClick={() => setModal('dispatch')}>Dispatch advice</Button>}
          {['approved', 'sent', 'accepted', 'rejected_by_supplier', 'partially_received'].includes(po.status) && manage && <Button icon={<RotateCcw className="size-4" />} onClick={() => setModal('revise')}>Revise</Button>}
          {['partially_received', 'received', 'accepted'].includes(po.status) && manage && received > 0 && <Button icon={<Lock className="size-4" />} onClick={() => setModal('close')}>Close</Button>}
          {!['cancelled', 'closed', 'received', 'partially_received'].includes(po.status) && manage && <Button variant="ghost" icon={<Ban className="size-4" />} onClick={() => setModal('cancel')}>Cancel</Button>}
        </>} />
      {po.status === 'pending_approval' && <div className="mb-5"><Notice tone="info">Waiting for a checker with PO approval rights. It appears in their <Link className="link" to="/approvals">approvals inbox</Link>.</Notice></div>}
      {po.status === 'rejected_by_supplier' && <div className="mb-5"><Notice tone="danger" title="Rejected by supplier">{po.supplier_remarks}. Revise the PO or cancel it.</Notice></div>}
      {po.deliver_to_type === 'mill' && receivable && <div className="mb-5"><Notice tone="info" title="Direct-to-mill">{po.deliver_to_name} confirms receipt on the mill portal; that confirmation creates grey stock at the mill for job work.</Notice></div>}
      {po.exceptions.map((e) => <div key={e.id} className="mb-3"><Notice tone={e.severity === 'critical' ? 'danger' : 'warning'}>{e.message}</Notice></div>)}

      <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <div className="card p-4"><p className="text-[12px] text-slate-500">Order value</p><p className="text-[20px] font-semibold tabular">{fmtINR(po.total_value)}</p><p className="text-[12px] text-slate-500">{fmtINR(po.taxable_value)} + GST {fmtINR(po.tax_value)}</p></div>
        <div className="card p-4"><p className="text-[12px] text-slate-500">Delivery</p><p className="text-[15px] font-semibold">{fmtDate(po.expected_date)}</p><p className="text-[12px] text-slate-500">{po.supplier_promise_date ? `Supplier promised ${fmtDate(po.supplier_promise_date)}` : 'Not yet confirmed by supplier'}</p></div>
        <div className="card p-4"><Progress value={received} max={ordered} tone="success" label={`Received ${fmtNum(Math.round(received))} of ${fmtNum(ordered)} kg`} /><div className="mt-3"><Progress value={invoiced} max={ordered} label={`Invoiced ${fmtNum(Math.round(invoiced))} kg`} /></div></div>
        <div className="card p-4"><p className="text-[12px] text-slate-500">Terms</p><p className="text-[13.5px] font-medium">{po.payment_term ?? '—'} · {po.payment_days} days</p><p className="text-[12px] text-slate-500">{po.freight_terms ?? 'Freight not specified'}</p></div>
      </div>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
        <div className="xl:col-span-2">
          <Tabs className="mb-4" value={tab} onChange={setTab} tabs={[{ value: 'lines', label: 'Lines' }, { value: 'receipts', label: 'Dispatch & receipts', count: po.receipts.length + po.dispatches.length }, { value: 'documents', label: 'Documents' }, { value: 'history', label: 'Audit history' }]} />
          {tab === 'lines' && (
            <Card padded={false}>
              <SimpleTable rows={po.lines} rowKey={(l) => l.id} columns={[
                { key: 'sku', header: 'Fabric', render: (l) => <div><p className="font-mono text-[12.5px] font-semibold">{l.sku}</p><p className="text-[12px] text-slate-500">{l.product_name} · HSN {l.hsn_code}</p></div> },
                { key: 'qty', header: 'Ordered', align: 'right', render: (l) => fmtNum(l.qty_kg, 'kg') },
                { key: 'rate', header: 'Rate', align: 'right', render: (l) => `₹${l.rate_per_kg}` },
                { key: 'gst', header: 'GST', align: 'right', render: (l) => `${l.gst_rate}%` },
                { key: 'amt', header: 'Taxable', align: 'right', render: (l) => fmtINR(l.taxable) },
                { key: 'rcv', header: 'Received', render: (l) => <Progress value={l.received_kg} max={l.qty_kg} tone="success" label={`${fmtNum(l.received_kg)} kg${l.rejected_kg ? ` · ${fmtNum(l.rejected_kg)} rejected` : ''}`} /> },
                { key: 'inv', header: 'Invoiced', align: 'right', render: (l) => fmtNum(l.invoiced_kg, 'kg') },
              ]} />
            </Card>
          )}
          {tab === 'receipts' && (
            <div className="space-y-4">
              {po.dispatches.map((d) => (
                <Card key={d.id}><p className="flex items-center gap-2 text-[13.5px] font-medium"><Truck className="size-4 text-slate-400" />Dispatched {fmtDate(d.dispatch_date)} · {fmtNum(d.kg, 'kg')}{d.rolls ? ` · ${d.rolls} rolls` : ''} <Badge>{d.reported_via === 'supplier_portal' ? 'Supplier portal' : 'Buyer'}</Badge></p>
                  <p className="mt-1 text-[12.5px] text-slate-600">{[d.transporter_name, d.lr_number && `LR ${d.lr_number}`, d.vehicle_no, d.eway_bill_no && `e-way ${d.eway_bill_no}`].filter(Boolean).join(' · ') || 'No transport details'}</p></Card>
              ))}
              {po.receipts.map((r) => (
                <Card key={r.id} title={<span className="flex items-center gap-2">{r.number} <Badge tone={r.receipt_type === 'mill' ? 'violet' : 'success'}>{r.receipt_type === 'mill' ? 'At mill' : 'Warehouse'}</Badge>{r.source === 'mill_portal' && <Badge tone="info">Mill portal</Badge>}</span>} description={`${fmtDate(r.receipt_date)} · ${r.location_name} · by ${r.recorded_by_name}${r.challan_no ? ` · challan ${r.challan_no}` : ''}`} padded={false}>
                  <SimpleTable rows={r.lines} rowKey={(l) => l.po_line_id} columns={[
                    { key: 'sku', header: 'SKU', render: (l) => <span className="font-mono text-[12.5px]">{l.sku}</span> },
                    { key: 'rcv', header: 'Received', align: 'right', render: (l) => fmtNum(l.received_kg, 'kg') },
                    { key: 'rej', header: 'Rejected', align: 'right', render: (l) => (l.rejected_kg ? <span className="text-rose-600">{fmtNum(l.rejected_kg, 'kg')}</span> : '—') },
                    { key: 'rolls', header: 'Rolls', align: 'right', render: (l) => l.rolls ?? '—' },
                    { key: 'rem', header: 'Remarks', render: (l) => l.remarks ?? '' },
                  ]} />
                </Card>
              ))}
              {!po.receipts.length && !po.dispatches.length && <Card><p className="text-[13px] text-slate-500">Nothing dispatched or received yet.</p></Card>}
            </div>
          )}
          {tab === 'documents' && <Card><DocumentsPanel entityType="purchase_order" entityId={po.id} /></Card>}
          {tab === 'history' && <Card><AuditTimeline entityId={po.id} /></Card>}
        </div>
        <div className="space-y-6">
          <Card title="Timeline">
            <Timeline items={[...po.events].reverse().map((e) => ({ id: e.id, title: humanize(e.event), detail: e.detail, meta: `${e.actor_name ?? 'System'}${e.actor_type !== 'user' ? ` (${e.actor_type})` : ''} · ${fmtDateTime(e.at)}`, tone: EVENT_TONE[e.event] ?? 'neutral' }))} />
          </Card>
          <Card title="Supplier invoices" padded={false}>
            {po.invoices.length ? (
              <ul className="divide-y divide-slate-100">{po.invoices.map((i) => <li key={i.id}><Link to={`/procurement/invoices/${i.id}`} className="flex items-center gap-2 px-5 py-3 text-[13px] hover:bg-slate-50"><span className="flex-1 font-mono">{i.invoice_number}</span><StatusBadge status={i.match_status} /><span className="tabular">{fmtINR(i.total_value)}</span></Link></li>)}</ul>
            ) : <p className="px-5 py-4 text-[13px] text-slate-500">No invoices yet.</p>}
          </Card>
          <Card title="Details"><KeyValue columns={1} items={[{ label: 'Created by', value: po.created_by_name }, { label: 'Approved', value: po.approved_by_name ? `${po.approved_by_name} · ${fmtDateTime(po.approved_at)}` : null }, { label: 'Sent', value: fmtDateTime(po.sent_at) }, { label: 'Notes', value: po.notes }]} /></Card>
          {po.revisions.length > 0 && <Card title="Revisions"><Timeline items={po.revisions.map((r) => ({ id: r.id, title: `Revision ${r.revision + 1}`, detail: r.reason, meta: `${r.created_by_name} · ${fmtDateTime(r.created_at)}`, tone: 'warning' }))} /></Card>}
        </div>
      </div>

      {modal === 'edit' && <PoForm po={po} onClose={() => setModal(null)} onSaved={() => refresh()} />}
      {modal === 'receipt' && <ReceiptModal po={po} onClose={() => setModal(null)} onSaved={() => { setModal(null); refresh(); toast({ tone: 'success', title: 'Receipt recorded' }); }} />}
      {modal === 'dispatch' && <DispatchModal onClose={() => setModal(null)} onSubmit={(b) => act('dispatches', b, 'Dispatch recorded')} />}
      <ConfirmDialog open={modal === 'revise'} onClose={() => setModal(null)} requireReason title="Revise this purchase order?" description="The current version is saved in revision history. The PO goes back to draft and needs approval again before it is re-sent." confirmLabel="Revise" onConfirm={(r) => act('revise', { reason: r }, 'PO returned to draft for revision')} />
      <ConfirmDialog open={modal === 'cancel'} onClose={() => setModal(null)} requireReason tone="danger" title="Cancel this purchase order?" confirmLabel="Cancel PO" onConfirm={(r) => act('cancel', { reason: r }, 'PO cancelled')} />
      <ConfirmDialog open={modal === 'close'} onClose={() => setModal(null)} requireReason title="Close this purchase order?" description="No further receipts will be accepted. Use this for short-closed orders." confirmLabel="Close PO" onConfirm={(r) => act('close', { reason: r }, 'PO closed')} />
    </>
  );
}

export function ReceiptModal({ po, onClose, onSaved, portal }: { po: Pick<PoDetail, 'id' | 'number' | 'lines'>; onClose: () => void; onSaved: () => void; portal?: boolean }) {
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [challan, setChallan] = useState('');
  const [lr, setLr] = useState('');
  const [rows, setRows] = useState(po.lines.map((l) => ({ po_line_id: l.id, received_kg: '', rejected_kg: '', rolls: '', remarks: '' })));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  async function save() {
    setSaving(true);
    try {
      const body = { receipt_date: date, challan_no: challan, lr_number: lr, lines: rows.filter((r) => r.received_kg).map((r) => ({ po_line_id: r.po_line_id, received_kg: Number(r.received_kg), rejected_kg: Number(r.rejected_kg || 0), rolls: r.rolls ? Number(r.rolls) : null, remarks: r.remarks || null })) };
      await api.post(portal ? `/procurement/portal/mill/incoming/${po.id}/receive` : `/procurement/purchase-orders/${po.id}/receipts`, body);
      onSaved();
    } catch (e) { setError((e as Error).message); } finally { setSaving(false); }
  }
  return (
    <Modal open onClose={onClose} size="lg" title={`Record receipt · ${po.number}`} description="Weigh what arrived. Rejected KG is not accepted into stock and is not payable."
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={saving} onClick={save}>Record receipt</Button></>}>
      <div className="space-y-4">
        {error && <Notice tone="danger">{error}</Notice>}
        <div className="grid grid-cols-3 gap-3">
          <Input label="Receipt date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          <Input label="Supplier challan no." value={challan} onChange={(e) => setChallan(e.target.value)} />
          <Input label="LR / docket no." value={lr} onChange={(e) => setLr(e.target.value)} />
        </div>
        <div className="overflow-hidden rounded-lg border border-slate-200">
          <table className="w-full text-[13px]">
            <thead className="bg-slate-50 text-[11px] tracking-wide text-slate-500 uppercase"><tr><th className="px-3 py-2 text-left">SKU</th><th className="px-3 py-2 text-right">Pending</th><th className="w-28 px-3 py-2">Received kg</th><th className="w-28 px-3 py-2">Rejected kg</th><th className="w-20 px-3 py-2">Rolls</th></tr></thead>
            <tbody className="divide-y divide-slate-100">
              {po.lines.map((l, i) => (
                <tr key={l.id}>
                  <td className="px-3 py-2 font-mono text-[12.5px]">{l.sku}</td>
                  <td className="px-3 py-2 text-right text-slate-500 tabular">{fmtNum(Math.max(0, l.qty_kg - l.received_kg))}</td>
                  {(['received_kg', 'rejected_kg', 'rolls'] as const).map((k) => (
                    <td key={k} className="px-2 py-1.5"><input className="input h-8 text-right tabular" type="number" min={0} value={rows[i]![k]} onChange={(e) => setRows(rows.map((r, j) => (j === i ? { ...r, [k]: e.target.value } : r)))} /></td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </Modal>
  );
}

export function DispatchModal({ onClose, onSubmit }: { onClose: () => void; onSubmit: (b: object) => void }) {
  const [v, setV] = useState({ dispatch_date: new Date().toISOString().slice(0, 10), kg: '', rolls: '', transporter_name: '', lr_number: '', vehicle_no: '', eway_bill_no: '', notes: '' });
  const f = (k: keyof typeof v, label: string, type = 'text') => <Input label={label} type={type} value={v[k]} onChange={(e) => setV({ ...v, [k]: e.target.value })} />;
  return (
    <Modal open onClose={onClose} size="lg" title="Dispatch advice" footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={() => onSubmit({ ...v, kg: Number(v.kg), rolls: v.rolls ? Number(v.rolls) : null })}>Save dispatch</Button></>}>
      <div className="grid grid-cols-2 gap-3">
        {f('dispatch_date', 'Dispatch date', 'date')}{f('kg', 'Quantity (kg)', 'number')}{f('rolls', 'Rolls', 'number')}{f('transporter_name', 'Transporter')}{f('lr_number', 'LR / docket no.')}{f('vehicle_no', 'Vehicle no.')}{f('eway_bill_no', 'e-Way bill no.')}{f('notes', 'Notes')}
      </div>
    </Modal>
  );
}
