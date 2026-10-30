import type { Request, Router } from 'express';
import { z } from 'zod';
import {
  type BusEvent, type Client, type ServiceContext, badRequest, conflict, forbidden, listQuery, many, notFound, notify, one, optText, orderLimit,
  page, parse, publish, reqText, requirePermission, tx,
} from '@erp/platform';
import {
  S, auditReq, getGstRegs, getParty, getPaymentTerms, getProduct, getWarehouses, nextNumber, poEvent, portalUsers, requestApproval, resolveDestination,
  resolveExceptions, round2, setting,
} from './common.ts';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');

export const poBody = z.object({
  supplier_id: z.uuid(),
  bill_to_gst_registration_id: z.uuid().nullable().optional(),
  deliver_to_type: z.enum(['warehouse', 'mill']),
  deliver_to_id: z.uuid(),
  expected_date: isoDate,
  freight_terms: optText(200),
  notes: optText(2000),
  lines: z.array(z.object({ product_id: z.uuid(), qty_kg: z.number().positive(), rate_per_kg: z.number().positive(), notes: optText(300) })).min(1, 'Add at least one line'),
  version: z.number().int().optional(),
});
export type PoInput = z.infer<typeof poBody>;

/** Resolves supplier, GST registrations, tax type and line values for a PO. */
async function buildPo(input: PoInput) {
  const supplier = await getParty(input.supplier_id).catch(() => null);
  if (!supplier || !['supplier', 'manufacturer'].includes(supplier.party_type)) throw badRequest('Choose a supplier or manufacturer', { fields: { supplier_id: 'Required' } });
  if (supplier.status !== 'active') throw badRequest(`${supplier.legal_name} is ${supplier.status}; purchase orders are blocked`);
  const dest = await resolveDestination(input.deliver_to_type, input.deliver_to_id);
  const regs = (await getGstRegs()).filter((g) => g.status === 'active');
  // Bill-to GSTIN: explicit choice, else the receiving warehouse's registration, else the first active one.
  const billToId = input.bill_to_gst_registration_id ?? dest.gstRegistrationId ?? regs[0]?.id;
  const billTo = regs.find((g) => g.id === billToId);
  if (!billTo) throw badRequest('Choose the GST registration the PO is billed to', { fields: { bill_to_gst_registration_id: 'Required' } });
  const intra = !!supplier.state_code && supplier.state_code === billTo.state_code;
  const terms = await getPaymentTerms();
  const term = terms.find((t) => t.id === supplier.payment_term_id);
  const lines = await Promise.all(input.lines.map(async (l, i) => {
    const p = await getProduct(l.product_id).catch(() => null);
    if (!p || p.status !== 'active') throw badRequest(`Line ${i + 1}: choose an active product`);
    const taxable = round2(l.qty_kg * l.rate_per_kg);
    return { ...l, line_no: i + 1, sku: p.sku, product_name: p.name, hsn_code: p.hsn_code, gst_rate: Number(p.gst_rate), taxable, tax: round2((taxable * Number(p.gst_rate)) / 100) };
  }));
  const taxable = round2(lines.reduce((s, l) => s + l.taxable, 0));
  const tax = round2(lines.reduce((s, l) => s + l.tax, 0));
  return { supplier, dest, billTo, intra, term, lines, taxable, tax, total: round2(taxable + tax) };
}

