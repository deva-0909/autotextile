import { useQuery, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { AlarmClock, ArrowRightLeft, CheckCircle2, ClipboardCheck, FileSignature, Inbox, ListTodo, MessageSquare, Plus, RefreshCw, Search, Trash2, Workflow as WorkflowIcon } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, invalidatePrefix, type Page } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { fmtDate, fmtDateTime, fmtINR, fmtRelative, humanize } from '../../lib/format';
import { SimpleTable } from '../../components/DataTable';
import { Drawer, Modal, useToast } from '../../components/overlay';
import { useParties } from '../../components/business';
import { Badge, Button, Card, Checkbox, EmptyState, ErrorState, Input, KeyValue, Notice, PageHeader, Segmented, Select, Skeleton, Stat, StatusBadge, Tabs, Textarea } from '../../components/ui';

const errMsg = (e: unknown) => (e as Error).message;
interface DirUser { id: string; name: string; email: string; status: string; party_id: string | null }
const useDirectory = () => useQuery({ queryKey: ['directory'], queryFn: () => api.get<DirUser[]>('/identity/directory'), staleTime: 60_000, select: (d) => d.filter((u) => !u.party_id && u.status === 'active') });
const PRIORITY_TONE = { urgent: 'danger', high: 'warning', normal: 'neutral', low: 'neutral' } as const;

// ---------------------------------------------------------------- My Work
interface Task { id: string; number: string; title: string; description: string | null; link: string | null; owner_id: string | null; owner_name: string | null; queue_permission: string | null; priority: keyof typeof PRIORITY_TONE; due_at: string | null; overdue: boolean; status: string; escalated_at: string | null; source_type: string | null; created_by_name: string; created_at: string; resolution?: string | null }
interface Approval { id: string; title: string; summary: string | null; approval_type: string; requested_by_name: string; requested_at: string }
interface Lead { id: string; number: string; name: string; company: string | null; stage: string; next_action: string | null; next_action_at: string | null }

export function MyWorkPage() {
  const { user, can } = useAuth();
  const nav = useNavigate();
  const [tab, setTab] = useState<'tasks' | 'approvals' | 'followups'>('tasks');
  const [sel, setSel] = useState<Task | null>(null);
  const [creating, setCreating] = useState(false);
  const work = useQuery({ queryKey: ['wf-mywork'], queryFn: () => api.get<{ tasks: Task[]; done_7d: number }>('/workflow/my-work') });
  const appr = useQuery({ queryKey: ['wf-myappr'], queryFn: () => api.get<Page<Approval>>('/governance/approvals?f_status=pending&f_box=inbox&pageSize=50') });
  const leads = useQuery({ queryKey: ['wf-myleads'], queryFn: () => api.get<Page<Lead>>(`/crm/leads?f_owner=me&f_view=overdue&pageSize=50&sort=next_action_at&dir=asc`), enabled: can('crm.read') });
  const tasks = work.data?.tasks ?? [];
  const mine = tasks.filter((t) => t.owner_id === user?.id), queue = tasks.filter((t) => !t.owner_id);
  const overdue = tasks.filter((t) => t.overdue).length;
  return (
    <>
      <PageHeader title="My work" description="Your tasks, your team’s unassigned queue, approvals waiting for you and customer follow-ups that are due — in one list." actions={<Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>New task</Button>} />
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Stat label="Assigned to me" value={mine.length} />
        <Stat label="In my team’s queue" value={queue.length} />
        <Stat label="Overdue" value={overdue} tone={overdue ? 'danger' : undefined} />
        <Stat label="Approvals waiting" value={appr.data?.total ?? '—'} tone={appr.data?.total ? 'warning' : undefined} />
        <Stat label="Done in the last 7 days" value={work.data?.done_7d ?? '—'} tone="success" />
      </div>
      <Tabs className="mb-4" value={tab} onChange={setTab} tabs={[{ value: 'tasks', label: 'Tasks', count: tasks.length }, { value: 'approvals', label: 'Approvals', count: appr.data?.total }, { value: 'followups', label: 'Follow-ups due', count: leads.data?.total }]} />
      {tab === 'tasks' ? (
        <Card padded={false}>
          {!work.data ? <Skeleton className="m-5 h-40" /> : <TaskTable rows={tasks} onOpen={setSel} empty="Nothing waiting — well done." />}
        </Card>
      ) : tab === 'approvals' ? (
        <Card padded={false}>
          {!appr.data ? (appr.isFetching ? <Skeleton className="m-5 h-32" /> : <EmptyState title="You approve nothing in this role" />) : (
            <SimpleTable rows={appr.data.items} rowKey={(a) => a.id} onRowClick={(a) => nav(`/approvals/${a.id}`)} empty={<EmptyState icon={<ClipboardCheck className="size-5" />} title="No approvals waiting" />} columns={[
              { key: 't', header: 'Request', render: (a) => <div><p className="font-medium">{a.title}</p>{a.summary && <p className="max-w-xl truncate text-[12px] text-slate-500">{a.summary}</p>}</div> },
              { key: 'k', header: 'Type', render: (a) => <Badge>{humanize(a.approval_type)}</Badge> },
              { key: 'b', header: 'From', render: (a) => a.requested_by_name },
              { key: 'd', header: 'Waiting', render: (a) => fmtRelative(a.requested_at) },
            ]} />
          )}
        </Card>
      ) : (
        <Card padded={false}>
          {!leads.data ? <EmptyState title="Follow-ups appear here for sales users" /> : (
            <SimpleTable rows={leads.data.items} rowKey={(l) => l.id} onRowClick={(l) => nav(`/crm/leads/${l.id}`)} empty={<EmptyState icon={<AlarmClock className="size-5" />} title="No follow-ups due" />} columns={[
              { key: 'n', header: 'Lead', render: (l) => <div><p className="font-medium">{l.name}{l.company ? ` · ${l.company}` : ''}</p><p className="text-[12px] text-slate-500">{l.number}</p></div> },
              { key: 's', header: 'Stage', render: (l) => <StatusBadge status={l.stage} /> },
              { key: 'a', header: 'Next action', render: (l) => l.next_action ?? <span className="text-rose-600">None planned</span> },
              { key: 'd', header: 'Due', render: (l) => (l.next_action_at ? <span className="text-rose-600">{fmtRelative(l.next_action_at)}</span> : '—') },
            ]} />
          )}
        </Card>
      )}
      <TaskDrawer task={sel} onClose={() => setSel(null)} />
      <NewTaskModal open={creating} onClose={() => setCreating(false)} />
    </>
  );
}

function TaskTable({ rows, onOpen, empty, showOwner = true }: { rows: Task[]; onOpen: (t: Task) => void; empty: string; showOwner?: boolean }) {
  return (
    <SimpleTable rows={rows} rowKey={(t) => t.id} onRowClick={onOpen} empty={<EmptyState icon={<ListTodo className="size-5" />} title={empty} />} columns={[
      { key: 'p', header: '', width: '90px', render: (t) => <Badge tone={PRIORITY_TONE[t.priority]} dot>{t.escalated_at ? 'escalated' : t.priority}</Badge> },
      { key: 't', header: 'Task', render: (t) => <div><p className="font-medium">{t.title}</p><p className="text-[12px] text-slate-500">{t.number} · {t.created_by_name}{t.source_type && t.source_type !== 'manual' ? ` · ${humanize(t.source_type)}` : ''}</p></div> },
      ...(showOwner ? [{ key: 'o', header: 'With', render: (t: Task) => t.owner_name ?? <Badge tone="info">Team queue</Badge> }] : []),
      { key: 'd', header: 'Due', render: (t) => (t.due_at ? <span className={clsx(t.overdue && 'font-semibold text-rose-600')}>{fmtDateTime(t.due_at)}</span> : '—') },
      { key: 's', header: 'Status', render: (t) => <StatusBadge status={t.status} /> },
    ]} />
  );
}

