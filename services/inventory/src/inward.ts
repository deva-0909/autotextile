import type { Request, Router } from 'express';
import { z } from 'zod';
import {
  type BusEvent, type Client, type Pool, type ServiceContext, badRequest, conflict, many, notFound, notify, one, optText, parse, requirePermission, scopeClause, tx,
} from '@erp/platform';
import { S, assertWarehouse, auditReq, getLocations, getProduct, getWarehouse, localNumber, raiseException, round2, round3, setting, today, whLabel, isoDate, type Location } from './common.ts';
import { type Actor, type Roll, createRoll, lockRoll, moveRoll, splitRoll, PHYSICAL } from './ledger.ts';

const actorOf = (req: Request): Actor => ({ id: req.user!.id.startsWith('svc:') ? null : req.user!.id, name: req.user!.name });
export { actorOf };

async function newInward(c: Client, i: { source_type: 'po_receipt' | 'job_return' | 'opening'; source_id: string | null; source_ref: string; key: string | null; party_name: string | null; warehouse_id: string; warehouse_name: string; expected_date: string; notes?: string | null;
  lines: { product_id: string; sku: string; product_name: string; hsn_code: string | null; gst_rate: number | null; expected_kg: number; expected_rolls: number | null; cost_per_kg: number | null; lot_ref: string | null; parent_lot_ids?: string[] }[] }) {
  const number = await localNumber(c, 'inward', 'IN-');
  const r = await one<{ id: string }>(c, `
    INSERT INTO inwards (number, source_type, source_id, source_ref, source_event_key, party_name, warehouse_id, warehouse_name, expected_date, notes)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (source_event_key) DO NOTHING RETURNING id`,
    [number, i.source_type, i.source_id, i.source_ref, i.key, i.party_name, i.warehouse_id, i.warehouse_name, i.expected_date, i.notes ?? null]);
  if (!r) return null;
  for (const [n, l] of i.lines.entries())
    await c.query(`INSERT INTO inward_lines (inward_id, line_no, product_id, sku, product_name, hsn_code, gst_rate, expected_kg, expected_rolls, cost_per_kg, lot_ref, parent_lot_ids) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [r.id, n + 1, l.product_id, l.sku, l.product_name, l.hsn_code, l.gst_rate, round3(l.expected_kg), l.expected_rolls, l.cost_per_kg === null ? null : round2(l.cost_per_kg), l.lot_ref, l.parent_lot_ids ?? []]);
  return { id: r.id, number };
}

/** Goods received into one of our warehouses become an inward waiting to be weighed and scanned. */
export function receiptConsumer() {
  return async (ev: BusEvent, c: Client) => {
    const p = ev.payload as { receipt_id: string; receipt_number: string; po_id: string; po_number: string; receipt_type: string; location_id: string; location_name: string; supplier_name: string; receipt_date: string;
      lines: { product_id: string; sku: string; product_name: string; hsn_code?: string; gst_rate?: number; rate_per_kg?: number; accepted_kg: number; rolls: number | null }[] };
    if (p.receipt_type !== 'warehouse') return;
    const lines = p.lines.filter((l) => l.accepted_kg > 0);
    if (!lines.length) return;
    const inw = await newInward(c, {
      source_type: 'po_receipt', source_id: p.receipt_id, source_ref: `${p.receipt_number} · ${p.po_number}`, key: `po_receipt:${p.receipt_id}`, party_name: p.supplier_name,
      warehouse_id: p.location_id, warehouse_name: p.location_name, expected_date: p.receipt_date,
      lines: lines.map((l) => ({ product_id: l.product_id, sku: l.sku, product_name: l.product_name, hsn_code: l.hsn_code ?? null, gst_rate: l.gst_rate ?? null, expected_kg: l.accepted_kg, expected_rolls: l.rolls, cost_per_kg: l.rate_per_kg ?? null, lot_ref: null })),
    });
    if (inw) await notifyStores(c, p.location_id, `${inw.number}: weigh and scan ${p.receipt_number} from ${p.supplier_name}`, `/inventory/inward/${inw.id}`);
  };
}

/**
 * Processed fabric back from a mill: the grey rolls issued for the job are consumed at the mill and the good kg
 * arrives as a new finished lot whose parents are those grey lots (genealogy).
 */
export function jobReturnConsumer() {
  return async (ev: BusEvent, c: Client) => {
    const p = ev.payload as { job_order_id: string; number: string; return_id: string; return_date?: string; mill_name?: string; warehouse_id: string; warehouse_name?: string; kg_good: number; kg_consumed?: number; rolls: number | null; lot_ref: string | null; charge: number;
      products?: { product_id: string; sku: string; product_name: string; kg_sent: number; grey_cost_per_kg: number | null }[] };
    if (!p.products?.length) return;
    const actor = { id: null, name: 'system' };
    // Consume grey rolls held at the mill for this job, oldest first; a partly used roll is split.
    let toConsume = round3(p.kg_consumed ?? p.kg_good);
    const held = await many<Roll & { cost_per_kg: number | null }>(c, `SELECT r.*, l.cost_per_kg FROM rolls r JOIN lots l ON l.id = r.lot_id WHERE r.state = 'at_mill' AND r.holder_ref = $1 ORDER BY r.created_at, r.roll_no FOR UPDATE OF r`, [p.number]);
    const parents = new Set<string>();
    let greyValue = 0, greyKg = 0;
    for (const r of held) {
      if (toConsume <= 0.0005) break;
      let roll: Roll = r;
      if (r.weight_kg > toConsume + 0.0005) roll = await splitRoll(c, r, toConsume, actor, `Part consumed on ${p.number}`) as Roll;
      parents.add(roll.lot_id);
      if (r.cost_per_kg !== null) { greyValue += roll.weight_kg * Number(r.cost_per_kg); greyKg += roll.weight_kg; }
      toConsume = round3(toConsume - roll.weight_kg);
      await moveRoll(c, roll, 'consume_at_mill', { state: 'consumed', warehouse_id: null, location: null }, { ref: { type: 'job_return', id: p.return_id, no: p.number }, actor });
    }
    await c.query(`UPDATE mill_issues SET consumed_kg = consumed_kg + $2 WHERE job_order_id = $1`, [p.job_order_id, round3((p.kg_consumed ?? p.kg_good) - Math.max(0, toConsume))]);
    if (p.kg_good <= 0) return;
    const sentTotal = p.products.reduce((s, x) => s + x.kg_sent, 0);
    const consumed = p.kg_consumed ?? p.kg_good;
    const lines = [];
    for (const x of p.products) {
      const share = sentTotal ? x.kg_sent / sentTotal : 1 / p.products.length;
      const good = round3(p.kg_good * share);
      if (good <= 0) continue;
      const greyRate = x.grey_cost_per_kg ?? (greyKg ? greyValue / greyKg : null);
      // Cost per good kg: grey fabric consumed plus the processing charge, spread over what came back good.
      const cost = greyRate === null ? null : (greyRate * consumed * share + p.charge * share) / good;
      const prod = await getProduct(x.product_id).catch(() => null);
      lines.push({ product_id: x.product_id, sku: x.sku, product_name: x.product_name, hsn_code: prod?.hsn_code ?? null, gst_rate: prod?.gst_rate ?? null, expected_kg: good,
        expected_rolls: p.rolls && p.products.length === 1 ? p.rolls : null, cost_per_kg: cost, lot_ref: p.lot_ref, parent_lot_ids: [...parents] });
    }
    const inw = await newInward(c, {
      source_type: 'job_return', source_id: p.return_id, source_ref: `${p.number}${p.mill_name ? ` · ${p.mill_name}` : ''}`, key: `job_return:${p.return_id}`, party_name: p.mill_name ?? null,
      warehouse_id: p.warehouse_id, warehouse_name: p.warehouse_name ?? 'Warehouse', expected_date: p.return_date ?? today(), lines,
    });
    if (inw) await notifyStores(c, p.warehouse_id, `${inw.number}: processed fabric back from ${p.mill_name ?? 'mill'} on ${p.number}`, `/inventory/inward/${inw.id}`);
  };
}

async function notifyStores(c: Client, _warehouseId: string, title: string, link: string) {
  await notify(c, S, { audience_permission: 'inventory.inward.record', kind: 'action', title, body: null, link });
}

export async function inwardDetail(c: Pool | Client, id: string) {
  const i = await one<Record<string, unknown> & { id: string; warehouse_id: string }>(c, 'SELECT * FROM inwards WHERE id = $1', [id]);
  if (!i) throw notFound('Inward');
  const lines = await many<{ id: string; lot_id: string | null; expected_kg: number }>(c, `
    SELECT l.*, lt.lot_no, lt.qc_status, lt.grade, lt.price_per_kg,
      coalesce((SELECT round(sum(r.initial_kg), 3) FROM rolls r WHERE r.lot_id = l.lot_id AND r.parent_roll_id IS NULL AND r.state <> 'written_off'), 0)::float AS weighed_kg,
      coalesce((SELECT count(*) FROM rolls r WHERE r.lot_id = l.lot_id AND r.parent_roll_id IS NULL AND r.state <> 'written_off'), 0)::int AS rolls_scanned
    FROM inward_lines l LEFT JOIN lots lt ON lt.id = l.lot_id WHERE l.inward_id = $1 ORDER BY l.line_no`, [id]);
  const rolls = await many(c, `SELECT r.id, r.barcode, r.roll_no, r.weight_kg, r.initial_kg, r.state, r.gsm, r.width_in, r.shade_code, r.dye_lot, r.grade, r.location_path, r.created_at, l.lot_no, l.id AS lot_id, il.id AS line_id
    FROM inward_lines il JOIN rolls r ON r.lot_id = il.lot_id AND r.parent_roll_id IS NULL JOIN lots l ON l.id = r.lot_id WHERE il.inward_id = $1 ORDER BY r.created_at DESC`, [id]);
  return { ...i, lines, rolls };
}

/** Receiving area for new rolls: the warehouse's receiving zone, if it has one. */
async function receivingLocation(warehouseId: string): Promise<Location | null> {
  const locs = await getLocations(warehouseId).catch(() => [] as Location[]);
  return locs.find((l) => l.purpose === 'receiving' && l.status === 'active') ?? null;
}

const scanBody = z.object({
  line_id: z.uuid(),
  weight_kg: z.number().positive().max(500),
  gsm: z.number().positive().max(1000).nullable().optional(),
  width_in: z.number().positive().max(200).nullable().optional(),
  shade_code: optText(40),
  dye_lot: optText(40),
});

const qcBody = z.object({
  results: z.array(z.object({
    barcode: z.string().min(3),
    grade: z.enum(['A', 'B', 'C', 'reject']),
    gsm: z.number().positive().max(1000).nullable().optional(),
    width_in: z.number().positive().max(200).nullable().optional(),
    shade_code: optText(40),
    defects: z.array(z.string().max(40)).max(10).default([]),
  })).min(1),
  note: optText(500),
});

export function inwardRoutes(r: Router, { pool }: ServiceContext) {
  r.get('/inwards', requirePermission('inventory.read'), async (req, res) => {
    const params: unknown[] = [];
    const where: string[] = [];
    if (req.query.status) { params.push(String(req.query.status).split(',')); where.push(`i.status = ANY($${params.length})`); }
    if (req.query.warehouse) { params.push(req.query.warehouse); where.push(`i.warehouse_id = $${params.length}`); }
    const sc = scopeClause(req.user!, 'warehouse', 'i.warehouse_id', params);
    if (sc) where.push(sc);
    res.json(await many(pool, `
      SELECT i.*, (SELECT round(sum(expected_kg), 3) FROM inward_lines WHERE inward_id = i.id)::float AS expected_kg,
        (SELECT coalesce(round(sum(r.initial_kg), 3), 0) FROM inward_lines il JOIN rolls r ON r.lot_id = il.lot_id AND r.parent_roll_id IS NULL AND r.state <> 'written_off' WHERE il.inward_id = i.id)::float AS weighed_kg,
        (SELECT count(*) FROM inward_lines il JOIN rolls r ON r.lot_id = il.lot_id AND r.parent_roll_id IS NULL AND r.state <> 'written_off' WHERE il.inward_id = i.id)::int AS rolls_scanned,
        (SELECT string_agg(sku, ', ' ORDER BY line_no) FROM inward_lines WHERE inward_id = i.id) AS skus
      FROM inwards i ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY (i.status = 'open') DESC, i.created_at DESC LIMIT 300`, params));
  });

  r.get('/inwards/:id', requirePermission('inventory.read'), async (req, res) => {
    const d = await inwardDetail(pool, String(req.params.id));
    assertWarehouse(req, d.warehouse_id);
    res.json(d);
  });

  /** Opening stock or a manual receipt (e.g. a customer return). Purchase and mill receipts arrive by event. */
  r.post('/inwards', requirePermission('inventory.inward.record'), async (req, res) => {
    const b = parse(z.object({
      warehouse_id: z.uuid(), source_ref: z.string().trim().min(1).max(80), party_name: optText(120), notes: optText(500),
      // Opening stock keeps its original receipt date so ageing stays true.
      received_date: z.string().regex(isoDate).nullable().optional(),
      lines: z.array(z.object({ product_id: z.uuid(), expected_kg: z.number().positive(), expected_rolls: z.number().int().positive().nullable().optional(), cost_per_kg: z.number().positive().nullable().optional(), lot_ref: optText(40) })).min(1),
    }), req.body);
    const w = await getWarehouse(b.warehouse_id);
    assertWarehouse(req, w.id);
    const products = await Promise.all(b.lines.map((l) => getProduct(l.product_id)));
    const out = await tx(pool, async (c) => {
      const inw = await newInward(c, {
        source_type: 'opening', source_id: null, source_ref: b.source_ref, key: null, party_name: b.party_name ?? null, warehouse_id: w.id, warehouse_name: whLabel(w), expected_date: b.received_date && b.received_date < today() ? b.received_date : today(), notes: b.notes,
        lines: b.lines.map((l, i) => ({ product_id: l.product_id, sku: products[i].sku, product_name: products[i].name, hsn_code: products[i].hsn_code, gst_rate: products[i].gst_rate, expected_kg: l.expected_kg, expected_rolls: l.expected_rolls ?? null, cost_per_kg: l.cost_per_kg ?? null, lot_ref: l.lot_ref ?? null })),
      });
      await auditReq(c, req, 'inward', inw!.id, 'created', { after: { number: inw!.number, warehouse: w.code, source_ref: b.source_ref } });
      return inw;
    });
    res.status(201).json(out);
  });

  /** Weigh and scan one roll: creates the lot on the first roll of a line and prints a roll barcode. */
  r.post('/inwards/:id/rolls', requirePermission('inventory.inward.record'), async (req, res) => {
    const b = parse(scanBody, req.body);
    const qcRequired = await setting('inventory.qc_required', true);
    const out = await tx(pool, async (c) => {
      const inw = await one<{ id: string; number: string; status: string; warehouse_id: string; source_type: 'po_receipt' | 'job_return' | 'opening'; source_id: string | null; source_ref: string; party_name: string | null; expected_date: string }>(c, 'SELECT * FROM inwards WHERE id = $1 FOR UPDATE', [req.params.id]);
      if (!inw) throw notFound('Inward');
      assertWarehouse(req, inw.warehouse_id);
      if (inw.status !== 'open') throw conflict('This inward is already completed');
      const line = await one<{ id: string; product_id: string; sku: string; product_name: string; hsn_code: string | null; gst_rate: number | null; cost_per_kg: number | null; lot_ref: string | null; parent_lot_ids: string[]; lot_id: string | null }>(c, 'SELECT * FROM inward_lines WHERE id = $1 AND inward_id = $2', [b.line_id, inw.id]);
      if (!line) throw badRequest('That line is not on this inward');
      const w = await getWarehouse(inw.warehouse_id);
      let lot = line.lot_id ? await one<{ id: string; lot_no: string; product_id: string; shade_code: string | null; dye_lot: string | null }>(c, 'SELECT * FROM lots WHERE id = $1', [line.lot_id]) : null;
      if (!lot) {
        const lotNo = await localNumber(c, `lot:${w.code}`, `LOT-${w.code}-`);
        lot = await one(c, `
          INSERT INTO lots (lot_no, product_id, sku, product_name, hsn_code, gst_rate, source_type, source_id, source_ref, party_name, inward_id, origin_warehouse_id, parent_lot_ids, supplier_lot_ref, shade_code, dye_lot, cost_per_kg, received_date)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING *`,
          [lotNo, line.product_id, line.sku, line.product_name, line.hsn_code, line.gst_rate, inw.source_type, inw.source_id, inw.source_ref, inw.party_name, inw.id, w.id, line.parent_lot_ids,
            line.lot_ref, b.shade_code ?? null, b.dye_lot ?? line.lot_ref ?? null, line.cost_per_kg, inw.expected_date]);
        await c.query('UPDATE inward_lines SET lot_id = $2 WHERE id = $1', [line.id, lot!.id]);
      }
      const rcv = await receivingLocation(w.id);
      const roll = await createRoll(c, lot!, {
        weight_kg: b.weight_kg, state: qcRequired ? 'qc_hold' : 'available', warehouse_id: w.id, location: rcv ? { id: rcv.id, path: rcv.path } : null,
        gsm: b.gsm, width_in: b.width_in, shade_code: b.shade_code ?? lot!.shade_code, dye_lot: b.dye_lot ?? lot!.dye_lot,
      }, { ref: { type: 'inward', id: inw.id, no: inw.number }, actor: actorOf(req) });
      return { ...roll, lot_no: lot!.lot_no, sku: line.sku, product_name: line.product_name };
    });
    res.status(201).json(out);
  });

  /** A roll scanned by mistake on an open inward is written off with a reason (the ledger keeps both entries). */
  r.post('/inwards/:id/rolls/:rollId/void', requirePermission('inventory.inward.record'), async (req, res) => {
    const { reason } = parse(z.object({ reason: z.string().trim().min(3).max(300) }), req.body);
    await tx(pool, async (c) => {
      const inw = await one<{ status: string; number: string }>(c, 'SELECT status, number FROM inwards WHERE id = $1', [req.params.id]);
      if (!inw) throw notFound('Inward');
      if (inw.status !== 'open') throw conflict('Rolls can only be voided while the inward is open');
      const roll = await lockRoll(c, String(req.params.rollId));
      const onInward = await one(c, 'SELECT 1 FROM inward_lines WHERE inward_id = $1 AND lot_id = $2', [req.params.id, roll.lot_id]);
      if (!onInward || roll.state !== 'qc_hold' && roll.state !== 'available') throw conflict('Only rolls still on this inward can be voided');
      await moveRoll(c, roll, 'write_off', { state: 'written_off', warehouse_id: null, location: null }, { ref: { type: 'inward', id: String(req.params.id), no: inw.number }, reason, actor: actorOf(req) });
      await auditReq(c, req, 'roll', roll.id, 'voided', { reason, after: { barcode: roll.barcode } });
    });
    res.json({ ok: true });
  });

  r.post('/inwards/:id/complete', requirePermission('inventory.inward.record'), async (req, res) => {
    const { note } = parse(z.object({ note: optText(500) }), req.body);
    const tol = Number(await setting('inventory.inward_weight_tolerance_percent', 1));
    const out = await tx(pool, async (c) => {
      const inw = await one<{ id: string; number: string; status: string; source_ref: string; warehouse_id: string }>(c, 'SELECT * FROM inwards WHERE id = $1 FOR UPDATE', [req.params.id]);
      if (!inw) throw notFound('Inward');
      assertWarehouse(req, inw.warehouse_id);
      if (inw.status !== 'open') throw conflict('This inward is already completed');
      const d = await inwardDetail(c, inw.id);
      const lines = d.lines as unknown as { sku: string; expected_kg: number; weighed_kg: number; rolls_scanned: number }[];
      if (!lines.some((l) => l.rolls_scanned > 0)) throw badRequest('Scan at least one roll first');
      const variances = lines.map((l) => ({ sku: l.sku, expected: Number(l.expected_kg), weighed: Number(l.weighed_kg), diff: round3(Number(l.weighed_kg) - Number(l.expected_kg)) }))
        .filter((v) => v.expected > 0 && Math.abs(v.diff) / v.expected * 100 > tol);
      if (variances.length && !note) throw badRequest(`Weighed kg differs from the document by more than ${tol}% (${variances.map((v) => `${v.sku}: ${v.diff > 0 ? '+' : ''}${v.diff} kg`).join(', ')}). Add a note to complete.`, { fields: { note: 'Required' } });
      await c.query(`UPDATE inwards SET status = 'completed', completed_at = now(), completed_by_name = $2, notes = coalesce($3, notes) WHERE id = $1`, [inw.id, req.user!.name, note ?? null]);
      if (variances.length)
        await raiseException(c, { kind: 'inward_weight_variance', severity: 'warning', ref_type: 'inward', ref_id: inw.id, ref_label: `${inw.number} · ${inw.source_ref}`,
          message: `${inw.number}: weighed kg differs from the document — ${variances.map((v) => `${v.sku} ${v.diff > 0 ? '+' : ''}${v.diff} kg`).join(', ')}`, notifyPermission: 'procurement.exception.manage', link: `/inventory/inward/${inw.id}` });
      await auditReq(c, req, 'inward', inw.id, 'completed', { after: { lines: variances }, reason: note });
      return { variances };
    });
    res.json(out);
  });

  // ---------- quality inspection & grading ----------
  r.get('/qc/queue', requirePermission('inventory.read'), async (req, res) => {
    const params: unknown[] = [];
    let where = `r.state = 'qc_hold'`;
    if (req.query.warehouse) { params.push(req.query.warehouse); where += ` AND r.warehouse_id = $${params.length}`; }
    res.json(await many(pool, `
      SELECT l.id AS lot_id, l.lot_no, l.sku, l.product_name, l.party_name, l.source_ref, l.received_date, l.shade_code, l.dye_lot, r.warehouse_id,
        count(*)::int AS rolls, round(sum(r.weight_kg), 2)::float AS kg,
        json_agg(json_build_object('id', r.id, 'barcode', r.barcode, 'weight_kg', r.weight_kg, 'gsm', r.gsm, 'width_in', r.width_in, 'shade_code', r.shade_code) ORDER BY r.roll_no) AS roll_list
      FROM rolls r JOIN lots l ON l.id = r.lot_id WHERE ${where} GROUP BY l.id, r.warehouse_id ORDER BY l.received_date, l.lot_no`, params));
  });

  /** Grade rolls A/B/C/reject with measured GSM, width and shade; out-of-spec measurements are flagged. */
  r.post('/qc', requirePermission('inventory.qc.record'), async (req, res) => {
    const b = parse(qcBody, req.body);
    const out = await tx(pool, async (c) => {
      const lots = new Map<string, { lot_no: string; product_id: string }>();
      const flags: string[] = [];
      for (const x of b.results) {
        const roll = await lockRoll(c, x.barcode);
        assertWarehouse(req, roll.warehouse_id);
        if (roll.state !== 'qc_hold') throw conflict(`${roll.barcode} is not waiting for QC`);
        const lot = await one<{ id: string; lot_no: string; product_id: string }>(c, 'SELECT id, lot_no, product_id FROM lots WHERE id = $1', [roll.lot_id]);
        lots.set(lot!.id, lot!);
        const p = await getProduct(roll.product_id).catch(() => null) as { attributes?: Record<string, number> } | null;
        const gsm = x.gsm ?? roll.gsm, width = x.width_in ?? roll.width_in;
        const spec = p?.attributes ?? {};
        if (gsm && spec.gsm && Math.abs(gsm - spec.gsm) / spec.gsm * 100 > (spec.weight_tolerance_pct ?? 5)) flags.push(`${roll.barcode}: GSM ${gsm} vs spec ${spec.gsm}`);
        if (width && spec.width && Math.abs(width - spec.width) / spec.width * 100 > (spec.width_tolerance_pct ?? 5)) flags.push(`${roll.barcode}: width ${width}" vs spec ${spec.width}"`);
        await moveRoll(c, roll, 'qc', { state: x.grade === 'reject' ? 'rejected' : 'available' }, {
          ref: { type: 'lot', id: lot!.id, no: lot!.lot_no }, reason: x.defects.length ? x.defects.join(', ') : b.note, actor: actorOf(req),
          set: { grade: x.grade, gsm, width_in: width, shade_code: x.shade_code ?? roll.shade_code, defects: x.defects },
        });
      }
      for (const [lotId, lot] of lots) {
        const g = await one<{ pending: number; graded: number; rejected: number; top: string | null }>(c, `
          SELECT count(*) FILTER (WHERE state = 'qc_hold')::int AS pending, count(*) FILTER (WHERE grade IS NOT NULL)::int AS graded,
            count(*) FILTER (WHERE grade = 'reject')::int AS rejected,
            (SELECT grade FROM rolls WHERE lot_id = $1 AND grade IS NOT NULL AND grade <> 'reject' GROUP BY grade ORDER BY count(*) DESC, grade LIMIT 1) AS top
          FROM rolls WHERE lot_id = $1`, [lotId]);
        const status = g!.pending > 0 ? 'pending' : g!.rejected === 0 ? 'passed' : g!.rejected === g!.graded ? 'failed' : 'partial';
        await c.query('UPDATE lots SET qc_status = $2, grade = coalesce($3, CASE WHEN $4::int > 0 THEN \'reject\' END) WHERE id = $1', [lotId, status, g!.top, g!.rejected]);
        if (g!.rejected > 0)
          await raiseException(c, { kind: 'qc_rejected', severity: 'warning', ref_type: 'lot', ref_id: lotId, ref_label: lot.lot_no, message: `${g!.rejected} roll(s) of ${lot.lot_no} rejected at QC — arrange return or claim`, notifyPermission: 'procurement.exception.manage', link: `/inventory/lots/${lotId}` });
      }
      if (flags.length)
        for (const [lotId, lot] of lots)
          await raiseException(c, { kind: 'spec_deviation', severity: 'info', ref_type: 'lot', ref_id: lotId, ref_label: lot.lot_no, message: `Out-of-spec measurements on ${lot.lot_no}: ${flags.slice(0, 4).join('; ')}`, notifyPermission: 'inventory.qc.record', link: `/inventory/lots/${lotId}` });
      await auditReq(c, req, 'qc', [...lots.keys()][0], 'graded', { after: { rolls: b.results.length, grades: b.results.map((x) => `${x.barcode}:${x.grade}`) }, reason: b.note });
      return { graded: b.results.length, flags };
    });
    res.json(out);
  });

  // ---------- putaway & warehouse map ----------
  /** Directed putaway: the bin already holding this lot, else one with this SKU, else the emptiest storage bin with room. */
  r.get('/putaway/suggest', requirePermission('inventory.read'), async (req, res) => {
    const roll = await one<Roll>(pool, 'SELECT * FROM rolls WHERE barcode = upper($1) OR id::text = $1', [String(req.query.barcode ?? '')]);
    if (!roll || !roll.warehouse_id) throw notFound('Roll');
    res.json(await suggestBins(pool, roll));
  });

  r.post('/putaway', requirePermission('inventory.move'), async (req, res) => {
    const b = parse(z.object({ barcodes: z.array(z.string().min(3)).min(1).max(200), location_id: z.uuid() }), req.body);
    const out = await tx(pool, async (c) => {
      let n = 0, kg = 0;
      for (const code of b.barcodes) {
        const roll = await lockRoll(c, code);
        assertWarehouse(req, roll.warehouse_id);
        if (!roll.warehouse_id || !PHYSICAL.includes(roll.state)) throw conflict(`${roll.barcode} is not in a warehouse (${roll.state.replace('_', ' ')})`);
        const loc = (await getLocations(roll.warehouse_id)).find((l) => l.id === b.location_id && l.status === 'active');
        if (!loc) throw badRequest(`That location is not in ${roll.barcode}’s warehouse`);
        if (loc.kind !== 'bin' && loc.purpose === 'storage') throw badRequest('Choose a bin for storage');
        if (roll.state === 'qc_hold' && loc.purpose === 'storage') throw conflict(`${roll.barcode} must pass QC before it is put away`);
        const toDamaged = loc.purpose === 'damaged' && roll.state === 'available';
        await moveRoll(c, roll, roll.location_path && /^RCV/.test(roll.location_path) ? 'putaway' : toDamaged ? 'damage' : 'move', { location: { id: loc.id, path: loc.path }, ...(toDamaged ? { state: 'damaged' as const } : {}) }, { actor: actorOf(req) });
        n++; kg += roll.weight_kg;
      }
      return { rolls: n, kg: round3(kg) };
    });
    res.json(out);
  });

  r.post('/rolls/:code/split', requirePermission('inventory.move'), async (req, res) => {
    const b = parse(z.object({ kg: z.number().positive(), reason: optText(300) }), req.body);
    const child = await tx(pool, async (c) => {
      const roll = await lockRoll(c, String(req.params.code));
      if (roll.state === 'at_mill') throw conflict('Rolls at a mill are split automatically on return');
      assertWarehouse(req, roll.warehouse_id);
      const ch = await splitRoll(c, roll, b.kg, actorOf(req), b.reason ?? null);
      await auditReq(c, req, 'roll', roll.id, 'split', { after: { child: ch.barcode, kg: b.kg }, reason: b.reason });
      return ch;
    });
    res.status(201).json(child);
  });

  r.post('/rolls/:code/damage', requirePermission('inventory.move'), async (req, res) => {
    const { reason } = parse(z.object({ reason: z.string().trim().min(3).max(300) }), req.body);
    await tx(pool, async (c) => {
      const roll = await lockRoll(c, String(req.params.code));
      assertWarehouse(req, roll.warehouse_id);
      if (roll.state !== 'available') throw conflict('Only available rolls can be marked damaged');
      const dmg = (await getLocations(roll.warehouse_id!)).find((l) => l.purpose === 'damaged' && l.status === 'active');
      await moveRoll(c, roll, 'damage', { state: 'damaged', ...(dmg ? { location: { id: dmg.id, path: dmg.path } } : {}) }, { reason, actor: actorOf(req) });
      await auditReq(c, req, 'roll', roll.id, 'damaged', { reason });
    });
    res.json({ ok: true });
  });

  /** Locations with what each holds, for the warehouse map. */
  r.get('/warehouses/:id/map', requirePermission('inventory.read'), async (req, res) => {
    const w = await getWarehouse(String(req.params.id));
    assertWarehouse(req, w.id);
    const locs = await getLocations(w.id);
    const occ = await many<{ location_id: string; rolls: number; kg: number; lots: number; skus: string }>(pool, `
      SELECT r.location_id, count(*)::int AS rolls, round(sum(r.weight_kg), 2)::float AS kg, count(DISTINCT r.lot_id)::int AS lots, string_agg(DISTINCT l.sku, ', ') AS skus
      FROM rolls r JOIN lots l ON l.id = r.lot_id WHERE r.warehouse_id = $1 AND r.state = ANY($2) AND r.location_id IS NOT NULL GROUP BY r.location_id`, [w.id, PHYSICAL]);
    const unplaced = await one<{ rolls: number; kg: number }>(pool, `SELECT count(*)::int AS rolls, coalesce(round(sum(weight_kg), 2), 0)::float AS kg FROM rolls WHERE warehouse_id = $1 AND state = ANY($2) AND location_id IS NULL`, [w.id, PHYSICAL]);
    const byId = new Map(occ.map((o) => [o.location_id, o]));
    res.json({ warehouse: w, unplaced, locations: locs.map((l) => ({ ...l, rolls: byId.get(l.id)?.rolls ?? 0, kg: byId.get(l.id)?.kg ?? 0, lots: byId.get(l.id)?.lots ?? 0, skus: byId.get(l.id)?.skus ?? null })) });
  });

  /** One lookup for any scanned code: a roll barcode or a lot number. */
  r.get('/scan/:code', requirePermission('inventory.read'), async (req, res) => {
    const code = String(req.params.code).trim().toUpperCase();
    const roll = await one<Roll & { lot_no: string; sku: string; product_name: string; price_per_kg: number | null; qc_status: string }>(pool, `
      SELECT r.*, l.lot_no, l.sku, l.product_name, l.price_per_kg, l.qc_status FROM rolls r JOIN lots l ON l.id = r.lot_id WHERE r.barcode = $1`, [code]);
    if (roll) {
      const history = await many(pool, 'SELECT * FROM stock_movements WHERE roll_id = $1 ORDER BY id DESC LIMIT 20', [roll.id]);
      return void res.json({ kind: 'roll', roll, history, suggestions: roll.warehouse_id && roll.state === 'available' ? await suggestBins(pool, roll) : [] });
    }
    const lot = await one<{ id: string }>(pool, 'SELECT id FROM lots WHERE lot_no = $1', [code]);
    if (lot) return void res.json({ kind: 'lot', lot_id: lot.id });
    throw notFound(`Barcode ${code}`);
  });
}

async function suggestBins(c: Pool | Client, roll: Roll) {
  const bins = (await getLocations(roll.warehouse_id!)).filter((l) => l.kind === 'bin' && l.purpose === 'storage' && l.status === 'active');
  const occ = await many<{ location_id: string; kg: number; same_lot: boolean; same_sku: boolean }>(c, `
    SELECT location_id, sum(weight_kg)::float AS kg, bool_or(lot_id = $2) AS same_lot, bool_or(product_id = $3) AS same_sku
    FROM rolls WHERE warehouse_id = $1 AND location_id IS NOT NULL AND state = ANY($4) GROUP BY location_id`, [roll.warehouse_id, roll.lot_id, roll.product_id, PHYSICAL]);
  const by = new Map(occ.map((o) => [o.location_id, o]));
  return bins
    .map((b) => {
      const o = by.get(b.id);
      const used = o?.kg ?? 0;
      const free = b.capacity_kg ? Number(b.capacity_kg) - used : null;
      const reason = o?.same_lot ? 'Same lot already here' : o?.same_sku ? 'Same SKU already here' : used === 0 ? 'Empty bin' : 'Has room';
      return { id: b.id, path: b.path, used_kg: round2(used), free_kg: free === null ? null : round2(free), reason, score: (o?.same_lot ? 3 : o?.same_sku ? 2 : 0) + (used === 0 ? 1 : 0) - used / 100000 };
    })
    .filter((b) => b.free_kg === null || b.free_kg >= roll.weight_kg)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map(({ score: _s, ...rest }) => rest);
}

export { isoDate };
