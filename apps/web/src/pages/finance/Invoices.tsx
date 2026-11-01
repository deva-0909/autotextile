import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, ShoppingBag, Trash2, Wallet } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Link } from '../../components/AppLink';
import { api, invalidatePrefix } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { GST_STATES, fmtDate, fmtDateTime, fmtINR, fmtNum, humanize } from '../../lib/format';
import { SimpleTable } from '../../components/DataTable';
import { ConfirmDialog, useToast } from '../../components/overlay';
import { useParties } from '../../components/business';
import { DocumentPreviewButton, DocumentSheet as DocumentSheetInline, PreviewModal, VersionHistory, type DocData } from '../../components/DocumentPreview';
import { Badge, Button, Card, ErrorState, Input, KeyValue, Notice, PageHeader, Segmented, Select, Skeleton, Stat, StatusBadge, Tabs, Textarea } from '../../components/ui';
import { useAccounts, useBooks } from './Ledger';

interface Line { description: string; hsn: string; qty: number; uom: string; rate: number; gst_rate: number; account?: string; sku?: string; taxable?: number; cgst?: number; sgst?: number; igst?: number }
interface Inv { id: string; root_id: string; version: number; kind: 'sales' | 'purchase'; mode: 'manual' | 'counter'; status: string; number: string | null; draft_no: string; book_id: string; doc_date: string; due_date: string | null; party_id: string | null; party_name: string; party_gstin: string | null; party_state: string | null; party_mobile: string | null; supplier_invoice_no: string | null; lines: Line[]; barcodes: string[];
  taxable: number; cgst: number; sgst: number; igst: number; round_off: number; total: number; tds_amount: number; payment_mode: string | null; amount_received: number; notes: string | null; created_by_name: string | null; approved_by_name: string | null; cancel_reason: string | null; created_at: string;
  book: { code: string; gstin: string; state_code: string; entity_name: string; name: string }; versions: { id: string; version: number; status: string; number: string | null }[]; is_latest: boolean; editable: boolean }

const blank = (): Line => ({ description: '', hsn: '6006', qty: 0, uom: 'kg', rate: 0, gst_rate: 5 });
const n = (x: unknown) => Number(x ?? 0);

/** The invoice as a printable document (same layout as every other document). */
export function invoiceDoc(i: Pick<Inv, 'kind' | 'mode' | 'number' | 'draft_no' | 'doc_date' | 'party_name' | 'party_gstin' | 'party_state' | 'party_mobile' | 'supplier_invoice_no' | 'lines' | 'taxable' | 'cgst' | 'sgst' | 'igst' | 'round_off' | 'total' | 'notes' | 'payment_mode' | 'status'> & { version?: number }, book?: Inv['book'] | null): DocData {
  return {
    title: i.kind === 'sales' ? (i.mode === 'counter' ? 'Tax invoice (cash sale)' : 'Tax invoice') : 'Purchase invoice (entered)', number: i.number ?? i.draft_no, date: i.doc_date, version: i.version, status: i.status,
    seller: i.kind === 'sales' ? { name: book?.entity_name ?? 'Our company', gstin: book?.gstin, lines: [book?.name] } : { name: i.party_name, gstin: i.party_gstin, lines: [i.supplier_invoice_no ? `Supplier invoice ${i.supplier_invoice_no}` : null] },
    party: i.kind === 'sales' ? { label: 'Bill to', name: i.party_name, gstin: i.party_gstin, state: i.party_state, lines: [i.party_mobile ? `Mobile ${i.party_mobile}` : null, !i.party_gstin ? 'Unregistered buyer (B2C)' : null] } : { label: 'Bill to', name: book?.entity_name ?? 'Our company', gstin: book?.gstin },
    meta: [{ label: 'Place of supply', value: i.party_state ? `${i.party_state} · ${GST_STATES[i.party_state] ?? ''}` : '—' }, ...(i.payment_mode ? [{ label: 'Paid by', value: humanize(i.payment_mode) }] : [])],
    lines: i.lines.map((l) => ({ description: l.description, hsn: l.hsn, qty: n(l.qty), uom: l.uom, rate: n(l.rate), gst_rate: n(l.gst_rate), taxable: l.taxable ?? n(l.qty) * n(l.rate) })),
    totals: [{ label: 'Taxable value', value: n(i.taxable) }, ...(n(i.igst) ? [{ label: 'IGST', value: n(i.igst) }] : [{ label: 'CGST', value: n(i.cgst) }, { label: 'SGST', value: n(i.sgst) }]), ...(n(i.round_off) ? [{ label: 'Rounding', value: n(i.round_off) }] : []), { label: 'Total', value: n(i.total), strong: true }],
    notes: i.notes,
  };
}

