import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Layers, ListTree, Package, Plus, Tags } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, invalidatePrefix } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fmtDate, fmtNum, humanize } from '../lib/format';
import { DataTable, FilterSelect, SimpleTable } from '../components/DataTable';
import { clean, useForm } from '../components/form';
import { Drawer, useToast } from '../components/overlay';
import { DocumentsPanel } from '../components/Documents';
import { AuditTimeline } from '../components/AuditTrail';
import { Badge, Button, Card, Checkbox, Input, Notice, PageHeader, Select, StatusBadge, Tabs, Textarea, type Tone } from '../components/ui';

interface Category { id: string; code: string; name: string; hsn_code: string | null; description: string | null; status: string; version: number; product_count: number }
export interface AttrDef { id: string; category_id: string | null; category_name: string | null; key: string; label: string; data_type: 'text' | 'number' | 'select' | 'multiselect' | 'boolean'; unit: string | null; options: string[] | null; min_value: number | null; max_value: number | null; required: boolean; level: 'product' | 'lot' | 'roll'; group_name: string; sort_order: number; status: string; version: number }
interface Product { id: string; sku: string; name: string; category_id: string; category_name: string; hsn_code: string; gst_rate: number; uom_code: string; attributes: Record<string, unknown>; min_order_qty: number | null; description: string | null; status: string; version: number; updated_at: string }
interface Hsn { code: string; description: string; gst_rate: number; status: string }

const LEVEL_TONE: Record<string, Tone> = { product: 'brand', lot: 'violet', roll: 'info' };

export function CataloguePage() {
  const { tab = 'products' } = useParams();
  const nav = useNavigate();
  return (
    <>
      <PageHeader
        title="Fabric catalogue"
        description="SKUs, fabric categories and the configurable textile attribute dictionary. SKU, lot and roll are kept distinct; lot and roll attributes are captured at inward (P4)."
        breadcrumbs={[{ label: 'Master data' }, { label: 'Fabric catalogue' }]}
      />
      <Tabs className="mb-5" value={tab} onChange={(t) => nav(`/catalogue/${t}`)} tabs={[
        { value: 'products', label: <span className="flex items-center gap-2"><Package className="size-4" />Fabric SKUs</span> },
        { value: 'categories', label: <span className="flex items-center gap-2"><Layers className="size-4" />Categories</span> },
        { value: 'attributes', label: <span className="flex items-center gap-2"><ListTree className="size-4" />Attribute dictionary</span> },
        { value: 'price-lists', label: <span className="flex items-center gap-2"><Tags className="size-4" />Price lists</span> },
      ]} />
      {tab === 'products' && <Products />}
      {tab === 'categories' && <Categories />}
      {tab === 'attributes' && <Attributes />}
      {tab === 'price-lists' && <PriceLists />}
    </>
  );
}

