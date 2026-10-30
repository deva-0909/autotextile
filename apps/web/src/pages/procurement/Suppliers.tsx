import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, Circle, Medal } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../lib/api';
import { fmtDate, fmtINR, fmtNum, GST_STATES } from '../../lib/format';
import { SimpleTable } from '../../components/DataTable';
import { Drawer } from '../../components/overlay';
import { Badge, Card, PageHeader, Skeleton, StatusBadge, type Tone } from '../../components/ui';

interface Row { id: string; code: string; legal_name: string; party_type: string; gstin: string | null; state_code: string | null; status: string; pos: number; po_value: number; avg_lead_days: number | null; open_exceptions: number; score: number | null; on_time_pct: number | null; rejection_pct: number | null; fill_rate_pct: number | null; invoice_accuracy_pct: number | null }
interface Detail { score: number | null; on_time_pct: number | null; rejection_pct: number | null; fill_rate_pct: number | null; invoice_accuracy_pct: number | null; kyc: { item: string; ok: boolean }[]; kyc_complete: boolean; risk_score: number; risk_level: string; performance: { pos: number; po_value: number; avg_lead_days: number | null } | null;
  price_history: { sku: string; product_name: string; order_date: string; rate_per_kg: number; qty_kg: number; number: string }[]; recent_orders: { id: string; number: string; order_date: string; status: string; total_value: number; deliver_to_name: string }[]; disputes: { id: string; kind: string; message: string; status: string }[] }

const scoreTone = (s: number | null): Tone => (s == null ? 'neutral' : s >= 80 ? 'success' : s >= 60 ? 'warning' : 'danger');

export function SuppliersPage() {
  const q = useQuery({ queryKey: ['scorecards'], queryFn: () => api.get<Row[]>('/procurement/suppliers/scorecards') });
  const [open, setOpen] = useState<Row | null>(null);
  return (
    <>
      <PageHeader title="Supplier scorecards" description="Delivery, quality and invoice accuracy from actual purchase orders, receipts and matching, plus onboarding (KYC) completeness. Scores guide; they never place orders." breadcrumbs={[{ label: 'Procurement', to: '/procurement' }, { label: 'Supplier scorecards' }]} />
      <Card padded={false}>
        {!q.data ? <div className="p-5"><Skeleton className="h-40" /></div> : (
          <SimpleTable rows={q.data} rowKey={(r) => r.id} onRowClick={setOpen} columns={[
            { key: 'name', header: 'Supplier', render: (r) => <div><p className="font-medium text-slate-900">{r.legal_name}</p><p className="text-[12px] text-slate-500">{r.code} · {r.state_code ? GST_STATES[r.state_code] : '—'}</p></div> },
            { key: 'score', header: 'Score', render: (r) => (r.score != null ? <Badge tone={scoreTone(r.score)}><Medal className="size-3" />{r.score}</Badge> : <span className="text-[12px] text-slate-400">No history</span>) },
            { key: 'ot', header: 'On time', align: 'right', render: (r) => (r.on_time_pct != null ? `${r.on_time_pct}%` : '—') },
            { key: 'rej', header: 'Rejected', align: 'right', render: (r) => (r.rejection_pct != null ? `${r.rejection_pct}%` : '—') },
            { key: 'fill', header: 'Fill rate', align: 'right', render: (r) => (r.fill_rate_pct != null ? `${r.fill_rate_pct}%` : '—') },
            { key: 'lead', header: 'Avg lead', align: 'right', render: (r) => (r.avg_lead_days != null ? `${r.avg_lead_days} d` : '—') },
            { key: 'pos', header: 'POs', align: 'right', render: (r) => `${r.pos} · ${fmtINR(r.po_value)}` },
            { key: 'ex', header: 'Open issues', align: 'right', render: (r) => (r.open_exceptions ? <Badge tone="warning">{r.open_exceptions}</Badge> : '—') },
            { key: 'st', header: 'Status', render: (r) => <StatusBadge status={r.status} /> },
          ]} />
        )}
      </Card>
      {open && <ScorecardDrawer row={open} onClose={() => setOpen(null)} />}
    </>
  );
}