export function ManualInvoicesPage() {
  const nav = useNavigate();
  const { can } = useAuth();
  const [kind, setKind] = useState<'sales' | 'purchase'>('sales');
  const q = useQuery({ queryKey: ['fin-manual', kind], queryFn: () => api.get<Inv[]>(`/finance/manual-invoices?kind=${kind}`) });
  return (
    <>
      <PageHeader title="Manual invoices" description="Sales invoices without an order or dispatch (waste, services, sales from another place) and purchase invoices without a purchase order (expenses, services). Each is drafted, previewed, approved by a second person, then posted with GST, TDS and the party balance. A posted invoice is never edited: it is revised into a new version or cancelled with a reason."
        breadcrumbs={[{ label: 'Accounts', to: '/finance' }, { label: 'Manual invoices' }]}
        actions={can('finance.voucher.post') && <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => nav(`/finance/invoices/new?kind=${kind}`)}>New {kind} invoice</Button>} />
      <Tabs className="mb-4" value={kind} onChange={setKind} tabs={[{ value: 'sales', label: 'Sales' }, { value: 'purchase', label: 'Purchase' }]} />
      <Card padded={false}>
        {!q.data ? <Skeleton className="m-5 h-40" /> : <SimpleTable rows={q.data} rowKey={(r) => r.id} onRowClick={(r) => nav(`/finance/invoices/${r.id}`)} empty="No invoices yet" columns={[
          { key: 'n', header: 'Invoice', render: (r) => <span><span className="font-mono text-[12.5px] font-semibold">{r.number ?? r.draft_no}</span>{r.version > 1 && <Badge className="ml-1.5">v{r.version}</Badge>}{r.mode === 'counter' && <Badge tone="info" className="ml-1.5">Counter</Badge>}</span> },
          { key: 'd', header: 'Date', render: (r) => fmtDate(r.doc_date) },
          { key: 'p', header: kind === 'sales' ? 'Customer' : 'Supplier', render: (r) => <span>{r.party_name}{r.supplier_invoice_no && <span className="block text-[12px] text-slate-500">Their invoice {r.supplier_invoice_no}</span>}</span> },
          { key: 't', header: 'Total', align: 'right', render: (r) => fmtINR(n(r.total)) },
          { key: 's', header: 'Status', render: (r) => <StatusBadge status={r.status} /> },
          { key: 'b', header: 'By', render: (r) => <span className="text-[12.5px]">{r.created_by_name}{r.approved_by_name && <span className="block text-slate-500">approved {r.approved_by_name}</span>}</span> },
        ]} />}
      </Card>
    </>
  );
}

