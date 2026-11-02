import { useQuery } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { ArrowRight, Ban, CalendarClock, Clock, Copy, FileText, Inbox, Plus, Target, TrendingUp, UserX } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Link } from '../../components/AppLink';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { GST_STATES, fmtDate, fmtDateTime, fmtINR, fmtNum, fmtRelative, humanize } from '../../lib/format';
import { SimpleTable } from '../../components/DataTable';
import { ConfirmDialog, Modal, useToast } from '../../components/overlay';
import { Bar } from '../../components/scan';
import { useParties } from '../../components/business';
import { Avatar, Badge, Button, Card, EmptyState, ErrorState, Input, KeyValue, Notice, PageHeader, Select, Skeleton, Stat, StatusBadge, Textarea, Timeline } from '../../components/ui';
import { CreditCard } from './Quotations';
import { STAGES } from './Leads';

// ---------- Sales dashboard ----------
interface Dash { leads_today: number; open_leads: number; unassigned: number; followups_due: number; possible_duplicates: number; quotes_pending_approval: number; quotes_open_value: number; won_this_month: number; avg_first_response_min: number | null; credit_pending: number; stages: { stage: string; n: number; value: number }[]; sources: { source_code: string; n: number; converted: number }[] }
interface Ex { id: string; kind: string; severity: string; message: string; ref_type: string; ref_id: string; detected_at: string }

export function CrmDashboard() {
  const { can } = useAuth();
  const d = useQuery({ queryKey: ['crm-dash'], queryFn: () => api.get<Dash>('/crm/dashboard') });
  const ex = useQuery({ queryKey: ['crm-exceptions'], queryFn: () => api.get<Ex[]>('/crm/exceptions') });
  const v = d.data;
  const pipe = ['new', 'assigned', 'contacted', 'qualified', 'quotation', 'negotiation', 'order_confirmed'];
  const maxStage = Math.max(1, ...(v?.stages.filter((s) => pipe.includes(s.stage)).map((s) => s.n) ?? [1]));
  return (
    <>
      <PageHeader title="Sales" description={can('crm.lead.read_all') ? 'Team pipeline, follow-ups and approvals.' : 'Your pipeline, follow-ups and quotations.'} breadcrumbs={[{ label: 'Sales & CRM' }]}
        actions={<Link to="/crm/leads"><Button variant="primary" icon={<Inbox className="size-4" />}>Lead inbox</Button></Link>} />
      <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-6">
        <Stat label="New leads today" value={v?.leads_today ?? '—'} />
        <Stat label="Open leads" value={v?.open_leads ?? '—'} sub={v?.unassigned ? `${v.unassigned} unassigned` : undefined} />
        <Stat label="Follow-ups due" value={v?.followups_due ?? '—'} tone={v?.followups_due ? 'danger' : undefined} />
        <Stat label="Avg first response" value={v?.avg_first_response_min != null ? `${v.avg_first_response_min} min` : '—'} sub="Last 30 days" />
        <Stat label="Open quotations" value={fmtINR(v?.quotes_open_value)} sub={v?.quotes_pending_approval ? `${v.quotes_pending_approval} awaiting price approval` : undefined} />
        <Stat label="Won this month" value={fmtINR(v?.won_this_month)} tone="success" />
      </div>
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
        <Card title="Pipeline" className="xl:col-span-2">
          <div className="space-y-2.5">
            {pipe.map((s) => {
              const row = v?.stages.find((x) => x.stage === s);
              return (
                <Link key={s} to={`/crm/leads`} className="grid grid-cols-[140px_1fr_120px] items-center gap-3 text-[13px] hover:opacity-80">
                  <span className="text-slate-700">{humanize(s)}</span>
                  <Bar value={row?.n ?? 0} max={maxStage} />
                  <span className="text-right tabular"><b>{row?.n ?? 0}</b> · {fmtINR(row?.value ?? 0)}</span>
                </Link>
              );
            })}
            <p className="pt-2 text-[12px] text-slate-500">Closed: {v?.stages.filter((s) => ['won', 'lost', 'nurture'].includes(s.stage)).map((s) => `${humanize(s.stage)} ${s.n}`).join(' · ') || '—'}</p>
          </div>
        </Card>
        <Card title="Needs attention" padded={false}>
          <ul className="divide-y divide-slate-100 text-[13.5px]">
            {[
              { icon: <CalendarClock className="size-4" />, label: 'Follow-ups due', n: v?.followups_due, to: '/crm/leads' },
              ...(can('crm.lead.read_all') ? [{ icon: <UserX className="size-4" />, label: 'Unassigned leads', n: v?.unassigned, to: '/crm/leads' }] : []),
              { icon: <Copy className="size-4" />, label: 'Possible duplicates', n: v?.possible_duplicates, to: '/crm/leads' },
              { icon: <FileText className="size-4" />, label: 'Quotes awaiting price approval', n: v?.quotes_pending_approval, to: '/crm/price-approvals' },
              { icon: <Ban className="size-4" />, label: 'Credit applications pending', n: v?.credit_pending, to: '/crm/credit' },
            ].map((x) => <li key={x.label}><Link to={x.to} className="flex items-center gap-3 px-5 py-3 hover:bg-slate-50"><span className="text-slate-400">{x.icon}</span><span className="flex-1">{x.label}</span><span className={clsx('font-semibold tabular', x.n ? 'text-slate-900' : 'text-slate-400')}>{x.n ?? '—'}</span></Link></li>)}
          </ul>
        </Card>
        <Card title="Alerts" description="First-response breaches, overdue follow-ups, leads nobody could take" padded={false} className="xl:col-span-2">
          {ex.data?.length ? (
            <ul className="divide-y divide-slate-100">{ex.data.slice(0, 8).map((e) => (
              <li key={e.id}><Link to={e.ref_type === 'lead' ? `/crm/leads/${e.ref_id}` : '/crm/allocation?tab=sources'} className="flex items-center gap-3 px-5 py-3 hover:bg-slate-50"><StatusBadge status={e.severity} /><span className="min-w-0 flex-1"><span className="block truncate text-[13.5px]">{e.message}</span><span className="text-[12px] text-slate-500">{humanize(e.kind)} · {fmtRelative(e.detected_at)}</span></span><ArrowRight className="size-4 text-slate-300" /></Link></li>
            ))}</ul>
          ) : <EmptyState title="No alerts" />}
        </Card>
        <Card title="Lead sources (90 days)" padded={false}>
          <SimpleTable rows={v?.sources ?? []} rowKey={(r) => r.source_code} columns={[
            { key: 's', header: 'Source', render: (r) => r.source_code },
            { key: 'n', header: 'Leads', align: 'right', render: (r) => r.n },
            { key: 'c', header: 'Converted', align: 'right', render: (r) => `${r.converted} (${r.n ? Math.round((r.converted / r.n) * 100) : 0}%)` },
          ]} />
        </Card>
      </div>
    </>
  );
}

