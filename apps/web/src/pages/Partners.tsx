import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Building, Factory, Landmark, Mail, MapPin, Pencil, Phone, Plus, ShieldAlert, Star, Trash2, Truck, Users } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Link } from '../components/AppLink';
import { api, invalidatePrefix, qs } from '../lib/api';
import { useAuth } from '../lib/auth';
import { GST_STATES, fmtDate, fmtDateTime, fmtINR, gstinProblem, humanize } from '../lib/format';
import { DataTable, FilterSelect, type Column } from '../components/DataTable';
import { clean, useForm } from '../components/form';
import { ConfirmDialog, Drawer, Modal, useToast } from '../components/overlay';
import { AuditTimeline } from '../components/AuditTrail';
import { DocumentsPanel } from '../components/Documents';
import { Badge, Button, Card, ErrorState, Input, KeyValue, Notice, PageHeader, Select, Skeleton, StatusBadge, Tabs, Textarea, Checkbox } from '../components/ui';

export type PartyType = 'customer' | 'supplier' | 'manufacturer' | 'mill' | 'transporter';
const TYPES: { value: PartyType; label: string; plural: string; icon: typeof Users; perm: string }[] = [
  { value: 'customer', label: 'Customer', plural: 'Customers', icon: Users, perm: 'masters.customer.manage' },
  { value: 'supplier', label: 'Supplier', plural: 'Suppliers', icon: Building, perm: 'masters.supplier.manage' },
  { value: 'manufacturer', label: 'Manufacturer', plural: 'Manufacturers', icon: Factory, perm: 'masters.supplier.manage' },
  { value: 'mill', label: 'Mill', plural: 'Processing mills', icon: Factory, perm: 'masters.mill.manage' },
  { value: 'transporter', label: 'Transporter', plural: 'Transporters', icon: Truck, perm: 'masters.transporter.manage' },
];
const typeInfo = (t: string) => TYPES.find((x) => x.value === t) ?? TYPES[0]!;
const STATES = Object.entries(GST_STATES).map(([code, name]) => ({ value: code, label: `${code} · ${name}` }));

interface PartyRow { id: string; party_type: PartyType; code: string; legal_name: string; trade_name: string | null; gstin: string | null; state_code: string | null; email: string | null; phone: string | null; segment: string | null; credit_limit: number | null; rating: number | null; tags: string[]; status: string; updated_at: string; payment_term: string | null; primary_contact: string | null; has_pending_approval: boolean }
interface Contact { id: string; name: string; designation: string | null; email: string | null; phone: string | null; is_primary: boolean; version: number }
interface Address { id: string; kind: string; line1: string; line2: string | null; city: string; state_code: string; pincode: string; gstin: string | null; is_default: boolean; version: number }
interface Bank { id: string; account_name: string; account_number: string; ifsc: string; bank_name: string | null; branch: string | null; status: string; masked: boolean; created_at: string; decided_at: string | null; decision_comment: string | null }
interface Pending { id: string; changes: Record<string, unknown>; previous: Record<string, unknown>; reason: string; status: string; requested_at: string; decided_at: string | null; decision_comment: string | null }
export interface Party extends PartyRow { pan: string | null; gst_treatment: string; website: string | null; payment_term_id: string | null; profile: Record<string, unknown>; owner_user_id: string | null; notes: string | null; version: number; created_at: string; contacts: Contact[]; addresses: Address[]; bank_accounts: Bank[]; pending_changes: Pending[] }