export function ManualInvoiceEditPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const toast = useToast();
  const qc = useQueryClient();
  const books = useBooks();
  const accounts = useAccounts();
  const params = new URLSearchParams(window.location.search);
  const existing = useQuery({ queryKey: ['fin-manual-one', id], queryFn: () => api.get<Inv>(`/finance/manual-invoices/${id}`), enabled: !!id });
  const [v, setV] = useState<{ kind: 'sales' | 'purchase'; book_id: string; doc_date: string; due_date: string; party_id: string; party_name: string; party_gstin: string; party_state: string; party_mobile: string; supplier_invoice_no: string; notes: string; barcodes: string; lines: Line[]; change_note: string }>({
    kind: (params.get('kind') as 'sales' | 'purchase') || 'sales', book_id: '', doc_date: new Date().toISOString().slice(0, 10), due_date: '', party_id: '', party_name: '', party_gstin: '', party_state: '', party_mobile: '', supplier_invoice_no: '', notes: '', barcodes: '', lines: [blank()], change_note: '',
  });
  const parties = useParties(v.kind === 'sales' ? 'customer' : 'supplier,manufacturer,mill,transporter');
  const [totals, setTotals] = useState<{ taxable: number; cgst: number; sgst: number; igst: number; round_off: number; total: number; lines: Line[] } | null>(null);
  const [preview, setPreview] = useState<DocData | null>(null);
  useEffect(() => {
    const i = existing.data;
    if (i) setV({ kind: i.kind, book_id: i.book_id, doc_date: i.doc_date.slice(0, 10), due_date: i.due_date?.slice(0, 10) ?? '', party_id: i.party_id ?? '', party_name: i.party_name, party_gstin: i.party_gstin ?? '', party_state: i.party_state ?? '', party_mobile: i.party_mobile ?? '', supplier_invoice_no: i.supplier_invoice_no ?? '', notes: i.notes ?? '', barcodes: i.barcodes.join('\n'), lines: i.lines.filter((l) => !l.sku), change_note: '' });
  }, [existing.data]);
  useEffect(() => { if (!v.book_id && books.data?.length) setV((x) => ({ ...x, book_id: books.data!.find((b) => b.is_primary)?.id ?? books.data![0]!.id })); }, [books.data, v.book_id]);
  if (id && existing.data && !existing.data.editable) return <Notice tone="warning" title="This version cannot be edited">Only the latest draft can be changed. <Link className="link" to={`/finance/invoices/${id}`}>Open it</Link> to revise or cancel.</Notice>;
  const bodyOf = () => ({
    kind: v.kind, book_id: v.book_id, doc_date: v.doc_date, due_date: v.due_date || null, party_id: v.party_id || null, party_name: v.party_name || null, party_gstin: v.party_gstin || null, party_state: v.party_state || null, party_mobile: v.party_mobile || null,
    supplier_invoice_no: v.supplier_invoice_no || null, notes: v.notes || null, change_note: v.change_note || null, barcodes: v.kind === 'sales' ? v.barcodes.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean) : [],
    lines: v.lines.filter((l) => l.description.trim()).map((l) => ({ description: l.description, hsn: l.hsn || null, qty: Number(l.qty), uom: l.uom || 'kg', rate: Number(l.rate), gst_rate: Number(l.gst_rate), account: v.kind === 'purchase' ? l.account || null : null })),
  });
  const compute = async () => { const t = await api.post<typeof totals>('/finance/manual-invoices/compute', bodyOf()); setTotals(t); return t!; };
  const book = books.data?.find((b) => b.id === v.book_id);
  const setLine = (i: number, k: keyof Line, x: string) => setV({ ...v, lines: v.lines.map((l, j) => (j === i ? { ...l, [k]: ['qty', 'rate', 'gst_rate'].includes(k) ? Number(x) : x } : l)) });
  async function save(submit: boolean) {
    try {
      const b = bodyOf();
      const r = id ? await api.put<{ id: string }>(`/finance/manual-invoices/${id}`, b) : await api.post<{ id: string }>('/finance/manual-invoices', b);
      if (submit) await api.post(`/finance/manual-invoices/${r.id}/submit`, {});
      invalidatePrefix(qc, 'fin-manual');
      toast({ tone: 'success', title: submit ? 'Sent for approval' : 'Draft saved', body: submit ? 'A second person approves it; it posts to the books on approval.' : 'Each save is kept as a version.' });
      nav(`/finance/invoices/${r.id}`);
    } catch (e) { toast({ tone: 'error', title: (e as Error).message }); }
  }
  return (
    <>
      <PageHeader title={id ? `Edit draft ${existing.data?.draft_no ?? ''}` : `New ${v.kind} invoice`} description={v.kind === 'sales' ? 'Uses the same tax-invoice number series as dispatch invoices when posted. Scan rolls to take them out of stock with this invoice, or enter lines by hand.' : 'For bills without a purchase order: services, expenses, freight. Input GST and TDS are worked out on posting.'}
        breadcrumbs={[{ label: 'Accounts', to: '/finance' }, { label: 'Manual invoices', to: '/finance/invoices' }, { label: id ? 'Edit' : 'New' }]}
        actions={<>
          <Button onClick={async () => { try { const t = await compute(); setPreview(invoiceDoc({ ...bodyOf(), mode: 'manual', number: null, draft_no: existing.data?.draft_no ?? 'DRAFT', party_name: v.party_name || parties.data?.find((p) => p.id === v.party_id)?.legal_name || 'Walk-in buyer', party_gstin: v.party_gstin || null, party_state: v.party_state || null, party_mobile: v.party_mobile || null, supplier_invoice_no: v.supplier_invoice_no || null, notes: v.notes || null, payment_mode: null, status: 'draft', ...t } as never, book ? { code: book.code, gstin: book.gstin, state_code: book.state_code, entity_name: 'Demo Textile Trading Pvt Ltd', name: book.name } : null)); } catch (e) { toast({ tone: 'error', title: (e as Error).message }); } }}>Preview</Button>
          <Button onClick={() => void save(false)}>Save draft</Button>
          <Button variant="primary" onClick={() => void save(true)}>Save and send for approval</Button>
        </>} />
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
        <Card className="xl:col-span-2" title="Lines">
          <div className="space-y-2">
            {v.lines.map((l, i) => (
              <div key={i} className="grid grid-cols-2 gap-2 rounded-lg border border-slate-200 p-2 md:grid-cols-[2fr_80px_90px_70px_100px_80px_auto]">
                <Input aria-label="Description" placeholder="Description" value={l.description} onChange={(e) => setLine(i, 'description', e.target.value)} />
                <Input aria-label="HSN/SAC" placeholder="HSN/SAC" value={l.hsn} onChange={(e) => setLine(i, 'hsn', e.target.value)} />
                <Input aria-label="Quantity" type="number" placeholder="Qty" value={String(l.qty || '')} onChange={(e) => setLine(i, 'qty', e.target.value)} />
                <Input aria-label="Unit" placeholder="kg" value={l.uom} onChange={(e) => setLine(i, 'uom', e.target.value)} />
                <Input aria-label="Rate" type="number" placeholder="Rate ₹" value={String(l.rate || '')} onChange={(e) => setLine(i, 'rate', e.target.value)} />
                <Select aria-label="GST rate" value={String(l.gst_rate)} onChange={(e) => setLine(i, 'gst_rate', e.target.value)} options={[0, 5, 12, 18, 28].map((x) => ({ value: String(x), label: `${x}%` }))} />
                <button type="button" className="text-slate-400 hover:text-rose-600" aria-label="Remove line" onClick={() => setV({ ...v, lines: v.lines.filter((_, j) => j !== i) })}><Trash2 className="size-4" /></button>
                {v.kind === 'purchase' && <Select className="col-span-2 md:col-span-7" aria-label="Expense account" value={l.account ?? ''} onChange={(e) => setLine(i, 'account', e.target.value)} options={[{ value: '', label: 'Account: Purchases' }, ...(accounts.data ?? []).filter((a) => a.type === 'expense' && a.allow_manual).map((a) => ({ value: a.code, label: `Account: ${a.code} ${a.name}` }))]} />}
              </div>
            ))}
            <Button size="sm" icon={<Plus className="size-3.5" />} onClick={() => setV({ ...v, lines: [...v.lines, blank()] })}>Add line</Button>
          </div>
          {v.kind === 'sales' && <Textarea className="mt-4" label="Rolls to take out of stock (optional)" hint="Scan or paste barcodes, one per line. They become lines at the lot’s tagged price and leave stock when the invoice posts." rows={3} value={v.barcodes} onChange={(e) => setV({ ...v, barcodes: e.target.value })} />}
          <div className="mt-4 flex items-center justify-between"><Button size="sm" onClick={() => void compute().catch((e) => toast({ tone: 'error', title: (e as Error).message }))}>Work out GST</Button>
            {totals && <span className="text-[13px]">Taxable {fmtINR(totals.taxable)} · GST {fmtINR(totals.cgst + totals.sgst + totals.igst)} · <b>Total {fmtINR(totals.total)}</b></span>}</div>
        </Card>
        <Card title="Details">
          <div className="space-y-3">
            <Segmented value={v.kind} onChange={(k) => !id && setV({ ...v, kind: k, party_id: '' })} options={[{ value: 'sales', label: 'Sales' }, { value: 'purchase', label: 'Purchase' }]} />
            <Select label="Our GST registration" value={v.book_id} onChange={(e) => setV({ ...v, book_id: e.target.value })} options={(books.data ?? []).map((b) => ({ value: b.id, label: `${b.code} · ${b.gstin}` }))} />
            <Input label="Invoice date" type="date" value={v.doc_date} onChange={(e) => setV({ ...v, doc_date: e.target.value })} />
            <Select label={v.kind === 'sales' ? 'Customer' : 'Supplier'} value={v.party_id} onChange={(e) => { const p = parties.data?.find((x) => x.id === e.target.value); setV({ ...v, party_id: e.target.value, party_name: p?.legal_name ?? '', party_gstin: p?.gstin ?? '', party_state: p?.state_code ?? '' }); }} options={[{ value: '', label: v.kind === 'sales' ? 'Walk-in / not in masters' : 'Choose…' }, ...(parties.data ?? []).map((p) => ({ value: p.id, label: p.legal_name }))]} />
            {v.kind === 'sales' && !v.party_id && <><Input label="Buyer name" value={v.party_name} onChange={(e) => setV({ ...v, party_name: e.target.value })} /><Input label="Mobile" value={v.party_mobile} onChange={(e) => setV({ ...v, party_mobile: e.target.value })} /></>}
            <Input label="GSTIN" hint="Blank for an unregistered buyer (B2C)" value={v.party_gstin} onChange={(e) => setV({ ...v, party_gstin: e.target.value.toUpperCase(), party_state: e.target.value.length >= 2 ? e.target.value.slice(0, 2) : v.party_state })} />
            <Select label="Place of supply" value={v.party_state} onChange={(e) => setV({ ...v, party_state: e.target.value })} options={[{ value: '', label: 'Same state as us' }, ...Object.entries(GST_STATES).map(([k, x]) => ({ value: k, label: `${k} · ${x}` }))]} />
            {v.kind === 'purchase' && <Input label="Supplier’s invoice number" required value={v.supplier_invoice_no} onChange={(e) => setV({ ...v, supplier_invoice_no: e.target.value })} />}
            <Input label="Due date" type="date" value={v.due_date} onChange={(e) => setV({ ...v, due_date: e.target.value })} />
            <Textarea label="Notes" value={v.notes} onChange={(e) => setV({ ...v, notes: e.target.value })} />
            {id && <Input label="What changed (kept in the version history)" value={v.change_note} onChange={(e) => setV({ ...v, change_note: e.target.value })} />}
          </div>
        </Card>
      </div>
      {preview && <PreviewModal d={preview} draft onClose={() => setPreview(null)} />}
    </>
  );
}