// ---------- Customers ----------
interface CustRow { id: string; code: string; legal_name: string; gstin: string | null; segment: string | null; state_code: string | null; leads: number; open_leads: number; accepted: number; revenue: number; last_activity: string | null; credit: { mode: string; credit_limit: number; status: string } | null }
export function CustomersPage() {
  const nav = useNavigate();
  const [q, setQ] = useState('');
  const [dq, setDq] = useState('');
  useEffect(() => { const t = setTimeout(() => setDq(q), 250); return () => clearTimeout(t); }, [q]);
  const list = useQuery({ queryKey: ['crm-customers', dq], queryFn: () => api.get<CustRow[]>(`/crm/customers${dq ? `?q=${encodeURIComponent(dq)}` : ''}`) });
  return (
    <>
      <PageHeader title="Customers" description="Every account with its enquiries, orders, credit and salesperson. Open one for the 360° view." breadcrumbs={[{ label: 'Sales & CRM', to: '/crm' }, { label: 'Customers' }]} />
      <Card padded={false} actions={<input className="input h-8 w-64 text-[13px]" placeholder="Search customers…" value={q} onChange={(e) => setQ(e.target.value)} />} title="Accounts">
        {!list.data ? <Skeleton className="m-5 h-40" /> : (
          <SimpleTable rows={list.data} rowKey={(r) => r.id} onRowClick={(r) => nav(`/crm/customers/${r.id}`)} empty={<EmptyState title="No customers" />} columns={[
            { key: 'n', header: 'Customer', render: (r) => <div><p className="font-medium">{r.legal_name}</p><p className="font-mono text-[11.5px] text-slate-500">{r.code}{r.gstin ? ` · ${r.gstin}` : ''}</p></div> },
            { key: 's', header: 'Segment', render: (r) => r.segment ?? '—' },
            { key: 'st', header: 'State', render: (r) => (r.state_code ? GST_STATES[r.state_code] : '—') },
            { key: 'l', header: 'Leads', align: 'right', render: (r) => <span>{r.leads}{r.open_leads ? <span className="block text-[11.5px] text-slate-500">{r.open_leads} open</span> : null}</span> },
            { key: 'o', header: 'Orders', align: 'right', render: (r) => r.accepted },
            { key: 'r', header: 'Value', align: 'right', render: (r) => fmtINR(r.revenue) },
            { key: 'c', header: 'Terms', render: (r) => (r.credit?.status === 'blocked' ? <Badge tone="danger">Blocked</Badge> : r.credit?.mode === 'credit' ? <Badge tone="brand">Credit {fmtINR(Number(r.credit.credit_limit))}</Badge> : <Badge>Advance</Badge>) },
            { key: 'a', header: 'Last activity', render: (r) => <span className="text-[12.5px] text-slate-500">{r.last_activity ? fmtRelative(r.last_activity) : '—'}</span> },
          ]} />
        )}
      </Card>
    </>
  );
}

