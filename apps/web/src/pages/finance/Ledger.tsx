import { useQuery, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { AlertTriangle, BookOpen, FilePlus2, Landmark, Plus, Receipt, RotateCcw, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, invalidatePrefix } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { fmtAmt, fmtDate, fmtDateTime, fmtINR, humanize } from '../../lib/format';
import { SimpleTable } from '../../components/DataTable';
import { ConfirmDialog, Modal, useToast } from '../../components/overlay';
import { useParties } from '../../components/business';
import { Badge, Button, Card, EmptyState, ErrorState, Input, KeyValue, Notice, PageHeader, Segmented, Select, Skeleton, Stat, StatusBadge, Tabs, Textarea } from '../../components/ui';

export interface Book { id: string; code: string; name: string; gstin: string; state_code: string; is_primary: boolean }
export interface Account { id: string; code: string; name: string; type: string; group_name: string; section: string; system_key: string | null; control: string | null; is_bank: boolean; allow_manual: boolean; status: string; balance: number }
export const useBooks = () => useQuery({ queryKey: ['fin-books'], queryFn: () => api.get<Book[]>('/finance/books'), staleTime: 60_000 });
export const useAccounts = () => useQuery({ queryKey: ['fin-accounts'], queryFn: () => api.get<Account[]>('/finance/accounts') });
const errMsg = (e: unknown) => (e as Error).message;
const VTYPES = ['journal', 'sales', 'purchase', 'receipt', 'payment', 'contra', 'credit_note', 'transfer', 'opening', 'closing', 'payroll'];

/** Book selector: one GSTIN's books or the consolidated view. */
export function BookPicker({ value, onChange, allowAll = true }: { value: string; onChange: (v: string) => void; allowAll?: boolean }) {
  const b = useBooks();
  return <Select className="w-72" value={value} onChange={(e) => onChange(e.target.value)} options={[...(allowAll ? [{ value: 'all', label: 'All GSTINs (consolidated)' }] : []), ...(b.data ?? []).map((x) => ({ value: x.id, label: `${x.code} · ${x.gstin}` }))]} />;
}
export const Amt = ({ v, className }: { v: number | null | undefined; className?: string }) => <span className={clsx('tabular', (v ?? 0) < 0 && 'text-rose-600', className)}>{fmtAmt(v)}</span>;

// ---------------------------------------------------------------- overview
interface Dash { cash_and_bank: number; receivables: number; receivables_overdue: number; payables: number; payables_overdue: number; gst_payable: number; gst_this_month: { output: number; input: number }; tds_payable: number; inventory: number; ytd: { revenue: number; gross_profit: number; net_profit: number }; anomalies: { n: number; critical: number }; pending_approval: number; periods: { month: string; status: string }[]; recent: VRow[] }
export function FinanceOverview() {
  const nav = useNavigate();
  const q = useQuery({ queryKey: ['fin-dash'], queryFn: () => api.get<Dash>('/finance/dashboard') });
  const d = q.data;
  return (
    <>
      <PageHeader title="Finance" description="Double-entry books for each GSTIN, posted automatically from purchase, sales, receipts, returns and stock transfers. Manual entries above the limit go to a checker; locked periods cannot change." breadcrumbs={[{ label: 'Finance' }]}
        actions={<Link to="/finance/vouchers/new"><Button variant="primary" icon={<FilePlus2 className="size-4" />}>New voucher</Button></Link>} />
      {q.isError ? <ErrorState error={q.error} /> : !d ? <Skeleton className="h-80" /> : (
        <>
          {d.anomalies.critical > 0 && <div className="mb-4"><Notice tone="danger" title={`${d.anomalies.critical} critical alert(s)`} action={<Link to="/finance/anomalies"><Button size="sm">Review</Button></Link>}>Possible duplicate payments, payments after bank changes or overdue statutory dues.</Notice></div>}
          <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Cash, bank and gateway" value={fmtINR(d.cash_and_bank)} />
            <Stat label="Receivables" value={fmtINR(d.receivables)} sub={`${fmtINR(d.receivables_overdue)} overdue`} tone={d.receivables_overdue > 0 ? 'warning' : undefined} />
            <Stat label="Payables" value={fmtINR(d.payables)} sub={`${fmtINR(d.payables_overdue)} overdue`} tone={d.payables_overdue > 0 ? 'warning' : undefined} />
            <Stat label="GST net (output − input)" value={fmtINR(d.gst_payable)} sub={d.gst_payable < 0 ? 'credit carried forward' : 'payable'} />
            <Stat label="Revenue this year" value={fmtINR(d.ytd.revenue)} />
            <Stat label="Gross profit this year" value={fmtINR(d.ytd.gross_profit)} sub="before closing stock if not yet valued" />
            <Stat label="TDS to deposit" value={fmtINR(d.tds_payable)} tone={d.tds_payable > 0 ? 'warning' : undefined} />
            <Stat label="Open alerts / awaiting approval" value={`${d.anomalies.n} / ${d.pending_approval}`} tone={d.anomalies.n ? 'warning' : undefined} />
          </div>
          <div className="grid gap-4 lg:grid-cols-3">
            <Card className="lg:col-span-2" title="Latest vouchers" padded={false} actions={<Link className="link text-[13px]" to="/finance/vouchers">All vouchers</Link>}>
              <VoucherTable rows={d.recent} onOpen={(id) => nav(`/finance/vouchers/${id}`)} />
            </Card>
            <Card title="Go to">
              <ul className="space-y-2 text-[13.5px]">
                {[['/finance/accounts', 'Chart of accounts and ledgers'], ['/finance/receivables', 'Customer ledgers and ageing'], ['/finance/payables', 'Supplier ledgers and ageing'], ['/finance/bank', 'Bank reconciliation'], ['/finance/gst', 'GST returns and 2B reconciliation'], ['/finance/tds', 'TDS register and challans'], ['/finance/statements', 'Trial balance, P&L, balance sheet, cash flow'], ['/finance/close', 'Period close and stock valuation']].map(([to, l]) => <li key={to}><Link className="link" to={to!}>{l}</Link></li>)}
              </ul>
              <div className="mt-4 border-t border-slate-100 pt-3 text-[12.5px] text-slate-500">Periods: {d.periods.map((p) => <span key={p.month} className="mr-2">{p.month.slice(0, 7)} <StatusBadge status={p.status === 'locked' ? 'locked' : 'open'} /></span>)}</div>
            </Card>
          </div>
        </>
      )}
    </>
  );
}

// ---------------------------------------------------------------- chart of accounts
const TYPE_ORDER = ['asset', 'liability', 'equity', 'income', 'expense'];
export function ChartOfAccountsPage() {
  const { can } = useAuth();
  const nav = useNavigate();
  const [book, setBook] = useState('all');
  const q = useQuery({ queryKey: ['fin-accounts', book], queryFn: () => api.get<Account[]>(`/finance/accounts?book=${book}`) });
  const [adding, setAdding] = useState(false);
  const [type, setType] = useState<string>(TYPE_ORDER[0]!);
  return (
    <>
      <PageHeader title="Chart of accounts" description="Accounts marked “system” receive automatic postings and cannot be removed. Control accounts carry a customer or supplier on every line." breadcrumbs={[{ label: 'Finance', to: '/finance' }, { label: 'Chart of accounts' }]}
        actions={<div className="flex gap-2"><BookPicker value={book} onChange={setBook} />{can('finance.config.manage') && <Button icon={<Plus className="size-4" />} onClick={() => setAdding(true)}>Add account</Button>}</div>} />
      {!q.data ? <Skeleton className="h-96" /> : (() => {
        const totalOf = (t: string) => q.data.filter((a) => a.type === t).reduce((s, a) => s + a.balance * (['asset', 'expense'].includes(t) ? 1 : -1), 0);
        const rows = q.data.filter((a) => a.type === type);
        return (
          <Card padded={false}>
            <Tabs className="px-3" value={type} onChange={setType} tabs={TYPE_ORDER.map((t) => ({ value: t, label: <span>{humanize(t === 'income' ? 'income' : `${t}s`)} <span className="ml-1 text-[12px] font-normal text-slate-400 tabular">{fmtINR(totalOf(t))}</span></span>, count: q.data.filter((a) => a.type === t).length }))} />
            <SimpleTable rows={rows} rowKey={(a) => a.id} onRowClick={(a) => nav(`/finance/ledger/${a.id}${book !== 'all' ? `?book=${book}` : ''}`)} columns={[
                { key: 'c', header: 'Code', width: '90px', render: (a) => <span className="font-mono text-[12.5px]">{a.code}</span> },
                { key: 'n', header: 'Account', render: (a) => <div className="flex items-center gap-2"><span className={a.status !== 'active' ? 'text-slate-400 line-through' : ''}>{a.name}</span>{a.system_key && <Badge tone="neutral">system</Badge>}{a.control && <Badge tone="violet">{a.control.replace('_', '-')} control</Badge>}{a.is_bank && <Badge tone="info">bank</Badge>}</div> },
                { key: 'g', header: 'Group', render: (a) => <span className="text-[12.5px] text-slate-500">{a.group_name}</span> },
                { key: 'b', header: 'Balance', align: 'right', render: (a) => <span className="tabular">{fmtAmt(Math.abs(a.balance))} {Math.abs(a.balance) > 0.005 && <span className="text-[11px] text-slate-400">{a.balance > 0 ? 'Dr' : 'Cr'}</span>}</span> },
                ]} />
          </Card>
        );
      })()}
      <AddAccountModal open={adding} onClose={() => setAdding(false)} />
    </>
  );
}

function AddAccountModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const [v, setV] = useState({ code: '', name: '', type: 'expense', group_name: '', section: 'operating_expenses', is_bank: false });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const sections: Record<string, string[]> = { asset: ['current_assets', 'non_current_assets'], liability: ['current_liabilities', 'non_current_liabilities'], equity: ['equity'], income: ['revenue', 'other_income'], expense: ['cost_of_sales', 'operating_expenses', 'finance_costs'] };
  return (
    <Modal open={open} onClose={onClose} title="Add a ledger account" footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} onClick={async () => { setBusy(true); setErr(null); try { await api.post('/finance/accounts', v); invalidatePrefix(qc, 'fin-'); onClose(); } catch (e) { setErr(errMsg(e)); } finally { setBusy(false); } }}>Add</Button></>}>
      <div className="grid grid-cols-2 gap-3">
        {err && <div className="col-span-2"><Notice tone="danger">{err}</Notice></div>}
        <Input label="Code" hint="4–6 digits" value={v.code} onChange={(e) => setV({ ...v, code: e.target.value })} />
        <Select label="Type" value={v.type} onChange={(e) => setV({ ...v, type: e.target.value, section: sections[e.target.value]![0]! })} options={TYPE_ORDER.map((t) => ({ value: t, label: humanize(t) }))} />
        <Input className="col-span-2" label="Name" value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} />
        <Input label="Group" value={v.group_name} onChange={(e) => setV({ ...v, group_name: e.target.value })} />
        <Select label="Statement section" value={v.section} onChange={(e) => setV({ ...v, section: e.target.value })} options={sections[v.type]!.map((s) => ({ value: s, label: humanize(s) }))} />
      </div>
    </Modal>
  );
}

