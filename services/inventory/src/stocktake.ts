import type { Router } from 'express';
import { z } from 'zod';
import { type Client, type Pool, type ServiceContext, badRequest, conflict, many, notFound, one, optText, parse, publish, reqText, requirePermission, tx } from '@erp/platform';
import { assertWarehouse, auditReq, getLocations, getWarehouse, nextNumber, requestApproval, round3, setting, whLabel } from './common.ts';
import { type Actor, type Roll, PHYSICAL, adjustWeight, moveRoll } from './ledger.ts';
import { actorOf } from './inward.ts';

interface Variance {
  missing: { roll_id: string; barcode: string; sku: string; expected_kg: number; location_path: string | null }[];
  found: { roll_id: string; barcode: string; sku: string; kg: number; was: string; location_path: string | null }[];
  unknown: { barcode: string }[];
  weight: { roll_id: string; barcode: string; sku: string; expected_kg: number; counted_kg: number; diff: number }[];
  relocated: { roll_id: string; barcode: string; from: string | null; to: string | null; location_id: string | null }[];
  totals: { expected_rolls: number; counted_rolls: number; missing_kg: number; found_kg: number; weight_diff_kg: number };
}

/** Compares what was counted with what the system expected when the count started. */
export async function computeVariance(c: Pool | Client, id: string): Promise<Variance> {
  const st = await one<{ warehouse_id: string; product_ids: string[] }>(c, 'SELECT warehouse_id, product_ids FROM stocktakes WHERE id = $1', [id]);
  const tol = Number(await setting('inventory.stocktake_weight_tolerance_kg', 0.5));
  const expected = await many<{ roll_id: string; barcode: string; sku: string; expected_kg: number; location_path: string | null; state: string; warehouse_id: string | null }>(c, `
    SELECT e.roll_id, r.barcode, l.sku, e.expected_kg::float, e.location_path, r.state, r.warehouse_id
    FROM stocktake_expected e JOIN rolls r ON r.id = e.roll_id JOIN lots l ON l.id = r.lot_id WHERE e.stocktake_id = $1`, [id]);
  const counts = await many<{ barcode: string; roll_id: string | null; counted_kg: number | null; location_id: string | null; location_path: string | null; sku: string | null; state: string | null; weight_kg: number | null; cur_path: string | null; warehouse_id: string | null }>(c, `
    SELECT k.barcode, k.roll_id, k.counted_kg::float, k.location_id, k.location_path, l.sku, r.state, r.weight_kg::float, r.location_path AS cur_path, r.warehouse_id, r.product_id
    FROM stocktake_counts k LEFT JOIN rolls r ON r.id = k.roll_id LEFT JOIN lots l ON l.id = r.lot_id WHERE k.stocktake_id = $1`, [id]);
  const counted = new Map(counts.filter((k) => k.roll_id).map((k) => [k.roll_id!, k]));
  const exp = new Set(expected.map((e) => e.roll_id));
  const v: Variance = { missing: [], found: [], unknown: [], weight: [], relocated: [], totals: { expected_rolls: expected.length, counted_rolls: counts.length, missing_kg: 0, found_kg: 0, weight_diff_kg: 0 } };
  for (const e of expected) {
    const k = counted.get(e.roll_id);
    // A roll that legitimately left during the count (picked, transferred) is not missing.
    if (!k) { if (PHYSICAL.includes(e.state as never) && e.warehouse_id === st!.warehouse_id) v.missing.push({ roll_id: e.roll_id, barcode: e.barcode, sku: e.sku, expected_kg: e.expected_kg, location_path: e.location_path }); continue; }
    if (k.counted_kg !== null && Math.abs(k.counted_kg - Number(k.weight_kg)) > tol) v.weight.push({ roll_id: e.roll_id, barcode: e.barcode, sku: e.sku, expected_kg: Number(k.weight_kg), counted_kg: k.counted_kg, diff: round3(k.counted_kg - Number(k.weight_kg)) });
    if (k.location_id && k.location_path !== k.cur_path) v.relocated.push({ roll_id: e.roll_id, barcode: e.barcode, from: k.cur_path, to: k.location_path, location_id: k.location_id });
  }
  for (const k of counts) {
    if (!k.roll_id) { v.unknown.push({ barcode: k.barcode }); continue; }
    if (exp.has(k.roll_id)) continue;
    // A count limited to some fabrics ignores other fabrics scanned by mistake.
    if (st!.product_ids?.length && !st!.product_ids.includes((k as { product_id?: string }).product_id ?? '')) continue;
    v.found.push({ roll_id: k.roll_id, barcode: k.barcode, sku: k.sku ?? '?', kg: k.counted_kg ?? Number(k.weight_kg), was: k.warehouse_id === st!.warehouse_id ? k.state ?? '?' : `${k.state} elsewhere`, location_path: k.location_path });
  }
  v.totals.missing_kg = round3(v.missing.reduce((s, x) => s + x.expected_kg, 0));
  v.totals.found_kg = round3(v.found.reduce((s, x) => s + x.kg, 0));
  v.totals.weight_diff_kg = round3(v.weight.reduce((s, x) => s + x.diff, 0));
  return v;
}

