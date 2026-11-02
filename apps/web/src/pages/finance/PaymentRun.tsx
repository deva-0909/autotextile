import { useQuery, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { AlertTriangle, Download, Send } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link } from '../../components/AppLink';
import { api, invalidatePrefix } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { fmtDate, fmtINR, fmtRelative } from '../../lib/format';
import { SimpleTable } from '../../components/DataTable';
import { useToast } from '../../components/overlay';
import { Badge, Button, Card, EmptyState, Input, Notice, PageHeader, Select, Skeleton, Stat } from '../../components/ui';

interface Candidate { party_id: string; party_name: string; doc_no: string; doc_date: string; due_date: string; outstanding: number; days_overdue: number; bank: { name: string; account: string; ifsc: string; bank_name: string | null } | null; bank_changed_recently: boolean; awaiting_approval: boolean; deductions_pending?: number; deductions_count?: number }
interface RunItem { party?: string; party_id?: string; invoice: string; amount?: number; voucher?: string; status: string; error?: string }
interface Run { id: string; number: string; total: number; released: number; items: RunItem[]; bank_file: string | null }
interface RunRow { id: string; number: string; run_date: string; mode: string; total: number; released: number; waiting: number; count: number; created_by_name: string; created_at: string }

const keyOf = (c: { party_id: string; doc_no: string }) => `${c.party_id}|${c.doc_no}`;