function Products() {
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const cats = useQuery({ queryKey: ['fabric-categories'], queryFn: () => api.get<Category[]>('/masters/fabric-categories') });
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [edit, setEdit] = useState<string | 'new' | null>(params.get('new') ? 'new' : params.get('open'));
  const close = () => { setEdit(null); if (params.toString()) setParams({}); };
  return (
    <>
      <DataTable<Product>
        id="products"
        endpoint="/masters/products"
        defaultSort={{ key: 'sku', dir: 'asc' }}
        filters={filters}
        onFiltersChange={setFilters}
        searchPlaceholder="Search SKU, name, colour, composition…"
        onRowClick={(r) => setEdit(r.id)}
        toolbar={<>
          <FilterSelect placeholder="All categories" value={filters.category} onChange={(v) => setFilters({ ...filters, category: v })} options={cats.data?.map((c) => ({ value: c.id, label: c.name })) ?? []} />
          <FilterSelect placeholder="All statuses" value={filters.status} onChange={(v) => setFilters({ ...filters, status: v })} options={['active', 'inactive', 'discontinued'].map((s) => ({ value: s, label: humanize(s) }))} />
          {can('masters.product.manage') && <Button size="sm" variant="primary" icon={<Plus className="size-3.5" />} onClick={() => setEdit('new')}>New SKU</Button>}
        </>}
        columns={[
          { key: 'sku', header: 'SKU', sort: 'sku', csv: (r) => r.sku, render: (r) => <span className="font-mono text-[12.5px] font-semibold text-slate-900">{r.sku}</span> },
          { key: 'name', header: 'Description', sort: 'name', csv: (r) => r.name, render: (r) => <span className="text-slate-900">{r.name}</span> },
          { key: 'cat', header: 'Category', csv: (r) => r.category_name, render: (r) => <Badge>{r.category_name}</Badge> },
          { key: 'gsm', header: 'GSM', align: 'right', csv: (r) => r.attributes.gsm as number, render: (r) => fmtNum(r.attributes.gsm as number) },
          { key: 'width', header: 'Width', align: 'right', csv: (r) => r.attributes.width as number, render: (r) => r.attributes.width ? `${r.attributes.width}″ ${r.attributes.width_form === 'Tubular' ? 'tub.' : 'open'}` : '—' },
          { key: 'comp', header: 'Composition', csv: (r) => r.attributes.composition as string, render: (r) => <span className="text-[12.5px]">{(r.attributes.composition as string) ?? '—'}</span> },
          { key: 'colour', header: 'Colour', csv: (r) => r.attributes.colour as string, render: (r) => (r.attributes.colour as string) ?? '—' },
          { key: 'proc', header: 'Processing', csv: (r) => r.attributes.processing_type as string, render: (r) => (r.attributes.processing_type as string) ?? '—', defaultHidden: true },
          { key: 'hsn', header: 'HSN · GST', csv: (r) => `${r.hsn_code} ${r.gst_rate}%`, render: (r) => <span className="font-mono text-[12.5px]">{r.hsn_code} · {r.gst_rate}%</span> },
          { key: 'moq', header: 'MOQ', align: 'right', csv: (r) => r.min_order_qty, render: (r) => fmtNum(r.min_order_qty, r.uom_code.toLowerCase()), defaultHidden: true },
          { key: 'status', header: 'Status', sort: 'status', csv: (r) => r.status, render: (r) => <StatusBadge status={r.status} /> },
        ]}
        empty={{ title: 'No fabric SKUs yet' }}
      />
      {edit && <ProductDrawer productId={edit === 'new' ? undefined : edit} onClose={close} />}
    </>
  );
}

/** Renders an input for one attribute definition. */
function AttrInput({ def, value, onChange, error }: { def: AttrDef; value: unknown; onChange: (v: unknown) => void; error?: string }) {
  const label = <>{def.label}{def.unit && <span className="font-normal text-slate-400"> ({def.unit})</span>}</>;
  const range = def.min_value != null || def.max_value != null ? `Allowed ${def.min_value ?? '…'}–${def.max_value ?? '…'}` : undefined;
  if (def.data_type === 'select') return <Select label={label} required={def.required} error={error} placeholder="Select" value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} options={(def.options ?? []).map((o) => ({ value: o, label: o }))} />;
  if (def.data_type === 'multiselect') {
    const arr = (value as string[]) ?? [];
    return (
      <div className="sm:col-span-2">
        <p className="label">{label}{def.required && <span className="ml-0.5 text-rose-500">*</span>}</p>
        <div className="flex flex-wrap gap-1.5">
          {(def.options ?? []).map((o) => {
            const on = arr.includes(o);
            return <button type="button" key={o} onClick={() => onChange(on ? arr.filter((x) => x !== o) : [...arr, o])} className={`rounded-full border px-2.5 py-1 text-[12px] transition ${on ? 'border-brand-500 bg-brand-50 text-brand-700' : 'border-slate-300 bg-white text-slate-600 hover:border-slate-400'}`}>{o}</button>;
          })}
        </div>
        {error && <p className="mt-1.5 text-xs font-medium text-rose-600">{error}</p>}
      </div>
    );
  }
  if (def.data_type === 'boolean') return <Checkbox label={def.label} checked={!!value} onChange={(e) => onChange(e.target.checked)} />;
  return <Input label={label} required={def.required} error={error} hint={range} type={def.data_type === 'number' ? 'number' : 'text'} step="any" value={String(value ?? '')} onChange={(e) => onChange(def.data_type === 'number' ? (e.target.value === '' ? '' : Number(e.target.value)) : e.target.value)} />;
}

