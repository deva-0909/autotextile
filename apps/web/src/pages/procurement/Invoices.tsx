import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, BookCheck, CheckCircle2, RefreshCw, Wallet, XCircle } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, invalidatePrefix } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { fmtDate, fmtDateTime, fmtINR, fmtNum } from '../../lib/format';
import { DataTable, FilterSelect, SimpleTable } from '../../components/DataTable';
import { ConfirmDialog, useToast } from '../../components/overlay';
import { Preview } from '../../components/Documents';
import { Badge, Button, Card, ErrorState, KeyValue, Notice, PageHeader, Skeleton, Stat, StatusBadge, Tabs } from '../../components/ui';

interface InvRow { id: string; supplier_name: string; supplier_gstin: string | null; invoice_number: string; invoice_date: string; due_date: string; po_number: string | null; total_value: number; status: string; match_status: string; payment_status: string }
interface Issue { code: string; severity: string; message: string; line_no?: number }
interface InvDetail extends InvRow { po_id: string | null; capture_id: string | null; document_id: string | null; taxable_value: number; cgst: number; sgst: number; igst: number; match_result: Issue[]; hold_reason: string | null; created_by: string; created_by_name: string; posted_by_name: string | null; posted_at: string | null; payment_approved_by_name: string | null;
  lines: { id: string; line_no: number; description: string; hsn_code: string | null; qty_kg: number; rate: number; taxable: number; gst_rate: number; sku: string | null; po_qty: number | null; po_rate: number | null; received_kg: number | null; invoiced_kg: number | null }[];
  po: { id: string; number: string; status: string; tax_type: string; deliver_to_name: string } | null; ledger: { id: number; credit: number; entry_date: string; due_date: string }[] }
interface ApSummary { totals: { outstanding: number; overdue: number; due_7d: number }; approved_for_payment: { n: number; value: number }; suppliers: { supplier_id: string; supplier_name: string; outstanding: number; overdue: number; due_7d: number; age_1_30: number; age_31_60: number; age_60_plus: number; next_due: string | null }[] }

export function InvoicesPage() {
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') ?? 'invoices';
  const [filters, setFilters] = useState<Record<string, string>>({});
  return (
    <>
      <PageHeader title="Supplier invoices & payables" description="Invoices are matched against PO and receipts. Matched invoices post to the AP ledger; variances need a checker. Payment approval is separate." breadcrumbs={[{ label: 'Procurement', to: '/procurement' }, { label: 'Supplier invoices' }]}
        actions={<Link to="/procurement/invoice-workbench"><Button variant="primary">Upload invoices</Button></Link>} />
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

export function InvoiceDetailPage() {
  const { id = '' } = useParams();
  const { can, user } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['invoice', id], queryFn: () => api.get<InvDetail>(`/procurement/invoices/${id}`) });
  const [dialog, setDialog] = useState<'variance' | 'reject' | null>(null);
  const [preview, setPreview] = useState(false);
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
      {preview && inv.document_id && <Preview doc={{ id: inv.document_id, title: inv.invoice_number, mime_type: 'application/pdf' }} version={1} onClose={() => setPreview(false)} />}
    </>
  );
}