interface C360 {
  customer: { id: string; code: string; legal_name: string; gstin: string | null; state_code: string | null; phone: string | null; email: string | null; segment: string | null; payment_term: string | null; contacts: { id: string; name: string; designation: string | null; phone: string | null; email: string | null }[]; addresses: { id: string; kind: string; line1: string; city: string; pincode: string | null }[] };
  salesperson: string | null; value: { orders: number; revenue: number; kg: number; win_rate: number | null };
  leads: { id: string; number: string; source_code: string; stage: string; status: string; owner_name: string | null; est_value: number | null; created_at: string; lost_reason: string | null }[];
  quotations: { id: string; number: string; version: number; status: string; kg: number; total: number; margin_pct: number | null; owner_name: string; created_at: string; lost_reason: string | null; competitor_name: string | null; competitor_price: number | null }[];
  activities: { id: number; kind: string; summary: string; outcome: string | null; by_name: string | null; at: string; lead_number: string }[];
  preferences: { category: string | null; sku: string; product_name: string; kg_quoted: number; kg_bought: number | null; quotes: number }[];
  prices: { sku: string; requested_price: number; list_price: number | null; status: string; created_at: string }[];
  credit: { ok: boolean; mode: string; credit_limit: number; available: number; status: string; reason: string | null; exposure: { total: number; confirmed_orders: number; outstanding_invoices: number } };
  shade_decisions: { id: string; sku: string; shade_code: string; decision: string; note: string | null }[];
  reservations: { id: string; number: string; status: string; kg_reserved: number | null }[];
  pending: Record<string, string>;
}

