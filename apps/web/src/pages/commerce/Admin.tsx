import { useQuery, useQueryClient } from '@tanstack/react-query';
import { BadgeIndianRupee, Landmark, Check, ClipboardCopy, FileText, Link2, MessageSquareWarning, Plus, RotateCcw, ShieldAlert, UserPlus, Wallet } from 'lucide-react';
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Link } from '../../components/AppLink';
import { api, invalidatePrefix } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { fmtDate, fmtDateTime, fmtINR, fmtNum, humanize } from '../../lib/format';
import { SimpleTable } from '../../components/DataTable';
import { ConfirmDialog, Drawer, Modal, useToast } from '../../components/overlay';
import { useParties, useProducts } from '../../components/business';
import { DocumentPreviewButton, type DocData } from '../../components/DocumentPreview';
import { Badge, Button, Card, Checkbox, EmptyState, ErrorState, Input, KeyValue, Notice, PageHeader, Segmented, Select, Skeleton, Stat, StatusBadge, Tabs, Textarea } from '../../components/ui';

const errMsg = (e: unknown) => (e as Error).message;

// ---------------------------------------------------------------- orders
interface ORow { id: string; number: string; customer_id: string; customer_name: string; channel: string; status: string; payment_terms: string; kg: number; total_estimate: number; token_amount: number; token_paid_at: string | null; reservation_expires_at: string | null; placed_by_name: string | null; skus: string | null; paid: number; created_at: string }
const VIEWS = {
  open: 'pending_company_approval,awaiting_allocation,pending_payment,booked,in_fulfilment,partially_dispatched',
  done: 'dispatched,delivered',
  closed: 'cancelled,expired',
};

export function CommerceOrdersPage() {
  const nav = useNavigate();
  const { can } = useAuth();
  const [view, setView] = useState<keyof typeof VIEWS>('open');
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useState(false);
  const q = useQuery({ queryKey: ['com-orders', view, search], queryFn: () => api.get<ORow[]>(`/commerce/orders?status=${VIEWS[view]}${search ? `&q=${encodeURIComponent(search)}` : ''}`) });
  return (
    <>
      <PageHeader title="Sales orders" description="Every order from the customer portal, from accepted quotations and from phone or email orders. Stock is reserved when an order is allocated; advance orders are booked only once the token is paid."
        breadcrumbs={[{ label: 'B2B commerce' }, { label: 'Sales orders' }]} actions={can('commerce.order.manage') && <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>New order</Button>} />
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Segmented value={view} onChange={setView} options={[{ value: 'open', label: 'Open' }, { value: 'done', label: 'Dispatched' }, { value: 'closed', label: 'Cancelled / expired' }]} />
        <Input className="w-64" placeholder="Search order or customer" value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>
      <Card padded={false}>
        {q.isError ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : !q.data ? <Skeleton className="m-5 h-40" /> : (
          <SimpleTable rows={q.data} rowKey={(r) => r.id} onRowClick={(r) => nav(`/commerce/orders/${r.id}`)} empty={<EmptyState icon={<FileText className="size-5" />} title="No orders here" />} columns={[
            { key: 'n', header: 'Order', render: (r) => <div><p className="font-mono text-[12.5px] font-semibold">{r.number}</p><p className="text-[12px] text-slate-500">{humanize(r.channel)} · {fmtDate(r.created_at)}</p></div> },
            { key: 'c', header: 'Customer', render: (r) => r.customer_name },
            { key: 's', header: 'Fabric', render: (r) => <span className="font-mono text-[12px]">{r.skus}</span> },
            { key: 'k', header: 'KG', align: 'right', render: (r) => fmtNum(Number(r.kg)) },
            { key: 't', header: 'Value', align: 'right', render: (r) => fmtINR(Number(r.total_estimate)) },
            { key: 'p', header: 'Terms', render: (r) => r.payment_terms === 'credit' ? <Badge tone="violet">Credit</Badge> : <span className="text-[12.5px]">Token {fmtINR(Number(r.token_amount))}{r.token_paid_at ? <Check className="ml-1 inline size-3.5 text-emerald-600" /> : null}</span> },
            { key: 'st', header: 'Status', render: (r) => <StatusBadge status={r.status} /> },
          ]} />
        )}
      </Card>
      <NewOrderModal open={creating} onClose={() => setCreating(false)} onDone={(id) => nav(`/commerce/orders/${id}`)} />
    </>
  );
}

function NewOrderModal({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: (id: string) => void }) {
  const customers = useParties('customer');
  const products = useProducts();
  const toast = useToast();
  const [cust, setCust] = useState('');
  const [lines, setLines] = useState([{ product_id: '', kg: '' }]);
  const [shipTo, setShipTo] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const submit = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await api.post<{ id: string; number: string }>('/commerce/orders', { customer_id: cust, lines: lines.filter((l) => l.product_id && Number(l.kg) > 0).map((l) => ({ product_id: l.product_id, kg: Number(l.kg) })), ship_to: shipTo || null, notes: notes || null });
      toast({ tone: 'success', title: `Order ${r.number} created`, body: 'Sent to dispatch for allocation.' });
      onClose(); onDone(r.id);
    } catch (e) { setErr(errMsg(e)); } finally { setBusy(false); }
  };
  return (
    <Modal open={open} onClose={onClose} size="lg" title="New order for a customer" description="For orders taken by phone, email or WhatsApp. Dispatch chooses the warehouse and lots; you only need the fabric and quantity."
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} disabled={!cust || !lines.some((l) => l.product_id && Number(l.kg) > 0)} onClick={() => void submit()}>Create order</Button></>}>
      <div className="space-y-3">
        {err && <Notice tone="danger">{err}</Notice>}
        <Select label="Customer" required value={cust} onChange={(e) => setCust(e.target.value)} placeholder="Choose a customer" options={(customers.data ?? []).filter((p) => p.status === 'active').map((p) => ({ value: p.id, label: `${p.legal_name} (${p.code})` }))} />
        {lines.map((l, i) => (
          <div key={i} className="grid grid-cols-[1fr_140px_auto] items-end gap-2">
            <Select label={i === 0 ? 'Fabric' : undefined} value={l.product_id} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, product_id: e.target.value } : x)))} placeholder="Choose fabric" options={(products.data ?? []).map((p) => ({ value: p.id, label: `${p.sku} · ${p.name}` }))} />
            <Input label={i === 0 ? 'KG' : undefined} type="number" min={0} value={l.kg} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, kg: e.target.value } : x)))} />
            <Button variant="ghost" disabled={lines.length === 1} onClick={() => setLines(lines.filter((_, j) => j !== i))}>Remove</Button>
          </div>
        ))}
        <Button size="sm" icon={<Plus className="size-3.5" />} onClick={() => setLines([...lines, { product_id: '', kg: '' }])}>Add fabric</Button>
        <Textarea label="Ship to" value={shipTo} onChange={(e) => setShipTo(e.target.value)} placeholder="Leave blank to use the customer’s address" />
        <Textarea label="Notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
      </div>
    </Modal>
  );
}

