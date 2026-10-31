import type { Router } from 'express';
import { z } from 'zod';
import { type Client, type ServiceContext, badRequest, conflict, hasPermission, many, notFound, one, optText, parse, publish, reqText, requirePermission, tx } from '@erp/platform';
import { S, assertSelfOr, auditReq, dow, eachDay, fyOf, localNumber, requestApproval, selfEmployee, today } from './common.ts';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Time as HH:MM (24-hour)');
type Status = 'present' | 'absent' | 'half_day' | 'leave' | 'weekly_off' | 'holiday';

/** Marks one day; works out lateness and overtime against the shift, credits comp-off for work on an off day, and tells CRM. */
async function mark(c: Client, e: { id: string; user_id: string | null; weekly_off: number; overtime_eligible: boolean; shift_id: string | null }, day: string, a: { status: Status; in_time?: string | null; out_time?: string | null; source: string; note?: string | null; lat?: number | null; lng?: number | null }, by: string) {
  const shift = e.shift_id ? await one<{ start_time: string; end_time: string; grace_minutes: number; hours: number }>(c, 'SELECT start_time::text, end_time::text, grace_minutes, hours::float FROM shifts WHERE id = $1', [e.shift_id]) : null;
  const mins = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
  let late = 0, ot = 0;
  if (shift && a.in_time && a.status === 'present') late = Math.max(0, mins(a.in_time) - mins(shift.start_time) - shift.grace_minutes);
  if (shift && a.in_time && a.out_time) ot = Math.max(0, mins(a.out_time) - mins(a.in_time) - shift.hours * 60 - 30);
  const holiday = await one(c, 'SELECT 1 FROM holidays WHERE day = $1', [day]);
  const offDay = dow(day) === e.weekly_off || !!holiday;
  await c.query(`INSERT INTO attendance (employee_id, day, status, in_time, out_time, late_minutes, overtime_minutes, source, lat, lng, note, marked_by_name) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
    ON CONFLICT (employee_id, day) DO UPDATE SET status = EXCLUDED.status, in_time = EXCLUDED.in_time, out_time = EXCLUDED.out_time, late_minutes = EXCLUDED.late_minutes, overtime_minutes = EXCLUDED.overtime_minutes, source = EXCLUDED.source, lat = EXCLUDED.lat, lng = EXCLUDED.lng, note = EXCLUDED.note, marked_by_name = EXCLUDED.marked_by_name, marked_at = now()`,
  [e.id, day, a.status, a.in_time ?? null, a.out_time ?? null, late, offDay && !e.overtime_eligible ? 0 : ot, a.source, a.lat ?? null, a.lng ?? null, a.note ?? null, by]);
  // Working on a weekly off or holiday earns a compensatory day off (valid 90 days) unless overtime is paid instead.
  if (offDay && !e.overtime_eligible && ['present', 'half_day'].includes(a.status))
    await c.query(`INSERT INTO comp_offs (employee_id, worked_on, days, expires_on) VALUES ($1,$2,$3, $2::date + 90) ON CONFLICT (employee_id, worked_on) DO UPDATE SET days = EXCLUDED.days`, [e.id, day, a.status === 'half_day' ? 0.5 : 1]);
  if (e.user_id) await publish(c, S, 'hrms.attendance.marked', { user_id: e.user_id, employee_id: e.id, day, status: a.status === 'holiday' ? 'weekly_off' : a.status });
}

/** Working days requested (weekly offs and holidays excluded). */
async function leaveDays(c: Client | ServiceContext['pool'], e: { weekly_off: number }, from: string, to: string, half: boolean) {
  const hol = new Set((await many<{ day: string }>(c, 'SELECT day::text FROM holidays WHERE day BETWEEN $1 AND $2', [from, to])).map((h) => h.day));
  const n = eachDay(from, to).filter((d) => dow(d) !== e.weekly_off && !hol.has(d)).length;
  return half ? Math.min(n, 0.5) : n;
}