function TaskDrawer({ task, onClose }: { task: Task | null; onClose: () => void }) {
  const { user, can } = useAuth();
  const qc = useQueryClient();
  const dir = useDirectory();
  const q = useQuery({ queryKey: ['wf-task', task?.id], queryFn: () => api.get<Task & { events: { id: number; kind: string; note: string | null; by_name: string; at: string }[] }>(`/workflow/tasks/${task!.id}`), enabled: !!task });
  const [note, setNote] = useState('');
  const [to, setTo] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const t = q.data;
  const act = async (action: string) => { setErr(null); try { await api.post(`/workflow/tasks/${task!.id}/action`, { action, note: note || null, owner_id: to || undefined }); setNote(''); invalidatePrefix(qc, 'wf-'); if (['complete', 'cancel'].includes(action)) onClose(); } catch (e) { setErr(errMsg(e)); } };
  const open = t && ['open', 'in_progress'].includes(t.status);
  return (
    <Drawer open={!!task} onClose={onClose} title={task?.title ?? ''} description={task ? `${task.number}${task.owner_name ? ` · ${task.owner_name}` : ' · team queue'}` : undefined}
      footer={open && <div className="flex w-full flex-wrap justify-end gap-2">
        {!t.owner_id && <Button onClick={() => void act('claim')}>Take it</Button>}
        {t.status === 'open' && t.owner_id === user?.id && <Button onClick={() => void act('start')}>Start</Button>}
        <Button variant="ghost" onClick={() => void act('cancel')}>Cancel task</Button>
        <Button variant="primary" icon={<CheckCircle2 className="size-4" />} onClick={() => void act('complete')}>Mark done</Button>
      </div>}>
      {!t ? <Skeleton className="h-60" /> : (
        <div className="space-y-5">
          <KeyValue items={[{ label: 'Status', value: <StatusBadge status={t.status} /> }, { label: 'Priority', value: <Badge tone={PRIORITY_TONE[t.priority]}>{t.priority}</Badge> }, { label: 'Due', value: t.due_at ? fmtDateTime(t.due_at) : '—' }, { label: 'Queue', value: t.queue_permission ?? '—' }, { label: 'Created by', value: t.created_by_name }, { label: 'Resolution', value: t.resolution ?? '—' }]} />
          {t.description && <p className="text-[13.5px] whitespace-pre-wrap">{t.description}</p>}
          {t.link && <Link to={t.link} className="link text-[13px]">Open the record →</Link>}
          {err && <Notice tone="danger">{err}</Notice>}
          {open && <Textarea label="Note (needed to finish or reassign)" value={note} onChange={(e) => setNote(e.target.value)} />}
          {open && can('workflow.task.manage') && (
            <div className="flex items-end gap-2"><Select className="flex-1" label="Reassign to" value={to} onChange={(e) => setTo(e.target.value)} placeholder="Choose a colleague" options={(dir.data ?? []).map((u) => ({ value: u.id, label: u.name }))} /><Button disabled={!to} icon={<ArrowRightLeft className="size-4" />} onClick={() => void act('reassign')}>Reassign</Button></div>
          )}
          <div><p className="mb-2 text-[13px] font-semibold">History</p><ul className="space-y-1.5 text-[12.5px]">{t.events.map((e) => <li key={e.id}><span className="text-slate-500">{fmtDateTime(e.at)}</span> · <span className="font-medium">{humanize(e.kind)}</span> by {e.by_name}{e.note ? ` — ${e.note}` : ''}</li>)}</ul></div>
        </div>
      )}
    </Drawer>
  );
}

const QUEUES = [['fulfilment.dispatch', 'Dispatch team'], ['commerce.order.manage', 'Sales desk'], ['fulfilment.returns.manage', 'Customer care / returns'], ['finance.voucher.post', 'Accounts'], ['procurement.po.manage', 'Purchase'], ['inventory.move', 'Warehouse'], ['hrms.employee.manage', 'HR'], ['workflow.handover.manage', 'Team leads'], ['crm.price.approve', 'Sales managers'], ['fulfilment.split.approve', 'Management'], ['governance.approval.decide', 'Approvers']];
function NewTaskModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { user, can } = useAuth();
  const qc = useQueryClient();
  const dir = useDirectory();
  const [v, setV] = useState({ title: '', description: '', to: 'me', priority: 'normal', due_at: '' });
  const [err, setErr] = useState<string | null>(null);
  return (
    <Modal open={open} onClose={onClose} title="New task" footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={v.title.trim().length < 3} onClick={async () => {
      setErr(null);
      try {
        const isQueue = v.to.startsWith('q:');
        await api.post('/workflow/tasks', { title: v.title, description: v.description || null, priority: v.priority, due_at: v.due_at ? new Date(v.due_at).toISOString() : null, owner_id: v.to === 'me' ? user!.id : isQueue ? null : v.to, queue_permission: isQueue ? v.to.slice(2) : null });
        invalidatePrefix(qc, 'wf-'); onClose(); setV({ title: '', description: '', to: 'me', priority: 'normal', due_at: '' });
      } catch (e) { setErr(errMsg(e)); }
    }}>Create</Button></>}>
      <div className="space-y-3">
        {err && <Notice tone="danger">{err}</Notice>}
        <Input label="What needs doing" required value={v.title} onChange={(e) => setV({ ...v, title: e.target.value })} />
        <Textarea label="Details" value={v.description} onChange={(e) => setV({ ...v, description: e.target.value })} />
        <div className="grid grid-cols-3 gap-3">
          <Select label="For" value={v.to} onChange={(e) => setV({ ...v, to: e.target.value })} options={[{ value: 'me', label: 'Me' }, ...QUEUES.map(([p, l]) => ({ value: `q:${p}`, label: `Queue: ${l}` })), ...(can('workflow.task.manage') ? (dir.data ?? []).filter((u) => u.id !== user?.id).map((u) => ({ value: u.id, label: u.name })) : [])]} />
          <Select label="Priority" value={v.priority} onChange={(e) => setV({ ...v, priority: e.target.value })} options={['low', 'normal', 'high', 'urgent'].map((p) => ({ value: p, label: humanize(p) }))} />
          <Input label="Due" type="datetime-local" value={v.due_at} onChange={(e) => setV({ ...v, due_at: e.target.value })} />
        </div>
      </div>
    </Modal>
  );
}

export function AllTasksPage() {
  const [status, setStatus] = useState('open,in_progress');
  const [sel, setSel] = useState<Task | null>(null);
  const q = useQuery({ queryKey: ['wf-alltasks', status], queryFn: () => api.get<Task[]>(`/workflow/tasks?status=${status}`) });
  const overdue = (q.data ?? []).filter((t) => t.overdue).length;
  return (
    <>
      <PageHeader title="All tasks" description="Every task across teams, from workflow rules, contract renewals, handovers and people." breadcrumbs={[{ label: 'Workflow' }, { label: 'Tasks' }]} />
      <div className="mb-4 flex items-center gap-4"><Segmented value={status} onChange={setStatus} options={[{ value: 'open,in_progress', label: 'Open' }, { value: 'done,cancelled', label: 'Closed' }]} />{overdue > 0 && <Badge tone="danger">{overdue} overdue</Badge>}</div>
      <Card padded={false}>{!q.data ? <Skeleton className="m-5 h-40" /> : <TaskTable rows={q.data} onOpen={setSel} empty="No tasks" />}</Card>
      <TaskDrawer task={sel} onClose={() => setSel(null)} />
    </>
  );
}

