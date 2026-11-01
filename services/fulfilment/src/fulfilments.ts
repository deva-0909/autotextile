import type { Request, Router } from 'express';
import { z } from 'zod';
import { type BusEvent, type Client, type Pool, type ServiceContext, badRequest, callService, conflict, hasPermission, many, notFound, one, optText, parse, publish, reqText, requirePermission, scopeClause, tx } from '@erp/platform';
import { randomBytes } from 'node:crypto';
import { S, assertWarehouse, auditReq, gstSplit, localNumber, nextNumber, notifyCustomer, raiseException, requestApproval, resolveException, round2, round3, setting } from './common.ts';

interface F { customer_gstin: string | null;
  id: string; number: string; order_id: string; order_no: string; customer_id: string; customer_name: string; customer_state_code: string | null; warehouse_id: string; warehouse_code: string; warehouse_name: string; warehouse_state_code: string;
  gst_registration_id: string; gstin: string; reservation_id: string | null; reservation_no: string | null; status: string; payment_terms: 'advance' | 'credit'; picked_kg: number; picked_rolls: number; packages: number | null; gross_kg: number | null;
  invoice_no: string | null; taxable: number; cgst: number; sgst: number; igst: number; invoice_total: number; amount_settled: number; gate_payment: string; gate_override_status: string;
}
interface ResRoll { id: string; barcode: string; weight_kg: number; state: string; location_path: string | null; lot_no: string; sku: string; product_name: string; grade: string | null; dye_lot: string | null; shade_code: string | null }

async function lockF(c: Client, req: Request, id: string) {
  const f = await one<F>(c, 'SELECT * FROM fulfilments WHERE id = $1 FOR UPDATE', [id]);
  if (!f) throw notFound('Fulfilment');
  assertWarehouse(req, f.warehouse_id);
  return f;
}

/** Dispatch gates, evaluated from the record: picked, invoiced, paid (or credit), and any approved override. */
export function gates(f: F) {
  const invoiced = !!f.invoice_no;
  const paid = ['paid', 'credit', 'override'].includes(f.gate_payment);
  return { picked: f.picked_rolls > 0, packed: f.packages != null, invoiced, payment: f.gate_payment, paid, override: f.gate_override_status };
}

/** Settles an invoice: credit customers within limit are cleared; advance customers have their advance applied. */
async function settle(c: Client, f: F) {
  if (!f.invoice_no) return f;
  if (f.payment_terms === 'credit') {
    const chk = await callService<{ ok: boolean; mode: string }>(S, 'crm', 'GET', `/credit-check/${f.customer_id}?amount=${Number(f.invoice_total) - Number(f.amount_settled)}`).catch(() => null);
    if (chk?.mode === 'credit' && chk.ok) { await c.query(`UPDATE fulfilments SET gate_payment = 'credit', updated_at = now() WHERE id = $1`, [f.id]); return { ...f, gate_payment: 'credit' }; }
  }
  const r = await callService<{ applied_total: number; balance_due: number }>(S, 'commerce', 'POST', '/wallet/apply', { customer_id: f.customer_id, order_id: f.order_id, invoice_no: f.invoice_no, amount: Number(f.invoice_total) });
  const status = r.balance_due <= 0.005 ? 'paid' : f.gate_payment === 'override' ? 'override' : 'pending';
  await c.query(`UPDATE fulfilments SET amount_settled = $2, gate_payment = $3, updated_at = now() WHERE id = $1`, [f.id, r.applied_total, status]);
  if (status === 'paid') await resolveException(c, 'awaiting_payment', f.id, 'Paid');
  else await raiseException(c, { kind: 'awaiting_payment', severity: 'info', ref_type: 'fulfilment', ref_id: f.id, ref_label: `${f.number} · ${f.customer_name}`, message: `${f.invoice_no}: ₹${r.balance_due.toLocaleString('en-IN')} still to be paid by ${f.customer_name} before dispatch`, notifyPermission: 'fulfilment.dispatch', link: `/fulfilment/${f.id}` });
  return { ...f, amount_settled: r.applied_total, gate_payment: status };
}

