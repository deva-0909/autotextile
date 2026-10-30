import { useQuery } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { useNavigate } from 'react-router-dom';
import { api } from '../../lib/api';
import { fmtDate, fmtNum, fmtRelative, humanize } from '../../lib/format';
import { SimpleTable } from '../../components/DataTable';
import { Card, EmptyState, Notice, PageHeader, Stat, StatusBadge } from '../../components/ui';

interface Row { id: string; number: string; mill_name: string; process_name: string; status: string; issue_date: string; expected_return_date: string; internal_due_date: string; statutory_due_date: string; kg_sent: number; kg_balance: number; commercial_days: number; operational_days: number; statutory_days: number; ack_at: string | null }
interface Data { counts: { operational_overdue: number; commercial_overdue: number; statutory_within_30: number; awaiting_ack: number; kg_at_mills: number }; orders: Row[] }
interface Dash { open_orders: number; kg_at_mills: number; grey_unallocated_kg: number; awaiting_ack: number; ready_for_collection: number; overdue: number; open_claims: number; open_exceptions: number }
interface Ex { id: string; kind: string; severity: string; message: string; ref_id: string; detected_at: string }

function Clock({ date, days }: { date: string; days: number }) {
  const tone = days < 0 ? 'bg-rose-50 text-rose-700 ring-rose-600/20' : days <= 3 ? 'bg-amber-50 text-amber-800 ring-amber-600/20' : 'bg-slate-50 text-slate-700 ring-slate-500/10';
  return (
    <div className={clsx('inline-flex flex-col rounded-md px-2 py-1 ring-1 ring-inset', tone)}>
      <span className="text-[12.5px] font-medium tabular">{fmtDate(date)}</span>
      <span className="text-[11px]">{days < 0 ? `${-days} d overdue` : days === 0 ? 'today' : `in ${days} d`}</span>
    </div>
  );
}

export function JobworkCockpit() {
  const nav = useNavigate();
  const q = useQuery({ queryKey: ['jw-deadlines'], queryFn: () => api.get<Data>('/jobwork/deadlines') });
  const dash = useQuery({ queryKey: ['jw-dash'], queryFn: () => api.get<Dash>('/jobwork/dashboard') });
  const ex = useQuery({ queryKey: ['jw-exceptions'], queryFn: () => api.get<Ex[]>('/jobwork/exceptions') });
  const c = q.data?.counts;
  return (
    <>
      <PageHeader title="Job-work deadline cockpit" description="Every order at a mill runs on three separate clocks: the commercial date agreed with the mill, our internal operational due date, and the statutory job-work return deadline." breadcrumbs={[{ label: 'Mill job work' }, { label: 'Deadline cockpit' }]} />
      <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-5">
        <Stat label="Fabric at mills" value={fmtNum(c?.kg_at_mills, 'kg')} sub={`${dash.data?.open_orders ?? '—'} open orders · trader-owned`} />
        <Stat label="Grey awaiting job work" value={fmtNum(dash.data?.grey_unallocated_kg, 'kg')} sub="Received at mills from suppliers" />
        <Stat label="Awaiting mill acknowledgement" value={c?.awaiting_ack ?? '—'} tone={c?.awaiting_ack ? 'warning' : undefined} />
        <Stat label="Operationally overdue" value={c?.operational_overdue ?? '—'} tone={c?.operational_overdue ? 'danger' : undefined} />
        <Stat label="Statutory due ≤ 30 days" value={c?.statutory_within_30 ?? '—'} tone={c?.statutory_within_30 ? 'danger' : undefined} />
      </div>
      <div className="mb-6"><Notice tone="warning">The statutory deadline uses the configured return period (default 365 days for inputs). Validate the period and ITC-04 applicability with the CA (DEC-007).</Notice></div>
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
        <Card title="Open orders" padded={false} className="xl:col-span-2">
          {q.data && q.data.orders.length === 0 ? <EmptyState title="No fabric at mills" /> : (
            <SimpleTable rows={q.data?.orders ?? []} rowKey={(r) => r.id} onRowClick={(r) => nav(`/jobwork/orders/${r.id}`)} columns={[
              { key: 'n', header: 'Order', render: (r) => <div><p className="font-mono text-[12.5px] font-semibold text-slate-900">{r.number}</p><p className="text-[12px] text-slate-500">{r.mill_name} · {r.process_name}</p></div> },
              { key: 's', header: 'Status', render: (r) => <StatusBadge status={r.status} /> },
              { key: 'kg', header: 'At mill', align: 'right', render: (r) => fmtNum(r.kg_balance, 'kg') },
              { key: 'c', header: 'Commercial', render: (r) => <Clock date={r.expected_return_date} days={r.commercial_days} /> },
              { key: 'o', header: 'Operational', render: (r) => <Clock date={r.internal_due_date} days={r.operational_days} /> },
              { key: 'st', header: 'Statutory', render: (r) => <Clock date={r.statutory_due_date} days={r.statutory_days} /> },
            ]} />
          )}
        </Card>
        <Card title="Alerts" padded={false}>
          {ex.data?.length ? (
            <ul className="divide-y divide-slate-100">{ex.data.map((e) => <li key={e.id}><button className="w-full px-5 py-3 text-left hover:bg-slate-50" onClick={() => nav(`/jobwork/orders/${e.ref_id}`)}><div className="flex items-center gap-2"><StatusBadge status={e.severity} /><span className="text-[11.5px] text-slate-500">{humanize(e.kind)} · {fmtRelative(e.detected_at)}</span></div><p className="mt-1 text-[13px] text-slate-800">{e.message}</p></button></li>)}</ul>
          ) : <EmptyState title="No alerts" />}
        </Card>
      </div>
    </>
  );
}
