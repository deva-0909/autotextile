import type { Request } from 'express';
import { type AppError, type Client, type Pool, audit, callService, contextOf, forbidden, hasPermission, notFound, notify, one, publish } from '@erp/platform';

export const S = 'commerce';
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

export interface Party { id: string; code: string; legal_name: string; party_type: string; gstin: string | null; state_code: string | null; phone: string | null; email: string | null; status: string; addresses?: { kind: string; line1: string; city: string; pincode: string | null; is_default: boolean }[] }
export interface Product { id: string; sku: string; name: string; category_id: string; category_name: string; hsn_code: string; gst_rate: number; min_order_qty: number | null; status: string; attributes: Record<string, unknown>; description: string | null }
export interface Lot { id: string; lot_no: string; product_id: string; sku: string; product_name: string; price_per_kg: number | null; cost_per_kg: number | null; kg: number; available_kg: number; qc_status: string; grade: string | null; shade_code: string | null; dye_lot: string | null; warehouses: string[] | null; received_date: string }

export const getParty = (id: string) => cached(`party:${id}`, 20_000, () => callService<Party>(S, 'masters', 'GET', `/parties/${id}`));
export const getProduct = (id: string) => cached(`product:${id}`, 60_000, () => callService<Product>(S, 'masters', 'GET', `/products/${id}`));
export const listProducts = () => cached('products', 60_000, () => callService<{ items: Product[] }>(S, 'masters', 'GET', '/products?pageSize=200&sort=sku').then((r) => r.items));
export const getLot = (id: string) => callService<Lot & { summary: { kg: number; available_kg: number } }>(S, 'inventory', 'GET', `/lots/${id}`);
/** Lots that can be sold: in stock, QC passed (fully or partly) and carrying a selling price. */
export const sellableLots = () => cached('lots', 15_000, () => callService<{ items: Lot[] }>(S, 'inventory', 'GET', '/lots?f_in_stock=true&pageSize=200&sort=received_date&dir=asc').then((r) => r.items.filter((l) => Number(l.available_kg) > 0 && ['passed', 'partial'].includes(l.qc_status) && l.price_per_kg !== null)));
export const clearLotCache = () => cache.delete('lots');
export const getWarehouses = () => cached('wh', 60_000, () => callService<{ id: string; code: string; name: string; city: string; state_code: string; gstin: string }[]>(S, 'organisation', 'GET', '/warehouses'));

export async function setting<T>(key: string, fallback: T): Promise<T> {
  const all = await cached('settings', 30_000, () => callService<{ key: string; value: unknown }[]>(S, 'organisation', 'GET', '/settings').catch(() => []));
  return (all.find((s) => s.key === key)?.value as T) ?? fallback;
}

export async function nextNumber(c: Client, docType: string, prefix: string) {
  try {
    return (await callService<{ number: string }>(S, 'organisation', 'POST', '/number-series/next', { doc_type: docType })).number;
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

export const userId = (req: Request) => (req.user!.id.startsWith('svc:') ? null : req.user!.id);
/** Customer portal users act for exactly one customer (their party). */
export function portalCustomer(req: Request) {
  const id = req.user!.partyId;
  if (!id) throw forbidden('Customer portal only');
  return id;
}
/** Internal users with commerce.read see everything; portal users only their own company. */
export function assertCustomerAccess(req: Request, customerId: string, what = 'Order') {
  if (req.user!.partyId) { if (req.user!.partyId !== customerId) throw notFound(what); return; }
  if (!hasPermission(req.user, 'commerce.read')) throw notFound(what);
}

export async function walletBalance(c: Pool | Client, customerId: string) {
  return Number((await one<{ b: number }>(c, 'SELECT coalesce(sum(amount), 0)::float AS b FROM wallet_ledger WHERE customer_id = $1', [customerId]))!.b);
}
export async function walletEntry(c: Client, e: { customer_id: string; customer_name: string; entry_type: string; amount: number; order_id?: string | null; ref_type?: string | null; ref_no?: string | null; narration?: string | null; by_name: string }) {
  await c.query(`INSERT INTO wallet_ledger (customer_id, customer_name, entry_type, amount, order_id, ref_type, ref_no, narration, by_name) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [e.customer_id, e.customer_name, e.entry_type, round2(e.amount), e.order_id ?? null, e.ref_type ?? null, e.ref_no ?? null, e.narration ?? null, e.by_name]);
}

export const isoDate = /^\d{4}-\d{2}-\d{2}$/;
export const today = () => new Date().toISOString().slice(0, 10);
