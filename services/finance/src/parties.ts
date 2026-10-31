import type { Router } from 'express';
import { type ServiceContext, many, requirePermission } from '@erp/platform';
import { round2, today } from './common.ts';
import { bucketOf, openBills } from './ledger.ts';

const BUCKETS = ['not_due', 'd1_30', 'd31_60', 'd61_90', 'd90_plus'] as const;

/** Customer and supplier ledgers with bill-wise ageing (first-in-first-out against the party balance). */
export function partyRoutes(r: Router, { pool }: ServiceContext) {
  r.get('/ageing/:kind', requirePermission('finance.read'), async (req, res) => {
    const kind = req.params.kind === 'payables' ? 'payable' : 'receivable';
    const asOf = (req.query.as_of as string) || today();
    const { bills, parties } = await openBills(pool, kind, null, asOf);
    const rows = parties.filter((p) => Math.abs(p.balance) > 0.005).map((p) => {
      const b: Record<string, number> = Object.fromEntries(BUCKETS.map((k) => [k, 0]));
      for (const x of bills.filter((y) => y.party_id === p.party_id)) b[bucketOf(x.due_date, asOf)] = round2(b[bucketOf(x.due_date, asOf)]! + x.outstanding);
      return { ...p, ...b, oldest_due: bills.filter((y) => y.party_id === p.party_id).map((y) => y.due_date).sort()[0] ?? null };
    }).sort((a, b) => b.balance - a.balance);
    const totals = Object.fromEntries(['balance', 'on_account', ...BUCKETS].map((k) => [k, round2(rows.reduce((s, r1) => s + Number((r1 as Record<string, unknown>)[k] ?? 0), 0))]));
    res.json({ as_of: asOf, kind, rows, totals });
  });

  r.get('/parties/:kind/:partyId', requirePermission('finance.read'), async (req, res) => {
    const kind = req.params.kind === 'payables' ? 'payable' : 'receivable';
    const ctl = kind === 'receivable' ? 'receivables' : 'payables';
    const id = String(req.params.partyId);
    const asOf = today();
    const { bills, parties } = await openBills(pool, kind, id, asOf);
    let run = 0;
    const entries = (await many<{ debit: number; credit: number }>(pool, `
      SELECT v.id AS voucher_id, v.number, v.voucher_type, v.voucher_date::text AS date, v.narration, l.bill_ref, l.debit::float, l.credit::float, b.code AS book
      FROM voucher_lines l JOIN vouchers v ON v.id = l.voucher_id JOIN accounts a ON a.id = l.account_id JOIN books b ON b.id = v.book_id
      WHERE a.system_key = $1 AND l.party_id = $2 AND v.status IN ('posted','reversed') ORDER BY v.voucher_date, v.created_at`, [ctl, id]))
      .map((e) => { run += kind === 'receivable' ? Number(e.debit) - Number(e.credit) : Number(e.credit) - Number(e.debit); return { ...e, balance: round2(run) }; });
    const allBills = await many(pool, `SELECT doc_no, doc_date::text, due_date::text, amount::float, b.code AS book FROM bills x JOIN books b ON b.id = x.book_id WHERE kind = $1 AND party_id = $2 ORDER BY doc_date DESC`, [kind, id]);
    const tds = kind === 'payable' ? await many(pool, `SELECT section, base_amount::float, rate::float, tds_amount::float, deducted_on::text, challan_id IS NOT NULL AS deposited FROM tds_entries WHERE party_id = $1 ORDER BY deducted_on DESC`, [id]) : [];
    res.json({ kind, party: parties[0] ?? { party_id: id, party_name: entries[0] ? null : null, balance: 0, billed_outstanding: 0, on_account: 0 }, open_bills: bills.map((b) => ({ ...b, bucket: bucketOf(b.due_date, asOf) })), bills: allBills, entries: entries.reverse(), tds });
  });
}
