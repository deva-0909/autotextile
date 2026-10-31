import type { Router } from 'express';
import { z } from 'zod';
import { type ServiceContext, badRequest, conflict, many, notFound, one, parse, reqText, requirePermission, tx } from '@erp/platform';
import { assertWarehouse, auditReq, getLocations, getWarehouse, round3, setting } from './common.ts';
import { type Roll, adjustWeight, lockRoll, moveRoll } from './ledger.ts';
import { actorOf } from './inward.ts';

/**
 * Reservation steps used by order fulfilment (P7): extend the hold, scan rolls onto the order (reserved →
 * allocated, re-weighed), ship the allocated rolls, and take customer returns back in.
 */
export function dispatchRoutes(r: Router, { pool }: ServiceContext) {
  /** Available kg per lot and warehouse, for the fulfilment allocation engine. */
  r.get('/lot-availability', requirePermission('inventory.read'), async (req, res) => {
    const ids = String(req.query.product_ids ?? '').split(',').filter((x) => /^[0-9a-f-]{36}$/i.test(x));
    res.json(await many(pool, `
      SELECT r.lot_id, r.warehouse_id, l.product_id, l.lot_no, l.grade, coalesce(l.dye_lot, l.shade_code) AS shade, l.received_date, l.price_per_kg::float, l.cost_per_kg::float,
        round(sum(r.weight_kg), 3)::float AS available_kg, count(*)::int AS rolls
      FROM rolls r JOIN lots l ON l.id = r.lot_id
      WHERE r.state = 'available' AND ($1::uuid[] = '{}' OR l.product_id = ANY($1::uuid[]))
      GROUP BY r.lot_id, r.warehouse_id, l.id ORDER BY l.received_date, l.lot_no`, [ids]));
  });

  r.post('/reservations/:id/extend', requirePermission('inventory.reserve'), async (req, res) => {
    const { until, reason } = parse2(req.body);
    const out = await tx(pool, async (c) => {
      const rv = await one<{ id: string; status: string; expires_at: string; warehouse_id: string }>(c, 'SELECT * FROM reservations WHERE id = $1 FOR UPDATE', [req.params.id]);
      if (!rv) throw notFound('Reservation');
      assertWarehouse(req, rv.warehouse_id);
      if (rv.status !== 'active') throw conflict(`This reservation is ${rv.status}`);
      if (new Date(until) <= new Date()) throw badRequest('Choose a time in the future');
      await c.query('UPDATE reservations SET expires_at = $2 WHERE id = $1', [rv.id, until]);
      await auditReq(c, req, 'reservation', rv.id, 'extended', { before: { expires_at: rv.expires_at }, after: { expires_at: until }, reason });
      return { expires_at: until };
    });
    res.json(out);
  });

  /** Pick by scan for an order: the roll must be on this reservation; it moves to the staging area as allocated. */
  r.post('/reservations/:id/allocate-scan', requirePermission('inventory.move', 'inventory.reserve'), async (req, res) => {
    const b = parse(z.object({ barcode: reqText(40), weight_kg: z.number().positive().nullable().optional() }), req.body);
    const tol = Number(await setting('fulfilment.pick_weight_tolerance_kg', 0.5));
    const out = await tx(pool, async (c) => {
      const rv = await one<{ id: string; number: string; status: string; warehouse_id: string }>(c, 'SELECT * FROM reservations WHERE id = $1 FOR UPDATE', [req.params.id]);
      if (!rv) throw notFound('Reservation');
      assertWarehouse(req, rv.warehouse_id);
      if (rv.status !== 'active') throw conflict(`This reservation is ${rv.status}`);
      const roll = await lockRoll(c, b.barcode);
      if (roll.reservation_id !== rv.id) throw conflict(`${roll.barcode} is not on this order’s pick list`);
      if (roll.state === 'allocated') throw conflict(`${roll.barcode} is already picked`);
      if (roll.state !== 'reserved') throw conflict(`${roll.barcode} is ${roll.state.replace('_', ' ')}`);
      const stg = (await getLocations(rv.warehouse_id).catch(() => [])).find((l) => l.purpose === 'staging' && l.status === 'active');
      await moveRoll(c, roll, 'allocate', { state: 'allocated', ...(stg ? { location: { id: stg.id, path: stg.path } } : {}) }, { ref: { type: 'reservation', id: rv.id, no: rv.number }, actor: actorOf(req) });
      let diff = 0;
      if (b.weight_kg && Math.abs(b.weight_kg - roll.weight_kg) > tol) diff = await adjustWeight(c, roll, b.weight_kg, 'weight_adjust', { ref: { type: 'reservation', id: rv.id, no: rv.number }, reason: 'Re-weighed at picking', actor: actorOf(req) });
      const left = await one<{ n: number; kg: number }>(c, `SELECT count(*) FILTER (WHERE state = 'reserved')::int AS n, coalesce(sum(weight_kg) FILTER (WHERE state = 'allocated'), 0)::float AS kg FROM rolls WHERE reservation_id = $1`, [rv.id]);
      return { barcode: roll.barcode, kg: roll.weight_kg, weight_difference: diff, remaining_rolls: left!.n, picked_kg: round3(left!.kg) };
    });
    res.json(out);
  });

  r.post('/reservations/:id/unallocate', requirePermission('inventory.move', 'inventory.reserve'), async (req, res) => {
    const { barcode } = parse(z.object({ barcode: reqText(40) }), req.body);
    await tx(pool, async (c) => {
      const rv = await one<{ id: string; number: string; status: string; warehouse_id: string }>(c, 'SELECT * FROM reservations WHERE id = $1 FOR UPDATE', [req.params.id]);
      if (!rv || rv.status !== 'active') throw conflict('Reservation is not active');
      const roll = await lockRoll(c, barcode);
      if (roll.reservation_id !== rv.id || roll.state !== 'allocated') throw conflict(`${roll.barcode} is not picked on this order`);
      await moveRoll(c, roll, 'release', { state: 'reserved' }, { ref: { type: 'reservation', id: rv.id, no: rv.number }, reason: 'Un-picked', actor: actorOf(req) });
    });
    res.json({ ok: true });
  });

  /** Ship: allocated rolls leave the warehouse; anything reserved but not picked is released back to stock. */
  r.post('/reservations/:id/ship', requirePermission('inventory.move', 'inventory.reserve'), async (req, res) => {
    const b = parse(z.object({ ref_no: reqText(60), holder: z.string().max(160).nullable().optional() }), req.body);
    const out = await tx(pool, async (c) => {
      const rv = await one<{ id: string; number: string; status: string; warehouse_id: string; customer_name: string | null }>(c, 'SELECT * FROM reservations WHERE id = $1 FOR UPDATE', [req.params.id]);
      if (!rv) throw notFound('Reservation');
      assertWarehouse(req, rv.warehouse_id);
      if (rv.status !== 'active') throw conflict(`This reservation is ${rv.status}`);
      const picked = await many<Roll>(c, `SELECT * FROM rolls WHERE reservation_id = $1 AND state = 'allocated' FOR UPDATE`, [rv.id]);
      if (!picked.length) throw conflict('Nothing is picked yet');
      const ref = { type: 'reservation', id: rv.id, no: b.ref_no };
      for (const roll of picked) await moveRoll(c, roll, 'pick', { state: 'dispatched', warehouse_id: null, location: null }, { ref, actor: actorOf(req), set: { holder_ref: b.holder ?? rv.customer_name ?? b.ref_no } });
      const rest = await many<Roll>(c, `SELECT * FROM rolls WHERE reservation_id = $1 AND state = 'reserved' FOR UPDATE`, [rv.id]);
      for (const roll of rest) await moveRoll(c, roll, 'release', { state: 'available' }, { ref, reason: 'Not picked for dispatch', actor: actorOf(req), set: { reservation_id: null } });
      await c.query(`UPDATE reservations SET status = 'picked', closed_at = now() WHERE id = $1`, [rv.id]);
      const rolls = await many(c, `SELECT r.id, r.barcode, r.weight_kg::float, r.product_id, r.lot_id, l.lot_no, l.sku, l.product_name, r.grade, r.shade_code, r.dye_lot FROM rolls r JOIN lots l ON l.id = r.lot_id WHERE r.id = ANY($1) ORDER BY l.sku, r.barcode`, [picked.map((p) => p.id)]);
      return { rolls, released_rolls: rest.length };
    });
    res.json(out);
  });

  /** Customer return: dispatched rolls come back into a warehouse on QC hold for disposition. */
  r.post('/returns/receive', requirePermission('inventory.inward.record'), async (req, res) => {
    const b = parse(z.object({ warehouse_id: z.uuid(), barcodes: z.array(z.string().min(3)).min(1).max(300), ref_no: reqText(60), reason: z.string().max(300).nullable().optional() }), req.body);
    const w = await getWarehouse(b.warehouse_id);
    assertWarehouse(req, w.id);
    const out = await tx(pool, async (c) => {
      const rcv = (await getLocations(w.id).catch(() => [])).find((l) => l.purpose === 'returns' || l.purpose === 'receiving');
      const got = [];
      for (const code of b.barcodes) {
        const roll = await lockRoll(c, code);
        if (roll.state !== 'dispatched') throw conflict(`${roll.barcode} was not dispatched, so it cannot come back as a return`);
        await moveRoll(c, roll, 'return_in', { state: 'qc_hold', warehouse_id: w.id, location: rcv ? { id: rcv.id, path: rcv.path } : null }, { ref: { type: 'return', no: b.ref_no }, reason: b.reason ?? 'Customer return', actor: actorOf(req), set: { reservation_id: null, holder_ref: null } });
        got.push({ barcode: roll.barcode, kg: roll.weight_kg });
      }
      await auditReq(c, req, 'customer_return', b.ref_no, 'received', { after: { warehouse: w.code, rolls: got.length } });
      return { received: got };
    });
    res.json(out);
  });
}

function parse2(body: unknown) {
  return parse(z.object({ until: z.iso.datetime({ offset: true }), reason: z.string().max(300).nullable().optional() }), body);
}
