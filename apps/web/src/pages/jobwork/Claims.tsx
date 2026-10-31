import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Link } from '../../components/AppLink';
import { api, invalidatePrefix } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { fmtDateTime, fmtINR, fmtNum, humanize } from '../../lib/format';
import { DataTable, FilterSelect } from '../../components/DataTable';
import { DocumentsPanel } from '../../components/Documents';
import { Drawer, useToast } from '../../components/overlay';
import { Badge, Button, Input, KeyValue, Notice, PageHeader, Select, Skeleton, StatusBadge, Textarea } from '../../components/ui';

interface Claim { id: string; number: string; job_order_id: string; job_number: string; mill_name: string; defect_types: string[]; description: string; kg_affected: number; samples: string | null; root_cause: string | null; responsibility: string; claim_type: string; amount: number; status: string; mill_response: string | null; mill_response_at: string | null; resolution: string | null; raised_by_name: string; created_at: string }

export function ClaimsPage() {
  const [params, setParams] = useSearchParams();
  const [filters, setFilters] = useState<Record<string, string>>({ status: 'open,under_review' });
  const open = params.get('open');
  return (
    <>
      <PageHeader title="Mill quality claims" description="Defects found after processing: evidence, mill response, root cause, responsibility and settlement (debit note, rework or replacement)." breadcrumbs={[{ label: 'Mill job work', to: '/jobwork' }, { label: 'Quality claims' }]} />
      <DataTable<Claim>
        id="claims" endpoint="/jobwork/claims" filters={filters} onFiltersChange={setFilters} defaultSort={{ key: 'created_at', dir: 'desc' }} onRowClick={(r) => setParams({ open: r.id })}
        toolbar={<FilterSelect placeholder="All claims" value={filters.status} onChange={(v) => setFilters({ ...filters, status: v })} options={[{ value: 'open,under_review', label: 'Open' }, { value: 'accepted', label: 'Accepted' }, { value: 'rejected', label: 'Rejected' }, { value: 'closed', label: 'Closed' }]} />}
        columns={[
          { key: 'n', header: 'Claim', sort: 'number', csv: (r) => r.number, render: (r) => <span className="font-mono text-[12.5px] font-semibold">{r.number}</span> },
          { key: 'm', header: 'Mill / order', csv: (r) => r.mill_name, render: (r) => <div><p>{r.mill_name}</p><p className="font-mono text-[12px] text-slate-500">{r.job_number}</p></div> },
          { key: 'd', header: 'Defects', csv: (r) => r.defect_types.join('; '), render: (r) => <div className="flex flex-wrap gap-1">{r.defect_types.map((t) => <Badge key={t} tone="danger">{t}</Badge>)}</div> },
          { key: 'kg', header: 'KG', align: 'right', csv: (r) => r.kg_affected, render: (r) => fmtNum(r.kg_affected) },
          { key: 'a', header: 'Claim', align: 'right', sort: 'amount', csv: (r) => r.amount, render: (r) => <span>{humanize(r.claim_type)}{r.amount ? ` · ${fmtINR(r.amount)}` : ''}</span> },
          { key: 'mr', header: 'Mill response', csv: (r) => r.mill_response, render: (r) => (r.mill_response ? <Badge tone="info">Responded</Badge> : <span className="text-slate-400">Awaiting</span>) },
          { key: 's', header: 'Status', sort: 'status', csv: (r) => r.status, render: (r) => <StatusBadge status={r.status} /> },
        ]}
        empty={{ title: 'No claims' }}
      />
      {open && <ClaimDrawer id={open} onClose={() => setParams({})} />}
    </>
  );
}

function ClaimDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const { can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['claim', id], queryFn: () => api.get<Claim>(`/jobwork/claims/${id}`) });
  const [v, setV] = useState({ status: 'open', root_cause: '', responsibility: 'undetermined', claim_type: 'debit_note', amount: '0', resolution: '' });
  useEffect(() => { const c = q.data; if (c) setV({ status: c.status, root_cause: c.root_cause ?? '', responsibility: c.responsibility, claim_type: c.claim_type, amount: String(c.amount), resolution: c.resolution ?? '' }); }, [q.data]);
  const c = q.data;
  const editable = c && c.status !== 'closed' && can('jobwork.claim.manage');
  return (
    <Drawer open onClose={onClose} width="lg" title={c ? `${c.number} · ${c.mill_name}` : 'Claim'} description={c && <StatusBadge status={c.status} />}
      footer={editable && <Button variant="primary" onClick={async () => {
        try { await api.patch(`/jobwork/claims/${id}`, { ...v, amount: Number(v.amount || 0), root_cause: v.root_cause || null, resolution: v.resolution || null }); q.refetch(); invalidatePrefix(qc, '/jobwork/claims'); toast({ tone: 'success', title: 'Claim updated' }); } catch (e) { toast({ tone: 'error', title: (e as Error).message }); }
      }}>Save</Button>}>
      {!c ? <Skeleton className="h-64" /> : (
        <div className="space-y-6">
          <KeyValue columns={2} items={[{ label: 'Job-work order', value: <Link className="link" to={`/jobwork/orders/${c.job_order_id}`}>{c.job_number}</Link> }, { label: 'KG affected', value: fmtNum(c.kg_affected) }, { label: 'Raised by', value: `${c.raised_by_name} · ${fmtDateTime(c.created_at)}` }, { label: 'Samples', value: c.samples }]} />
          <div className="flex flex-wrap gap-1">{c.defect_types.map((t) => <Badge key={t} tone="danger">{t}</Badge>)}</div>
          <p className="rounded-lg bg-slate-50 px-4 py-3 text-[13px] text-slate-700">{c.description}</p>
          {c.mill_response ? <Notice tone="info" title={`Mill response · ${fmtDateTime(c.mill_response_at)}`}>{c.mill_response}</Notice> : <Notice tone="warning">The mill has not responded on its portal yet.</Notice>}
          <fieldset disabled={!editable} className="grid grid-cols-2 gap-3">
            <Select label="Status" value={v.status} onChange={(e) => setV({ ...v, status: e.target.value })} options={['open', 'under_review', 'accepted', 'rejected', 'closed'].map((s) => ({ value: s, label: humanize(s) }))} />
            <Select label="Responsibility" value={v.responsibility} onChange={(e) => setV({ ...v, responsibility: e.target.value })} options={['mill', 'supplier', 'internal', 'undetermined'].map((s) => ({ value: s, label: humanize(s) }))} />
            <Select label="Settlement" value={v.claim_type} onChange={(e) => setV({ ...v, claim_type: e.target.value })} options={[{ value: 'debit_note', label: 'Debit note' }, { value: 'rework', label: 'Rework' }, { value: 'replacement', label: 'Replacement' }, { value: 'none', label: 'None' }]} />
            <Input label="Amount" type="number" prefix="₹" value={v.amount} onChange={(e) => setV({ ...v, amount: e.target.value })} />
            <Textarea className="col-span-2" label="Root cause" value={v.root_cause} onChange={(e) => setV({ ...v, root_cause: e.target.value })} />
            <Textarea className="col-span-2" label="Resolution" required={['accepted', 'rejected', 'closed'].includes(v.status)} value={v.resolution} onChange={(e) => setV({ ...v, resolution: e.target.value })} hint="Accepted debit-note claims are handed to accounting (P8) for the debit note" />
          </fieldset>
          <div><p className="mb-2 text-[13px] font-semibold">Evidence</p><DocumentsPanel entityType="quality_claim" entityId={c.id} /></div>
        </div>
      )}
    </Drawer>
  );
}