function ProductDrawer({ productId, onClose }: { productId?: string; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { can } = useAuth();
  const manage = can('masters.product.manage');
  const product = useQuery({ queryKey: ['product', productId], queryFn: () => api.get<Product>(`/masters/products/${productId}`), enabled: !!productId });
  const cats = useQuery({ queryKey: ['fabric-categories'], queryFn: () => api.get<Category[]>('/masters/fabric-categories') });
  const hsn = useQuery({ queryKey: ['hsn-codes'], queryFn: () => api.get<Hsn[]>('/masters/hsn-codes') });
  const [tab, setTab] = useState<'spec' | 'documents' | 'history'>('spec');
  const f = useForm({ sku: '', name: '', category_id: '', hsn_code: '', uom_code: 'KG', min_order_qty: '', description: '', status: 'active' });
  const [attrs, setAttrs] = useState<Record<string, unknown>>({});
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    const p = product.data;
    if (p) {
      f.setValues({ sku: p.sku, name: p.name, category_id: p.category_id, hsn_code: p.hsn_code, uom_code: p.uom_code, min_order_qty: p.min_order_qty == null ? '' : String(p.min_order_qty), description: p.description ?? '', status: p.status });
      setAttrs(p.attributes);
    }
  }, [product.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const defs = useQuery({
    queryKey: ['attribute-definitions', f.values.category_id],
    queryFn: () => api.get<AttrDef[]>(`/masters/attribute-definitions?categoryId=${f.values.category_id}`),
    enabled: !!f.values.category_id,
  });
  const productDefs = useMemo(() => (defs.data ?? []).filter((d) => d.level === 'product' && d.status === 'active'), [defs.data]);
  const groups = [...new Set(productDefs.map((d) => d.group_name))];

  async function save() {
    setSaving(true);
    try {
      const keep = Object.fromEntries(Object.entries(attrs).filter(([k, v]) => productDefs.some((d) => d.key === k) && v !== '' && v !== undefined));
      const body = { ...clean(f.values, ['min_order_qty']), attributes: keep, version: product.data?.version };
      if (productId) await api.patch(`/masters/products/${productId}`, body);
      else await api.post('/masters/products', body);
      invalidatePrefix(qc, '/masters/products');
      qc.invalidateQueries({ queryKey: ['product', productId] });
      toast({ tone: 'success', title: productId ? 'SKU updated' : 'SKU created' });
      onClose();
    } catch (e) { f.handleError(e); } finally { setSaving(false); }
  }

  return (
    <Drawer open onClose={onClose} width="xl" title={productId ? product.data?.name ?? 'Fabric SKU' : 'New fabric SKU'} description={productId ? <span className="font-mono">{product.data?.sku}</span> : 'Specification fields come from the attribute dictionary for the chosen category.'}
      footer={manage && tab === 'spec' && <><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={saving} onClick={save}>Save</Button></>}>
      {productId && <Tabs className="mb-5" value={tab} onChange={setTab} tabs={[{ value: 'spec', label: 'Specification' }, { value: 'documents', label: 'Documents & images' }, { value: 'history', label: 'History' }]} />}
      {tab === 'spec' && (
        <fieldset disabled={!manage} className="space-y-6">
          {f.formError && <Notice tone="danger">{f.formError}</Notice>}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Input label="SKU" required {...f.bind('sku')} onChange={(e) => f.set('sku', e.target.value.toUpperCase())} />
            <Input label="Description" required className="sm:col-span-2" {...f.bind('name')} />
            <Select label="Category" required placeholder="Select category" options={cats.data?.filter((c) => c.status === 'active').map((c) => ({ value: c.id, label: c.name })) ?? []} {...f.bind('category_id')}
              onChange={(e) => { f.set('category_id', e.target.value); const c = cats.data?.find((x) => x.id === e.target.value); if (c?.hsn_code && !f.values.hsn_code) f.set('hsn_code', c.hsn_code); }} />
            <Select label="HSN code" required placeholder="Select HSN" options={hsn.data?.filter((h) => h.status === 'active').map((h) => ({ value: h.code, label: `${h.code} · ${h.gst_rate}% · ${h.description}` })) ?? []} {...f.bind('hsn_code')} />
            <Select label="Status" options={['active', 'inactive', 'discontinued'].map((s) => ({ value: s, label: humanize(s) }))} {...f.bind('status')} />
            <Select label="Selling unit" options={[{ value: 'KG', label: 'Kilogram (KG)' }, { value: 'MTR', label: 'Metre' }]} {...f.bind('uom_code')} />
            <Input label="Minimum order" type="number" suffix={f.values.uom_code.toLowerCase()} {...f.bind('min_order_qty')} />
          </div>
          {!f.values.category_id && <Notice tone="info">Choose a category to load its specification fields.</Notice>}
          {groups.map((g) => (
            <section key={g}>
              <h3 className="mb-3 text-[12px] font-semibold tracking-wide text-slate-500 uppercase">{g}</h3>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                {productDefs.filter((d) => d.group_name === g).map((d) => (
                  <AttrInput key={d.id} def={d} value={attrs[d.key]} onChange={(v) => setAttrs((a) => ({ ...a, [d.key]: v }))} error={f.errors[`attributes.${d.key}`]} />
                ))}
              </div>
            </section>
          ))}
          <Textarea label="Notes for sales team" {...f.bind('description')} />
        </fieldset>
      )}
      {tab === 'documents' && productId && <DocumentsPanel entityType="product" entityId={productId} />}
      {tab === 'history' && productId && <AuditTimeline entityId={productId} entity="product" />}
    </Drawer>
  );
}

function Categories() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['fabric-categories'], queryFn: () => api.get<Category[]>('/masters/fabric-categories') });
  const hsn = useQuery({ queryKey: ['hsn-codes'], queryFn: () => api.get<Hsn[]>('/masters/hsn-codes') });
  const [edit, setEdit] = useState<Category | 'new' | null>(null);
  const f = useForm({ code: '', name: '', hsn_code: '', description: '', status: 'active' });
  useEffect(() => { const c = edit && edit !== 'new' ? edit : null; f.setValues({ code: c?.code ?? '', name: c?.name ?? '', hsn_code: c?.hsn_code ?? '', description: c?.description ?? '', status: c?.status ?? 'active' }); f.setErrors({}); }, [edit]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Card padded={false} title="Fabric categories" description="Each category can carry its own attributes on top of the global dictionary." actions={can('masters.product.manage') && <Button size="sm" variant="primary" icon={<Plus className="size-3.5" />} onClick={() => setEdit('new')}>Add category</Button>}>
      <SimpleTable rows={q.data ?? []} rowKey={(r) => r.id} onRowClick={can('masters.product.manage') ? setEdit : undefined} columns={[
        { key: 'code', header: 'Code', render: (r) => <span className="font-mono text-[12.5px] font-semibold">{r.code}</span> },
        { key: 'name', header: 'Name', render: (r) => <span className="font-medium text-slate-900">{r.name}</span> },
        { key: 'hsn', header: 'Default HSN', render: (r) => <span className="font-mono text-[12.5px]">{r.hsn_code ?? '—'}</span> },
        { key: 'desc', header: 'Description', render: (r) => r.description ?? '—' },
        { key: 'n', header: 'SKUs', align: 'right', render: (r) => r.product_count },
        { key: 's', header: 'Status', render: (r) => <StatusBadge status={r.status} /> },
      ]} />
      <Drawer open={!!edit} onClose={() => setEdit(null)} title={edit === 'new' ? 'Add category' : 'Edit category'} footer={<><Button onClick={() => setEdit(null)}>Cancel</Button><Button variant="primary" onClick={async () => {
        try {
          const body = { ...clean(f.values), version: edit !== 'new' ? edit?.version : undefined };
          if (edit === 'new') await api.post('/masters/fabric-categories', body); else await api.patch(`/masters/fabric-categories/${edit!.id}`, body);
          qc.invalidateQueries({ queryKey: ['fabric-categories'] }); setEdit(null); toast({ tone: 'success', title: 'Category saved' });
        } catch (e) { f.handleError(e); }
      }}>Save</Button></>}>
        <div className="space-y-4">
          {f.formError && <Notice tone="danger">{f.formError}</Notice>}
          <div className="grid grid-cols-3 gap-4">
            <Input label="Code" required disabled={edit !== 'new'} {...f.bind('code')} />
            <Input label="Name" required className="col-span-2" {...f.bind('name')} />
          </div>
          <Select label="Default HSN code" placeholder="None" options={hsn.data?.map((h) => ({ value: h.code, label: `${h.code} · ${h.description}` })) ?? []} {...f.bind('hsn_code')} />
          <Textarea label="Description" {...f.bind('description')} />
          <Select label="Status" options={[{ value: 'active', label: 'Active' }, { value: 'inactive', label: 'Inactive' }]} {...f.bind('status')} />
        </div>
      </Drawer>
    </Card>
  );
}

