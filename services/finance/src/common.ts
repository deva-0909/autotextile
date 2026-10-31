import type { Request } from 'express';
import { type Client, type Pool, audit, callService, contextOf, notify, publish } from '@erp/platform';

export const S = 'finance';
export const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

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

export interface Party { id: string; code: string; legal_name: string; party_type: string; gstin: string | null; state_code: string | null; pan: string | null; status: string }
export const getParty = (id: string) => cached(`party:${id}`, 30_000, () => callService<Party>(S, 'masters', 'GET', `/parties/${id}`));

// ---------- books (one per GST registration) ----------
export interface Book { id: string; gst_registration_id: string; gstin: string; state_code: string; legal_entity_id: string; entity_name: string; code: string; name: string; is_primary: boolean }

/** Books mirror the organisation's GST registrations; new registrations get a book on first use. */
export async function syncBooks(c: Client | Pool): Promise<Book[]> {
  const regs = await callService<{ id: string; gstin: string; state_code: string; state_name: string; legal_entity_id: string; legal_name: string; entity_code: string; status: string }[]>(S, 'organisation', 'GET', '/gst-registrations');
  const ents = await callService<{ id: string; state_code: string | null }[]>(S, 'organisation', 'GET', '/entities').catch(() => []);
  for (const g of regs) {
    const hq = ents.find((e) => e.id === g.legal_entity_id)?.state_code === g.state_code;
    await c.query(`INSERT INTO books (gst_registration_id, gstin, state_code, legal_entity_id, entity_name, code, name, is_primary) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      ON CONFLICT (gst_registration_id) DO UPDATE SET entity_name = EXCLUDED.entity_name, name = EXCLUDED.name`,
      [g.id, g.gstin, g.state_code, g.legal_entity_id, g.legal_name, `${g.entity_code}-${g.state_code}`, `${g.legal_name} · ${g.state_name ?? g.state_code}`, hq]);
  }
  // Exactly one primary book per entity: the registered-office state, else the first.
  await c.query(`UPDATE books b SET is_primary = true WHERE NOT EXISTS (SELECT 1 FROM books x WHERE x.legal_entity_id = b.legal_entity_id AND x.is_primary)
    AND b.id = (SELECT id FROM books y WHERE y.legal_entity_id = b.legal_entity_id ORDER BY gstin LIMIT 1)`);
  const { rows } = await c.query<Book>('SELECT * FROM books ORDER BY is_primary DESC, gstin');
  return rows;
}
export async function books(c: Client | Pool): Promise<Book[]> {
  const { rows } = await c.query<Book>('SELECT * FROM books ORDER BY is_primary DESC, gstin');
  return rows.length ? rows : syncBooks(c);
}
export async function bookByGstin(c: Client | Pool, gstin: string | null | undefined): Promise<Book> {
  let all = await books(c);
  let b = all.find((x) => x.gstin === gstin);
  if (!b && gstin) { all = await syncBooks(c); b = all.find((x) => x.gstin === gstin); }
  return b ?? all.find((x) => x.is_primary) ?? all[0]!;
}
export async function bookByRegistration(c: Client | Pool, regId: string | null | undefined): Promise<Book> {
  const all = await books(c);
  return all.find((x) => x.gst_registration_id === regId) ?? all.find((x) => x.is_primary) ?? all[0]!;
}
export const primaryBook = async (c: Client | Pool) => { const all = await books(c); return all.find((x) => x.is_primary) ?? all[0]!; };

// ---------- dates ----------
/** Indian financial year code for a date, e.g. 2026-10-31 → "2627". */
export function fyOf(date: string) {
  const d = new Date(`${date.slice(0, 10)}T00:00:00Z`);
  const y = d.getUTCMonth() >= 3 ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
  return `${String(y).slice(2)}${String(y + 1).slice(2)}`;
}
export const fyStart = (fy: string) => `20${fy.slice(0, 2)}-04-01`;
export const fyEnd = (fy: string) => `20${fy.slice(2)}-03-31`;
export const monthOf = (date: string) => `${date.slice(0, 7)}-01`;
export function monthEnd(month: string) {
  const d = new Date(`${month.slice(0, 7)}-01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + 1); d.setUTCDate(0);
  return d.toISOString().slice(0, 10);
}
export function addDays(date: string, days: number) {
  const d = new Date(`${date.slice(0, 10)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
export const today = () => new Date().toISOString().slice(0, 10);

// ---------- anomalies, audit, approvals ----------
export async function raiseAnomaly(c: Client, a: { kind: string; severity: 'info' | 'warning' | 'critical'; ref_type: string; ref_id: string; ref_label: string; message: string; amount?: number | null }) {
  const r = await c.query(`INSERT INTO anomalies (kind, severity, ref_type, ref_id, ref_label, message, amount) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (kind, ref_id) WHERE status = 'open' DO NOTHING RETURNING id`,
    [a.kind, a.severity, a.ref_type, a.ref_id, a.ref_label, a.message, a.amount ?? null]);
  if (r.rowCount && a.severity !== 'info') await notify(c, S, { audience_permission: 'finance.anomaly.manage', kind: a.severity === 'critical' ? 'warning' : 'action', title: a.message, body: a.ref_label, link: '/finance/anomalies' });
  return !!r.rowCount;
}

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