export function PartnersPage() {
  const { type = 'customer' } = useParams();
  const nav = useNavigate();
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [creating, setCreating] = useState(params.get('new') === '1');
  const info = typeInfo(type);
  useEffect(() => setFilters({}), [type]);

  const columns: Column<PartyRow>[] = [
    { key: 'name', header: 'Name', sort: 'legal_name', csv: (r) => r.legal_name, render: (r) => (
      <div className="min-w-[220px]">
        <p className="flex items-center gap-2 font-medium text-slate-900">{r.legal_name}{r.has_pending_approval && <span title="Change awaiting approval"><ShieldAlert className="size-3.5 text-amber-500" /></span>}</p>
        <p className="text-[12px] text-slate-500"><span className="font-mono">{r.code}</span>{r.primary_contact ? ` · ${r.primary_contact}` : ''}</p>
      </div>
    ) },
    { key: 'gstin', header: 'GSTIN', csv: (r) => r.gstin, render: (r) => r.gstin ? <span className="font-mono text-[12.5px]">{r.gstin}</span> : <span className="text-slate-400">Unregistered</span> },
    { key: 'state', header: 'State', sort: 'state_code', csv: (r) => (r.state_code ? GST_STATES[r.state_code] : ''), render: (r) => (r.state_code ? GST_STATES[r.state_code] : '—') },
    { key: 'phone', header: 'Phone', csv: (r) => r.phone, render: (r) => <span className="whitespace-nowrap">{r.phone ?? '—'}</span>, defaultHidden: type !== 'customer' },
    { key: 'email', header: 'Email', csv: (r) => r.email, render: (r) => r.email ?? '—', defaultHidden: true },
    { key: 'segment', header: type === 'mill' ? 'Speciality' : 'Segment', csv: (r) => r.segment, render: (r) => r.segment ? <Badge>{r.segment}</Badge> : '—' },
    ...(type === 'customer' ? [
      { key: 'terms', header: 'Terms', csv: (r: PartyRow) => r.payment_term, render: (r: PartyRow) => r.payment_term ?? '—' },
      { key: 'credit', header: 'Credit limit', align: 'right' as const, csv: (r: PartyRow) => r.credit_limit, render: (r: PartyRow) => fmtINR(r.credit_limit) },
    ] : []),
    { key: 'rating', header: 'Rating', csv: (r) => r.rating, render: (r) => r.rating ? <span className="inline-flex items-center gap-0.5 text-amber-500">{Array.from({ length: r.rating }).map((_, i) => <Star key={i} className="size-3 fill-current" />)}</span> : '—', defaultHidden: type === 'customer' },
    { key: 'status', header: 'Status', sort: 'status', csv: (r) => r.status, render: (r) => <StatusBadge status={r.status} /> },
  ];

  return (
    <>
      <PageHeader
        title="Business partners"
        description="Customers, suppliers, manufacturers, processing mills and transporters share one master with GST validation, duplicate detection and maker-checker controls."
        breadcrumbs={[{ label: 'Master data' }, { label: 'Business partners' }, { label: info.plural }]}
        actions={can(info.perm) && <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>New {info.label.toLowerCase()}</Button>}
      />
      <Tabs className="mb-5" value={type as PartyType} onChange={(t) => nav(`/partners/${t}`)} tabs={TYPES.map((t) => ({ value: t.value, label: t.plural }))} />
      <DataTable<PartyRow>
        key={type}
        id={`parties-${type}`}
        endpoint={`/masters/parties?f_type=${type}`}
        columns={columns}
        filters={filters}
        onFiltersChange={setFilters}
        defaultSort={{ key: 'legal_name', dir: 'asc' }}
        searchPlaceholder="Search name, code, GSTIN, phone, email…"
        onRowClick={(r) => nav(`/partners/${type}/${r.id}`)}
        exportName={info.plural.toLowerCase().replace(/\s/g, '-')}
        toolbar={<>
          <FilterSelect placeholder="All statuses" value={filters.status} onChange={(v) => setFilters({ ...filters, status: v })} options={[{ value: 'active', label: 'Active' }, { value: 'inactive', label: 'Inactive' }, { value: 'blocked', label: 'Blocked' }]} />
          <FilterSelect placeholder="All states" value={filters.state} onChange={(v) => setFilters({ ...filters, state: v })} options={Object.entries(GST_STATES).map(([c, n]) => ({ value: c, label: n }))} />
        </>}
        empty={{ title: `No ${info.plural.toLowerCase()} yet`, description: 'Add your first record to get started.', action: can(info.perm) && <Button variant="primary" onClick={() => setCreating(true)}>New {info.label.toLowerCase()}</Button> }}
      />
      {creating && <PartyDrawer type={type as PartyType} onClose={() => { setCreating(false); if (params.get('new')) setParams({}); }} onSaved={(id) => nav(`/partners/${type}/${id}`)} />}
    </>
  );
}

interface PaymentTerm { id: string; name: string; status: string }

interface ProfileField { key: string; label: string; list?: boolean; number?: boolean; hint?: string }
function profileFields(type: PartyType): ProfileField[] {
  if (type === 'mill') return [{ key: 'processes', label: 'Processes offered', list: true, hint: 'Comma separated, e.g. Dyeing, Compacting' }, { key: 'capacity_kg_per_day', label: 'Capacity (kg/day)', number: true }, { key: 'tat_days', label: 'Standard turnaround (days)', number: true }];
  if (type === 'transporter') return [{ key: 'modes', label: 'Modes', list: true, hint: 'FTL, PTL' }, { key: 'routes', label: 'Main routes', list: true }];
  if (type === 'supplier' || type === 'manufacturer') return [{ key: 'fabric_categories', label: 'Fabric categories supplied', list: true }];
  return [{ key: 'preferred_fabrics', label: 'Preferred fabrics', list: true }];
}