interface LedgerEntry { voucher_id: string; number: string; voucher_type: string; date: string; narration: string; status: string; book: string; party_name: string | null; bill_ref: string | null; debit: number; credit: number; balance: number; against: string | null }
export function LedgerPage() {
  const { id = '' } = useParams();
  const [sp, setSp] = useSearchParams();
  const book = sp.get('book') ?? 'all';
  const [from, setFrom] = useState(sp.get('from') ?? '');
  const [to, setTo] = useState(sp.get('to') ?? '');
  const q = useQuery({ queryKey: ['fin-ledger', id, book, from, to], queryFn: () => api.get<{ account: Account; opening: number; entries: LedgerEntry[]; closing: number }>(`/finance/ledger/${id}?book=${book}${from ? `&from=${from}` : ''}${to ? `&to=${to}` : ''}`) });
  const nav = useNavigate();
  const d = q.data;
  return (
    <>
      <PageHeader title={d ? `${d.account.code} · ${d.account.name}` : 'Ledger'} description={d ? `${humanize(d.account.type)} · ${d.account.group_name}` : undefined} breadcrumbs={[{ label: 'Finance', to: '/finance' }, { label: 'Chart of accounts', to: '/finance/accounts' }, { label: 'Ledger' }]}
        actions={<div className="flex items-end gap-2"><BookPicker value={book} onChange={(v) => setSp({ book: v })} /><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /><Input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></div>} />
      {q.isError ? <ErrorState error={q.error} /> : !d ? <Skeleton className="h-96" /> : (
        <Card padded={false}>
          <div className="flex justify-between border-b border-slate-100 px-5 py-3 text-[13px]"><span>Opening balance</span><Amt v={d.opening} className="font-semibold" /></div>
          <SimpleTable pageSize={20} rows={d.entries} rowKey={(e) => `${e.voucher_id}-${e.debit}-${e.credit}-${e.balance}`} onRowClick={(e) => nav(`/finance/vouchers/${e.voucher_id}`)} empty={<EmptyState icon={<BookOpen className="size-5" />} title="No entries in this range" />} columns={[
            { key: 'd', header: 'Date', render: (e) => <span className="whitespace-nowrap">{fmtDate(e.date)}</span> },
            { key: 'v', header: 'Voucher', render: (e) => <div><p className="font-mono text-[12.5px]">{e.number}</p><p className="text-[11.5px] text-slate-500">{humanize(e.voucher_type)} · {e.book}{e.status === 'reversed' ? ' · reversed' : ''}</p></div> },
            { key: 'n', header: 'Particulars', render: (e) => <div className="max-w-md"><p className="truncate">{e.party_name ?? e.against}</p><p className="truncate text-[12px] text-slate-500">{e.narration}</p></div> },
            { key: 'dr', header: 'Debit', align: 'right', render: (e) => fmtAmt(e.debit) },
            { key: 'cr', header: 'Credit', align: 'right', render: (e) => fmtAmt(e.credit) },
            { key: 'b', header: 'Balance', align: 'right', render: (e) => <Amt v={e.balance} /> },
          ]} />
          <div className="flex justify-between border-t border-slate-200 px-5 py-3 text-[13px] font-semibold"><span>Closing balance</span><Amt v={d.closing} /></div>
        </Card>
      )}
    </>
  );
}

