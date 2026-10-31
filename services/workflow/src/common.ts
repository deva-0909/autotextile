import type { Request } from 'express';
import { type Client, audit, callService, contextOf, publish } from '@erp/platform';

export const S = 'workflow';
export const round2 = (n: number) => Math.round(n * 100) / 100;
/** Base URL used in links sent to customers (payment, tracking, invoices). */
export const publicUrl = () => (process.env.APP_PUBLIC_URL ?? 'http://localhost:4000').replace(/\/$/, '');

const cache = new Map<string, { at: number; value: unknown }>();
export async function cached<T>(key: string, ttl: number, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.value as T;
  const value = await load();
  cache.set(key, { at: Date.now(), value });
  return value;
}
export async function setting<T>(key: string, fallback: T): Promise<T> {
  const all = await cached('settings', 30_000, () => callService<{ key: string; value: unknown }[]>(S, 'organisation', 'GET', '/settings').catch(() => []));
  return (all.find((s) => s.key === key)?.value as T) ?? fallback;
}
export interface Party { id: string; code: string; legal_name: string; party_type: string; email: string | null; phone: string | null; gstin: string | null }
export const getParty = (id: string) => cached(`party:${id}`, 30_000, () => callService<Party>(S, 'masters', 'GET', `/parties/${id}`));
export interface DirUser { id: string; name: string; email: string; status: string; party_id: string | null; permissions?: string[] }
export const directory = () => cached('dir', 30_000, () => callService<DirUser[]>(S, 'identity', 'GET', '/directory').catch(() => [] as DirUser[]));
export const companyName = () => cached('company', 300_000, async () => (await callService<{ legal_name: string; trade_name: string | null }[]>(S, 'organisation', 'GET', '/entities').catch(() => []))[0]?.trade_name ?? 'Demo Textile Trading');

export async function auditReq(c: Client, req: Request, entity: string, entityId: string, action: string, extra: { before?: unknown; after?: unknown; reason?: string | null } = {}) {
  await audit(c, S, contextOf(req), { entity, entityId, action, ...extra });
}
export async function requestApproval(c: Client, req: Request, p: { type: string; refId: string; title: string; summary: string | null; permission: string; payload: object }) {
  await publish(c, S, 'approval.requested', { source_service: S, approval_type: p.type, ref_id: p.refId, title: p.title, summary: p.summary, payload: p.payload, requested_by: req.user!.id, requested_by_name: req.user!.name, required_permission: p.permission });
}
export async function localNumber(c: Client, key: string, prefix: string) {
  const { rows: [r] } = await c.query(`INSERT INTO counters (doc_type, next_number) VALUES ($1, 2) ON CONFLICT (doc_type) DO UPDATE SET next_number = counters.next_number + 1 RETURNING next_number - 1 AS n`, [key]);
  return `${prefix}${String(r.n).padStart(5, '0')}`;
}
export const fmtMoney = (n: unknown) => Number(n ?? 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });
export const fmtDay = (d: unknown) => (d ? new Date(String(d)).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '');
