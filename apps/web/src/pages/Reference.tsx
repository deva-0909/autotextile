import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fmtDate, humanize } from '../lib/format';
import { SimpleTable } from '../components/DataTable';
import { useForm } from '../components/form';
import { Drawer, useToast } from '../components/overlay';
import { Badge, Button, Card, Checkbox, Input, Notice, PageHeader, Select, StatusBadge, Tabs } from '../components/ui';

type Row = Record<string, unknown> & { id: string; status: string; version: number };
interface FieldDef { key: string; label: string; type?: 'text' | 'number' | 'select' | 'bool' | 'list' | 'date'; options?: string[]; required?: boolean; locked?: boolean; hint?: string }
interface TableDef { path: string; title: string; description: string; fields: FieldDef[]; columns: { key: string; header: string; render?: (r: Row) => React.ReactNode }[] }

const TABLES: TableDef[] = [
  {
    path: 'hsn-codes', title: 'HSN / SAC & GST', description: 'Tax codes and rates. Rates are marked unverified until the CA confirms them.',
    fields: [
      { key: 'code', label: 'HSN / SAC code', required: true, locked: true }, { key: 'description', label: 'Description', required: true },
      { key: 'kind', label: 'Kind', type: 'select', options: ['goods', 'service'] }, { key: 'gst_rate', label: 'GST rate (%)', type: 'number', required: true },
      { key: 'cess_rate', label: 'Cess (%)', type: 'number' }, { key: 'effective_from', label: 'Effective from', type: 'date', required: true },
      { key: 'ca_verified', label: 'Verified by CA', type: 'bool' },
    ],
    columns: [
      { key: 'code', header: 'Code', render: (r) => <span className="font-mono font-semibold">{String(r.code)}</span> },
      { key: 'description', header: 'Description' },
      { key: 'kind', header: 'Kind', render: (r) => humanize(String(r.kind)) },
      { key: 'gst_rate', header: 'GST', render: (r) => <span className="font-semibold tabular">{String(r.gst_rate)}%</span> },
      { key: 'effective_from', header: 'Effective', render: (r) => fmtDate(String(r.effective_from)) },
      { key: 'ca_verified', header: 'CA', render: (r) => (r.ca_verified ? <Badge tone="success">Verified</Badge> : <Badge tone="warning">Unverified</Badge>) },
    ],
  },
  {
    path: 'uoms', title: 'Units of measure', description: 'Fabric is sold and stocked by KG; rolls and metres are tracked alongside.',
    fields: [{ key: 'code', label: 'Code', required: true, locked: true }, { key: 'name', label: 'Name', required: true }, { key: 'category', label: 'Category', type: 'select', options: ['weight', 'length', 'count', 'area'] }, { key: 'decimals', label: 'Decimals', type: 'number' }],
    columns: [{ key: 'code', header: 'Code', render: (r) => <span className="font-mono font-semibold">{String(r.code)}</span> }, { key: 'name', header: 'Name' }, { key: 'category', header: 'Category', render: (r) => humanize(String(r.category)) }, { key: 'decimals', header: 'Decimals' }],
  },
  {
    path: 'payment-terms', title: 'Payment terms', description: 'Advance, token and credit terms offered to customers and agreed with suppliers.',
    fields: [{ key: 'code', label: 'Code', required: true, locked: true }, { key: 'name', label: 'Name', required: true }, { key: 'credit_days', label: 'Credit days', type: 'number' }, { key: 'advance_percent', label: 'Advance %', type: 'number' }, { key: 'description', label: 'Description' }],
    columns: [{ key: 'code', header: 'Code', render: (r) => <span className="font-mono font-semibold">{String(r.code)}</span> }, { key: 'name', header: 'Name' }, { key: 'credit_days', header: 'Credit days' }, { key: 'advance_percent', header: 'Advance', render: (r) => `${r.advance_percent}%` }, { key: 'description', header: 'Description' }],
  },
  {
    path: 'reason-codes', title: 'Reason codes', description: 'Mandatory reasons for adjustments, rejections, overrides, returns and lost leads.',
    fields: [{ key: 'category', label: 'Category', required: true, locked: true, hint: 'e.g. stock_adjustment' }, { key: 'code', label: 'Code', required: true, locked: true }, { key: 'description', label: 'Description', required: true }],
    columns: [{ key: 'category', header: 'Category', render: (r) => <Badge>{humanize(String(r.category))}</Badge> }, { key: 'code', header: 'Code', render: (r) => <span className="font-mono">{String(r.code)}</span> }, { key: 'description', header: 'Description' }],
  },
  {
    path: 'document-types', title: 'Document types', description: 'Types available in the document manager, with retention and expiry rules.',
    fields: [{ key: 'code', label: 'Code', required: true, locked: true }, { key: 'name', label: 'Name', required: true }, { key: 'applies_to', label: 'Applies to', type: 'list', hint: 'customer, supplier, mill, product…' }, { key: 'retention_years', label: 'Retention (years)', type: 'number' }, { key: 'requires_expiry', label: 'Requires expiry date', type: 'bool' }],
    columns: [{ key: 'code', header: 'Code', render: (r) => <span className="font-mono">{String(r.code)}</span> }, { key: 'name', header: 'Name' }, { key: 'applies_to', header: 'Applies to', render: (r) => (r.applies_to as string[]).join(', ') }, { key: 'retention_years', header: 'Retention', render: (r) => `${r.retention_years} y` }, { key: 'requires_expiry', header: 'Expiry', render: (r) => (r.requires_expiry ? 'Required' : '—') }],
  },
];