// ---------------------------------------------------------------- vouchers
export interface VRow { id: string; number: string; voucher_type: string; date: string; narration: string; party_name?: string | null; amount: number; status: string; book: string; source_service?: string; manual?: boolean; created_by_name?: string; approved_by_name?: string | null }
function VoucherTable({ rows, onOpen }: { rows: VRow[]; onOpen: (id: string) => void }) {
  return (
    <SimpleTable pageSize={20} rows={rows} rowKey={(v) => v.id} onRowClick={(v) => onOpen(v.id)} empty={<EmptyState icon={<Receipt className="size-5" />} title="No vouchers" />} columns={[
      { key: 'd', header: 'Date', render: (v) => <span className="whitespace-nowrap">{fmtDate(v.date)}</span> },
      { key: 'n', header: 'Voucher', render: (v) => <div className="whitespace-nowrap"><p className="font-mono text-[12.5px] font-semibold">{v.number}</p><p className="text-[11.5px] text-slate-500">{humanize(v.voucher_type)} · {v.book}{v.source_service && v.source_service !== 'finance' ? ` · ${v.source_service}` : v.manual ? ' · manual' : ''}</p></div> },
      { key: 'p', header: 'Particulars', render: (v) => <div className="max-w-xs xl:max-w-sm">{v.party_name ? <><p className="truncate">{v.party_name}</p><p className="truncate text-[12px] text-slate-500">{v.narration}</p></> : <p className="line-clamp-2 text-[13px]">{v.narration}</p>}</div> },
      { key: 'a', header: 'Amount', align: 'right', render: (v) => fmtAmt(v.amount) },
      { key: 's', header: 'Status', render: (v) => <StatusBadge status={v.status} /> },
    ]} />
  );
}

