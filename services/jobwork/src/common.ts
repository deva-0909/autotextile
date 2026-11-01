import type { Request } from 'express';
import { type AppError, type Client, type Pool, audit, callService, contextOf, notify, publish } from '@erp/platform';

export const S = 'jobwork';
export const round2 = (n: number) => Math.round(n * 100) / 100;

const cache = new Map<string, { at: number; value: unknown }>();
async function cached<T>(key: string, ttl: number, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.value as T;
  const value = await load();
  cache.set(key, { at: Date.now(), value });
  return value;
}

export interface Party { id: string; code: string; legal_name: string; party_type: string; gstin: string | null; status: string; profile: Record<string, unknown> }
export interface Product { id: string; sku: string; name: string; category_id: string; category_name: string; status: string }
export const getParty = (id: string) => cached(`party:${id}`, 30_000, () => callService<Party>(S, 'masters', 'GET', `/parties/${id}`));
export const getProduct = (id: string) => cached(`product:${id}`, 60_000, () => callService<Product>(S, 'masters', 'GET', `/products/${id}`));
export const getWarehouses = () => cached('wh', 60_000, () => callService<{ id: string; code: string; name: string; status: string }[]>(S, 'organisation', 'GET', '/warehouses'));
export const listMills = () => cached('mills', 30_000, () => callService<{ items: Party[] }>(S, 'masters', 'GET', '/parties?f_type=mill&pageSize=200&sort=legal_name').then((r) => r.items));

export async function setting<T>(key: string, fallback: T): Promise<T> {
  const all = await cached('settings', 30_000, () => callService<{ key: string; value: unknown }[]>(S, 'organisation', 'GET', '/settings').catch(() => []));
  return (all.find((s) => s.key === key)?.value as T) ?? fallback;
}

export async function nextNumber(c: Client, docType: string, prefix: string) {
  try {
    return (await callService<{ number: string }>(S, 'organisation', 'POST', '/number-series/next', { doc_type: docType })).number;
  } catch (e) {
    if ((e as AppError).status !== 404) throw e;
    const { rows: [r] } = await c.query(`INSERT INTO counters (doc_type, next_number) VALUES ($1, 2) ON CONFLICT (doc_type) DO UPDATE SET next_number = counters.next_number + 1 RETURNING next_number - 1 AS n`, [docType]);
    return `${prefix}${String(r.n).padStart(5, '0')}`;
  }
}

export async function raiseException(c: Client, e: { kind: string; severity: 'info' | 'warning' | 'critical'; ref_id: string; ref_label: string; message: string; notifyPermission?: string; link?: string }) {
  const r = await c.query(`INSERT INTO exceptions (kind, severity, ref_type, ref_id, ref_label, message) VALUES ($1, $2, 'job_order', $3, $4, $5) ON CONFLICT (kind, ref_id) WHERE status = 'open' DO NOTHING RETURNING id`,
    [e.kind, e.severity, e.ref_id, e.ref_label, e.message]);
  if (r.rowCount && e.notifyPermission) await notify(c, S, { audience_permission: e.notifyPermission, kind: e.severity === 'critical' ? 'warning' : 'action', title: e.message, body: e.ref_label, link: e.link ?? null });
  return !!r.rowCount;
}
export async function resolveException(c: Client, kind: string, refId: string, resolution: string) {
  await c.query(`UPDATE exceptions SET status = 'resolved', resolved_at = now(), resolved_by_name = 'system', resolution = $3 WHERE kind = $1 AND ref_id = $2 AND status = 'open'`, [kind, refId, resolution]);
}

export async function auditReq(c: Client, req: Request, entity: string, entityId: string, action: string, extra: { before?: unknown; after?: unknown; reason?: string | null } = {}) {
  await audit(c, S, contextOf(req), { entity, entityId, action, ...extra });
}

export async function portalUsers(partyId: string) {
  const dir = await callService<{ id: string; party_id: string | null; status: string }[]>(S, 'identity', 'GET', '/directory').catch(() => []);
  return dir.filter((u) => u.party_id === partyId && u.status === 'active').map((u) => u.id);
}

export const addDays = (iso: string, days: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
export const today = () => new Date().toISOString().slice(0, 10);
export type { Pool };

/**
 * Tell Accounts what is held or deducted from a mill. Finance posts it to the mill's ledger straight away (so it is held
 * from payments), turns it into a debit note when confirmed, and reverses it when released.
 */
export async function millDeduction(c: Client, p: {
  key: string; mill_id: string; mill_name: string; kind: 'quality_claim' | 'shortage_claim' | 'quarantine'; source_id: string; ref: string; job_ref?: string | null;
  reason?: string | null; state: 'held' | 'confirmed' | 'released'; amount: number; expense_account?: 'purchases' | 'jobwork'; by?: string | null;
}) {
  await publish(c, S, 'jobwork.mill_deduction', { ...p, amount: Math.round(Number(p.amount) * 100) / 100, date: new Date().toISOString().slice(0, 10) });
}

/** Value of the fabric sent on a job order, per kg: its grey cost, or the set rate when the cost is not known. */
export async function greyRateOf(c: Client | Pool, jobOrderId: string) {
  const { rows: [r] } = await c.query(`SELECT (sum(l.kg_sent * s.cost_per_kg) / nullif(sum(l.kg_sent) FILTER (WHERE s.cost_per_kg IS NOT NULL), 0))::float AS rate
    FROM job_order_lines l LEFT JOIN mill_stock s ON s.id = l.mill_stock_id WHERE l.job_order_id = $1`, [jobOrderId]);
  const fallback = await setting('jobwork.shortage_rate_per_kg', 240);
  return Math.round(Number(r?.rate ?? fallback) * 100) / 100;
}
