import { useQuery } from '@tanstack/react-query';
import { ArrowRight, Building2, CheckCircle2, ClipboardCheck, Factory, FileWarning, History, Package, ShieldAlert, Truck, Users, Warehouse } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { api, qs, type Page } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fmtNum, fmtRelative, humanize } from '../lib/format';
import { Avatar, Badge, Card, EmptyState, Skeleton } from '../components/ui';
import programme from '../lib/programme.json';

interface Summary { approvalsToDecide: number; myPendingRequests: number; auditEvents24h: number; documents: number; documentsExpiring30d: number }
interface WarehouseRow { id: string; code: string; name: string; city: string; gstin: string; dispatch_priority: number; warehouse_type: string; bin_count: number; capacity_kg: number | null; status: string }
interface AuditRow { id: number; service: string; entity: string; entity_id: string; action: string; user_name: string | null; at: string; reason: string | null }
interface Approval { id: string; title: string; requested_by_name: string; requested_at: string; summary: string | null }
interface Setting { key: string; label: string; requires_ca_validation: boolean }

function useCount(path: string, enabled: boolean) {
  return useQuery({ queryKey: ['count', path], queryFn: () => api.get<Page<unknown>>(path).then((r) => r.total), enabled });
}

function Kpi({ icon, label, value, sub, to, tone = 'brand' }: { icon: ReactNode; label: string; value: ReactNode; sub?: ReactNode; to?: string; tone?: 'brand' | 'amber' | 'emerald' | 'sky' | 'violet' }) {
  const bg = { brand: 'bg-brand-50 text-brand-600', amber: 'bg-amber-50 text-amber-600', emerald: 'bg-emerald-50 text-emerald-600', sky: 'bg-sky-50 text-sky-600', violet: 'bg-violet-50 text-violet-600' }[tone];
  const body = (
    <div className="card group flex h-full items-start gap-4 p-4 transition hover:border-slate-300">
      <span className={`flex size-10 shrink-0 items-center justify-center rounded-lg ${bg}`}>{icon}</span>
      <div className="min-w-0">
        <p className="text-[12.5px] font-medium text-slate-500">{label}</p>
        <p className="mt-0.5 text-[24px] leading-tight font-semibold tracking-tight text-slate-900 tabular">{value ?? <Skeleton className="mt-1 h-6 w-12" />}</p>
        {sub && <p className="mt-0.5 text-[12px] text-slate-500">{sub}</p>}
      </div>
    </div>
  );
  return to ? <Link to={to}>{body}</Link> : body;
}