export function VouchersPage() {
  const nav = useNavigate();
  const [book, setBook] = useState('all');
  const [type, setType] = useState('');
  const [status, setStatus] = useState('');
  const [qtext, setQ] = useState('');
  const q = useQuery({ queryKey: ['fin-vouchers', book, type, status, qtext], queryFn: () => api.get<VRow[]>(`/finance/vouchers?book=${book}${type ? `&type=${type}` : ''}${status ? `&status=${status}` : ''}${qtext ? `&q=${encodeURIComponent(qtext)}` : ''}`) });
  return (
    <>
      <PageHeader title="Vouchers" description="Day book of every entry. Automatic vouchers link back to the invoice, receipt or transfer that created them." breadcrumbs={[{ label: 'Finance', to: '/finance' }, { label: 'Vouchers' }]}
        actions={<Link to="/finance/vouchers/new"><Button variant="primary" icon={<FilePlus2 className="size-4" />}>New voucher</Button></Link>} />
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <BookPicker value={book} onChange={setBook} />
        <Select className="w-44" value={type} onChange={(e) => setType(e.target.value)} options={[{ value: '', label: 'All types' }, ...VTYPES.map((t) => ({ value: t, label: humanize(t) }))]} />
        <Select className="w-48" value={status} onChange={(e) => setStatus(e.target.value)} options={[{ value: '', label: 'Any status' }, ...['posted', 'pending_approval', 'reversed', 'rejected'].map((s) => ({ value: s, label: humanize(s) }))]} />
        <Input className="w-64" placeholder="Number, party, narration, UTR" value={qtext} onChange={(e) => setQ(e.target.value)} />
      </div>
      <Card padded={false}>{!q.data ? <Skeleton className="m-5 h-40" /> : <VoucherTable rows={q.data} onOpen={(id) => nav(`/finance/vouchers/${id}`)} />}</Card>
    </>
  );
}

interface VDetail extends VRow { book_name: string; gstin: string; source_service: string; source_type: string | null; source_ref: string | null; reversal_of: string | null; reversed_by: string | null; posted_at: string | null; created_at: string;
  lines: { id: number; code: string; account_name: string; account_id: string; party_name: string | null; debit: number; credit: number; bill_ref: string | null; narration: string | null }[];
  tax: { id: number; doc_type: string; doc_no: string; hsn: string | null; rate: number; taxable: number; cgst: number; sgst: number; igst: number; party_gstin: string | null; place_of_supply: string | null }[];
  tds: { section: string; base_amount: number; rate: number; tds_amount: number; pan: string | null }[]; bill: { kind: string; doc_no: string; due_date: string; amount: number } | null; related: { id: string; number: string; status: string }[]; bank_line: { txn_date: string; description: string; ref: string | null } | null }
const SOURCE_LINK: Record<string, (ref: string) => string> = { fulfilment: () => '/fulfilment', commerce: () => '/commerce/payments', procurement: () => '/procurement/invoices', inventory: () => '/inventory/transfers' };

