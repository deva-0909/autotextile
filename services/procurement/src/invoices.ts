import type { Request, Router } from 'express';
import { z } from 'zod';
import {
  type Client, type ServiceContext, badRequest, conflict, forbidden, hasPermission, listQuery, many, notFound, one, optText, orderLimit, page,
  parse, publish, reqText, requirePermission, tx,
} from '@erp/platform';
import { S, auditReq, getParty, getPaymentTerms, raiseException, requestApproval, resolveExceptions, round2, setting } from './common.ts';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
export const invoiceBody = z.object({
  supplier_id: z.uuid(),
  invoice_number: z.string().trim().min(1, 'Required').max(40),
  invoice_date: isoDate,
  po_id: z.uuid().nullable().optional(),
  document_id: z.uuid().nullable().optional(),
  taxable_value: z.number().min(0),
  cgst: z.number().min(0).default(0),
  sgst: z.number().min(0).default(0),
  igst: z.number().min(0).default(0),
  total_value: z.number().min(0),
  lines: z.array(z.object({
    po_line_id: z.uuid().nullable().optional(),
    description: reqText(300),
    hsn_code: optText(8),
    qty_kg: z.number().min(0),
    rate: z.number().min(0),
    gst_rate: z.number().min(0).max(28).default(0),
  })).min(1, 'Add at least one line'),
});
export type InvoiceInput = z.infer<typeof invoiceBody>;

export interface MatchIssue { code: string; severity: 'warning' | 'critical'; message: string; line_no?: number }

