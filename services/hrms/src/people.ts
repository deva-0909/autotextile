import type { Router } from 'express';
import { z } from 'zod';
import { type ServiceContext, badRequest, callService, conflict, hasPermission, many, notFound, one, optText, parse, publish, reqText, requirePermission, tx } from '@erp/platform';
import { S, assertSelfOr, auditReq, fyOf, localNumber, selfEmployee, today } from './common.ts';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const ONBOARDING = ['Offer letter signed', 'ID and address proof', 'PAN and Aadhaar', 'Bank account details', 'PF nomination (Form 2) / UAN', 'ESIC declaration (if eligible)', 'Login and system access', 'Safety induction (warehouse)'];
const EXIT = ['Resignation accepted', 'Handover of leads, tasks and customers', 'Return laptop, phone, ID card and keys', 'Revoke system access', 'Full and final settlement', 'Relieving and experience letter'];

const empBody = z.object({
  name: reqText(120), email: z.email().nullable().optional(), phone: optText(20), designation: reqText(80), department: reqText(60), location: reqText(60),
  manager_id: z.uuid().nullable().optional(), date_of_joining: date, probation_months: z.number().int().min(0).max(12).default(6),
  pan: z.string().trim().toUpperCase().regex(/^[A-Z]{5}[0-9]{4}[A-Z]$/).nullable().optional(), uan: optText(20), esic_no: optText(20), bank_account: optText(30), ifsc: z.string().trim().toUpperCase().regex(/^[A-Z]{4}0[A-Z0-9]{6}$/).nullable().optional(),
  shift_code: z.string().default('GEN'), weekly_off: z.number().int().min(0).max(6).default(0), pt_state: z.string().length(2).default('24'), overtime_eligible: z.boolean().default(false), user_id: z.uuid().nullable().optional(),
});
const salaryBody = z.object({ effective_from: date, basic: z.number().min(0), hra: z.number().min(0).default(0), conveyance: z.number().min(0).default(0), special: z.number().min(0).default(0), other: z.number().min(0).default(0), pf_applicable: z.boolean().default(true), pf_on_capped_wage: z.boolean().default(true) });

export async function grantLeave(c: Parameters<typeof one>[0], employeeId: string, doj: string) {
  const fy = fyOf(today());
  const types = await many<{ code: string; annual_quota: number }>(c, 'SELECT code, annual_quota::float FROM leave_types WHERE annual_quota > 0');
  // Pro-rata entitlement for joiners during the year.
  const start = new Date(`20${fy.slice(0, 2)}-04-01T00:00:00Z`), j = new Date(`${doj}T00:00:00Z`);
  const months = j > start ? 12 - ((j.getUTCFullYear() - start.getUTCFullYear()) * 12 + j.getUTCMonth() - start.getUTCMonth()) : 12;
  for (const t of types) await c.query(`INSERT INTO leave_balances (employee_id, leave_type, fy, entitled) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`, [employeeId, t.code, fy, Math.round((t.annual_quota * Math.max(0, months)) / 12 * 2) / 2]);
}