function ScorecardDrawer({ row, onClose }: { row: Row; onClose: () => void }) {
  const q = useQuery({ queryKey: ['scorecard', row.id], queryFn: () => api.get<Detail>(`/procurement/suppliers/${row.id}/scorecard`) });
  const d = q.data;
  const metrics = d ? [['Score', d.score != null ? `${d.score}/100` : '—'], ['On-time delivery', d.on_time_pct != null ? `${d.on_time_pct}%` : '—'], ['Rejection rate', d.rejection_pct != null ? `${d.rejection_pct}%` : '—'], ['Fill rate', d.fill_rate_pct != null ? `${d.fill_rate_pct}%` : '—'], ['Invoice accuracy', d.invoice_accuracy_pct != null ? `${d.invoice_accuracy_pct}%` : '—'], ['Avg lead time', d.performance?.avg_lead_days != null ? `${d.performance.avg_lead_days} days` : '—']] : [];
  return (
    <Drawer open onClose={onClose} width="lg" title={row.legal_name} description={<span className="font-mono">{row.code} · {row.gstin ?? 'Unregistered'}</span>}>
      {!d ? <Skeleton className="h-96" /> : (
        <div className="space-y-6">
          <div className="grid grid-cols-3 gap-3">{metrics.map(([l, v]) => <div key={l} className="rounded-lg border border-slate-200 px-3 py-2.5"><p className="text-[11.5px] text-slate-500">{l}</p><p className="text-[16px] font-semibold tabular">{v}</p></div>)}</div>
          <div className="flex items-center gap-3 rounded-lg border border-slate-200 p-4">
            <div className="flex-1"><p className="text-[13px] font-semibold">Risk</p><p className="text-[12px] text-slate-500">Weighted from KYC gaps, delivery history and open issues</p></div>
            <Badge tone={d.risk_level === 'high' ? 'danger' : d.risk_level === 'medium' ? 'warning' : 'success'}>{d.risk_level} · {d.risk_score}</Badge>
          </div>
          <Card title="Onboarding (KYC)" description={d.kyc_complete ? 'Complete' : 'Upload missing items on the partner record'} actions={<Link className="link text-[12.5px]" to={`/partners/${row.party_type}/${row.id}`}>Open record</Link>}>
            <ul className="space-y-2">{d.kyc.map((k) => <li key={k.item} className="flex items-center gap-2 text-[13px]">{k.ok ? <CheckCircle2 className="size-4 text-emerald-500" /> : <Circle className="size-4 text-slate-300" />}{k.item}</li>)}</ul>
          </Card>
          <Card title="Price history" padded={false}>
            <SimpleTable rows={d.price_history} rowKey={(r) => `${r.number}-${r.sku}`} columns={[
              { key: 'd', header: 'Date', render: (r) => fmtDate(r.order_date) },
              { key: 's', header: 'SKU', render: (r) => <span className="font-mono text-[12.5px]">{r.sku}</span> },
              { key: 'q', header: 'KG', align: 'right', render: (r) => fmtNum(r.qty_kg) },
              { key: 'r', header: '₹/kg', align: 'right', render: (r) => r.rate_per_kg },
              { key: 'p', header: 'PO', render: (r) => <span className="font-mono text-[12px] text-slate-500">{r.number}</span> },
            ]} empty={<p className="px-5 py-6 text-center text-[13px] text-slate-500">No purchases yet.</p>} />
          </Card>
          {d.disputes.length > 0 && <Card title="Issues & disputes"><ul className="space-y-2 text-[13px]">{d.disputes.map((x) => <li key={x.id} className="flex gap-2"><StatusBadge status={x.status} />{x.message}</li>)}</ul></Card>}
        </div>
      )}
    </Drawer>
  );
}
