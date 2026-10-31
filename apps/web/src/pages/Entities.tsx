import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Building2, ChevronRight, GitBranch, Landmark, Pencil, Plus, Warehouse } from 'lucide-react';
import { useState } from 'react';
import { Link } from '../components/AppLink';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { GST_STATES, fmtDate, gstinProblem, humanize } from '../lib/format';
import { clean, useForm } from '../components/form';
import { Drawer, useToast } from '../components/overlay';
import { Badge, Button, Card, ErrorState, Input, Notice, PageHeader, Select, Skeleton, StatusBadge, Switch, Textarea } from '../components/ui';

interface Entity { id: string; code: string; legal_name: string; trade_name: string | null; constitution: string; pan: string; cin: string | null; registered_address: string | null; state_code: string | null; pincode: string | null; email: string | null; phone: string | null; status: string; version: number; gst_count: number }
interface Gst { id: string; legal_entity_id: string; gstin: string; state_code: string; state_name: string; registration_type: string; trade_name: string | null; principal_address: string | null; effective_from: string; effective_to: string | null; e_invoice_applicable: boolean; status: string; version: number; branch_count: number; warehouse_count: number }
interface Branch { id: string; gst_registration_id: string; code: string; name: string; city: string | null; address: string | null; pincode: string | null; is_principal_place: boolean; status: string; version: number; warehouse_count: number }
interface Wh { id: string; code: string; name: string; branch_id: string; city: string; dispatch_priority: number; status: string }

const STATE_OPTIONS = Object.entries(GST_STATES).map(([code, name]) => ({ value: code, label: `${code} · ${name}` }));
const CONSTITUTIONS = ['private_limited', 'public_limited', 'llp', 'partnership', 'proprietorship', 'other'].map((v) => ({ value: v, label: humanize(v) }));