export function Customer360Page() {
  const { id = '' } = useParams();
  const nav = useNavigate();
  const { can } = useAuth();
  const q = useQuery({ queryKey: ['crm-360', id], queryFn: () => api.get<C360>(`/crm/customers/${id}/360`) });
  if (q.isError) return <ErrorState error={q.error} />;
  const c = q.data;
  if (!c) return <Skeleton className="h-96" />;
  const cu = c.customer;
  return (
    <>
      <PageHeader title={cu.legal_name} description={<span className="font-mono">{cu.code}{cu.gstin ? ` · ${cu.gstin}` : ''}</span>} meta={<>{cu.segment && <Badge>{cu.segment}</Badge>}{c.credit.status === 'blocked' ? <Badge tone="danger">Credit blocked</Badge> : <Badge tone={c.credit.mode === 'credit' ? 'brand' : 'neutral'}>{c.credit.mode === 'credit' ? 'Credit' : 'Advance'}</Badge>}</>}
        breadcrumbs={[{ label: 'Sales & CRM', to: '/crm' }, { label: 'Customers', to: '/crm/customers' }, { label: cu.legal_name }]}
        actions={<>
          <Link to={`/partners/customer/${cu.id}`}><Button>Master record</Button></Link>
          {can('crm.quote.manage') && <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => nav(`/crm/quotations/new?customer=${cu.id}`)}>New quotation</Button>}
        </>} />
      <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-5">
        <Stat label="Orders confirmed" value={c.value.orders} />
        <Stat label="Order value" value={fmtINR(c.value.revenue)} tone="success" />
        <Stat label="Fabric bought" value={fmtNum(c.value.kg, 'kg')} />
        <Stat label="Win rate" value={c.value.win_rate === null ? '—' : `${c.value.win_rate}%`} sub="Of decided quotations" />
        <Stat label="Salesperson" value={<span className="text-[16px]">{c.salesperson ?? '—'}</span>} />
      </div>
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
        <div className="space-y-6 xl:col-span-2">
          <Card title="Quotations & orders" padded={false}>
            <SimpleTable rows={c.quotations} rowKey={(r) => r.id} onRowClick={(r) => nav(`/crm/quotations/${r.id}`)} empty={<EmptyState title="No quotations yet" />} columns={[
              { key: 'n', header: 'Quotation', render: (r) => <span className="font-mono text-[12.5px]">{r.number} v{r.version}</span> },
              { key: 'd', header: 'Date', render: (r) => fmtDate(r.created_at) },
              { key: 'k', header: 'KG', align: 'right', render: (r) => fmtNum(Number(r.kg)) },
              { key: 't', header: 'Total', align: 'right', render: (r) => fmtINR(Number(r.total)) },
              { key: 'm', header: 'Margin', align: 'right', render: (r) => (r.margin_pct === null ? '—' : `${r.margin_pct}%`) },
              { key: 's', header: 'Status', render: (r) => <div><StatusBadge status={r.status} />{r.lost_reason && <p className="mt-0.5 text-[11.5px] text-slate-500">{r.lost_reason}{r.competitor_price ? ` (₹${r.competitor_price})` : ''}</p>}</div> },
            ]} />
          </Card>
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <Card title="Fabric preferences" padded={false}>
              <SimpleTable rows={c.preferences} rowKey={(r) => r.sku} empty={<EmptyState title="No history" />} columns={[
                { key: 's', header: 'Fabric', render: (r) => <span className="font-mono text-[12.5px]">{r.sku}<span className="block font-sans text-slate-500">{r.category}</span></span> },
                { key: 'q', header: 'Quoted', align: 'right', render: (r) => fmtNum(r.kg_quoted) },
                { key: 'b', header: 'Bought', align: 'right', render: (r) => fmtNum(r.kg_bought ?? 0) },
              ]} />
            </Card>
            <Card title="Last prices" padded={false}>
              <SimpleTable rows={c.prices} rowKey={(r) => r.sku} empty={<EmptyState title="No prices quoted" />} columns={[
                { key: 's', header: 'Fabric', render: (r) => <span className="font-mono text-[12.5px]">{r.sku}</span> },
                { key: 'p', header: '₹ / kg', align: 'right', render: (r) => <span>₹{r.requested_price}{r.list_price && <span className="block text-[11.5px] text-slate-500">list ₹{r.list_price}</span>}</span> },
                { key: 'st', header: '', render: (r) => <StatusBadge status={r.status} /> },
              ]} />
            </Card>
          </div>
          <Card title="Timeline" description="Calls, visits, quotations and stage changes across all this customer’s enquiries">
            {c.activities.length ? <Timeline items={c.activities.map((a) => ({ id: a.id, title: a.summary, detail: a.outcome ?? undefined, meta: `${humanize(a.kind)} · ${a.lead_number} · ${a.by_name ?? 'system'} · ${fmtDateTime(a.at)}`, tone: a.kind === 'quotation' ? 'brand' : 'success' }))} /> : <EmptyState title="No activity yet" />}
          </Card>
        </div>
        <div className="space-y-6">
          <CreditCard credit={c.credit} customerId={cu.id} />
          <Card title="Contact">
            <KeyValue columns={1} items={[{ label: 'Phone', value: cu.phone }, { label: 'Email', value: cu.email }, { label: 'State', value: cu.state_code ? GST_STATES[cu.state_code] : null }, { label: 'Payment term', value: cu.payment_term }, ...cu.contacts.slice(0, 3).map((p) => ({ label: p.designation ?? 'Contact', value: `${p.name}${p.phone ? ` · ${p.phone}` : ''}` }))]} />
          </Card>
          <Card title="Enquiries" padded={false}>
            <ul className="divide-y divide-slate-100">{c.leads.map((l) => (
              <li key={l.id}><Link to={`/crm/leads/${l.id}`} className="flex items-center justify-between px-5 py-2.5 text-[13px] hover:bg-slate-50"><span><span className="font-mono text-[12px]">{l.number}</span><span className="block text-[12px] text-slate-500">{l.source_code} · {l.owner_name ?? 'unassigned'} · {fmtDate(l.created_at)}</span></span><StatusBadge status={l.status === 'merged' ? 'merged' : l.stage} /></Link></li>
            ))}{!c.leads.length && <li><EmptyState title="No enquiries" /></li>}</ul>
          </Card>
          {(c.shade_decisions.length > 0 || c.reservations.length > 0) && (
            <Card title="Stock & shades">
              {c.reservations.map((r) => <p key={r.id} className="text-[13px]"><span className="font-mono">{r.number}</span> · {fmtNum(r.kg_reserved ?? 0)} kg · <StatusBadge status={r.status} /></p>)}
              {c.shade_decisions.map((s) => <p key={s.id} className="mt-1 text-[13px]">{s.sku} shade {s.shade_code}: <Badge tone={s.decision === 'accepted' ? 'success' : 'danger'}>{humanize(s.decision)}</Badge></p>)}
            </Card>
          )}
          <Card title="Coming with later releases"><ul className="space-y-1.5 text-[12.5px] text-slate-500">{Object.values(c.pending).map((p) => <li key={p} className="flex gap-2"><Clock className="mt-0.5 size-3.5 shrink-0" />{p}</li>)}</ul></Card>
        </div>
      </div>
    </>
  );
}

