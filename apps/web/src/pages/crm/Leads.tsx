import { useQuery, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { Building2, CalendarClock, Copy, FileText, GitMerge, Mail, MessageCircle, Phone, Plus, Upload, UserRoundCheck, Users } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, invalidatePrefix } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { GST_STATES, fmtDate, fmtDateTime, fmtINR, fmtNum, fmtRelative, humanize } from '../../lib/format';
import { DataTable, FilterSelect, SimpleTable } from '../../components/DataTable';
import { Modal, useToast } from '../../components/overlay';
import { useParties } from '../../components/business';
import { useForm } from '../../components/form';
import { Avatar, Badge, Button, Card, EmptyState, ErrorState, Input, KeyValue, Notice, PageHeader, Segmented, Select, Skeleton, StatusBadge, Textarea, Timeline } from '../../components/ui';

export interface LeadRow { id: string; number: string; source_code: string; source_name: string; name: string; company: string | null; mobile: string | null; email: string | null; city: string | null; state_code: string | null; category: string | null; product_label: string | null; requirement_kg: number | null; est_value: number | null; stage: string; status: string; owner_id: string | null; owner_name: string | null; next_action_at: string | null; next_action: string | null; created_at: string; open_duplicates: number; follow_up_due: boolean; duplicate_flag: boolean; customer_id: string | null; customer_name: string | null }
interface Source { id: string; code: string; name: string; kind: string; status: string; leads_received: number; last_received_at: string | null; webhook_path?: string; field_map: Record<string, string> }
interface Member { user_id: string; name: string; active: boolean; available: boolean; availability: string; active_leads: number }

export const STAGES = ['new', 'assigned', 'contact_pending', 'contacted', 'qualified', 'quotation', 'negotiation', 'order_confirmed', 'won', 'lost', 'nurture'];
const PIPE = ['new', 'assigned', 'contacted', 'qualified', 'quotation', 'negotiation', 'order_confirmed', 'won'];
export const useSources = () => useQuery({ queryKey: ['crm-sources'], queryFn: () => api.get<Source[]>('/crm/sources'), staleTime: 60_000 });
export const useTeam = () => useQuery({ queryKey: ['crm-team'], queryFn: () => api.get<Member[]>('/crm/team'), staleTime: 30_000 });
const VIEWS = [{ value: 'open', label: 'Open' }, { value: 'mine', label: 'Mine' }, { value: 'overdue', label: 'Follow-up due' }, { value: 'unassigned', label: 'Unassigned' }, { value: 'duplicates', label: 'Possible duplicates' }, { value: 'all', label: 'All' }];