export function VoucherDetailPage() {
  const { id = '' } = useParams();
  const { can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['fin-voucher', id], queryFn: () => api.get<VDetail>(`/finance/vouchers/${encodeURIComponent(id)}`) });
  const [rev, setRev] = useState(false);
  const [busy, setBusy] = useState(false);
  const v = q.data;
  if (q.isError) return <ErrorState error={q.error} />;
  if (!v) return <Skeleton className="h-96" />;
  const dr = v.lines.reduce((s, l) => s + l.debit, 0), cr = v.lines.reduce((s, l) => s + l.credit, 0);
  return (
    <>
      <PageHeader title={`${humanize(v.voucher_type)} ${v.number}`} meta={<StatusBadge status={v.status} />} description={v.narration} breadcrumbs={[{ label: 'Finance', to: '/finance' }, { label: 'Vouchers', to: '/finance/vouchers' }, { label: v.number }]}
        actions={can('finance.voucher.approve') && v.status === 'posted' && <Button variant="danger" icon={<RotateCcw className="size-4" />} onClick={() => setRev(true)}>Reverse</Button>} />
      {v.status === 'pending_approval' && <div className="mb-4"><Notice tone="warning" title="Waiting for a checker">This voucher does not affect any balance until it is approved in Approvals.</Notice></div>}
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Card padded={false}>
            <SimpleTable rows={v.lines} rowKey={(l) => String(l.id)} columns={[
              { key: 'a', header: 'Account', render: (l) => <div><Link className="link" to={`/finance/ledger/${l.account_id}`}>{l.code} · {l.account_name}</Link>{l.party_name && <p className="text-[12px] text-slate-500">{l.party_name}{l.bill_ref ? ` · ${l.bill_ref}` : ''}</p>}{l.narration && <p className="text-[12px] text-slate-500">{l.narration}</p>}</div> },
              { key: 'dr', header: 'Debit', align: 'right', render: (l) => fmtAmt(l.debit) },
              { key: 'cr', header: 'Credit', align: 'right', render: (l) => fmtAmt(l.credit) },
            ]} />
            <div className="flex justify-end gap-10 border-t border-slate-200 px-4 py-2.5 text-[13px] font-semibold tabular"><span>{fmtAmt(dr)}</span><span>{fmtAmt(cr)}</span></div>
          </Card>
          {v.tax.length > 0 && (
            <Card title="GST register entries" padded={false}>
              <SimpleTable rows={v.tax} rowKey={(t) => String(t.id)} columns={[
                { key: 'd', header: 'Document', render: (t) => <span className="font-mono text-[12.5px]">{humanize(t.doc_type)} {t.doc_no}</span> },
                { key: 'g', header: 'Party GSTIN', render: (t) => <span className="font-mono text-[12px]">{t.party_gstin ?? 'Unregistered'}</span> },
                { key: 'p', header: 'POS', render: (t) => t.place_of_supply },
                { key: 'h', header: 'HSN · rate', render: (t) => `${t.hsn ?? '—'} · ${t.rate}%` },
                { key: 't', header: 'Taxable', align: 'right', render: (t) => fmtAmt(t.taxable) },
                { key: 'c', header: 'CGST', align: 'right', render: (t) => fmtAmt(t.cgst) },
                { key: 's', header: 'SGST', align: 'right', render: (t) => fmtAmt(t.sgst) },
                { key: 'i', header: 'IGST', align: 'right', render: (t) => fmtAmt(t.igst) },
              ]} />
            </Card>
          )}
          {v.tds.length > 0 && <Card title="TDS deducted"><ul className="text-[13px]">{v.tds.map((t, i) => <li key={i}>Section {t.section}: {fmtINR(t.tds_amount)} at {t.rate}% on {fmtINR(t.base_amount)} (PAN {t.pan ?? 'not on file'})</li>)}</ul></Card>}
        </div>
        <Card title="Details">
          <KeyValue columns={1} items={[
            { label: 'Date', value: fmtDate(v.date) },
            { label: 'Book', value: `${v.book_name} · ${v.gstin}` },
            { label: 'Source', value: v.source_service === 'finance' ? (v.manual ? 'Entered manually' : 'Finance') : <span>{humanize(v.source_service)} · {humanize(v.source_type ?? '')} {v.source_ref && <span className="font-mono text-[12px]">{v.source_ref}</span>} {SOURCE_LINK[v.source_service] && <Link className="link ml-1" to={SOURCE_LINK[v.source_service]!(v.source_ref ?? '')}>open</Link>}</span> },
            { label: 'Entered by', value: v.created_by_name },
            { label: 'Approved by', value: v.approved_by_name ?? '—' },
            { label: 'Posted', value: v.posted_at ? fmtDateTime(v.posted_at) : '—' },
            { label: 'Bill', value: v.bill ? `${humanize(v.bill.kind)} ${v.bill.doc_no}, due ${fmtDate(v.bill.due_date)}` : '—' },
            { label: 'Bank statement', value: v.bank_line ? `${fmtDate(v.bank_line.txn_date)} · ${v.bank_line.description}` : '—' },
            { label: 'Related', value: v.related.length ? v.related.map((r) => <Link key={r.id} className="link mr-2" to={`/finance/vouchers/${r.id}`}>{r.number}</Link>) : '—' },
          ]} />
        </Card>
      </div>
      <ConfirmDialog open={rev} onClose={() => setRev(false)} title={`Reverse ${v.number}?`} description="An equal and opposite voucher is posted today. Both stay in the books; a bill or GST entry from this voucher stops counting." requireReason tone="danger" confirmLabel="Post reversal" loading={busy}
        onConfirm={async (reason) => { setBusy(true); try { const r = await api.post<{ number: string }>(`/finance/vouchers/${v.id}/reverse`, { reason }); toast({ tone: 'success', title: `Reversed by ${r.number}` }); setRev(false); invalidatePrefix(qc, 'fin-'); } catch (e) { toast({ tone: 'error', title: 'Could not reverse', body: errMsg(e) }); } finally { setBusy(false); } }} />
    </>
  );
}