export function ManualInvoiceDetailPage() {
  const { id = '' } = useParams();
  const nav = useNavigate();
  const { can } = useAuth();
  const toast = useToast();
  const q = useQuery({ queryKey: ['fin-manual-one', id], queryFn: () => api.get<Inv>(`/finance/manual-invoices/${id}`) });
  const [dlg, setDlg] = useState<'cancel' | 'revise' | null>(null);
  if (q.isError) return <ErrorState error={q.error} />;
  const i = q.data;
  if (!i) return <Skeleton className="h-96" />;
  const doc = invoiceDoc(i, i.book);
  const act = async (path: string, body: object, msg: string) => { try { const r = await api.post<{ id?: string }>(`/finance/manual-invoices/${i.id}/${path}`, body); toast({ tone: 'success', title: msg }); setDlg(null); if (r?.id && r.id !== i.id) nav(`/finance/invoices/${r.id}/edit`); else q.refetch(); } catch (e) { toast({ tone: 'error', title: (e as Error).message }); } };
  return (
    <>
      <PageHeader title={`${i.kind === 'sales' ? 'Sales' : 'Purchase'} invoice ${i.number ?? i.draft_no}`} description={`${i.party_name} · ${fmtDate(i.doc_date)} · version ${i.version}${i.mode === 'counter' ? ' · counter sale' : ''}`} meta={<StatusBadge status={i.status} />}
        breadcrumbs={[{ label: 'Accounts', to: '/finance' }, { label: i.mode === 'counter' ? 'Counter sales' : 'Manual invoices', to: i.mode === 'counter' ? '/finance/counter' : '/finance/invoices' }, { label: i.number ?? i.draft_no }]}
        actions={<>
          <DocumentPreviewButton d={doc} draft={i.status !== 'posted'} />
          {i.editable && can('finance.voucher.post') && <><Button onClick={() => nav(`/finance/invoices/${i.id}/edit`)}>Edit draft</Button><Button variant="primary" onClick={() => void act('submit', {}, 'Sent for approval')}>Send for approval</Button></>}
          {i.status === 'posted' && i.is_latest && i.mode === 'manual' && can('finance.voucher.post') && !i.barcodes.length && <Button onClick={() => setDlg('revise')}>Revise</Button>}
          {['draft', 'posted'].includes(i.status) && i.is_latest && can('finance.voucher.post') && <Button variant="ghost" onClick={() => setDlg('cancel')}>Cancel invoice</Button>}
        </>} />
      {!i.is_latest && <div className="mb-4"><Notice tone="info" title="An older version">This version is kept read-only. <Link className="link" to={`/finance/invoices/${i.versions[0]!.id}`}>Open the latest version</Link>.</Notice></div>}
      {i.status === 'pending_approval' && <div className="mb-4"><Notice tone="warning">Waiting for a second person to approve it in the <Link className="link" to="/approvals">Approvals inbox</Link>. It posts to the books on approval.</Notice></div>}
      {i.status === 'cancelled' && <div className="mb-4"><Notice tone="danger">Cancelled: {i.cancel_reason}. {i.number ? 'Its postings were reversed; the number stays used.' : ''}</Notice></div>}
      <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Taxable" value={fmtINR(n(i.taxable))} /><Stat label="GST" value={fmtINR(n(i.cgst) + n(i.sgst) + n(i.igst))} /><Stat label="Total" value={fmtINR(n(i.total))} />{i.kind === 'purchase' ? <Stat label="TDS deducted" value={fmtINR(n(i.tds_amount))} /> : <Stat label={i.mode === 'counter' ? `Paid by ${humanize(i.payment_mode ?? '')}` : 'Customer'} value={i.mode === 'counter' ? fmtINR(n(i.amount_received)) : i.party_gstin ? 'B2B' : 'B2C'} />}
      </div>
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
        <div className="xl:col-span-2"><div className="bg-slate-100 p-3"><DocumentSheetInline d={doc} draft={i.status !== 'posted'} /></div></div>
        <div className="space-y-6">
          <Card title="Details"><KeyValue columns={1} items={[{ label: 'Prepared by', value: i.created_by_name }, { label: 'Approved by', value: i.approved_by_name ?? '—' }, { label: 'Rolls out of stock', value: i.barcodes.length ? `${i.barcodes.length} rolls` : 'None' }, { label: 'Created', value: fmtDateTime(i.created_at) }]} /></Card>
          <VersionHistory docType={i.kind === 'sales' ? 'manual_sales_invoice' : 'manual_purchase_invoice'} docId={i.root_id} render={(ver) => invoiceDoc({ ...(ver.data as unknown as Inv), version: ver.version }, i.book)} />
        </div>
      </div>
      <ConfirmDialog open={dlg === 'cancel'} onClose={() => setDlg(null)} requireReason tone="danger" title="Cancel this invoice" description={i.status === 'posted' ? 'The sales or purchase entry, GST and party balance are reversed. The number stays used and the invoice stays visible.' : 'The draft is closed.'} confirmLabel="Cancel invoice" onConfirm={(r) => act('cancel', { reason: r }, 'Invoice cancelled')} />
      <ConfirmDialog open={dlg === 'revise'} onClose={() => setDlg(null)} requireReason title="Revise this invoice" description="The posted invoice is cancelled (reversed in the books) and the next version opens as a draft for you to correct and send for approval." confirmLabel="Revise" onConfirm={(r) => act('revise', { reason: r }, 'New version opened')} />
    </>
  );
}


