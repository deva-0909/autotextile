import { useQuery, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { CheckCircle2, Download, FileUp, Landmark, Lock, ShieldAlert, Unlock } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { api, invalidatePrefix } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { fmtAmt, fmtDate, fmtDateTime, fmtINR, fmtNum, humanize } from '../../lib/format';
import { SimpleTable } from '../../components/DataTable';
import { ConfirmDialog, Modal, useToast } from '../../components/overlay';
import { useParties } from '../../components/business';
import { Badge, Button, Card, EmptyState, Input, KeyValue, Notice, PageHeader, Segmented, Select, Skeleton, Stat, StatusBadge, Tabs, Textarea } from '../../components/ui';
import { Amt, BookPicker, useAccounts, useBooks } from './Ledger';

const errMsg = (e: unknown) => (e as Error).message;
const thisMonth = () => new Date().toISOString().slice(0, 7);
function download(name: string, data: unknown) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a'); a.href = url; a.download = name; a.click(); URL.revokeObjectURL(url);
}

// ---------------------------------------------------------------- bank reconciliation
interface BankAcc { id: string; bank_name: string; account_no: string; ifsc: string | null; code: string; account_name: string; book: string; book_balance: number; statement_balance: number | null; statement_to: string | null; unmatched: number }
interface Cand { voucher_id: string; number: string; date: string; narration: string; amount: number; ref_match: boolean }
interface BLine { id: string; txn_date: string; description: string; ref: string | null; debit: number; credit: number; balance: number | null; status: string; voucher_no: string | null; note: string | null; matched_by_name: string | null; candidates?: Cand[] }
interface Recon { account: { bank_name: string; account_no: string }; lines: BLine[]; unpresented: { voucher_id: string; number: string; date: string; narration: string; debit: number; credit: number }[]; summary: { book_balance: number; statement_balance: number | null; bank_only_receipts: number; bank_only_payments: number; book_only_receipts: number; book_only_payments: number; derived_bank_balance: number; difference: number | null } }

export function BankPage() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const accs = useQuery({ queryKey: ['fin-banks'], queryFn: () => api.get<BankAcc[]>('/finance/bank-accounts') });
  const [sel, setSel] = useState<string>('');
  const id = sel || accs.data?.[0]?.id || '';
  const [status, setStatus] = useState('unmatched');
  const rec = useQuery({ queryKey: ['fin-recon', id, status], queryFn: () => api.get<Recon>(`/finance/bank-accounts/${id}/reconciliation?status=${status}`), enabled: !!id });
  const [importing, setImporting] = useState(false);
  const [create, setCreate] = useState<BLine | null>(null);
  const [ignore, setIgnore] = useState<BLine | null>(null);
  const [adding, setAdding] = useState(false);
  const toast = useToast();
  const refresh = () => invalidatePrefix(qc, 'fin-');
  const match = async (l: BLine, voucherId: string) => { try { await api.post(`/finance/bank-lines/${l.id}/match`, { voucher_id: voucherId }); refresh(); } catch (e) { toast({ tone: 'error', title: 'Could not match', body: errMsg(e) }); } };
  const s = rec.data?.summary;
  return (
    <>
      <PageHeader title="Bank reconciliation" description="Import the bank’s statement (CSV). Lines are matched to vouchers by amount, date and UTR; re-imported lines are recognised as duplicates. Whatever is left is either missing from the books or not yet through the bank."
        breadcrumbs={[{ label: 'Finance', to: '/finance' }, { label: 'Bank reconciliation' }]}
        actions={<div className="flex gap-2">{can('finance.config.manage') && <Button onClick={() => setAdding(true)}>Add bank account</Button>}{id && can('finance.bank.reconcile') && <Button variant="primary" icon={<FileUp className="size-4" />} onClick={() => setImporting(true)}>Import statement</Button>}</div>} />
      {!accs.data ? <Skeleton className="h-60" /> : accs.data.length === 0 ? <EmptyState icon={<Landmark className="size-5" />} title="No bank accounts yet" description="Link a bank-type ledger account to its bank account number to start reconciling." /> : (
        <>
          <div className="mb-4 flex flex-wrap gap-2">
            {accs.data.map((a) => (
              <button key={a.id} onClick={() => setSel(a.id)} className={clsx('rounded-lg px-4 py-3 text-left ring-1 transition', a.id === id ? 'bg-brand-50 ring-brand-500' : 'bg-white ring-slate-200 hover:ring-slate-300')}>
                <p className="text-[13.5px] font-semibold">{a.bank_name}</p><p className="font-mono text-[12px] text-slate-500">••••{a.account_no.slice(-4)} · {a.book}</p>
                <p className="mt-1 text-[12.5px]">Books {fmtINR(a.book_balance)} · Bank {a.statement_balance == null ? '—' : fmtINR(a.statement_balance)}</p>
                {a.unmatched > 0 && <Badge tone="warning" className="mt-1">{a.unmatched} to reconcile</Badge>}
              </button>
            ))}
          </div>
          {s && (
            <Card className="mb-4" title="Reconciliation statement">
              <div className="grid gap-x-10 gap-y-1 text-[13px] md:grid-cols-2">
                {([['Balance as per books', s.book_balance], ['Add: credited by bank, not in books', s.bank_only_receipts], ['Less: debited by bank, not in books', -s.bank_only_payments], ['Less: deposits in books not yet credited', -s.book_only_receipts], ['Add: payments in books not yet debited', s.book_only_payments]] as [string, number][]).map(([l, v]) => <div key={l} className="flex justify-between"><span className="text-slate-600">{l}</span><Amt v={v} /></div>)}
                <div className="flex justify-between border-t border-slate-200 pt-1 font-semibold"><span>Derived bank balance</span><Amt v={s.derived_bank_balance} /></div>
                <div className="flex justify-between border-t border-slate-200 pt-1 font-semibold"><span>Balance as per statement</span><span>{s.statement_balance == null ? '—' : fmtAmt(s.statement_balance)}</span></div>
              </div>
              {s.difference != null && (s.difference === 0 ? <p className="mt-3 flex items-center gap-1.5 text-[13px] text-emerald-700"><CheckCircle2 className="size-4" />Reconciled: every difference is explained.</p> : <p className="mt-3 text-[13px] text-rose-600">Unexplained difference {fmtAmt(s.difference)} — check opening balances or a missing statement period.</p>)}
            </Card>
          )}
          <div className="mb-3"><Segmented value={status} onChange={setStatus} options={[{ value: 'unmatched', label: 'To reconcile' }, { value: 'matched', label: 'Matched' }, { value: 'duplicate', label: 'Duplicates' }, { value: 'ignored', label: 'Set aside' }]} /></div>
          <Card padded={false}>
            {!rec.data ? <Skeleton className="m-5 h-40" /> : (
              <SimpleTable rows={rec.data.lines} rowKey={(l) => l.id} empty={<EmptyState title={status === 'unmatched' ? 'Nothing left to reconcile' : 'None'} />} columns={[
                { key: 'd', header: 'Date', width: '100px', render: (l) => fmtDate(l.txn_date) },
                { key: 'n', header: 'Statement line', render: (l) => <div className="max-w-sm"><p className="truncate">{l.description}</p><p className="font-mono text-[11.5px] text-slate-500">{l.ref ?? ''}</p>{l.note && <p className="text-[12px] text-slate-500">{l.note}</p>}</div> },
                { key: 'w', header: 'Withdrawal', align: 'right', render: (l) => fmtAmt(l.debit) },
                { key: 'p', header: 'Deposit', align: 'right', render: (l) => fmtAmt(l.credit) },
                { key: 'm', header: status === 'unmatched' ? 'Suggested match' : 'Voucher', render: (l) => status !== 'unmatched' ? <span className="text-[12.5px]">{l.voucher_no ?? '—'} {l.matched_by_name && <span className="text-slate-400">({l.matched_by_name})</span>}</span> : (
                  <div className="space-y-1">{(l.candidates ?? []).slice(0, 2).map((c) => <div key={c.voucher_id} className="flex items-center gap-2 text-[12.5px]"><span className="font-mono">{c.number}</span><span className="max-w-[180px] truncate text-slate-500">{c.narration}</span>{c.ref_match && <Badge tone="success">UTR</Badge>}{can('finance.bank.reconcile') && <Button size="sm" onClick={() => void match(l, c.voucher_id)}>Match</Button>}</div>)}{!l.candidates?.length && <span className="text-[12.5px] text-slate-400">No voucher with this amount</span>}</div>) },
                { key: 'a', header: '', render: (l) => status === 'unmatched' && can('finance.bank.reconcile') ? <div className="flex gap-1"><Button size="sm" onClick={() => setCreate(l)}>Create entry</Button><Button size="sm" variant="ghost" onClick={() => setIgnore(l)}>Set aside</Button></div> : null },
              ]} />
            )}
          </Card>
          {rec.data && rec.data.unpresented.length > 0 && (
            <Card className="mt-4" title="In the books, not yet in the bank" description="Cheques issued not presented, deposits not yet credited, and receipts still sitting with the payment gateway." padded={false}>
              <SimpleTable rows={rec.data.unpresented} rowKey={(u) => u.voucher_id} columns={[
                { key: 'd', header: 'Date', render: (u) => fmtDate(u.date) },
                { key: 'n', header: 'Voucher', render: (u) => <Link className="link font-mono text-[12.5px]" to={`/finance/vouchers/${u.voucher_id}`}>{u.number}</Link> },
                { key: 'x', header: 'Narration', render: (u) => <span className="text-[12.5px]">{u.narration}</span> },
                { key: 'r', header: 'Receipt', align: 'right', render: (u) => fmtAmt(u.debit) },
                { key: 'p', header: 'Payment', align: 'right', render: (u) => fmtAmt(u.credit) },
              ]} />
            </Card>
          )}
        </>
      )}
      <ImportModal open={importing} onClose={() => setImporting(false)} accountId={id} onDone={refresh} />
      <CreateFromLine line={create} onClose={() => setCreate(null)} onDone={refresh} />
      <ConfirmDialog open={!!ignore} onClose={() => setIgnore(null)} title="Set this line aside?" description="Use for lines that need no entry (for example a reversed bank charge already credited back)." requireReason reasonLabel="Why" confirmLabel="Set aside"
        onConfirm={async (note) => { await api.post(`/finance/bank-lines/${ignore!.id}/ignore`, { note }); setIgnore(null); refresh(); }} />
      <AddBankModal open={adding} onClose={() => setAdding(false)} onDone={refresh} />
    </>
  );
}

