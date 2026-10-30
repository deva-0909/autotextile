import { useQuery, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { ArrowDown, ArrowUp, Box, ChevronDown, ChevronRight, Grid3x3, MapPin, Pencil, Plus, Rows3, Save, Warehouse as WarehouseIcon } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fmtNum, humanize } from '../lib/format';
import { clean, useForm } from '../components/form';
import { SimpleTable } from '../components/DataTable';
import { ConfirmDialog, Drawer, useToast } from '../components/overlay';
import { Badge, Button, Card, ErrorState, Input, KeyValue, Notice, PageHeader, Select, Skeleton, StatusBadge, Textarea, type Tone } from '../components/ui';

interface Warehouse {
  id: string; code: string; name: string; branch_id: string; branch_name: string; gst_registration_id: string; gstin: string; state_code: string; warehouse_type: string;
  dispatch_priority: number; address: string | null; city: string; pincode: string | null; manager_name: string | null; phone: string | null; capacity_kg: number | null;
  status: string; version: number; bin_count: number; location_count: number; legal_name?: string;
}
interface Location { id: string; parent_id: string | null; kind: 'zone' | 'aisle' | 'rack' | 'bin'; code: string; path: string; name: string | null; purpose: string; capacity_kg: number | null; status: string; version: number }

const TYPE_TONE: Record<string, Tone> = { receiving_hub: 'brand', distribution: 'info', transit: 'warning', returns: 'neutral' };
const PURPOSE_TONE: Record<string, Tone> = { storage: 'neutral', receiving: 'info', qc: 'violet', staging: 'brand', dispatch: 'success', damaged: 'danger', returns: 'warning' };
const CHILD: Record<string, Location['kind'] | undefined> = { zone: 'aisle', aisle: 'rack', rack: 'bin' };

export function WarehousesPage() {
  const { can } = useAuth();
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['warehouses'], queryFn: () => api.get<Warehouse[]>('/organisation/warehouses') });
  const [order, setOrder] = useState<string[] | null>(null);
  const [edit, setEdit] = useState<Warehouse | 'new' | null>(null);
  const [confirm, setConfirm] = useState(false);
  const rows = useMemo(() => (order && q.data ? order.map((id) => q.data!.find((w) => w.id === id)!).filter(Boolean) : q.data ?? []), [order, q.data]);
  const manage = can('org.warehouse.manage');

  const move = (i: number, d: -1 | 1) => {
    const ids = rows.map((r) => r.id);
    [ids[i], ids[i + d]] = [ids[i + d]!, ids[i]!];
    setOrder(ids);
  };

  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  return (
    <>
      <PageHeader
        title="Warehouses"
        description="Physical warehouses, their GST registration mapping and the default dispatch priority used by the allocation engine."
        breadcrumbs={[{ label: 'Organisation' }, { label: 'Warehouses' }]}
        actions={manage && (
          <>
            {order && <Button onClick={() => setOrder(null)}>Discard order</Button>}
            {order && <Button variant="primary" icon={<Save className="size-4" />} onClick={() => setConfirm(true)}>Save priority</Button>}
            {!order && <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setEdit('new')}>Add warehouse</Button>}
          </>
        )}
      />
      {order && <div className="mb-4"><Notice tone="warning">Priority order changed. Save to apply it to future allocations.</Notice></div>}
      <Card padded={false}>
        {!q.data ? <div className="p-5"><Skeleton className="h-40" /></div> : (
          <SimpleTable
            rows={rows}
            rowKey={(r) => r.id}
            onRowClick={(r) => nav(`/organisation/warehouses/${r.id}`)}
            columns={[
              { key: 'prio', header: 'Priority', width: '110px', render: (r) => {
                const i = rows.indexOf(r);
                return (
                  <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                    <span className="w-6 font-mono text-[12.5px] font-semibold text-slate-500">#{i + 1}</span>
                    {manage && <>
                      <button className="rounded p-0.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700 disabled:opacity-30" disabled={i === 0} onClick={() => move(i, -1)} aria-label="Move up"><ArrowUp className="size-3.5" /></button>
                      <button className="rounded p-0.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700 disabled:opacity-30" disabled={i === rows.length - 1} onClick={() => move(i, 1)} aria-label="Move down"><ArrowDown className="size-3.5" /></button>
                    </>}
                  </div>
                );
              } },
              { key: 'name', header: 'Warehouse', render: (r) => (
                <div className="flex items-center gap-3">
                  <span className="flex size-8 items-center justify-center rounded-md bg-slate-100 text-slate-500"><WarehouseIcon className="size-4" /></span>
                  <div><p className="font-medium text-slate-900">{r.name}</p><p className="font-mono text-[11.5px] text-slate-500">{r.code}</p></div>
                </div>
              ) },
              { key: 'type', header: 'Type', render: (r) => <Badge tone={TYPE_TONE[r.warehouse_type]}>{humanize(r.warehouse_type)}</Badge> },
              { key: 'city', header: 'City', render: (r) => r.city },
              { key: 'gstin', header: 'GST registration', render: (r) => <span className="font-mono text-[12.5px]">{r.gstin}</span> },
              { key: 'branch', header: 'Branch', render: (r) => r.branch_name },
              { key: 'bins', header: 'Bins', align: 'right', render: (r) => fmtNum(r.bin_count) },
              { key: 'cap', header: 'Capacity', align: 'right', render: (r) => fmtNum(r.capacity_kg, 'kg') },
              { key: 'status', header: 'Status', render: (r) => <StatusBadge status={r.status} /> },
            ]}
          />
        )}
      </Card>
      {edit && <WarehouseDrawer warehouse={edit === 'new' ? undefined : edit} onClose={() => setEdit(null)} />}
      <ConfirmDialog
        open={confirm}
        onClose={() => setConfirm(false)}
        title="Save dispatch priority?"
        description={`New order: ${rows.map((r) => r.code).join(' → ')}. The allocation engine will recommend warehouses in this order.`}
        confirmLabel="Save priority"
        onConfirm={async () => {
          await api.put('/organisation/warehouses-priority', { order: rows.map((r) => r.id) });
          setOrder(null);
          setConfirm(false);
          qc.invalidateQueries({ queryKey: ['warehouses'] });
          toast({ tone: 'success', title: 'Dispatch priority updated' });
        }}
      />
    </>
  );
}