interface OLine { id: string; line_no: number; sku: string; product_name: string; lot_no: string | null; kg: number; price_per_kg: number; taxable: number; gst_rate: number }
interface OPay { id: string; number: string; purpose: string; ref_no: string | null; amount: number; status: string; utr: string | null; link_token: string; link_expires_at: string; refunded_amount: number; created_at: string }
interface OWallet { id: number; entry_type: string; amount: number; ref_no: string | null; narration: string | null; at: string; by_name: string | null }
interface OExt { id: string; requested_until: string; reason: string; status: string; requested_by_name: string; decided_by_name: string | null; created_at: string }
interface OSummary { plan: { status: string; decision_mode: string | null; decision_reason: string | null; booked: boolean } | null; fulfilments: { id: string; number: string; warehouse_code: string; status: string; picked_kg: number; invoice_no: string | null; invoice_total: number; amount_settled: number; shipment_id: string | null; shipment_no: string | null; shipment_status: string | null; lr_number: string | null }[]; returns: { id: string; number: string; status: string; credit_note_no: string | null; credit_total: number | null }[] }
interface ODetail extends ORow { customer_gstin: string | null; source_ref: string | null; taxable: number; tax_estimate: number; token_policy_text: string | null; token_refundable: boolean; token_cancellation_fee_pct: number; token_due_at: string | null; company_approved_by_name: string | null; ship_to: string | null; notes: string | null; cancelled_reason: string | null; cancelled_by_name: string | null; wallet_balance: number;
  lines: OLine[]; payments: OPay[]; wallet: OWallet[]; extensions: OExt[]; fulfilment: OSummary | null }

/**
 * The order as the customer receives it. On advance terms it is a proforma invoice (what to pay before dispatch);
 * otherwise an order confirmation. Neither is a tax invoice: that is issued at dispatch with the actual rolls.
 */
function orderDoc(o: ODetail): DocData {
  const advance = o.payment_terms === 'advance';
  return {
    title: advance ? 'Proforma invoice' : 'Sales order confirmation', number: o.number, date: o.created_at.slice(0, 10), status: o.status,
    seller: { name: 'Demo Textile Trading Pvt Ltd', lines: ['Ring Road, Surat, Gujarat'] },
    party: { label: 'Bill to', name: o.customer_name, gstin: o.customer_gstin, state: o.customer_gstin ? o.customer_gstin.slice(0, 2) : null, lines: [o.ship_to ? `Ship to: ${o.ship_to}` : null] },
    meta: [
      { label: 'Payment terms', value: humanize(o.payment_terms) },
      ...(Number(o.token_amount) ? [{ label: advance ? 'Advance to pay now' : 'Token', value: fmtINR(Number(o.token_amount)) }] : []),
      ...(o.token_due_at ? [{ label: 'Advance due by', value: fmtDate(o.token_due_at) }] : []),
      { label: 'Placed by', value: o.placed_by_name ?? 'Customer portal' },
      ...(o.source_ref ? [{ label: 'Customer ref', value: o.source_ref }] : []),
    ],
    lines: o.lines.map((l) => ({ description: `${l.sku} — ${l.product_name}`, note: l.lot_no ? `Lot ${l.lot_no}` : 'Lot allocated at dispatch', qty: Number(l.kg), uom: 'kg', rate: Number(l.price_per_kg), gst_rate: Number(l.gst_rate), taxable: Number(l.taxable), amount: Number(l.taxable) })),
    totals: [
      { label: 'Taxable value', value: Number(o.taxable) },
      { label: 'GST', value: Number(o.tax_estimate) },
      { label: 'Order total', value: Number(o.total_estimate), strong: true },
      ...(advance && Number(o.token_amount) ? [{ label: 'Advance payable now', value: Number(o.token_amount) }, { label: 'Balance before dispatch', value: Math.max(0, Number(o.total_estimate) - Number(o.token_amount)) }] : []),
    ],
    notes: o.notes,
    terms: [
      o.token_policy_text ? `Advance: ${o.token_policy_text}${o.token_refundable ? `; refundable less ${o.token_cancellation_fee_pct}% if the order is cancelled.` : '; not refundable.'}` : null,
      'Weights are invoiced as actually dispatched; shade and GSM within normal tolerance. GST is charged as CGST + SGST within Gujarat, IGST outside.',
    ].filter(Boolean).join('\n'),
    footer: advance ? 'Proforma invoice: not a tax invoice. The GST tax invoice is issued at dispatch.' : 'Order confirmation: not a tax invoice. The GST tax invoice is issued at dispatch.',
  };
}

const CANCELLABLE = ['pending_company_approval', 'awaiting_allocation', 'pending_payment', 'booked'];

