import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2 } from 'lucide-react';
import { useState } from 'react';
import { Link } from '../../components/AppLink';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { fmtINR, fmtNum, fmtRelative, humanize } from '../../lib/format';
import { SimpleTable } from '../../components/DataTable';
import { ConfirmDialog, useToast } from '../../components/overlay';
import { Badge, Button, Card, EmptyState, PageHeader, Stat, StatusBadge } from '../../components/ui';
import { exceptionLink } from './Overview';

interface Overview {
  counts: { open_exceptions: number; ready_to_post: number; on_hold: number; unbilled_value: number; captures_to_review: number };
  exceptions: { id: string; kind: string; severity: string; message: string; ref_type: string; ref_id: string; ref_label: string; detected_at: string }[];
  unbilled: { po_id: string; po_number: string; supplier_name: string; deliver_to_type: string; deliver_to_name: string; sku: string; ordered_kg: number; received_kg: number; invoiced_kg: number; unbilled_kg: number; unbilled_value: number; days_since_receipt: number | null }[];
  held: { id: string; invoice_number: string; supplier_name: string; total_value: number; match_status: string; status: string; po_number: string | null; match_result: { message: string }[] }[];
  awaiting_acceptance: { id: string; number: string; supplier_name: string; total_value: number; hours_waiting: number }[];
}

export function MatchPage() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['match-overview'], queryFn: () => api.get<Overview>('/procurement/match/overview') });
  const [resolve, setResolve] = useState<string | null>(null);
  const d = q.data;
  return (
    <>
      <PageHeader title="Three-way match & exceptions" description="Purchase order vs supplier invoice vs warehouse or mill receipt. Unbilled receipts, held invoices and supplier SLA breaches in one place." breadcrumbs={[{ label: 'Procurement', to: '/procurement' }, { label: 'Three-way match' }]} />
      <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-5">
        <Stat label="Open exceptions" value={d?.counts.open_exceptions ?? '—'} tone={d?.counts.open_exceptions ? 'warning' : undefined} />
        <Stat label="Invoices on hold" value={d?.counts.on_hold ?? '—'} tone={d?.counts.on_hold ? 'danger' : undefined} />
        <Stat label="Ready to post" value={d?.counts.ready_to_post ?? '—'} tone="success" />
        <Stat label="Received, not invoiced" value={fmtINR(d?.counts.unbilled_value)} sub="Unbilled receipts" />
        <Stat label="To review in workbench" value={d?.counts.captures_to_review ?? '—'} />
      </div>
      <div className="space-y-6">
        <Card title="Exceptions" padded={false}>
          {d?.exceptions.length ? (
            <ul className="divide-y divide-slate-100">
              {d.exceptions.map((e) => (
                <li key={e.id} className="flex items-center gap-3 px-5 py-3">
                  <StatusBadge status={e.severity} />
                  <Link to={exceptionLink(e)} className="min-w-0 flex-1 hover:underline"><span className="block truncate text-[13.5px] text-slate-900">{e.message}</span><span className="text-[12px] text-slate-500">{humanize(e.kind)} · {e.ref_label} · {fmtRelative(e.detected_at)}</span></Link>
                  {can('procurement.exception.manage') && <Button size="xs" onClick={() => setResolve(e.id)}>Resolve</Button>}
                </li>
              ))}
            </ul>
          ) : <EmptyState icon={<CheckCircle2 className="size-5" />} title="No open exceptions" />}
        </Card>
        <Card title="Received but not invoiced" description="Material accepted at a warehouse or mill with no supplier invoice yet" padded={false}>
          <SimpleTable rows={d?.unbilled ?? []} rowKey={(r) => `${r.po_id}-${r.sku}`} columns={[
            { key: 'po', header: 'PO', render: (r) => <Link className="link font-mono text-[12.5px]" to={`/procurement/purchase-orders/${r.po_id}`}>{r.po_number}</Link> },
            { key: 'sup', header: 'Supplier', render: (r) => r.supplier_name },
            { key: 'dest', header: 'Received at', render: (r) => <span className="flex items-center gap-1.5">{r.deliver_to_type === 'mill' && <Badge tone="violet">Mill</Badge>}{r.deliver_to_name}</span> },
            { key: 'sku', header: 'SKU', render: (r) => <span className="font-mono text-[12.5px]">{r.sku}</span> },
            { key: 'kg', header: 'Ordered / received / invoiced', align: 'right', render: (r) => `${fmtNum(r.ordered_kg)} / ${fmtNum(r.received_kg)} / ${fmtNum(r.invoiced_kg)}` },
            { key: 'ub', header: 'Unbilled', align: 'right', render: (r) => <span className="font-medium">{fmtNum(r.unbilled_kg, 'kg')} · {fmtINR(r.unbilled_value)}</span> },
            { key: 'age', header: 'Since receipt', align: 'right', render: (r) => (r.days_since_receipt != null ? <span className={r.days_since_receipt > 7 ? 'font-medium text-rose-600' : ''}>{r.days_since_receipt} d</span> : '—') },
          ]} empty={<p className="px-5 py-6 text-center text-[13px] text-slate-500">Every receipt is invoiced.</p>} />
        </Card>
        <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
          <Card title="Invoices on hold" padded={false}>
            <SimpleTable rows={d?.held ?? []} rowKey={(r) => r.id} columns={[
              { key: 'n', header: 'Invoice', render: (r) => <Link className="link font-mono text-[12.5px]" to={`/procurement/invoices/${r.id}`}>{r.invoice_number}</Link> },
              { key: 's', header: 'Supplier', render: (r) => r.supplier_name },
              { key: 'm', header: 'Issue', render: (r) => <div><StatusBadge status={r.match_status} /><p className="mt-0.5 max-w-[260px] truncate text-[12px] text-slate-500">{r.match_result[0]?.message}</p></div> },
              { key: 'v', header: 'Total', align: 'right', render: (r) => fmtINR(r.total_value) },
            ]} empty={<p className="px-5 py-6 text-center text-[13px] text-slate-500">None.</p>} />
          </Card>
          <Card title="POs awaiting supplier acceptance" padded={false}>
            <SimpleTable rows={d?.awaiting_acceptance ?? []} rowKey={(r) => r.id} columns={[
              { key: 'n', header: 'PO', render: (r) => <Link className="link font-mono text-[12.5px]" to={`/procurement/purchase-orders/${r.id}`}>{r.number}</Link> },
              { key: 's', header: 'Supplier', render: (r) => r.supplier_name },
              { key: 'h', header: 'Waiting', align: 'right', render: (r) => <span className={r.hours_waiting > 48 ? 'font-medium text-rose-600' : ''}>{Math.round(r.hours_waiting)} h</span> },
              { key: 'v', header: 'Value', align: 'right', render: (r) => fmtINR(r.total_value) },
            ]} empty={<p className="px-5 py-6 text-center text-[13px] text-slate-500">None.</p>} />
          </Card>
        </div>
      </div>
      <ConfirmDialog open={!!resolve} onClose={() => setResolve(null)} requireReason reasonLabel="Resolution" title="Resolve exception" confirmLabel="Mark resolved"
        onConfirm={async (r) => { await api.post(`/procurement/exceptions/${resolve}/resolve`, { resolution: r }); setResolve(null); qc.invalidateQueries({ queryKey: ['match-overview'] }); toast({ tone: 'success', title: 'Exception resolved' }); }} />
    </>
  );
}
