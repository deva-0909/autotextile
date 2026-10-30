import { useQuery, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { Bell, ChevronDown, CornerDownLeft, KeyRound, LogOut, Menu as MenuIcon, Search, ShieldCheck, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { api, qs, type Page } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fmtRelative } from '../lib/format';
import { ALL_ITEMS, NAV } from '../lib/nav';
import { Menu, MenuItem } from './overlay';
import { Avatar, Badge } from './ui';

interface Notification { id: string; kind: string; title: string; body: string | null; link: string | null; created_at: string; read: boolean }
interface Structure { entities: { id: string; legal_name: string }[]; gstRegistrations: { id: string; gstin: string; state_name: string }[]; warehouses: { id: string; code: string; name: string }[] }

function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const { can } = useAuth();
  const summary = useQuery({ queryKey: ['governance-summary'], queryFn: () => api.get<{ approvalsToDecide: number }>('/governance/summary'), refetchInterval: 30_000 });
  return (
    <div className="flex h-full flex-col bg-nav-950 text-slate-300">
      <div className="flex h-14 items-center gap-2.5 px-5">
        <img src="/favicon.svg" alt="" className="size-7" />
        <div className="leading-tight">
          <p className="text-[14px] font-semibold text-white">Textile ERP</p>
          <p className="text-[11px] text-slate-400">Trading · Processing · Fulfilment</p>
        </div>
      </div>
      <nav className="scrollbar-thin flex-1 overflow-y-auto px-3 pb-6">
        {NAV.map((g) => {
          const items = g.items.filter((i) => !i.perms || can(...i.perms));
          if (!items.length) return null;
          return (
            <div key={g.label} className="mt-5">
              <p className="mb-1.5 px-2.5 text-[10.5px] font-semibold tracking-[0.08em] text-slate-500 uppercase">{g.label}</p>
              {items.map((i) => (
                <NavLink
                  key={i.to}
                  to={i.to}
                  end={i.to === '/'}
                  onClick={onNavigate}
                  className={({ isActive }) =>
                    clsx(
                      'group flex items-center gap-2.5 rounded-md px-2.5 py-[7px] text-[13.5px] transition-colors',
                      isActive ? 'bg-nav-800 text-white shadow-[inset_2px_0_0_var(--color-brand-400)]' : 'hover:bg-nav-900 hover:text-white',
                      i.phase && 'text-slate-400',
                    )
                  }
                >
                  <i.icon className={clsx('size-4 shrink-0', i.phase ? 'opacity-60' : 'opacity-80')} />
                  <span className="flex-1 truncate">{i.label}</span>
                  {i.phase && <span className="rounded bg-nav-800 px-1.5 py-px text-[10px] font-semibold text-slate-400">{i.phase}</span>}
                  {i.to === '/approvals' && !!summary.data?.approvalsToDecide && (
                    <span className="rounded-full bg-amber-400 px-1.5 text-[10.5px] font-bold text-amber-950 tabular">{summary.data.approvalsToDecide}</span>
                  )}
                </NavLink>
              ))}
            </div>
          );
        })}
      </nav>
      <div className="border-t border-nav-800 px-5 py-3 text-[11px] text-slate-500">Releases P1–P3 · Foundation, procurement, job work</div>
    </div>
  );
}

function ScopeChip() {
  const { user } = useAuth();
  const s = useQuery({ queryKey: ['structure'], queryFn: () => api.get<Structure>('/organisation/structure'), staleTime: 5 * 60_000 });
  if (!user || !s.data) return null;
  const full = user.scope.warehouse === '*' && user.scope.gstin === '*';
  const label = full
    ? `${s.data.entities[0]?.legal_name ?? 'All entities'} · All locations`
    : `${s.data.warehouses.map((w) => w.code).join(', ') || 'No warehouses'} · ${s.data.gstRegistrations.map((g) => g.gstin).join(', ')}`;
  return (
    <div className="hidden items-center gap-2 rounded-md border border-slate-200 bg-white px-2.5 py-1 text-[12px] text-slate-600 lg:flex" title="Your data scope">
      <ShieldCheck className="size-3.5 text-emerald-600" />
      <span className="max-w-[340px] truncate">{label}</span>
      {!full && <Badge tone="warning">Restricted</Badge>}
    </div>
  );
}

