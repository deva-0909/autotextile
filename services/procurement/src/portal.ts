import type { Request, Router } from 'express';
import express from 'express';
import { z } from 'zod';
import { type ServiceContext, badRequest, callService, conflict, forbidden, many, notFound, notify, one, optText, parse, requirePermission, tx } from '@erp/platform';
import { S, auditReq, poEvent, resolveExceptions } from './common.ts';
import { dispatchBody, poDetail, receiptBody, recordDispatch, recordReceipt } from './orders.ts';

function partyOf(req: Request) {
  if (!req.user!.partyId) throw forbidden('Your account is not linked to a business partner');
  return req.user!.partyId;
}

/** Supplier and mill portals: partners only ever see their own documents. */
export function portalRoutes(r: Router, { pool }: ServiceContext) {
  // ---------- supplier portal ----------
  r.get('/portal/supplier/orders', requirePermission('portal.supplier.access'), async (req, res) => {
    res.json(await many(pool, `
      SELECT p.id, p.number, p.revision, p.order_date, p.expected_date, p.status, p.total_value, p.deliver_to_name, p.deliver_to_type, p.supplier_promise_date, p.sent_at,
        (SELECT sum(qty_kg) FROM po_lines l WHERE l.po_id = p.id) AS ordered_kg, (SELECT sum(received_kg) FROM po_lines l WHERE l.po_id = p.id) AS received_kg
      FROM purchase_orders p WHERE p.supplier_id = $1 AND p.status NOT IN ('draft','pending_approval','approved') ORDER BY p.order_date DESC`, [partyOf(req)]));
  });

  async function ownPo(req: Request) {
    const po = await poDetail(pool, String(req.params.id));
    if (po.supplier_id !== partyOf(req) || ['draft', 'pending_approval', 'approved'].includes(po.status)) throw notFound('Purchase order');
    return po;
  }

  r.get('/portal/supplier/orders/:id', requirePermission('portal.supplier.access'), async (req, res) => {
    const po = await ownPo(req);
    // Internal notes, approvals and exceptions are not shared with the supplier.
    const { exceptions: _e, revisions: _r, created_by: _c, approved_by: _a, ...shared } = po as Record<string, unknown>;
    const invoices = await many(pool, 'SELECT id, invoice_number, invoice_date, total_value, status, payment_status, due_date FROM supplier_invoices WHERE po_id = $1', [req.params.id]);
    res.json({ ...shared, events: (po.events as { actor_type: string; event: string }[]).filter((e) => ['sent', 'accepted', 'rejected_by_supplier', 'dispatched', 'received', 'received_at_mill', 'revised'].includes(e.event)), invoices });
  });

  r.post('/portal/supplier/orders/:id/respond', requirePermission('portal.supplier.access'), async (req, res) => {
    const body = parse(z.object({ accept: z.boolean(), promise_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(), remarks: optText(500) }), req.body);
    if (body.accept && !body.promise_date) throw badRequest('Confirm the delivery date', { fields: { promise_date: 'Required' } });
    if (!body.accept && !body.remarks) throw badRequest('Tell the buyer why you are rejecting', { fields: { remarks: 'Required' } });
    await tx(pool, async (c) => {
      const po = await one<{ id: string; number: string; status: string; supplier_id: string; created_by: string | null }>(c, 'SELECT * FROM purchase_orders WHERE id = $1 FOR UPDATE', [req.params.id]);
      if (!po || po.supplier_id !== partyOf(req)) throw notFound('Purchase order');
      if (po.status !== 'sent') throw conflict('This order is not awaiting your response');
      await c.query(`UPDATE purchase_orders SET status = $2, supplier_response_at = now(), supplier_promise_date = $3, supplier_remarks = $4, updated_at = now() WHERE id = $1`,
        [po.id, body.accept ? 'accepted' : 'rejected_by_supplier', body.promise_date ?? null, body.remarks ?? null]);
      await poEvent(c, po.id, body.accept ? 'accepted' : 'rejected_by_supplier', body.accept ? `Delivery promised ${body.promise_date}${body.remarks ? ` · ${body.remarks}` : ''}` : body.remarks!, { type: 'supplier', name: req.user!.name });
      await resolveExceptions(c, 'po_not_accepted', po.id, body.accept ? 'Accepted by supplier' : 'Rejected by supplier');
      await notify(c, S, { user_id: po.created_by, audience_permission: po.created_by ? null : 'procurement.po.manage', kind: body.accept ? 'success' : 'warning', title: `${po.number} ${body.accept ? 'accepted' : 'rejected'} by supplier`, body: body.remarks ?? (body.promise_date ? `Promised ${body.promise_date}` : null), link: `/procurement/purchase-orders/${po.id}` });
      await auditReq(c, req, 'purchase_order', po.id, body.accept ? 'supplier_accepted' : 'supplier_rejected', { reason: body.remarks });
    });
    res.json({ ok: true });
  });

  r.post('/portal/supplier/orders/:id/dispatches', requirePermission('portal.supplier.access'), async (req, res) => {
    await ownPo(req);
    res.status(201).json(await recordDispatch(pool, String(req.params.id), parse(dispatchBody, req.body), { via: 'supplier_portal', name: req.user!.name }));
  });

  /** Supplier uploads its invoice; it enters the same AI capture queue and human review as any other invoice. */
  r.post('/portal/supplier/orders/:id/invoice', requirePermission('portal.supplier.access'), express.raw({ type: () => true, limit: 20 * 1024 * 1024 }), async (req, res) => {
    const po = await ownPo(req);
    const mime = String(req.headers['content-type'] ?? '').split(';')[0]!;
    if (!['application/pdf', 'image/png', 'image/jpeg', 'image/webp'].includes(mime)) throw badRequest('Upload the invoice as PDF, PNG, JPEG or WebP');
    const fileName = decodeURIComponent(String(req.headers['x-file-name'] ?? 'invoice')).slice(0, 200);
    const out = await tx(pool, async (c) => {
      const batch = await one<{ id: string }>(c, `SELECT id FROM capture_batches WHERE name = $1`, [`Supplier portal · ${po.supplier_name}`])
        ?? await one<{ id: string }>(c, `INSERT INTO capture_batches (name, created_by_name) VALUES ($1, 'Supplier portal') RETURNING id`, [`Supplier portal · ${po.supplier_name}`]);
      const q = new URLSearchParams({ title: `${po.number} invoice`, document_type: 'SUPPLIER_INVOICE', entity_type: 'purchase_order', entity_id: String(req.params.id) });
      const doc = await callService<{ id: string }>(S, 'governance', 'POST', `/documents?${q}`, req.body as Buffer, { 'content-type': mime, 'x-file-name': encodeURIComponent(fileName) });
      const cap = await one<{ id: string }>(c, `INSERT INTO invoice_captures (batch_id, document_id, file_name, mime_type, data) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [batch!.id, doc.id, fileName, mime, JSON.stringify({ po_reference: po.number })]);
      await poEvent(c, String(req.params.id), 'invoice_uploaded', fileName, { type: 'supplier', name: req.user!.name });
      await notify(c, S, { audience_permission: 'procurement.invoice.capture', kind: 'action', title: `Invoice uploaded for ${po.number}`, body: `${po.supplier_name} · ${fileName}`, link: `/procurement/invoice-workbench/${cap!.id}` });
      return cap;
    });
    res.status(201).json(out);
  });

  r.get('/portal/supplier/summary', requirePermission('portal.supplier.access'), async (req, res) => {
    const id = partyOf(req);
    res.json(await one(pool, `SELECT
      (SELECT count(*)::int FROM purchase_orders WHERE supplier_id = $1 AND status = 'sent') AS awaiting_response,
      (SELECT count(*)::int FROM purchase_orders WHERE supplier_id = $1 AND status IN ('accepted','partially_received')) AS open_orders,
      (SELECT round(coalesce(sum(credit - debit), 0), 2) FROM ap_ledger WHERE supplier_id = $1) AS outstanding,
      (SELECT round(coalesce(sum(credit - debit) FILTER (WHERE due_date < current_date), 0), 2) FROM ap_ledger WHERE supplier_id = $1) AS overdue`, [id]));
  });

  // ---------- mill portal: grey fabric arriving directly from suppliers ----------
  r.get('/portal/mill/incoming', requirePermission('portal.mill.access'), async (req, res) => {
    res.json(await many(pool, `
      SELECT p.id, p.number, p.supplier_name, p.expected_date, p.status,
        json_agg(json_build_object('id', l.id, 'sku', l.sku, 'product_name', l.product_name, 'qty_kg', l.qty_kg, 'received_kg', l.received_kg) ORDER BY l.line_no) AS lines,
        (SELECT json_agg(d ORDER BY d.dispatch_date) FROM dispatches d WHERE d.po_id = p.id) AS dispatches
      FROM purchase_orders p JOIN po_lines l ON l.po_id = p.id
      WHERE p.deliver_to_type = 'mill' AND p.deliver_to_id = $1 AND p.status IN ('sent','accepted','partially_received','received')
      GROUP BY p.id ORDER BY p.expected_date`, [partyOf(req)]));
  });

  /** Mill confirms grey fabric received from the supplier. Portal confirmation is the authoritative record. */
  r.post('/portal/mill/incoming/:id/receive', requirePermission('portal.mill.access'), async (req, res) => {
    const body = parse(receiptBody, req.body);
    res.status(201).json(await tx(pool, (c) => recordReceipt(c, req, String(req.params.id), body, 'mill_portal')));
  });
}
