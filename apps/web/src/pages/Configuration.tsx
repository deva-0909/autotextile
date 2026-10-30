import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CalendarRange, Hash, Pencil, Plus, SlidersHorizontal } from 'lucide-react';
import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fmtDate, fmtDateTime, humanize } from '../lib/format';
import { clean, useForm } from '../components/form';
import { SimpleTable } from '../components/DataTable';
import { Drawer, Modal, useToast } from '../components/overlay';
import { Badge, Button, Card, Input, Notice, PageHeader, Select, Skeleton, StatusBadge, Switch, Tabs, Textarea } from '../components/ui';

interface Setting { key: string; category: string; label: string; description: string | null; value_type: string; options: string[] | null; value: unknown; requires_ca_validation: boolean; updated_at: string }
interface FiscalYear { id: string; code: string; start_date: string; end_date: string; status: string; is_current: boolean }
interface Series { id: string; doc_type: string; gst_registration_id: string | null; gstin: string | null; fiscal_year: string; fiscal_year_id: string; prefix: string; padding: number; next_number: number; status: string; version: number }

type Tab = 'rules' | 'fiscal' | 'numbering';

export function ConfigurationPage() {
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') as Tab) ?? 'rules';
  return (
    <>
      <PageHeader
        title="Configuration"
        description="Business rules, fiscal years and GSTIN-wise document numbering. Every change requires a reason and is audited."
        breadcrumbs={[{ label: 'Organisation' }, { label: 'Configuration' }]}
      />
      <Tabs
        className="mb-6"
        value={tab}
        onChange={(t) => setParams({ tab: t })}
        tabs={[
          { value: 'rules', label: <span className="flex items-center gap-2"><SlidersHorizontal className="size-4" />Business rules</span> },
          { value: 'fiscal', label: <span className="flex items-center gap-2"><CalendarRange className="size-4" />Fiscal years</span> },
          { value: 'numbering', label: <span className="flex items-center gap-2"><Hash className="size-4" />Document numbering</span> },
        ]}
      />
      {tab === 'rules' && <Rules />}
      {tab === 'fiscal' && <FiscalYears />}
      {tab === 'numbering' && <Numbering />}
    </>
  );
}

function display(s: Setting) {
  const v = s.value;
  if (s.value_type === 'boolean') return v ? <Badge tone="success">On</Badge> : <Badge>Off</Badge>;
  if (s.value_type === 'percent') return `${v}%`;
  if (s.value_type === 'list') return (v as number[]).join(', ');
  if (s.value_type === 'select') return humanize(String(v));
  return String(v);
}

function Rules() {
  const { can } = useAuth();
  const q = useQuery({ queryKey: ['settings'], queryFn: () => api.get<Setting[]>('/organisation/settings') });
  const [edit, setEdit] = useState<Setting | null>(null);
  if (!q.data) return <Skeleton className="h-96" />;
  const groups = [...new Set(q.data.map((s) => s.category))];
  return (
    <div className="space-y-6">
      <Notice tone="warning" icon={<AlertTriangle className="size-4" />} title="Values are placeholders until confirmed">
        Items flagged “CA validation” must be confirmed by the client’s chartered accountant before production (Decisions & Risks register).
      </Notice>
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
        {groups.map((g) => (
          <Card key={g} title={g} padded={false}>
            <ul className="divide-y divide-slate-100">
              {q.data!.filter((s) => s.category === g).map((s) => (
                <li key={s.key} className="flex items-center gap-4 px-5 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-center gap-2 text-[13.5px] font-medium text-slate-900">
                      {s.label}
                      {s.requires_ca_validation && <Badge tone="warning">CA validation</Badge>}
                    </p>
                    {s.description && <p className="mt-0.5 text-[12px] text-slate-500">{s.description}</p>}
                  </div>
                  <span className="shrink-0 text-[13.5px] font-semibold text-slate-900 tabular">{display(s)}</span>
                  {can('org.config.manage') && <Button size="xs" variant="ghost" icon={<Pencil className="size-3" />} onClick={() => setEdit(s)}>Change</Button>}
                </li>
              ))}
            </ul>
          </Card>
        ))}
      </div>
      {edit && <SettingModal setting={edit} onClose={() => setEdit(null)} />}
    </div>
  );
}