export async function fulfilmentDetail(c: Pool | Client, id: string) {
  const f = await one<F & Record<string, unknown>>(c, 'SELECT * FROM fulfilments WHERE id::text = $1 OR number = $1', [id]);
  if (!f) throw notFound('Fulfilment');
  const [lines, invoiceLines, shipment, plan] = await Promise.all([
    many(c, 'SELECT * FROM fulfilment_lines WHERE fulfilment_id = $1', [f.id]),
    many(c, 'SELECT * FROM invoice_lines WHERE fulfilment_id = $1 ORDER BY line_no', [f.id]),
    one<{ id: string }>(c, 'SELECT * FROM shipments WHERE fulfilment_id = $1', [f.id]),
    one(c, 'SELECT order_id, status, decision_mode, decision_reason, recommended_warehouse_id, decided_by_name, approved_by_name FROM plans WHERE order_id = $1', [f.order_id]),
  ]);
  const events = shipment ? await many(c, 'SELECT * FROM shipment_events WHERE shipment_id = $1 ORDER BY at', [shipment.id]) : [];
  const pick = f.reservation_id ? await callService<{ rolls: ResRoll[] }>(S, 'inventory', 'GET', `/reservations/${f.reservation_id}`).then((r) => r.rolls).catch(() => []) : [];
  return { ...f, lines, invoice_lines: invoiceLines, shipment: shipment ? { ...shipment, events } : null, plan, pick_list: pick, gates: gates(f) };
}

const dispatchBody = z.object({
  transporter_id: z.uuid().nullable().optional(), transporter_name: z.string().trim().min(2).max(120),
  mode: z.enum(['FTL', 'PTL', 'own_vehicle', 'customer_pickup']), vehicle_no: optText(20), driver_name: optText(80), driver_phone: optText(20),
  lr_number: optText(40), eway_bill_no: optText(20), freight_amount: z.number().min(0).default(0), eta_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
});

