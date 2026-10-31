import type { Request } from 'express';
import { type Client, audit, contextOf, forbidden, hasPermission, one, publish } from '@erp/platform';

export const S = 'hrms';
export const today = () => new Date().toISOString().slice(0, 10);
export function fyOf(date: string) {
  const d = new Date(`${date.slice(0, 10)}T00:00:00Z`);
  const y = d.getUTCMonth() >= 3 ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
  return `${String(y).slice(2)}${String(y + 1).slice(2)}`;
}
export const daysIn = (month: string) => new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate();
export function eachDay(from: string, to: string) {
  const out: string[] = [];
  for (let d = new Date(`${from}T00:00:00Z`); d <= new Date(`${to}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1)) out.push(d.toISOString().slice(0, 10));
  return out;
}
export const dow = (day: string) => new Date(`${day}T00:00:00Z`).getUTCDay();

export async function auditReq(c: Client, req: Request, entity: string, entityId: string, action: string, extra: { before?: unknown; after?: unknown; reason?: string | null } = {}) {
  await audit(c, S, contextOf(req), { entity, entityId, action, ...extra });
}
export async function requestApproval(c: Client, req: Request, p: { type: string; refId: string; title: string; summary: string | null; permission: string; payload: object }) {
  await publish(c, S, 'approval.requested', { source_service: S, approval_type: p.type, ref_id: p.refId, title: p.title, summary: p.summary, payload: p.payload, requested_by: req.user!.id, requested_by_name: req.user!.name, required_permission: p.permission });
}
export async function localNumber(c: Client, key: string, prefix: string) {
  const { rows: [r] } = await c.query(`INSERT INTO counters (doc_type, next_number) VALUES ($1, 2) ON CONFLICT (doc_type) DO UPDATE SET next_number = counters.next_number + 1 RETURNING next_number - 1 AS n`, [key]);
  return `${prefix}${String(r.n).padStart(4, '0')}`;
}

export interface Employee { id: string; code: string; user_id: string | null; name: string; email: string | null; designation: string; department: string; location: string; status: string; weekly_off: number; pt_state: string; overtime_eligible: boolean; shift_id: string | null; manager_id: string | null; date_of_joining: string }
/** The employee record linked to the signed-in user, if any. */
export const selfEmployee = (c: Parameters<typeof one>[0], req: Request) => one<Employee>(c, 'SELECT * FROM employees WHERE user_id = $1', [req.user!.id]);
/** HR staff may act on anyone; others only on themselves. */
export async function assertSelfOr(c: Parameters<typeof one>[0], req: Request, employeeId: string, perm: string) {
  if (hasPermission(req.user, perm)) return;
  const me = await selfEmployee(c, req);
  if (me?.id !== employeeId) throw forbidden('You can only do this for yourself');
}