// ---------------------------------------------------------------- communications
interface Msg { id: string; event_type: string; template_code: string; channel: string; to_name: string | null; to_address: string; ref_label: string | null; subject: string | null; body: string; status: string; skip_reason: string | null; attempts: number; next_attempt_at: string; error: string | null; created_at: string; sent_at: string | null; delivered_at: string | null; read_at: string | null }
interface Tpl { id: string; code: string; version: number; name: string; event_type: string; channel: string; category: string; subject: string | null; body: string; status: string; provider_template: string | null; provider_status: string; created_by_name: string; approved_by_name: string | null; sent_30d: number; failed_30d: number }
const CH_TONE = { whatsapp: 'success', sms: 'info', email: 'violet' } as const;
const MSG_TONE: Record<string, 'success' | 'warning' | 'danger' | 'neutral' | 'info'> = { delivered: 'success', read: 'success', sent: 'info', queued: 'warning', failed: 'danger', skipped: 'neutral' };

export function CommunicationsPage() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const [tab, setTab] = useState<'log' | 'templates' | 'consent'>('log');
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const [msg, setMsg] = useState<Msg | null>(null);
  const [tpl, setTpl] = useState<Tpl | 'new' | null>(null);
  const log = useQuery({ queryKey: ['wf-msgs', status, search], queryFn: () => api.get<{ rows: Msg[]; stats: Record<string, number> }>(`/workflow/messages?${status ? `status=${status}&` : ''}${search ? `q=${encodeURIComponent(search)}` : ''}`), enabled: tab === 'log' });
  const tpls = useQuery({ queryKey: ['wf-tpls'], queryFn: () => api.get<Tpl[]>('/workflow/templates'), enabled: tab === 'templates' });
  const s = log.data?.stats;
  return (
    <>
      <PageHeader title="Customer communications" description="WhatsApp, SMS and email sent automatically from business events — enquiry, quotation, booking, payment link, invoice, receipt, dispatch with LR and tracking, delivery and complaints. WhatsApp and SMS go only to numbers that opted in."
        breadcrumbs={[{ label: 'Workflow' }, { label: 'Communications' }]} actions={tab === 'templates' && can('workflow.template.manage') && <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setTpl('new')}>New template</Button>} />
      <Tabs className="mb-4" value={tab} onChange={setTab} tabs={[{ value: 'log', label: 'Delivery log' }, { value: 'templates', label: 'Templates' }, { value: 'consent', label: 'Consent' }]} />
      {tab === 'log' ? (
        <>
          {s && <div className="mb-4 grid grid-cols-3 gap-3 lg:grid-cols-6">
            <Stat label="Last 30 days" value={s.total} /><Stat label="Delivered" value={s.delivered} tone="success" /><Stat label="Read" value={s.read} /><Stat label="Queued / retrying" value={s.queued} /><Stat label="Failed" value={s.failed} tone={s.failed ? 'danger' : undefined} /><Stat label="Skipped (no consent)" value={s.skipped} />
          </div>}
          <div className="mb-3 flex flex-wrap gap-2"><Segmented value={status} onChange={setStatus} options={[{ value: '', label: 'All' }, { value: 'queued', label: 'Queued' }, { value: 'delivered,read', label: 'Delivered' }, { value: 'failed', label: 'Failed' }, { value: 'skipped', label: 'Skipped' }]} /><Input className="w-64" placeholder="Customer, number, reference" value={search} onChange={(e) => setSearch(e.target.value)} /></div>
          <Card padded={false}>
            {!log.data ? <Skeleton className="m-5 h-40" /> : <SimpleTable pageSize={20} rows={log.data.rows} rowKey={(m) => m.id} onRowClick={setMsg} empty={<EmptyState icon={<MessageSquare className="size-5" />} title="No messages" />} columns={[
              { key: 'w', header: 'When', render: (m) => <span className="whitespace-nowrap">{fmtDateTime(m.created_at)}</span> },
              { key: 'c', header: 'Channel', render: (m) => <Badge tone={CH_TONE[m.channel as keyof typeof CH_TONE]}>{m.channel === 'whatsapp' ? 'WhatsApp' : m.channel.toUpperCase()}</Badge> },
              { key: 't', header: 'To', render: (m) => <div><p>{m.to_name}</p><p className="font-mono text-[11.5px] text-slate-500">{m.to_address}</p></div> },
              { key: 'm', header: 'Message', render: (m) => <div className="max-w-md"><p className="text-[12px] text-slate-500">{humanize(m.template_code.replace(/_(whatsapp|sms|email)$/, ''))} · {m.ref_label}</p><p className="truncate text-[12.5px]">{m.subject ?? m.body}</p></div> },
              { key: 's', header: 'Status', render: (m) => <div><Badge tone={MSG_TONE[m.status] ?? 'neutral'} dot>{humanize(m.status)}</Badge>{m.status === 'queued' && m.attempts > 0 && <p className="text-[11px] text-slate-500">retry {m.attempts}/5</p>}{m.skip_reason && <p className="text-[11px] text-slate-500">{m.skip_reason}</p>}</div> },
            ]} />}
          </Card>
        </>
      ) : tab === 'templates' ? (
        <Card padded={false}>
          {!tpls.data ? <Skeleton className="m-5 h-40" /> : <SimpleTable rows={tpls.data} rowKey={(x) => x.id} onRowClick={setTpl} columns={[
            { key: 'n', header: 'Template', render: (x) => <div><p className="font-medium">{x.name} <span className="text-slate-400">v{x.version}</span></p><p className="font-mono text-[11.5px] text-slate-500">{x.code}</p></div> },
            { key: 'e', header: 'Sent when', render: (x) => <span className="text-[12.5px]">{humanize(x.event_type.split('.').slice(1).join(' '))}</span> },
            { key: 'c', header: 'Channel', render: (x) => <Badge tone={CH_TONE[x.channel as keyof typeof CH_TONE]}>{x.channel === 'whatsapp' ? 'WhatsApp' : x.channel.toUpperCase()}</Badge> },
            { key: 'p', header: 'Meta approval', render: (x) => (x.channel === 'whatsapp' ? <Badge tone={x.provider_status === 'approved' ? 'success' : x.provider_status === 'rejected' ? 'danger' : 'warning'}>{x.provider_template ?? '—'} · {x.provider_status}</Badge> : '—') },
            { key: 'u', header: '30 days', align: 'right', render: (x) => <span>{x.sent_30d}{x.failed_30d ? <span className="text-rose-600"> · {x.failed_30d} failed</span> : ''}</span> },
            { key: 's', header: 'Status', render: (x) => <StatusBadge status={x.status} /> },
          ]} />}
        </Card>
      ) : <ConsentPanel />}
      <Drawer open={!!msg} onClose={() => setMsg(null)} title={msg ? `${msg.channel === 'whatsapp' ? 'WhatsApp' : msg.channel.toUpperCase()} to ${msg.to_name ?? msg.to_address}` : ''} description={msg?.ref_label ?? undefined}
        footer={msg?.status === 'failed' && can('workflow.template.manage') && <Button variant="primary" icon={<RefreshCw className="size-4" />} onClick={async () => { const r = await api.post<{ status: string }>(`/workflow/messages/${msg.id}/retry`); toast({ tone: r.status === 'failed' ? 'error' : 'success', title: `Retry: ${humanize(r.status)}` }); setMsg(null); invalidatePrefix(qc, 'wf-'); }}>Retry now</Button>}>
        {msg && <MessageDetail id={msg.id} />}
      </Drawer>
      {tpl && <TemplateModal tpl={tpl === 'new' ? null : tpl} onClose={() => setTpl(null)} onDone={() => invalidatePrefix(qc, 'wf-')} />}
    </>
  );
}