function Attributes() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['attribute-definitions', 'all'], queryFn: () => api.get<AttrDef[]>('/masters/attribute-definitions') });
  const cats = useQuery({ queryKey: ['fabric-categories'], queryFn: () => api.get<Category[]>('/masters/fabric-categories') });
  const [edit, setEdit] = useState<AttrDef | 'new' | null>(null);
  const empty = { category_id: '', key: '', label: '', data_type: 'text', unit: '', options: '', min_value: '', max_value: '', required: false as boolean, level: 'product', group_name: 'Specification', sort_order: '100', status: 'active' };
  const f = useForm(empty);
  useEffect(() => {
    const d = edit && edit !== 'new' ? edit : null;
    f.setValues(d ? { category_id: d.category_id ?? '', key: d.key, label: d.label, data_type: d.data_type, unit: d.unit ?? '', options: (d.options ?? []).join(', '), min_value: d.min_value == null ? '' : String(d.min_value), max_value: d.max_value == null ? '' : String(d.max_value), required: d.required, level: d.level, group_name: d.group_name, sort_order: String(d.sort_order), status: d.status } : empty);
    f.setErrors({});
  }, [edit]); // eslint-disable-line react-hooks/exhaustive-deps
  async function save() {
    try {
      const v = clean(f.values, ['min_value', 'max_value', 'sort_order']);
      const body = { ...v, required: f.values.required, options: ['select', 'multiselect'].includes(f.values.data_type) ? f.values.options.split(',').map((s) => s.trim()).filter(Boolean) : null, version: edit !== 'new' ? edit?.version : undefined };
      if (edit === 'new') await api.post('/masters/attribute-definitions', body); else await api.patch(`/masters/attribute-definitions/${edit!.id}`, body);
      qc.invalidateQueries({ queryKey: ['attribute-definitions'] }); setEdit(null); toast({ tone: 'success', title: 'Attribute saved' });
    } catch (e) { f.handleError(e); }
  }
  return (
    <Card padded={false} title="Attribute dictionary" description="Add fabric attributes without code changes. Product-level attributes appear on SKUs; lot and roll attributes are captured at inward and QC."
      actions={can('masters.product.manage') && <Button size="sm" variant="primary" icon={<Plus className="size-3.5" />} onClick={() => setEdit('new')}>Add attribute</Button>}>
      <SimpleTable rows={q.data ?? []} rowKey={(r) => r.id} onRowClick={can('masters.product.manage') ? setEdit : undefined} columns={[
        { key: 'label', header: 'Attribute', render: (r) => <div><p className="font-medium text-slate-900">{r.label}{r.required && <span className="text-rose-500"> *</span>}</p><p className="font-mono text-[11.5px] text-slate-500">{r.key}</p></div> },
        { key: 'level', header: 'Level', render: (r) => <Badge tone={LEVEL_TONE[r.level]}>{humanize(r.level)}</Badge> },
        { key: 'scope', header: 'Applies to', render: (r) => r.category_name ?? <span className="text-slate-500">All categories</span> },
        { key: 'type', header: 'Type', render: (r) => <span>{humanize(r.data_type)}{r.unit ? ` · ${r.unit}` : ''}</span> },
        { key: 'rule', header: 'Rule', render: (r) => <span className="text-[12.5px] text-slate-600">{r.options?.length ? `${r.options.length} options` : r.min_value != null || r.max_value != null ? `${r.min_value ?? '…'}–${r.max_value ?? '…'}` : '—'}</span> },
        { key: 'group', header: 'Group', render: (r) => r.group_name },
        { key: 's', header: 'Status', render: (r) => <StatusBadge status={r.status} /> },
      ]} />
      <Drawer open={!!edit} onClose={() => setEdit(null)} title={edit === 'new' ? 'Add attribute' : `Edit ${(edit as AttrDef | null)?.label ?? ''}`} footer={<><Button onClick={() => setEdit(null)}>Cancel</Button><Button variant="primary" onClick={save}>Save</Button></>}>
        <div className="space-y-4">
          {f.formError && <Notice tone="danger">{f.formError}</Notice>}
          <div className="grid grid-cols-2 gap-4">
            <Input label="Label" required {...f.bind('label')} />
            <Input label="Key" required disabled={edit !== 'new'} {...f.bind('key')} hint="lowercase_with_underscores" />
            <Select label="Applies to" disabled={edit !== 'new'} placeholder="All categories" options={cats.data?.map((c) => ({ value: c.id, label: c.name })) ?? []} {...f.bind('category_id')} />
            <Select label="Captured at" options={[{ value: 'product', label: 'Product (SKU)' }, { value: 'lot', label: 'Lot / batch' }, { value: 'roll', label: 'Roll' }]} {...f.bind('level')} />
            <Select label="Data type" options={['text', 'number', 'select', 'multiselect', 'boolean'].map((t) => ({ value: t, label: humanize(t) }))} {...f.bind('data_type')} />
            <Input label="Unit" {...f.bind('unit')} placeholder="g/m², inch, %" />
            {['select', 'multiselect'].includes(f.values.data_type) && <Input label="Options" required className="col-span-2" {...f.bind('options')} hint="Comma separated" />}
            {f.values.data_type === 'number' && <><Input label="Minimum" type="number" {...f.bind('min_value')} /><Input label="Maximum" type="number" {...f.bind('max_value')} /></>}
            <Input label="Group" {...f.bind('group_name')} />
            <Input label="Sort order" type="number" {...f.bind('sort_order')} />
            <Select label="Status" options={[{ value: 'active', label: 'Active' }, { value: 'inactive', label: 'Inactive' }]} {...f.bind('status')} />
          </div>
          <Checkbox label="Required" description="Records cannot be saved without this value" checked={f.values.required} onChange={(e) => f.set('required', e.target.checked)} />
        </div>
      </Drawer>
    </Card>
  );
}

