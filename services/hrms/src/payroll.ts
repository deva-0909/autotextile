import type { Router } from 'express';
import { z } from 'zod';
import { type Client, type ServiceContext, badRequest, callService, conflict, hasPermission, many, notFound, one, parse, publish, requirePermission, tx } from '@erp/platform';
import { S, auditReq, daysIn, dow, eachDay, holidaysFor, requestApproval, selfEmployee } from './common.ts';
import { type PtSlab, type Structure, computePayslip } from './statutory.ts';

const monthParam = (m: string) => { if (!/^\d{4}-\d{2}/.test(m)) throw badRequest('Month as YYYY-MM'); return `${m.slice(0, 7)}-01`; };
const monthEndOf = (m: string) => `${m.slice(0, 8)}${String(daysIn(m)).padStart(2, '0')}`;

/** Prepare (or re-prepare) the month: one payslip per employee on the rolls, from attendance and the salary structure in force. */
async function prepare(c: Client, month: string, by: string) {
  const end = monthEndOf(month);
  const run = await one<{ id: string; status: string }>(c, `INSERT INTO payroll_runs (month, prepared_by_name) VALUES ($1, $2) ON CONFLICT (month) DO UPDATE SET prepared_by_name = EXCLUDED.prepared_by_name, updated_at = now() RETURNING id, status`, [month, by]);
  if (run!.status !== 'draft') throw conflict(`Payroll for ${month.slice(0, 7)} is already ${run!.status.replace('_', ' ')}`);
  await c.query('DELETE FROM payslips WHERE run_id = $1', [run!.id]);
  const emps = await many<{ id: string; code: string; name: string; designation: string; department: string; location: string; pan: string | null; uan: string | null; bank_account: string | null; ifsc: string | null; date_of_joining: string; exited_on: string | null; weekly_off: number; pt_state: string; overtime_eligible: boolean; shift_hours: number | null }>(c, `
    SELECT e.*, e.date_of_joining::text, e.exited_on::text, s.hours::float AS shift_hours FROM employees e LEFT JOIN shifts s ON s.id = e.shift_id
    WHERE e.date_of_joining <= $2 AND (e.exited_on IS NULL OR e.exited_on >= $1) ORDER BY e.code`, [month, end]);
  const dim = daysIn(month);
  const missing: string[] = [];
  let count = 0;
  for (const e of emps) {
    const s = await one<Structure>(c, `SELECT basic::float, hra::float, conveyance::float, special::float, other::float, pf_applicable, pf_on_capped_wage FROM salary_structures WHERE employee_id = $1 AND effective_from <= $2 ORDER BY effective_from DESC LIMIT 1`, [e.id, end]);
    if (!s) { missing.push(e.name); continue; }
    const hol = await holidaysFor(c, e.pt_state, month, end);
    const att = await many<{ day: string; status: string; overtime_minutes: number }>(c, 'SELECT day::text, status, overtime_minutes FROM attendance WHERE employee_id = $1 AND day BETWEEN $2 AND $3', [e.id, month, end]);
    // Loss of pay: absences, half days, days before joining or after exit. Unmarked working days count as present.
    let lop = 0;
    for (const d of eachDay(month, end)) {
      if (d < e.date_of_joining || (e.exited_on && d > e.exited_on)) { lop++; continue; }
      const a = att.find((x) => x.day === d);
      if (a?.status === 'absent') lop++;
      else if (a?.status === 'half_day') lop += 0.5;
      else if (!a && dow(d) !== e.weekly_off && !hol.has(d)) { /* unmarked working day: treated as present */ }
    }
    const otHours = Math.round(att.reduce((t, a) => t + a.overtime_minutes, 0) / 6) / 10;
    const pt = await many<PtSlab>(c, 'SELECT min_gross::float, max_gross::float, amount::float, feb_amount::float FROM pt_slabs WHERE state_code = $1', [e.pt_state]);
    const p = computePayslip(s, { daysInMonth: dim, paidDays: dim - lop, overtimeHours: otHours, overtimeEligible: e.overtime_eligible, month: Number(month.slice(5, 7)), ptSlabs: pt, shiftHours: e.shift_hours ?? 8 });
    await c.query(`INSERT INTO payslips (run_id, employee_id, employee_code, employee_name, designation, department, location, pan, uan, bank_account, ifsc, days_in_month, paid_days, lop_days, overtime_hours, earnings, gross, deductions, total_deductions, employer, net)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)`,
    [run!.id, e.id, e.code, e.name, e.designation, e.department, e.location, e.pan, e.uan, e.bank_account, e.ifsc, dim, dim - lop, lop, otHours, JSON.stringify(p.earnings), p.gross, JSON.stringify(p.deductions), p.total_deductions, JSON.stringify(p.employer), p.net]);
    count++;
  }
  const t = (await one<Record<string, number>>(c, `SELECT count(*)::int AS employees, coalesce(sum(gross), 0)::float AS gross, coalesce(sum(total_deductions), 0)::float AS deductions, coalesce(sum(net), 0)::float AS net,
    coalesce(sum((deductions->>'pf')::numeric), 0)::float AS pf_employee, coalesce(sum((deductions->>'esic')::numeric), 0)::float AS esic_employee, coalesce(sum((deductions->>'professional_tax')::numeric), 0)::float AS pt, coalesce(sum((deductions->>'income_tax')::numeric), 0)::float AS tds,
    coalesce(sum((employer->>'epf')::numeric + (employer->>'eps')::numeric), 0)::float AS pf_employer, coalesce(sum((employer->>'esic')::numeric), 0)::float AS esic_employer FROM payslips WHERE run_id = $1`, [run!.id]))!;
  await c.query(`UPDATE payroll_runs SET employees = $2, gross = $3, deductions = $4, net = $5, employer_cost = $6, totals = $7, updated_at = now() WHERE id = $1`,
    [run!.id, t.employees, t.gross, t.deductions, t.net, t.gross + t.pf_employer + t.esic_employer, JSON.stringify({ ...t, missing_structure: missing })]);
  return { id: run!.id, employees: count, missing_structure: missing, totals: t };
}