export function CommerceOrderDetailPage() {
  const { id = '' } = useParams();
  const { can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['com-order', id], queryFn: () => api.get<ODetail>(`/commerce/orders/${id}`) });
  const [cancel, setCancel] = useState(false);
  const [extend, setExtend] = useState(false);
  const [link, setLink] = useState(false);
  const [busy, setBusy] = useState(false);
  const o = q.data;
  const refresh = () => invalidatePrefix(qc, 'com-');
  if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  if (!o) return <Skeleton className="h-96" />;
  const f = o.fulfilment;
  return (
    <>
      <PageHeader title={`Order ${o.number}`} meta={<StatusBadge status={o.status} />} description={`${o.customer_name} · ${humanize(o.channel)}${o.source_ref ? ` from ${o.source_ref}` : ''} · placed by ${o.placed_by_name ?? 'system'} on ${fmtDateTime(o.created_at)}`}
        breadcrumbs={[{ label: 'B2B commerce' }, { label: 'Sales orders', to: '/commerce/orders' }, { label: o.number }]}
        actions={<div className="flex gap-2">
          <DocumentPreviewButton label={o.payment_terms === 'advance' ? 'Proforma invoice' : 'Order confirmation'} draft={o.status === 'pending_company_approval'} d={orderDoc(o)} />
          {can('fulfilment.read') && <Link to={`/fulfilment/orders/${o.id}`}><Button>Allocation & dispatch</Button></Link>}
          {can('commerce.payment.manage') && !['cancelled', 'expired'].includes(o.status) && <Button icon={<Link2 className="size-4" />} onClick={() => setLink(true)}>Payment link</Button>}
          {can('commerce.order.manage') && o.status === 'booked' && <Button onClick={() => setExtend(true)}>Extend hold</Button>}
          {can('commerce.order.manage') && CANCELLABLE.includes(o.status) && <Button variant="danger" onClick={() => setCancel(true)}>Cancel order</Button>}
        </div>} />
      {o.status === 'cancelled' && <div className="mb-4"><Notice tone="warning" title="Cancelled">{o.cancelled_reason} — {o.cancelled_by_name}</Notice></div>}
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Stat label="Quantity" value={`${fmtNum(Number(o.kg))} kg`} />
        <Stat label="Order value (est.)" value={fmtINR(Number(o.total_estimate))} sub={`${fmtINR(Number(o.taxable))} + GST ${fmtINR(Number(o.tax_estimate))}`} />
        <Stat label="Terms" value={o.payment_terms === 'credit' ? 'Credit' : 'Advance'} sub={o.payment_terms === 'advance' ? `Token ${fmtINR(Number(o.token_amount))}${o.token_paid_at ? ' · paid' : ''}` : 'Within credit limit'} />
        <Stat label="Customer advance" value={fmtINR(Number(o.wallet_balance))} sub="unapplied balance" />
        <Stat label="Stock held until" value={o.reservation_expires_at ? fmtDate(o.reservation_expires_at) : '—'} tone={o.reservation_expires_at && new Date(o.reservation_expires_at).getTime() - Date.now() < 86_400_000 ? 'warning' : undefined} />
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Card title="Lines" padded={false}>
            <SimpleTable rows={o.lines} rowKey={(l) => l.id} columns={[
              { key: 's', header: 'Fabric', render: (l) => <div><p className="font-mono text-[12.5px] font-semibold">{l.sku}</p><p className="text-[12px] text-slate-500">{l.product_name}</p></div> },
              { key: 'l', header: 'Lot', render: (l) => l.lot_no ?? <span className="text-slate-400">dispatch chooses</span> },
              { key: 'k', header: 'KG', align: 'right', render: (l) => fmtNum(Number(l.kg)) },
              { key: 'p', header: 'Rate', align: 'right', render: (l) => fmtINR(Number(l.price_per_kg)) },
              { key: 't', header: 'Taxable', align: 'right', render: (l) => fmtINR(Number(l.taxable)) },
              { key: 'g', header: 'GST', align: 'right', render: (l) => `${l.gst_rate}%` },
            ]} />
          </Card>
          <Card title="Fulfilment" description={f?.plan ? `Plan ${humanize(f.plan.status)}${f.plan.decision_mode ? ` · ${humanize(f.plan.decision_mode)}` : ''}` : 'Not yet with dispatch'} padded={false}>
            {!f || f.fulfilments.length === 0 ? <p className="p-5 text-[13px] text-slate-500">No warehouse has been chosen yet.</p> : (
              <SimpleTable rows={f.fulfilments} rowKey={(x) => x.id} columns={[
                { key: 'n', header: 'Fulfilment', render: (x) => <Link className="link font-mono text-[12.5px]" to={`/fulfilment/${x.id}`}>{x.number}</Link> },
                { key: 'w', header: 'From', render: (x) => x.warehouse_code },
                { key: 's', header: 'Status', render: (x) => <StatusBadge status={x.status} /> },
                { key: 'i', header: 'Invoice', render: (x) => x.invoice_no ? <Link className="link font-mono text-[12px]" to={`/fulfilment/invoices/${x.id}`}>{x.invoice_no}</Link> : '—' },
                { key: 't', header: 'Total', align: 'right', render: (x) => x.invoice_no ? fmtINR(Number(x.invoice_total)) : '—' },
                { key: 'sh', header: 'Shipment', render: (x) => x.shipment_id ? <Link className="link text-[12.5px]" to={`/fulfilment/shipments/${x.shipment_id}`}>{x.shipment_no} · {humanize(x.shipment_status ?? '')}</Link> : '—' },
              ]} />
            )}
            {f && f.returns.length > 0 && <div className="border-t border-slate-100 px-5 py-3 text-[13px]">Returns: {f.returns.map((r) => <Link key={r.id} className="link mr-3" to={`/fulfilment/returns/${r.id}`}>{r.number} ({humanize(r.status)})</Link>)}</div>}
          </Card>
          <Card title="Payments" padded={false}>
            {o.payments.length === 0 ? <p className="p-5 text-[13px] text-slate-500">No payment links yet.</p> : (
              <SimpleTable rows={o.payments} rowKey={(p) => p.id} columns={[
                { key: 'n', header: 'Reference', render: (p) => <span className="font-mono text-[12.5px]">{p.number}</span> },
                { key: 'p', header: 'For', render: (p) => `${humanize(p.purpose)}${p.ref_no ? ` ${p.ref_no}` : ''}` },
                { key: 'a', header: 'Amount', align: 'right', render: (p) => fmtINR(Number(p.amount)) },
                { key: 'u', header: 'UTR', render: (p) => p.utr ?? '—' },
                { key: 's', header: 'Status', render: (p) => <StatusBadge status={p.status} /> },
                { key: 'l', header: '', render: (p) => p.status === 'created' ? <CopyLink path={`/pay/${p.link_token}`} /> : null },
              ]} />
            )}
          </Card>
        </div>
        <div className="space-y-4">
          <Card title="Details">
            <KeyValue columns={1} items={[
              { label: 'Customer', value: <Link className="link" to={`/crm/customers/${o.customer_id}`}>{o.customer_name}</Link> },
              { label: 'GSTIN', value: o.customer_gstin ?? 'Unregistered', mono: true },
              { label: 'Token policy', value: o.token_policy_text ?? '—' },
              { label: 'Token refundable', value: o.payment_terms === 'credit' ? '—' : o.token_refundable ? `Yes, less ${o.token_cancellation_fee_pct}% fee` : 'No' },
              { label: 'Token due by', value: o.token_due_at ? fmtDateTime(o.token_due_at) : '—' },
              { label: 'Company approval', value: o.company_approved_by_name ?? '—' },
              { label: 'Ship to', value: o.ship_to ?? 'Customer address' },
              { label: 'Notes', value: o.notes ?? '—' },
            ]} />
          </Card>
          <Card title="Advance ledger for this order" padded={false}>
            {o.wallet.length === 0 ? <p className="p-5 text-[13px] text-slate-500">Nothing yet.</p> : (
              <ul className="divide-y divide-slate-100 text-[13px]">
                {o.wallet.map((w) => <li key={w.id} className="flex items-center justify-between px-5 py-2.5"><div><p>{humanize(w.entry_type)}</p><p className="text-[12px] text-slate-500">{w.ref_no} · {fmtDateTime(w.at)}</p></div><span className={Number(w.amount) < 0 ? 'text-rose-600 tabular' : 'text-emerald-700 tabular'}>{fmtINR(Number(w.amount))}</span></li>)}
              </ul>
            )}
          </Card>
          {o.extensions.length > 0 && (
            <Card title="Hold extensions">
              <ul className="space-y-2 text-[13px]">{o.extensions.map((x) => <li key={x.id}><StatusBadge status={x.status} /> until {fmtDate(x.requested_until)} — {x.reason} <span className="text-slate-500">({x.requested_by_name})</span></li>)}</ul>
            </Card>
          )}
        </div>
      </div>
      <ConfirmDialog open={cancel} onClose={() => setCancel(false)} title={`Cancel ${o.number}?`} tone="danger" requireReason loading={busy} confirmLabel="Cancel order"
        description={o.token_paid_at ? `The token stays with the customer as advance${o.token_refundable ? `, less the ${o.token_cancellation_fee_pct}% cancellation fee` : '; this token is non-refundable and will be forfeited'}. Reserved stock is released.` : 'Reserved stock is released.'}
        onConfirm={async (reason) => { setBusy(true); try { await api.post(`/commerce/orders/${o.id}/cancel`, { reason }); toast({ tone: 'success', title: 'Order cancelled' }); setCancel(false); refresh(); } catch (e) { toast({ tone: 'error', title: 'Could not cancel', body: errMsg(e) }); } finally { setBusy(false); } }} />
      <ExtendModal open={extend} onClose={() => setExtend(false)} orderId={o.id} onDone={refresh} />
      <PaymentLinkModal open={link} onClose={() => setLink(false)} customerId={o.customer_id} orderId={o.id} onDone={refresh} />
    </>
  );
}

function CopyLink({ path }: { path: string }) {
  const toast = useToast();
  return <Button size="sm" variant="ghost" icon={<ClipboardCopy className="size-3.5" />} onClick={() => { void navigator.clipboard?.writeText(`${window.location.origin}${path}`); toast({ tone: 'info', title: 'Payment link copied' }); }}>Copy link</Button>;
}

function ExtendModal({ open, onClose, orderId, onDone }: { open: boolean; onClose: () => void; orderId: string; onDone: () => void }) {
  const toast = useToast();
  const [days, setDays] = useState('3');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <Modal open={open} onClose={onClose} title="Hold the stock longer" description="The reservation is extended only after a manager approves it."
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} disabled={reason.trim().length < 3} onClick={async () => {
        setBusy(true); setErr(null);
        try { await api.post(`/commerce/orders/${orderId}/extend`, { days: Number(days), reason }); toast({ tone: 'success', title: 'Sent for approval' }); onClose(); onDone(); } catch (e) { setErr(errMsg(e)); } finally { setBusy(false); }
      }}>Request extension</Button></>}>
      <div className="space-y-3">{err && <Notice tone="danger">{err}</Notice>}<Input label="Extra days" type="number" min={1} value={days} onChange={(e) => setDays(e.target.value)} /><Textarea label="Reason" required value={reason} onChange={(e) => setReason(e.target.value)} /></div>
    </Modal>
  );
}

