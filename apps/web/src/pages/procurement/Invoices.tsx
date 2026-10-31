import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, BookCheck, CheckCircle2, PenLine, Plus, RefreshCw, Wallet, XCircle } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, invalidatePrefix } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { fmtDate, fmtDateTime, fmtINR, fmtNum } from '../../lib/format';
import { DataTable, FilterSelect, SimpleTable } from '../../components/DataTable';
import { ConfirmDialog, Modal, useToast } from '../../components/overlay';
import { useParties } from '../../components/business';
import { Preview } from '../../components/Documents';
import { Badge, Button, Card, ErrorState, Input, KeyValue, Notice, PageHeader, Segmented, Select, Skeleton, Stat, StatusBadge, Tabs } from '../../components/ui';

interface MLine { po_line_id: string | null; description: string; hsn_code: string; qty_kg: string; rate: string; gst_rate: string }
const r2 = (n: number) => Math.round(n * 100) / 100;
/**
 * A supplier invoice typed in from paper (no upload). Choosing the purchase order fills its lines; the invoice then
 * goes through the same three-way match (PO, goods receipt, invoice) and posting rules as an uploaded one.
 */
function ManualInvoiceModal({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (id: string) => void }) {
  const suppliers = useParties('supplier,manufacturer,mill,transporter');
  const qc = useQueryClient();
  const today = new Date().toISOString().slice(0, 10);
  const blankLine = (): MLine => ({ po_line_id: null, description: '', hsn_code: '', qty_kg: '', rate: '', gst_rate: '5' });
  const [sup, setSup] = useState('');
  const [poId, setPoId] = useState('');
  const [no, setNo] = useState('');
  const [date, setDate] = useState(today);
  const [intra, setIntra] = useState(true);
  const [lines, setLines] = useState<MLine[]>([blankLine()]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const pos = useQuery({ queryKey: ['proc-po-open', sup], enabled: open && !!sup,
    queryFn: () => api.get<{ items: { id: string; number: string; status: string; total_value: number }[] }>(`/procurement/purchase-orders?pageSize=50&f_supplier=${sup}&f_status=sent,accepted,partially_received,received`).then((r) => r.items) });
  const reset = () => { setSup(''); setPoId(''); setNo(''); setDate(today); setLines([blankLine()]); setErr(null); };
  const choosePo = async (id: string) => {
    setPoId(id);
    if (!id) return;
    const po = await api.get<{ tax_type: string; lines: { id: string; sku: string; product_name: string; hsn_code: string | null; qty_kg: number; received_kg: number; invoiced_kg: number; rate_per_kg: number; gst_rate: number }[] }>(`/procurement/purchase-orders/${id}`);
    setIntra(po.tax_type !== 'inter');
    setLines(po.lines.map((l) => {
      const open = Math.max(0, Number(l.received_kg || l.qty_kg) - Number(l.invoiced_kg || 0));
      return { po_line_id: l.id, description: `${l.sku} · ${l.product_name}`, hsn_code: l.hsn_code ?? '', qty_kg: String(r2(open)), rate: String(l.rate_per_kg), gst_rate: String(l.gst_rate) };
    }));
  };
  const chooseSupplier = (id: string) => {
    setSup(id); setPoId(''); setLines([blankLine()]);
    const st = suppliers.data?.find((x) => x.id === id)?.state_code;
    if (st) setIntra(st === '24');
  };
  const calc = lines.map((l) => { const t = r2(Number(l.qty_kg || 0) * Number(l.rate || 0)); return { taxable: t, tax: r2((t * Number(l.gst_rate || 0)) / 100) }; });
  const taxable = r2(calc.reduce((a, c) => a + c.taxable, 0));
  const tax = r2(calc.reduce((a, c) => a + c.tax, 0));
  const half = r2(tax / 2);
  const ok = !!sup && no.trim() && lines.every((l) => l.description.trim() && Number(l.qty_kg) > 0 && Number(l.rate) > 0);
  const set = (i: number, k: keyof MLine, v: string) => setLines(lines.map((l, j) => (j === i ? { ...l, [k]: v } : l)));
  return (
    <Modal open={open} onClose={() => { reset(); onClose(); }} size="lg" title="Enter a supplier invoice" description="For invoices received on paper. Choose the purchase order to fill its lines: the invoice is matched against the PO and goods receipt, then posted to payables, GST input credit and TDS like an uploaded one."
      footer={<><Button onClick={() => { reset(); onClose(); }}>Cancel</Button><Button variant="primary" loading={busy} disabled={!ok} onClick={async () => {
        setBusy(true); setErr(null);
        try {
          const r = await api.post<{ id: string }>('/procurement/invoices', { supplier_id: sup, invoice_number: no.trim(), invoice_date: date, po_id: poId || null, taxable_value: taxable,
            cgst: intra ? half : 0, sgst: intra ? r2(tax - half) : 0, igst: intra ? 0 : tax, total_value: r2(taxable + tax),
            lines: lines.map((l) => ({ po_line_id: l.po_line_id, description: l.description.trim(), hsn_code: l.hsn_code || null, qty_kg: Number(l.qty_kg), rate: Number(l.rate), gst_rate: Number(l.gst_rate || 0) })) });
          invalidatePrefix(qc, 'proc-'); reset(); onClose(); onCreated(r.id);
        } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
      }}>Save and match</Button></>}>
      <div className="space-y-3">
        {err && <Notice tone="danger">{err}</Notice>}
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Select label="Supplier" required value={sup} onChange={(e) => chooseSupplier(e.target.value)} placeholder="Choose a supplier" options={(suppliers.data ?? []).map((p) => ({ value: p.id, label: p.legal_name }))} />
          <Select label="Purchase order" value={poId} onChange={(e) => void choosePo(e.target.value)} placeholder={!sup ? 'Choose the supplier first' : pos.data?.length ? 'Without a PO' : 'No open POs'} options={(pos.data ?? []).map((p) => ({ value: p.id, label: `${p.number} · ${fmtINR(p.total_value)}` }))} />
          <Input label="Supplier’s invoice number" required value={no} onChange={(e) => setNo(e.target.value)} />
          <Input label="Invoice date" type="date" required max={today} value={date} onChange={(e) => setDate(e.target.value)} />
        </div>
        <Segmented value={intra ? 'intra' : 'inter'} onChange={(v) => setIntra(v === 'intra')} options={[{ value: 'intra', label: 'Same state: CGST + SGST' }, { value: 'inter', label: 'Other state: IGST' }]} />
        <table className="w-full text-[13px]">
          <thead><tr className="text-left text-[11.5px] text-slate-500 uppercase"><th className="py-1">Item</th><th className="w-24 py-1">HSN</th><th className="w-24 py-1 text-right">Qty (kg)</th><th className="w-28 py-1 text-right">Rate ₹/kg</th><th className="w-20 py-1 text-right">GST %</th><th className="w-28 py-1 text-right">Taxable</th><th className="w-8" /></tr></thead>
          <tbody>{lines.map((l, i) => (
            <tr key={i} className="border-t border-slate-100">
              <td className="py-1 pr-2"><input className="input h-8" value={l.description} onChange={(e) => set(i, 'description', e.target.value)} placeholder="Fabric / service" /></td>
              <td className="py-1 pr-2"><input className="input h-8" value={l.hsn_code} onChange={(e) => set(i, 'hsn_code', e.target.value)} /></td>
              <td className="py-1 pr-2"><input className="input h-8 text-right" type="number" value={l.qty_kg} onChange={(e) => set(i, 'qty_kg', e.target.value)} /></td>
              <td className="py-1 pr-2"><input className="input h-8 text-right" type="number" value={l.rate} onChange={(e) => set(i, 'rate', e.target.value)} /></td>
              <td className="py-1 pr-2"><input className="input h-8 text-right" type="number" value={l.gst_rate} onChange={(e) => set(i, 'gst_rate', e.target.value)} /></td>
              <td className="py-1 text-right tabular">{fmtINR(calc[i]!.taxable)}</td>
              <td className="py-1 text-right">{lines.length > 1 && <button className="text-slate-400 hover:text-rose-600" onClick={() => setLines(lines.filter((_, j) => j !== i))} aria-label="Remove line"><XCircle className="size-4" /></button>}</td>
            </tr>))}</tbody>
        </table>
        <div className="flex items-start justify-between">
          <Button size="sm" variant="ghost" icon={<Plus className="size-3.5" />} onClick={() => setLines([...lines, blankLine()])}>Add line</Button>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-0.5 text-right text-[13px]">
            <dt className="text-slate-500">Taxable</dt><dd className="tabular">{fmtINR(taxable)}</dd>
            {intra ? <><dt className="text-slate-500">CGST</dt><dd className="tabular">{fmtINR(half)}</dd><dt className="text-slate-500">SGST</dt><dd className="tabular">{fmtINR(r2(tax - half))}</dd></> : <><dt className="text-slate-500">IGST</dt><dd className="tabular">{fmtINR(tax)}</dd></>}
            <dt className="font-semibold">Total</dt><dd className="font-semibold tabular">{fmtINR(r2(taxable + tax))}</dd>
          </dl>
        </div>
      </div>
    </Modal>
  );
}

interface InvRow { id: string; supplier_name: string; supplier_gstin: string | null; invoice_number: string; invoice_date: string; due_date: string; po_number: string | null; total_value: number; status: string; match_status: string; payment_status: string }
interface Issue { code: string; severity: string; message: string; line_no?: number }
interface InvDetail extends InvRow { supplier_id: string; po_id: string | null; capture_id: string | null; document_id: string | null; taxable_value: number; cgst: number; sgst: number; igst: number; match_result: Issue[]; hold_reason: string | null; created_by: string; created_by_name: string; posted_by_name: string | null; posted_at: string | null; payment_approved_by_name: string | null;
  lines: { id: string; line_no: number; description: string; hsn_code: string | null; qty_kg: number; rate: number; taxable: number; gst_rate: number; sku: string | null; po_qty: number | null; po_rate: number | null; received_kg: number | null; invoiced_kg: number | null }[];
  po: { id: string; number: string; status: string; tax_type: string; deliver_to_name: string } | null; ledger: { id: number; credit: number; entry_date: string; due_date: string }[] }
interface ApSummary { totals: { outstanding: number; overdue: number; due_7d: number }; approved_for_payment: { n: number; value: number }; suppliers: { supplier_id: string; supplier_name: string; outstanding: number; overdue: number; due_7d: number; age_1_30: number; age_31_60: number; age_60_plus: number; next_due: string | null }[] }

export function InvoicesPage() {
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') ?? 'invoices';
  const [filters, setFilters] = useState<Record<string, string>>({});
  const { can } = useAuth();
  const [manual, setManual] = useState(false);
  return (
    <>
      <ManualInvoiceModal open={manual} onClose={() => setManual(false)} onCreated={(id) => nav(`/procurement/invoices/${id}`)} />
      <PageHeader title="Supplier invoices & payables" description="Invoices are matched against PO and receipts. Matched invoices post to the AP ledger; variances need a checker. Payment approval is separate." breadcrumbs={[{ label: 'Procurement', to: '/procurement' }, { label: 'Supplier invoices' }]}
        actions={<div className="flex gap-2">{can('procurement.invoice.capture') && <Button icon={<PenLine className="size-4" />} onClick={() => setManual(true)}>Enter invoice manually</Button>}<Link to="/procurement/invoice-workbench"><Button variant="primary">Upload invoices</Button></Link></div>} />
      <Tabs className="mb-5" value={tab} onChange={(t) => setParams({ tab: t })} tabs={[{ value: 'invoices', label: 'Invoices' }, { value: 'ap', label: 'Accounts payable' }]} />
      {tab === 'invoices' ? (
        <DataTable<InvRow>
          id="supplier-invoices" endpoint="/procurement/invoices" filters={filters} onFiltersChange={setFilters} defaultSort={{ key: 'invoice_date', dir: 'desc' }} onRowClick={(r) => nav(`/procurement/invoices/${r.id}`)}
          searchPlaceholder="Search invoice no., supplier, GSTIN…"
          toolbar={<>
            <FilterSelect placeholder="All statuses" value={filters.status} onChange={(v) => setFilters({ ...filters, status: v })} options={[{ value: 'draft', label: 'Draft' }, { value: 'pending_approval', label: 'Awaiting approval' }, { value: 'posted', label: 'Posted' }, { value: 'rejected', label: 'Rejected' }]} />
            <FilterSelect placeholder="Any match" value={filters.match} onChange={(v) => setFilters({ ...filters, match: v })} options={[{ value: 'matched', label: 'Matched' }, { value: 'variance', label: 'Variance' }, { value: 'no_receipt', label: 'No receipt' }, { value: 'no_po', label: 'No PO' }]} />
            <FilterSelect placeholder="Any payment" value={filters.payment} onChange={(v) => setFilters({ ...filters, payment: v })} options={[{ value: 'unpaid', label: 'Unpaid' }, { value: 'approved', label: 'Approved for payment' }]} />
          </>}
          columns={[
            { key: 'number', header: 'Invoice', csv: (r) => r.invoice_number, render: (r) => <div><p className="font-mono text-[12.5px] font-semibold text-slate-900">{r.invoice_number}</p><p className="text-[12px] text-slate-500">{fmtDate(r.invoice_date)}</p></div> },
            { key: 'supplier', header: 'Supplier', sort: 'supplier_name', csv: (r) => r.supplier_name, render: (r) => r.supplier_name },
            { key: 'po', header: 'PO', csv: (r) => r.po_number, render: (r) => (r.po_number ? <span className="font-mono text-[12px]">{r.po_number}</span> : <span className="text-slate-400">—</span>) },
            { key: 'total', header: 'Total', align: 'right', sort: 'total_value', csv: (r) => r.total_value, render: (r) => fmtINR(r.total_value) },
            { key: 'match', header: 'Match', csv: (r) => r.match_status, render: (r) => <StatusBadge status={r.match_status} /> },
            { key: 'status', header: 'Status', sort: 'status', csv: (r) => r.status, render: (r) => <StatusBadge status={r.status} /> },
            { key: 'due', header: 'Due', sort: 'due_date', csv: (r) => r.due_date, render: (r) => <span className={r.status === 'posted' && r.payment_status !== 'paid' && new Date(r.due_date) < new Date() ? 'font-medium text-rose-600' : ''}>{fmtDate(r.due_date)}</span> },
            { key: 'pay', header: 'Payment', csv: (r) => r.payment_status, render: (r) => (r.status === 'posted' ? <StatusBadge status={r.payment_status === 'approved' ? 'approved' : r.payment_status} /> : '—') },
          ]}
          empty={{ title: 'No supplier invoices yet', description: 'Upload them in the invoice workbench.' }}
        />
      ) : <ApView />}
    </>
  );
}

function ApView() {
  const q = useQuery({ queryKey: ['ap-summary'], queryFn: () => api.get<ApSummary>('/procurement/ap/summary') });
  const d = q.data;
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="Outstanding to suppliers" value={fmtINR(d?.totals.outstanding)} />
        <Stat label="Overdue" value={fmtINR(d?.totals.overdue)} tone={d?.totals.overdue ? 'danger' : undefined} />
        <Stat label="Due in 7 days" value={fmtINR(d?.totals.due_7d)} tone={d?.totals.due_7d ? 'warning' : undefined} />
        <Stat label="Approved for payment" value={fmtINR(d?.approved_for_payment.value)} sub={`${d?.approved_for_payment.n ?? 0} invoices`} tone="success" />
      </div>
      <Card title="Ageing by supplier" description="From the AP sub-ledger. Payments are recorded with accounting (P8)." padded={false}>
        <SimpleTable rows={d?.suppliers ?? []} rowKey={(r) => r.supplier_id} columns={[
          { key: 'name', header: 'Supplier', render: (r) => <span className="font-medium text-slate-900">{r.supplier_name}</span> },
          { key: 'out', header: 'Outstanding', align: 'right', render: (r) => fmtINR(r.outstanding) },
          { key: 'due7', header: 'Due ≤ 7 days', align: 'right', render: (r) => fmtINR(r.due_7d) },
          { key: 'a1', header: '1–30 overdue', align: 'right', render: (r) => (r.age_1_30 ? <span className="text-amber-700">{fmtINR(r.age_1_30)}</span> : '—') },
          { key: 'a2', header: '31–60', align: 'right', render: (r) => (r.age_31_60 ? <span className="text-rose-600">{fmtINR(r.age_31_60)}</span> : '—') },
          { key: 'a3', header: '60+', align: 'right', render: (r) => (r.age_60_plus ? <span className="font-semibold text-rose-700">{fmtINR(r.age_60_plus)}</span> : '—') },
          { key: 'next', header: 'Next due', render: (r) => fmtDate(r.next_due) },
        ]} empty={<p className="px-5 py-8 text-center text-[13px] text-slate-500">Nothing outstanding.</p>} />
      </Card>
    </div>
  );
}