interface DraftLine { account_id: string; party_id: string; debit: string; credit: string; narration: string }
const blank = (): DraftLine => ({ account_id: '', party_id: '', debit: '', credit: '', narration: '' });
export function NewVoucherPage() {
  const nav = useNavigate();
  const books = useBooks();
  const accs = useAccounts();
  const parties = useParties('customer,supplier,mill,manufacturer,transporter');
  const [type, setType] = useState<'journal' | 'receipt' | 'payment' | 'contra'>('payment');
  const [book, setBook] = useState('');
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [narration, setNarration] = useState('');
  const [reference, setReference] = useState('');
  const [lines, setLines] = useState<DraftLine[]>([blank(), blank()]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const bookId = book || books.data?.find((b) => b.is_primary)?.id || '';
  const accOpts = useMemo(() => (accs.data ?? []).filter((a) => a.status === 'active' && a.allow_manual).map((a) => ({ value: a.id, label: `${a.code} · ${a.name}` })), [accs.data]);
  const dr = lines.reduce((s, l) => s + (Number(l.debit) || 0), 0), cr = lines.reduce((s, l) => s + (Number(l.credit) || 0), 0);
  const isControl = (id: string) => !!accs.data?.find((a) => a.id === id)?.control;
  const set = (i: number, p: Partial<DraftLine>) => setLines(lines.map((l, j) => (j === i ? { ...l, ...p } : l)));
  return (
    <>
      <PageHeader title="New voucher" description="Journals, payments and contra entries above the approval limit wait for a checker before they count. Customer and supplier accounts need the party on the line." breadcrumbs={[{ label: 'Finance', to: '/finance' }, { label: 'Vouchers', to: '/finance/vouchers' }, { label: 'New' }]} />
      <Card>
        <div className="mb-4"><Segmented value={type} onChange={setType} options={[{ value: 'payment', label: 'Payment' }, { value: 'receipt', label: 'Receipt' }, { value: 'journal', label: 'Journal' }, { value: 'contra', label: 'Contra' }]} /></div>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
          <Select label="Book (GSTIN)" value={bookId} onChange={(e) => setBook(e.target.value)} options={(books.data ?? []).map((b) => ({ value: b.id, label: `${b.code} · ${b.gstin}` }))} />
          <Input label="Date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          <Input label="Reference" hint="UTR, cheque or bill number" value={reference} onChange={(e) => setReference(e.target.value)} />
        </div>
        <div className="mt-5 space-y-2">
          <div className="grid grid-cols-[1.4fr_1.2fr_130px_130px_1fr_32px] gap-2 text-[11.5px] font-semibold tracking-wide text-slate-500 uppercase"><span>Account</span><span>Customer / supplier</span><span className="text-right">Debit</span><span className="text-right">Credit</span><span>Line note</span><span /></div>
          {lines.map((l, i) => (
            <div key={i} className="grid grid-cols-[1.4fr_1.2fr_130px_130px_1fr_32px] items-center gap-2">
              <Select value={l.account_id} onChange={(e) => set(i, { account_id: e.target.value })} placeholder="Choose account" options={accOpts} />
              <Select value={l.party_id} disabled={!isControl(l.account_id)} onChange={(e) => set(i, { party_id: e.target.value })} placeholder={isControl(l.account_id) ? 'Choose party' : '—'} options={(parties.data ?? []).map((p) => ({ value: p.id, label: p.legal_name }))} />
              <Input type="number" min={0} className="text-right" value={l.debit} onChange={(e) => set(i, { debit: e.target.value, credit: e.target.value ? '' : l.credit })} />
              <Input type="number" min={0} value={l.credit} onChange={(e) => set(i, { credit: e.target.value, debit: e.target.value ? '' : l.debit })} />
              <Input value={l.narration} onChange={(e) => set(i, { narration: e.target.value })} />
              <button type="button" className="text-slate-400 hover:text-rose-600 disabled:opacity-30" disabled={lines.length <= 2} onClick={() => setLines(lines.filter((_, j) => j !== i))}><Trash2 className="size-4" /></button>
            </div>
          ))}
          <div className="flex items-center justify-between pt-1">
            <Button size="sm" icon={<Plus className="size-3.5" />} onClick={() => setLines([...lines, blank()])}>Add line</Button>
            <div className="flex gap-8 text-[13px] tabular"><span>Dr {fmtAmt(dr, false)}</span><span>Cr {fmtAmt(cr, false)}</span>{Math.abs(dr - cr) > 0.004 && <span className="flex items-center gap-1 text-rose-600"><AlertTriangle className="size-4" />Difference {fmtAmt(dr - cr)}</span>}</div>
          </div>
        </div>
        <Textarea className="mt-4" label="Narration" required value={narration} onChange={(e) => setNarration(e.target.value)} />
        {err && <div className="mt-3"><Notice tone="danger">{err}</Notice></div>}
        <div className="mt-4 flex justify-end gap-2">
          <Button onClick={() => nav('/finance/vouchers')}>Cancel</Button>
          <Button variant="primary" loading={busy} disabled={!bookId || Math.abs(dr - cr) > 0.004 || dr <= 0 || narration.trim().length < 3} onClick={async () => {
            setBusy(true); setErr(null);
            try {
              const r = await api.post<{ id: string; number: string; status: string }>('/finance/vouchers', { voucher_type: type, book_id: bookId, date, narration, reference: reference || null, lines: lines.filter((l) => l.account_id && (Number(l.debit) || Number(l.credit))).map((l) => ({ account_id: l.account_id, party_id: l.party_id || null, debit: Number(l.debit) || 0, credit: Number(l.credit) || 0, narration: l.narration || null })) });
              nav(`/finance/vouchers/${r.id}`);
            } catch (e) { setErr(errMsg(e)); } finally { setBusy(false); }
          }}>Save voucher</Button>
        </div>
      </Card>
    </>
  );
}

// ---------------------------------------------------------------- receivables / payables
interface AgeRow { party_id: string; party_name: string; balance: number; on_account: number; not_due: number; d1_30: number; d31_60: number; d61_90: number; d90_plus: number; oldest_due: string | null }
export function AgeingPage({ kind }: { kind: 'receivables' | 'payables' }) {
  const nav = useNavigate();
  const [asOf, setAsOf] = useState(new Date().toISOString().slice(0, 10));
  const q = useQuery({ queryKey: ['fin-ageing', kind, asOf], queryFn: () => api.get<{ rows: AgeRow[]; totals: Record<string, number> }>(`/finance/ageing/${kind}?as_of=${asOf}`) });
  const cols = [['not_due', 'Not due'], ['d1_30', '1–30'], ['d31_60', '31–60'], ['d61_90', '61–90'], ['d90_plus', '90+']] as const;
  return (
    <>
      <PageHeader title={kind === 'receivables' ? 'Customer ledgers' : 'Supplier ledgers'} description={kind === 'receivables' ? 'What customers owe, by days past the due date. Receipts settle the oldest invoices first; a negative balance is an advance held for the customer.' : 'What we owe suppliers and mills, net of TDS, by days past the due date. A negative balance is an advance paid.'}
        breadcrumbs={[{ label: 'Finance', to: '/finance' }, { label: kind === 'receivables' ? 'Receivables' : 'Payables' }]} actions={<Input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} />} />
      {!q.data ? <Skeleton className="h-80" /> : (
        <>
          <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-6">
            <Stat label="Total" value={fmtINR(q.data.totals.balance)} />
            {cols.map(([k, l]) => <Stat key={k} label={k === 'not_due' ? l : `${l} days overdue`} value={fmtINR(q.data!.totals[k])} tone={k === 'd90_plus' && q.data!.totals[k]! > 0 ? 'danger' : k !== 'not_due' && q.data!.totals[k]! > 0 ? 'warning' : undefined} />)}
          </div>
          <Card padded={false}>
            <SimpleTable pageSize={20} rows={q.data.rows} rowKey={(r) => r.party_id} onRowClick={(r) => nav(`/finance/${kind}/${r.party_id}`)} empty={<EmptyState icon={<Landmark className="size-5" />} title="Nothing outstanding" />} columns={[
              { key: 'p', header: kind === 'receivables' ? 'Customer' : 'Supplier', render: (r) => r.party_name },
              { key: 'b', header: 'Balance', align: 'right', render: (r) => <Amt v={r.balance} className="font-semibold" /> },
              ...cols.map(([k, l]) => ({ key: k, header: l, align: 'right' as const, render: (r: AgeRow) => <span className={k === 'd90_plus' && r[k] > 0 ? 'font-semibold text-rose-600' : ''}>{fmtAmt(r[k])}</span> })),
              { key: 'o', header: 'On account', align: 'right', render: (r) => fmtAmt(r.on_account) },
            ]} />
          </Card>
        </>
      )}
    </>
  );
}

