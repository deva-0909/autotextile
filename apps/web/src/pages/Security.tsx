import { useQuery, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { AlertTriangle, CheckCircle2, KeyRound, Lock, LogOut, Plus, ShieldCheck, Smartphone, Unlock, XCircle } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, invalidatePrefix } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fmtDateTime, fmtRelative, humanize } from '../lib/format';
import { DataTable, FilterSelect } from '../components/DataTable';
import { useForm } from '../components/form';
import { ConfirmDialog, Drawer, Modal, useToast } from '../components/overlay';
import { Avatar, Badge, Button, Card, Checkbox, Input, Notice, PageHeader, Select, Skeleton, StatusBadge, Tabs, Textarea } from '../components/ui';
import { PasswordRules } from './Login';

interface Role { id: string; code: string; name: string; description: string | null; is_system: boolean; user_count: number; permissions: { code: string; limit: number | null }[] }
interface Permission { code: string; module: string; label: string; sensitive?: boolean }
interface UserRow { id: string; email: string; name: string; phone: string | null; employee_code: string | null; designation: string | null; status: string; mfa_enabled: boolean; must_change_password: boolean; last_login_at: string | null; locked_until: string | null; roles: { code: string; name: string }[] }
type Scope = Record<'entity' | 'gstin' | 'branch' | 'warehouse', '*' | string[]>;
interface UserDetail extends Omit<UserRow, 'roles'> { roles: { id: string; code: string; name: string }[]; scope: Scope; failed_attempts: number; created_at: string }
interface Structure { entities: { id: string; legal_name: string }[]; gstRegistrations: { id: string; gstin: string; state_name: string }[]; branches: { id: string; name: string }[]; warehouses: { id: string; code: string; name: string }[] }

const isLocked = (u: { locked_until: string | null }) => !!u.locked_until && new Date(u.locked_until) > new Date();

export function UsersPage() {
  const { can } = useAuth();
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [open, setOpen] = useState<string | 'new' | null>(null);
  const roles = useQuery({ queryKey: ['roles'], queryFn: () => api.get<Role[]>('/identity/roles') });
  return (
    <>
      <PageHeader
        title="Users"
        description="Each user gets one or more roles (what they can do) and a data scope (which entities, GSTINs, branches and warehouses they can see)."
        breadcrumbs={[{ label: 'Security' }, { label: 'Users' }]}
        actions={can('identity.user.manage') && <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setOpen('new')}>Invite user</Button>}
      />
      <DataTable<UserRow>
        id="users"
        endpoint="/identity/users"
        filters={filters}
        onFiltersChange={setFilters}
        defaultSort={{ key: 'name', dir: 'asc' }}
        searchPlaceholder="Search name, email, employee code…"
        onRowClick={(r) => setOpen(r.id)}
        toolbar={<>
          <FilterSelect placeholder="All roles" value={filters.role} onChange={(v) => setFilters({ ...filters, role: v })} options={roles.data?.map((r) => ({ value: r.code, label: r.name })) ?? []} />
          <FilterSelect placeholder="All statuses" value={filters.status} onChange={(v) => setFilters({ ...filters, status: v })} options={[{ value: 'active', label: 'Active' }, { value: 'inactive', label: 'Inactive' }]} />
        </>}
        columns={[
          { key: 'name', header: 'User', sort: 'name', csv: (r) => r.name, render: (r) => (
            <div className="flex items-center gap-3">
              <Avatar name={r.name} />
              <div><p className="font-medium text-slate-900">{r.name}</p><p className="text-[12px] text-slate-500">{r.email}</p></div>
            </div>
          ) },
          { key: 'designation', header: 'Designation', csv: (r) => r.designation, render: (r) => r.designation ?? '—' },
          { key: 'roles', header: 'Roles', csv: (r) => r.roles.map((x) => x.name).join('; '), render: (r) => <div className="flex flex-wrap gap-1">{r.roles.map((x) => <Badge key={x.code} tone="brand">{x.name}</Badge>)}{!r.roles.length && <span className="text-slate-400">No role</span>}</div> },
          { key: 'mfa', header: 'MFA', csv: (r) => (r.mfa_enabled ? 'on' : 'off'), render: (r) => (r.mfa_enabled ? <Badge tone="success">On</Badge> : <Badge tone="warning">Off</Badge>) },
          { key: 'last', header: 'Last sign-in', sort: 'last_login_at', csv: (r) => r.last_login_at, render: (r) => <span className="text-[12.5px]">{fmtRelative(r.last_login_at)}</span> },
          { key: 'status', header: 'Status', sort: 'status', csv: (r) => r.status, render: (r) => isLocked(r) ? <Badge tone="danger" dot>Locked</Badge> : <StatusBadge status={r.status} /> },
        ]}
      />
      {open && <UserDrawer userId={open === 'new' ? undefined : open} roles={roles.data ?? []} onClose={() => setOpen(null)} />}
    </>
  );
}