/** Money received outside the gateway (bank transfer, cheque, cash): same effect as a confirmed gateway payment. */
function OfflinePaymentModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const customers = useParties('customer');
  const qc = useQueryClient();
  const today = new Date().toISOString().slice(0, 10);
  const blank = { cust: '', amount: '', mode: 'neft', reference: '', received_on: today, purpose: 'advance', order: '', ref: '' };
  const [v, setV] = useState(blank);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const orders = useQuery({ queryKey: ['com-orders-pending', v.cust], queryFn: () => api.get<{ id: string; number: string; status: string; token_amount: number }[]>(`/commerce/orders?customer=${v.cust}&status=pending_payment`), enabled: open && !!v.cust && v.purpose === 'token' });
  const close = () => { setV(blank); setErr(null); setDone(null); onClose(); };
  return (
    <Modal open={open} onClose={close} title="Record an offline payment" description="Money received by NEFT/RTGS/IMPS, UPI to the bank, cheque or cash. It credits the customer’s advance, books a token order and posts the receipt to the bank (or cash) in the books."
      footer={done ? <Button variant="primary" onClick={close}>Done</Button> : <><Button onClick={close}>Cancel</Button><Button variant="primary" loading={busy} disabled={!v.cust || !(Number(v.amount) > 0) || v.reference.trim().length < 3 || (v.purpose === 'token' && !v.order)} onClick={async () => {
        setBusy(true); setErr(null);
        try {
          const r = await api.post<{ number: string }>('/commerce/payments/offline', { customer_id: v.cust, amount: Number(v.amount), mode: v.mode, reference: v.reference.trim(), received_on: v.received_on, purpose: v.purpose, order_id: v.purpose === 'token' ? v.order : null, ref_no: v.ref || null });
          setDone(r.number); invalidatePrefix(qc, 'com-');
        } catch (e) { setErr(errMsg(e)); } finally { setBusy(false); }
      }}>Record payment</Button></>}>
      {done ? <Notice tone="success" title={`Recorded as ${done}`}>The customer’s advance and the books are updated.</Notice> : (
        <div className="space-y-3">
          {err && <Notice tone="danger">{err}</Notice>}
          <Select label="Customer" required value={v.cust} onChange={(e) => setV({ ...v, cust: e.target.value, order: '' })} placeholder="Choose a customer" options={(customers.data ?? []).map((p) => ({ value: p.id, label: p.legal_name }))} />
          <div className="grid grid-cols-2 gap-3">
            <Input label="Amount" type="number" prefix="₹" required value={v.amount} onChange={(e) => setV({ ...v, amount: e.target.value })} />
            <Input label="Received on" type="date" required max={today} value={v.received_on} onChange={(e) => setV({ ...v, received_on: e.target.value })} />
            <Select label="Mode" value={v.mode} onChange={(e) => setV({ ...v, mode: e.target.value })} options={[{ value: 'neft', label: 'NEFT' }, { value: 'rtgs', label: 'RTGS' }, { value: 'imps', label: 'IMPS' }, { value: 'upi', label: 'UPI to bank' }, { value: 'cheque', label: 'Cheque' }, { value: 'cash', label: 'Cash' }]} />
            <Input label={v.mode === 'cheque' ? 'Cheque number' : v.mode === 'cash' ? 'Receipt number' : 'UTR / reference'} required value={v.reference} onChange={(e) => setV({ ...v, reference: e.target.value })} />
          </div>
          <Select label="For" value={v.purpose} onChange={(e) => setV({ ...v, purpose: e.target.value })} options={[{ value: 'advance', label: 'Advance payment' }, { value: 'invoice', label: 'Against an invoice' }, { value: 'token', label: 'Booking token for an order' }]} />
          {v.purpose === 'token' && <Select label="Order waiting for its token" required value={v.order} onChange={(e) => setV({ ...v, order: e.target.value })} placeholder={orders.data?.length === 0 ? 'No orders waiting for a token' : 'Choose an order'} options={(orders.data ?? []).map((o) => ({ value: o.id, label: `${o.number} · token ${fmtINR(Number(o.token_amount))}` }))} />}
          {v.purpose === 'invoice' && <Input label="Invoice number" value={v.ref} onChange={(e) => setV({ ...v, ref: e.target.value })} />}
        </div>
      )}
    </Modal>
  );
}

function PaymentLinkModal({ open, onClose, customerId, orderId, onDone }: { open: boolean; onClose: () => void; customerId?: string; orderId?: string; onDone?: () => void }) {
  const customers = useParties('customer');
  const [cust, setCust] = useState(customerId ?? '');
  const [amount, setAmount] = useState('');
  const [purpose, setPurpose] = useState<'advance' | 'invoice'>('advance');
  const [ref, setRef] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [made, setMade] = useState<{ number: string; link_token: string } | null>(null);
  const close = () => { setMade(null); setErr(null); onClose(); };
  return (
    <Modal open={open} onClose={close} title="Create a payment link" description="The customer pays on the bank’s page. The ERP credits their advance only after the bank confirms."
      footer={made ? <Button variant="primary" onClick={close}>Done</Button> : <><Button onClick={close}>Cancel</Button><Button variant="primary" loading={busy} disabled={!(customerId ?? cust) || !(Number(amount) > 0)} onClick={async () => {
        setBusy(true); setErr(null);
        try { setMade(await api.post<{ number: string; link_token: string }>('/commerce/payments/links', { customer_id: customerId ?? cust, amount: Number(amount), purpose, ref_no: ref || null, order_id: orderId ?? null })); onDone?.(); } catch (e) { setErr(errMsg(e)); } finally { setBusy(false); }
      }}>Create link</Button></>}>
      {made ? (
        <div className="space-y-3"><Notice tone="success" title={`Link ${made.number} created`}>Share it with the customer by WhatsApp or email.</Notice><div className="flex items-center gap-2 rounded-lg bg-slate-50 p-3 font-mono text-[12px] ring-1 ring-slate-200"><span className="flex-1 break-all">{window.location.origin}/pay/{made.link_token}</span><CopyLink path={`/pay/${made.link_token}`} /></div></div>
      ) : (
        <div className="space-y-3">
          {err && <Notice tone="danger">{err}</Notice>}
          {!customerId && <Select label="Customer" required value={cust} onChange={(e) => setCust(e.target.value)} placeholder="Choose a customer" options={(customers.data ?? []).map((p) => ({ value: p.id, label: p.legal_name }))} />}
          <Input label="Amount" type="number" prefix="₹" required value={amount} onChange={(e) => setAmount(e.target.value)} />
          <Select label="For" value={purpose} onChange={(e) => setPurpose(e.target.value as 'advance' | 'invoice')} options={[{ value: 'advance', label: 'Advance payment' }, { value: 'invoice', label: 'Against an invoice' }]} />
          <Input label="Reference" hint="Invoice number or note" value={ref} onChange={(e) => setRef(e.target.value)} />
        </div>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------- token policies
interface Policy { id: string; name: string; scope: string; scope_ref: string | null; scope_label: string | null; basis: string; value: number; min_amount: number | null; max_amount: number | null; validity_days: number; refundable: boolean; cancellation_fee_pct: number; valid_from: string | null; valid_to: string | null; status: string; reason: string | null; requested_by_name: string; approved_by_name: string | null; created_at: string }
const SCOPE_ORDER = 'Customer › product › category › campaign › company default';

export function TokenPoliciesPage() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['com-policies'], queryFn: () => api.get<Policy[]>('/commerce/token-policies') });
  const [open, setOpen] = useState(false);
  const [off, setOff] = useState<Policy | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <>
      <PageHeader title="Token policies" description={`The booking token an advance customer pays before stock is held. The most specific active rule wins: ${SCOPE_ORDER}. Every new rule needs a second person to approve it.`}
        breadcrumbs={[{ label: 'B2B commerce' }, { label: 'Token policies' }]} actions={can('commerce.policy.manage') && <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setOpen(true)}>Propose a rule</Button>} />
      <Card padded={false}>
        {!q.data ? <Skeleton className="m-5 h-40" /> : (
          <SimpleTable rows={q.data} rowKey={(p) => p.id} empty={<EmptyState title="No policies" />} columns={[
            { key: 'n', header: 'Rule', render: (p) => <div><p className="font-medium">{p.name}</p><p className="text-[12px] text-slate-500">{humanize(p.scope)}{p.scope_label ? ` · ${p.scope_label}` : ''}{p.scope === 'campaign' ? ` · ${fmtDate(p.valid_from)}–${fmtDate(p.valid_to)}` : ''}</p></div> },
            { key: 'v', header: 'Token', render: (p) => <span className="tabular">{p.basis === 'percent' ? `${p.value}% of taxable` : fmtINR(Number(p.value))}{p.min_amount != null ? ` · min ${fmtINR(Number(p.min_amount))}` : ''}{p.max_amount != null ? ` · max ${fmtINR(Number(p.max_amount))}` : ''}</span> },
            { key: 'd', header: 'Holds stock', render: (p) => `${p.validity_days} days` },
            { key: 'r', header: 'If cancelled', render: (p) => (p.refundable ? `Refund less ${p.cancellation_fee_pct}%` : <Badge tone="warning">Non-refundable</Badge>) },
            { key: 'b', header: 'Proposed / approved', render: (p) => <span className="text-[12.5px]">{p.requested_by_name}{p.approved_by_name ? ` → ${p.approved_by_name}` : ''}</span> },
            { key: 's', header: 'Status', render: (p) => <StatusBadge status={p.status} /> },
            { key: 'a', header: '', render: (p) => can('commerce.policy.manage') && p.status === 'active' && p.scope !== 'global' ? <Button size="sm" variant="ghost" onClick={() => setOff(p)}>Switch off</Button> : null },
          ]} />
        )}
      </Card>
      <PolicyPreview />
      <PolicyModal open={open} onClose={() => setOpen(false)} onDone={() => invalidatePrefix(qc, 'com-policies')} />
      <ConfirmDialog open={!!off} onClose={() => setOff(null)} title={`Switch off “${off?.name}”?`} description="Orders already placed keep their token. New orders fall back to the next rule." requireReason loading={busy} tone="danger" confirmLabel="Switch off"
        onConfirm={async (reason) => { setBusy(true); try { await api.post(`/commerce/token-policies/${off!.id}/deactivate`, { reason }); setOff(null); invalidatePrefix(qc, 'com-policies'); } catch (e) { toast({ tone: 'error', title: 'Failed', body: errMsg(e) }); } finally { setBusy(false); } }} />
    </>
  );
}