export function PartyDrawer({ type, party, onClose, onSaved }: { type: PartyType; party?: Party; onClose: () => void; onSaved?: (id: string) => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const terms = useQuery({ queryKey: ['payment-terms'], queryFn: () => api.get<PaymentTerm[]>('/masters/payment-terms') });
  const [saving, setSaving] = useState(false);
  const pf = profileFields(type);
  const f = useForm({
    legal_name: party?.legal_name ?? '', trade_name: party?.trade_name ?? '', gst_treatment: party?.gst_treatment ?? 'registered', gstin: party?.gstin ?? '',
    pan: party?.pan ?? '', state_code: party?.state_code ?? '', email: party?.email ?? '', phone: party?.phone ?? '', website: party?.website ?? '',
    payment_term_id: party?.payment_term_id ?? '', credit_limit: party?.credit_limit == null ? '' : String(party.credit_limit), segment: party?.segment ?? '',
    rating: party?.rating ? String(party.rating) : '', tags: party?.tags.join(', ') ?? '', notes: party?.notes ?? '', status: party?.status ?? 'active', reason: '',
    ...Object.fromEntries(pf.map((p) => [`profile_${p.key}`, Array.isArray(party?.profile[p.key]) ? (party!.profile[p.key] as string[]).join(', ') : String(party?.profile[p.key] ?? '')])),
  } as Record<string, string>);
  const g = f.values.gstin!.toUpperCase();
  const gstRequired = ['registered', 'composition', 'sez'].includes(f.values.gst_treatment!);
  const live = g.length === 15 ? gstinProblem(g) : null;
  const [dupes, setDupes] = useState<{ id: string; code: string; legal_name: string; party_type: string; gstin: string | null }[]>([]);
  const sensitiveChanged = party && (g !== (party.gstin ?? '') || f.values.legal_name !== party.legal_name || f.values.gst_treatment !== party.gst_treatment || (f.values.credit_limit || null) !== (party.credit_limit == null ? null : String(party.credit_limit)));

  useEffect(() => {
    const t = setTimeout(async () => {
      if (!(g.length === 15 && !live) && !(f.values.phone!.replace(/\D/g, '').length >= 10) && !f.values.email!.includes('@')) return setDupes([]);
      const r = await api.get<typeof dupes>(`/masters/parties/duplicates${qs({ gstin: g.length === 15 ? g : undefined, phone: f.values.phone || undefined, email: f.values.email || undefined, excludeId: party?.id })}`).catch(() => []);
      setDupes(r);
    }, 400);
    return () => clearTimeout(t);
  }, [g, live, f.values.phone, f.values.email, party?.id]);

  async function save() {
    setSaving(true);
    try {
      const v = clean(f.values, ['credit_limit', 'rating']);
      const profile: Record<string, unknown> = { ...(party?.profile ?? {}) };
      for (const p of pf) {
        const raw = f.values[`profile_${p.key}`] ?? '';
        profile[p.key] = p.list ? raw.split(',').map((s) => s.trim()).filter(Boolean) : p.number ? (raw ? Number(raw) : null) : raw;
        delete v[`profile_${p.key}`];
      }
      const body = { ...v, party_type: type, gstin: g || null, tags: (f.values.tags ?? '').split(',').map((s) => s.trim()).filter(Boolean), profile, version: party?.version };
      const r = party ? await api.patch<{ id: string; pending_change: unknown }>(`/masters/parties/${party.id}`, body) : await api.post<{ id: string }>('/masters/parties', body);
      invalidatePrefix(qc, '/masters/parties');
      qc.invalidateQueries({ queryKey: ['party'] });
      if (party && (r as unknown as { pending_change: unknown }).pending_change) toast({ tone: 'warning', title: 'Saved — sensitive change sent for approval', body: 'GSTIN, legal name or credit limit will update once a checker approves.' });
      else toast({ tone: 'success', title: party ? 'Changes saved' : `${typeInfo(type).label} created` });
      onSaved?.(r.id);
      onClose();
    } catch (e) { f.handleError(e); } finally { setSaving(false); }
  }

  return (
    <Drawer open onClose={onClose} width="lg" title={party ? `Edit ${party.legal_name}` : `New ${typeInfo(type).label.toLowerCase()}`}
      description={party ? <span className="font-mono">{party.code}</span> : 'A code is assigned automatically.'}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={saving} onClick={save} disabled={!!live}>{sensitiveChanged ? 'Save & request approval' : 'Save'}</Button></>}>
      <div className="space-y-6">
        {f.formError && <Notice tone="danger">{f.formError}</Notice>}
        {dupes.length > 0 && (
          <Notice tone="warning" icon={<AlertTriangle className="size-4" />} title="Possible duplicate">
            {dupes.map((d) => <div key={d.id}><Link className="link" to={`/partners/${d.party_type}/${d.id}`} target="_blank">{d.code} {d.legal_name}</Link> ({d.party_type}{d.gstin ? `, ${d.gstin}` : ''})</div>)}
            <p className="mt-1">Check before creating a new record. Never create a second record for the same GSTIN.</p>
          </Notice>
        )}
        <section>
          <h3 className="mb-3 text-[12px] font-semibold tracking-wide text-slate-500 uppercase">Identity & tax</h3>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Input label="Legal name" required className="sm:col-span-2" {...f.bind('legal_name')} hint={party ? 'Changing the legal name needs approval' : undefined} />
            <Input label="Trade name" {...f.bind('trade_name')} />
            <Select label="GST treatment" options={['registered', 'composition', 'unregistered', 'sez', 'overseas'].map((v) => ({ value: v, label: humanize(v) }))} {...f.bind('gst_treatment')} />
            <Input label="GSTIN" required={gstRequired} className="font-mono" maxLength={15} {...f.bind('gstin')} onChange={(e) => f.set('gstin', e.target.value.toUpperCase())}
              error={f.errors.gstin ?? live ?? undefined} hint={g.length === 15 && !live ? `✓ Valid · ${GST_STATES[g.slice(0, 2)]} · PAN ${g.slice(2, 12)}` : 'PAN and state are taken from the GSTIN'} />
            <Input label="PAN" disabled={g.length === 15 && !live} {...f.bind('pan')} onChange={(e) => f.set('pan', e.target.value.toUpperCase())} />
            <Select label="State" disabled={g.length === 15 && !live} placeholder="Select state" options={STATES} {...f.bind('state_code')} />
            <Select label="Status" options={[{ value: 'active', label: 'Active' }, { value: 'inactive', label: 'Inactive' }, { value: 'blocked', label: 'Blocked' }]} {...f.bind('status')} />
          </div>
        </section>
        <section>
          <h3 className="mb-3 text-[12px] font-semibold tracking-wide text-slate-500 uppercase">Contact</h3>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Input label="Phone" {...f.bind('phone')} />
            <Input label="Email" type="email" {...f.bind('email')} />
            <Input label="Website" className="sm:col-span-2" {...f.bind('website')} />
          </div>
        </section>
        <section>
          <h3 className="mb-3 text-[12px] font-semibold tracking-wide text-slate-500 uppercase">Commercial</h3>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Select label="Payment terms" placeholder="Not set" options={terms.data?.filter((t) => t.status === 'active').map((t) => ({ value: t.id, label: t.name })) ?? []} {...f.bind('payment_term_id')} />
            {type === 'customer' && <Input label="Credit limit" type="number" min={0} prefix="₹" {...f.bind('credit_limit')} hint={party ? 'Changes need approval' : undefined} />}
            <Input label={type === 'mill' ? 'Speciality' : 'Segment'} {...f.bind('segment')} />
            <Select label="Rating" placeholder="Not rated" options={[1, 2, 3, 4, 5].map((n) => ({ value: String(n), label: '★'.repeat(n) }))} {...f.bind('rating')} />
            <Input label="Tags" className="sm:col-span-2" {...f.bind('tags')} hint="Comma separated" />
            {pf.map((p) => <Input key={p.key} label={p.label} type={p.number ? 'number' : 'text'} hint={p.hint} {...f.bind(`profile_${p.key}`)} />)}
          </div>
        </section>
        <Textarea label="Internal notes" {...f.bind('notes')} />
        {sensitiveChanged && <Textarea label="Reason for sensitive change" required {...f.bind('reason')} hint="GSTIN, legal name, GST treatment and credit limit changes go to a checker for approval" />}
      </div>
    </Drawer>
  );
}

