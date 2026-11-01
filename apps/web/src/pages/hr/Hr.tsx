import { useQuery, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { Briefcase, CalendarCheck, CalendarDays, CheckCircle2, Circle, Clock, Download, IndianRupee, LogIn, LogOut, Plus, UserPlus, Users } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Link } from '../../components/AppLink';
import { api, invalidatePrefix } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { fmtDate, fmtDateTime, fmtINR, humanize } from '../../lib/format';
import { SimpleTable } from '../../components/DataTable';
import { DocumentsPanel } from '../../components/Documents';
import { ConfirmDialog, Modal, useToast } from '../../components/overlay';
import { Badge, Button, Card, Checkbox, EmptyState, ErrorState, Input, KeyValue, Notice, PageHeader, Segmented, Select, Skeleton, Stat, StatusBadge, Tabs, Textarea } from '../../components/ui';

const errMsg = (e: unknown) => (e as Error).message;
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const ATT_TONE: Record<string, string> = { present: 'bg-emerald-500', half_day: 'bg-amber-400', absent: 'bg-rose-500', leave: 'bg-violet-500', weekly_off: 'bg-slate-300', holiday: 'bg-sky-400' };
const EMP_TONE: Record<string, 'success' | 'warning' | 'info' | 'neutral' | 'danger'> = { onboarding: 'info', probation: 'warning', active: 'success', notice: 'danger', exited: 'neutral' };
const money = (n: number | null | undefined) => (n == null ? '—' : `₹${Math.round(n).toLocaleString('en-IN')}`);

// ---------------------------------------------------------------- overview
interface Dash { headcount: number; on_probation: number; on_notice: number; present_today: number; on_leave_today: number; unmarked_today: number; leave_pending: number; confirmations_due: number; candidates_open: number; last_payroll: { month: string; status: string; net: number; employees: number } | null; by_department: { department: string; n: number }[] | null }
export function HrOverview() {
  const q = useQuery({ queryKey: ['hr-dash'], queryFn: () => api.get<Dash>('/hrms/dashboard') });
  const d = q.data;
  return (
    <>
      <PageHeader title="People" description="Employees, attendance, leave, recruitment and payroll. Approved leave and attendance also feed lead allocation in CRM; approved payroll is booked in accounts automatically." breadcrumbs={[{ label: 'HR & payroll' }]} />
      {!d ? <Skeleton className="h-80" /> : (
        <>
          <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Headcount" value={d.headcount} sub={`${d.on_probation} on probation · ${d.on_notice} serving notice`} />
            <Stat label="Present today" value={d.present_today} sub={`${d.on_leave_today} on leave · ${d.unmarked_today} not marked`} tone={d.unmarked_today ? 'warning' : undefined} />
            <Stat label="Leave to approve" value={d.leave_pending} tone={d.leave_pending ? 'warning' : undefined} />
            <Stat label="Last payroll" value={d.last_payroll ? money(d.last_payroll.net) : '—'} sub={d.last_payroll ? `${d.last_payroll.month.slice(0, 7)} · ${humanize(d.last_payroll.status)} · ${d.last_payroll.employees} people` : 'Not run yet'} />
          </div>
          <div className="grid gap-4 lg:grid-cols-3">
            <Card title="By department">
              <ul className="space-y-2 text-[13px]">{(d.by_department ?? []).map((x) => <li key={x.department} className="flex items-center gap-3"><span className="w-36 truncate">{x.department}</span><div className="h-2 flex-1 rounded-full bg-slate-100"><div className="h-2 rounded-full bg-brand-500" style={{ width: `${(x.n / d.headcount) * 100}%` }} /></div><span className="w-6 text-right tabular">{x.n}</span></li>)}</ul>
            </Card>
            <Card title="Needs attention">
              <ul className="space-y-2 text-[13.5px]">
                <li><Link className="link" to="/hr/attendance">{d.unmarked_today} people not marked today</Link></li>
                <li><Link className="link" to="/hr/leave">{d.leave_pending} leave requests waiting</Link></li>
                <li><Link className="link" to="/hr/employees">{d.confirmations_due} probation reviews in the next 15 days</Link></li>
                <li><Link className="link" to="/hr/recruitment">{d.candidates_open} candidates in the pipeline</Link></li>
              </ul>
            </Card>
            <Card title="Go to"><ul className="space-y-2 text-[13.5px]">{[['/hr/employees', 'Employees'], ['/hr/salaries', 'Salary register'], ['/hr/attendance', 'Daily attendance'], ['/hr/holidays', 'Holiday calendar'], ['/hr/leave', 'Leave'], ['/hr/payroll', 'Payroll'], ['/hr/recruitment', 'Recruitment'], ['/workflow/handover', 'Handover']].map(([to, l]) => <li key={to}><Link className="link" to={to!}>{l}</Link></li>)}</ul></Card>
          </div>
        </>
      )}
    </>
  );
}

// ---------------------------------------------------------------- employees
interface ERow { id: string; code: string; name: string; designation: string; department: string; location: string; status: string; date_of_joining: string; manager_name: string | null; shift: string | null; today: string | null; user_id: string | null }
export function EmployeesPage() {
  const nav = useNavigate();
  const { can } = useAuth();
  const [status, setStatus] = useState('onboarding,probation,active,notice');
  const [adding, setAdding] = useState(false);
  const q = useQuery({ queryKey: ['hr-emps', status], queryFn: () => api.get<ERow[]>(`/hrms/employees?status=${status}`) });
  return (
    <>
      <PageHeader title="Employees" breadcrumbs={[{ label: 'HR & payroll', to: '/hr' }, { label: 'Employees' }]} actions={can('hrms.employee.manage') && <Button variant="primary" icon={<UserPlus className="size-4" />} onClick={() => setAdding(true)}>Add employee</Button>} />
      <div className="mb-4"><Segmented value={status} onChange={setStatus} options={[{ value: 'onboarding,probation,active,notice', label: 'Current' }, { value: 'notice', label: 'Serving notice' }, { value: 'exited', label: 'Left' }]} /></div>
      <Card padded={false}>
        {!q.data ? <Skeleton className="m-5 h-40" /> : <SimpleTable rows={q.data} rowKey={(e) => e.id} onRowClick={(e) => nav(`/hr/employees/${e.id}`)} empty={<EmptyState icon={<Users className="size-5" />} title="No employees" />} columns={[
          { key: 'n', header: 'Employee', render: (e) => <div><p className="font-medium">{e.name}</p><p className="text-[12px] text-slate-500">{e.code} · {e.designation}</p></div> },
          { key: 'd', header: 'Department', render: (e) => e.department },
          { key: 'l', header: 'Location · shift', render: (e) => `${e.location}${e.shift ? ` · ${e.shift}` : ''}` },
          { key: 'm', header: 'Reports to', render: (e) => e.manager_name ?? '—' },
          { key: 'j', header: 'Joined', render: (e) => fmtDate(e.date_of_joining) },
          { key: 't', header: 'Today', render: (e) => (e.today ? <span className="inline-flex items-center gap-1.5 text-[12.5px]"><span className={clsx('size-2 rounded-full', ATT_TONE[e.today])} />{humanize(e.today)}</span> : <span className="text-[12px] text-slate-400">not marked</span>) },
          { key: 's', header: 'Status', render: (e) => <Badge tone={EMP_TONE[e.status]} dot>{humanize(e.status)}</Badge> },
          { key: 'u', header: 'Login', render: (e) => (e.user_id ? <Badge tone="info">linked</Badge> : '—') },
        ]} />}
      </Card>
      {adding && <EmployeeModal onClose={() => setAdding(false)} onDone={(id) => nav(`/hr/employees/${id}`)} />}
    </>
  );
}