function PolicyModal({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const customers = useParties('customer');
  const products = useProducts();
  const cats = useQuery({ queryKey: ['fabric-categories'], queryFn: () => api.get<{ id: string; name: string }[]>('/masters/fabric-categories'), enabled: open });
  const [v, setV] = useState({ name: '', scope: 'customer', scope_ref: '', basis: 'percent', value: '10', min_amount: '', max_amount: '', validity_days: '7', refundable: true, cancellation_fee_pct: '0', valid_from: '', valid_to: '', reason: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const targets = v.scope === 'customer' ? (customers.data ?? []).map((p) => ({ value: p.id, label: p.legal_name })) : v.scope === 'product' ? (products.data ?? []).map((p) => ({ value: p.id, label: `${p.sku} · ${p.name}` })) : v.scope === 'category' ? (cats.data ?? []).map((c) => ({ value: c.id, label: c.name })) : [];
  const num = (s: string) => (s === '' ? null : Number(s));
  return (
    <Modal open={open} onClose={onClose} size="lg" title="Propose a token rule" description="It takes effect after another authorised person approves it in Approvals."
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} onClick={async () => {
        setBusy(true); setErr(null);
        try {
          await api.post('/commerce/token-policies', { name: v.name, scope: v.scope, scope_ref: v.scope_ref || null, basis: v.basis, value: Number(v.value), min_amount: num(v.min_amount), max_amount: num(v.max_amount), validity_days: Number(v.validity_days), refundable: v.refundable, cancellation_fee_pct: Number(v.cancellation_fee_pct), valid_from: v.valid_from || null, valid_to: v.valid_to || null, reason: v.reason || null });
          toast({ tone: 'success', title: 'Sent for approval' }); onClose(); onDone();
        } catch (e) { setErr(errMsg(e)); } finally { setBusy(false); }
      }}>Send for approval</Button></>}>
      <div className="grid grid-cols-2 gap-3">
        {err && <div className="col-span-2"><Notice tone="danger">{err}</Notice></div>}
        <Input className="col-span-2" label="Name" required value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} />
        <Select label="Applies to" value={v.scope} onChange={(e) => setV({ ...v, scope: e.target.value, scope_ref: '' })} options={['customer', 'product', 'category', 'campaign', 'global'].map((s) => ({ value: s, label: s === 'global' ? 'Company default' : humanize(s) }))} />
        {targets.length > 0 || ['customer', 'product', 'category'].includes(v.scope) ? <Select label="Which" required value={v.scope_ref} onChange={(e) => setV({ ...v, scope_ref: e.target.value })} placeholder="Choose" options={targets} /> : <div />}
        {v.scope === 'campaign' && <><Input label="From" type="date" value={v.valid_from} onChange={(e) => setV({ ...v, valid_from: e.target.value })} /><Input label="To" type="date" value={v.valid_to} onChange={(e) => setV({ ...v, valid_to: e.target.value })} /></>}
        <Select label="Basis" value={v.basis} onChange={(e) => setV({ ...v, basis: e.target.value })} options={[{ value: 'percent', label: 'Percent of taxable value' }, { value: 'fixed', label: 'Fixed amount' }]} />
        <Input label={v.basis === 'percent' ? 'Percent' : 'Amount'} type="number" value={v.value} onChange={(e) => setV({ ...v, value: e.target.value })} suffix={v.basis === 'percent' ? '%' : undefined} prefix={v.basis === 'fixed' ? '₹' : undefined} />
        <Input label="Minimum token" type="number" prefix="₹" value={v.min_amount} onChange={(e) => setV({ ...v, min_amount: e.target.value })} />
        <Input label="Maximum token" type="number" prefix="₹" value={v.max_amount} onChange={(e) => setV({ ...v, max_amount: e.target.value })} />
        <Input label="Hold stock for" type="number" suffix="days" value={v.validity_days} onChange={(e) => setV({ ...v, validity_days: e.target.value })} />
        <Input label="Cancellation fee" type="number" suffix="%" disabled={!v.refundable} value={v.cancellation_fee_pct} onChange={(e) => setV({ ...v, cancellation_fee_pct: e.target.value })} />
        <div className="col-span-2"><Checkbox label="Refundable if the customer cancels" checked={v.refundable} onChange={(e) => setV({ ...v, refundable: e.target.checked })} /></div>
        <Textarea className="col-span-2" label="Why" value={v.reason} onChange={(e) => setV({ ...v, reason: e.target.value })} />
      </div>
    </Modal>
  );
}