function ImportModal({ open, onClose, accountId, onDone }: { open: boolean; onClose: () => void; accountId: string; onDone: () => void }) {
  const [csv, setCsv] = useState('');
  const [name, setName] = useState<string | null>(null);
  const [res, setRes] = useState<{ lines: number; duplicates: number; auto_matched: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const close = () => { setCsv(''); setRes(null); setErr(null); onClose(); };
  return (
    <Modal open={open} onClose={close} size="lg" title="Import bank statement" description="CSV exported from net banking. The header row needs a date column and either Debit/Credit or a signed Amount; narration, reference and balance are used when present."
      footer={res ? <Button variant="primary" onClick={close}>Done</Button> : <><Button onClick={close}>Cancel</Button><Button variant="primary" loading={busy} disabled={csv.length < 10} onClick={async () => { setBusy(true); setErr(null); try { setRes(await api.post(`/finance/bank-accounts/${accountId}/statements`, { csv, file_name: name })); onDone(); } catch (e) { setErr(errMsg(e)); } finally { setBusy(false); } }}>Import</Button></>}>
      {res ? <Notice tone="success" title={`${res.lines} lines imported`}>{res.auto_matched} matched automatically; {res.duplicates} already imported earlier (kept as duplicates).</Notice> : (
        <div className="space-y-3">
          {err && <Notice tone="danger">{err}</Notice>}
          <input type="file" accept=".csv,text/csv" onChange={async (e) => { const f = e.target.files?.[0]; if (f) { setName(f.name); setCsv(await f.text()); } }} className="text-[13px]" />
          <Textarea label="…or paste the CSV" rows={8} className="font-mono text-[12px]" value={csv} onChange={(e) => setCsv(e.target.value)} />
        </div>
      )}
    </Modal>
  );
}

function CreateFromLine({ line, onClose, onDone }: { line: BLine | null; onClose: () => void; onDone: () => void }) {
  const inflow = (line?.credit ?? 0) > 0;
  const parties = useParties(inflow ? 'customer' : 'supplier,mill,transporter,manufacturer');
  const accs = useAccounts();
  const [kind, setKind] = useState('');
  const [party, setParty] = useState('');
  const [acc, setAcc] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const k = kind || (inflow ? (/PG|SETTLE/i.test(line?.description ?? '') ? 'gateway_settlement' : 'customer_receipt') : /CHARGE|FEE|GST ON/i.test(line?.description ?? '') ? 'bank_charges' : 'supplier_payment');
  const opts = inflow ? [['customer_receipt', 'Receipt from a customer'], ['gateway_settlement', 'Payment gateway settlement'], ['other', 'Other income or transfer']] : [['supplier_payment', 'Payment to a supplier or mill'], ['bank_charges', 'Bank charges'], ['other', 'Other expense']];
  return (
    <Modal open={!!line} onClose={onClose} title="Create the missing entry" description={line ? `${fmtDate(line.txn_date)} · ${line.description} · ${fmtINR(inflow ? line.credit : line.debit)}` : undefined}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} onClick={async () => { setBusy(true); setErr(null); try { await api.post(`/finance/bank-lines/${line!.id}/create`, { kind: k, party_id: party || null, account_id: acc || undefined }); onClose(); onDone(); } catch (e) { setErr(errMsg(e)); } finally { setBusy(false); } }}>Post and match</Button></>}>
      <div className="space-y-3">
        {err && <Notice tone="danger">{err}</Notice>}
        <Select label="What is it?" value={k} onChange={(e) => setKind(e.target.value)} options={opts.map(([v, l]) => ({ value: v!, label: l! }))} />
        {['customer_receipt', 'supplier_payment'].includes(k) && <Select label={inflow ? 'Customer' : 'Supplier'} value={party} onChange={(e) => setParty(e.target.value)} placeholder="Choose" options={(parties.data ?? []).map((p) => ({ value: p.id, label: p.legal_name }))} />}
        {k === 'other' && <Select label="Ledger account" value={acc} onChange={(e) => setAcc(e.target.value)} placeholder="Choose" options={(accs.data ?? []).filter((a) => a.allow_manual && !a.control && !a.is_bank).map((a) => ({ value: a.id, label: `${a.code} · ${a.name}` }))} />}
      </div>
    </Modal>
  );
}