// ---------- Credit ----------
interface Account { customer_id: string; customer_name: string; mode: string; credit_limit: number; credit_days: number; status: string; block_reason: string | null; approved_by_name: string | null; approved_at: string | null; exposure: number; available: number | null; utilisation_pct: number | null }
interface Application { id: string; number: string; kind: string; customer_id: string; customer_name: string; requested_mode: string | null; requested_limit: number | null; requested_days: number | null; override_amount: number | null; current_limit: number | null; exposure_at_request: number | null; justification: string; status: string; requested_by_name: string; decided_by_name: string | null; decided_at: string | null; comment: string | null; created_at: string; valid_until: string | null }

export function CreditPage() {
  const nav = useNavigate();
  const { can } = useAuth();
  const q = useQuery({ queryKey: ['crm-credit'], queryFn: () => api.get<{ accounts: Account[]; pending: Application[] }>('/crm/credit') });
  const [applying, setApplying] = useState(false);
  return (
    <>
      <PageHeader title="Customer credit" description="Customers buy on advance unless credit is approved. Limits, overrides and blocks go through a checker; exposure is confirmed orders plus outstanding invoices (from P8)."
        breadcrumbs={[{ label: 'Sales & CRM', to: '/crm' }, { label: 'Credit' }]} actions={can('crm.credit.request') && <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setApplying(true)}>Apply for credit</Button>} />
      {q.data?.pending.length ? (
        <Card className="mb-6" title={`Awaiting approval (${q.data.pending.length})`} padded={false} actions={<Link to="/approvals" className="link text-[12.5px]">Approvals inbox</Link>}>
          <SimpleTable rows={q.data.pending} rowKey={(r) => r.id} onRowClick={(r) => nav(`/crm/credit/${r.customer_id}`)} columns={[
            { key: 'n', header: 'Application', render: (r) => <span className="font-mono text-[12.5px]">{r.number}</span> },
            { key: 'c', header: 'Customer', render: (r) => r.customer_name },
            { key: 'r', header: 'Request', render: (r) => (r.kind === 'override' ? `One-time override ${fmtINR(Number(r.override_amount))}` : r.requested_mode === 'credit' ? `Credit ${fmtINR(Number(r.requested_limit))} · ${r.requested_days} days` : 'Advance only') },
            { key: 'b', header: 'By', render: (r) => <span className="text-[12.5px]">{r.requested_by_name}<span className="block text-slate-500">{fmtRelative(r.created_at)}</span></span> },
          ]} />
        </Card>
      ) : null}
      <Card title="Credit accounts" padded={false}>
        {!q.data ? <Skeleton className="m-5 h-40" /> : (
          <SimpleTable rows={q.data.accounts} rowKey={(r) => r.customer_id} onRowClick={(r) => nav(`/crm/credit/${r.customer_id}`)} empty={<EmptyState title="No approved credit yet" description="Every customer is on advance until credit is approved." />} columns={[
            { key: 'c', header: 'Customer', render: (r) => r.customer_name },
            { key: 'm', header: 'Terms', render: (r) => (r.status === 'blocked' ? <Badge tone="danger">Blocked</Badge> : r.mode === 'credit' ? `${fmtINR(Number(r.credit_limit))} · ${r.credit_days} days` : 'Advance') },
            { key: 'e', header: 'Exposure', align: 'right', render: (r) => fmtINR(r.exposure) },
            { key: 'a', header: 'Available', align: 'right', render: (r) => (r.available === null ? '—' : <span className={r.available < 0 ? 'font-semibold text-rose-600' : ''}>{fmtINR(r.available)}</span>) },
            { key: 'u', header: 'Utilisation', render: (r) => (r.utilisation_pct === null ? '—' : <div className="w-32"><div className="mb-1 text-[12px] tabular">{r.utilisation_pct}%</div><Bar value={r.utilisation_pct} max={100} tone={r.utilisation_pct > 90 ? 'danger' : r.utilisation_pct > 70 ? 'warning' : 'success'} /></div>) },
            { key: 'ap', header: 'Approved by', render: (r) => <span className="text-[12.5px]">{r.approved_by_name ?? '—'}</span> },
          ]} />
        )}
      </Card>
      {applying && <ApplyModal onClose={() => setApplying(false)} onDone={() => { setApplying(false); q.refetch(); }} />}
    </>
  );
}