function PolicyPreview() {
  const customers = useParties('customer');
  const products = useProducts();
  const [cust, setCust] = useState('');
  const [prod, setProd] = useState('');
  const [taxable, setTaxable] = useState('100000');
  const [out, setOut] = useState<{ amount: number; text: string; scope?: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  return (
    <Card className="mt-4" title="Test the rules" description="What token a customer would be asked for on an order.">
      <div className="grid grid-cols-1 items-end gap-3 sm:grid-cols-[1fr_1fr_160px_auto]">
        <Select label="Customer" value={cust} onChange={(e) => setCust(e.target.value)} placeholder="Choose" options={(customers.data ?? []).map((p) => ({ value: p.id, label: p.legal_name }))} />
        <Select label="Fabric" value={prod} onChange={(e) => setProd(e.target.value)} placeholder="Choose" options={(products.data ?? []).map((p) => ({ value: p.id, label: p.sku }))} />
        <Input label="Taxable value" type="number" prefix="₹" value={taxable} onChange={(e) => setTaxable(e.target.value)} />
        <Button disabled={!cust || !prod} onClick={async () => { setErr(null); try { setOut(await api.post('/commerce/token-policies/preview', { customer_id: cust, lines: [{ product_id: prod, taxable: Number(taxable) }] })); } catch (e) { setErr(errMsg(e)); } }}>Calculate</Button>
      </div>
      {err && <div className="mt-3"><Notice tone="danger">{err}</Notice></div>}
      {out && <p className="mt-3 text-[13.5px]">Token <span className="font-semibold tabular">{fmtINR(Number(out.amount))}</span> — {out.text}</p>}
    </Card>
  );
}

// ---------------------------------------------------------------- wallet
interface WRow { customer_id: string; customer_name: string; balance: number; received: number | null; applied: number | null; refunded: number | null; last_entry: string }
interface WEntry { id: number; entry_type: string; amount: number; ref_no: string | null; narration: string | null; by_name: string | null; at: string; running: number }

export function WalletPage() {
  const q = useQuery({ queryKey: ['com-wallet'], queryFn: () => api.get<WRow[]>('/commerce/wallet') });
  const [sel, setSel] = useState<WRow | null>(null);
  const total = (q.data ?? []).reduce((s, r) => s + Number(r.balance), 0);
  return (
    <>
      <PageHeader title="Customer advances" description="Money received from customers and not yet set against an invoice. It is owed to the customer until goods are invoiced, so it is shown here, not as sales. The ledger cannot be edited; corrections are new entries."
        breadcrumbs={[{ label: 'B2B commerce' }, { label: 'Customer advances' }]} />
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Held for customers" value={fmtINR(total)} />
        <Stat label="Customers with a balance" value={(q.data ?? []).filter((r) => Number(r.balance) > 0).length} />
      </div>
      <Card padded={false}>
        {!q.data ? <Skeleton className="m-5 h-40" /> : (
          <SimpleTable rows={q.data} rowKey={(r) => r.customer_id} onRowClick={setSel} empty={<EmptyState icon={<Wallet className="size-5" />} title="No advances yet" />} columns={[
            { key: 'c', header: 'Customer', render: (r) => r.customer_name },
            { key: 'r', header: 'Received', align: 'right', render: (r) => fmtINR(Number(r.received ?? 0)) },
            { key: 'a', header: 'Applied to invoices', align: 'right', render: (r) => fmtINR(Number(r.applied ?? 0)) },
            { key: 'f', header: 'Refunded', align: 'right', render: (r) => fmtINR(Number(r.refunded ?? 0)) },
            { key: 'b', header: 'Balance', align: 'right', render: (r) => <span className="font-semibold">{fmtINR(Number(r.balance))}</span> },
            { key: 'l', header: 'Last entry', render: (r) => fmtDateTime(r.last_entry) },
          ]} />
        )}
      </Card>
      <WalletDrawer row={sel} onClose={() => setSel(null)} />
    </>
  );
}

function WalletDrawer({ row, onClose }: { row: WRow | null; onClose: () => void }) {
  const q = useQuery({ queryKey: ['com-wallet', row?.customer_id], queryFn: () => api.get<{ balance: number; entries: WEntry[] }>(`/commerce/wallet/${row!.customer_id}`), enabled: !!row });
  return (
    <Drawer open={!!row} onClose={onClose} width="lg" title={row?.customer_name ?? ''} description={q.data ? `Balance ${fmtINR(q.data.balance)}` : undefined}>
      {!q.data ? <Skeleton className="h-60" /> : (
        <SimpleTable rows={q.data.entries} rowKey={(e) => String(e.id)} columns={[
          { key: 'd', header: 'When', render: (e) => fmtDateTime(e.at) },
          { key: 't', header: 'Entry', render: (e) => <div><p>{humanize(e.entry_type)}</p><p className="text-[12px] text-slate-500">{e.ref_no}{e.narration ? ` · ${e.narration}` : ''}</p></div> },
          { key: 'a', header: 'Amount', align: 'right', render: (e) => <span className={Number(e.amount) < 0 ? 'text-rose-600' : 'text-emerald-700'}>{fmtINR(Number(e.amount))}</span> },
          { key: 'r', header: 'Balance', align: 'right', render: (e) => fmtINR(Number(e.running)) },
        ]} />
      )}
    </Drawer>
  );
}

// ---------------------------------------------------------------- payments
interface PRow { id: string; number: string; customer_id: string; customer_name: string; order_id: string | null; order_no: string | null; purpose: string; ref_no: string | null; amount: number; status: string; gateway: string; utr: string | null; verified_at: string | null; refunded_amount: number; link_token: string; link_expires_at: string; created_at: string }
interface PDetail extends PRow { gateway_order_id: string; gateway_txn_id: string | null; failure_reason: string | null; events: { id: number; kind: string; signature_ok: boolean | null; detail: unknown; at: string }[]; refunds: { id: string; amount: number; reason: string; status: string; gateway_refund_id: string | null; created_by_name: string; created_at: string }[] }
interface Recon { payments: number; received: number; refunded: number; net: number; rejected_callbacks: number; issues: { payment: string; issue: string; amount: number }[] }

export function PaymentsPage() {
  const { can } = useAuth();
  const [tab, setTab] = useState<'payments' | 'recon'>('payments');
  const [status, setStatus] = useState('');
  const [sel, setSel] = useState<string | null>(null);
  const [link, setLink] = useState(false);
  const [offline, setOffline] = useState(false);
  const q = useQuery({ queryKey: ['com-payments', status], queryFn: () => api.get<PRow[]>(`/commerce/payments${status ? `?status=${status}` : ''}`), enabled: tab === 'payments' });
  const r = useQuery({ queryKey: ['com-recon'], queryFn: () => api.get<Recon>('/commerce/payments-reconciliation'), enabled: tab === 'recon' });
  return (
    <>
      <PageHeader title="Payments" description="Gateway payments count only when the bank’s signed callback and a separate status check agree. Money received by bank transfer, cheque or cash is recorded here as an offline payment."
        breadcrumbs={[{ label: 'B2B commerce' }, { label: 'Payments' }]} actions={can('commerce.payment.manage') && <div className="flex gap-2"><Button icon={<Landmark className="size-4" />} onClick={() => setOffline(true)}>Record offline payment</Button><Button variant="primary" icon={<Link2 className="size-4" />} onClick={() => setLink(true)}>New payment link</Button></div>} />
      <Tabs className="mb-4" value={tab} onChange={setTab} tabs={[{ value: 'payments', label: 'Payments' }, { value: 'recon', label: 'Reconciliation' }]} />
      {tab === 'payments' ? (
        <>
          <div className="mb-3"><Segmented value={status} onChange={setStatus} options={[{ value: '', label: 'All' }, { value: 'created', label: 'Awaiting' }, { value: 'success,partially_refunded', label: 'Received' }, { value: 'failed,expired', label: 'Failed / expired' }, { value: 'refunded,partially_refunded', label: 'Refunded' }]} /></div>
          <Card padded={false}>
            {!q.data ? <Skeleton className="m-5 h-40" /> : (
              <SimpleTable rows={q.data} rowKey={(p) => p.id} onRowClick={(p) => setSel(p.id)} empty={<EmptyState icon={<BadgeIndianRupee className="size-5" />} title="No payments" />} columns={[
                { key: 'n', header: 'Reference', render: (p) => <div><p className="font-mono text-[12.5px] font-semibold">{p.number}</p><p className="text-[12px] text-slate-500">{fmtDateTime(p.created_at)}</p></div> },
                { key: 'c', header: 'Customer', render: (p) => p.customer_name },
                { key: 'f', header: 'For', render: (p) => `${humanize(p.purpose)}${p.order_no ? ` · ${p.order_no}` : p.ref_no ? ` · ${p.ref_no}` : ''}` },
                { key: 'a', header: 'Amount', align: 'right', render: (p) => fmtINR(Number(p.amount)) },
                { key: 'u', header: 'UTR', render: (p) => <span className="font-mono text-[12px]">{p.utr ?? '—'}</span> },
                { key: 's', header: 'Status', render: (p) => <StatusBadge status={p.status} /> },
              ]} />
            )}
          </Card>
        </>
      ) : !r.data ? <Skeleton className="h-60" /> : (
        <>
          <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-5">
            <Stat label="Payments (90 days)" value={r.data.payments} />
            <Stat label="Received" value={fmtINR(r.data.received)} />
            <Stat label="Refunded" value={fmtINR(r.data.refunded)} />
            <Stat label="Net" value={fmtINR(r.data.net)} />
            <Stat label="Rejected callbacks" value={r.data.rejected_callbacks} tone={r.data.rejected_callbacks ? 'warning' : undefined} sub="bad signature" />
          </div>
          <Card title="Exceptions" description="Each payment is checked against the bank’s record and against the customer advance ledger." padded={false}>
            {r.data.issues.length === 0 ? <div className="p-5"><Notice tone="success">Everything ties up: every confirmed payment is credited once, and the bank agrees with each status.</Notice></div> : (
              <SimpleTable rows={r.data.issues} rowKey={(i) => i.payment + i.issue} columns={[
                { key: 'p', header: 'Payment', render: (i) => <span className="font-mono">{i.payment}</span> },
                { key: 'i', header: 'Issue', render: (i) => <span className="flex items-center gap-1.5"><ShieldAlert className="size-4 text-rose-500" />{i.issue}</span> },
                { key: 'a', header: 'Amount', align: 'right', render: (i) => fmtINR(i.amount) },
              ]} />
            )}
          </Card>
        </>
      )}
      <PaymentDrawer id={sel} onClose={() => setSel(null)} />
      <PaymentLinkModal open={link} onClose={() => setLink(false)} />
      <OfflinePaymentModal open={offline} onClose={() => setOffline(false)} />
    </>
  );
}

function PaymentDrawer({ id, onClose }: { id: string | null; onClose: () => void }) {
  const { can } = useAuth();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['com-payment', id], queryFn: () => api.get<PDetail>(`/commerce/payments/${id}`), enabled: !!id });
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const p = q.data;
  const left = p ? Number(p.amount) - Number(p.refunded_amount) : 0;
  return (
    <Drawer open={!!id} onClose={onClose} width="lg" title={p ? `Payment ${p.number}` : ''} description={p ? `${p.customer_name} · ${fmtINR(Number(p.amount))}` : undefined}>
      {!p ? <Skeleton className="h-60" /> : (
        <div className="space-y-5">
          <KeyValue items={[
            { label: 'Status', value: <StatusBadge status={p.status} /> },
            { label: 'Received by', value: p.gateway === 'offline' ? `Offline · ${(p.gateway_txn_id ?? '').split(':')[0].toUpperCase()}` : p.gateway },
            { label: 'Gateway order', value: p.gateway_order_id, mono: true },
            { label: 'Transaction', value: p.gateway_txn_id ?? '—', mono: true },
            { label: 'UTR', value: p.utr ?? '—', mono: true },
            { label: 'Verified', value: p.verified_at ? fmtDateTime(p.verified_at) : '—' },
            { label: 'Order', value: p.order_id ? <Link className="link" to={`/commerce/orders/${p.order_id}`}>{p.order_no}</Link> : '—' },
            { label: 'Refunded', value: fmtINR(Number(p.refunded_amount)) },
          ]} />
          {p.failure_reason && <Notice tone="danger">{p.failure_reason}</Notice>}
          <div>
            <p className="mb-2 text-[13px] font-semibold">Gateway events</p>
            <ul className="space-y-1.5 text-[12.5px]">{p.events.map((e) => <li key={e.id} className="flex gap-2"><span className="w-36 shrink-0 text-slate-500">{fmtDateTime(e.at)}</span><span className="font-medium">{humanize(e.kind)}</span>{e.signature_ok === false && <Badge tone="danger">bad signature</Badge>}{e.signature_ok === true && <Badge tone="success">signed</Badge>}</li>)}</ul>
          </div>
          {p.refunds.length > 0 && <div><p className="mb-2 text-[13px] font-semibold">Refunds</p><ul className="space-y-1 text-[12.5px]">{p.refunds.map((x) => <li key={x.id}>{fmtINR(Number(x.amount))} · {x.reason} · {x.created_by_name} · <StatusBadge status={x.status} /></li>)}</ul></div>}
          {can('commerce.payment.manage') && p.gateway !== 'offline' && ['success', 'partially_refunded'].includes(p.status) && left > 0 && (
            <Card title="Refund" description="Only money not yet set against an invoice can be refunded.">
              <div className="space-y-3">
                {err && <Notice tone="danger">{err}</Notice>}
                <Input label="Amount" type="number" prefix="₹" hint={`Up to ${fmtINR(left)} on this payment`} value={amount} onChange={(e) => setAmount(e.target.value)} />
                <Textarea label="Reason" required value={reason} onChange={(e) => setReason(e.target.value)} />
                <Button variant="danger" icon={<RotateCcw className="size-4" />} loading={busy} disabled={!(Number(amount) > 0) || reason.trim().length < 3} onClick={async () => {
                  setBusy(true); setErr(null);
                  try { await api.post(`/commerce/payments/${p.id}/refund`, { amount: Number(amount), reason }); setAmount(''); setReason(''); invalidatePrefix(qc, 'com-'); } catch (e) { setErr(errMsg(e)); } finally { setBusy(false); }
                }}>Refund to customer</Button>
              </div>
            </Card>
          )}
        </div>
      )}
    </Drawer>
  );
}