interface RollRow { barcode: string; sku: string; product_name: string; weight_kg: number; price_per_kg: number | null; lot_no: string }

/** Counter cash sale: walk-in buyer, scan rolls, invoice and receipt in one step. */
export function CounterSalePage() {
  const toast = useToast();
  const books = useBooks();
  const nav = useNavigate();
  const [v, setV] = useState({ book_id: '', buyer_name: '', buyer_mobile: '', buyer_gstin: '', payment_mode: 'cash', amount_received: '', notes: '' });
  const [codes, setCodes] = useState<string[]>([]);
  const [rolls, setRolls] = useState<RollRow[]>([]);
  const [code, setCode] = useState('');
  const [prices, setPrices] = useState<Record<string, string>>({});
  const [pv, setPv] = useState<{ total: number; taxable: number; cgst: number; sgst: number; igst: number; kg: number; warning: string | null; b2c: boolean; lines: Line[]; round_off: number } | null>(null);
  const [done, setDone] = useState<{ id: string; number: string; total: number; change: number } | null>(null);
  useEffect(() => { if (!v.book_id && books.data?.length) setV((x) => ({ ...x, book_id: books.data!.find((b) => b.is_primary)?.id ?? books.data![0]!.id })); }, [books.data, v.book_id]);
  const body = (preview: boolean) => ({ book_id: v.book_id, buyer_name: v.buyer_name || null, buyer_mobile: v.buyer_mobile || null, buyer_gstin: v.buyer_gstin || null, barcodes: codes, prices: Object.entries(prices).filter(([, x]) => Number(x) > 0).map(([sku, rate]) => ({ sku, rate: Number(rate) })), payment_mode: v.payment_mode, amount_received: Number(v.amount_received || 0), notes: v.notes || null, preview });
  const refresh = async (list = codes) => {
    if (!list.length) { setPv(null); return; }
    try { setPv(await api.post('/finance/counter-sales', { ...body(true), barcodes: list })); } catch (e) { toast({ tone: 'error', title: (e as Error).message }); }
  };
  async function scan() {
    const c = code.trim().toUpperCase();
    if (!c || codes.includes(c)) { setCode(''); return; }
    try {
      const r = await api.get<{ kind: string; roll?: { barcode: string; sku: string; product_name: string; weight_kg: number; price_per_kg: number | null; lot_no: string; state: string } }>(`/inventory/scan/${encodeURIComponent(c)}`);
      if (r.kind !== 'roll' || !r.roll) throw new Error('Scan a roll barcode');
      if (r.roll.state !== 'available') throw new Error(`Roll ${c} is ${humanize(r.roll.state)}, not available`);
      const list = [...codes, c];
      setCodes(list); setRolls([...rolls, r.roll]); setCode(''); await refresh(list);
    } catch (e) { toast({ tone: 'error', title: (e as Error).message }); setCode(''); }
  }
  if (done) return (
    <>
      <PageHeader title={`Sold: ${done.number}`} breadcrumbs={[{ label: 'Accounts', to: '/finance' }, { label: 'Counter sale' }]} />
      <Notice tone="success" title={`${fmtINR(done.total)} received`}>{done.change > 0 ? `Give back ${fmtINR(done.change)} change. ` : ''}The rolls are out of stock, the invoice is in the sales register and GST, and the money is in the cash book.</Notice>
      <div className="mt-4 flex gap-2"><Button variant="primary" onClick={() => nav(`/finance/invoices/${done.id}`)}>Open and print the invoice</Button><Button onClick={() => { setDone(null); setCodes([]); setRolls([]); setPv(null); setV({ ...v, buyer_name: '', buyer_mobile: '', buyer_gstin: '', amount_received: '', notes: '' }); }}>Next sale</Button></div>
    </>
  );
  return (
    <>
      <PageHeader title="Counter sale" description="For walk-in buyers: scan the rolls, take the money, and the invoice and receipt are made in one step. Buyers without a GSTIN go into GSTR-1 as B2C."
        breadcrumbs={[{ label: 'Accounts', to: '/finance' }, { label: 'Counter sale' }]} actions={<Button icon={<Wallet className="size-4" />} onClick={() => nav('/finance/cash-book')}>Cash book</Button>} />
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
        <Card className="xl:col-span-2" title="Rolls" padded={false}>
          <form className="flex gap-2 border-b border-slate-100 p-4" onSubmit={(e) => { e.preventDefault(); void scan(); }}>
            <input className="input h-11 flex-1 font-mono" autoFocus placeholder="Scan a roll barcode" value={code} onChange={(e) => setCode(e.target.value)} />
            <Button type="submit" variant="primary" icon={<ShoppingBag className="size-4" />}>Add</Button>
          </form>
          <SimpleTable rows={rolls} rowKey={(r) => r.barcode} csv={false} empty="Scan the rolls the buyer is taking" columns={[
            { key: 'b', header: 'Roll', render: (r) => <span className="font-mono text-[12.5px]">{r.barcode}</span> },
            { key: 's', header: 'Fabric', render: (r) => <span>{r.sku}<span className="block text-[12px] text-slate-500">lot {r.lot_no}</span></span> },
            { key: 'k', header: 'Kg', align: 'right', render: (r) => fmtNum(Number(r.weight_kg)) },
            { key: 'p', header: 'Rate ₹/kg', align: 'right', render: (r) => <input className="input h-8 w-24 text-right" type="number" aria-label={`Rate for ${r.sku}`} placeholder={r.price_per_kg ? String(r.price_per_kg) : 'Set'} value={prices[r.sku] ?? ''} onChange={(e) => setPrices({ ...prices, [r.sku]: e.target.value })} onBlur={() => void refresh()} /> },
            { key: 'x', header: '', render: (r) => <button type="button" aria-label="Remove" className="text-slate-400 hover:text-rose-600" onClick={() => { const list = codes.filter((c) => c !== r.barcode); setCodes(list); setRolls(rolls.filter((x) => x.barcode !== r.barcode)); void refresh(list); }}><Trash2 className="size-4" /></button> },
          ]} />
        </Card>
        <Card title="Buyer and payment">
          <div className="space-y-3">
            <Select label="Sell from (GSTIN)" value={v.book_id} onChange={(e) => setV({ ...v, book_id: e.target.value })} options={(books.data ?? []).map((b) => ({ value: b.id, label: `${b.code} · ${b.gstin}` }))} />
            <Input label="Buyer name (optional)" value={v.buyer_name} onChange={(e) => setV({ ...v, buyer_name: e.target.value })} />
            <Input label="Mobile (optional)" value={v.buyer_mobile} onChange={(e) => setV({ ...v, buyer_mobile: e.target.value })} />
            <Input label="GSTIN (optional)" hint="Blank: B2C sale" value={v.buyer_gstin} onChange={(e) => setV({ ...v, buyer_gstin: e.target.value.toUpperCase() })} onBlur={() => void refresh()} />
            <Segmented value={v.payment_mode} onChange={(m) => { setV({ ...v, payment_mode: m }); }} options={[{ value: 'cash', label: 'Cash' }, { value: 'upi', label: 'UPI' }, { value: 'card', label: 'Card' }, { value: 'bank', label: 'Bank' }]} />
            {pv && <div className="rounded-lg bg-slate-50 p-3 text-[13px]">
              <div className="flex justify-between"><span>{fmtNum(pv.kg)} kg · taxable</span><span>{fmtINR(pv.taxable)}</span></div>
              <div className="flex justify-between"><span>GST</span><span>{fmtINR(pv.cgst + pv.sgst + pv.igst)}</span></div>
              <div className="flex justify-between border-t border-slate-200 pt-1 text-[15px] font-bold"><span>To collect</span><span>{fmtINR(pv.total)}</span></div>
              <p className="mt-1 text-[12px] text-slate-500">{pv.b2c ? 'B2C sale (no GSTIN)' : 'B2B sale'}</p>
            </div>}
            {pv?.warning && v.payment_mode === 'cash' && <Notice tone="danger" title="Cash limit">{pv.warning}</Notice>}
            <Input label="Amount received" prefix="₹" type="number" value={v.amount_received} onChange={(e) => setV({ ...v, amount_received: e.target.value })} hint={pv && Number(v.amount_received) > pv.total ? `Change to give: ${fmtINR(Number(v.amount_received) - pv.total)}` : undefined} />
            <Textarea label="Notes" rows={2} value={v.notes} onChange={(e) => setV({ ...v, notes: e.target.value })} />
            <div className="flex gap-2">
              {pv && <DocumentPreviewButton draft d={invoiceDoc({ kind: 'sales', mode: 'counter', number: null, draft_no: 'COUNTER SALE', doc_date: new Date().toISOString().slice(0, 10), party_name: v.buyer_name || 'Walk-in buyer', party_gstin: v.buyer_gstin || null, party_state: v.buyer_gstin ? v.buyer_gstin.slice(0, 2) : null, party_mobile: v.buyer_mobile || null, supplier_invoice_no: null, lines: pv.lines, taxable: pv.taxable, cgst: pv.cgst, sgst: pv.sgst, igst: pv.igst, round_off: pv.round_off, total: pv.total, notes: v.notes || null, payment_mode: v.payment_mode, status: 'draft' }, null)} />}
              <Button variant="primary" className="flex-1" disabled={!pv || Number(v.amount_received) + 0.5 < (pv?.total ?? 0) || (!!pv?.warning && v.payment_mode === 'cash')} onClick={async () => {
                try { setDone(await api.post('/finance/counter-sales', body(false))); } catch (e) { toast({ tone: 'error', title: (e as Error).message }); }
              }}>Complete sale</Button>
            </div>
          </div>
        </Card>
      </div>
    </>
  );
}