type DetailTab = 'overview' | 'contacts' | 'addresses' | 'bank' | 'documents' | 'activity';

export function PartnerDetailPage() {
  const { type = 'customer', id = '' } = useParams();
  const { can } = useAuth();
  const q = useQuery({ queryKey: ['party', id], queryFn: () => api.get<Party>(`/masters/parties/${id}`) });
  const [tab, setTab] = useState<DetailTab>('overview');
  const [edit, setEdit] = useState(false);
  const info = typeInfo(type);
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  if (!q.data) return <Skeleton className="h-96" />;
  const p = q.data;
  const manage = can(info.perm);
  const pending = p.pending_changes.filter((c) => c.status === 'pending');
  const pendingBanks = p.bank_accounts.filter((b) => b.status === 'pending_approval');

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: 'Business partners', to: `/partners/${type}` }, { label: info.plural, to: `/partners/${type}` }, { label: p.code }]}
        title={<>{p.legal_name} <StatusBadge status={p.status} /></>}
        meta={<>
          <span className="font-mono">{p.code}</span>
          {p.gstin && <span>GSTIN <span className="font-mono font-medium text-slate-800">{p.gstin}</span></span>}
          {p.state_code && <span className="flex items-center gap-1"><MapPin className="size-3.5" />{GST_STATES[p.state_code]}</span>}
          {p.phone && <span className="flex items-center gap-1"><Phone className="size-3.5" />{p.phone}</span>}
          {p.email && <span className="flex items-center gap-1"><Mail className="size-3.5" />{p.email}</span>}
        </>}
        actions={manage && <Button icon={<Pencil className="size-4" />} onClick={() => setEdit(true)}>Edit</Button>}
      />
      {(pending.length > 0 || pendingBanks.length > 0) && (
        <div className="mb-5">
          <Notice tone="warning" icon={<ShieldAlert className="size-4" />} title="Changes awaiting approval">
            {pending.map((c) => <div key={c.id}>{Object.keys(c.changes).map(humanize).join(', ')} — “{c.reason}”</div>)}
            {pendingBanks.map((b) => <div key={b.id}>New bank account {b.account_number} ({b.ifsc})</div>)}
          </Notice>
        </div>
      )}
      <Tabs className="mb-5" value={tab} onChange={setTab} tabs={[
        { value: 'overview', label: 'Overview' },
        { value: 'contacts', label: 'Contacts', count: p.contacts.length },
        { value: 'addresses', label: 'Addresses', count: p.addresses.length },
        { value: 'bank', label: 'Bank accounts', count: p.bank_accounts.length },
        { value: 'documents', label: 'Documents' },
        { value: 'activity', label: 'Activity' },
      ]} />
      {tab === 'overview' && (
        <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
          <Card title="Profile" className="xl:col-span-2">
            <KeyValue columns={3} items={[
              { label: 'Legal name', value: p.legal_name },
              { label: 'Trade name', value: p.trade_name },
              { label: 'Type', value: info.label },
              { label: 'GST treatment', value: humanize(p.gst_treatment) },
              { label: 'GSTIN', value: p.gstin, mono: true },
              { label: 'PAN', value: p.pan, mono: true },
              { label: 'State', value: p.state_code ? `${p.state_code} · ${GST_STATES[p.state_code]}` : null },
              { label: 'Payment terms', value: p.payment_term },
              ...(type === 'customer' ? [{ label: 'Credit limit', value: fmtINR(p.credit_limit) }] : []),
              { label: type === 'mill' ? 'Speciality' : 'Segment', value: p.segment },
              { label: 'Website', value: p.website },
              { label: 'Tags', value: p.tags.length ? <span className="flex flex-wrap gap-1">{p.tags.map((t) => <Badge key={t}>{t}</Badge>)}</span> : null },
              ...profileFields(type as PartyType).map((f) => ({ label: f.label, value: Array.isArray(p.profile[f.key]) ? (p.profile[f.key] as string[]).join(', ') || null : (p.profile[f.key] as string) ?? null })),
            ]} />
            {p.notes && <div className="mt-5 rounded-lg bg-slate-50 px-4 py-3 text-[13px] text-slate-700">{p.notes}</div>}
          </Card>
          <div className="space-y-6">
            <Card title="Primary contact">
              {p.contacts[0] ? (
                <div className="text-[13px]">
                  <p className="font-medium text-slate-900">{p.contacts[0].name}</p>
                  <p className="text-slate-500">{p.contacts[0].designation}</p>
                  <p className="mt-2 text-slate-700">{p.contacts[0].phone}</p>
                  <p className="text-slate-700">{p.contacts[0].email}</p>
                </div>
              ) : <p className="text-[13px] text-slate-500">No contacts yet.</p>}
            </Card>
            <Card title="Record">
              <KeyValue columns={1} items={[{ label: 'Created', value: fmtDateTime(p.created_at) }, { label: 'Last updated', value: fmtDateTime(p.updated_at) }, { label: 'Version', value: p.version }]} />
            </Card>
          </div>
        </div>
      )}
      {tab === 'contacts' && <Contacts party={p} manage={manage} />}
      {tab === 'addresses' && <Addresses party={p} manage={manage} />}
      {tab === 'bank' && <BankAccounts party={p} />}
      {tab === 'documents' && <Card><DocumentsPanel entityType={p.party_type} entityId={p.id} /></Card>}
      {tab === 'activity' && <Card title="Change history" description="Every change to this record, its contacts, addresses and bank accounts"><AuditTimeline entityId={p.id} /></Card>}
      {edit && <PartyDrawer type={type as PartyType} party={p} onClose={() => setEdit(false)} />}
    </>
  );
}