const hasVariance = (v: Variance) => v.missing.length + v.found.length + v.weight.length + v.relocated.length > 0;

/** Posts an approved count to the stock ledger. Every adjustment carries the stocktake reference and reason. */
async function postAdjustments(c: Client, st: { id: string; number: string; warehouse_id: string; reason: string | null }, actor: Actor) {
  const v = await computeVariance(c, st.id);
  const ref = { type: 'stocktake', id: st.id, no: st.number };
  const reason = `Stocktake ${st.number}${st.reason ? `: ${st.reason}` : ''}`;
  const lock = async (id: string) => (await one<Roll>(c, 'SELECT * FROM rolls WHERE id = $1 FOR UPDATE', [id]))!;
  for (const m of v.missing) {
    const r = await lock(m.roll_id);
    if (r.warehouse_id !== st.warehouse_id || !PHYSICAL.includes(r.state)) continue;
    if (r.reservation_id) await c.query('UPDATE rolls SET reservation_id = NULL WHERE id = $1', [r.id]);
    await moveRoll(c, r, 'adjust_out', { state: 'written_off', warehouse_id: null, location: null }, { ref, reason, actor });
  }
  const locs = await getLocations(st.warehouse_id).catch(() => []);
  for (const f of v.found) {
    const r = await lock(f.roll_id);
    const k = await one<{ location_id: string | null }>(c, 'SELECT location_id FROM stocktake_counts WHERE stocktake_id = $1 AND roll_id = $2', [st.id, r.id]);
    const loc = locs.find((l) => l.id === k?.location_id);
    const to = { warehouse_id: st.warehouse_id, location: loc ? { id: loc.id, path: loc.path } : null };
    if (PHYSICAL.includes(r.state) && r.warehouse_id !== st.warehouse_id) await moveRoll(c, r, 'move', to, { ref, reason: `${reason} (found in another warehouse)`, actor });
    else if (!PHYSICAL.includes(r.state)) await moveRoll(c, r, 'adjust_in', { ...to, state: 'available' }, { ref, reason, actor, set: { transfer_id: null, reservation_id: null, holder_ref: null } });
  }
  for (const w of v.weight) await adjustWeight(c, await lock(w.roll_id), w.counted_kg, 'weight_adjust', { ref, reason, actor });
  for (const m of v.relocated) {
    const loc = locs.find((l) => l.id === m.location_id);
    if (loc) await moveRoll(c, await lock(m.roll_id), 'move', { location: { id: loc.id, path: loc.path } }, { ref, reason: `${reason} (found in ${loc.path})`, actor });
  }
  return v;
}

