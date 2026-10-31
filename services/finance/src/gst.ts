import type { Router } from 'express';
import { z } from 'zod';
import { type ServiceContext, badRequest, conflict, many, notFound, one, optText, parse, requirePermission, tx } from '@erp/platform';
import { post } from './ledger.ts';
import { auditReq, books, monthEnd, round2 } from './common.ts';

const month = z.string().regex(/^\d{4}-\d{2}(-01)?$/).transform((m) => `${m.slice(0, 7)}-01`);
interface TL { id: number; direction: string; doc_type: string; doc_no: string; doc_date: string; party_name: string | null; party_gstin: string | null; place_of_supply: string | null; hsn: string | null; rate: number; taxable: number; cgst: number; sgst: number; igst: number; reverse_charge: boolean; itc_eligible: boolean; qty_kg: number | null; status: string }
const sum = (rows: TL[], k: 'taxable' | 'cgst' | 'sgst' | 'igst') => round2(rows.reduce((s, r) => s + Number(r[k]), 0));
const totals = (rows: TL[]) => ({ taxable: sum(rows, 'taxable'), cgst: sum(rows, 'cgst'), sgst: sum(rows, 'sgst'), igst: sum(rows, 'igst') });

async function lines(pool: ServiceContext['pool'], bookId: string, m: string) {
  return many<TL>(pool, `SELECT t.*, t.doc_date::text AS doc_date, t.rate::float, t.taxable::float, t.cgst::float, t.sgst::float, t.igst::float, v.status FROM tax_lines t JOIN vouchers v ON v.id = t.voucher_id
    WHERE t.book_id = $1 AND t.doc_date BETWEEN $2 AND $3 AND v.status = 'posted' ORDER BY t.doc_date, t.doc_no`, [bookId, m, monthEnd(m)]);
}

/** GSTR-1 sections from the outward register: B2B (incl. transfers to other GSTINs), B2C small, credit notes, HSN summary. */
function gstr1(out: TL[]) {
  const inv = out.filter((t) => t.doc_type === 'invoice' || t.doc_type === 'transfer');
  const b2bRows = inv.filter((t) => t.party_gstin);
  const byDoc = new Map<string, TL[]>();
  for (const t of b2bRows) byDoc.set(t.doc_no, [...(byDoc.get(t.doc_no) ?? []), t]);
  const b2b = [...byDoc.entries()].map(([doc, ls]) => ({ doc_no: doc, doc_date: ls[0]!.doc_date, party_name: ls[0]!.party_name, party_gstin: ls[0]!.party_gstin, place_of_supply: ls[0]!.place_of_supply, transfer: ls[0]!.doc_type === 'transfer', ...totals(ls), value: round2(sum(ls, 'taxable') + sum(ls, 'cgst') + sum(ls, 'sgst') + sum(ls, 'igst')) }));
  const b2cMap = new Map<string, TL[]>();
  for (const t of inv.filter((x) => !x.party_gstin)) { const k = `${t.place_of_supply}|${t.rate}`; b2cMap.set(k, [...(b2cMap.get(k) ?? []), t]); }
  const b2cs = [...b2cMap.entries()].map(([k, ls]) => ({ place_of_supply: k.split('|')[0], rate: Number(k.split('|')[1]), ...totals(ls) }));
  const cn = out.filter((t) => t.doc_type === 'credit_note');
  const cdnr = cn.map((t) => ({ doc_no: t.doc_no, doc_date: t.doc_date, party_name: t.party_name, party_gstin: t.party_gstin, ...totals([t]) }));
  const hsnMap = new Map<string, TL[]>();
  for (const t of out) { const k = `${t.hsn ?? 'NA'}|${t.rate}`; hsnMap.set(k, [...(hsnMap.get(k) ?? []), t]); }
  const hsn = [...hsnMap.entries()].map(([k, ls]) => {
    const signed = ls.map((t) => (t.doc_type === 'credit_note' ? { ...t, taxable: -t.taxable, cgst: -t.cgst, sgst: -t.sgst, igst: -t.igst, qty_kg: t.qty_kg ? -t.qty_kg : t.qty_kg } : t));
    return { hsn: k.split('|')[0], rate: Number(k.split('|')[1]), uqc: 'KGS', qty: round2(signed.reduce((s, t) => s + Number(t.qty_kg ?? 0), 0)), ...totals(signed) };
  });
  return { b2b, b2cs, cdnr, hsn, totals: { invoices: totals(inv), credit_notes: totals(cn) } };
}

