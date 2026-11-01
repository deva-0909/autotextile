import { useQuery } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { HandCoins, LogOut, Plus, RefreshCw, UserPlus } from 'lucide-react';
import { useState } from 'react';
import { NavLink, useNavigate, useParams } from 'react-router-dom';
import { Link } from '../../components/AppLink';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { GST_STATES, fmtDate, fmtINR, fmtNum } from '../../lib/format';
import { SimpleTable } from '../../components/DataTable';
import { Modal, useToast } from '../../components/overlay';
import { useForm } from '../../components/form';
import { Avatar, Badge, Button, Card, ErrorState, Input, Notice, PageHeader, Select, Skeleton, Stat, StatusBadge, Tabs, Textarea } from '../../components/ui';

interface AgentRow { id: string; code: string; name: string; firm: string | null; mobile: string | null; city: string | null; basis: 'pct' | 'per_kg'; rate: number; status: string; leads: number; customers: number; pending: number; earned: number; paid: number }
interface Commission { id: string; customer_name: string; invoice_no: string; invoice_date: string; taxable: number; kg: number | null; amount: number; status: string; payout_number?: string | null }
type AgentLead = { id: string; number: string; name: string; company: string | null; stage: string; status: string; owner_name: string | null; est_value: number | null; created_at: string; agent_protected_until: string | null; customer_name: string | null };
type AgentCustomer = { customer_id: string; customer_name: string; from_date: string; until_date: string };
type AgentDetail = Omit<AgentRow, 'leads' | 'customers'> & { email: string | null; pan: string | null; party_id: string | null; state_code: string | null; leads: AgentLead[]; customers: AgentCustomer[];
  totals: { pending: number; earned: number; in_payout: number; paid: number };
  commissions: Commission[]; payouts: { id: string; number: string; amount: number; status: string; created_at: string; decided_by_name: string | null; comment: string | null }[] };

export const rateLabel = (a: { basis: string; rate: number }) => (a.basis === 'pct' ? `${a.rate}% of invoice value` : `₹${a.rate}/kg`);

export function AgentsPage() {
  const { can } = useAuth();
  const nav = useNavigate();
  const [modal, setModal] = useState(false);
  const q = useQuery({ queryKey: ['crm-agents'], queryFn: () => api.get<AgentRow[]>('/crm/agents') });
  if (q.isError) return <ErrorState error={q.error} />;
  return (
    <>
      <PageHeader title="Commission agents" description="Agents (dalals) who bring in buyers. A buyer an agent registers is protected for them; once the buyer becomes a customer, the agent earns commission on each invoice the customer pays. Payouts are approved and paid through payables with TDS."
        breadcrumbs={[{ label: 'Sales & CRM', to: '/crm' }, { label: 'Agents' }]}
        actions={can('crm.config.manage') && <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setModal(true)}>New agent</Button>} />
      {!q.data ? <Skeleton className="h-60" /> : (
        <Card padded={false}>
          <SimpleTable rows={q.data} rowKey={(r) => r.id} onRowClick={(r) => nav(`/crm/agents/${r.id}`)} empty="No agents yet" columns={[
            { key: 'n', header: 'Agent', render: (r) => <span className="flex items-center gap-2"><Avatar name={r.name} size="sm" /><span><span className="font-medium">{r.firm ?? r.name}</span><span className="block text-[12px] text-slate-500">{r.code} · {r.name}{r.city ? ` · ${r.city}` : ''}</span></span></span> },
            { key: 'r', header: 'Commission', render: (r) => rateLabel(r) },
            { key: 'l', header: 'Leads · customers', align: 'right', render: (r) => `${r.leads} · ${r.customers}` },
            { key: 'p', header: 'Waiting for payment', align: 'right', render: (r) => fmtINR(r.pending) },
            { key: 'e', header: 'Earned, to pay', align: 'right', render: (r) => <b>{fmtINR(r.earned)}</b> },
            { key: 'pd', header: 'Paid', align: 'right', render: (r) => fmtINR(r.paid) },
            { key: 's', header: 'Status', render: (r) => <StatusBadge status={r.status} /> },
          ]} />
        </Card>
      )}
      {modal && <AgentModal onClose={() => setModal(false)} onDone={(id) => nav(`/crm/agents/${id}`)} />}
    </>
  );
}

