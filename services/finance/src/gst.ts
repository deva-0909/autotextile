import type { Router } from 'express';
import { z } from 'zod';
import { type ServiceContext, badRequest, many, notFound, one, parse, requirePermission, tx } from '@erp/platform';
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

/** GSTR-3B: outward tax (3.1), ITC (4) and the cash/credit set-off in the order the GST law prescribes. */
function gstr3b(out: TL[], inw: TL[]) {
  const inv = totals(out.filter((t) => t.doc_type !== 'credit_note'));
  const cn = totals(out.filter((t) => t.doc_type === 'credit_note'));
  const outward = { taxable: round2(inv.taxable - cn.taxable), igst: round2(inv.igst - cn.igst), cgst: round2(inv.cgst - cn.cgst), sgst: round2(inv.sgst - cn.sgst) };
  const rcm = totals(inw.filter((t) => t.reverse_charge));
  const itcRows = inw.filter((t) => t.itc_eligible && !t.reverse_charge);
  const itc = totals(itcRows);
  // Liability includes reverse-charge tax; RCM is paid in cash but also becomes credit.
  const liab = { igst: round2(outward.igst + rcm.igst), cgst: round2(outward.cgst + rcm.cgst), sgst: round2(outward.sgst + rcm.sgst) };
  const credit = { igst: round2(itc.igst + rcm.igst), cgst: round2(itc.cgst + rcm.cgst), sgst: round2(itc.sgst + rcm.sgst) };
  const pay = { ...liab };
  const use = (from: 'igst' | 'cgst' | 'sgst', to: 'igst' | 'cgst' | 'sgst') => { const x = Math.min(credit[from], pay[to]); credit[from] = round2(credit[from] - x); pay[to] = round2(pay[to] - x); };
  // IGST credit: IGST, then CGST, then SGST. CGST credit: CGST then IGST. SGST credit: SGST then IGST.
  use('igst', 'igst'); use('igst', 'cgst'); use('igst', 'sgst'); use('cgst', 'cgst'); use('cgst', 'igst'); use('sgst', 'sgst'); use('sgst', 'igst');
  return { outward_3_1_a: outward, reverse_charge_3_1_d: rcm, itc_4a: itc, liability: liab, cash_payable: pay, credit_carried_forward: credit };
}

export function gstRoutes(r: Router, { pool }: ServiceContext) {
  r.get('/gst/returns', requirePermission('finance.read'), async (req, res) => {
    const m = parse(month, req.query.month ?? new Date().toISOString().slice(0, 7));
    const b = (await books(pool)).find((x) => x.id === req.query.book) ?? (await books(pool))[0];
    if (!b) throw notFound('Book');
    const all = await lines(pool, b.id, m);
    const out = all.filter((t) => t.direction === 'outward'), inw = all.filter((t) => t.direction === 'inward');
    const recon = await one(pool, `SELECT count(*)::int AS lines, count(*) FILTER (WHERE status = 'matched')::int AS matched, count(*) FILTER (WHERE status <> 'matched')::int AS issues FROM gstr2b_lines WHERE book_id = $1 AND period = $2`, [b.id, m]);
    res.json({ book: b, month: m, gstr1: gstr1(out), gstr3b: gstr3b(out, inw), inward: inw, itc_reconciliation: recon });
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