function AddBankModal({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const accs = useAccounts();
  const books = useBooks();
  const [v, setV] = useState({ account_id: '', book_id: '', bank_name: '', account_no: '', ifsc: '' });
  const [err, setErr] = useState<string | null>(null);
  return (
    <Modal open={open} onClose={onClose} title="Add a bank account" footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={async () => { setErr(null); try { await api.post('/finance/bank-accounts', { ...v, ifsc: v.ifsc || null }); onClose(); onDone(); } catch (e) { setErr(errMsg(e)); } }}>Add</Button></>}>
      <div className="space-y-3">
        {err && <Notice tone="danger">{err}</Notice>}
        <Select label="Ledger account" value={v.account_id} onChange={(e) => setV({ ...v, account_id: e.target.value })} placeholder="Choose a bank-type account" options={(accs.data ?? []).filter((a) => a.is_bank).map((a) => ({ value: a.id, label: `${a.code} · ${a.name}` }))} />
        <Select label="Book (GSTIN)" value={v.book_id} onChange={(e) => setV({ ...v, book_id: e.target.value })} placeholder="Choose" options={(books.data ?? []).map((b) => ({ value: b.id, label: `${b.code} · ${b.gstin}` }))} />
        <Input label="Bank and branch" value={v.bank_name} onChange={(e) => setV({ ...v, bank_name: e.target.value })} />
        <div className="grid grid-cols-2 gap-3"><Input label="Account number" value={v.account_no} onChange={(e) => setV({ ...v, account_no: e.target.value })} /><Input label="IFSC" value={v.ifsc} onChange={(e) => setV({ ...v, ifsc: e.target.value.toUpperCase() })} /></div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- GST
interface Tot { taxable: number; cgst: number; sgst: number; igst: number }
interface GstRet { book: { id: string; gstin: string; code: string }; month: string;
  gstr1: { b2b: (Tot & { doc_no: string; doc_date: string; party_name: string; party_gstin: string; place_of_supply: string; transfer: boolean; value: number })[]; b2cs: (Tot & { place_of_supply: string; rate: number })[]; cdnr: (Tot & { doc_no: string; doc_date: string; party_name: string; party_gstin: string | null })[]; hsn: (Tot & { hsn: string; rate: number; qty: number })[] };
  gstr3b: { outward_3_1_a: Tot; reverse_charge_3_1_d: Tot; itc_4a: Tot; liability: Omit<Tot, 'taxable'>; cash_payable: Omit<Tot, 'taxable'>; credit_brought_forward: Omit<Tot, 'taxable'>; credit_carried_forward: Omit<Tot, 'taxable'> };
  inward: (Tot & { id: number; doc_no: string; doc_date: string; party_name: string; party_gstin: string | null; doc_type: string })[]; itc_reconciliation: { lines: number; matched: number; issues: number } }
const taxCols = <T extends Tot>() => [
  { key: 't', header: 'Taxable', align: 'right' as const, render: (r: T) => fmtAmt(r.taxable) },
  { key: 'i', header: 'IGST', align: 'right' as const, render: (r: T) => fmtAmt(r.igst) },
  { key: 'c', header: 'CGST', align: 'right' as const, render: (r: T) => fmtAmt(r.cgst) },
  { key: 's', header: 'SGST', align: 'right' as const, render: (r: T) => fmtAmt(r.sgst) },
];

export function GstPage() {
  const books = useBooks();
  const { can } = useAuth();
  const [book, setBook] = useState('');
  const [month, setMonth] = useState(thisMonth());
  const [tab, setTab] = useState<'3b' | 'gstr1' | '2b' | 'einv' | 'inward'>('3b');
  const bookId = book || books.data?.find((b) => b.is_primary)?.id || '';
  const q = useQuery({ queryKey: ['fin-gst', bookId, month], queryFn: () => api.get<GstRet>(`/finance/gst/returns?book=${bookId}&month=${month}`), enabled: !!bookId });
  const g = q.data;
  return (
    <>
      <PageHeader title="GST compliance" description="Returns are prepared from the GST register that every posted invoice, credit note and inter-GSTIN transfer writes. Filing is done on the GST portal or through a GSP with the exported files." breadcrumbs={[{ label: 'Finance', to: '/finance' }, { label: 'GST' }]}
        actions={<div className="flex gap-2"><BookPicker value={bookId} onChange={setBook} allowAll={false} /><Input type="month" value={month} onChange={(e) => setMonth(e.target.value)} /></div>} />
      <Tabs className="mb-4" value={tab} onChange={setTab} tabs={[{ value: '3b', label: 'GSTR-3B' }, { value: 'gstr1', label: 'GSTR-1', count: g ? g.gstr1.b2b.length + g.gstr1.cdnr.length : undefined }, { value: 'inward', label: 'Purchases (ITC)', count: g?.inward.length }, { value: '2b', label: 'GSTR-2B match' }, { value: 'einv', label: 'E-invoice' }]} />
      {!g ? <Skeleton className="h-80" /> : tab === '3b' ? (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card title="3.1 Outward supplies and reverse charge">
            <TaxGrid rows={[['(a) Outward taxable supplies (net of credit notes)', g.gstr3b.outward_3_1_a], ['(d) Inward supplies liable to reverse charge', g.gstr3b.reverse_charge_3_1_d]]} />
          </Card>
          <Card title="4. Eligible input tax credit">
            <TaxGrid rows={[['(A)(5) All other ITC', g.gstr3b.itc_4a]]} />
            {g.itc_reconciliation.lines > 0 ? <p className="mt-3 text-[12.5px] text-slate-600">GSTR-2B: {g.itc_reconciliation.matched} of {g.itc_reconciliation.lines} lines match; {g.itc_reconciliation.issues} need attention.</p> : <p className="mt-3 text-[12.5px] text-amber-700">GSTR-2B for this month is not imported yet — claim only credit that appears in 2B.</p>}
          </Card>
          <Card className="lg:col-span-2" title="Payment of tax" description="Credit is used in the order the law prescribes: IGST credit against IGST, then CGST, then SGST; CGST and SGST credit against their own head, then IGST.">
            <SimpleTable rows={(['igst', 'cgst', 'sgst'] as const).map((h) => ({ h, liab: g.gstr3b.liability[h], cash: g.gstr3b.cash_payable[h], bf: g.gstr3b.credit_brought_forward[h], cf: g.gstr3b.credit_carried_forward[h] }))} rowKey={(r) => r.h} columns={[
              { key: 'h', header: 'Tax', render: (r) => r.h.toUpperCase() },
              { key: 'b', header: 'Credit brought forward', align: 'right', render: (r) => fmtAmt(r.bf, false) },
              { key: 'l', header: 'Liability', align: 'right', render: (r) => fmtAmt(r.liab, false) },
              { key: 'u', header: 'Paid through credit', align: 'right', render: (r) => fmtAmt(r.liab - r.cash, false) },
              { key: 'c', header: 'Payable in cash', align: 'right', render: (r) => <span className="font-semibold">{fmtAmt(r.cash, false)}</span> },
              { key: 'f', header: 'Credit carried forward', align: 'right', render: (r) => fmtAmt(r.cf, false) },
            ]} />
          </Card>
        </div>
      ) : tab === 'gstr1' ? (
        <div className="space-y-4">
          <div className="flex justify-end">{can('finance.gst.manage') && <Button icon={<Download className="size-4" />} onClick={async () => download(`GSTR1_${g.book.gstin}_${month.replace('-', '')}.json`, await api.get(`/finance/gst/gstr1-json?book=${bookId}&month=${month}`))}>Download GSTR-1 JSON</Button>}</div>
          <Card title="B2B invoices (4A) and supplies to other GSTINs of the company" padded={false}>
            <SimpleTable rows={g.gstr1.b2b} rowKey={(r) => r.doc_no} empty={<EmptyState title="No B2B invoices this month" />} columns={[
              { key: 'n', header: 'Invoice', render: (r) => <div><p className="font-mono text-[12.5px]">{r.doc_no}</p><p className="text-[11.5px] text-slate-500">{fmtDate(r.doc_date)}{r.transfer ? ' · branch transfer' : ''}</p></div> },
              { key: 'p', header: 'Recipient', render: (r) => <div><p>{r.party_name}</p><p className="font-mono text-[11.5px] text-slate-500">{r.party_gstin}</p></div> },
              { key: 'pos', header: 'POS', render: (r) => r.place_of_supply },
              ...taxCols<GstRet['gstr1']['b2b'][number]>(),
            ]} />
          </Card>
          <div className="grid gap-4 lg:grid-cols-2">
            <Card title="B2C small (7)" padded={false}><SimpleTable rows={g.gstr1.b2cs} rowKey={(r) => `${r.place_of_supply}${r.rate}`} empty={<EmptyState title="None" />} columns={[{ key: 'p', header: 'POS · rate', render: (r) => `${r.place_of_supply} · ${r.rate}%` }, ...taxCols<GstRet['gstr1']['b2cs'][number]>()]} /></Card>
            <Card title="Credit notes (9B)" padded={false}><SimpleTable rows={g.gstr1.cdnr} rowKey={(r) => r.doc_no} empty={<EmptyState title="None" />} columns={[{ key: 'n', header: 'Note', render: (r) => <div><p className="font-mono text-[12.5px]">{r.doc_no}</p><p className="text-[11.5px] text-slate-500">{r.party_name}</p></div> }, ...taxCols<GstRet['gstr1']['cdnr'][number]>()]} /></Card>
          </div>
          <Card title="HSN summary (12)" padded={false}><SimpleTable rows={g.gstr1.hsn} rowKey={(r) => `${r.hsn}${r.rate}`} empty={<EmptyState title="None" />} columns={[{ key: 'h', header: 'HSN', render: (r) => <span className="font-mono">{r.hsn}</span> }, { key: 'r', header: 'Rate', render: (r) => `${r.rate}%` }, { key: 'q', header: 'Qty (KGS)', align: 'right', render: (r) => fmtNum(r.qty) }, ...taxCols<GstRet['gstr1']['hsn'][number]>()]} /></Card>
        </div>
      ) : tab === 'inward' ? (
        <Card padded={false}>
          <SimpleTable rows={g.inward} rowKey={(r) => String(r.id)} empty={<EmptyState title="No purchases this month" />} columns={[
            { key: 'n', header: 'Supplier invoice', render: (r) => <div><p className="font-mono text-[12.5px]">{r.doc_no}</p><p className="text-[11.5px] text-slate-500">{fmtDate(r.doc_date)} · {humanize(r.doc_type)}</p></div> },
            { key: 'p', header: 'Supplier', render: (r) => <div><p>{r.party_name}</p><p className="font-mono text-[11.5px] text-slate-500">{r.party_gstin}</p></div> },
            ...taxCols<GstRet['inward'][number]>(),
          ]} />
        </Card>
      ) : tab === '2b' ? <TwoBPanel bookId={bookId} month={month} /> : <EInvoicePanel bookId={bookId} month={month} />}
    </>
  );
}

function TaxGrid({ rows }: { rows: [string, Tot][] }) {
  return (
    <table className="w-full text-[13px]"><thead><tr className="text-left text-[11.5px] text-slate-500 uppercase"><th className="py-1 font-semibold">Nature</th>{['Taxable', 'IGST', 'CGST', 'SGST'].map((h) => <th key={h} className="py-1 pl-4 text-right font-semibold">{h}</th>)}</tr></thead>
      <tbody>{rows.map(([l, t]) => <tr key={l} className="border-t border-slate-100"><td className="py-2 pr-3">{l}</td>{[t.taxable, t.igst, t.cgst, t.sgst].map((v, i) => <td key={i} className="py-2 pl-4 text-right whitespace-nowrap tabular">{fmtAmt(v, false)}</td>)}</tr>)}</tbody></table>
  );
}

interface TwoB { lines: { id: string; supplier_gstin: string; supplier_name: string | null; invoice_no: string; invoice_date: string | null; taxable: number; igst: number; cgst: number; sgst: number; status: string; difference: number | null }[]; not_in_2b: { doc_no: string; doc_date: string; party_name: string; party_gstin: string; tax: number; taxable: number }[] }
function TwoBPanel({ bookId, month }: { bookId: string; month: string }) {
  const { can } = useAuth();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['fin-2b', bookId, month], queryFn: () => api.get<TwoB>(`/finance/gst/2b?book=${bookId}&month=${month}`) });
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const tone = (s: string) => (s === 'matched' ? 'success' : s === 'amount_mismatch' ? 'warning' : 'danger');
  return (
    <div className="space-y-4">
      <div className="flex justify-end">{can('finance.gst.manage') && <Button icon={<FileUp className="size-4" />} onClick={() => setOpen(true)}>Import GSTR-2B</Button>}</div>
      <Card title="GSTR-2B lines" description="Supplier invoices the GST portal shows for this month, matched to our purchase register by supplier GSTIN and invoice number." padded={false}>
        {!q.data ? <Skeleton className="m-5 h-32" /> : <SimpleTable rows={q.data.lines} rowKey={(r) => r.id} empty={<EmptyState title="Not imported for this month" />} columns={[
          { key: 's', header: 'Supplier', render: (r) => <div><p>{r.supplier_name}</p><p className="font-mono text-[11.5px] text-slate-500">{r.supplier_gstin}</p></div> },
          { key: 'n', header: 'Invoice', render: (r) => <span className="font-mono text-[12.5px]">{r.invoice_no}</span> },
          { key: 't', header: 'Tax in 2B', align: 'right', render: (r) => fmtAmt(r.igst + r.cgst + r.sgst) },
          { key: 'd', header: 'Difference', align: 'right', render: (r) => (r.status === 'matched' ? '—' : fmtAmt(r.difference)) },
          { key: 'st', header: 'Result', render: (r) => <Badge tone={tone(r.status)}>{humanize(r.status === 'not_in_books' ? 'not in our books' : r.status)}</Badge> },
        ]} />}
      </Card>
      <Card title="In our books but not in 2B" description="The supplier has not filed these yet; the credit is at risk until they do." padded={false}>
        {!q.data ? null : <SimpleTable rows={q.data.not_in_2b} rowKey={(r) => r.doc_no + r.party_gstin} empty={<EmptyState title="Every purchase invoice appears in 2B" />} columns={[
          { key: 's', header: 'Supplier', render: (r) => r.party_name },
          { key: 'n', header: 'Invoice', render: (r) => <span className="font-mono text-[12.5px]">{r.doc_no}</span> },
          { key: 'd', header: 'Date', render: (r) => fmtDate(r.doc_date) },
          { key: 't', header: 'Tax', align: 'right', render: (r) => fmtAmt(r.tax) },
        ]} />}
      </Card>
      <Modal open={open} onClose={() => setOpen(false)} size="lg" title="Import GSTR-2B" description="Paste the B2B section of the GSTR-2B JSON from the GST portal, or CSV with: supplier_gstin, supplier_name, invoice_no, invoice_date, taxable, igst, cgst, sgst."
        footer={<><Button onClick={() => setOpen(false)}>Cancel</Button><Button variant="primary" onClick={async () => {
          setErr(null);
          try {
            let lines: unknown[];
            const t = text.trim();
            if (t.startsWith('{') || t.startsWith('[')) {
              const j = JSON.parse(t);
              const b2b = (j.data?.docdata?.b2b ?? j.docdata?.b2b ?? j.b2b ?? j) as { ctin: string; trdnm?: string; inv: { inum: string; dt: string; txval: number; igst?: number; cgst?: number; sgst?: number; items?: { txval: number; igst: number; cgst: number; sgst: number }[] }[] }[];
              lines = b2b.flatMap((s) => s.inv.map((i) => ({ supplier_gstin: s.ctin, supplier_name: s.trdnm ?? null, invoice_no: i.inum, invoice_date: i.dt?.split('-').reverse().join('-') ?? null, taxable: i.txval ?? i.items?.reduce((a, x) => a + x.txval, 0) ?? 0, igst: i.igst ?? 0, cgst: i.cgst ?? 0, sgst: i.sgst ?? 0 })));
            } else {
              lines = t.split(/\r?\n/).slice(1).filter(Boolean).map((l) => { const c = l.split(','); return { supplier_gstin: c[0], supplier_name: c[1] || null, invoice_no: c[2], invoice_date: c[3] || null, taxable: Number(c[4]), igst: Number(c[5] || 0), cgst: Number(c[6] || 0), sgst: Number(c[7] || 0) }; });
            }
            await api.post('/finance/gst/2b', { book_id: bookId, month, lines });
            setOpen(false); setText(''); invalidatePrefix(qc, 'fin-');
          } catch (e) { setErr(errMsg(e)); }
        }}>Import and match</Button></>}>
        {err && <div className="mb-3"><Notice tone="danger">{err}</Notice></div>}
        <Textarea rows={10} className="font-mono text-[12px]" value={text} onChange={(e) => setText(e.target.value)} />
      </Modal>
    </div>
  );
}

