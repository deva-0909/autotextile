import { config, type ServiceName } from './config.ts';
import { serviceUser, signAccessToken } from './auth.ts';
import { AppError } from './errors.ts';

let cached: { token: string; exp: number; for: string } | null = null;

/** Short-lived token identifying the calling service; holds every permission. */
async function serviceToken(caller: string) {
  if (cached && cached.for === caller && cached.exp > Date.now() + 30_000) return cached.token;
  const token = await signAccessToken(serviceUser(caller), '5m');
  cached = { token, exp: Date.now() + 5 * 60_000, for: caller };
  return token;
}

/** Override target ports (tests run services on random ports). */
const portOverrides: Partial<Record<ServiceName, number>> = {};
export function setServicePorts(ports: Partial<Record<ServiceName, number>>) {
  Object.assign(portOverrides, ports);
}
export const servicePort = (name: ServiceName) => portOverrides[name] ?? config.port(name);

/** Calls another service directly (not through the gateway) as the calling service. */
export async function callService<T>(caller: string, target: ServiceName, method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
  return send<T>(`Bearer ${await serviceToken(caller)}`, target, method, path, body, headers);
}

/**
 * Calls another service with the signed-in user's own token, so that service applies the user's permissions and
 * data scope. Used where results are shown back to that user (reports, dashboards, the assistant).
 */
export async function callAsUser<T>(authorization: string, target: ServiceName, method: string, path: string, body?: unknown): Promise<T> {
  return send<T>(authorization, target, method, path, body, {});
}

async function send<T>(authorization: string, target: ServiceName, method: string, path: string, body: unknown, headers: Record<string, string>): Promise<T> {
  const port = portOverrides[target] ?? config.port(target);
  const raw = body instanceof Buffer || body instanceof Uint8Array;
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: {
      authorization,
      ...(body !== undefined && !raw ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : raw ? new Blob([body as Uint8Array<ArrayBuffer>]) : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  }).catch(() => {
    throw new AppError(503, 'service_unavailable', `The ${target} service is not reachable`);
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => null)) as { error?: { code: string; message: string; details?: unknown } } | null;
    throw new AppError(res.status === 404 ? 404 : res.status >= 500 ? 502 : res.status, err?.error?.code ?? 'upstream_error', `${target}: ${err?.error?.message ?? res.statusText}`, err?.error?.details);
  }
  const type = res.headers.get('content-type') ?? '';
  return (type.includes('application/json') ? await res.json() : Buffer.from(await res.arrayBuffer())) as T;
}

