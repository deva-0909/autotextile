import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { fmtDate, fmtINR, fmtNum } from '../../lib/format';
import { SimpleTable } from '../../components/DataTable';
import { useProducts } from '../../components/business';
import { Drawer, Modal, useToast } from '../../components/overlay';
import { Badge, Button, Card, Checkbox, ErrorState, IconButton, Input, KeyValue, Notice, PageHeader, Select, Skeleton, StatusBadge, Tabs, Textarea } from '../../components/ui';

interface MillRow { id: string; code: string; legal_name: string; gstin: string | null; status: string; profile: { processes?: string[]; capacity_kg_per_day?: number; tat_days?: number }; orders: number; open_orders: number; kg_at_mill: number; avg_tat_days: number | null; on_time_pct: number | null; avg_yield_pct: number | null; open_claims: number; grey_available_kg: number }
interface Card_ { id: string; process_code: string; product_label: string | null; basis: string; rate: number | null; slabs: { upto_kg: number | null; rate: number }[] | null; min_charge: number; negotiated: boolean; effective_from: string; effective_to: string | null; notes: string | null; created_by_name: string }
interface Template { id: string; code: string; name: string; description: string | null; stages: { code: string; name: string }[]; status: string }

const rateText = (c: Card_) => (c.basis === 'per_kg' ? `₹${c.rate}/kg` : c.basis === 'fixed' ? `₹${c.rate} fixed` : (c.slabs ?? []).map((s, i, a) => (s.upto_kg == null ? `>${a[i - 1]?.upto_kg ?? 0} kg ₹${s.rate}` : `≤${s.upto_kg} kg ₹${s.rate}`)).join(' · '));

export function MillsPage() {
  const nav = useNavigate();
  const [tab, setTab] = useState<'mills' | 'processes'>('mills');
  const q = useQuery({ queryKey: ['jw-mills'], queryFn: () => api.get<MillRow[]>('/jobwork/mills') });
  return (
    <>
      <PageHeader title="Mills & rates" description="Processing mills with capability, current load, turnaround, yield and rate cards. Mill master data itself is maintained under Business partners." breadcrumbs={[{ label: 'Mill job work', to: '/jobwork' }, { label: 'Mills & rates' }]} />
      <Tabs className="mb-5" value={tab} onChange={setTab} tabs={[{ value: 'mills', label: 'Mills' }, { value: 'processes', label: 'Process templates' }]} />
      {tab === 'mills' ? (
        <Card padded={false}>
          {!q.data ? <div className="p-5"><Skeleton className="h-40" /></div> : (
            <SimpleTable rows={q.data} rowKey={(r) => r.id} onRowClick={(r) => nav(`/jobwork/mills/${r.id}`)} columns={[
              { key: 'n', header: 'Mill', render: (r) => <div><p className="font-medium text-slate-900">{r.legal_name}</p><p className="text-[12px] text-slate-500">{(r.profile?.processes ?? []).join(', ') || 'Processes not set'}</p></div> },
              { key: 'cap', header: 'Capacity', align: 'right', render: (r) => (r.profile?.capacity_kg_per_day ? `${fmtNum(r.profile?.capacity_kg_per_day)} kg/day` : '—') },
              { key: 'load', header: 'At mill now', align: 'right', render: (r) => `${fmtNum(r.kg_at_mill)} kg` },
              { key: 'grey', header: 'Grey waiting', align: 'right', render: (r) => (r.grey_available_kg ? <Badge tone="violet">{fmtNum(r.grey_available_kg)} kg</Badge> : '—') },
              { key: 'tat', header: 'Avg TAT', align: 'right', render: (r) => (r.avg_tat_days != null ? `${r.avg_tat_days} d` : r.profile?.tat_days ? `${r.profile?.tat_days} d (std)` : '—') },
              { key: 'ot', header: 'On time', align: 'right', render: (r) => (r.on_time_pct != null ? `${r.on_time_pct}%` : '—') },
              { key: 'y', header: 'Avg yield', align: 'right', render: (r) => (r.avg_yield_pct != null ? `${r.avg_yield_pct}%` : '—') },
              { key: 'c', header: 'Open claims', align: 'right', render: (r) => (r.open_claims ? <Badge tone="warning">{r.open_claims}</Badge> : '—') },
            ]} />
          )}
        </Card>
      ) : <Processes />}
    </>
  );
}