interface EInv { doc_no: string; doc_type: string; doc_date: string; party_name: string; party_gstin: string; value: number; irn: string | null; irn_status: string; payload: unknown }
function EInvoicePanel({ bookId, month }: { bookId: string; month: string }) {
  const q = useQuery({ queryKey: ['fin-einv', bookId, month], queryFn: () => api.get<EInv[]>(`/finance/gst/e-invoices?book=${bookId}&month=${month}`) });
  return (
    <>
      <div className="mb-4"><Notice tone="info" title="IRN generation needs a GSP connection">The payloads below follow the IRP schema (version 1.1). Until a GST Suvidha Provider is configured, upload them on the e-invoice portal and record the IRN; invoices carry a note that IRN is pending.</Notice></div>
      <Card padded={false}>
        {!q.data ? <Skeleton className="m-5 h-32" /> : <SimpleTable rows={q.data} rowKey={(r) => r.doc_no} empty={<EmptyState title="No B2B documents this month" />} columns={[
          { key: 'n', header: 'Document', render: (r) => <div><p className="font-mono text-[12.5px]">{r.doc_no}</p><p className="text-[11.5px] text-slate-500">{humanize(r.doc_type)} · {fmtDate(r.doc_date)}</p></div> },
          { key: 'p', header: 'Buyer', render: (r) => <div><p>{r.party_name}</p><p className="font-mono text-[11.5px] text-slate-500">{r.party_gstin}</p></div> },
          { key: 'v', header: 'Value', align: 'right', render: (r) => fmtAmt(r.value) },
          { key: 's', header: 'IRN', render: (r) => (r.irn ? <span className="font-mono text-[11px]">{r.irn}</span> : <Badge tone="warning">Pending</Badge>) },
          { key: 'd', header: '', render: (r) => <Button size="sm" variant="ghost" icon={<Download className="size-3.5" />} onClick={() => download(`${r.doc_no.replace(/\//g, '-')}.json`, r.payload)}>JSON</Button> },
        ]} />}
      </Card>
    </>
  );
}

