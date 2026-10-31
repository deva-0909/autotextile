import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, FileSearch, Plus, Send, XCircle } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Link } from '../../components/AppLink';
import { api, invalidatePrefix } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { fmtDate, fmtNum } from '../../lib/format';
import { DataTable, FilterSelect, SimpleTable } from '../../components/DataTable';
import { DeliverTo, LineEditor, emptyLine, type Line } from '../../components/business';
import { ConfirmDialog, Drawer, useToast } from '../../components/overlay';
import { Button, Input, KeyValue, Notice, PageHeader, Skeleton, StatusBadge, Textarea } from '../../components/ui';

interface PR { id: string; number: string; title: string; deliver_to_type: 'warehouse' | 'mill'; deliver_to_id: string; deliver_to_name: string; required_by: string; purpose: string | null; status: string; requested_by: string; requested_by_name: string; decided_by_name: string | null; decision_comment: string | null; line_count: number; total_kg: number; version: number; created_at: string }
interface PRDetail extends PR { lines: { product_id: string; sku: string; product_name: string; qty_kg: number; target_rate: number | null }[]; rfqs: { id: string; number: string; status: string }[]; purchase_orders: { id: string; number: string; status: string }[] }

export function RequisitionsPage() {
  const { can } = useAuth();
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [open, setOpen] = useState<string | 'new' | null>(null);
  return (
    <>
      <PageHeader title="Purchase requisitions" description="Internal requests for fabric. An approver other than the requester signs them off before sourcing." breadcrumbs={[{ label: 'Procurement', to: '/procurement' }, { label: 'Requisitions' }]}
        actions={can('procurement.requisition.create') && <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setOpen('new')}>New requisition</Button>} />
      <DataTable<PR>
        id="requisitions" endpoint="/procurement/requisitions" filters={filters} onFiltersChange={setFilters} defaultSort={{ key: 'created_at', dir: 'desc' }} onRowClick={(r) => setOpen(r.id)}
        toolbar={<FilterSelect placeholder="All statuses" value={filters.status} onChange={(v) => setFilters({ ...filters, status: v })} options={['draft', 'submitted', 'approved', 'rejected', 'converted', 'cancelled'].map((s) => ({ value: s, label: s[0]!.toUpperCase() + s.slice(1) }))} />}
        columns={[
          { key: 'number', header: 'Number', sort: 'number', csv: (r) => r.number, render: (r) => <span className="font-mono text-[12.5px] font-semibold text-slate-900">{r.number}</span> },
          { key: 'title', header: 'Title', csv: (r) => r.title, render: (r) => <div><p className="text-slate-900">{r.title}</p><p className="text-[12px] text-slate-500">{r.requested_by_name}</p></div> },
          { key: 'to', header: 'Deliver to', csv: (r) => r.deliver_to_name, render: (r) => r.deliver_to_name },
          { key: 'kg', header: 'Quantity', align: 'right', csv: (r) => r.total_kg, render: (r) => fmtNum(r.total_kg, 'kg') },
          { key: 'by', header: 'Required by', sort: 'required_by', csv: (r) => r.required_by, render: (r) => fmtDate(r.required_by) },
          { key: 'status', header: 'Status', sort: 'status', csv: (r) => r.status, render: (r) => <StatusBadge status={r.status} /> },
        ]}
        empty={{ title: 'No requisitions yet' }}
      />
      {open === 'new' && <RequisitionForm onClose={() => setOpen(null)} />}
      {open && open !== 'new' && <RequisitionDrawer id={open} onClose={() => setOpen(null)} />}
    </>
  );
}

function RequisitionForm({ pr, onClose }: { pr?: PRDetail; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [title, setTitle] = useState(pr?.title ?? '');
  const [dest, setDest] = useState<{ type: 'warehouse' | 'mill'; id: string }>({ type: pr?.deliver_to_type ?? 'warehouse', id: pr?.deliver_to_id ?? '' });
  const [requiredBy, setRequiredBy] = useState(pr?.required_by ?? '');
  const [purpose, setPurpose] = useState(pr?.purpose ?? '');
  const [lines, setLines] = useState<Line[]>(pr ? pr.lines.map((l) => ({ product_id: l.product_id, qty_kg: String(l.qty_kg), rate: l.target_rate ? String(l.target_rate) : '' })) : [emptyLine()]);
  const [error, setError] = useState<{ message?: string; fields: Record<string, string> }>({ fields: {} });
  const [saving, setSaving] = useState(false);
  async function save() {
    setSaving(true);
    try {
      const body = { title, deliver_to_type: dest.type, deliver_to_id: dest.id, required_by: requiredBy, purpose, lines: lines.filter((l) => l.product_id).map((l) => ({ product_id: l.product_id, qty_kg: Number(l.qty_kg), target_rate: l.rate ? Number(l.rate) : null })), version: pr?.version };
      if (pr) await api.patch(`/procurement/requisitions/${pr.id}`, body); else await api.post('/procurement/requisitions', body);
      invalidatePrefix(qc, '/procurement/requisitions');
      qc.invalidateQueries({ queryKey: ['requisition'] });
      toast({ tone: 'success', title: pr ? 'Requisition updated' : 'Requisition created as draft' });
      onClose();
    } catch (e) { setError({ message: (e as Error).message, fields: (e as { fields?: Record<string, string> }).fields ?? {} }); } finally { setSaving(false); }
  }
  return (
    <Drawer open onClose={onClose} width="xl" title={pr ? `Edit ${pr.number}` : 'New requisition'} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={saving} onClick={save}>Save draft</Button></>}>
      <div className="space-y-5">
        {error.message && <Notice tone="danger">{error.message}</Notice>}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Input label="Title" required className="sm:col-span-2" value={title} onChange={(e) => setTitle(e.target.value)} error={error.fields.title} />
          <Input label="Required by" type="date" required value={requiredBy} onChange={(e) => setRequiredBy(e.target.value)} error={error.fields.required_by} />
        </div>
        <DeliverTo type={dest.type} id={dest.id} onChange={(type, id) => setDest({ type, id })} error={error.fields.deliver_to_id} />
        <LineEditor lines={lines} onChange={setLines} withRate rateLabel="Target ₹/kg" error={error.fields.lines} />
        <Textarea label="Purpose / notes" value={purpose} onChange={(e) => setPurpose(e.target.value)} />
      </div>
    </Drawer>
  );
}

function RequisitionDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const { can, user } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const nav = useNavigate();
  const q = useQuery({ queryKey: ['requisition', id], queryFn: () => api.get<PRDetail>(`/procurement/requisitions/${id}`) });
  const [edit, setEdit] = useState(false);
  const [dialog, setDialog] = useState<'reject' | 'cancel' | null>(null);
  const refresh = () => { invalidatePrefix(qc, '/procurement/requisitions'); q.refetch(); };
  const act = async (path: string, body?: object, msg?: string) => {
    try { await api.post(`/procurement/requisitions/${id}/${path}`, body); refresh(); if (msg) toast({ tone: 'success', title: msg }); } catch (e) { toast({ tone: 'error', title: (e as Error).message }); }
  };
  const pr = q.data;
  if (edit && pr) return <RequisitionForm pr={pr} onClose={() => { setEdit(false); q.refetch(); }} />;
  const own = pr?.requested_by === user?.id;
  return (
    <Drawer open onClose={onClose} width="lg" title={pr ? `${pr.number} · ${pr.title}` : 'Requisition'} description={pr && <StatusBadge status={pr.status} />}
      footer={pr && <>
        {['draft', 'rejected'].includes(pr.status) && can('procurement.requisition.create') && <Button onClick={() => setEdit(true)}>Edit</Button>}
        {pr.status === 'draft' && can('procurement.requisition.create') && <Button variant="primary" icon={<Send className="size-4" />} onClick={() => act('submit', undefined, 'Submitted for approval')}>Submit</Button>}
        {pr.status === 'submitted' && can('procurement.requisition.approve') && !own && <>
          <Button variant="danger" icon={<XCircle className="size-4" />} onClick={() => setDialog('reject')}>Reject</Button>
          <Button variant="primary" icon={<CheckCircle2 className="size-4" />} onClick={() => act('decide', { decision: 'approved' }, 'Requisition approved')}>Approve</Button>
        </>}
        {pr.status === 'approved' && can('procurement.rfq.manage') && <Button variant="primary" icon={<FileSearch className="size-4" />} onClick={() => nav(`/procurement/rfqs?fromRequisition=${pr.id}`)}>Create RFQ</Button>}
        {['draft', 'submitted', 'approved', 'rejected'].includes(pr.status) && can('procurement.requisition.create') && <Button variant="ghost" onClick={() => setDialog('cancel')}>Cancel requisition</Button>}
      </>}>
      {!pr ? <Skeleton className="h-64" /> : (
        <div className="space-y-6">
          {pr.status === 'submitted' && own && <Notice tone="info">Waiting for an approver other than you.</Notice>}
          {pr.decision_comment && <Notice tone={pr.status === 'rejected' ? 'danger' : 'success'} title={`${pr.status === 'rejected' ? 'Rejected' : 'Approved'} by ${pr.decided_by_name}`}>{pr.decision_comment}</Notice>}
          <KeyValue columns={3} items={[{ label: 'Requested by', value: pr.requested_by_name }, { label: 'Deliver to', value: pr.deliver_to_name }, { label: 'Required by', value: fmtDate(pr.required_by) }]} />
          {pr.purpose && <p className="rounded-lg bg-slate-50 px-4 py-3 text-[13px] text-slate-700">{pr.purpose}</p>}
          <div className="overflow-hidden rounded-lg border border-slate-200">
            <SimpleTable rows={pr.lines} rowKey={(l) => l.product_id} columns={[
              { key: 'sku', header: 'Fabric', render: (l) => <div><p className="font-mono text-[12.5px] font-semibold">{l.sku}</p><p className="text-[12px] text-slate-500">{l.product_name}</p></div> },
              { key: 'kg', header: 'KG', align: 'right', render: (l) => fmtNum(l.qty_kg) },
              { key: 'rate', header: 'Target ₹/kg', align: 'right', render: (l) => fmtNum(l.target_rate) },
            ]} />
          </div>
          {(pr.rfqs.length > 0 || pr.purchase_orders.length > 0) && (
            <div className="text-[13px]">
              <p className="mb-1 font-medium">Sourcing</p>
              {pr.rfqs.map((r) => <p key={r.id}><Link className="link" to={`/procurement/rfqs/${r.id}`}>{r.number}</Link> · {r.status}</p>)}
              {pr.purchase_orders.map((p) => <p key={p.id}><Link className="link" to={`/procurement/purchase-orders/${p.id}`}>{p.number}</Link> · {p.status}</p>)}
            </div>
          )}
        </div>
      )}
      <ConfirmDialog open={dialog === 'reject'} onClose={() => setDialog(null)} requireReason tone="danger" title="Reject requisition?" confirmLabel="Reject" onConfirm={(r) => { setDialog(null); void act('decide', { decision: 'rejected', comment: r }, 'Requisition rejected'); }} />
      <ConfirmDialog open={dialog === 'cancel'} onClose={() => setDialog(null)} requireReason tone="danger" title="Cancel requisition?" confirmLabel="Cancel requisition" onConfirm={(r) => { setDialog(null); void act('cancel', { reason: r }, 'Requisition cancelled'); }} />
    </Drawer>
  );
}

