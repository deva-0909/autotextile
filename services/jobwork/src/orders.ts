import type { Request, Router } from 'express';
import { z } from 'zod';
import {
  type BusEvent, type Client, type Pool, type ServiceContext, badRequest, conflict, listQuery, many, notFound, notify, one, optText, orderLimit, page, parse,
  publish, reqText, requirePermission, tx,
} from '@erp/platform';
import { S, addDays, auditReq, getParty, getProduct, getWarehouses, nextNumber, portalUsers, raiseException, resolveException, round2, setting, today } from './common.ts';
import { chargeFor, describeCard, pickRateCard } from './rates.ts';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');

const orderBody = z.object({
  mill_id: z.uuid(),
  process_code: z.string(),
  expected_return_date: isoDate,
  instructions: optText(2000),
  transporter_name: optText(120), lr_number: optText(40), vehicle_no: optText(20), eway_bill_no: optText(20),
  lines: z.array(z.discriminatedUnion('source', [
    z.object({ source: z.literal('mill_stock'), mill_stock_id: z.uuid(), kg_sent: z.number().positive(), rolls: z.number().int().positive().nullable().optional(), lot_ref: optText(40) }),
    z.object({ source: z.literal('warehouse'), warehouse_id: z.uuid(), product_id: z.uuid(), kg_sent: z.number().positive(), rolls: z.number().int().positive().nullable().optional(), lot_ref: optText(40) }),
  ])).min(1, 'Add at least one line'),
});

const ACTIVE = ['issued', 'acknowledged', 'in_process', 'ready', 'partially_returned'];

export async function orderDetail(c: Pool | Client, id: string) {
  const o = await one<Record<string, unknown> & { mill_id: string; status: string }>(c, 'SELECT * FROM job_orders WHERE id = $1', [id]);
  if (!o) throw notFound('Job-work order');
  const [lines, stages, returns, claims, exceptions] = await Promise.all([
    many(c, 'SELECT * FROM job_order_lines WHERE job_order_id = $1 ORDER BY line_no', [id]),
    many(c, 'SELECT * FROM stage_updates WHERE job_order_id = $1 ORDER BY at', [id]),
    many(c, 'SELECT * FROM job_returns WHERE job_order_id = $1 ORDER BY return_date, created_at', [id]),
    many(c, 'SELECT id, number, status, kg_affected, amount, claim_type, created_at FROM quality_claims WHERE job_order_id = $1 ORDER BY created_at', [id]),
    many(c, `SELECT * FROM exceptions WHERE ref_id = $1 AND status = 'open'`, [id]),
  ]);
  const quarantine = await many(c, 'SELECT * FROM quarantine_holds WHERE job_order_id = $1 ORDER BY created_at DESC', [id]);
  return { ...o, lines, stage_updates: stages, returns, claims, exceptions, quarantine, reconciliation: reconcile(o as never) };
}

/** Sent vs returned vs lost: everything sent must be accounted for. */
export function reconcile(o: { kg_sent: number; kg_good: number; kg_rejected: number; kg_damaged: number; kg_process_loss: number; kg_quarantine?: number }) {
  const q = Number(o.kg_quarantine ?? 0);
  const accounted = o.kg_good + o.kg_rejected + o.kg_damaged + o.kg_process_loss + q;
  return {
    kg_sent: round2(o.kg_sent), kg_good: round2(o.kg_good), kg_rejected: round2(o.kg_rejected), kg_damaged: round2(o.kg_damaged), kg_process_loss: round2(o.kg_process_loss), kg_quarantine: round2(q),
    kg_balance_at_mill: round2(o.kg_sent - accounted),
    yield_pct: o.kg_sent > 0 && accounted - q > 0 ? round2((o.kg_good / Math.max(accounted - q, 0.0001)) * 100) : null,
    loss_pct: o.kg_sent > 0 && accounted - q > 0 ? round2(((o.kg_rejected + o.kg_damaged + o.kg_process_loss) / (accounted - q)) * 100) : null,
  };
}

/** Records a mill's acknowledgement of material received; a discrepancy opens an exception. */
export async function acknowledge(c: Client, req: Request, id: string, b: { kg_received: number; remarks?: string | null }, source: 'mill_portal' | 'internal') {
  const o = await one<{ id: string; number: string; status: string; kg_sent: number; mill_id: string; mill_name: string; created_by: string | null }>(c, 'SELECT * FROM job_orders WHERE id = $1 FOR UPDATE', [id]);
  if (!o) throw notFound('Job-work order');
  if (source === 'mill_portal' && o.mill_id !== req.user!.partyId) throw notFound('Job-work order');
  if (o.status !== 'issued') throw conflict('This challan is not awaiting acknowledgement');
  const diff = round2(o.kg_sent - b.kg_received);
  if (Math.abs(diff) > 0.001 && !b.remarks) throw badRequest('Explain the quantity difference', { fields: { remarks: 'Required when the received quantity differs' } });
  await c.query(`UPDATE job_orders SET status = 'acknowledged', ack_at = now(), ack_kg = $2, ack_discrepancy_kg = $3, ack_remarks = $4, ack_by_name = $5, ack_source = $6, updated_at = now() WHERE id = $1`,
    [id, b.kg_received, diff, b.remarks ?? null, req.user!.name, source]);
  await c.query(`INSERT INTO stage_updates (job_order_id, stage_code, stage_name, status, kg, note, source, by_name) VALUES ($1, 'RECEIPT', 'Material received at mill', 'completed', $2, $3, $4, $5)`,
    [id, b.kg_received, b.remarks ?? null, source, req.user!.name]);
  await resolveException(c, 'mill_ack_overdue', id, 'Acknowledged');
  if (Math.abs(diff) / o.kg_sent > 0.005)
    await raiseException(c, { kind: 'mill_receipt_discrepancy', severity: 'critical', ref_id: id, ref_label: `${o.number} · ${o.mill_name}`, message: `${o.mill_name} acknowledged ${b.kg_received} kg against ${o.kg_sent} kg sent on ${o.number} (${diff > 0 ? 'short' : 'excess'} ${Math.abs(diff)} kg)`, notifyPermission: 'jobwork.order.manage', link: `/jobwork/orders/${id}` });
  await auditReq(c, req, 'job_order', id, 'acknowledged', { after: { kg_received: b.kg_received, discrepancy: diff, source }, reason: b.remarks });
}

