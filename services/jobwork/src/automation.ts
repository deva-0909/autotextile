import { type Pool, many, tx } from '@erp/platform';
import { raiseException, setting } from './common.ts';

/** Mill receipt overdue, operational overdue, and statutory job-work deadline reminders and breaches. */
export async function runJobworkChecks(pool: Pool) {
  const ackDays = Number(await setting('jobwork.mill_ack_due_days', 2));
  const reminders = (await setting<number[]>('jobwork.statutory_alert_days', [30, 15, 7])).slice().sort((a, b) => a - b);
  await tx(pool, async (c) => {
    const unacked = await many<{ id: string; number: string; mill_name: string }>(c, `SELECT id, number, mill_name FROM job_orders WHERE status = 'issued' AND issue_date + $1::int < current_date`, [ackDays]);
    for (const o of unacked)
      await raiseException(c, { kind: 'mill_ack_overdue', severity: 'warning', ref_id: o.id, ref_label: `${o.number} · ${o.mill_name}`, message: `${o.mill_name} has not acknowledged ${o.number} within ${ackDays} days of dispatch`, notifyPermission: 'jobwork.order.manage', link: `/jobwork/orders/${o.id}` });
    // Our goods sitting at the mill too long (not returned, or held back).
    const maxDays = Number(await setting('jobwork.max_days_at_mill', 30));
    const aged = await many<{ id: string; number: string; mill_name: string; kg: number; days: number }>(c, `
      SELECT id, number, mill_name, round(kg_sent - kg_good - kg_rejected - kg_damaged - kg_process_loss - kg_quarantine, 1)::float AS kg, current_date - issue_date AS days
      FROM job_orders WHERE status IN ('acknowledged','in_process','ready','partially_returned') AND issue_date + $1::int < current_date
        AND kg_sent - kg_good - kg_rejected - kg_damaged - kg_process_loss - kg_quarantine > 0.5`, [maxDays]);
    for (const o of aged)
      await raiseException(c, { kind: 'aged_at_mill', severity: 'warning', ref_id: o.id, ref_label: `${o.number} · ${o.mill_name}`, message: `${o.kg} kg on ${o.number} has been at ${o.mill_name} for ${o.days} days (limit ${maxDays})`, notifyPermission: 'jobwork.order.manage', link: `/jobwork/orders/${o.id}` });
    const open = await many<{ id: string; number: string; mill_name: string; internal_due_date: string; statutory_days: number; operational_days: number }>(c, `
      SELECT id, number, mill_name, internal_due_date, statutory_due_date - current_date AS statutory_days, internal_due_date - current_date AS operational_days
      FROM job_orders WHERE status IN ('issued','acknowledged','in_process','ready','partially_returned')`);
    for (const o of open) {
      if (o.operational_days < 0)
        await raiseException(c, { kind: 'operational_overdue', severity: 'warning', ref_id: o.id, ref_label: `${o.number} · ${o.mill_name}`, message: `${o.number} at ${o.mill_name} is ${-o.operational_days} days past the internal due date`, notifyPermission: 'jobwork.order.manage', link: `/jobwork/orders/${o.id}` });
      if (o.statutory_days < 0)
        await raiseException(c, { kind: 'statutory_breach', severity: 'critical', ref_id: o.id, ref_label: `${o.number} · ${o.mill_name}`, message: `Statutory job-work return deadline passed for ${o.number} — consult the CA`, notifyPermission: 'jobwork.order.manage', link: `/jobwork/deadlines` });
      else {
        const window = reminders.find((d) => o.statutory_days <= d);
        if (window !== undefined)
          await raiseException(c, { kind: `statutory_due_${window}d`, severity: window <= 7 ? 'critical' : 'warning', ref_id: o.id, ref_label: `${o.number} · ${o.mill_name}`, message: `${o.number}: statutory job-work deadline in ${o.statutory_days} days`, notifyPermission: 'jobwork.order.manage', link: `/jobwork/deadlines` });
      }
    }
  });
}

export function startJobworkAutomation(pool: Pool, everyMs = 5 * 60_000) {
  const run = () => runJobworkChecks(pool).catch((e) => console.error('[jobwork-automation]', e.message));
  setTimeout(run, 12_000).unref();
  const t = setInterval(run, everyMs);
  t.unref();
  return () => clearInterval(t);
}
