import type { Request, Router } from 'express';
import { z } from 'zod';
import { type Client, type Pool, type ServiceContext, badRequest, callService, conflict, many, notFound, one, optText, parse, recordVersion, reqText, requirePermission, tx } from '@erp/platform';
import { S, addDays, auditReq, books, fyOf, fyStart, getParty, localNumber, raiseAnomaly, requestApproval, round2, setting, today } from './common.ts';
import { periodOpen, post, reverse, type TaxLine } from './ledger.ts';
import { tdsFor } from './postings.ts';

/**
 * Manual sales and purchase invoices (no order, dispatch or purchase order) and counter cash sales.
 * A manual invoice is drafted, can be edited while it is the latest draft (each save is a version), goes to a checker,
 * and is posted on approval. A posted invoice is never edited: it is cancelled with a reason (reversed in the books),
 * or revised, which cancels it and opens a new draft as the next version.
 */
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const line = z.object({
  description: reqText(200), hsn: optText(8), qty: z.number().positive(), uom: z.string().max(10).default('kg'), rate: z.number().nonnegative(),
  gst_rate: z.number().refine((x) => [0, 0.25, 3, 5, 12, 18, 28].includes(x), 'GST rate must be 0, 0.25, 3, 5, 12, 18 or 28'),
  account: optText(40), product_id: z.uuid().nullable().optional(), sku: optText(40), barcode: optText(40),
});
const body = z.object({
  kind: z.enum(['sales', 'purchase']), book_id: z.uuid(), doc_date: date, due_date: date.nullable().optional(),
  party_id: z.uuid().nullable().optional(), party_name: optText(200), party_gstin: optText(15), party_state: optText(2), party_mobile: optText(20),
  supplier_invoice_no: optText(40), lines: z.array(line).min(1).max(100), barcodes: z.array(z.string().trim()).max(200).default([]), notes: optText(1000), change_note: optText(300),
});
type Body = z.infer<typeof body>;
type Line = z.infer<typeof line> & { taxable?: number; cgst?: number; sgst?: number; igst?: number };
interface Inv { id: string; root_id: string; version: number; kind: 'sales' | 'purchase'; mode: 'manual' | 'counter'; status: string; number: string | null; draft_no: string; book_id: string; doc_date: string; due_date: string | null;
  party_id: string | null; party_name: string; party_gstin: string | null; party_state: string | null; party_mobile: string | null; supplier_invoice_no: string | null; lines: Line[]; barcodes: string[];
  taxable: number; cgst: number; sgst: number; igst: number; round_off: number; total: number; tds_section: string | null; tds_amount: number; payment_mode: string | null; amount_received: number; notes: string | null;
  voucher_id: string | null; receipt_voucher_id: string | null; created_by_name: string | null; approved_by_name: string | null; cancel_reason: string | null }

/** GST per line: intra-state CGST + SGST, inter-state IGST (place of supply vs the book's state). */
export function computeTotals(lines: Line[], bookState: string, partyState: string | null) {
  const inter = !!partyState && partyState !== bookState;
  let taxable = 0, cgst = 0, sgst = 0, igst = 0;
  const out = lines.map((l) => {
    const t = round2(l.qty * l.rate);
    const tax = round2((t * l.gst_rate) / 100);
    const x = inter ? { cgst: 0, sgst: 0, igst: tax } : { cgst: round2(tax / 2), sgst: round2(tax - round2(tax / 2)), igst: 0 };
    taxable += t; cgst += x.cgst; sgst += x.sgst; igst += x.igst;
    return { ...l, taxable: t, ...x };
  });
  const gross = round2(taxable + cgst + sgst + igst);
  const total = Math.round(gross);
  return { lines: out, taxable: round2(taxable), cgst: round2(cgst), sgst: round2(sgst), igst: round2(igst), round_off: round2(total - gross), total };
}

async function bookOf(c: Client | Pool, id: string) {
  const b = (await books(c)).find((x) => x.id === id);
  if (!b) throw badRequest('Choose the GST registration (book)', { fields: { book_id: 'Required' } });
  return b;
}

const snapshot = (i: Inv) => ({ number: i.number ?? i.draft_no, kind: i.kind, mode: i.mode, status: i.status, doc_date: i.doc_date, party_name: i.party_name, party_gstin: i.party_gstin, party_state: i.party_state, supplier_invoice_no: i.supplier_invoice_no, lines: i.lines, taxable: i.taxable, cgst: i.cgst, sgst: i.sgst, igst: i.igst, round_off: i.round_off, total: i.total, tds_amount: i.tds_amount, notes: i.notes, barcodes: i.barcodes });
async function version(c: Client, i: Inv, note: string | null, by: string) {
  await recordVersion(c, S, { doc_type: i.kind === 'sales' ? 'manual_sales_invoice' : 'manual_purchase_invoice', doc_id: i.root_id, number: i.number ?? i.draft_no, version: i.version, status: i.status, data: snapshot(i), change_note: note, by_name: by });
}

