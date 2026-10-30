import type { Request, Router } from 'express';
import { z } from 'zod';
import { type Client, type Pool, type ServiceContext, badRequest, callService, conflict, many, notFound, one, optText, parse, publish, reqText, requirePermission, tx } from '@erp/platform';
import { S, assertWarehouse, auditReq, getWarehouse, nextNumber, round3, setting, whLabel } from './common.ts';
import { type Roll, lockRoll, moveRoll, splitRoll } from './ledger.ts';
import { actorOf } from './inward.ts';

export const reservationBody = z.object({
  warehouse_id: z.uuid(),
  ref_type: z.enum(['manual', 'quotation', 'sales_order']).default('manual'),
  ref_id: z.uuid().nullable().optional(),
  ref_no: optText(40),
  customer_id: z.uuid().nullable().optional(),
  barcodes: z.array(z.string().min(3)).max(300).optional(),
  lines: z.array(z.object({ lot_id: z.uuid(), kg: z.number().positive() })).max(50).optional(),
  mixed_shade_reason: optText(300),
}).refine((b) => (b.barcodes?.length ?? 0) + (b.lines?.length ?? 0) > 0, 'Choose rolls or lots to reserve');

/**
 * Reserves whole rolls (splitting the last one when only part is needed) so the same kg can never be
 * promised twice. Mixing dye lots of one SKU is blocked unless a reason is given, and a shade the
 * customer has rejected is never reserved for them.
 */
export async function reserve(c: Client, req: Request, b: z.infer<typeof reservationBody>) {
  const w = await getWarehouse(b.warehouse_id);
  assertWarehouse(req, w.id);
  const holdDays = Number(await setting('inventory.reservation_hold_days', 3));
  const blockMix = await setting('inventory.block_shade_mixing', true);
  const actor = actorOf(req);
  const rolls: Roll[] = [];
  for (const code of b.barcodes ?? []) rolls.push(await lockRoll(c, code));
  for (const l of b.lines ?? []) {
    const avail = await many<Roll>(c, `SELECT * FROM rolls WHERE lot_id = $1 AND warehouse_id = $2 AND state = 'available' ORDER BY weight_kg DESC, roll_no FOR UPDATE`, [l.lot_id, w.id]);
    const total = avail.reduce((s, r) => s + Number(r.weight_kg), 0);
    if (total < l.kg - 0.001) {
      const lot = await one<{ lot_no: string }>(c, 'SELECT lot_no FROM lots WHERE id = $1', [l.lot_id]);
      throw conflict(`Only ${round3(total)} kg of ${lot?.lot_no ?? 'that lot'} is available in ${w.code}`);
    }
    let need = l.kg;
    for (const r of avail) {
      if (need <= 0.0005) break;
      if (Number(r.weight_kg) > need + 1) { rolls.push(await splitRoll(c, r, round3(need), actor, `Cut for reservation`) as Roll); need = 0; } else { rolls.push(r); need = round3(need - Number(r.weight_kg)); }
    }
  }
  if (!rolls.length) throw badRequest('Nothing to reserve');
  const seen = new Set<string>();
  for (const r of rolls) {
    if (seen.has(r.id)) throw conflict(`${r.barcode} was scanned twice`);
    seen.add(r.id);
    if (r.warehouse_id !== w.id) throw conflict(`${r.barcode} is not in ${w.code}`);
    if (r.state !== 'available') throw conflict(`${r.barcode} is ${r.state.replace('_', ' ')}, not available`);
  }
  // Shade control: one dye lot per SKU unless explicitly accepted, and never a shade the customer rejected.
  const shades = new Map<string, Set<string>>();
  for (const r of rolls) {
    const s = shades.get(r.product_id) ?? new Set<string>();
    s.add((r.dye_lot ?? r.shade_code ?? '—').toUpperCase());
    shades.set(r.product_id, s);
  }
  const mixed = [...shades.values()].some((s) => s.size > 1);
  if (mixed && blockMix && !b.mixed_shade_reason) throw conflict('These rolls come from different dye lots of the same fabric. Choose one dye lot, or give a reason to mix shades.');
  let customerName: string | null = null;
  if (b.customer_id) {
    const cust = await callService<{ legal_name: string }>(S, 'masters', 'GET', `/parties/${b.customer_id}`).catch(() => null);
    customerName = cust?.legal_name ?? null;
    const rejected = await many<{ shade_code: string; sku: string }>(c, `SELECT shade_code, sku FROM shade_approvals WHERE customer_id = $1 AND decision = 'rejected'`, [b.customer_id]);
    for (const r of rolls) {
      const bad = rejected.find((x) => x.shade_code === (r.shade_code ?? '').toUpperCase() && r.shade_code);
      if (bad) throw conflict(`${customerName ?? 'This customer'} rejected shade ${bad.shade_code} of ${bad.sku}; ${r.barcode} has that shade`);
    }
  }
  const number = await nextNumber(c, 'reservation', 'RS-');
  const res = await one<{ id: string; number: string; expires_at: string }>(c, `
    INSERT INTO reservations (number, ref_type, ref_id, ref_no, customer_id, customer_name, warehouse_id, warehouse_name, mixed_shade_reason, expires_at, created_by, created_by_name)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now() + make_interval(days => $10), $11, $12) RETURNING id, number, expires_at`,
    [number, b.ref_type, b.ref_id ?? null, b.ref_no ?? null, b.customer_id ?? null, customerName, w.id, whLabel(w), mixed ? b.mixed_shade_reason ?? null : null, holdDays, actor.id, actor.name]);
  for (const r of rolls)
    await moveRoll(c, r, 'reserve', { state: 'reserved' }, { ref: { type: 'reservation', id: res!.id, no: number }, actor, set: { reservation_id: res!.id } });
  const kg = round3(rolls.reduce((s, r) => s + Number(r.weight_kg), 0));
  await auditReq(c, req, 'reservation', res!.id, 'created', { after: { number, rolls: rolls.length, kg, ref: b.ref_no, mixed_shade: mixed } });
  return { ...res!, rolls: rolls.map((r) => ({ barcode: r.barcode, weight_kg: r.weight_kg })), kg, mixed_shade: mixed };
}