export function LeadsPage() {
  const nav = useNavigate();
  const { can } = useAuth();
  const sources = useSources();
  const team = useTeam();
  const [view, setView] = useState('open');
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [modal, setModal] = useState<'new' | 'import' | null>(null);
  const f: Record<string, string> = { ...filters };
  if (view === 'open') f.view = 'open';
  if (view === 'overdue') f.view = 'overdue';
  if (view === 'duplicates') f.view = 'duplicates';
  if (view === 'mine') { f.owner = 'me'; f.view = 'open'; }
  if (view === 'unassigned') { f.owner = 'none'; f.view = 'open'; }
  return (
    <>
      <PageHeader title="Lead inbox" description="Every enquiry from every channel in one place, assigned automatically by territory, product, value and who is in today. No open lead is left without a next follow-up."
        breadcrumbs={[{ label: 'Sales & CRM', to: '/crm' }, { label: 'Leads' }]}
        actions={<>
          {can('crm.lead.assign') && <Button icon={<Upload className="size-4" />} onClick={() => setModal('import')}>Import CSV</Button>}
          {can('crm.lead.manage') && <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setModal('new')}>New lead</Button>}
        </>} />
      <div className="mb-4 overflow-x-auto"><Segmented value={view} onChange={setView} options={can('crm.lead.read_all') ? VIEWS : VIEWS.filter((v) => !['unassigned', 'mine'].includes(v.value))} /></div>
      <DataTable<LeadRow> id="crm-leads" endpoint="/crm/leads" filters={f} onFiltersChange={(x) => setFilters({ stage: x.stage ?? '', source: x.source ?? '', owner: view === 'mine' || view === 'unassigned' ? '' : x.owner ?? '' })} defaultSort={{ key: 'created_at', dir: 'desc' }} onRowClick={(r) => nav(`/crm/leads/${r.id}`)}
        searchPlaceholder="Name, company, mobile, email or city…"
        toolbar={<>
          <FilterSelect placeholder="Any stage" value={filters.stage} onChange={(v) => setFilters({ ...filters, stage: v })} options={STAGES.map((s) => ({ value: s, label: humanize(s) }))} />
          <FilterSelect placeholder="Any source" value={filters.source} onChange={(v) => setFilters({ ...filters, source: v })} options={(sources.data ?? []).map((s) => ({ value: s.code, label: s.name }))} />
          {can('crm.lead.read_all') && view !== 'mine' && view !== 'unassigned' && <FilterSelect placeholder="Any salesperson" value={filters.owner} onChange={(v) => setFilters({ ...filters, owner: v })} options={(team.data ?? []).map((m) => ({ value: m.user_id, label: m.name }))} />}
        </>}
        columns={[
          { key: 'n', header: 'Lead', sort: 'number', csv: (r) => r.number, render: (r) => <div><p className="font-medium text-slate-900">{r.name}{r.company && <span className="font-normal text-slate-500"> · {r.company}</span>}</p><p className="font-mono text-[11.5px] text-slate-500">{r.number}{r.open_duplicates > 0 && <Badge tone="warning" className="ml-1.5">possible duplicate</Badge>}</p></div> },
          { key: 'src', header: 'Source', csv: (r) => r.source_code, render: (r) => <Badge tone="neutral">{r.source_name}</Badge> },
          { key: 'loc', header: 'Where', csv: (r) => r.city, render: (r) => <span className="text-[12.5px]">{r.city ?? '—'}{r.state_code && <span className="block text-slate-500">{GST_STATES[r.state_code]}</span>}</span> },
          { key: 'need', header: 'Requirement', csv: (r) => r.product_label ?? r.category, render: (r) => <span className="text-[12.5px]">{r.product_label ?? r.category ?? '—'}{(r.requirement_kg || r.est_value) && <span className="block text-slate-500">{r.requirement_kg ? `${fmtNum(Number(r.requirement_kg))} kg` : ''}{r.requirement_kg && r.est_value ? ' · ' : ''}{r.est_value ? fmtINR(Number(r.est_value)) : ''}</span>}</span> },
          { key: 'st', header: 'Stage', sort: 'stage', csv: (r) => r.stage, render: (r) => <StatusBadge status={r.stage} /> },
          { key: 'o', header: 'Owner', sort: 'owner_name', csv: (r) => r.owner_name, render: (r) => (r.owner_name ? <span className="flex items-center gap-2 text-[13px]"><Avatar name={r.owner_name} size="sm" />{r.owner_name}</span> : <Badge tone="danger">Unassigned</Badge>) },
          { key: 'na', header: 'Next follow-up', sort: 'next_action_at', csv: (r) => r.next_action_at, render: (r) => (r.status !== 'open' ? <span className="text-slate-400">—</span> : <span className={clsx('text-[12.5px]', r.follow_up_due && 'font-semibold text-rose-600')}>{r.next_action_at ? fmtDateTime(r.next_action_at) : 'Not set'}{r.next_action && <span className="block max-w-[180px] truncate font-normal text-slate-500">{r.next_action}</span>}</span>) },
          { key: 'c', header: 'Received', sort: 'created_at', csv: (r) => r.created_at, render: (r) => <span className="text-[12.5px] text-slate-500">{fmtRelative(r.created_at)}</span> },
        ]}
        empty={{ title: 'No leads here', description: view === 'overdue' ? 'Every open lead has a future follow-up.' : undefined }} />
      {modal === 'new' && <NewLeadModal onClose={() => setModal(null)} onDone={(id) => nav(`/crm/leads/${id}`)} />}
      {modal === 'import' && <ImportModal onClose={() => setModal(null)} />}
    </>
  );
}