/** Rolls scanned for a sales invoice become its lines (by fabric, at the lot's tagged price unless a line sets one). */
async function rollLines(barcodes: string[], ref: { type: 'counter_sale' | 'manual_invoice'; id: string; no: string; holder: string | null }, preview: boolean, given: Line[] = []) {
  if (!barcodes.length) return { lines: [] as Line[], kg: 0 };
  const r = await callService<{ rolls: { barcode: string; product_id: string; sku: string; product_name: string; weight_kg: number; price_per_kg: number | null; lot_no: string }[]; kg: number }>(S, 'inventory', 'POST', '/issues/sale',
    { barcodes, ref_type: ref.type, ref_id: ref.id, ref_no: ref.no, holder: ref.holder, preview });
  const by = new Map<string, { sku: string; name: string; product_id: string; kg: number; price: number | null; lots: Set<string> }>();
  for (const x of r.rolls) {
    const g = by.get(x.sku) ?? { sku: x.sku, name: x.product_name, product_id: x.product_id, kg: 0, price: x.price_per_kg, lots: new Set<string>() };
    g.kg += Number(x.weight_kg); g.lots.add(x.lot_no); by.set(x.sku, g);
  }
  const lines: Line[] = [];
  for (const g of by.values()) {
    const p = await callService<{ hsn_code: string; gst_rate: number }>(S, 'masters', 'GET', `/products/${g.product_id}`).catch(() => ({ hsn_code: '6006', gst_rate: 5 }));
    const override = given.find((l) => l.sku === g.sku);
    const rate = override?.rate ?? g.price;
    if (!rate) throw badRequest(`Set a price for ${g.sku}: its lot has no price tag`, { fields: { lines: g.sku } });
    lines.push({ description: `${g.name} (lot ${[...g.lots].join(', ')})`, hsn: p.hsn_code, qty: Math.round(g.kg * 1000) / 1000, uom: 'kg', rate, gst_rate: Number(p.gst_rate), product_id: g.product_id, sku: g.sku });
  }
  return { lines, kg: r.kg };
}

