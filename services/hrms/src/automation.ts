import { type Pool, many, notify, tx } from '@erp/platform';
import { S } from './common.ts';

/** Daily: expire unused comp-offs; remind HR about probation confirmations and last working days coming up. */
export async function runHrChecks(pool: Pool) {
  await pool.query(`UPDATE comp_offs SET status = 'expired' WHERE status = 'available' AND expires_on < current_date`);
  const due = await many<{ name: string; due: string }>(pool, `SELECT name, (date_of_joining + make_interval(months => probation_months))::date::text AS due FROM employees WHERE status = 'probation' AND date_of_joining + make_interval(months => probation_months) BETWEEN current_date AND current_date + 15`);
  const leaving = await many<{ name: string; last_working_day: string }>(pool, `SELECT name, last_working_day::text FROM employees WHERE status = 'notice' AND last_working_day BETWEEN current_date AND current_date + 7`);
  if (due.length || leaving.length) await tx(pool, async (c) => {
    for (const d of due) await notify(c, S, { audience_permission: 'hrms.employee.manage', kind: 'action', title: `Probation review: ${d.name} (due ${d.due})`, link: '/hr/employees' });
    for (const l of leaving) await notify(c, S, { audience_permission: 'hrms.employee.manage', kind: 'action', title: `${l.name} leaves on ${l.last_working_day}: finish the exit checklist`, link: '/hr/employees' });
  });
  return { confirmations: due.length, exits: leaving.length };
}
export function startHrAutomation(pool: Pool) {
  const run = () => runHrChecks(pool).catch((e) => console.error('[hrms] automation failed', (e as Error).message));
  setTimeout(run, 40_000);
  setInterval(run, 24 * 60 * 60_000).unref();
}