function Contacts({ party, manage }: { party: Party; manage: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [edit, setEdit] = useState<Contact | 'new' | null>(null);
  const [del, setDel] = useState<Contact | null>(null);
  const f = useForm({ name: '', designation: '', email: '', phone: '', is_primary: false as boolean });
  useEffect(() => {
    const c = edit && edit !== 'new' ? edit : null;
    f.setValues({ name: c?.name ?? '', designation: c?.designation ?? '', email: c?.email ?? '', phone: c?.phone ?? '', is_primary: c?.is_primary ?? party.contacts.length === 0 });
    f.setErrors({});
  }, [edit]); // eslint-disable-line react-hooks/exhaustive-deps
  async function save() {
    try {
      const body = { ...clean(f.values), is_primary: f.values.is_primary, version: edit !== 'new' ? edit?.version : undefined };
      if (edit === 'new') await api.post(`/masters/parties/${party.id}/contacts`, body);
      else await api.patch(`/masters/parties/${party.id}/contacts/${edit!.id}`, body);
      qc.invalidateQueries({ queryKey: ['party', party.id] });
      toast({ tone: 'success', title: 'Contact saved' });
      setEdit(null);
    } catch (e) { f.handleError(e); }
  }
  return (
    <Card title="Contacts" padded={false} actions={manage && <Button size="sm" variant="primary" icon={<Plus className="size-3.5" />} onClick={() => setEdit('new')}>Add contact</Button>}>
      <ul className="divide-y divide-slate-100">
        {party.contacts.map((c) => (
          <li key={c.id} className="flex items-center gap-4 px-5 py-3">
            <div className="min-w-0 flex-1">
              <p className="text-[13.5px] font-medium text-slate-900">{c.name} {c.is_primary && <Badge tone="brand">Primary</Badge>}</p>
              <p className="text-[12.5px] text-slate-500">{[c.designation, c.phone, c.email].filter(Boolean).join(' · ')}</p>
            </div>
            {manage && <><Button size="xs" variant="ghost" onClick={() => setEdit(c)}>Edit</Button><Button size="xs" variant="ghost" icon={<Trash2 className="size-3" />} onClick={() => setDel(c)}>Remove</Button></>}
          </li>
        ))}
        {party.contacts.length === 0 && <li className="px-5 py-8 text-center text-[13px] text-slate-500">No contacts yet.</li>}
      </ul>
      <Modal open={!!edit} onClose={() => setEdit(null)} title={edit === 'new' ? 'Add contact' : 'Edit contact'} footer={<><Button onClick={() => setEdit(null)}>Cancel</Button><Button variant="primary" onClick={save}>Save</Button></>}>
        <div className="grid grid-cols-2 gap-4">
          {f.formError && <div className="col-span-2"><Notice tone="danger">{f.formError}</Notice></div>}
          <Input label="Name" required {...f.bind('name')} />
          <Input label="Designation" {...f.bind('designation')} />
          <Input label="Phone" {...f.bind('phone')} />
          <Input label="Email" {...f.bind('email')} />
          <Checkbox className="col-span-2" label="Primary contact" checked={f.values.is_primary} onChange={(e) => f.set('is_primary', e.target.checked)} />
        </div>
      </Modal>
      <ConfirmDialog open={!!del} onClose={() => setDel(null)} tone="danger" title={`Remove ${del?.name}?`} description="The removal is recorded in the audit trail." confirmLabel="Remove"
        onConfirm={async () => { await api.delete(`/masters/parties/${party.id}/contacts/${del!.id}`); setDel(null); qc.invalidateQueries({ queryKey: ['party', party.id] }); toast({ tone: 'success', title: 'Contact removed' }); }} />
    </Card>
  );
}

function Addresses({ party, manage }: { party: Party; manage: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [edit, setEdit] = useState<Address | 'new' | null>(null);
  const f = useForm({ kind: 'billing', line1: '', line2: '', city: '', state_code: '', pincode: '', gstin: '', is_default: false as boolean });
  useEffect(() => {
    const a = edit && edit !== 'new' ? edit : null;
    f.setValues({ kind: a?.kind ?? 'shipping', line1: a?.line1 ?? '', line2: a?.line2 ?? '', city: a?.city ?? '', state_code: a?.state_code ?? party.state_code ?? '', pincode: a?.pincode ?? '', gstin: a?.gstin ?? '', is_default: a?.is_default ?? false });
    f.setErrors({});
  }, [edit]); // eslint-disable-line react-hooks/exhaustive-deps
  async function save() {
    try {
      const body = { ...clean(f.values), is_default: f.values.is_default, version: edit !== 'new' ? edit?.version : undefined };
      if (edit === 'new') await api.post(`/masters/parties/${party.id}/addresses`, body);
      else await api.patch(`/masters/parties/${party.id}/addresses/${edit!.id}`, body);
      qc.invalidateQueries({ queryKey: ['party', party.id] });
      toast({ tone: 'success', title: 'Address saved' });
      setEdit(null);
    } catch (e) { f.handleError(e); }
  }
  return (
    <>
      <div className="mb-4 flex justify-end">{manage && <Button size="sm" variant="primary" icon={<Plus className="size-3.5" />} onClick={() => setEdit('new')}>Add address</Button>}</div>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        {party.addresses.map((a) => (
          <div key={a.id} className="card p-4">
            <div className="flex items-center justify-between">
              <p className="flex items-center gap-2 text-[13px] font-semibold text-slate-900 capitalize">{a.kind} {a.is_default && <Badge tone="brand">Default</Badge>}</p>
              {manage && <Button size="xs" variant="ghost" onClick={() => setEdit(a)}>Edit</Button>}
            </div>
            <p className="mt-2 text-[13px] leading-relaxed text-slate-700">{a.line1}{a.line2 ? <><br />{a.line2}</> : null}<br />{a.city} {a.pincode}<br />{GST_STATES[a.state_code]}</p>
            {a.gstin && <p className="mt-2 font-mono text-[12px] text-slate-500">{a.gstin}</p>}
          </div>
        ))}
        {party.addresses.length === 0 && <p className="text-[13px] text-slate-500">No addresses yet.</p>}
      </div>
      <Modal open={!!edit} onClose={() => setEdit(null)} title={edit === 'new' ? 'Add address' : 'Edit address'} size="lg" footer={<><Button onClick={() => setEdit(null)}>Cancel</Button><Button variant="primary" onClick={save}>Save</Button></>}>
        <div className="grid grid-cols-2 gap-4">
          {f.formError && <div className="col-span-2"><Notice tone="danger">{f.formError}</Notice></div>}
          <Select label="Type" options={['billing', 'shipping', 'registered', 'factory', 'warehouse'].map((v) => ({ value: v, label: humanize(v) }))} {...f.bind('kind')} />
          <Input label="GSTIN (if different)" {...f.bind('gstin')} onChange={(e) => f.set('gstin', e.target.value.toUpperCase())} />
          <Input label="Address line 1" required className="col-span-2" {...f.bind('line1')} />
          <Input label="Address line 2" className="col-span-2" {...f.bind('line2')} />
          <Input label="City" required {...f.bind('city')} />
          <Input label="PIN code" required {...f.bind('pincode')} />
          <Select label="State" required placeholder="Select" options={STATES} className="col-span-2" {...f.bind('state_code')} />
          <Checkbox className="col-span-2" label="Default address of this type" checked={f.values.is_default} onChange={(e) => f.set('is_default', e.target.checked)} />
        </div>
      </Modal>
    </>
  );
}

function BankAccounts({ party }: { party: Party }) {
  const { can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const [adding, setAdding] = useState(false);
  const [deact, setDeact] = useState<Bank | null>(null);
  const f = useForm({ account_name: party.legal_name, account_number: '', confirm: '', ifsc: '', bank_name: '', branch: '', reason: '' });
  async function request() {
    if (f.values.account_number !== f.values.confirm) return f.setErrors({ confirm: 'Account numbers do not match' });
    try {
      const { confirm: _c, ...v } = f.values;
      await api.post(`/masters/parties/${party.id}/bank-accounts`, clean(v));
      qc.invalidateQueries({ queryKey: ['party', party.id] });
      setAdding(false);
      f.reset();
      toast({ tone: 'warning', title: 'Bank account sent for approval', body: 'It cannot be used for payments until a checker approves it.' });
    } catch (e) { f.handleError(e); }
  }
  return (
    <Card title="Bank accounts" description="New accounts are inactive until approved by a different user (maker-checker)." padded={false}
      actions={can('masters.party.bank.request') && <Button size="sm" variant="primary" icon={<Landmark className="size-3.5" />} onClick={() => setAdding(true)}>Request new account</Button>}>
      {!can('masters.party.bank.view') && <div className="px-5 pt-4"><Notice tone="info">Account numbers are masked for your role.</Notice></div>}
      <ul className="divide-y divide-slate-100">
        {party.bank_accounts.map((b) => (
          <li key={b.id} className="flex flex-wrap items-center gap-4 px-5 py-3.5">
            <span className="flex size-9 items-center justify-center rounded-md bg-slate-100 text-slate-500"><Landmark className="size-4" /></span>
            <div className="min-w-0 flex-1">
              <p className="text-[13.5px] font-medium text-slate-900">{b.bank_name ?? 'Bank'} <span className="font-mono text-slate-600">{b.account_number}</span></p>
              <p className="text-[12.5px] text-slate-500">{b.account_name} · IFSC <span className="font-mono">{b.ifsc}</span>{b.branch ? ` · ${b.branch}` : ''} · added {fmtDate(b.created_at)}</p>
              {b.decision_comment && <p className="text-[12px] text-slate-500">Checker: “{b.decision_comment}”</p>}
            </div>
            <StatusBadge status={b.status} />
            {b.status === 'active' && can('masters.party.bank.request') && <Button size="xs" variant="ghost" onClick={() => setDeact(b)}>Deactivate</Button>}
          </li>
        ))}
        {party.bank_accounts.length === 0 && <li className="px-5 py-8 text-center text-[13px] text-slate-500">No bank accounts.</li>}
      </ul>
      <Modal open={adding} onClose={() => setAdding(false)} title="Request new bank account" size="lg"
        description="A checker with approval rights must verify it (e.g. against a cancelled cheque) before it becomes active."
        footer={<><Button onClick={() => setAdding(false)}>Cancel</Button><Button variant="primary" onClick={request}>Submit for approval</Button></>}>
        <div className="grid grid-cols-2 gap-4">
          {f.formError && <div className="col-span-2"><Notice tone="danger">{f.formError}</Notice></div>}
          <Input label="Account holder name" required className="col-span-2" {...f.bind('account_name')} />
          <Input label="Account number" required inputMode="numeric" {...f.bind('account_number')} />
          <Input label="Confirm account number" required inputMode="numeric" {...f.bind('confirm')} onPaste={(e) => e.preventDefault()} />
          <Input label="IFSC" required {...f.bind('ifsc')} onChange={(e) => f.set('ifsc', e.target.value.toUpperCase())} />
          <Input label="Bank name" {...f.bind('bank_name')} />
          <Input label="Branch" className="col-span-2" {...f.bind('branch')} />
          <Textarea label="Reason" required className="col-span-2" {...f.bind('reason')} hint="E.g. “Supplier letter dated 12 Oct; cancelled cheque uploaded”" />
        </div>
      </Modal>
      <ConfirmDialog open={!!deact} onClose={() => setDeact(null)} tone="danger" requireReason title="Deactivate bank account?" description={`${deact?.bank_name ?? ''} ${deact?.account_number ?? ''} will no longer be usable for payments.`} confirmLabel="Deactivate"
        onConfirm={async (reason) => { await api.post(`/masters/parties/${party.id}/bank-accounts/${deact!.id}/deactivate`, { reason }); setDeact(null); qc.invalidateQueries({ queryKey: ['party', party.id] }); toast({ tone: 'success', title: 'Bank account deactivated' }); }} />
    </Card>
  );
}