/** Walk-in buyers share one customer account per GSTIN book; each invoice carries the buyer's own name and GSTIN. */
async function walkinParty(c: Client, bookId: string, state: string) {
  const ex = await one<{ party_id: string }>(c, 'SELECT party_id FROM walkin_parties WHERE book_id = $1', [bookId]);
  if (ex) return ex.party_id;
  const b = await bookOf(c, bookId);
  const p = await callService<{ id: string }>(S, 'masters', 'POST', '/parties', { party_type: 'customer', legal_name: `Cash sales (walk-in), ${b.code}`, gst_treatment: 'unregistered', state_code: state, segment: 'Walk-in', tags: ['walk_in'], notes: 'Counter sales to walk-in buyers' });
  await c.query('INSERT INTO walkin_parties (book_id, party_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [bookId, p.id]);
  return p.id;
}

/** Posts an approved (or counter) invoice: number, voucher, GST, bill; stock out for sales with rolls; TDS for purchases. */
async function postInvoice(c: Client, i: Inv, by: string, approvedBy: string) {
  const b = await bookOf(c, i.book_id);
  if (!(await periodOpen(c, i.doc_date))) throw conflict(`${i.doc_date.slice(0, 7)} is locked: change the invoice date`);
  const party = i.party_id ? await getParty(i.party_id) : null;
  const partyId = i.party_id ?? (i.kind === 'sales' ? await walkinParty(c, i.book_id, b.state_code) : null);
  if (!partyId) throw badRequest('Choose the supplier');
  const name = i.party_name || party?.legal_name || 'Walk-in buyer';
  const number = i.kind === 'sales'
    ? await callService<{ number: string }>(S, 'organisation', 'POST', '/number-series/next', { doc_type: 'tax_invoice', gst_registration_id: b.gst_registration_id }).then((x) => x.number, () => localNumber(c, `tax_invoice:${b.code}`, `${b.code}/INV/`))
    : await localNumber(c, 'manual_purchase', 'PUR-M-');
  if (i.kind === 'sales' && i.barcodes.length) await rollLines(i.barcodes, { type: i.mode === 'counter' ? 'counter_sale' : 'manual_invoice', id: i.id, no: number, holder: name }, false, i.lines);
  const pos = i.party_state ?? party?.state_code ?? b.state_code;
  const gstin = i.party_gstin ?? party?.gstin ?? null;
  const tax: TaxLine[] = i.lines.map((l) => ({ direction: i.kind === 'sales' ? 'outward' : 'inward', doc_type: 'invoice', doc_no: i.kind === 'sales' ? number : i.supplier_invoice_no ?? number, doc_date: i.doc_date, party_id: partyId, party_name: name, party_gstin: gstin, place_of_supply: pos,
    hsn: l.hsn ?? null, rate: l.gst_rate, taxable: l.taxable ?? 0, cgst: l.cgst ?? 0, sgst: l.sgst ?? 0, igst: l.igst ?? 0, sku: l.sku ?? null, qty_kg: l.uom === 'kg' ? l.qty : null }));
  let voucher: { id: string; number: string };
  let tdsAmount = 0;
  if (i.kind === 'sales') {
    voucher = await post(c, {
      type: 'sales', book_id: b.id, date: i.doc_date, by, approved_by: approvedBy, narration: `${i.mode === 'counter' ? 'Counter sale' : 'Sales invoice'} ${number} — ${name}`, party_id: partyId, party_name: name,
      source: { service: S, type: i.mode === 'counter' ? 'counter_sale' : 'manual_sales_invoice', id: i.id, ref: number },
      lines: [
        { account: 'receivables', debit: i.total, party_id: partyId, party_name: name, bill_ref: number },
        { account: 'sales', credit: i.taxable }, { account: 'output_cgst', credit: i.cgst }, { account: 'output_sgst', credit: i.sgst }, { account: 'output_igst', credit: i.igst },
        ...(i.round_off ? [{ account: 'rounding', debit: i.round_off < 0 ? -i.round_off : 0, credit: i.round_off > 0 ? i.round_off : 0 }] : []),
      ],
      tax, bill: { kind: 'receivable', party_id: partyId, party_name: name, doc_no: number, doc_date: i.doc_date, due_date: i.due_date ?? addDays(i.doc_date, i.mode === 'counter' ? 0 : Number(await setting('finance.default_credit_days', 30))), amount: i.total },
    });
  } else {
    const tds = await tdsFor(c, partyId, party?.pan ?? null, i.taxable, i.doc_date);
    tdsAmount = tds?.amount ?? 0;
    const payable = round2(i.total - tdsAmount);
    const exp = new Map<string, number>();
    for (const l of i.lines) exp.set(l.account || 'purchases', round2((exp.get(l.account || 'purchases') ?? 0) + (l.taxable ?? 0)));
    voucher = await post(c, {
      type: 'purchase', book_id: b.id, date: i.doc_date, by, approved_by: approvedBy, narration: `Purchase invoice ${i.supplier_invoice_no ?? number} — ${name} (entered manually)`, party_id: partyId, party_name: name,
      source: { service: S, type: 'manual_purchase_invoice', id: i.id, ref: i.supplier_invoice_no ?? number },
      lines: [
        ...[...exp].map(([account, debit]) => ({ account, debit })),
        { account: 'input_cgst', debit: i.cgst }, { account: 'input_sgst', debit: i.sgst }, { account: 'input_igst', debit: i.igst },
        ...(i.round_off ? [{ account: 'rounding', debit: i.round_off > 0 ? i.round_off : 0, credit: i.round_off < 0 ? -i.round_off : 0 }] : []),
        { account: 'payables', credit: payable, party_id: partyId, party_name: name, bill_ref: i.supplier_invoice_no ?? number },
        ...(tds ? [{ account: 'tds_payable', credit: tds.amount, narration: `TDS ${tds.section} @ ${tds.rate}% on ₹${tds.base}` }] : []),
      ],
      tax, bill: { kind: 'payable', party_id: partyId, party_name: name, doc_no: i.supplier_invoice_no ?? number, doc_date: i.doc_date, due_date: i.due_date ?? addDays(i.doc_date, 30), amount: payable },
    });
    if (tds) await c.query(`INSERT INTO tds_entries (voucher_id, book_id, party_id, party_name, pan, section, base_amount, rate, tds_amount, deducted_on) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [voucher.id, b.id, partyId, name, tds.pan, tds.section, tds.base, tds.rate, tds.amount, i.doc_date]);
  }
  await c.query(`UPDATE manual_invoices SET status = 'posted', number = $2, voucher_id = $3, party_id = $4, tds_amount = $5, approved_by_name = $6, approved_at = now(), updated_at = now() WHERE id = $1`, [i.id, number, voucher.id, partyId, tdsAmount, approvedBy]);
  const done = (await one<Inv>(c, 'SELECT * FROM manual_invoices WHERE id = $1', [i.id]))!;
  await version(c, done, `Posted as ${number}`, approvedBy);
  return done;
}

export async function applyInvoiceDecision(c: Client, p: { approval_type: string; ref_id: string; decision: string; decided_by_name: string; comment: string | null }) {
  if (p.approval_type !== 'manual_invoice') return;
  const i = await one<Inv>(c, 'SELECT * FROM manual_invoices WHERE id = $1 FOR UPDATE', [p.ref_id]);
  if (!i || i.status !== 'pending_approval') return;
  if (p.decision !== 'approved') {
    await c.query(`UPDATE manual_invoices SET status = 'draft', updated_at = now(), notes = concat_ws(E'\n', notes, $2::text) WHERE id = $1`, [i.id, `Sent back by ${p.decided_by_name}${p.comment ? `: ${p.comment}` : ''}`]);
    await version(c, { ...i, status: 'draft' }, `Sent back by ${p.decided_by_name}${p.comment ? `: ${p.comment}` : ''}`, p.decided_by_name);
    return;
  }
  await postInvoice(c, i, i.created_by_name ?? 'system', p.decided_by_name);
}

async function cancelPosted(c: Client, i: Inv, req: Request, reason: string) {
  if (i.voucher_id) await reverse(c, i.voucher_id, req.user!.name, `Invoice ${i.number} cancelled: ${reason}`, today());
  if (i.receipt_voucher_id) await reverse(c, i.receipt_voucher_id, req.user!.name, `Receipt for ${i.number} cancelled: ${reason}`, today());
  await c.query(`UPDATE manual_invoices SET status = 'cancelled', cancel_reason = $2, cancelled_by_name = $3, cancelled_at = now(), updated_at = now() WHERE id = $1`, [i.id, reason, req.user!.name]);
}

export function invoiceRoutes(r: Router, { pool }: ServiceContext) {
  r.get('/manual-invoices', requirePermission('finance.read'), async (req, res) => {
    const p: unknown[] = []; const w = [`status <> 'superseded'`];
    if (req.query.kind) { p.push(req.query.kind); w.push(`kind = $${p.length}`); }
    if (req.query.mode) { p.push(req.query.mode); w.push(`mode = $${p.length}`); }
    if (req.query.status) { p.push(String(req.query.status).split(',')); w.push(`status = ANY($${p.length})`); }
    if (req.query.q) { p.push(`%${req.query.q}%`); w.push(`(number ILIKE $${p.length} OR draft_no ILIKE $${p.length} OR party_name ILIKE $${p.length} OR supplier_invoice_no ILIKE $${p.length})`); }
    res.json(await many(pool, `SELECT id, root_id, version, kind, mode, status, number, draft_no, book_id, doc_date::text, party_name, party_gstin, supplier_invoice_no, taxable::float, total::float, payment_mode, created_by_name, approved_by_name, cancel_reason, created_at FROM manual_invoices WHERE ${w.join(' AND ')} ORDER BY created_at DESC LIMIT 300`, p));
  });
  r.get('/manual-invoices/:id', requirePermission('finance.read', 'fulfilment.read'), async (req, res) => {
    const i = await one<Inv>(pool, 'SELECT *, doc_date::text, due_date::text FROM manual_invoices WHERE id = $1', [req.params.id]);
    if (!i) throw notFound('Invoice');
    const b = await bookOf(pool, i.book_id);
    const versions = await many(pool, 'SELECT id, version, status, number, draft_no, total::float, updated_at FROM manual_invoices WHERE root_id = $1 ORDER BY version DESC', [i.root_id]);
    const latest = (versions[0] as { id: string }).id === i.id;
    res.json({ ...i, book: { code: b.code, gstin: b.gstin, state_code: b.state_code, entity_name: b.entity_name, name: b.name }, versions, is_latest: latest, editable: latest && i.status === 'draft' });
  });
  /** Totals and GST for a draft before it is saved (the preview uses this). */
  r.post('/manual-invoices/compute', requirePermission('finance.voucher.post'), async (req, res) => {
    const b = parse(body.partial({ doc_date: true }), req.body);
    const bk = await bookOf(pool, b.book_id!);
    let lines = b.lines as Line[];
    if (b.kind === 'sales' && b.barcodes?.length) lines = [...(await rollLines(b.barcodes, { type: 'manual_invoice', id: '00000000-0000-0000-0000-000000000000', no: 'PREVIEW', holder: null }, true, lines)).lines, ...lines.filter((l) => !l.sku)];
    res.json(computeTotals(lines, bk.state_code, b.party_state ?? null));
  });

  r.post('/manual-invoices', requirePermission('finance.voucher.post'), async (req, res) => {
    const b = parse(body, req.body);
    const out = await tx(pool, async (c) => saveDraft(c, req, b, null));
    res.status(201).json(out);
  });
  /** Saves the latest draft as a new version (older versions stay as they were). */
  r.put('/manual-invoices/:id', requirePermission('finance.voucher.post'), async (req, res) => {
    const b = parse(body, req.body);
    const out = await tx(pool, async (c) => {
      const i = await one<Inv>(c, 'SELECT * FROM manual_invoices WHERE id = $1 FOR UPDATE', [req.params.id]);
      if (!i) throw notFound('Invoice');
      if (i.status !== 'draft') throw conflict(i.status === 'posted' ? 'A posted invoice is never edited: revise it (a new version) or cancel it with a reason' : `This version is ${i.status.replace('_', ' ')}; only the latest draft can be edited`);
      return saveDraft(c, req, b, i);
    });
    res.json(out);
  });
  r.post('/manual-invoices/:id/submit', requirePermission('finance.voucher.post'), async (req, res) => {
    const out = await tx(pool, async (c) => {
      const i = await one<Inv>(c, 'SELECT * FROM manual_invoices WHERE id = $1 FOR UPDATE', [req.params.id]);
      if (!i) throw notFound('Invoice');
      if (i.status !== 'draft') throw conflict(`This invoice is ${i.status.replace('_', ' ')}`);
      if (i.kind === 'purchase' && !i.supplier_invoice_no) throw badRequest('Enter the supplier’s invoice number');
      await c.query(`UPDATE manual_invoices SET status = 'pending_approval', submitted_by_name = $2, updated_at = now() WHERE id = $1`, [i.id, req.user!.name]);
      await requestApproval(c, req, { type: 'manual_invoice', refId: i.id, permission: 'finance.voucher.approve', title: `${i.kind === 'sales' ? 'Manual sales invoice' : 'Manual purchase invoice'} ${i.draft_no} · ${i.party_name} · ₹${Number(i.total).toLocaleString('en-IN')}`,
        summary: `${i.lines.length} line(s), dated ${i.doc_date}${i.barcodes.length ? `, ${i.barcodes.length} rolls out of stock` : ''}`, payload: { kind: i.kind, total: i.total, party: i.party_name } });
      await version(c, { ...i, status: 'pending_approval' }, 'Sent for approval', req.user!.name);
      await auditReq(c, req, 'manual_invoice', i.id, 'submitted');
      return { status: 'pending_approval' };
    });
    res.json(out);
  });
  r.post('/manual-invoices/:id/cancel', requirePermission('finance.voucher.post'), async (req, res) => {
    const { reason } = parse(z.object({ reason: reqText(300) }), req.body);
    await tx(pool, async (c) => {
      const i = await one<Inv>(c, 'SELECT * FROM manual_invoices WHERE id = $1 FOR UPDATE', [req.params.id]);
      if (!i) throw notFound('Invoice');
      if (!['draft', 'posted', 'rejected'].includes(i.status)) throw conflict(`This invoice is ${i.status.replace('_', ' ')}`);
      if (i.status === 'posted') await cancelPosted(c, i, req, reason);
      else await c.query(`UPDATE manual_invoices SET status = 'cancelled', cancel_reason = $2, cancelled_by_name = $3, cancelled_at = now() WHERE id = $1`, [i.id, reason, req.user!.name]);
      await version(c, { ...i, status: 'cancelled' }, `Cancelled: ${reason}`, req.user!.name);
      await auditReq(c, req, 'manual_invoice', i.id, 'cancelled', { reason });
    });
    res.json({ ok: true });
  });
  /** A posted invoice is revised by cancelling it (reversed in the books) and opening the next version as a draft. */
  r.post('/manual-invoices/:id/revise', requirePermission('finance.voucher.post'), async (req, res) => {
    const { reason } = parse(z.object({ reason: reqText(300) }), req.body);
    const out = await tx(pool, async (c) => {
      const i = await one<Inv>(c, 'SELECT *, doc_date::text, due_date::text FROM manual_invoices WHERE id = $1 FOR UPDATE', [req.params.id]);
      if (!i) throw notFound('Invoice');
      if (i.status !== 'posted') throw conflict('Only a posted invoice is revised; edit the draft instead');
      if (i.mode === 'counter') throw conflict('A counter sale is cancelled, not revised: cancel it and make a new sale');
      if (i.barcodes.length) throw conflict('Rolls left stock on this invoice: cancel it, take the rolls back, and raise a new invoice');
      await cancelPosted(c, i, req, `Revised: ${reason}`);
      await version(c, { ...i, status: 'cancelled' }, `Revised: ${reason}`, req.user!.name);
      const nextId = crypto.randomUUID();
      const next = await one<{ id: string }>(c, `INSERT INTO manual_invoices (id, root_id, version, kind, mode, status, draft_no, book_id, doc_date, due_date, party_id, party_name, party_gstin, party_state, party_mobile, supplier_invoice_no, lines, barcodes, taxable, cgst, sgst, igst, round_off, total, notes, created_by, created_by_name, revised_from)
        SELECT $5, root_id, $2, kind, mode, 'draft', draft_no, book_id, doc_date, due_date, party_id, party_name, party_gstin, party_state, party_mobile, supplier_invoice_no, lines, '{}', taxable, cgst, sgst, igst, round_off, total, notes, $3, $4, id FROM manual_invoices WHERE id = $1 RETURNING id`,
        [i.id, (await one<{ v: number }>(c, 'SELECT max(version)::int AS v FROM manual_invoices WHERE root_id = $1', [i.root_id]))!.v + 1, req.user!.id.startsWith('svc:') ? null : req.user!.id, req.user!.name, nextId]);
      const n = (await one<Inv>(c, 'SELECT *, doc_date::text FROM manual_invoices WHERE id = $1', [next!.id]))!;
      await version(c, n, `New version after revising ${i.number}: ${reason}`, req.user!.name);
      await auditReq(c, req, 'manual_invoice', i.id, 'revised', { reason, after: { new_version: n.version } });
      return { id: n.id, version: n.version };
    });
    res.status(201).json(out);
  });

  // ---------- counter cash sale ----------
  r.post('/counter-sales', requirePermission('finance.voucher.post', 'fulfilment.invoice'), async (req, res) => {
    const b = parse(z.object({
      book_id: z.uuid(), buyer_name: optText(160), buyer_mobile: optText(20), buyer_gstin: optText(15), buyer_pan: optText(10), buyer_state: optText(2),
      barcodes: z.array(z.string().trim().min(3)).min(1).max(200), prices: z.array(z.object({ sku: z.string(), rate: z.number().positive() })).default([]),
      payment_mode: z.enum(['cash', 'upi', 'card', 'bank']), amount_received: z.number().nonnegative(), notes: optText(500), preview: z.boolean().default(false),
    }), req.body);
    const bk = await bookOf(pool, b.book_id);
    const gstin = b.buyer_gstin ? b.buyer_gstin.toUpperCase() : null;
    const state = b.buyer_state ?? (gstin ? gstin.slice(0, 2) : bk.state_code);
    const id = crypto.randomUUID();
    const given = b.prices.map((p) => ({ sku: p.sku, rate: p.rate })) as Line[];
    const { lines, kg } = await rollLines(b.barcodes, { type: 'counter_sale', id, no: 'PREVIEW', holder: null }, true, given);
    const t = computeTotals(lines, bk.state_code, state);
    // Who bought: name and mobile always; PAN as well for a sale of ₹50,000 or more to a buyer without a GSTIN.
    const mobile = b.buyer_mobile?.replace(/\D/g, '').slice(-10) || null;
    const pan = b.buyer_pan ? b.buyer_pan.toUpperCase() : null;
    const panAbove = Number(await setting('finance.counter_pan_above', 49999));
    const fields: Record<string, string> = {};
    if (!b.buyer_name?.trim()) fields.buyer_name = 'Buyer name is required';
    if (!mobile || mobile.length !== 10) fields.buyer_mobile = 'A 10-digit mobile number is required';
    if (!gstin && t.total > panAbove && !pan) fields.buyer_pan = `PAN is required for a sale above ₹${panAbove.toLocaleString('en-IN')} without a GSTIN`;
    if (pan && !/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(pan)) fields.buyer_pan = 'PAN looks wrong (5 letters, 4 digits, 1 letter)';
    if (gstin && !/^[0-9]{2}[A-Z0-9]{13}$/.test(gstin)) fields.buyer_gstin = 'GSTIN looks wrong (15 characters)';
    // Cash from one buyer is capped for the whole financial year (₹2 lakh by default), which also keeps every
    // single day inside Income-tax section 269ST. The buyer is matched by mobile, PAN or GSTIN.
    const limit = Number(await setting('finance.cash_receipt_limit', 200000));
    const fy = fyOf(today());
    const ids = [mobile, pan, gstin].filter(Boolean) as string[];
    const earlier = ids.length ? await one<{ s: number }>(pool, `SELECT coalesce(sum(amount_received), 0)::float AS s FROM manual_invoices
      WHERE mode = 'counter' AND status = 'posted' AND payment_mode = 'cash' AND doc_date >= $1::date AND (party_mobile = ANY($2) OR party_pan = ANY($2) OR party_gstin = ANY($2))`, [fyStart(fy), ids]) : { s: 0 };
    const cashThisYear = round2((earlier?.s ?? 0) + t.total);
    const cashLeft = round2(Math.max(0, limit - (earlier?.s ?? 0)));
    const warning = cashThisYear > limit
      ? `Cash from this buyer this financial year would be ₹${cashThisYear.toLocaleString('en-IN')}; the limit is ₹${limit.toLocaleString('en-IN')} a year (₹${cashLeft.toLocaleString('en-IN')} left). Take UPI, card or bank transfer.` : null;
    if (b.preview) { res.json({ preview: true, kg, ...t, warning, b2c: !gstin, cash_this_year: round2(earlier?.s ?? 0), cash_limit: limit, cash_left: cashLeft, pan_required: !gstin && t.total > panAbove, missing: fields }); return; }
    if (Object.keys(fields).length) throw badRequest(Object.values(fields)[0]!, { fields });
    if (warning && b.payment_mode === 'cash') throw badRequest(warning, { fields: { payment_mode: 'Choose UPI, card or bank' } });
    if (b.amount_received + 0.5 < t.total) throw badRequest(`₹${t.total.toLocaleString('en-IN')} is due; ₹${b.amount_received.toLocaleString('en-IN')} received. A counter sale is paid in full.`, { fields: { amount_received: 'Collect the full amount' } });
    const out = await tx(pool, async (c) => {
      const draft = await localNumber(c, 'counter_draft', 'CS-');
      await c.query(`INSERT INTO manual_invoices (id, root_id, kind, mode, status, draft_no, book_id, doc_date, party_name, party_gstin, party_state, party_mobile, lines, barcodes, taxable, cgst, sgst, igst, round_off, total, payment_mode, amount_received, notes, created_by, created_by_name, party_pan)
        VALUES ($1,$1,'sales','counter','pending_approval',$2,$3,current_date,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)`,
        [id, draft, bk.id, b.buyer_name!.trim(), gstin, state, mobile, JSON.stringify(t.lines), b.barcodes.map((x) => x.toUpperCase()), t.taxable, t.cgst, t.sgst, t.igst, t.round_off, t.total, b.payment_mode, t.total, b.notes ?? null, req.user!.id.startsWith('svc:') ? null : req.user!.id, req.user!.name, pan]);
      const i = (await one<Inv>(c, 'SELECT *, doc_date::text FROM manual_invoices WHERE id = $1', [id]))!;
      const posted = await postInvoice(c, i, req.user!.name, `${req.user!.name} (counter)`);
      const rcpt = await post(c, {
        type: 'receipt', book_id: bk.id, date: posted.doc_date, by: req.user!.name, approved_by: 'counter sale', narration: `${b.payment_mode.toUpperCase()} received for ${posted.number} — ${posted.party_name}`,
        party_id: posted.party_id, party_name: posted.party_name, source: { service: S, type: 'counter_receipt', id, ref: posted.number },
        lines: [{ account: b.payment_mode === 'cash' ? 'cash' : 'bank_main', debit: t.total }, { account: 'receivables', credit: t.total, party_id: posted.party_id, party_name: posted.party_name, bill_ref: posted.number }],
      });
      await c.query('UPDATE manual_invoices SET receipt_voucher_id = $2 WHERE id = $1', [id, rcpt.id]);
      await auditReq(c, req, 'counter_sale', id, 'sold', { after: { number: posted.number, total: t.total, kg, mode: b.payment_mode, rolls: b.barcodes.length } });
      return { id, number: posted.number, total: t.total, kg, change: round2(b.amount_received - t.total) };
    });
    res.status(201).json(out);
  });

  // ---------- cash book and daily cash closing ----------
  r.get('/cash-book', requirePermission('finance.read'), async (req, res) => {
    const bookId = String(req.query.book_id ?? '');
    const from = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.from)) ? String(req.query.from) : today();
    const to = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.to)) ? String(req.query.to) : today();
    const opening = await one<{ b: number }>(pool, `SELECT coalesce(sum(l.debit - l.credit), 0)::float AS b FROM voucher_lines l JOIN vouchers v ON v.id = l.voucher_id JOIN accounts a ON a.id = l.account_id WHERE a.system_key = 'cash' AND v.status IN ('posted','reversed') AND v.voucher_date < $1 AND ($2 = '' OR v.book_id::text = $2)`, [from, bookId]);
    const rows = await many<{ debit: number; credit: number }>(pool, `SELECT v.id AS voucher_id, v.number, v.voucher_type, v.voucher_date::text AS date, v.narration, v.party_name, l.debit::float, l.credit::float FROM voucher_lines l JOIN vouchers v ON v.id = l.voucher_id JOIN accounts a ON a.id = l.account_id
      WHERE a.system_key = 'cash' AND v.status IN ('posted','reversed') AND v.voucher_date BETWEEN $1 AND $2 AND ($3 = '' OR v.book_id::text = $3) ORDER BY v.voucher_date, v.created_at`, [from, to, bookId]);
    let bal = opening!.b;
    res.json({ from, to, opening: round2(opening!.b), rows: rows.map((x) => ({ ...x, balance: round2((bal += Number(x.debit) - Number(x.credit))) })), closing: round2(bal), closings: await many(pool, `SELECT *, day::text FROM cash_closings WHERE cash_closings.day BETWEEN $1 AND $2 AND ($3 = '' OR book_id::text = $3) ORDER BY cash_closings.day DESC`, [from, to, bookId]) });
  });
  r.post('/cash-closings', requirePermission('finance.voucher.post'), async (req, res) => {
    const b = parse(z.object({ book_id: z.uuid(), day: date.default(today()), counted: z.number().min(0), denominations: z.record(z.string(), z.number().int().min(0)).nullable().optional(), note: optText(500) }), req.body);
    const sys = await one<{ b: number }>(pool, `SELECT coalesce(sum(l.debit - l.credit), 0)::float AS b FROM voucher_lines l JOIN vouchers v ON v.id = l.voucher_id JOIN accounts a ON a.id = l.account_id WHERE a.system_key = 'cash' AND v.status IN ('posted','reversed') AND v.voucher_date <= $1 AND v.book_id = $2`, [b.day, b.book_id]);
    const diff = round2(b.counted - sys!.b);
    if (Math.abs(diff) >= 1 && !b.note) throw badRequest(`Counted cash differs from the books by ₹${diff.toLocaleString('en-IN')}: explain the difference`, { fields: { note: 'Required when there is a difference' } });
    const out = await tx(pool, async (c) => {
      if (await one(c, 'SELECT 1 FROM cash_closings WHERE book_id = $1 AND day = $2', [b.book_id, b.day])) throw conflict('This day is already closed');
      const row = await one<{ id: string }>(c, `INSERT INTO cash_closings (book_id, day, system_cash, counted, difference, denominations, note, closed_by_name) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`, [b.book_id, b.day, round2(sys!.b), b.counted, diff, b.denominations ? JSON.stringify(b.denominations) : null, b.note ?? null, req.user!.name]);
      if (Math.abs(diff) >= 1) await raiseAnomaly(c, { kind: 'cash_difference', severity: Math.abs(diff) >= 1000 ? 'warning' : 'info', ref_type: 'cash_closing', ref_id: row!.id, ref_label: `Cash closing ${b.day}`, message: `Cash counted on ${b.day} is ₹${Math.abs(diff).toLocaleString('en-IN')} ${diff < 0 ? 'short' : 'over'}: ${b.note}`, amount: Math.abs(diff) });
      await auditReq(c, req, 'cash_closing', row!.id, 'closed', { after: { day: b.day, system: sys!.b, counted: b.counted, difference: diff }, reason: b.note });
      return { id: row!.id, system_cash: round2(sys!.b), counted: b.counted, difference: diff };
    });
    res.status(201).json(out);
  });
}

async function saveDraft(c: Client, req: Request, b: Body, prev: Inv | null) {
  const bk = await bookOf(c, b.book_id);
  const party = b.party_id ? await getParty(b.party_id) : null;
  if (b.kind === 'purchase' && !party) throw badRequest('Choose the supplier', { fields: { party_id: 'Required for a purchase invoice' } });
  if (party && b.kind === 'purchase' && !['supplier', 'manufacturer', 'mill', 'transporter'].includes(party.party_type)) throw badRequest('Choose a supplier, mill or transporter');
  if (party && b.kind === 'sales' && party.party_type !== 'customer') throw badRequest('Choose a customer');
  const state = b.party_state ?? party?.state_code ?? (b.party_gstin ? b.party_gstin.slice(0, 2) : null) ?? bk.state_code;
  let lines = b.lines as Line[];
  if (b.kind === 'sales' && b.barcodes.length) lines = [...(await rollLines(b.barcodes, { type: 'manual_invoice', id: '00000000-0000-0000-0000-000000000000', no: 'PREVIEW', holder: null }, true, lines)).lines, ...lines.filter((l) => !l.sku)];
  const t = computeTotals(lines, bk.state_code, state);
  const vals = [b.kind, bk.id, b.doc_date, b.due_date ?? null, party?.id ?? null, b.party_name || party?.legal_name || 'Walk-in buyer', b.party_gstin ?? party?.gstin ?? null, state, b.party_mobile ?? null, b.supplier_invoice_no ?? null, JSON.stringify(t.lines), b.barcodes.map((x) => x.toUpperCase()), t.taxable, t.cgst, t.sgst, t.igst, t.round_off, t.total, b.notes ?? null];
  let id: string;
  if (prev) {
    // The saved draft becomes the next version; the earlier one is kept, read-only, in the history.
    await c.query(`UPDATE manual_invoices SET kind = $2, book_id = $3, doc_date = $4, due_date = $5, party_id = $6, party_name = $7, party_gstin = $8, party_state = $9, party_mobile = $10, supplier_invoice_no = $11, lines = $12, barcodes = $13,
      taxable = $14, cgst = $15, sgst = $16, igst = $17, round_off = $18, total = $19, notes = $20, version = version + 1, updated_at = now() WHERE id = $1`, [prev.id, ...vals]);
    id = prev.id;
  } else {
    const draft = await localNumber(c, `manual_${b.kind}_draft`, b.kind === 'sales' ? 'DSI-' : 'DPI-');
    id = crypto.randomUUID();
    await c.query(`INSERT INTO manual_invoices (id, root_id, kind, book_id, doc_date, due_date, party_id, party_name, party_gstin, party_state, party_mobile, supplier_invoice_no, lines, barcodes, taxable, cgst, sgst, igst, round_off, total, notes, draft_no, created_by, created_by_name)
      VALUES ($23, $23, $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)`, [...vals, draft, req.user!.id.startsWith('svc:') ? null : req.user!.id, req.user!.name, id]);
  }
  const i = (await one<Inv>(c, 'SELECT *, doc_date::text FROM manual_invoices WHERE id = $1', [id]))!;
  await version(c, i, prev ? b.change_note ?? 'Draft edited' : 'Draft created', req.user!.name);
  await auditReq(c, req, 'manual_invoice', id, prev ? 'edited' : 'drafted', { before: prev ? snapshot(prev) : undefined, after: snapshot(i), reason: b.change_note });
  return { id, draft_no: i.draft_no, version: i.version, ...t };
}