export function DashboardPage() {
  const { user, can } = useAuth();
  const summary = useQuery({ queryKey: ['governance-summary'], queryFn: () => api.get<Summary>('/governance/summary') });
  const warehouses = useQuery({ queryKey: ['warehouses'], queryFn: () => api.get<WarehouseRow[]>('/organisation/warehouses'), enabled: can('org.warehouse.read') });
  const gst = useQuery({ queryKey: ['gst-registrations'], queryFn: () => api.get<unknown[]>('/organisation/gst-registrations'), enabled: can('org.entity.read') });
  const canParty = can('masters.party.read');
  const customers = useCount(`/masters/parties${qs({ pageSize: 1, f_type: 'customer', f_status: 'active' })}`, canParty);
  const suppliers = useCount(`/masters/parties${qs({ pageSize: 1, f_type: 'supplier,manufacturer', f_status: 'active' })}`, canParty);
  const mills = useCount(`/masters/parties${qs({ pageSize: 1, f_type: 'mill', f_status: 'active' })}`, canParty);
  const transporters = useCount(`/masters/parties${qs({ pageSize: 1, f_type: 'transporter', f_status: 'active' })}`, canParty);
  const products = useCount(`/masters/products${qs({ pageSize: 1, f_status: 'active' })}`, can('masters.product.read'));
  const audit = useQuery({ queryKey: ['audit-recent'], queryFn: () => api.get<Page<AuditRow>>('/governance/audit?pageSize=8'), enabled: can('governance.audit.read') });
  const approvals = useQuery({
    queryKey: ['approvals-dash'],
    queryFn: () => api.get<Page<Approval>>('/governance/approvals?f_status=pending&pageSize=5'),
    enabled: can('governance.approval.decide'),
  });
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => api.get<Setting[]>('/organisation/settings'), enabled: can('org.config.read') });
  const caPending = settings.data?.filter((s) => s.requires_ca_validation) ?? [];

  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  const phases = programme.phases;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-[13px] text-slate-500">{new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}</p>
          <h1 className="mt-1 text-[24px] font-semibold tracking-tight">{greeting}, {user?.name.split(' ')[0]}</h1>
        </div>
        <div className="flex gap-2">
          {can('masters.customer.manage') && <Link to="/partners/customer?new=1" className="inline-flex h-9 items-center gap-2 rounded-md border border-slate-300 bg-white px-3.5 text-[13.5px] font-medium text-slate-700 shadow-sm hover:bg-slate-50">New customer</Link>}
          {can('masters.product.manage') && <Link to="/catalogue/products?new=1" className="inline-flex h-9 items-center gap-2 rounded-md bg-brand-600 px-3.5 text-[13.5px] font-medium text-white shadow-sm hover:bg-brand-700">New fabric SKU</Link>}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {can('governance.approval.decide') ? (
          <Kpi icon={<ClipboardCheck className="size-5" />} tone="amber" label="Approvals waiting for you" value={summary.data?.approvalsToDecide} sub="Maker-checker requests" to="/approvals" />
        ) : (
          <Kpi icon={<ClipboardCheck className="size-5" />} tone="amber" label="My pending requests" value={summary.data?.myPendingRequests} sub="Awaiting a checker" to="/approvals" />
        )}
        {can('org.warehouse.read') && <Kpi icon={<Warehouse className="size-5" />} label="Warehouses in scope" value={warehouses.data?.length} sub={gst.data ? `${gst.data.length} GST registrations` : 'In your data scope'} to="/organisation/warehouses" />}
        {canParty && <Kpi icon={<Users className="size-5" />} tone="emerald" label="Active customers" value={customers.data} sub={`${fmtNum(suppliers.data)} suppliers · ${fmtNum(mills.data)} mills`} to="/partners/customer" />}
        {can('masters.product.read') && <Kpi icon={<Package className="size-5" />} tone="violet" label="Active fabric SKUs" value={products.data} sub="Across configurable categories" to="/catalogue/products" />}
      </div>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
        <div className="space-y-6 xl:col-span-2">
          {can('governance.approval.decide') && (
            <Card title="Needs your decision" description="Sensitive changes held for maker-checker approval" padded={false} actions={<Link to="/approvals" className="link text-[12.5px]">Open inbox</Link>}>
              {approvals.data?.items.length ? (
                <ul className="divide-y divide-slate-100">
                  {approvals.data.items.map((a) => (
                    <li key={a.id}>
                      <Link to={`/approvals/${a.id}`} className="flex items-center gap-4 px-5 py-3 hover:bg-slate-50">
                        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-amber-50 text-amber-600"><ShieldAlert className="size-4" /></span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[13.5px] font-medium text-slate-900">{a.title}</span>
                          <span className="block truncate text-[12px] text-slate-500">{a.requested_by_name} · {fmtRelative(a.requested_at)}{a.summary ? ` · ${a.summary}` : ''}</span>
                        </span>
                        <ArrowRight className="size-4 text-slate-300" />
                      </Link>
                    </li>
                  ))}
                </ul>
              ) : (
                <EmptyState icon={<CheckCircle2 className="size-5" />} title="Nothing waiting" description="New requests from colleagues will appear here." />
              )}
            </Card>
          )}

          {can('org.warehouse.read') && (
            <Card title="Warehouse network" description="Dispatch priority order used by the allocation engine (Surat first by default)" padded={false} actions={<Link to="/organisation/warehouses" className="link text-[12.5px]">Manage</Link>}>
              <div className="grid grid-cols-1 divide-y divide-slate-100 sm:grid-cols-2 sm:divide-y-0 lg:grid-cols-5 lg:divide-x">
                {warehouses.data?.map((w, i) => (
                  <Link key={w.id} to={`/organisation/warehouses/${w.id}`} className="block px-5 py-4 hover:bg-slate-50">
                    <div className="flex items-center justify-between">
                      <span className="font-mono text-[12px] font-semibold text-slate-500">#{i + 1} · {w.code}</span>
                      {w.warehouse_type === 'receiving_hub' && <Badge tone="brand">Hub</Badge>}
                    </div>
                    <p className="mt-1.5 text-[13.5px] font-medium text-slate-900">{w.name}</p>
                    <p className="text-[12px] text-slate-500">{w.city} · {w.bin_count} bins</p>
                    <p className="mt-2 truncate font-mono text-[11px] text-slate-400">{w.gstin}</p>
                  </Link>
                ))}
                {!warehouses.data && Array.from({ length: 5 }).map((_, i) => <div key={i} className="p-5"><Skeleton className="h-16" /></div>)}
              </div>
            </Card>
          )}

          {can('governance.audit.read') && (
            <Card title="Recent activity" description={`${fmtNum(summary.data?.auditEvents24h)} audited changes in the last 24 hours`} padded={false} actions={<Link to="/governance/audit" className="link text-[12.5px]">Audit trail</Link>}>
              <ul className="divide-y divide-slate-100">
                {audit.data?.items.map((a) => (
                  <li key={a.id} className="flex items-center gap-3 px-5 py-2.5">
                    <Avatar name={a.user_name ?? 'System'} size="sm" />
                    <p className="min-w-0 flex-1 truncate text-[13px] text-slate-700">
                      <span className="font-medium text-slate-900">{a.user_name ?? 'System'}</span> {humanize(a.action).toLowerCase()} {humanize(a.entity).toLowerCase()}
                      {a.reason && <span className="text-slate-500"> — {a.reason}</span>}
                    </p>
                    <span className="shrink-0 text-[12px] text-slate-400">{fmtRelative(a.at)}</span>
                  </li>
                ))}
                {audit.data?.items.length === 0 && <EmptyState icon={<History className="size-5" />} title="No activity yet" />}
              </ul>
            </Card>
          )}
        </div>

        <div className="space-y-6">
          <Card title="Attention" padded={false}>
            <ul className="divide-y divide-slate-100 text-[13px]">
              {caPending.length > 0 && (
                <li className="flex gap-3 px-5 py-3">
                  <FileWarning className="mt-0.5 size-4 shrink-0 text-amber-500" />
                  <div>
                    <p className="font-medium text-slate-900">{caPending.length} settings need CA validation</p>
                    <p className="text-slate-500">{caPending.map((s) => s.label).slice(0, 2).join(', ')}{caPending.length > 2 ? '…' : ''}</p>
                    <Link to="/organisation/configuration" className="link text-[12.5px]">Review configuration</Link>
                  </div>
                </li>
              )}
              {!!summary.data?.documentsExpiring30d && (
                <li className="flex gap-3 px-5 py-3">
                  <FileWarning className="mt-0.5 size-4 shrink-0 text-rose-500" />
                  <div>
                    <p className="font-medium text-slate-900">{summary.data.documentsExpiring30d} documents expire within 30 days</p>
                    <Link to="/governance/documents" className="link text-[12.5px]">View documents</Link>
                  </div>
                </li>
              )}
              {!!summary.data?.myPendingRequests && (
                <li className="flex gap-3 px-5 py-3">
                  <ClipboardCheck className="mt-0.5 size-4 shrink-0 text-sky-500" />
                  <div>
                    <p className="font-medium text-slate-900">{summary.data.myPendingRequests} of your requests await approval</p>
                    <Link to="/approvals?box=mine" className="link text-[12.5px]">Track requests</Link>
                  </div>
                </li>
              )}
              <li className="flex gap-3 px-5 py-3">
                <Building2 className="mt-0.5 size-4 shrink-0 text-slate-400" />
                <div>
                  <p className="font-medium text-slate-900">Legal entity and GSTIN mapping are demo values</p>
                  <p className="text-slate-500">Replace after client and CA confirmation (DEC-001, DEC-002).</p>
                </div>
              </li>
            </ul>
          </Card>

          {canParty && (
            <Card title="Business partners">
              <div className="space-y-3 text-[13px]">
                {[
                  { icon: <Users className="size-4" />, label: 'Customers', v: customers.data, to: '/partners/customer' },
                  { icon: <Package className="size-4" />, label: 'Suppliers & manufacturers', v: suppliers.data, to: '/partners/supplier' },
                  { icon: <Factory className="size-4" />, label: 'Processing mills', v: mills.data, to: '/partners/mill' },
                  { icon: <Truck className="size-4" />, label: 'Transporters', v: transporters.data, to: '/partners/transporter' },
                ].map((r) => (
                  <Link key={r.label} to={r.to} className="flex items-center gap-3 rounded-md px-1 py-1 hover:bg-slate-50">
                    <span className="text-slate-400">{r.icon}</span>
                    <span className="flex-1 text-slate-700">{r.label}</span>
                    <span className="font-semibold text-slate-900 tabular">{fmtNum(r.v)}</span>
                  </Link>
                ))}
              </div>
            </Card>
          )}

          <Card title="Delivery programme" description="Phase-wise release plan from the developer brief" actions={<Link to="/programme" className="link text-[12.5px]">Tracker</Link>}>
            <ol className="space-y-2.5">
              {phases.slice(0, 6).map((p) => {
                const state = p.id === 'P0' || p.id === 'P1' ? 'current' : 'planned';
                return (
                  <li key={p.id} className="flex items-center gap-3 text-[13px]">
                    <span className={`flex size-6 shrink-0 items-center justify-center rounded-full text-[10.5px] font-bold ${state === 'current' ? 'bg-brand-600 text-white' : 'bg-slate-100 text-slate-500'}`}>{p.id.slice(1)}</span>
                    <span className="flex-1 truncate text-slate-700">{p.name}</span>
                    {state === 'current' && <Badge tone="brand">In delivery</Badge>}
                  </li>
                );
              })}
            </ol>
          </Card>
        </div>
      </div>
    </div>
  );
}
