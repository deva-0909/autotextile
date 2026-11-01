import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlarmClock, CalendarClock, Flame, PackageOpen, Phone, RotateCcw, Shuffle, Timer, Users } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Link } from '../../components/AppLink';
import { api, invalidatePrefix } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { fmtDate, fmtDateTime, fmtINR, fmtRelative, humanize } from '../../lib/format';
import { SimpleTable } from '../../components/DataTable';
import { useToast } from '../../components/overlay';
import { Badge, Button, Card, EmptyState, ErrorState, Input, Notice, PageHeader, Select, Skeleton, Stat, StatusBadge, Tabs, Textarea } from '../../components/ui';
import { useTeam } from './Leads';

export interface Reason { text: string; points: number }
export interface CrmSettings { first_response_minutes: number; sla_reassign_minutes: number; no_progress_attempts: number; objections: string[]; stage_probability: Record<string, number>; performance_window_days: number; agent_protection_days: number; agent_commission_months: number; attribution_months: number }
export const useCrmSettings = () => useQuery({ queryKey: ['crm-settings'], queryFn: () => api.get<CrmSettings>('/crm/settings'), staleTime: 60_000 });

/** Score with its band; hovering shows why. */
export function ScoreBadge({ score, band, reasons }: { score: number | null | undefined; band?: string | null; reasons?: Reason[] | null }) {
  if (score == null) return <span className="text-slate-400">—</span>;
  const tone = band === 'hot' ? 'danger' : band === 'warm' ? 'warning' : 'info';
  const title = (reasons ?? []).map((r) => `${r.points > 0 ? '+' : ''}${r.points}  ${r.text}`).join('\n');
  return <span title={title || undefined}><Badge tone={tone}>{band === 'hot' && <Flame className="size-3" />}{score} · {humanize(band ?? '')}</Badge></span>;
}

/** Minutes left to make the first call, ticking; red once missed. */
export function SlaCountdown({ due }: { due: string | null | undefined }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(t); }, []);
  if (!due) return null;
  const mins = Math.round((new Date(due).getTime() - now) / 60_000);
  return <Badge tone={mins < 0 ? 'danger' : mins <= 5 ? 'warning' : 'neutral'}><Timer className="size-3" />{mins < 0 ? `${-mins} min late` : `${mins} min left`}</Badge>;
}

interface DayLead { id: string; number: string; name: string; company: string | null; mobile: string | null; city: string | null; stage: string; source_name: string; score: number | null; score_band: string | null; score_reasons: Reason[] | null; next_action_at: string | null; next_action: string | null; call_attempts: number; no_progress: boolean; reenquiry_count: number; est_value: number | null; sla_due_at: string | null; created_at: string }
interface Engagement { id: string; number: string; kind: 'sample' | 'visit'; items: string; status: string; scheduled_at: string | null; lead_id: string; lead_number: string; lead_name: string; company: string | null; created_at: string }
interface MyDay { user_id: string; name: string; first_response_minutes: number; call_now: DayLead[]; overdue: DayLead[]; due_today: DayLead[]; upcoming: DayLead[]; engagements: Engagement[] }