interface PartyLedger { party: { party_name: string | null; balance: number; billed_outstanding: number; on_account: number }; open_bills: { doc_no: string; doc_date: string; due_date: string; amount: number; outstanding: number; bucket: string }[]; entries: { voucher_id: string; number: string; voucher_type: string; date: string; narration: string; bill_ref: string | null; debit: number; credit: number; balance: number; book: string }[]; tds: { section: string; base_amount: number; tds_amount: number; deducted_on: string; deposited: boolean }[] }
export function PartyLedgerPage({ kind }: { kind: 'receivables' | 'payables' }) {
  const { id = '' } = useParams();
  const nav = useNavigate();
  const [tab, setTab] = useState<'bills' | 'ledger' | 'tds'>('bills');
  const q = useQuery({ queryKey: ['fin-party', kind, id], queryFn: () => api.get<PartyLedger>(`/finance/parties/${kind}/${id}`) });
  const d = q.data;
  const name = d?.party.party_name ?? d?.entries.find(() => true)?.narration ?? 'Party';
  return (
    <>
      <PageHeader title={d?.party.party_name ?? 'Ledger'} breadcrumbs={[{ label: 'Finance', to: '/finance' }, { label: kind === 'receivables' ? 'Receivables' : 'Payables', to: `/finance/${kind}` }, { label: String(name) }]}
        actions={<Link to={`/partners/${kind === 'receivables' ? 'customer' : 'supplier'}/${id}`}><Button>Master record</Button></Link>} />
      {!d ? <Skeleton className="h-80" /> : (
        <>
          <div className="mb-4 grid grid-cols-3 gap-3"><Stat label="Balance" value={fmtINR(d.party.balance)} sub={d.party.balance < 0 ? (kind === 'receivables' ? 'advance held for the customer' : 'advance paid') : undefined} /><Stat label="Against bills" value={fmtINR(d.party.billed_outstanding)} /><Stat label="On account" value={fmtINR(d.party.on_account)} /></div>
          <Tabs className="mb-4" value={tab} onChange={setTab} tabs={[{ value: 'bills', label: 'Open bills', count: d.open_bills.length }, { value: 'ledger', label: 'Ledger' }, ...(kind === 'payables' ? [{ value: 'tds' as const, label: 'TDS', count: d.tds.length }] : [])]} />
          <Card padded={false}>
            {tab === 'bills' ? (
              <SimpleTable pageSize={20} rows={d.open_bills} rowKey={(b) => b.doc_no} empty={<EmptyState title="No open bills" />} columns={[
                { key: 'n', header: 'Document', render: (b) => <span className="font-mono text-[12.5px]">{b.doc_no}</span> },
                { key: 'd', header: 'Date', render: (b) => fmtDate(b.doc_date) },
                { key: 'u', header: 'Due', render: (b) => fmtDate(b.due_date) },
                { key: 'a', header: 'Amount', align: 'right', render: (b) => fmtAmt(b.amount) },
                { key: 'o', header: 'Outstanding', align: 'right', render: (b) => <span className="font-semibold">{fmtAmt(b.outstanding)}</span> },
                { key: 'b', header: 'Age', render: (b) => <Badge tone={b.bucket === 'not_due' ? 'success' : b.bucket === 'd90_plus' ? 'danger' : 'warning'}>{b.bucket === 'not_due' ? 'Not due' : `${b.bucket.replace('d', '').replace('_plus', '+').replace('_', '–')} days`}</Badge> },
              ]} />
            ) : tab === 'ledger' ? (
              <SimpleTable pageSize={20} rows={d.entries} rowKey={(e) => `${e.voucher_id}${e.balance}`} onRowClick={(e) => nav(`/finance/vouchers/${e.voucher_id}`)} columns={[
                { key: 'd', header: 'Date', render: (e) => fmtDate(e.date) },
                { key: 'v', header: 'Voucher', render: (e) => <div><p className="font-mono text-[12.5px]">{e.number}</p><p className="text-[11.5px] text-slate-500">{humanize(e.voucher_type)} · {e.book}</p></div> },
                { key: 'n', header: 'Narration', render: (e) => <span className="text-[12.5px]">{e.narration}</span> },
                { key: 'dr', header: 'Debit', align: 'right', render: (e) => fmtAmt(e.debit) },
                { key: 'cr', header: 'Credit', align: 'right', render: (e) => fmtAmt(e.credit) },
                { key: 'b', header: 'Balance', align: 'right', render: (e) => <Amt v={e.balance} /> },
              ]} />
            ) : (
              <SimpleTable rows={d.tds} rowKey={(t) => `${t.deducted_on}${t.tds_amount}`} columns={[
                { key: 'd', header: 'Deducted', render: (t) => fmtDate(t.deducted_on) },
                { key: 's', header: 'Section', render: (t) => t.section },
                { key: 'b', header: 'Base', align: 'right', render: (t) => fmtAmt(t.base_amount) },
                { key: 't', header: 'TDS', align: 'right', render: (t) => fmtAmt(t.tds_amount) },
                { key: 'x', header: 'Deposited', render: (t) => (t.deposited ? <Badge tone="success">Yes</Badge> : <Badge tone="warning">Pending</Badge>) },
              ]} />
            )}
          </Card>
        </>
      )}
    </>
  );
}
