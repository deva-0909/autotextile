import type { Request } from 'express';
import { type AppError, type Client, type Pool, audit, callService, contextOf, forbidden, hasPermission, notFound, notify, one, publish } from '@erp/platform';

export const S = 'crm';
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

export interface Party { id: string; code: string; legal_name: string; party_type: string; gstin: string | null; state_code: string | null; phone: string | null; email: string | null; owner_user_id: string | null; credit_limit: number | null; payment_term: string | null; status: string; segment: string | null }
export interface Product { id: string; sku: string; name: string; category_id: string; category_name: string; hsn_code: string; gst_rate: number; status: string }
export interface Lot { id: string; lot_no: string; product_id: string; sku: string; price_per_kg: number | null; cost_per_kg: number | null; kg: number; available_kg: number; qc_status: string; shade_code: string | null; dye_lot: string | null; warehouses: string[] | null }

export const getParty = (id: string) => cached(`party:${id}`, 20_000, () => callService<Party>(S, 'masters', 'GET', `/parties/${id}`));
export const getProduct = (id: string) => cached(`product:${id}`, 60_000, () => callService<Product>(S, 'masters', 'GET', `/products/${id}`));
export const getLot = (id: string) => callService<Lot & { summary: { kg: number; available_kg: number } }>(S, 'inventory', 'GET', `/lots/${id}`);
/** In-stock lots of a product, from inventory. */
export const lotsOf = (productId: string) =>
  callService<{ items: Lot[] }>(S, 'inventory', 'GET', `/lots?f_product=${productId}&f_in_stock=true&pageSize=50`).then((r) => r.items).catch(() => [] as Lot[]);
export const getDirectory = () => cached('dir', 30_000, () => callService<{ id: string; name: string; email: string; status: string; party_id: string | null }[]>(S, 'identity', 'GET', '/directory').catch(() => []));

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

export async function raiseException(c: Client, e: { kind: string; severity: 'info' | 'warning' | 'critical'; ref_type: string; ref_id: string; ref_label: string; message: string; notifyPermission?: string; notifyUser?: string | null; link?: string }) {
  const r = await c.query(`INSERT INTO exceptions (kind, severity, ref_type, ref_id, ref_label, message) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (kind, ref_id) WHERE status = 'open' DO NOTHING RETURNING id`,
    [e.kind, e.severity, e.ref_type, e.ref_id, e.ref_label, e.message]);
  if (r.rowCount && e.notifyPermission) await notify(c, S, { audience_permission: e.notifyPermission, kind: e.severity === 'critical' ? 'warning' : 'action', title: e.message, body: e.ref_label, link: e.link ?? null });
  if (r.rowCount && e.notifyUser) await notify(c, S, { user_id: e.notifyUser, kind: 'action', title: e.message, body: e.ref_label, link: e.link ?? null });
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

/** Salespeople see their own leads and quotes; managers with read_all see the team's. */
export const seesAll = (req: Request) => hasPermission(req.user, 'crm.lead.read_all');
export function assertOwnerOrAll(req: Request, ownerId: string | null, what = 'Lead') {
  if (seesAll(req) || hasPermission(req.user, 'crm.lead.assign') || ownerId === req.user!.id) return;
  throw notFound(what);
}
export const userId = (req: Request) => (req.user!.id.startsWith('svc:') ? null : req.user!.id);

/** Indian mobile numbers compared on their last 10 digits. */
export const normMobile = (v: unknown) => {
  if (v === null || v === undefined || v === '') return null;
  const d = String(v).replace(/\D/g, '');
  return d.length >= 10 ? d.slice(-10) : null;
};
export const normEmail = (v: unknown) => (typeof v === 'string' && v.includes('@') ? v.trim().toLowerCase() : null);
export const normGstin = (v: unknown) => (typeof v === 'string' && /^[0-9A-Z]{15}$/i.test(v.trim()) ? v.trim().toUpperCase() : null);

export const today = () => new Date().toISOString().slice(0, 10);
export const addDays = (iso: string, d: number) => {
  const x = new Date(`${iso}T00:00:00Z`);
  x.setUTCDate(x.getUTCDate() + d);
  return x.toISOString().slice(0, 10);
};

export async function leadOrThrow(c: Pool | Client, id: string, lock = false) {
  const l = await one<Lead>(c, `SELECT * FROM leads WHERE id::text = $1 OR number = $1${lock ? ' FOR UPDATE' : ''}`, [id]);
  if (!l) throw notFound('Lead');
  return l;
}

export interface Lead {
  id: string; number: string; source_id: string; source_code: string; source_ref: string | null; name: string; company: string | null; mobile: string | null; email: string | null; gstin: string | null;
  city: string | null; state_code: string | null; language: string | null; category: string | null; product_id: string | null; product_label: string | null; requirement_kg: number | null; est_value: number | null;
  message: string | null; stage: string; status: string; owner_id: string | null; owner_name: string | null; assigned_at: string | null; first_response_at: string | null; next_action_at: string | null; next_action: string | null;
  lost_reason: string | null; customer_id: string | null; customer_name: string | null; merged_into: string | null; duplicate_flag: boolean; created_at: string; version: number;
}

export { forbidden };

/** State (GST code) for cities lead platforms commonly send without a state; used only when no state or GSTIN is given. */
const CITY_STATE: Record<string, string> = {
  mumbai: '27', pune: '27', nagpur: '27', bhiwandi: '27', thane: '27', ichalkaranji: '27', delhi: '07', 'new delhi': '07', noida: '09', kanpur: '09', ghaziabad: '09', gurugram: '06', gurgaon: '06', panipat: '06', faridabad: '06',
  surat: '24', ahmedabad: '24', vadodara: '24', rajkot: '24', ludhiana: '03', amritsar: '03', jalandhar: '03', jaipur: '08', bhilwara: '08', indore: '23',
  tiruppur: '33', tirupur: '33', coimbatore: '33', chennai: '33', erode: '33', karur: '33', salem: '33', madurai: '33', palladam: '33', bengaluru: '29', bangalore: '29', mysuru: '29',
  hyderabad: '36', kochi: '32', ernakulam: '32', kolkata: '19', howrah: '19', bhubaneswar: '21', cuttack: '21', patna: '10', ranchi: '20', guwahati: '18',
};
export const stateOfCity = (city: string | null | undefined) => (city ? CITY_STATE[city.trim().toLowerCase()] ?? null : null);