export function MillDetailPage() {
  const { id = '' } = useParams();
  const { can } = useAuth();
  const q = useQuery({ queryKey: ['jw-mill', id], queryFn: () => api.get<{ mill: MillRow & { payment_term: string | null }; performance: MillRow; rate_cards: Card_[]; recent_orders: { id: string; number: string; process_name: string; status: string; issue_date: string; kg_sent: number; kg_good: number }[]; claims: { id: string; number: string; status: string; kg_affected: number; amount: number }[]; grey_stock: { id: string; sku: string; kg_available: number; source_ref: string; supplier_name: string; received_date: string }[] }>(`/jobwork/mills/${id}`) });
  const [adding, setAdding] = useState(false);
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  if (!q.data) return <Skeleton className="h-96" />;
  const { mill, performance: p } = q.data;
  const today = new Date().toISOString().slice(0, 10);
  const current = q.data.rate_cards.filter((c) => c.effective_from <= today && (!c.effective_to || c.effective_to >= today));
  return (
    <>
      <PageHeader breadcrumbs={[{ label: 'Mill job work', to: '/jobwork' }, { label: 'Mills & rates', to: '/jobwork/mills' }, { label: mill.code }]} title={<>{mill.legal_name} <StatusBadge status={mill.status} /></>}
        meta={<><span className="font-mono">{mill.gstin}</span><span>{(mill.profile?.processes ?? []).join(' · ')}</span><Link className="link" to={`/partners/mill/${mill.id}`}>Partner record</Link></>}
        actions={can('jobwork.rate.manage') && <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setAdding(true)}>New rate</Button>} />
      <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-5">
        {[['Capacity', mill.profile?.capacity_kg_per_day ? `${fmtNum(mill.profile?.capacity_kg_per_day)} kg/day` : '—'], ['At mill now', `${fmtNum(p.kg_at_mill)} kg`], ['Avg turnaround', p.avg_tat_days != null ? `${p.avg_tat_days} days` : '—'], ['On-time returns', p.on_time_pct != null ? `${p.on_time_pct}%` : '—'], ['Average yield', p.avg_yield_pct != null ? `${p.avg_yield_pct}%` : '—']].map(([l, v]) => <div key={l} className="card p-4"><p className="text-[12px] text-slate-500">{l}</p><p className="text-[18px] font-semibold tabular">{v}</p></div>)}
      </div>
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
        <div className="space-y-6 xl:col-span-2">
          <Card title="Rate cards" description="Most specific active card wins: product, then category, then mill-wide. New rates close the previous one, so history is kept." padded={false}>
            <SimpleTable rows={q.data.rate_cards} rowKey={(r) => r.id} columns={[
              { key: 'p', header: 'Process', render: (r) => <div><p className="font-medium">{r.process_code.replace(/_/g, ' ')}</p><p className="text-[12px] text-slate-500">{r.product_label ?? 'All fabrics'}</p></div> },
              { key: 'r', header: 'Rate', render: (r) => <span className="tabular">{rateText(r)}{r.min_charge > 0 && <span className="block text-[11.5px] text-slate-500">min {fmtINR(r.min_charge)}</span>}</span> },
              { key: 'e', header: 'Effective', render: (r) => <span className="text-[12.5px]">{fmtDate(r.effective_from)} – {r.effective_to ? fmtDate(r.effective_to) : 'open'}</span> },
              { key: 's', header: '', render: (r) => <span className="flex gap-1">{current.includes(r) ? <Badge tone="success">Current</Badge> : <Badge>History</Badge>}{r.negotiated && <Badge tone="violet">Negotiated</Badge>}</span> },
              { key: 'n', header: 'Notes', render: (r) => <span className="text-[12px] text-slate-500">{r.notes ?? ''}</span> },
            ]} empty={<p className="px-5 py-6 text-center text-[13px] text-slate-500">No rates yet. Job-work orders will show “no rate card”.</p>} />
          </Card>
          <Card title="Recent orders" padded={false}>
            <SimpleTable rows={q.data.recent_orders} rowKey={(r) => r.id} columns={[
              { key: 'n', header: 'Order', render: (r) => <Link className="link font-mono text-[12.5px]" to={`/jobwork/orders/${r.id}`}>{r.number}</Link> },
              { key: 'p', header: 'Process', render: (r) => r.process_name },
              { key: 'd', header: 'Issued', render: (r) => fmtDate(r.issue_date) },
              { key: 'k', header: 'Sent / good', align: 'right', render: (r) => `${fmtNum(r.kg_sent)} / ${fmtNum(r.kg_good)}` },
              { key: 's', header: 'Status', render: (r) => <StatusBadge status={r.status} /> },
            ]} />
          </Card>
        </div>
        <div className="space-y-6">
          <Card title="Grey stock waiting at this mill" description="Received on direct-to-mill POs, not yet on a job-work order" padded={false}>
            {q.data.grey_stock.length ? <ul className="divide-y divide-slate-100">{q.data.grey_stock.map((s) => <li key={s.id} className="px-5 py-3 text-[13px]"><p className="font-medium"><span className="font-mono">{s.sku}</span> · {fmtNum(s.kg_available)} kg</p><p className="text-[12px] text-slate-500">{s.source_ref} from {s.supplier_name} · {fmtDate(s.received_date)}</p></li>)}</ul>
              : <p className="px-5 py-4 text-[13px] text-slate-500">None.</p>}
          </Card>
          <Card title="Commercial"><KeyValue columns={1} items={[{ label: 'Payment terms', value: mill.payment_term }, { label: 'Standard turnaround', value: mill.profile?.tat_days ? `${mill.profile?.tat_days} days` : null }, { label: 'Open quality claims', value: p.open_claims }]} /></Card>
        </div>
      </div>
      {adding && <RateCardModal millId={mill.id} onClose={() => setAdding(false)} onSaved={() => { setAdding(false); q.refetch(); }} />}
    </>
  );
}