export function peopleRoutes(r: Router, { pool }: ServiceContext) {
  r.get('/dashboard', requirePermission('hrms.read'), async (_req, res) => {
    res.json(await one(pool, `SELECT
      (SELECT count(*)::int FROM employees WHERE status <> 'exited') AS headcount,
      (SELECT count(*)::int FROM employees WHERE status IN ('onboarding','probation')) AS on_probation,
      (SELECT count(*)::int FROM employees WHERE status = 'notice') AS on_notice,
      (SELECT count(*)::int FROM attendance WHERE day = current_date AND status IN ('present','half_day')) AS present_today,
      (SELECT count(*)::int FROM attendance WHERE day = current_date AND status = 'leave') AS on_leave_today,
      (SELECT count(*)::int FROM employees e WHERE status <> 'exited' AND NOT EXISTS (SELECT 1 FROM attendance a WHERE a.employee_id = e.id AND a.day = current_date)) AS unmarked_today,
      (SELECT count(*)::int FROM leave_requests WHERE status = 'pending') AS leave_pending,
      (SELECT count(*)::int FROM employees WHERE status = 'probation' AND date_of_joining + make_interval(months => probation_months) <= current_date + 15) AS confirmations_due,
      (SELECT count(*)::int FROM candidates WHERE stage IN ('applied','screening','interview','offer')) AS candidates_open,
      (SELECT row_to_json(p) FROM (SELECT month::text, status, net::float, employees FROM payroll_runs ORDER BY month DESC LIMIT 1) p) AS last_payroll,
      (SELECT json_agg(d) FROM (SELECT department, count(*)::int AS n FROM employees WHERE status <> 'exited' GROUP BY department ORDER BY 2 DESC) d) AS by_department`));
  });

  r.get('/employees', requirePermission('hrms.read'), async (req, res) => {
    const st = (req.query.status as string) || 'onboarding,probation,active,notice';
    res.json(await many(pool, `SELECT e.id, e.code, e.name, e.designation, e.department, e.location, e.status, e.date_of_joining::text, e.user_id, m.name AS manager_name, s.code AS shift,
      (SELECT status FROM attendance a WHERE a.employee_id = e.id AND a.day = current_date) AS today
      FROM employees e LEFT JOIN employees m ON m.id = e.manager_id LEFT JOIN shifts s ON s.id = e.shift_id WHERE e.status = ANY($1) ORDER BY e.department, e.name`, [st.split(',')]));
  });

  r.get('/employees/:id', async (req, res) => {
    const e = await one<{ id: string }>(pool, `SELECT e.*, e.date_of_joining::text, e.confirmed_on::text, e.last_working_day::text, m.name AS manager_name, s.code AS shift_code, s.name AS shift_name FROM employees e LEFT JOIN employees m ON m.id = e.manager_id LEFT JOIN shifts s ON s.id = e.shift_id WHERE e.id::text = $1 OR e.code = $1`, [req.params.id]);
    if (!e) throw notFound('Employee');
    await assertSelfOr(pool, req, e.id, 'hrms.read');
    const canPay = hasPermission(req.user, 'hrms.payroll.manage');
    const [events, checklist, salary, balances, leaves, att] = await Promise.all([
      many(pool, 'SELECT * FROM employee_events WHERE employee_id = $1 ORDER BY at DESC', [e.id]),
      many(pool, 'SELECT * FROM checklist WHERE employee_id = $1 ORDER BY stage, item', [e.id]),
      canPay || (await selfEmployee(pool, req))?.id === e.id ? many(pool, 'SELECT s.*, s.effective_from::text, s.basic::float, s.hra::float, s.conveyance::float, s.special::float, s.other::float FROM salary_structures s WHERE s.employee_id = $1 ORDER BY s.effective_from DESC', [e.id]) : Promise.resolve([]),
      many(pool, `SELECT b.*, t.name, b.entitled::float, b.used::float FROM leave_balances b JOIN leave_types t ON t.code = b.leave_type WHERE employee_id = $1 AND fy = $2 ORDER BY leave_type`, [e.id, fyOf(today())]),
      many(pool, 'SELECT *, from_date::text, to_date::text, days::float FROM leave_requests WHERE employee_id = $1 ORDER BY created_at DESC LIMIT 20', [e.id]),
      many(pool, `SELECT day::text, status, in_time::text, out_time::text, late_minutes, overtime_minutes, source FROM attendance WHERE employee_id = $1 AND day >= current_date - 45 ORDER BY day DESC`, [e.id]),
    ]);
    const comp = await one(pool, `SELECT coalesce(sum(days), 0)::float AS available FROM comp_offs WHERE employee_id = $1 AND status = 'available' AND expires_on >= current_date`, [e.id]);
    res.json({ ...e, events, checklist, salary, balances, leaves, attendance: att, comp_off: comp });
  });

  r.post('/employees', requirePermission('hrms.employee.manage'), async (req, res) => {
    const b = parse(empBody, req.body);
    const out = await tx(pool, async (c) => {
      if (b.user_id && await one(c, 'SELECT 1 FROM employees WHERE user_id = $1', [b.user_id])) throw conflict('That login is already linked to an employee');
      const shift = await one<{ id: string }>(c, 'SELECT id FROM shifts WHERE code = $1', [b.shift_code]);
      const code = await localNumber(c, 'employee', 'EMP-');
      const e = await one<{ id: string }>(c, `INSERT INTO employees (code, user_id, name, email, phone, designation, department, location, manager_id, date_of_joining, probation_months, status, pan, uan, esic_no, bank_account, ifsc, shift_id, weekly_off, pt_state, overtime_eligible, created_by_name)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'onboarding',$12,$13,$14,$15,$16,$17,$18,$19,$20,$21) RETURNING id`,
      [code, b.user_id ?? null, b.name, b.email ?? null, b.phone ?? null, b.designation, b.department, b.location, b.manager_id ?? null, b.date_of_joining, b.probation_months, b.pan ?? null, b.uan ?? null, b.esic_no ?? null, b.bank_account ?? null, b.ifsc ?? null, shift?.id ?? null, b.weekly_off, b.pt_state, b.overtime_eligible, req.user!.name]);
      for (const item of ONBOARDING) await c.query(`INSERT INTO checklist (employee_id, stage, item) VALUES ($1, 'onboarding', $2)`, [e!.id, item]);
      await grantLeave(c, e!.id, b.date_of_joining);
      await c.query(`INSERT INTO employee_events (employee_id, kind, detail, effective_date, by_name) VALUES ($1, 'hired', $2, $3, $4)`, [e!.id, `${b.designation}, ${b.department} at ${b.location}`, b.date_of_joining, req.user!.name]);
      await auditReq(c, req, 'employee', e!.id, 'hired', { after: { ...b, bank_account: b.bank_account ? `••••${b.bank_account.slice(-4)}` : null } });
      return { id: e!.id, code };
    });
    res.status(201).json(out);
  });

  r.put('/employees/:id', requirePermission('hrms.employee.manage'), async (req, res) => {
    const b = parse(empBody.partial().extend({ name: reqText(120) }), req.body);
    await tx(pool, async (c) => {
      const before = await one<Record<string, unknown>>(c, 'SELECT * FROM employees WHERE id = $1 FOR UPDATE', [req.params.id]);
      if (!before) throw notFound('Employee');
      const shift = b.shift_code ? await one<{ id: string }>(c, 'SELECT id FROM shifts WHERE code = $1', [b.shift_code]) : null;
      await c.query(`UPDATE employees SET name = $2, email = coalesce($3, email), phone = coalesce($4, phone), designation = coalesce($5, designation), department = coalesce($6, department), manager_id = coalesce($7, manager_id),
        pan = coalesce($8, pan), uan = coalesce($9, uan), esic_no = coalesce($10, esic_no), bank_account = coalesce($11, bank_account), ifsc = coalesce($12, ifsc), shift_id = coalesce($13, shift_id), weekly_off = coalesce($14, weekly_off), overtime_eligible = coalesce($15, overtime_eligible), user_id = coalesce($16, user_id), updated_at = now() WHERE id = $1`,
      [req.params.id, b.name, b.email ?? null, b.phone ?? null, b.designation ?? null, b.department ?? null, b.manager_id ?? null, b.pan ?? null, b.uan ?? null, b.esic_no ?? null, b.bank_account ?? null, b.ifsc ?? null, shift?.id ?? null, b.weekly_off ?? null, b.overtime_eligible ?? null, b.user_id ?? null]);
      if (b.bank_account && b.bank_account !== before.bank_account) await c.query(`INSERT INTO employee_events (employee_id, kind, detail, by_name) VALUES ($1, 'bank_changed', 'Salary bank account changed', $2)`, [req.params.id, req.user!.name]);
      await auditReq(c, req, 'employee', String(req.params.id), 'updated', { before: { ...before, bank_account: before.bank_account ? '••••' : null }, after: { ...b, bank_account: b.bank_account ? '••••' : undefined } });
    });
    res.json({ ok: true });
  });

  r.post('/employees/:id/salary', requirePermission('hrms.payroll.manage'), async (req, res) => {
    const b = parse(salaryBody, req.body);
    await tx(pool, async (c) => {
      if (!(await one(c, 'SELECT 1 FROM employees WHERE id = $1', [req.params.id]))) throw notFound('Employee');
      await c.query(`INSERT INTO salary_structures (employee_id, effective_from, basic, hra, conveyance, special, other, pf_applicable, pf_on_capped_wage, created_by_name) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        ON CONFLICT (employee_id, effective_from) DO UPDATE SET basic = EXCLUDED.basic, hra = EXCLUDED.hra, conveyance = EXCLUDED.conveyance, special = EXCLUDED.special, other = EXCLUDED.other, pf_applicable = EXCLUDED.pf_applicable, pf_on_capped_wage = EXCLUDED.pf_on_capped_wage, created_by_name = EXCLUDED.created_by_name`,
      [req.params.id, b.effective_from, b.basic, b.hra, b.conveyance, b.special, b.other, b.pf_applicable, b.pf_on_capped_wage, req.user!.name]);
      await c.query(`INSERT INTO employee_events (employee_id, kind, detail, effective_date, by_name) VALUES ($1, 'salary_revised', $2, $3, $4)`, [req.params.id, `Monthly gross ₹${(b.basic + b.hra + b.conveyance + b.special + b.other).toLocaleString('en-IN')}`, b.effective_from, req.user!.name]);
      await auditReq(c, req, 'salary_structure', String(req.params.id), 'set', { after: b });
    });
    res.json({ ok: true });
  });

  /** Lifecycle: start probation, confirm, transfer, promote, resign, complete exit. */
  r.post('/employees/:id/lifecycle', requirePermission('hrms.employee.manage'), async (req, res) => {
    const b = parse(z.object({ action: z.enum(['start_probation', 'confirm', 'transfer', 'promote', 'resign', 'withdraw_resignation', 'complete_exit']), effective_date: date, location: optText(60), department: optText(60), designation: optText(80), last_working_day: date.optional(), reason: optText(500) }), req.body);
    const e = await one<{ id: string; name: string; status: string; user_id: string | null; location: string; designation: string; last_working_day: string | null }>(pool, 'SELECT * FROM employees WHERE id = $1', [req.params.id]);
    if (!e) throw notFound('Employee');
    // Exit closes the login; that is a call to identity, made before this transaction publishes anything.
    if (b.action === 'complete_exit') {
      const open = await one<{ n: number }>(pool, `SELECT count(*)::int AS n FROM checklist WHERE employee_id = $1 AND stage = 'exit' AND NOT done`, [e.id]);
      if (open!.n) throw conflict(`${open!.n} exit checklist item(s) are still open`);
      if (e.user_id) {
        const u = await callService<{ id: string; email: string; name: string; phone: string | null; designation: string | null; party_id: string | null }>(S, 'identity', 'GET', `/users/${e.user_id}`).catch(() => null);
        if (u) await callService(S, 'identity', 'PATCH', `/users/${u.id}`, { email: u.email, name: u.name, phone: u.phone, designation: u.designation, party_id: u.party_id, status: 'inactive' });
      }
    }
    await tx(pool, async (c) => {
      const ev = (kind: string, detail: string) => c.query(`INSERT INTO employee_events (employee_id, kind, detail, effective_date, by_name) VALUES ($1,$2,$3,$4,$5)`, [e.id, kind, detail, b.effective_date, req.user!.name]);
      switch (b.action) {
        case 'start_probation': if (e.status !== 'onboarding') throw conflict('Not in onboarding'); await c.query(`UPDATE employees SET status = 'probation' WHERE id = $1`, [e.id]); await ev('probation_started', 'Onboarding complete'); break;
        case 'confirm': if (e.status !== 'probation') throw conflict('Only employees on probation can be confirmed'); await c.query(`UPDATE employees SET status = 'active', confirmed_on = $2 WHERE id = $1`, [e.id, b.effective_date]); await ev('confirmed', b.reason ?? 'Confirmed after probation'); break;
        case 'transfer': if (!b.location) throw badRequest('Choose the new location'); await c.query(`UPDATE employees SET location = $2, department = coalesce($3, department) WHERE id = $1`, [e.id, b.location, b.department ?? null]); await ev('transferred', `${e.location} → ${b.location}${b.reason ? `: ${b.reason}` : ''}`); break;
        case 'promote': if (!b.designation) throw badRequest('Give the new designation'); await c.query(`UPDATE employees SET designation = $2 WHERE id = $1`, [e.id, b.designation]); await ev('promoted', `${e.designation} → ${b.designation}`); break;
        case 'resign': {
          if (['notice', 'exited'].includes(e.status)) throw conflict(`Already ${e.status}`);
          if (!b.last_working_day || !b.reason) throw badRequest('Give the last working day and reason');
          await c.query(`UPDATE employees SET status = 'notice', resignation_date = $2, last_working_day = $3, exit_reason = $4 WHERE id = $1`, [e.id, b.effective_date, b.last_working_day, b.reason]);
          for (const item of EXIT) await c.query(`INSERT INTO checklist (employee_id, stage, item) VALUES ($1, 'exit', $2)`, [e.id, item]);
          await ev('resigned', `Last working day ${b.last_working_day}: ${b.reason}`);
          // Workflow raises the handover task from this event.
          await publish(c, S, 'hrms.employee.exiting', { employee_id: e.id, employee_name: e.name, user_id: e.user_id, last_working_day: b.last_working_day, reason: b.reason });
          break;
        }
        case 'withdraw_resignation': if (e.status !== 'notice') throw conflict('No resignation to withdraw'); await c.query(`UPDATE employees SET status = 'active', resignation_date = NULL, last_working_day = NULL, exit_reason = NULL WHERE id = $1`, [e.id]); await c.query(`DELETE FROM checklist WHERE employee_id = $1 AND stage = 'exit'`, [e.id]); await ev('resignation_withdrawn', b.reason ?? ''); break;
        case 'complete_exit': if (e.status !== 'notice') throw conflict('Record the resignation first'); await c.query(`UPDATE employees SET status = 'exited', exited_on = $2 WHERE id = $1`, [e.id, b.effective_date]); await ev('exited', e.user_id ? 'Login deactivated' : 'Exit completed'); break;
      }
      await auditReq(c, req, 'employee', e.id, b.action, { after: b, reason: b.reason ?? null });
    });
    res.json({ ok: true });
  });

  r.post('/checklist/:id', requirePermission('hrms.employee.manage'), async (req, res) => {
    const { done } = parse(z.object({ done: z.boolean() }), req.body);
    await tx(pool, async (c) => {
      const r1 = await c.query(`UPDATE checklist SET done = $2, done_by_name = CASE WHEN $2 THEN $3 END, done_at = CASE WHEN $2 THEN now() END WHERE id = $1`, [req.params.id, done, req.user!.name]);
      if (!r1.rowCount) throw notFound('Checklist item');
    });
    res.json({ ok: true });
  });

  // ----- recruitment -----
  r.get('/openings', requirePermission('hrms.read'), async (_req, res) => {
    res.json(await many(pool, `SELECT o.*, (SELECT json_agg(c ORDER BY c.updated_at DESC) FROM candidates c WHERE c.opening_id = o.id) AS candidates FROM openings o ORDER BY (o.status = 'open') DESC, o.created_at DESC`));
  });
  r.post('/openings', requirePermission('hrms.employee.manage'), async (req, res) => {
    const b = parse(z.object({ title: reqText(120), department: reqText(60), location: reqText(60), positions: z.number().int().min(1).max(50).default(1) }), req.body);
    const o = await tx(pool, async (c) => one<{ id: string }>(c, `INSERT INTO openings (title, department, location, positions, created_by_name) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [b.title, b.department, b.location, b.positions, req.user!.name]));
    res.status(201).json(o);
  });
  r.post('/openings/:id/candidates', requirePermission('hrms.employee.manage'), async (req, res) => {
    const b = parse(z.object({ name: reqText(120), phone: optText(20), email: z.email().nullable().optional(), source: optText(60), notes: optText(1000) }), req.body);
    const o = await tx(pool, async (c) => one<{ id: string }>(c, `INSERT INTO candidates (opening_id, name, phone, email, source, notes, updated_by_name) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`, [req.params.id, b.name, b.phone ?? null, b.email ?? null, b.source ?? null, b.notes ?? null, req.user!.name]));
    res.status(201).json(o);
  });
  r.post('/candidates/:id/stage', requirePermission('hrms.employee.manage'), async (req, res) => {
    const b = parse(z.object({ stage: z.enum(['applied', 'screening', 'interview', 'offer', 'hired', 'rejected']), notes: optText(1000) }), req.body);
    await tx(pool, async (c) => {
      const r1 = await c.query(`UPDATE candidates SET stage = $2, notes = coalesce($3, notes), updated_by_name = $4, updated_at = now() WHERE id = $1`, [req.params.id, b.stage, b.notes ?? null, req.user!.name]);
      if (!r1.rowCount) throw notFound('Candidate');
      await auditReq(c, req, 'candidate', String(req.params.id), b.stage);
    });
    res.json({ ok: true });
  });
}