function ScopePicker({ label, value, onChange, options }: { label: string; value: '*' | string[]; onChange: (v: '*' | string[]) => void; options: { value: string; label: string }[] }) {
  const all = value === '*';
  return (
    <div className="rounded-lg border border-slate-200 p-3.5">
      <div className="flex items-center justify-between">
        <p className="text-[13px] font-medium text-slate-900">{label}</p>
        <label className="flex items-center gap-2 text-[12.5px] text-slate-600">
          <input type="checkbox" className="accent-brand-600" checked={all} onChange={(e) => onChange(e.target.checked ? '*' : [])} />
          All, including future ones
        </label>
      </div>
      {!all && (
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          {options.map((o) => {
            const on = (value as string[]).includes(o.value);
            return (
              <button type="button" key={o.value} onClick={() => onChange(on ? (value as string[]).filter((x) => x !== o.value) : [...(value as string[]), o.value])}
                className={clsx('rounded-md border px-2.5 py-1 text-[12.5px] transition', on ? 'border-brand-500 bg-brand-50 text-brand-700' : 'border-slate-300 bg-white text-slate-600 hover:border-slate-400')}>
                {o.label}
              </button>
            );
          })}
          {(value as string[]).length === 0 && <p className="w-full text-[12px] text-amber-700">Nothing selected — the user will see no {label.toLowerCase()}.</p>}
        </div>
      )}
    </div>
  );
}