function AgentModal({ onClose, onDone, agent }: { onClose: () => void; onDone: (id: string) => void; agent?: AgentDetail }) {
  const f = useForm({ name: agent?.name ?? '', firm: agent?.firm ?? '', mobile: agent?.mobile ?? '', email: agent?.email ?? '', city: agent?.city ?? '', state_code: agent?.state_code ?? '', pan: agent?.pan ?? '', basis: agent?.basis ?? 'pct', rate: String(agent?.rate ?? '1'), status: agent?.status ?? 'active' });
  const [busy, setBusy] = useState(false);
  return (
    <Modal open onClose={onClose} size="lg" title={agent ? `Edit ${agent.code}` : 'New commission agent'} description={agent ? undefined : 'The agent is also added to Partners as a supplier-type party, so payouts go through payables and the payment run. Give them an agent-portal login in Security → Users (role “Commission Agent”, linked to this party).'}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} onClick={async () => {
        setBusy(true);
        try {
          const v = f.values;
          const body = { ...Object.fromEntries(Object.entries(v).map(([k, x]) => [k, x === '' ? null : x])), rate: Number(v.rate) };
          if (agent) { await api.put(`/crm/agents/${agent.id}`, body); onDone(agent.id); } else onDone((await api.post<{ id: string }>('/crm/agents', body)).id);
        } catch (e) { f.handleError(e); } finally { setBusy(false); }
      }}>{agent ? 'Save' : 'Add agent'}</Button></>}>
      <div className="grid grid-cols-2 gap-3">
        {f.formError && <div className="col-span-2"><Notice tone="danger">{f.formError}</Notice></div>}
        <Input label="Name" required {...f.bind('name')} />
        <Input label="Firm" {...f.bind('firm')} />
        <Input label="Mobile" {...f.bind('mobile')} />
        <Input label="Email" {...f.bind('email')} />
        <Input label="City" {...f.bind('city')} />
        <Select label="State" {...f.bind('state_code')} options={[{ value: '', label: 'From city' }, ...Object.entries(GST_STATES).map(([k, x]) => ({ value: k, label: x }))]} />
        <Input label="PAN" hint="For TDS under 194H" {...f.bind('pan')} />
        <Select label="Status" {...f.bind('status')} options={[{ value: 'active', label: 'Active' }, { value: 'inactive', label: 'Inactive' }]} />
        <Select label="Commission on" {...f.bind('basis')} options={[{ value: 'pct', label: 'Percentage of invoice value (before GST)' }, { value: 'per_kg', label: 'Rupees per kg invoiced' }]} />
        <Input label={f.values.basis === 'pct' ? 'Rate (%)' : 'Rate (₹ per kg)'} type="number" required {...f.bind('rate')} />
      </div>
    </Modal>
  );
}