function SettingModal({ setting, onClose }: { setting: Setting; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [value, setValue] = useState<unknown>(setting.value_type === 'list' ? (setting.value as number[]).join(', ') : setting.value);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  async function save() {
    setSaving(true);
    setError(null);
    try {
      let v: unknown = value;
      if (['number', 'percent'].includes(setting.value_type)) v = Number(value);
      if (setting.value_type === 'list') v = String(value).split(',').map((x) => Number(x.trim())).filter((x) => !Number.isNaN(x));
      await api.put(`/organisation/settings/${setting.key}`, { value: v, reason });
      qc.invalidateQueries({ queryKey: ['settings'] });
      toast({ tone: 'success', title: `${setting.label} updated` });
      onClose();
    } catch (e) { setError((e as Error).message); } finally { setSaving(false); }
  }
  return (
    <Modal open onClose={onClose} title={setting.label} description={setting.description}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={saving} disabled={reason.trim().length < 3} onClick={save}>Save change</Button></>}>
      <div className="space-y-4">
        {error && <Notice tone="danger">{error}</Notice>}
        {setting.requires_ca_validation && <Notice tone="warning">Confirm this value with the CA before relying on it in production.</Notice>}
        {setting.value_type === 'boolean' && <Switch checked={!!value} onChange={setValue} label={value ? 'On' : 'Off'} />}
        {['number', 'percent'].includes(setting.value_type) && <Input label="Value" type="number" min={0} max={setting.value_type === 'percent' ? 100 : undefined} step="any" value={String(value)} onChange={(e) => setValue(e.target.value)} suffix={setting.value_type === 'percent' ? '%' : undefined} />}
        {setting.value_type === 'select' && <Select label="Value" value={String(value)} onChange={(e) => setValue(e.target.value)} options={(setting.options ?? []).map((o) => ({ value: o, label: humanize(o) }))} />}
        {setting.value_type === 'list' && <Input label="Values (comma separated)" value={String(value)} onChange={(e) => setValue(e.target.value)} />}
        {setting.value_type === 'text' && <Input label="Value" value={String(value)} onChange={(e) => setValue(e.target.value)} />}
        <Textarea label="Reason for change" required value={reason} onChange={(e) => setReason(e.target.value)} hint="Recorded in the audit trail" />
        <p className="text-[12px] text-slate-500">Last changed {fmtDateTime(setting.updated_at)}</p>
      </div>
    </Modal>
  );
}

function FiscalYears() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['fiscal-years'], queryFn: () => api.get<FiscalYear[]>('/organisation/fiscal-years') });
  const [adding, setAdding] = useState(false);
  const f = useForm({ code: '', start_date: '', end_date: '' });
  return (
    <Card title="Fiscal years" description="Exactly one open fiscal year is current; document numbering follows it." padded={false}
      actions={can('org.config.manage') && <Button size="sm" variant="primary" icon={<Plus className="size-3.5" />} onClick={() => setAdding(true)}>Add fiscal year</Button>}>
      <SimpleTable
        rows={q.data ?? []}
        rowKey={(r) => r.id}
        columns={[
          { key: 'code', header: 'Fiscal year', render: (r) => <span className="font-medium text-slate-900">{r.code}</span> },
          { key: 'from', header: 'Starts', render: (r) => fmtDate(r.start_date) },
          { key: 'to', header: 'Ends', render: (r) => fmtDate(r.end_date) },
          { key: 'status', header: 'Status', render: (r) => <span className="flex gap-2"><StatusBadge status={r.status} />{r.is_current && <Badge tone="brand">Current</Badge>}</span> },
          { key: 'act', header: '', align: 'right', render: (r) => can('org.config.manage') && !r.is_current && r.status === 'open' && (
            <Button size="xs" onClick={async () => { await api.post(`/organisation/fiscal-years/${r.id}/set-current`); qc.invalidateQueries({ queryKey: ['fiscal-years'] }); toast({ tone: 'success', title: `${r.code} is now current` }); }}>Make current</Button>
          ) },
        ]}
      />
      <Modal open={adding} onClose={() => setAdding(false)} title="Add fiscal year"
        footer={<><Button onClick={() => setAdding(false)}>Cancel</Button><Button variant="primary" onClick={async () => {
          try { await api.post('/organisation/fiscal-years', f.values); qc.invalidateQueries({ queryKey: ['fiscal-years'] }); setAdding(false); f.reset(); toast({ tone: 'success', title: 'Fiscal year added' }); } catch (e) { f.handleError(e); }
        }}>Add</Button></>}>
        <div className="space-y-4">
          {f.formError && <Notice tone="danger">{f.formError}</Notice>}
          <Input label="Code" placeholder="FY2027-28" required {...f.bind('code')} />
          <div className="grid grid-cols-2 gap-4">
            <Input label="Start date" type="date" required {...f.bind('start_date')} />
            <Input label="End date" type="date" required {...f.bind('end_date')} />
          </div>
        </div>
      </Modal>
    </Card>
  );
}