// ---------------------------------------------------------------- TDS
interface TdsSec { code: string; description: string; rate_company: number; rate_individual: number; rate_no_pan: number; threshold_single: number; threshold_annual: number; on_excess: boolean; effective_from: string }
interface TdsReg { fy: string; entries: { id: string; party_name: string; pan: string | null; section: string; base_amount: number; rate: number; tds_amount: number; deducted_on: string; voucher_no: string; challan_no: string | null }[]; challans: { id: string; section: string; month: string; amount: number; bsr_code: string; challan_no: string; paid_on: string }[]; summary: { month: string; section: string; deducted: number; deposited: number; pending: number; due_date: string; overdue: boolean; entries: number }[]; quarters: { quarter: string; form: string; deductees: number; entries: number; tds: number; deposited: number }[] }
export function TdsPage() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const [tab, setTab] = useState<'register' | 'parties' | 'sections'>('register');
  const reg = useQuery({ queryKey: ['fin-tds'], queryFn: () => api.get<TdsReg>('/finance/tds/register') });
  const secs = useQuery({ queryKey: ['fin-tds-sec'], queryFn: () => api.get<TdsSec[]>('/finance/tds/sections') });
  const pts = useQuery({ queryKey: ['fin-tds-parties'], queryFn: () => api.get<{ party_id: string; party_name: string; pan: string | null; tds_section: string | null; lower_rate: number | null; lower_cert_no: string | null; lower_valid_to: string | null }[]>('/finance/tds/parties') });
  const [challan, setChallan] = useState<TdsReg['summary'][number] | null>(null);
  const [cv, setCv] = useState({ bsr_code: '', challan_no: '', paid_on: new Date().toISOString().slice(0, 10) });
  const [party, setParty] = useState<{ party_id: string; party_name: string; pan: string | null; tds_section: string | null } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const allParties = useParties('supplier,mill,transporter,manufacturer');
  const r = reg.data;
  return (
    <>
      <PageHeader title="TDS" description="Tax is deducted when a supplier’s or mill’s bill posts, by the section set for that party, with single and annual thresholds. Deposit by the 7th of the following month; the quarterly 26Q is prepared from this register." breadcrumbs={[{ label: 'Finance', to: '/finance' }, { label: 'TDS' }]} />
      <Tabs className="mb-4" value={tab} onChange={setTab} tabs={[{ value: 'register', label: 'Register and challans' }, { value: 'parties', label: 'Deductees', count: pts.data?.length }, { value: 'sections', label: 'Sections and rates' }]} />
      {tab === 'register' ? (!r ? <Skeleton className="h-60" /> : (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">{r.quarters.map((qq) => <Stat key={qq.quarter} label={`${qq.quarter} FY ${r.fy} · ${qq.form}`} value={fmtINR(qq.tds)} sub={`${qq.deductees} deductees · ${fmtINR(qq.deposited)} deposited`} tone={qq.tds - qq.deposited > 0.5 ? 'warning' : undefined} />)}</div>
          <Card title="By month and section" padded={false}>
            <SimpleTable rows={r.summary} rowKey={(s) => s.month + s.section} empty={<EmptyState title="No TDS deducted this year" />} columns={[
              { key: 'm', header: 'Month', render: (s) => s.month.slice(0, 7) },
              { key: 's', header: 'Section', render: (s) => s.section },
              { key: 'd', header: 'Deducted', align: 'right', render: (s) => fmtAmt(s.deducted) },
              { key: 'p', header: 'Deposited', align: 'right', render: (s) => fmtAmt(s.deposited) },
              { key: 'u', header: 'Due by', render: (s) => <span className={s.overdue ? 'font-semibold text-rose-600' : ''}>{fmtDate(s.due_date)}</span> },
              { key: 'a', header: '', render: (s) => s.pending > 0.5 && can('finance.tds.manage') ? <Button size="sm" onClick={() => { setChallan(s); setErr(null); }}>Record challan</Button> : s.pending <= 0.5 ? <Badge tone="success">Deposited</Badge> : null },
            ]} />
          </Card>
          <Card title="Deductions" padded={false}>
            <SimpleTable rows={r.entries} rowKey={(e) => e.id} columns={[
              { key: 'd', header: 'Date', render: (e) => fmtDate(e.deducted_on) },
              { key: 'p', header: 'Deductee', render: (e) => <div><p>{e.party_name}</p><p className="font-mono text-[11.5px] text-slate-500">{e.pan ?? 'No PAN (higher rate)'}</p></div> },
              { key: 's', header: 'Section', render: (e) => e.section },
              { key: 'b', header: 'Base', align: 'right', render: (e) => fmtAmt(e.base_amount) },
              { key: 'r', header: 'Rate', align: 'right', render: (e) => `${e.rate}%` },
              { key: 't', header: 'TDS', align: 'right', render: (e) => fmtAmt(e.tds_amount) },
              { key: 'v', header: 'Voucher', render: (e) => <span className="font-mono text-[12px]">{e.voucher_no}</span> },
              { key: 'c', header: 'Challan', render: (e) => e.challan_no ?? '—' },
            ]} />
          </Card>
        </div>
      )) : tab === 'parties' ? (
        <Card padded={false} actions={can('finance.tds.manage') && <Button size="sm" onClick={() => setParty({ party_id: '', party_name: '', pan: null, tds_section: null })}>Configure a party</Button>} title="Deductees">
          <SimpleTable rows={pts.data ?? []} rowKey={(p) => p.party_id} onRowClick={can('finance.tds.manage') ? (p) => setParty(p) : undefined} columns={[
            { key: 'n', header: 'Party', render: (p) => p.party_name },
            { key: 'p', header: 'PAN', render: (p) => <span className="font-mono text-[12.5px]">{p.pan ?? '—'}</span> },
            { key: 's', header: 'Section', render: (p) => p.tds_section ?? 'Not deducted' },
            { key: 'l', header: 'Lower deduction certificate', render: (p) => (p.lower_rate != null ? `${p.lower_rate}% · ${p.lower_cert_no} · to ${fmtDate(p.lower_valid_to)}` : '—') },
          ]} />
        </Card>
      ) : (
        <Card padded={false}>
          <SimpleTable rows={secs.data ?? []} rowKey={(s) => s.code} columns={[
            { key: 'c', header: 'Section', render: (s) => <span className="font-semibold">{s.code}</span> },
            { key: 'd', header: 'Nature', render: (s) => s.description },
            { key: 'r', header: 'Rate (company / individual / no PAN)', render: (s) => `${s.rate_company}% / ${s.rate_individual}% / ${s.rate_no_pan}%` },
            { key: 't', header: 'Threshold', render: (s) => `${s.threshold_single ? `${fmtINR(s.threshold_single)} per bill` : ''}${s.threshold_single && s.threshold_annual ? ' · ' : ''}${s.threshold_annual ? `${fmtINR(s.threshold_annual)} a year${s.on_excess ? ' (on the excess)' : ''}` : ''}` },
            { key: 'e', header: 'From', render: (s) => fmtDate(s.effective_from) },
          ]} />
          <p className="px-5 py-3 text-[12.5px] text-slate-500">Rates and thresholds are configuration. Confirm them with the CA before go-live and on every Finance Act change.</p>
        </Card>
      )}
      <Modal open={!!challan} onClose={() => setChallan(null)} title={challan ? `Challan for ${challan.section} · ${challan.month.slice(0, 7)}` : ''} description={challan ? `${fmtINR(challan.pending)} from ${challan.entries} deductions. The payment is posted from the main bank account.` : undefined}
        footer={<><Button onClick={() => setChallan(null)}>Cancel</Button><Button variant="primary" onClick={async () => { setErr(null); try { await api.post('/finance/tds/challans', { section: challan!.section, month: challan!.month.slice(0, 7), ...cv }); setChallan(null); invalidatePrefix(qc, 'fin-'); } catch (e) { setErr(errMsg(e)); } }}>Record</Button></>}>
        <div className="space-y-3">{err && <Notice tone="danger">{err}</Notice>}<div className="grid grid-cols-3 gap-3"><Input label="BSR code" value={cv.bsr_code} onChange={(e) => setCv({ ...cv, bsr_code: e.target.value })} /><Input label="Challan serial" value={cv.challan_no} onChange={(e) => setCv({ ...cv, challan_no: e.target.value })} /><Input label="Paid on" type="date" value={cv.paid_on} onChange={(e) => setCv({ ...cv, paid_on: e.target.value })} /></div></div>
      </Modal>
      {party && <PartyTaxModal init={party} parties={(allParties.data ?? []).map((p) => ({ id: p.id, name: p.legal_name }))} sections={secs.data ?? []} onClose={() => setParty(null)} onDone={() => invalidatePrefix(qc, 'fin-')} />}
    </>
  );
}

