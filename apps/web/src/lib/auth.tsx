import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, onUnauthenticated, refreshSession, setAccessToken, type SessionUser } from './api';

interface AuthState {
  user: SessionUser | null;
  ready: boolean;
  mustChangePassword: boolean;
  can: (...codes: string[]) => boolean;
  /** Whether a menu page is in this person's menu (Overview pages always are). */
  sees: (path: string) => boolean;
  signIn: (result: { accessToken: string; user: SessionUser; mustChangePassword: boolean }) => void;
  signOut: () => Promise<void>;
  reload: () => Promise<void>;
  passwordChanged: () => void;
}

/** The Overview pages every signed-in person keeps. */
export const ALWAYS_SHOWN = ['/', '/approvals', '/my-work', '/me'];

const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [ready, setReady] = useState(false);
  const [mustChangePassword, setMust] = useState(false);
  const qc = useQueryClient();

  const reload = useCallback(async () => {
    const r = await refreshSession();
    setUser(r?.user ?? null);
    setMust(r?.mustChangePassword ?? false);
  }, []);

  useEffect(() => {
    reload().finally(() => setReady(true));
    onUnauthenticated(() => {
      setAccessToken(null);
      setUser(null);
    });
  }, [reload]);

  // Refresh shortly before the 15-minute access token expires.
  useEffect(() => {
    if (!user) return;
    const t = setInterval(() => void reload(), 12 * 60 * 1000);
    return () => clearInterval(t);
  }, [user, reload]);

  const value = useMemo<AuthState>(() => ({
    user,
    ready,
    mustChangePassword,
    can: (...codes) => !!user && codes.some((c) => user.permissions.includes(c) || user.permissions.includes('*')),
    sees: (path) => !!user && (ALWAYS_SHOWN.includes(path) || !user.menu || user.menu.includes(path)),
    signIn: (r) => {
      setAccessToken(r.accessToken);
      setUser(r.user);
      setMust(r.mustChangePassword);
    },
    signOut: async () => {
      await api.post('/identity/auth/logout').catch(() => {});
      setAccessToken(null);
      setUser(null);
      qc.clear();
    },
    reload,
    passwordChanged: () => setMust(false),
  }), [user, ready, mustChangePassword, qc, reload]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth() {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth outside AuthProvider');
  return v;
}
