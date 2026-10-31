import { useQuery, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { Building2, Check, ChevronUp, Loader2, Search, UsersRound, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, type SessionUser } from '../lib/api';
import { useAuth } from '../lib/auth';

/** Users offered by the server in demo mode (DEMO_MODE=1). The endpoint does not exist otherwise. */
interface DemoUser { email: string; name: string; designation: string | null; portal: boolean; roles: string | null; role_code: string | null }

export function useDemoUsers() {
  return useQuery({
    queryKey: ['demo-users'],
    queryFn: () => api.get<DemoUser[]>('/identity/auth/demo-users'),
    retry: false,
    staleTime: Infinity,
  });
}

/** Signs in as a demo user and starts that user's app from its home page. */
function useSwitch() {
  const { signIn } = useAuth();
  const qc = useQueryClient();
  const nav = useNavigate();
  const [busy, setBusy] = useState<string | null>(null);
  const go = async (email: string) => {
    setBusy(email);
    try {
      const r = await api.post<{ accessToken: string; user: SessionUser; mustChangePassword: boolean }>('/identity/auth/demo-login', { email });
      qc.removeQueries({ predicate: (q) => q.queryKey[0] !== 'demo-users' });
      signIn(r);
      nav('/', { replace: true });
    } finally {
      setBusy(null);
    }
  };
  return { go, busy };
}

const groupOf = (u: DemoUser) => (!u.portal ? 'Staff' : u.role_code?.startsWith('customer') ? 'Customer portal' : u.role_code === 'mill_user' ? 'Mill portal' : 'Supplier portal');

function UserRow({ u, active, busy, onPick }: { u: DemoUser; active: boolean; busy: boolean; onPick: () => void }) {
  return (
    <button onClick={onPick} disabled={active || busy}
      className={clsx('flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left transition', active ? 'bg-brand-50' : 'hover:bg-slate-50')}>
      <span className={clsx('flex size-8 shrink-0 items-center justify-center rounded-full text-[11.5px] font-semibold', u.portal ? 'bg-amber-100 text-amber-800' : 'bg-brand-100 text-brand-700')}>
        {u.name.split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase()}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-medium text-slate-900">{u.name}</span>
        <span className="block truncate text-[11.5px] text-slate-500">{u.designation ?? u.roles}</span>
      </span>
      {busy ? <Loader2 className="size-4 animate-spin text-slate-400" /> : active ? <Check className="size-4 text-brand-600" /> : null}
    </button>
  );
}

/** Floating "view as" control on every signed-in screen when the server runs in demo mode. */
export function DemoSwitcher() {
  const { user } = useAuth();
  const q = useDemoUsers();
  const { go, busy } = useSwitch();
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', esc); };
  }, [open]);
  const groups = useMemo(() => {
    const f = filter.trim().toLowerCase();
    const list = (q.data ?? []).filter((u) => !f || `${u.name} ${u.designation} ${u.roles} ${u.email}`.toLowerCase().includes(f));
    const out = new Map<string, DemoUser[]>();
    for (const u of list) out.set(groupOf(u), [...(out.get(groupOf(u)) ?? []), u]);
    return [...out.entries()];
  }, [q.data, filter]);
  if (!user || !q.data?.length) return null;
  return (
    <div ref={box} className="fixed right-4 bottom-4 z-[60] print:hidden">
      {open && (
        <div className="mb-2 flex max-h-[min(70vh,560px)] w-[320px] flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-2xl">
          <div className="flex items-center justify-between border-b border-slate-100 px-3.5 py-2.5">
            <div><p className="text-[13px] font-semibold text-slate-900">View the demo as…</p><p className="text-[11.5px] text-slate-500">Each person sees only what their role allows</p></div>
            <button onClick={() => setOpen(false)} className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700" aria-label="Close"><X className="size-4" /></button>
          </div>
          <div className="border-b border-slate-100 p-2">
            <div className="relative"><Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-slate-400" />
              <input autoFocus value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Find a role or person" className="input h-8 pl-8 text-[12.5px]" /></div>
          </div>
          <div className="overflow-y-auto p-1.5">
            {groups.map(([g, list]) => (
              <div key={g} className="mb-1">
                <p className="px-2.5 pt-2 pb-1 text-[10.5px] font-semibold tracking-wider text-slate-400 uppercase">{g}</p>
                {list.map((u) => <UserRow key={u.email} u={u} active={u.email.toLowerCase() === user.email.toLowerCase()} busy={busy === u.email} onPick={() => void go(u.email).then(() => setOpen(false))} />)}
              </div>
            ))}
          </div>
        </div>
      )}
      <button onClick={() => setOpen((o) => !o)}
        className="ml-auto flex items-center gap-2 rounded-full bg-slate-900 py-2 pr-3.5 pl-2.5 text-[12.5px] font-medium text-white shadow-lg ring-1 ring-white/10 transition hover:bg-slate-800">
        <span className="flex size-6 items-center justify-center rounded-full bg-amber-400 text-slate-900"><UsersRound className="size-3.5" /></span>
        <span className="max-w-[180px] truncate">Demo · {user.name}</span>
        <ChevronUp className={clsx('size-3.5 text-slate-400 transition', !open && 'rotate-180')} />
      </button>
    </div>
  );
}

/** One-click role cards on the sign-in page in demo mode. */
export function DemoLoginPanel() {
  const q = useDemoUsers();
  const { go, busy } = useSwitch();
  if (!q.data?.length) return null;
  const staff = q.data.filter((u) => !u.portal);
  const portal = q.data.filter((u) => u.portal);
  const card = (u: DemoUser) => (
    <button key={u.email} onClick={() => void go(u.email)} disabled={!!busy}
      className="flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-2.5 py-2 text-left transition hover:border-brand-300 hover:bg-brand-50/50 disabled:opacity-60">
      <span className="min-w-0 flex-1"><span className="block truncate text-[12.5px] font-medium text-slate-900">{u.designation ?? u.roles}</span><span className="block truncate text-[11px] text-slate-500">{u.name}</span></span>
      {busy === u.email && <Loader2 className="size-3.5 animate-spin text-slate-400" />}
    </button>
  );
  return (
    <div className="mt-8 border-t border-slate-200 pt-6">
      <p className="flex items-center gap-1.5 text-[12.5px] font-semibold text-slate-700"><UsersRound className="size-4 text-amber-500" /> Demo: sign in as</p>
      <p className="mt-0.5 mb-3 text-[11.5px] text-slate-500">No password needed on this demo. Switch roles any time from the button at the bottom right.</p>
      <div className="grid grid-cols-2 gap-1.5">{staff.map(card)}</div>
      {portal.length > 0 && <>
        <p className="mt-3 mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold tracking-wider text-slate-400 uppercase"><Building2 className="size-3.5" /> Partner portals</p>
        <div className="grid grid-cols-2 gap-1.5">{portal.map(card)}</div>
      </>}
    </div>
  );
}