export function AgentDetailPage() {
  const { id = '' } = useParams();
  const { can } = useAuth();
  const toast = useToast();
  const nav = useNavigate();
  const [tab, setTab] = useState<'commission' | 'leads' | 'customers'>('commission');
  const [modal, setModal] = useState<'edit' | 'payout' | null>(null);
  const q = useQuery({ queryKey: ['crm-agent', id], queryFn: () => api.get<AgentDetail>(`/crm/agents/${id}`) });
  if (q.isError) return <ErrorState error={q.error} />;
  const a = q.data;
  if (!a) return <Skeleton className="h-96" />;
  return (
    <>
      <PageHeader title={a.firm ?? a.name} description={`${a.code} · ${a.name} · ${rateLabel(a)}`} meta={<StatusBadge status={a.status} />}
        breadcrumbs={[{ label: 'Sales & CRM', to: '/crm' }, { label: 'Agents', to: '/crm/agents' }, { label: a.code }]}
        actions={<>
          <Button icon={<RefreshCw className="size-4" />} onClick={async () => { const r = await api.post<{ accrued: number; earned: number }>(`/crm/agents/${a.id}/sync`, {}); toast({ tone: 'success', title: `${r.accrued} new invoices, ${r.earned} now paid` }); q.refetch(); }}>Check invoices</Button>
          {can('crm.config.manage') && <Button onClick={() => setModal('edit')}>Edit</Button>}
          {can('crm.config.manage') && <Button variant="primary" icon={<HandCoins className="size-4" />} disabled={!a.totals.earned} onClick={() => setModal('payout')}>Pay earned commission</Button>}
        </>} />
      <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Waiting for the customer to pay" value={fmtINR(a.totals.pending)} />
        <Stat label="Earned, ready to pay" value={fmtINR(a.totals.earned)} tone="success" />
        <Stat label="Waiting for approval" value={fmtINR(a.totals.in_payout)} />
        <Stat label="Approved for payment" value={fmtINR(a.totals.paid)} />
      </div>
      <Tabs className="mb-4" value={tab} onChange={setTab} tabs={[{ value: 'commission', label: 'Commission', count: a.commissions.length }, { value: 'leads', label: 'Leads', count: a.leads.length }, { value: 'customers', label: 'Customers', count: a.customers.length }]} />
      {tab === 'commission' && (
        <div className="space-y-6">
          <Card padded={false} title="Commission by invoice" description="Accrues when the customer is invoiced; earned once that invoice is fully paid.">
            <SimpleTable rows={a.commissions} rowKey={(r) => r.id} empty="No invoices yet" columns={[
              { key: 'i', header: 'Invoice', render: (r) => <span className="font-mono text-[12.5px]">{r.invoice_no}</span> },
              { key: 'd', header: 'Date', render: (r) => fmtDate(r.invoice_date) },
              { key: 'c', header: 'Customer', render: (r) => r.customer_name },
              { key: 't', header: 'Value', align: 'right', render: (r) => fmtINR(r.taxable) },
              { key: 'k', header: 'Kg', align: 'right', render: (r) => fmtNum(r.kg) },
              { key: 'a', header: 'Commission', align: 'right', render: (r) => <b>{fmtINR(r.amount)}</b> },
              { key: 's', header: 'Status', render: (r) => <Badge tone={r.status === 'earned' ? 'success' : r.status === 'paid' ? 'neutral' : r.status === 'in_payout' ? 'info' : 'warning'}>{{ pending: 'Customer to pay', earned: 'Earned', in_payout: 'Awaiting approval', paid: 'Approved for payment', cancelled: 'Cancelled' }[r.status] ?? r.status}</Badge> },
              { key: 'p', header: 'Payout', render: (r) => r.payout_number ?? '—' },
            ]} />
          </Card>
          <Card padded={false} title="Payouts"><SimpleTable rows={a.payouts} rowKey={(r) => r.id} csv={false} empty="No payouts yet" columns={[
            { key: 'n', header: 'Payout', render: (r) => <span className="font-mono text-[12.5px]">{r.number}</span> },
            { key: 'd', header: 'Raised', render: (r) => fmtDate(r.created_at) },
            { key: 'a', header: 'Amount', align: 'right', render: (r) => fmtINR(r.amount) },
            { key: 's', header: 'Status', render: (r) => <StatusBadge status={r.status} /> },
            { key: 'b', header: 'Decided by', render: (r) => r.decided_by_name ?? '—' },
          ]} /></Card>
        </div>
      )}
      {tab === 'leads' && <Card padded={false}><SimpleTable rows={a.leads} rowKey={(r) => r.id} onRowClick={(r) => nav(`/crm/leads/${r.id}`)} columns={[
        { key: 'n', header: 'Lead', render: (r) => <span>{r.name}{r.company ? ` · ${r.company}` : ''}<span className="block font-mono text-[11.5px] text-slate-500">{r.number}</span></span> },
        { key: 's', header: 'Stage', render: (r) => <StatusBadge status={r.stage} /> },
        { key: 'o', header: 'Salesperson', render: (r) => r.owner_name ?? '—' },
        { key: 'v', header: 'Value', align: 'right', render: (r) => fmtINR(r.est_value) },
        { key: 'p', header: 'Protected until', render: (r) => fmtDate(r.agent_protected_until) },
        { key: 'c', header: 'Customer', render: (r) => r.customer_name ?? '—' },
      ]} /></Card>}
      {tab === 'customers' && <Card padded={false}><SimpleTable rows={a.customers} rowKey={(r) => r.customer_id} columns={[
        { key: 'c', header: 'Customer', render: (r) => <Link className="link" to={`/crm/customers/${r.customer_id}`}>{r.customer_name}</Link> },
        { key: 'f', header: 'Commission from', render: (r) => fmtDate(r.from_date) },
        { key: 'u', header: 'Until', render: (r) => fmtDate(r.until_date) },
      ]} /></Card>}
      {modal === 'edit' && <AgentModal agent={a} onClose={() => setModal(null)} onDone={() => { setModal(null); q.refetch(); }} />}
      {modal === 'payout' && <PayoutModal agentId={a.id} amount={a.totals.earned} onClose={() => setModal(null)} onDone={() => { setModal(null); q.refetch(); }} />}
    </>
  );
}

