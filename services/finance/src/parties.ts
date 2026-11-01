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

  /** Sales invoices by customer with what is still unpaid (for agent commission and lead-source revenue). */
  r.get('/sales-invoices', requirePermission('finance.read'), async (req, res) => {
    const ids = String(req.query.party_ids ?? '').split(',').filter((x) => /^[0-9a-f-]{36}$/.test(x));
    const from = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.from)) ? String(req.query.from) : '1900-01-01';
    if (!ids.length) { res.json([]); return; }
    const rows = await many<{ party_id: string; doc_no: string; doc_date: string; taxable: number; kg: number | null; total: number }>(pool, `
      SELECT t.party_id, t.doc_no, min(t.doc_date)::text AS doc_date, round(sum(t.taxable), 2)::float AS taxable, sum(t.qty_kg)::float AS kg, round(sum(t.taxable + t.cgst + t.sgst + t.igst), 2)::float AS total
      FROM tax_lines t JOIN vouchers v ON v.id = t.voucher_id
      WHERE t.direction = 'outward' AND t.doc_type = 'invoice' AND v.status = 'posted' AND t.party_id = ANY($1) AND t.doc_date >= $2
      GROUP BY t.party_id, t.doc_no ORDER BY 3`, [ids, from]);
    const open = new Map<string, number>();
    for (const id of ids) for (const b of (await openBills(pool, 'receivable', id)).bills) open.set(`${id}|${b.doc_no}`, b.outstanding);
    res.json(rows.map((r1) => ({ ...r1, outstanding: open.get(`${r1.party_id}|${r1.doc_no}`) ?? 0 })));
  });

  /** Taxable sales per customer in a period (lead-source return). */
  r.get('/sales-by-party', requirePermission('finance.read'), async (req, res) => {
    const from = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.from)) ? String(req.query.from) : '1900-01-01';
    const to = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.to)) ? String(req.query.to) : '9999-12-31';
    res.json(await many(pool, `
      SELECT t.party_id, round(sum(t.taxable), 2)::float AS taxable, count(DISTINCT t.doc_no)::int AS invoices, min(t.doc_date)::text AS first_invoice
      FROM tax_lines t JOIN vouchers v ON v.id = t.voucher_id
      WHERE t.direction = 'outward' AND t.doc_type = 'invoice' AND v.status = 'posted' AND t.doc_date BETWEEN $1 AND $2 GROUP BY t.party_id`, [from, to]));
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