function WarehouseDrawer({ warehouse, onClose }: { warehouse?: Warehouse; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [saving, setSaving] = useState(false);
  const branches = useQuery({ queryKey: ['branches'], queryFn: () => api.get<{ id: string; name: string; gst_registration_id: string; gstin: string }[]>('/organisation/branches') });
  const gsts = useQuery({ queryKey: ['gst-registrations'], queryFn: () => api.get<{ id: string; gstin: string; state_name: string; status: string }[]>('/organisation/gst-registrations') });
  const f = useForm({
    code: warehouse?.code ?? '', name: warehouse?.name ?? '', branch_id: warehouse?.branch_id ?? '', gst_registration_id: warehouse?.gst_registration_id ?? '',
    warehouse_type: warehouse?.warehouse_type ?? 'distribution', dispatch_priority: String(warehouse?.dispatch_priority ?? 100), address: warehouse?.address ?? '',
    city: warehouse?.city ?? '', pincode: warehouse?.pincode ?? '', manager_name: warehouse?.manager_name ?? '', phone: warehouse?.phone ?? '',
    capacity_kg: warehouse?.capacity_kg == null ? '' : String(warehouse.capacity_kg), status: warehouse?.status ?? 'active',
  });
  async function save() {
    setSaving(true);
    try {
      const body = { ...clean(f.values, ['dispatch_priority', 'capacity_kg']), version: warehouse?.version };
      if (warehouse) await api.patch(`/organisation/warehouses/${warehouse.id}`, body);
      else await api.post('/organisation/warehouses', body);
      qc.invalidateQueries({ queryKey: ['warehouses'] });
      qc.invalidateQueries({ queryKey: ['warehouse'] });
      qc.invalidateQueries({ queryKey: ['structure'] });
      toast({ tone: 'success', title: warehouse ? 'Warehouse updated' : 'Warehouse added' });
      onClose();
    } catch (e) { f.handleError(e); } finally { setSaving(false); }
  }
  return (
    <Drawer open onClose={onClose} title={warehouse ? `Edit ${warehouse.name}` : 'Add warehouse'} description="New warehouses become available everywhere without code changes." width="lg"
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={saving} onClick={save}>Save</Button></>}>
      <div className="space-y-5">
        {f.formError && <Notice tone="danger">{f.formError}</Notice>}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Input label="Code" required {...f.bind('code')} />
          <Input label="Name" required className="sm:col-span-2" {...f.bind('name')} />
          <Select label="Branch" required placeholder="Select branch" options={branches.data?.map((b) => ({ value: b.id, label: b.name })) ?? []} {...f.bind('branch_id')}
            onChange={(e) => { f.set('branch_id', e.target.value); const b = branches.data?.find((x) => x.id === e.target.value); if (b && !f.values.gst_registration_id) f.set('gst_registration_id', b.gst_registration_id); }} />
          <Select label="GST registration" required className="sm:col-span-2" placeholder="Select GSTIN" options={gsts.data?.filter((g) => g.status === 'active').map((g) => ({ value: g.id, label: `${g.gstin} · ${g.state_name}` })) ?? []} {...f.bind('gst_registration_id')} hint="Documents for this warehouse are issued under this registration" />
          <Select label="Type" options={['receiving_hub', 'distribution', 'transit', 'returns'].map((v) => ({ value: v, label: humanize(v) }))} {...f.bind('warehouse_type')} />
          <Input label="Dispatch priority" type="number" min={1} {...f.bind('dispatch_priority')} hint="Lower = preferred" />
          <Select label="Status" options={[{ value: 'active', label: 'Active' }, { value: 'inactive', label: 'Inactive' }]} {...f.bind('status')} />
        </div>
        <Textarea label="Address" {...f.bind('address')} />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Input label="City" required {...f.bind('city')} />
          <Input label="PIN code" {...f.bind('pincode')} />
          <Input label="Capacity" type="number" suffix="kg" {...f.bind('capacity_kg')} />
          <Input label="Manager" {...f.bind('manager_name')} />
          <Input label="Phone" {...f.bind('phone')} />
        </div>
      </div>
    </Drawer>
  );
}

