import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, invalidatePrefix } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { fmtDate, fmtINR } from '../../lib/format';
import { SimpleTable } from '../../components/DataTable';
import { Modal, useToast } from '../../components/overlay';
import { Badge, Button, Card, Input, Notice, PageHeader, Segmented, Select, Skeleton, Stat } from '../../components/ui';

interface Deduction {
  id: string; mill_id: string; mill_name: string; kind: string; ref: string; job_ref: string | null; reason: string | null; state: 'held' | 'confirmed' | 'released';
  held_amount: number; confirmed_amount: number; amount: number; applied_bill_ref: string | null; applied_at: string | null; applied_by_name: string | null; created_at: string; age_days: number;
  history: { at: string; state: string; amount: number; voucher: string | null; note: string | null }[];
}
interface ByMill { mill_id: string; mill_name: string; count: number; held: number; confirmed: number }
const KIND: Record<string, string> = { quality_claim: 'Quality claim', shortage_claim: 'Shortage claim', quarantine: 'Wrong goods (quarantine)' };
const STATE: Record<string, [string, 'warning' | 'danger' | 'success' | 'neutral']> = { held: ['Held — being decided', 'warning'], confirmed: ['Debit note', 'danger'], released: ['Released', 'success'] };

/**
 * Everything held back or deducted from mills. Each item is already in the mill's ledger the moment it is raised, so
 * nothing depends on someone remembering it; this list is the check that every one is adjusted in a mill bill.
 */
export function MillDeductionsPage() {
  const { can } = useAuth();
  const [filter, setFilter] = useState<'pending' | 'applied' | 'released' | 'all'>('pending');
  const q = useQuery({ queryKey: ['mill-deductions', filter], queryFn: () => api.get<{ rows: Deduction[]; by_mill: ByMill[] }>(`/finance/mill-deductions?filter=${filter}`) });
  const [apply, setApply] = useState<Deduction | null>(null);
  const [view, setView] = useState<Deduction | null>(null);
  const bm = q.data?.by_mill ?? [];
  const held = bm.reduce((s, m) => s + m.held, 0), confirmed = bm.reduce((s, m) => s + m.confirmed, 0);
  return (
    <>
      <PageHeader title="Mill deductions" description="Claims on mills and the value of wrong goods held in quarantine. Each one is posted to the mill's ledger the moment it is raised, so it is held from payments; it stays on this list until it is adjusted in one of the mill's bills."
        breadcrumbs={[{ label: 'Accounts', to: '/finance' }, { label: 'Mill deductions' }]} />
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Held, being decided" value={fmtINR(held)} tone={held ? 'warning' : undefined} />
        <Stat label="Debit notes not yet applied" value={fmtINR(confirmed)} tone={confirmed ? 'danger' : undefined} />
        <Stat label="Mills with pending items" value={bm.length} />
        <Stat label="Items pending" value={bm.reduce((s, m) => s + m.count, 0)} />
      </div>
      {bm.length > 0 && (
        <Card title="Pending by mill" description="Deduct these before paying the mill." className="mb-4">
          <ul className="divide-y divide-slate-100 text-[13px]">{bm.map((m) => (
            <li key={m.mill_id} className="flex items-center justify-between py-2"><span className="font-medium">{m.mill_name}</span><span className="text-slate-600">{m.count} item(s) · held {fmtINR(m.held)} · debit notes {fmtINR(m.confirmed)} · <b>{fmtINR(m.held + m.confirmed)}</b></span></li>
          ))}</ul>
        </Card>
      )}
      <div className="mb-3"><Segmented value={filter} onChange={setFilter} options={[{ value: 'pending', label: 'Pending to apply' }, { value: 'applied', label: 'Applied to bills' }, { value: 'released', label: 'Released' }, { value: 'all', label: 'All' }]} /></div>
      {!q.data ? <Skeleton className="h-60" /> : (
        <Card padded={false}><SimpleTable rows={q.data.rows} rowKey={(r) => r.id} csvName="mill-deductions" empty="Nothing here" onRowClick={(r) => setView(r)} columns={[
          { key: 'd', header: 'Raised', render: (r) => <>{fmtDate(r.created_at)}{filter === 'pending' && r.age_days > 30 ? <Badge tone="danger" className="ml-1.5">{r.age_days} days</Badge> : null}</> },
          { key: 'm', header: 'Mill', render: (r) => r.mill_name },
          { key: 'k', header: 'What', render: (r) => <span className="text-[12.5px]"><b>{KIND[r.kind] ?? r.kind}</b> {r.ref}{r.job_ref ? ` · ${r.job_ref}` : ''}<span className="block text-slate-500">{r.reason}</span></span> },
          { key: 's', header: 'State', render: (r) => <Badge tone={STATE[r.state]![1]}>{STATE[r.state]![0]}</Badge> },
          { key: 'a', header: 'Amount', align: 'right', render: (r) => fmtINR(r.amount) },
          { key: 'b', header: 'Applied to bill', render: (r) => (r.applied_bill_ref ? <span className="text-[12.5px]">{r.applied_bill_ref}<span className="block text-slate-500">{r.applied_by_name}</span></span>
            : r.state !== 'released' && can('finance.voucher.post') ? <Button size="sm" onClick={(e) => { e.stopPropagation(); setApply(r); }}>Apply to bill</Button> : '—') },
        ]} /></Card>
      )}
      {apply && <ApplyModal d={apply} onClose={() => setApply(null)} />}
      {view && (
        <Modal open onClose={() => setView(null)} title={`${KIND[view.kind]} ${view.ref}`} description={view.mill_name} footer={<Button onClick={() => setView(null)}>Close</Button>}>
          <ol className="space-y-2 text-[12.5px]">{view.history.map((h, i) => (
            <li key={i} className="rounded border border-slate-200 p-2"><b>{STATE[h.state]?.[0] ?? h.state}</b> · {fmtINR(Number(h.amount))}{h.voucher ? ` · voucher ${h.voucher}` : ''}<span className="block text-slate-500">{fmtDate(h.at)}{h.note ? ` — ${h.note}` : ''}</span></li>
          ))}</ol>
        </Modal>
      )}
    </>
  );
}

