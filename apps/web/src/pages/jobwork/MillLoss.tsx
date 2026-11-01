import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../lib/api';
import { fmtDate, fmtINR, fmtNum } from '../../lib/format';
import { SimpleTable } from '../../components/DataTable';
import { Badge, Card, ErrorState, Input, PageHeader, Skeleton, Tabs } from '../../components/ui';

interface Row { mill_id: string; mill_name: string; process_name: string; orders: number; kg_sent: number; kg_good: number; kg_rejected: number; kg_damaged: number; kg_process_loss: number; kg_quarantine: number; kg_at_mill: number; claims: number; claims_accepted: number; loss_pct: number | null; yield_pct: number | null }
interface Hold { id: string; number: string; job_order_id: string; job_number: string; mill_name: string; kg: number; reason_type: string; description: string; status: string; created_at: string; resolution: string | null; challan_no: string | null }
const REASON: Record<string, string> = { other_party: 'Another party’s fabric', wrong_shade: 'Wrong shade', wrong_gsm: 'Wrong GSM', wrong_quality: 'Wrong quality', other: 'Other' };

/** Loss % by mill and process, and the wrong goods held in quarantine. */
export function MillLossPage() {
  const nav = useNavigate();
  const [tab, setTab] = useState<'loss' | 'quarantine'>('loss');
  const [from, setFrom] = useState(new Date(Date.now() - 180 * 86_400_000).toISOString().slice(0, 10));
  const [to, setTo] = useState(new Date().toISOString().slice(0, 10));
  const q = useQuery({ queryKey: ['jw-loss', from, to], queryFn: () => api.get<Row[]>(`/jobwork/analytics/mill-loss?from=${from}&to=${to}`) });
  const holds = useQuery({ queryKey: ['jw-quarantine'], queryFn: () => api.get<Hold[]>('/jobwork/quarantine?status=all') });
  if (q.isError) return <ErrorState error={q.error} />;
  const worst = Math.max(0, ...(q.data ?? []).map((r) => r.loss_pct ?? 0));
  return (
    <>
      <PageHeader title="Mill losses" description="What went to each mill, what came back good, what was lost, held back or claimed — to compare mills and processes. Wrong goods returned are held in quarantine until resolved."
        breadcrumbs={[{ label: 'Mill job work', to: '/jobwork' }, { label: 'Mill losses' }]}
        actions={tab === 'loss' && <div className="flex items-end gap-2"><Input label="Issued from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /><Input label="To" type="date" value={to} onChange={(e) => setTo(e.target.value)} /></div>} />
      <Tabs className="mb-4" value={tab} onChange={setTab} tabs={[{ value: 'loss', label: 'Loss by mill and process' }, { value: 'quarantine', label: 'Quarantine', count: (holds.data ?? []).filter((h) => h.status === 'held').length }]} />
      {tab === 'loss' && (!q.data ? <Skeleton className="h-60" /> : (
        <Card padded={false}>
          <SimpleTable rows={q.data} rowKey={(r) => `${r.mill_id}-${r.process_name}`} csvName="mill-losses" empty="No job work in this period" columns={[
            { key: 'm', header: 'Mill', render: (r) => <span className="font-medium">{r.mill_name}</span> },
            { key: 'p', header: 'Process', render: (r) => r.process_name },
            { key: 'o', header: 'Orders', align: 'right', render: (r) => r.orders },
            { key: 's', header: 'Sent', align: 'right', render: (r) => fmtNum(r.kg_sent, 'kg') },
            { key: 'g', header: 'Good', align: 'right', render: (r) => <span className="text-emerald-700">{fmtNum(r.kg_good)}</span> },
            { key: 'l', header: 'Rejected · damaged · process loss', align: 'right', render: (r) => `${fmtNum(r.kg_rejected)} · ${fmtNum(r.kg_damaged)} · ${fmtNum(r.kg_process_loss)}` },
            { key: 'lp', header: 'Loss %', align: 'right', render: (r) => (r.loss_pct == null ? '—' : <Badge tone={r.loss_pct === worst && worst > 0 ? 'danger' : r.loss_pct > 5 ? 'warning' : 'success'}>{r.loss_pct}%</Badge>) },
            { key: 'q', header: 'Quarantine', align: 'right', render: (r) => (r.kg_quarantine ? <span className="text-violet-700">{fmtNum(r.kg_quarantine)}</span> : '—') },
            { key: 'a', header: 'Still at mill', align: 'right', render: (r) => fmtNum(r.kg_at_mill) },
            { key: 'c', header: 'Claims · accepted', align: 'right', render: (r) => `${r.claims} · ${fmtINR(r.claims_accepted)}` },
          ]} />
        </Card>
      ))}
      {tab === 'quarantine' && (!holds.data ? <Skeleton className="h-60" /> : (
        <Card padded={false}>
          <SimpleTable rows={holds.data} rowKey={(r) => r.id} onRowClick={(r) => nav(`/jobwork/orders/${r.job_order_id}`)} empty="Nothing held" columns={[
            { key: 'n', header: 'Hold', render: (r) => <span className="font-mono text-[12.5px]">{r.number}</span> },
            { key: 'j', header: 'Order', render: (r) => `${r.job_number} · ${r.mill_name}` },
            { key: 'k', header: 'KG', align: 'right', render: (r) => fmtNum(r.kg) },
            { key: 'w', header: 'What is wrong', render: (r) => <span>{REASON[r.reason_type]}<span className="block text-[12px] text-slate-500">{r.description}</span></span> },
            { key: 's', header: 'Status', render: (r) => <Badge tone={r.status === 'held' ? 'warning' : 'neutral'}>{{ held: 'Held', returned_to_mill: 'Sent back', rework: 'Rework', accepted: 'Accepted' }[r.status]}</Badge> },
            { key: 'r', header: 'Resolution', render: (r) => <span className="text-[12.5px]">{r.challan_no ? `${r.challan_no} · ` : ''}{r.resolution ?? '—'}</span> },
            { key: 'd', header: 'Held on', render: (r) => fmtDate(r.created_at) },
          ]} />
        </Card>
      ))}
    </>
  );
}