function PriceLists() {
  const q = useQuery({ queryKey: ['price-lists'], queryFn: () => api.get<{ id: string; code: string; name: string; valid_from: string; valid_to: string | null; status: string; item_count: number }[]>('/masters/price-lists') });
  return (
    <Card padded={false} title="Price lists" description="Base selling rates per KG. Negotiated, customer-specific and approval-controlled pricing arrives with CRM & commercial controls (P5).">
      <SimpleTable rows={q.data ?? []} rowKey={(r) => r.id} columns={[
        { key: 'code', header: 'Code', render: (r) => <span className="font-mono text-[12.5px] font-semibold">{r.code}</span> },
        { key: 'name', header: 'Name', render: (r) => r.name },
        { key: 'from', header: 'Valid from', render: (r) => fmtDate(r.valid_from) },
        { key: 'to', header: 'Valid to', render: (r) => fmtDate(r.valid_to) },
        { key: 'n', header: 'Items', align: 'right', render: (r) => r.item_count },
        { key: 's', header: 'Status', render: (r) => <StatusBadge status={r.status} /> },
      ]} empty={<div className="px-6 py-10 text-center text-[13px] text-slate-500">No price lists yet. Approved selling price per KG is tagged at lot inward in P4.</div>} />
    </Card>
  );
}

