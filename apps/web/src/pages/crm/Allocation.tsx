import { useQuery, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { Coffee, Copy, KeyRound, Pencil, Plus, Wand2 } from 'lucide-react';
import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { GST_STATES, fmtNum, fmtRelative, humanize } from '../../lib/format';
import { SimpleTable } from '../../components/DataTable';
import { Drawer, Modal, useToast } from '../../components/overlay';
import { Avatar, Badge, Button, Card, Checkbox, EmptyState, Input, Notice, PageHeader, Select, Skeleton, Switch, Tabs, Textarea } from '../../components/ui';
import { useSources } from './Leads';

interface Member { user_id: string; name: string; email: string | null; cities: string[]; states: string[]; categories: string[]; sources: string[]; languages: string[]; specialisations: string[]; min_value: number | null; max_value: number | null; max_active_leads: number | null; max_discount_pct: number | null; weekly_off: number[]; active: boolean; last_assigned_at: string | null; available: boolean; availability: string; active_leads: number; attendance: { status: string; on_break: boolean; note: string | null } | null; shift_start: string | null; shift_end: string | null; shift_name: string | null; performance?: { assigned: number; contact_rate: number; conversion_rate: number; score: number } }
interface Rule { id: string; name: string; priority: number; conditions: { cities?: string[]; states?: string[]; sources?: string[]; categories?: string[]; languages?: string[]; min_value?: number | null; max_value?: number | null }; strategy: 'round_robin' | 'least_loaded' | 'best_performer'; member_ids: string[]; member_names: string[] | null; status: string }
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const list = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean);
const today = () => new Date().toISOString().slice(0, 10);

type T = 'today' | 'rules' | 'team' | 'preview' | 'sources';
export function AllocationPage() {
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') as T) || 'today';
  return (
    <>
      <PageHeader title="Lead allocation" description="Rules decide who should get a lead; attendance decides who can. Absent, on-leave, weekly-off, on-break, inactive and capped salespeople are skipped, and every decision records why."
        breadcrumbs={[{ label: 'Sales & CRM', to: '/crm' }, { label: 'Allocation' }]} />
      <Tabs className="mb-5" value={tab} onChange={(v) => setParams({ tab: v })} tabs={[{ value: 'today', label: 'Today’s availability' }, { value: 'rules', label: 'Rules' }, { value: 'team', label: 'Sales team' }, { value: 'preview', label: 'Try it' }, { value: 'sources', label: 'Lead sources' }]} />
      {tab === 'today' && <Today />}
      {tab === 'rules' && <Rules />}
      {tab === 'team' && <Team />}
      {tab === 'preview' && <Preview />}
      {tab === 'sources' && <Sources />}
    </>
  );
}

function useMembers() { return useQuery({ queryKey: ['crm-team'], queryFn: () => api.get<Member[]>('/crm/team') }); }