function ApplyModal({ customerId, onClose, onDone }: { customerId?: string; onClose: () => void; onDone: () => void }) {
  const customers = useParties('customer');
  const toast = useToast();
  const [v, setV] = useState({ customer_id: customerId ?? '', requested_mode: 'credit', requested_limit: '', requested_days: '30', justification: '' });
  return (
    <Modal open onClose={onClose} title="Credit application" description="Takes effect only after a checker with credit approval rights approves it." footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={async () => {
      try { await api.post('/crm/credit/applications', { ...v, requested_limit: Number(v.requested_limit || 0), requested_days: Number(v.requested_days || 0) }); toast({ tone: 'success', title: 'Sent for approval' }); onDone(); } catch (e) { toast({ tone: 'error', title: (e as Error).message }); }
    }}>Submit</Button></>}>
      <div className="grid grid-cols-2 gap-3">
        <Select className="col-span-2" label="Customer" disabled={!!customerId} value={v.customer_id} onChange={(e) => setV({ ...v, customer_id: e.target.value })} options={[{ value: '', label: 'Choose…' }, ...(customers.data ?? []).map((c) => ({ value: c.id, label: c.legal_name }))]} />
        <Select label="Terms" value={v.requested_mode} onChange={(e) => setV({ ...v, requested_mode: e.target.value })} options={[{ value: 'credit', label: 'Credit' }, { value: 'advance', label: 'Advance only' }]} />
        {v.requested_mode === 'credit' && <><Input label="Credit limit" type="number" prefix="₹" value={v.requested_limit} onChange={(e) => setV({ ...v, requested_limit: e.target.value })} /><Input label="Credit days" type="number" value={v.requested_days} onChange={(e) => setV({ ...v, requested_days: e.target.value })} /></>}
        <Textarea className="col-span-2" label="Justification" required value={v.justification} onChange={(e) => setV({ ...v, justification: e.target.value })} placeholder="Trading history, references, security, expected volumes" />
      </div>
    </Modal>
  );
}