function PayoutModal({ agentId, amount, onClose, onDone }: { agentId: string; amount: number; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [note, setNote] = useState('');
  return (
    <Modal open onClose={onClose} title="Pay earned commission" footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={async () => {
      try { const r = await api.post<{ number: string; amount: number }>(`/crm/agents/${agentId}/payouts`, { note: note || null }); toast({ tone: 'success', title: `Payout ${r.number} sent for approval`, body: `${fmtINR(r.amount)} — once approved it is payable in Accounts (TDS 194H deducted).` }); onDone(); } catch (e) { toast({ tone: 'error', title: (e as Error).message }); }
    }}>Send for approval</Button></>}>
      <div className="space-y-3">
        <Notice tone="info">{fmtINR(amount)} of commission on invoices the customers have paid. The owner or the accounts manager approves it; Accounts then pays it in the normal payment run.</Notice>
        <Textarea label="Note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. October commission" />
      </div>
    </Modal>
  );
}

// ---------------- the agent's own portal ----------------
interface PortalData { agent: { code: string; name: string; firm: string | null; basis: string; rate: number }; protection_days: number; commission_months: number;
  leads: { id: string; number: string; name: string; company: string | null; stage: string; status: string; created_at: string; protected_until: string | null; customer: string | null; owner_name: string | null }[];
  customers: AgentCustomer[]; commissions: Commission[]; totals: { pending: number; earned: number; in_payout: number; paid: number } }

export function AgentPortalLayout({ children }: { children: React.ReactNode }) {
  const { user, signOut } = useAuth();
  const nav = useNavigate();
  return (
    <div className="min-h-screen bg-slate-50">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-6 px-4">
          <div className="flex items-center gap-2.5"><img src="/favicon.svg" alt="" className="size-7" /><div className="leading-tight"><p className="text-[13.5px] font-semibold">Agent portal</p><p className="text-[11px] text-slate-500">Demo Textile Trading Pvt Ltd</p></div></div>
          <nav className="flex gap-1">{[['/portal', 'My buyers'], ['/portal/commission', 'Commission']].map(([to, label]) => <NavLink key={to} to={to!} end className={({ isActive }) => clsx('rounded-md px-3 py-1.5 text-[13.5px]', isActive ? 'bg-brand-50 font-medium text-brand-700' : 'text-slate-600 hover:bg-slate-100')}>{label}</NavLink>)}</nav>
          <div className="ml-auto flex items-center gap-3"><Avatar name={user?.name ?? '?'} /><span className="hidden text-[13px] sm:block">{user?.name}</span>
            <Button size="sm" variant="ghost" icon={<LogOut className="size-4" />} onClick={() => void signOut().then(() => nav('/login'))}>Sign out</Button></div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-7">{children}</main>
    </div>
  );
}

const useAgentPortal = () => useQuery({ queryKey: ['agent-portal'], queryFn: () => api.get<PortalData>('/crm/portal/agent') });

export function AgentHome() {
  const q = useAgentPortal();
  const [modal, setModal] = useState(false);
  if (q.isError) return <ErrorState error={q.error} />;
  const d = q.data;
  if (!d) return <Skeleton className="h-96" />;
  return (
    <>
      <PageHeader title={`Welcome, ${d.agent.name}`} description={`Register a buyer here first: they are yours for ${d.protection_days} days, whichever way they contact us. Once they buy, you earn ${rateLabel(d.agent)} on every invoice they pay for ${d.commission_months} months.`}
        actions={<Button variant="primary" icon={<UserPlus className="size-4" />} onClick={() => setModal(true)}>Register a buyer</Button>} />
      <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Buyers registered" value={d.leads.length} />
        <Stat label="Became customers" value={d.customers.length} tone="success" />
        <Stat label="Commission earned" value={fmtINR(d.totals.earned + d.totals.in_payout + d.totals.paid)} />
        <Stat label="Waiting for the buyer to pay" value={fmtINR(d.totals.pending)} />
      </div>
      <Card padded={false} title="My buyers" description="Progress only; the sales team’s notes stay internal.">
        <SimpleTable rows={d.leads} rowKey={(r) => r.id} empty="No buyers registered yet" columns={[
          { key: 'n', header: 'Buyer', render: (r) => <span>{r.company ?? r.name}<span className="block text-[12px] text-slate-500">{r.name} · {r.number}</span></span> },
          { key: 'd', header: 'Registered', render: (r) => fmtDate(r.created_at) },
          { key: 's', header: 'Progress', render: (r) => <StatusBadge status={r.stage} /> },
          { key: 'o', header: 'Our salesperson', render: (r) => r.owner_name ?? 'Being assigned' },
          { key: 'p', header: 'Protected until', render: (r) => fmtDate(r.protected_until) },
          { key: 'c', header: 'Customer', render: (r) => (r.customer ? <Badge tone="success">{r.customer}</Badge> : '—') },
        ]} />
      </Card>
      {modal && <RegisterBuyer onClose={() => setModal(false)} onDone={() => { setModal(false); q.refetch(); }} />}
    </>
  );
}