export async function applyStocktakeDecision(c: Client, p: { ref_id: string; decision: string; decided_by: string; decided_by_name: string; comment: string | null }) {
  const st = await one<{ id: string; number: string; warehouse_id: string; status: string; reason: string | null }>(c, 'SELECT * FROM stocktakes WHERE id = $1 FOR UPDATE', [p.ref_id]);
  if (!st || st.status !== 'submitted') return;
  if (p.decision === 'approved') {
    const v = await postAdjustments(c, st, { id: p.decided_by, name: p.decided_by_name });
    const val = await varianceValue(c, v);
    // Accounts shows the loss (or gain) on its own line instead of hiding it in the cost of goods sold.
    if (Math.abs(val.net) >= 1) await publish(c, 'inventory', 'inventory.stocktake.posted', { stocktake_id: st.id, number: st.number, warehouse_id: st.warehouse_id, value_diff: val.net, date: new Date().toISOString().slice(0, 10), approved_by: p.decided_by_name });
  }
  await c.query(`UPDATE stocktakes SET status = $2, decided_by_name = $3, decided_at = now(), decision_comment = $4 WHERE id = $1`, [st.id, p.decision === 'approved' ? 'approved' : 'rejected', p.decided_by_name, p.comment]);
}

export function stocktakeRoutes(r: Router, { pool }: ServiceContext) {
  r.get('/stocktakes', requirePermission('inventory.read'), async (_req, res) => {
    res.json(await many(pool, `
      SELECT s.*, (SELECT count(*)::int FROM stocktake_expected WHERE stocktake_id = s.id) AS expected_rolls,
        (SELECT count(*)::int FROM stocktake_counts WHERE stocktake_id = s.id) AS counted_rolls
      FROM stocktakes s ORDER BY s.started_at DESC LIMIT 200`));
  });

  r.get('/stocktakes/:id', requirePermission('inventory.read'), async (req, res) => {
    const st = await one<{ id: string; status: string; variance_summary: unknown }>(pool, 'SELECT * FROM stocktakes WHERE id = $1', [req.params.id]);
    if (!st) throw notFound('Stocktake');
    const counts = await many(pool, `SELECT k.*, l.sku, l.lot_no FROM stocktake_counts k LEFT JOIN rolls r ON r.id = k.roll_id LEFT JOIN lots l ON l.id = r.lot_id WHERE k.stocktake_id = $1 ORDER BY k.counted_at DESC`, [st.id]);
    // After posting the ledger has moved on, so show the variance frozen at submission.
    const variance = ['approved', 'rejected', 'cancelled'].includes(st.status) && st.variance_summary ? st.variance_summary : await computeVariance(pool, st.id);
    const reasons = await many(pool, 'SELECT * FROM stocktake_reasons WHERE stocktake_id = $1', [st.id]);
    // While a blind count is open, counters see only what they scanned; supervisors (approvers) see the comparison.
    const hide = (st as { blind?: boolean }).blind && st.status === 'counting' && !req.user!.permissions.includes('inventory.stocktake.approve') && !req.user!.permissions.includes('*');
    res.json({ ...st, counts: hide ? (counts as Record<string, unknown>[]).map((k) => ({ ...k, sku: undefined, lot_no: undefined })) : counts, variance: hide ? null : variance, reasons, values: hide ? null : await varianceValue(pool, variance as Variance), hidden: !!hide });
  });

  /** Start a count: freezes the list of rolls the system expects in the warehouse (or one area of it). */
  r.post('/stocktakes', requirePermission('inventory.stocktake.count'), async (req, res) => {
    const b = parse(z.object({ warehouse_id: z.uuid(), location_prefix: optText(40), blind: z.boolean().default(false) }), req.body);
    const w = await getWarehouse(b.warehouse_id);
    assertWarehouse(req, w.id);
    const out = await tx(pool, async (c) => {
      const o = await startCount(c, w, { location_prefix: b.location_prefix ?? null, blind: b.blind, by: req.user!.name });
      await auditReq(c, req, 'stocktake', o.id, 'started', { after: { number: o.number, warehouse: w.code, area: b.location_prefix, expected_rolls: o.expected_rolls, blind: b.blind } });
      return o;
    });
    res.status(201).json(out);
  });

  r.post('/stocktakes/:id/count', requirePermission('inventory.stocktake.count'), async (req, res) => {
    const b = parse(z.object({ barcode: reqText(40), weight_kg: z.number().positive().nullable().optional(), location_id: z.uuid().nullable().optional() }), req.body);
    const out = await tx(pool, async (c) => {
      const st = await one<{ id: string; status: string; warehouse_id: string; blind: boolean }>(c, 'SELECT * FROM stocktakes WHERE id = $1 FOR UPDATE', [req.params.id]);
      if (!st) throw notFound('Stocktake');
      assertWarehouse(req, st.warehouse_id);
      if (st.status !== 'counting') throw conflict('This count is closed');
      if (st.blind && !b.weight_kg) throw badRequest('Weigh the roll: this is a blind count', { fields: { weight_kg: 'Required' } });
      const code = b.barcode.trim().toUpperCase();
      const roll = await one<{ id: string; weight_kg: number; state: string; warehouse_id: string | null }>(c, 'SELECT id, weight_kg, state, warehouse_id FROM rolls WHERE barcode = $1', [code]);
      const loc = b.location_id ? (await getLocations(st.warehouse_id)).find((l) => l.id === b.location_id) : null;
      if (b.location_id && !loc) throw badRequest('That location is not in this warehouse');
      const dup = await one(c, 'SELECT 1 FROM stocktake_counts WHERE stocktake_id = $1 AND barcode = $2', [st.id, code]);
      await c.query(`
        INSERT INTO stocktake_counts (stocktake_id, barcode, roll_id, counted_kg, location_id, location_path, counted_by_name) VALUES ($1,$2,$3,$4,$5,$6,$7)
        ON CONFLICT (stocktake_id, barcode) DO UPDATE SET counted_kg = EXCLUDED.counted_kg, location_id = EXCLUDED.location_id, location_path = EXCLUDED.location_path, counted_by_name = EXCLUDED.counted_by_name, counted_at = now()`,
        [st.id, code, roll?.id ?? null, b.weight_kg ?? null, loc?.id ?? null, loc?.path ?? null, req.user!.name]);
      const expected = roll ? await one(c, 'SELECT 1 FROM stocktake_expected WHERE stocktake_id = $1 AND roll_id = $2', [st.id, roll.id]) : null;
      // In a blind count the counter is not shown what the system expects.
      return st.blind ? { barcode: code, known: !!roll, recounted: !!dup, blind: true } : { barcode: code, known: !!roll, expected: !!expected, recounted: !!dup, system_kg: roll ? Number(roll.weight_kg) : null };
    });
    res.json(out);
  });

  r.post('/stocktakes/:id/uncount', requirePermission('inventory.stocktake.count'), async (req, res) => {
    const { barcode } = parse(z.object({ barcode: reqText(40) }), req.body);
    const r1 = await pool.query(`DELETE FROM stocktake_counts k USING stocktakes s WHERE s.id = k.stocktake_id AND s.status = 'counting' AND k.stocktake_id = $1 AND k.barcode = upper($2)`, [req.params.id, barcode]);
    if (!r1.rowCount) throw notFound('Count');
    res.json({ ok: true });
  });

  r.put('/stocktakes/:id/reasons', requirePermission('inventory.stocktake.count'), async (req, res) => {
    const b = parse(z.object({ reasons: z.array(z.object({ barcode: reqText(40), reason_code: z.enum(['not_found', 'damaged_unrecorded', 'dispatch_not_recorded', 'wrong_label', 'weight_moisture', 'mislocated', 'found_unrecorded', 'other']), note: optText(300) })).max(500) }), req.body);
    await tx(pool, async (c) => {
      const st = await one<{ status: string }>(c, 'SELECT status FROM stocktakes WHERE id = $1 FOR UPDATE', [req.params.id]);
      if (!st) throw notFound('Stocktake');
      if (!['counting', 'submitted'].includes(st.status)) throw conflict('This count is closed');
      for (const x of b.reasons) {
        if (x.reason_code === 'other' && !x.note) throw badRequest(`Say what happened to ${x.barcode}`);
        await c.query(`INSERT INTO stocktake_reasons (stocktake_id, barcode, reason_code, note, by_name) VALUES ($1, upper($2), $3, $4, $5) ON CONFLICT (stocktake_id, barcode) DO UPDATE SET reason_code = EXCLUDED.reason_code, note = EXCLUDED.note, by_name = EXCLUDED.by_name, at = now()`, [req.params.id, x.barcode, x.reason_code, x.note ?? null, req.user!.name]);
      }
    });
    res.json({ ok: true });
  });

  /** Submit the count. A clean count closes at once; any variance needs a checker before the ledger is adjusted. */
  r.post('/stocktakes/:id/submit', requirePermission('inventory.stocktake.count'), async (req, res) => {
    const { reason } = parse(z.object({ reason: optText(500) }), req.body);
    const out = await tx(pool, async (c) => {
      const st = await one<{ id: string; number: string; status: string; warehouse_name: string; warehouse_id: string }>(c, 'SELECT * FROM stocktakes WHERE id = $1 FOR UPDATE', [req.params.id]);
      if (!st) throw notFound('Stocktake');
      if (st.status !== 'counting') throw conflict('This count is already submitted');
      const v = await computeVariance(c, st.id);
      const variance = hasVariance(v);
      if (variance && !reason) throw badRequest('Explain the variance for the approver', { fields: { reason: 'Required' } });
      // Every missing, found or re-weighed roll needs a reason code.
      const given = new Set((await many<{ barcode: string }>(c, 'SELECT barcode FROM stocktake_reasons WHERE stocktake_id = $1', [st.id])).map((x) => x.barcode));
      const need = [...v.missing, ...v.found, ...v.weight].map((x) => x.barcode).filter((x) => !given.has(x));
      if (need.length) throw badRequest(`Give a reason for ${need.length} difference${need.length === 1 ? '' : 's'} (${need.slice(0, 5).join(', ')}${need.length > 5 ? '…' : ''})`, { fields: { reasons: 'Required for every difference' } });
      const val = await varianceValue(c, v);
      const ownerLimit = Number(await setting('inventory.stocktake_owner_limit', 25000));
      const needsOwner = Math.abs(val.net) >= ownerLimit || val.gross >= ownerLimit * 2;
      await c.query('UPDATE stocktakes SET value_diff = $2, needs_owner = $3 WHERE id = $1', [st.id, val.net, needsOwner]);
      await c.query(`UPDATE stocktakes SET status = $2, reason = $3, submitted_by = $4, submitted_by_name = $5, submitted_at = now(), variance_summary = $6,
        decided_by_name = CASE WHEN $2 = 'approved' THEN 'system (no variance)' END, decided_at = CASE WHEN $2 = 'approved' THEN now() END WHERE id = $1`,
        [st.id, variance ? 'submitted' : 'approved', reason ?? null, req.user!.id, req.user!.name, JSON.stringify(v)]);
      if (variance)
        await requestApproval(c, req, {
          type: 'stock_adjustment', refId: st.id, permission: needsOwner ? 'inventory.stocktake.approve_large' : 'inventory.stocktake.approve',
          title: `Stock adjustment ${st.number} · ${st.warehouse_name} · ₹${Math.abs(val.net).toLocaleString('en-IN')} ${val.net < 0 ? 'short' : 'over'}${needsOwner ? ' (owner approval)' : ''}`,
          summary: `${v.missing.length} missing (${v.totals.missing_kg} kg), ${v.found.length} found (${v.totals.found_kg} kg), ${v.weight.length} weight differences (${v.totals.weight_diff_kg} kg), ${v.relocated.length} in another bin. ${reason}`,
          payload: { totals: v.totals, missing: v.missing.slice(0, 20).map((x) => x.barcode), found: v.found.slice(0, 20).map((x) => x.barcode) },
        });
      await auditReq(c, req, 'stocktake', st.id, 'submitted', { after: v.totals, reason });
      return { status: variance ? 'submitted' : 'approved', variance: v.totals };
    });
    res.json(out);
  });

  r.post('/stocktakes/:id/cancel', requirePermission('inventory.stocktake.count'), async (req, res) => {
    const { reason } = parse(z.object({ reason: reqText(300) }), req.body);
    await tx(pool, async (c) => {
      const r1 = await c.query(`UPDATE stocktakes SET status = 'cancelled', reason = $2 WHERE id = $1 AND status = 'counting'`, [req.params.id, reason]);
      if (!r1.rowCount) throw conflict('Only an open count can be cancelled');
      await auditReq(c, req, 'stocktake', String(req.params.id), 'cancelled', { reason });
    });
    res.json({ ok: true });
  });

  // Exposed for tests and the UI: how the variance would post.
  r.get('/stocktakes/:id/variance', requirePermission('inventory.read'), async (req, res) => {
    res.json(await computeVariance(pool, String(req.params.id)));
  });
}