/** Cash book with the daily cash closing (counted cash against the books). */
export function CashBookPage() {
  const books = useBooks();
  const { can } = useAuth();
  const toast = useToast();
  const today = new Date().toISOString().slice(0, 10);
  const [f, setF] = useState({ book_id: '', from: today, to: today });
  useEffect(() => { if (!f.book_id && books.data?.length) setF((x) => ({ ...x, book_id: books.data!.find((b) => b.is_primary)?.id ?? books.data![0]!.id })); }, [books.data, f.book_id]);
  const q = useQuery({ queryKey: ['fin-cash', f], queryFn: () => api.get<{ opening: number; closing: number; rows: { voucher_id: string; number: string; voucher_type: string; date: string; narration: string; party_name: string | null; debit: number; credit: number; balance: number }[]; closings: { id: string; day: string; system_cash: number; counted: number; difference: number; note: string | null; closed_by_name: string }[] }>(`/finance/cash-book?book_id=${f.book_id}&from=${f.from}&to=${f.to}`), enabled: !!f.book_id });
  const DEN = [2000, 500, 200, 100, 50, 20, 10, 5, 2, 1];
  const [den, setDen] = useState<Record<string, string>>({});
  const [note, setNote] = useState('');
  const counted = DEN.reduce((s, d) => s + d * Number(den[d] || 0), 0);
  const closedToday = q.data?.closings.some((c) => c.day === f.to);
  return (
    <>
      <PageHeader title="Cash book" description="Every cash receipt and payment with the running balance, and the daily closing: count the cash in hand and compare it with the books. A difference needs an explanation and raises an alert." breadcrumbs={[{ label: 'Accounts', to: '/finance' }, { label: 'Cash book' }]}
        actions={<div className="flex items-end gap-2"><Select label="Book" value={f.book_id} onChange={(e) => setF({ ...f, book_id: e.target.value })} options={(books.data ?? []).map((b) => ({ value: b.id, label: b.code }))} /><Input label="From" type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} /><Input label="To" type="date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} /></div>} />
      {!q.data ? <Skeleton className="h-60" /> : (
        <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
          <div className="space-y-6 xl:col-span-2">
            <div className="grid grid-cols-3 gap-3"><Stat label="Opening" value={fmtINR(q.data.opening)} /><Stat label="In − out" value={fmtINR(q.data.closing - q.data.opening)} /><Stat label="Closing (books)" value={fmtINR(q.data.closing)} /></div>
            <Card padded={false}><SimpleTable rows={q.data.rows} rowKey={(r) => `${r.voucher_id}-${r.debit}-${r.credit}`} csvName="cash-book" empty="No cash entries in this period" columns={[
              { key: 'd', header: 'Date', render: (r) => fmtDate(r.date) },
              { key: 'n', header: 'Voucher', render: (r) => <span className="font-mono text-[12px]">{r.number}</span> },
              { key: 'w', header: 'Details', render: (r) => <span className="text-[12.5px]">{r.narration}</span> },
              { key: 'i', header: 'In', align: 'right', render: (r) => (r.debit ? fmtINR(r.debit) : '') },
              { key: 'o', header: 'Out', align: 'right', render: (r) => (r.credit ? fmtINR(r.credit) : '') },
              { key: 'b', header: 'Balance', align: 'right', render: (r) => fmtINR(r.balance) },
            ]} /></Card>
          </div>
          <div className="space-y-6">
            {can('finance.voucher.post') && !closedToday && (
              <Card title={`Close the day: ${fmtDate(f.to)}`} description="Count the notes and coins in the cash box.">
                <div className="grid grid-cols-2 gap-2">{DEN.map((d) => <Input key={d} label={`₹${d} ×`} type="number" value={den[d] ?? ''} onChange={(e) => setDen({ ...den, [d]: e.target.value })} />)}</div>
                <div className="mt-3 rounded-lg bg-slate-50 p-3 text-[13px]"><div className="flex justify-between"><span>Counted</span><b>{fmtINR(counted)}</b></div><div className="flex justify-between"><span>Books</span><span>{fmtINR(q.data.closing)}</span></div><div className={`flex justify-between ${Math.abs(counted - q.data.closing) >= 1 ? 'text-rose-600' : 'text-emerald-700'}`}><span>Difference</span><span>{fmtINR(counted - q.data.closing)}</span></div></div>
                {Math.abs(counted - q.data.closing) >= 1 && <Textarea className="mt-2" label="Explain the difference" required value={note} onChange={(e) => setNote(e.target.value)} />}
                <Button className="mt-3 w-full" variant="primary" onClick={async () => { try { await api.post('/finance/cash-closings', { book_id: f.book_id, day: f.to, counted, denominations: Object.fromEntries(Object.entries(den).filter(([, x]) => Number(x) > 0).map(([k, x]) => [k, Number(x)])), note: note || null }); toast({ tone: 'success', title: 'Day closed' }); q.refetch(); } catch (e) { toast({ tone: 'error', title: (e as Error).message }); } }}>Close the day</Button>
              </Card>
            )}
            <Card title="Closings" padded={false}><SimpleTable rows={q.data.closings} rowKey={(r) => r.id} csv={false} empty="No closings in this period" columns={[
              { key: 'd', header: 'Day', render: (r) => fmtDate(r.day) },
              { key: 'c', header: 'Counted', align: 'right', render: (r) => fmtINR(Number(r.counted)) },
              { key: 'x', header: 'Difference', align: 'right', render: (r) => <span className={Math.abs(Number(r.difference)) >= 1 ? 'text-rose-600' : 'text-emerald-700'}>{fmtINR(Number(r.difference))}</span> },
              { key: 'b', header: 'By', render: (r) => <span className="text-[12px]">{r.closed_by_name}{r.note && <span className="block text-slate-500">{r.note}</span>}</span> },
            ]} /></Card>
          </div>
        </div>
      )}
    </>
  );
}