/** GSTR-3B: outward tax (3.1), ITC (4), and the set-off: credit in the order the GST law prescribes, then the cash ledger. */
type Credit = { igst: number; cgst: number; sgst: number };
type Ledgers = { credit: Credit; cash: Credit };
type Reversals = { rule_42_43: Credit; others: Credit; reclaimed: Credit };
const ZERO = (): Credit => ({ igst: 0, cgst: 0, sgst: 0 });
const HEADS = ['igst', 'cgst', 'sgst'] as const;
function gstr3b(out: TL[], inw: TL[], bf: Ledgers = { credit: ZERO(), cash: ZERO() }, rev: Reversals = { rule_42_43: ZERO(), others: ZERO(), reclaimed: ZERO() }, dues: { interest: Credit; late_fee: Credit } = { interest: ZERO(), late_fee: ZERO() }) {
  const inv = totals(out.filter((t) => t.doc_type !== 'credit_note'));
  const cn = totals(out.filter((t) => t.doc_type === 'credit_note'));
  const outward = { taxable: round2(inv.taxable - cn.taxable), igst: round2(inv.igst - cn.igst), cgst: round2(inv.cgst - cn.cgst), sgst: round2(inv.sgst - cn.sgst) };
  const rcm = totals(inw.filter((t) => t.reverse_charge));
  const itcRows = inw.filter((t) => t.itc_eligible && !t.reverse_charge);
  const itc = totals(itcRows);
  // Net ITC (4C) = available (4A, including reclaimed reversals) less reversed (4B).
  const net = Object.fromEntries(HEADS.map((h) => [h, round2(itc[h] + rcm[h] + rev.reclaimed[h] - rev.rule_42_43[h] - rev.others[h])])) as Credit;
  // Liability includes reverse-charge tax; RCM is paid in cash but also becomes credit.
  const liab = { igst: round2(outward.igst + rcm.igst), cgst: round2(outward.cgst + rcm.cgst), sgst: round2(outward.sgst + rcm.sgst) };
  const credit = Object.fromEntries(HEADS.map((h) => [h, round2(bf.credit[h] + net[h])])) as Credit;
  // A reversal larger than the credit in that head is paid like tax.
  for (const h of HEADS) if (credit[h] < 0) { liab[h] = round2(liab[h] - credit[h]); credit[h] = 0; }
  const pay = { ...liab };
  const use = (from: 'igst' | 'cgst' | 'sgst', to: 'igst' | 'cgst' | 'sgst') => { const x = Math.min(credit[from], pay[to]); credit[from] = round2(credit[from] - x); pay[to] = round2(pay[to] - x); };
  // IGST credit: IGST, then CGST, then SGST. CGST credit: CGST then IGST. SGST credit: SGST then IGST.
  use('igst', 'igst'); use('igst', 'cgst'); use('igst', 'sgst'); use('cgst', 'cgst'); use('cgst', 'igst'); use('sgst', 'sgst'); use('sgst', 'igst');
  // The cash ledger pays what credit could not, each head from its own balance only.
  const fromCash = Object.fromEntries(HEADS.map((h) => [h, round2(Math.min(bf.cash[h], pay[h]))])) as Credit;
  const cash = Object.fromEntries(HEADS.map((h) => [h, round2(pay[h] - fromCash[h])])) as Credit;
  const cashCf = Object.fromEntries(HEADS.map((h) => [h, round2(bf.cash[h] - fromCash[h])])) as Credit;
  return { outward_3_1_a: outward, reverse_charge_3_1_d: rcm, itc_4a: itc, itc_reclaimed: rev.reclaimed, itc_reversed_4b1: rev.rule_42_43, itc_reversed_4b2: rev.others, net_itc_4c: net,
    interest_5_1: dues.interest, late_fee_5_1: dues.late_fee,
    credit_brought_forward: bf.credit, liability: liab, cash_ledger_brought_forward: bf.cash, paid_from_cash_ledger: fromCash, cash_payable: cash, credit_carried_forward: credit, cash_ledger_carried_forward: cashCf };
}

async function reversalsFor(pool: ServiceContext['pool'], bookId: string, m: string): Promise<Reversals> {
  const rows = await many<{ reason: string; period: string; reclaim_period: string | null; igst: number; cgst: number; sgst: number }>(pool,
    `SELECT reason, period::text, reclaim_period::text, igst::float, cgst::float, sgst::float FROM gst_itc_reversals WHERE book_id = $1 AND (period = $2 OR reclaim_period = $2)`, [bookId, m]);
  const add = (pick: (r: typeof rows[number]) => boolean) => { const c = ZERO(); for (const r of rows.filter(pick)) for (const h of HEADS) c[h] = round2(c[h] + r[h]); return c; };
  return { rule_42_43: add((r) => r.period === m && r.reason === 'rule_42_43'), others: add((r) => r.period === m && r.reason !== 'rule_42_43'), reclaimed: add((r) => r.reclaim_period === m) };
}

/** Carried-over interest and late fee planned for this month's return (table 5.1); paid in cash, never from credit. */
async function duesFor(pool: ServiceContext['pool'], bookId: string, m: string) {
  const rows = await many<{ minor_head: string; igst: number; cgst: number; sgst: number }>(pool, `SELECT minor_head, igst::float, cgst::float, sgst::float FROM gst_dues WHERE book_id = $1 AND kind = 'outstanding' AND minor_head IN ('interest','late_fee') AND pay_in_month = $2`, [bookId, m]);
  const sumOf = (k: string) => { const c = ZERO(); for (const r of rows.filter((x) => x.minor_head === k)) for (const h of HEADS) c[h] = round2(c[h] + r[h]); return c; };
  return { interest: sumOf('interest'), late_fee: sumOf('late_fee') };
}

/** Cash held per minor head and tax head: what was carried over, less what settlements have used. */
async function minorCash(c: ServiceContext['pool'] | Parameters<typeof post>[0], bookId: string) {
  const rows = await many<{ minor_head: string; igst: number; cgst: number; sgst: number }>(c, `
    SELECT minor_head, sum(CASE WHEN kind = 'cash_balance' THEN igst ELSE -from_cash_igst END)::float AS igst, sum(CASE WHEN kind = 'cash_balance' THEN cgst ELSE -from_cash_cgst END)::float AS cgst,
      sum(CASE WHEN kind = 'cash_balance' THEN sgst ELSE -from_cash_sgst END)::float AS sgst FROM gst_dues WHERE book_id = $1 GROUP BY minor_head`, [bookId]);
  const out: Record<string, Credit> = {};
  for (const k of ['interest', 'late_fee', 'penalty', 'others']) { const r = rows.find((x) => x.minor_head === k); out[k] = r ? { igst: round2(r.igst), cgst: round2(r.cgst), sgst: round2(r.sgst) } : ZERO(); }
  return out;
}