export function EntitiesPage() {
  const { can } = useAuth();
  const entities = useQuery({ queryKey: ['entities'], queryFn: () => api.get<Entity[]>('/organisation/entities') });
  const gsts = useQuery({ queryKey: ['gst-registrations'], queryFn: () => api.get<Gst[]>('/organisation/gst-registrations') });
  const branches = useQuery({ queryKey: ['branches'], queryFn: () => api.get<Branch[]>('/organisation/branches') });
  const whs = useQuery({ queryKey: ['warehouses'], queryFn: () => api.get<Wh[]>('/organisation/warehouses'), enabled: can('org.warehouse.read') });
  const [editEntity, setEditEntity] = useState<Entity | 'new' | null>(null);
  const [editGst, setEditGst] = useState<{ gst?: Gst; entityId: string } | null>(null);
  const [editBranch, setEditBranch] = useState<{ branch?: Branch; gstId: string } | null>(null);
  const manage = can('org.entity.manage');

  if (entities.isError) return <ErrorState error={entities.error} onRetry={() => entities.refetch()} />;

  return (
    <>
      <PageHeader
        title="Legal entities & GST registrations"
        description="Legal Entity → GST Registration → Branch / place of business → Warehouse. Each level is configured separately; nothing is hard-coded."
        breadcrumbs={[{ label: 'Organisation' }, { label: 'Entities & GST' }]}
        actions={manage && <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setEditEntity('new')}>Add legal entity</Button>}
      />
      <div className="space-y-6">
        {!entities.data && <Skeleton className="h-64" />}
        {entities.data?.map((e) => (
          <Card key={e.id} padded={false}>
            <div className="flex flex-wrap items-start justify-between gap-4 border-b border-slate-100 px-5 py-4">
              <div className="flex items-start gap-3.5">
                <span className="flex size-10 items-center justify-center rounded-lg bg-brand-50 text-brand-600"><Landmark className="size-5" /></span>
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="text-[16px] font-semibold text-slate-900">{e.legal_name}</h2>
                    <StatusBadge status={e.status} />
                    <Badge>{humanize(e.constitution)}</Badge>
                  </div>
                  <p className="mt-0.5 text-[12.5px] text-slate-500">
                    <span className="font-mono">{e.code}</span> · PAN <span className="font-mono">{e.pan}</span>{e.cin ? <> · CIN <span className="font-mono">{e.cin}</span></> : null}
                  </p>
                </div>
              </div>
              {manage && (
                <div className="flex gap-2">
                  <Button size="sm" icon={<Pencil className="size-3.5" />} onClick={() => setEditEntity(e)}>Edit</Button>
                  <Button size="sm" variant="subtle" icon={<Plus className="size-3.5" />} onClick={() => setEditGst({ entityId: e.id })}>GST registration</Button>
                </div>
              )}
            </div>
            <div className="divide-y divide-slate-100">
              {gsts.data?.filter((g) => g.legal_entity_id === e.id).map((g) => (
                <div key={g.id} className="px-5 py-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="flex items-center gap-3">
                      <span className="flex size-8 items-center justify-center rounded-md bg-emerald-50 text-emerald-600"><Building2 className="size-4" /></span>
                      <div>
                        <p className="flex flex-wrap items-center gap-2">
                          <span className="font-mono text-[13.5px] font-semibold tracking-wide text-slate-900">{g.gstin}</span>
                          <Badge tone="neutral">{g.state_name}</Badge>
                          <Badge tone="info">{humanize(g.registration_type)}</Badge>
                          {g.e_invoice_applicable && <Badge tone="violet">e-invoice</Badge>}
                          <StatusBadge status={g.status} />
                        </p>
                        <p className="mt-0.5 text-[12px] text-slate-500">Effective {fmtDate(g.effective_from)}{g.effective_to ? ` – ${fmtDate(g.effective_to)}` : ''} · {g.principal_address}</p>
                      </div>
                    </div>
                    {manage && (
                      <div className="flex gap-1.5">
                        <Button size="xs" variant="ghost" icon={<Pencil className="size-3" />} onClick={() => setEditGst({ gst: g, entityId: e.id })}>Edit</Button>
                        <Button size="xs" variant="ghost" icon={<Plus className="size-3" />} onClick={() => setEditBranch({ gstId: g.id })}>Branch</Button>
                      </div>
                    )}
                  </div>
                  <div className="mt-3 ml-11 space-y-2">
                    {branches.data?.filter((b) => b.gst_registration_id === g.id).map((b) => (
                      <div key={b.id} className="rounded-lg border border-slate-200 bg-slate-50/50">
                        <div className="flex items-center justify-between gap-3 px-3.5 py-2.5">
                          <div className="flex items-center gap-2.5 text-[13px]">
                            <GitBranch className="size-4 text-slate-400" />
                            <span className="font-medium text-slate-900">{b.name}</span>
                            <span className="font-mono text-[11.5px] text-slate-500">{b.code}</span>
                            {b.is_principal_place && <Badge tone="brand">Principal place</Badge>}
                            {b.status !== 'active' && <StatusBadge status={b.status} />}
                          </div>
                          {manage && <Button size="xs" variant="ghost" onClick={() => setEditBranch({ branch: b, gstId: g.id })}>Edit</Button>}
                        </div>
                        <div className="flex flex-wrap gap-2 border-t border-slate-200 px-3.5 py-2.5">
                          {whs.data?.filter((w) => w.branch_id === b.id).map((w) => (
                            <Link key={w.id} to={`/organisation/warehouses/${w.id}`} className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 bg-white px-2.5 py-1 text-[12.5px] text-slate-700 hover:border-brand-300 hover:text-brand-700">
                              <Warehouse className="size-3.5 text-slate-400" /> {w.name} <span className="font-mono text-[11px] text-slate-400">#{w.dispatch_priority}</span> <ChevronRight className="size-3 text-slate-300" />
                            </Link>
                          ))}
                          {b.warehouse_count === 0 && <span className="text-[12px] text-slate-400">No warehouses mapped</span>}
                        </div>
                      </div>
                    ))}
                    {g.branch_count === 0 && <p className="text-[12.5px] text-slate-400">No branches yet.</p>}
                  </div>
                </div>
              ))}
              {e.gst_count === 0 && <p className="px-5 py-6 text-[13px] text-slate-500">No GST registrations yet.</p>}
            </div>
          </Card>
        ))}
      </div>
      {editEntity && <EntityDrawer entity={editEntity === 'new' ? undefined : editEntity} onClose={() => setEditEntity(null)} />}
      {editGst && <GstDrawer {...editGst} entity={entities.data?.find((x) => x.id === editGst.entityId)} onClose={() => setEditGst(null)} />}
      {editBranch && <BranchDrawer {...editBranch} onClose={() => setEditBranch(null)} />}
    </>
  );
}