export function CounterSalesListPage() {
  const nav = useNavigate();
  const q = useQuery({ queryKey: ['fin-manual', 'counter'], queryFn: () => api.get<Inv[]>('/finance/manual-invoices?kind=sales&mode=counter') });
  return (
    <>
      <PageHeader title="Counter sales" breadcrumbs={[{ label: 'Accounts', to: '/finance' }, { label: 'Counter sales' }]} actions={<Button variant="primary" icon={<Plus className="size-4" />} onClick={() => nav('/finance/counter/new')}>New counter sale</Button>} />
      <Card padded={false}><SimpleTable rows={q.data ?? []} rowKey={(r) => r.id} onRowClick={(r) => nav(`/finance/invoices/${r.id}`)} empty="No counter sales yet" columns={[
        { key: 'n', header: 'Invoice', render: (r) => <span className="font-mono text-[12.5px]">{r.number ?? r.draft_no}</span> },
        { key: 'd', header: 'Date', render: (r) => fmtDate(r.doc_date) },
        { key: 'b', header: 'Buyer', render: (r) => <span>{r.party_name}{!r.party_gstin && <Badge className="ml-1.5">B2C</Badge>}</span> },
        { key: 'm', header: 'Paid by', render: (r) => humanize(r.payment_mode ?? '') },
        { key: 't', header: 'Total', align: 'right', render: (r) => fmtINR(n(r.total)) },
        { key: 's', header: 'Status', render: (r) => <StatusBadge status={r.status} /> },
      ]} /></Card>
    </>
  );
}