/** Rupee value of a variance at each lot's cost: missing and lighter rolls are losses, found and heavier ones gains. */
export async function varianceValue(c: Pool | Client, v: Variance) {
  const ids = [...v.missing.map((x) => x.roll_id), ...v.found.map((x) => x.roll_id), ...v.weight.map((x) => x.roll_id)];
  const cost = new Map((await many<{ id: string; cost: number | null }>(c, 'SELECT r.id, coalesce(l.cost_per_kg, l.price_per_kg * 0.85)::float AS cost FROM rolls r JOIN lots l ON l.id = r.lot_id WHERE r.id = ANY($1)', [ids])).map((x) => [x.id, Number(x.cost ?? 0)]));
  const loss = v.missing.reduce((s, x) => s + x.expected_kg * (cost.get(x.roll_id) ?? 0), 0) + v.weight.filter((x) => x.diff < 0).reduce((s, x) => s - x.diff * (cost.get(x.roll_id) ?? 0), 0);
  const gain = v.found.reduce((s, x) => s + x.kg * (cost.get(x.roll_id) ?? 0), 0) + v.weight.filter((x) => x.diff > 0).reduce((s, x) => s + x.diff * (cost.get(x.roll_id) ?? 0), 0);
  const r2 = (n: number) => Math.round(n * 100) / 100;
  return { loss: r2(loss), gain: r2(gain), net: r2(gain - loss), gross: r2(gain + loss) };
}