function Today() {
  const { can } = useAuth();
  const toast = useToast();
  const q = useMembers();
  const manage = can('crm.config.manage');
  const mark = async (m: Member, status: string, on_break = false) => {
    try { await api.put('/crm/attendance', { user_id: m.user_id, day: today(), status, on_break }); q.refetch(); } catch (e) { toast({ tone: 'error', title: (e as Error).message }); }
  };
  if (!q.data) return <Skeleton className="h-60" />;
  return (
    <>
      <Notice tone="info">Attendance will come from HRMS (P9). Until then, the sales manager marks it here; it takes effect on the next lead.</Notice>
      <div className="mt-5 grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        {q.data.filter((m) => m.active).map((m) => {
          const status = m.attendance?.status ?? (m.weekly_off.includes(new Date().getDay()) ? 'weekly_off' : 'present');
          const cap = m.max_active_leads ?? 40;
          return (
            <div key={m.user_id} className={clsx('card p-4', !m.available && 'bg-slate-50')}>
              <div className="flex items-center gap-3">
                <Avatar name={m.name} />
                <div className="min-w-0 flex-1"><p className="font-medium text-slate-900">{m.name}</p><p className={clsx('text-[12.5px]', m.available ? 'text-emerald-700' : 'text-slate-500')}>{m.available ? 'Taking leads' : m.availability}</p><p className="text-[11.5px] text-slate-500">{m.shift_start ? `Hours ${m.shift_start.slice(0, 5)}–${m.shift_end?.slice(0, 5)} (${m.shift_name ?? 'from HR'})` : 'Hours not set in HR'}{m.performance && m.performance.assigned > 0 ? ` · ${m.performance.contact_rate}% contact, ${m.performance.conversion_rate}% won` : ''}</p></div>
                <Badge tone={m.available ? 'success' : 'neutral'} dot>{m.available ? 'Available' : 'Skipped'}</Badge>
              </div>
              <div className="mt-3 text-[12px] text-slate-600">
                <div className="mb-1 flex justify-between"><span>Open leads</span><span className="tabular">{m.active_leads} / {cap}</span></div>
                <div className="h-1.5 overflow-hidden rounded-full bg-slate-100"><div className={clsx('h-full rounded-full', m.active_leads >= cap ? 'bg-rose-500' : 'bg-brand-500')} style={{ width: `${Math.min(100, (m.active_leads / cap) * 100)}%` }} /></div>
                <p className="mt-2 text-slate-500">{m.states.map((s) => GST_STATES[s]).join(', ') || 'Any territory'}{m.last_assigned_at ? ` · last lead ${fmtRelative(m.last_assigned_at)}` : ''}</p>
              </div>
              {manage && (
                <div className="mt-3 flex flex-wrap items-center gap-1.5 border-t border-slate-100 pt-3">
                  {(['present', 'absent', 'leave', 'weekly_off', 'half_day'] as const).map((s) => <Button key={s} size="sm" variant={status === s && !m.attendance?.on_break ? 'primary' : 'secondary'} onClick={() => void mark(m, s)}>{humanize(s)}</Button>)}
                  <Button size="sm" variant={m.attendance?.on_break ? 'primary' : 'ghost'} icon={<Coffee className="size-3.5" />} onClick={() => void mark(m, status === 'weekly_off' ? 'present' : status, !m.attendance?.on_break)}>{m.attendance?.on_break ? 'Back from break' : 'On break'}</Button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}

function Rules() {
  const { can } = useAuth();
  const q = useQuery({ queryKey: ['crm-rules'], queryFn: () => api.get<Rule[]>('/crm/rules') });
  const [edit, setEdit] = useState<Rule | 'new' | null>(null);
  const cond = (r: Rule) => [
    r.conditions.states?.length && `State: ${r.conditions.states.map((s) => GST_STATES[s] ?? s).join(', ')}`,
    r.conditions.cities?.length && `City: ${r.conditions.cities.join(', ')}`,
    r.conditions.sources?.length && `Source: ${r.conditions.sources.join(', ')}`,
    r.conditions.categories?.length && `Fabric: ${r.conditions.categories.join(', ')}`,
    r.conditions.languages?.length && `Language: ${r.conditions.languages.join(', ')}`,
    (r.conditions.min_value || r.conditions.max_value) && `Value ${r.conditions.min_value ? `≥ ₹${fmtNum(r.conditions.min_value)}` : ''}${r.conditions.max_value ? ` ≤ ₹${fmtNum(r.conditions.max_value)}` : ''}`,
  ].filter(Boolean).join(' · ') || 'Every lead';
  return (
    <Card title="Allocation rules" description="Checked in priority order; the first matching rule picks the pool. If none matches, everyone whose profile fits is considered." padded={false}
      actions={can('crm.config.manage') && <Button size="sm" variant="primary" icon={<Plus className="size-3.5" />} onClick={() => setEdit('new')}>Add rule</Button>}>
      {!q.data ? <Skeleton className="m-5 h-32" /> : (
        <SimpleTable rows={q.data} rowKey={(r) => r.id} onRowClick={can('crm.config.manage') ? (r) => setEdit(r) : undefined} empty={<EmptyState title="No rules: leads go by profile match" />} columns={[
          { key: 'p', header: '#', render: (r) => <span className="tabular text-slate-500">{r.priority}</span> },
          { key: 'n', header: 'Rule', render: (r) => <div><p className="font-medium">{r.name}</p><p className="text-[12px] text-slate-500">{cond(r)}</p></div> },
          { key: 'm', header: 'Pool', render: (r) => <span className="text-[12.5px]">{r.member_names?.join(', ')}</span> },
          { key: 's', header: 'Strategy', render: (r) => <Badge>{humanize(r.strategy)}</Badge> },
          { key: 'st', header: 'Status', render: (r) => <Badge tone={r.status === 'active' ? 'success' : 'neutral'}>{humanize(r.status)}</Badge> },
          { key: 'e', header: '', align: 'right', render: () => (can('crm.config.manage') ? <Pencil className="ml-auto size-3.5 text-slate-400" /> : null) },
        ]} />
      )}
      {edit && <RuleModal rule={edit === 'new' ? null : edit} onClose={() => setEdit(null)} onDone={() => { setEdit(null); q.refetch(); }} />}
    </Card>
  );
}

function RuleModal({ rule, onClose, onDone }: { rule: Rule | null; onClose: () => void; onDone: () => void }) {
  const team = useMembers();
  const toast = useToast();
  const c = rule?.conditions ?? {};
  const [v, setV] = useState({ name: rule?.name ?? '', priority: String(rule?.priority ?? 100), strategy: rule?.strategy ?? 'round_robin', status: rule?.status ?? 'active', states: (c.states ?? []).join(', '), cities: (c.cities ?? []).join(', '), sources: (c.sources ?? []).join(', '), categories: (c.categories ?? []).join(', '), languages: (c.languages ?? []).join(', '), min_value: c.min_value ? String(c.min_value) : '', max_value: c.max_value ? String(c.max_value) : '', member_ids: rule?.member_ids ?? [] });
  return (
    <Modal open onClose={onClose} size="lg" title={rule ? `Edit rule · ${rule.name}` : 'New allocation rule'} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={async () => {
      const body = { name: v.name, priority: Number(v.priority), strategy: v.strategy, status: v.status, member_ids: v.member_ids, conditions: { states: list(v.states), cities: list(v.cities), sources: list(v.sources).map((s) => s.toUpperCase()), categories: list(v.categories), languages: list(v.languages), min_value: v.min_value ? Number(v.min_value) : null, max_value: v.max_value ? Number(v.max_value) : null } };
      try { if (rule) await api.patch(`/crm/rules/${rule.id}`, body); else await api.post('/crm/rules', body); onDone(); } catch (e) { toast({ tone: 'error', title: (e as Error).message }); }
    }}>Save rule</Button></>}>
      <div className="grid grid-cols-2 gap-3">
        <Input className="col-span-2" label="Name" required value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} />
        <Input label="Priority" type="number" hint="Lower runs first" value={v.priority} onChange={(e) => setV({ ...v, priority: e.target.value })} />
        <Select label="Strategy" value={v.strategy} onChange={(e) => setV({ ...v, strategy: e.target.value as Rule['strategy'] })} options={[{ value: 'round_robin', label: 'Round robin (longest waiting)' }, { value: 'least_loaded', label: 'Least loaded (fewest open leads)' }, { value: 'best_performer', label: 'Best performer (contact and conversion rate)' }]} />
        <Input label="States (GST codes)" placeholder="33, 29" value={v.states} onChange={(e) => setV({ ...v, states: e.target.value })} />
        <Input label="Cities" placeholder="Tiruppur, Erode" value={v.cities} onChange={(e) => setV({ ...v, cities: e.target.value })} />
        <Input label="Sources" placeholder="INDIAMART, META" value={v.sources} onChange={(e) => setV({ ...v, sources: e.target.value })} />
        <Input label="Fabric categories" value={v.categories} onChange={(e) => setV({ ...v, categories: e.target.value })} />
        <Input label="Languages" value={v.languages} onChange={(e) => setV({ ...v, languages: e.target.value })} />
        <div className="grid grid-cols-2 gap-2"><Input label="Min value ₹" type="number" value={v.min_value} onChange={(e) => setV({ ...v, min_value: e.target.value })} /><Input label="Max value ₹" type="number" value={v.max_value} onChange={(e) => setV({ ...v, max_value: e.target.value })} /></div>
        <div className="col-span-2"><p className="mb-1.5 text-[12.5px] font-medium text-slate-700">Pool</p><div className="flex flex-wrap gap-3">{(team.data ?? []).map((m) => <Checkbox key={m.user_id} label={m.name} checked={v.member_ids.includes(m.user_id)} onChange={(e) => setV({ ...v, member_ids: e.target.checked ? [...v.member_ids, m.user_id] : v.member_ids.filter((x) => x !== m.user_id) })} />)}</div></div>
        <div className="col-span-2"><Switch checked={v.status === 'active'} onChange={(on) => setV({ ...v, status: on ? 'active' : 'inactive' })} label="Rule is active" /></div>
      </div>
    </Modal>
  );
}

function Team() {
  const { can } = useAuth();
  const q = useMembers();
  const cands = useQuery({ queryKey: ['crm-cands'], queryFn: () => api.get<{ id: string; name: string; email: string }[]>('/crm/team/candidates'), enabled: can('crm.config.manage') });
  const [edit, setEdit] = useState<Member | { user_id: string; name: string } | null>(null);
  return (
    <Card title="Sales team" description="Territory, language and value bands used for profile matching; lead cap and discount authority per person." padded={false}
      actions={can('crm.config.manage') && cands.data?.length ? <select aria-label="Add to the team" className="input h-8 w-auto text-[13px]" value="" onChange={(e) => { const u = cands.data!.find((x) => x.id === e.target.value); if (u) setEdit({ user_id: u.id, name: u.name }); }}><option value="">Add a person…</option>{cands.data.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select> : undefined}>
      {!q.data ? <Skeleton className="m-5 h-32" /> : (
        <SimpleTable rows={q.data} rowKey={(m) => m.user_id} onRowClick={can('crm.config.manage') ? (m) => setEdit(m) : undefined} columns={[
          { key: 'n', header: 'Salesperson', render: (m) => <span className="flex items-center gap-2"><Avatar name={m.name} size="sm" />{m.name}</span> },
          { key: 't', header: 'Territory', render: (m) => <span className="text-[12.5px]">{m.states.map((s) => GST_STATES[s]).join(', ') || 'Any'}{m.cities.length > 0 && <span className="block text-slate-500">{m.cities.join(', ')}</span>}</span> },
          { key: 'l', header: 'Languages', render: (m) => <span className="text-[12.5px]">{m.languages.join(', ') || '—'}</span> },
          { key: 'c', header: 'Lead cap', align: 'right', render: (m) => m.max_active_leads ?? 'Default' },
          { key: 'd', header: 'Discount authority', align: 'right', render: (m) => (m.max_discount_pct === null ? 'Default' : `${m.max_discount_pct}%`) },
          { key: 'o', header: 'Weekly off', render: (m) => m.weekly_off.map((d) => DAYS[d]).join(', ') },
          { key: 's', header: 'Status', render: (m) => <Badge tone={m.active ? 'success' : 'neutral'}>{m.active ? 'Active' : 'Inactive'}</Badge> },
        ]} />
      )}
      {edit && <MemberDrawer member={edit} onClose={() => setEdit(null)} onDone={() => { setEdit(null); q.refetch(); cands.refetch(); }} />}
    </Card>
  );
}

function MemberDrawer({ member, onClose, onDone }: { member: Partial<Member> & { user_id: string; name: string }; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [v, setV] = useState({ states: (member.states ?? []).join(', '), cities: (member.cities ?? []).join(', '), categories: (member.categories ?? []).join(', '), sources: (member.sources ?? []).join(', '), languages: (member.languages ?? []).join(', '), max_active_leads: member.max_active_leads ? String(member.max_active_leads) : '', max_discount_pct: member.max_discount_pct != null ? String(member.max_discount_pct) : '', min_value: member.min_value ? String(member.min_value) : '', max_value: member.max_value ? String(member.max_value) : '', weekly_off: member.weekly_off ?? [0], active: member.active ?? true });
  return (
    <Drawer open onClose={onClose} title={member.name} description="Sales profile" footer={<Button variant="primary" onClick={async () => {
      try {
        await api.put(`/crm/team/${member.user_id}`, { states: list(v.states), cities: list(v.cities), categories: list(v.categories), sources: list(v.sources), languages: list(v.languages), max_active_leads: v.max_active_leads ? Number(v.max_active_leads) : null, max_discount_pct: v.max_discount_pct ? Number(v.max_discount_pct) : null, min_value: v.min_value ? Number(v.min_value) : null, max_value: v.max_value ? Number(v.max_value) : null, weekly_off: v.weekly_off, active: v.active });
        onDone();
      } catch (e) { toast({ tone: 'error', title: (e as Error).message }); }
    }}>Save</Button>}>
      <div className="grid grid-cols-2 gap-3">
        <Input className="col-span-2" label="States (GST codes)" value={v.states} onChange={(e) => setV({ ...v, states: e.target.value })} hint={list(v.states).map((s) => GST_STATES[s] ?? '?').join(', ')} />
        <Input className="col-span-2" label="Cities" value={v.cities} onChange={(e) => setV({ ...v, cities: e.target.value })} />
        <Input label="Fabric categories" value={v.categories} onChange={(e) => setV({ ...v, categories: e.target.value })} />
        <Input label="Sources" value={v.sources} onChange={(e) => setV({ ...v, sources: e.target.value })} />
        <Input label="Languages" value={v.languages} onChange={(e) => setV({ ...v, languages: e.target.value })} />
        <Input label="Max open leads" type="number" value={v.max_active_leads} onChange={(e) => setV({ ...v, max_active_leads: e.target.value })} hint="Blank = company default" />
        <Input label="Discount authority %" type="number" value={v.max_discount_pct} onChange={(e) => setV({ ...v, max_discount_pct: e.target.value })} hint="Above this needs approval" />
        <div />
        <Input label="Min deal ₹" type="number" value={v.min_value} onChange={(e) => setV({ ...v, min_value: e.target.value })} />
        <Input label="Max deal ₹" type="number" value={v.max_value} onChange={(e) => setV({ ...v, max_value: e.target.value })} />
        <div className="col-span-2"><p className="mb-1.5 text-[12.5px] font-medium text-slate-700">Weekly off</p><div className="flex gap-1.5">{DAYS.map((d, i) => <Button key={d} size="sm" variant={v.weekly_off.includes(i) ? 'primary' : 'secondary'} onClick={() => setV({ ...v, weekly_off: v.weekly_off.includes(i) ? v.weekly_off.filter((x) => x !== i) : [...v.weekly_off, i] })}>{d}</Button>)}</div></div>
        <div className="col-span-2"><Switch checked={v.active} onChange={(on) => setV({ ...v, active: on })} label="Takes leads" /></div>
      </div>
    </Drawer>
  );
}

function Preview() {
  const sources = useSources();
  const [v, setV] = useState({ state_code: '33', city: '', source_code: 'INDIAMART', category: '', language: '', est_value: '', mobile: '' });
  const [r, setR] = useState<{ owner: { name: string } | null; method: string; rule: string | null; note: string; candidates: { user_id: string; name: string; eligible: boolean; reason: string; active_leads: number }[] } | null>(null);
  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
      <Card title="A lead like this…">
        <div className="grid grid-cols-2 gap-3">
          <Select label="State" value={v.state_code} onChange={(e) => setV({ ...v, state_code: e.target.value })} options={[{ value: '', label: 'Unknown' }, ...Object.entries(GST_STATES).map(([k, x]) => ({ value: k, label: x }))]} />
          <Input label="City" value={v.city} onChange={(e) => setV({ ...v, city: e.target.value })} />
          <Select label="Source" value={v.source_code} onChange={(e) => setV({ ...v, source_code: e.target.value })} options={(sources.data ?? []).map((s) => ({ value: s.code, label: s.name }))} />
          <Input label="Estimated value ₹" type="number" value={v.est_value} onChange={(e) => setV({ ...v, est_value: e.target.value })} />
          <Input label="Fabric category" value={v.category} onChange={(e) => setV({ ...v, category: e.target.value })} />
          <Input label="Language" value={v.language} onChange={(e) => setV({ ...v, language: e.target.value })} />
          <Input className="col-span-2" label="Mobile (checks sticky ownership)" value={v.mobile} onChange={(e) => setV({ ...v, mobile: e.target.value })} />
        </div>
        <Button className="mt-4" variant="primary" icon={<Wand2 className="size-4" />} onClick={async () => setR(await api.post('/crm/allocation/preview', { ...v, est_value: v.est_value ? Number(v.est_value) : null, city: v.city || null, state_code: v.state_code || null, category: v.category || null, language: v.language || null, mobile: v.mobile || null }))}>Who gets it?</Button>
      </Card>
      <Card title="…would go to">
        {!r ? <EmptyState title="Run a preview" description="Nothing is created; this only shows the decision." /> : (
          <div className="space-y-4">
            <div className="rounded-lg bg-brand-50 px-4 py-3"><p className="text-[18px] font-semibold text-brand-900">{r.owner?.name ?? 'Nobody available'}</p><p className="text-[12.5px] text-brand-800">{humanize(r.method)} · {r.note}</p></div>
            <ul className="space-y-1.5">{r.candidates.map((c) => <li key={c.user_id} className="flex items-center justify-between text-[13px]"><span className={c.eligible ? '' : 'text-slate-400 line-through'}>{c.name}</span><span className={c.eligible ? 'text-emerald-700' : 'text-slate-500'}>{c.reason} · {c.active_leads} open</span></li>)}</ul>
          </div>
        )}
      </Card>
    </div>
  );
}

function Sources() {
  const { can } = useAuth();
  const toast = useToast();
  const q = useSources();
  const qc = useQueryClient();
  const [edit, setEdit] = useState<{ id?: string; code: string; name: string; kind: string; field_map: string; status: string } | null>(null);
  const base = window.location.origin;
  return (
    <>
      <Notice tone="info">Each source has a private webhook URL. Point IndiaMART’s push API, Meta lead ads (via your connector), Justdial, your website form or WhatsApp at it. The field map translates their JSON into lead fields, so a new platform needs configuration, not code.</Notice>
      <Card className="mt-5" padded={false} title="Sources" actions={can('crm.config.manage') && <Button size="sm" variant="primary" icon={<Plus className="size-3.5" />} onClick={() => setEdit({ code: '', name: '', kind: 'api', field_map: '{\n  "name": "name",\n  "mobile": "phone",\n  "source_ref": "id"\n}', status: 'active' })}>Add source</Button>}>
        {!q.data ? <Skeleton className="m-5 h-32" /> : (
          <SimpleTable rows={q.data} rowKey={(s) => s.id} columns={[
            { key: 'n', header: 'Source', render: (s) => <div><p className="font-medium">{s.name}</p><p className="font-mono text-[11.5px] text-slate-500">{s.code} · {humanize(s.kind)}</p></div> },
            { key: 'c', header: 'Leads', align: 'right', render: (s) => <span>{s.leads_received}<span className="block text-[11.5px] text-slate-500">{s.last_received_at ? fmtRelative(s.last_received_at) : 'none yet'}</span></span> },
            { key: 'm', header: 'Field map', render: (s) => <span className="text-[12px] text-slate-500">{Object.keys(s.field_map).length ? Object.entries(s.field_map).slice(0, 3).map(([k, x]) => `${x}→${k}`).join(', ') + (Object.keys(s.field_map).length > 3 ? '…' : '') : 'Manual entry'}</span> },
            { key: 'u', header: 'Webhook', render: (s) => (s.webhook_path ? <button className="flex items-center gap-1.5 text-[12px] text-brand-700 hover:underline" onClick={() => { void navigator.clipboard?.writeText(`${base}${s.webhook_path}`); toast({ tone: 'success', title: 'Webhook URL copied' }); }}><Copy className="size-3.5" />Copy URL</button> : '—') },
            { key: 's', header: 'Status', render: (s) => <Badge tone={s.status === 'active' ? 'success' : 'neutral'}>{humanize(s.status)}</Badge> },
            { key: 'e', header: '', align: 'right', render: (s) => (can('crm.config.manage') ? <div className="flex justify-end gap-1"><Button size="sm" variant="ghost" icon={<Pencil className="size-3.5" />} onClick={() => setEdit({ id: s.id, code: s.code, name: s.name, kind: s.kind, field_map: JSON.stringify(s.field_map, null, 2), status: s.status })}>Edit</Button><Button size="sm" variant="ghost" icon={<KeyRound className="size-3.5" />} onClick={async () => { await api.post(`/crm/sources/${s.id}/rotate-key`); q.refetch(); toast({ tone: 'success', title: 'New webhook key issued; the old URL stops working' }); }}>Rotate key</Button></div> : null) },
          ]} />
        )}
      </Card>
      {edit && (
        <Modal open onClose={() => setEdit(null)} title={edit.id ? `Edit ${edit.name}` : 'New lead source'} footer={<><Button onClick={() => setEdit(null)}>Cancel</Button><Button variant="primary" onClick={async () => {
          try {
            const fm = JSON.parse(edit.field_map || '{}');
            if (edit.id) await api.patch(`/crm/sources/${edit.id}`, { name: edit.name, kind: edit.kind, field_map: fm, status: edit.status });
            else await api.post('/crm/sources', { code: edit.code, name: edit.name, kind: edit.kind, field_map: fm, status: edit.status });
            setEdit(null); qc.invalidateQueries({ queryKey: ['crm-sources'] });
          } catch (e) { toast({ tone: 'error', title: e instanceof SyntaxError ? 'Field map must be valid JSON' : (e as Error).message }); }
        }}>Save</Button></>}>
          <div className="grid grid-cols-2 gap-3">
            <Input label="Code" disabled={!!edit.id} value={edit.code} onChange={(e) => setEdit({ ...edit, code: e.target.value.toUpperCase() })} />
            <Select label="Kind" value={edit.kind} onChange={(e) => setEdit({ ...edit, kind: e.target.value })} options={['meta', 'indiamart', 'justdial', 'website', 'whatsapp', 'phone', 'email', 'referral', 'exhibition', 'trade_platform', 'manual', 'api', 'csv'].map((k) => ({ value: k, label: humanize(k) }))} />
            <Input className="col-span-2" label="Name" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} />
            <Textarea className="col-span-2 font-mono" rows={8} label="Field map (lead field → path in their JSON)" value={edit.field_map} onChange={(e) => setEdit({ ...edit, field_map: e.target.value })} hint="Fields: name, company, mobile, email, gstin, city, state_code, category, product_label, requirement_kg, est_value, message, source_ref. Paths can be nested, e.g. profile.name" />
            <div className="col-span-2"><Switch checked={edit.status === 'active'} onChange={(on) => setEdit({ ...edit, status: on ? 'active' : 'inactive' })} label="Accept leads" /></div>
          </div>
        </Modal>
      )}
    </>
  );
}
