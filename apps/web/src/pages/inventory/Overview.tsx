import { useQuery } from '@tanstack/react-query';
import { ArrowRight, ArrowRightLeft, ClipboardCheck, Factory, PackageOpen, ScanLine, ShieldAlert, Tag, Timer } from 'lucide-react';
import { Link } from '../../components/AppLink';
import { api } from '../../lib/api';
import { fmtNum, fmtRelative, humanize } from '../../lib/format';
import { Bar } from '../../components/scan';
import { Button, Card, EmptyState, PageHeader, Stat, StatusBadge } from '../../components/ui';

export interface InvDash { physical_kg: number; available_kg: number; reserved_kg: number; in_transit_kg: number; at_mill_kg: number; rolls: number; qc_pending_rolls: number; open_inwards: number; price_pending: number; unpriced_lots: number; transfers_open: number; transfers_in_transit: number; stocktakes_open: number; mill_issues_open: number; reservations_active: number; aged_kg: number; open_exceptions: number }
interface Ex { id: string; kind: string; severity: string; message: string; ref_type: string; ref_id: string; detected_at: string }
interface Ageing { buckets: { label: string; lots: number; kg: number; value: number }[] }

export const invExceptionLink = (e: { ref_type: string; ref_id: string }) =>
  ({ inward: `/inventory/inward/${e.ref_id}`, lot: `/inventory/lots/${e.ref_id}`, transfer: `/inventory/transfers/${e.ref_id}` } as Record<string, string>)[e.ref_type] ?? '/inventory';

export function InventoryOverview() {
  const d = useQuery({ queryKey: ['inv-dash'], queryFn: () => api.get<InvDash>('/inventory/dashboard') });
  const ex = useQuery({ queryKey: ['inv-exceptions'], queryFn: () => api.get<Ex[]>('/inventory/exceptions') });
  const age = useQuery({ queryKey: ['inv-ageing'], queryFn: () => api.get<Ageing>('/inventory/ageing') });
  const v = d.data;
  const maxAge = Math.max(1, ...(age.data?.buckets.map((b) => b.kg) ?? [1]));
  const queues = [
    { icon: <PackageOpen className="size-4" />, label: 'Inwards to weigh and scan', n: v?.open_inwards, to: '/inventory/inward' },
    { icon: <ClipboardCheck className="size-4" />, label: 'Rolls waiting for QC', n: v?.qc_pending_rolls, to: '/inventory/qc' },
    { icon: <Tag className="size-4" />, label: 'Lots without a selling price', n: v?.unpriced_lots, to: '/inventory/pricing' },
    { icon: <Tag className="size-4" />, label: 'Price changes awaiting approval', n: v?.price_pending, to: '/inventory/pricing?tab=pending' },
    { icon: <Factory className="size-4" />, label: 'Rolls to issue to mills', n: v?.mill_issues_open, to: '/inventory/mill-issues' },
    { icon: <ArrowRightLeft className="size-4" />, label: 'Transfers to dispatch', n: v?.transfers_open, to: '/inventory/transfers' },
    { icon: <ArrowRightLeft className="size-4" />, label: 'Transfers in transit', n: v?.transfers_in_transit, to: '/inventory/transfers' },
    { icon: <ClipboardCheck className="size-4" />, label: 'Stock counts open', n: v?.stocktakes_open, to: '/inventory/stocktakes' },
  ];
  return (
    <>
      <PageHeader title="Inventory" description="Every kilogram is a roll with a barcode. Balances come only from the immutable stock ledger: inward, QC, putaway, reservation, transfer, issue to mill and adjustment."
        breadcrumbs={[{ label: 'Inventory' }]} actions={<Link to="/inventory/scan"><Button variant="primary" icon={<ScanLine className="size-4" />}>Scan station</Button></Link>} />
      <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-5">
        <Stat label="Physical stock" value={fmtNum(v?.physical_kg, 'kg')} sub={`${fmtNum(v?.rolls)} rolls in warehouses`} />
        <Stat label="Available to sell" value={fmtNum(v?.available_kg, 'kg')} sub="Graded A/B/C, not reserved" />
        <Stat label="Reserved" value={fmtNum(v?.reserved_kg, 'kg')} sub={`${v?.reservations_active ?? '—'} active reservations`} />
        <Stat label="In transit" value={fmtNum(v?.in_transit_kg, 'kg')} sub="Between warehouses" />
        <Stat label="At mills" value={fmtNum(v?.at_mill_kg, 'kg')} sub="Issued for job work" />
      </div>
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
        <div className="space-y-6 xl:col-span-2">
          <Card title="Exceptions" description="Weight variances, QC rejects, out-of-spec lots and transfer shortages" padded={false}>
            {ex.data?.length ? (
              <ul className="divide-y divide-slate-100">
                {ex.data.slice(0, 8).map((e) => (
                  <li key={e.id}><Link to={invExceptionLink(e)} className="flex items-center gap-3 px-5 py-3 hover:bg-slate-50">
                    <StatusBadge status={e.severity} />
                    <span className="min-w-0 flex-1"><span className="block truncate text-[13.5px] text-slate-900">{e.message}</span><span className="text-[12px] text-slate-500">{humanize(e.kind)} · {fmtRelative(e.detected_at)}</span></span>
                    <ArrowRight className="size-4 text-slate-300" />
                  </Link></li>
                ))}
              </ul>
            ) : <EmptyState icon={<ShieldAlert className="size-5" />} title="No open exceptions" />}
          </Card>
          <Card title="Stock ageing" description="By days since the lot was received" actions={<Link to="/inventory/stock?tab=ageing" className="link text-[12.5px]">Ageing report</Link>}>
            <div className="space-y-3">
              {age.data?.buckets.map((b) => (
                <div key={b.label} className="grid grid-cols-[90px_1fr_120px] items-center gap-3 text-[13px]">
                  <span className="text-slate-600 tabular">{b.label} days</span>
                  <Bar value={b.kg} max={maxAge} tone={b.label.startsWith('>') || b.label.startsWith('181') ? 'danger' : b.label.startsWith('91') ? 'warning' : 'brand'} />
                  <span className="text-right font-medium tabular">{fmtNum(b.kg, 'kg')}</span>
                </div>
              ))}
            </div>
          </Card>
        </div>
        <Card title="Work queues" padded={false}>
          <ul className="divide-y divide-slate-100 text-[13.5px]">
            {queues.map((q) => (
              <li key={q.label}><Link to={q.to} className="flex items-center gap-3 px-5 py-3 hover:bg-slate-50"><span className="text-slate-400">{q.icon}</span><span className="flex-1 text-slate-700">{q.label}</span><span className={`font-semibold tabular ${q.n ? 'text-slate-900' : 'text-slate-400'}`}>{q.n ?? '—'}</span></Link></li>
            ))}
            <li><Link to="/inventory/stock?tab=ageing" className="flex items-center gap-3 px-5 py-3 hover:bg-slate-50"><span className="text-slate-400"><Timer className="size-4" /></span><span className="flex-1 text-slate-700">Aged stock (older than 180 days)</span><span className="font-semibold tabular">{fmtNum(v?.aged_kg, 'kg')}</span></Link></li>
          </ul>
        </Card>
      </div>
    </>
  );
}