// ---------------------------------------------------------------- registrations
interface Reg { id: string; number: string; company_name: string; gstin: string | null; city: string | null; address: string | null; contact_name: string; email: string; phone: string; message: string | null; status: string; customer_id: string | null; decided_by_name: string | null; decided_at: string | null; note: string | null; created_at: string }

export function RegistrationsPage() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const [status, setStatus] = useState('pending');
  const q = useQuery({ queryKey: ['com-regs', status], queryFn: () => api.get<Reg[]>(`/commerce/registrations${status ? `?status=${status}` : ''}`) });
  const customers = useParties('customer');
  const [sel, setSel] = useState<Reg | null>(null);
  const [link, setLink] = useState('');
  const [reject, setReject] = useState<Reg | null>(null);
  const [made, setMade] = useState<{ email: string; temporary_password: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <>
      <PageHeader title="Customer registrations" description="Trade-account requests from the website. Approving creates the customer (or links an existing one) and the company’s first portal login."
        breadcrumbs={[{ label: 'B2B commerce' }, { label: 'Registrations' }]} />
      <div className="mb-4"><Segmented value={status} onChange={setStatus} options={[{ value: 'pending', label: 'Waiting' }, { value: 'approved', label: 'Approved' }, { value: 'rejected', label: 'Rejected' }]} /></div>
      <Card padded={false}>
        {!q.data ? <Skeleton className="m-5 h-40" /> : (
          <SimpleTable rows={q.data} rowKey={(r) => r.id} empty={<EmptyState icon={<UserPlus className="size-5" />} title="Nothing waiting" />} columns={[
            { key: 'n', header: 'Company', render: (r) => <div><p className="font-medium">{r.company_name}</p><p className="text-[12px] text-slate-500">{r.number} · {fmtDate(r.created_at)}</p></div> },
            { key: 'g', header: 'GSTIN', render: (r) => <span className="font-mono text-[12px]">{r.gstin ?? 'Unregistered'}</span> },
            { key: 'c', header: 'Contact', render: (r) => <div className="text-[12.5px]"><p>{r.contact_name}</p><p className="text-slate-500">{r.email} · {r.phone}</p></div> },
            { key: 'm', header: 'Buys', render: (r) => <span className="text-[12.5px]">{r.message ?? '—'}</span> },
            { key: 's', header: 'Status', render: (r) => <div><StatusBadge status={r.status} />{r.decided_by_name && <p className="text-[11.5px] text-slate-500">{r.decided_by_name}</p>}</div> },
            { key: 'a', header: '', render: (r) => r.status === 'pending' && can('commerce.registration.approve') ? <div className="flex gap-1"><Button size="sm" variant="primary" onClick={() => { setSel(r); setLink(''); setErr(null); }}>Approve</Button><Button size="sm" variant="ghost" onClick={() => setReject(r)}>Reject</Button></div> : null },
          ]} />
        )}
      </Card>
      <Modal open={!!sel || !!made} onClose={() => { setSel(null); setMade(null); }} title={made ? 'Account created' : `Approve ${sel?.company_name}`}
        footer={made ? <Button variant="primary" onClick={() => setMade(null)}>Done</Button> : <><Button onClick={() => setSel(null)}>Cancel</Button><Button variant="primary" loading={busy} onClick={async () => {
          setBusy(true); setErr(null);
          try { const r = await api.post<{ email: string; temporary_password: string }>(`/commerce/registrations/${sel!.id}/approve`, { customer_id: link || null }); setSel(null); setMade(r); invalidatePrefix(qc, 'com-regs'); } catch (e) { setErr(errMsg(e)); } finally { setBusy(false); }
        }}>Approve and create login</Button></>}>
        {made ? (
          <div className="space-y-3"><Notice tone="success">Send these to the customer. The password is shown only once and must be changed at first sign-in.</Notice>
            <KeyValue columns={1} items={[{ label: 'Sign-in email', value: made.email, mono: true }, { label: 'Temporary password', value: made.temporary_password, mono: true }]} /></div>
        ) : sel && (
          <div className="space-y-3">
            {err && <Notice tone="danger">{err}</Notice>}
            <p className="text-[13px] text-slate-600">Check the GSTIN on the GST portal before approving. Credit limits are set separately in Customer credit; new accounts start on advance terms.</p>
            <Select label="Existing customer" hint="Only if this company already buys from us offline" value={link} onChange={(e) => setLink(e.target.value)} placeholder="Create a new customer" options={(customers.data ?? []).map((p) => ({ value: p.id, label: `${p.legal_name}${p.gstin ? ` · ${p.gstin}` : ''}` }))} />
          </div>
        )}
      </Modal>
      <ConfirmDialog open={!!reject} onClose={() => setReject(null)} title={`Reject ${reject?.company_name}?`} requireReason tone="danger" confirmLabel="Reject" loading={busy}
        onConfirm={async (reason) => { setBusy(true); try { await api.post(`/commerce/registrations/${reject!.id}/reject`, { reason }); setReject(null); invalidatePrefix(qc, 'com-regs'); } finally { setBusy(false); } }} />
    </>
  );
}

