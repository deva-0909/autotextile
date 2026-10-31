import { useQuery } from '@tanstack/react-query';
import { ArrowRight, ClipboardList, FileSearch, Receipt, ScanText, ShieldAlert, ShoppingCart } from 'lucide-react';
import { Link } from '../../components/AppLink';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { fmtINR, fmtRelative, humanize } from '../../lib/format';
import { Card, EmptyState, PageHeader, Stat, StatusBadge } from '../../components/ui';

interface Dash { requisitions_to_approve: number; open_rfqs: number; open_pos: number; open_po_value: number; pos_pending_approval: number; overdue_pos: number; captures_to_review: number; open_exceptions: number }
interface Ex { id: string; kind: string; severity: string; message: string; ref_type: string; ref_id: string; ref_label: string; detected_at: string }

export const exceptionLink = (e: { ref_type: string; ref_id: string }) =>
  e.ref_type === 'purchase_order' ? `/procurement/purchase-orders/${e.ref_id}` : e.ref_type === 'supplier_invoice' ? `/procurement/invoices/${e.ref_id}` : '/procurement/match';

export function ProcurementOverview() {
  const { can } = useAuth();
  const d = useQuery({ queryKey: ['proc-dash'], queryFn: () => api.get<Dash>('/procurement/dashboard'), enabled: can('procurement.read') });
  const ex = useQuery({ queryKey: ['proc-exceptions'], queryFn: () => api.get<Ex[]>('/procurement/exceptions') });
  const v = d.data;
  return (
    <>
      <PageHeader title="Procurement" description="Requisition → RFQ → purchase order → supplier dispatch → receipt (warehouse or mill) → invoice → three-way match → AP." breadcrumbs={[{ label: 'Procurement' }]} />
      <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="Open purchase orders" value={v?.open_pos ?? '—'} sub={v ? fmtINR(v.open_po_value) : undefined} />
        <Stat label="Overdue deliveries" value={v?.overdue_pos ?? '—'} tone={v?.overdue_pos ? 'danger' : undefined} sub="Past expected date" />
        <Stat label="Invoices to review" value={v?.captures_to_review ?? '—'} tone={v?.captures_to_review ? 'warning' : undefined} sub="In the AI workbench" />
        <Stat label="Open exceptions" value={v?.open_exceptions ?? '—'} tone={v?.open_exceptions ? 'warning' : undefined} sub="Match, missing invoice, SLA" />
      </div>
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
        <Card title="Exceptions" description="Raised automatically; each links to the record" padded={false} className="xl:col-span-2" actions={<Link to="/procurement/match" className="link text-[12.5px]">Three-way match</Link>}>
          {ex.data?.length ? (
            <ul className="divide-y divide-slate-100">
              {ex.data.slice(0, 10).map((e) => (
                <li key={e.id}>
                  <Link to={exceptionLink(e)} className="flex items-center gap-3 px-5 py-3 hover:bg-slate-50">
                    <StatusBadge status={e.severity} />
                    <span className="min-w-0 flex-1"><span className="block truncate text-[13.5px] text-slate-900">{e.message}</span><span className="text-[12px] text-slate-500">{humanize(e.kind)} · {fmtRelative(e.detected_at)}</span></span>
                    <ArrowRight className="size-4 text-slate-300" />
                  </Link>
                </li>
              ))}
            </ul>
          ) : <EmptyState icon={<ShieldAlert className="size-5" />} title="No open exceptions" />}
        </Card>
        <Card title="Work queues" padded={false}>
          <ul className="divide-y divide-slate-100 text-[13.5px]">
            {[
              { icon: <ClipboardList className="size-4" />, label: 'Requisitions to approve', n: v?.requisitions_to_approve, to: '/procurement/requisitions' },
              { icon: <FileSearch className="size-4" />, label: 'Open RFQs', n: v?.open_rfqs, to: '/procurement/rfqs' },
              { icon: <ShoppingCart className="size-4" />, label: 'POs awaiting approval', n: v?.pos_pending_approval, to: '/approvals' },
              { icon: <ScanText className="size-4" />, label: 'Invoices to review', n: v?.captures_to_review, to: '/procurement/invoice-workbench' },
              { icon: <Receipt className="size-4" />, label: 'Supplier invoices & AP', n: undefined, to: '/procurement/invoices' },
            ].map((q) => (
              <li key={q.label}><Link to={q.to} className="flex items-center gap-3 px-5 py-3 hover:bg-slate-50"><span className="text-slate-400">{q.icon}</span><span className="flex-1 text-slate-700">{q.label}</span>{q.n !== undefined && <span className="font-semibold tabular">{q.n}</span>}</Link></li>
            ))}
          </ul>
        </Card>
      </div>
    </>
  );
}