/** Creates a draft supplier invoice (never posted automatically) and runs the three-way match. */
export async function createInvoice(c: Client, req: Request, input: InvoiceInput, links: { captureId?: string | null } = {}) {
  const supplier = await getParty(input.supplier_id).catch(() => null);
  if (!supplier || !['supplier', 'manufacturer', 'mill', 'transporter'].includes(supplier.party_type)) throw badRequest('Choose the supplier who issued this invoice', { fields: { supplier_id: 'Required' } });
  if (input.po_id) {
    const po = await one<{ supplier_id: string; status: string }>(c, 'SELECT supplier_id, status FROM purchase_orders WHERE id = $1', [input.po_id]);
    if (!po) throw badRequest('Unknown purchase order', { fields: { po_id: 'Not found' } });
    if (po.supplier_id !== input.supplier_id) throw badRequest('The PO belongs to a different supplier', { fields: { po_id: 'Supplier mismatch' } });
    if (['draft', 'pending_approval', 'cancelled'].includes(po.status)) throw badRequest(`The PO is ${po.status.replace(/_/g, ' ')}`, { fields: { po_id: 'Not an active PO' } });
  }
  const norm = input.invoice_number.replace(/\s/g, '').toUpperCase();
  const dup = await one<{ id: string; status: string }>(c, `SELECT id, status FROM supplier_invoices WHERE supplier_id = $1 AND upper(regexp_replace(invoice_number, '\\s', '', 'g')) = $2 AND status <> 'rejected'`, [input.supplier_id, norm]);
  if (dup) {
    await raiseException(c, { kind: 'duplicate_invoice', severity: 'critical', ref_type: 'supplier_invoice', ref_id: dup.id, ref_label: `${supplier.legal_name} · ${input.invoice_number}`, message: `Duplicate invoice ${input.invoice_number} from ${supplier.legal_name} was blocked`, notifyPermission: 'procurement.exception.manage', link: `/procurement/invoices/${dup.id}` });
    throw conflict(`Invoice ${input.invoice_number} from ${supplier.legal_name} already exists`);
  }
  // Due date from the PO's agreed terms, else the supplier's payment terms.
  let days = 0;
  if (input.po_id) days = (await one<{ payment_days: number }>(c, 'SELECT payment_days FROM purchase_orders WHERE id = $1', [input.po_id]))!.payment_days;
  else days = (await getPaymentTerms()).find((t) => t.id === supplier.payment_term_id)?.credit_days ?? 0;
  const due = new Date(`${input.invoice_date}T00:00:00Z`);
  due.setUTCDate(due.getUTCDate() + days);
  const inv = await one<{ id: string }>(c, `
    INSERT INTO supplier_invoices (supplier_id, supplier_name, supplier_gstin, invoice_number, invoice_date, po_id, capture_id, document_id, taxable_value, cgst, sgst, igst, total_value, due_date, created_by, created_by_name)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING id`,
    [supplier.id, supplier.legal_name, supplier.gstin, input.invoice_number.trim(), input.invoice_date, input.po_id ?? null, links.captureId ?? null, input.document_id ?? null,
      input.taxable_value, input.cgst, input.sgst, input.igst, input.total_value, due.toISOString().slice(0, 10), req.user!.id, req.user!.name]);
  for (const [i, l] of input.lines.entries())
    await c.query(`INSERT INTO invoice_lines (invoice_id, line_no, po_line_id, description, hsn_code, qty_kg, rate, taxable, gst_rate) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [inv!.id, i + 1, l.po_line_id ?? null, l.description, l.hsn_code ?? null, l.qty_kg, l.rate, round2(l.qty_kg * l.rate), l.gst_rate]);
  await runMatch(c, inv!.id);
  await auditReq(c, req, 'supplier_invoice', inv!.id, 'created', { after: { supplier: supplier.code, number: input.invoice_number, total: input.total_value, capture: links.captureId ?? null } });
  return inv!;
}

/** Three-way match: PO (what we ordered) vs receipts (what arrived) vs invoice (what we are billed). */
export async function runMatch(c: Client, invoiceId: string) {
  const inv = await one<{ id: string; supplier_id: string; supplier_name: string; invoice_number: string; invoice_date: string; po_id: string | null; taxable_value: number; cgst: number; sgst: number; igst: number; total_value: number }>(
    c, 'SELECT * FROM supplier_invoices WHERE id = $1', [invoiceId]);
  if (!inv) return;
  const lines = await many<{ line_no: number; po_line_id: string | null; qty_kg: number; rate: number; taxable: number; gst_rate: number; description: string }>(c, 'SELECT * FROM invoice_lines WHERE invoice_id = $1 ORDER BY line_no', [invoiceId]);
  const qtyTol = Number(await setting('procurement.three_way_tolerance_percent', 2)) / 100;
  const rateTol = Number(await setting('procurement.rate_tolerance_percent', 1)) / 100;
  const issues: MatchIssue[] = [];

  // Arithmetic and tax-split checks apply with or without a PO.
  const lineTaxable = round2(lines.reduce((s, l) => s + l.taxable, 0));
  if (Math.abs(lineTaxable - inv.taxable_value) > 1) issues.push({ code: 'taxable_mismatch', severity: 'warning', message: `Line totals ₹${lineTaxable} differ from taxable value ₹${inv.taxable_value}` });
  const tax = inv.cgst + inv.sgst + inv.igst;
  if (Math.abs(inv.taxable_value + tax - inv.total_value) > 1) issues.push({ code: 'total_mismatch', severity: 'warning', message: `Taxable ₹${inv.taxable_value} + tax ₹${round2(tax)} ≠ total ₹${inv.total_value}` });
  const expectedTax = round2(lines.reduce((s, l) => s + (l.taxable * l.gst_rate) / 100, 0));
  if (Math.abs(expectedTax - tax) > 1) issues.push({ code: 'tax_mismatch', severity: 'warning', message: `Tax charged ₹${round2(tax)} vs ₹${expectedTax} expected from line GST rates` });
  if (inv.cgst !== inv.sgst) issues.push({ code: 'cgst_sgst_unequal', severity: 'warning', message: 'CGST and SGST must be equal' });
  if (inv.igst > 0 && inv.cgst + inv.sgst > 0) issues.push({ code: 'mixed_tax', severity: 'critical', message: 'Invoice charges both IGST and CGST/SGST' });

  const soft = await one<{ invoice_number: string }>(c, `SELECT invoice_number FROM supplier_invoices WHERE supplier_id = $1 AND id <> $2 AND invoice_date = $3 AND abs(total_value - $4) < 1 AND status <> 'rejected'`,
    [inv.supplier_id, inv.id, inv.invoice_date, inv.total_value]);
  if (soft) issues.push({ code: 'possible_duplicate', severity: 'critical', message: `Same date and amount as invoice ${soft.invoice_number} — possible duplicate` });

  let status: 'matched' | 'variance' | 'no_po' | 'no_receipt' = 'matched';
  if (!inv.po_id) {
    status = 'no_po';
    issues.push({ code: 'no_po', severity: 'warning', message: 'Not linked to a purchase order' });
  } else {
    const po = await one<{ tax_type: string; number: string }>(c, 'SELECT tax_type, number FROM purchase_orders WHERE id = $1', [inv.po_id]);
    if (po!.tax_type === 'intra' && inv.igst > 0) issues.push({ code: 'tax_type', severity: 'critical', message: 'PO is intra-state (CGST+SGST) but the invoice charges IGST' });
    if (po!.tax_type === 'inter' && inv.cgst + inv.sgst > 0) issues.push({ code: 'tax_type', severity: 'critical', message: 'PO is inter-state (IGST) but the invoice charges CGST+SGST' });
    const poLines = await many<{ id: string; line_no: number; sku: string; qty_kg: number; rate_per_kg: number; gst_rate: number; received_kg: number; invoiced_kg: number }>(c, 'SELECT * FROM po_lines WHERE po_id = $1 ORDER BY line_no', [inv.po_id]);
    let anyReceipt = false;
    for (const l of lines) {
      // Lines without an explicit link are matched by position when the counts agree.
      const pl = poLines.find((p) => p.id === l.po_line_id) ?? (lines.length === poLines.length ? poLines[l.line_no - 1] : undefined);
      if (!pl) { issues.push({ code: 'unmatched_line', severity: 'warning', line_no: l.line_no, message: `Line ${l.line_no} (${l.description}) is not on the PO` }); continue; }
      if (pl.received_kg > 0) anyReceipt = true;
      const available = pl.received_kg - pl.invoiced_kg;
      if (l.qty_kg > available * (1 + qtyTol) + 0.001)
        issues.push({ code: 'qty_exceeds_receipt', severity: 'critical', line_no: l.line_no, message: `${pl.sku}: billed ${l.qty_kg} kg but only ${round2(available)} kg received and not yet invoiced` });
      if (Math.abs(l.rate - pl.rate_per_kg) / pl.rate_per_kg > rateTol)
        issues.push({ code: 'rate_variance', severity: l.rate > pl.rate_per_kg ? 'critical' : 'warning', line_no: l.line_no, message: `${pl.sku}: rate ₹${l.rate}/kg vs PO ₹${pl.rate_per_kg}/kg (${round2(((l.rate - pl.rate_per_kg) / pl.rate_per_kg) * 100)}%)` });
      if (Number(l.gst_rate) !== Number(pl.gst_rate))
        issues.push({ code: 'gst_rate_variance', severity: 'critical', line_no: l.line_no, message: `${pl.sku}: GST ${l.gst_rate}% vs ${pl.gst_rate}% on PO` });
      if (!l.po_line_id) await c.query('UPDATE invoice_lines SET po_line_id = $3 WHERE invoice_id = $1 AND line_no = $2', [inv.id, l.line_no, pl.id]);
    }
    if (!anyReceipt) status = 'no_receipt';
    else if (issues.length) status = 'variance';
  }
  if (status === 'matched' && issues.length) status = 'variance';
  await c.query('UPDATE supplier_invoices SET match_status = $2, match_result = $3, updated_at = now() WHERE id = $1', [inv.id, status, JSON.stringify(issues)]);
  if (status === 'matched') await resolveExceptions(c, 'invoice_variance', inv.id, 'Re-matched within tolerance');
  else
    await raiseException(c, {
      kind: 'invoice_variance', severity: issues.some((i) => i.severity === 'critical') ? 'critical' : 'warning', ref_type: 'supplier_invoice', ref_id: inv.id,
      ref_label: `${inv.supplier_name} · ${inv.invoice_number}`, message: `Invoice ${inv.invoice_number} held: ${status === 'no_receipt' ? 'no goods receipt yet' : status === 'no_po' ? 'no purchase order' : issues[0]!.message}`,
      notifyPermission: 'procurement.exception.manage', link: `/procurement/invoices/${inv.id}`,
    });
  return { status, issues };
}

/** Posts to the AP sub-ledger. Called only after a human decision. */
async function postInvoice(c: Client, invoiceId: string, by: { id: string; name: string }) {
  const inv = await one<{ id: string; supplier_id: string; supplier_name: string; invoice_number: string; invoice_date: string; due_date: string; total_value: number; po_id: string | null; taxable_value: number; cgst: number; sgst: number; igst: number }>(c, 'SELECT * FROM supplier_invoices WHERE id = $1 FOR UPDATE', [invoiceId]);
  await c.query(`UPDATE supplier_invoices SET status = 'posted', posted_by = $2, posted_by_name = $3, posted_at = now(), updated_at = now() WHERE id = $1`, [invoiceId, by.id, by.name]);
  await c.query(`INSERT INTO ap_ledger (supplier_id, supplier_name, entry_date, doc_type, doc_id, doc_number, credit, due_date, narration) VALUES ($1,$2,$3,'invoice',$4,$5,$6,$7,$8)`,
    [inv!.supplier_id, inv!.supplier_name, inv!.invoice_date, invoiceId, inv!.invoice_number, inv!.total_value, inv!.due_date, `Supplier invoice ${inv!.invoice_number}`]);
  const lines = await many<{ po_line_id: string | null; qty_kg: number }>(c, 'SELECT po_line_id, qty_kg FROM invoice_lines WHERE invoice_id = $1', [invoiceId]);
  for (const l of lines) if (l.po_line_id) await c.query('UPDATE po_lines SET invoiced_kg = invoiced_kg + $2 WHERE id = $1', [l.po_line_id, l.qty_kg]);
  await resolveExceptions(c, 'invoice_variance', invoiceId, 'Posted after review');
  // Accounting (P8) books the GL journal from this event.
  await publish(c, S, 'procurement.invoice.posted', { invoice_id: invoiceId, supplier_id: inv!.supplier_id, invoice_number: inv!.invoice_number, invoice_date: inv!.invoice_date, taxable_value: inv!.taxable_value, cgst: inv!.cgst, sgst: inv!.sgst, igst: inv!.igst, total_value: inv!.total_value, po_id: inv!.po_id });
}

export async function applyInvoiceDecision(c: Client, p: { ref_id: string; decision: string; decided_by: string; decided_by_name: string; comment: string | null }) {
  const inv = await one<{ status: string }>(c, 'SELECT status FROM supplier_invoices WHERE id = $1', [p.ref_id]);
  if (inv?.status !== 'pending_approval') return;
  if (p.decision === 'approved') await postInvoice(c, p.ref_id, { id: p.decided_by, name: p.decided_by_name });
  else await c.query(`UPDATE supplier_invoices SET status = 'draft', hold_reason = $2, updated_at = now() WHERE id = $1`, [p.ref_id, `Variance approval rejected: ${p.comment ?? ''}`]);
}

export function invoiceRoutes(r: Router, { pool }: ServiceContext) {
  r.get('/invoices', requirePermission('procurement.invoice.read'), async (req, res) => {
    const lq = listQuery(req, ['invoice_date', 'due_date', 'total_value', 'supplier_name', 'status', 'created_at'], 'invoice_date');
    const params: unknown[] = [];
    const where: string[] = [];
    const f = lq.filters;
    if (f.status) { params.push(f.status.split(',')); where.push(`i.status = ANY($${params.length})`); }
    if (f.match) { params.push(f.match.split(',')); where.push(`i.match_status = ANY($${params.length})`); }
    if (f.payment) { params.push(f.payment); where.push(`i.payment_status = $${params.length}`); }
    if (f.supplier) { params.push(f.supplier); where.push(`i.supplier_id = $${params.length}`); }
    if (lq.q) { params.push(`%${lq.q}%`); where.push(`(i.invoice_number ILIKE $${params.length} OR i.supplier_name ILIKE $${params.length} OR i.supplier_gstin ILIKE $${params.length})`); }
    const rows = await many<{ total_count: number }>(pool, `
      SELECT i.*, p.number AS po_number, count(*) OVER ()::int AS total_count
      FROM supplier_invoices i LEFT JOIN purchase_orders p ON p.id = i.po_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ${orderLimit({ ...lq, dir: req.query.dir ? lq.dir : 'desc' }, params).replace('ORDER BY ', 'ORDER BY i.')}`, params);
    res.json(page(rows, lq));
  });

  r.get('/invoices/:id', requirePermission('procurement.invoice.read'), async (req, res) => {
    const inv = await one<Record<string, unknown> & { po_id: string | null }>(pool, 'SELECT * FROM supplier_invoices WHERE id = $1', [req.params.id]);
    if (!inv) throw notFound('Invoice');
    const lines = await many(pool, `SELECT il.*, pl.sku, pl.qty_kg AS po_qty, pl.rate_per_kg AS po_rate, pl.received_kg, pl.invoiced_kg FROM invoice_lines il LEFT JOIN po_lines pl ON pl.id = il.po_line_id WHERE il.invoice_id = $1 ORDER BY il.line_no`, [req.params.id]);
    const po = inv.po_id ? await one(pool, 'SELECT id, number, status, total_value, tax_type, deliver_to_name FROM purchase_orders WHERE id = $1', [inv.po_id]) : null;
    const ledger = await many(pool, 'SELECT * FROM ap_ledger WHERE doc_id = $1', [req.params.id]);
    res.json({ ...inv, lines, po, ledger });
  });

  r.post('/invoices', requirePermission('procurement.invoice.capture'), async (req, res) => {
    const body = parse(invoiceBody, req.body);
    res.status(201).json(await tx(pool, (c) => createInvoice(c, req, body)));
  });

  r.post('/invoices/:id/rematch', requirePermission('procurement.invoice.capture'), async (req, res) => {
    res.json(await tx(pool, async (c) => {
      const inv = await one<{ status: string }>(c, 'SELECT status FROM supplier_invoices WHERE id = $1 FOR UPDATE', [req.params.id]);
      if (!inv) throw notFound('Invoice');
      if (inv.status !== 'draft') throw conflict('Only draft invoices can be re-matched');
      return runMatch(c, String(req.params.id));
    }));
  });

  /** Posting is always a human decision. Matched invoices post directly; variances need a checker. */
  r.post('/invoices/:id/post', requirePermission('procurement.invoice.capture', 'procurement.invoice.approve'), async (req, res) => {
    const { reason } = parse(z.object({ reason: optText(500) }), req.body);
    res.json(await tx(pool, async (c) => {
      const inv = await one<{ id: string; status: string; match_status: string; created_by: string; supplier_name: string; invoice_number: string; total_value: number; match_result: MatchIssue[] }>(c, 'SELECT * FROM supplier_invoices WHERE id = $1 FOR UPDATE', [req.params.id]);
      if (!inv) throw notFound('Invoice');
      if (inv.status !== 'draft') throw conflict(`Invoice is ${inv.status.replace(/_/g, ' ')}`);
      const check = await runMatch(c, inv.id);
      if (check!.status === 'matched') {
        if (!hasPermission(req.user, 'procurement.invoice.approve')) throw forbidden('You can review invoices but not post them');
        if (inv.created_by === req.user!.id) throw forbidden('Maker-checker: someone other than the person who entered the invoice must post it');
        await postInvoice(c, inv.id, { id: req.user!.id, name: req.user!.name });
        await auditReq(c, req, 'supplier_invoice', inv.id, 'posted', { after: { total: inv.total_value } });
        return { status: 'posted' };
      }
      if (!reason) throw badRequest('This invoice does not match. Give a reason to request approval of the variance.', { fields: { reason: 'Required for variances' } });
      await c.query(`UPDATE supplier_invoices SET status = 'pending_approval', hold_reason = $2, updated_at = now() WHERE id = $1`, [inv.id, reason]);
      await requestApproval(c, req, {
        type: 'invoice_posting', refId: inv.id, permission: 'procurement.invoice.approve',
        title: `Post ${inv.supplier_name} invoice ${inv.invoice_number} with variance (₹${Number(inv.total_value).toLocaleString('en-IN')})`,
        summary: reason,
        payload: { invoice_id: inv.id, invoice_number: inv.invoice_number, supplier: inv.supplier_name, match_status: check!.status, issues: check!.issues.map((i) => i.message).join(' · ') },
      });
      await auditReq(c, req, 'supplier_invoice', inv.id, 'variance_approval_requested', { reason });
      return { status: 'pending_approval' };
    }));
  });

  r.post('/invoices/:id/reject', requirePermission('procurement.invoice.capture'), async (req, res) => {
    const { reason } = parse(z.object({ reason: reqText(500) }), req.body);
    await tx(pool, async (c) => {
      const r1 = await c.query(`UPDATE supplier_invoices SET status = 'rejected', hold_reason = $2, updated_at = now() WHERE id = $1 AND status = 'draft'`, [req.params.id, reason]);
      if (!r1.rowCount) throw conflict('Only draft invoices can be rejected');
      await resolveExceptions(c, 'invoice_variance', String(req.params.id), `Rejected: ${reason}`);
      await auditReq(c, req, 'supplier_invoice', String(req.params.id), 'rejected', { reason });
    });
    res.json({ ok: true });
  });

  r.post('/invoices/:id/approve-payment', requirePermission('procurement.payment.approve'), async (req, res) => {
    await tx(pool, async (c) => {
      const inv = await one<{ status: string; payment_status: string; posted_by: string | null }>(c, 'SELECT * FROM supplier_invoices WHERE id = $1 FOR UPDATE', [req.params.id]);
      if (!inv) throw notFound('Invoice');
      if (inv.status !== 'posted' || inv.payment_status !== 'unpaid') throw conflict('Only posted, unpaid invoices can be approved for payment');
      await c.query(`UPDATE supplier_invoices SET payment_status = 'approved', payment_approved_by_name = $2, payment_approved_at = now(), updated_at = now() WHERE id = $1`, [req.params.id, req.user!.name]);
      await auditReq(c, req, 'supplier_invoice', String(req.params.id), 'payment_approved');
    });
    res.json({ ok: true });
  });

  // ---------- accounts payable ----------
  r.get('/ap/summary', requirePermission('procurement.invoice.read'), async (_req, res) => {
    const suppliers = await many(pool, `
      SELECT l.supplier_id, max(l.supplier_name) AS supplier_name, round(sum(l.credit - l.debit), 2) AS outstanding,
        round(coalesce(sum(l.credit - l.debit) FILTER (WHERE l.due_date < current_date), 0), 2) AS overdue,
        round(coalesce(sum(l.credit - l.debit) FILTER (WHERE l.due_date BETWEEN current_date AND current_date + 7), 0), 2) AS due_7d,
        round(coalesce(sum(l.credit - l.debit) FILTER (WHERE current_date - l.due_date BETWEEN 1 AND 30), 0), 2) AS age_1_30,
        round(coalesce(sum(l.credit - l.debit) FILTER (WHERE current_date - l.due_date BETWEEN 31 AND 60), 0), 2) AS age_31_60,
        round(coalesce(sum(l.credit - l.debit) FILTER (WHERE current_date - l.due_date > 60), 0), 2) AS age_60_plus,
        min(l.due_date) FILTER (WHERE l.due_date >= current_date) AS next_due
      FROM ap_ledger l GROUP BY l.supplier_id HAVING sum(l.credit - l.debit) <> 0 ORDER BY outstanding DESC`);
    const totals = await one(pool, `
      SELECT round(coalesce(sum(credit - debit), 0), 2) AS outstanding,
        round(coalesce(sum(credit - debit) FILTER (WHERE due_date < current_date), 0), 2) AS overdue,
        round(coalesce(sum(credit - debit) FILTER (WHERE due_date BETWEEN current_date AND current_date + 7), 0), 2) AS due_7d
      FROM ap_ledger`);
    const awaiting = await one(pool, `SELECT count(*)::int AS n, round(coalesce(sum(total_value), 0), 2) AS value FROM supplier_invoices WHERE status = 'posted' AND payment_status = 'approved'`);
    res.json({ totals, suppliers, approved_for_payment: awaiting });
  });

  r.get('/ap/ledger', requirePermission('procurement.invoice.read'), async (req, res) => {
    const params: unknown[] = [];
    const where = req.query.supplier ? (params.push(req.query.supplier), 'WHERE supplier_id = $1') : '';
    res.json(await many(pool, `SELECT *, sum(credit - debit) OVER (PARTITION BY supplier_id ORDER BY entry_date, id) AS balance FROM ap_ledger ${where} ORDER BY entry_date DESC, id DESC LIMIT 500`, params));
  });

  // ---------- three-way match & exceptions dashboard ----------
  r.get('/match/overview', requirePermission('procurement.invoice.read', 'procurement.read'), async (_req, res) => {
    const [exceptions, unbilled, held, awaitingAcceptance, counts] = await Promise.all([
      many(pool, `SELECT * FROM exceptions WHERE status = 'open' ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, detected_at DESC LIMIT 200`),
      many(pool, `
        SELECT p.id AS po_id, p.number AS po_number, p.supplier_name, p.deliver_to_type, p.deliver_to_name, l.sku, l.qty_kg AS ordered_kg, l.received_kg, l.invoiced_kg,
          round(l.received_kg - l.invoiced_kg, 3) AS unbilled_kg, round((l.received_kg - l.invoiced_kg) * l.rate_per_kg, 2) AS unbilled_value,
          (SELECT max(r.receipt_date) FROM receipts r WHERE r.po_id = p.id) AS last_receipt, current_date - (SELECT min(r.receipt_date) FROM receipts r WHERE r.po_id = p.id) AS days_since_receipt
        FROM po_lines l JOIN purchase_orders p ON p.id = l.po_id
        WHERE l.received_kg - l.invoiced_kg > 0.001 AND p.status <> 'cancelled' ORDER BY days_since_receipt DESC NULLS LAST`),
      many(pool, `SELECT i.id, i.invoice_number, i.supplier_name, i.total_value, i.match_status, i.status, i.match_result, p.number AS po_number FROM supplier_invoices i LEFT JOIN purchase_orders p ON p.id = i.po_id WHERE i.status IN ('draft','pending_approval') AND i.match_status <> 'matched' ORDER BY i.created_at DESC`),
      many(pool, `SELECT id, number, supplier_name, sent_at, total_value, extract(epoch from now() - sent_at) / 3600 AS hours_waiting FROM purchase_orders WHERE status = 'sent' ORDER BY sent_at`),
      one(pool, `SELECT
          (SELECT count(*)::int FROM exceptions WHERE status = 'open') AS open_exceptions,
          (SELECT count(*)::int FROM supplier_invoices WHERE status = 'draft' AND match_status = 'matched') AS ready_to_post,
          (SELECT count(*)::int FROM supplier_invoices WHERE status IN ('draft','pending_approval') AND match_status <> 'matched') AS on_hold,
          (SELECT round(coalesce(sum((l.received_kg - l.invoiced_kg) * l.rate_per_kg), 0), 2) FROM po_lines l JOIN purchase_orders p ON p.id = l.po_id WHERE l.received_kg > l.invoiced_kg AND p.status <> 'cancelled') AS unbilled_value,
          (SELECT count(*)::int FROM invoice_captures WHERE status = 'needs_review') AS captures_to_review`),
    ]);
    res.json({ counts, exceptions, unbilled, held, awaiting_acceptance: awaitingAcceptance });
  });

  r.get('/exceptions', requirePermission('procurement.read', 'procurement.invoice.read'), async (req, res) => {
    const status = (req.query.status as string) ?? 'open';
    res.json(await many(pool, `SELECT * FROM exceptions WHERE status = $1 ORDER BY detected_at DESC LIMIT 500`, [status]));
  });

  r.post('/exceptions/:id/resolve', requirePermission('procurement.exception.manage'), async (req, res) => {
    const { resolution, dismiss } = parse(z.object({ resolution: reqText(500), dismiss: z.boolean().default(false) }), req.body);
    await tx(pool, async (c) => {
      const r1 = await c.query(`UPDATE exceptions SET status = $2, resolved_at = now(), resolved_by_name = $3, resolution = $4 WHERE id = $1 AND status = 'open'`, [req.params.id, dismiss ? 'dismissed' : 'resolved', req.user!.name, resolution]);
      if (!r1.rowCount) throw notFound('Open exception');
      await auditReq(c, req, 'exception', String(req.params.id), dismiss ? 'dismissed' : 'resolved', { reason: resolution });
    });
    res.json({ ok: true });
  });
}