function PartyTaxModal({ init, parties, sections, onClose, onDone }: { init: { party_id: string; party_name: string; pan: string | null; tds_section: string | null }; parties: { id: string; name: string }[]; sections: TdsSec[]; onClose: () => void; onDone: () => void }) {
  const [v, setV] = useState({ party_id: init.party_id, pan: init.pan ?? '', tds_section: init.tds_section ?? '', lower_rate: '', lower_cert_no: '', lower_valid_to: '' });
  const [err, setErr] = useState<string | null>(null);
  return (
    <Modal open onClose={onClose} title={init.party_name || 'Configure TDS for a party'} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={async () => { setErr(null); try { await api.put(`/finance/tds/parties/${v.party_id}`, { pan: v.pan || null, tds_section: v.tds_section || null, lower_rate: v.lower_rate ? Number(v.lower_rate) : null, lower_cert_no: v.lower_cert_no || null, lower_valid_to: v.lower_valid_to || null }); onClose(); onDone(); } catch (e) { setErr(errMsg(e)); } }}>Save</Button></>}>
      <div className="space-y-3">
        {err && <Notice tone="danger">{err}</Notice>}
        {!init.party_id && <Select label="Party" value={v.party_id} onChange={(e) => setV({ ...v, party_id: e.target.value })} placeholder="Choose" options={parties.map((p) => ({ value: p.id, label: p.name }))} />}
        <div className="grid grid-cols-2 gap-3"><Input label="PAN" value={v.pan} onChange={(e) => setV({ ...v, pan: e.target.value.toUpperCase() })} /><Select label="Section" value={v.tds_section} onChange={(e) => setV({ ...v, tds_section: e.target.value })} options={[{ value: '', label: 'No deduction' }, ...sections.map((s) => ({ value: s.code, label: `${s.code} · ${s.description}` }))]} /></div>
        <p className="text-[12.5px] font-medium text-slate-600">Lower deduction certificate (section 197), if any</p>
        <div className="grid grid-cols-3 gap-3"><Input label="Rate %" type="number" value={v.lower_rate} onChange={(e) => setV({ ...v, lower_rate: e.target.value })} /><Input label="Certificate no." value={v.lower_cert_no} onChange={(e) => setV({ ...v, lower_cert_no: e.target.value })} /><Input label="Valid to" type="date" value={v.lower_valid_to} onChange={(e) => setV({ ...v, lower_valid_to: e.target.value })} /></div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- statements
interface PLLine { code: string; name: string; account_id: string; amount: number }
interface PL { revenue: PLLine[]; revenue_total: number; cost_of_sales: PLLine[]; cost_of_sales_total: number; gross_profit: number; gross_margin_pct: number | null; other_income: PLLine[]; other_income_total: number; operating_expenses: PLLine[]; operating_expenses_total: number; finance_costs: PLLine[]; finance_costs_total: number; net_profit: number }
interface BS { current_assets: PLLine[]; non_current_assets: PLLine[]; total_assets: number; current_liabilities: PLLine[]; non_current_liabilities: PLLine[]; equity: PLLine[]; total_liabilities: number; total_equity: number; balanced: boolean; difference: number }
interface TB { rows: { account_id: string; code: string; name: string; group: string; opening: number; debit: number; credit: number; closing_debit: number; closing_credit: number }[]; totals: { debit: number; credit: number; closing_debit: number; closing_credit: number }; balanced: boolean }
interface CF { receipts_from_customers: number; payments_to_suppliers: number; payments_to_employees: number; taxes_paid: number; other_operating: number; operating: number; investing: number; financing: number; net_change: number; opening_cash: number; closing_cash: number }
interface Ratios { sales_12m: number; purchases_12m: number; receivables: number; payables: number; inventory: number; dso_days: number | null; dpo_days: number | null; inventory_days: number | null; working_capital: number; current_ratio: number | null; gross_margin_pct: number | null; net_profit_12m: number }

function Section({ title, rows, total, neg }: { title: string; rows: PLLine[]; total: number; neg?: boolean }) {
  if (!rows.length && !total) return null;
  return (
    <>
      <tr><td colSpan={2} className="pt-4 pb-1 text-[12px] font-semibold tracking-wide text-slate-500 uppercase">{title}</td></tr>
      {rows.map((r) => <tr key={r.code + r.name}><td className="py-1 pl-3">{r.account_id ? <Link className="hover:underline" to={`/finance/ledger/${r.account_id}`}>{r.name}</Link> : r.name}</td><td className="py-1 text-right tabular">{fmtAmt(r.amount)}</td></tr>)}
      <tr className="border-t border-slate-200 font-semibold"><td className="py-1.5">Total {title.toLowerCase()}</td><td className="py-1.5 text-right tabular">{neg ? `(${fmtAmt(total, false)})` : fmtAmt(total, false)}</td></tr>
    </>
  );
}
const Strong = ({ label, v }: { label: ReactNode; v: number }) => <tr className="border-t-2 border-slate-300 text-[14px] font-bold"><td className="py-2">{label}</td><td className={clsx('py-2 text-right tabular', v < 0 && 'text-rose-600')}>{fmtAmt(v, false)}</td></tr>;

export function StatementsPage() {
  const fyStart = (() => { const d = new Date(); const y = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1; return `${y}-04-01`; })();
  const [tab, setTab] = useState<'pl' | 'bs' | 'tb' | 'cf' | 'ratios'>('pl');
  const [book, setBook] = useState('all');
  const [from, setFrom] = useState(fyStart);
  const [to, setTo] = useState(new Date().toISOString().slice(0, 10));
  const qs = `book=${book}&from=${from}&to=${to}`;
  const pl = useQuery({ queryKey: ['fin-pl', qs], queryFn: () => api.get<PL>(`/finance/reports/profit-and-loss?${qs}`), enabled: tab === 'pl' });
  const bs = useQuery({ queryKey: ['fin-bs', qs], queryFn: () => api.get<BS>(`/finance/reports/balance-sheet?${qs}`), enabled: tab === 'bs' });
  const tb = useQuery({ queryKey: ['fin-tb', qs], queryFn: () => api.get<TB>(`/finance/reports/trial-balance?${qs}`), enabled: tab === 'tb' });
  const cf = useQuery({ queryKey: ['fin-cf', qs], queryFn: () => api.get<CF>(`/finance/reports/cash-flow?${qs}`), enabled: tab === 'cf' });
  const ra = useQuery({ queryKey: ['fin-ratios', qs], queryFn: () => api.get<Ratios>(`/finance/reports/ratios?${qs}`), enabled: tab === 'ratios' });
  return (
    <>
      <PageHeader title="Financial statements" description="Built from posted vouchers only. The consolidated view removes inter-GSTIN transfers and inter-unit balances, which cancel out within the company." breadcrumbs={[{ label: 'Finance', to: '/finance' }, { label: 'Statements' }]}
        actions={<div className="flex items-end gap-2"><BookPicker value={book} onChange={setBook} />{tab !== 'bs' && tab !== 'ratios' && <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />}<Input type="date" value={to} onChange={(e) => setTo(e.target.value)} /><Button onClick={() => window.print()}>Print</Button></div>} />
      <Tabs className="mb-4" value={tab} onChange={setTab} tabs={[{ value: 'pl', label: 'Profit and loss' }, { value: 'bs', label: 'Balance sheet' }, { value: 'tb', label: 'Trial balance' }, { value: 'cf', label: 'Cash flow' }, { value: 'ratios', label: 'Working capital' }]} />
      {tab === 'pl' && (!pl.data ? <Skeleton className="h-96" /> : (
        <Card className="max-w-3xl"><table className="w-full text-[13.5px]"><tbody>
          <Section title="Revenue from operations" rows={pl.data.revenue} total={pl.data.revenue_total} />
          <Section title="Cost of sales" rows={pl.data.cost_of_sales} total={pl.data.cost_of_sales_total} neg />
          <Strong label={<>Gross profit {pl.data.gross_margin_pct != null && <span className="text-[12px] font-normal text-slate-500">({pl.data.gross_margin_pct}%)</span>}</>} v={pl.data.gross_profit} />
          <Section title="Other income" rows={pl.data.other_income} total={pl.data.other_income_total} />
          <Section title="Operating expenses" rows={pl.data.operating_expenses} total={pl.data.operating_expenses_total} neg />
          <Section title="Finance costs" rows={pl.data.finance_costs} total={pl.data.finance_costs_total} neg />
          <Strong label="Net profit before tax" v={pl.data.net_profit} />
        </tbody></table><p className="mt-3 text-[12px] text-slate-500">Cost of sales includes the change in inventory posted at each period close. When the report runs to today, stock not yet posted is valued now and shown as a provisional line; nothing is posted until the month is locked.</p></Card>
      ))}
      {tab === 'bs' && (!bs.data ? <Skeleton className="h-96" /> : (
        <div className="grid max-w-5xl gap-4 lg:grid-cols-2">
          <Card title="Assets"><table className="w-full text-[13.5px]"><tbody><Section title="Non-current assets" rows={bs.data.non_current_assets} total={bs.data.non_current_assets.reduce((s, r) => s + r.amount, 0)} /><Section title="Current assets" rows={bs.data.current_assets} total={bs.data.current_assets.reduce((s, r) => s + r.amount, 0)} /><Strong label="Total assets" v={bs.data.total_assets} /></tbody></table></Card>
          <Card title="Equity and liabilities"><table className="w-full text-[13.5px]"><tbody><Section title="Equity" rows={bs.data.equity} total={bs.data.total_equity} /><Section title="Non-current liabilities" rows={bs.data.non_current_liabilities} total={bs.data.non_current_liabilities.reduce((s, r) => s + r.amount, 0)} /><Section title="Current liabilities" rows={bs.data.current_liabilities} total={bs.data.current_liabilities.reduce((s, r) => s + r.amount, 0)} /><Strong label="Total equity and liabilities" v={bs.data.total_equity + bs.data.total_liabilities} /></tbody></table></Card>
          <div className="lg:col-span-2">{bs.data.balanced ? <Notice tone="success">Assets equal equity plus liabilities.</Notice> : <Notice tone="danger">Out of balance by {fmtAmt(bs.data.difference)}.</Notice>}</div>
        </div>
      ))}
      {tab === 'tb' && (!tb.data ? <Skeleton className="h-96" /> : (
        <Card padded={false}>
          <SimpleTable rows={tb.data.rows} rowKey={(r) => r.account_id} columns={[
            { key: 'a', header: 'Account', render: (r) => <Link className="hover:underline" to={`/finance/ledger/${r.account_id}?book=${book}`}><span className="font-mono text-[12px] text-slate-500">{r.code}</span> {r.name}</Link> },
            { key: 'o', header: 'Opening', align: 'right', render: (r) => <span>{fmtAmt(Math.abs(r.opening))} {Math.abs(r.opening) > 0.005 && <span className="text-[11px] text-slate-400">{r.opening > 0 ? 'Dr' : 'Cr'}</span>}</span> },
            { key: 'd', header: 'Debit', align: 'right', render: (r) => fmtAmt(r.debit) },
            { key: 'c', header: 'Credit', align: 'right', render: (r) => fmtAmt(r.credit) },
            { key: 'cd', header: 'Closing Dr', align: 'right', render: (r) => fmtAmt(r.closing_debit) },
            { key: 'cc', header: 'Closing Cr', align: 'right', render: (r) => fmtAmt(r.closing_credit) },
          ]} />
          <div className="flex justify-between border-t-2 border-slate-300 px-4 py-3 text-[13.5px] font-semibold tabular"><span>{tb.data.balanced ? <span className="text-emerald-700">Balanced</span> : <span className="text-rose-600">Not balanced</span>}</span><span className="flex gap-8"><span>{fmtAmt(tb.data.totals.debit)}</span><span>{fmtAmt(tb.data.totals.credit)}</span><span>{fmtAmt(tb.data.totals.closing_debit)}</span><span>{fmtAmt(tb.data.totals.closing_credit)}</span></span></div>
        </Card>
      ))}
      {tab === 'cf' && (!cf.data ? <Skeleton className="h-80" /> : (
        <Card className="max-w-2xl" title="Cash flow (direct method)" description="Movements on cash, bank and the payment-gateway clearing account, classified by the other side of each voucher.">
          <table className="w-full text-[13.5px]"><tbody>
            {([['Receipts from customers', cf.data.receipts_from_customers], ['Payments to suppliers and mills', cf.data.payments_to_suppliers], ['Payments to employees', cf.data.payments_to_employees], ['Taxes paid (GST, TDS)', cf.data.taxes_paid], ['Other operating', cf.data.other_operating]] as [string, number][]).map(([l, v]) => <tr key={l}><td className="py-1 pl-3">{l}</td><td className="py-1 text-right tabular">{fmtAmt(v, false)}</td></tr>)}
            <Strong label="Net cash from operations" v={cf.data.operating} />
            <tr><td className="py-1 pl-3">Investing</td><td className="py-1 text-right tabular">{fmtAmt(cf.data.investing, false)}</td></tr>
            <tr><td className="py-1 pl-3">Financing</td><td className="py-1 text-right tabular">{fmtAmt(cf.data.financing, false)}</td></tr>
            <Strong label="Net change in cash" v={cf.data.net_change} />
            <tr><td className="py-1">Opening cash and bank</td><td className="py-1 text-right tabular">{fmtAmt(cf.data.opening_cash, false)}</td></tr>
            <Strong label="Closing cash and bank" v={cf.data.closing_cash} />
          </tbody></table>
        </Card>
      ))}
      {tab === 'ratios' && (!ra.data ? <Skeleton className="h-60" /> : (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat label="Debtor days (DSO)" value={ra.data.dso_days ?? '—'} sub={`Receivables ${fmtINR(ra.data.receivables)}`} />
          <Stat label="Creditor days (DPO)" value={ra.data.dpo_days ?? '—'} sub={`Payables ${fmtINR(ra.data.payables)}`} />
          <Stat label="Inventory days" value={ra.data.inventory_days ?? '—'} sub={`Stock ${fmtINR(ra.data.inventory)} at last close`} />
          <Stat label="Working capital" value={fmtINR(ra.data.working_capital)} sub={ra.data.current_ratio != null ? `Current ratio ${ra.data.current_ratio}` : undefined} />
          <Stat label="Sales, last 12 months" value={fmtINR(ra.data.sales_12m)} />
          <Stat label="Purchases, last 12 months" value={fmtINR(ra.data.purchases_12m)} />
          <Stat label="Gross margin" value={ra.data.gross_margin_pct != null ? `${ra.data.gross_margin_pct}%` : '—'} />
          <Stat label="Net profit, last 12 months" value={fmtINR(ra.data.net_profit_12m)} />
        </div>
      ))}
    </>
  );
}

// ---------------------------------------------------------------- close
interface Period { month: string; status: string; locked_by_name: string | null; locked_at: string | null; note: string | null; vouchers: number; pending: number; stock_value: number | null }
interface Val { method: string; as_of: string; total_kg: number; total_value: number; by_book: { book_code: string; kg: number; value: number }[]; by_sku: { sku: string; product_name: string; kg: number; value: number; rate: number; lots: number; at_mill_kg: number }[]; missing_cost_lots: number; snapshots: { month: string; value: number; kg: number; book: string; voucher_no: string | null }[] }
export function ClosePage() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const p = useQuery({ queryKey: ['fin-periods'], queryFn: () => api.get<Period[]>('/finance/periods') });
  const v = useQuery({ queryKey: ['fin-val'], queryFn: () => api.get<Val>('/finance/inventory-valuation') });
  const [lock, setLock] = useState<Period | null>(null);
  const [reopen, setReopen] = useState<Period | null>(null);
  const [busy, setBusy] = useState(false);
  const cur = new Date().toISOString().slice(0, 7);
  return (
    <>
      <PageHeader title="Period close" description="Lock each month once it is reviewed: nothing can be posted into a locked month, and automatic postings that arrive late move to the next open month. Locking the latest month also values closing stock and posts it." breadcrumbs={[{ label: 'Finance', to: '/finance' }, { label: 'Period close' }]} />
      <div className="grid gap-4 lg:grid-cols-5">
        <Card className="lg:col-span-2" title="Months" padded={false}>
          {!p.data ? <Skeleton className="m-5 h-60" /> : (
            <ul className="divide-y divide-slate-100">
              {p.data.map((m) => (
                <li key={m.month} className="flex items-center justify-between px-5 py-2.5 text-[13px]">
                  <div><p className="font-medium">{new Date(`${m.month}T00:00:00`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' })}</p><p className="text-[12px] text-slate-500">{m.vouchers} vouchers{m.pending ? ` · ${m.pending} awaiting approval` : ''}{m.stock_value != null ? ` · stock ${fmtINR(m.stock_value)}` : ''}{m.locked_by_name ? ` · locked by ${m.locked_by_name}` : ''}</p></div>
                  {m.status === 'locked' ? <div className="flex items-center gap-2"><Badge tone="neutral"><Lock className="mr-1 inline size-3" />Locked</Badge>{can('finance.period.manage') && <Button size="sm" variant="ghost" icon={<Unlock className="size-3.5" />} onClick={() => setReopen(m)}>Reopen</Button>}</div>
                    : m.month.slice(0, 7) <= cur && can('finance.period.manage') ? <Button size="sm" icon={<Lock className="size-3.5" />} onClick={() => setLock(m)}>Lock</Button> : <span className="text-[12px] text-slate-400">Open</span>}
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card className="lg:col-span-3" title="Inventory valuation" description={v.data ? `${humanize(v.data.method)} at landed lot cost (purchase, processing and freight as captured on each lot). Includes stock at mills and in transit, which the company still owns.` : undefined}>
          {!v.data ? <Skeleton className="h-60" /> : (
            <>
              <div className="mb-3 grid grid-cols-3 gap-3"><Stat label="Owned stock" value={`${fmtNum(v.data.total_kg)} kg`} /><Stat label="Value" value={fmtINR(v.data.total_value)} /><Stat label="Lots without a cost" value={v.data.missing_cost_lots} tone={v.data.missing_cost_lots ? 'warning' : undefined} sub="valued at the SKU average" /></div>
              <SimpleTable rows={v.data.by_sku} rowKey={(r) => r.sku} columns={[
                { key: 's', header: 'Fabric', render: (r) => <div><p className="font-mono text-[12.5px]">{r.sku}</p><p className="text-[11.5px] text-slate-500">{r.lots} lots{r.at_mill_kg ? ` · ${fmtNum(r.at_mill_kg)} kg at mills` : ''}</p></div> },
                { key: 'k', header: 'KG', align: 'right', render: (r) => fmtNum(r.kg) },
                { key: 'r', header: 'Rate', align: 'right', render: (r) => fmtAmt(r.rate) },
                { key: 'v', header: 'Value', align: 'right', render: (r) => fmtAmt(r.value) },
              ]} />
              <p className="mt-3 text-[12.5px] text-slate-600">By GSTIN: {v.data.by_book.map((b) => `${b.book_code} ${fmtINR(b.value)}`).join(' · ')}</p>
              {v.data.snapshots.length > 0 && <p className="mt-1 text-[12.5px] text-slate-500">Posted: {v.data.snapshots.map((s) => `${s.month.slice(0, 7)} ${s.book} ${fmtINR(s.value)}${s.voucher_no ? ` (${s.voucher_no})` : ''}`).join(' · ')}</p>}
            </>
          )}
        </Card>
      </div>
      <ConfirmDialog open={!!lock} onClose={() => setLock(null)} title={`Lock ${lock?.month.slice(0, 7)}?`} description={lock && lock.month.slice(0, 7) >= new Date(Date.now() - 31 * 86_400_000).toISOString().slice(0, 7) ? 'Closing stock will be valued as it stands now and posted on the last day of the month.' : 'Earlier months are locked without a stock valuation (stock can only be valued as it stands today).'} confirmLabel="Lock month" loading={busy}
        onConfirm={async (note) => { setBusy(true); try { await api.post(`/finance/periods/${lock!.month}/lock`, { note: note || null }); setLock(null); invalidatePrefix(qc, 'fin-'); } catch (e) { toast({ tone: 'error', title: 'Could not lock', body: errMsg(e) }); } finally { setBusy(false); } }} />
      <ConfirmDialog open={!!reopen} onClose={() => setReopen(null)} title={`Reopen ${reopen?.month.slice(0, 7)}?`} description="A second person must approve. Reopening a month after returns are filed may need a revised return." requireReason tone="danger" confirmLabel="Request reopening" loading={busy}
        onConfirm={async (reason) => { setBusy(true); try { await api.post(`/finance/periods/${reopen!.month}/reopen`, { reason }); toast({ tone: 'success', title: 'Sent for approval' }); setReopen(null); } catch (e) { toast({ tone: 'error', title: 'Failed', body: errMsg(e) }); } finally { setBusy(false); } }} />
    </>
  );
}

// ---------------------------------------------------------------- anomalies
interface Anom { id: string; kind: string; severity: string; ref_type: string; ref_id: string; ref_label: string; message: string; amount: number | null; status: string; resolution: string | null; resolved_by_name: string | null; created_at: string }
export function AnomaliesPage() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const [status, setStatus] = useState('open');
  const q = useQuery({ queryKey: ['fin-anom', status], queryFn: () => api.get<Anom[]>(`/finance/anomalies?status=${status}`) });
  const [sel, setSel] = useState<Anom | null>(null);
  const [res, setRes] = useState('');
  return (
    <>
      <PageHeader title="Financial alerts" description="Duplicate supplier bills and payments, payments soon after a bank-detail change, unusual discounts, large credit notes and refunds, manual journals on sensitive accounts, unusual ledger movements and overdue TDS." breadcrumbs={[{ label: 'Finance', to: '/finance' }, { label: 'Alerts' }]} />
      <div className="mb-4"><Segmented value={status} onChange={setStatus} options={[{ value: 'open', label: 'Open' }, { value: 'resolved,dismissed', label: 'Closed' }]} /></div>
      <Card padded={false}>
        {!q.data ? <Skeleton className="m-5 h-40" /> : <SimpleTable rows={q.data} rowKey={(a) => a.id} onRowClick={(a) => { setSel(a); setRes(''); }} empty={<EmptyState icon={<ShieldAlert className="size-5" />} title="No alerts" />} columns={[
          { key: 's', header: '', width: '90px', render: (a) => <StatusBadge status={a.severity} /> },
          { key: 'm', header: 'Alert', render: (a) => <div><p>{a.message}</p><p className="text-[12px] text-slate-500">{humanize(a.kind)} · {a.ref_label}</p></div> },
          { key: 'a', header: 'Amount', align: 'right', render: (a) => fmtAmt(a.amount) },
          { key: 'd', header: 'Raised', render: (a) => fmtDateTime(a.created_at) },
          { key: 'r', header: status === 'open' ? '' : 'Outcome', render: (a) => (a.resolution ? <span className="text-[12.5px]">{a.resolution} — {a.resolved_by_name}</span> : a.ref_type === 'voucher' ? <Link className="link text-[12.5px]" to={`/finance/vouchers/${a.ref_id}`} onClick={(e) => e.stopPropagation()}>Open voucher</Link> : null) },
        ]} />}
      </Card>
      <Modal open={!!sel && sel.status === 'open'} onClose={() => setSel(null)} title="Close alert" description={sel?.message}
        footer={can('finance.anomaly.manage') ? <><Button onClick={() => setSel(null)}>Cancel</Button><Button disabled={res.trim().length < 3} onClick={async () => { await api.post(`/finance/anomalies/${sel!.id}/close`, { status: 'dismissed', resolution: res }); setSel(null); invalidatePrefix(qc, 'fin-'); }}>Dismiss (not a problem)</Button><Button variant="primary" disabled={res.trim().length < 3} onClick={async () => { await api.post(`/finance/anomalies/${sel!.id}/close`, { status: 'resolved', resolution: res }); setSel(null); invalidatePrefix(qc, 'fin-'); }}>Resolved</Button></> : undefined}>
        <KeyValue columns={1} items={[{ label: 'Type', value: humanize(sel?.kind ?? '') }, { label: 'Reference', value: sel?.ref_label ?? '' }, { label: 'Amount', value: fmtINR(sel?.amount) }]} />
        {can('finance.anomaly.manage') && <Textarea className="mt-3" label="What was found" required value={res} onChange={(e) => setRes(e.target.value)} />}
      </Modal>
    </>
  );
}