export async function stageUpdate(c: Client, req: Request, id: string, b: { stage_code: string; status: 'started' | 'completed' | 'qc_passed' | 'qc_failed' | 'on_hold'; kg?: number | null; note?: string | null }, source: 'mill_portal' | 'internal') {
  const o = await one<{ id: string; number: string; status: string; mill_id: string; mill_name: string; stages: { code: string; name: string }[] }>(c, 'SELECT * FROM job_orders WHERE id = $1 FOR UPDATE', [id]);
  if (!o) throw notFound('Job-work order');
  if (source === 'mill_portal' && o.mill_id !== req.user!.partyId) throw notFound('Job-work order');
  if (!['acknowledged', 'in_process'].includes(o.status)) throw conflict(o.status === 'issued' ? 'Acknowledge receipt of the material first' : `Stages can’t be updated on a ${o.status.replace(/_/g, ' ')} order`);
  const stage = o.stages.find((s) => s.code === b.stage_code);
  if (!stage) throw badRequest('Unknown stage for this process');
  if (b.status === 'qc_failed' && !b.note) throw badRequest('Describe the QC failure', { fields: { note: 'Required' } });
  await c.query(`INSERT INTO stage_updates (job_order_id, stage_code, stage_name, status, kg, note, source, by_name) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [id, stage.code, stage.name, b.status, b.kg ?? null, b.note ?? null, source, req.user!.name]);
  await c.query(`UPDATE job_orders SET status = 'in_process', current_stage = $2, updated_at = now() WHERE id = $1`, [id, stage.name]);
  if (b.status === 'qc_failed')
    await raiseException(c, { kind: 'mill_qc_failed', severity: 'warning', ref_id: id, ref_label: `${o.number} · ${o.mill_name}`, message: `QC failed at ${stage.name} on ${o.number}: ${b.note}`, notifyPermission: 'jobwork.order.manage', link: `/jobwork/orders/${id}` });
  await auditReq(c, req, 'job_order', id, 'stage_update', { after: { stage: stage.name, status: b.status, source } });
}

export async function markReady(c: Client, req: Request, id: string, note: string | null, source: 'mill_portal' | 'internal') {
  const o = await one<{ id: string; number: string; status: string; mill_id: string; mill_name: string; created_by: string | null }>(c, 'SELECT * FROM job_orders WHERE id = $1 FOR UPDATE', [id]);
  if (!o) throw notFound('Job-work order');
  if (source === 'mill_portal' && o.mill_id !== req.user!.partyId) throw notFound('Job-work order');
  if (!['acknowledged', 'in_process'].includes(o.status)) throw conflict('Only orders in process can be marked ready');
  await c.query(`UPDATE job_orders SET status = 'ready', ready_at = now(), updated_at = now() WHERE id = $1`, [id]);
  await c.query(`INSERT INTO stage_updates (job_order_id, stage_code, stage_name, status, note, source, by_name) VALUES ($1, 'READY', 'Ready for collection', 'completed', $2, $3, $4)`, [id, note, source, req.user!.name]);
  await notify(c, S, { audience_permission: 'jobwork.return.record', kind: 'action', title: `${o.number} ready for collection at ${o.mill_name}`, body: note, link: `/jobwork/orders/${id}` });
  await auditReq(c, req, 'job_order', id, 'ready_for_collection', { reason: note });
}

export function orderRoutes(r: Router, { pool }: ServiceContext) {
  r.get('/mill-stock', requirePermission('jobwork.read'), async (req, res) => {
    const params: unknown[] = [];
    const where = ['kg_in - kg_allocated > 0.001'];
    if (req.query.millId) { params.push(req.query.millId); where.push(`mill_id = $${params.length}`); }
    res.json(await many(pool, `SELECT *, round(kg_in - kg_allocated, 3) AS kg_available FROM mill_stock WHERE ${where.join(' AND ')} ORDER BY mill_name, received_date`, params));
  });

  r.get('/orders', requirePermission('jobwork.read'), async (req, res) => {
    const lq = listQuery(req, ['number', 'issue_date', 'expected_return_date', 'status', 'mill_name', 'created_at'], 'created_at');
    const params: unknown[] = [];
    const where: string[] = [];
    if (lq.filters.status) { params.push(lq.filters.status.split(',')); where.push(`status = ANY($${params.length})`); }
    if (lq.filters.mill) { params.push(lq.filters.mill); where.push(`mill_id = $${params.length}`); }
    if (lq.filters.numbers) { params.push(lq.filters.numbers.split(',')); where.push(`number = ANY($${params.length})`); }
    if (lq.q) { params.push(`%${lq.q}%`); where.push(`(number ILIKE $${params.length} OR mill_name ILIKE $${params.length} OR process_name ILIKE $${params.length})`); }
    const rows = await many<{ total_count: number }>(pool, `
      SELECT *, round(kg_sent - kg_good - kg_rejected - kg_damaged - kg_process_loss - kg_quarantine, 3) AS kg_balance, count(*) OVER ()::int AS total_count
      FROM job_orders ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ${orderLimit({ ...lq, dir: req.query.dir ? lq.dir : 'desc' }, params)}`, params);
    res.json(page(rows, lq));
  });

  r.get('/orders/:id', requirePermission('jobwork.read'), async (req, res) => {
    res.json(await orderDetail(pool, String(req.params.id)));
  });

  r.post('/orders', requirePermission('jobwork.order.manage'), async (req, res) => {
    const b = parse(orderBody, req.body);
    const mill = await getParty(b.mill_id).catch(() => null);
    if (!mill || mill.party_type !== 'mill' || mill.status !== 'active') throw badRequest('Choose an active mill', { fields: { mill_id: 'Required' } });
    const warehouses = await getWarehouses();
    const out = await tx(pool, async (c) => {
      const proc = await one<{ code: string; name: string; stages: unknown; status: string }>(c, 'SELECT * FROM process_templates WHERE code = $1', [b.process_code]);
      if (!proc || proc.status !== 'active') throw badRequest('Choose an active process', { fields: { process_code: 'Required' } });
      const lines = [];
      for (const [i, l] of b.lines.entries()) {
        let productId: string, warehouseName: string | null = null, millStockId: string | null = null, warehouseId: string | null = null;
        if (l.source === 'mill_stock') {
          const s = await one<{ id: string; mill_id: string; product_id: string; kg_in: number; kg_allocated: number; sku: string }>(c, 'SELECT * FROM mill_stock WHERE id = $1 FOR UPDATE', [l.mill_stock_id]);
          if (!s || s.mill_id !== b.mill_id) throw badRequest(`Line ${i + 1}: that grey stock is not at ${mill.legal_name}`);
          if (s.kg_in - s.kg_allocated < l.kg_sent - 0.001) throw badRequest(`Line ${i + 1}: only ${round2(s.kg_in - s.kg_allocated)} kg of ${s.sku} is available at the mill`);
          await c.query('UPDATE mill_stock SET kg_allocated = kg_allocated + $2 WHERE id = $1', [s.id, l.kg_sent]);
          productId = s.product_id;
          millStockId = s.id;
        } else {
          const w = warehouses.find((x) => x.id === l.warehouse_id && x.status === 'active');
          if (!w) throw badRequest(`Line ${i + 1}: choose an active warehouse`);
          productId = l.product_id;
          warehouseId = w.id;
          warehouseName = `${w.code} · ${w.name}`;
        }
        const p = await getProduct(productId);
        const card = await pickRateCard(c, b.mill_id, b.process_code, p.id, p.category_id, today());
        lines.push({ ...l, line_no: i + 1, product: p, millStockId, warehouseId, warehouseName, card, charge: card ? chargeFor(card, l.kg_sent) : 0 });
      }
      const kgSent = round2(lines.reduce((s, l) => s + l.kg_sent, 0));
      const missingRate = lines.filter((l) => !l.card);
      const number = await nextNumber(c, 'job_work_challan', 'JW-');
      const o = await one<{ id: string; number: string }>(c, `
        INSERT INTO job_orders (number, mill_id, mill_code, mill_name, mill_gstin, process_code, process_name, stages, expected_return_date, instructions,
          transporter_name, lr_number, vehicle_no, eway_bill_no, estimated_charge, rate_summary, kg_sent, created_by, created_by_name)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING id, number`,
        [number, mill.id, mill.code, mill.legal_name, mill.gstin, proc.code, proc.name, JSON.stringify(proc.stages), b.expected_return_date, b.instructions ?? null,
          b.transporter_name ?? null, b.lr_number ?? null, b.vehicle_no ?? null, b.eway_bill_no ?? null, round2(lines.reduce((s, l) => s + l.charge, 0)),
          missingRate.length ? `No rate card for ${missingRate.map((l) => l.product.sku).join(', ')}` : [...new Set(lines.map((l) => describeCard(l.card!)))].join('; '), kgSent, req.user!.id, req.user!.name]);
      for (const l of lines)
        await c.query(`INSERT INTO job_order_lines (job_order_id, line_no, source, mill_stock_id, warehouse_id, warehouse_name, product_id, sku, product_name, category_id, lot_ref, rolls, kg_sent, rate_card_id, estimated_charge)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
          [o!.id, l.line_no, l.source, l.millStockId, l.warehouseId, l.warehouseName, l.product.id, l.product.sku, l.product.name, l.product.category_id, l.lot_ref ?? null, l.rolls ?? null, l.kg_sent, l.card?.id ?? null, l.charge]);
      await auditReq(c, req, 'job_order', o!.id, 'created', { after: { number, mill: mill.code, process: proc.code, kg_sent: kgSent } });
      return o;
    });
    res.status(201).json(out);
  });

  /**
   * Go-live: fabric already at a mill on a legacy challan. Only the balance still at the mill is loaded, as grey stock
   * at the mill (valued at the legacy cost) on a job order that the mill has already acknowledged. The statutory
   * return clock runs from the original challan date. Loading the same challan twice returns the first order.
   */
  r.post('/orders/opening', requirePermission('jobwork.order.manage'), async (req, res) => {
    const b = parse(z.object({ mill_id: z.uuid(), process_code: z.string(), legacy_challan_no: z.string().trim().min(1).max(60), challan_date: isoDate, expected_return_date: isoDate,
      migration_ref: optText(40), instructions: optText(2000),
      lines: z.array(z.object({ product_id: z.uuid(), kg_at_mill: z.number().positive(), cost_per_kg: z.number().positive(), rolls: z.number().int().positive().nullable().optional(), lot_ref: optText(40) })).min(1).max(40) }), req.body);
    if (b.challan_date > today()) throw badRequest('The challan date is in the future');
    const mill = await getParty(b.mill_id).catch(() => null);
    if (!mill || mill.party_type !== 'mill' || mill.status !== 'active') throw badRequest('Choose an active mill', { fields: { mill_id: 'Required' } });
    const buffer = Number(await setting('jobwork.internal_buffer_days', 1));
    const statutoryDays = Number(await setting('jobwork.statutory_return_days', 365));
    const out = await tx(pool, async (c) => {
      const ex = await one<{ id: string; number: string }>(c, 'SELECT id, number FROM job_orders WHERE mill_id = $1 AND legacy_ref = $2', [b.mill_id, b.legacy_challan_no]);
      if (ex) return { ...ex, existing: true };
      const proc = await one<{ code: string; name: string; stages: unknown; status: string }>(c, 'SELECT * FROM process_templates WHERE code = $1', [b.process_code]);
      if (!proc || proc.status !== 'active') throw badRequest('Choose an active process', { fields: { process_code: 'Required' } });
      const lines = [];
      for (const [i, l] of b.lines.entries()) {
        const p = await getProduct(l.product_id);
        const ms = await one<{ id: string }>(c, `INSERT INTO mill_stock (mill_id, mill_name, source_type, source_ref, product_id, sku, product_name, kg_in, kg_allocated, rolls, received_date, cost_per_kg)
          VALUES ($1,$2,'opening',$3,$4,$5,$6,$7,$7,$8,$9,$10) RETURNING id`, [mill.id, mill.legal_name, `Legacy challan ${b.legacy_challan_no}`, p.id, p.sku, p.name, l.kg_at_mill, l.rolls ?? null, b.challan_date, l.cost_per_kg]);
        const card = await pickRateCard(c, b.mill_id, b.process_code, p.id, p.category_id, today());
        lines.push({ ...l, line_no: i + 1, product: p, millStockId: ms!.id, card, charge: card ? chargeFor(card, l.kg_at_mill) : 0 });
      }
      const kg = round2(lines.reduce((s, l) => s + l.kg_at_mill, 0));
      const missingRate = lines.filter((l) => !l.card);
      const number = await nextNumber(c, 'job_work_challan', 'JW-');
      const o = await one<{ id: string; number: string }>(c, `
        INSERT INTO job_orders (number, mill_id, mill_code, mill_name, mill_gstin, process_code, process_name, stages, expected_return_date, instructions, estimated_charge, rate_summary, kg_sent, created_by, created_by_name,
          status, issue_date, internal_due_date, statutory_due_date, ack_at, ack_kg, ack_discrepancy_kg, ack_remarks, ack_by_name, ack_source, legacy_ref, migration_ref)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'acknowledged',$16,$17,$18,now(),$13,0,$19,$15,'internal',$20,$21) RETURNING id, number`,
        [number, mill.id, mill.code, mill.legal_name, mill.gstin, proc.code, proc.name, JSON.stringify(proc.stages), b.expected_return_date, [`Legacy challan ${b.legacy_challan_no}`, b.instructions].filter(Boolean).join(' · '),
          round2(lines.reduce((s, l) => s + l.charge, 0)), missingRate.length ? `No rate card for ${missingRate.map((l) => l.product.sku).join(', ')}` : [...new Set(lines.map((l) => describeCard(l.card!)))].join('; '), kg, req.user!.id, req.user!.name,
          b.challan_date, addDays(b.expected_return_date, -buffer), addDays(b.challan_date, statutoryDays), `Balance at mill carried over from the legacy system${b.migration_ref ? ` (${b.migration_ref})` : ''}`, b.legacy_challan_no, b.migration_ref ?? null]);
      for (const l of lines)
        await c.query(`INSERT INTO job_order_lines (job_order_id, line_no, source, mill_stock_id, product_id, sku, product_name, category_id, lot_ref, rolls, kg_sent, rate_card_id, estimated_charge)
          VALUES ($1,$2,'mill_stock',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [o!.id, l.line_no, l.millStockId, l.product.id, l.product.sku, l.product.name, l.product.category_id, l.lot_ref ?? null, l.rolls ?? null, l.kg_at_mill, l.card?.id ?? null, l.charge]);
      await c.query(`INSERT INTO stage_updates (job_order_id, stage_code, stage_name, status, kg, note, source, by_name) VALUES ($1, 'ISSUED', 'Challan issued (legacy)', 'completed', NULL, $2, 'internal', $3), ($1, 'RECEIPT', 'Material at mill (carried over)', 'completed', $4, NULL, 'internal', $3)`,
        [o!.id, `Legacy challan ${b.legacy_challan_no} dated ${b.challan_date}`, req.user!.name, kg]);
      await auditReq(c, req, 'job_order', o!.id, 'migrated', { after: { number, legacy_challan: b.legacy_challan_no, mill: mill.code, kg } });
      return { ...o!, existing: false };
    });
    res.status(201).json(out);
  });

  /** Issue the challan: starts the three clocks (commercial, operational and statutory). */
  r.post('/orders/:id/issue', requirePermission('jobwork.order.manage'), async (req, res) => {
    const { issue_date } = parse(z.object({ issue_date: isoDate.optional() }), req.body);
    const buffer = Number(await setting('jobwork.internal_buffer_days', 1));
    const statutoryDays = Number(await setting('jobwork.statutory_return_days', 365));
    await tx(pool, async (c) => {
      const o = await one<{ id: string; number: string; status: string; mill_id: string; mill_name: string; expected_return_date: string }>(c, 'SELECT * FROM job_orders WHERE id = $1 FOR UPDATE', [req.params.id]);
      if (!o) throw notFound('Job-work order');
      if (o.status !== 'draft') throw conflict('Only draft orders can be issued');
      const issued = issue_date ?? today();
      if (o.expected_return_date < issued) throw badRequest('Expected return date is before the issue date');
      await c.query(`UPDATE job_orders SET status = 'issued', issue_date = $2, internal_due_date = $3, statutory_due_date = $4, updated_at = now() WHERE id = $1`,
        [o.id, issued, addDays(o.expected_return_date, -buffer), addDays(issued, statutoryDays)]);
      await c.query(`INSERT INTO stage_updates (job_order_id, stage_code, stage_name, status, note, source, by_name) VALUES ($1, 'ISSUED', 'Challan issued', 'completed', NULL, 'internal', $2)`, [o.id, req.user!.name]);
      for (const uid of await portalUsers(o.mill_id))
        await notify(c, S, { user_id: uid, kind: 'action', title: `Job-work challan ${o.number}`, body: 'Please acknowledge the material when it arrives.', link: `/portal/jobs/${o.id}` });
      const whLines = await many<{ warehouse_id: string; product_id: string; sku: string; kg_sent: number }>(c, `SELECT warehouse_id, product_id, sku, kg_sent FROM job_order_lines WHERE job_order_id = $1 AND source = 'warehouse'`, [o.id]);
      // Inventory (P4) asks the stores to scan these rolls out to the mill.
      await publish(c, S, 'jobwork.order.issued', { job_order_id: o.id, number: o.number, mill_id: o.mill_id, mill_name: o.mill_name, warehouse_lines: whLines });
      await auditReq(c, req, 'job_order', o.id, 'issued', { after: { issue_date: issued } });
    });
    res.json({ ok: true });
  });

  r.post('/orders/:id/cancel', requirePermission('jobwork.order.manage'), async (req, res) => {
    const { reason } = parse(z.object({ reason: reqText(500) }), req.body);
    await tx(pool, async (c) => {
      const o = await one<{ status: string }>(c, 'SELECT status FROM job_orders WHERE id = $1 FOR UPDATE', [req.params.id]);
      if (!o) throw notFound('Job-work order');
      if (!['draft', 'issued'].includes(o.status)) throw conflict('Only draft or unacknowledged orders can be cancelled');
      // Release grey stock that was reserved for this order.
      await c.query(`UPDATE mill_stock s SET kg_allocated = s.kg_allocated - l.kg_sent FROM job_order_lines l WHERE l.mill_stock_id = s.id AND l.job_order_id = $1`, [req.params.id]);
      await c.query(`UPDATE job_orders SET status = 'cancelled', close_reason = $2, updated_at = now() WHERE id = $1`, [req.params.id, reason]);
      await auditReq(c, req, 'job_order', String(req.params.id), 'cancelled', { reason });
    });
    res.json({ ok: true });
  });

  r.post('/orders/:id/acknowledge', requirePermission('jobwork.order.manage'), async (req, res) => {
    const b = parse(z.object({ kg_received: z.number().min(0), remarks: optText(500) }), req.body);
    await tx(pool, (c) => acknowledge(c, req, String(req.params.id), b, 'internal'));
    res.json({ ok: true });
  });

  r.post('/orders/:id/stages', requirePermission('jobwork.order.manage'), async (req, res) => {
    const b = parse(stageBody, req.body);
    await tx(pool, (c) => stageUpdate(c, req, String(req.params.id), b, 'internal'));
    res.json({ ok: true });
  });

  r.post('/orders/:id/ready', requirePermission('jobwork.order.manage'), async (req, res) => {
    const { note } = parse(z.object({ note: optText(500) }), req.body);
    await tx(pool, (c) => markReady(c, req, String(req.params.id), note ?? null, 'internal'));
    res.json({ ok: true });
  });

  /** Return inward at our warehouse: good, rejected, damaged and process loss must account for what was sent. */
  r.post('/orders/:id/returns', requirePermission('jobwork.return.record'), async (req, res) => {
    const b = parse(z.object({
      return_date: isoDate, warehouse_id: z.uuid(), mill_challan_no: optText(40), lr_number: optText(40),
      kg_good: z.number().min(0), kg_rejected: z.number().min(0).default(0), kg_damaged: z.number().min(0).default(0), kg_process_loss: z.number().min(0).default(0),
      kg_quarantine: z.number().min(0).default(0), quarantine_reason: z.enum(['other_party', 'wrong_shade', 'wrong_gsm', 'wrong_quality', 'other']).optional(), quarantine_note: optText(500), quarantine_rolls: z.number().int().min(0).nullable().optional(),
      rolls: z.number().int().min(0).nullable().optional(), lot_ref: optText(40), loss_reason: optText(500),
    }), req.body);
    const w = (await getWarehouses()).find((x) => x.id === b.warehouse_id);
    if (!w) throw badRequest('Choose a warehouse');
    const minYield = Number(await setting('jobwork.min_yield_percent', 92));
    const out = await tx(pool, async (c) => {
      const o = await one<{ id: string; number: string; status: string; mill_id: string; mill_name: string; process_code: string; kg_sent: number; kg_good: number; kg_rejected: number; kg_damaged: number; kg_process_loss: number; kg_quarantine: number }>(c, 'SELECT * FROM job_orders WHERE id = $1 FOR UPDATE', [req.params.id]);
      if (!o) throw notFound('Job-work order');
      if (!['acknowledged', 'in_process', 'ready', 'partially_returned'].includes(o.status)) throw conflict(o.status === 'issued' ? 'The mill has not acknowledged receipt yet' : `Returns can’t be recorded on a ${o.status.replace(/_/g, ' ')} order`);
      const thisTotal = b.kg_good + b.kg_rejected + b.kg_damaged + b.kg_process_loss + b.kg_quarantine;
      if (thisTotal <= 0) throw badRequest('Enter the returned quantity');
      if (b.kg_quarantine > 0 && (!b.quarantine_reason || !b.quarantine_note)) throw badRequest('Say what is wrong with the goods held in quarantine', { fields: { quarantine_note: 'Required' } });
      const balance = o.kg_sent - (o.kg_good + o.kg_rejected + o.kg_damaged + o.kg_process_loss + Number(o.kg_quarantine));
      if (thisTotal > balance + 0.001) throw badRequest(`Only ${round2(balance)} kg is still at the mill on this order`);
      if (b.kg_rejected + b.kg_damaged + b.kg_process_loss > 0 && !b.loss_reason) throw badRequest('Give the reason for rejection, damage or loss', { fields: { loss_reason: 'Required' } });
      // Charge on the fabric processed in this return, using each line's rate card.
      const lines = await many<{ rate_card_id: string | null; kg_sent: number }>(c, 'SELECT rate_card_id, kg_sent FROM job_order_lines WHERE job_order_id = $1', [o.id]);
      let charge = 0;
      for (const l of lines) {
        if (!l.rate_card_id) continue;
        const card = await one(c, 'SELECT * FROM rate_cards WHERE id = $1', [l.rate_card_id]);
        charge += chargeFor(card as never, (b.kg_good + b.kg_rejected) * (l.kg_sent / o.kg_sent));
      }
      charge = round2(charge);
      const ret = await one<{ id: string }>(c, `
        INSERT INTO job_returns (job_order_id, return_date, warehouse_id, warehouse_name, mill_challan_no, lr_number, kg_good, kg_rejected, kg_damaged, kg_process_loss, rolls, lot_ref, loss_reason, charge, created_by_name, kg_quarantine)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
        [o.id, b.return_date, w.id, `${w.code} · ${w.name}`, b.mill_challan_no ?? null, b.lr_number ?? null, b.kg_good, b.kg_rejected, b.kg_damaged, b.kg_process_loss, b.rolls ?? null, b.lot_ref ?? null, b.loss_reason ?? null, charge, req.user!.name, b.kg_quarantine]);
      if (b.kg_quarantine > 0) {
        const qn = await nextNumber(c, 'quarantine', 'QH-');
        await c.query(`INSERT INTO quarantine_holds (number, job_order_id, return_id, mill_id, mill_name, warehouse_id, warehouse_name, kg, rolls, reason_type, description, created_by_name) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [qn, o.id, ret!.id, o.mill_id, o.mill_name, w.id, `${w.code} · ${w.name}`, b.kg_quarantine, b.quarantine_rolls ?? null, b.quarantine_reason, b.quarantine_note, req.user!.name]);
        await raiseException(c, { kind: 'quarantine_held', severity: 'warning', ref_id: o.id, ref_label: `${o.number} · ${o.mill_name}`, message: `${b.kg_quarantine} kg returned on ${o.number} held in quarantine: ${b.quarantine_note}`, notifyPermission: 'jobwork.claim.manage', link: `/jobwork/orders/${o.id}` });
      }
      const after = await one<{ kg_sent: number; kg_good: number; kg_rejected: number; kg_damaged: number; kg_process_loss: number }>(c, `
        UPDATE job_orders SET kg_good = kg_good + $2, kg_rejected = kg_rejected + $3, kg_damaged = kg_damaged + $4, kg_process_loss = kg_process_loss + $5,
          processing_charge = processing_charge + $6, kg_quarantine = kg_quarantine + $7, updated_at = now() WHERE id = $1 RETURNING *`,
        [o.id, b.kg_good, b.kg_rejected, b.kg_damaged, b.kg_process_loss, charge, b.kg_quarantine]);
      const rec = reconcile(after!);
      const done = rec.kg_balance_at_mill <= 0.001;
      await c.query(`UPDATE job_orders SET status = $2 WHERE id = $1`, [o.id, done ? 'returned' : 'partially_returned']);
      if (done) await resolveException(c, 'operational_overdue', o.id, 'Returned');
      if (rec.yield_pct !== null && rec.yield_pct < minYield)
        await raiseException(c, { kind: 'low_yield', severity: 'warning', ref_id: o.id, ref_label: `${o.number} · ${o.mill_name}`, message: `Yield ${rec.yield_pct}% on ${o.number} is below the ${minYield}% threshold — investigate process loss at ${o.mill_name}`, notifyPermission: 'jobwork.claim.manage', link: `/jobwork/orders/${o.id}` });
      // Inventory (P4) creates finished lots from this event.
      const products = await many<{ product_id: string; sku: string; product_name: string; kg_sent: number; grey_cost_per_kg: number | null }>(c, `
        SELECT l.product_id, l.sku, l.product_name, sum(l.kg_sent)::float AS kg_sent,
          sum(l.kg_sent * s.cost_per_kg) / nullif(sum(l.kg_sent) FILTER (WHERE s.cost_per_kg IS NOT NULL), 0) AS grey_cost_per_kg
        FROM job_order_lines l LEFT JOIN mill_stock s ON s.id = l.mill_stock_id WHERE l.job_order_id = $1 GROUP BY l.product_id, l.sku, l.product_name ORDER BY min(l.line_no)`, [o.id]);
      // Inventory (P4) receives the good kg as a new finished lot and consumes the grey rolls at the mill.
      await publish(c, S, 'jobwork.return.recorded', {
        job_order_id: o.id, number: o.number, return_id: ret!.id, return_date: b.return_date, mill_name: o.mill_name, process_code: o.process_code, warehouse_id: w.id, warehouse_name: `${w.code} · ${w.name}`,
        kg_good: b.kg_good, kg_rejected: b.kg_rejected, kg_consumed: thisTotal - b.kg_quarantine, rolls: b.rolls ?? null, lot_ref: b.lot_ref ?? null, charge, products,
      });
      await auditReq(c, req, 'job_order', o.id, 'return_recorded', { after: { ...b, charge }, reason: b.loss_reason });
      return { ...ret, reconciliation: rec };
    });
    res.status(201).json(out);
  });

  r.post('/orders/:id/close', requirePermission('jobwork.order.manage'), async (req, res) => {
    const { reason } = parse(z.object({ reason: optText(500) }), req.body);
    const out = await tx(pool, async (c) => {
      const o = await one<JobForLoss & { status: string }>(c, 'SELECT * FROM job_orders WHERE id = $1 FOR UPDATE', [req.params.id]);
      if (!o) throw notFound('Job-work order');
      const rec = reconcile(o);
      if (!['returned', 'partially_returned'].includes(o.status)) throw conflict('Record the return before closing');
      if (Number(o.kg_quarantine) > 0.001) throw conflict(`${round2(Number(o.kg_quarantine))} kg is still held in quarantine: resolve it first`);
      // Goods not returned, or lost beyond the allowance, become a shortage claim on the mill before the order can close.
      const sh = await shortageOf(c, o);
      if (sh.kg > 0.001 && !(await one(c, `SELECT 1 FROM quality_claims WHERE job_order_id = $1 AND claim_type = 'shortage'`, [o.id]))) {
        const q = await raiseShortageClaim(c, req.user!.name, o, sh);
        return { closed: false, shortage_claim: q };
      }
      if (rec.kg_balance_at_mill > 0.001 && !reason) throw badRequest(`${rec.kg_balance_at_mill} kg is unaccounted for. Give a reason to close anyway.`, { fields: { reason: 'Required' } });
      const openClaims = await one<{ n: number }>(c, `SELECT count(*)::int AS n FROM quality_claims WHERE job_order_id = $1 AND status IN ('open','under_review')`, [req.params.id]);
      if (openClaims!.n) throw conflict('Settle the open quality claims first');
      await c.query(`UPDATE job_orders SET status = 'closed', closed_at = now(), close_reason = $2, updated_at = now() WHERE id = $1`, [req.params.id, reason ?? null]);
      await auditReq(c, req, 'job_order', String(req.params.id), 'closed', { reason, after: rec });
      return { closed: true };
    });
    res.json(out);
  });

  /** What a shortage claim would be on this order now (kg beyond the allowance, at the agreed rate). */
  r.get('/orders/:id/shortage', requirePermission('jobwork.read'), async (req, res) => {
    const o = await one<JobForLoss>(pool, 'SELECT * FROM job_orders WHERE id = $1', [req.params.id]);
    if (!o) throw notFound('Job-work order');
    res.json(await shortageOf(pool, o));
  });
  r.post('/orders/:id/shortage-claim', requirePermission('jobwork.claim.manage'), async (req, res) => {
    const out = await tx(pool, async (c) => {
      const o = await one<JobForLoss>(c, 'SELECT * FROM job_orders WHERE id = $1 FOR UPDATE', [req.params.id]);
      if (!o) throw notFound('Job-work order');
      const sh = await shortageOf(c, o);
      if (sh.kg <= 0.001) throw badRequest('No shortage beyond the allowed loss on this order');
      if (await one(c, `SELECT 1 FROM quality_claims WHERE job_order_id = $1 AND claim_type = 'shortage' AND status <> 'rejected'`, [o.id])) throw conflict('A shortage claim is already raised on this order');
      return raiseShortageClaim(c, req.user!.name, o, sh);
    });
    res.status(201).json(out);
  });

  // ---------- quarantine: wrong goods sent back ----------
  r.get('/quarantine', requirePermission('jobwork.read'), async (req, res) => {
    const st = String(req.query.status ?? 'held');
    res.json(await many(pool, `SELECT h.*, j.number AS job_number, j.process_name FROM quarantine_holds h JOIN job_orders j ON j.id = h.job_order_id ${st === 'all' ? '' : 'WHERE h.status = $1'} ORDER BY h.created_at DESC LIMIT 300`, st === 'all' ? [] : [st]));
  });
  r.post('/quarantine/:id/resolve', requirePermission('jobwork.claim.manage'), async (req, res) => {
    const b = parse(z.object({ action: z.enum(['return_to_mill', 'rework', 'accept']), note: reqText(500), challan_no: optText(40) }), req.body);
    const out = await tx(pool, async (c) => {
      const h = await one<{ id: string; number: string; job_order_id: string; kg: number; status: string; warehouse_id: string; warehouse_name: string; rolls: number | null; return_id: string }>(c, 'SELECT * FROM quarantine_holds WHERE id = $1 FOR UPDATE', [req.params.id]);
      if (!h) throw notFound('Quarantine hold');
      if (h.status !== 'held') throw conflict(`Already ${h.status.replace(/_/g, ' ')}`);
      const o = await one<{ id: string; number: string; mill_name: string; process_code: string; status: string }>(c, 'SELECT * FROM job_orders WHERE id = $1 FOR UPDATE', [h.job_order_id]);
      const kg = Number(h.kg);
      const challan = b.action === 'accept' ? null : b.challan_no ?? await nextNumber(c, 'mill_return_challan', 'RTM-');
      if (b.action === 'accept') {
        // Accepted as it is: becomes good stock like any return.
        await c.query('UPDATE job_orders SET kg_quarantine = kg_quarantine - $2, kg_good = kg_good + $2, updated_at = now() WHERE id = $1', [o!.id, kg]);
        const products = await many(c, `
          SELECT l.product_id, l.sku, l.product_name, sum(l.kg_sent)::float AS kg_sent,
            sum(l.kg_sent * s.cost_per_kg) / nullif(sum(l.kg_sent) FILTER (WHERE s.cost_per_kg IS NOT NULL), 0) AS grey_cost_per_kg
          FROM job_order_lines l LEFT JOIN mill_stock s ON s.id = l.mill_stock_id WHERE l.job_order_id = $1 GROUP BY l.product_id, l.sku, l.product_name ORDER BY min(l.line_no)`, [o!.id]);
        await publish(c, S, 'jobwork.return.recorded', { job_order_id: o!.id, number: o!.number, return_id: h.return_id, return_date: today(), mill_name: o!.mill_name, process_code: o!.process_code, warehouse_id: h.warehouse_id, warehouse_name: h.warehouse_name,
          kg_good: kg, kg_rejected: 0, kg_consumed: kg, rolls: h.rolls, lot_ref: `${h.number}`, charge: 0, products, source: 'quarantine' });
      } else {
        // Back to the mill (someone else's fabric, or for rework): our fabric is still at the mill.
        await c.query(`UPDATE job_orders SET kg_quarantine = kg_quarantine - $2, status = CASE WHEN status IN ('returned','closed') THEN 'partially_returned' ELSE status END, updated_at = now() WHERE id = $1`, [o!.id, kg]);
        await c.query(`INSERT INTO stage_updates (job_order_id, stage_code, stage_name, status, kg, note, source, by_name) VALUES ($1, 'RETURN_TO_MILL', $2, 'started', $3, $4, 'internal', $5)`,
          [o!.id, b.action === 'rework' ? 'Sent back for rework' : 'Wrong goods sent back to the mill', kg, `${challan}: ${b.note}`, req.user!.name]);
      }
      await c.query(`UPDATE quarantine_holds SET status = $2, resolution = $3, challan_no = $4, resolved_by_name = $5, resolved_at = now() WHERE id = $1`, [h.id, b.action === 'accept' ? 'accepted' : b.action === 'rework' ? 'rework' : 'returned_to_mill', b.note, challan, req.user!.name]);
      if (!(await one(c, `SELECT 1 FROM quarantine_holds WHERE job_order_id = $1 AND status = 'held'`, [o!.id]))) await resolveException(c, 'quarantine_held', o!.id, 'Quarantine resolved');
      await auditReq(c, req, 'quarantine_hold', h.id, b.action, { after: { kg, challan }, reason: b.note });
      return { status: b.action, challan_no: challan };
    });
    res.json(out);
  });

  /** Loss by mill and process: what went out, what came back good, what was lost, held or claimed. */
  r.get('/analytics/mill-loss', requirePermission('jobwork.read'), async (req, res) => {
    const from = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.from)) ? String(req.query.from) : '1900-01-01';
    const to = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.to)) ? String(req.query.to) : '9999-12-31';
    const rows = await many<Record<string, number | string>>(pool, `
      WITH o AS (SELECT * FROM job_orders j WHERE j.status NOT IN ('draft','cancelled') AND j.issue_date BETWEEN $1 AND $2),
        cl AS (SELECT o.mill_id, o.process_name, count(q.id)::int AS claims, coalesce(sum(q.amount) FILTER (WHERE q.status IN ('accepted','closed')), 0)::float AS claims_accepted
               FROM quality_claims q JOIN o ON o.id = q.job_order_id GROUP BY o.mill_id, o.process_name)
      SELECT o.mill_id, o.mill_name, o.process_name, count(*)::int AS orders, sum(o.kg_sent)::float AS kg_sent, sum(o.kg_good)::float AS kg_good, sum(o.kg_rejected)::float AS kg_rejected,
        sum(o.kg_damaged)::float AS kg_damaged, sum(o.kg_process_loss)::float AS kg_process_loss, sum(o.kg_quarantine)::float AS kg_quarantine,
        sum(o.kg_sent - o.kg_good - o.kg_rejected - o.kg_damaged - o.kg_process_loss - o.kg_quarantine)::float AS kg_at_mill,
        coalesce(max(cl.claims), 0) AS claims, coalesce(max(cl.claims_accepted), 0) AS claims_accepted
      FROM o LEFT JOIN cl ON cl.mill_id = o.mill_id AND cl.process_name = o.process_name GROUP BY o.mill_id, o.mill_name, o.process_name ORDER BY o.mill_name, o.process_name`, [from, to]);
    res.json(rows.map((r1) => {
      const back = Number(r1.kg_good) + Number(r1.kg_rejected) + Number(r1.kg_damaged) + Number(r1.kg_process_loss);
      return { ...r1, loss_pct: back > 0 ? round2(((Number(r1.kg_rejected) + Number(r1.kg_damaged) + Number(r1.kg_process_loss)) / back) * 100) : null, yield_pct: back > 0 ? round2((Number(r1.kg_good) / back) * 100) : null };
    }));
  });

  /** Separate commercial, operational and statutory clocks for every open order. */
  r.get('/deadlines', requirePermission('jobwork.read'), async (_req, res) => {
    const rows = await many<{ id: string; number: string; mill_name: string; status: string; issue_date: string; expected_return_date: string; internal_due_date: string; statutory_due_date: string; kg_balance: number }>(pool, `
      SELECT id, number, mill_name, process_name, status, issue_date, expected_return_date, internal_due_date, statutory_due_date, kg_sent,
        round(kg_sent - kg_good - kg_rejected - kg_damaged - kg_process_loss - kg_quarantine, 3) AS kg_balance,
        expected_return_date - current_date AS commercial_days, internal_due_date - current_date AS operational_days, statutory_due_date - current_date AS statutory_days, ack_at
      FROM job_orders WHERE status = ANY($1) ORDER BY least(internal_due_date, statutory_due_date)`, [ACTIVE]);
    const counts = {
      operational_overdue: rows.filter((r) => (r as unknown as { operational_days: number }).operational_days < 0).length,
      commercial_overdue: rows.filter((r) => (r as unknown as { commercial_days: number }).commercial_days < 0).length,
      statutory_within_30: rows.filter((r) => (r as unknown as { statutory_days: number }).statutory_days <= 30).length,
      awaiting_ack: rows.filter((r) => r.status === 'issued').length,
      kg_at_mills: round2(rows.reduce((s, r) => s + Number(r.kg_balance), 0)),
    };
    res.json({ counts, orders: rows });
  });

  r.get('/exceptions', requirePermission('jobwork.read'), async (req, res) => {
    res.json(await many(pool, `SELECT * FROM exceptions WHERE status = $1 ORDER BY detected_at DESC LIMIT 300`, [(req.query.status as string) ?? 'open']));
  });

  r.post('/exceptions/:id/resolve', requirePermission('jobwork.order.manage'), async (req, res) => {
    const { resolution } = parse(z.object({ resolution: reqText(500) }), req.body);
    await tx(pool, async (c) => {
      const r1 = await c.query(`UPDATE exceptions SET status = 'resolved', resolved_at = now(), resolved_by_name = $2, resolution = $3 WHERE id = $1 AND status = 'open'`, [req.params.id, req.user!.name, resolution]);
      if (!r1.rowCount) throw notFound('Open exception');
      await auditReq(c, req, 'exception', String(req.params.id), 'resolved', { reason: resolution });
    });
    res.json({ ok: true });
  });

  r.get('/dashboard', requirePermission('jobwork.read'), async (_req, res) => {
    res.json(await one(pool, `SELECT
      (SELECT count(*)::int FROM job_orders WHERE status = ANY($1)) AS open_orders,
      (SELECT round(coalesce(sum(kg_sent - kg_good - kg_rejected - kg_damaged - kg_process_loss - kg_quarantine), 0), 1) FROM job_orders WHERE status = ANY($1)) AS kg_at_mills,
      (SELECT round(coalesce(sum(kg_in - kg_allocated), 0), 1) FROM mill_stock) AS grey_unallocated_kg,
      (SELECT count(*)::int FROM job_orders WHERE status = 'issued') AS awaiting_ack,
      (SELECT count(*)::int FROM job_orders WHERE status = 'ready') AS ready_for_collection,
      (SELECT count(*)::int FROM job_orders WHERE status = ANY($1) AND internal_due_date < current_date) AS overdue,
      (SELECT count(*)::int FROM quality_claims WHERE status IN ('open','under_review')) AS open_claims,
      (SELECT count(*)::int FROM exceptions WHERE status = 'open') AS open_exceptions`, [ACTIVE]));
  });
}

export const stageBody = z.object({
  stage_code: z.string(),
  status: z.enum(['started', 'completed', 'qc_passed', 'qc_failed', 'on_hold']),
  kg: z.number().min(0).nullable().optional(),
  note: optText(500),
});

/** Grey fabric received at a mill on a direct-to-mill PO becomes trader-owned stock at that mill. */
export function receiptConsumer() {
  return async (ev: BusEvent, c: Client) => {
    const p = ev.payload as { receipt_id: string; receipt_number: string; po_id: string; po_number: string; receipt_type: string; location_id: string; location_name: string; supplier_name: string; receipt_date: string;
      lines: { product_id: string; sku: string; product_name: string; accepted_kg: number; rolls: number | null; rate_per_kg?: number }[] };
    if (p.receipt_type !== 'mill') return;
    for (const l of p.lines) {
      if (l.accepted_kg <= 0) continue;
      await c.query(`
        INSERT INTO mill_stock (mill_id, mill_name, source_type, source_ref, receipt_id, po_id, po_number, supplier_name, product_id, sku, product_name, kg_in, rolls, received_date, cost_per_kg)
        VALUES ($1, $2, 'po_receipt', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) ON CONFLICT (receipt_id, product_id) DO NOTHING`,
        [p.location_id, p.location_name.replace(/^[A-Z]{3}-\d+ · /, ''), p.receipt_number, p.receipt_id, p.po_id, p.po_number, p.supplier_name, l.product_id, l.sku, l.product_name, l.accepted_kg, l.rolls, p.receipt_date, l.rate_per_kg ?? null]);
    }
  };
}


interface JobForLoss { id: string; number: string; mill_id: string; mill_name: string; kg_sent: number; kg_good: number; kg_rejected: number; kg_damaged: number; kg_process_loss: number; kg_quarantine: number; issue_date: string | null }

/** Kg the mill owes: still not returned, plus process loss above the allowed %, priced at the grey cost (or the set rate). */
export async function shortageOf(c: Client | ServiceContext['pool'], o: JobForLoss) {
  const allowed = Number(await setting('jobwork.allowed_loss_percent', 3));
  const rec = reconcile(o);
  const excessLoss = Math.max(0, Number(o.kg_process_loss) - (Number(o.kg_sent) * allowed) / 100);
  const kg = round2(Math.max(0, rec.kg_balance_at_mill) + excessLoss);
  const cost = await one<{ rate: number | null }>(c, `SELECT (sum(l.kg_sent * s.cost_per_kg) / nullif(sum(l.kg_sent) FILTER (WHERE s.cost_per_kg IS NOT NULL), 0))::float AS rate FROM job_order_lines l LEFT JOIN mill_stock s ON s.id = l.mill_stock_id WHERE l.job_order_id = $1`, [o.id]);
  const rate = round2(cost?.rate ?? Number(await setting('jobwork.shortage_rate_per_kg', 240)));
  return { kg, kg_not_returned: round2(Math.max(0, rec.kg_balance_at_mill)), kg_excess_loss: round2(excessLoss), allowed_loss_pct: allowed, rate_per_kg: rate, amount: round2(kg * rate) };
}

export async function raiseShortageClaim(c: Client, by: string, o: JobForLoss, sh: Awaited<ReturnType<typeof shortageOf>>) {
  const number = await nextNumber(c, 'quality_claim', 'QC-');
  const desc = [sh.kg_not_returned > 0 ? `${sh.kg_not_returned} kg not returned` : '', sh.kg_excess_loss > 0 ? `${sh.kg_excess_loss} kg process loss above the ${sh.allowed_loss_pct}% allowance` : ''].filter(Boolean).join('; ');
  const q = await one<{ id: string; number: string }>(c, `INSERT INTO quality_claims (number, job_order_id, mill_id, mill_name, defect_types, description, kg_affected, claim_type, amount, rate_per_kg, responsibility, auto_raised, raised_by_name)
    VALUES ($1,$2,$3,$4,'{Short quantity}',$5,$6,'shortage',$7,$8,'mill',true,$9) RETURNING id, number`, [number, o.id, o.mill_id, o.mill_name, `Shortage on ${o.number}: ${desc}, at ₹${sh.rate_per_kg}/kg`, sh.kg, sh.amount, sh.rate_per_kg, by]);
  for (const uid of await portalUsers(o.mill_id)) await notify(c, S, { user_id: uid, kind: 'warning', title: `Shortage claim ${number} on ${o.number}: ${sh.kg} kg`, body: desc, link: `/portal/claims/${q!.id}` });
  await raiseException(c, { kind: 'mill_shortage', severity: 'warning', ref_id: o.id, ref_label: `${o.number} · ${o.mill_name}`, message: `Shortage claim ${number} raised on ${o.mill_name}: ${sh.kg} kg, ₹${sh.amount.toLocaleString('en-IN')}`, notifyPermission: 'jobwork.claim.manage', link: `/jobwork/claims` });
  return q;
}