export function CreditDetailPage() {
  const { id = '' } = useParams();
  const [params] = useSearchParams();
  const { can } = useAuth();
  const toast = useToast();
  const q = useQuery({ queryKey: ['crm-credit', id], queryFn: () => api.get<{ customer: { id: string; code: string; legal_name: string; gstin: string | null; master_credit_limit: number | null; payment_term: string | null }; account: Account | null; applications: Application[]; check: C360['credit']; orders: { id: string; number: string; version: number; total: number; decided_at: string }[] }>(`/crm/credit/${id}`) });
  const [modal, setModal] = useState<'apply' | 'override' | 'block' | 'unblock' | null>(params.get('override') ? 'override' : null);
  const [ov, setOv] = useState({ amount: '', justification: '' });
  if (q.isError) return <ErrorState error={q.error} />;
  const d = q.data;
  if (!d) return <Skeleton className="h-96" />;
  const blocked = d.check.status === 'blocked';
  return (
    <>
      <PageHeader title={`Credit · ${d.customer.legal_name}`} description={<span className="font-mono">{d.customer.code}</span>} meta={blocked ? <Badge tone="danger">Blocked</Badge> : <Badge tone={d.check.mode === 'credit' ? 'brand' : 'neutral'}>{d.check.mode === 'credit' ? 'Credit' : 'Advance'}</Badge>}
        breadcrumbs={[{ label: 'Sales & CRM', to: '/crm' }, { label: 'Credit', to: '/crm/credit' }, { label: d.customer.legal_name }]}
        actions={<>
          <Link to={`/crm/customers/${id}`}><Button>Customer 360</Button></Link>
          {can('crm.credit.approve') && (blocked ? <Button onClick={() => setModal('unblock')}>Unblock</Button> : <Button variant="danger" icon={<Ban className="size-4" />} onClick={() => setModal('block')}>Block</Button>)}
          {can('crm.credit.request') && d.check.mode === 'credit' && !blocked && <Button onClick={() => setModal('override')}>Request override</Button>}
          {can('crm.credit.request') && <Button variant="primary" onClick={() => setModal('apply')}>{d.account ? 'Change limit' : 'Apply for credit'}</Button>}
        </>} />
      <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-5">
        <Stat label="Limit" value={d.check.mode === 'credit' ? fmtINR(d.check.credit_limit) : 'Advance'} sub={d.account?.credit_days ? `${d.account.credit_days} days` : undefined} />
        <Stat label="Confirmed orders" value={fmtINR(d.check.exposure.confirmed_orders)} />
        <Stat label="Outstanding invoices" value={fmtINR(d.check.exposure.outstanding_invoices)} sub="From accounts receivable (P8)" />
        <Stat label="Available" value={d.check.mode === 'credit' ? fmtINR(d.check.available) : '—'} tone={d.check.available < 0 ? 'danger' : undefined} />
        <Stat label="Master-data limit" value={fmtINR(d.customer.master_credit_limit)} sub={d.customer.payment_term ?? undefined} />
      </div>
      {blocked && <div className="mb-5"><Notice tone="danger" title="Credit blocked">{d.account?.block_reason}. New orders cannot be accepted until unblocked.</Notice></div>}
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
        <Card title="Applications, overrides and decisions" className="xl:col-span-2" padded={false}>
          <SimpleTable rows={d.applications} rowKey={(r) => r.id} empty={<EmptyState title="No applications" />} columns={[
            { key: 'n', header: 'Number', render: (r) => <span className="font-mono text-[12.5px]">{r.number}</span> },
            { key: 'r', header: 'Request', render: (r) => <span className="text-[13px]">{r.kind === 'override' ? `Override ${fmtINR(Number(r.override_amount))}${r.valid_until ? ` until ${fmtDate(r.valid_until)}` : ''}` : r.requested_mode === 'credit' ? `${fmtINR(Number(r.requested_limit))} · ${r.requested_days} days` : 'Advance only'}<span className="block text-[12px] text-slate-500">{r.justification}</span></span> },
            { key: 'b', header: 'Requested', render: (r) => <span className="text-[12.5px]">{r.requested_by_name}<span className="block text-slate-500">{fmtDate(r.created_at)}</span></span> },
            { key: 'd', header: 'Decision', render: (r) => <span className="text-[12.5px]"><StatusBadge status={r.status} />{r.decided_by_name && <span className="block text-slate-500">{r.decided_by_name}{r.comment ? `: ${r.comment}` : ''}</span>}</span> },
          ]} />
        </Card>
        <Card title="Confirmed orders" padded={false}>
          <ul className="divide-y divide-slate-100">{d.orders.map((o) => <li key={o.id}><Link className="flex justify-between px-5 py-2.5 text-[13px] hover:bg-slate-50" to={`/crm/quotations/${o.id}`}><span className="font-mono">{o.number} v{o.version}</span><span>{fmtINR(Number(o.total))}</span></Link></li>)}{!d.orders.length && <li><EmptyState title="None" /></li>}</ul>
        </Card>
      </div>
      {modal === 'apply' && <ApplyModal customerId={id} onClose={() => setModal(null)} onDone={() => { setModal(null); q.refetch(); }} />}
      {modal === 'override' && (
        <Modal open onClose={() => setModal(null)} title="One-time credit override" description="Extra headroom for one order, valid for 7 days, approved by a checker." footer={<><Button onClick={() => setModal(null)}>Cancel</Button><Button variant="primary" onClick={async () => {
          try { await api.post(`/crm/credit/${id}/override`, { amount: Number(ov.amount), justification: ov.justification, quotation_id: params.get('override') }); setModal(null); q.refetch(); toast({ tone: 'success', title: 'Sent for approval' }); } catch (e) { toast({ tone: 'error', title: (e as Error).message }); }
        }}>Request</Button></>}>
          <div className="space-y-3"><Input label="Extra headroom" type="number" prefix="₹" value={ov.amount} onChange={(e) => setOv({ ...ov, amount: e.target.value })} /><Textarea label="Justification" required value={ov.justification} onChange={(e) => setOv({ ...ov, justification: e.target.value })} /></div>
        </Modal>
      )}
      <ConfirmDialog open={modal === 'block' || modal === 'unblock'} onClose={() => setModal(null)} title={modal === 'block' ? `Block credit for ${d.customer.legal_name}` : 'Unblock credit'} requireReason tone={modal === 'block' ? 'danger' : 'primary'} confirmLabel={modal === 'block' ? 'Block' : 'Unblock'}
        onConfirm={async (reason) => { try { await api.post(`/crm/credit/${id}/block`, { blocked: modal === 'block', reason }); setModal(null); q.refetch(); } catch (e) { toast({ tone: 'error', title: (e as Error).message }); } }} />
    </>
  );
}

// ---------- Performance ----------
interface Perf { user_id: string; name: string; leads: number; avg_response_min: number | null; qualified: number; quotes: number; kg: number; revenue: number; margin_pct: number | null; new_customers: number; repeat_customers: number; t_leads: number | null; t_qualified: number | null; t_quotes: number | null; t_kg: number | null; t_revenue: number | null; t_margin_pct: number | null; t_new_customers: number | null; incentive_eligible: boolean; incentive_reasons: string[] }