export async function releaseReservation(c: Client, id: string, status: 'released' | 'expired', reason: string, actor: { id: string | null; name: string }) {
  const rv = await one<{ id: string; number: string; status: string }>(c, 'SELECT * FROM reservations WHERE id = $1 FOR UPDATE', [id]);
  if (!rv) throw notFound('Reservation');
  if (rv.status !== 'active') throw conflict(`This reservation is already ${rv.status}`);
  const rolls = await many<Roll>(c, `SELECT * FROM rolls WHERE reservation_id = $1 AND state = 'reserved' FOR UPDATE`, [id]);
  for (const r of rolls) await moveRoll(c, r, 'release', { state: 'available' }, { ref: { type: 'reservation', id, no: rv.number }, reason, actor, set: { reservation_id: null } });
  await c.query(`UPDATE reservations SET status = $2, closed_at = now(), close_reason = $3 WHERE id = $1`, [id, status, reason]);
  return { released_rolls: rolls.length };
}

export async function reservationDetail(c: Pool | Client, id: string) {
  const rv = await one<Record<string, unknown>>(c, 'SELECT * FROM reservations WHERE id::text = $1 OR number = $1', [id]);
  if (!rv) throw notFound('Reservation');
  const rolls = await many(c, `
    SELECT DISTINCT ON (r.id) r.id, r.barcode, r.weight_kg, r.state, r.shade_code, r.dye_lot, r.grade, r.location_path, l.lot_no, l.sku, l.product_name, l.price_per_kg
    FROM stock_movements m JOIN rolls r ON r.id = m.roll_id JOIN lots l ON l.id = r.lot_id WHERE m.ref_id = $1 AND m.movement_type = 'reserve' ORDER BY r.id`, [rv.id]);
  return { ...rv, rolls, kg: round3((rolls as { weight_kg: number }[]).reduce((s, r) => s + Number(r.weight_kg), 0)) };
}

