import type { Request } from 'express';
import { type AppError, type Client, type Pool, audit, badRequest, callService, contextOf, forbidden, inScope, notify, publish } from '@erp/platform';

export const S = 'inventory';
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

export interface Warehouse { id: string; code: string; name: string; city: string; gst_registration_id: string; gstin: string; state_code: string; status: string; dispatch_priority: number }
export interface Location { id: string; warehouse_id: string; parent_id: string | null; kind: 'zone' | 'aisle' | 'rack' | 'bin'; code: string; path: string; name: string | null; purpose: string; capacity_kg: number | null; status: string }
export interface Product { id: string; sku: string; name: string; category_id: string; category_name: string; hsn_code: string; gst_rate: number; status: string }
export interface Party { id: string; code: string; legal_name: string; party_type: string; gstin: string | null; status: string }

export const getWarehouses = () => cached('wh', 60_000, () => callService<Warehouse[]>(S, 'organisation', 'GET', '/warehouses'));
export async function getWarehouse(id: string) {
  const w = (await getWarehouses()).find((x) => x.id === id);
  if (!w || w.status !== 'active') throw badRequest('Choose an active warehouse', { fields: { warehouse_id: 'Unknown warehouse' } });
  return w;
}
export const whLabel = (w: { code: string; name: string }) => `${w.code} · ${w.name}`;
export const getLocations = (warehouseId: string) =>
  cached(`loc:${warehouseId}`, 30_000, () => callService<{ locations: Location[] }>(S, 'organisation', 'GET', `/warehouses/${warehouseId}`).then((w) => w.locations));
export const getProduct = (id: string) => cached(`product:${id}`, 60_000, () => callService<Product>(S, 'masters', 'GET', `/products/${id}`));
export const getParty = (id: string) => cached(`party:${id}`, 30_000, () => callService<Party>(S, 'masters', 'GET', `/parties/${id}`));

export async function setting<T>(key: string, fallback: T): Promise<T> {
  const all = await cached('settings', 30_000, () => callService<{ key: string; value: unknown }[]>(S, 'organisation', 'GET', '/settings').catch(() => []));
  return (all.find((s) => s.key === key)?.value as T) ?? fallback;
}

/** Number from the organisation series (per GSTIN when given); a local series if none is configured. */
export async function nextNumber(c: Client, docType: string, prefix: string, gstRegistrationId: string | null = null) {
  try {
    return (await callService<{ number: string }>(S, 'organisation', 'POST', '/number-series/next', { doc_type: docType, gst_registration_id: gstRegistrationId })).number;
  } catch (e) {
    if ((e as AppError).status !== 404) throw e;
    return localNumber(c, docType, prefix);
  }
}
export async function localNumber(c: Client, key: string, prefix: string, pad = 5) {
  const { rows: [r] } = await c.query(`INSERT INTO counters (doc_type, next_number) VALUES ($1, 2) ON CONFLICT (doc_type) DO UPDATE SET next_number = counters.next_number + 1 RETURNING next_number - 1 AS n`, [key]);
  return `${prefix}${String(r.n).padStart(pad, '0')}`;
}

export async function raiseException(c: Client, e: { kind: string; severity: 'info' | 'warning' | 'critical'; ref_type: string; ref_id: string; ref_label: string; message: string; notifyPermission?: string; link?: string }) {
  const r = await c.query(`INSERT INTO exceptions (kind, severity, ref_type, ref_id, ref_label, message) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (kind, ref_id) WHERE status = 'open' DO NOTHING RETURNING id`,
    [e.kind, e.severity, e.ref_type, e.ref_id, e.ref_label, e.message]);
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
  await publish(c, S, 'approval.requested', {
    source_service: S, approval_type: p.type, ref_id: p.refId, title: p.title, summary: p.summary, payload: p.payload,
    requested_by: req.user!.id, requested_by_name: req.user!.name, required_permission: p.permission,
  });
}

export const isoDate = /^\d{4}-\d{2}-\d{2}$/;
export const today = () => new Date().toISOString().slice(0, 10);
export const daysBetween = (from: string | Date, to: Date = new Date()) => Math.floor((to.getTime() - new Date(from).getTime()) / 86_400_000);
export type { Pool };

/** Warehouse data scope: a user limited to some warehouses can neither see nor move stock elsewhere. */
export function assertWarehouse(req: Request, warehouseId: string | null | undefined) {
  if (!inScope(req.user!, 'warehouse', warehouseId)) throw forbidden('This warehouse is outside your data scope');
}
