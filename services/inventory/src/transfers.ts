import type { Router } from 'express';
import { z } from 'zod';
import { type Client, type Pool, type ServiceContext, badRequest, conflict, many, notFound, notify, one, optText, parse, publish, reqText, requirePermission, scopeClause, tx } from '@erp/platform';
import { S, assertWarehouse, auditReq, getLocations, getProduct, getWarehouse, isoDate, localNumber, nextNumber, raiseException, requestApproval, round2, round3, setting, whLabel } from './common.ts';
import { type Roll, adjustWeight, lockRoll, moveRoll } from './ledger.ts';
import { actorOf } from './inward.ts';

const createBody = z.object({
  from_warehouse_id: z.uuid(),
  to_warehouse_id: z.uuid(),
  reason: z.string().trim().min(3).max(500),
  needed_by: z.string().regex(isoDate).nullable().optional(),
  lines: z.array(z.object({ product_id: z.uuid(), requested_kg: z.number().positive(), lot_id: z.uuid().nullable().optional() })).min(1).max(30),
});

export async function transferDetail(c: Pool | Client, id: string) {
  const t = await one<Record<string, unknown> & { id: string }>(c, 'SELECT * FROM transfers WHERE id::text = $1 OR number = $1', [id]);
  if (!t) throw notFound('Transfer');
  const lines = await many(c, `
    SELECT tl.*, lt.lot_no,
      coalesce((SELECT round(sum(tr.dispatched_kg), 3) FROM transfer_rolls tr JOIN rolls r ON r.id = tr.roll_id WHERE tr.transfer_id = tl.transfer_id AND r.product_id = tl.product_id), 0)::float AS dispatched_kg,
      coalesce((SELECT round(sum(tr.received_kg), 3) FROM transfer_rolls tr JOIN rolls r ON r.id = tr.roll_id WHERE tr.transfer_id = tl.transfer_id AND r.product_id = tl.product_id AND tr.status = 'received'), 0)::float AS received_kg,
      coalesce((SELECT round(sum(weight_kg), 3) FROM rolls r WHERE r.product_id = tl.product_id AND r.state = 'available' AND r.warehouse_id = $2 AND (tl.lot_id IS NULL OR r.lot_id = tl.lot_id)), 0)::float AS available_at_source
    FROM transfer_lines tl LEFT JOIN lots lt ON lt.id = tl.lot_id WHERE tl.transfer_id = $1 ORDER BY tl.line_no`, [t.id, t.from_warehouse_id]);
  const rolls = await many(c, `
    SELECT tr.*, r.barcode, r.weight_kg, r.state, l.lot_no, l.sku FROM transfer_rolls tr JOIN rolls r ON r.id = tr.roll_id JOIN lots l ON l.id = r.lot_id
    WHERE tr.transfer_id = $1 ORDER BY l.sku, r.barcode`, [t.id]);
  return { ...t, lines, rolls };
}

/** Approval decision on a transfer request. */
export async function applyTransferDecision(c: Client, p: { ref_id: string; decision: string; decided_by_name: string; comment: string | null }) {
  const t = await one<{ id: string; status: string; number: string; created_by: string | null }>(c, 'SELECT * FROM transfers WHERE id = $1 FOR UPDATE', [p.ref_id]);
  if (!t || t.status !== 'pending_approval') return;
  const approved = p.decision === 'approved';
  await c.query(`UPDATE transfers SET status = $2, approved_by_name = $3, approved_at = now(), close_reason = CASE WHEN $2 = 'rejected' THEN $4 ELSE close_reason END, updated_at = now() WHERE id = $1`,
    [t.id, approved ? 'approved' : 'rejected', p.decided_by_name, p.comment]);
  if (approved) await notify(c, S, { audience_permission: 'inventory.transfer.execute', kind: 'action', title: `Transfer ${t.number} approved — scan rolls to dispatch`, body: null, link: `/inventory/transfers/${t.id}` });
}