function NewLeadModal({ onClose, onDone }: { onClose: () => void; onDone: (id: string) => void }) {
  const { can } = useAuth();
  const sources = useSources();
  const team = useTeam();
  const f = useForm({ source_code: 'PHONE', name: '', company: '', mobile: '', email: '', gstin: '', city: '', state_code: '', category: '', product_label: '', requirement_kg: '', est_value: '', message: '', owner_id: '' });
  const [busy, setBusy] = useState(false);
  return (
    <Modal open onClose={onClose} size="lg" title="New lead" description={can('crm.lead.assign') ? 'Leave the owner blank to let the allocation engine decide.' : 'The lead is assigned to you.'}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} onClick={async () => {
        setBusy(true);
        try {
          const v = f.values;
          const body = Object.fromEntries(Object.entries(v).map(([k, x]) => [k, x === '' ? null : ['requirement_kg', 'est_value'].includes(k) ? Number(x) : x]));
          const r = await api.post<{ id: string; duplicates?: unknown[] }>('/crm/leads', body);
          onDone(r.id);
        } catch (e) { f.handleError(e); } finally { setBusy(false); }
      }}>Create lead</Button></>}>
      <div className="grid grid-cols-2 gap-3">
        {f.formError && <div className="col-span-2"><Notice tone="danger">{f.formError}</Notice></div>}
        <Select label="Source" {...f.bind('source_code')} options={(sources.data ?? []).filter((s) => s.status === 'active').map((s) => ({ value: s.code, label: s.name }))} />
        {can('crm.lead.assign') ? <Select label="Owner" {...f.bind('owner_id')} options={[{ value: '', label: 'Assign automatically' }, ...(team.data ?? []).filter((m) => m.active).map((m) => ({ value: m.user_id, label: `${m.name}${m.available ? '' : ` (${m.availability.toLowerCase()})`}` }))]} /> : <div />}
        <Input label="Contact name" required {...f.bind('name')} />
        <Input label="Company" {...f.bind('company')} />
        <Input label="Mobile" {...f.bind('mobile')} />
        <Input label="Email" type="email" {...f.bind('email')} />
        <Input label="City" {...f.bind('city')} />
        <Select label="State" {...f.bind('state_code')} options={[{ value: '', label: 'From city or GSTIN' }, ...Object.entries(GST_STATES).map(([k, v]) => ({ value: k, label: v }))]} />
        <Input label="GSTIN" {...f.bind('gstin')} />
        <Input label="Fabric category" placeholder="e.g. Single Jersey" {...f.bind('category')} />
        <Input label="Requirement (kg)" type="number" {...f.bind('requirement_kg')} />
        <Input label="Estimated value" type="number" prefix="₹" {...f.bind('est_value')} />
        <Textarea className="col-span-2" label="Enquiry" {...f.bind('message')} />
      </div>
    </Modal>
  );
}