export function WarehouseDetailPage() {
  const { id } = useParams();
  const { can } = useAuth();
  const q = useQuery({ queryKey: ['warehouse', id], queryFn: () => api.get<Warehouse & { locations: Location[] }>(`/organisation/warehouses/${id}`) });
  const [edit, setEdit] = useState(false);
  const [locEdit, setLocEdit] = useState<{ parent?: Location; loc?: Location } | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const manage = can('org.warehouse.manage');

  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  if (!q.data) return <Skeleton className="h-96" />;
  const w = q.data;
  const children = (pid: string | null) => w.locations.filter((l) => l.parent_id === pid);
  const counts = { zone: 0, aisle: 0, rack: 0, bin: 0 } as Record<Location['kind'], number>;
  w.locations.forEach((l) => counts[l.kind]++);
  const icon = { zone: <Grid3x3 className="size-4" />, aisle: <Rows3 className="size-4" />, rack: <Box className="size-4" />, bin: <MapPin className="size-3.5" /> };

  const renderNode = (l: Location, depth: number): React.ReactNode => {
    const kids = children(l.id);
    const open = !collapsed.has(l.id);
    return (
      <div key={l.id}>
        <div className="group flex items-center gap-2 rounded-md py-1.5 pr-2 hover:bg-slate-50" style={{ paddingLeft: depth * 22 + 8 }}>
          <button className={clsx('rounded p-0.5 text-slate-400 hover:text-slate-700', !kids.length && 'invisible')} onClick={() => setCollapsed((s) => { const n = new Set(s); if (n.has(l.id)) n.delete(l.id); else n.add(l.id); return n; })} aria-label="Toggle">
            {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
          </button>
          <span className="text-slate-400">{icon[l.kind]}</span>
          <span className="font-mono text-[12.5px] font-semibold text-slate-800">{l.path}</span>
          {l.name && <span className="text-[12.5px] text-slate-500">{l.name}</span>}
          <span className="text-[11px] tracking-wide text-slate-400 uppercase">{l.kind}</span>
          {l.purpose !== 'storage' && <Badge tone={PURPOSE_TONE[l.purpose]}>{humanize(l.purpose)}</Badge>}
          {l.status !== 'active' && <StatusBadge status={l.status} />}
          {manage && (
            <span className="ml-auto flex gap-1 opacity-0 group-hover:opacity-100">
              {CHILD[l.kind] && <Button size="xs" variant="ghost" icon={<Plus className="size-3" />} onClick={() => setLocEdit({ parent: l })}>{humanize(CHILD[l.kind]!)}</Button>}
              <Button size="xs" variant="ghost" icon={<Pencil className="size-3" />} onClick={() => setLocEdit({ loc: l })}>Edit</Button>
            </span>
          )}
        </div>
        {open && kids.map((k) => renderNode(k, depth + 1))}
      </div>
    );
  };

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: 'Organisation' }, { label: 'Warehouses', to: '/organisation/warehouses' }, { label: w.code }]}
        title={<>{w.name} <StatusBadge status={w.status} /> <Badge tone={TYPE_TONE[w.warehouse_type]}>{humanize(w.warehouse_type)}</Badge></>}
        meta={<>
          <span>Code <span className="font-mono font-medium text-slate-800">{w.code}</span></span>
          <span>GSTIN <span className="font-mono font-medium text-slate-800">{w.gstin}</span></span>
          <span>Dispatch priority <span className="font-medium text-slate-800">{w.dispatch_priority}</span></span>
        </>}
        actions={manage && <Button icon={<Pencil className="size-4" />} onClick={() => setEdit(true)}>Edit warehouse</Button>}
      />
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
        <div className="space-y-6">
          <Card title="Details">
            <KeyValue columns={1} items={[
              { label: 'Legal entity', value: w.legal_name },
              { label: 'Branch', value: w.branch_name },
              { label: 'Address', value: [w.address, w.city, w.pincode].filter(Boolean).join(', ') },
              { label: 'Manager', value: w.manager_name ? `${w.manager_name}${w.phone ? ` · ${w.phone}` : ''}` : null },
              { label: 'Capacity', value: fmtNum(w.capacity_kg, 'kg') },
            ]} />
          </Card>
          <Card title="Layout summary">
            <div className="grid grid-cols-2 gap-3">
              {(['zone', 'aisle', 'rack', 'bin'] as const).map((k) => (
                <div key={k} className="rounded-lg border border-slate-200 px-3 py-2.5">
                  <p className="text-[12px] text-slate-500 capitalize">{k}s</p>
                  <p className="text-[20px] font-semibold tabular">{counts[k]}</p>
                </div>
              ))}
            </div>
          </Card>
        </div>
        <Card
          className="xl:col-span-2"
          title="Locations"
          description="Zone → aisle → rack → bin. Bins become scan targets for put-away and picking in the inventory release (P4)."
          actions={manage && <Button size="sm" variant="primary" icon={<Plus className="size-3.5" />} onClick={() => setLocEdit({})}>Add zone</Button>}
        >
          {w.locations.length === 0 ? (
            <Notice tone="info">No locations yet. Start with zones such as Receiving, QC, Storage, Staging and Damaged.</Notice>
          ) : (
            <div className="scrollbar-thin max-h-[620px] overflow-y-auto">{children(null).map((z) => renderNode(z, 0))}</div>
          )}
        </Card>
      </div>
      {edit && <WarehouseDrawer warehouse={w} onClose={() => setEdit(false)} />}
      {locEdit && <LocationDrawer warehouseId={w.id} {...locEdit} onClose={() => setLocEdit(null)} />}
    </>
  );
}