function RateCardModal({ millId, onClose, onSaved }: { millId: string; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const products = useProducts();
  const templates = useQuery({ queryKey: ['process-templates'], queryFn: () => api.get<Template[]>('/jobwork/process-templates') });
  const [v, setV] = useState({ process_code: '', product_id: '', basis: 'per_kg', rate: '', min_charge: '0', negotiated: false, effective_from: new Date().toISOString().slice(0, 10), notes: '' });
  const [slabs, setSlabs] = useState([{ upto_kg: '1000', rate: '' }, { upto_kg: '', rate: '' }]);
  const [error, setError] = useState<string | null>(null);
  async function save() {
    try {
      await api.post('/jobwork/rate-cards', { mill_id: millId, process_code: v.process_code, product_id: v.product_id || null, basis: v.basis, rate: v.basis === 'slab' ? null : Number(v.rate), slabs: v.basis === 'slab' ? slabs.filter((s) => s.rate).map((s) => ({ upto_kg: s.upto_kg ? Number(s.upto_kg) : null, rate: Number(s.rate) })) : null, min_charge: Number(v.min_charge || 0), negotiated: v.negotiated, effective_from: v.effective_from, notes: v.notes || null });
      toast({ tone: 'success', title: 'Rate saved', body: 'Any previous rate for the same scope now ends the day before.' });
      onSaved();
    } catch (e) { setError((e as Error).message); }
  }
  return (
    <Modal open onClose={onClose} size="lg" title="New processing rate" footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={save}>Save rate</Button></>}>
      <div className="space-y-4">
        {error && <Notice tone="danger">{error}</Notice>}
        <div className="grid grid-cols-2 gap-3">
          <Select label="Process" required placeholder="Select" value={v.process_code} onChange={(e) => setV({ ...v, process_code: e.target.value })} options={templates.data?.map((t) => ({ value: t.code, label: t.name })) ?? []} />
          <Select label="Applies to" placeholder="All fabrics (mill-wide)" value={v.product_id} onChange={(e) => setV({ ...v, product_id: e.target.value })} options={products.data?.map((p) => ({ value: p.id, label: p.sku })) ?? []} />
          <Select label="Basis" value={v.basis} onChange={(e) => setV({ ...v, basis: e.target.value })} options={[{ value: 'per_kg', label: 'Per KG' }, { value: 'fixed', label: 'Fixed per order' }, { value: 'slab', label: 'Slab by quantity' }]} />
          {v.basis !== 'slab' && <Input label={v.basis === 'fixed' ? 'Amount' : 'Rate per KG'} type="number" prefix="₹" value={v.rate} onChange={(e) => setV({ ...v, rate: e.target.value })} />}
          <Input label="Minimum charge" type="number" prefix="₹" value={v.min_charge} onChange={(e) => setV({ ...v, min_charge: e.target.value })} />
          <Input label="Effective from" type="date" value={v.effective_from} onChange={(e) => setV({ ...v, effective_from: e.target.value })} />
        </div>
        {v.basis === 'slab' && (
          <div className="space-y-2 rounded-lg border border-slate-200 p-3">
            {slabs.map((s, i) => (
              <div key={i} className="flex items-end gap-2">
                <Input className="flex-1" label={i === 0 ? 'Up to KG (blank = above)' : undefined} type="number" value={s.upto_kg} onChange={(e) => setSlabs(slabs.map((x, j) => (j === i ? { ...x, upto_kg: e.target.value } : x)))} />
                <Input className="flex-1" label={i === 0 ? 'Rate ₹/kg' : undefined} type="number" value={s.rate} onChange={(e) => setSlabs(slabs.map((x, j) => (j === i ? { ...x, rate: e.target.value } : x)))} />
                <IconButton label="Remove" onClick={() => setSlabs(slabs.filter((_, j) => j !== i))}><Trash2 className="size-4" /></IconButton>
              </div>
            ))}
            <Button size="xs" variant="ghost" icon={<Plus className="size-3" />} onClick={() => setSlabs([...slabs, { upto_kg: '', rate: '' }])}>Add slab</Button>
          </div>
        )}
        <Checkbox label="Negotiated rate" description="Special rate agreed outside the standard card" checked={v.negotiated} onChange={(e) => setV({ ...v, negotiated: e.target.checked })} />
        <Textarea label="Notes" value={v.notes} onChange={(e) => setV({ ...v, notes: e.target.value })} rows={2} />
      </div>
    </Modal>
  );
}