function UserDrawer({ userId, roles, onClose }: { userId?: string; roles: Role[]; onClose: () => void }) {
  const { can, user: me } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const manage = can('identity.user.manage');
  const u = useQuery({ queryKey: ['user', userId], queryFn: () => api.get<UserDetail>(`/identity/users/${userId}`), enabled: !!userId });
  const structure = useQuery({ queryKey: ['structure'], queryFn: () => api.get<Structure>('/organisation/structure') });
  const sessions = useQuery({ queryKey: ['sessions', userId], queryFn: () => api.get<{ id: string; ip: string; user_agent: string; created_at: string; last_used_at: string }[]>(`/identity/sessions?userId=${userId}`), enabled: !!userId && can('identity.session.read') });
  const [tab, setTab] = useState<'profile' | 'access' | 'security'>('profile');
  const f = useForm({ email: '', name: '', phone: '', employee_code: '', designation: '', status: 'active', password: '' });
  const [roleIds, setRoleIds] = useState<string[]>([]);
  const [scope, setScope] = useState<Scope>({ entity: '*', gstin: '*', branch: '*', warehouse: '*' });
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [resetPw, setResetPw] = useState(false);
  const [tempPw, setTempPw] = useState('');
  const [mfaReset, setMfaReset] = useState(false);

  useEffect(() => {
    const d = u.data;
    if (!d) return;
    f.setValues({ email: d.email, name: d.name, phone: d.phone ?? '', employee_code: d.employee_code ?? '', designation: d.designation ?? '', status: d.status, password: '' });
    setRoleIds(d.roles.map((r) => r.id));
    setScope(d.scope);
  }, [u.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const refresh = () => { invalidatePrefix(qc, '/identity/users'); qc.invalidateQueries({ queryKey: ['user', userId] }); };

  async function save() {
    setSaving(true);
    try {
      const profile = { email: f.values.email, name: f.values.name, phone: f.values.phone || null, employee_code: f.values.employee_code || null, designation: f.values.designation || null };
      if (!userId) {
        await api.post('/identity/users', { ...profile, password: f.values.password, roleIds, scope });
        toast({ tone: 'success', title: 'User created', body: 'They must change the temporary password at first sign-in.' });
      } else if (tab === 'access') {
        await api.put(`/identity/users/${userId}/access`, { roleIds, scope, reason: reason || null });
        toast({ tone: 'success', title: 'Access updated', body: 'Takes effect at their next token refresh (within 15 minutes).' });
      } else {
        await api.patch(`/identity/users/${userId}`, { ...profile, status: f.values.status });
        toast({ tone: 'success', title: 'Profile saved' });
      }
      refresh();
      onClose();
    } catch (e) { f.handleError(e); } finally { setSaving(false); }
  }

  const s = structure.data;
  const selectedPerms = useMemo(() => new Set(roles.filter((r) => roleIds.includes(r.id)).flatMap((r) => r.permissions.map((p) => p.code))), [roles, roleIds]);
  const access = (
    <div className="space-y-6">
      <section>
        <h3 className="mb-3 text-[12px] font-semibold tracking-wide text-slate-500 uppercase">Roles</h3>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {roles.map((r) => (
            <Checkbox key={r.id} disabled={!manage} label={r.name} description={r.description ?? undefined} checked={roleIds.includes(r.id)}
              onChange={(e) => setRoleIds((ids) => (e.target.checked ? [...ids, r.id] : ids.filter((x) => x !== r.id)))}
              className="rounded-lg border border-slate-200 p-2.5" />
          ))}
        </div>
        <p className="mt-2 text-[12px] text-slate-500">{selectedPerms.size} effective permissions from the selected roles.</p>
      </section>
      <section>
        <h3 className="mb-3 text-[12px] font-semibold tracking-wide text-slate-500 uppercase">Data scope</h3>
        {!s ? <Skeleton className="h-40" /> : (
          <div className="space-y-3">
            <ScopePicker label="Legal entities" value={scope.entity} onChange={(v) => setScope({ ...scope, entity: v })} options={s.entities.map((e) => ({ value: e.id, label: e.legal_name }))} />
            <ScopePicker label="GST registrations" value={scope.gstin} onChange={(v) => setScope({ ...scope, gstin: v })} options={s.gstRegistrations.map((g) => ({ value: g.id, label: `${g.gstin} · ${g.state_name}` }))} />
            <ScopePicker label="Branches" value={scope.branch} onChange={(v) => setScope({ ...scope, branch: v })} options={s.branches.map((b) => ({ value: b.id, label: b.name }))} />
            <ScopePicker label="Warehouses" value={scope.warehouse} onChange={(v) => setScope({ ...scope, warehouse: v })} options={s.warehouses.map((w) => ({ value: w.id, label: `${w.code} · ${w.name}` }))} />
          </div>
        )}
      </section>
      {userId && <Textarea label="Reason for access change" value={reason} onChange={(e) => setReason(e.target.value)} hint="Recorded in the audit trail" />}
    </div>
  );

  const profile = (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      {f.formError && <div className="sm:col-span-2"><Notice tone="danger">{f.formError}</Notice></div>}
      <Input label="Full name" required {...f.bind('name')} />
      <Input label="Work email" type="email" required {...f.bind('email')} />
      <Input label="Designation" {...f.bind('designation')} />
      <Input label="Employee code" {...f.bind('employee_code')} />
      <Input label="Mobile" {...f.bind('phone')} />
      {userId && <Select label="Status" disabled={userId === me?.id} options={[{ value: 'active', label: 'Active' }, { value: 'inactive', label: 'Inactive — blocks sign-in' }]} {...f.bind('status')} />}
      {!userId && (
        <div className="sm:col-span-2">
          <Input label="Temporary password" required type="text" {...f.bind('password')} hint="Share it securely; the user must change it at first sign-in." />
          <div className="mt-2"><PasswordRules value={f.values.password} /></div>
        </div>
      )}
    </div>
  );

  return (
    <Drawer open onClose={onClose} width="lg" title={userId ? u.data?.name ?? 'User' : 'Invite user'} description={u.data?.email}
      footer={manage && tab !== 'security' && <><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={saving} onClick={save}>{userId ? 'Save' : 'Create user'}</Button></>}>
      {userId && !u.data ? <Skeleton className="h-64" /> : !userId ? (
        <div className="space-y-8">{profile}{access}</div>
      ) : (
        <>
          <Tabs className="mb-5" value={tab} onChange={setTab} tabs={[{ value: 'profile', label: 'Profile' }, { value: 'access', label: 'Roles & scope' }, { value: 'security', label: 'Security' }]} />
          {tab === 'profile' && <fieldset disabled={!manage}>{profile}</fieldset>}
          {tab === 'access' && access}
          {tab === 'security' && u.data && (
            <div className="space-y-5">
              <div className="grid grid-cols-2 gap-3">
                <div className="rounded-lg border border-slate-200 p-3.5">
                  <p className="text-[12px] text-slate-500">Multi-factor authentication</p>
                  <p className="mt-1 flex items-center gap-2 text-[13.5px] font-medium">{u.data.mfa_enabled ? <><CheckCircle2 className="size-4 text-emerald-500" />Enabled</> : <><AlertTriangle className="size-4 text-amber-500" />Not enrolled</>}</p>
                </div>
                <div className="rounded-lg border border-slate-200 p-3.5">
                  <p className="text-[12px] text-slate-500">Account</p>
                  <p className="mt-1 flex items-center gap-2 text-[13.5px] font-medium">{isLocked(u.data) ? <><Lock className="size-4 text-rose-500" />Locked until {fmtDateTime(u.data.locked_until)}</> : <><Unlock className="size-4 text-emerald-500" />Not locked</>}</p>
                </div>
              </div>
              {manage && (
                <div className="flex flex-wrap gap-2">
                  <Button icon={<KeyRound className="size-4" />} onClick={() => setResetPw(true)}>Set temporary password</Button>
                  {isLocked(u.data) && <Button icon={<Unlock className="size-4" />} onClick={async () => { await api.post(`/identity/users/${userId}/unlock`); refresh(); toast({ tone: 'success', title: 'Account unlocked' }); }}>Unlock</Button>}
                  {u.data.mfa_enabled && <Button icon={<Smartphone className="size-4" />} onClick={() => setMfaReset(true)}>Reset MFA</Button>}
                </div>
              )}
              <Card title="Active sessions" padded={false}>
                <ul className="divide-y divide-slate-100">
                  {sessions.data?.map((s) => (
                    <li key={s.id} className="flex items-center gap-3 px-4 py-2.5 text-[12.5px]">
                      <div className="min-w-0 flex-1"><p className="truncate text-slate-800">{s.user_agent}</p><p className="text-slate-500">{s.ip} · started {fmtDateTime(s.created_at)} · active {fmtRelative(s.last_used_at)}</p></div>
                      {manage && <Button size="xs" variant="ghost" icon={<LogOut className="size-3" />} onClick={async () => { await api.post(`/identity/sessions/${s.id}/revoke`); sessions.refetch(); toast({ tone: 'success', title: 'Session ended' }); }}>End</Button>}
                    </li>
                  ))}
                  {sessions.data?.length === 0 && <li className="px-4 py-4 text-[12.5px] text-slate-500">No active sessions.</li>}
                </ul>
              </Card>
            </div>
          )}
        </>
      )}
      <Modal open={resetPw} onClose={() => setResetPw(false)} title="Set temporary password" description="All of the user’s sessions end. They must choose a new password at next sign-in."
        footer={<><Button onClick={() => setResetPw(false)}>Cancel</Button><Button variant="primary" onClick={async () => {
          try { await api.post(`/identity/users/${userId}/reset-password`, { password: tempPw }); setResetPw(false); setTempPw(''); refresh(); toast({ tone: 'success', title: 'Temporary password set' }); } catch (e) { toast({ tone: 'error', title: (e as Error).message }); }
        }}>Set password</Button></>}>
        <Input label="Temporary password" value={tempPw} onChange={(e) => setTempPw(e.target.value)} />
        <div className="mt-2"><PasswordRules value={tempPw} /></div>
      </Modal>
      <ConfirmDialog open={mfaReset} onClose={() => setMfaReset(false)} requireReason tone="danger" title="Reset MFA?" description="Use when the user lost their phone. They can enrol again after signing in." confirmLabel="Reset MFA"
        onConfirm={async (r) => { await api.post(`/identity/users/${userId}/mfa-reset`, { reason: r }); setMfaReset(false); refresh(); toast({ tone: 'success', title: 'MFA reset' }); }} />
    </Drawer>
  );
}

export function RolesPage() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const roles = useQuery({ queryKey: ['roles'], queryFn: () => api.get<Role[]>('/identity/roles') });
  const perms = useQuery({ queryKey: ['permissions'], queryFn: () => api.get<Permission[]>('/identity/permissions') });
  const [params, setParams] = useSearchParams();
  const selected = roles.data?.find((r) => r.id === params.get('role')) ?? roles.data?.[0];
  const [draft, setDraft] = useState<Map<string, number | null>>(new Map());
  const [dirty, setDirty] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [creating, setCreating] = useState(false);
  const nf = useForm({ code: '', name: '', description: '' });
  const manage = can('identity.role.manage') && selected?.code !== 'super_admin';

  useEffect(() => {
    if (selected) setDraft(new Map(selected.permissions.map((p) => [p.code, p.limit])));
    setDirty(false);
  }, [selected?.id, roles.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const modules = [...new Set(perms.data?.map((p) => p.module) ?? [])];
  const toggle = (code: string) => { const n = new Map(draft); if (n.has(code)) n.delete(code); else n.set(code, null); setDraft(n); setDirty(true); };

  return (
    <>
      <PageHeader
        title="Roles & permissions"
        description="Permissions are granted to roles, never hard-coded to role names. Sensitive permissions are highlighted; every change is audited."
        breadcrumbs={[{ label: 'Security' }, { label: 'Roles & permissions' }]}
        actions={can('identity.role.manage') && <Button icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>New role</Button>}
      />
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[300px_1fr]">
        <Card padded={false} className="h-fit">
          <ul className="scrollbar-thin max-h-[calc(100vh-220px)] overflow-y-auto py-1.5">
            {roles.data?.map((r) => (
              <li key={r.id}>
                <button onClick={() => setParams({ role: r.id })} className={clsx('flex w-full items-center gap-3 px-4 py-2 text-left', selected?.id === r.id ? 'bg-brand-50' : 'hover:bg-slate-50')}>
                  <span className="min-w-0 flex-1">
                    <span className={clsx('block truncate text-[13.5px]', selected?.id === r.id ? 'font-semibold text-brand-800' : 'font-medium text-slate-800')}>{r.name}</span>
                    <span className="block text-[11.5px] text-slate-500">{r.permissions.length} permissions · {r.user_count} users</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </Card>
        {selected && (
          <Card
            title={<span className="flex items-center gap-2">{selected.name}{selected.is_system && <Badge>Baseline role</Badge>}</span>}
            description={selected.description}
            padded={false}
            actions={manage && <><Button size="sm" disabled={!dirty} onClick={() => { setDraft(new Map(selected.permissions.map((p) => [p.code, p.limit]))); setDirty(false); }}>Discard</Button><Button size="sm" variant="primary" disabled={!dirty} onClick={() => setConfirm(true)}>Save changes</Button></>}
          >
            {selected.code === 'super_admin' && <div className="px-5 pt-4"><Notice tone="info" icon={<ShieldCheck className="size-4" />}>Super Admin always holds every permission, including ones added in later phases.</Notice></div>}
            {selected.permissions.length === 0 && selected.code.match(/customer|supplier|transporter|mill_user/) && <div className="px-5 pt-4"><Notice tone="info">Portal roles get their permissions when the partner portals ship (P2, P3, P6, P7).</Notice></div>}
            <div className="divide-y divide-slate-100">
              {modules.map((m) => (
                <section key={m} className="px-5 py-4">
                  <h3 className="mb-2 text-[12px] font-semibold tracking-wide text-slate-500 uppercase">{m}</h3>
                  <ul className="space-y-1">
                    {perms.data!.filter((p) => p.module === m).map((p) => {
                      const on = draft.has(p.code);
                      return (
                        <li key={p.code} className="flex items-center gap-3 rounded-md px-2 py-1.5 hover:bg-slate-50">
                          <input type="checkbox" className="size-4 accent-brand-600" checked={on} disabled={!manage} onChange={() => toggle(p.code)} aria-label={p.label} />
                          <span className="flex-1 text-[13.5px] text-slate-800">{p.label}</span>
                          {p.sensitive && <Badge tone="warning">Sensitive</Badge>}
                          <span className="hidden font-mono text-[11px] text-slate-400 md:inline">{p.code}</span>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              ))}
            </div>
          </Card>
        )}
      </div>
      <ConfirmDialog open={confirm} onClose={() => setConfirm(false)} requireReason title={`Update ${selected?.name}?`}
        description={`${selected?.user_count} users hold this role. Changes apply at their next token refresh.`} confirmLabel="Save permissions"
        onConfirm={async (reason) => {
          await api.put(`/identity/roles/${selected!.id}/permissions`, { permissions: [...draft].map(([code, limit]) => ({ code, limit })), reason });
          setConfirm(false); setDirty(false);
          qc.invalidateQueries({ queryKey: ['roles'] });
          toast({ tone: 'success', title: 'Permissions updated' });
        }} />
      <Modal open={creating} onClose={() => setCreating(false)} title="New role" footer={<><Button onClick={() => setCreating(false)}>Cancel</Button><Button variant="primary" onClick={async () => {
        try { const r = await api.post<Role>('/identity/roles', nf.values); qc.invalidateQueries({ queryKey: ['roles'] }); setCreating(false); nf.reset(); setParams({ role: r.id }); toast({ tone: 'success', title: 'Role created' }); } catch (e) { nf.handleError(e); }
      }}>Create</Button></>}>
        <div className="space-y-4">
          {nf.formError && <Notice tone="danger">{nf.formError}</Notice>}
          <Input label="Name" required {...nf.bind('name')} />
          <Input label="Code" required {...nf.bind('code')} hint="lowercase_with_underscores" />
          <Textarea label="Description" {...nf.bind('description')} />
        </div>
      </Modal>
    </>
  );
}

const OUTCOME: Record<string, [string, React.ReactNode]> = {
  success: ['Signed in', <CheckCircle2 className="size-4 text-emerald-500" />],
  bad_password: ['Wrong password', <XCircle className="size-4 text-rose-500" />],
  unknown_user: ['Unknown email', <XCircle className="size-4 text-rose-500" />],
  locked: ['Locked out', <Lock className="size-4 text-rose-600" />],
  inactive: ['Deactivated account', <XCircle className="size-4 text-slate-400" />],
  mfa_failed: ['MFA code rejected', <XCircle className="size-4 text-amber-500" />],
  password_ok_mfa_pending: ['Password OK, MFA pending', <ShieldCheck className="size-4 text-sky-500" />],
  password_reset_requested: ['Password reset requested', <KeyRound className="size-4 text-slate-500" />],
};

export function LoginActivityPage() {
  const [filters, setFilters] = useState<Record<string, string>>({});
  return (
    <>
      <PageHeader title="Login activity" description="Every sign-in attempt with outcome, IP and device. Repeated failures lock the account automatically." breadcrumbs={[{ label: 'Security' }, { label: 'Login activity' }]} />
      <DataTable<{ id: string; email: string; outcome: string; ip: string | null; user_agent: string | null; at: string }>
        id="login-events"
        endpoint="/identity/login-events"
        filters={filters}
        onFiltersChange={setFilters}
        searchPlaceholder="Search email or IP…"
        defaultSort={{ key: 'at', dir: 'desc' }}
        toolbar={<FilterSelect placeholder="All outcomes" value={filters.outcome} onChange={(v) => setFilters({ ...filters, outcome: v })} options={Object.entries(OUTCOME).map(([k, [l]]) => ({ value: k, label: l }))} />}
        columns={[
          { key: 'at', header: 'When', sort: 'at', csv: (r) => r.at, render: (r) => <span className="text-[12.5px] whitespace-nowrap">{fmtDateTime(r.at)}</span> },
          { key: 'email', header: 'Email', sort: 'email', csv: (r) => r.email, render: (r) => r.email },
          { key: 'outcome', header: 'Outcome', sort: 'outcome', csv: (r) => r.outcome, render: (r) => <span className="flex items-center gap-2">{OUTCOME[r.outcome]?.[1]}{OUTCOME[r.outcome]?.[0] ?? humanize(r.outcome)}</span> },
          { key: 'ip', header: 'IP address', csv: (r) => r.ip, render: (r) => <span className="font-mono text-[12.5px]">{r.ip ?? '—'}</span> },
          { key: 'ua', header: 'Device', csv: (r) => r.user_agent, render: (r) => <span className="block max-w-[360px] truncate text-[12px] text-slate-500">{r.user_agent ?? '—'}</span> },
        ]}
      />
    </>
  );
}