function EmployeeModal({ onClose, onDone }: { onClose: () => void; onDone: (id: string) => void }) {
  const users = useQuery({ queryKey: ['directory'], queryFn: () => api.get<{ id: string; name: string; email: string; party_id: string | null }[]>('/identity/directory') });
  const [v, setV] = useState({ name: '', email: '', phone: '', designation: '', department: 'Warehouse', location: 'Surat', date_of_joining: new Date().toISOString().slice(0, 10), pan: '', uan: '', bank_account: '', ifsc: '', shift_code: 'GEN', weekly_off: '0', pt_state: '24', overtime_eligible: false, user_id: '' });
  const [err, setErr] = useState<string | null>(null);
  return (
    <Modal open onClose={onClose} size="lg" title="Add employee" description="Starts in onboarding with the joining checklist. Leave entitlement for the year is credited pro rata." footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={async () => {
      setErr(null);
      try { const r = await api.post<{ id: string }>('/hrms/employees', { ...v, weekly_off: Number(v.weekly_off), email: v.email || null, phone: v.phone || null, pan: v.pan || null, uan: v.uan || null, bank_account: v.bank_account || null, ifsc: v.ifsc || null, user_id: v.user_id || null }); onClose(); onDone(r.id); } catch (e) { setErr(errMsg(e)); }
    }}>Add</Button></>}>
      <div className="grid grid-cols-3 gap-3">
        {err && <div className="col-span-3"><Notice tone="danger">{err}</Notice></div>}
        <Input className="col-span-2" label="Full name" value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} />
        <Input label="Joining date" type="date" value={v.date_of_joining} onChange={(e) => setV({ ...v, date_of_joining: e.target.value })} />
        <Input label="Designation" value={v.designation} onChange={(e) => setV({ ...v, designation: e.target.value })} />
        <Input label="Department" value={v.department} onChange={(e) => setV({ ...v, department: e.target.value })} />
        <Select label="Location" value={v.location} onChange={(e) => setV({ ...v, location: e.target.value, pt_state: e.target.value === 'Kolkata' ? '19' : e.target.value === 'Tiruppur' ? '33' : '24' })} options={['Surat', 'Kolkata', 'Tiruppur'].map((x) => ({ value: x, label: x }))} />
        <Input label="Mobile" value={v.phone} onChange={(e) => setV({ ...v, phone: e.target.value })} />
        <Input label="Email" value={v.email} onChange={(e) => setV({ ...v, email: e.target.value })} />
        <Select label="ERP login" value={v.user_id} onChange={(e) => setV({ ...v, user_id: e.target.value })} placeholder="None" options={(users.data ?? []).filter((u) => !u.party_id).map((u) => ({ value: u.id, label: `${u.name} (${u.email})` }))} />
        <Select label="Shift" value={v.shift_code} onChange={(e) => setV({ ...v, shift_code: e.target.value })} options={[{ value: 'GEN', label: 'General 9:30–18:30' }, { value: 'WH1', label: 'Warehouse 8:00–16:30' }, { value: 'WH2', label: 'Warehouse 14:00–22:30' }]} />
        <Select label="Weekly off" value={v.weekly_off} onChange={(e) => setV({ ...v, weekly_off: e.target.value })} options={DAYS.map((d, i) => ({ value: String(i), label: d }))} />
        <div className="flex items-end"><Checkbox label="Paid overtime" checked={v.overtime_eligible} onChange={(e) => setV({ ...v, overtime_eligible: e.target.checked })} /></div>
        <Input label="PAN" value={v.pan} onChange={(e) => setV({ ...v, pan: e.target.value.toUpperCase() })} />
        <Input label="UAN (PF)" value={v.uan} onChange={(e) => setV({ ...v, uan: e.target.value })} />
        <div />
        <Input label="Salary bank account" value={v.bank_account} onChange={(e) => setV({ ...v, bank_account: e.target.value })} />
        <Input label="IFSC" value={v.ifsc} onChange={(e) => setV({ ...v, ifsc: e.target.value.toUpperCase() })} />
      </div>
    </Modal>
  );
}

interface EDetail extends ERow { email: string | null; phone: string | null; pan: string | null; uan: string | null; esic_no: string | null; bank_account: string | null; ifsc: string | null; shift_code: string | null; shift_name: string | null; shift_start: string | null; shift_end: string | null; work_start: string | null; work_end: string | null; weekly_off: number; pt_state: string; overtime_eligible: boolean; probation_months: number; confirmed_on: string | null; last_working_day: string | null; exit_reason: string | null;
  events: { id: number; kind: string; detail: string | null; effective_date: string | null; by_name: string; at: string }[]; checklist: { id: string; stage: string; item: string; done: boolean; done_by_name: string | null }[];
  salary: { effective_from: string; basic: number; hra: number; conveyance: number; special: number; other: number; pf_applicable: boolean }[]; balances: { leave_type: string; name: string; entitled: number; used: number }[];
  leaves: { id: string; number: string; leave_type: string; from_date: string; to_date: string; days: number; status: string; reason: string }[]; attendance: { day: string; status: string; in_time: string | null; out_time: string | null; late_minutes: number; overtime_minutes: number }[]; comp_off: { available: number } }

