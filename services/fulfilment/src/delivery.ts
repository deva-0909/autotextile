import type { Request, Router } from 'express';
import { z } from 'zod';
import { type Client, type Pool, type ServiceContext, badRequest, callService, conflict, forbidden, many, notFound, notify, one, optText, parse, publish, reqText, requirePermission, tx } from '@erp/platform';
import { S, assertWarehouse, auditReq, getParty, getWarehouses, localNumber, nextNumber, gstSplit, notifyCustomer, raiseException, round2, round3 } from './common.ts';

interface Shipment { id: string; number: string; fulfilment_id: string; order_id: string; customer_id: string; customer_name: string; transporter_name: string; status: string; kg: number; rolls: number; tracking_token: string }

async function recordPod(c: Client, req: Request, s: Shipment, b: { received_by: string; kg_received: number; condition: 'ok' | 'short' | 'damaged'; remarks?: string | null }, source: 'customer_portal' | 'internal') {
  if (s.status === 'delivered') throw conflict('Delivery is already confirmed');
  if (b.condition !== 'ok' && !b.remarks) throw badRequest('Describe the shortage or damage', { fields: { remarks: 'Required' } });
  await c.query(`UPDATE shipments SET status = 'delivered', delivered_at = now(), pod_received_by = $2, pod_kg = $3, pod_condition = $4, pod_remarks = $5, pod_source = $6, pod_at = now() WHERE id = $1`, [s.id, b.received_by, b.kg_received, b.condition, b.remarks ?? null, source]);
  await c.query(`INSERT INTO shipment_events (shipment_id, milestone, note, source, by_name) VALUES ($1, 'delivered', $2, $3, $4)`, [s.id, `Received by ${b.received_by}: ${b.kg_received} kg${b.condition !== 'ok' ? ` — ${b.condition}: ${b.remarks}` : ''}`, source, req.user!.name]);
  await c.query(`UPDATE fulfilments SET status = 'delivered', delivered_at = now(), updated_at = now() WHERE id = $1`, [s.fulfilment_id]);
  if (b.condition !== 'ok' || Number(s.kg) - b.kg_received > 0.5) {
    const number = await localNumber(c, 'transport_claim', 'TC-');
    const short = round3(Math.max(0, Number(s.kg) - b.kg_received));
    await c.query(`INSERT INTO transport_claims (number, shipment_id, transporter_name, claim_type, kg, description, created_by_name) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [number, s.id, s.transporter_name, b.condition === 'damaged' ? 'damage' : 'short', short || null, b.remarks ?? `Short by ${short} kg`, req.user!.name]);
    await raiseException(c, { kind: 'delivery_discrepancy', severity: 'critical', ref_type: 'shipment', ref_id: s.id, ref_label: `${s.number} · ${s.customer_name}`, message: `${s.number} delivered ${b.condition === 'damaged' ? 'damaged' : `short ${short} kg`} to ${s.customer_name}: claim ${number} opened against ${s.transporter_name}`, notifyPermission: 'fulfilment.returns.manage', link: `/fulfilment/shipments/${s.id}` });
  }
  const open = await one<{ n: number }>(c, `SELECT count(*)::int AS n FROM fulfilments WHERE order_id = $1 AND status NOT IN ('delivered','cancelled')`, [s.order_id]);
  await publish(c, S, 'fulfilment.delivered', { order_id: s.order_id, shipment_id: s.id, all_delivered: open!.n === 0, condition: b.condition });
}

export async function orderSummary(c: Pool | Client, orderId: string) {
  const plan = await one<{ status: string; decision_mode: string | null; decision_reason: string | null; booked: boolean }>(c, 'SELECT status, decision_mode, decision_reason, booked FROM plans WHERE order_id = $1', [orderId]);
  const fs = await many<Record<string, unknown> & { id: string; invoice_no: string | null; invoice_total: number; amount_settled: number; gate_payment: string }>(c, `
    SELECT f.id, f.number, f.warehouse_code, f.warehouse_name, f.status, f.picked_kg, f.picked_rolls, f.invoice_no, f.invoice_date, f.taxable, f.cgst, f.sgst, f.igst, f.invoice_total, f.amount_settled, f.gate_payment, f.dispatched_at, f.delivered_at,
      s.id AS shipment_id, s.number AS shipment_no, s.status AS shipment_status, s.transporter_name, s.lr_number, s.vehicle_no, s.eta_date, s.tracking_token, s.pod_condition, s.pod_kg, s.pod_received_by, s.kg AS shipped_kg
    FROM fulfilments f LEFT JOIN shipments s ON s.fulfilment_id = f.id WHERE f.order_id = $1 AND f.status <> 'cancelled' ORDER BY f.created_at`, [orderId]);
  const returns = await many(c, 'SELECT id, number, status, resolution, credit_note_no, credit_total, created_at FROM returns WHERE order_id = $1 ORDER BY created_at', [orderId]);
  return {
    plan, fulfilments: fs, returns,
    invoices: fs.filter((f) => f.invoice_no).map((f) => ({ fulfilment_id: f.id, invoice_no: f.invoice_no!, total: Number(f.invoice_total), settled: Number(f.amount_settled), balance_due: f.gate_payment === 'credit' ? 0 : round2(Number(f.invoice_total) - Number(f.amount_settled)), on_credit: f.gate_payment === 'credit' })),
  };
}

export function publicTrackingRoutes(r: Router, { pool }: ServiceContext) {
  /** Shareable tracking link: milestones and delivery status, no prices. */
  r.get('/public/track/:token', async (req, res) => {
    const s = await one<Shipment & { lr_number: string | null; eta_date: string | null; dispatched_at: string; delivered_at: string | null; mode: string; pod_received_by: string | null }>(pool, 'SELECT * FROM shipments WHERE tracking_token = $1', [req.params.token]);
    if (!s) throw notFound('Shipment');
    const f = await one<{ order_no: string; warehouse_name: string }>(pool, 'SELECT order_no, warehouse_name FROM fulfilments WHERE id = $1', [s.fulfilment_id]);
    res.json({ number: s.number, order_no: f?.order_no, customer: s.customer_name, from: f?.warehouse_name, transporter: s.transporter_name, lr_number: s.lr_number, mode: s.mode, status: s.status, kg: Number(s.kg), rolls: s.rolls, eta_date: s.eta_date, dispatched_at: s.dispatched_at, delivered_at: s.delivered_at, received_by: s.pod_received_by,
      events: await many(pool, 'SELECT milestone, location, note, at FROM shipment_events WHERE shipment_id = $1 ORDER BY at', [s.id]), live_gps: false });
  });
}

const podBody = z.object({ received_by: reqText(120), kg_received: z.number().min(0), condition: z.enum(['ok', 'short', 'damaged']), remarks: optText(1000) });

export function deliveryRoutes(r: Router, { pool }: ServiceContext) {
  r.get('/orders/:orderId/summary', requirePermission('fulfilment.read', 'commerce.read'), async (req, res) => {
    res.json(await orderSummary(pool, String(req.params.orderId)));
  });

  r.get('/shipments', requirePermission('fulfilment.read'), async (req, res) => {
    res.json(await many(pool, `SELECT s.*, f.order_no, f.warehouse_code, f.invoice_no, (SELECT count(*)::int FROM transport_claims t WHERE t.shipment_id = s.id AND t.status NOT IN ('settled','rejected','closed')) AS open_claims
      FROM shipments s JOIN fulfilments f ON f.id = s.fulfilment_id WHERE ($1::text IS NULL OR s.status = ANY(string_to_array($1, ','))) ORDER BY s.dispatched_at DESC LIMIT 300`, [req.query.status ?? null]));
  });
  r.get('/shipments/:id', requirePermission('fulfilment.read'), async (req, res) => {
    const s = await one<Shipment & Record<string, unknown>>(pool, 'SELECT s.*, f.order_no, f.number AS fulfilment_no, f.warehouse_name, f.invoice_no FROM shipments s JOIN fulfilments f ON f.id = s.fulfilment_id WHERE s.id = $1', [req.params.id]);
    if (!s) throw notFound('Shipment');
    res.json({ ...s, events: await many(pool, 'SELECT * FROM shipment_events WHERE shipment_id = $1 ORDER BY at', [s.id]), claims: await many(pool, 'SELECT * FROM transport_claims WHERE shipment_id = $1 ORDER BY created_at', [s.id]) });
  });

  /** Manual milestones (no transporter GPS API yet). */
  r.post('/shipments/:id/milestones', requirePermission('fulfilment.dispatch'), async (req, res) => {
    const b = parse(z.object({ milestone: z.enum(['picked_up', 'in_transit', 'reached_hub', 'out_for_delivery', 'exception']), location: optText(120), note: optText(500), eta_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional() }), req.body);
    await tx(pool, async (c) => {
      const s = await one<Shipment>(c, 'SELECT * FROM shipments WHERE id = $1 FOR UPDATE', [req.params.id]);
      if (!s) throw notFound('Shipment');
      if (s.status === 'delivered') throw conflict('Already delivered');
      if (b.milestone === 'exception' && !b.note) throw badRequest('Describe the problem');
      await c.query(`INSERT INTO shipment_events (shipment_id, milestone, location, note, by_name) VALUES ($1,$2,$3,$4,$5)`, [s.id, b.milestone, b.location ?? null, b.note ?? null, req.user!.name]);
      await c.query(`UPDATE shipments SET status = $2, eta_date = coalesce($3, eta_date) WHERE id = $1`, [s.id, b.milestone === 'out_for_delivery' ? 'out_for_delivery' : b.milestone === 'exception' ? 'exception' : 'in_transit', b.eta_date ?? null]);
      if (['out_for_delivery', 'exception'].includes(b.milestone)) await notifyCustomer(c, s.customer_id, { title: `${s.number}: ${b.milestone === 'exception' ? `delivery problem — ${b.note}` : 'out for delivery today'}`, link: `/portal/orders/${s.order_id}` });
    });
    res.json({ ok: true });
  });

  r.post('/shipments/:id/pod', requirePermission('fulfilment.dispatch'), async (req, res) => {
    const b = parse(podBody, req.body);
    await tx(pool, async (c) => {
      const s = await one<Shipment>(c, 'SELECT * FROM shipments WHERE id = $1 FOR UPDATE', [req.params.id]);
      if (!s) throw notFound('Shipment');
      await recordPod(c, req, s, b, 'internal');
      await auditReq(c, req, 'shipment', s.id, 'delivered', { after: b });
    });
    res.json({ ok: true });
  });

  /** ePOD from the customer portal: the customer confirms what arrived and reports shortage or damage. */
  r.post('/portal/shipments/:id/pod', requirePermission('portal.customer.order', 'portal.customer.accounts'), async (req, res) => {
    const b = parse(podBody, req.body);
    await tx(pool, async (c) => {
      const s = await one<Shipment>(c, 'SELECT * FROM shipments WHERE id = $1 FOR UPDATE', [req.params.id]);
      if (!s || s.customer_id !== req.user!.partyId) throw notFound('Shipment');
      await recordPod(c, req, s, b, 'customer_portal');
      await auditReq(c, req, 'shipment', s.id, 'delivered_customer_confirmed', { after: b });
    });
    res.json({ ok: true });
  });

  // ----- transport -----
  r.get('/freight-rates', requirePermission('fulfilment.read'), async (_req, res) => {
    res.json(await many(pool, `SELECT * FROM freight_rates ORDER BY status, from_state, to_state, rate_per_kg`));
  });
  r.post('/freight-rates', requirePermission('fulfilment.transport.manage'), async (req, res) => {
    const b = parse(z.object({ transporter_id: z.uuid(), mode: z.enum(['FTL', 'PTL']), from_state: z.string().length(2), to_state: z.string().length(2), rate_per_kg: z.number().min(0), min_charge: z.number().min(0).default(0), eta_days: z.number().int().min(1).max(30) }), req.body);
    const t = await getParty(b.transporter_id).catch(() => null);
    if (!t || t.party_type !== 'transporter') throw badRequest('Choose a transporter');
    const out = await tx(pool, async (c) => {
      await c.query(`UPDATE freight_rates SET status = 'inactive' WHERE transporter_id = $1 AND mode = $2 AND from_state = $3 AND to_state = $4 AND status = 'active'`, [b.transporter_id, b.mode, b.from_state, b.to_state]);
      const row = await one<{ id: string }>(c, `INSERT INTO freight_rates (transporter_id, transporter_name, mode, from_state, to_state, rate_per_kg, min_charge, eta_days, created_by_name) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`, [t.id, t.legal_name, b.mode, b.from_state, b.to_state, b.rate_per_kg, b.min_charge, b.eta_days, req.user!.name]);
      await auditReq(c, req, 'freight_rate', row!.id, 'created', { after: b });
      return row;
    });
    res.status(201).json(out);
  });
  /** Freight comparison for a fulfilment: every transporter rate on the lane, cheapest first. */
  r.get('/fulfilments/:id/freight-quotes', requirePermission('fulfilment.read'), async (req, res) => {
    const f = await one<{ warehouse_state_code: string; customer_state_code: string | null; picked_kg: number; gross_kg: number | null }>(pool, 'SELECT * FROM fulfilments WHERE id = $1', [req.params.id]);
    if (!f) throw notFound('Fulfilment');
    const kg = Number(f.gross_kg ?? f.picked_kg) || 1;
    const rates = await many<{ transporter_id: string; transporter_name: string; mode: string; rate_per_kg: number; min_charge: number; eta_days: number }>(pool, `SELECT * FROM freight_rates WHERE status = 'active' AND from_state = $1 AND to_state = $2`, [f.warehouse_state_code, f.customer_state_code]);
    res.json(rates.map((r1) => ({ ...r1, kg, freight: round2(Math.max(Number(r1.min_charge), Number(r1.rate_per_kg) * kg)) })).sort((a, b) => a.freight - b.freight));
  });

  r.get('/claims', requirePermission('fulfilment.read'), async (_req, res) => {
    res.json(await many(pool, `SELECT t.*, s.number AS shipment_no, s.customer_name, s.lr_number FROM transport_claims t JOIN shipments s ON s.id = t.shipment_id ORDER BY t.created_at DESC LIMIT 300`));
  });
  r.patch('/claims/:id', requirePermission('fulfilment.returns.manage'), async (req, res) => {
    const b = parse(z.object({ status: z.enum(['open', 'filed', 'settled', 'rejected', 'closed']), amount: z.number().min(0).optional(), settlement_amount: z.number().min(0).nullable().optional(), resolution: optText(1000) }), req.body);
    if (['settled', 'rejected', 'closed'].includes(b.status) && !b.resolution) throw badRequest('Record how it was resolved', { fields: { resolution: 'Required' } });
    await tx(pool, async (c) => {
      const r1 = await c.query(`UPDATE transport_claims SET status = $2, amount = coalesce($3, amount), settlement_amount = $4, resolution = coalesce($5, resolution), updated_at = now() WHERE id = $1`, [req.params.id, b.status, b.amount ?? null, b.settlement_amount ?? null, b.resolution ?? null]);
      if (!r1.rowCount) throw notFound('Claim');
      await auditReq(c, req, 'transport_claim', String(req.params.id), b.status, { after: b });
    });
    res.json({ ok: true });
  });

  // ----- returns (RMA) -----
  async function createReturn(c: Client, req: Request, b: { fulfilment_id: string; barcodes: string[]; reason: string }, source: 'customer_portal' | 'internal') {
    const f = await one<{ id: string; order_id: string; order_no: string; customer_id: string; customer_name: string; status: string; invoice_no: string | null }>(c, 'SELECT * FROM fulfilments WHERE id = $1', [b.fulfilment_id]);
    if (!f) throw notFound('Dispatch');
    if (source === 'customer_portal' && f.customer_id !== req.user!.partyId) throw notFound('Dispatch');
    if (!['dispatched', 'delivered'].includes(f.status)) throw conflict('Only dispatched goods can be returned');
    const lines = await many<{ barcodes: string[]; sku: string; kg: number; rolls: number; price_per_kg: number; gst_rate: number }>(c, 'SELECT * FROM invoice_lines WHERE fulfilment_id = $1', [f.id]);
    const rolls = await callService<{ rolls: { barcode: string; weight_kg: number; sku: string }[] }>(S, 'inventory', 'GET', `/reservations/${(await one<{ reservation_id: string }>(c, 'SELECT reservation_id FROM fulfilments WHERE id = $1', [f.id]))!.reservation_id}`).then((r1) => r1.rolls).catch(() => []);
    const taken = await many<{ barcode: string }>(c, `SELECT rl.barcode FROM return_lines rl JOIN returns r ON r.id = rl.return_id WHERE r.fulfilment_id = $1 AND r.status <> 'rejected'`, [f.id]);
    const number = await nextNumber(c, 'rma', 'RMA-');
    const ret = await one<{ id: string }>(c, `INSERT INTO returns (number, order_id, order_no, fulfilment_id, customer_id, customer_name, reason, source, requested_by_name) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`, [number, f.order_id, f.order_no, f.id, f.customer_id, f.customer_name, b.reason, source, req.user!.name]);
    for (const code of [...new Set(b.barcodes.map((x) => x.trim().toUpperCase()))]) {
      const l = lines.find((x) => x.barcodes.includes(code));
      if (!l) throw badRequest(`${code} was not on invoice ${f.invoice_no}`);
      if (taken.some((t) => t.barcode === code)) throw conflict(`${code} is already on another return`);
      const roll = rolls.find((x) => x.barcode === code);
      await c.query(`INSERT INTO return_lines (return_id, barcode, sku, kg, price_per_kg, gst_rate) VALUES ($1,$2,$3,$4,$5,$6)`, [ret!.id, code, l.sku, roll ? Number(roll.weight_kg) : round3(Number(l.kg) / l.rolls), l.price_per_kg, l.gst_rate]);
    }
    await notify(c, S, { audience_permission: 'fulfilment.returns.manage', kind: 'action', title: `Return request ${number} from ${f.customer_name}`, body: b.reason, link: `/fulfilment/returns/${ret!.id}` });
    return { id: ret!.id, number };
  }

  r.get('/returns', requirePermission('fulfilment.read'), async (_req, res) => {
    res.json(await many(pool, `SELECT r.*, (SELECT count(*)::int FROM return_lines WHERE return_id = r.id) AS rolls, (SELECT round(sum(kg), 2)::float FROM return_lines WHERE return_id = r.id) AS kg FROM returns r ORDER BY r.created_at DESC LIMIT 300`));
  });
  r.get('/returns/:id', requirePermission('fulfilment.read', 'portal.customer.order'), async (req, res) => {
    const ret = await one<{ id: string; customer_id: string; fulfilment_id: string }>(pool, 'SELECT r.*, f.invoice_no, f.warehouse_id, f.warehouse_name AS shipped_from FROM returns r JOIN fulfilments f ON f.id = r.fulfilment_id WHERE r.id = $1', [req.params.id]);
    if (!ret || (req.user!.partyId && ret.customer_id !== req.user!.partyId)) throw notFound('Return');
    res.json({ ...ret, lines: await many(pool, 'SELECT * FROM return_lines WHERE return_id = $1 ORDER BY barcode', [ret.id]) });
  });
  r.post('/returns', requirePermission('fulfilment.returns.manage'), async (req, res) => {
    const b = parse(z.object({ fulfilment_id: z.uuid(), barcodes: z.array(z.string().min(3)).min(1).max(200), reason: reqText(1000) }), req.body);
    res.status(201).json(await tx(pool, (c) => createReturn(c, req, b, 'internal')));
  });
  r.get('/portal/returns', requirePermission('portal.customer.order'), async (req, res) => {
    if (!req.user!.partyId) throw forbidden();
    res.json(await many(pool, `SELECT r.*, (SELECT round(sum(kg), 2)::float FROM return_lines WHERE return_id = r.id) AS kg FROM returns r WHERE customer_id = $1 ORDER BY created_at DESC`, [req.user!.partyId]));
  });
  r.post('/portal/returns', requirePermission('portal.customer.order'), async (req, res) => {
    const b = parse(z.object({ fulfilment_id: z.uuid(), barcodes: z.array(z.string().min(3)).min(1).max(200), reason: reqText(1000) }), req.body);
    res.status(201).json(await tx(pool, (c) => createReturn(c, req, b, 'customer_portal')));
  });

  r.post('/returns/:id/authorize', requirePermission('fulfilment.returns.manage'), async (req, res) => {
    const b = parse(z.object({ approve: z.boolean(), note: optText(1000) }), req.body);
    if (!b.approve && !b.note) throw badRequest('Give the reason for rejecting');
    await tx(pool, async (c) => {
      const ret = await one<{ id: string; status: string; customer_id: string; number: string; order_id: string }>(c, 'SELECT * FROM returns WHERE id = $1 FOR UPDATE', [req.params.id]);
      if (!ret) throw notFound('Return');
      if (ret.status !== 'requested') throw conflict(`Already ${ret.status}`);
      await c.query(`UPDATE returns SET status = $2, authorized_by_name = $3, authorized_at = now(), decision_note = $4, updated_at = now() WHERE id = $1`, [ret.id, b.approve ? 'authorized' : 'rejected', req.user!.name, b.note ?? null]);
      await notifyCustomer(c, ret.customer_id, { title: `Return ${ret.number} ${b.approve ? 'authorised — please send the rolls back quoting this number' : 'not accepted'}`, body: b.note ?? null, link: `/portal/orders/${ret.order_id}` });
      await auditReq(c, req, 'return', ret.id, b.approve ? 'authorized' : 'rejected', { reason: b.note });
    });
    res.json({ ok: true });
  });

  /** Rolls arrive back: they re-enter the warehouse on QC hold (stock ledger movement return_in). */
  r.post('/returns/:id/receive', requirePermission('fulfilment.returns.manage'), async (req, res) => {
    const b = parse(z.object({ warehouse_id: z.uuid(), barcodes: z.array(z.string().min(3)).min(1) }), req.body);
    assertWarehouse(req, b.warehouse_id);
    const out = await tx(pool, async (c) => {
      const ret = await one<{ id: string; number: string; status: string }>(c, 'SELECT * FROM returns WHERE id = $1 FOR UPDATE', [req.params.id]);
      if (!ret) throw notFound('Return');
      if (ret.status !== 'authorized') throw conflict(ret.status === 'requested' ? 'Authorise the return first' : `Return is ${ret.status}`);
      const lines = await many<{ barcode: string }>(c, 'SELECT barcode FROM return_lines WHERE return_id = $1', [ret.id]);
      const codes = b.barcodes.map((x) => x.trim().toUpperCase());
      const extra = codes.filter((x) => !lines.some((l) => l.barcode === x));
      if (extra.length) throw badRequest(`Not on this return: ${extra.join(', ')}`);
      await callService(S, 'inventory', 'POST', '/returns/receive', { warehouse_id: b.warehouse_id, barcodes: codes, ref_no: ret.number, reason: 'Customer return' });
      await c.query(`UPDATE return_lines SET received = true WHERE return_id = $1 AND barcode = ANY($2)`, [ret.id, codes]);
      const missing = lines.length - codes.length;
      await c.query(`UPDATE returns SET status = 'received', warehouse_id = $2, received_at = now(), updated_at = now() WHERE id = $1`, [ret.id, b.warehouse_id]);
      await auditReq(c, req, 'return', ret.id, 'received', { after: { rolls: codes.length, missing } });
      return { received: codes.length, not_received: missing };
    });
    res.json(out);
  });

  /** QC disposition per roll: restock (back to available), hold (stays on QC hold) or reject. */
  r.post('/returns/:id/disposition', requirePermission('fulfilment.returns.manage'), async (req, res) => {
    const b = parse(z.object({ lines: z.array(z.object({ barcode: z.string(), disposition: z.enum(['restock', 'hold', 'reject']) })).min(1), note: optText(500) }), req.body);
    await tx(pool, async (c) => {
      const ret = await one<{ id: string; number: string; status: string }>(c, 'SELECT * FROM returns WHERE id = $1 FOR UPDATE', [req.params.id]);
      if (!ret) throw notFound('Return');
      if (ret.status !== 'received') throw conflict('Receive the rolls first');
      const grade = b.lines.filter((l) => l.disposition !== 'hold').map((l) => ({ barcode: l.barcode, grade: l.disposition === 'restock' ? 'A' : 'reject', defects: l.disposition === 'reject' ? ['Customer return'] : [] }));
      if (grade.length) await callService(S, 'inventory', 'POST', '/qc', { results: grade, note: `Return ${ret.number}${b.note ? `: ${b.note}` : ''}` });
      for (const l of b.lines) await c.query('UPDATE return_lines SET disposition = $3 WHERE return_id = $1 AND barcode = $2 AND received', [ret.id, l.barcode.toUpperCase(), l.disposition]);
      await c.query(`UPDATE returns SET status = 'inspected', updated_at = now() WHERE id = $1`, [ret.id]);
      await auditReq(c, req, 'return', ret.id, 'inspected', { after: b.lines, reason: b.note });
    });
    res.json({ ok: true });
  });

  /**
   * Close the return. A credit note from the dispatching GSTIN’s series credits the customer’s advance (refund it
   * from Payments if the customer wants money back); replacement closes the RMA for a new order to be placed.
   */
  r.post('/returns/:id/resolve', requirePermission('fulfilment.returns.manage'), async (req, res) => {
    const b = parse(z.object({ resolution: z.enum(['credit_note', 'replacement']), note: optText(500) }), req.body);
    const out = await tx(pool, async (c) => {
      const ret = await one<{ id: string; number: string; status: string; customer_id: string; order_id: string; fulfilment_id: string }>(c, 'SELECT * FROM returns WHERE id = $1 FOR UPDATE', [req.params.id]);
      if (!ret) throw notFound('Return');
      if (ret.status !== 'inspected') throw conflict('Inspect the returned rolls first');
      const f = (await one<{ gst_registration_id: string; gstin: string; invoice_no: string | null; customer_name: string; customer_gstin: string | null; warehouse_state_code: string; customer_state_code: string | null }>(c, 'SELECT * FROM fulfilments WHERE id = $1', [ret.fulfilment_id]))!;
      const lines = await many<{ kg: number; price_per_kg: number; gst_rate: number }>(c, 'SELECT * FROM return_lines WHERE return_id = $1 AND received', [ret.id]);
      let cn: string | null = null, taxable = 0, tax = 0;
      if (b.resolution === 'credit_note') {
        taxable = round2(lines.reduce((s, l) => s + Number(l.kg) * Number(l.price_per_kg), 0));
        tax = round2(lines.reduce((s, l) => s + (Number(l.kg) * Number(l.price_per_kg) * Number(l.gst_rate)) / 100, 0));
        cn = await nextNumber(c, 'credit_note', 'CN-', f.gst_registration_id);
        await callService(S, 'commerce', 'POST', '/wallet/credit', { customer_id: ret.customer_id, amount: round2(taxable + tax), entry_type: 'credit_note', ref_no: cn, order_id: ret.order_id, narration: `Credit note ${cn} for return ${ret.number}` });
        await publish(c, S, 'fulfilment.credit_note.issued', { return_id: ret.id, credit_note_no: cn, fulfilment_id: ret.fulfilment_id, gstin: f.gstin, original_invoice_no: f.invoice_no, customer_id: ret.customer_id, customer_name: f.customer_name, customer_gstin: f.customer_gstin, ...gstSplit(tax, f.warehouse_state_code, f.customer_state_code), place_of_supply: f.customer_state_code, taxable, tax, total: round2(taxable + tax) });
      }
      await c.query(`UPDATE returns SET status = 'closed', resolution = $2, credit_note_no = $3, credit_taxable = $4, credit_tax = $5, credit_total = $6, decision_note = coalesce($7, decision_note), updated_at = now() WHERE id = $1`, [ret.id, b.resolution, cn, taxable, tax, round2(taxable + tax), b.note ?? null]);
      await notifyCustomer(c, ret.customer_id, { title: `Return ${ret.number} closed${cn ? `: credit note ${cn} for ₹${round2(taxable + tax).toLocaleString('en-IN')} added to your advance` : ' — replacement to follow'}`, link: `/portal/orders/${ret.order_id}` });
      await auditReq(c, req, 'return', ret.id, 'resolved', { after: { resolution: b.resolution, credit_note: cn, total: round2(taxable + tax) }, reason: b.note });
      return { credit_note_no: cn, total: round2(taxable + tax) };
    });
    res.json(out);
  });

  r.get('/exceptions', requirePermission('fulfilment.read'), async (req, res) => {
    res.json(await many(pool, `SELECT * FROM exceptions WHERE status = $1 ORDER BY detected_at DESC LIMIT 300`, [(req.query.status as string) ?? 'open']));
  });

  r.get('/dashboard', requirePermission('fulfilment.read'), async (_req, res) => {
    const whs = await getWarehouses();
    res.json({
      ...(await one(pool, `SELECT
        (SELECT count(*)::int FROM plans WHERE status = 'needs_decision') AS needs_decision,
        (SELECT count(*)::int FROM plans WHERE status = 'pending_split_approval') AS split_pending,
        (SELECT count(*)::int FROM fulfilments WHERE status = 'reserved') AS awaiting_booking,
        (SELECT count(*)::int FROM fulfilments WHERE status IN ('released','picking')) AS to_pick,
        (SELECT count(*)::int FROM fulfilments WHERE status = 'picked') AS to_pack,
        (SELECT count(*)::int FROM fulfilments WHERE status = 'packed') AS to_invoice,
        (SELECT count(*)::int FROM fulfilments WHERE status = 'invoiced' AND gate_payment = 'pending') AS awaiting_payment,
        (SELECT count(*)::int FROM fulfilments WHERE status = 'invoiced' AND gate_payment <> 'pending') AS ready_to_dispatch,
        (SELECT count(*)::int FROM shipments WHERE status IN ('in_transit','out_for_delivery','exception')) AS in_transit,
        (SELECT count(*)::int FROM shipments WHERE status IN ('in_transit','out_for_delivery') AND eta_date < current_date) AS late,
        (SELECT count(*)::int FROM transport_claims WHERE status IN ('open','filed')) AS open_claims,
        (SELECT count(*)::int FROM returns WHERE status NOT IN ('closed','rejected')) AS open_returns,
        (SELECT count(*)::int FROM exceptions WHERE status = 'open') AS open_exceptions`))!,
      by_warehouse: (await many<{ warehouse_id: string; n: number; kg: number }>(pool, `SELECT warehouse_id, count(*)::int AS n, coalesce(sum(picked_kg), 0)::float AS kg FROM fulfilments WHERE status NOT IN ('dispatched','delivered','cancelled') GROUP BY warehouse_id`)).map((x) => ({ ...x, code: whs.find((w) => w.id === x.warehouse_id)?.code })),
    });
  });
}