/** Pays an approved supplier invoice from the bank (or cash). Finance books it against the bill; the invoice then shows as paid. */
function SupplierPaymentModal({ inv, open, onClose, onDone }: { inv: InvDetail; open: boolean; onClose: () => void; onDone: () => void }) {
  const today = new Date().toISOString().slice(0, 10);
  const [v, setV] = useState({ amount: '', mode: 'neft', reference: '', date: today });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const toast = useToast();
  return (
    <Modal open={open} onClose={onClose} title={`Pay ${inv.invoice_number}`} description={`${inv.supplier_name} · the payment is posted to the bank (or cash) and settles the payable. Payments above the approval limit, or to a supplier whose bank details changed recently, go to a checker first.`}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} disabled={(v.amount !== '' && !(Number(v.amount) > 0)) || v.reference.trim().length < 3} onClick={async () => {
        setBusy(true); setErr(null);
        try {
          const r = await api.post<{ number: string; status: string; fully_paid: boolean }>('/finance/supplier-payments', { party_id: inv.supplier_id, invoice_number: inv.invoice_number, amount: v.amount === '' ? undefined : Number(v.amount), mode: v.mode, reference: v.reference.trim(), date: v.date });
          toast({ tone: 'success', title: r.status === 'pending_approval' ? `${r.number} sent to a checker for approval` : `Paid · ${r.number}${r.fully_paid ? '' : ' (part payment)'}` });
          onDone(); onClose();
        } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
      }}>Record payment</Button></>}>
      <div className="space-y-3">
        {err && <Notice tone="danger">{err}</Notice>}
        <div className="grid grid-cols-2 gap-3">
          <Input label="Amount" type="number" prefix="₹" placeholder="Full amount owed" value={v.amount} onChange={(e) => setV({ ...v, amount: e.target.value })} hint="Leave blank to settle what is owed (net of TDS); enter less for a part payment" />
          <Input label="Paid on" type="date" required max={today} value={v.date} onChange={(e) => setV({ ...v, date: e.target.value })} />
          <Select label="Mode" value={v.mode} onChange={(e) => setV({ ...v, mode: e.target.value })} options={[{ value: 'neft', label: 'NEFT' }, { value: 'rtgs', label: 'RTGS' }, { value: 'imps', label: 'IMPS' }, { value: 'upi', label: 'UPI' }, { value: 'cheque', label: 'Cheque' }, { value: 'cash', label: 'Cash' }]} />
          <Input label={v.mode === 'cheque' ? 'Cheque number' : v.mode === 'cash' ? 'Voucher number' : 'UTR / reference'} required value={v.reference} onChange={(e) => setV({ ...v, reference: e.target.value })} />
        </div>
      </div>
    </Modal>
  );
}