async function writeLines(c: Client, poId: string, lines: Awaited<ReturnType<typeof buildPo>>['lines']) {
  await c.query('DELETE FROM po_lines WHERE po_id = $1', [poId]);
  for (const l of lines)
    await c.query(`INSERT INTO po_lines (po_id, line_no, product_id, sku, product_name, hsn_code, qty_kg, rate_per_kg, gst_rate, taxable, tax, notes) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [poId, l.line_no, l.product_id, l.sku, l.product_name, l.hsn_code, l.qty_kg, l.rate_per_kg, l.gst_rate, l.taxable, l.tax, l.notes ?? null]);
}

export async function createPurchaseOrder(c: Client, req: Request, input: PoInput, links: { rfqId?: string | null; requisitionId?: string | null } = {}) {
  const b = await buildPo(input);
  const number = await nextNumber(c, 'purchase_order', 'PO-');
  const po = await one<{ id: string; number: string }>(c, `
    INSERT INTO purchase_orders (number, supplier_id, supplier_code, supplier_name, supplier_gstin, supplier_state, bill_to_gst_registration_id, bill_to_gstin, bill_to_state,
      deliver_to_type, deliver_to_id, deliver_to_name, rfq_id, requisition_id, expected_date, payment_term, payment_days, freight_terms, notes, tax_type,
      taxable_value, tax_value, total_value, created_by, created_by_name)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25) RETURNING id, number`,
    [number, b.supplier.id, b.supplier.code, b.supplier.legal_name, b.supplier.gstin, b.supplier.state_code, b.billTo.id, b.billTo.gstin, b.billTo.state_code,
      input.deliver_to_type, input.deliver_to_id, b.dest.name, links.rfqId ?? null, links.requisitionId ?? null, input.expected_date, b.term?.name ?? b.supplier.payment_term, b.term?.credit_days ?? 0,
      input.freight_terms ?? null, input.notes ?? null, b.intra ? 'intra' : 'inter', b.taxable, b.tax, b.total, req.user!.id, req.user!.name]);
  await writeLines(c, po!.id, b.lines);
  await poEvent(c, po!.id, 'created', `${b.lines.length} lines · ₹${b.total.toLocaleString('en-IN')}`, { name: req.user!.name });
  await auditReq(c, req, 'purchase_order', po!.id, 'created', { after: { number, supplier: b.supplier.code, total: b.total, deliver_to: b.dest.name } });
  return po!;
}

/** Applies a checker's decision on a PO approval request. */
export async function applyPoDecision(c: Client, p: { ref_id: string; decision: string; decided_by: string; decided_by_name: string; comment: string | null }) {
  const po = await one<{ id: string; number: string; status: string; created_by: string }>(c, 'SELECT id, number, status, created_by FROM purchase_orders WHERE id = $1 FOR UPDATE', [p.ref_id]);
  if (!po || po.status !== 'pending_approval') return;
  if (p.decision === 'approved') {
    await c.query(`UPDATE purchase_orders SET status = 'approved', approved_by = $2, approved_by_name = $3, approved_at = now(), updated_at = now() WHERE id = $1`, [po.id, p.decided_by, p.decided_by_name]);
    await poEvent(c, po.id, 'approved', p.comment, { name: p.decided_by_name });
  } else {
    await c.query(`UPDATE purchase_orders SET status = 'draft', updated_at = now() WHERE id = $1`, [po.id]);
    await poEvent(c, po.id, 'approval_rejected', p.comment, { name: p.decided_by_name });
  }
}

export function orderRoutes(r: Router, { pool }: ServiceContext) {
  r.get('/purchase-orders', requirePermission('procurement.read'), async (req, res) => {
    const lq = listQuery(req, ['number', 'order_date', 'expected_date', 'total_value', 'status', 'supplier_name'], 'order_date');
    const params: unknown[] = [];
    const where: string[] = [];
    const f = lq.filters;
    if (f.status) { params.push(f.status.split(',')); where.push(`p.status = ANY($${params.length})`); }
    if (f.supplier) { params.push(f.supplier); where.push(`p.supplier_id = $${params.length}`); }
    if (f.deliverTo) { params.push(f.deliverTo); where.push(`p.deliver_to_type = $${params.length}`); }
    if (lq.q) { params.push(`%${lq.q}%`); where.push(`(p.number ILIKE $${params.length} OR p.supplier_name ILIKE $${params.length} OR p.deliver_to_name ILIKE $${params.length})`); }
    const rows = await many<{ total_count: number }>(pool, `
      SELECT p.*, (SELECT sum(qty_kg) FROM po_lines l WHERE l.po_id = p.id) AS ordered_kg,
        (SELECT sum(received_kg) FROM po_lines l WHERE l.po_id = p.id) AS received_kg,
        (SELECT sum(invoiced_kg) FROM po_lines l WHERE l.po_id = p.id) AS invoiced_kg,
        count(*) OVER ()::int AS total_count
      FROM purchase_orders p ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ${orderLimit({ ...lq, dir: req.query.dir ? lq.dir : 'desc' }, params).replace('ORDER BY ', 'ORDER BY p.')}`, params);
    res.json(page(rows, lq));
  });

  r.get('/purchase-orders/:id', requirePermission('procurement.read'), async (req, res) => {
    res.json(await poDetail(pool, String(req.params.id)));
  });

  r.post('/purchase-orders', requirePermission('procurement.po.manage'), async (req, res) => {
    const body = parse(poBody, req.body);
    res.status(201).json(await tx(pool, (c) => createPurchaseOrder(c, req, body)));
  });

  r.patch('/purchase-orders/:id', requirePermission('procurement.po.manage'), async (req, res) => {
    const body = parse(poBody, req.body);
    const b = await buildPo(body);
    await tx(pool, async (c) => {
      const po = await one<{ status: string; version: number }>(c, 'SELECT status, version FROM purchase_orders WHERE id = $1 FOR UPDATE', [req.params.id]);
      if (!po) throw notFound('Purchase order');
      if (po.status !== 'draft') throw conflict('Only draft purchase orders can be edited. Use “Revise” on an approved PO.');
      if (body.version !== undefined && body.version !== po.version) throw conflict('Someone else changed this PO. Reload to see the latest version.');
      await c.query(`
        UPDATE purchase_orders SET supplier_id = $2, supplier_code = $3, supplier_name = $4, supplier_gstin = $5, supplier_state = $6, bill_to_gst_registration_id = $7,
          bill_to_gstin = $8, bill_to_state = $9, deliver_to_type = $10, deliver_to_id = $11, deliver_to_name = $12, expected_date = $13, payment_term = $14,
          payment_days = $15, freight_terms = $16, notes = $17, tax_type = $18, taxable_value = $19, tax_value = $20, total_value = $21,
          version = version + 1, updated_at = now(), updated_by = $22 WHERE id = $1`,
        [req.params.id, b.supplier.id, b.supplier.code, b.supplier.legal_name, b.supplier.gstin, b.supplier.state_code, b.billTo.id, b.billTo.gstin, b.billTo.state_code,
          body.deliver_to_type, body.deliver_to_id, b.dest.name, body.expected_date, b.term?.name ?? b.supplier.payment_term, b.term?.credit_days ?? 0,
          body.freight_terms ?? null, body.notes ?? null, b.intra ? 'intra' : 'inter', b.taxable, b.tax, b.total, req.user!.id]);
      await writeLines(c, String(req.params.id), b.lines);
      await poEvent(c, String(req.params.id), 'edited', null, { name: req.user!.name });
      await auditReq(c, req, 'purchase_order', String(req.params.id), 'updated', { after: { total: b.total, lines: b.lines.length } });
    });
    res.json({ ok: true });
  });

  /** Submit for approval. Below the configured threshold a PO is approved immediately. */
  r.post('/purchase-orders/:id/submit', requirePermission('procurement.po.manage'), async (req, res) => {
    const threshold = Number(await setting('procurement.po_approval_threshold', 0));
    const out = await tx(pool, async (c) => {
      const po = await one<{ id: string; number: string; status: string; taxable_value: number; supplier_name: string; total_value: number; deliver_to_name: string; revision: number }>(c, 'SELECT * FROM purchase_orders WHERE id = $1 FOR UPDATE', [req.params.id]);
      if (!po) throw notFound('Purchase order');
      if (po.status !== 'draft') throw conflict('Only draft purchase orders can be submitted');
      if (threshold > 0 && po.taxable_value <= threshold) {
        await c.query(`UPDATE purchase_orders SET status = 'approved', approved_by_name = 'Auto (below threshold)', approved_at = now(), updated_at = now() WHERE id = $1`, [po.id]);
        await poEvent(c, po.id, 'approved', `Below approval threshold ₹${threshold.toLocaleString('en-IN')}`, { type: 'system' });
        return { status: 'approved' };
      }
      await c.query(`UPDATE purchase_orders SET status = 'pending_approval', updated_at = now() WHERE id = $1`, [po.id]);
      await requestApproval(c, req, {
        type: 'purchase_order', refId: po.id, permission: 'procurement.po.approve',
        title: `${po.number}${po.revision ? ` rev ${po.revision}` : ''} · ${po.supplier_name} · ₹${Number(po.total_value).toLocaleString('en-IN')}`,
        summary: `Deliver to ${po.deliver_to_name}`,
        payload: { po_id: po.id, number: po.number, supplier: po.supplier_name, total_value: po.total_value, deliver_to: po.deliver_to_name, revision: po.revision },
      });
      await poEvent(c, po.id, 'submitted', 'Sent for approval', { name: req.user!.name });
      await auditReq(c, req, 'purchase_order', po.id, 'submitted');
      return { status: 'pending_approval' };
    });
    res.json(out);
  });

  r.post('/purchase-orders/:id/send', requirePermission('procurement.po.manage'), async (req, res) => {
    await tx(pool, async (c) => {
      const po = await one<{ id: string; number: string; status: string; supplier_id: string }>(c, 'SELECT * FROM purchase_orders WHERE id = $1 FOR UPDATE', [req.params.id]);
      if (!po) throw notFound('Purchase order');
      if (po.status !== 'approved') throw conflict('Only approved purchase orders can be sent');
      await c.query(`UPDATE purchase_orders SET status = 'sent', sent_at = now(), updated_at = now() WHERE id = $1`, [po.id]);
      await poEvent(c, po.id, 'sent', 'Sent to supplier portal', { name: req.user!.name });
      for (const uid of await portalUsers(po.supplier_id))
        await notify(c, S, { user_id: uid, kind: 'action', title: `New purchase order ${po.number}`, body: 'Please accept or reject and confirm the delivery date.', link: `/portal/orders/${po.id}` });
      await auditReq(c, req, 'purchase_order', po.id, 'sent');
    });
    res.json({ ok: true });
  });

  /** Revision: snapshot the current version, bump the revision and return it to draft for edits and re-approval. */
  r.post('/purchase-orders/:id/revise', requirePermission('procurement.po.manage'), async (req, res) => {
    const { reason } = parse(z.object({ reason: reqText(500) }), req.body);
    await tx(pool, async (c) => {
      const po = await one<Record<string, unknown> & { id: string; status: string; revision: number }>(c, 'SELECT * FROM purchase_orders WHERE id = $1 FOR UPDATE', [req.params.id]);
      if (!po) throw notFound('Purchase order');
      if (!['approved', 'sent', 'accepted', 'rejected_by_supplier', 'partially_received'].includes(po.status)) throw conflict(`A ${po.status.replace(/_/g, ' ')} PO cannot be revised`);
      const lines = await many(c, 'SELECT * FROM po_lines WHERE po_id = $1 ORDER BY line_no', [po.id]);
      await c.query('INSERT INTO po_revisions (po_id, revision, snapshot, reason, created_by_name) VALUES ($1, $2, $3, $4, $5)', [po.id, po.revision, JSON.stringify({ ...po, lines }), reason, req.user!.name]);
      await c.query(`UPDATE purchase_orders SET revision = revision + 1, status = 'draft', approved_by = NULL, approved_by_name = NULL, approved_at = NULL, sent_at = NULL,
        supplier_response_at = NULL, supplier_promise_date = NULL, supplier_remarks = NULL, version = version + 1, updated_at = now() WHERE id = $1`, [po.id]);
      await poEvent(c, po.id, 'revised', `Revision ${po.revision + 1}: ${reason}`, { name: req.user!.name });
      await auditReq(c, req, 'purchase_order', po.id, 'revised', { reason });
    });
    res.json({ ok: true });
  });

  r.post('/purchase-orders/:id/cancel', requirePermission('procurement.po.manage'), async (req, res) => {
    const { reason } = parse(z.object({ reason: reqText(500) }), req.body);
    await tx(pool, async (c) => {
      const po = await one<{ id: string; status: string }>(c, 'SELECT id, status FROM purchase_orders WHERE id = $1 FOR UPDATE', [req.params.id]);
      if (!po) throw notFound('Purchase order');
      const received = await one<{ n: number }>(c, 'SELECT coalesce(sum(received_kg), 0) AS n FROM po_lines WHERE po_id = $1', [po.id]);
      if (received!.n > 0) throw conflict('Goods have been received against this PO. Close it instead of cancelling.');
      if (['cancelled', 'closed'].includes(po.status)) throw conflict('Already closed');
      await c.query(`UPDATE purchase_orders SET status = 'cancelled', updated_at = now() WHERE id = $1`, [po.id]);
      await poEvent(c, po.id, 'cancelled', reason, { name: req.user!.name });
      await auditReq(c, req, 'purchase_order', po.id, 'cancelled', { reason });
    });
    res.json({ ok: true });
  });

  r.post('/purchase-orders/:id/close', requirePermission('procurement.po.manage'), async (req, res) => {
    const { reason } = parse(z.object({ reason: reqText(500) }), req.body);
    await tx(pool, async (c) => {
      const r1 = await c.query(`UPDATE purchase_orders SET status = 'closed', updated_at = now() WHERE id = $1 AND status IN ('partially_received','received','accepted') RETURNING id`, [req.params.id]);
      if (!r1.rowCount) throw conflict('Only received or partially received POs can be closed');
      await poEvent(c, String(req.params.id), 'closed', reason, { name: req.user!.name });
      await auditReq(c, req, 'purchase_order', String(req.params.id), 'closed', { reason });
    });
    res.json({ ok: true });
  });

  r.post('/purchase-orders/:id/dispatches', requirePermission('procurement.po.manage'), async (req, res) => {
    res.status(201).json(await recordDispatch(pool, String(req.params.id), parse(dispatchBody, req.body), { via: 'buyer', name: req.user!.name }));
  });

  r.post('/purchase-orders/:id/receipts', requirePermission('procurement.receipt.record'), async (req, res) => {
    const body = parse(receiptBody, req.body);
    res.status(201).json(await tx(pool, (c) => recordReceipt(c, req, String(req.params.id), body, 'internal')));
  });
}

export const dispatchBody = z.object({
  dispatch_date: isoDate,
  kg: z.number().positive(),
  rolls: z.number().int().positive().nullable().optional(),
  lr_number: optText(40), transporter_name: optText(120), vehicle_no: optText(20), eway_bill_no: optText(20), notes: optText(500),
});

export async function recordDispatch(pool: ServiceContext['pool'], poId: string, d: z.infer<typeof dispatchBody>, by: { via: 'buyer' | 'supplier_portal'; name: string }) {
  return tx(pool, async (c) => {
    const po = await one<{ status: string }>(c, 'SELECT status FROM purchase_orders WHERE id = $1 FOR UPDATE', [poId]);
    if (!po) throw notFound('Purchase order');
    if (!['sent', 'accepted', 'partially_received'].includes(po.status)) throw conflict('Dispatch can only be recorded for sent or accepted POs');
    const row = await one(c, `INSERT INTO dispatches (po_id, dispatch_date, kg, rolls, lr_number, transporter_name, vehicle_no, eway_bill_no, reported_via, reported_by_name, notes)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [poId, d.dispatch_date, d.kg, d.rolls ?? null, d.lr_number ?? null, d.transporter_name ?? null, d.vehicle_no ?? null, d.eway_bill_no ?? null, by.via, by.name, d.notes ?? null]);
    await poEvent(c, poId, 'dispatched', `${d.kg} kg${d.lr_number ? ` · LR ${d.lr_number}` : ''}${d.eway_bill_no ? ` · e-way ${d.eway_bill_no}` : ''}`, { type: by.via === 'buyer' ? 'user' : 'supplier', name: by.name });
    return row;
  });
}

