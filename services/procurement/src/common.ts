import type { Request } from 'express';
import { type Client, type Pool, AppError, badRequest, callService, contextOf, audit, many, notify, one, publish } from '@erp/platform';

export const S = 'procurement';
export const round2 = (n: number) => Math.round(n * 100) / 100;

// ---------- lookups in other services (service-to-service, short caches) ----------
const cache = new Map<string, { at: number; value: unknown }>();
async function cached<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value as T;
  const value = await load();
  cache.set(key, { at: Date.now(), value });
  return value;
}
export const clearLookupCache = () => cache.clear();

export interface Party { id: string; code: string; legal_name: string; party_type: string; gstin: string | null; state_code: string | null; status: string; payment_term: string | null; payment_term_id: string | null; profile: Record<string, unknown>; bank_accounts?: { status: string }[] }
export interface Product { id: string; sku: string; name: string; hsn_code: string; gst_rate: number; status: string }
export interface GstReg { id: string; gstin: string; state_code: string; status: string }
export interface Warehouse { id: string; code: string; name: string; gst_registration_id: string; status: string }

export const getParty = (id: string) => cached(`party:${id}`, 30_000, () => callService<Party>(S, 'masters', 'GET', `/parties/${id}`));
export const getProduct = (id: string) => cached(`product:${id}`, 60_000, () => callService<Product>(S, 'masters', 'GET', `/products/${id}`));
export const getPaymentTerms = () => cached('terms', 60_000, () => callService<{ id: string; name: string; credit_days: number }[]>(S, 'masters', 'GET', '/payment-terms'));
export const getGstRegs = () => cached('gst', 60_000, () => callService<GstReg[]>(S, 'organisation', 'GET', '/gst-registrations'));
export const getWarehouses = () => cached('wh', 60_000, () => callService<Warehouse[]>(S, 'organisation', 'GET', '/warehouses'));
export async function findPartyByGstin(gstin: string) {
  const r = await callService<{ items: Party[] }>(S, 'masters', 'GET', `/parties?q=${encodeURIComponent(gstin)}&pageSize=5`);
  return r.items.find((p) => p.gstin === gstin.toUpperCase()) ?? null;
}

export async function setting<T>(key: string, fallback: T): Promise<T> {
  const all = await cached('settings', 30_000, () => callService<{ key: string; value: unknown }[]>(S, 'organisation', 'GET', '/settings').catch(() => []));
  const s = all.find((x) => x.key === key);
  return (s?.value as T) ?? fallback;
}

/** Document number from the organisation service; falls back to a local series if none is configured. */
export async function nextNumber(c: Client | Pool, docType: string, prefix: string, gstRegistrationId: string | null = null) {
  try {
    const r = await callService<{ number: string }>(S, 'organisation', 'POST', '/number-series/next', { doc_type: docType, gst_registration_id: gstRegistrationId });
    return r.number;
  } catch (e) {
    if ((e as AppError).status !== 404) throw e;
    const r = await one<{ n: number }>(c, `
      INSERT INTO counters (doc_type, next_number) VALUES ($1, 2)
      ON CONFLICT (doc_type) DO UPDATE SET next_number = counters.next_number + 1 RETURNING next_number - 1 AS n`, [docType]);
    return `${prefix}${String(r!.n).padStart(5, '0')}`;
  }
}

/** Where goods are delivered: one of our warehouses, or a processing mill (direct-to-mill). */
export async function resolveDestination(type: 'warehouse' | 'mill', id: string) {
  if (type === 'warehouse') {
    const w = (await getWarehouses()).find((x) => x.id === id);
    if (!w || w.status !== 'active') throw badRequest('Choose an active warehouse', { fields: { deliver_to_id: 'Unknown warehouse' } });
    return { name: `${w.code} · ${w.name}`, gstRegistrationId: w.gst_registration_id };
  }
  const m = await getParty(id).catch(() => null);
  if (!m || m.party_type !== 'mill' || m.status !== 'active') throw badRequest('Choose an active mill', { fields: { deliver_to_id: 'Unknown mill' } });
  return { name: `${m.code} · ${m.legal_name}`, gstRegistrationId: null };
}

/** CGST+SGST within a state, IGST across states. */
export function taxSplit(taxableByRate: { taxable: number; gst_rate: number }[], intra: boolean) {
  const tax = round2(taxableByRate.reduce((s, l) => s + (l.taxable * l.gst_rate) / 100, 0));
  return intra ? { cgst: round2(tax / 2), sgst: round2(tax / 2), igst: 0, tax } : { cgst: 0, sgst: 0, igst: tax, tax };
}

// ---------- exceptions ----------
export async function raiseException(c: Client, e: { kind: string; severity: 'info' | 'warning' | 'critical'; ref_type: string; ref_id: string; ref_label: string; message: string; notifyPermission?: string; link?: string }) {
  const r = await c.query(`
    INSERT INTO exceptions (kind, severity, ref_type, ref_id, ref_label, message) VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT (kind, ref_id) WHERE status = 'open' DO NOTHING RETURNING id`,
    [e.kind, e.severity, e.ref_type, e.ref_id, e.ref_label, e.message]);
  if (r.rowCount && e.notifyPermission)
    await notify(c, S, { audience_permission: e.notifyPermission, kind: e.severity === 'critical' ? 'warning' : 'action', title: e.message, body: e.ref_label, link: e.link ?? null });
  return !!r.rowCount;
}

export async function resolveExceptions(c: Client, kind: string, refId: string, resolution: string) {
  await c.query(`UPDATE exceptions SET status = 'resolved', resolved_at = now(), resolved_by_name = 'system', resolution = $3 WHERE kind = $1 AND ref_id = $2 AND status = 'open'`, [kind, refId, resolution]);
}

// ---------- timeline / audit helpers ----------
export async function poEvent(c: Client, poId: string, event: string, detail: string | null, actor: { type?: 'user' | 'supplier' | 'mill' | 'system'; name?: string | null } = {}) {
  await c.query('INSERT INTO po_events (po_id, event, detail, actor_type, actor_name) VALUES ($1, $2, $3, $4, $5)', [poId, event, detail, actor.type ?? 'user', actor.name ?? null]);
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

/** Portal users (supplier or mill) who act for a business partner. */
export async function portalUsers(partyId: string) {
  const dir = await callService<{ id: string; party_id: string | null; status: string }[]>(S, 'identity', 'GET', '/directory').catch(() => []);
  return dir.filter((u) => u.party_id === partyId && u.status === 'active').map((u) => u.id);
}

export async function linesOf<T>(c: Client | Pool, table: string, fk: string, id: string): Promise<T[]> {
  return many<T>(c, `SELECT * FROM ${table} WHERE ${fk} = $1 ORDER BY line_no`, [id]);
}