export function payrollRoutes(r: Router, { pool }: ServiceContext) {
  r.get('/payroll', requirePermission('hrms.payroll.manage', 'hrms.payroll.approve'), async (_req, res) => {
    res.json(await many(pool, `SELECT id, month::text, status, employees, gross::float, deductions::float, net::float, employer_cost::float, prepared_by_name, approved_by_name, paid_on::text FROM payroll_runs ORDER BY month DESC`));
  });
  r.get('/payroll/:month', requirePermission('hrms.payroll.manage', 'hrms.payroll.approve'), async (req, res) => {
    const m = monthParam(String(req.params.month));
    const run = await one<{ id: string; status: string }>(pool, `SELECT *, month::text, gross::float, deductions::float, net::float, employer_cost::float, paid_on::text FROM payroll_runs WHERE month = $1`, [m]);
    if (!run) { res.json({ month: m, status: 'not_prepared', payslips: [] }); return; }
    const slips = await many(pool, `SELECT id, employee_id, employee_code, employee_name, designation, department, location, paid_days::float, lop_days::float, overtime_hours::float, earnings, gross::float, deductions, total_deductions::float, employer, net::float FROM payslips WHERE run_id = $1 ORDER BY employee_code`, [run.id]);
    // Accounting tie-out: the vouchers finance posted from this run.
    const vouchers = await callService<{ id: string; number: string; amount: number; status: string; voucher_type: string }[]>(S, 'finance', 'GET', `/vouchers?q=${encodeURIComponent(`PAYROLL-${m.slice(0, 7)}`)}`).catch(() => []);
    res.json({ ...run, payslips: slips, vouchers });
  });
  r.post('/payroll/:month/prepare', requirePermission('hrms.payroll.manage'), async (req, res) => {
    const m = monthParam(String(req.params.month));
    const out = await tx(pool, async (c) => { const x = await prepare(c, m, req.user!.name); await auditReq(c, req, 'payroll_run', x.id, 'prepared', { after: x.totals }); return x; });
    res.json(out);
  });
  r.post('/payroll/:month/submit', requirePermission('hrms.payroll.manage'), async (req, res) => {
    const m = monthParam(String(req.params.month));
    await tx(pool, async (c) => {
      const run = await one<{ id: string; status: string; employees: number; net: number; gross: number; totals: { missing_structure?: string[] } }>(c, `SELECT *, net::float, gross::float FROM payroll_runs WHERE month = $1 FOR UPDATE`, [m]);
      if (!run || run.status !== 'draft') throw conflict('Prepare the payroll first');
      if (!run.employees) throw conflict('No payslips in this run');
      await c.query(`UPDATE payroll_runs SET status = 'pending_approval', updated_at = now() WHERE id = $1`, [run.id]);
      await requestApproval(c, req, { type: 'payroll_run', refId: run.id, permission: 'hrms.payroll.approve', title: `Payroll ${m.slice(0, 7)}: ${run.employees} employees, net ₹${Math.round(run.net).toLocaleString('en-IN')}`,
        summary: `Gross ₹${Math.round(run.gross).toLocaleString('en-IN')}${run.totals.missing_structure?.length ? `; no salary structure for ${run.totals.missing_structure.join(', ')}` : ''}`, payload: { month: m.slice(0, 7), employees: run.employees, gross: run.gross, net: run.net } });
      await auditReq(c, req, 'payroll_run', run.id, 'submitted');
    });
    res.json({ ok: true });
  });
  /** Salary paid from the bank: the bank upload file and the accounting entry. */
  r.post('/payroll/:month/pay', requirePermission('hrms.payroll.manage'), async (req, res) => {
    const m = monthParam(String(req.params.month));
    const b = parse(z.object({ paid_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }), req.body);
    const out = await tx(pool, async (c) => {
      const run = await one<{ id: string; status: string; net: number }>(c, `SELECT id, status, net::float FROM payroll_runs WHERE month = $1 FOR UPDATE`, [m]);
      if (run?.status !== 'approved') throw conflict('Payroll must be approved before it is paid');
      const slips = await many<{ employee_code: string; employee_name: string; bank_account: string | null; ifsc: string | null; net: number }>(c, 'SELECT employee_code, employee_name, bank_account, ifsc, net::float FROM payslips WHERE run_id = $1 AND net > 0 ORDER BY employee_code', [run.id]);
      const noBank = slips.filter((s) => !s.bank_account || !s.ifsc);
      if (noBank.length) throw badRequest(`Bank details missing for ${noBank.map((s) => s.employee_name).join(', ')}`);
      await c.query(`UPDATE payroll_runs SET status = 'paid', paid_on = $2, paid_by_name = $3, updated_at = now() WHERE id = $1`, [run.id, b.paid_on, req.user!.name]);
      await publish(c, S, 'hrms.payroll.paid', { run_id: run.id, month: m, paid_on: b.paid_on, net: run.net, reference: `PAYROLL-${m.slice(0, 7)}` });
      await auditReq(c, req, 'payroll_run', run.id, 'paid', { after: b });
      const csv = ['Beneficiary name,Account number,IFSC,Amount,Narration', ...slips.map((s) => `${s.employee_name},${s.bank_account},${s.ifsc},${s.net.toFixed(2)},Salary ${m.slice(0, 7)} ${s.employee_code}`)].join('\n');
      return { bank_file: csv, total: run.net, count: slips.length };
    });
    res.json(out);
  });

  r.get('/payslips/:id', async (req, res) => {
    const p = await one<{ employee_id: string; run_id: string }>(pool, `SELECT p.*, r.month::text, r.status AS run_status, p.gross::float, p.net::float, p.total_deductions::float, p.paid_days::float, p.lop_days::float FROM payslips p JOIN payroll_runs r ON r.id = p.run_id WHERE p.id = $1`, [req.params.id]);
    if (!p) throw notFound('Payslip');
    if (!hasPermission(req.user, 'hrms.payroll.manage') && !hasPermission(req.user, 'hrms.payroll.approve')) {
      const me = await selfEmployee(pool, req);
      if (me?.id !== p.employee_id || !['approved', 'paid'].includes((p as unknown as { run_status: string }).run_status)) throw notFound('Payslip');
    }
    const company = await callService<{ legal_name: string; registered_address: string | null }[]>(S, 'organisation', 'GET', '/entities').catch(() => []);
    res.json({ ...p, company: company[0] ?? null });
  });
}

/** Payroll approval: the run is fixed and accounting books the salary cost and liabilities from this event. */
export async function applyPayrollDecision(c: Client, p: { ref_id: string; decision: string; decided_by_name: string }) {
  const run = await one<{ id: string; status: string; month: string; totals: Record<string, number> }>(c, `SELECT id, status, month::text, totals FROM payroll_runs WHERE id = $1 FOR UPDATE`, [p.ref_id]);
  if (!run || run.status !== 'pending_approval') return;
  if (p.decision !== 'approved') { await c.query(`UPDATE payroll_runs SET status = 'draft', updated_at = now() WHERE id = $1`, [run.id]); return; }
  await c.query(`UPDATE payroll_runs SET status = 'approved', approved_by_name = $2, approved_at = now(), updated_at = now() WHERE id = $1`, [run.id, p.decided_by_name]);
  const t = run.totals;
  await publish(c, S, 'hrms.payroll.approved', { run_id: run.id, month: run.month, reference: `PAYROLL-${run.month.slice(0, 7)}`, gross: t.gross, net: t.net, pf_employee: t.pf_employee, esic_employee: t.esic_employee, pt: t.pt, tds: t.tds, pf_employer: t.pf_employer, esic_employer: t.esic_employer });
}