export function MyDayPage() {
  const { can, user } = useAuth();
  const nav = useNavigate();
  const team = useTeam();
  const manager = can('crm.lead.read_all') || can('crm.lead.assign');
  const [who, setWho] = useState('');
  const q = useQuery({ queryKey: ['crm-my-day', who], queryFn: () => api.get<MyDay>(`/crm/my-day${who ? `?user=${who}` : ''}`), refetchInterval: 60_000 });
  if (q.isError) return <ErrorState error={q.error} />;
  const d = q.data;
  const groups: { key: 'call_now' | 'overdue' | 'due_today' | 'upcoming'; title: string; hint: string; tone: 'danger' | 'warning' | 'brand' | 'neutral'; icon: React.ReactNode }[] = [
    { key: 'call_now', title: 'Call now', hint: `Never contacted · target ${d?.first_response_minutes ?? 15} minutes`, tone: 'danger', icon: <AlarmClock className="size-4" /> },
    { key: 'overdue', title: 'Overdue', hint: 'Follow-up date has passed', tone: 'warning', icon: <CalendarClock className="size-4" /> },
    { key: 'due_today', title: 'Due today', hint: 'Best score first', tone: 'brand', icon: <Phone className="size-4" /> },
    { key: 'upcoming', title: 'This week', hint: 'Coming up', tone: 'neutral', icon: <CalendarClock className="size-4" /> },
  ];
  return (
    <>
      <PageHeader title={who && d ? `${d.name}’s day` : 'My day'} description="Your calls for today in order: new leads to call first, then overdue and due follow-ups, best score first. Samples and visits waiting for the customer’s response are at the bottom."
        breadcrumbs={[{ label: 'Sales & CRM', to: '/crm' }, { label: 'My day' }]}
        actions={manager && <Select aria-label="Salesperson" value={who} onChange={(e) => setWho(e.target.value)} options={[{ value: '', label: user?.name ? `${user.name} (me)` : 'Me' }, ...(team.data ?? []).filter((m) => m.active).map((m) => ({ value: m.user_id, label: m.name }))]} />} />
      {!d ? <Skeleton className="h-96" /> : (
        <div className="space-y-6">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
            <Stat label="Call now" value={d.call_now.length} tone={d.call_now.length ? 'danger' : undefined} />
            <Stat label="Overdue" value={d.overdue.length} tone={d.overdue.length ? 'warning' : undefined} />
            <Stat label="Due today" value={d.due_today.length} />
            <Stat label="This week" value={d.upcoming.length} />
            <Stat label="Samples & visits waiting" value={d.engagements.length} />
          </div>
          {groups.map((g) => (
            <Card key={g.key} title={<span className="flex items-center gap-2">{g.icon}{g.title} <Badge tone={g.tone === 'brand' ? 'info' : g.tone}>{d[g.key].length}</Badge></span>} description={g.hint} padded={false}>
              {d[g.key].length ? (
                <SimpleTable rows={d[g.key]} rowKey={(r) => r.id} onRowClick={(r) => nav(`/crm/leads/${r.id}`)} csv={false} pageSize={10} columns={[
                  { key: 'n', header: 'Lead', render: (r) => <div><p className="font-medium text-slate-900">{r.name}{r.company && <span className="font-normal text-slate-500"> · {r.company}</span>}</p><p className="text-[12px] text-slate-500"><span className="font-mono">{r.number}</span> · {r.source_name}{r.city ? ` · ${r.city}` : ''}</p></div> },
                  { key: 's', header: 'Score', render: (r) => <ScoreBadge score={r.score} band={r.score_band} reasons={r.score_reasons} /> },
                  { key: 'st', header: 'Stage', render: (r) => <span className="flex flex-wrap gap-1"><StatusBadge status={r.stage} />{r.reenquiry_count > 0 && <Badge tone="success">Enquired again</Badge>}{r.no_progress && <Badge tone="danger">Many calls, no progress</Badge>}</span> },
                  { key: 'm', header: 'Mobile', render: (r) => (r.mobile ? <a className="link" href={`tel:+91${r.mobile}`} onClick={(e) => e.stopPropagation()}>+91 {r.mobile}</a> : '—') },
                  { key: 'c', header: 'Calls', align: 'right', render: (r) => r.call_attempts },
                  { key: 'w', header: g.key === 'call_now' ? 'Respond within' : 'Follow-up', render: (r) => (g.key === 'call_now' ? <SlaCountdown due={r.sla_due_at} /> : <span className="text-[12.5px]">{r.next_action_at ? fmtDateTime(r.next_action_at) : 'Not set'}{r.next_action && <span className="block max-w-[200px] truncate text-slate-500">{r.next_action}</span>}</span>) },
                ]} />
              ) : <p className="px-5 py-4 text-[13px] text-slate-500">Nothing here.</p>}
            </Card>
          ))}
          <Card title={<span className="flex items-center gap-2"><PackageOpen className="size-4" />Samples and visits waiting for a response</span>} padded={false}>
            {d.engagements.length ? <SimpleTable rows={d.engagements} rowKey={(r) => r.id} onRowClick={(r) => nav(`/crm/leads/${r.lead_id}`)} csv={false} columns={[
              { key: 'n', header: 'Number', render: (r) => <span className="font-mono text-[12.5px]">{r.number}</span> },
              { key: 'k', header: 'Kind', render: (r) => <Badge>{r.kind === 'sample' ? 'Sample' : 'Showroom visit'}</Badge> },
              { key: 'l', header: 'Lead', render: (r) => `${r.lead_name}${r.company ? ` · ${r.company}` : ''}` },
              { key: 'i', header: 'What', render: (r) => r.items },
              { key: 's', header: 'Status', render: (r) => <StatusBadge status={r.status} /> },
              { key: 'w', header: 'When', render: (r) => (r.scheduled_at ? fmtDateTime(r.scheduled_at) : fmtRelative(r.created_at)) },
            ]} /> : <p className="px-5 py-4 text-[13px] text-slate-500">Nothing waiting.</p>}
          </Card>
        </div>
      )}
    </>
  );
}