/** Opens a count and freezes the rolls expected in it. Used by hand and by the count schedule. */
export async function startCount(c: Client, w: { id: string; code: string; name: string }, o: { location_prefix?: string | null; product_ids?: string[]; blind?: boolean; schedule_id?: string | null; due_date?: string | null; scope_label?: string | null; by: string }) {
  const open = await one(c, `SELECT 1 FROM stocktakes WHERE warehouse_id = $1 AND status IN ('counting','submitted') AND coalesce(location_prefix, '') = coalesce($2, '') AND product_ids = $3::uuid[]`, [w.id, o.location_prefix ?? null, o.product_ids ?? []]);
  if (open) throw conflict('A count is already open for this area');
  const number = await nextNumber(c, 'stocktake', 'ST-');
  const st = await one<{ id: string }>(c, `INSERT INTO stocktakes (number, warehouse_id, warehouse_name, location_prefix, started_by_name, blind, schedule_id, due_date, product_ids, scope_label) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
    [number, w.id, whLabel(w as never), o.location_prefix ?? null, o.by, !!o.blind, o.schedule_id ?? null, o.due_date ?? null, o.product_ids ?? [], o.scope_label ?? null]);
  const n = await c.query(`
    INSERT INTO stocktake_expected (stocktake_id, roll_id, expected_kg, location_path)
    SELECT $1, id, weight_kg, location_path FROM rolls WHERE warehouse_id = $2 AND state = ANY($3) AND ($4::text IS NULL OR location_path LIKE $4 || '%') AND (cardinality($5::uuid[]) = 0 OR product_id = ANY($5::uuid[]))`, [st!.id, w.id, PHYSICAL, o.location_prefix ?? null, o.product_ids ?? []]);
  return { id: st!.id, number, expected_rolls: n.rowCount ?? 0 };
}

export { actorOf };