function Notifications() {
  const qc = useQueryClient();
  const nav = useNavigate();
  const q = useQuery({ queryKey: ['notifications'], queryFn: () => api.get<Notification[]>('/governance/notifications'), refetchInterval: 30_000 });
  const unread = q.data?.filter((n) => !n.read).length ?? 0;
  const markAll = async () => { await api.post('/governance/notifications/read-all'); qc.invalidateQueries({ queryKey: ['notifications'] }); };
  return (
    <Menu
      width="w-[380px]"
      trigger={(toggle) => (
        <button onClick={toggle} className="relative inline-flex size-9 items-center justify-center rounded-md text-slate-500 hover:bg-slate-100 hover:text-slate-900" aria-label="Notifications">
          <Bell className="size-[18px]" />
          {unread > 0 && <span className="absolute top-1.5 right-1.5 flex size-4 items-center justify-center rounded-full bg-rose-500 text-[9.5px] font-bold text-white">{unread > 9 ? '9+' : unread}</span>}
        </button>
      )}
    >
      {(close) => (
        <div>
          <div className="flex items-center justify-between border-b border-slate-100 px-4 py-2.5">
            <p className="text-[13.5px] font-semibold">Notifications</p>
            {unread > 0 && <button className="text-[12px] font-medium text-brand-600 hover:underline" onClick={markAll}>Mark all read</button>}
          </div>
          <div className="scrollbar-thin max-h-[420px] overflow-y-auto">
            {!q.data?.length && <p className="px-4 py-8 text-center text-[13px] text-slate-500">You’re all caught up.</p>}
            {q.data?.map((n) => (
              <button
                key={n.id}
                className={clsx('flex w-full gap-3 border-b border-slate-50 px-4 py-3 text-left hover:bg-slate-50', !n.read && 'bg-brand-50/40')}
                onClick={async () => {
                  close();
                  await api.post(`/governance/notifications/${n.id}/read`);
                  qc.invalidateQueries({ queryKey: ['notifications'] });
                  if (n.link) nav(n.link);
                }}
              >
                <span className={clsx('mt-1.5 size-2 shrink-0 rounded-full', n.read ? 'bg-transparent' : n.kind === 'action' ? 'bg-amber-500' : n.kind === 'warning' ? 'bg-rose-500' : 'bg-brand-500')} />
                <span className="min-w-0">
                  <span className="block text-[13px] font-medium text-slate-900">{n.title}</span>
                  {n.body && <span className="mt-0.5 block truncate text-[12px] text-slate-500">{n.body}</span>}
                  <span className="mt-1 block text-[11px] text-slate-400">{fmtRelative(n.created_at)}</span>
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
    </Menu>
  );
}

interface SearchHit { kind: string; label: string; sub?: string; to: string }

function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const nav = useNavigate();
  const { can } = useAuth();
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { if (open) { setQ(''); setActive(0); setTimeout(() => inputRef.current?.focus(), 10); } }, [open]);

  const pages = useMemo(
    () => ALL_ITEMS.filter((i) => (!i.perms || can(...i.perms)) && i.label.toLowerCase().includes(q.toLowerCase())).map((i) => ({ kind: i.group, label: i.label, to: i.to })),
    [q, can],
  );

  useEffect(() => {
    if (q.trim().length < 2) { setHits([]); return; }
    const t = setTimeout(async () => {
      const out: SearchHit[] = [];
      if (can('masters.party.read')) {
        const r = await api.get<Page<{ id: string; code: string; legal_name: string; party_type: string; gstin: string | null }>>(`/masters/parties${qs({ q, pageSize: 6 })}`).catch(() => null);
        r?.items.forEach((p) => out.push({ kind: p.party_type, label: p.legal_name, sub: `${p.code}${p.gstin ? ` · ${p.gstin}` : ''}`, to: `/partners/${p.party_type}/${p.id}` }));
      }
      if (can('masters.product.read')) {
        const r = await api.get<Page<{ id: string; sku: string; name: string }>>(`/masters/products${qs({ q, pageSize: 4 })}`).catch(() => null);
        r?.items.forEach((p) => out.push({ kind: 'product', label: p.name, sub: p.sku, to: `/catalogue/products?open=${p.id}` }));
      }
      setHits(out);
    }, 200);
    return () => clearTimeout(t);
  }, [q, can]);

  const all: SearchHit[] = [...pages.slice(0, 6), ...hits];
  useEffect(() => setActive(0), [q, hits.length]);
  if (!open) return null;
  const go = (h: SearchHit) => { onClose(); nav(h.to); };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center p-4 pt-[14vh]">
      <div className="animate-fade-in fixed inset-0 bg-slate-900/40" onClick={onClose} />
      <div className="animate-pop-in relative w-full max-w-xl overflow-hidden rounded-xl bg-white shadow-pop">
        <div className="flex items-center gap-3 border-b border-slate-200 px-4">
          <Search className="size-4 text-slate-400" />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, all.length - 1)); }
              if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
              if (e.key === 'Enter' && all[active]) go(all[active]);
              if (e.key === 'Escape') onClose();
            }}
            placeholder="Search pages, customers, suppliers, mills, SKUs, GSTIN…"
            className="h-12 flex-1 bg-transparent text-[14px] outline-none placeholder:text-slate-400"
          />
          <span className="kbd">Esc</span>
        </div>
        <div className="scrollbar-thin max-h-[380px] overflow-y-auto py-2">
          {all.length === 0 && <p className="px-4 py-8 text-center text-[13px] text-slate-500">{q.length < 2 ? 'Type to search records' : 'No results'}</p>}
          {all.map((h, i) => (
            <button
              key={`${h.to}-${i}`}
              onMouseEnter={() => setActive(i)}
              onClick={() => go(h)}
              className={clsx('flex w-full items-center gap-3 px-4 py-2 text-left', i === active && 'bg-brand-50')}
            >
              <span className="w-24 shrink-0 truncate text-[11px] font-semibold tracking-wide text-slate-400 uppercase">{h.kind}</span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13.5px] text-slate-900">{h.label}</span>
                {h.sub && <span className="block truncate font-mono text-[11.5px] text-slate-500">{h.sub}</span>}
              </span>
              {i === active && <CornerDownLeft className="size-3.5 text-slate-400" />}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

export function Layout({ children }: { children: ReactNode }) {
  const { user, signOut } = useAuth();
  const nav = useNavigate();
  const loc = useLocation();
  const [palette, setPalette] = useState(false);
  const [mobileNav, setMobileNav] = useState(false);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPalette((p) => !p); }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);
  useEffect(() => setMobileNav(false), [loc.pathname]);

  return (
    <div className="flex h-screen overflow-hidden">
      <aside className="hidden w-[248px] shrink-0 lg:block"><Sidebar /></aside>
      {mobileNav && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-slate-900/40" onClick={() => setMobileNav(false)} />
          <div className="animate-slide-in absolute inset-y-0 left-0 w-[260px]"><Sidebar onNavigate={() => setMobileNav(false)} /></div>
          <button className="absolute top-3 left-[270px] rounded-md bg-white p-1.5" onClick={() => setMobileNav(false)} aria-label="Close menu"><X className="size-4" /></button>
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center gap-3 border-b border-slate-200 bg-white/90 px-4 backdrop-blur lg:px-6">
          <button className="rounded-md p-1.5 text-slate-500 hover:bg-slate-100 lg:hidden" onClick={() => setMobileNav(true)} aria-label="Open menu"><MenuIcon className="size-5" /></button>
          <button
            onClick={() => setPalette(true)}
            className="flex h-9 w-full max-w-md items-center gap-2.5 rounded-md border border-slate-200 bg-slate-50 px-3 text-[13px] text-slate-500 transition hover:border-slate-300 hover:bg-white"
          >
            <Search className="size-4" />
            <span className="flex-1 text-left">Search records and pages…</span>
            <span className="hidden items-center gap-0.5 sm:flex"><span className="kbd">Ctrl</span><span className="kbd">K</span></span>
          </button>
          <div className="ml-auto flex items-center gap-2">
            <ScopeChip />
            <Notifications />
            <Menu
              width="w-64"
              trigger={(toggle) => (
                <button onClick={toggle} className="flex items-center gap-2 rounded-md py-1 pr-1.5 pl-1 hover:bg-slate-100">
                  <Avatar name={user?.name ?? '?'} />
                  <span className="hidden text-left leading-tight md:block">
                    <span className="block text-[13px] font-medium text-slate-900">{user?.name}</span>
                    <span className="block text-[11.5px] text-slate-500">{user?.roles.map((r) => r.replace(/_/g, ' ')).join(', ')}</span>
                  </span>
                  <ChevronDown className="size-3.5 text-slate-400" />
                </button>
              )}
            >
              {(close) => (
                <>
                  <div className="border-b border-slate-100 px-3 py-2.5">
                    <p className="text-[13px] font-medium text-slate-900">{user?.name}</p>
                    <p className="truncate text-[12px] text-slate-500">{user?.email}</p>
                  </div>
                  <MenuItem icon={<KeyRound className="size-4" />} onClick={() => { close(); nav('/account'); }}>Account & security</MenuItem>
                  <MenuItem icon={<LogOut className="size-4" />} danger onClick={() => { close(); void signOut().then(() => nav('/login')); }}>Sign out</MenuItem>
                </>
              )}
            </Menu>
          </div>
        </header>
        <main className="scrollbar-thin flex-1 overflow-y-auto">
          <div className="mx-auto max-w-[1440px] px-4 py-6 lg:px-8 lg:py-7">{children}</div>
        </main>
      </div>
      <CommandPalette open={palette} onClose={() => setPalette(false)} />
    </div>
  );
}

export function PageLink({ to, children }: { to: string; children: ReactNode }) {
  return <Link to={to} className="link">{children}</Link>;
}