interface LostLead { id: string; number: string; name: string; company: string | null; objection: string | null; lost_reason: string | null; owner_name: string | null; closed_at: string; revived_count: number; source_name: string; est_value: number | null }
interface PlanRow { lead_id: string; number: string; name: string; score: number | null; why: string; from: string | null; to: string | null; note: string }
interface OpenLead { id: string; number: string; name: string; company: string | null; owner_name: string | null; owner_inactive: boolean; score: number | null; score_band: string | null; stage: string; source_name: string; created_at: string; first_response_at: string | null }

/** Bulk assignment, rebalancing and reviving lost leads — the sales manager's tools. */
export function LeadToolsPage() {
  const [tab, setTab] = useState<'assign' | 'rebalance' | 'revive'>('assign');
  return (
    <>
      <PageHeader title="Lead tools" description="Assign many leads at once, share out leads held by people who are away or have left, and bring lost leads back for another call."
        breadcrumbs={[{ label: 'Sales & CRM', to: '/crm' }, { label: 'Lead tools' }]} />
      <Tabs className="mb-5" value={tab} onChange={setTab} tabs={[{ value: 'assign', label: 'Bulk assign' }, { value: 'rebalance', label: 'Rebalance' }, { value: 'revive', label: 'Revive lost leads' }]} />
      {tab === 'assign' && <BulkAssign />}
      {tab === 'rebalance' && <Rebalance />}
      {tab === 'revive' && <Revive />}
    </>
  );
}

function Checks<T extends { id: string }>({ rows, sel, setSel }: { rows: T[]; sel: Set<string>; setSel: (s: Set<string>) => void }) {
  const all = rows.length > 0 && rows.every((r) => sel.has(r.id));
  return <input type="checkbox" aria-label="Select all" checked={all} onChange={() => setSel(all ? new Set() : new Set(rows.map((r) => r.id)))} />;
}

function BulkAssign() {
  const team = useTeam();
  const toast = useToast();
  const qc = useQueryClient();
  const [view, setView] = useState('open');
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [to, setTo] = useState('');
  const [reason, setReason] = useState('');
  const q = useQuery({ queryKey: ['crm-bulk', view], queryFn: () => api.get<{ items: OpenLead[] }>(`/crm/leads?pageSize=200&sort=score&dir=desc&f_view=${view === 'unassigned' ? 'open&f_owner=none' : view}`) });
  const rows = q.data?.items ?? [];
  const toggle = (id: string) => { const s = new Set(sel); if (s.has(id)) s.delete(id); else s.add(id); setSel(s); };
  async function go() {
    try {
      const r = await api.post<{ assigned: number; unchanged: number; unassigned: number }>('/crm/leads/bulk-assign', { lead_ids: [...sel], ...(to === 'auto' ? { auto: true } : { user_id: to }), reason });
      toast({ tone: 'success', title: `${r.assigned} leads assigned`, body: r.unassigned ? `${r.unassigned} could not be assigned: nobody available` : undefined });
      setSel(new Set()); q.refetch(); invalidatePrefix(qc, '/crm/leads');
    } catch (e) { toast({ tone: 'error', title: (e as Error).message }); }
  }
  return (
    <Card padded={false} title="Choose leads" description="Hot leads are handled first. Every move is kept in the lead’s assignment history and the new owner is told."
      actions={<Select aria-label="Which leads" value={view} onChange={(e) => { setView(e.target.value); setSel(new Set()); }} options={[{ value: 'open', label: 'All open' }, { value: 'unassigned', label: 'Unassigned' }, { value: 'not_contacted', label: 'Not contacted yet' }, { value: 'no_progress', label: 'Many calls, no progress' }, { value: 'overdue', label: 'Follow-up due' }]} />}>
      <div className="flex flex-wrap items-end gap-3 border-b border-slate-100 px-5 py-3">
        <Select label="Assign to" value={to} onChange={(e) => setTo(e.target.value)} options={[{ value: '', label: 'Choose…' }, { value: 'auto', label: 'Automatically (rules, attendance, shift, caps)' }, ...(team.data ?? []).filter((m) => m.active).map((m) => ({ value: m.user_id, label: `${m.name} · ${m.availability.toLowerCase()} · ${m.active_leads} open` }))]} />
        <Input label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Exhibition follow-up" />
        <Button variant="primary" icon={<Users className="size-4" />} disabled={!sel.size || !to || reason.trim().length < 2} onClick={() => void go()}>Assign {sel.size || ''} lead{sel.size === 1 ? '' : 's'}</Button>
      </div>
      {q.isLoading ? <Skeleton className="m-5 h-40" /> : rows.length ? (
        <SimpleTable rows={rows} rowKey={(r) => r.id} csv={false} pageSize={50} columns={[
          { key: 'x', header: <Checks rows={rows} sel={sel} setSel={setSel} />, render: (r) => <input type="checkbox" aria-label={`Select ${r.number}`} checked={sel.has(r.id)} onChange={() => toggle(r.id)} /> },
          { key: 'n', header: 'Lead', render: (r) => <Link className="link" to={`/crm/leads/${r.id}`}>{r.name}{r.company ? ` · ${r.company}` : ''}</Link> },
          { key: 's', header: 'Score', render: (r) => <ScoreBadge score={r.score} band={r.score_band} /> },
          { key: 'st', header: 'Stage', render: (r) => <StatusBadge status={r.stage} /> },
          { key: 'src', header: 'Source', render: (r) => r.source_name },
          { key: 'o', header: 'Owner', render: (r) => (r.owner_name ? <span>{r.owner_name}{r.owner_inactive && <Badge tone="danger" className="ml-1">Owner inactive – reassign</Badge>}</span> : <Badge tone="danger">Unassigned</Badge>) },
          { key: 'c', header: 'Received', render: (r) => fmtRelative(r.created_at) },
        ]} />
      ) : <EmptyState title="No leads here" />}
    </Card>
  );
}