function EntityDrawer({ entity, onClose }: { entity?: Entity; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [saving, setSaving] = useState(false);
  const f = useForm({
    code: entity?.code ?? '', legal_name: entity?.legal_name ?? '', trade_name: entity?.trade_name ?? '', constitution: entity?.constitution ?? 'private_limited',
    pan: entity?.pan ?? '', cin: entity?.cin ?? '', registered_address: entity?.registered_address ?? '', state_code: entity?.state_code ?? '',
    pincode: entity?.pincode ?? '', email: entity?.email ?? '', phone: entity?.phone ?? '', status: entity?.status ?? 'active',
  });
  async function save() {
    setSaving(true);
    try {
      const body = { ...clean(f.values), version: entity?.version };
      if (entity) await api.patch(`/organisation/entities/${entity.id}`, body);
      else await api.post('/organisation/entities', body);
      qc.invalidateQueries({ queryKey: ['entities'] });
      qc.invalidateQueries({ queryKey: ['structure'] });
      toast({ tone: 'success', title: entity ? 'Legal entity updated' : 'Legal entity created' });
      onClose();
    } catch (e) { f.handleError(e); } finally { setSaving(false); }
  }
  return (
    <Drawer open onClose={onClose} title={entity ? 'Edit legal entity' : 'New legal entity'} description="Changes are recorded in the audit trail." width="lg"
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={saving} onClick={save}>Save</Button></>}>
      <div className="space-y-5">
        {f.formError && <Notice tone="danger">{f.formError}</Notice>}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Input label="Code" required {...f.bind('code')} disabled={!!entity} hint="Short unique code" />
          <Input label="Legal name" required className="sm:col-span-2" {...f.bind('legal_name')} />
          <Input label="Trade name" {...f.bind('trade_name')} />
          <Select label="Constitution" required options={CONSTITUTIONS} {...f.bind('constitution')} />
          <Select label="Status" options={[{ value: 'active', label: 'Active' }, { value: 'inactive', label: 'Inactive' }]} {...f.bind('status')} />
          <Input label="PAN" required className="font-mono" {...f.bind('pan')} onChange={(e) => f.set('pan', e.target.value.toUpperCase())} />
          <Input label="CIN / LLPIN" className="sm:col-span-2" {...f.bind('cin')} />
        </div>
        <Textarea label="Registered address" {...f.bind('registered_address')} />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Select label="State" placeholder="Select state" options={STATE_OPTIONS} {...f.bind('state_code')} />
          <Input label="PIN code" {...f.bind('pincode')} />
          <Input label="Email" type="email" {...f.bind('email')} />
          <Input label="Phone" {...f.bind('phone')} />
        </div>
      </div>
    </Drawer>
  );
}

