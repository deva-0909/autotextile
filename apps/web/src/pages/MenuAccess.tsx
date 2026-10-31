import { useQuery, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { Lock, RotateCcw, Search } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, type Page } from '../lib/api';
import { ALWAYS_SHOWN, useAuth } from '../lib/auth';
import { NAV } from '../lib/nav';
import { fmtRelative } from '../lib/format';
import { ConfirmDialog, useToast } from '../components/overlay';
import { Badge, Button, Card, Notice, PageHeader, Skeleton, Switch, Tabs } from '../components/ui';

interface Role { id: string; code: string; name: string; user_count: number; permissions: { code: string }[] }
interface MenuRow { scope: 'role' | 'user'; ref: string; items: string[]; ref_name: string | null; updated_by_name: string | null; updated_at: string }
interface UserRow { id: string; name: string; email: string; designation: string | null; roles: { code: string; name: string }[]; parent_name: string | null; custom_menu: boolean; status: string }

/**
 * Which pages each role, and each person, sees in the menu. Permissions still decide what someone may do; this decides
 * what their menu offers, so each job sees only its own work. A person's menu can only narrow their role's.
 */
export function MenuAccessPage() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') as 'roles' | 'people') ?? 'roles';
  const roles = useQuery({ queryKey: ['roles'], queryFn: () => api.get<Role[]>('/identity/roles') });
  const menus = useQuery({ queryKey: ['menu-access'], queryFn: () => api.get<MenuRow[]>('/identity/menu-access') });
  const [q, setQ] = useState('');
  const users = useQuery({ queryKey: ['menu-users', q], queryFn: () => api.get<Page<UserRow>>(`/identity/users?pageSize=100&f_status=active${q ? `&q=${encodeURIComponent(q)}` : ''}`), enabled: tab === 'people' });

  const staffRoles = (roles.data ?? []).filter((r) => !/^customer_|^supplier_|^transporter_|^mill_user$/.test(r.code));
  const selRole = tab === 'roles' ? staffRoles.find((r) => r.code === params.get('role')) ?? staffRoles.find((r) => r.code !== 'super_admin') : undefined;
  const people = (users.data?.items ?? []).filter((u) => u.roles.some((r) => staffRoles.some((s) => s.code === r.code)));
  const selUser = tab === 'people' ? people.find((u) => u.id === params.get('user')) ?? people[0] : undefined;
  const roleMenu = (code: string) => menus.data?.find((m) => m.scope === 'role' && m.ref === code)?.items ?? null;
  const userMenu = (id: string) => menus.data?.find((m) => m.scope === 'user' && m.ref === id)?.items ?? null;

  // What the selected role or person may open at all (their permissions), and for a person, what their roles show.
  const perms = useMemo(() => {
    const codes = selRole ? [selRole.code] : selUser?.roles.map((r) => r.code) ?? [];
    const set = new Set((roles.data ?? []).filter((r) => codes.includes(r.code)).flatMap((r) => r.permissions.map((p) => p.code)));
    return { all: codes.includes('super_admin'), set };
  }, [selRole, selUser, roles.data]);
  const ceiling = useMemo(() => {
    if (!selUser) return null;
    const ms = selUser.roles.map((r) => roleMenu(r.code));
    return ms.some((m) => !m) ? null : [...new Set(ms.flatMap((m) => m!))];
  }, [selUser, menus.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const saved = selRole ? roleMenu(selRole.code) : selUser ? userMenu(selUser.id) : null;
  const [all, setAll] = useState(true);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [confirm, setConfirm] = useState(false);
  const key = selRole?.code ?? selUser?.id ?? '';
  useEffect(() => {
    setAll(!saved);
    setPicked(new Set(saved ?? []));
  }, [key, menus.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const allowed = (perm?: string[]) => perms.all || !perm || perm.some((p) => perms.set.has(p));
  const inCeiling = (to: string) => !ceiling || ceiling.includes(to);
  const shown = (to: string) => ALWAYS_SHOWN.includes(to) || (all ? inCeiling(to) : picked.has(to));
  const groups = NAV.filter((g) => g.label !== 'Overview').map((g) => ({ ...g, items: g.items.filter((i) => allowed(i.perms)) })).filter((g) => g.items.length);
  const visibleCount = groups.reduce((n, g) => n + g.items.filter((i) => shown(i.to) && inCeiling(i.to)).length, 0);
  const dirty = all !== !saved || (!all && (picked.size !== (saved?.length ?? 0) || [...picked].some((p) => !saved?.includes(p))));
  const editable = selRole ? can('identity.role.manage') && selRole.code !== 'super_admin' : can('identity.user.manage');
  const toggle = (to: string) => { const n = new Set(picked); if (n.has(to)) n.delete(to); else n.add(to); setPicked(n); };
  const toggleGroup = (items: string[], on: boolean) => { const n = new Set(picked); for (const i of items) if (on) n.add(i); else n.delete(i); setPicked(n); };
  const startCustom = () => { setAll(false); setPicked(new Set(groups.flatMap((g) => g.items.map((i) => i.to)).filter(inCeiling))); };

  const save = async (reason: string) => {
    const items = all ? null : [...picked].filter(inCeiling);
    const path = selRole ? `/identity/menu-access/roles/${selRole.code}` : `/identity/menu-access/users/${selUser!.id}`;
    await api.put(path, { items, reason });
    await qc.invalidateQueries({ queryKey: ['menu-access'] });
    await qc.invalidateQueries({ queryKey: ['menu-users'] });
    setConfirm(false);
    toast({ tone: 'success', title: 'Menu saved', body: 'People see the change the next time they sign in or within 15 minutes.' });
  };

  // Pages a role can actually open from its menu: in its menu and covered by its permissions.
  const pagesOf = (r: Role) => {
    const ps = new Set(r.permissions.map((p) => p.code));
    const menu = roleMenu(r.code)!;
    return NAV.flatMap((g) => g.items).filter((i) => !ALWAYS_SHOWN.includes(i.to) && menu.includes(i.to) && (!i.perms || i.perms.some((p) => ps.has(p)))).length;
  };
  const list = tab === 'roles' ? staffRoles.map((r) => ({ id: r.code, name: r.name, sub: `${r.user_count} ${r.user_count === 1 ? 'person' : 'people'}`, badge: r.code === 'super_admin' || !roleMenu(r.code) ? 'All pages' : `${pagesOf(r)} pages` }))
    : people.map((u) => ({ id: u.id, name: u.name, sub: `${u.roles.map((r) => r.name).join(', ')}${u.parent_name ? ` · sub-user of ${u.parent_name}` : ''}`, badge: userMenu(u.id) ? 'Own menu' : 'As role' }));
  const selectedId = tab === 'roles' ? selRole?.code : selUser?.id;

  return (
    <>
      <PageHeader title="Menu access" breadcrumbs={[{ label: 'Security' }, { label: 'Menu access' }]}
        description="Choose which pages each role and each person sees in the menu. Permissions still decide what they may do; pages taken out of someone's menu are also closed to them." />
      <Tabs className="mb-4" value={tab} onChange={(t) => setParams({ tab: t })} tabs={[{ value: 'roles', label: 'Roles' }, { value: 'people', label: 'People' }]} />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[280px_1fr]">
        <Card padded={false} className="h-fit">
          {tab === 'people' && (
            <div className="relative border-b border-slate-100 p-2">
              <Search className="pointer-events-none absolute top-1/2 left-4.5 size-3.5 -translate-y-1/2 text-slate-400" />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a person" className="input h-8 pl-8 text-[12.5px]" aria-label="Find a person" />
            </div>
          )}
          <ul className="scrollbar-thin max-h-[calc(100vh-260px)] overflow-y-auto py-1">
            {!roles.data && <li className="p-3"><Skeleton className="h-40" /></li>}
            {list.map((x) => (
              <li key={x.id}>
                <button onClick={() => setParams(tab === 'roles' ? { tab, role: x.id } : { tab, user: x.id })}
                  className={clsx('flex w-full items-center gap-2 px-4 py-2 text-left', selectedId === x.id ? 'bg-brand-50' : 'hover:bg-slate-50')}>
                  <span className="min-w-0 flex-1">
                    <span className={clsx('block truncate text-[13px]', selectedId === x.id ? 'font-semibold text-brand-800' : 'font-medium text-slate-800')}>{x.name}</span>
                    <span className="block truncate text-[11.5px] text-slate-500">{x.sub}</span>
                  </span>
                  <Badge tone={x.badge === 'All pages' || x.badge === 'As role' ? 'neutral' : 'brand'}>{x.badge}</Badge>
                </button>
              </li>
            ))}
          </ul>
        </Card>

        {(selRole || selUser) && (
          <Card padded={false}
            title={<span className="flex items-center gap-2">{selRole?.name ?? selUser!.name}<span className="text-[12px] font-normal text-slate-500">{visibleCount} pages in the menu</span></span>}
            description={selUser ? `${selUser.roles.map((r) => r.name).join(', ')}${selUser.parent_name ? ` · sub-user of ${selUser.parent_name}` : ''}${ceiling ? ' · can only see pages their role shows' : ''}` : selRole?.code === 'super_admin' ? 'Super Admin always sees every page.' : undefined}
            actions={editable && <><Button size="sm" disabled={!dirty} onClick={() => { setAll(!saved); setPicked(new Set(saved ?? [])); }}>Discard</Button><Button size="sm" variant="primary" disabled={!dirty} onClick={() => setConfirm(true)}>Save menu</Button></>}>
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-4 py-2.5">
              <Switch checked={all} disabled={!editable} onChange={(v) => (v ? setAll(true) : startCustom())}
                label={<span className="text-[13px]">{selRole ? 'Show every page this role’s permissions allow' : 'Same menu as their role'}</span>} />
              {!all && editable && <Button size="xs" variant="ghost" icon={<RotateCcw className="size-3" />} onClick={() => setAll(true)}>{selRole ? 'Show all pages' : 'Back to role menu'}</Button>}
            </div>
            {saved && <p className="border-b border-slate-100 px-4 py-1.5 text-[11.5px] text-slate-500">Last changed by {menus.data?.find((m) => m.ref === key)?.updated_by_name ?? '—'} {fmtRelative(menus.data?.find((m) => m.ref === key)?.updated_at)}</p>}
            <div className="gap-x-6 px-4 py-3 md:columns-2 2xl:columns-3">
              <section className="mb-3 break-inside-avoid">
                <h3 className="mb-1 px-1.5 text-[11px] font-semibold tracking-wide text-slate-500 uppercase">Overview</h3>
                <p className="flex items-center gap-1.5 px-1.5 text-[12.5px] text-slate-500"><Lock className="size-3" />Dashboard, approvals, my work and my HR are always shown</p>
              </section>
              {groups.map((g) => {
                const items = g.items.filter((i) => inCeiling(i.to));
                const on = items.filter((i) => shown(i.to)).length;
                return (
                  <section key={g.label} className="mb-3 break-inside-avoid">
                    <label className="mb-0.5 flex items-center gap-2 px-1.5 text-[11px] font-semibold tracking-wide text-slate-500 uppercase">
                      <input type="checkbox" className="size-3.5 accent-brand-600" disabled={!editable || all || !items.length} checked={items.length > 0 && on === items.length}
                        ref={(el) => { if (el) el.indeterminate = on > 0 && on < items.length; }} onChange={(e) => toggleGroup(items.map((i) => i.to), e.target.checked)} aria-label={`All of ${g.label}`} />
                      <span className="flex-1">{g.label}</span><span className="font-normal tracking-normal text-slate-400 normal-case">{on}/{items.length}</span>
                    </label>
                    <ul>
                      {g.items.map((i) => {
                        const outside = !inCeiling(i.to);
                        return (
                          <li key={i.to} className={clsx('flex items-center gap-2 rounded px-1.5 py-[3px]', !outside && 'hover:bg-slate-50')} title={outside ? 'Not in their role’s menu' : i.to}>
                            <input type="checkbox" className="ml-4 size-3.5 shrink-0 accent-brand-600" disabled={!editable || all || outside} checked={!outside && shown(i.to)} onChange={() => toggle(i.to)} aria-label={i.label} />
                            <i.icon className={clsx('size-3.5 shrink-0', outside ? 'text-slate-300' : 'text-slate-400')} />
                            <span className={clsx('min-w-0 flex-1 truncate text-[12.5px]', outside ? 'text-slate-400 line-through' : shown(i.to) ? 'text-slate-800' : 'text-slate-500')}>{i.label}</span>
                          </li>
                        );
                      })}
                    </ul>
                  </section>
                );
              })}
            </div>
            {groups.length === 0 && <div className="p-4"><Notice tone="info">This role has no permissions for any menu page yet. Grant permissions under Roles & permissions first.</Notice></div>}
          </Card>
        )}
      </div>
      <ConfirmDialog open={confirm} onClose={() => setConfirm(false)} requireReason title={`Save the menu for ${selRole?.name ?? selUser?.name}?`}
        description={all ? (selRole ? 'They will see every page their permissions allow.' : 'They will see the same menu as their role.') : `${visibleCount} pages will be in the menu; other pages are hidden and closed to them.`}
        confirmLabel="Save menu" onConfirm={save} />
    </>
  );
}