function MessageDetail({ id }: { id: string }) {
  const q = useQuery({ queryKey: ['wf-msg', id], queryFn: () => api.get<Msg & { events: { id: number; kind: string; detail: Record<string, unknown> | null; at: string }[] }>(`/workflow/messages/${id}`) });
  const m = q.data;
  if (!m) return <Skeleton className="h-60" />;
  return (
    <div className="space-y-4">
      <div className={clsx('rounded-xl p-4 text-[13.5px] whitespace-pre-wrap', m.channel === 'whatsapp' ? 'bg-[#e7fbe6]' : 'bg-slate-50 ring-1 ring-slate-200')}>{m.subject && <p className="mb-2 font-semibold">{m.subject}</p>}{m.body}</div>
      <KeyValue items={[{ label: 'Status', value: <Badge tone={MSG_TONE[m.status] ?? 'neutral'}>{humanize(m.status)}</Badge> }, { label: 'Attempts', value: m.attempts }, { label: 'Sent', value: m.sent_at ? fmtDateTime(m.sent_at) : '—' }, { label: 'Delivered', value: m.delivered_at ? fmtDateTime(m.delivered_at) : '—' }, { label: 'Read', value: m.read_at ? fmtDateTime(m.read_at) : '—' }, { label: 'Error', value: m.error ?? m.skip_reason ?? '—' }]} />
      <div><p className="mb-2 text-[13px] font-semibold">Provider events</p><ul className="space-y-1 text-[12.5px]">{m.events.map((e) => <li key={e.id}><span className="text-slate-500">{fmtDateTime(e.at)}</span> · {humanize(e.kind)}{e.detail?.error ? ` — ${String(e.detail.error)}` : ''}</li>)}</ul></div>
    </div>
  );
}

function TemplateModal({ tpl, onClose, onDone }: { tpl: Tpl | null; onClose: () => void; onDone: () => void }) {
  const { can } = useAuth();
  const events = useQuery({ queryKey: ['wf-events'], queryFn: () => api.get<{ type: string; variables: string[] }[]>('/workflow/events') });
  const [v, setV] = useState({ code: tpl?.code ?? '', name: tpl?.name ?? '', event_type: tpl?.event_type ?? 'commerce.order.booked', channel: tpl?.channel ?? 'whatsapp', category: tpl?.category ?? 'utility', subject: tpl?.subject ?? '', body: tpl?.body ?? '', provider_template: tpl?.provider_template ?? '' });
  const [preview, setPreview] = useState<{ subject: string | null; body: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const vars = events.data?.find((e) => e.type === v.event_type)?.variables ?? [];
  const readOnly = !can('workflow.template.manage');
  return (
    <Modal open onClose={onClose} size="lg" title={tpl ? `${tpl.name} · v${tpl.version}` : 'New message template'} description="Saving creates a new version that goes live after a second person approves it in Approvals. WhatsApp templates must also be approved by Meta."
      footer={<><Button onClick={onClose}>Close</Button>{tpl && <Button onClick={async () => setPreview(await api.post(`/workflow/templates/${tpl.id}/preview`))}>Preview live version</Button>}{!readOnly && <Button variant="primary" onClick={async () => { setErr(null); try { await api.post('/workflow/templates', { ...v, subject: v.subject || null, provider_template: v.provider_template || null }); onDone(); onClose(); } catch (e) { setErr(errMsg(e)); } }}>Submit for approval</Button>}</>}>
      <div className="grid grid-cols-2 gap-3">
        {err && <div className="col-span-2"><Notice tone="danger">{err}</Notice></div>}
        <Input label="Code" disabled={!!tpl || readOnly} value={v.code} onChange={(e) => setV({ ...v, code: e.target.value })} hint="lower_case, unique" />
        <Input label="Name" disabled={readOnly} value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} />
        <Select label="Sent when" disabled={!!tpl || readOnly} value={v.event_type} onChange={(e) => setV({ ...v, event_type: e.target.value })} options={(events.data ?? []).map((e) => ({ value: e.type, label: humanize(e.type.split('.').slice(1).join(' ')) }))} />
        <div className="grid grid-cols-2 gap-3"><Select label="Channel" disabled={!!tpl || readOnly} value={v.channel} onChange={(e) => setV({ ...v, channel: e.target.value })} options={[{ value: 'whatsapp', label: 'WhatsApp' }, { value: 'sms', label: 'SMS' }, { value: 'email', label: 'Email' }]} /><Select label="Category" disabled={readOnly} value={v.category} onChange={(e) => setV({ ...v, category: e.target.value })} options={['utility', 'marketing'].map((c) => ({ value: c, label: humanize(c) }))} /></div>
        {v.channel === 'email' && <Input className="col-span-2" label="Subject" disabled={readOnly} value={v.subject} onChange={(e) => setV({ ...v, subject: e.target.value })} />}
        {v.channel === 'whatsapp' && <Input className="col-span-2" label="WhatsApp template name (as registered with Meta)" disabled={readOnly} value={v.provider_template} onChange={(e) => setV({ ...v, provider_template: e.target.value })} />}
        <Textarea className="col-span-2 font-mono text-[12.5px]" rows={6} label="Message" disabled={readOnly} value={v.body} onChange={(e) => setV({ ...v, body: e.target.value })} />
        <div className="col-span-2 flex flex-wrap gap-1.5 text-[12px]"><span className="text-slate-500">Insert:</span>{vars.map((x) => <button key={x} type="button" disabled={readOnly} className="rounded bg-slate-100 px-1.5 py-0.5 font-mono hover:bg-brand-50" onClick={() => setV({ ...v, body: `${v.body}{{${x}}}` })}>{`{{${x}}}`}</button>)}</div>
        {preview && <div className="col-span-2 rounded-lg bg-[#e7fbe6] p-3 text-[13px] whitespace-pre-wrap">{preview.subject && <p className="font-semibold">{preview.subject}</p>}{preview.body}</div>}
      </div>
    </Modal>
  );
}