function GstDrawer({ gst, entityId, entity, onClose }: { gst?: Gst; entityId: string; entity?: Entity; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [saving, setSaving] = useState(false);
  const f = useForm({
    gstin: gst?.gstin ?? '', registration_type: gst?.registration_type ?? 'regular', trade_name: gst?.trade_name ?? '',
    principal_address: gst?.principal_address ?? '', effective_from: gst?.effective_from ?? '', effective_to: gst?.effective_to ?? '',
    e_invoice_applicable: gst?.e_invoice_applicable ?? true, status: gst?.status ?? 'active', reason: '',
  });
  const g = f.values.gstin.toUpperCase();
  const live = g.length === 15 ? gstinProblem(g) ?? (entity && g.slice(2, 12) !== entity.pan ? `PAN in GSTIN must be ${entity.pan}` : null) : null;
  async function save() {
    setSaving(true);
    try {
      const body = { ...clean(f.values), gstin: g, legal_entity_id: entityId, e_invoice_applicable: f.values.e_invoice_applicable, version: gst?.version };
      if (gst) await api.patch(`/organisation/gst-registrations/${gst.id}`, body);
      else await api.post('/organisation/gst-registrations', body);
      qc.invalidateQueries({ queryKey: ['gst-registrations'] });
      qc.invalidateQueries({ queryKey: ['entities'] });
      toast({ tone: 'success', title: gst ? 'GST registration updated' : 'GST registration added' });
      onClose();
    } catch (e) { f.handleError(e); } finally { setSaving(false); }
  }
  return (
    <Drawer open onClose={onClose} title={gst ? 'Edit GST registration' : 'Add GST registration'} description={entity?.legal_name}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={saving} onClick={save} disabled={!!live}>Save</Button></>}>
      <div className="space-y-4">
        {f.formError && <Notice tone="danger">{f.formError}</Notice>}
        {gst && <Notice tone="info">GSTIN and owning entity are fixed once created. To change them, deactivate this registration and add a new one.</Notice>}
        <Input label="GSTIN" required className="font-mono" maxLength={15} disabled={!!gst} {...f.bind('gstin')} onChange={(e) => f.set('gstin', e.target.value.toUpperCase())}
          error={f.errors.gstin ?? live ?? undefined}
          hint={g.length === 15 && !live ? `✓ Valid · ${GST_STATES[g.slice(0, 2)]}` : 'State and PAN are read from the GSTIN'} />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Select label="Registration type" options={['regular', 'composition', 'sez_unit', 'sez_developer', 'isd', 'casual'].map((v) => ({ value: v, label: humanize(v) }))} {...f.bind('registration_type')} />
          <Select label="Status" options={[{ value: 'active', label: 'Active' }, { value: 'inactive', label: 'Inactive' }]} {...f.bind('status')} />
          <Input label="Effective from" type="date" required {...f.bind('effective_from')} />
          <Input label="Effective to" type="date" {...f.bind('effective_to')} />
        </div>
        <Input label="Trade name on registration" {...f.bind('trade_name')} />
        <Textarea label="Principal place of business" {...f.bind('principal_address')} />
        <Switch checked={f.values.e_invoice_applicable} onChange={(v) => f.set('e_invoice_applicable', v)} label="e-Invoice (IRN) applicable" />
        {gst && <Textarea label="Reason for change" hint="Recorded in the audit trail" {...f.bind('reason')} />}
      </div>
    </Drawer>
  );
}

function BranchDrawer({ branch, gstId, onClose }: { branch?: Branch; gstId: string; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [saving, setSaving] = useState(false);
  const f = useForm({ code: branch?.code ?? '', name: branch?.name ?? '', city: branch?.city ?? '', address: branch?.address ?? '', pincode: branch?.pincode ?? '', is_principal_place: branch?.is_principal_place ?? false, status: branch?.status ?? 'active' });
  async function save() {
    setSaving(true);
    try {
      const body = { ...clean(f.values), is_principal_place: f.values.is_principal_place, gst_registration_id: gstId, version: branch?.version };
      if (branch) await api.patch(`/organisation/branches/${branch.id}`, body);
      else await api.post('/organisation/branches', body);
      qc.invalidateQueries({ queryKey: ['branches'] });
      qc.invalidateQueries({ queryKey: ['gst-registrations'] });
      toast({ tone: 'success', title: 'Branch saved' });
      onClose();
    } catch (e) { f.handleError(e); } finally { setSaving(false); }
  }
  return (
    <Drawer open onClose={onClose} title={branch ? 'Edit branch' : 'Add branch / place of business'}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={saving} onClick={save}>Save</Button></>}>
      <div className="space-y-4">
        {f.formError && <Notice tone="danger">{f.formError}</Notice>}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Input label="Code" required {...f.bind('code')} />
          <Input label="Name" required className="sm:col-span-2" {...f.bind('name')} />
          <Input label="City" {...f.bind('city')} />
          <Input label="PIN code" {...f.bind('pincode')} />
          <Select label="Status" options={[{ value: 'active', label: 'Active' }, { value: 'inactive', label: 'Inactive' }]} {...f.bind('status')} />
        </div>
        <Textarea label="Address" {...f.bind('address')} />
        <Switch checked={f.values.is_principal_place} onChange={(v) => f.set('is_principal_place', v)} label="Principal place of business for this GSTIN" />
      </div>
    </Drawer>
  );
}