export function timeRoutes(r: Router, { pool }: ServiceContext) {
  r.get('/shifts', async (_req, res) => { res.json(await many(pool, 'SELECT *, start_time::text, end_time::text FROM shifts ORDER BY code')); });
  r.get('/holidays', async (_req, res) => { res.json(await many(pool, `SELECT day::text, name, state_code FROM holidays WHERE day >= current_date - 365 ORDER BY day`)); });
  r.post('/holidays', requirePermission('hrms.attendance.manage'), async (req, res) => {
    const b = parse(z.object({ day: date, name: reqText(80), state_code: z.string().length(2).nullable().optional() }), req.body);
    await tx(pool, async (c) => { await c.query('INSERT INTO holidays (day, name, state_code) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [b.day, b.name, b.state_code ?? null]); await auditReq(c, req, 'holiday', b.day, 'added', { after: b }); });
    res.status(201).json({ ok: true });
  });

  /** Daily muster: everyone and their mark for the day (blank when not marked yet). */
  r.get('/attendance', requirePermission('hrms.read'), async (req, res) => {
    const day = (req.query.day as string) || today();
    res.json({ day, holiday: await one(pool, 'SELECT name FROM holidays WHERE day = $1', [day]), rows: await many(pool, `
      SELECT e.id AS employee_id, e.code, e.name, e.department, e.location, e.weekly_off, s.code AS shift, a.status, a.in_time::text, a.out_time::text, a.late_minutes, a.overtime_minutes, a.source, a.note,
        (extract(dow FROM $1::date) = e.weekly_off) AS is_weekly_off
      FROM employees e LEFT JOIN shifts s ON s.id = e.shift_id LEFT JOIN attendance a ON a.employee_id = e.id AND a.day = $1::date
      WHERE e.status <> 'exited' AND e.date_of_joining <= $1::date ORDER BY e.location, e.name`, [day]) });
  });

  r.put('/attendance', async (req, res) => {
    const b = parse(z.object({ day: date, entries: z.array(z.object({ employee_id: z.uuid(), status: z.enum(['present', 'absent', 'half_day', 'weekly_off', 'holiday']), in_time: time.nullable().optional(), out_time: time.nullable().optional(), note: optText(200) })).min(1).max(500) }), req.body);
    if (b.day > today()) throw badRequest('Attendance cannot be marked for a future date');
    const hr = hasPermission(req.user, 'hrms.attendance.manage');
    await tx(pool, async (c) => {
      for (const x of b.entries) {
        if (!hr) await assertSelfOr(c, req, x.employee_id, 'hrms.attendance.manage');
        const e = await one<{ id: string; user_id: string | null; weekly_off: number; overtime_eligible: boolean; shift_id: string | null; status: string }>(c, 'SELECT * FROM employees WHERE id = $1', [x.employee_id]);
        if (!e || e.status === 'exited') throw notFound('Employee');
        const cur = await one<{ status: string }>(c, 'SELECT status FROM attendance WHERE employee_id = $1 AND day = $2', [e.id, b.day]);
        if (cur?.status === 'leave') continue; // approved leave stands until the leave is cancelled
        await mark(c, e, b.day, { status: x.status, in_time: x.in_time, out_time: x.out_time, note: x.note, source: 'manual' }, req.user!.name);
      }
      await auditReq(c, req, 'attendance', b.day, 'marked', { after: { entries: b.entries.length } });
    });
    res.json({ ok: true });
  });

  /** Self check-in / check-out from the phone (location optional; the server records the time). */
  r.post('/me/punch', async (req, res) => {
    const b = parse(z.object({ kind: z.enum(['in', 'out']), lat: z.number().min(-90).max(90).nullable().optional(), lng: z.number().min(-180).max(180).nullable().optional() }), req.body);
    const out = await tx(pool, async (c) => {
      const e = await selfEmployee(c, req);
      if (!e) throw notFound('No employee record is linked to your login');
      const now = new Date(Date.now() + 330 * 60_000); // IST
      const day = now.toISOString().slice(0, 10), t = now.toISOString().slice(11, 16);
      const cur = await one<{ in_time: string | null; status: string }>(c, 'SELECT in_time::text, status FROM attendance WHERE employee_id = $1 AND day = $2', [e.id, day]);
      if (cur?.status === 'leave') throw conflict('You are on approved leave today');
      if (b.kind === 'in' && cur?.in_time) throw conflict(`Already checked in at ${cur.in_time.slice(0, 5)}`);
      if (b.kind === 'out' && !cur?.in_time) throw conflict('Check in first');
      await mark(c, e, day, { status: 'present', in_time: b.kind === 'in' ? t : cur!.in_time!.slice(0, 5), out_time: b.kind === 'out' ? t : null, source: 'mobile', lat: b.lat, lng: b.lng }, e.name);
      return { day, time: t };
    });
    res.json(out);
  });

  // ----- leave -----
  r.get('/leave-types', async (_req, res) => { res.json(await many(pool, 'SELECT *, annual_quota::float FROM leave_types ORDER BY code')); });
  r.get('/leave', requirePermission('hrms.read'), async (req, res) => {
    res.json(await many(pool, `SELECT l.*, l.from_date::text, l.to_date::text, l.days::float, e.name AS employee_name, e.code AS employee_code, e.department FROM leave_requests l JOIN employees e ON e.id = l.employee_id
      WHERE ($1::text IS NULL OR l.status = ANY(string_to_array($1, ','))) ORDER BY l.created_at DESC LIMIT 300`, [req.query.status ?? null]));
  });

  r.post('/leave', async (req, res) => {
    const b = parse(z.object({ employee_id: z.uuid().optional(), leave_type: z.string(), from_date: date, to_date: date, half_day: z.boolean().default(false), reason: reqText(500) }), req.body);
    const out = await tx(pool, async (c) => {
      const me = await selfEmployee(c, req);
      const empId = b.employee_id ?? me?.id;
      if (!empId) throw badRequest('No employee record is linked to your login');
      await assertSelfOr(c, req, empId, 'hrms.attendance.manage');
      const e = await one<{ id: string; name: string; weekly_off: number; status: string }>(c, 'SELECT * FROM employees WHERE id = $1', [empId]);
      if (!e || e.status === 'exited') throw notFound('Employee');
      if (b.to_date < b.from_date) throw badRequest('The end date is before the start date');
      const days = await leaveDays(c, e, b.from_date, b.to_date, b.half_day);
      if (days <= 0) throw badRequest('Those dates are all weekly offs or holidays');
      if (await one(c, `SELECT 1 FROM leave_requests WHERE employee_id = $1 AND status IN ('pending','approved') AND from_date <= $3 AND to_date >= $2`, [e.id, b.from_date, b.to_date])) throw conflict('There is already leave for some of these dates');
      if (b.leave_type === 'CO') {
        const avail = Number((await one<{ d: number }>(c, `SELECT coalesce(sum(days), 0)::float AS d FROM comp_offs WHERE employee_id = $1 AND status = 'available' AND expires_on >= $2`, [e.id, b.from_date]))!.d);
        if (avail < days) throw badRequest(`Only ${avail} comp-off day(s) available`);
      } else if (b.leave_type !== 'LOP') {
        const bal = await one<{ entitled: number; used: number }>(c, 'SELECT entitled::float, used::float FROM leave_balances WHERE employee_id = $1 AND leave_type = $2 AND fy = $3', [e.id, b.leave_type, fyOf(b.from_date)]);
        const pending = Number((await one<{ d: number }>(c, `SELECT coalesce(sum(days), 0)::float AS d FROM leave_requests WHERE employee_id = $1 AND leave_type = $2 AND status = 'pending'`, [e.id, b.leave_type]))!.d);
        const left = (bal?.entitled ?? 0) - (bal?.used ?? 0) - pending;
        if (left < days) throw badRequest(`Only ${left} day(s) of ${b.leave_type} left; apply the rest as leave without pay`);
      }
      const number = await localNumber(c, 'leave', 'LV-');
      const l = await one<{ id: string }>(c, `INSERT INTO leave_requests (number, employee_id, leave_type, from_date, to_date, half_day, days, reason, applied_by_name) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [number, e.id, b.leave_type, b.from_date, b.to_date, b.half_day, days, b.reason, req.user!.name]);
      await requestApproval(c, req, { type: 'leave_request', refId: l!.id, permission: 'hrms.leave.approve', title: `Leave ${number}: ${e.name}, ${days} day(s) ${b.leave_type}`, summary: `${b.from_date} to ${b.to_date}: ${b.reason}`, payload: { employee: e.name, type: b.leave_type, from: b.from_date, to: b.to_date, days } });
      await auditReq(c, req, 'leave_request', l!.id, 'applied', { after: { ...b, days } });
      return { id: l!.id, number, days };
    });
    res.status(201).json(out);
  });

  r.post('/leave/:id/cancel', async (req, res) => {
    const { reason } = parse(z.object({ reason: reqText(300) }), req.body);
    await tx(pool, async (c) => {
      const l = await one<{ id: string; employee_id: string; status: string; leave_type: string; from_date: string; to_date: string; days: number }>(c, 'SELECT *, from_date::text, to_date::text, days::float FROM leave_requests WHERE id = $1 FOR UPDATE', [req.params.id]);
      if (!l) throw notFound('Leave');
      await assertSelfOr(c, req, l.employee_id, 'hrms.attendance.manage');
      if (!['pending', 'approved'].includes(l.status)) throw conflict(`This leave is ${l.status}`);
      if (l.status === 'approved') {
        if (l.from_date <= today()) throw conflict('Leave that has started cannot be cancelled; mark attendance instead');
        await c.query(`DELETE FROM attendance WHERE employee_id = $1 AND day BETWEEN $2 AND $3 AND status = 'leave'`, [l.employee_id, l.from_date, l.to_date]);
        if (l.leave_type === 'CO') await c.query(`UPDATE comp_offs SET status = 'available' WHERE employee_id = $1 AND status = 'used' AND id IN (SELECT id FROM comp_offs WHERE employee_id = $1 AND status = 'used' ORDER BY worked_on DESC LIMIT $2)`, [l.employee_id, Math.ceil(l.days)]);
        else await c.query(`UPDATE leave_balances SET used = used - $3 WHERE employee_id = $1 AND leave_type = $2 AND fy = $4`, [l.employee_id, l.leave_type, l.days, fyOf(l.from_date)]);
      }
      await c.query(`UPDATE leave_requests SET status = 'cancelled', comment = $2 WHERE id = $1`, [l.id, reason]);
      await auditReq(c, req, 'leave_request', l.id, 'cancelled', { reason });
    });
    res.json({ ok: true });
  });

  /** Self-service: my profile summary, this month's attendance, balances, leave and payslips. */
  r.get('/me', async (req, res) => {
    const e = await selfEmployee(pool, req);
    if (!e) { res.json({ employee: null }); return; }
    const [att, bal, leaves, slips, comp, types] = await Promise.all([
      many(pool, `SELECT day::text, status, in_time::text, out_time::text, late_minutes, overtime_minutes FROM attendance WHERE employee_id = $1 AND day >= date_trunc('month', current_date) - interval '1 month' ORDER BY day DESC`, [e.id]),
      many(pool, `SELECT b.leave_type, t.name, b.entitled::float, b.used::float FROM leave_balances b JOIN leave_types t ON t.code = b.leave_type WHERE b.employee_id = $1 AND b.fy = $2 ORDER BY b.leave_type`, [e.id, fyOf(today())]),
      many(pool, `SELECT id, number, leave_type, from_date::text, to_date::text, days::float, status, reason FROM leave_requests WHERE employee_id = $1 ORDER BY created_at DESC LIMIT 20`, [e.id]),
      many(pool, `SELECT p.id, r.month::text, p.gross::float, p.net::float, r.status FROM payslips p JOIN payroll_runs r ON r.id = p.run_id WHERE p.employee_id = $1 AND r.status IN ('approved','paid') ORDER BY r.month DESC`, [e.id]),
      one(pool, `SELECT coalesce(sum(days), 0)::float AS available FROM comp_offs WHERE employee_id = $1 AND status = 'available' AND expires_on >= current_date`, [e.id]),
      many(pool, 'SELECT code, name FROM leave_types ORDER BY code'),
    ]);
    res.json({ employee: e, attendance: att, balances: bal, leaves, payslips: slips, comp_off: comp, leave_types: types });
  });
}

/** Checker decision on leave: mark the days, use the balance or comp-off, and tell CRM (allocation skips people on leave). */
export async function applyLeaveDecision(c: Client, p: { ref_id: string; decision: string; decided_by_name: string; comment: string | null }) {
  const l = await one<{ id: string; employee_id: string; status: string; leave_type: string; from_date: string; to_date: string; days: number; half_day: boolean }>(c, 'SELECT *, from_date::text, to_date::text, days::float FROM leave_requests WHERE id = $1 FOR UPDATE', [p.ref_id]);
  if (!l || l.status !== 'pending') return;
  if (p.decision !== 'approved') { await c.query(`UPDATE leave_requests SET status = 'rejected', decided_by_name = $2, decided_at = now(), comment = $3 WHERE id = $1`, [l.id, p.decided_by_name, p.comment]); return; }
  const e = (await one<{ id: string; name: string; user_id: string | null; weekly_off: number; overtime_eligible: boolean; shift_id: string | null }>(c, 'SELECT * FROM employees WHERE id = $1', [l.employee_id]))!;
  const hol = new Set((await many<{ day: string }>(c, 'SELECT day::text FROM holidays WHERE day BETWEEN $1 AND $2', [l.from_date, l.to_date])).map((h) => h.day));
  for (const d of eachDay(l.from_date, l.to_date).filter((x) => dow(x) !== e.weekly_off && !hol.has(x)))
    await c.query(`INSERT INTO attendance (employee_id, day, status, source, note, marked_by_name) VALUES ($1,$2,$3,'leave',$4,$5) ON CONFLICT (employee_id, day) DO UPDATE SET status = EXCLUDED.status, source = 'leave', note = EXCLUDED.note, marked_by_name = EXCLUDED.marked_by_name, marked_at = now()`,
      [e.id, d, l.half_day ? 'half_day' : l.leave_type === 'LOP' ? 'absent' : 'leave', `${l.leave_type} leave`, p.decided_by_name]);
  if (l.leave_type === 'CO') await c.query(`UPDATE comp_offs SET status = 'used' WHERE id IN (SELECT id FROM comp_offs WHERE employee_id = $1 AND status = 'available' ORDER BY worked_on LIMIT $2)`, [e.id, Math.ceil(l.days)]);
  else if (l.leave_type !== 'LOP') await c.query(`UPDATE leave_balances SET used = used + $3 WHERE employee_id = $1 AND leave_type = $2 AND fy = $4`, [e.id, l.leave_type, l.days, fyOf(l.from_date)]);
  await c.query(`UPDATE leave_requests SET status = 'approved', decided_by_name = $2, decided_at = now(), comment = $3 WHERE id = $1`, [l.id, p.decided_by_name, p.comment]);
  await publish(c, S, 'hrms.leave.approved', { leave_id: l.id, employee_id: e.id, user_id: e.user_id, employee_name: e.name, from: l.from_date, to: l.to_date, days: l.days, leave_type: l.leave_type, half_day: l.half_day });
}