export function ReferencePage() {
  const [params, setParams] = useSearchParams();
  const t = TABLES.find((x) => x.path === params.get('t')) ?? TABLES[0]!;
  return (
    <>
      <PageHeader title="Reference data" description="Shared lists used across purchase, sales, inventory and accounting." breadcrumbs={[{ label: 'Master data' }, { label: 'Reference data' }]} />
      <Tabs className="mb-5" value={t.path} onChange={(v) => setParams({ t: v })} tabs={TABLES.map((x) => ({ value: x.path, label: x.title }))} />
      <RefTable key={t.path} def={t} />
    </>
  );
}

function RefTable({ def }: { def: TableDef }) {
  const { can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: [def.path], queryFn: () => api.get<Row[]>(`/masters/${def.path}`) });
  const [edit, setEdit] = useState<Row | 'new' | null>(null);
  const blank = Object.fromEntries([...def.fields.map((f) => [f.key, f.type === 'bool' ? false : '']), ['status', 'active']]) as Record<string, unknown>;
  const form = useForm(blank);
  useEffect(() => {
    if (!edit) return;
    const r = edit === 'new' ? blank : edit;
    form.setValues(Object.fromEntries([...def.fields.map((f) => [f.key, f.type === 'list' ? ((r[f.key] as string[]) ?? []).join(', ') : f.type === 'bool' ? !!r[f.key] : r[f.key] == null ? '' : String(r[f.key])]), ['status', r.status ?? 'active']]));
    form.setErrors({});
  }, [edit]); // eslint-disable-line react-hooks/exhaustive-deps
  const manage = can('masters.reference.manage');

  async function save() {
    const body: Record<string, unknown> = { status: form.values.status, version: edit !== 'new' ? edit?.version : undefined };
    for (const f of def.fields) {
      const v = form.values[f.key];
      body[f.key] = f.type === 'number' ? (v === '' ? 0 : Number(v)) : f.type === 'list' ? String(v).split(',').map((s) => s.trim()).filter(Boolean) : f.type === 'bool' ? !!v : v === '' ? null : v;
    }
    try {
      if (edit === 'new') await api.post(`/masters/${def.path}`, body);
      else await api.patch(`/masters/${def.path}/${edit!.id}`, body);
      qc.invalidateQueries({ queryKey: [def.path] });
      toast({ tone: 'success', title: 'Saved' });
      setEdit(null);
    } catch (e) { form.handleError(e); }
  }

  return (
    <Card padded={false} title={def.title} description={def.description} actions={manage && <Button size="sm" variant="primary" icon={<Plus className="size-3.5" />} onClick={() => setEdit('new')}>Add</Button>}>
      <SimpleTable rows={q.data ?? []} rowKey={(r) => r.id} onRowClick={manage ? setEdit : undefined}
        columns={[...def.columns.map((c) => ({ key: c.key, header: c.header, render: c.render ?? ((r: Row) => String(r[c.key] ?? '—')) })), { key: 'status', header: 'Status', render: (r: Row) => <StatusBadge status={r.status} /> }]} />
      <Drawer open={!!edit} onClose={() => setEdit(null)} title={edit === 'new' ? `Add to ${def.title.toLowerCase()}` : 'Edit'} footer={<><Button onClick={() => setEdit(null)}>Cancel</Button><Button variant="primary" onClick={save}>Save</Button></>}>
        <div className="space-y-4">
          {form.formError && <Notice tone="danger">{form.formError}</Notice>}
          {def.fields.map((f) => {
            const common = { label: f.label, required: f.required, disabled: f.locked && edit !== 'new', hint: f.hint, error: form.errors[f.key] };
            if (f.type === 'bool') return <Checkbox key={f.key} label={f.label} checked={!!form.values[f.key]} onChange={(e) => form.set(f.key, e.target.checked)} />;
            if (f.type === 'select') return <Select key={f.key} {...common} value={String(form.values[f.key])} onChange={(e) => form.set(f.key, e.target.value)} options={f.options!.map((o) => ({ value: o, label: humanize(o) }))} />;
            return <Input key={f.key} {...common} type={f.type === 'number' ? 'number' : f.type === 'date' ? 'date' : 'text'} step="any" value={String(form.values[f.key] ?? '')} onChange={(e) => form.set(f.key, e.target.value)} />;
          })}
          <Select label="Status" value={String(form.values.status)} onChange={(e) => form.set('status', e.target.value)} options={[{ value: 'active', label: 'Active' }, { value: 'inactive', label: 'Inactive' }]} />
        </div>
      </Drawer>
    </Card>
  );
}
