import { type Pool, many, publish, tx } from '@erp/platform';
import { S, raiseAnomaly, round2, today } from './common.ts';
import { openBills } from './ledger.ts';
import { tdsDueDate } from './tds.ts';
import { overdueReturns } from './gst.ts';

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
  const late3b = await overdueReturns(pool);
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
    for (const g of late3b.filter((x) => x.return_type === 'gstr3b'))
      raised += Number(await raiseAnomaly(c, { kind: 'gstr3b_overdue', severity: g.cash_due > 0 ? 'critical' : 'warning', ref_type: 'gstr3b', ref_id: `${g.book_id}:${g.period}`, ref_label: `GSTR-3B ${g.period.slice(0, 7)} · ${g.gstin}`,
        message: `GSTR-3B ${g.period.slice(0, 7)} for ${g.gstin} was due on ${g.due_date} and no payment is recorded (${g.days_late} days late; cash due ₹${g.cash_due.toLocaleString('en-IN')}, interest so far ₹${g.interest_so_far.toLocaleString('en-IN')}, late fee so far ₹${g.late_fee_so_far.toLocaleString('en-IN')}, both growing daily)`, amount: g.cash_due }));
    for (const g of late3b.filter((x) => x.return_type === 'gstr1'))
      raised += Number(await raiseAnomaly(c, { kind: 'gstr1_overdue', severity: 'warning', ref_type: 'gstr1', ref_id: `${g.book_id}:${g.period}`, ref_label: `GSTR-1 ${g.period.slice(0, 7)} · ${g.gstin}`,
        message: `GSTR-1 ${g.period.slice(0, 7)} for ${g.gstin} was due on ${g.due_date} and is not recorded as filed (${g.days_late} days late; late fee so far ₹${g.late_fee_so_far.toLocaleString('en-IN')}, growing daily up to its cap)`, amount: g.late_fee_so_far }));
    // Payment reminders at 1, 7, 15 and 30 days overdue; communications and follow-up tasks come from this event.
    for (const b of ar.bills.filter((x) => days(x.due_date) >= 1)) {
      const d = days(b.due_date);
      const stage = [30, 15, 7, 1].find((s) => d >= s)!;
      const r = await c.query('INSERT INTO reminders (bill_id, stage) VALUES ($1, $2) ON CONFLICT DO NOTHING', [b.id, stage]);
      if (r.rowCount) await publish(c, S, 'finance.payment.reminder_due', { bill_id: b.id, party_id: b.party_id, party_name: b.party_name, doc_no: b.doc_no, due_date: b.due_date, outstanding: b.outstanding, days_overdue: d, stage });
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