function ConsentPanel() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const parties = useParties('customer');
  const q = useQuery({ queryKey: ['wf-consent'], queryFn: () => api.get<{ id: string; party_name: string | null; address: string; channel: string; status: string; scope: string; source: string; recorded_by_name: string; at: string }[]>('/workflow/consents') });
  const [v, setV] = useState({ party_id: '', address: '', channel: 'whatsapp', status: 'opted_in', scope: 'transactional', source: '' });
  const [err, setErr] = useState<string | null>(null);
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <Card className="lg:col-span-2" padded={false} title="Recorded consent">
        {!q.data ? <Skeleton className="m-5 h-40" /> : <SimpleTable rows={q.data} rowKey={(x) => x.id} columns={[
          { key: 'p', header: 'Customer', render: (x) => x.party_name ?? '—' },
          { key: 'a', header: 'Number / email', render: (x) => <span className="font-mono text-[12.5px]">{x.address}</span> },
          { key: 'c', header: 'Channel', render: (x) => <Badge tone={CH_TONE[x.channel as keyof typeof CH_TONE]}>{x.channel}</Badge> },
          { key: 's', header: 'Consent', render: (x) => <Badge tone={x.status === 'opted_in' ? 'success' : 'danger'}>{humanize(x.status)} · {x.scope}</Badge> },
          { key: 'o', header: 'Source', render: (x) => <span className="text-[12.5px]">{x.source} · {fmtDate(x.at)}</span> },
        ]} />}
      </Card>
      {can('workflow.template.manage', 'commerce.order.manage') && (
        <Card title="Record consent or opt-out" description="Opt-outs (for example a customer replying STOP) take effect immediately.">
          <div className="space-y-3">
            {err && <Notice tone="danger">{err}</Notice>}
            <Select label="Customer" value={v.party_id} onChange={(e) => setV({ ...v, party_id: e.target.value })} placeholder="Optional" options={(parties.data ?? []).map((p) => ({ value: p.id, label: p.legal_name }))} />
            <Input label="Mobile or email" value={v.address} onChange={(e) => setV({ ...v, address: e.target.value })} />
            <div className="grid grid-cols-2 gap-2"><Select label="Channel" value={v.channel} onChange={(e) => setV({ ...v, channel: e.target.value })} options={[{ value: 'whatsapp', label: 'WhatsApp' }, { value: 'sms', label: 'SMS' }, { value: 'email', label: 'Email' }]} /><Select label="Status" value={v.status} onChange={(e) => setV({ ...v, status: e.target.value })} options={[{ value: 'opted_in', label: 'Opted in' }, { value: 'opted_out', label: 'Opted out' }]} /></div>
            <Select label="For" value={v.scope} onChange={(e) => setV({ ...v, scope: e.target.value })} options={[{ value: 'transactional', label: 'Order and account updates' }, { value: 'marketing', label: 'Offers and new arrivals' }]} />
            <Input label="How it was given" value={v.source} onChange={(e) => setV({ ...v, source: e.target.value })} placeholder="Signed form, WhatsApp reply, website tick-box" />
            <Button variant="primary" onClick={async () => { setErr(null); try { await api.post('/workflow/consents', { ...v, party_id: v.party_id || null }); invalidatePrefix(qc, 'wf-'); setV({ ...v, address: '', source: '' }); } catch (e) { setErr(errMsg(e)); } }}>Save</Button>
          </div>
        </Card>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- rules
interface Cond { field: string; op: string; value: string | number }
interface Act { type: string; title?: string; owner_field?: string; queue_permission?: string; permission?: string; priority?: string; due_in_hours?: number; escalate_after_hours?: number; escalate_to_permission?: string; template_code?: string; delay_minutes?: number }
interface Rule { id: string; name: string; event_type: string; match: 'all' | 'any'; conditions: Cond[]; actions: Act[]; active: boolean; runs: number; last_run_at: string | null; matched_30d: number; created_by_name: string }
const OPS = [['eq', 'is'], ['neq', 'is not'], ['gt', '>'], ['gte', '≥'], ['lt', '<'], ['lte', '≤'], ['contains', 'contains'], ['in', 'is one of']];

export function RulesPage() {
  const nav = useNavigate();
  const { can } = useAuth();
  const q = useQuery({ queryKey: ['wf-rules'], queryFn: () => api.get<Rule[]>('/workflow/rules') });
  return (
    <>
      <PageHeader title="Workflow rules" description="When something happens in the business, and the conditions match, create a task, notify a team or send a message — now or after a delay. Tasks can escalate when overdue." breadcrumbs={[{ label: 'Workflow' }, { label: 'Rules' }]}
        actions={can('workflow.rule.manage') && <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => nav('/workflow/rules/new')}>New rule</Button>} />
      <Card padded={false}>
        {!q.data ? <Skeleton className="m-5 h-40" /> : <SimpleTable rows={q.data} rowKey={(r) => r.id} onRowClick={(r) => nav(`/workflow/rules/${r.id}`)} empty={<EmptyState icon={<WorkflowIcon className="size-5" />} title="No rules" />} columns={[
          { key: 'n', header: 'Rule', render: (r) => <p className="font-medium">{r.name}</p> },
          { key: 'w', header: 'When', render: (r) => <span className="text-[12.5px]">{humanize(r.event_type.split('.').slice(1).join(' '))}{r.conditions.length ? ` · ${r.conditions.map((c) => `${c.field} ${OPS.find((o) => o[0] === c.op)?.[1]} ${c.value}`).join(r.match === 'all' ? ' and ' : ' or ')}` : ''}</span> },
          { key: 'a', header: 'Then', render: (r) => <span className="text-[12.5px]">{r.actions.map((a) => `${humanize(a.type)}${a.delay_minutes ? ` after ${a.delay_minutes >= 1440 ? `${a.delay_minutes / 1440} d` : `${a.delay_minutes} min`}` : ''}`).join(', ')}</span> },
          { key: 'r', header: 'Matched (30 d)', align: 'right', render: (r) => r.matched_30d },
          { key: 's', header: 'Status', render: (r) => <StatusBadge status={r.active ? 'active' : 'inactive'} /> },
        ]} />}
      </Card>
    </>
  );
}

export function RuleEditorPage() {
  const { id = 'new' } = useParams();
  const nav = useNavigate();
  const { can } = useAuth();
  const qc = useQueryClient();
  const events = useQuery({ queryKey: ['wf-events'], queryFn: () => api.get<{ type: string; variables: string[] }[]>('/workflow/events') });
  const tpls = useQuery({ queryKey: ['wf-tpls'], queryFn: () => api.get<Tpl[]>('/workflow/templates') });
  const existing = useQuery({ queryKey: ['wf-rule', id], queryFn: () => api.get<Rule & { runs_log: { id: number; event_type: string; matched: boolean; outcome: string | null; at: string }[] }>(`/workflow/rules/${id}`), enabled: id !== 'new' });
  const [r, setR] = useState<Omit<Rule, 'id' | 'runs' | 'last_run_at' | 'matched_30d' | 'created_by_name'> | null>(id === 'new' ? { name: '', event_type: 'fulfilment.delivered', match: 'all', conditions: [], actions: [{ type: 'create_task', title: '', queue_permission: 'commerce.order.manage', priority: 'normal', due_in_hours: 24 }], active: true } : null);
  const [err, setErr] = useState<string | null>(null);
  const v = r ?? (existing.data ? { name: existing.data.name, event_type: existing.data.event_type, match: existing.data.match, conditions: existing.data.conditions, actions: existing.data.actions, active: existing.data.active } : null);
  if (!v) return <Skeleton className="h-96" />;
  const set = (p: Partial<typeof v>) => setR({ ...v, ...p });
  const vars = events.data?.find((e) => e.type === v.event_type)?.variables ?? [];
  const setA = (i: number, p: Partial<Act>) => set({ actions: v.actions.map((a, j) => (j === i ? { ...a, ...p } : a)) });
  const setC = (i: number, p: Partial<Cond>) => set({ conditions: v.conditions.map((c, j) => (j === i ? { ...c, ...p } : c)) });
  const ro = !can('workflow.rule.manage');
  return (
    <>
      <PageHeader title={id === 'new' ? 'New workflow rule' : v.name} breadcrumbs={[{ label: 'Workflow' }, { label: 'Rules', to: '/workflow/rules' }, { label: id === 'new' ? 'New' : v.name }]}
        actions={!ro && <Button variant="primary" onClick={async () => { setErr(null); try { const out = id === 'new' ? await api.post<{ id: string }>('/workflow/rules', v) : await api.put<{ id: string }>(`/workflow/rules/${id}`, v); invalidatePrefix(qc, 'wf-'); nav(`/workflow/rules/${out.id}`); } catch (e) { setErr(errMsg(e)); } }}>Save rule</Button>} />
      {err && <div className="mb-4"><Notice tone="danger">{err}</Notice></div>}
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Card title="1 · When">
            <div className="grid grid-cols-2 gap-3"><Input label="Rule name" disabled={ro} value={v.name} onChange={(e) => set({ name: e.target.value })} /><Select label="This happens" disabled={ro} value={v.event_type} onChange={(e) => set({ event_type: e.target.value })} options={(events.data ?? []).map((e) => ({ value: e.type, label: humanize(e.type.split('.').slice(1).join(' ')) }))} /></div>
          </Card>
          <Card title="2 · If" description="Leave empty to act every time." actions={!ro && <Segmented value={v.match} onChange={(m) => set({ match: m })} options={[{ value: 'all', label: 'All match' }, { value: 'any', label: 'Any matches' }]} />}>
            <div className="space-y-2">
              {v.conditions.map((c, i) => (
                <div key={i} className="grid grid-cols-[1fr_140px_1fr_32px] gap-2">
                  <Select value={c.field} disabled={ro} onChange={(e) => setC(i, { field: e.target.value })} options={[...vars, 'amount', 'total', 'condition', 'days', 'days_overdue', 'category', 'purpose'].filter((x, k, a) => a.indexOf(x) === k).map((x) => ({ value: x, label: x }))} />
                  <Select value={c.op} disabled={ro} onChange={(e) => setC(i, { op: e.target.value })} options={OPS.map(([o, l]) => ({ value: o!, label: l! }))} />
                  <Input value={String(c.value)} disabled={ro} onChange={(e) => setC(i, { value: e.target.value })} />
                  {!ro && <button type="button" className="text-slate-400 hover:text-rose-600" onClick={() => set({ conditions: v.conditions.filter((_, j) => j !== i) })}><Trash2 className="size-4" /></button>}
                </div>
              ))}
              {!ro && <Button size="sm" icon={<Plus className="size-3.5" />} onClick={() => set({ conditions: [...v.conditions, { field: vars[0] ?? 'amount', op: 'eq', value: '' }] })}>Add condition</Button>}
            </div>
          </Card>
          <Card title="3 · Then">
            <div className="space-y-4">
              {v.actions.map((a, i) => (
                <div key={i} className="rounded-lg p-3 ring-1 ring-slate-200">
                  <div className="mb-2 flex items-center gap-2"><Select className="w-48" disabled={ro} value={a.type} onChange={(e) => setA(i, { type: e.target.value })} options={[{ value: 'create_task', label: 'Create a task' }, { value: 'notify', label: 'Notify a team' }, { value: 'send_message', label: 'Send a message' }]} />
                    <Input className="w-40" type="number" disabled={ro} value={String(a.delay_minutes ?? 0)} onChange={(e) => setA(i, { delay_minutes: Number(e.target.value) })} suffix="min later" />
                    {!ro && v.actions.length > 1 && <button type="button" className="ml-auto text-slate-400 hover:text-rose-600" onClick={() => set({ actions: v.actions.filter((_, j) => j !== i) })}><Trash2 className="size-4" /></button>}</div>
                  {a.type === 'send_message' ? <Select label="Template" disabled={ro} value={a.template_code ?? ''} onChange={(e) => setA(i, { template_code: e.target.value })} placeholder="Choose" options={(tpls.data ?? []).filter((x) => x.status === 'active').map((x) => ({ value: x.code, label: `${x.name} (${x.channel})` }))} /> : (
                    <div className="grid grid-cols-2 gap-2">
                      <Input className="col-span-2" label={a.type === 'notify' ? 'Notification' : 'Task title'} disabled={ro} value={a.title ?? ''} onChange={(e) => setA(i, { title: e.target.value })} hint={`Variables: ${vars.map((x) => `{{${x}}}`).join(' ')}`} />
                      <Select label="Assign to" disabled={ro} value={a.owner_field ? `field:${a.owner_field}` : `q:${(a.type === 'notify' ? a.permission : a.queue_permission) ?? ''}`} onChange={(e) => setA(i, e.target.value.startsWith('field:') ? { owner_field: e.target.value.slice(6), queue_permission: undefined, permission: undefined } : a.type === 'notify' ? { permission: e.target.value.slice(2), owner_field: undefined } : { queue_permission: e.target.value.slice(2), owner_field: undefined })}
                        options={[{ value: 'field:owner_id', label: 'Owner of the record' }, ...QUEUES.map(([p, l]) => ({ value: `q:${p}`, label: l! }))]} />
                      {a.type === 'create_task' && <>
                        <Select label="Priority" disabled={ro} value={a.priority ?? 'normal'} onChange={(e) => setA(i, { priority: e.target.value })} options={['low', 'normal', 'high', 'urgent'].map((p) => ({ value: p, label: humanize(p) }))} />
                        <Input label="Due in" type="number" disabled={ro} suffix="hours" value={String(a.due_in_hours ?? '')} onChange={(e) => setA(i, { due_in_hours: e.target.value ? Number(e.target.value) : undefined })} />
                        <Input label="Escalate if not done after" type="number" disabled={ro} suffix="hours" value={String(a.escalate_after_hours ?? '')} onChange={(e) => setA(i, { escalate_after_hours: e.target.value ? Number(e.target.value) : undefined, escalate_to_permission: a.escalate_to_permission ?? 'governance.approval.decide' })} />
                      </>}
                    </div>
                  )}
                </div>
              ))}
              {!ro && <Button size="sm" icon={<Plus className="size-3.5" />} onClick={() => set({ actions: [...v.actions, { type: 'notify', title: '', permission: 'commerce.order.manage' }] })}>Add action</Button>}
              {!ro && <Checkbox label="Rule is active" checked={v.active} onChange={(e) => set({ active: e.target.checked })} />}
            </div>
          </Card>
        </div>
        <Card title="Recent runs" padded={false}>
          {existing.data?.runs_log.length ? <ul className="divide-y divide-slate-100 text-[12.5px]">{existing.data.runs_log.map((x) => <li key={x.id} className="px-4 py-2"><Badge tone={x.matched ? 'success' : 'neutral'}>{x.matched ? 'matched' : 'skipped'}</Badge> <span className="text-slate-500">{fmtDateTime(x.at)}</span>{x.outcome && <p className="mt-0.5">{x.outcome}</p>}</li>)}</ul> : <p className="p-4 text-[13px] text-slate-500">Not run yet.</p>}
        </Card>
      </div>
    </>
  );
}

// ---------------------------------------------------------------- contracts
interface KRow { id: string; number: string; kind: string; title: string; party_name: string; start_date: string; end_date: string; value: number | null; status: string; owner_name: string; days_left: number; notes: number }
interface KDetail extends KRow { party_id: string | null; rates: { item: string; rate: number; uom: string }[]; payment_terms: string | null; quality_terms: string | null; delivery_terms: string | null; penalties: string | null; auto_renew: boolean; alerts_sent: number[]; notes_list?: never; notes: number & never; history: { id: string; number: string; start_date: string; end_date: string; status: string }[] }

export function ContractsPage() {
  const nav = useNavigate();
  const { can } = useAuth();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('active');
  const [creating, setCreating] = useState(false);
  const list = useQuery({ queryKey: ['wf-contracts', q, status], queryFn: () => api.get<KRow[]>(`/workflow/contracts?status=${status}${q ? `&q=${encodeURIComponent(q)}` : ''}`) });
  return (
    <>
      <PageHeader title="Contracts" description="Supplier, mill, customer, transport and lease agreements with their rates and terms. Owners are reminded 30, 15 and 7 days before expiry. Search covers the terms and all correspondence."
        breadcrumbs={[{ label: 'Workflow' }, { label: 'Contracts' }]} actions={can('workflow.contract.manage') && <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>New contract</Button>} />
      <div className="mb-4 flex flex-wrap items-center gap-2"><Segmented value={status} onChange={setStatus} options={[{ value: 'active', label: 'Active' }, { value: 'expired,renewed,terminated', label: 'Past' }]} /><div className="relative"><Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-slate-400" /><Input className="w-80 [&_input]:pl-9" placeholder="Search terms, rates, notes — e.g. penalty, shade" value={q} onChange={(e) => setQ(e.target.value)} /></div></div>
      <Card padded={false}>
        {!list.data ? <Skeleton className="m-5 h-40" /> : <SimpleTable rows={list.data} rowKey={(k) => k.id} onRowClick={(k) => nav(`/contracts/${k.id}`)} empty={<EmptyState icon={<FileSignature className="size-5" />} title="No contracts" />} columns={[
          { key: 'n', header: 'Contract', render: (k) => <div><p className="font-medium">{k.title}</p><p className="text-[12px] text-slate-500">{k.number} · {humanize(k.kind)}</p></div> },
          { key: 'p', header: 'With', render: (k) => k.party_name },
          { key: 'v', header: 'Value', align: 'right', render: (k) => (k.value ? fmtINR(k.value) : '—') },
          { key: 'd', header: 'Valid', render: (k) => <span className="whitespace-nowrap">{fmtDate(k.start_date)} – {fmtDate(k.end_date)}</span> },
          { key: 'l', header: 'Expires', render: (k) => (k.status !== 'active' ? <StatusBadge status={k.status} /> : <Badge tone={k.days_left <= 7 ? 'danger' : k.days_left <= 30 ? 'warning' : 'neutral'}>{k.days_left} days</Badge>) },
          { key: 'o', header: 'Owner', render: (k) => k.owner_name },
        ]} />}
      </Card>
      {creating && <ContractModal onClose={() => setCreating(false)} onDone={(id) => nav(`/contracts/${id}`)} />}
    </>
  );
}

function ContractModal({ init, onClose, onDone }: { init?: Partial<KDetail> & { id?: string }; onClose: () => void; onDone: (id: string) => void }) {
  const parties = useParties('supplier,mill,customer,transporter,manufacturer');
  const [v, setV] = useState({ kind: init?.kind ?? 'supply', title: init?.title ?? '', party_id: init?.party_id ?? '', party_name: '', start_date: init?.start_date ?? new Date().toISOString().slice(0, 10), end_date: init?.end_date ?? '', value: init?.value ? String(init.value) : '', payment_terms: init?.payment_terms ?? '', quality_terms: init?.quality_terms ?? '', delivery_terms: init?.delivery_terms ?? '', penalties: init?.penalties ?? '', rates: init?.rates ?? [{ item: '', rate: 0, uom: 'kg' }] });
  const [err, setErr] = useState<string | null>(null);
  return (
    <Modal open onClose={onClose} size="lg" title={init?.id ? 'Amend contract' : 'New contract'} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={async () => {
      setErr(null);
      try {
        const body = { ...v, party_id: v.party_id || null, party_name: v.party_name || null, value: v.value ? Number(v.value) : null, rates: v.rates.filter((r) => r.item), payment_terms: v.payment_terms || null, quality_terms: v.quality_terms || null, delivery_terms: v.delivery_terms || null, penalties: v.penalties || null };
        if (init?.id) { await api.put(`/workflow/contracts/${init.id}`, body); onDone(init.id); } else onDone((await api.post<{ id: string }>('/workflow/contracts', body)).id);
        onClose();
      } catch (e) { setErr(errMsg(e)); }
    }}>Save</Button></>}>
      <div className="grid grid-cols-2 gap-3">
        {err && <div className="col-span-2"><Notice tone="danger">{err}</Notice></div>}
        <Input className="col-span-2" label="Title" value={v.title} onChange={(e) => setV({ ...v, title: e.target.value })} />
        <Select label="Type" value={v.kind} onChange={(e) => setV({ ...v, kind: e.target.value })} options={['supply', 'job_work', 'customer', 'transport', 'rent', 'service', 'other'].map((k) => ({ value: k, label: humanize(k) }))} />
        {!init?.id && <Select label="With" value={v.party_id} onChange={(e) => setV({ ...v, party_id: e.target.value })} placeholder="Business partner" options={(parties.data ?? []).map((p) => ({ value: p.id, label: p.legal_name }))} />}
        {!init?.id && !v.party_id && <Input label="…or other party" value={v.party_name} onChange={(e) => setV({ ...v, party_name: e.target.value })} />}
        <Input label="From" type="date" value={v.start_date} onChange={(e) => setV({ ...v, start_date: e.target.value })} />
        <Input label="To" type="date" value={v.end_date} onChange={(e) => setV({ ...v, end_date: e.target.value })} />
        <Input label="Contract value" type="number" prefix="₹" value={v.value} onChange={(e) => setV({ ...v, value: e.target.value })} />
        <div className="col-span-2 space-y-2"><p className="text-[12.5px] font-medium text-slate-700">Rates</p>{v.rates.map((r, i) => <div key={i} className="grid grid-cols-[1fr_120px_90px] gap-2"><Input placeholder="Item or service" value={r.item} onChange={(e) => setV({ ...v, rates: v.rates.map((x, j) => (j === i ? { ...x, item: e.target.value } : x)) })} /><Input type="number" prefix="₹" value={String(r.rate)} onChange={(e) => setV({ ...v, rates: v.rates.map((x, j) => (j === i ? { ...x, rate: Number(e.target.value) } : x)) })} /><Input value={r.uom} onChange={(e) => setV({ ...v, rates: v.rates.map((x, j) => (j === i ? { ...x, uom: e.target.value } : x)) })} /></div>)}<Button size="sm" onClick={() => setV({ ...v, rates: [...v.rates, { item: '', rate: 0, uom: 'kg' }] })}>Add rate</Button></div>
        <Textarea label="Payment terms" value={v.payment_terms} onChange={(e) => setV({ ...v, payment_terms: e.target.value })} />
        <Textarea label="Delivery terms" value={v.delivery_terms} onChange={(e) => setV({ ...v, delivery_terms: e.target.value })} />
        <Textarea label="Quality terms" value={v.quality_terms} onChange={(e) => setV({ ...v, quality_terms: e.target.value })} />
        <Textarea label="Penalties" value={v.penalties} onChange={(e) => setV({ ...v, penalties: e.target.value })} />
      </div>
    </Modal>
  );
}

