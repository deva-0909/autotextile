/** API client: keeps the access token in memory and transparently refreshes it via the httpOnly refresh cookie. */
export interface ApiErrorBody { code: string; message: string; details?: { fields?: Record<string, string> } }

export class ApiError extends Error {
  status: number;
  code: string;
  fields: Record<string, string>;
  constructor(status: number, body: ApiErrorBody) {
    super(body.message);
    this.status = status;
    this.code = body.code;
    this.fields = body.details?.fields ?? {};
  }
}

let accessToken: string | null = null;
let refreshing: Promise<boolean> | null = null;
let onSessionLost: () => void = () => {};

export const setAccessToken = (t: string | null) => { accessToken = t; };
export const getAccessToken = () => accessToken;
export const onUnauthenticated = (fn: () => void) => { onSessionLost = fn; };

export async function refreshSession(): Promise<RefreshResult | null> {
  const r = await fetch('/api/identity/auth/refresh', { method: 'POST', credentials: 'same-origin' });
  if (!r.ok) return null;
  const body = (await r.json()) as RefreshResult;
  accessToken = body.accessToken;
  return body;
}

export interface RefreshResult { accessToken: string; user: SessionUser; mustChangePassword: boolean }
export interface SessionUser {
  id: string; name: string; email: string; roles: string[]; permissions: string[];
  scope: Record<'entity' | 'gstin' | 'branch' | 'warehouse', '*' | string[]>;
  partyId?: string | null;
  /** Pages shown in this person's menu (set by the owner or admin per role or user); null means every page they may open. */
  menu?: string[] | null;
}

type Body = BodyInit | object | undefined;

async function request<T>(method: string, path: string, body?: Body, headers: Record<string, string> = {}, retry = true): Promise<T> {
  const isRaw = body instanceof Blob || body instanceof ArrayBuffer;
  const res = await fetch(`/api${path}`, {
    method,
    credentials: 'same-origin',
    headers: {
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      ...(body !== undefined && !isRaw ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : isRaw ? (body as BodyInit) : JSON.stringify(body),
  });
  if (res.status === 401 && retry && !path.startsWith('/identity/auth/')) {
    refreshing ??= refreshSession().then((r) => !!r).finally(() => { refreshing = null; });
    if (await refreshing) return request<T>(method, path, body, headers, false);
    onSessionLost();
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: { code: 'network', message: `Request failed (${res.status})` } }));
    throw new ApiError(res.status, err.error ?? { code: 'unknown', message: 'Request failed' });
  }
  if (res.headers.get('content-type')?.includes('application/json')) return (await res.json()) as T;
  return (await res.blob()) as unknown as T;
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: Body, headers?: Record<string, string>) => request<T>('POST', path, body ?? {}, headers),
  patch: <T>(path: string, body: Body) => request<T>('PATCH', path, body),
  put: <T>(path: string, body: Body) => request<T>('PUT', path, body),
  delete: <T>(path: string) => request<T>('DELETE', path),
  blob: (path: string) => request<Blob>('GET', path),
};

export interface Page<T> { items: T[]; total: number; page: number; pageSize: number }

export function qs(params: Record<string, string | number | undefined | null>) {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') s.set(k, String(v));
  const str = s.toString();
  return str ? `?${str}` : '';
}

/** Invalidates every cached query whose first key segment starts with `prefix` (DataTable keys include the full URL). */
export function invalidatePrefix(qc: { invalidateQueries: (f: { predicate: (q: { queryKey: readonly unknown[] }) => boolean }) => unknown }, ...prefixes: string[]) {
  return qc.invalidateQueries({ predicate: (q) => prefixes.some((p) => String(q.queryKey[0]).startsWith(p)) });
}