/** Credit and cash ledger balances at the start of a month: the legacy carry-forwards, rolled through every month since. */
async function broughtForward(pool: ServiceContext['pool'], bookId: string, m: string): Promise<Ledgers> {
  const get = (t: string) => one<{ as_of: string; igst: number; cgst: number; sgst: number }>(pool, `SELECT as_of::text, igst::float, cgst::float, sgst::float FROM ${t} WHERE book_id = $1`, [bookId]);
  const [oc, ok] = [await get('gst_opening_credit'), await get('gst_opening_cash')];
  const bf: Ledgers = { credit: ZERO(), cash: ZERO() };
  const starts = [oc?.as_of, ok?.as_of].filter((x): x is string => !!x && x <= m).sort();
  if (!starts.length) return bf;
  for (let cur = starts[0]!; ; cur = nextMonth(cur)) {
    if (oc && cur === oc.as_of) for (const h of HEADS) bf.credit[h] = round2(bf.credit[h] + oc[h]);
    if (ok && cur === ok.as_of) for (const h of HEADS) bf.cash[h] = round2(bf.cash[h] + ok[h]);
    if (cur >= m) return bf;
    const all = await lines(pool, bookId, cur);
    const r = gstr3b(all.filter((t) => t.direction === 'outward'), all.filter((t) => t.direction === 'inward'), bf, await reversalsFor(pool, bookId, cur));
    bf.credit = r.credit_carried_forward; bf.cash = r.cash_ledger_carried_forward;
  }
}
const nextMonth = (m: string) => { const d = new Date(`${m}T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() + 1); return d.toISOString().slice(0, 10); };

export function gstRoutes(r: Router, { pool }: ServiceContext) {
  r.get('/gst/returns', requirePermission('finance.read'), async (req, res) => {
    const m = parse(month, req.query.month ?? new Date().toISOString().slice(0, 7));
    const b = (await books(pool)).find((x) => x.id === req.query.book) ?? (await books(pool))[0];
    if (!b) throw notFound('Book');
    const all = await lines(pool, b.id, m);
    const out = all.filter((t) => t.direction === 'outward'), inw = all.filter((t) => t.direction === 'inward');
    const recon = await one(pool, `SELECT count(*)::int AS lines, count(*) FILTER (WHERE status = 'matched')::int AS matched, count(*) FILTER (WHERE status <> 'matched')::int AS issues FROM gstr2b_lines WHERE book_id = $1 AND period = $2`, [b.id, m]);
    res.json({ book: b, month: m, gstr1: gstr1(out), gstr3b: gstr3b(out, inw, await broughtForward(pool, b.id, m), await reversalsFor(pool, b.id, m), await duesFor(pool, b.id, m)), inward: inw, itc_reconciliation: recon });
  });

  /**
   * Go-live: the electronic credit ledger (ITC) or cash ledger balance per head carried over from the legacy system for
   * one GSTIN, as at the start of the first month run in the ERP. Credit posts Dr Input GST, cash posts Dr GST cash
   * ledger, both against Opening difference; GSTR-3B brings them forward from that month.
   */
  for (const kind of ['credit', 'cash'] as const) {
    const table = kind === 'credit' ? 'gst_opening_credit' : 'gst_opening_cash';
    r.get(`/gst/opening-${kind}`, requirePermission('finance.read'), async (_req, res) => {
      res.json(await many(pool, `SELECT o.book_id, b.gstin, o.as_of::text, o.igst::float, o.cgst::float, o.sgst::float, o.reference, v.number AS voucher_number, v.status AS voucher_status, o.created_by_name, o.created_at
        FROM ${table} o JOIN books b ON b.id = o.book_id LEFT JOIN vouchers v ON v.id = o.voucher_id ORDER BY b.gstin`));
    });
    r.post(`/gst/opening-${kind}`, requirePermission('finance.gst.manage'), async (req, res) => {
      const amt = z.number().min(0).max(1e10);
      const b = parse(z.object({ gstin: z.string().length(15), as_of: month, igst: amt, cgst: amt, sgst: amt, reference: optText(80) }), req.body);
      if (kind === 'credit' && round2(b.cgst) !== round2(b.sgst)) throw badRequest('CGST and SGST credit are normally equal; check the electronic credit ledger');
      const book = (await books(pool)).find((x) => x.gstin === b.gstin.toUpperCase());
      if (!book) throw badRequest(`${b.gstin} is not one of your GST registrations`);
      const label = kind === 'credit' ? 'GST credit' : 'GST cash ledger balance';
      const out = await tx(pool, async (c) => {
        const ex = await one<{ as_of: string; igst: number; cgst: number; sgst: number; number: string | null }>(c, `SELECT o.as_of::text, o.igst::float, o.cgst::float, o.sgst::float, v.number FROM ${table} o LEFT JOIN vouchers v ON v.id = o.voucher_id WHERE o.book_id = $1 FOR UPDATE OF o`, [book.id]);
        if (ex) {
          if (ex.as_of === b.as_of && ex.igst === round2(b.igst) && ex.cgst === round2(b.cgst) && ex.sgst === round2(b.sgst)) return { number: ex.number, existing: true };
          throw conflict(`Opening ${kind} for ${book.gstin} is already loaded (${ex.number}) with different figures; reverse that voucher and remove it before loading again`);
        }
        const total = round2(b.igst + b.cgst + b.sgst);
        let v: { id: string; number: string } | null = null;
        if (total > 0) {
          const dr = kind === 'credit' ? [{ account: 'input_igst', debit: b.igst }, { account: 'input_cgst', debit: b.cgst }, { account: 'input_sgst', debit: b.sgst }] : [{ account: 'gst_cash_ledger', debit: total, narration: `IGST ${b.igst} · CGST ${b.cgst} · SGST ${b.sgst}` }];
          v = await post(c, { type: 'opening', book_id: book.id, date: b.as_of, narration: `${label} carried forward from the legacy system${b.reference ? ` (${b.reference})` : ''}`, by: req.user!.name, approved_by: 'migration sign-off',
            source: { service: 'finance', type: `gst_opening_${kind}`, id: book.id, ref: b.reference ?? null }, lines: [...dr, { account: 'opening_difference', credit: total }] });
        }
        await c.query(`INSERT INTO ${table} (book_id, as_of, igst, cgst, sgst, voucher_id, reference, created_by_name) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [book.id, b.as_of, round2(b.igst), round2(b.cgst), round2(b.sgst), v?.id ?? null, b.reference ?? null, req.user!.name]);
        await auditReq(c, req, `gst_opening_${kind}`, book.id, 'imported', { after: b });
        return { number: v?.number ?? null, existing: false };
      });
      res.status(201).json(out);
    });
  }

  /**
   * ITC reversals reported in GSTR-3B table 4(B) in their period: Rule 42/43 (common credit) in 4(B)(1), Rule 37
   * (supplier unpaid after 180 days) and others in 4(B)(2). The credit leaves Input GST in that month; Rule 37
   * reversals sit in a reclaimable account until the supplier is paid and the credit is reclaimed.
   */
  /**
   * Interest, late fee, penalty and others: cash held in those minor heads of the cash ledger, and amounts still owed.
   * Owed amounts are settled from cash in the same minor and tax head first; the rest is paid by challan from the bank.
   */
  r.get('/gst/dues', requirePermission('finance.read'), async (req, res) => {
    const bs = (await books(pool)).filter((b) => !req.query.book || b.id === req.query.book);
    const rows = await many(pool, `SELECT d.id, d.book_id, b.gstin, d.kind, d.minor_head, d.as_of::text, d.reference, d.pay_in_month::text, d.igst::float, d.cgst::float, d.sgst::float, d.status, d.settled_on::text,
      d.from_cash_igst::float, d.from_cash_cgst::float, d.from_cash_sgst::float, d.from_challan::float, d.challan_ref, v.number AS voucher_number, v.status AS voucher_status, sv.number AS settle_voucher_number, d.migration_ref
      FROM gst_dues d JOIN books b ON b.id = d.book_id LEFT JOIN vouchers v ON v.id = d.voucher_id LEFT JOIN vouchers sv ON sv.id = d.settle_voucher_id
      WHERE d.book_id = ANY($1) ORDER BY b.gstin, d.kind DESC, d.minor_head, d.reference`, [bs.map((b) => b.id)]);
    res.json({ dues: rows, cash: Object.fromEntries(await Promise.all(bs.map(async (b) => [b.gstin, await minorCash(pool, b.id)]))) });
  });
  r.post('/gst/dues', requirePermission('finance.gst.manage'), async (req, res) => {
    const amt = z.number().min(0).max(1e10);
    const b = parse(z.object({ gstin: z.string().length(15), kind: z.enum(['cash_balance', 'outstanding']), minor_head: z.enum(['interest', 'late_fee', 'penalty', 'others']), as_of: month,
      reference: optText(120), pay_in_month: month.nullable().optional(), igst: amt, cgst: amt, sgst: amt, migration_ref: optText(40) }), req.body);
    const total = round2(b.igst + b.cgst + b.sgst);
    if (!(total > 0)) throw badRequest('Enter an amount');
    if (b.kind === 'outstanding' && !b.reference) throw badRequest('Give the return period, notice or order the amount is owed for');
    if (b.pay_in_month && (b.kind !== 'outstanding' || !['interest', 'late_fee'].includes(b.minor_head))) throw badRequest('Only owed interest and late fee are paid through GSTR-3B table 5.1');
    if (b.pay_in_month && b.pay_in_month < b.as_of) throw badRequest('pay_in_month is before the carry-over month');
    const book = (await books(pool)).find((x) => x.gstin === b.gstin.toUpperCase());
    if (!book) throw badRequest(`${b.gstin} is not one of your GST registrations`);
    const ref = b.reference ?? 'Opening balance';
    const label = b.minor_head.replace('_', ' ');
    const out = await tx(pool, async (c) => {
      const ex = await one<{ id: string; number: string | null; igst: number; cgst: number; sgst: number }>(c, `SELECT d.id, v.number, d.igst::float, d.cgst::float, d.sgst::float FROM gst_dues d LEFT JOIN vouchers v ON v.id = d.voucher_id WHERE d.book_id = $1 AND d.kind = $2 AND d.minor_head = $3 AND d.reference = $4`, [book.id, b.kind, b.minor_head, ref]);
      if (ex) {
        if (ex.igst === round2(b.igst) && ex.cgst === round2(b.cgst) && ex.sgst === round2(b.sgst)) return { id: ex.id, number: ex.number, existing: true };
        throw conflict(`${label} ${b.kind === 'cash_balance' ? 'cash balance' : 'due'} "${ref}" for ${book.gstin} is already loaded with different figures`);
      }
      const v = await post(c, { type: 'opening', book_id: book.id, date: b.as_of, by: req.user!.name, approved_by: 'migration sign-off',
        narration: b.kind === 'cash_balance' ? `GST cash ledger — ${label} head, carried over (IGST ${b.igst} · CGST ${b.cgst} · SGST ${b.sgst})` : `GST ${label} owed for ${ref}, carried over (IGST ${b.igst} · CGST ${b.cgst} · SGST ${b.sgst})`,
        source: { service: 'finance', type: 'gst_due_opening', id: `${book.id}:${b.kind}:${b.minor_head}:${ref}`, ref: b.migration_ref ?? null },
        lines: b.kind === 'cash_balance' ? [{ account: 'gst_cash_ledger', debit: total }, { account: 'opening_difference', credit: total }] : [{ account: 'opening_difference', debit: total }, { account: 'gst_dues_payable', credit: total }] });
      const row = await one<{ id: string }>(c, `INSERT INTO gst_dues (book_id, kind, minor_head, as_of, reference, pay_in_month, igst, cgst, sgst, status, voucher_id, migration_ref, created_by_name) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
        [book.id, b.kind, b.minor_head, b.as_of, ref, b.pay_in_month ?? null, round2(b.igst), round2(b.cgst), round2(b.sgst), b.kind === 'cash_balance' ? 'balance' : 'open', v.id, b.migration_ref ?? null, req.user!.name]);
      await auditReq(c, req, 'gst_due', row!.id, 'imported', { after: b });
      return { id: row!.id, number: v.number, existing: false };
    });
    res.status(201).json(out);
  });
  r.post('/gst/dues/:id/settle', requirePermission('finance.gst.manage'), async (req, res) => {
    const b = parse(z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), challan_ref: optText(60) }), req.body);
    const out = await tx(pool, async (c) => {
      const d = await one<{ id: string; book_id: string; kind: string; minor_head: string; status: string; reference: string; igst: number; cgst: number; sgst: number }>(c, `SELECT *, igst::float, cgst::float, sgst::float FROM gst_dues WHERE id = $1 FOR UPDATE`, [req.params.id]);
      if (!d) throw notFound('GST due');
      if (d.kind !== 'outstanding' || d.status !== 'open') throw conflict('Only open amounts owed can be settled');
      await c.query('SELECT 1 FROM gst_dues WHERE book_id = $1 FOR UPDATE', [d.book_id]);
      const avail = (await minorCash(c, d.book_id))[d.minor_head]!;
      const fromCash = Object.fromEntries(HEADS.map((h) => [h, round2(Math.max(0, Math.min(avail[h], d[h])))])) as Credit;
      const cashTotal = round2(fromCash.igst + fromCash.cgst + fromCash.sgst);
      const challan = round2(d.igst + d.cgst + d.sgst - cashTotal);
      if (challan > 0 && !b.challan_ref) throw badRequest(`₹${challan.toLocaleString('en-IN')} is not covered by the cash ledger; give the challan (CPIN/CIN) it was paid with`);
      const v = await post(c, { type: 'payment', book_id: d.book_id, date: b.date, by: req.user!.name, approved_by: req.user!.name,
        narration: `GST ${d.minor_head.replace('_', ' ')} for ${d.reference} paid${cashTotal ? ` · ₹${cashTotal.toLocaleString('en-IN')} from the cash ledger` : ''}${challan ? ` · ₹${challan.toLocaleString('en-IN')} by challan ${b.challan_ref}` : ''}`,
        source: { service: 'finance', type: 'gst_due_settlement', id: d.id },
        lines: [{ account: 'gst_dues_payable', debit: round2(d.igst + d.cgst + d.sgst) }, { account: 'gst_cash_ledger', credit: cashTotal }, { account: 'bank_main', credit: challan }] });
      await c.query(`UPDATE gst_dues SET status = 'settled', settled_on = $2, settle_voucher_id = $3, from_cash_igst = $4, from_cash_cgst = $5, from_cash_sgst = $6, from_challan = $7, challan_ref = $8 WHERE id = $1`,
        [d.id, b.date, v.id, fromCash.igst, fromCash.cgst, fromCash.sgst, challan, b.challan_ref ?? null]);
      await auditReq(c, req, 'gst_due', d.id, 'settled', { after: { ...b, from_cash: fromCash, challan } });
      return { number: v.number, from_cash: fromCash, from_challan: challan };
    });
    res.json(out);
  });

  r.get('/gst/itc-reversals', requirePermission('finance.read'), async (req, res) => {
    const params: unknown[] = [];
    const where: string[] = [];
    if (req.query.book) { params.push(req.query.book); where.push(`r.book_id = $${params.length}`); }
    res.json(await many(pool, `SELECT r.id, r.book_id, b.gstin, r.supplier_name, r.doc_no, r.doc_date::text, r.reason, r.period::text, r.reclaim_period::text, r.igst::float, r.cgst::float, r.sgst::float, r.status, r.reference, r.note,
      v.number AS voucher_number, v.status AS voucher_status, rv.number AS reclaim_voucher_number, r.created_by_name, r.created_at
      FROM gst_itc_reversals r JOIN books b ON b.id = r.book_id LEFT JOIN vouchers v ON v.id = r.voucher_id LEFT JOIN vouchers rv ON rv.id = r.reclaim_voucher_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY r.period, b.gstin, r.supplier_name, r.doc_no`, params));
  });
  r.post('/gst/itc-reversals', requirePermission('finance.gst.manage'), async (req, res) => {
    const amt = z.number().min(0).max(1e10);
    const b = parse(z.object({ gstin: z.string().length(15), supplier_name: z.string().trim().min(2).max(200), doc_no: z.string().trim().min(1).max(60), doc_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      reason: z.enum(['rule_37', 'rule_42_43', 'other']), period: month, igst: amt, cgst: amt, sgst: amt, reference: optText(80), note: optText(500) }), req.body);
    const total = round2(b.igst + b.cgst + b.sgst);
    if (!(total > 0)) throw badRequest('Enter the credit to reverse');
    const book = (await books(pool)).find((x) => x.gstin === b.gstin.toUpperCase());
    if (!book) throw badRequest(`${b.gstin} is not one of your GST registrations`);
    const out = await tx(pool, async (c) => {
      const ex = await one<{ id: string; number: string | null; period: string; igst: number; cgst: number; sgst: number }>(c, `SELECT r.id, v.number, r.period::text, r.igst::float, r.cgst::float, r.sgst::float FROM gst_itc_reversals r LEFT JOIN vouchers v ON v.id = r.voucher_id WHERE r.book_id = $1 AND r.supplier_name = $2 AND r.doc_no = $3 AND r.reason = $4`, [book.id, b.supplier_name, b.doc_no, b.reason]);
      if (ex) {
        if (ex.period === b.period && ex.igst === round2(b.igst) && ex.cgst === round2(b.cgst) && ex.sgst === round2(b.sgst)) return { id: ex.id, number: ex.number, existing: true };
        throw conflict(`A ${b.reason.replace(/_/g, ' ')} reversal for ${b.doc_no} of ${b.supplier_name} is already recorded with different figures`);
      }
      const to = b.reason === 'rule_37' ? 'itc_reclaimable' : 'itc_reversed';
      const v = await post(c, { type: 'journal', book_id: book.id, date: b.period, narration: `ITC reversed (${b.reason === 'rule_37' ? 'Rule 37, supplier unpaid after 180 days' : b.reason === 'rule_42_43' ? 'Rule 42/43, common credit' : 'other'}) on ${b.doc_no} of ${b.supplier_name}`, by: req.user!.name, approved_by: b.reference ? 'migration sign-off' : req.user!.name,
        source: { service: 'finance', type: 'itc_reversal', id: `${book.id}:${b.supplier_name}:${b.doc_no}:${b.reason}`, ref: b.reference ?? null },
        lines: [{ account: to, debit: total }, { account: 'input_igst', credit: b.igst }, { account: 'input_cgst', credit: b.cgst }, { account: 'input_sgst', credit: b.sgst }] });
      const row = await one<{ id: string }>(c, `INSERT INTO gst_itc_reversals (book_id, supplier_name, doc_no, doc_date, reason, period, igst, cgst, sgst, voucher_id, reference, note, created_by_name) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
        [book.id, b.supplier_name, b.doc_no, b.doc_date, b.reason, b.period, round2(b.igst), round2(b.cgst), round2(b.sgst), v.id, b.reference ?? null, b.note ?? null, req.user!.name]);
      await auditReq(c, req, 'itc_reversal', row!.id, 'recorded', { after: b });
      return { id: row!.id, number: v.number, existing: false };
    });
    res.status(201).json(out);
  });
  /** The supplier has been paid: Rule 37 credit comes back in the month of payment (reported in 4(A)(5) and 4(D)(1)). */
  r.post('/gst/itc-reversals/:id/reclaim', requirePermission('finance.gst.manage'), async (req, res) => {
    const b = parse(z.object({ period: month, note: optText(500) }), req.body);
    const out = await tx(pool, async (c) => {
      const x = await one<{ id: string; book_id: string; reason: string; status: string; period: string; supplier_name: string; doc_no: string; igst: number; cgst: number; sgst: number }>(c, `SELECT *, period::text, igst::float, cgst::float, sgst::float FROM gst_itc_reversals WHERE id = $1 FOR UPDATE`, [req.params.id]);
      if (!x) throw notFound('ITC reversal');
      if (x.reason !== 'rule_37') throw conflict('Only Rule 37 reversals (supplier unpaid) can be reclaimed');
      if (x.status === 'reclaimed') throw conflict('Already reclaimed');
      if (b.period <= x.period) throw badRequest('Reclaim in a month after the reversal');
      const total = round2(x.igst + x.cgst + x.sgst);
      const v = await post(c, { type: 'journal', book_id: x.book_id, date: b.period, narration: `ITC reclaimed on payment: ${x.doc_no} of ${x.supplier_name}`, by: req.user!.name, approved_by: req.user!.name,
        source: { service: 'finance', type: 'itc_reclaim', id: x.id },
        lines: [{ account: 'input_igst', debit: x.igst }, { account: 'input_cgst', debit: x.cgst }, { account: 'input_sgst', debit: x.sgst }, { account: 'itc_reclaimable', credit: total }] });
      await c.query(`UPDATE gst_itc_reversals SET status = 'reclaimed', reclaim_period = $2, reclaim_voucher_id = $3, note = coalesce($4, note) WHERE id = $1`, [x.id, b.period, v.id, b.note ?? null]);
      await auditReq(c, req, 'itc_reversal', x.id, 'reclaimed', { after: b });
      return { number: v.number };
    });
    res.json(out);
  });

  /** GSTR-1 data in the GST portal's offline JSON layout, for upload through the GST offline tool or a GSP. */
  r.get('/gst/gstr1-json', requirePermission('finance.gst.manage'), async (req, res) => {
    const m = parse(month, req.query.month);
    const b = (await books(pool)).find((x) => x.id === req.query.book);
    if (!b) throw notFound('Book');
    const g = gstr1((await lines(pool, b.id, m)).filter((t) => t.direction === 'outward'));
    const fp = `${m.slice(5, 7)}${m.slice(0, 4)}`;
    const dt = (d: string) => `${d.slice(8, 10)}-${d.slice(5, 7)}-${d.slice(0, 4)}`;
    res.json({
      gstin: b.gstin, fp,
      b2b: Object.values(g.b2b.reduce<Record<string, { ctin: string; inv: unknown[] }>>((acc, i) => { (acc[i.party_gstin!] ??= { ctin: i.party_gstin!, inv: [] }).inv.push({ inum: i.doc_no, idt: dt(i.doc_date), val: i.value, pos: i.place_of_supply, rchrg: 'N', inv_typ: 'R', itms: [{ num: 1, itm_det: { txval: i.taxable, iamt: i.igst, camt: i.cgst, samt: i.sgst } }] }); return acc; }, {})),
      b2cs: g.b2cs.map((x) => ({ sply_ty: x.place_of_supply === b.state_code ? 'INTRA' : 'INTER', pos: x.place_of_supply, typ: 'OE', rt: x.rate, txval: x.taxable, iamt: x.igst, camt: x.cgst, samt: x.sgst })),
      cdnr: g.cdnr.filter((x) => x.party_gstin).map((x) => ({ ctin: x.party_gstin, nt: [{ ntty: 'C', nt_num: x.doc_no, nt_dt: dt(x.doc_date), val: round2(x.taxable + x.igst + x.cgst + x.sgst), itms: [{ num: 1, itm_det: { txval: x.taxable, iamt: x.igst, camt: x.cgst, samt: x.sgst } }] }] })),
      hsn: { data: g.hsn.map((x, i) => ({ num: i + 1, hsn_sc: x.hsn, uqc: x.uqc, qty: x.qty, rt: x.rate, txval: x.taxable, iamt: x.igst, camt: x.cgst, samt: x.sgst })) },
    });
  });

  /** E-invoice payloads (IRP schema) for B2B invoices. IRN generation needs a GSP/IRP connection. */
  r.get('/gst/e-invoices', requirePermission('finance.read'), async (req, res) => {
    const m = parse(month, req.query.month ?? new Date().toISOString().slice(0, 7));
    const b = (await books(pool)).find((x) => x.id === req.query.book) ?? (await books(pool))[0]!;
    const out = (await lines(pool, b.id, m)).filter((t) => t.direction === 'outward' && !!t.party_gstin);
    const byDoc = new Map<string, TL[]>();
    for (const t of out) byDoc.set(t.doc_no, [...(byDoc.get(t.doc_no) ?? []), t]);
    res.json([...byDoc.entries()].map(([doc, ls]) => {
      const f = ls[0]!;
      const tot = totals(ls);
      return {
        doc_no: doc, doc_type: f.doc_type, doc_date: f.doc_date, party_name: f.party_name, party_gstin: f.party_gstin, value: round2(tot.taxable + tot.cgst + tot.sgst + tot.igst), irn: null, irn_status: 'pending_gsp',
        payload: { Version: '1.1', TranDtls: { TaxSch: 'GST', SupTyp: 'B2B', RegRev: 'N' }, DocDtls: { Typ: f.doc_type === 'credit_note' ? 'CRN' : 'INV', No: doc, Dt: `${f.doc_date.slice(8, 10)}/${f.doc_date.slice(5, 7)}/${f.doc_date.slice(0, 4)}` },
          SellerDtls: { Gstin: b.gstin, LglNm: b.entity_name, Stcd: b.state_code }, BuyerDtls: { Gstin: f.party_gstin, LglNm: f.party_name, Pos: f.place_of_supply, Stcd: f.party_gstin?.slice(0, 2) },
          ItemList: ls.map((t, i) => ({ SlNo: String(i + 1), IsServc: 'N', HsnCd: t.hsn, Qty: t.qty_kg, Unit: 'KGS', AssAmt: t.taxable, GstRt: t.rate, IgstAmt: t.igst, CgstAmt: t.cgst, SgstAmt: t.sgst, TotItemVal: round2(t.taxable + t.igst + t.cgst + t.sgst) })),
          ValDtls: { AssVal: tot.taxable, IgstVal: tot.igst, CgstVal: tot.cgst, SgstVal: tot.sgst, TotInvVal: round2(tot.taxable + tot.cgst + tot.sgst + tot.igst) } },
      };
    }));
  });

  /** Sales or purchase register line by line (invoices, credit notes, transfers) for reports and analysis. */
  r.get('/registers/:direction', requirePermission('finance.read'), async (req, res) => {
    const dir = req.params.direction === 'purchases' ? 'inward' : 'outward';
    const from = (req.query.from as string) || '2000-01-01', to = (req.query.to as string) || '9999-12-31';
    res.json(await many(pool, `SELECT t.doc_type, t.doc_no, t.doc_date::text AS doc_date, t.party_id, t.party_name, t.party_gstin, t.place_of_supply, t.hsn, t.sku, t.qty_kg::float AS kg, t.rate::float AS gst_rate,
      (CASE WHEN t.doc_type = 'credit_note' THEN -1 ELSE 1 END * t.taxable)::float AS taxable, (CASE WHEN t.doc_type = 'credit_note' THEN -1 ELSE 1 END * (t.cgst + t.sgst + t.igst))::float AS tax, b.code AS book, b.gstin
      FROM tax_lines t JOIN vouchers v ON v.id = t.voucher_id JOIN books b ON b.id = t.book_id
      WHERE t.direction = $1 AND v.status = 'posted' AND t.doc_date BETWEEN $2 AND $3 ORDER BY t.doc_date, t.doc_no LIMIT 20000`, [dir, from, to]));
  });

  // ----- GSTR-2B reconciliation -----
  const twoB = z.object({ book_id: z.uuid(), month, lines: z.array(z.object({ supplier_gstin: z.string().trim().length(15), supplier_name: z.string().max(200).nullable().optional(), invoice_no: z.string().trim().min(1).max(40), invoice_date: z.string().nullable().optional(), taxable: z.number(), igst: z.number().default(0), cgst: z.number().default(0), sgst: z.number().default(0) })).min(1).max(5000) });
  r.post('/gst/2b', requirePermission('finance.gst.manage'), async (req, res) => {
    const b = parse(twoB, req.body);
    const out = await tx(pool, async (c) => {
      for (const l of b.lines) {
        await c.query(`INSERT INTO gstr2b_lines (book_id, period, supplier_gstin, supplier_name, invoice_no, invoice_date, taxable, igst, cgst, sgst, imported_by_name) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
          ON CONFLICT (book_id, supplier_gstin, invoice_no) DO UPDATE SET taxable = EXCLUDED.taxable, igst = EXCLUDED.igst, cgst = EXCLUDED.cgst, sgst = EXCLUDED.sgst, period = EXCLUDED.period`,
        [b.book_id, b.month, l.supplier_gstin.toUpperCase(), l.supplier_name ?? null, l.invoice_no, l.invoice_date || null, l.taxable, l.igst, l.cgst, l.sgst, req.user!.name]);
      }
      await auditReq(c, req, 'gstr2b', b.book_id, 'imported', { after: { month: b.month, lines: b.lines.length } });
      return reconcile2b(c, b.book_id, b.month);
    });
    res.json(out);
  });

  r.get('/gst/2b', requirePermission('finance.read'), async (req, res) => {
    const m = parse(month, req.query.month);
    if (!req.query.book) throw badRequest('Choose a GSTIN');
    const twob = await many(pool, `SELECT *, taxable::float, igst::float, cgst::float, sgst::float, difference::float FROM gstr2b_lines WHERE book_id = $1 AND period = $2 ORDER BY status, supplier_gstin`, [req.query.book, m]);
    // In our books but not in 2B: the supplier has not filed, so the credit is at risk.
    const missing = await many(pool, `SELECT t.doc_no, t.doc_date::text, t.party_name, t.party_gstin, (t.igst + t.cgst + t.sgst)::float AS tax, t.taxable::float FROM tax_lines t JOIN vouchers v ON v.id = t.voucher_id
      WHERE t.book_id = $1 AND t.direction = 'inward' AND t.doc_type = 'invoice' AND t.doc_date <= $3 AND t.doc_date >= $2::date - interval '12 months' AND v.status = 'posted' AND t.party_gstin IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM gstr2b_lines g WHERE g.book_id = t.book_id AND g.supplier_gstin = t.party_gstin AND upper(regexp_replace(g.invoice_no, '\\s', '', 'g')) = upper(regexp_replace(t.doc_no, '\\s', '', 'g')))
      ORDER BY t.doc_date`, [req.query.book, m, monthEnd(m)]);
    res.json({ month: m, lines: twob, not_in_2b: missing });
  });
}