export function PerformancePage() {
  const { can } = useAuth();
  const toast = useToast();
  const [period, setPeriod] = useState(new Date().toISOString().slice(0, 7));
  const q = useQuery({ queryKey: ['crm-perf', period], queryFn: () => api.get<{ period: string; min_margin: number; collections_note: string; people: Perf[] }>(`/crm/performance?period=${period}`) });
  const [edit, setEdit] = useState<Perf | null>(null);
  const [t, setT] = useState<Record<string, string>>({});
  const cell = (actual: number, target: number | null, fmt: (n: number) => string = (n) => fmtNum(n)) => (
    <div className="min-w-[110px]"><div className="flex justify-between text-[12.5px] tabular"><span className="font-semibold">{fmt(actual)}</span>{target != null && <span className="text-slate-400">/ {fmt(Number(target))}</span>}</div>{target ? <Bar className="mt-1" value={actual} max={Number(target)} tone={actual >= Number(target) ? 'success' : 'brand'} /> : null}</div>
  );
  return (
    <>
      <PageHeader title="Targets & performance" description="Only verified outcomes count: revenue, kg and margin come from quotations the customer accepted at an approved price on a customer account."
        breadcrumbs={[{ label: 'Sales & CRM', to: '/crm' }, { label: 'Performance' }]} actions={<input type="month" aria-label="Month" className="input h-9 w-auto" value={period} onChange={(e) => setPeriod(e.target.value)} />} />
      <Card padded={false}>
        {!q.data ? <Skeleton className="m-5 h-40" /> : (
          <SimpleTable rows={q.data.people} rowKey={(p) => p.user_id} empty={<EmptyState icon={<Target className="size-5" />} title="No sales team" />} columns={[
            { key: 'n', header: 'Salesperson', render: (p) => <span className="flex items-center gap-2"><Avatar name={p.name} size="sm" />{p.name}</span> },
            { key: 'l', header: 'Leads', render: (p) => cell(p.leads, p.t_leads) },
            { key: 'r', header: 'Response', align: 'right', render: (p) => (p.avg_response_min === null ? '—' : `${p.avg_response_min} min`) },
            { key: 'q', header: 'Qualified', render: (p) => cell(p.qualified, p.t_qualified) },
            { key: 'qt', header: 'Quotes', render: (p) => cell(p.quotes, p.t_quotes) },
            { key: 'kg', header: 'KG sold', render: (p) => cell(p.kg, p.t_kg) },
            { key: 'rev', header: 'Revenue', render: (p) => cell(p.revenue, p.t_revenue, (n) => fmtINR(n)) },
            { key: 'm', header: 'Margin', align: 'right', render: (p) => (p.margin_pct === null ? '—' : <span className={p.margin_pct < (p.t_margin_pct ?? q.data!.min_margin) ? 'font-semibold text-rose-600' : 'text-emerald-700'}>{p.margin_pct}%</span>) },
            { key: 'c', header: 'Customers', align: 'right', render: (p) => <span>{p.new_customers} new<span className="block text-[11.5px] text-slate-500">{p.repeat_customers} repeat</span></span> },
            { key: 'i', header: 'Incentive', render: (p) => (p.incentive_eligible ? <Badge tone="success" dot>Eligible</Badge> : <span title={p.incentive_reasons.join('; ')}><Badge tone="neutral">Not yet</Badge><span className="mt-0.5 block max-w-[160px] truncate text-[11.5px] text-slate-500">{p.incentive_reasons[0]}</span></span>) },
            { key: 'e', header: '', align: 'right', render: (p) => (can('crm.target.manage') ? <Button size="sm" variant="ghost" icon={<TrendingUp className="size-3.5" />} onClick={() => { setEdit(p); setT({ leads: String(p.t_leads ?? ''), qualified: String(p.t_qualified ?? ''), quotes: String(p.t_quotes ?? ''), kg: String(p.t_kg ?? ''), revenue: String(p.t_revenue ?? ''), margin_pct: String(p.t_margin_pct ?? ''), new_customers: String(p.t_new_customers ?? '') }); }}>Targets</Button> : null) },
          ]} />
        )}
        <p className="border-t border-slate-100 px-5 py-3 text-[12px] text-slate-500">{q.data?.collections_note}</p>
      </Card>
      {edit && (
        <Modal open onClose={() => setEdit(null)} title={`Targets for ${edit.name} · ${period}`} footer={<><Button onClick={() => setEdit(null)}>Cancel</Button><Button variant="primary" onClick={async () => {
          try { await api.put('/crm/targets', { user_id: edit.user_id, period, ...Object.fromEntries(Object.entries(t).map(([k, x]) => [k, x === '' || x === 'null' ? null : Number(x)])) }); setEdit(null); q.refetch(); } catch (e) { toast({ tone: 'error', title: (e as Error).message }); }
        }}>Save</Button></>}>
          <div className="grid grid-cols-2 gap-3">{Object.keys(t).map((k) => <Input key={k} label={humanize(k)} type="number" value={t[k] === 'null' ? '' : t[k]} onChange={(e) => setT({ ...t, [k]: e.target.value })} />)}</div>
        </Modal>
      )}
    </>
  );
}

export { STAGES };
