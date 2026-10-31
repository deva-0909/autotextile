import { type Pool, many, tx } from '@erp/platform';
import { raiseAnomaly, round2, today } from './common.ts';
import { openBills } from './ledger.ts';
import { tdsDueDate } from './tds.ts';

/** Periodic financial checks: unusual ledger movements, TDS not deposited on time, long-overdue receivables. Runs hourly. */
export async function runFinanceChecks(pool: Pool) {
  const moves = await many<{ id: string; name: string; cur: number; avg: number }>(pool, `
    WITH m AS (
      SELECT l.account_id, date_trunc('month', v.voucher_date)::date AS month, sum(l.debit - l.credit) AS amt
      FROM voucher_lines l JOIN vouchers v ON v.id = l.voucher_id JOIN accounts a ON a.id = l.account_id
      WHERE a.type = 'expense' AND a.system_key IS DISTINCT FROM 'inventory_change' AND v.status IN ('posted','reversed') AND v.voucher_date >= date_trunc('month', current_date) - interval '3 months'
      GROUP BY 1, 2)
    SELECT a.id, a.name, coalesce((SELECT amt FROM m WHERE m.account_id = a.id AND m.month = date_trunc('month', current_date)::date), 0)::float AS cur,
      coalesce((SELECT sum(amt) / 3 FROM m WHERE m.account_id = a.id AND m.month < date_trunc('month', current_date)::date), 0)::float AS avg
    FROM accounts a WHERE a.type = 'expense'`);
  const tds = await many<{ month: string; section: string; pending: number }>(pool, `SELECT date_trunc('month', deducted_on)::date::text AS month, section, sum(tds_amount)::float AS pending FROM tds_entries WHERE challan_id IS NULL GROUP BY 1, 2`);
  const ar = await openBills(pool, 'receivable', null, today());
  const days = (d: string) => Math.floor((Date.now() - new Date(`${d}T00:00:00Z`).getTime()) / 86_400_000);
  let raised = 0;
  await tx(pool, async (c) => {
    for (const m of moves) {
      if (m.avg > 0 && m.cur > 3 * m.avg && m.cur - m.avg > 50000)
        raised += Number(await raiseAnomaly(c, { kind: 'unusual_ledger_movement', severity: 'warning', ref_type: 'account', ref_id: `${m.id}:${today().slice(0, 7)}`, ref_label: m.name, message: `${m.name} this month is ₹${round2(m.cur).toLocaleString('en-IN')}, over three times the recent monthly average of ₹${round2(m.avg).toLocaleString('en-IN')}`, amount: m.cur }));
    }
    for (const t of tds) {
      const due = tdsDueDate(t.month);
      if (due < today()) raised += Number(await raiseAnomaly(c, { kind: 'tds_overdue', severity: 'critical', ref_type: 'tds', ref_id: `${t.month}:${t.section}`, ref_label: `TDS ${t.section} · ${t.month.slice(0, 7)}`, message: `TDS ${t.section} of ₹${round2(t.pending).toLocaleString('en-IN')} deducted in ${t.month.slice(0, 7)} was due by ${due} and is not deposited (interest runs at 1.5% a month)`, amount: t.pending }));
    }
    for (const b of ar.bills.filter((x) => days(x.due_date) > 90))
      raised += Number(await raiseAnomaly(c, { kind: 'receivable_90_days', severity: 'warning', ref_type: 'bill', ref_id: b.id, ref_label: `${b.doc_no} · ${b.party_name}`, message: `${b.party_name}: ₹${b.outstanding.toLocaleString('en-IN')} on ${b.doc_no} is more than 90 days overdue`, amount: b.outstanding }));
  });
  return { raised };
}

export function startFinanceAutomation(pool: Pool) {
  const run = () => runFinanceChecks(pool).catch((e) => console.error('[finance] automation failed', (e as Error).message));
  setTimeout(run, 30_000);
  setInterval(run, 60 * 60_000).unref();
}