function Numbering() {
  const { can } = useAuth();
  const q = useQuery({ queryKey: ['number-series'], queryFn: () => api.get<Series[]>('/organisation/number-series') });
  const [edit, setEdit] = useState<Series | 'new' | null>(null);
  return (
    <>
      <Card title="Document number series" description="GSTIN-wise series for tax documents; company-wide series for internal documents. Tax invoice numbers are limited to 16 characters." padded={false}
        actions={can('org.config.manage') && <Button size="sm" variant="primary" icon={<Plus className="size-3.5" />} onClick={() => setEdit('new')}>Add series</Button>}>
        <SimpleTable
          rows={q.data ?? []}
          rowKey={(r) => r.id}
          onRowClick={can('org.config.manage') ? (r) => setEdit(r) : undefined}
          columns={[
            { key: 'doc', header: 'Document', render: (r) => <span className="font-medium text-slate-900">{humanize(r.doc_type)}</span> },
            { key: 'gstin', header: 'GST registration', render: (r) => r.gstin ? <span className="font-mono text-[12.5px]">{r.gstin}</span> : <Badge>Company-wide</Badge> },
            { key: 'fy', header: 'Fiscal year', render: (r) => r.fiscal_year },
            { key: 'next', header: 'Next number', render: (r) => <span className="font-mono text-[12.5px] text-slate-900">{r.prefix}{String(r.next_number).padStart(r.padding, '0')}</span> },
            { key: 'status', header: 'Status', render: (r) => <StatusBadge status={r.status} /> },
          ]}
        />
      </Card>
      {edit && <SeriesDrawer series={edit === 'new' ? undefined : edit} onClose={() => setEdit(null)} />}
    </>
  );
}

function SeriesDrawer({ series, onClose }: { series?: Series; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const fy = useQuery({ queryKey: ['fiscal-years'], queryFn: () => api.get<FiscalYear[]>('/organisation/fiscal-years') });
  const gst = useQuery({ queryKey: ['gst-registrations'], queryFn: () => api.get<{ id: string; gstin: string }[]>('/organisation/gst-registrations') });
  const f = useForm({
    doc_type: series?.doc_type ?? '', gst_registration_id: series?.gst_registration_id ?? '', fiscal_year_id: series?.fiscal_year_id ?? '',
    prefix: series?.prefix ?? '', padding: String(series?.padding ?? 5), next_number: String(series?.next_number ?? 1), status: series?.status ?? 'active',
  });
  const preview = `${f.values.prefix}${String(f.values.next_number || 1).padStart(Number(f.values.padding) || 1, '0')}`;
  async function save() {
    try {
      const v = clean(f.values, ['padding', 'next_number']);
      if (series) await api.patch(`/organisation/number-series/${series.id}`, { prefix: v.prefix ?? '', padding: v.padding, next_number: v.next_number, status: v.status, version: series.version });
      else await api.post('/organisation/number-series', { ...v, prefix: v.prefix ?? '' });
      qc.invalidateQueries({ queryKey: ['number-series'] });
      toast({ tone: 'success', title: 'Number series saved' });
      onClose();
    } catch (e) { f.handleError(e); }
  }
  return (
    <Drawer open onClose={onClose} title={series ? 'Edit number series' : 'Add number series'}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={save}>Save</Button></>}>
      <div className="space-y-4">
        {f.formError && <Notice tone="danger">{f.formError}</Notice>}
        <Input label="Document type" required disabled={!!series} placeholder="tax_invoice" {...f.bind('doc_type')} />
        <Select label="GST registration" disabled={!!series} placeholder="Company-wide (internal documents)" options={gst.data?.map((g) => ({ value: g.id, label: g.gstin })) ?? []} {...f.bind('gst_registration_id')} />
        <Select label="Fiscal year" required disabled={!!series} placeholder="Select" options={fy.data?.map((y) => ({ value: y.id, label: y.code })) ?? []} {...f.bind('fiscal_year_id')} />
        <div className="grid grid-cols-3 gap-4">
          <Input label="Prefix" {...f.bind('prefix')} onChange={(e) => f.set('prefix', e.target.value.toUpperCase())} />
          <Input label="Digits" type="number" min={1} max={10} {...f.bind('padding')} />
          <Input label="Next number" type="number" min={1} {...f.bind('next_number')} />
        </div>
        <div className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3">
          <p className="text-[12px] text-slate-500">Next document will be</p>
          <p className="mt-0.5 font-mono text-[16px] font-semibold text-slate-900">{preview}</p>
          <p className={`mt-1 text-[12px] ${preview.length > 16 ? 'text-rose-600' : 'text-slate-500'}`}>{preview.length}/16 characters</p>
        </div>
        <Select label="Status" options={[{ value: 'active', label: 'Active' }, { value: 'inactive', label: 'Inactive' }]} {...f.bind('status')} />
      </div>
    </Drawer>
  );
}
