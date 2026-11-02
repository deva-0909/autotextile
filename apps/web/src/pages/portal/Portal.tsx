import { useQuery } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { CheckCircle2, ClipboardCheck, Factory, FileUp, LogOut, PackageCheck, ShieldAlert, Truck, XCircle } from 'lucide-react';
import { useRef, useState, type ReactNode } from 'react';
import { NavLink, useNavigate, useParams } from 'react-router-dom';
import { Link } from '../../components/AppLink';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { fmtDate, fmtDateTime, fmtINR, fmtNum, humanize } from '../../lib/format';
import { SimpleTable } from '../../components/DataTable';
import { Modal, useToast } from '../../components/overlay';
import { Avatar, Badge, Button, Card, EmptyState, ErrorState, Input, Notice, Skeleton, Stat, StatusBadge, Textarea, Timeline, BackButton } from '../../components/ui';
import { DispatchModal, ReceiptModal } from '../procurement/PurchaseOrders';
import { AckModal, Reconciliation, StageModal, StageTrack, type JobDetail } from '../jobwork/Orders';

export function PortalLayout({ children }: { children: ReactNode }) {
  const { user, can, signOut } = useAuth();
  const nav = useNavigate();
  const mill = can('portal.mill.access') && !can('portal.supplier.access');
  // Icon and label per page: on a phone only the icon shows (the label stays for screen readers), so the bar fits.
  const links: [string, string, typeof Factory][] = mill
    ? [['/portal', 'Overview', Factory], ['/portal/jobs', 'Job-work orders', ClipboardCheck], ['/portal/claims', 'Quality claims', ShieldAlert]]
    : [['/portal', 'Purchase orders', PackageCheck]];
  return (
    <div className="min-h-screen bg-slate-50">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-2 px-3 sm:gap-6 sm:px-4">
          <div className="flex shrink-0 items-center gap-2.5"><img src="/favicon.svg" alt="" className="size-7" /><div className="hidden leading-tight md:block"><p className="text-[13.5px] font-semibold">{mill ? 'Mill portal' : 'Supplier portal'}</p><p className="text-[11px] text-slate-500">Demo Textile Trading Pvt Ltd</p></div></div>
          <nav className="flex min-w-0 gap-1" aria-label={mill ? 'Mill portal' : 'Supplier portal'}>
            {links.map(([to, label, Icon]) => (
              <NavLink key={to} to={to} end aria-label={label} title={label}
                className={({ isActive }) => clsx('flex h-10 min-w-10 items-center justify-center gap-2 whitespace-nowrap rounded-md px-2.5 text-[13.5px] sm:px-3', isActive ? 'bg-brand-50 font-medium text-brand-700' : 'text-slate-600 hover:bg-slate-100')}>
                <Icon className="size-[18px] shrink-0 sm:hidden" aria-hidden /><span className="hidden sm:inline">{label}</span>
              </NavLink>
            ))}
          </nav>
          <div className="ml-auto flex shrink-0 items-center gap-2 sm:gap-3">
            <Avatar name={user?.name ?? '?'} /><span className="hidden text-[13px] lg:block">{user?.name}</span>
            <button type="button" aria-label="Sign out" title="Sign out" onClick={() => void signOut().then(() => nav('/login'))}
              className="flex h-10 min-w-10 items-center justify-center gap-2 rounded-md px-2.5 text-[13px] text-slate-600 hover:bg-slate-100 focus-visible:outline-2 focus-visible:outline-brand-500">
              <LogOut className="size-4" aria-hidden /><span className="hidden sm:inline">Sign out</span>
            </button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-7">{children}</main>
    </div>
  );
}

async function uploadFile(path: string, file: File) {
  return api.post(path, await file.arrayBuffer(), { 'Content-Type': file.type || 'application/pdf', 'X-File-Name': encodeURIComponent(file.name) });
}

