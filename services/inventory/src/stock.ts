import type { Router } from 'express';
import { z } from 'zod';
import { type BusEvent, type Client, type ServiceContext, badRequest, callService, conflict, listQuery, many, notFound, notify, one, orderLimit, page, parse, reqText, requirePermission, scopeClause, tx } from '@erp/platform';
import { S, assertWarehouse, auditReq, getWarehouses, round2, round3, setting, whLabel } from './common.ts';
import { PHYSICAL, lockRoll, moveRoll, verifyLedger } from './ledger.ts';
import { actorOf } from './inward.ts';

const STATES = ['qc_hold', 'available', 'reserved', 'allocated', 'in_transit', 'damaged', 'rejected'];

/** Ageing bucket labels from the configured limits, e.g. [30,60,90,180,365] → 0–30 … >365. */
export function ageingBuckets(limits: number[]) {
  const out: { label: string; min: number; max: number | null }[] = [];
  let prev = 0;
  for (const [i, l] of limits.entries()) {
    out.push({ label: `${i === 0 ? 0 : prev + 1}–${l}`, min: i === 0 ? 0 : prev + 1, max: l });
    prev = l;
  }
  out.push({ label: `>${prev}`, min: prev + 1, max: null });
  return out;
}

function recommendation(ageDays: number, slow: boolean) {
  if (ageDays > 365) return 'Dead stock: clear at or below cost, offer to wholesale buyers';
  if (ageDays > 180) return 'Clearance: 10–15% discount or bundle with fast movers';
  if (slow) return 'Slow: push to the sales team with a targeted offer';
  return null;
}

/** Job-work orders that draw from a warehouse: the stores scan those rolls out to the mill. */
export function jobIssuedConsumer() {
  return async (ev: BusEvent, c: Client) => {
    const p = ev.payload as { job_order_id: string; number: string; mill_name?: string; warehouse_lines?: { warehouse_id: string; product_id: string; sku: string; kg_sent: number }[] };
    if (!p.warehouse_lines?.length) return;
    const whs = await getWarehouses();
    for (const l of p.warehouse_lines) {
      const w = whs.find((x) => x.id === l.warehouse_id);
      await c.query(`
        INSERT INTO mill_issues (job_order_id, job_order_no, mill_name, warehouse_id, warehouse_name, product_id, sku, requested_kg) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
        ON CONFLICT (job_order_id, warehouse_id, product_id) DO UPDATE SET requested_kg = mill_issues.requested_kg + EXCLUDED.requested_kg`,
        [p.job_order_id, p.number, p.mill_name ?? 'Mill', l.warehouse_id, w ? whLabel(w) : 'Warehouse', l.product_id, l.sku, l.kg_sent]);
    }
    await notify(c, S, { audience_permission: 'inventory.move', kind: 'action', title: `Issue rolls to ${p.mill_name ?? 'the mill'} for ${p.number}`, body: p.warehouse_lines.map((l) => `${l.sku} ${l.kg_sent} kg`).join(', '), link: '/inventory/mill-issues' });
  };
}