function downloadText(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/**
 * Pay several supplier bills in one go and download the bank's bulk-upload file. Each payment follows the same rules
 * as a single one: amounts above the approval limit, and payees whose bank details changed recently, wait for a checker
 * and stay out of the bank file until approved.
 */
export function PaymentRunPage() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const cands = useQuery({ queryKey: ['payrun-cands'], queryFn: () => api.get<Candidate[]>('/finance/payment-run/candidates') });
  const runs = useQuery({ queryKey: ['payrun-list'], queryFn: () => api.get<RunRow[]>('/finance/payment-runs') });
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [mode, setMode] = useState<'neft' | 'rtgs'>('neft');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Run | null>(null);
  const rows = cands.data ?? [];
  const payable = (c: Candidate) => !!c.bank && !c.awaiting_approval;
  const chosen = rows.filter((c) => picked.has(keyOf(c)));
  const sum = (xs: Candidate[]) => xs.reduce((s, c) => s + c.outstanding, 0);
  const overdue = rows.filter((c) => c.days_overdue > 0);
  const dueSoon = useMemo(() => rows.filter((c) => payable(c) && c.days_overdue >= -7), [rows]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = (c: Candidate) => { const n = new Set(picked); const k = keyOf(c); if (n.has(k)) n.delete(k); else n.add(k); setPicked(n); };
  const run = async () => {
    setBusy(true);
    try {
      const r = await api.post<Run>('/finance/payment-runs', { date, mode, items: chosen.map((c) => ({ party_id: c.party_id, invoice_number: c.doc_no })) });
      setResult(r);
      setPicked(new Set());
      invalidatePrefix(qc, '/finance');
      qc.invalidateQueries({ queryKey: ['payrun-cands'] });
      qc.invalidateQueries({ queryKey: ['payrun-list'] });
      toast({ tone: 'success', title: `${r.number}: ${fmtINR(r.released)} released`, body: r.released < r.total ? 'Some payments wait for a checker before they go into a bank file.' : 'Download the bank file and upload it in corporate banking.' });
    } catch (e) { toast({ tone: 'error', title: (e as Error).message }); } finally { setBusy(false); }
  };
  const download = async (id: string, number: string, text?: string | null) => {
    const file = text ?? (await api.get<Run>(`/finance/payment-runs/${id}`)).bank_file;
    if (file) downloadText(`${number.replace(/\//g, '-')}-bank-upload.csv`, file);
  };

  return (
    <>
      <PageHeader title="Supplier payment run" breadcrumbs={[{ label: 'Finance', to: '/finance' }, { label: 'Payment run' }]}
        description="Pick the bills to pay, pay them together, and upload one file to the bank. Large amounts and payees with recently changed bank details go to a checker first." />
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Owed to suppliers" value={fmtINR(sum(rows))} sub={`${rows.length} open bills`} />
        <Stat label="Overdue" value={fmtINR(sum(overdue))} sub={`${overdue.length} bills`} tone={overdue.length ? 'danger' : undefined} />
        <Stat label="Due within a week or overdue" value={fmtINR(sum(dueSoon))} sub={`${dueSoon.length} payable now`} />
        <Stat label="Selected" value={fmtINR(sum(chosen))} sub={`${chosen.length} bills`} tone={chosen.length ? 'success' : undefined} />
      </div>

      {result && (
        <Card className="mb-4" title={`${result.number} created`} description={`${fmtINR(result.released)} released of ${fmtINR(result.total)}${result.released < result.total ? '. Payments approved later join this run’s bank file; download it again after approval.' : ''}`}
          actions={<>{result.bank_file && <Button size="sm" variant="primary" icon={<Download className="size-4" />} onClick={() => void download(result.id, result.number, result.bank_file)}>Bank upload file</Button>}<Button size="sm" onClick={() => setResult(null)}>Close</Button></>} padded={false}>
          <SimpleTable rows={result.items} rowKey={(r) => `${r.invoice}${r.voucher ?? r.error}`} columns={[
            { key: 'p', header: 'Supplier', render: (r) => r.party ?? '—' },
            { key: 'i', header: 'Bill', render: (r) => <span className="font-mono text-[12.5px]">{r.invoice}</span> },
            { key: 'a', header: 'Amount', align: 'right', render: (r) => (r.amount ? fmtINR(r.amount) : '—') },
            { key: 's', header: 'Result', render: (r) => r.status === 'posted' ? <Badge tone="success">Paid · {r.voucher}</Badge> : r.status === 'pending_approval' ? <Badge tone="warning">Waiting for a checker · {r.voucher}</Badge> : <span className="text-[12.5px] text-rose-600">{r.error}</span> },
          ]} />
        </Card>
      )}

      <Card padded={false} title="Open supplier bills" description="Oldest due first. Bills already waiting for approval, and payees without an approved bank account, cannot be added."
        actions={can('finance.voucher.post') && <div className="flex flex-wrap items-end gap-2">
          <Button size="sm" variant="ghost" onClick={() => setPicked(new Set(dueSoon.map(keyOf)))} disabled={!dueSoon.length}>Select due and overdue</Button>
          <Input type="date" aria-label="Payment date" className="h-8 w-[150px]" value={date} max={new Date().toISOString().slice(0, 10)} onChange={(e) => setDate(e.target.value)} />
          <Select aria-label="Mode" className="h-8 w-[100px]" value={mode} onChange={(e) => setMode(e.target.value as 'neft' | 'rtgs')} options={[{ value: 'neft', label: 'NEFT' }, { value: 'rtgs', label: 'RTGS' }]} />
          <Button size="sm" variant="primary" icon={<Send className="size-4" />} loading={busy} disabled={!chosen.length} onClick={() => void run()}>Pay {chosen.length || ''} {chosen.length === 1 ? 'bill' : 'bills'}{chosen.length ? ` · ${fmtINR(sum(chosen))}` : ''}</Button>
        </div>}>
        {!cands.data ? <div className="p-4"><Skeleton className="h-48" /></div> : !rows.length ? <EmptyState title="Nothing owed to suppliers" description="Posted supplier invoices appear here until they are paid." /> : (
          <SimpleTable pageSize={20} rows={rows} rowKey={keyOf} onRowClick={(c) => payable(c) && toggle(c)} columns={[
            { key: 'x', header: '', width: '36px', render: (c) => <input type="checkbox" className="size-4 accent-brand-600" disabled={!payable(c)} checked={picked.has(keyOf(c))} onChange={() => toggle(c)} onClick={(e) => e.stopPropagation()} aria-label={`Pay ${c.doc_no}`} /> },
            { key: 'p', header: 'Supplier', render: (c) => <span className="font-medium text-slate-900">{c.party_name}</span> },
            { key: 'b', header: 'Bill', render: (c) => <span className="font-mono text-[12.5px]">{c.doc_no}</span> },
            { key: 'd', header: 'Dated', render: (c) => fmtDate(c.doc_date) },
            { key: 'due', header: 'Due', render: (c) => <span className={clsx(c.days_overdue > 0 && 'font-medium text-rose-600')}>{fmtDate(c.due_date)}{c.days_overdue > 0 && <span className="ml-1 text-[11.5px]">({c.days_overdue}d overdue)</span>}</span> },
            { key: 'o', header: 'Owed', align: 'right', render: (c) => <span className="tabular">{fmtINR(c.outstanding)}</span> },
            { key: 'bank', header: 'Pay to', render: (c) => c.bank ? <span className="text-[12.5px] text-slate-600">{c.bank.bank_name ?? c.bank.ifsc} {c.bank.account}</span> : <span className="text-[12.5px] text-rose-600">No approved bank account</span> },
            { key: 'f', header: '', render: (c) => <span className="flex gap-1">{c.awaiting_approval && <Badge tone="warning">Awaiting approval</Badge>}{!!c.deductions_pending && <Link to="/finance/mill-deductions" title="Claims and quarantine holds on this mill, already deducted from its balance: apply them to this bill"><Badge tone="warning">Mill deductions {fmtINR(c.deductions_pending)}</Badge></Link>}{c.bank_changed_recently && <Badge tone="danger"><AlertTriangle className="mr-1 inline size-3" />Bank changed</Badge>}</span> },
          ]} />
        )}
      </Card>

      {!!runs.data?.length && (
        <Card className="mt-4" title="Recent payment runs" padded={false}>
          <SimpleTable rows={runs.data} rowKey={(r) => r.id} columns={[
            { key: 'n', header: 'Run', render: (r) => <span className="font-mono text-[12.5px]">{r.number}</span> },
            { key: 'd', header: 'Date', render: (r) => fmtDate(r.run_date) },
            { key: 'c', header: 'Bills', align: 'right', render: (r) => r.count },
            { key: 't', header: 'Released', align: 'right', render: (r) => <span className="tabular">{fmtINR(r.released)} <span className="text-slate-400">of {fmtINR(r.total)}</span>{r.waiting > 0 && <span className="block text-[11.5px] text-amber-700">{r.waiting} waiting for a checker</span>}</span> },
            { key: 'by', header: 'By', render: (r) => <span className="text-[12.5px] text-slate-500">{r.created_by_name} · {fmtRelative(r.created_at)}</span> },
            { key: 'f', header: '', render: (r) => r.released > 0 && can('finance.voucher.post') && <Button size="xs" variant="ghost" icon={<Download className="size-3" />} onClick={() => void download(r.id, r.number)}>Bank file</Button> },
          ]} />
        </Card>
      )}
      {!can('finance.voucher.post') && <div className="mt-4"><Notice tone="info">You can see the bills; paying them needs the right to post vouchers.</Notice></div>}
    </>
  );
}