function UploadButton({ label, path, onDone }: { label: string; path: string; onDone: () => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  return (
    <>
      <Button icon={<FileUp className="size-4" />} loading={busy} onClick={() => ref.current?.click()}>{label}</Button>
      <input ref={ref} type="file" accept=".pdf,.png,.jpg,.jpeg,.webp" className="hidden" onChange={async (e) => {
        const f = e.target.files?.[0];
        if (!f) return;
        setBusy(true);
        try { await uploadFile(path, f); toast({ tone: 'success', title: 'Invoice submitted', body: 'The buyer’s accounts team will review it.' }); onDone(); } catch (err) { toast({ tone: 'error', title: (err as Error).message }); } finally { setBusy(false); e.target.value = ''; }
      }} />
    </>
  );
}

// ---------- supplier ----------
interface SupplierPo { id: string; number: string; revision: number; order_date: string; expected_date: string; status: string; total_value: number; deliver_to_name: string; deliver_to_type: string; supplier_promise_date: string | null; ordered_kg: number; received_kg: number }

export function SupplierHome() {
  const nav = useNavigate();
  const summary = useQuery({ queryKey: ['sp-summary'], queryFn: () => api.get<{ awaiting_response: number; open_orders: number; outstanding: number; overdue: number }>('/procurement/portal/supplier/summary') });
  const pos = useQuery({ queryKey: ['sp-orders'], queryFn: () => api.get<SupplierPo[]>('/procurement/portal/supplier/orders') });
  return (
    <>
      <h1 className="mb-1 text-[22px] font-semibold">Purchase orders</h1>
      <p className="mb-6 text-[13.5px] text-slate-500">Accept orders and confirm delivery dates, record dispatches, and upload your tax invoices.</p>
      <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="Awaiting your response" value={summary.data?.awaiting_response ?? '—'} tone={summary.data?.awaiting_response ? 'warning' : undefined} />
        <Stat label="Open orders" value={summary.data?.open_orders ?? '—'} />
        <Stat label="Payable to you" value={fmtINR(summary.data?.outstanding)} />
        <Stat label="Overdue payments" value={fmtINR(summary.data?.overdue)} />
      </div>
      <Card padded={false}>
        {!pos.data ? <div className="p-5"><Skeleton className="h-32" /></div> : (
          <SimpleTable rows={pos.data} rowKey={(r) => r.id} onRowClick={(r) => nav(`/portal/orders/${r.id}`)} columns={[
            { key: 'n', header: 'PO', render: (r) => <span className="font-mono text-[12.5px] font-semibold">{r.number}{r.revision ? ` r${r.revision}` : ''}</span> },
            { key: 'd', header: 'Ordered', render: (r) => fmtDate(r.order_date) },
            { key: 'to', header: 'Deliver to', render: (r) => <span className="flex items-center gap-1.5">{r.deliver_to_type === 'mill' && <Badge tone="violet">Mill</Badge>}{r.deliver_to_name}</span> },
            { key: 'e', header: 'Required by', render: (r) => fmtDate(r.expected_date) },
            { key: 'kg', header: 'KG', align: 'right', render: (r) => `${fmtNum(r.received_kg)} / ${fmtNum(r.ordered_kg)}` },
            { key: 'v', header: 'Value', align: 'right', render: (r) => fmtINR(r.total_value) },
            { key: 's', header: 'Status', render: (r) => (r.status === 'sent' ? <Badge tone="warning" dot>Action needed</Badge> : <StatusBadge status={r.status} />) },
          ]} empty={<EmptyState title="No purchase orders yet" />} />
        )}
      </Card>
    </>
  );
}

export function SupplierOrder() {
  const { id = '' } = useParams();
  const toast = useToast();
  const q = useQuery({ queryKey: ['sp-order', id], queryFn: () => api.get<{ id: string; number: string; status: string; expected_date: string; deliver_to_name: string; deliver_to_type: string; notes: string | null; freight_terms: string | null; payment_term: string | null; total_value: number; taxable_value: number; tax_value: number; supplier_promise_date: string | null; lines: { id: string; sku: string; product_name: string; hsn_code: string; qty_kg: number; rate_per_kg: number; gst_rate: number; received_kg: number }[]; events: { id: number; event: string; detail: string | null; actor_name: string | null; at: string }[]; dispatches: { id: string; dispatch_date: string; kg: number; lr_number: string | null }[]; invoices: { id: string; invoice_number: string; total_value: number; status: string; payment_status: string; due_date: string }[] }>(`/procurement/portal/supplier/orders/${id}`) });
  const [modal, setModal] = useState<'accept' | 'reject' | 'dispatch' | null>(null);
  const [promise, setPromise] = useState('');
  const [remarks, setRemarks] = useState('');
  const respond = async (accept: boolean) => {
    try { await api.post(`/procurement/portal/supplier/orders/${id}/respond`, { accept, promise_date: accept ? promise : null, remarks: remarks || null }); setModal(null); q.refetch(); toast({ tone: 'success', title: accept ? 'Order accepted' : 'Order rejected' }); } catch (e) { toast({ tone: 'error', title: (e as Error).message }); }
  };
  if (q.isError) return <ErrorState error={q.error} />;
  if (!q.data) return <Skeleton className="h-96" />;
  const po = q.data;
  return (
    <>
      <p className="mb-1 text-[12.5px] text-slate-500"><Link to="/portal" className="hover:text-slate-800">Purchase orders</Link> / {po.number}</p>
      <div className="mb-6 flex flex-wrap items-center gap-3">
        <BackButton to="/portal/orders" />
        <h1 className="flex-1 text-[22px] font-semibold">{po.number} <StatusBadge status={po.status} /></h1>
        {po.status === 'sent' && <><Button variant="danger" icon={<XCircle className="size-4" />} onClick={() => setModal('reject')}>Reject</Button><Button variant="primary" icon={<CheckCircle2 className="size-4" />} onClick={() => { setPromise(po.expected_date); setModal('accept'); }}>Accept order</Button></>}
        {['sent', 'accepted', 'partially_received'].includes(po.status) && <Button icon={<Truck className="size-4" />} onClick={() => setModal('dispatch')}>Record dispatch</Button>}
        {['accepted', 'partially_received', 'received'].includes(po.status) && <UploadButton label="Upload tax invoice" path={`/procurement/portal/supplier/orders/${id}/invoice`} onDone={() => q.refetch()} />}
      </div>
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Card padded={false} title="Order lines" description={`Deliver to ${po.deliver_to_name} by ${fmtDate(po.expected_date)}`}>
            <SimpleTable rows={po.lines} rowKey={(l) => l.id} columns={[
              { key: 's', header: 'Fabric', render: (l) => <div><p className="font-mono text-[12.5px] font-semibold">{l.sku}</p><p className="text-[12px] text-slate-500">{l.product_name} · HSN {l.hsn_code}</p></div> },
              { key: 'q', header: 'KG', align: 'right', render: (l) => fmtNum(l.qty_kg) },
              { key: 'r', header: 'Rate', align: 'right', render: (l) => `₹${l.rate_per_kg}` },
              { key: 'g', header: 'GST', align: 'right', render: (l) => `${l.gst_rate}%` },
              { key: 'rc', header: 'Received', align: 'right', render: (l) => fmtNum(l.received_kg) },
            ]} />
            <div className="border-t border-slate-100 px-5 py-3 text-right text-[13px]">Taxable {fmtINR(po.taxable_value)} + GST {fmtINR(po.tax_value)} = <span className="font-semibold">{fmtINR(po.total_value)}</span></div>
          </Card>
          <Card title="Your invoices" padded={false}>
            {po.invoices.length ? <SimpleTable rows={po.invoices} rowKey={(i) => i.id} columns={[{ key: 'n', header: 'Invoice', render: (i) => <span className="font-mono">{i.invoice_number}</span> }, { key: 'v', header: 'Total', align: 'right', render: (i) => fmtINR(i.total_value) }, { key: 's', header: 'Status', render: (i) => <StatusBadge status={i.status === 'posted' ? (i.payment_status === 'approved' ? 'approved' : 'posted') : i.status} /> }, { key: 'd', header: 'Due', render: (i) => fmtDate(i.due_date) }]} />
              : <p className="px-5 py-4 text-[13px] text-slate-500">Uploaded invoices appear here once the buyer has reviewed them.</p>}
          </Card>
        </div>
        <div className="space-y-6">
          <Card title="Terms"><dl className="space-y-2 text-[13px]"><div><dt className="text-slate-500">Payment</dt><dd>{po.payment_term ?? '—'}</dd></div><div><dt className="text-slate-500">Freight</dt><dd>{po.freight_terms ?? '—'}</dd></div>{po.notes && <div><dt className="text-slate-500">Notes</dt><dd>{po.notes}</dd></div>}{po.supplier_promise_date && <div><dt className="text-slate-500">You promised delivery</dt><dd>{fmtDate(po.supplier_promise_date)}</dd></div>}</dl></Card>
          <Card title="Timeline"><Timeline items={[...po.events].reverse().map((e) => ({ id: e.id, title: humanize(e.event), detail: e.detail, meta: fmtDateTime(e.at) }))} /></Card>
        </div>
      </div>
      <Modal open={modal === 'accept'} onClose={() => setModal(null)} title={`Accept ${po.number}?`} footer={<><Button onClick={() => setModal(null)}>Cancel</Button><Button variant="primary" disabled={!promise} onClick={() => respond(true)}>Accept</Button></>}>
        <div className="space-y-3"><Input label="Delivery date you commit to" type="date" required value={promise} onChange={(e) => setPromise(e.target.value)} /><Textarea label="Remarks" value={remarks} onChange={(e) => setRemarks(e.target.value)} /></div>
      </Modal>
      <Modal open={modal === 'reject'} onClose={() => setModal(null)} title={`Reject ${po.number}?`} footer={<><Button onClick={() => setModal(null)}>Cancel</Button><Button variant="danger" disabled={!remarks.trim()} onClick={() => respond(false)}>Reject</Button></>}>
        <Textarea label="Reason" required value={remarks} onChange={(e) => setRemarks(e.target.value)} placeholder="e.g. rate not workable, capacity full until…" />
      </Modal>
      {modal === 'dispatch' && <DispatchModal onClose={() => setModal(null)} onSubmit={async (b) => { try { await api.post(`/procurement/portal/supplier/orders/${id}/dispatches`, b); setModal(null); q.refetch(); toast({ tone: 'success', title: 'Dispatch recorded' }); } catch (e) { toast({ tone: 'error', title: (e as Error).message }); } }} />}
    </>
  );
}

// ---------- mill ----------
interface Incoming { id: string; number: string; supplier_name: string; expected_date: string; status: string; lines: { id: string; sku: string; product_name: string; qty_kg: number; received_kg: number }[]; dispatches: { dispatch_date: string; kg: number; lr_number: string | null }[] | null }
interface MillJob { id: string; number: string; process_name: string; status: string; issue_date: string; expected_return_date: string; kg_sent: number; ack_kg: number | null; current_stage: string | null; kg_balance: number }

export function MillHome() {
  const nav = useNavigate();
  const toast = useToast();
  const s = useQuery({ queryKey: ['mp-summary'], queryFn: () => api.get<{ awaiting_ack: number; in_process: number; ready: number; kg_with_you: number; open_claims: number }>('/jobwork/portal/mill/summary') });
  const incoming = useQuery({ queryKey: ['mp-incoming'], queryFn: () => api.get<Incoming[]>('/procurement/portal/mill/incoming') });
  const jobs = useQuery({ queryKey: ['mp-jobs'], queryFn: () => api.get<MillJob[]>('/jobwork/portal/mill/jobs') });
  const [receive, setReceive] = useState<Incoming | null>(null);
  const pending = incoming.data?.filter((p) => p.status !== 'received') ?? [];
  return (
    <>
      <h1 className="mb-1 text-[22px] font-semibold">Mill overview</h1>
      <p className="mb-6 text-[13.5px] text-slate-500">Confirm fabric you receive, update processing stages and mark lots ready for collection. Your confirmations here are the official record.</p>
      <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-5">
        <Stat label="Challans to acknowledge" value={s.data?.awaiting_ack ?? '—'} tone={s.data?.awaiting_ack ? 'warning' : undefined} />
        <Stat label="In process" value={s.data?.in_process ?? '—'} />
        <Stat label="Ready for collection" value={s.data?.ready ?? '—'} tone="success" />
        <Stat label="Fabric with you" value={fmtNum(s.data?.kg_with_you, 'kg')} />
        <Stat label="Open quality claims" value={s.data?.open_claims ?? '—'} tone={s.data?.open_claims ? 'danger' : undefined} />
      </div>
      <div className="space-y-6">
        <Card title="Grey fabric coming from suppliers" description="Direct deliveries ordered by the trader. Weigh and confirm on arrival." padded={false}>
          {pending.length ? (
            <ul className="divide-y divide-slate-100">
              {pending.map((p) => (
                <li key={p.id} className="flex flex-wrap items-center gap-4 px-5 py-3.5">
                  <div className="min-w-0 flex-1"><p className="text-[13.5px] font-medium"><span className="font-mono">{p.number}</span> · {p.supplier_name}</p><p className="text-[12.5px] text-slate-500">{p.lines.map((l) => `${l.sku} ${fmtNum(l.qty_kg)} kg`).join(', ')} · expected {fmtDate(p.expected_date)}{p.dispatches?.length ? ` · dispatched ${fmtDate(p.dispatches[p.dispatches.length - 1]!.dispatch_date)}` : ''}</p></div>
                  <StatusBadge status={p.status} />
                  <Button size="sm" variant="primary" icon={<PackageCheck className="size-3.5" />} onClick={() => setReceive(p)}>Confirm receipt</Button>
                </li>
              ))}
            </ul>
          ) : <EmptyState icon={<Truck className="size-5" />} title="No incoming grey fabric" />}
        </Card>
        <Card title="Job-work orders" padded={false} actions={<Link className="link inline-block py-1 text-[12.5px]" to="/portal/jobs">All orders</Link>}>
          <SimpleTable rows={(jobs.data ?? []).filter((j) => !['closed', 'returned'].includes(j.status)).slice(0, 8)} rowKey={(j) => j.id} onRowClick={(j) => nav(`/portal/jobs/${j.id}`)} columns={[
            { key: 'n', header: 'Challan', render: (j) => <span className="font-mono text-[12.5px] font-semibold">{j.number}</span> },
            { key: 'p', header: 'Process', render: (j) => j.process_name },
            { key: 'kg', header: 'KG', align: 'right', render: (j) => fmtNum(j.kg_sent) },
            { key: 'st', header: 'Stage', render: (j) => j.current_stage ?? '—' },
            { key: 'r', header: 'Return by', render: (j) => fmtDate(j.expected_return_date) },
            { key: 's', header: 'Status', render: (j) => (j.status === 'issued' ? <Badge tone="warning" dot>Acknowledge</Badge> : <StatusBadge status={j.status} />) },
          ]} empty={<EmptyState title="No open job-work orders" />} />
        </Card>
      </div>
      {receive && <ReceiptModal portal po={{ id: receive.id, number: receive.number, lines: receive.lines as never }} onClose={() => setReceive(null)} onSaved={() => { setReceive(null); incoming.refetch(); toast({ tone: 'success', title: 'Receipt confirmed' }); }} />}
    </>
  );
}

export function MillJobs() {
  const nav = useNavigate();
  const jobs = useQuery({ queryKey: ['mp-jobs'], queryFn: () => api.get<MillJob[]>('/jobwork/portal/mill/jobs') });
  return (
    <>
      <h1 className="mb-6 text-[22px] font-semibold">Job-work orders</h1>
      <Card padded={false}>
        <SimpleTable rows={jobs.data ?? []} rowKey={(j) => j.id} onRowClick={(j) => nav(`/portal/jobs/${j.id}`)} columns={[
          { key: 'n', header: 'Challan', render: (j) => <span className="font-mono text-[12.5px] font-semibold">{j.number}</span> },
          { key: 'p', header: 'Process', render: (j) => j.process_name },
          { key: 'i', header: 'Issued', render: (j) => fmtDate(j.issue_date) },
          { key: 'kg', header: 'Sent / acknowledged', align: 'right', render: (j) => `${fmtNum(j.kg_sent)} / ${fmtNum(j.ack_kg)}` },
          { key: 'st', header: 'Stage', render: (j) => j.current_stage ?? '—' },
          { key: 's', header: 'Status', render: (j) => <StatusBadge status={j.status} /> },
        ]} empty={<EmptyState title="No job-work orders" />} />
      </Card>
    </>
  );
}

export function MillJob() {
  const { id = '' } = useParams();
  const toast = useToast();
  const q = useQuery({ queryKey: ['mp-job', id], queryFn: () => api.get<JobDetail>(`/jobwork/portal/mill/jobs/${id}`) });
  const [modal, setModal] = useState<'ack' | 'stage' | 'ready' | null>(null);
  const [note, setNote] = useState('');
  const act = async (path: string, body: object, msg: string) => {
    try { await api.post(`/jobwork/portal/mill/jobs/${id}/${path}`, body); setModal(null); q.refetch(); toast({ tone: 'success', title: msg }); } catch (e) { toast({ tone: 'error', title: (e as Error).message }); }
  };
  if (q.isError) return <ErrorState error={q.error} />;
  if (!q.data) return <Skeleton className="h-96" />;
  const o = q.data;
  return (
    <>
      <p className="mb-1 text-[12.5px] text-slate-500"><Link to="/portal/jobs" className="hover:text-slate-800">Job-work orders</Link> / {o.number}</p>
      <div className="mb-6 flex flex-wrap items-center gap-3">
        <BackButton to="/portal/jobs" />
        <h1 className="flex-1 text-[22px] font-semibold">{o.number} · {o.process_name} <StatusBadge status={o.status} /></h1>
        {o.status === 'issued' && <Button variant="primary" icon={<ClipboardCheck className="size-4" />} onClick={() => setModal('ack')}>Acknowledge receipt</Button>}
        {['acknowledged', 'in_process'].includes(o.status) && <><Button icon={<Factory className="size-4" />} onClick={() => setModal('stage')}>Update stage</Button><Button variant="primary" icon={<PackageCheck className="size-4" />} onClick={() => setModal('ready')}>Ready for collection</Button></>}
        {['ready', 'partially_returned', 'returned', 'closed'].includes(o.status) && <UploadButton label="Upload job-work invoice" path={`/jobwork/portal/mill/jobs/${id}/invoice`} onDone={() => q.refetch()} />}
      </div>
      {o.status === 'issued' && <div className="mb-5"><Notice tone="warning">Weigh the fabric when it arrives and acknowledge the quantity. Report any shortfall here.</Notice></div>}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Card title="Stages"><StageTrack stages={o.stages} updates={o.stage_updates} current={o.current_stage} /></Card>
          <Card title="Fabric" padded={false}>
            <SimpleTable rows={o.lines} rowKey={(l) => l.id} columns={[{ key: 's', header: 'Fabric', render: (l) => <span className="font-mono text-[12.5px] font-semibold">{l.sku}</span> }, { key: 'lot', header: 'Lot', render: (l) => l.lot_ref ?? '—' }, { key: 'r', header: 'Rolls', align: 'right', render: (l) => l.rolls ?? '—' }, { key: 'k', header: 'KG', align: 'right', render: (l) => fmtNum(l.kg_sent) }]} />
          </Card>
          {o.returns.length > 0 && <Card title="Returned to trader"><Reconciliation r={o.reconciliation} /></Card>}
        </div>
        <div className="space-y-6">
          <Card title="Instructions"><p className="text-[13px] text-slate-700">{o.instructions ?? 'None'}</p><p className="mt-3 text-[12.5px] text-slate-500">Return by {fmtDate(o.expected_return_date)}</p></Card>
          <Card title="Updates"><Timeline items={[...o.stage_updates].reverse().map((u) => ({ id: u.id, title: `${u.stage_name} · ${u.status.replace('_', ' ')}`, detail: u.note, meta: `${u.by_name} · ${fmtDateTime(u.at)}`, tone: u.status === 'qc_failed' ? 'danger' : 'brand' }))} /></Card>
        </div>
      </div>
      {modal === 'ack' && <AckModal kgSent={o.kg_sent} onClose={() => setModal(null)} onSubmit={(b) => act('acknowledge', b, 'Receipt acknowledged')} />}
      {modal === 'stage' && <StageModal stages={o.stages} onClose={() => setModal(null)} onSubmit={(b) => act('stages', b, 'Stage updated')} />}
      <Modal open={modal === 'ready'} onClose={() => setModal(null)} title="Ready for collection?" footer={<><Button onClick={() => setModal(null)}>Cancel</Button><Button variant="primary" onClick={() => act('ready', { note: note || null }, 'Marked ready')}>Confirm</Button></>}>
        <Textarea label="Note for the trader" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Packing, roll count, pickup timing…" />
      </Modal>
    </>
  );
}

export function MillClaims() {
  const toast = useToast();
  const q = useQuery({ queryKey: ['mp-claims'], queryFn: () => api.get<{ id: string; number: string; job_number: string; status: string; defect_types: string[]; description: string; kg_affected: number; claim_type: string; amount: number; mill_response: string | null; resolution: string | null; created_at: string }[]>('/jobwork/portal/mill/claims') });
  const [respond, setRespond] = useState<string | null>(null);
  const [text, setText] = useState('');
  return (
    <>
      <h1 className="mb-6 text-[22px] font-semibold">Quality claims</h1>
      <div className="space-y-4">
        {q.data?.length === 0 && <Card><EmptyState icon={<ShieldAlert className="size-5" />} title="No quality claims" /></Card>}
        {q.data?.map((c) => (
          <Card key={c.id} title={<span className="flex items-center gap-2"><span className="font-mono">{c.number}</span> on {c.job_number} <StatusBadge status={c.status} /></span>} description={`${fmtNum(c.kg_affected)} kg affected · ${humanize(c.claim_type)}${c.amount ? ` · ${fmtINR(c.amount)}` : ''} · raised ${fmtDate(c.created_at)}`}
            actions={['open', 'under_review'].includes(c.status) && <Button size="sm" onClick={() => { setRespond(c.id); setText(c.mill_response ?? ''); }}>{c.mill_response ? 'Edit response' : 'Respond'}</Button>}>
            <div className="mb-2 flex flex-wrap gap-1">{c.defect_types.map((t) => <Badge key={t} tone="danger">{t}</Badge>)}</div>
            <p className="text-[13px] text-slate-700">{c.description}</p>
            {c.mill_response && <p className="mt-3 rounded-lg bg-sky-50 px-3 py-2 text-[13px] text-sky-900">Your response: {c.mill_response}</p>}
            {c.resolution && <p className="mt-2 text-[13px] text-slate-600">Resolution: {c.resolution}</p>}
          </Card>
        ))}
      </div>
      <Modal open={!!respond} onClose={() => setRespond(null)} title="Respond to claim" footer={<><Button onClick={() => setRespond(null)}>Cancel</Button><Button variant="primary" disabled={text.trim().length < 3} onClick={async () => { await api.post(`/jobwork/portal/mill/claims/${respond}/respond`, { response: text }); setRespond(null); q.refetch(); toast({ tone: 'success', title: 'Response sent' }); }}>Send</Button></>}>
        <Textarea label="Your response" rows={5} value={text} onChange={(e) => setText(e.target.value)} placeholder="Root cause from your side, corrective action, rework offer…" />
      </Modal>
    </>
  );
}