export async function reconcile2b(c: Parameters<typeof many>[0], bookId: string, m: string) {
  const rows = await many<{ id: string; supplier_gstin: string; invoice_no: string; taxable: number; igst: number; cgst: number; sgst: number }>(c, 'SELECT * FROM gstr2b_lines WHERE book_id = $1 AND period = $2', [bookId, m]);
  let matched = 0, mismatch = 0, missing = 0;
  for (const g of rows) {
    const t = await one<{ doc_no: string; tax: number; taxable: number }>(c, `SELECT doc_no, sum(igst + cgst + sgst)::float AS tax, sum(taxable)::float AS taxable FROM tax_lines WHERE book_id = $1 AND direction = 'inward' AND party_gstin = $2
      AND upper(regexp_replace(doc_no, '\\s', '', 'g')) = upper(regexp_replace($3, '\\s', '', 'g')) GROUP BY doc_no`, [bookId, g.supplier_gstin, g.invoice_no]);
    const tax2b = round2(Number(g.igst) + Number(g.cgst) + Number(g.sgst));
    const status = !t ? 'not_in_books' : Math.abs(t.tax - tax2b) <= 1 ? 'matched' : 'amount_mismatch';
    if (status === 'matched') matched++; else if (status === 'amount_mismatch') mismatch++; else missing++;
    await c.query('UPDATE gstr2b_lines SET status = $2, matched_doc_no = $3, difference = $4 WHERE id = $1', [g.id, status, t?.doc_no ?? null, t ? round2(tax2b - t.tax) : tax2b]);
  }
  return { lines: rows.length, matched, amount_mismatch: mismatch, not_in_books: missing };
}