export function reservationRoutes(r: Router, { pool }: ServiceContext) {
  r.get('/reservations', requirePermission('inventory.read'), async (req, res) => {
    res.json(await many(pool, `
      SELECT v.*, (SELECT count(*)::int FROM rolls WHERE reservation_id = v.id AND state = 'reserved') AS rolls_reserved,
        (SELECT round(sum(weight_kg), 2)::float FROM rolls WHERE reservation_id = v.id AND state = 'reserved') AS kg_reserved,
        (SELECT count(*)::int FROM stock_movements m WHERE m.ref_id = v.id AND m.movement_type = 'pick') AS rolls_picked
      FROM reservations v WHERE ($1::text IS NULL OR v.status = $1) AND ($2::uuid IS NULL OR v.ref_id = $2) ORDER BY v.created_at DESC LIMIT 300`, [req.query.status ?? null, req.query.ref_id ?? null]));
  });

  r.get('/reservations/:id', requirePermission('inventory.read'), async (req, res) => {
    res.json(await reservationDetail(pool, String(req.params.id)));
  });

  r.post('/reservations', requirePermission('inventory.reserve'), async (req, res) => {
    const b = parse(reservationBody, req.body);
    res.status(201).json(await tx(pool, (c) => reserve(c, req, b)));
  });

  r.post('/reservations/:id/release', requirePermission('inventory.reserve'), async (req, res) => {
    const { reason } = parse(z.object({ reason: reqText(300) }), req.body);
    const out = await tx(pool, async (c) => {
      const o = await releaseReservation(c, String(req.params.id), 'released', reason, actorOf(req));
      await auditReq(c, req, 'reservation', String(req.params.id), 'released', { reason });
      return o;
    });
    res.json(out);
  });

  /**
   * Pick by scanning. Only rolls on this reservation can be picked, and a roll can be picked once:
   * a second scan is refused, so nothing is deducted twice.
   */
  r.post('/reservations/:id/pick', requirePermission('inventory.reserve', 'inventory.move'), async (req, res) => {
    const { barcode } = parse(z.object({ barcode: reqText(40) }), req.body);
    const out = await tx(pool, async (c) => {
      const rv = await one<{ id: string; number: string; status: string; customer_name: string | null; ref_type: string; ref_id: string | null; ref_no: string | null }>(c, 'SELECT * FROM reservations WHERE id = $1 FOR UPDATE', [req.params.id]);
      if (!rv) throw notFound('Reservation');
      if (rv.status !== 'active') throw conflict(`This reservation is ${rv.status}`);
      const roll = await lockRoll(c, barcode);
      assertWarehouse(req, (await one<{ warehouse_id: string }>(c, 'SELECT warehouse_id FROM reservations WHERE id = $1', [rv.id]))!.warehouse_id);
      if (roll.state === 'dispatched' && (await one(c, `SELECT 1 FROM stock_movements WHERE roll_id = $1 AND ref_id = $2 AND movement_type = 'pick'`, [roll.id, rv.id])))
        throw conflict(`${roll.barcode} was already picked`);
      if (roll.reservation_id !== rv.id || roll.state !== 'reserved') throw conflict(`${roll.barcode} is not on reservation ${rv.number}`);
      await moveRoll(c, roll, 'pick', { state: 'dispatched', warehouse_id: null, location: null }, { ref: { type: 'reservation', id: rv.id, no: rv.number }, actor: actorOf(req), set: { holder_ref: rv.customer_name ?? rv.number } });
      const left = await one<{ n: number }>(c, `SELECT count(*)::int AS n FROM rolls WHERE reservation_id = $1 AND state = 'reserved'`, [rv.id]);
      if (left!.n === 0) {
        await c.query(`UPDATE reservations SET status = 'picked', closed_at = now() WHERE id = $1`, [rv.id]);
        await publish(c, S, 'inventory.reservation.picked', { reservation_id: rv.id, number: rv.number, ref_type: rv.ref_type, ref_id: rv.ref_id, ref_no: rv.ref_no });
      }
      return { barcode: roll.barcode, kg: roll.weight_kg, remaining_rolls: left!.n };
    });
    res.json(out);
  });
}