function ImportModal({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const sources = useSources();
  const [source, setSource] = useState('');
  const [csv, setCsv] = useState('');
  const header = csv.split(/\r?\n/)[0]?.split(',').map((h) => h.replace(/"/g, '').trim()).filter(Boolean) ?? [];
  const [map, setMap] = useState<Record<string, string>>({});
  const [res, setRes] = useState<{ created: number; skipped: number; duplicates: number; errors: { row: number; error: string }[] } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const FIELDS = ['name', 'company', 'mobile', 'email', 'city', 'state_code', 'gstin', 'category', 'requirement_kg', 'est_value', 'message', 'source_ref'];
  const guess = (f: string) => header.find((h) => h.toLowerCase().replace(/[^a-z]/g, '').includes(f.replace('_', '').slice(0, 5))) ?? '';
  return (
    <Modal open onClose={onClose} size="lg" title="Import leads from CSV" description="Exhibition lists, trade-platform exports or old spreadsheets. Each row goes through duplicate checks and allocation like any other lead."
      footer={res ? <Button variant="primary" onClick={() => { invalidatePrefix(qc, '/crm/leads'); onClose(); }}>Done</Button> : <><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!source || !csv} onClick={async () => {
        setErr(null);
        const mapping = Object.fromEntries(FIELDS.map((f) => [f, map[f] ?? guess(f)]).filter(([, h]) => h));
        try { setRes(await api.post('/crm/leads/import', { source_id: source, csv, mapping })); } catch (e) { setErr((e as Error).message); }
      }}>Import</Button></>}>
      {res ? (
        <div className="space-y-3">
          <Notice tone="success" title={`${res.created} leads created`}>{res.skipped} already imported earlier · {res.duplicates} flagged as possible duplicates</Notice>
          {res.errors.length > 0 && <Notice tone="warning" title={`${res.errors.length} rows skipped`}>{res.errors.slice(0, 8).map((e) => <span key={e.row} className="block">Row {e.row}: {e.error}</span>)}</Notice>}
        </div>
      ) : (
        <div className="space-y-4">
          {err && <Notice tone="danger">{err}</Notice>}
          <Select label="Source" value={source} onChange={(e) => setSource(e.target.value)} options={[{ value: '', label: 'Choose…' }, ...(sources.data ?? []).map((s) => ({ value: s.id, label: s.name }))]} />
          <div>
            <input type="file" accept=".csv,text/csv" className="text-[13px]" onChange={async (e) => { const file = e.target.files?.[0]; if (file) setCsv(await file.text()); }} />
            <Textarea className="mt-2" label="…or paste CSV" rows={4} value={csv} onChange={(e) => setCsv(e.target.value)} placeholder={'Name,Phone,Company,City\nRavi Shah,9820000001,Shah Tex,Mumbai'} />
          </div>
          {header.length > 0 && (
            <div className="grid grid-cols-2 gap-2 rounded-lg bg-slate-50 p-3 md:grid-cols-3">
              {FIELDS.map((f) => (
                <label key={f} className="text-[12px] text-slate-600">{humanize(f)}
                  <select className="input mt-0.5 h-8 text-[12.5px]" value={map[f] ?? guess(f)} onChange={(e) => setMap({ ...map, [f]: e.target.value })}><option value="">—</option>{header.map((h) => <option key={h} value={h}>{h}</option>)}</select>
                </label>
              ))}
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

interface Activity { id: number; kind: string; summary: string; outcome: string | null; by_name: string | null; at: string; lead_number: string }
interface Lead extends LeadRow { gstin: string | null; language: string | null; message: string | null; first_response_at: string | null; assigned_at: string | null; lost_reason: string | null; competitor: string | null; nurture_reason: string | null; merged_into: string | null; closed_at: string | null;
  allocation_trace: { method: string; rule: string | null; note: string; chosen: string | null; at: string; candidates: { user_id: string; name: string; eligible: boolean; reason: string; active_leads: number }[] } | null;
  source: { code: string; name: string; kind: string }; merged_leads: { id: string; number: string }[]; activities: Activity[];
  assignments: { id: number; from_name: string | null; to_name: string | null; method: string; rule_name: string | null; reason: string | null; by_name: string; at: string }[];
  duplicates: { id: string; lead_id: string; match_type: string; match_id: string; match_label: string; match_on: string[]; status: string; decided_by_name: string | null; note: string | null }[];
  quotations: { id: string; number: string; version: number; status: string; total: number; kg: number; margin_pct: number | null; valid_until: string }[] }

const ACT_ICON: Record<string, ReactNode> = { call: <Phone className="size-3.5" />, whatsapp: <MessageCircle className="size-3.5" />, email: <Mail className="size-3.5" />, meeting: <Users className="size-3.5" />, visit: <Building2 className="size-3.5" />, quotation: <FileText className="size-3.5" />, merge: <GitMerge className="size-3.5" />, assignment: <UserRoundCheck className="size-3.5" /> };
const toLocal = (iso: string | null) => (iso ? new Date(new Date(iso).getTime() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16) : '');
const fromLocal = (v: string) => (v ? new Date(v).toISOString() : null);

export function LeadDetailPage() {
  const { id = '' } = useParams();
  const { can, user } = useAuth();
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['crm-lead', id], queryFn: () => api.get<Lead>(`/crm/leads/${id}`) });
  const [modal, setModal] = useState<'stage' | 'assign' | 'convert' | null>(null);
  const [act, setAct] = useState({ kind: 'call', summary: '', outcome: '', next_action_at: '', next_action: '' });
  if (q.isError) return <ErrorState error={q.error} />;
  const l = q.data;
  if (!l) return <Skeleton className="h-96" />;
  const refresh = () => { q.refetch(); invalidatePrefix(qc, '/crm', 'crm'); };
  const mine = l.owner_id === user?.id || can('crm.lead.assign') || can('crm.lead.read_all');
  const canWork = can('crm.lead.manage') && l.status === 'open' && mine;
  const step = PIPE.indexOf(l.stage);
  async function logActivity() {
    try {
      await api.post(`/crm/leads/${id}/activities`, { kind: act.kind, summary: act.summary, outcome: act.outcome || null, next_action_at: fromLocal(act.next_action_at), next_action: act.next_action || null });
      setAct({ kind: 'call', summary: '', outcome: '', next_action_at: '', next_action: '' });
      refresh();
    } catch (e) { toast({ tone: 'error', title: (e as Error).message }); }
  }
  return (
    <>
      <PageHeader title={<span>{l.name}{l.company && <span className="font-normal text-slate-500"> · {l.company}</span>}</span>} description={<span className="font-mono">{l.number}</span>}
        meta={<><StatusBadge status={l.status === 'merged' ? 'merged' : l.stage} /><Badge>{l.source.name}</Badge>{l.duplicate_flag && <Badge tone="warning">Possible duplicate</Badge>}</>}
        breadcrumbs={[{ label: 'Sales & CRM', to: '/crm' }, { label: 'Leads', to: '/crm/leads' }, { label: l.number }]}
        actions={<>
          {can('crm.lead.assign') && l.status === 'open' && <Button icon={<UserRoundCheck className="size-4" />} onClick={() => setModal('assign')}>{l.owner_id ? 'Reassign' : 'Assign'}</Button>}
          {canWork && !l.customer_id && <Button icon={<Building2 className="size-4" />} onClick={() => setModal('convert')}>Convert to customer</Button>}
          {canWork && can('crm.quote.manage') && <Button icon={<FileText className="size-4" />} onClick={() => nav(`/crm/quotations/new?lead=${l.id}`)}>New quotation</Button>}
          {canWork && <Button variant="primary" onClick={() => setModal('stage')}>Move stage</Button>}
        </>} />
      {l.status === 'merged' && <div className="mb-5"><Notice tone="info">This lead was merged into another lead. It is kept for the record. <Link className="link" to={`/crm/leads/${l.merged_into}`}>Open the surviving lead →</Link></Notice></div>}
      {l.status !== 'merged' && (
        <div className="card mb-6 flex items-center gap-1 overflow-x-auto p-3">
          {PIPE.map((s, i) => (
            <div key={s} className="flex flex-1 items-center gap-1">
              <div className={clsx('flex-1 rounded-md px-2 py-1.5 text-center text-[12px] font-medium whitespace-nowrap', l.stage === 'lost' ? 'bg-slate-100 text-slate-400' : i < step ? 'bg-brand-100 text-brand-800' : i === step ? 'bg-brand-600 text-white' : 'bg-slate-100 text-slate-500')}>{humanize(s)}</div>
            </div>
          ))}
          {['lost', 'nurture'].includes(l.stage) && <Badge tone={l.stage === 'lost' ? 'danger' : 'neutral'} className="ml-2">{humanize(l.stage)}: {l.lost_reason ?? l.nurture_reason}</Badge>}
        </div>
      )}
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
        <div className="space-y-6 xl:col-span-2">
          {l.status === 'open' && (
            <div className={clsx('flex items-center gap-3 rounded-xl px-5 py-4 ring-1 ring-inset', !l.next_action_at || new Date(l.next_action_at) < new Date() ? 'bg-rose-50 ring-rose-600/20' : 'bg-emerald-50 ring-emerald-600/15')}>
              <CalendarClock className="size-5 text-slate-600" />
              <div className="flex-1"><p className="text-[13.5px] font-semibold text-slate-900">{l.next_action_at ? `Next: ${l.next_action ?? 'Follow up'}` : 'No next follow-up set'}</p><p className="text-[12.5px] text-slate-600">{l.next_action_at ? `${fmtDateTime(l.next_action_at)} · ${new Date(l.next_action_at) < new Date() ? 'overdue' : fmtRelative(l.next_action_at).replace(' ago', '')}` : 'Every open lead needs one — log an activity with a follow-up date.'}</p></div>
              {!l.first_response_at && <Badge tone="warning">Not contacted yet</Badge>}
            </div>
          )}
          {canWork && (
            <Card title="Log an activity">
              <div className="space-y-3">
                <div className="flex flex-wrap gap-1.5">{['call', 'whatsapp', 'email', 'meeting', 'visit', 'sample', 'note'].map((k) => <Button key={k} size="sm" variant={act.kind === k ? 'primary' : 'secondary'} icon={ACT_ICON[k]} onClick={() => setAct({ ...act, kind: k })}>{humanize(k)}</Button>)}</div>
                <Textarea placeholder="What happened?" rows={2} value={act.summary} onChange={(e) => setAct({ ...act, summary: e.target.value })} />
                <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
                  <Input placeholder="Outcome (optional)" value={act.outcome} onChange={(e) => setAct({ ...act, outcome: e.target.value })} />
                  <Input type="datetime-local" value={act.next_action_at} onChange={(e) => setAct({ ...act, next_action_at: e.target.value })} aria-label="Next follow-up" />
                  <Input placeholder="Next action" value={act.next_action} onChange={(e) => setAct({ ...act, next_action: e.target.value })} />
                </div>
                <div className="flex justify-end"><Button variant="primary" disabled={act.summary.trim().length < 2} onClick={() => void logActivity()}>Save activity</Button></div>
              </div>
            </Card>
          )}
          <Card title="Timeline" description={l.merged_leads.length ? `Includes ${l.merged_leads.map((m) => m.number).join(', ')} merged into this lead` : undefined}>
            {l.activities.length ? <Timeline items={l.activities.map((a) => ({
              id: a.id, tone: a.kind === 'stage' ? 'brand' : a.kind === 'system' ? 'neutral' : a.kind === 'merge' ? 'warning' : 'success',
              title: <span className="flex items-center gap-1.5">{ACT_ICON[a.kind]}{a.summary}</span>, detail: a.outcome ?? undefined,
              meta: `${humanize(a.kind)} · ${a.by_name ?? 'system'} · ${fmtDateTime(a.at)}${a.lead_number !== l.number ? ` · ${a.lead_number}` : ''}`,
            }))} /> : <EmptyState title="No activity yet" />}
          </Card>
          {l.quotations.length > 0 && (
            <Card title="Quotations" padded={false}>
              <SimpleTable rows={l.quotations} rowKey={(r) => r.id} onRowClick={(r) => nav(`/crm/quotations/${r.id}`)} columns={[
                { key: 'n', header: 'Quotation', render: (r) => <span className="font-mono text-[12.5px]">{r.number} v{r.version}</span> },
                { key: 'k', header: 'KG', align: 'right', render: (r) => fmtNum(Number(r.kg)) },
                { key: 't', header: 'Total', align: 'right', render: (r) => fmtINR(Number(r.total)) },
                { key: 'm', header: 'Margin', align: 'right', render: (r) => (r.margin_pct === null ? '—' : `${r.margin_pct}%`) },
                { key: 'v', header: 'Valid until', render: (r) => fmtDate(r.valid_until) },
                { key: 's', header: 'Status', render: (r) => <StatusBadge status={r.status} /> },
              ]} />
            </Card>
          )}
        </div>
        <div className="space-y-6">
          <Card title="Contact">
            <KeyValue columns={1} items={[
              { label: 'Mobile', value: l.mobile ? <a className="link" href={`tel:+91${l.mobile}`}>+91 {l.mobile}</a> : null },
              { label: 'Email', value: l.email ? <a className="link" href={`mailto:${l.email}`}>{l.email}</a> : null },
              { label: 'Location', value: [l.city, l.state_code && GST_STATES[l.state_code]].filter(Boolean).join(', ') || null },
              { label: 'GSTIN', value: l.gstin, mono: true },
              { label: 'Customer', value: l.customer_id ? <Link className="link" to={`/crm/customers/${l.customer_id}`}>{l.customer_name}</Link> : 'Not yet a customer' },
              { label: 'Requirement', value: [l.product_label ?? l.category, l.requirement_kg && `${fmtNum(Number(l.requirement_kg))} kg`, l.est_value && fmtINR(Number(l.est_value))].filter(Boolean).join(' · ') || null },
              { label: 'Enquiry', value: l.message ? <span className="whitespace-pre-line">{l.message}</span> : null },
            ]} />
          </Card>
          <Card title="Ownership">
            <KeyValue columns={1} items={[
              { label: 'Salesperson', value: l.owner_name ?? <Badge tone="danger">Unassigned</Badge> },
              { label: 'Received', value: fmtDateTime(l.created_at) },
              { label: 'First response', value: l.first_response_at ? `${fmtDateTime(l.first_response_at)} (${Math.round((new Date(l.first_response_at).getTime() - new Date(l.assigned_at ?? l.created_at).getTime()) / 60000)} min)` : '—' },
            ]} />
            {l.allocation_trace && (
              <div className="mt-4 rounded-lg bg-slate-50 p-3">
                <p className="text-[12.5px] font-semibold text-slate-800">Why {l.allocation_trace.chosen ?? 'nobody'}</p>
                <p className="mb-2 text-[12px] text-slate-600">{l.allocation_trace.note}</p>
                <ul className="space-y-1">{l.allocation_trace.candidates.map((c) => <li key={c.user_id} className="flex items-center justify-between text-[12px]"><span className={c.eligible ? 'text-slate-800' : 'text-slate-400 line-through'}>{c.name}</span><span className={c.eligible ? 'text-emerald-700' : 'text-slate-500'}>{c.reason} · {c.active_leads} open</span></li>)}</ul>
              </div>
            )}
            {l.assignments.length > 0 && (
              <ul className="mt-4 space-y-1.5 border-t border-slate-100 pt-3">{l.assignments.map((a) => <li key={a.id} className="text-[12px] text-slate-600"><span className="font-medium text-slate-800">{a.to_name ?? 'Unassigned'}</span> · {humanize(a.method)}{a.reason ? ` — ${a.reason}` : ''}<span className="block text-slate-400">{a.by_name} · {fmtDateTime(a.at)}</span></li>)}</ul>
            )}
          </Card>
          {l.duplicates.length > 0 && <DuplicatesCard lead={l} onDone={refresh} />}
        </div>
      </div>
      {modal === 'stage' && <StageModal lead={l} onClose={() => setModal(null)} onDone={() => { setModal(null); refresh(); }} />}
      {modal === 'assign' && <AssignModal lead={l} onClose={() => setModal(null)} onDone={() => { setModal(null); refresh(); }} />}
      {modal === 'convert' && <ConvertModal lead={l} onClose={() => setModal(null)} onDone={() => { setModal(null); refresh(); }} />}
    </>
  );
}

function DuplicatesCard({ lead, onDone }: { lead: Lead; onDone: () => void }) {
  const { can } = useAuth();
  const toast = useToast();
  const act = async (id: string, action: string) => {
    try { await api.post(`/crm/duplicates/${id}/resolve`, { action, note: null }); onDone(); toast({ tone: 'success', title: humanize(action) }); } catch (e) { toast({ tone: 'error', title: (e as Error).message }); }
  };
  return (
    <Card title="Possible duplicates" description="Matched on mobile, email or GSTIN. Nothing is merged or deleted without a decision.">
      <ul className="space-y-3">{lead.duplicates.map((d) => (
        <li key={d.id} className="rounded-lg border border-slate-200 p-3">
          <div className="flex items-center justify-between gap-2"><span className="flex items-center gap-1.5 text-[13px] font-medium"><Copy className="size-3.5 text-slate-400" />{d.match_type === 'customer' ? <Link className="link" to={`/crm/customers/${d.match_id}`}>{d.match_label}</Link> : <Link className="link" to={`/crm/leads/${d.lead_id === lead.id ? d.match_id : d.lead_id}`}>{d.lead_id === lead.id ? d.match_label : 'Newer enquiry'}</Link>}</span><StatusBadge status={d.status} /></div>
          <p className="text-[12px] text-slate-500">{humanize(d.match_type)} · same {d.match_on.join(', ')}{d.decided_by_name ? ` · ${d.decided_by_name}` : ''}</p>
          {['open', 'escalated'].includes(d.status) && d.lead_id === lead.id && can('crm.lead.assign') && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {d.match_type === 'lead' && <Button size="sm" variant="primary" onClick={() => void act(d.id, 'merge')}>Merge into it</Button>}
              {d.match_type === 'customer' && <Button size="sm" variant="primary" onClick={() => void act(d.id, 'link')}>Link to customer</Button>}
              <Button size="sm" onClick={() => void act(d.id, 'keep_separate')}>Keep separate</Button>
              {d.status === 'open' && <Button size="sm" variant="ghost" onClick={() => void act(d.id, 'escalate')}>Escalate</Button>}
            </div>
          )}
        </li>
      ))}</ul>
    </Card>
  );
}

function StageModal({ lead, onClose, onDone }: { lead: Lead; onClose: () => void; onDone: () => void }) {
  const [v, setV] = useState({ stage: lead.stage === 'new' || lead.stage === 'assigned' ? 'contacted' : lead.stage, next_action_at: toLocal(lead.next_action_at), next_action: lead.next_action ?? '', lost_reason: '', competitor: '', nurture_reason: '', note: '' });
  const [err, setErr] = useState<string | null>(null);
  const open = !['won', 'lost'].includes(v.stage);
  return (
    <Modal open onClose={onClose} title="Move stage" footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={async () => {
      try { await api.post(`/crm/leads/${lead.id}/stage`, { stage: v.stage, next_action_at: open ? fromLocal(v.next_action_at) : null, next_action: v.next_action || null, lost_reason: v.lost_reason || null, competitor: v.competitor || null, nurture_reason: v.nurture_reason || null, note: v.note || null }); onDone(); } catch (e) { setErr((e as Error).message); }
    }}>Save</Button></>}>
      <div className="grid grid-cols-2 gap-3">
        {err && <div className="col-span-2"><Notice tone="danger">{err}</Notice></div>}
        <Select className="col-span-2" label="Stage" value={v.stage} onChange={(e) => setV({ ...v, stage: e.target.value })} options={STAGES.filter((s) => s !== 'new').map((s) => ({ value: s, label: humanize(s) }))} />
        {open && <><Input label="Next follow-up" type="datetime-local" required value={v.next_action_at} onChange={(e) => setV({ ...v, next_action_at: e.target.value })} /><Input label="Next action" value={v.next_action} onChange={(e) => setV({ ...v, next_action: e.target.value })} /></>}
        {v.stage === 'lost' && <><Input className="col-span-2" label="Why was it lost?" required value={v.lost_reason} onChange={(e) => setV({ ...v, lost_reason: e.target.value })} /><Input className="col-span-2" label="Lost to (competitor)" value={v.competitor} onChange={(e) => setV({ ...v, competitor: e.target.value })} /></>}
        {v.stage === 'nurture' && <Input className="col-span-2" label="Why park it?" required value={v.nurture_reason} onChange={(e) => setV({ ...v, nurture_reason: e.target.value })} />}
        <Textarea className="col-span-2" label="Note" value={v.note} onChange={(e) => setV({ ...v, note: e.target.value })} />
      </div>
    </Modal>
  );
}

function AssignModal({ lead, onClose, onDone }: { lead: Lead; onClose: () => void; onDone: () => void }) {
  const team = useTeam();
  const [v, setV] = useState({ user_id: '', reason: '' });
  const [err, setErr] = useState<string | null>(null);
  return (
    <Modal open onClose={onClose} title={lead.owner_id ? 'Reassign lead' : 'Assign lead'} footer={<>
      <Button onClick={async () => { try { await api.post(`/crm/leads/${lead.id}/assign`, { auto: true }); onDone(); } catch (e) { setErr((e as Error).message); } }}>Run allocation</Button>
      <Button variant="primary" disabled={!v.user_id} onClick={async () => { try { await api.post(`/crm/leads/${lead.id}/assign`, { user_id: v.user_id, reason: v.reason || null }); onDone(); } catch (e) { setErr((e as Error).message); } }}>Assign</Button>
    </>}>
      <div className="space-y-3">
        {err && <Notice tone="danger">{err}</Notice>}
        <div className="space-y-1.5">{(team.data ?? []).filter((m) => m.active).map((m) => (
          <label key={m.user_id} className={clsx('flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2', v.user_id === m.user_id ? 'border-brand-500 bg-brand-50' : 'border-slate-200')}>
            <input type="radio" checked={v.user_id === m.user_id} onChange={() => setV({ ...v, user_id: m.user_id })} />
            <Avatar name={m.name} size="sm" /><span className="flex-1 text-[13px] font-medium">{m.name}</span>
            <span className={clsx('text-[12px]', m.available ? 'text-emerald-700' : 'text-slate-500')}>{m.availability} · {m.active_leads} open</span>
          </label>
        ))}</div>
        {lead.owner_id && <Input label="Reason" required value={v.reason} onChange={(e) => setV({ ...v, reason: e.target.value })} hint="Kept in the reassignment history" />}
      </div>
    </Modal>
  );
}

function ConvertModal({ lead, onClose, onDone }: { lead: Lead; onClose: () => void; onDone: () => void }) {
  const customers = useParties('customer');
  const [mode, setMode] = useState<'new' | 'link'>('new');
  const [v, setV] = useState({ legal_name: lead.company ?? lead.name, gstin: lead.gstin ?? '', state_code: lead.state_code ?? '', customer_id: '' });
  const [err, setErr] = useState<string | null>(null);
  return (
    <Modal open onClose={onClose} title="Convert to customer" footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={async () => {
      try { await api.post(`/crm/leads/${lead.id}/convert`, mode === 'link' ? { customer_id: v.customer_id } : { legal_name: v.legal_name, gstin: v.gstin || null, state_code: v.state_code || null }); onDone(); } catch (e) { setErr((e as Error).message); }
    }}>{mode === 'link' ? 'Link' : 'Create customer'}</Button></>}>
      <div className="space-y-3">
        {err && <Notice tone="danger">{err}</Notice>}
        <Segmented value={mode} onChange={setMode} options={[{ value: 'new', label: 'New customer' }, { value: 'link', label: 'Existing customer' }]} />
        {mode === 'new' ? (
          <div className="grid grid-cols-2 gap-3">
            <Input className="col-span-2" label="Legal name" value={v.legal_name} onChange={(e) => setV({ ...v, legal_name: e.target.value })} />
            <Input label="GSTIN" value={v.gstin} onChange={(e) => setV({ ...v, gstin: e.target.value.toUpperCase() })} hint="Blank for unregistered buyers" />
            <Select label="State" value={v.state_code} onChange={(e) => setV({ ...v, state_code: e.target.value })} options={[{ value: '', label: '—' }, ...Object.entries(GST_STATES).map(([k, x]) => ({ value: k, label: x }))]} />
          </div>
        ) : <Select label="Customer" value={v.customer_id} onChange={(e) => setV({ ...v, customer_id: e.target.value })} options={[{ value: '', label: 'Choose…' }, ...(customers.data ?? []).map((c) => ({ value: c.id, label: c.legal_name }))]} />}
      </div>
    </Modal>
  );
}