function Processes() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['process-templates'], queryFn: () => api.get<Template[]>('/jobwork/process-templates') });
  const [edit, setEdit] = useState<Template | 'new' | null>(null);
  const [v, setV] = useState({ code: '', name: '', description: '', stages: '', status: 'active' });
  const openEdit = (t: Template | 'new') => { setEdit(t); setV(t === 'new' ? { code: '', name: '', description: '', stages: '', status: 'active' } : { code: t.code, name: t.name, description: t.description ?? '', stages: t.stages.map((s) => s.name).join('\n'), status: t.status }); };
  async function save() {
    const stages = v.stages.split('\n').map((s) => s.trim()).filter(Boolean).map((name) => ({ code: name.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 24), name }));
    try {
      const body = { code: v.code, name: v.name, description: v.description || null, stages, status: v.status };
      if (edit === 'new') await api.post('/jobwork/process-templates', body); else await api.patch(`/jobwork/process-templates/${(edit as Template).id}`, body);
      qc.invalidateQueries({ queryKey: ['process-templates'] }); setEdit(null); toast({ tone: 'success', title: 'Process saved' });
    } catch (e) { toast({ tone: 'error', title: (e as Error).message }); }
  }
  return (
    <Card padded={false} title="Process templates" description="Stages are configurable per process; the mill updates progress against them." actions={can('jobwork.rate.manage') && <Button size="sm" variant="primary" icon={<Plus className="size-3.5" />} onClick={() => openEdit('new')}>Add process</Button>}>
      <SimpleTable rows={q.data ?? []} rowKey={(r) => r.id} onRowClick={can('jobwork.rate.manage') ? openEdit : undefined} columns={[
        { key: 'n', header: 'Process', render: (r) => <div><p className="font-medium">{r.name}</p><p className="font-mono text-[11.5px] text-slate-500">{r.code}</p></div> },
        { key: 's', header: 'Stages', render: (r) => <span className="text-[12.5px] text-slate-600">{r.stages.map((s) => s.name).join(' → ')}</span> },
        { key: 'st', header: 'Status', render: (r) => <StatusBadge status={r.status} /> },
      ]} />
      <Drawer open={!!edit} onClose={() => setEdit(null)} title={edit === 'new' ? 'New process' : 'Edit process'} footer={<><Button onClick={() => setEdit(null)}>Cancel</Button><Button variant="primary" onClick={save}>Save</Button></>}>
        <div className="space-y-4">
          <div className="grid grid-cols-3 gap-3"><Input label="Code" disabled={edit !== 'new'} value={v.code} onChange={(e) => setV({ ...v, code: e.target.value.toUpperCase() })} /><Input className="col-span-2" label="Name" value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} /></div>
          <Input label="Description" value={v.description} onChange={(e) => setV({ ...v, description: e.target.value })} />
          <Textarea label="Stages, one per line, in order" rows={8} value={v.stages} onChange={(e) => setV({ ...v, stages: e.target.value })} />
          <Select label="Status" value={v.status} onChange={(e) => setV({ ...v, status: e.target.value })} options={[{ value: 'active', label: 'Active' }, { value: 'inactive', label: 'Inactive' }]} />
        </div>
      </Drawer>
    </Card>
  );
}