export const receiptBody = z.object({
  receipt_date: isoDate,
  location_id: z.uuid().nullable().optional(),
  challan_no: optText(40), lr_number: optText(40), notes: optText(500),
  lines: z.array(z.object({ po_line_id: z.uuid(), received_kg: z.number().min(0), rejected_kg: z.number().min(0).default(0), rolls: z.number().int().min(0).nullable().optional(), remarks: optText(300) })).min(1),
});

/**
 * Goods receipt against a PO — at our warehouse, or at a mill for direct-to-mill purchases.
 * Material received at a mill stays trader-owned stock; the job-work service picks it up from the event.
 */
export async function recordReceipt(c: Client, req: Request, poId: string, body: z.infer<typeof receiptBody>, source: 'internal' | 'mill_portal') {
  const po = await one<{ id: string; number: string; status: string; deliver_to_type: 'warehouse' | 'mill'; deliver_to_id: string; deliver_to_name: string; supplier_id: string; supplier_name: string }>(
    c, 'SELECT * FROM purchase_orders WHERE id = $1 FOR UPDATE', [poId]);
  if (!po) throw notFound('Purchase order');
  if (!['sent', 'accepted', 'partially_received'].includes(po.status)) throw conflict(`Receipts can’t be recorded on a ${po.status.replace(/_/g, ' ')} PO`);
  if (source === 'mill_portal' && (po.deliver_to_type !== 'mill' || po.deliver_to_id !== req.user!.partyId)) throw forbidden('This PO is not delivered to your mill');
  let locationId = po.deliver_to_id;
  let locationName = po.deliver_to_name;
  if (po.deliver_to_type === 'warehouse' && body.location_id && body.location_id !== po.deliver_to_id) {
    const w = (await getWarehouses()).find((x) => x.id === body.location_id);
    if (!w) throw badRequest('Unknown warehouse');
    locationId = w.id;
    locationName = `${w.code} · ${w.name}`;
  }
  const tolerance = Number(await setting('procurement.three_way_tolerance_percent', 2)) / 100;
  const poLines = await many<{ id: string; qty_kg: number; received_kg: number; sku: string; product_id: string; product_name: string }>(c, 'SELECT * FROM po_lines WHERE po_id = $1', [poId]);
  for (const l of body.lines) {
    const pl = poLines.find((x) => x.id === l.po_line_id);
    if (!pl) throw badRequest('Receipt lines must belong to this PO');
    if (l.rejected_kg > l.received_kg) throw badRequest(`${pl.sku}: rejected KG cannot exceed received KG`);
    const accepted = l.received_kg - l.rejected_kg;
    if (pl.received_kg + accepted > pl.qty_kg * (1 + tolerance) + 0.001)
      throw badRequest(`${pl.sku}: accepting ${accepted} kg would exceed the ordered ${pl.qty_kg} kg beyond the ${tolerance * 100}% tolerance`);
  }
  if (!body.lines.some((l) => l.received_kg > 0)) throw badRequest('Enter the received quantity');
  const number = await nextNumber(c, 'goods_receipt', 'GRN-');
  const rc = await one<{ id: string; number: string }>(c, `
    INSERT INTO receipts (number, po_id, receipt_type, location_id, location_name, receipt_date, challan_no, lr_number, source, recorded_by_name, notes, created_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id, number`,
    [number, poId, po.deliver_to_type, locationId, locationName, body.receipt_date, body.challan_no ?? null, body.lr_number ?? null, source, req.user!.name, body.notes ?? null, req.user!.id]);
  for (const l of body.lines) {
    if (l.received_kg === 0) continue;
    await c.query('INSERT INTO receipt_lines (receipt_id, po_line_id, received_kg, rejected_kg, rolls, remarks) VALUES ($1,$2,$3,$4,$5,$6)', [rc!.id, l.po_line_id, l.received_kg, l.rejected_kg, l.rolls ?? null, l.remarks ?? null]);
    await c.query('UPDATE po_lines SET received_kg = received_kg + $2, rejected_kg = rejected_kg + $3 WHERE id = $1', [l.po_line_id, l.received_kg - l.rejected_kg, l.rejected_kg]);
  }
  const totals = await one<{ ordered: number; received: number }>(c, 'SELECT sum(qty_kg) AS ordered, sum(received_kg) AS received FROM po_lines WHERE po_id = $1', [poId]);
  const full = totals!.received >= totals!.ordered * (1 - tolerance);
  await c.query(`UPDATE purchase_orders SET status = $2, updated_at = now() WHERE id = $1`, [poId, full ? 'received' : 'partially_received']);
  const kg = round2(body.lines.reduce((s, l) => s + l.received_kg - l.rejected_kg, 0));
  await poEvent(c, poId, po.deliver_to_type === 'mill' ? 'received_at_mill' : 'received', `${rc!.number} · ${kg} kg accepted at ${locationName}`,
    { type: source === 'mill_portal' ? 'mill' : 'user', name: req.user!.name });
  await publish(c, S, 'procurement.receipt.recorded', {
    receipt_id: rc!.id, receipt_number: rc!.number, po_id: poId, po_number: po.number, receipt_type: po.deliver_to_type, location_id: locationId, location_name: locationName,
    supplier_id: po.supplier_id, supplier_name: po.supplier_name, receipt_date: body.receipt_date, source,
    lines: body.lines.filter((l) => l.received_kg > 0).map((l) => {
      const pl = poLines.find((x) => x.id === l.po_line_id)!;
      return { po_line_id: l.po_line_id, product_id: pl.product_id, sku: pl.sku, product_name: pl.product_name, accepted_kg: l.received_kg - l.rejected_kg, rejected_kg: l.rejected_kg, rolls: l.rolls ?? null };
    }),
  });
  await resolveExceptions(c, 'po_not_accepted', poId, 'Goods received');
  await auditReq(c, req, 'goods_receipt', rc!.id, 'recorded', { after: { number: rc!.number, po: po.number, kg, location: locationName, source } });
  return rc!;
}