function LocationDrawer({ warehouseId, parent, loc, onClose }: { warehouseId: string; parent?: Location; loc?: Location; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [saving, setSaving] = useState(false);
  const kind = loc?.kind ?? (parent ? CHILD[parent.kind]! : 'zone');
  const f = useForm({ code: loc?.code ?? '', name: loc?.name ?? '', purpose: loc?.purpose ?? parent?.purpose ?? 'storage', capacity_kg: loc?.capacity_kg == null ? '' : String(loc.capacity_kg), status: loc?.status ?? 'active' });
  async function save() {
    setSaving(true);
    try {
      const v = clean(f.values, ['capacity_kg']);
      if (loc) await api.patch(`/organisation/locations/${loc.id}`, { name: v.name, purpose: v.purpose, capacity_kg: v.capacity_kg, status: v.status, version: loc.version });
      else await api.post(`/organisation/warehouses/${warehouseId}/locations`, { ...v, kind, parent_id: parent?.id ?? null });
      qc.invalidateQueries({ queryKey: ['warehouse', warehouseId] });
      qc.invalidateQueries({ queryKey: ['warehouses'] });
      toast({ tone: 'success', title: `${humanize(kind)} saved` });
      onClose();
    } catch (e) { f.handleError(e); } finally { setSaving(false); }
  }
  return (
    <Drawer open onClose={onClose} title={loc ? `Edit ${loc.path}` : `Add ${kind}${parent ? ` in ${parent.path}` : ''}`}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={saving} onClick={save}>Save</Button></>}>
      <div className="space-y-4">
        {f.formError && <Notice tone="danger">{f.formError}</Notice>}
        <div className="grid grid-cols-2 gap-4">
          <Input label="Code" required disabled={!!loc} {...f.bind('code')} hint={parent ? `Full path: ${parent.path}-${f.values.code.toUpperCase() || '…'}` : undefined} />
          <Input label="Name" {...f.bind('name')} />
          <Select label="Purpose" options={['storage', 'receiving', 'qc', 'staging', 'dispatch', 'damaged', 'returns'].map((v) => ({ value: v, label: humanize(v) }))} {...f.bind('purpose')} />
          <Input label="Capacity" type="number" suffix="kg" {...f.bind('capacity_kg')} />
          <Select label="Status" options={[{ value: 'active', label: 'Active' }, { value: 'inactive', label: 'Inactive' }]} {...f.bind('status')} />
        </div>
      </div>
    </Drawer>
  );
}