export function fulfilmentRoutes(r: Router, { pool }: ServiceContext) {
  /** Dispatch readiness cockpit: every open fulfilment with its gates. */
  r.get('/fulfilments', requirePermission('fulfilment.read'), async (req, res) => {
    const params: unknown[] = [];
    const where: string[] = [];
    if (req.query.status) { params.push(String(req.query.status).split(',')); where.push(`f.status = ANY($${params.length})`); }
    if (req.query.order) { params.push(req.query.order); where.push(`f.order_id = $${params.length}`); }
    const sc = scopeClause(req.user!, 'warehouse', 'f.warehouse_id', params);
    if (sc) where.push(sc);
    const rows = await many<F & Record<string, unknown>>(pool, `
      SELECT f.*, p.booked, s.number AS shipment_no, s.status AS shipment_status, s.lr_number, s.transporter_name,
        (SELECT round(sum(kg_planned), 3)::float FROM fulfilment_lines WHERE fulfilment_id = f.id) AS kg_planned,
        (SELECT string_agg(DISTINCT sku, ', ') FROM fulfilment_lines WHERE fulfilment_id = f.id) AS skus
      FROM fulfilments f JOIN plans p ON p.order_id = f.order_id LEFT JOIN shipments s ON s.fulfilment_id = f.id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY f.created_at DESC LIMIT 300`, params);
    res.json(rows.map((f) => ({ ...f, gates: gates(f) })));
  });

  r.get('/fulfilments/:id', requirePermission('fulfilment.read'), async (req, res) => {
    const d = await fulfilmentDetail(pool, String(req.params.id));
    assertWarehouse(req, d.warehouse_id);
    res.json(d);
  });

  /** Scan a roll from the pick list; it is re-weighed, staged and counted against the order. */
  r.post('/fulfilments/:id/pick', requirePermission('fulfilment.pick'), async (req, res) => {
    const b = parse(z.object({ barcode: reqText(40), weight_kg: z.number().positive().nullable().optional() }), req.body);
    const out = await tx(pool, async (c) => {
      const f = await lockF(c, req, String(req.params.id));
      if (f.status === 'reserved') throw conflict('This order is not booked yet (token or approval pending)');
      if (!['released', 'picking', 'picked'].includes(f.status)) throw conflict(`Picking is closed: ${f.status}`);
      const r1 = await callService<{ kg: number; remaining_rolls: number; picked_kg: number; weight_difference: number }>(S, 'inventory', 'POST', `/reservations/${f.reservation_id}/allocate-scan`, b);
      const status = r1.remaining_rolls === 0 ? 'picked' : 'picking';
      await c.query(`UPDATE fulfilments SET status = $2, picked_kg = $3, picked_rolls = picked_rolls + 1, updated_at = now() WHERE id = $1`, [f.id, status, r1.picked_kg]);
      if (f.status === 'released') await publish(c, S, 'fulfilment.started', { order_id: f.order_id, fulfilment_id: f.id });
      return { ...r1, status };
    });
    res.json(out);
  });

  r.post('/fulfilments/:id/unpick', requirePermission('fulfilment.pick'), async (req, res) => {
    const { barcode } = parse(z.object({ barcode: reqText(40) }), req.body);
    await tx(pool, async (c) => {
      const f = await lockF(c, req, String(req.params.id));
      if (!['picking', 'picked', 'packed'].includes(f.status)) throw conflict('Nothing to un-pick at this stage');
      await callService(S, 'inventory', 'POST', `/reservations/${f.reservation_id}/unallocate`, { barcode });
      const rv = await callService<{ rolls: ResRoll[] }>(S, 'inventory', 'GET', `/reservations/${f.reservation_id}`);
      const picked = rv.rolls.filter((x) => x.state === 'allocated');
      await c.query(`UPDATE fulfilments SET status = $2, picked_kg = $3, picked_rolls = $4, packages = NULL, updated_at = now() WHERE id = $1`, [f.id, picked.length ? 'picking' : 'released', round3(picked.reduce((s, x) => s + Number(x.weight_kg), 0)), picked.length]);
    });
    res.json({ ok: true });
  });

  r.post('/fulfilments/:id/pack', requirePermission('fulfilment.pick'), async (req, res) => {
    const b = parse(z.object({ packages: z.number().int().positive(), gross_kg: z.number().positive() }), req.body);
    await tx(pool, async (c) => {
      const f = await lockF(c, req, String(req.params.id));
      if (!['picking', 'picked'].includes(f.status)) throw conflict('Pick the rolls first');
      if (b.gross_kg < Number(f.picked_kg) - 0.5) throw badRequest(`Gross weight is less than the ${f.picked_kg} kg picked`);
      await c.query(`UPDATE fulfilments SET status = 'packed', packages = $2, gross_kg = $3, updated_at = now() WHERE id = $1`, [f.id, b.packages, b.gross_kg]);
      await auditReq(c, req, 'fulfilment', f.id, 'packed', { after: b });
    });
    res.json({ ok: true });
  });

  /** GST tax invoice from the dispatching warehouse’s GSTIN series, for exactly the rolls picked. */
  r.post('/fulfilments/:id/invoice', requirePermission('fulfilment.invoice'), async (req, res) => {
    const out = await tx(pool, async (c) => {
      const f = await lockF(c, req, String(req.params.id));
      if (f.invoice_no) throw conflict(`Already invoiced on ${f.invoice_no}`);
      if (f.status !== 'packed') throw conflict('Pick and pack the order before invoicing');
      const rv = await callService<{ rolls: (ResRoll & { product_id?: string })[] }>(S, 'inventory', 'GET', `/reservations/${f.reservation_id}`);
      const picked = rv.rolls.filter((x) => x.state === 'allocated');
      const lines = await many<{ product_id: string; sku: string; product_name: string; hsn_code: string | null; gst_rate: number; price_per_kg: number }>(c, 'SELECT DISTINCT ON (sku) * FROM fulfilment_lines WHERE fulfilment_id = $1', [f.id]);
      const inv: { sku: string; product_id: string; product_name: string; hsn_code: string | null; gst_rate: number; price: number; kg: number; rolls: number; barcodes: string[] }[] = [];
      for (const roll of picked) {
        const l = lines.find((x) => x.sku === roll.sku);
        if (!l) throw conflict(`${roll.barcode} is not a fabric on this order`);
        const row = inv.find((x) => x.sku === l.sku) ?? (inv.push({ sku: l.sku, product_id: l.product_id, product_name: l.product_name, hsn_code: l.hsn_code, gst_rate: Number(l.gst_rate), price: Number(l.price_per_kg), kg: 0, rolls: 0, barcodes: [] }), inv[inv.length - 1]!);
        row.kg = round3(row.kg + Number(roll.weight_kg)); row.rolls++; row.barcodes.push(roll.barcode);
      }
      const taxable = round2(inv.reduce((s, l) => s + l.kg * l.price, 0));
      const tax = round2(inv.reduce((s, l) => s + (l.kg * l.price * l.gst_rate) / 100, 0));
      const split = gstSplit(tax, f.warehouse_state_code, f.customer_state_code);
      const number = await nextNumber(c, 'tax_invoice', 'INV-', f.gst_registration_id);
      await c.query(`UPDATE fulfilments SET status = 'invoiced', invoice_no = $2, invoice_date = current_date, taxable = $3, cgst = $4, sgst = $5, igst = $6, invoice_total = $7, updated_at = now() WHERE id = $1`,
        [f.id, number, taxable, split.cgst, split.sgst, split.igst, round2(taxable + tax)]);
      for (const [i, l] of inv.entries())
        await c.query(`INSERT INTO invoice_lines (fulfilment_id, line_no, product_id, sku, product_name, hsn_code, gst_rate, rolls, kg, price_per_kg, taxable, tax, barcodes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
          [f.id, i + 1, l.product_id, l.sku, l.product_name, l.hsn_code, l.gst_rate, l.rolls, l.kg, l.price, round2(l.kg * l.price), round2((l.kg * l.price * l.gst_rate) / 100), l.barcodes]);
      // Accounts receivable and GST returns (P8) book the sale from this event.
      await publish(c, S, 'fulfilment.invoiced', { fulfilment_id: f.id, order_id: f.order_id, invoice_no: number, invoice_date: new Date().toISOString().slice(0, 10), gstin: f.gstin, customer_id: f.customer_id, customer_name: f.customer_name, customer_gstin: f.customer_gstin, place_of_supply: f.customer_state_code, payment_terms: f.payment_terms, taxable, ...split, total: round2(taxable + tax) });
      await auditReq(c, req, 'fulfilment', f.id, 'invoiced', { after: { invoice_no: number, taxable, ...split } });
      const settled = await settle(c, { ...f, invoice_no: number, invoice_total: round2(taxable + tax), status: 'invoiced' });
      if (settled.gate_payment === 'pending') await notifyCustomer(c, f.customer_id, { title: `Invoice ${number} ready — ₹${round2(taxable + tax - Number(settled.amount_settled)).toLocaleString('en-IN')} to pay before dispatch`, link: `/portal/orders/${f.order_id}` });
      return { invoice_no: number, taxable, ...split, total: round2(taxable + tax), gate_payment: settled.gate_payment, settled: Number(settled.amount_settled) };
    });
    res.json(out);
  });

  r.post('/fulfilments/:id/refresh-payment', requirePermission('fulfilment.read'), async (req, res) => {
    const out = await tx(pool, async (c) => settle(c, await lockF(c, req, String(req.params.id))));
    res.json({ gate_payment: out.gate_payment, amount_settled: out.amount_settled });
  });

  /** Ask to dispatch without full payment (or without an invoice); a checker must approve, with a reason. */
  r.post('/fulfilments/:id/gate-override', requirePermission('fulfilment.dispatch'), async (req, res) => {
    const { reason } = parse(z.object({ reason: reqText(500) }), req.body);
    await tx(pool, async (c) => {
      const f = await lockF(c, req, String(req.params.id));
      if (['dispatched', 'delivered', 'cancelled'].includes(f.status)) throw conflict(`This fulfilment is ${f.status}`);
      if (f.gate_override_status === 'pending') throw conflict('An override is already waiting for approval');
      const g = gates(f);
      await c.query(`UPDATE fulfilments SET gate_override_status = 'pending', gate_override_reason = $2 WHERE id = $1`, [f.id, reason]);
      await requestApproval(c, req, {
        type: 'dispatch_gate_override', refId: f.id, permission: 'fulfilment.gate.approve',
        title: `Dispatch ${f.number} (${f.order_no}) without ${!g.invoiced ? 'an invoice' : 'full payment'} · ${f.customer_name}`,
        summary: `${reason}. Invoice ${f.invoice_no ?? 'not issued'}; ₹${round2(Number(f.invoice_total) - Number(f.amount_settled)).toLocaleString('en-IN')} unpaid.`,
        payload: { fulfilment: f.number, order: f.order_no, invoice: f.invoice_no, invoice_total: Number(f.invoice_total), settled: Number(f.amount_settled) },
      });
      await auditReq(c, req, 'fulfilment', f.id, 'gate_override_requested', { reason });
    });
    res.json({ ok: true });
  });

  /**
   * Dispatch. Holds until the GST invoice exists and payment is verified (or approved credit), unless a checker
   * approved an override. Ships exactly the picked rolls; unpicked reserved rolls go back to stock.
   */
  r.post('/fulfilments/:id/dispatch', requirePermission('fulfilment.dispatch'), async (req, res) => {
    const b = parse(dispatchBody, req.body);
    const [needInvoice, needPayment, ewayAbove] = await Promise.all([setting('fulfilment.dispatch_requires_invoice', true), setting('fulfilment.dispatch_requires_payment', true), setting('fulfilment.eway_bill_threshold', 50000)]);
    const out = await tx(pool, async (c) => {
      let f = await lockF(c, req, String(req.params.id));
      if (!['packed', 'invoiced'].includes(f.status)) throw conflict(f.status === 'dispatched' ? 'Already dispatched' : 'Pick and pack before dispatch');
      if (f.invoice_no && f.gate_payment === 'pending') f = { ...f, ...(await settle(c, f)) };
      const g = gates(f);
      const override = f.gate_override_status === 'approved';
      if (needInvoice && !g.invoiced && !override) throw conflict('Dispatch is held until the GST invoice is generated');
      if (needPayment && !g.paid && !override) throw conflict(`Dispatch is held until payment is received: ₹${round2(Number(f.invoice_total) - Number(f.amount_settled)).toLocaleString('en-IN')} due on ${f.invoice_no}`);
      if (Number(f.invoice_total) > Number(ewayAbove) && !b.eway_bill_no && b.mode !== 'customer_pickup') throw badRequest(`Invoice value above ₹${Number(ewayAbove).toLocaleString('en-IN')}: enter the e-way bill number`, { fields: { eway_bill_no: 'Required' } });
      const shipped = await callService<{ rolls: { barcode: string; weight_kg: number }[]; released_rolls: number }>(S, 'inventory', 'POST', `/reservations/${f.reservation_id}/ship`, { ref_no: f.invoice_no ?? f.number, holder: f.customer_name });
      const kg = round3(shipped.rolls.reduce((s, x) => s + Number(x.weight_kg), 0));
      const number = await nextNumber(c, 'shipment', 'SHP-');
      const token = randomBytes(16).toString('hex');
      const s = await one<{ id: string }>(c, `
        INSERT INTO shipments (number, fulfilment_id, order_id, customer_id, customer_name, transporter_id, transporter_name, mode, vehicle_no, driver_name, driver_phone, lr_number, eway_bill_no, freight_amount, kg, rolls, packages, eta_date, tracking_token, created_by_name)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) RETURNING id`,
        [number, f.id, f.order_id, f.customer_id, f.customer_name, b.transporter_id ?? null, b.transporter_name, b.mode, b.vehicle_no ?? null, b.driver_name ?? null, b.driver_phone ?? null, b.lr_number ?? null, b.eway_bill_no ?? null, b.freight_amount, kg, shipped.rolls.length, f.packages, b.eta_date ?? null, token, req.user!.name]);
      await c.query(`INSERT INTO shipment_events (shipment_id, milestone, location, note, by_name) VALUES ($1, 'dispatched', $2, $3, $4)`, [s!.id, f.warehouse_name, `${shipped.rolls.length} rolls · ${kg} kg${b.lr_number ? ` · LR ${b.lr_number}` : ''}`, req.user!.name]);
      await c.query(`UPDATE fulfilments SET status = 'dispatched', dispatched_at = now(), updated_at = now() WHERE id = $1`, [f.id]);
      const open = await one<{ n: number }>(c, `SELECT count(*)::int AS n FROM fulfilments WHERE order_id = $1 AND status NOT IN ('dispatched','delivered','cancelled')`, [f.order_id]);
      await publish(c, S, 'fulfilment.dispatched', { order_id: f.order_id, fulfilment_id: f.id, shipment_id: s!.id, all_dispatched: open!.n === 0, gate: override ? 'override' : f.gate_payment });
      await notifyCustomer(c, f.customer_id, { title: `${f.order_no} dispatched from ${f.warehouse_code}: ${kg} kg`, body: `${b.transporter_name}${b.lr_number ? `, LR ${b.lr_number}` : ''}`, link: `/portal/orders/${f.order_id}` });
      await auditReq(c, req, 'fulfilment', f.id, 'dispatched', { after: { shipment: number, kg, rolls: shipped.rolls.length, ...b, gate: override ? 'override' : f.gate_payment }, reason: override ? f.gate_override_status : null });
      return { shipment_id: s!.id, shipment_no: number, tracking_token: token, kg, rolls: shipped.rolls.length, released_rolls: shipped.released_rolls };
    });
    res.json(out);
  });

  /** Tax invoices raised at dispatch, newest first; q matches the invoice, order or customer. Each opens as the printable invoice. */
  r.get('/invoices', requirePermission('fulfilment.read'), async (req, res) => {
    const q = String(req.query.q ?? '').trim();
    const params: unknown[] = [];
    let where = 'invoice_no IS NOT NULL';
    if (q) { params.push(`%${q}%`); where += ` AND (invoice_no ILIKE $1 OR order_no ILIKE $1 OR customer_name ILIKE $1)`; }
    params.push(Math.min(Number(req.query.limit) || 200, 500));
    res.json(await many(pool, `SELECT id, invoice_no, invoice_date::text, order_no, order_id, customer_name, warehouse_code, status, taxable::float, (cgst + sgst + igst)::float AS gst, invoice_total::float AS total, amount_settled::float AS settled
      FROM fulfilments WHERE ${where} ORDER BY invoice_date DESC NULLS LAST, invoice_no DESC LIMIT $${params.length}`, params));
  });

  /** Printable tax invoice. Customers see only their own. */
  r.get('/invoices/:id', requirePermission('fulfilment.read', 'portal.customer.accounts', 'portal.customer.order'), async (req, res) => {
    const f = await one<F & { invoice_date: string; customer_gstin: string | null }>(pool, 'SELECT * FROM fulfilments WHERE (id::text = $1 OR invoice_no = $1) AND invoice_no IS NOT NULL', [req.params.id]);
    if (!f) throw notFound('Invoice');
    if (req.user!.partyId ? req.user!.partyId !== f.customer_id : !hasPermission(req.user, 'fulfilment.read')) throw notFound('Invoice');
    const [lines, shipment, cust, wh] = await Promise.all([
      many(pool, 'SELECT * FROM invoice_lines WHERE fulfilment_id = $1 ORDER BY line_no', [f.id]),
      one(pool, 'SELECT number, transporter_name, lr_number, vehicle_no, eway_bill_no, dispatched_at FROM shipments WHERE fulfilment_id = $1', [f.id]),
      callService<{ legal_name: string; gstin: string | null; addresses: { kind: string; line1: string; city: string; pincode: string | null }[] }>(S, 'masters', 'GET', `/parties/${f.customer_id}`).catch(() => null),
      callService<{ name: string; address: string | null; city: string; legal_name: string; gstin: string }>(S, 'organisation', 'GET', `/warehouses/${f.warehouse_id}`).catch(() => null),
    ]);
    res.json({ invoice_no: f.invoice_no, invoice_date: f.invoice_date, order_no: f.order_no, seller: { legal_name: wh?.legal_name, gstin: f.gstin, state_code: f.warehouse_state_code, warehouse: f.warehouse_name, address: wh?.address ?? wh?.city },
      buyer: { legal_name: f.customer_name, gstin: f.customer_gstin ?? cust?.gstin, state_code: f.customer_state_code, address: cust?.addresses?.find((a) => a.kind === 'billing') ?? cust?.addresses?.[0] ?? null },
      place_of_supply: f.customer_state_code, lines, taxable: Number(f.taxable), cgst: Number(f.cgst), sgst: Number(f.sgst), igst: Number(f.igst), total: Number(f.invoice_total), settled: Number(f.amount_settled), shipment, irn: null });
  });
}

export async function applyGateDecision(c: Client, p: { ref_id: string; decision: string; decided_by_name: string }) {
  const f = await one<F>(c, 'SELECT * FROM fulfilments WHERE id = $1 FOR UPDATE', [p.ref_id]);
  if (!f || f.gate_override_status !== 'pending') return;
  const ok = p.decision === 'approved';
  await c.query(`UPDATE fulfilments SET gate_override_status = $2, gate_override_by_name = $3, gate_payment = CASE WHEN $2 = 'approved' AND gate_payment = 'pending' THEN 'override' ELSE gate_payment END, updated_at = now() WHERE id = $1`, [f.id, ok ? 'approved' : 'rejected', p.decided_by_name]);
}

/** Money arrived for an order: re-apply the customer’s advance to its unpaid invoices. */
export function paymentReceivedConsumer() {
  return async (ev: BusEvent, c: Client) => {
    const p = ev.payload as { customer_id: string; order_id: string | null; purpose?: string; ref_no?: string | null };
    // Money paid against a named invoice on credit terms is set against that invoice, so the customer's advance does
    // not show it as unapplied (invoices on advance terms are settled below).
    if (p.purpose === 'invoice' && p.ref_no) {
      const f = await one<F>(c, `SELECT * FROM fulfilments WHERE customer_id = $1 AND invoice_no = $2 AND gate_payment = 'credit'`, [p.customer_id, p.ref_no]);
      if (f) {
        const r = await callService<{ applied_total: number }>(S, 'commerce', 'POST', '/wallet/apply', { customer_id: f.customer_id, order_id: f.order_id, invoice_no: f.invoice_no, amount: Number(f.invoice_total) });
        await c.query(`UPDATE fulfilments SET amount_settled = $2, updated_at = now() WHERE id = $1`, [f.id, r.applied_total]);
      }
    }
    const fs = await many<F>(c, `SELECT * FROM fulfilments WHERE customer_id = $1 AND invoice_no IS NOT NULL AND gate_payment IN ('pending','override') AND status = 'invoiced' ORDER BY (order_id = $2) DESC, created_at FOR UPDATE`, [p.customer_id, p.order_id]);
    for (const f of fs) await settle(c, f);
  };
}

export { localNumber };