// ---------------------------------------------------------------- complaints
interface Complaint { id: string; number: string; customer_name: string; order_id: string | null; order_no: string | null; category: string; subject: string; description: string; status: string; resolution: string | null; raised_by_name: string; assigned_to_name: string | null; created_at: string; updated_at: string }

export function ComplaintsPage() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const [status, setStatus] = useState('open,in_progress');
  const q = useQuery({ queryKey: ['com-complaints', status], queryFn: () => api.get<Complaint[]>(`/commerce/complaints?status=${status}`) });
  const [sel, setSel] = useState<Complaint | null>(null);
  const [next, setNext] = useState('in_progress');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <>
      <PageHeader title="Customer complaints" description="Raised by customers from the portal. Quality and short-delivery complaints usually lead to a return or a transport claim." breadcrumbs={[{ label: 'B2B commerce' }, { label: 'Complaints' }]} />
      <div className="mb-4"><Segmented value={status} onChange={setStatus} options={[{ value: 'open,in_progress', label: 'Open' }, { value: 'resolved,closed', label: 'Resolved' }]} /></div>
      <Card padded={false}>
        {!q.data ? <Skeleton className="m-5 h-40" /> : (
          <SimpleTable rows={q.data} rowKey={(c) => c.id} onRowClick={(c) => { setSel(c); setNext(c.status === 'open' ? 'in_progress' : 'resolved'); setNote(c.resolution ?? ''); }} empty={<EmptyState icon={<MessageSquareWarning className="size-5" />} title="No complaints" />} columns={[
            { key: 'n', header: 'Complaint', render: (c) => <div><p className="font-medium">{c.subject}</p><p className="text-[12px] text-slate-500">{c.number} · {fmtDate(c.created_at)}</p></div> },
            { key: 'c', header: 'Customer', render: (c) => c.customer_name },
            { key: 'k', header: 'Type', render: (c) => humanize(c.category) },
            { key: 'o', header: 'Order', render: (c) => c.order_no ?? '—' },
            { key: 'a', header: 'Handled by', render: (c) => c.assigned_to_name ?? '—' },
            { key: 's', header: 'Status', render: (c) => <StatusBadge status={c.status} /> },
          ]} />
        )}
      </Card>
      <Modal open={!!sel} onClose={() => setSel(null)} size="lg" title={sel?.subject ?? ''} description={sel ? `${sel.number} · ${sel.customer_name} · raised by ${sel.raised_by_name}` : undefined}
        footer={can('commerce.order.manage', 'fulfilment.returns.manage') ? <><Button onClick={() => setSel(null)}>Close</Button><Button variant="primary" loading={busy} onClick={async () => {
          setBusy(true); try { await api.patch(`/commerce/complaints/${sel!.id}`, { status: next, resolution: note || null }); setSel(null); invalidatePrefix(qc, 'com-complaints'); } finally { setBusy(false); }
        }}>Update</Button></> : undefined}>
        {sel && (
          <div className="space-y-3">
            <p className="whitespace-pre-wrap text-[13.5px]">{sel.description}</p>
            {sel.order_id && <Link className="link text-[13px]" to={`/commerce/orders/${sel.order_id}`}>Open order {sel.order_no} →</Link>}
            {can('commerce.order.manage', 'fulfilment.returns.manage') && <>
              <Select label="Status" value={next} onChange={(e) => setNext(e.target.value)} options={['open', 'in_progress', 'resolved', 'closed'].map((s) => ({ value: s, label: humanize(s) }))} />
              <Textarea label="Resolution / reply to customer" value={note} onChange={(e) => setNote(e.target.value)} />
            </>}
          </div>
        )}
      </Modal>
    </>
  );
}