function Rebalance() {
  const toast = useToast();
  const qc = useQueryClient();
  const [plan, setPlan] = useState<{ moved: number; stays: number; plan: PlanRow[] } | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const run = async (preview: boolean) => {
    setBusy(true);
    try {
      const r = await api.post<{ moved: number; stays: number; plan: PlanRow[] }>('/crm/leads/rebalance', { preview, reason: reason || null });
      setPlan(r);
      if (!preview) { toast({ tone: 'success', title: `${r.moved} leads moved` }); invalidatePrefix(qc, '/crm/leads'); setPlan(null); }
    } catch (e) { toast({ tone: 'error', title: (e as Error).message }); } finally { setBusy(false); }
  };
  return (
    <Card title="Share out leads fairly" description="Takes unassigned leads, leads held by people who have left, and uncalled or due-today leads of people absent or on leave today. Hot leads first; nobody goes over their lead limit. Preview first — nothing changes until you apply.">
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <Input label="Reason (kept in each lead’s history)" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Sourav on leave" />
        <Button icon={<Shuffle className="size-4" />} loading={busy} onClick={() => void run(true)}>Preview</Button>
        {plan && plan.moved > 0 && <Button variant="primary" loading={busy} onClick={() => void run(false)}>Apply: move {plan.moved} lead{plan.moved === 1 ? '' : 's'}</Button>}
      </div>
      {plan && (plan.plan.length ? <SimpleTable rows={plan.plan} rowKey={(r) => r.lead_id} csv={false} columns={[
        { key: 'n', header: 'Lead', render: (r) => <Link className="link" to={`/crm/leads/${r.lead_id}`}>{r.number} · {r.name}</Link> },
        { key: 's', header: 'Score', align: 'right', render: (r) => r.score ?? '—' },
        { key: 'w', header: 'Why', render: (r) => r.why },
        { key: 'f', header: 'From', render: (r) => r.from ?? '—' },
        { key: 't', header: 'To', render: (r) => (r.to ? <Badge tone="success">{r.to}</Badge> : <span className="text-slate-500" title={r.note}>Stays — nobody available</span>) },
      ]} /> : <Notice tone="success">Nothing to rebalance: every open lead is with someone who is in today.</Notice>)}
    </Card>
  );
}