function ApplyModal({ d, onClose }: { d: Deduction; onClose: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const bills = useQuery({ queryKey: ['mill-deduction-bills', d.id], queryFn: () => api.get<{ open: { doc_no: string; doc_date: string; outstanding: number }[]; recent: { doc_no: string; doc_date: string; amount: number }[] }>(`/finance/mill-deductions/${d.id}/bills`) });
  const [bill, setBill] = useState('');
  const [note, setNote] = useState('');
  const options = [...(bills.data?.open ?? []).map((b) => ({ value: b.doc_no, label: `${b.doc_no} · ${fmtDate(b.doc_date)} · ${fmtINR(b.outstanding)} open` })),
    ...(bills.data?.recent ?? []).filter((r) => !bills.data?.open.some((o) => o.doc_no === r.doc_no)).map((b) => ({ value: b.doc_no, label: `${b.doc_no} · ${fmtDate(b.doc_date)} · ${fmtINR(b.amount)}` }))];
  return (
    <Modal open onClose={onClose} title={`Apply ${d.ref} to a bill`} description={`${d.mill_name} · ${fmtINR(d.amount)}`}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!bill} onClick={async () => {
        try { await api.post(`/finance/mill-deductions/${d.id}/apply`, { bill_ref: bill, note: note || null }); invalidatePrefix(qc, 'mill-deductions'); toast({ tone: 'success', title: `Applied to ${bill}` }); onClose(); } catch (e) { toast({ tone: 'error', title: (e as Error).message }); }
      }}>Apply</Button></>}>
      <Notice tone="info">The amount is already deducted in the mill's ledger. This records which bill it was adjusted in, so the mill's statement and ours agree.</Notice>
      <div className="mt-3 space-y-3">
        <Select label="Mill bill" value={bill} onChange={(e) => setBill(e.target.value)} options={[{ value: '', label: bills.data ? (options.length ? 'Choose a bill' : 'No bills from this mill yet') : 'Loading…' }, ...options]} />
        <Input label="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
      </div>
    </Modal>
  );
}