export function InvoiceDetailPage() {
  const { id = '' } = useParams();
  const { can, user } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['invoice', id], queryFn: () => api.get<InvDetail>(`/procurement/invoices/${id}`) });
  const [dialog, setDialog] = useState<'variance' | 'reject' | null>(null);
  const [preview, setPreview] = useState(false);
  const [paying, setPaying] = useState(false);
  const refresh = () => { q.refetch(); invalidatePrefix(qc, '/procurement/invoices'); qc.invalidateQueries({ queryKey: ['governance-summary'] }); };
  const act = async (path: string, body: object = {}, msg?: string) => {
    try { const r = await api.post<{ status?: string }>(`/procurement/invoices/${id}/${path}`, body); refresh(); setDialog(null); toast({ tone: 'success', title: r?.status === 'pending_approval' ? 'Sent to a checker for variance approval' : msg ?? 'Done' }); } catch (e) { toast({ tone: 'error', title: (e as Error).message }); }
  };
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  if (!q.data) return <Skeleton className="h-96" />;
  const inv = q.data;
  const matched = inv.match_status === 'matched';
  const own = inv.created_by === user?.id;
  return (
    <>
      <PageHeader breadcrumbs={[{ label: 'Procurement', to: '/procurement' }, { label: 'Supplier invoices', to: '/procurement/invoices' }, { label: inv.invoice_number }]}
        title={<><span className="font-mono">{inv.invoice_number}</span> <StatusBadge status={inv.status} /> <StatusBadge status={inv.match_status} /></>}
        meta={<><span>{inv.supplier_name} <span className="font-mono text-slate-400">{inv.supplier_gstin}</span></span><span>Dated {fmtDate(inv.invoice_date)}</span><span>Due {fmtDate(inv.due_date)}</span>{inv.po && <Link className="link" to={`/procurement/purchase-orders/${inv.po.id}`}>{inv.po.number}</Link>}</>}
        actions={<>
          {inv.document_id && <Button onClick={() => setPreview(true)}>View document</Button>}
          {inv.capture_id && <Link to={`/procurement/invoice-workbench/${inv.capture_id}`}><Button>Extraction</Button></Link>}
          {inv.status === 'draft' && can('procurement.invoice.capture') && <><Button icon={<RefreshCw className="size-4" />} onClick={() => act('rematch', {}, 'Re-matched')}>Re-match</Button><Button variant="ghost" icon={<XCircle className="size-4" />} onClick={() => setDialog('reject')}>Reject</Button></>}
          {inv.status === 'draft' && matched && can('procurement.invoice.approve') && !own && <Button variant="primary" icon={<BookCheck className="size-4" />} onClick={() => act('post', {}, 'Posted to accounts payable')}>Post to AP</Button>}
          {inv.status === 'draft' && !matched && can('procurement.invoice.capture', 'procurement.invoice.approve') && <Button variant="primary" icon={<AlertTriangle className="size-4" />} onClick={() => setDialog('variance')}>Request variance approval</Button>}
          {inv.status === 'posted' && inv.payment_status === 'unpaid' && can('procurement.payment.approve') && <Button variant="primary" icon={<Wallet className="size-4" />} onClick={() => act('approve-payment', {}, 'Approved for payment')}>Approve for payment</Button>}
          {inv.status === 'posted' && inv.payment_status === 'approved' && can('finance.voucher.post') && <Button variant="primary" icon={<Wallet className="size-4" />} onClick={() => setPaying(true)}>Record payment</Button>}
        </>} />
      {inv.status === 'draft' && matched && own && <div className="mb-5"><Notice tone="info">This invoice matches. Someone other than you, with posting rights, must post it (maker-checker).</Notice></div>}
      {inv.status === 'pending_approval' && <div className="mb-5"><Notice tone="warning" title="Awaiting variance approval">{inv.hold_reason}</Notice></div>}
      {inv.hold_reason && inv.status === 'draft' && <div className="mb-5"><Notice tone="danger">{inv.hold_reason}</Notice></div>}
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
        <div className="space-y-6 xl:col-span-2">
          <Card title="Three-way match" description="Ordered (PO) vs received (receipts) vs billed (this invoice)" padded={false}>
            {inv.match_result.length === 0 ? <div className="flex items-center gap-2 px-5 py-4 text-[13.5px] text-emerald-700"><CheckCircle2 className="size-4" />Quantities, rates and tax agree with the PO and receipts within tolerance.</div> : (
              <ul className="divide-y divide-slate-100">
                {inv.match_result.map((i, k) => <li key={k} className="flex items-start gap-3 px-5 py-3 text-[13px]"><StatusBadge status={i.severity === 'critical' ? 'critical' : 'warning'} /><span className="flex-1">{i.message}</span>{i.line_no && <Badge>Line {i.line_no}</Badge>}</li>)}
              </ul>
            )}
          </Card>
          <Card title="Lines" padded={false}>
            <SimpleTable rows={inv.lines} rowKey={(l) => l.id} columns={[
              { key: 'd', header: 'Description', render: (l) => <div><p className="text-slate-900">{l.description}</p><p className="text-[12px] text-slate-500">{l.sku ? `PO line ${l.sku}` : 'Not linked to a PO line'}{l.hsn_code ? ` · HSN ${l.hsn_code}` : ''}</p></div> },
              { key: 'q', header: 'Billed kg', align: 'right', render: (l) => fmtNum(l.qty_kg) },
              { key: 'r', header: 'Received kg', align: 'right', render: (l) => (l.received_kg != null ? <span className={l.qty_kg > l.received_kg - (l.invoiced_kg ?? 0) + 0.001 && inv.status !== 'posted' ? 'font-semibold text-rose-600' : ''}>{fmtNum(l.received_kg)}</span> : '—') },
              { key: 'rate', header: 'Rate', align: 'right', render: (l) => <span>₹{l.rate}{l.po_rate != null && l.po_rate !== l.rate && <span className="block text-[11px] text-rose-600">PO ₹{l.po_rate}</span>}</span> },
              { key: 'gst', header: 'GST', align: 'right', render: (l) => `${l.gst_rate}%` },
              { key: 't', header: 'Taxable', align: 'right', render: (l) => fmtINR(l.taxable) },
            ]} />
          </Card>
        </div>
        <div className="space-y-6">
          <Card title="Amounts">
            <KeyValue columns={1} items={[{ label: 'Taxable value', value: fmtINR(inv.taxable_value) }, { label: inv.igst ? 'IGST' : 'CGST + SGST', value: inv.igst ? fmtINR(inv.igst) : `${fmtINR(inv.cgst)} + ${fmtINR(inv.sgst)}` }, { label: 'Invoice total', value: <span className="text-[16px] font-semibold">{fmtINR(inv.total_value)}</span> }]} />
          </Card>
          <Card title="Control trail">
            <KeyValue columns={1} items={[
              { label: 'Entered by', value: inv.created_by_name },
              { label: 'Posted', value: inv.posted_by_name ? `${inv.posted_by_name} · ${fmtDateTime(inv.posted_at)}` : null },
              { label: 'Payment', value: inv.payment_approved_by_name ? `Approved by ${inv.payment_approved_by_name}` : inv.status === 'posted' ? 'Not yet approved' : null },
              { label: 'AP ledger', value: inv.ledger.length ? `Credit ${fmtINR(inv.ledger[0]!.credit)} on ${fmtDate(inv.ledger[0]!.entry_date)}` : 'Not posted' },
            ]} />
          </Card>
        </div>
      </div>
      <ConfirmDialog open={dialog === 'variance'} onClose={() => setDialog(null)} requireReason reasonLabel="Why should this variance be accepted?" title="Request approval to post with variance" description="A checker with invoice approval rights decides in the approvals inbox." confirmLabel="Request approval" onConfirm={(r) => act('post', { reason: r })} />
      <ConfirmDialog open={dialog === 'reject'} onClose={() => setDialog(null)} requireReason tone="danger" title="Reject invoice?" description="Tell the supplier to issue a corrected invoice." confirmLabel="Reject" onConfirm={(r) => act('reject', { reason: r }, 'Invoice rejected')} />
      {paying && <SupplierPaymentModal inv={inv} open onClose={() => setPaying(false)} onDone={() => { refresh(); setTimeout(refresh, 2500); }} />}
      {preview && inv.document_id && <Preview doc={{ id: inv.document_id, title: inv.invoice_number, mime_type: 'application/pdf' }} version={1} onClose={() => setPreview(false)} />}
    </>
  );
}
