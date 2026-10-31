import type { Request } from 'express';
import { type AppError, type Client, audit, callService, contextOf, forbidden, inScope, notify, publish } from '@erp/platform';

export const S = 'fulfilment';
export const round2 = (n: number) => Math.round(n * 100) / 100;
export const round3 = (n: number) => Math.round(n * 1000) / 1000;

const cache = new Map<string, { at: number; value: unknown }>();
async function cached<T>(key: string, ttl: number, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.value as T;
  const value = await load();
  cache.set(key, { at: Date.now(), value });
  return value;
}

export interface Warehouse { id: string; code: string; name: string; city: string; state_code: string; gstin: string; gst_registration_id: string; dispatch_priority: number; status: string }
export const getWarehouses = () => cached('wh', 60_000, () => callService<Warehouse[]>(S, 'organisation', 'GET', '/warehouses').then((w) => w.filter((x) => x.status === 'active').sort((a, b) => a.dispatch_priority - b.dispatch_priority)));
export const getParty = (id: string) => cached(`party:${id}`, 30_000, () => callService<{ id: string; code: string; legal_name: string; party_type: string; gstin: string | null; state_code: string | null; status: string }>(S, 'masters', 'GET', `/parties/${id}`));

export async function setting<T>(key: string, fallback: T): Promise<T> {
  const all = await cached('settings', 30_000, () => callService<{ key: string; value: unknown }[]>(S, 'organisation', 'GET', '/settings').catch(() => []));
  return (all.find((s) => s.key === key)?.value as T) ?? fallback;
}

export async function nextNumber(c: Client, docType: string, prefix: string, gstRegistrationId: string | null = null) {
  try {
    return (await callService<{ number: string }>(S, 'organisation', 'POST', '/number-series/next', { doc_type: docType, gst_registration_id: gstRegistrationId })).number;
  } catch (e) {
    if ((e as AppError).status !== 404) throw e;
    return localNumber(c, docType, prefix);
  }
}
export async function localNumber(c: Client, key: string, prefix: string) {
  const { rows: [r] } = await c.query(`INSERT INTO counters (doc_type, next_number) VALUES ($1, 2) ON CONFLICT (doc_type) DO UPDATE SET next_number = counters.next_number + 1 RETURNING next_number - 1 AS n`, [key]);
  return `${prefix}${String(r.n).padStart(5, '0')}`;
}

export async function raiseException(c: Client, e: { kind: string; severity: 'info' | 'warning' | 'critical'; ref_type: string; ref_id: string; ref_label: string; message: string; notifyPermission?: string; link?: string }) {
  const r = await c.query(`INSERT INTO exceptions (kind, severity, ref_type, ref_id, ref_label, message) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (kind, ref_id) WHERE status = 'open' DO NOTHING RETURNING id`, [e.kind, e.severity, e.ref_type, e.ref_id, e.ref_label, e.message]);
  if (r.rowCount && e.notifyPermission) await notify(c, S, { audience_permission: e.notifyPermission, kind: e.severity === 'critical' ? 'warning' : 'action', title: e.message, body: e.ref_label, link: e.link ?? null });
  return !!r.rowCount;
}
export async function resolveException(c: Client, kind: string, refId: string, resolution: string) {
  await c.query(`UPDATE exceptions SET status = 'resolved', resolved_at = now(), resolved_by_name = 'system', resolution = $3 WHERE kind = $1 AND ref_id = $2 AND status = 'open'`, [kind, refId, resolution]);
}

export async function auditReq(c: Client, req: Request, entity: string, entityId: string, action: string, extra: { before?: unknown; after?: unknown; reason?: string | null } = {}) {
  await audit(c, S, contextOf(req), { entity, entityId, action, ...extra });
}
export async function requestApproval(c: Client, req: Request, p: { type: string; refId: string; title: string; summary: string | null; permission: string; payload: object }) {
  await publish(c, S, 'approval.requested', { source_service: S, approval_type: p.type, ref_id: p.refId, title: p.title, summary: p.summary, payload: p.payload, requested_by: req.user!.id, requested_by_name: req.user!.name, required_permission: p.permission });
}

export function assertWarehouse(req: Request, warehouseId: string) {
  if (!inScope(req.user!, 'warehouse', warehouseId)) throw forbidden('This warehouse is outside your data scope');
}

/** Tell a customer company’s portal users (order updates, dispatch, delivery). */
export async function notifyCustomer(c: Client, customerId: string, n: { title: string; body?: string | null; link?: string | null }) {
  const dir = await callService<{ id: string; party_id: string | null; status: string }[]>(S, 'identity', 'GET', '/directory').catch(() => []);
  for (const u of dir.filter((x) => x.party_id === customerId && x.status === 'active')) await notify(c, S, { user_id: u.id, kind: 'info', title: n.title, body: n.body ?? null, link: n.link ?? null });
}

/** India GST: same state → CGST + SGST, else IGST. */
export function gstSplit(tax: number, fromState: string, toState: string | null) {
  if (toState && fromState === toState) { const half = round2(tax / 2); return { cgst: half, sgst: round2(tax - half), igst: 0 }; }
  return { cgst: 0, sgst: 0, igst: round2(tax) };
}

/** Rough distance zones for freight and ETA estimates when no transporter rate exists. */
const ZONE: Record<string, string> = {
  '01': 'N', '02': 'N', '03': 'N', '04': 'N', '05': 'N', '06': 'N', '07': 'N', '08': 'N', '09': 'N',
  '24': 'W', '27': 'W', '30': 'W', '23': 'W', '22': 'W', '26': 'W',
  '29': 'S', '32': 'S', '33': 'S', '34': 'S', '36': 'S', '37': 'S',
  '10': 'E', '18': 'E', '19': 'E', '20': 'E', '21': 'E', '11': 'E', '12': 'E', '13': 'E', '14': 'E', '15': 'E', '16': 'E', '17': 'E',
};
export const distanceBand = (a: string, b: string | null) => (!b ? 2 : a === b ? 0 : ZONE[a] && ZONE[a] === ZONE[b] ? 1 : 2);