function Revive() {
  const team = useTeam();
  const settings = useCrmSettings();
  const toast = useToast();
  const qc = useQueryClient();
  const [f, setF] = useState({ objection: '', from: '', to: '', owner_id: '' });
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [opt, setOpt] = useState({ assign: 'previous', user_id: '', note: '' });
  const filter = Object.fromEntries(Object.entries(f).filter(([, v]) => v));
  const q = useQuery({ queryKey: ['crm-revive', filter], queryFn: () => api.post<{ count: number; leads: LostLead[] }>('/crm/leads/revive/preview', filter) });
  const rows = q.data?.leads ?? [];
  const toggle = (id: string) => { const s = new Set(sel); if (s.has(id)) s.delete(id); else s.add(id); setSel(s); };
  async function revive(all: boolean) {
    try {
      const body = { ...(all ? filter : { lead_ids: [...sel] }), assign: opt.assign, user_id: opt.assign === 'user' ? opt.user_id : undefined, note: opt.note };
      const r = await api.post<{ revived: number; unassigned: number }>('/crm/leads/revive', body);
      toast({ tone: 'success', title: `${r.revived} lead${r.revived === 1 ? '' : 's'} back in the call list`, body: r.unassigned ? `${r.unassigned} waiting for someone available` : undefined });
      setSel(new Set()); q.refetch(); invalidatePrefix(qc, '/crm/leads');
    } catch (e) { toast({ tone: 'error', title: (e as Error).message }); }
  }
  const ready = opt.note.trim().length >= 2 && (opt.assign !== 'user' || !!opt.user_id);
  return (
    <Card padded={false} title="Bring lost leads back for calling" description="Pick leads one by one, or revive every lead lost to one reason — for example everyone lost on price after a new price list. Revived leads reopen as ‘contact pending’ with a follow-up in an hour, the response timer restarts, and the history shows why.">
      <div className="grid grid-cols-2 gap-3 border-b border-slate-100 px-5 py-3 md:grid-cols-4">
        <Select label="Lost because" value={f.objection} onChange={(e) => setF({ ...f, objection: e.target.value })} options={[{ value: '', label: 'Any reason' }, ...(settings.data?.objections ?? []).map((o) => ({ value: o, label: o }))]} />
        <Input label="Lost from" type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} />
        <Input label="Lost to" type="date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} />
        <Select label="Salesperson" value={f.owner_id} onChange={(e) => setF({ ...f, owner_id: e.target.value })} options={[{ value: '', label: 'Anyone' }, ...(team.data ?? []).map((m) => ({ value: m.user_id, label: m.name }))]} />
      </div>
      <div className="flex flex-wrap items-end gap-3 border-b border-slate-100 px-5 py-3">
        <Select label="Give them to" value={opt.assign} onChange={(e) => setOpt({ ...opt, assign: e.target.value })} options={[{ value: 'previous', label: 'The same salesperson (if still active)' }, { value: 'auto', label: 'Assign automatically' }, { value: 'user', label: 'A chosen salesperson' }]} />
        {opt.assign === 'user' && <Select label="Salesperson" value={opt.user_id} onChange={(e) => setOpt({ ...opt, user_id: e.target.value })} options={[{ value: '', label: 'Choose…' }, ...(team.data ?? []).filter((m) => m.active).map((m) => ({ value: m.user_id, label: m.name }))]} />}
        <Input label="Why call again?" required value={opt.note} onChange={(e) => setOpt({ ...opt, note: e.target.value })} placeholder="e.g. New lower price list" />
        <Button icon={<RotateCcw className="size-4" />} disabled={!sel.size || !ready} onClick={() => void revive(false)}>Revive selected ({sel.size})</Button>
        <Button variant="primary" icon={<RotateCcw className="size-4" />} disabled={!rows.length || !ready || !Object.keys(filter).length} onClick={() => void revive(true)} >Revive all {q.data?.count ?? 0} matching</Button>
      </div>
      {!Object.keys(filter).length && <div className="px-5 pt-3"><Notice tone="info">Choose a reason, a date range or a salesperson to revive in bulk; or tick leads below.</Notice></div>}
      {q.isLoading ? <Skeleton className="m-5 h-40" /> : rows.length ? <SimpleTable rows={rows} rowKey={(r) => r.id} csv={false} pageSize={50} columns={[
        { key: 'x', header: <Checks rows={rows} sel={sel} setSel={setSel} />, render: (r) => <input type="checkbox" aria-label={`Select ${r.number}`} checked={sel.has(r.id)} onChange={() => toggle(r.id)} /> },
        { key: 'n', header: 'Lead', render: (r) => <Link className="link" to={`/crm/leads/${r.id}`}>{r.name}{r.company ? ` · ${r.company}` : ''}</Link> },
        { key: 'o', header: 'Objection', render: (r) => <Badge tone="warning">{r.objection ?? 'Not recorded'}</Badge> },
        { key: 'r', header: 'Reason given', render: (r) => <span className="text-[12.5px] text-slate-600">{r.lost_reason ?? '—'}</span> },
        { key: 'w', header: 'Salesperson', render: (r) => r.owner_name ?? '—' },
        { key: 'v', header: 'Value', align: 'right', render: (r) => fmtINR(r.est_value) },
        { key: 'd', header: 'Lost on', render: (r) => fmtDate(r.closed_at) },
        { key: 'rv', header: 'Revived before', align: 'right', render: (r) => (r.revived_count ? `${r.revived_count}×` : '—') },
      ]} /> : <EmptyState title="No lost leads match" />}
    </Card>
  );
}