export function stockRoutes(r: Router, { pool }: ServiceContext) {
  /** Availability by product and warehouse, derived only from the stock ledger. */
  r.get('/availability', requirePermission('inventory.read'), async (req, res) => {
    const params: unknown[] = [];
    const where: string[] = ['b.warehouse_id IS NOT NULL'];
    if (req.query.warehouse) { params.push(req.query.warehouse); where.push(`b.warehouse_id = $${params.length}`); }
    if (req.query.product) { params.push(req.query.product); where.push(`b.product_id = $${params.length}`); }
    const sc = scopeClause(req.user!, 'warehouse', 'b.warehouse_id', params);
    if (sc) where.push(sc);
    const rows = await many<{ product_id: string; warehouse_id: string; state: string; kg: number; rolls: number }>(pool, `SELECT b.product_id, b.warehouse_id, b.state, b.kg::float, b.rolls FROM stock_balances b WHERE ${where.join(' AND ')}`, params);
    const atMill = await many<{ product_id: string; kg: number }>(pool, `SELECT product_id, round(sum(weight_kg), 3)::float AS kg FROM rolls WHERE state = 'at_mill' GROUP BY product_id`);
    const greyAtMills = await callService<{ product_id: string; kg_available: number }[]>(S, 'jobwork', 'GET', '/mill-stock').catch(() => []);
    const lots = await many<{ id: string; sku: string; product_name: string; product_id: string }>(pool, 'SELECT DISTINCT ON (product_id) product_id, sku, product_name FROM lots ORDER BY product_id');
    const whs = await getWarehouses();
    const key = (p: string, w: string) => `${p}|${w}`;
    const grid = new Map<string, Record<string, number | string>>();
    for (const x of rows) {
      const k = key(x.product_id, x.warehouse_id);
      const g = grid.get(k) ?? { product_id: x.product_id, warehouse_id: x.warehouse_id };
      g[x.state] = round3(Number(g[x.state] ?? 0) + x.kg);
      g[`${x.state}_rolls`] = Number(g[`${x.state}_rolls`] ?? 0) + x.rolls;
      grid.set(k, g);
    }
    const items = [...grid.values()].map((g) => {
      const prod = lots.find((l) => l.product_id === g.product_id);
      const w = whs.find((x) => x.id === g.warehouse_id);
      const n = (s: string) => Number(g[s] ?? 0);
      return {
        product_id: g.product_id, sku: prod?.sku ?? '?', product_name: prod?.product_name ?? '', warehouse_id: g.warehouse_id, warehouse: w ? whLabel(w) : '?',
        physical: round3(PHYSICAL.reduce((s, x) => s + n(x), 0)), available: n('available'), reserved: n('reserved'), allocated: n('allocated'),
        hold: n('qc_hold'), damaged: n('damaged'), rejected: n('rejected'), in_transit_in: n('in_transit'), rolls_available: n('available_rolls'),
      };
    }).sort((a, b) => a.sku.localeCompare(b.sku) || a.warehouse.localeCompare(b.warehouse));
    const totals = Object.fromEntries(['physical', 'available', 'reserved', 'allocated', 'hold', 'damaged', 'rejected', 'in_transit_in'].map((k) => [k, round3(items.reduce((s, i) => s + Number(i[k as keyof typeof i]), 0))]));
    res.json({
      items, totals: { ...totals, at_mill: round3(atMill.reduce((s, x) => s + x.kg, 0)), grey_at_mills: round3(greyAtMills.reduce((s, x) => s + Number(x.kg_available), 0)) },
      at_mill: atMill.map((x) => ({ ...x, sku: lots.find((l) => l.product_id === x.product_id)?.sku ?? '?' })),
    });
  });

  /** Checks that every roll's position matches the ledger. */
  r.get('/ledger/verify', requirePermission('inventory.read'), async (_req, res) => {
    const mismatches = await verifyLedger(pool);
    const totals = await one<{ movements: number; rolls: number }>(pool, `SELECT count(*)::int AS movements, (SELECT count(*)::int FROM rolls) AS rolls FROM stock_movements`);
    res.json({ ok: mismatches.length === 0, mismatches, ...totals });
  });

  r.get('/ledger', requirePermission('inventory.read'), async (req, res) => {
    const lq = listQuery(req, ['id', 'at', 'movement_type', 'kg'], 'id');
    const params: unknown[] = [];
    const where: string[] = [];
    if (lq.filters.type) { params.push(lq.filters.type.split(',')); where.push(`m.movement_type = ANY($${params.length})`); }
    if (lq.filters.warehouse) { params.push(lq.filters.warehouse); where.push(`(m.from_warehouse_id = $${params.length} OR m.to_warehouse_id = $${params.length})`); }
    if (lq.filters.product) { params.push(lq.filters.product); where.push(`m.product_id = $${params.length}`); }
    if (lq.q) { params.push(`%${lq.q}%`); where.push(`(r.barcode ILIKE $${params.length} OR l.lot_no ILIKE $${params.length} OR m.ref_no ILIKE $${params.length} OR l.sku ILIKE $${params.length})`); }
    const rows = await many<{ total_count: number }>(pool, `
      SELECT m.*, r.barcode, l.lot_no, l.sku, count(*) OVER ()::int AS total_count
      FROM stock_movements m JOIN rolls r ON r.id = m.roll_id JOIN lots l ON l.id = m.lot_id ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ${orderLimit({ ...lq, dir: req.query.dir ? lq.dir : 'desc' }, params)}`, params);
    const whs = await getWarehouses();
    const name = (id: string | null) => (id ? whs.find((w) => w.id === id)?.code ?? '?' : null);
    const p = page(rows, lq);
    res.json({ ...p, items: p.items.map((m) => ({ ...m, from_warehouse: name((m as { from_warehouse_id: string | null }).from_warehouse_id), to_warehouse: name((m as { to_warehouse_id: string | null }).to_warehouse_id) })) });
  });

  r.get('/lots', requirePermission('inventory.read'), async (req, res) => {
    const lq = listQuery(req, ['lot_no', 'sku', 'received_date', 'kg', 'price_per_kg', 'created_at'], 'received_date');
    const params: unknown[] = [];
    const where: string[] = [];
    if (lq.filters.product) { params.push(lq.filters.product); where.push(`l.product_id = $${params.length}`); }
    if (lq.filters.qc) { params.push(lq.filters.qc.split(',')); where.push(`l.qc_status = ANY($${params.length})`); }
    if (lq.filters.warehouse) { params.push(lq.filters.warehouse); where.push(`EXISTS (SELECT 1 FROM rolls r WHERE r.lot_id = l.id AND r.warehouse_id = $${params.length} AND r.state = ANY('{${PHYSICAL.join(',')}}'))`); }
    if (lq.filters.in_stock === 'true') where.push(`s.kg > 0`);
    if (lq.q) { params.push(`%${lq.q}%`); where.push(`(l.lot_no ILIKE $${params.length} OR l.sku ILIKE $${params.length} OR l.product_name ILIKE $${params.length} OR l.party_name ILIKE $${params.length} OR l.shade_code ILIKE $${params.length} OR l.dye_lot ILIKE $${params.length})`); }
    const rows = await many<{ total_count: number }>(pool, `
      SELECT l.*, coalesce(s.kg, 0)::float AS kg, coalesce(s.available_kg, 0)::float AS available_kg, coalesce(s.rolls, 0)::int AS rolls, s.warehouses,
        (SELECT status FROM price_tags WHERE lot_id = l.id AND status = 'pending' LIMIT 1) AS price_pending,
        count(*) OVER ()::int AS total_count
      FROM lots l LEFT JOIN LATERAL (
        SELECT round(sum(weight_kg), 3) AS kg, round(sum(weight_kg) FILTER (WHERE state = 'available'), 3) AS available_kg, count(*) AS rolls, array_agg(DISTINCT warehouse_id) AS warehouses
        FROM rolls r WHERE r.lot_id = l.id AND r.state = ANY('{${PHYSICAL.join(',')}}')) s ON true
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ${orderLimit({ ...lq, dir: req.query.dir ? lq.dir : 'desc' }, params)}`, params);
    res.json(page(rows, lq));
  });

  /** Lot genealogy: where it came from (PO receipt or mill job and its grey lots), its rolls, every movement and what it became. */
  r.get('/lots/:id', requirePermission('inventory.read'), async (req, res) => {
    const id = String(req.params.id);
    const lot = await one<Record<string, unknown> & { parent_lot_ids: string[]; inward_id: string | null }>(pool, `SELECT * FROM lots WHERE id::text = $1 OR lot_no = upper($1)`, [id]);
    if (!lot) throw notFound('Lot');
    const lotId = lot.id as string;
    const [rolls, movements, parents, children, prices, inward, transfers] = await Promise.all([
      many(pool, 'SELECT * FROM rolls WHERE lot_id = $1 ORDER BY roll_no', [lotId]),
      many(pool, 'SELECT m.*, r.barcode FROM stock_movements m JOIN rolls r ON r.id = m.roll_id WHERE m.lot_id = $1 ORDER BY m.id', [lotId]),
      many(pool, 'SELECT id, lot_no, sku, product_name, source_type, source_ref, party_name, received_date, cost_per_kg FROM lots WHERE id = ANY($1)', [lot.parent_lot_ids]),
      many(pool, 'SELECT id, lot_no, sku, product_name, source_type, source_ref, party_name, received_date FROM lots WHERE $1 = ANY(parent_lot_ids) ORDER BY received_date', [lotId]),
      many(pool, 'SELECT * FROM price_tags WHERE lot_id = $1 ORDER BY requested_at DESC', [lotId]),
      lot.inward_id ? one(pool, 'SELECT id, number, source_type, source_ref, party_name, warehouse_name, status FROM inwards WHERE id = $1', [lot.inward_id]) : null,
      many(pool, `SELECT DISTINCT t.id, t.number, t.status, t.from_warehouse_name, t.to_warehouse_name, t.document_type, t.document_no FROM transfers t JOIN transfer_rolls tr ON tr.transfer_id = t.id JOIN rolls r ON r.id = tr.roll_id WHERE r.lot_id = $1`, [lotId]),
    ]);
    const physical = (rolls as { state: string; weight_kg: number }[]).filter((x) => PHYSICAL.includes(x.state as never));
    res.json({ ...lot, rolls, movements, parents, children, prices, inward, transfers,
      summary: { rolls: physical.length, kg: round3(physical.reduce((s, x) => s + Number(x.weight_kg), 0)), available_kg: round3(physical.filter((x) => x.state === 'available').reduce((s, x) => s + Number(x.weight_kg), 0)) } });
  });

  r.get('/rolls', requirePermission('inventory.read'), async (req, res) => {
    const params: unknown[] = [];
    const where: string[] = [];
    if (req.query.state) { params.push(String(req.query.state).split(',')); where.push(`r.state = ANY($${params.length})`); }
    if (req.query.warehouse) { params.push(req.query.warehouse); where.push(`r.warehouse_id = $${params.length}`); }
    if (req.query.product) { params.push(req.query.product); where.push(`r.product_id = $${params.length}`); }
    if (req.query.lot) { params.push(req.query.lot); where.push(`r.lot_id = $${params.length}`); }
    if (req.query.location) { params.push(req.query.location); where.push(`r.location_id = $${params.length}`); }
    const sc = scopeClause(req.user!, 'warehouse', 'r.warehouse_id', params);
    if (sc) where.push(sc);
    res.json(await many(pool, `
      SELECT r.*, l.lot_no, l.sku, l.product_name, l.price_per_kg, l.received_date FROM rolls r JOIN lots l ON l.id = r.lot_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY l.received_date, l.lot_no, r.roll_no LIMIT 500`, params));
  });

  /** Ageing by configurable buckets, with slow and dead stock and a clearance recommendation. */
  r.get('/ageing', requirePermission('inventory.read'), async (req, res) => {
    const limits = await setting<number[]>('inventory.ageing_buckets', [30, 60, 90, 180, 365]);
    const slowDays = Number(await setting('inventory.slow_moving_days', 90));
    const buckets = ageingBuckets(limits);
    const params: unknown[] = [PHYSICAL];
    let wh = '';
    if (req.query.warehouse) { params.push(req.query.warehouse); wh = ` AND r.warehouse_id = $${params.length}`; }
    const lots = await many<{ lot_id: string; lot_no: string; sku: string; product_name: string; received_date: string; age_days: number; kg: number; rolls: number; value: number | null; last_out: string | null; price_per_kg: number | null; cost_per_kg: number | null; warehouses: string[] }>(pool, `
      SELECT l.id AS lot_id, l.lot_no, l.sku, l.product_name, l.received_date, (current_date - l.received_date) AS age_days,
        round(sum(r.weight_kg), 3)::float AS kg, count(*)::int AS rolls, round(sum(r.weight_kg) * l.cost_per_kg, 2)::float AS value, l.price_per_kg, l.cost_per_kg,
        (SELECT max(m.at) FROM stock_movements m WHERE m.lot_id = l.id AND m.movement_type IN ('pick','transfer_out','issue_to_mill')) AS last_out,
        array_agg(DISTINCT r.warehouse_id) AS warehouses
      FROM rolls r JOIN lots l ON l.id = r.lot_id WHERE r.state = ANY($1)${wh}
      GROUP BY l.id ORDER BY age_days DESC`, params);
    const out = lots.map((l) => {
      const slow = l.age_days > slowDays && (!l.last_out || (Date.now() - new Date(l.last_out).getTime()) / 86_400_000 > slowDays);
      return { ...l, bucket: buckets.find((b) => l.age_days >= b.min && (b.max === null || l.age_days <= b.max))!.label, slow, recommendation: recommendation(l.age_days, slow) };
    });
    res.json({
      buckets: buckets.map((b) => {
        const inB = out.filter((l) => l.bucket === b.label);
        return { label: b.label, lots: inB.length, kg: round3(inB.reduce((s, l) => s + l.kg, 0)), value: round2(inB.reduce((s, l) => s + (l.value ?? 0), 0)) };
      }),
      slow_days: slowDays,
      lots: out,
    });
  });

  /** Lots grouped by shade and dye lot, with customer shade decisions, to keep shades from mixing. */
  r.get('/shades', requirePermission('inventory.read'), async (req, res) => {
    const params: unknown[] = [];
    let where = `r.state = ANY('{${PHYSICAL.join(',')}}')`;
    if (req.query.product) { params.push(req.query.product); where += ` AND l.product_id = $${params.length}`; }
    const groups = await many(pool, `
      SELECT l.product_id, l.sku, l.product_name, coalesce(r.shade_code, l.shade_code, '—') AS shade_code, coalesce(r.dye_lot, l.dye_lot, '—') AS dye_lot,
        count(DISTINCT l.id)::int AS lots, count(*)::int AS rolls, round(sum(r.weight_kg), 2)::float AS kg,
        round(sum(r.weight_kg) FILTER (WHERE r.state = 'available'), 2)::float AS available_kg, array_agg(DISTINCT l.lot_no) AS lot_nos
      FROM rolls r JOIN lots l ON l.id = r.lot_id WHERE ${where} GROUP BY 1, 2, 3, 4, 5 ORDER BY l.sku, 4, 5`, params);
    const decisions = await many(pool, 'SELECT * FROM shade_approvals ORDER BY recorded_at DESC LIMIT 300');
    res.json({ groups, decisions });
  });

  r.post('/shade-approvals', requirePermission('inventory.reserve'), async (req, res) => {
    const b = parse(z.object({ customer_id: z.uuid(), product_id: z.uuid(), shade_code: z.string().trim().min(1).max(40), decision: z.enum(['accepted', 'rejected']), note: z.string().max(500).nullable().optional() }), req.body);
    const out = await tx(pool, async (c) => {
      const cust = await callService<{ legal_name: string; party_type: string }>(S, 'masters', 'GET', `/parties/${b.customer_id}`).catch(() => null);
      if (!cust || cust.party_type !== 'customer') throw badRequest('Choose a customer');
      const lot = await one<{ sku: string }>(c, 'SELECT sku FROM lots WHERE product_id = $1 LIMIT 1', [b.product_id]);
      const row = await one(c, `
        INSERT INTO shade_approvals (customer_id, customer_name, product_id, sku, shade_code, decision, note, recorded_by_name) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
        ON CONFLICT (customer_id, product_id, shade_code) DO UPDATE SET decision = EXCLUDED.decision, note = EXCLUDED.note, recorded_by_name = EXCLUDED.recorded_by_name, recorded_at = now() RETURNING *`,
        [b.customer_id, cust.legal_name, b.product_id, lot?.sku ?? '?', b.shade_code.toUpperCase(), b.decision, b.note ?? null, req.user!.name]);
      await auditReq(c, req, 'shade_approval', (row as { id: string }).id, b.decision, { after: { customer: cust.legal_name, shade: b.shade_code }, reason: b.note });
      return row;
    });
    res.status(201).json(out);
  });

  // ---------- issue to mill ----------
  r.get('/mill-issues', requirePermission('inventory.read'), async (req, res) => {
    res.json(await many(pool, `
      SELECT i.*, (SELECT count(*)::int FROM rolls r WHERE r.holder_ref = i.job_order_no AND r.product_id = i.product_id AND r.state IN ('at_mill','consumed')) AS rolls_issued
      FROM mill_issues i WHERE ($1::text IS NULL OR i.status = $1) ORDER BY (i.status = 'open') DESC, i.created_at DESC LIMIT 200`, [req.query.status ?? null]));
  });

  r.post('/mill-issues/:id/scan', requirePermission('inventory.move'), async (req, res) => {
    const { barcode } = parse(z.object({ barcode: reqText(40) }), req.body);
    const out = await tx(pool, async (c) => {
      const i = await one<{ id: string; job_order_id: string; job_order_no: string; mill_name: string; warehouse_id: string; product_id: string; sku: string; requested_kg: number; issued_kg: number; status: string }>(c, 'SELECT * FROM mill_issues WHERE id = $1 FOR UPDATE', [req.params.id]);
      if (!i) throw notFound('Mill issue');
      if (i.status !== 'open') throw conflict('All rolls for this job are already issued');
      const roll = await lockRoll(c, barcode);
      if (roll.product_id !== i.product_id) throw conflict(`${roll.barcode} is not ${i.sku}`);
      assertWarehouse(req, i.warehouse_id);
      if (roll.warehouse_id !== i.warehouse_id) throw conflict(`${roll.barcode} is not in this warehouse`);
      if (roll.state !== 'available') throw conflict(`${roll.barcode} is ${roll.state.replace('_', ' ')}, not available`);
      await moveRoll(c, roll, 'issue_to_mill', { state: 'at_mill', warehouse_id: null, location: null }, { ref: { type: 'job_order', id: i.job_order_id, no: i.job_order_no }, actor: actorOf(req), set: { holder_ref: i.job_order_no } });
      const issued = round3(Number(i.issued_kg) + roll.weight_kg);
      const done = issued >= Number(i.requested_kg) * 0.98;
      await c.query('UPDATE mill_issues SET issued_kg = $2, status = $3 WHERE id = $1', [i.id, issued, done ? 'issued' : 'open']);
      return { roll: roll.barcode, kg: roll.weight_kg, issued_kg: issued, requested_kg: Number(i.requested_kg), done };
    });
    res.json(out);
  });

  r.get('/exceptions', requirePermission('inventory.read'), async (req, res) => {
    res.json(await many(pool, `SELECT * FROM exceptions WHERE status = $1 ORDER BY detected_at DESC LIMIT 300`, [(req.query.status as string) ?? 'open']));
  });

  r.post('/exceptions/:id/resolve', requirePermission('inventory.move', 'inventory.qc.record', 'inventory.inward.record'), async (req, res) => {
    const { resolution } = parse(z.object({ resolution: reqText(500) }), req.body);
    await tx(pool, async (c) => {
      const r1 = await c.query(`UPDATE exceptions SET status = 'resolved', resolved_at = now(), resolved_by_name = $2, resolution = $3 WHERE id = $1 AND status = 'open'`, [req.params.id, req.user!.name, resolution]);
      if (!r1.rowCount) throw notFound('Open exception');
      await auditReq(c, req, 'exception', String(req.params.id), 'resolved', { reason: resolution });
    });
    res.json({ ok: true });
  });

  r.get('/dashboard', requirePermission('inventory.read'), async (_req, res) => {
    const limits = await setting<number[]>('inventory.ageing_buckets', [30, 60, 90, 180, 365]);
    const old = limits[limits.length - 2] ?? 180;
    res.json(await one(pool, `SELECT
      (SELECT coalesce(round(sum(weight_kg), 1), 0) FROM rolls WHERE state = ANY($1))::float AS physical_kg,
      (SELECT coalesce(round(sum(weight_kg), 1), 0) FROM rolls WHERE state = 'available')::float AS available_kg,
      (SELECT coalesce(round(sum(weight_kg), 1), 0) FROM rolls WHERE state IN ('reserved','allocated'))::float AS reserved_kg,
      (SELECT coalesce(round(sum(weight_kg), 1), 0) FROM rolls WHERE state = 'in_transit')::float AS in_transit_kg,
      (SELECT coalesce(round(sum(weight_kg), 1), 0) FROM rolls WHERE state = 'at_mill')::float AS at_mill_kg,
      (SELECT count(*)::int FROM rolls WHERE state = ANY($1)) AS rolls,
      (SELECT count(*)::int FROM rolls WHERE state = 'qc_hold') AS qc_pending_rolls,
      (SELECT count(*)::int FROM inwards WHERE status = 'open') AS open_inwards,
      (SELECT count(*)::int FROM price_tags WHERE status = 'pending') AS price_pending,
      (SELECT count(*)::int FROM lots l WHERE l.price_per_kg IS NULL AND EXISTS (SELECT 1 FROM rolls r WHERE r.lot_id = l.id AND r.state = 'available')) AS unpriced_lots,
      (SELECT count(*)::int FROM transfers WHERE status IN ('requested','pending_approval','approved')) AS transfers_open,
      (SELECT count(*)::int FROM transfers WHERE status IN ('in_transit','partially_received')) AS transfers_in_transit,
      (SELECT count(*)::int FROM stocktakes WHERE status IN ('counting','submitted')) AS stocktakes_open,
      (SELECT count(*)::int FROM mill_issues WHERE status = 'open') AS mill_issues_open,
      (SELECT count(*)::int FROM reservations WHERE status = 'active') AS reservations_active,
      (SELECT coalesce(round(sum(r.weight_kg), 1), 0) FROM rolls r JOIN lots l ON l.id = r.lot_id WHERE r.state = ANY($1) AND current_date - l.received_date > $2)::float AS aged_kg,
      (SELECT count(*)::int FROM exceptions WHERE status = 'open') AS open_exceptions`, [PHYSICAL, old]));
  });

  r.get('/states', (_req, res) => void res.json(STATES));
}