export async function poDetail(pool: ServiceContext['pool'], id: string): Promise<Record<string, unknown> & { supplier_id: string; status: string; number: string; supplier_name: string; events: unknown[] }> {
  const po = await one<Record<string, unknown>>(pool, 'SELECT * FROM purchase_orders WHERE id = $1', [id]);
  if (!po) throw notFound('Purchase order');
  const [lines, events, dispatches, receipts, receiptLines, invoices, revisions, exceptions] = await Promise.all([
    many(pool, 'SELECT * FROM po_lines WHERE po_id = $1 ORDER BY line_no', [id]),
    many(pool, 'SELECT * FROM po_events WHERE po_id = $1 ORDER BY at', [id]),
    many(pool, 'SELECT * FROM dispatches WHERE po_id = $1 ORDER BY dispatch_date', [id]),
    many<{ id: string }>(pool, 'SELECT * FROM receipts WHERE po_id = $1 ORDER BY receipt_date, created_at', [id]),
    many<{ receipt_id: string }>(pool, 'SELECT rl.*, l.sku FROM receipt_lines rl JOIN receipts r ON r.id = rl.receipt_id JOIN po_lines l ON l.id = rl.po_line_id WHERE r.po_id = $1', [id]),
    many(pool, 'SELECT id, invoice_number, invoice_date, total_value, status, match_status, payment_status FROM supplier_invoices WHERE po_id = $1 ORDER BY invoice_date', [id]),
    many(pool, 'SELECT id, revision, reason, created_by_name, created_at FROM po_revisions WHERE po_id = $1 ORDER BY revision DESC', [id]),
    many(pool, `SELECT * FROM exceptions WHERE ref_id = $1 AND status = 'open'`, [id]),
  ]);
  return { ...po, lines, events, dispatches, receipts: receipts.map((r) => ({ ...r, lines: receiptLines.filter((l) => l.receipt_id === r.id) })), invoices, revisions, exceptions } as never;
}

export function approvalHandler(): (ev: BusEvent, c: Client) => Promise<void> {
  return async (ev, c) => {
    const p = ev.payload as { source_service: string; approval_type: string; ref_id: string; decision: string; decided_by: string; decided_by_name: string; comment: string | null };
    if (p.source_service !== S) return;
    if (p.approval_type === 'purchase_order') await applyPoDecision(c, p);
    if (p.approval_type === 'invoice_posting') {
      const { applyInvoiceDecision } = await import('./invoices.ts');
      await applyInvoiceDecision(c, p);
    }
  };
}