export function transferRoutes(r: Router, { pool }: ServiceContext) {
  r.get('/transfers', requirePermission('inventory.read'), async (req, res) => {
    const params: unknown[] = [req.query.status ?? null];
    const a = scopeClause(req.user!, 'warehouse', 't.from_warehouse_id', params);
    const scope = a ? ` AND (${a} OR t.to_warehouse_id = ANY($2::uuid[]))` : '';
    res.json(await many(pool, `
      SELECT t.*, (SELECT round(sum(requested_kg), 3) FROM transfer_lines WHERE transfer_id = t.id)::float AS requested_kg,
        (SELECT count(*)::int FROM transfer_rolls WHERE transfer_id = t.id) AS rolls,
        (SELECT string_agg(sku, ', ' ORDER BY line_no) FROM transfer_lines WHERE transfer_id = t.id) AS skus
      FROM transfers t WHERE ($1::text IS NULL OR t.status = ANY(string_to_array($1, ',')))${scope} ORDER BY t.created_at DESC LIMIT 300`, params));
  });

  r.get('/transfers/:id', requirePermission('inventory.read'), async (req, res) => {
    res.json(await transferDetail(pool, String(req.params.id)));
  });

  /**
   * Request a transfer. Moving stock between distinct GST registrations is a taxable supply, so it always
   * needs approval and carries a tax invoice (or the document the CA configures), never a stock adjustment.
   */
  r.post('/transfers', requirePermission('inventory.transfer.request'), async (req, res) => {
    const b = parse(createBody, req.body);
    if (b.from_warehouse_id === b.to_warehouse_id) throw badRequest('Choose two different warehouses');
    const [from, to] = await Promise.all([getWarehouse(b.from_warehouse_id), getWarehouse(b.to_warehouse_id)]);
    assertWarehouse(req, from.id);
    const inter = from.gst_registration_id !== to.gst_registration_id;
    const docType = inter ? await setting<'tax_invoice' | 'delivery_challan'>('inventory.inter_gstin_transfer_document', 'tax_invoice') : 'delivery_challan';
    const needsApproval = inter || (await setting('inventory.intra_gstin_transfer_requires_approval', false));
    const products = await Promise.all(b.lines.map((l) => getProduct(l.product_id)));
    const out = await tx(pool, async (c) => {
      for (const [i, l] of b.lines.entries()) {
        const a = await one<{ kg: number }>(c, `SELECT coalesce(sum(weight_kg), 0)::float AS kg FROM rolls WHERE product_id = $1 AND warehouse_id = $2 AND state = 'available' AND ($3::uuid IS NULL OR lot_id = $3)`, [l.product_id, from.id, l.lot_id ?? null]);
        if (a!.kg < l.requested_kg - 0.001) throw badRequest(`Only ${round3(a!.kg)} kg of ${products[i].sku} is available in ${from.code}`);
      }
      const number = await nextNumber(c, 'transfer_order', 'TO-');
      const t = await one<{ id: string }>(c, `
        INSERT INTO transfers (number, from_warehouse_id, from_warehouse_name, from_gst_registration_id, from_gstin, to_warehouse_id, to_warehouse_name, to_gst_registration_id, to_gstin, inter_gstin, document_type, status, reason, needed_by, created_by, created_by_name)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING id`,
        [number, from.id, whLabel(from), from.gst_registration_id, from.gstin, to.id, whLabel(to), to.gst_registration_id, to.gstin, inter, docType, needsApproval ? 'pending_approval' : 'approved', b.reason, b.needed_by ?? null, req.user!.id, req.user!.name]);
      for (const [i, l] of b.lines.entries())
        await c.query(`INSERT INTO transfer_lines (transfer_id, line_no, product_id, sku, product_name, hsn_code, gst_rate, requested_kg, lot_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [t!.id, i + 1, l.product_id, products[i].sku, products[i].name, products[i].hsn_code, products[i].gst_rate, l.requested_kg, l.lot_id ?? null]);
      const kg = round3(b.lines.reduce((s, l) => s + l.requested_kg, 0));
      if (needsApproval)
        await requestApproval(c, req, {
          type: 'stock_transfer', refId: t!.id, permission: 'inventory.transfer.approve',
          title: `Transfer ${number}: ${from.code} → ${to.code}, ${kg} kg`,
          summary: `${inter ? `Between GSTINs ${from.gstin} → ${to.gstin}: ${docType === 'tax_invoice' ? 'tax invoice' : 'delivery challan'} will be issued.` : 'Same GSTIN.'} ${b.reason}`,
          payload: { from: from.code, to: to.code, inter_gstin: inter, document_type: docType, lines: b.lines.map((l, i) => ({ sku: products[i].sku, kg: l.requested_kg })) },
        });
      await auditReq(c, req, 'transfer', t!.id, 'requested', { after: { number, from: from.code, to: to.code, kg, inter_gstin: inter }, reason: b.reason });
      return { id: t!.id, number, status: needsApproval ? 'pending_approval' : 'approved', inter_gstin: inter, document_type: docType };
    });
    res.status(201).json(out);
  });

  /** Scan a roll onto the truck: it leaves the source warehouse and is in transit to the destination. */
  r.post('/transfers/:id/scan-out', requirePermission('inventory.transfer.execute'), async (req, res) => {
    const { barcode } = parse(z.object({ barcode: reqText(40) }), req.body);
    const out = await tx(pool, async (c) => {
      const t = await one<{ id: string; number: string; status: string; from_warehouse_id: string; to_warehouse_id: string }>(c, 'SELECT * FROM transfers WHERE id = $1 FOR UPDATE', [req.params.id]);
      if (!t) throw notFound('Transfer');
      assertWarehouse(req, t.from_warehouse_id);
      if (t.status !== 'approved') throw conflict(t.status === 'pending_approval' ? 'This transfer is waiting for approval' : `Rolls can’t be loaded on a ${t.status.replace('_', ' ')} transfer`);
      const roll = await lockRoll(c, barcode);
      if (roll.transfer_id === t.id && roll.state === 'in_transit') throw conflict(`${roll.barcode} is already loaded`);
      if (roll.warehouse_id !== t.from_warehouse_id || roll.state !== 'available') throw conflict(`${roll.barcode} is not available in the source warehouse`);
      const line = await one<{ lot_id: string | null; requested_kg: number; sku: string }>(c, 'SELECT * FROM transfer_lines WHERE transfer_id = $1 AND product_id = $2', [t.id, roll.product_id]);
      if (!line) throw conflict(`${roll.barcode} is not a fabric on this transfer`);
      if (line.lot_id && line.lot_id !== roll.lot_id) throw conflict(`${roll.barcode} is not from the lot requested`);
      const lot = await one<{ cost_per_kg: number | null }>(c, 'SELECT cost_per_kg FROM lots WHERE id = $1', [roll.lot_id]);
      await c.query(`INSERT INTO transfer_rolls (transfer_id, roll_id, dispatched_kg, value) VALUES ($1,$2,$3,$4)`, [t.id, roll.id, roll.weight_kg, round2(roll.weight_kg * Number(lot?.cost_per_kg ?? 0))]);
      await moveRoll(c, roll, 'transfer_out', { state: 'in_transit', warehouse_id: t.to_warehouse_id, location: null }, { ref: { type: 'transfer', id: t.id, no: t.number }, actor: actorOf(req), set: { transfer_id: t.id } });
      const loaded = await one<{ kg: number }>(c, `SELECT coalesce(sum(tr.dispatched_kg), 0)::float AS kg FROM transfer_rolls tr JOIN rolls r ON r.id = tr.roll_id WHERE tr.transfer_id = $1 AND r.product_id = $2`, [t.id, roll.product_id]);
      return { barcode: roll.barcode, kg: roll.weight_kg, sku: line.sku, loaded_kg: round3(loaded!.kg), requested_kg: Number(line.requested_kg) };
    });
    res.json(out);
  });

  /** Take a roll back off the truck before dispatch is confirmed. */
  r.post('/transfers/:id/unload', requirePermission('inventory.transfer.execute'), async (req, res) => {
    const { barcode } = parse(z.object({ barcode: reqText(40) }), req.body);
    await tx(pool, async (c) => {
      const t = await one<{ id: string; number: string; status: string; from_warehouse_id: string }>(c, 'SELECT * FROM transfers WHERE id = $1 FOR UPDATE', [req.params.id]);
      if (!t || t.status !== 'approved') throw conflict('Rolls can only be unloaded before dispatch');
      const roll = await lockRoll(c, barcode);
      if (roll.transfer_id !== t.id || roll.state !== 'in_transit') throw conflict(`${roll.barcode} is not loaded on this transfer`);
      await c.query('DELETE FROM transfer_rolls WHERE transfer_id = $1 AND roll_id = $2', [t.id, roll.id]);
      await moveRoll(c, roll, 'transfer_in', { state: 'available', warehouse_id: t.from_warehouse_id, location: null }, { ref: { type: 'transfer', id: t.id, no: t.number }, reason: 'Unloaded before dispatch', actor: actorOf(req), set: { transfer_id: null } });
    });
    res.json({ ok: true });
  });

  /** Confirm dispatch: issues the GST document, records transport and the e-way bill. */
  r.post('/transfers/:id/dispatch', requirePermission('inventory.transfer.execute'), async (req, res) => {
    const b = parse(z.object({ transporter_name: z.string().trim().min(2).max(120), lr_number: optText(40), vehicle_no: optText(20), eway_bill_no: optText(20) }), req.body);
    const ewayAbove = Number(await setting('inventory.eway_bill_threshold', 50000));
    const out = await tx(pool, async (c) => {
      const t = await one<{ id: string; number: string; status: string; inter_gstin: boolean; document_type: string; from_gst_registration_id: string; from_gstin: string; to_gstin: string; from_warehouse_name: string; to_warehouse_name: string; to_warehouse_id: string }>(c, 'SELECT * FROM transfers WHERE id = $1 FOR UPDATE', [req.params.id]);
      if (!t) throw notFound('Transfer');
      if (t.status !== 'approved') throw conflict(`This transfer is ${t.status.replace('_', ' ')}`);
      const rolls = await many<{ dispatched_kg: number; value: number; gst_rate: number }>(c, `
        SELECT tr.dispatched_kg::float, tr.value::float, coalesce(tl.gst_rate, 5)::float AS gst_rate
        FROM transfer_rolls tr JOIN rolls r ON r.id = tr.roll_id JOIN transfer_lines tl ON tl.transfer_id = tr.transfer_id AND tl.product_id = r.product_id WHERE tr.transfer_id = $1`, [t.id]);
      if (!rolls.length) throw badRequest('Scan the rolls onto the vehicle first');
      const kg = round3(rolls.reduce((s, x) => s + x.dispatched_kg, 0));
      const taxable = round2(rolls.reduce((s, x) => s + x.value, 0));
      if (taxable > ewayAbove && !b.eway_bill_no) throw badRequest(`Consignment value ₹${taxable.toLocaleString('en-IN')} is above ₹${ewayAbove.toLocaleString('en-IN')}: enter the e-way bill number`, { fields: { eway_bill_no: 'Required' } });
      let cgst = 0, sgst = 0, igst = 0;
      if (t.document_type === 'tax_invoice') {
        // Place of supply: same state → CGST + SGST, different states → IGST (state code = first two GSTIN digits).
        const tax = round2(rolls.reduce((s, x) => s + (x.value * x.gst_rate) / 100, 0));
        if (t.from_gstin.slice(0, 2) === t.to_gstin.slice(0, 2)) { cgst = round2(tax / 2); sgst = round2(tax - cgst); } else igst = tax;
      }
      let docNo: string;
      try { docNo = await nextNumber(c, t.document_type, t.document_type === 'tax_invoice' ? 'TI-' : 'DC-', t.from_gst_registration_id); } catch { docNo = await localNumber(c, t.document_type, t.document_type === 'tax_invoice' ? 'TI-' : 'DC-'); }
      await c.query(`UPDATE transfers SET status = 'in_transit', document_no = $2, transporter_name = $3, lr_number = $4, vehicle_no = $5, eway_bill_no = $6, dispatched_kg = $7, taxable_value = $8, cgst = $9, sgst = $10, igst = $11, dispatched_at = now(), updated_at = now() WHERE id = $1`,
        [t.id, docNo, b.transporter_name, b.lr_number ?? null, b.vehicle_no ?? null, b.eway_bill_no ?? null, kg, taxable, cgst, sgst, igst]);
      // Accounting (P8) books the inter-GSTIN supply from this event; it is not a stock adjustment.
      await publish(c, S, 'inventory.transfer.dispatched', { transfer_id: t.id, number: t.number, inter_gstin: t.inter_gstin, document_type: t.document_type, document_no: docNo, from_gstin: t.from_gstin, to_gstin: t.to_gstin, kg, taxable_value: taxable, cgst, sgst, igst });
      await notify(c, S, { audience_permission: 'inventory.transfer.execute', kind: 'action', title: `${t.number} on its way to ${t.to_warehouse_name}: ${kg} kg`, body: `${b.transporter_name}${b.lr_number ? `, LR ${b.lr_number}` : ''}`, link: `/inventory/transfers/${t.id}` });
      await auditReq(c, req, 'transfer', t.id, 'dispatched', { after: { document_no: docNo, kg, taxable_value: taxable, cgst, sgst, igst, ...b } });
      return { document_no: docNo, kg, taxable_value: taxable, cgst, sgst, igst };
    });
    res.json(out);
  });

  /** Receive at the destination by scanning each roll; a re-weighed roll records the difference. */
  r.post('/transfers/:id/scan-in', requirePermission('inventory.transfer.execute'), async (req, res) => {
    const b = parse(z.object({ barcode: reqText(40), weight_kg: z.number().positive().nullable().optional() }), req.body);
    const tol = Number(await setting('inventory.stocktake_weight_tolerance_kg', 0.5));
    const out = await tx(pool, async (c) => {
      const t = await one<{ id: string; number: string; status: string; to_warehouse_id: string }>(c, 'SELECT * FROM transfers WHERE id = $1 FOR UPDATE', [req.params.id]);
      if (!t) throw notFound('Transfer');
      assertWarehouse(req, t.to_warehouse_id);
      if (!['in_transit', 'partially_received'].includes(t.status)) throw conflict(`This transfer is ${t.status.replace('_', ' ')}`);
      const roll = await lockRoll(c, b.barcode);
      const tr = await one<{ status: string; dispatched_kg: number }>(c, 'SELECT * FROM transfer_rolls WHERE transfer_id = $1 AND roll_id = $2 FOR UPDATE', [t.id, roll.id]);
      if (!tr) throw conflict(`${roll.barcode} was not dispatched on ${t.number}`);
      if (tr.status === 'received') throw conflict(`${roll.barcode} is already received`);
      const rcv = (await getLocations(t.to_warehouse_id).catch(() => [])).find((l) => l.purpose === 'receiving' && l.status === 'active');
      await moveRoll(c, roll, 'transfer_in', { state: 'available', warehouse_id: t.to_warehouse_id, location: rcv ? { id: rcv.id, path: rcv.path } : null }, { ref: { type: 'transfer', id: t.id, no: t.number }, actor: actorOf(req), set: { transfer_id: null } });
      let diff = 0;
      if (b.weight_kg && Math.abs(b.weight_kg - roll.weight_kg) > tol) diff = await adjustWeight(c, roll as Roll, b.weight_kg, 'weight_adjust', { ref: { type: 'transfer', id: t.id, no: t.number }, reason: 'Re-weighed on transfer receipt', actor: actorOf(req) });
      await c.query(`UPDATE transfer_rolls SET status = 'received', received_kg = $3, received_at = now() WHERE transfer_id = $1 AND roll_id = $2`, [t.id, roll.id, roll.weight_kg]);
      const left = await one<{ n: number; kg: number }>(c, `SELECT count(*) FILTER (WHERE status = 'dispatched')::int AS n, coalesce(sum(received_kg) FILTER (WHERE status = 'received'), 0)::float AS kg FROM transfer_rolls WHERE transfer_id = $1`, [t.id]);
      await c.query(`UPDATE transfers SET status = $2, received_kg = $3, received_at = CASE WHEN $2 = 'received' THEN now() ELSE received_at END, updated_at = now() WHERE id = $1`, [t.id, left!.n === 0 ? 'received' : 'partially_received', round3(left!.kg)]);
      return { barcode: roll.barcode, kg: roll.weight_kg, weight_difference: diff, remaining_rolls: left!.n };
    });
    res.json(out);
  });

  /** Close a transfer. Rolls that never arrived are written off with a reason and flagged for investigation. */
  r.post('/transfers/:id/close', requirePermission('inventory.transfer.execute'), async (req, res) => {
    const { reason } = parse(z.object({ reason: optText(500) }), req.body);
    const out = await tx(pool, async (c) => {
      const t = await one<{ id: string; number: string; status: string; to_warehouse_name: string }>(c, 'SELECT * FROM transfers WHERE id = $1 FOR UPDATE', [req.params.id]);
      if (!t) throw notFound('Transfer');
      if (!['in_transit', 'partially_received', 'received'].includes(t.status)) throw conflict(`A ${t.status.replace('_', ' ')} transfer can’t be closed`);
      const missing = await many<Roll>(c, `SELECT r.* FROM transfer_rolls tr JOIN rolls r ON r.id = tr.roll_id WHERE tr.transfer_id = $1 AND tr.status = 'dispatched' FOR UPDATE OF r`, [t.id]);
      if (missing.length && !reason) throw badRequest(`${missing.length} roll(s) were not received. Give a reason to close.`, { fields: { reason: 'Required' } });
      for (const roll of missing) {
        await moveRoll(c, roll, 'write_off', { state: 'written_off', warehouse_id: null, location: null }, { ref: { type: 'transfer', id: t.id, no: t.number }, reason: `Not received: ${reason}`, actor: actorOf(req), set: { transfer_id: null } });
        await c.query(`UPDATE transfer_rolls SET status = 'missing' WHERE transfer_id = $1 AND roll_id = $2`, [t.id, roll.id]);
      }
      const shortKg = round3(missing.reduce((s, x) => s + Number(x.weight_kg), 0));
      if (missing.length)
        await raiseException(c, { kind: 'transfer_shortage', severity: 'critical', ref_type: 'transfer', ref_id: t.id, ref_label: t.number, message: `${t.number}: ${missing.length} roll(s), ${shortKg} kg not received at ${t.to_warehouse_name}`, notifyPermission: 'inventory.transfer.approve', link: `/inventory/transfers/${t.id}` });
      await c.query(`UPDATE transfers SET status = 'closed', closed_at = now(), close_reason = $2, updated_at = now() WHERE id = $1`, [t.id, reason ?? null]);
      await auditReq(c, req, 'transfer', t.id, 'closed', { reason, after: { missing_rolls: missing.length, short_kg: shortKg } });
      return { missing_rolls: missing.length, short_kg: shortKg };
    });
    res.json(out);
  });

  r.post('/transfers/:id/cancel', requirePermission('inventory.transfer.request'), async (req, res) => {
    const { reason } = parse(z.object({ reason: reqText(300) }), req.body);
    await tx(pool, async (c) => {
      const t = await one<{ id: string; status: string }>(c, 'SELECT * FROM transfers WHERE id = $1 FOR UPDATE', [req.params.id]);
      if (!t) throw notFound('Transfer');
      if (!['requested', 'pending_approval', 'approved', 'rejected'].includes(t.status)) throw conflict('A dispatched transfer can’t be cancelled; receive and close it');
      if (await one(c, 'SELECT 1 FROM transfer_rolls WHERE transfer_id = $1', [t.id])) throw conflict('Unload the scanned rolls first');
      await c.query(`UPDATE transfers SET status = 'cancelled', close_reason = $2, updated_at = now() WHERE id = $1`, [t.id, reason]);
      await auditReq(c, req, 'transfer', t.id, 'cancelled', { reason });
    });
    res.json({ ok: true });
  });
}