export function ContractDetailPage() {
  const { id = '' } = useParams();
  const { can } = useAuth();
  const qc = useQueryClient();
  const nav = useNavigate();
  const q = useQuery({ queryKey: ['wf-contract', id], queryFn: () => api.get<Omit<KDetail, 'notes'> & { notes: { id: string; kind: string; body: string; by_name: string; at: string }[]; documents: { id: string; title: string }[] }>(`/workflow/contracts/${id}`) });
  const [edit, setEdit] = useState(false);
  const [renew, setRenew] = useState(false);
  const [note, setNote] = useState({ kind: 'note', body: '' });
  const [rv, setRv] = useState({ start_date: '', end_date: '' });
  const k = q.data;
  if (q.isError) return <ErrorState error={q.error} />;
  if (!k) return <Skeleton className="h-96" />;
  return (
    <>
      <PageHeader title={k.title} meta={<StatusBadge status={k.status} />} description={`${k.number} · ${humanize(k.kind)} · ${k.party_name}`} breadcrumbs={[{ label: 'Workflow' }, { label: 'Contracts', to: '/contracts' }, { label: k.number }]}
        actions={can('workflow.contract.manage') && ['active', 'expired'].includes(k.status) && <div className="flex gap-2"><Button onClick={() => setEdit(true)}>Amend</Button><Button variant="primary" onClick={() => { const d = new Date(`${k.end_date}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1); const e = new Date(d); e.setUTCFullYear(e.getUTCFullYear() + 1); e.setUTCDate(e.getUTCDate() - 1); setRv({ start_date: d.toISOString().slice(0, 10), end_date: e.toISOString().slice(0, 10) }); setRenew(true); }}>Renew</Button></div>} />
      {k.status === 'active' && k.days_left <= 30 && <div className="mb-4"><Notice tone={k.days_left <= 7 ? 'danger' : 'warning'} title={`Expires in ${k.days_left} days`}>Renew it, renegotiate, or let it lapse deliberately.</Notice></div>}
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Card title="Rates" padded={false}>{k.rates.length ? <SimpleTable rows={k.rates} rowKey={(r) => r.item} columns={[{ key: 'i', header: 'Item', render: (r) => r.item }, { key: 'r', header: 'Rate', align: 'right', render: (r) => `${fmtINR(r.rate)} / ${r.uom}` }]} /> : <p className="p-5 text-[13px] text-slate-500">No rates.</p>}</Card>
          <Card title="Terms"><KeyValue columns={1} items={[{ label: 'Payment', value: k.payment_terms ?? '—' }, { label: 'Delivery', value: k.delivery_terms ?? '—' }, { label: 'Quality', value: k.quality_terms ?? '—' }, { label: 'Penalties', value: k.penalties ?? '—' }]} /></Card>
          <Card title="Correspondence and notes">
            {can('workflow.contract.manage') && <div className="mb-4 flex gap-2"><Select className="w-32" value={note.kind} onChange={(e) => setNote({ ...note, kind: e.target.value })} options={['note', 'email', 'call', 'meeting', 'letter'].map((x) => ({ value: x, label: humanize(x) }))} /><Input className="flex-1" placeholder="What was agreed or said" value={note.body} onChange={(e) => setNote({ ...note, body: e.target.value })} /><Button disabled={note.body.trim().length < 3} onClick={async () => { await api.post(`/workflow/contracts/${k.id}/notes`, note); setNote({ kind: 'note', body: '' }); invalidatePrefix(qc, 'wf-'); }}>Add</Button></div>}
            <ul className="space-y-3">{k.notes.map((n) => <li key={n.id} className="text-[13px]"><p><Badge>{n.kind}</Badge> <span className="text-slate-500">{n.by_name} · {fmtDateTime(n.at)}</span></p><p className="mt-1 whitespace-pre-wrap">{n.body}</p></li>)}</ul>
          </Card>
        </div>
        <Card title="Details">
          <KeyValue columns={1} items={[{ label: 'Valid', value: `${fmtDate(k.start_date)} – ${fmtDate(k.end_date)}` }, { label: 'Value', value: k.value ? fmtINR(k.value) : '—' }, { label: 'Owner', value: k.owner_name }, { label: 'Reminders sent', value: k.alerts_sent.length ? k.alerts_sent.sort((a, b) => b - a).map((d) => `${d} days`).join(', ') : '—' },
            { label: 'Documents', value: k.documents.length ? k.documents.map((d) => <Link key={d.id} className="link block" to="/governance/documents">{d.title}</Link>) : 'None attached' },
            { label: 'Versions', value: k.history.length ? k.history.map((h) => <Link key={h.id} className="link mr-2" to={`/contracts/${h.id}`}>{h.number} ({humanize(h.status)})</Link>) : '—' }]} />
        </Card>
      </div>
      {edit && <ContractModal init={k as unknown as KDetail} onClose={() => setEdit(false)} onDone={() => invalidatePrefix(qc, 'wf-')} />}
      <Modal open={renew} onClose={() => setRenew(false)} title={`Renew ${k.number}`} description="A new contract with the same terms and rates is created for the next period; amend it afterwards if rates change." footer={<><Button onClick={() => setRenew(false)}>Cancel</Button><Button variant="primary" onClick={async () => { const n = await api.post<{ id: string }>(`/workflow/contracts/${k.id}/renew`, rv); setRenew(false); invalidatePrefix(qc, 'wf-'); nav(`/contracts/${n.id}`); }}>Renew</Button></>}>
        <div className="grid grid-cols-2 gap-3"><Input label="From" type="date" value={rv.start_date} onChange={(e) => setRv({ ...rv, start_date: e.target.value })} /><Input label="To" type="date" value={rv.end_date} onChange={(e) => setRv({ ...rv, end_date: e.target.value })} /></div>
      </Modal>
    </>
  );
}

// ---------------------------------------------------------------- handover
interface Ho { id: string; number: string; from_name: string; to_name: string; kind: string; reason: string; until: string | null; summary: Record<string, number>; created_by_name: string; created_at: string; moved: number; skipped: number }
export function HandoverPage() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const dir = useDirectory();
  const list = useQuery({ queryKey: ['wf-handovers'], queryFn: () => api.get<Ho[]>('/workflow/handovers') });
  const [from, setFrom] = useState('');
  const [v, setV] = useState({ to: '', kind: 'leave', reason: '', until: '', tasks: true, leads: true, contracts: true });
  const prev = useQuery({ queryKey: ['wf-hoprev', from], queryFn: () => api.get<{ tasks: unknown[]; contracts: unknown[]; leads: unknown[] }>(`/workflow/handovers/preview/${from}`), enabled: !!from });
  const [sel, setSel] = useState<string | null>(null);
  const det = useQuery({ queryKey: ['wf-ho', sel], queryFn: () => api.get<Ho & { items: { id: number; item_type: string; label: string; outcome: string; note: string | null }[] }>(`/workflow/handovers/${sel}`), enabled: !!sel });
  const [err, setErr] = useState<string | null>(null);
  return (
    <>
      <PageHeader title="Handover" description="When someone goes on leave, resigns or changes role, move their open tasks, sales leads and contracts to a colleague in one recorded step. Approvals follow permissions, so they need no transfer." breadcrumbs={[{ label: 'Workflow' }, { label: 'Handover' }]} />
      <div className="grid gap-4 lg:grid-cols-5">
        {can('workflow.handover.manage') && (
          <Card className="lg:col-span-2" title="Hand over work">
            <div className="space-y-3">
              {err && <Notice tone="danger">{err}</Notice>}
              <Select label="From" value={from} onChange={(e) => setFrom(e.target.value)} placeholder="Choose a person" options={(dir.data ?? []).map((u) => ({ value: u.id, label: u.name }))} />
              {prev.data && <p className="text-[13px] text-slate-600">Open now: {prev.data.tasks.length} tasks · {prev.data.leads.length} leads · {prev.data.contracts.length} contracts</p>}
              <Select label="To" value={v.to} onChange={(e) => setV({ ...v, to: e.target.value })} placeholder="Choose a colleague" options={(dir.data ?? []).filter((u) => u.id !== from).map((u) => ({ value: u.id, label: u.name }))} />
              <div className="grid grid-cols-2 gap-2"><Select label="Because of" value={v.kind} onChange={(e) => setV({ ...v, kind: e.target.value })} options={['leave', 'exit', 'transfer', 'rebalance'].map((k) => ({ value: k, label: humanize(k) }))} /><Input label="Until" type="date" value={v.until} onChange={(e) => setV({ ...v, until: e.target.value })} /></div>
              <Textarea label="Reason" value={v.reason} onChange={(e) => setV({ ...v, reason: e.target.value })} />
              <div className="flex gap-4"><Checkbox label="Tasks" checked={v.tasks} onChange={(e) => setV({ ...v, tasks: e.target.checked })} /><Checkbox label="Leads" checked={v.leads} onChange={(e) => setV({ ...v, leads: e.target.checked })} /><Checkbox label="Contracts" checked={v.contracts} onChange={(e) => setV({ ...v, contracts: e.target.checked })} /></div>
              <Button variant="primary" disabled={!from || !v.to || v.reason.trim().length < 3} onClick={async () => { setErr(null); try { const r = await api.post<{ id: string }>('/workflow/handovers', { from_user_id: from, to_user_id: v.to, kind: v.kind, reason: v.reason, until: v.until || null, include: { tasks: v.tasks, leads: v.leads, contracts: v.contracts } }); invalidatePrefix(qc, 'wf-'); setSel(r.id); setFrom(''); } catch (e) { setErr(errMsg(e)); } }}>Hand over</Button>
            </div>
          </Card>
        )}
        <Card className="lg:col-span-3" title="Past handovers" padded={false}>
          {!list.data ? <Skeleton className="m-5 h-40" /> : <SimpleTable rows={list.data} rowKey={(h) => h.id} onRowClick={(h) => setSel(h.id)} empty={<EmptyState icon={<Inbox className="size-5" />} title="No handovers yet" />} columns={[
            { key: 'n', header: 'Handover', render: (h) => <div><p className="font-medium">{h.from_name} → {h.to_name}</p><p className="text-[12px] text-slate-500">{h.number} · {humanize(h.kind)} · {fmtDate(h.created_at)}</p></div> },
            { key: 's', header: 'Moved', render: (h) => `${h.summary.task ?? 0} tasks · ${h.summary.lead ?? 0} leads · ${h.summary.contract ?? 0} contracts` },
            { key: 'k', header: 'Skipped', align: 'right', render: (h) => (h.skipped ? <Badge tone="warning">{h.skipped}</Badge> : '—') },
          ]} />}
        </Card>
      </div>
      <Drawer open={!!sel} onClose={() => setSel(null)} title={det.data ? `${det.data.from_name} → ${det.data.to_name}` : ''} description={det.data?.reason}>
        {!det.data ? <Skeleton className="h-40" /> : <ul className="space-y-2 text-[13px]">{det.data.items.map((i) => <li key={i.id}><Badge tone={i.outcome === 'moved' ? 'success' : 'warning'}>{i.outcome}</Badge> <span className="text-slate-500">{i.item_type}</span> {i.label}{i.note && <p className="text-[12px] text-slate-500">{i.note}</p>}</li>)}</ul>}
      </Drawer>
    </>
  );
}