/** Response target, no-progress limit, objections and the rest — set by the sales manager. */
export function LeadSettingsPage() {
  const { can } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const s = useCrmSettings();
  const [v, setV] = useState<CrmSettings | null>(null);
  const [objText, setObjText] = useState('');
  useEffect(() => { if (s.data && !v) { setV(s.data); setObjText(s.data.objections.join('\n')); } }, [s.data, v]);
  if (s.isError) return <ErrorState error={s.error} />;
  if (!v) return <Skeleton className="h-96" />;
  const edit = can('crm.config.manage');
  const num = (k: keyof CrmSettings, label: string, hint: string, unit: string) => (
    <Input label={label} hint={hint} type="number" disabled={!edit} value={String(v[k])} suffix={unit} onChange={(e) => setV({ ...v, [k]: Number(e.target.value) })} />
  );
  async function save() {
    try {
      await api.put('/crm/settings', { ...v, objections: objText.split('\n').map((x) => x.trim()).filter(Boolean) });
      toast({ tone: 'success', title: 'Lead settings saved' });
      qc.invalidateQueries({ queryKey: ['crm-settings'] }); setV(null);
    } catch (e) { toast({ tone: 'error', title: (e as Error).message }); }
  }
  return (
    <>
      <PageHeader title="Lead settings" description="How fast leads must be called, when a lead counts as stuck, the objection list and how the forecast and agents work. Changes apply straight away and are kept in the audit trail."
        breadcrumbs={[{ label: 'Sales & CRM', to: '/crm' }, { label: 'Lead settings' }]}
        actions={edit && <Button variant="primary" onClick={() => void save()}>Save</Button>} />
      {!edit && <div className="mb-4"><Notice tone="info">Only the sales manager can change these.</Notice></div>}
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
        <Card title="Response target" description="A new lead must be called within this time of reaching a salesperson. Missed targets turn red and alert the owner and the sales manager.">
          <div className="grid grid-cols-2 gap-3">
            {num('first_response_minutes', 'First call within', 'Counted from assignment', 'min')}
            {num('sla_reassign_minutes', 'Move the lead if still not called after', '0 switches this off; moved once only', 'min')}
          </div>
        </Card>
        <Card title="Many calls, no progress" description="After this many calls without the lead moving forward (or a positive sample or visit), the lead is flagged, its score drops, and the manager sees it on the leaderboard.">
          {num('no_progress_attempts', 'Calls before flagging', 'Counted since the last real progress', 'calls')}
        </Card>
        <Card title="Objections" description="The list salespeople choose from when a lead is lost. One per line; ‘Other’ always stays and needs a note.">
          <Textarea rows={9} disabled={!edit} value={objText} onChange={(e) => setObjText(e.target.value)} />
        </Card>
        <Card title="Forecast: chance of an order by stage" description="Multiplied by the lead’s score to give each open lead’s likelihood.">
          <div className="grid grid-cols-3 gap-3">{Object.entries(v.stage_probability).map(([k, p]) => (
            <Input key={k} label={humanize(k)} type="number" disabled={!edit} suffix="%" value={String(Math.round(p * 100))} onChange={(e) => setV({ ...v, stage_probability: { ...v.stage_probability, [k]: Math.max(0, Math.min(100, Number(e.target.value))) / 100 } })} />
          ))}</div>
        </Card>
        <Card title="Assignment and reports">
          <div className="grid grid-cols-2 gap-3">
            {num('performance_window_days', 'Best-performer looks back', 'Contact and conversion rates over this period', 'days')}
            {num('attribution_months', 'Source revenue counted for', 'After a customer’s first lead', 'months')}
          </div>
        </Card>
        <Card title="Commission agents">
          <div className="grid grid-cols-2 gap-3">
            {num('agent_protection_days', 'Buyer protected for', 'From the day the agent registers them', 'days')}
            {num('agent_commission_months', 'Commission on invoices for', 'From when the buyer becomes a customer', 'months')}
          </div>
        </Card>
      </div>
    </>
  );
}