export function EmployeeDetailPage() {
  const { id = '' } = useParams();
  const { can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['hr-emp', id], queryFn: () => api.get<EDetail>(`/hrms/employees/${id}`) });
  const [tab, setTab] = useState<'profile' | 'attendance' | 'leave' | 'salary' | 'documents' | 'history'>('profile');
  const [life, setLife] = useState<string | null>(null);
  const [lv, setLv] = useState({ effective_date: new Date().toISOString().slice(0, 10), last_working_day: '', location: '', designation: '', reason: '' });
  const [sal, setSal] = useState(false);
  const [cancelLeave, setCancelLeave] = useState<string | null>(null);
  const e = q.data;
  const refresh = () => invalidatePrefix(qc, 'hr-');
  if (q.isError) return <ErrorState error={q.error} />;
  if (!e) return <Skeleton className="h-96" />;
  const actions = { onboarding: ['start_probation'], probation: ['confirm', 'transfer', 'resign'], active: ['transfer', 'promote', 'resign'], notice: ['withdraw_resignation', 'complete_exit'], exited: [] }[e.status as 'active'] ?? [];
  const gross = e.salary[0] ? e.salary[0].basic + e.salary[0].hra + e.salary[0].conveyance + e.salary[0].special + e.salary[0].other : null;
  const stage = e.status === 'notice' || e.status === 'exited' ? 'exit' : 'onboarding';
  const list = e.checklist.filter((c) => c.stage === stage);
  return (
    <>
      <PageHeader title={e.name} meta={<Badge tone={EMP_TONE[e.status]} dot>{humanize(e.status)}</Badge>} description={`${e.code} · ${e.designation}, ${e.department} · ${e.location}`} breadcrumbs={[{ label: 'HR & payroll', to: '/hr' }, { label: 'Employees', to: '/hr/employees' }, { label: e.name }]}
        actions={can('hrms.employee.manage') && <div className="flex gap-2">{actions.map((a) => <Button key={a} variant={a === 'complete_exit' || a === 'resign' ? 'danger' : a === 'confirm' || a === 'start_probation' ? 'primary' : 'secondary'} onClick={() => setLife(a)}>{humanize(a)}</Button>)}</div>} />
      {e.status === 'notice' && <div className="mb-4"><Notice tone="warning" title={`Serving notice — last working day ${fmtDate(e.last_working_day)}`}>{e.exit_reason}. Complete the exit checklist, and hand over leads and tasks in <Link className="link" to="/workflow/handover">Handover</Link>.</Notice></div>}
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Monthly gross" value={money(gross)} sub={e.salary[0] ? `from ${fmtDate(e.salary[0].effective_from)}` : 'No salary structure'} tone={gross == null ? 'warning' : undefined} />
        <Stat label="Leave left" value={e.balances.reduce((s, b) => s + b.entitled - b.used, 0)} sub={e.balances.map((b) => `${b.leave_type} ${b.entitled - b.used}`).join(' · ')} />
        <Stat label="Comp-off available" value={e.comp_off.available} />
        <Stat label="Last 45 days" value={`${e.attendance.filter((a) => a.status === 'present').length} present`} sub={`${e.attendance.filter((a) => a.status === 'absent').length} absent · ${e.attendance.filter((a) => a.late_minutes > 0).length} late`} />
      </div>
      <Tabs className="mb-4" value={tab} onChange={setTab} tabs={[{ value: 'profile', label: 'Profile' }, { value: 'attendance', label: 'Attendance' }, { value: 'leave', label: 'Leave', count: e.leaves.length }, ...(can('hrms.payroll.manage') ? [{ value: 'salary' as const, label: 'Salary' }] : []), ...(can('hrms.employee.manage') ? [{ value: 'documents' as const, label: 'Documents' }] : []), { value: 'history', label: 'History' }]} />
      {tab === 'profile' ? (
        <div className="grid gap-4 lg:grid-cols-3">
          <Card className="lg:col-span-2" title="Details"><KeyValue columns={2} items={[{ label: 'Mobile', value: e.phone ?? '—' }, { label: 'Email', value: e.email ?? '—' }, { label: 'Joined', value: fmtDate(e.date_of_joining) }, { label: 'Confirmed', value: e.confirmed_on ? fmtDate(e.confirmed_on) : `Probation ${e.probation_months} months` }, { label: 'Shift', value: e.shift_name ?? '—' }, { label: 'Working hours', value: e.work_start ? `${e.work_start.slice(0, 5)}–${e.work_end?.slice(0, 5)} (own hours)` : e.shift_start ? `${e.shift_start.slice(0, 5)}–${e.shift_end?.slice(0, 5)} (shift)` : '—' }, { label: 'Weekly off', value: DAYS[e.weekly_off] }, { label: 'PAN', value: e.pan ?? '—', mono: true }, { label: 'UAN', value: e.uan ?? '—', mono: true }, { label: 'Salary account', value: e.bank_account ? `••••${e.bank_account.slice(-4)} · ${e.ifsc}` : '—', mono: true }, { label: 'Professional tax state', value: e.pt_state }, { label: 'Paid overtime', value: e.overtime_eligible ? 'Yes (2× hourly rate)' : 'No — comp-off for off-day work' }, { label: 'ERP login', value: e.user_id ? 'Linked' : 'None' }]} /></Card>
          {can('hrms.attendance.manage') && <HoursCard e={e} onDone={() => { refresh(); q.refetch(); }} />}
          <Card title={`${humanize(stage)} checklist`} description={`${list.filter((c) => c.done).length} of ${list.length} done`}>
            <ul className="space-y-2">{list.map((c) => <li key={c.id}><button type="button" disabled={!can('hrms.employee.manage')} className="flex w-full items-start gap-2 text-left text-[13px]" onClick={async () => { await api.post(`/hrms/checklist/${c.id}`, { done: !c.done }); refresh(); }}>{c.done ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-600" /> : <Circle className="mt-0.5 size-4 shrink-0 text-slate-300" />}<span className={c.done ? 'text-slate-500 line-through' : ''}>{c.item}{c.done_by_name && <span className="ml-1 text-[11.5px] no-underline">· {c.done_by_name}</span>}</span></button></li>)}</ul>
          </Card>
        </div>
      ) : tab === 'attendance' ? <AttendanceGrid rows={e.attendance} /> : tab === 'leave' ? (
        <Card padded={false}>
          <SimpleTable rows={e.leaves} rowKey={(l) => l.id} empty={<EmptyState title="No leave yet" />} columns={[{ key: 'n', header: 'Request', render: (l) => <span className="font-mono text-[12.5px]">{l.number}</span> }, { key: 't', header: 'Type', render: (l) => l.leave_type }, { key: 'd', header: 'Dates', render: (l) => `${fmtDate(l.from_date)} – ${fmtDate(l.to_date)}` }, { key: 'x', header: 'Days', align: 'right', render: (l) => l.days }, { key: 'r', header: 'Reason', render: (l) => l.reason }, { key: 's', header: 'Status', render: (l) => <StatusBadge status={l.status} /> }, { key: 'c', header: '', render: (l) => can('hrms.attendance.manage') && cancellable(l) && <Button size="xs" variant="ghost" onClick={() => setCancelLeave(l.id)}>Cancel</Button> }]} />
        </Card>
      ) : tab === 'salary' ? (
        <Card padded={false} actions={<Button size="sm" icon={<IndianRupee className="size-3.5" />} onClick={() => setSal(true)}>Revise salary</Button>} title="Salary structure (monthly)">
          <SimpleTable rows={e.salary} rowKey={(s) => s.effective_from} empty={<EmptyState title="No salary structure" description="Payroll skips this person until one is set." />} columns={[
            { key: 'f', header: 'From', render: (s) => fmtDate(s.effective_from) }, { key: 'b', header: 'Basic', align: 'right', render: (s) => money(s.basic) }, { key: 'h', header: 'HRA', align: 'right', render: (s) => money(s.hra) }, { key: 'c', header: 'Conveyance', align: 'right', render: (s) => money(s.conveyance) }, { key: 's', header: 'Special', align: 'right', render: (s) => money(s.special) },
            { key: 'g', header: 'Gross', align: 'right', render: (s) => <span className="font-semibold">{money(s.basic + s.hra + s.conveyance + s.special + s.other)}</span> }, { key: 'p', header: 'PF', render: (s) => (s.pf_applicable ? 'Yes' : 'No') },
          ]} />
        </Card>
      ) : tab === 'documents' ? (
        <Card title="Personnel file" description="Offer letter, ID and address proof, PAN, education and previous-employment papers, nominations and exit documents. Only HR sees these; each upload keeps its earlier versions.">
          <DocumentsPanel entityType="employee" entityId={e.id} />
        </Card>
      ) : (
        <Card><ul className="space-y-3">{e.events.map((x) => <li key={x.id} className="text-[13px]"><p className="font-medium">{humanize(x.kind)}{x.effective_date && <span className="font-normal text-slate-500"> · effective {fmtDate(x.effective_date)}</span>}</p>{x.detail && <p>{x.detail}</p>}<p className="text-[12px] text-slate-500">{x.by_name} · {fmtDateTime(x.at)}</p></li>)}</ul></Card>
      )}
      <Modal open={!!life} onClose={() => setLife(null)} title={humanize(life ?? '')} footer={<><Button onClick={() => setLife(null)}>Cancel</Button><Button variant="primary" onClick={async () => {
        try { await api.post(`/hrms/employees/${e.id}/lifecycle`, { action: life, effective_date: lv.effective_date, last_working_day: lv.last_working_day || undefined, location: lv.location || null, designation: lv.designation || null, reason: lv.reason || null }); setLife(null); refresh(); toast({ tone: 'success', title: humanize(life!) }); } catch (x) { toast({ tone: 'error', title: 'Not done', body: errMsg(x) }); }
      }}>Confirm</Button></>}>
        <div className="space-y-3">
          <Input label="Effective date" type="date" value={lv.effective_date} onChange={(x) => setLv({ ...lv, effective_date: x.target.value })} />
          {life === 'resign' && <Input label="Last working day" type="date" value={lv.last_working_day} onChange={(x) => setLv({ ...lv, last_working_day: x.target.value })} />}
          {life === 'transfer' && <Select label="New location" value={lv.location} onChange={(x) => setLv({ ...lv, location: x.target.value })} placeholder="Choose" options={['Surat', 'Kolkata', 'Tiruppur'].map((l) => ({ value: l, label: l }))} />}
          {life === 'promote' && <Input label="New designation" value={lv.designation} onChange={(x) => setLv({ ...lv, designation: x.target.value })} />}
          <Textarea label={life === 'resign' ? 'Reason' : 'Note'} value={lv.reason} onChange={(x) => setLv({ ...lv, reason: x.target.value })} />
          {life === 'complete_exit' && <Notice tone="warning">The ERP login (if any) is deactivated. The exit checklist must be complete.</Notice>}
        </div>
      </Modal>
      {sal && <SalaryModal employeeId={e.id} onClose={() => setSal(false)} onDone={refresh} />}
      <CancelLeaveDialog id={cancelLeave} onClose={() => setCancelLeave(null)} />
    </>
  );
}

function SalaryModal({ employeeId, onClose, onDone }: { employeeId: string; onClose: () => void; onDone: () => void }) {
  const [v, setV] = useState({ effective_from: new Date().toISOString().slice(0, 8) + '01', basic: '', hra: '', conveyance: '1600', special: '', pf_applicable: true });
  const [err, setErr] = useState<string | null>(null);
  const g = ['basic', 'hra', 'conveyance', 'special'].reduce((s, k) => s + (Number(v[k as 'basic']) || 0), 0);
  return (
    <Modal open onClose={onClose} title="Revise salary" description="Payroll uses the structure in force on the last day of the month." footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={async () => { setErr(null); try { await api.post(`/hrms/employees/${employeeId}/salary`, { effective_from: v.effective_from, basic: Number(v.basic), hra: Number(v.hra) || 0, conveyance: Number(v.conveyance) || 0, special: Number(v.special) || 0, pf_applicable: v.pf_applicable }); onClose(); onDone(); } catch (e) { setErr(errMsg(e)); } }}>Save</Button></>}>
      <div className="grid grid-cols-2 gap-3">
        {err && <div className="col-span-2"><Notice tone="danger">{err}</Notice></div>}
        <Input label="Effective from" type="date" value={v.effective_from} onChange={(e) => setV({ ...v, effective_from: e.target.value })} />
        <div />
        {(['basic', 'hra', 'conveyance', 'special'] as const).map((k) => <Input key={k} label={k === 'hra' ? 'HRA' : humanize(k)} type="number" prefix="₹" value={v[k]} onChange={(e) => setV({ ...v, [k]: e.target.value })} />)}
        <Checkbox label="PF applicable (on wages up to ₹15,000)" checked={v.pf_applicable} onChange={(e) => setV({ ...v, pf_applicable: e.target.checked })} />
        <p className="text-right text-[13px] font-semibold">Monthly gross {money(g)}</p>
      </div>
    </Modal>
  );
}

function AttendanceGrid({ rows }: { rows: { day: string; status: string; in_time: string | null; out_time: string | null; late_minutes: number; overtime_minutes: number }[] }) {
  return (
    <Card>
      <div className="mb-3 flex flex-wrap gap-3 text-[12px]">{Object.entries(ATT_TONE).map(([k, c]) => <span key={k} className="flex items-center gap-1.5"><span className={clsx('size-2.5 rounded-sm', c)} />{humanize(k)}</span>)}</div>
      <div className="grid grid-cols-7 gap-1.5 sm:grid-cols-10 lg:grid-cols-15">
        {[...rows].reverse().map((a) => (
          <div key={a.day} title={`${fmtDate(a.day)} · ${humanize(a.status)}${a.in_time ? ` · ${a.in_time.slice(0, 5)}–${a.out_time?.slice(0, 5) ?? ''}` : ''}${a.late_minutes ? ` · ${a.late_minutes} min late` : ''}${a.overtime_minutes ? ` · ${a.overtime_minutes} min overtime` : ''}`} className="rounded-md p-1.5 text-center ring-1 ring-slate-200">
            <p className="text-[10.5px] text-slate-500">{new Date(`${a.day}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}</p>
            <span className={clsx('mx-auto mt-1 block size-3 rounded-sm', ATT_TONE[a.status])} />
            {a.late_minutes > 0 && <p className="mt-0.5 text-[9.5px] text-amber-700">late</p>}
          </div>
        ))}
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------- daily attendance
interface Muster { day: string; holiday: { name: string } | null; rows: { employee_id: string; code: string; name: string; department: string; location: string; shift: string | null; is_weekly_off: boolean; holiday: string | null; status: string | null; in_time: string | null; out_time: string | null; late_minutes: number | null; overtime_minutes: number | null; source: string | null }[] }
export function AttendancePage() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const [day, setDay] = useState(new Date().toISOString().slice(0, 10));
  const q = useQuery({ queryKey: ['hr-muster', day], queryFn: () => api.get<Muster>(`/hrms/attendance?day=${day}`) });
  const [edits, setEdits] = useState<Record<string, { status: string; in_time: string; out_time: string }>>({});
  useEffect(() => setEdits({}), [day]);
  const rows = q.data?.rows ?? [];
  const markAll = () => setEdits(Object.fromEntries(rows.filter((r) => !r.status).map((r) => [r.employee_id, { status: r.is_weekly_off ? 'weekly_off' : r.holiday ? 'holiday' : 'present', in_time: '', out_time: '' }])));
  const counts = useMemo(() => rows.reduce<Record<string, number>>((m, r) => { const s = edits[r.employee_id]?.status ?? r.status ?? 'unmarked'; m[s] = (m[s] ?? 0) + 1; return m; }, {}), [rows, edits]);
  return (
    <>
      <PageHeader title="Daily attendance" description="Mark by exception: set everyone present, then change absentees. Approved leave is filled in automatically; employees can also check in from their phone in My HR."
        breadcrumbs={[{ label: 'HR & payroll', to: '/hr' }, { label: 'Attendance' }]} actions={<div className="flex gap-2"><Input type="date" value={day} onChange={(e) => setDay(e.target.value)} />{can('hrms.attendance.manage') && <><Button onClick={markAll}>Mark unmarked as present</Button><Button variant="primary" disabled={!Object.keys(edits).length} onClick={async () => {
          try { await api.put('/hrms/attendance', { day, entries: Object.entries(edits).map(([employee_id, e]) => ({ employee_id, status: e.status, in_time: e.in_time || null, out_time: e.out_time || null })) }); setEdits({}); invalidatePrefix(qc, 'hr-'); toast({ tone: 'success', title: 'Attendance saved' }); } catch (e) { toast({ tone: 'error', title: 'Not saved', body: errMsg(e) }); }
        }}>Save {Object.keys(edits).length || ''}</Button></>}</div>} />
      {q.data?.holiday && <div className="mb-4"><Notice tone="info">Holiday: {q.data.holiday.name}. Offices that observe it are marked holiday; the others work as usual. <Link className="link" to="/hr/holidays">Holiday calendar</Link></Notice></div>}
      <div className="mb-3 flex flex-wrap gap-3 text-[12.5px]">{Object.entries(counts).map(([k, n]) => <Badge key={k} tone={k === 'unmarked' ? 'warning' : 'neutral'}>{humanize(k)}: {n}</Badge>)}</div>
      <Card padded={false}>
        {!q.data ? <Skeleton className="m-5 h-40" /> : <SimpleTable rows={rows} rowKey={(r) => r.employee_id} columns={[
          { key: 'n', header: 'Employee', render: (r) => <div><p className="font-medium">{r.name}</p><p className="text-[12px] text-slate-500">{r.code} · {r.location} · {r.shift ?? '—'}{r.is_weekly_off ? ' · weekly off' : ''}{r.holiday ? ` · ${r.holiday}` : ''}</p></div> },
          { key: 's', header: 'Status', render: (r) => { const e = edits[r.employee_id]; const val = e?.status ?? r.status ?? ''; return r.status === 'leave' ? <Badge tone="violet">On leave</Badge> : <Select className="w-36" disabled={!can('hrms.attendance.manage')} value={val} onChange={(x) => setEdits({ ...edits, [r.employee_id]: { status: x.target.value, in_time: e?.in_time ?? r.in_time?.slice(0, 5) ?? '', out_time: e?.out_time ?? r.out_time?.slice(0, 5) ?? '' } })} placeholder="Not marked" options={['present', 'half_day', 'absent', 'weekly_off', 'holiday'].map((s) => ({ value: s, label: humanize(s) }))} />; } },
          { key: 'i', header: 'In', render: (r) => { const e = edits[r.employee_id]; return e ? <Input className="w-28" type="time" value={e.in_time} onChange={(x) => setEdits({ ...edits, [r.employee_id]: { ...e, in_time: x.target.value } })} /> : (r.in_time?.slice(0, 5) ?? '—'); } },
          { key: 'o', header: 'Out', render: (r) => { const e = edits[r.employee_id]; return e ? <Input className="w-28" type="time" value={e.out_time} onChange={(x) => setEdits({ ...edits, [r.employee_id]: { ...e, out_time: x.target.value } })} /> : (r.out_time?.slice(0, 5) ?? '—'); } },
          { key: 'l', header: 'Late', align: 'right', render: (r) => (r.late_minutes ? <span className="text-amber-700">{r.late_minutes} min</span> : '—') },
          { key: 'v', header: 'Overtime', align: 'right', render: (r) => (r.overtime_minutes ? `${Math.round(r.overtime_minutes / 6) / 10} h` : '—') },
          { key: 'x', header: 'Source', render: (r) => (r.source ? <span className="text-[12px] text-slate-500">{r.source}</span> : '') },
        ]} />}
      </Card>
    </>
  );
}

// ---------------------------------------------------------------- leave
interface LRow { id: string; number: string; employee_name: string; employee_code: string; department: string; leave_type: string; from_date: string; to_date: string; days: number; reason: string; status: string; applied_by_name: string; decided_by_name: string | null; created_at: string }
export function LeavePage() {
  const [status, setStatus] = useState('pending');
  const q = useQuery({ queryKey: ['hr-leave', status], queryFn: () => api.get<LRow[]>(`/hrms/leave?status=${status}`) });
  return (
    <>
      <PageHeader title="Leave" description="Requests are approved in Approvals by someone other than the applicant. Approval marks the days, uses the balance or comp-off, and tells CRM so leads are not allocated to people on leave." breadcrumbs={[{ label: 'HR & payroll', to: '/hr' }, { label: 'Leave' }]} actions={<Link to="/approvals"><Button>Open approvals</Button></Link>} />
      <div className="mb-4"><Segmented value={status} onChange={setStatus} options={[{ value: 'pending', label: 'Waiting' }, { value: 'approved', label: 'Approved' }, { value: 'rejected,cancelled', label: 'Rejected / cancelled' }]} /></div>
      <Card padded={false}>{!q.data ? <Skeleton className="m-5 h-40" /> : <SimpleTable rows={q.data} rowKey={(l) => l.id} empty={<EmptyState icon={<CalendarCheck className="size-5" />} title="No leave here" />} columns={[
        { key: 'e', header: 'Employee', render: (l) => <div><p className="font-medium">{l.employee_name}</p><p className="text-[12px] text-slate-500">{l.number} · {l.department}</p></div> },
        { key: 't', header: 'Type', render: (l) => <Badge>{l.leave_type}</Badge> },
        { key: 'd', header: 'Dates', render: (l) => `${fmtDate(l.from_date)} – ${fmtDate(l.to_date)}` },
        { key: 'n', header: 'Days', align: 'right', render: (l) => l.days },
        { key: 'r', header: 'Reason', render: (l) => <span className="text-[12.5px]">{l.reason}</span> },
        { key: 's', header: 'Status', render: (l) => <div><StatusBadge status={l.status} />{l.decided_by_name && <p className="text-[11.5px] text-slate-500">{l.decided_by_name}</p>}</div> },
      ]} />}</Card>
    </>
  );
}

// ---------------------------------------------------------------- recruitment
interface Opening { id: string; title: string; department: string; location: string; positions: number; status: string; candidates: { id: string; name: string; phone: string | null; source: string | null; stage: string; notes: string | null }[] | null }
const STAGES = ['applied', 'screening', 'interview', 'offer', 'hired', 'rejected'];
export function RecruitmentPage() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['hr-openings'], queryFn: () => api.get<Opening[]>('/hrms/openings') });
  const [newOpening, setNewOpening] = useState(false);
  const [ov, setOv] = useState({ title: '', department: 'Warehouse', location: 'Surat', positions: '1' });
  const [cand, setCand] = useState<string | null>(null);
  const [cv, setCv] = useState({ name: '', phone: '', source: '' });
  return (
    <>
      <PageHeader title="Recruitment" description="Openings and candidates. When someone is hired, add them as an employee to start onboarding." breadcrumbs={[{ label: 'HR & payroll', to: '/hr' }, { label: 'Recruitment' }]} actions={can('hrms.employee.manage') && <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setNewOpening(true)}>New opening</Button>} />
      {!q.data ? <Skeleton className="h-60" /> : q.data.length === 0 ? <EmptyState icon={<Briefcase className="size-5" />} title="No openings" /> : (
        <div className="space-y-4">{q.data.map((o) => (
          <Card key={o.id} title={`${o.title} · ${o.location}`} description={`${o.department} · ${o.positions} position(s)`} actions={<div className="flex items-center gap-2"><StatusBadge status={o.status} />{can('hrms.employee.manage') && <Button size="sm" onClick={() => setCand(o.id)}>Add candidate</Button>}</div>}>
            <div className="grid grid-cols-2 gap-2 md:grid-cols-6">{STAGES.map((st) => (
              <div key={st} className="min-h-24 rounded-lg bg-slate-50 p-2 ring-1 ring-slate-200"><p className="mb-1.5 text-[11.5px] font-semibold tracking-wide text-slate-500 uppercase">{humanize(st)}</p>
                {(o.candidates ?? []).filter((c) => c.stage === st).map((c) => <div key={c.id} className="mb-1.5 rounded-md bg-white p-2 text-[12.5px] ring-1 ring-slate-200"><p className="font-medium">{c.name}</p><p className="text-[11.5px] text-slate-500">{c.source ?? ''}</p>
                  {can('hrms.employee.manage') && !['hired', 'rejected'].includes(st) && <div className="mt-1 flex gap-1"><button className="link text-[11.5px]" onClick={async () => { await api.post(`/hrms/candidates/${c.id}/stage`, { stage: STAGES[STAGES.indexOf(st) + 1] }); invalidatePrefix(qc, 'hr-'); }}>Move on</button><button className="text-[11.5px] text-rose-600" onClick={async () => { await api.post(`/hrms/candidates/${c.id}/stage`, { stage: 'rejected' }); invalidatePrefix(qc, 'hr-'); }}>Reject</button></div>}</div>)}
              </div>))}</div>
          </Card>))}</div>
      )}
      <Modal open={newOpening} onClose={() => setNewOpening(false)} title="New opening" footer={<><Button onClick={() => setNewOpening(false)}>Cancel</Button><Button variant="primary" onClick={async () => { await api.post('/hrms/openings', { ...ov, positions: Number(ov.positions) }); setNewOpening(false); invalidatePrefix(qc, 'hr-'); }}>Create</Button></>}>
        <div className="grid grid-cols-2 gap-3"><Input className="col-span-2" label="Role" value={ov.title} onChange={(e) => setOv({ ...ov, title: e.target.value })} /><Input label="Department" value={ov.department} onChange={(e) => setOv({ ...ov, department: e.target.value })} /><Input label="Location" value={ov.location} onChange={(e) => setOv({ ...ov, location: e.target.value })} /><Input label="Positions" type="number" value={ov.positions} onChange={(e) => setOv({ ...ov, positions: e.target.value })} /></div>
      </Modal>
      <Modal open={!!cand} onClose={() => setCand(null)} title="Add candidate" footer={<><Button onClick={() => setCand(null)}>Cancel</Button><Button variant="primary" onClick={async () => { await api.post(`/hrms/openings/${cand}/candidates`, { name: cv.name, phone: cv.phone || null, source: cv.source || null }); setCand(null); setCv({ name: '', phone: '', source: '' }); invalidatePrefix(qc, 'hr-'); }}>Add</Button></>}>
        <div className="space-y-3"><Input label="Name" value={cv.name} onChange={(e) => setCv({ ...cv, name: e.target.value })} /><Input label="Mobile" value={cv.phone} onChange={(e) => setCv({ ...cv, phone: e.target.value })} /><Input label="Source" value={cv.source} onChange={(e) => setCv({ ...cv, source: e.target.value })} placeholder="Referral, walk-in, job portal" /></div>
      </Modal>
    </>
  );
}

// ---------------------------------------------------------------- payroll
interface Run { id: string; month: string; status: string; employees: number; gross: number; deductions: number; net: number; employer_cost: number; prepared_by_name: string | null; approved_by_name: string | null; paid_on: string | null; totals?: Record<string, number> & { missing_structure?: string[] } }
interface Slip { id: string; employee_code: string; employee_name: string; designation: string; department: string; location: string; paid_days: number; lop_days: number; overtime_hours: number; earnings: Record<string, number>; gross: number; deductions: Record<string, number>; total_deductions: number; employer: Record<string, number>; net: number }
export function PayrollPage() {
  const nav = useNavigate();
  const q = useQuery({ queryKey: ['hr-payroll'], queryFn: () => api.get<Run[]>('/hrms/payroll') });
  const [month, setMonth] = useState(new Date(Date.now() - 20 * 86_400_000).toISOString().slice(0, 7));
  return (
    <>
      <PageHeader title="Payroll" description="Monthly payroll from attendance and salary structures, with PF, ESIC, professional tax and salary TDS. A second person approves; accounts are posted automatically, and salaries are paid with a bank upload file."
        breadcrumbs={[{ label: 'HR & payroll', to: '/hr' }, { label: 'Payroll' }]} actions={<div className="flex gap-2"><Input type="month" value={month} onChange={(e) => setMonth(e.target.value)} /><Button variant="primary" onClick={() => nav(`/hr/payroll/${month}`)}>Open month</Button></div>} />
      <Card padded={false}>{!q.data ? <Skeleton className="m-5 h-40" /> : <SimpleTable rows={q.data} rowKey={(r) => r.id} onRowClick={(r) => nav(`/hr/payroll/${r.month.slice(0, 7)}`)} empty={<EmptyState icon={<IndianRupee className="size-5" />} title="No payroll yet" />} columns={[
        { key: 'm', header: 'Month', render: (r) => new Date(`${r.month}T00:00:00`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' }) },
        { key: 'e', header: 'People', align: 'right', render: (r) => r.employees },
        { key: 'g', header: 'Gross', align: 'right', render: (r) => money(r.gross) },
        { key: 'd', header: 'Deductions', align: 'right', render: (r) => money(r.deductions) },
        { key: 'n', header: 'Net pay', align: 'right', render: (r) => <span className="font-semibold">{money(r.net)}</span> },
        { key: 'c', header: 'Cost to company', align: 'right', render: (r) => money(r.employer_cost) },
        { key: 's', header: 'Status', render: (r) => <div><StatusBadge status={r.status} />{r.paid_on && <p className="text-[11.5px] text-slate-500">paid {fmtDate(r.paid_on)}</p>}</div> },
      ]} />}</Card>
    </>
  );
}

export function PayrollRunPage() {
  const { month = '' } = useParams();
  const { can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['hr-run', month], queryFn: () => api.get<Run & { payslips: Slip[]; vouchers: { id: string; number: string; amount: number; voucher_type: string; status: string }[] }>(`/hrms/payroll/${month}`) });
  const [busy, setBusy] = useState(false);
  const [pay, setPay] = useState(false);
  const r = q.data;
  const act = async (path: string, body?: Record<string, unknown>) => { setBusy(true); try { const out = await api.post<{ bank_file?: string }>(`/hrms/payroll/${month}/${path}`, body); invalidatePrefix(qc, 'hr-'); return out; } catch (e) { toast({ tone: 'error', title: 'Not done', body: errMsg(e) }); return null; } finally { setBusy(false); } };
  if (!r) return <Skeleton className="h-96" />;
  const label = new Date(`${month}-01T00:00:00`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
  const sum = (k: string, from: 'deductions' | 'employer') => r.payslips.reduce((s, p) => s + (p[from][k] ?? 0), 0);
  return (
    <>
      <PageHeader title={`Payroll · ${label}`} meta={<StatusBadge status={r.status} />} breadcrumbs={[{ label: 'HR & payroll', to: '/hr' }, { label: 'Payroll', to: '/hr/payroll' }, { label }]}
        actions={can('hrms.payroll.manage') && <div className="flex gap-2">
          {['not_prepared', 'draft'].includes(r.status) && <Button loading={busy} onClick={() => void act('prepare')}>{r.status === 'draft' ? 'Recalculate' : 'Prepare payroll'}</Button>}
          {r.status === 'draft' && <Button variant="primary" loading={busy} onClick={async () => { if (await act('submit')) toast({ tone: 'success', title: 'Sent for approval' }); }}>Submit for approval</Button>}
          {r.status === 'approved' && <Button variant="primary" onClick={() => setPay(true)}>Pay salaries</Button>}
        </div>} />
      {r.status === 'pending_approval' && <div className="mb-4"><Notice tone="warning" title="Waiting for approval">A second person approves in Approvals; then accounts book the cost and liabilities.</Notice></div>}
      {r.totals?.missing_structure?.length ? <div className="mb-4"><Notice tone="warning">No salary structure for {r.totals.missing_structure.join(', ')} — they are not in this run.</Notice></div> : null}
      {r.status !== 'not_prepared' && (
        <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-6">
          <Stat label="Gross" value={money(r.gross)} /><Stat label="Net pay" value={money(r.net)} /><Stat label="PF (employee + employer)" value={money(sum('pf', 'deductions') + sum('epf', 'employer') + sum('eps', 'employer'))} />
          <Stat label="ESIC (employee + employer)" value={money(sum('esic', 'deductions') + sum('esic', 'employer'))} /><Stat label="Professional tax" value={money(sum('professional_tax', 'deductions'))} /><Stat label="Salary TDS" value={money(sum('income_tax', 'deductions'))} />
        </div>
      )}
      {r.vouchers.length > 0 && <div className="mb-4"><Notice tone="success" title="Posted in accounts">{r.vouchers.map((v) => <Link key={v.id} className="link mr-3" to={`/finance/vouchers/${v.id}`}>{v.number} ({humanize(v.voucher_type)}, {fmtINR(v.amount)})</Link>)}</Notice></div>}
      <Card padded={false}>{r.status === 'not_prepared' ? <EmptyState icon={<Clock className="size-5" />} title="Not prepared yet" description="Preparing reads attendance and salary structures for the month. You can recalculate until it is submitted." /> : <SimpleTable rows={r.payslips} rowKey={(p) => p.id} columns={[
        { key: 'e', header: 'Employee', render: (p) => <div><Link className="link font-medium" to={`/hr/payslips/${p.id}`}>{p.employee_name}</Link><p className="text-[12px] text-slate-500">{p.employee_code} · {p.designation}</p></div> },
        { key: 'd', header: 'Paid days', align: 'right', render: (p) => <span>{p.paid_days}{p.lop_days ? <span className="text-rose-600"> (−{p.lop_days})</span> : ''}</span> },
        { key: 'g', header: 'Gross', align: 'right', render: (p) => money(p.gross) },
        { key: 'pf', header: 'PF', align: 'right', render: (p) => money(p.deductions.pf) },
        { key: 'es', header: 'ESIC', align: 'right', render: (p) => money(p.deductions.esic) },
        { key: 'pt', header: 'PT', align: 'right', render: (p) => money(p.deductions.professional_tax) },
        { key: 'it', header: 'TDS', align: 'right', render: (p) => money(p.deductions.income_tax) },
        { key: 'n', header: 'Net', align: 'right', render: (p) => <span className="font-semibold">{money(p.net)}</span> },
      ]} />}</Card>
      <ConfirmDialog open={pay} onClose={() => setPay(false)} title={`Pay ${label} salaries?`} description={`${money(r.net)} to ${r.employees} people. A bank upload file is downloaded and the payment is posted from the main bank account.`} confirmLabel="Mark paid and download file" loading={busy}
        onConfirm={async () => { const out = await act('pay', { paid_on: new Date().toISOString().slice(0, 10) }); if (out?.bank_file) { const url = URL.createObjectURL(new Blob([out.bank_file], { type: 'text/csv' })); const a = document.createElement('a'); a.href = url; a.download = `salary-${month}.csv`; a.click(); URL.revokeObjectURL(url); } setPay(false); }} />
    </>
  );
}

interface FullSlip extends Slip { month: string; run_status: string; pan: string | null; uan: string | null; bank_account: string | null; days_in_month: number; company: { legal_name: string; registered_address: string | null } | null }
export function PayslipPage() {
  const { id = '' } = useParams();
  const q = useQuery({ queryKey: ['hr-slip', id], queryFn: () => api.get<FullSlip>(`/hrms/payslips/${id}`) });
  const p = q.data;
  if (q.isError) return <ErrorState error={q.error} />;
  if (!p) return <Skeleton className="h-96" />;
  const rows = (o: Record<string, number>) => Object.entries(o).filter(([, v]) => v);
  return (
    <>
      <div className="mb-4 flex justify-end print:hidden"><Button icon={<Download className="size-4" />} onClick={() => window.print()}>Print / save PDF</Button></div>
      <div className="mx-auto max-w-3xl rounded-xl bg-white p-8 ring-1 ring-slate-200 print:ring-0">
        <div className="flex justify-between border-b border-slate-200 pb-4"><div><p className="text-[18px] font-semibold">{p.company?.legal_name}</p><p className="text-[12.5px] text-slate-500">{p.company?.registered_address}</p></div><div className="text-right"><p className="font-semibold">Payslip</p><p className="text-[13px]">{new Date(`${p.month}T00:00:00`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' })}</p></div></div>
        <div className="my-4 grid grid-cols-2 gap-x-8 gap-y-1 text-[13px]">
          {[['Employee', `${p.employee_name} (${p.employee_code})`], ['Designation', p.designation], ['Department', p.department], ['Location', p.location], ['PAN', p.pan ?? '—'], ['UAN', p.uan ?? '—'], ['Days paid', `${p.paid_days} of ${p.days_in_month}`], ['Loss of pay', `${p.lop_days} days`], ['Bank account', p.bank_account ? `••••${p.bank_account.slice(-4)}` : '—']].map(([k, v]) => <div key={k} className="flex justify-between"><span className="text-slate-500">{k}</span><span>{v}</span></div>)}
        </div>
        <div className="grid grid-cols-2 gap-6 text-[13px]">
          <table className="w-full"><thead><tr className="border-b border-slate-200 text-left text-[11.5px] text-slate-500 uppercase"><th className="py-1">Earnings</th><th className="py-1 text-right">₹</th></tr></thead><tbody>{rows(p.earnings).map(([k, v]) => <tr key={k}><td className="py-1">{k === 'hra' ? 'HRA' : humanize(k)}</td><td className="py-1 text-right tabular">{v.toLocaleString('en-IN')}</td></tr>)}<tr className="border-t border-slate-200 font-semibold"><td className="py-1">Gross</td><td className="py-1 text-right tabular">{p.gross.toLocaleString('en-IN')}</td></tr></tbody></table>
          <table className="w-full"><thead><tr className="border-b border-slate-200 text-left text-[11.5px] text-slate-500 uppercase"><th className="py-1">Deductions</th><th className="py-1 text-right">₹</th></tr></thead><tbody>{rows(p.deductions).map(([k, v]) => <tr key={k}><td className="py-1">{k === 'pf' ? 'Provident fund' : k === 'esic' ? 'ESIC' : k === 'income_tax' ? 'Income tax (TDS)' : humanize(k)}</td><td className="py-1 text-right tabular">{v.toLocaleString('en-IN')}</td></tr>)}<tr className="border-t border-slate-200 font-semibold"><td className="py-1">Total</td><td className="py-1 text-right tabular">{p.total_deductions.toLocaleString('en-IN')}</td></tr></tbody></table>
        </div>
        <div className="mt-6 flex justify-between rounded-lg bg-slate-50 p-4 text-[15px] font-semibold"><span>Net pay</span><span>{money(p.net)}</span></div>
        <p className="mt-4 text-[11.5px] text-slate-500">Employer contributions (not deducted): PF {money((p.employer.epf ?? 0) + (p.employer.eps ?? 0))}, ESIC {money(p.employer.esic)}. Computer-generated payslip.</p>
      </div>
    </>
  );
}

/** Waiting leave can always be withdrawn; approved leave only before it starts (after that, attendance is corrected instead). */
const cancellable = (l: { status: string; from_date: string }) => l.status === 'pending' || (l.status === 'approved' && l.from_date > new Date().toISOString().slice(0, 10));
function CancelLeaveDialog({ id, onClose }: { id: string | null; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  return <ConfirmDialog open={!!id} onClose={onClose} title="Cancel this leave?" description="Approved days are released back to the balance (or comp-off) and the attendance marks are removed." requireReason confirmLabel="Cancel leave" tone="danger"
    onConfirm={async (reason) => { try { await api.post(`/hrms/leave/${id}/cancel`, { reason }); onClose(); invalidatePrefix(qc, 'hr-'); toast({ tone: 'success', title: 'Leave cancelled' }); } catch (e) { toast({ tone: 'error', title: 'Not cancelled', body: errMsg(e) }); } }} />;
}

// ---------------------------------------------------------------- self-service
interface Me { employee: { id: string; name: string; code: string; designation: string; department: string; location: string; pt_state: string } | null; attendance: { day: string; status: string; in_time: string | null; out_time: string | null; late_minutes: number; overtime_minutes: number }[]; balances: { leave_type: string; name: string; entitled: number; used: number }[]; leaves: { id: string; number: string; leave_type: string; from_date: string; to_date: string; days: number; status: string; reason: string }[]; payslips: { id: string; month: string; gross: number; net: number }[]; comp_off: { available: number }; leave_types: { code: string; name: string }[] }
export function MyHrPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['hr-me'], queryFn: () => api.get<Me>('/hrms/me') });
  const year = new Date().getFullYear();
  const hols = useQuery({ queryKey: ['hr-holidays-me', year], queryFn: async () => [...(await api.get<HolidayYear>(`/hrms/holidays?year=${year}`)).holidays, ...(await api.get<HolidayYear>(`/hrms/holidays?year=${year + 1}`)).holidays] });
  const [apply, setApply] = useState(false);
  const [cancelLeave, setCancelLeave] = useState<string | null>(null);
  const [lv, setLv] = useState({ leave_type: 'CL', from_date: '', to_date: '', half_day: false, reason: '' });
  const [err, setErr] = useState<string | null>(null);
  const d = q.data;
  const todayRec = d?.attendance?.find((a) => a.day === new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10));
  const punch = async (kind: 'in' | 'out') => {
    const pos = await new Promise<GeolocationPosition | null>((res) => (navigator.geolocation ? navigator.geolocation.getCurrentPosition(res, () => res(null), { timeout: 4000 }) : res(null)));
    try { const r = await api.post<{ time: string }>('/hrms/me/punch', { kind, lat: pos?.coords.latitude ?? null, lng: pos?.coords.longitude ?? null }); toast({ tone: 'success', title: `Checked ${kind} at ${r.time}` }); invalidatePrefix(qc, 'hr-'); } catch (e) { toast({ tone: 'error', title: 'Not recorded', body: errMsg(e) }); }
  };
  if (!d) return <Skeleton className="h-96" />;
  if (!d.employee) return <EmptyState title="No employee record is linked to your login" description="Ask HR to link your login to your employee record." />;
  return (
    <>
      <PageHeader title="My HR" description={`${d.employee.name} · ${d.employee.code} · ${d.employee.designation}, ${d.employee.department}`}
        actions={<div className="flex gap-2"><Button icon={<LogIn className="size-4" />} disabled={!!todayRec?.in_time} onClick={() => void punch('in')}>Check in</Button><Button icon={<LogOut className="size-4" />} disabled={!todayRec?.in_time || !!todayRec?.out_time} onClick={() => void punch('out')}>Check out</Button><Button variant="primary" onClick={() => setApply(true)}>Apply for leave</Button></div>} />
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-5">
        {d.balances.map((b) => <Stat key={b.leave_type} label={b.name} value={b.entitled - b.used} sub={`of ${b.entitled}`} />)}
        <Stat label="Comp-off" value={d.comp_off.available} />
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2"><AttendanceGrid rows={d.attendance} /></div>
        <div className="space-y-4">
          <Card title="My leave" padded={false}>{d.leaves.length ? <ul className="divide-y divide-slate-100 text-[13px]">{d.leaves.map((l) => <li key={l.id} className="flex items-center justify-between gap-2 px-4 py-2.5"><div><p>{l.leave_type} · {fmtDate(l.from_date)}{l.to_date !== l.from_date ? ` – ${fmtDate(l.to_date)}` : ''}</p><p className="text-[12px] text-slate-500">{l.days} day(s) · {l.reason}</p></div><div className="flex items-center gap-2"><StatusBadge status={l.status} />{cancellable(l) && <Button size="xs" variant="ghost" onClick={() => setCancelLeave(l.id)}>Cancel</Button>}</div></li>)}</ul> : <p className="p-4 text-[13px] text-slate-500">None yet.</p>}</Card>
          <Card title={`Holidays at ${d.employee.location}`} padded={false}>{(() => { const up = (hols.data ?? []).filter((h) => h.day >= new Date().toISOString().slice(0, 10) && (!h.state_code || h.state_code === d.employee!.pt_state)).slice(0, 6); return up.length ? <ul className="divide-y divide-slate-100 text-[13px]">{up.map((h) => <li key={h.day + h.name} className="flex justify-between px-4 py-2.5"><span>{h.name}</span><span className="text-slate-500">{fmtDate(h.day)} · {new Date(`${h.day}T00:00:00`).toLocaleDateString('en-IN', { weekday: 'short' })}</span></li>)}</ul> : <p className="p-4 text-[13px] text-slate-500">No more holidays listed this year.</p>; })()}</Card>
          <Card title="Payslips" padded={false}>{d.payslips.length ? <ul className="divide-y divide-slate-100 text-[13px]">{d.payslips.map((p) => <li key={p.id} className="flex justify-between px-4 py-2.5"><Link className="link" to={`/hr/payslips/${p.id}`}>{new Date(`${p.month}T00:00:00`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' })}</Link><span className="tabular">{money(p.net)}</span></li>)}</ul> : <p className="p-4 text-[13px] text-slate-500">No payslips yet.</p>}</Card>
        </div>
      </div>
      <CancelLeaveDialog id={cancelLeave} onClose={() => setCancelLeave(null)} />
      <Modal open={apply} onClose={() => setApply(false)} title="Apply for leave" description="Weekly offs and holidays inside the dates are not counted." footer={<><Button onClick={() => setApply(false)}>Cancel</Button><Button variant="primary" onClick={async () => { setErr(null); try { await api.post('/hrms/leave', lv); setApply(false); invalidatePrefix(qc, 'hr-'); toast({ tone: 'success', title: 'Sent for approval' }); } catch (e) { setErr(errMsg(e)); } }}>Apply</Button></>}>
        <div className="grid grid-cols-2 gap-3">
          {err && <div className="col-span-2"><Notice tone="danger">{err}</Notice></div>}
          <Select className="col-span-2" label="Type" value={lv.leave_type} onChange={(e) => setLv({ ...lv, leave_type: e.target.value })} options={d.leave_types.map((t) => ({ value: t.code, label: t.name }))} />
          <Input label="From" type="date" value={lv.from_date} onChange={(e) => setLv({ ...lv, from_date: e.target.value, to_date: lv.to_date || e.target.value })} />
          <Input label="To" type="date" value={lv.to_date} onChange={(e) => setLv({ ...lv, to_date: e.target.value })} />
          <Checkbox label="Half day" checked={lv.half_day} onChange={(e) => setLv({ ...lv, half_day: e.target.checked })} />
          <Textarea className="col-span-2" label="Reason" value={lv.reason} onChange={(e) => setLv({ ...lv, reason: e.target.value })} />
        </div>
      </Modal>
    </>
  );
}

// ---------------------------------------------------------------- salary register
interface SalRow { id: string; code: string; name: string; designation: string; department: string; location: string; status: string; date_of_joining: string; effective_from: string | null; basic: number | null; hra: number | null; conveyance: number | null; special: number | null; other: number | null; pf_applicable: boolean | null; gross: number | null;
  previous_from: string | null; previous_gross: number | null; next_from: string | null; next_gross: number | null; last_month: string | null; last_gross: number | null; last_net: number | null; last_paid_days: number | null; last_payslip_id: string | null;
  estimate: { deductions: number; net: number; employer: number; monthly_ctc: number; annual_ctc: number } | null }
/** Who is paid what: current structure, scheduled revisions, take-home and cost to company, and the latest payroll. */
export function SalaryRegisterPage() {
  const nav = useNavigate();
  const [status, setStatus] = useState('current');
  const [dept, setDept] = useState('');
  const q = useQuery({ queryKey: ['hr-salaries', status], queryFn: () => api.get<SalRow[]>(`/hrms/salary-register${status === 'all' ? '?status=all' : ''}`) });
  const all = q.data ?? [];
  const rows = dept ? all.filter((r) => r.department === dept) : all;
  const withPay = rows.filter((r) => r.gross != null);
  const total = (f: (r: SalRow) => number | null | undefined) => withPay.reduce((t, r) => t + (f(r) ?? 0), 0);
  const missing = rows.filter((r) => r.gross == null && r.status !== 'exited');
  const label = (m: string | null) => (m ? new Date(`${m}T00:00:00`).toLocaleDateString('en-IN', { month: 'short', year: 'numeric' }) : '—');
  return (
    <>
      <PageHeader title="Salary register" description="What each person is paid now: the salary structure in force, any revision scheduled, an estimate of a full month's deductions, take-home and cost to the company, and what the latest payroll actually paid. Revise a salary from the person's Salary tab."
        breadcrumbs={[{ label: 'HR & payroll', to: '/hr' }, { label: 'Salary register' }]} />
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Monthly gross" value={money(total((r) => r.gross))} sub={`${withPay.length} people`} />
        <Stat label="Monthly take-home (estimate)" value={money(total((r) => r.estimate?.net))} sub="full month, no loss of pay" />
        <Stat label="Monthly cost to company" value={money(total((r) => r.estimate?.monthly_ctc))} sub={`${money(total((r) => r.estimate?.annual_ctc))} a year`} />
        <Stat label="No salary structure" value={missing.length} sub={missing.length ? missing.map((r) => r.name).slice(0, 3).join(', ') : 'Everyone is set up'} tone={missing.length ? 'warning' : undefined} />
      </div>
      <div className="mb-4 flex flex-wrap gap-3">
        <Segmented value={status} onChange={setStatus} options={[{ value: 'current', label: 'Current staff' }, { value: 'all', label: 'Including people who left' }]} />
        <Select aria-label="Department" className="w-48" value={dept} onChange={(e) => setDept(e.target.value)} placeholder="All departments" options={[...new Set(all.map((r) => r.department))].sort().map((d) => ({ value: d, label: d }))} />
      </div>
      <Card padded={false}>{!q.data ? <Skeleton className="m-5 h-40" /> : <SimpleTable rows={rows} rowKey={(r) => r.id} pageSize={25} csvName="salary-register" onRowClick={(r) => nav(`/hr/employees/${r.id}`)} empty={<EmptyState icon={<IndianRupee className="size-5" />} title="Nobody here" />} columns={[
        { key: 'e', header: 'Employee', render: (r) => <div><p className="font-medium">{r.name}</p><p className="text-[12px] text-slate-500">{r.code} · {r.designation}</p></div> },
        { key: 'd', header: 'Department · location', render: (r) => <span className="text-[12.5px]">{r.department} · {r.location}</span> },
        { key: 'b', header: 'Basic', align: 'right', render: (r) => money(r.basic) },
        { key: 'h', header: 'HRA + allowances', align: 'right', render: (r) => (r.gross == null ? '—' : money(r.gross - (r.basic ?? 0))) },
        { key: 'g', header: 'Monthly gross', align: 'right', render: (r) => (r.gross == null ? <Badge tone="warning">Not set</Badge> : <div><p className="font-semibold">{money(r.gross)}</p><p className="text-[11.5px] text-slate-500">from {fmtDate(r.effective_from)}{r.previous_gross != null && r.gross !== r.previous_gross ? ` · was ${money(r.previous_gross)}` : ''}</p></div>) },
        { key: 'n', header: 'Take-home (est.)', align: 'right', render: (r) => (r.estimate ? <div><p>{money(r.estimate.net)}</p><p className="text-[11.5px] text-slate-500">after {money(r.estimate.deductions)}</p></div> : '—') },
        { key: 'c', header: 'Annual CTC', align: 'right', render: (r) => (r.estimate ? money(r.estimate.annual_ctc) : '—') },
        { key: 'x', header: 'Next revision', render: (r) => (r.next_from ? <span className="text-[12.5px]">{money(r.next_gross)} from {fmtDate(r.next_from)}</span> : <span className="text-[12px] text-slate-400">none</span>) },
        { key: 'l', header: 'Last payroll', align: 'right', render: (r) => (r.last_payslip_id ? <div><Link className="link" to={`/hr/payslips/${r.last_payslip_id}`} onClick={(ev) => ev.stopPropagation()}>{money(r.last_net)}</Link><p className="text-[11.5px] text-slate-500">{label(r.last_month)} · {r.last_paid_days} days</p></div> : '—') },
      ]} />}</Card>
    </>
  );
}

// ---------------------------------------------------------------- holiday calendar
interface Holiday { day: string; name: string; state_code: string | null; state: string | null; offices: string[] }
interface HolidayYear { year: number; offices: { office: string; state_code: string; state: string }[]; holidays: Holiday[] }
/** The organisation's holiday list by year and office. Payroll, leave and attendance use it for each office's state. */
export function HolidaysPage() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const [year, setYear] = useState(new Date().getFullYear());
  const [office, setOffice] = useState('');
  const q = useQuery({ queryKey: ['hr-holidays', year], queryFn: () => api.get<HolidayYear>(`/hrms/holidays?year=${year}`) });
  const [adding, setAdding] = useState(false);
  const [v, setV] = useState({ day: '', name: '', state_code: '' });
  const [removing, setRemoving] = useState<Holiday | null>(null);
  const [reason, setReason] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const rows = (q.data?.holidays ?? []).filter((h) => !office || h.offices.includes(office));
  const todayIso = new Date().toISOString().slice(0, 10);
  const manage = can('hrms.attendance.manage');
  const refresh = () => invalidatePrefix(qc, 'hr-');
  return (
    <>
      <PageHeader title="Holiday calendar" description="Paid holidays for each office. National holidays apply everywhere; state holidays only to the office in that state. Attendance, leave (holidays inside leave are not counted) and payroll all read this list."
        breadcrumbs={[{ label: 'HR & payroll', to: '/hr' }, { label: 'Holidays' }]} actions={manage && <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => { setErr(null); setV({ day: '', name: '', state_code: '' }); setAdding(true); }}>Add holiday</Button>} />
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Segmented value={String(year)} onChange={(x) => setYear(Number(x))} options={[year - 1, year, year + 1].filter((y, i, a) => a.indexOf(y) === i).map((y) => ({ value: String(y), label: String(y) }))} />
        <Select aria-label="Office" className="w-56" value={office} onChange={(e) => setOffice(e.target.value)} placeholder="All offices" options={(q.data?.offices ?? []).map((o) => ({ value: o.office, label: `${o.office} (${o.state})` }))} />
      </div>
      {q.data && <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">{q.data.offices.map((o) => <Stat key={o.office} label={`${o.office} · ${o.state}`} value={q.data!.holidays.filter((h) => h.offices.includes(o.office)).length} sub={`holidays in ${year}`} />)}</div>}
      <Card padded={false}>{!q.data ? <Skeleton className="m-5 h-40" /> : <SimpleTable rows={rows} rowKey={(h) => h.day + h.name} csvName={`holidays-${year}`} empty={<EmptyState icon={<CalendarDays className="size-5" />} title={`No holidays listed for ${year}`} description={manage ? 'Add each holiday with the office it applies to.' : undefined} />} columns={[
        { key: 'd', header: 'Date', render: (h) => <span className={clsx(h.day < todayIso && 'text-slate-400')}>{fmtDate(h.day)}</span> },
        { key: 'w', header: 'Day', render: (h) => DAYS[new Date(`${h.day}T00:00:00`).getDay()] },
        { key: 'n', header: 'Holiday', render: (h) => <span className="font-medium">{h.name}</span> },
        { key: 's', header: 'Applies to', render: (h) => (h.state ? <span><Badge tone="info">{h.state}</Badge> <span className="text-[12.5px] text-slate-500">{h.offices.join(', ') || 'no office in this state'}</span></span> : <Badge>All offices</Badge>) },
        ...(manage ? [{ key: 'x', header: '', render: (h: Holiday) => <Button size="xs" variant="ghost" onClick={() => { setErr(null); setReason(''); setRemoving(h); }}>Remove</Button> }] : []),
      ]} />}</Card>
      <Modal open={adding} onClose={() => setAdding(false)} title="Add holiday" description="Days already marked for this date keep their mark; unmarked days become a holiday for the offices it applies to." footer={<><Button onClick={() => setAdding(false)}>Cancel</Button><Button variant="primary" onClick={async () => {
        setErr(null);
        try { await api.post('/hrms/holidays', { day: v.day, name: v.name, state_code: v.state_code || null }); setAdding(false); refresh(); toast({ tone: 'success', title: 'Holiday added' }); } catch (e) { setErr(errMsg(e)); }
      }}>Add</Button></>}>
        <div className="grid grid-cols-2 gap-3">
          {err && <div className="col-span-2"><Notice tone="danger">{err}</Notice></div>}
          <Input label="Date" type="date" value={v.day} onChange={(e) => setV({ ...v, day: e.target.value })} />
          <Select label="Applies to" value={v.state_code} onChange={(e) => setV({ ...v, state_code: e.target.value })} options={[{ value: '', label: 'All offices (national)' }, ...(q.data?.offices ?? []).map((o) => ({ value: o.state_code, label: `${o.state} only (${o.office})` }))]} />
          <Input className="col-span-2" label="Name" value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} placeholder="e.g. Raksha Bandhan" />
        </div>
      </Modal>
      <Modal open={!!removing} onClose={() => setRemoving(null)} title={`Remove ${removing?.name ?? ''}?`} description="Days marked as this holiday go back to unmarked so attendance can be taken. Not possible once that month's payroll is submitted." footer={<><Button onClick={() => setRemoving(null)}>Cancel</Button><Button variant="danger" onClick={async () => {
        setErr(null);
        try { await api.post('/hrms/holidays/remove', { day: removing!.day, name: removing!.name, reason }); setRemoving(null); refresh(); toast({ tone: 'success', title: 'Holiday removed' }); } catch (e) { setErr(errMsg(e)); }
      }}>Remove</Button></>}>
        <div className="space-y-3">{err && <Notice tone="danger">{err}</Notice>}<Textarea label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} /></div>
      </Modal>
    </>
  );
}

/** HR sets the shift and, where needed, the employee's own hours. Sales leads go only to people inside their hours. */
function HoursCard({ e, onDone }: { e: { id: string; shift_code: string | null; work_start: string | null; work_end: string | null; user_id: string | null }; onDone: () => void }) {
  const toast = useToast();
  const [v, setV] = useState({ shift_code: e.shift_code ?? 'GEN', own: !!e.work_start, work_start: e.work_start?.slice(0, 5) ?? '09:30', work_end: e.work_end?.slice(0, 5) ?? '18:30' });
  return (
    <Card title="Working hours" description={e.user_id ? 'Also used by Sales: new leads reach this person only inside these hours.' : 'Shift for attendance, lateness and overtime.'}>
      <div className="space-y-3">
        <Select label="Shift" value={v.shift_code} onChange={(x) => setV({ ...v, shift_code: x.target.value })} options={[{ value: 'GEN', label: 'General 9:30–18:30' }, { value: 'WH1', label: 'Warehouse 8:00–16:30' }, { value: 'WH2', label: 'Warehouse 14:00–22:30' }]} />
        <label className="flex items-center gap-2 text-[13px]"><input type="checkbox" checked={v.own} onChange={(x) => setV({ ...v, own: x.target.checked })} />Own hours for this employee</label>
        {v.own && <div className="grid grid-cols-2 gap-3"><Input label="From" type="time" value={v.work_start} onChange={(x) => setV({ ...v, work_start: x.target.value })} /><Input label="To" type="time" value={v.work_end} onChange={(x) => setV({ ...v, work_end: x.target.value })} /></div>}
        <Button variant="primary" onClick={async () => {
          try { await api.put(`/hrms/employees/${e.id}/hours`, { shift_code: v.shift_code, work_start: v.own ? v.work_start : null, work_end: v.own ? v.work_end : null }); toast({ tone: 'success', title: 'Working hours saved' }); onDone(); } catch (err) { toast({ tone: 'error', title: (err as Error).message }); }
        }}>Save hours</Button>
      </div>
    </Card>
  );
}