function RegisterBuyer({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const f = useForm({ name: '', company: '', mobile: '', email: '', city: '', state_code: '', gstin: '', category: '', requirement_kg: '', est_value: '', message: '' });
  const [busy, setBusy] = useState(false);
  return (
    <Modal open onClose={onClose} size="lg" title="Register a buyer" description="We check the buyer is not already with us or with another agent."
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} onClick={async () => {
        setBusy(true);
        try {
          const v = f.values;
          const r = await api.post<{ number: string; protected_until: string }>('/crm/portal/agent/leads', Object.fromEntries(Object.entries(v).map(([k, x]) => [k, x === '' ? null : ['requirement_kg', 'est_value'].includes(k) ? Number(x) : x])));
          toast({ tone: 'success', title: `Registered as ${r.number}`, body: `Protected for you until ${fmtDate(r.protected_until)}.` }); onDone();
        } catch (e) { f.handleError(e); } finally { setBusy(false); }
      }}>Register</Button></>}>
      <div className="grid grid-cols-2 gap-3">
        {f.formError && <div className="col-span-2"><Notice tone="danger">{f.formError}</Notice></div>}
        <Input label="Contact name" required {...f.bind('name')} />
        <Input label="Company" {...f.bind('company')} />
        <Input label="Mobile" required {...f.bind('mobile')} />
        <Input label="Email" {...f.bind('email')} />
        <Input label="City" {...f.bind('city')} />
        <Select label="State" {...f.bind('state_code')} options={[{ value: '', label: 'From city' }, ...Object.entries(GST_STATES).map(([k, x]) => ({ value: k, label: x }))]} />
        <Input label="GSTIN" {...f.bind('gstin')} />
        <Input label="Fabric needed" placeholder="e.g. Single Jersey 160 GSM" {...f.bind('category')} />
        <Input label="Quantity (kg)" type="number" {...f.bind('requirement_kg')} />
        <Input label="Approximate order value" prefix="₹" type="number" {...f.bind('est_value')} />
        <Textarea className="col-span-2" label="Requirement" {...f.bind('message')} />
      </div>
    </Modal>
  );
}

export function AgentCommission() {
  const q = useAgentPortal();
  if (q.isError) return <ErrorState error={q.error} />;
  const d = q.data;
  if (!d) return <Skeleton className="h-96" />;
  return (
    <>
      <PageHeader title="My commission" description={`${rateLabel(d.agent)}. Commission is earned when the buyer pays the invoice; the company then pays it to you (TDS deducted under section 194H).`} />
      <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Waiting for the buyer to pay" value={fmtINR(d.totals.pending)} />
        <Stat label="Earned" value={fmtINR(d.totals.earned)} tone="success" />
        <Stat label="Being approved" value={fmtINR(d.totals.in_payout)} />
        <Stat label="Approved for payment" value={fmtINR(d.totals.paid)} />
      </div>
      <Card padded={false}><SimpleTable rows={d.commissions} rowKey={(r) => r.id} empty="No invoices yet" columns={[
        { key: 'i', header: 'Invoice', render: (r) => <span className="font-mono text-[12.5px]">{r.invoice_no}</span> },
        { key: 'd', header: 'Date', render: (r) => fmtDate(r.invoice_date) },
        { key: 'c', header: 'Buyer', render: (r) => r.customer_name },
        { key: 't', header: 'Invoice value', align: 'right', render: (r) => fmtINR(r.taxable) },
        { key: 'a', header: 'Commission', align: 'right', render: (r) => <b>{fmtINR(r.amount)}</b> },
        { key: 's', header: 'Status', render: (r) => <Badge tone={r.status === 'pending' ? 'warning' : 'success'}>{{ pending: 'Buyer to pay', earned: 'Earned', in_payout: 'Being approved', paid: 'Approved for payment', cancelled: 'Cancelled' }[r.status] ?? r.status}</Badge> },
      ]} /></Card>
    </>
  );
}

