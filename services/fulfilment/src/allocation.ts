import type { Request, Router } from 'express';
import { z } from 'zod';
import { type BusEvent, type Client, type Pool, type ServiceContext, badRequest, callService, conflict, many, notFound, notify, one, optText, parse, publish, reqText, requirePermission, tx } from '@erp/platform';
import { S, type Warehouse, auditReq, distanceBand, getParty, getWarehouses, localNumber, requestApproval, round2, round3, setting } from './common.ts';

export interface PlanLine { order_line_id: string; product_id: string; sku: string; product_name: string; lot_id: string | null; kg: number; price_per_kg: number; gst_rate: number; hsn_code: string | null }
interface LotAvail { lot_id: string; warehouse_id: string; product_id: string; lot_no: string; grade: string | null; shade: string | null; received_date: string; available_kg: number }
export interface Pick { order_line_id: string; lot_id: string; kg: number }
export interface Option {
  warehouse_id: string; code: string; name: string; city: string; state_code: string; priority_rank: number; can_fulfil: boolean; covered_kg: number; total_kg: number;
  shortages: { sku: string; short_kg: number; note: string }[]; quality_pct: number | null; same_state: boolean; distance_band: number; freight_estimate: number; eta_days: number; workload: number; score: number; picks: Pick[];
}
export interface Recommendation { strategy: string; rule: string; recommended_warehouse_id: string | null; options: Option[]; split_suggestion: { warehouse_id: string; code: string; lines: { order_line_id: string; sku: string; kg: number }[] }[] | null; at: string }

/** Lots in one warehouse for a line: the chosen lot, else one lot that covers it, else one shade group; never mixes shades. */
function chooseLots(lots: LotAvail[], l: PlanLine) {
  const mine = lots.filter((x) => x.product_id === l.product_id);
  if (l.lot_id) {
    const lot = mine.find((x) => x.lot_id === l.lot_id);
    const have = lot?.available_kg ?? 0;
    return have >= l.kg - 0.001 ? { ok: true, covered: l.kg, picks: [{ order_line_id: l.order_line_id, lot_id: l.lot_id, kg: l.kg }], note: '' } : { ok: false, covered: have, picks: [], note: `lot has ${round3(have)} kg here` };
  }
  const single = mine.find((x) => x.available_kg >= l.kg - 0.001);
  if (single) return { ok: true, covered: l.kg, picks: [{ order_line_id: l.order_line_id, lot_id: single.lot_id, kg: l.kg }], note: '' };
  const groups = new Map<string, LotAvail[]>();
  for (const x of mine) groups.set(x.shade ?? x.lot_id, [...(groups.get(x.shade ?? x.lot_id) ?? []), x]);
  for (const g of groups.values()) {
    if (g.reduce((s, x) => s + x.available_kg, 0) < l.kg - 0.001) continue;
    let need = l.kg;
    const picks: Pick[] = [];
    for (const x of g) { if (need <= 0.0005) break; const take = round3(Math.min(need, x.available_kg)); picks.push({ order_line_id: l.order_line_id, lot_id: x.lot_id, kg: take }); need = round3(need - take); }
    return { ok: true, covered: l.kg, picks, note: '' };
  }
  const total = mine.reduce((s, x) => s + x.available_kg, 0);
  return { ok: false, covered: Math.max(0, ...[...groups.values()].map((g) => g.reduce((s, x) => s + x.available_kg, 0))), picks: [], note: total >= l.kg ? 'enough only by mixing shades' : `${round3(total)} kg in stock here` };
}

/**
 * Scores every warehouse for an order. Default strategy: Surat-first — the highest-priority warehouse that can
 * fulfil every line wins; distance (freight, ETA, intra-state GST), quality and workload break ties and are shown
 * for comparison. Never splits by itself: if no single warehouse can fulfil, it suggests a split for approval.
 */
export async function recommend(c: Pool | Client, lines: PlanLine[], customerState: string | null, orderId: string | null = null): Promise<Recommendation> {
  const [whs, strategy, defaults] = await Promise.all([getWarehouses(), setting('fulfilment.default_warehouse_strategy', 'priority_then_distance'), setting<number[]>('fulfilment.default_freight_per_kg', [1.5, 3, 5])]);
  const lots = await callService<LotAvail[]>(S, 'inventory', 'GET', `/lot-availability?product_ids=${[...new Set(lines.map((l) => l.product_id))].join(',')}`);
  // Stock this order already holds counts as available to it when re-deciding.
  if (orderId) {
    const own = await many<{ warehouse_id: string; lot_id: string; product_id: string; kg: number }>(c, `SELECT f.warehouse_id, l.lot_id, l.product_id, sum(l.kg_planned)::float AS kg FROM fulfilment_lines l JOIN fulfilments f ON f.id = l.fulfilment_id WHERE f.order_id = $1 AND f.status IN ('reserved','released') AND l.lot_id IS NOT NULL GROUP BY 1, 2, 3`, [orderId]);
    for (const o of own) {
      const hit = lots.find((x) => x.lot_id === o.lot_id && x.warehouse_id === o.warehouse_id);
      if (hit) hit.available_kg = round3(hit.available_kg + o.kg);
      else lots.push({ lot_id: o.lot_id, warehouse_id: o.warehouse_id, product_id: o.product_id, lot_no: '', grade: null, shade: null, received_date: '', available_kg: o.kg });
    }
  }
  const load = await many<{ warehouse_id: string; n: number }>(c, `SELECT warehouse_id, count(*)::int AS n FROM fulfilments WHERE status IN ('reserved','released','picking','picked','packed','invoiced') GROUP BY warehouse_id`);
  const rates = await many<{ from_state: string; to_state: string; rate_per_kg: number; min_charge: number; eta_days: number }>(c, `SELECT * FROM freight_rates WHERE status = 'active'`);
  const totalKg = round3(lines.reduce((s, l) => s + l.kg, 0));
  const n = whs.length;
  const options: Option[] = whs.map((w: Warehouse, rank) => {
    const here = lots.filter((x) => x.warehouse_id === w.id);
    const res = lines.map((l) => ({ l, ...chooseLots(here, l) }));
    const picks = res.flatMap((r) => r.picks);
    const pickedLots = picks.map((p) => ({ p, lot: here.find((x) => x.lot_id === p.lot_id) }));
    const aKg = pickedLots.filter((x) => x.lot?.grade === 'A').reduce((s, x) => s + x.p.kg, 0);
    const pkg = picks.reduce((s, p) => s + p.kg, 0);
    const band = distanceBand(w.state_code, customerState);
    const rate = rates.filter((r) => r.from_state === w.state_code && r.to_state === customerState).sort((a, b) => a.rate_per_kg - b.rate_per_kg)[0];
    const freight = rate ? Math.max(Number(rate.min_charge), Number(rate.rate_per_kg) * totalKg) : (defaults[band] ?? 5) * totalKg;
    const eta = rate ? rate.eta_days : [2, 4, 6][band]!;
    const workload = load.find((x) => x.warehouse_id === w.id)?.n ?? 0;
    const can = res.every((r) => r.ok);
    const quality = pkg ? Math.round((aKg / pkg) * 100) : null;
    const prio = (n - rank) * 100;
    const near = (2 - band) * (strategy === 'nearest_first' ? 120 : strategy === 'priority_only' ? 0 : 30);
    const score = (can ? 1000 : 0) + (strategy === 'nearest_first' ? prio / 10 : prio) + near + (quality ?? 0) / 5 - workload * 2;
    return {
      warehouse_id: w.id, code: w.code, name: w.name, city: w.city, state_code: w.state_code, priority_rank: rank + 1, can_fulfil: can,
      covered_kg: round3(res.reduce((s, r) => s + Math.min(r.covered, r.l.kg), 0)), total_kg: totalKg,
      shortages: res.filter((r) => !r.ok).map((r) => ({ sku: r.l.sku, short_kg: round3(r.l.kg - Math.min(r.covered, r.l.kg)), note: r.note })),
      quality_pct: quality, same_state: band === 0, distance_band: band, freight_estimate: round2(freight), eta_days: eta, workload, score: Math.round(score), picks,
    };
  });
  const best = options.filter((o) => o.can_fulfil).sort((a, b) => b.score - a.score)[0];
  const first = options[0];
  let rule: string;
  if (!best) rule = 'No single warehouse can fulfil every line. A split across warehouses needs management approval.';
  else if (best.warehouse_id === first?.warehouse_id) rule = `${best.code} is first in the dispatch priority and can fulfil the whole order.`;
  else rule = `${options.slice(0, best.priority_rank - 1).map((o) => o.code).join(', ')} cannot fulfil it all${first?.shortages[0] ? ` (${first.shortages[0].sku} short ${first.shortages[0].short_kg} kg)` : ''}; ${best.code} is the next by ${strategy === 'nearest_first' ? 'distance' : 'priority'}.`;
  // Suggested split (greedy by priority) shown to the decision-maker; never applied automatically.
  let split: Recommendation['split_suggestion'] = null;
  if (!best) {
    const remaining = new Map(lines.map((l) => [l.order_line_id, l.kg]));
    split = [];
    for (const o of options) {
      const here = lots.filter((x) => x.warehouse_id === o.warehouse_id);
      const take: { order_line_id: string; sku: string; kg: number }[] = [];
      for (const l of lines) {
        const need = remaining.get(l.order_line_id)!;
        if (need <= 0.0005) continue;
        const r = chooseLots(here, { ...l, kg: need });
        const kg = r.ok ? need : Math.min(need, r.covered);
        if (kg > 0.0005) { take.push({ order_line_id: l.order_line_id, sku: l.sku, kg: round3(kg) }); remaining.set(l.order_line_id, round3(need - kg)); }
      }
      if (take.length) split.push({ warehouse_id: o.warehouse_id, code: o.code, lines: take });
    }
    if ([...remaining.values()].some((v) => v > 0.0005)) split = null;
  }
  return { strategy, rule, recommended_warehouse_id: best?.warehouse_id ?? null, options, split_suggestion: split, at: new Date().toISOString() };
}

interface Plan { order_id: string; order_no: string; customer_id: string; customer_name: string; customer_state_code: string | null; status: string; lines: PlanLine[]; hold_until: string | null; booked: boolean; recommendation: Recommendation | null; recommended_warehouse_id: string | null; selected: unknown }

/** Reserves stock in one warehouse for the picks and opens its fulfilment record. */
async function reserveIn(c: Client, plan: Plan, w: Warehouse, picks: Pick[], holdUntil: string | null, existing?: { reservation_id: string }) {
  let rv: { id: string; number: string };
  if (existing) {
    const r = await callService<{ id: string; number: string }>(S, 'inventory', 'GET', `/reservations/${existing.reservation_id}`);
    rv = { id: r.id, number: r.number };
  } else {
    const byLine = new Map(plan.lines.map((l) => [l.order_line_id, l]));
    const lots = picks.map((p) => ({ lot_id: p.lot_id, kg: p.kg }));
    const chosenByCustomer = picks.some((p) => byLine.get(p.order_line_id)?.lot_id);
    rv = await callService<{ id: string; number: string }>(S, 'inventory', 'POST', '/reservations', {
      warehouse_id: w.id, ref_type: 'sales_order', ref_id: plan.order_id, ref_no: plan.order_no, customer_id: plan.customer_id, lines: lots,
      mixed_shade_reason: chosenByCustomer ? 'Lots chosen by the customer on the order' : null,
    });
  }
  if (holdUntil) await callService(S, 'inventory', 'POST', `/reservations/${rv.id}/extend`, { until: holdUntil, reason: `Order ${plan.order_no}` }).catch(() => null);
  const cust = await getParty(plan.customer_id).catch(() => null);
  const number = await localNumber(c, 'fulfilment', 'FUL-');
  const f = await one<{ id: string }>(c, `
    INSERT INTO fulfilments (number, order_id, order_no, customer_id, customer_name, customer_state_code, customer_gstin, warehouse_id, warehouse_code, warehouse_name, warehouse_state_code, gst_registration_id, gstin, reservation_id, reservation_no, status)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING id`,
    [number, plan.order_id, plan.order_no, plan.customer_id, plan.customer_name, plan.customer_state_code, cust?.gstin ?? null, w.id, w.code, `${w.code} · ${w.name}`, w.state_code, w.gst_registration_id, w.gstin, rv.id, rv.number, plan.booked ? 'released' : 'reserved']);
  const byLine = new Map(plan.lines.map((l) => [l.order_line_id, l]));
  for (const p of picks) {
    const l = byLine.get(p.order_line_id)!;
    await c.query(`INSERT INTO fulfilment_lines (fulfilment_id, order_line_id, product_id, sku, product_name, hsn_code, gst_rate, lot_id, kg_planned, price_per_kg) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [f!.id, p.order_line_id, l.product_id, l.sku, l.product_name, l.hsn_code, l.gst_rate, p.lot_id, p.kg, l.price_per_kg]);
  }
  return { id: f!.id, number, warehouse_id: w.id, warehouse: w.code, reservation_id: rv.id, reservation_no: rv.number };
}

async function releaseFulfilments(c: Client, orderId: string, reason: string) {
  const fs = await many<{ id: string; status: string; reservation_id: string | null }>(c, `SELECT * FROM fulfilments WHERE order_id = $1 AND status NOT IN ('cancelled','dispatched','delivered') FOR UPDATE`, [orderId]);
  for (const f of fs) {
    if (['invoiced'].includes(f.status)) throw conflict('An invoice is already issued for this order; cancel through a credit note');
    if (f.reservation_id) await callService(S, 'inventory', 'POST', `/reservations/${f.reservation_id}/release`, { reason }).catch((e) => { if (!String((e as Error).message).includes('already')) throw e; });
    await c.query(`UPDATE fulfilments SET status = 'cancelled', cancelled_reason = $2, updated_at = now() WHERE id = $1`, [f.id, reason]);
  }
  return fs.length;
}

/** Picks for a warehouse limited to given kg per line (split allocations). */
async function picksFor(c: Pool | Client, plan: Plan, warehouseId: string, kgs: Map<string, number>) {
  const sub = plan.lines.filter((l) => (kgs.get(l.order_line_id) ?? 0) > 0).map((l) => ({ ...l, kg: kgs.get(l.order_line_id)! }));
  const rec = await recommend(c, sub, plan.customer_state_code);
  const o = rec.options.find((x) => x.warehouse_id === warehouseId)!;
  if (!o.can_fulfil) throw conflict(`${o.code} cannot supply its share: ${o.shortages.map((s) => `${s.sku} short ${s.short_kg} kg`).join(', ')}`);
  return o.picks;
}

export async function planSummary(c: Pool | Client, orderId: string) {
  const plan = await one<Plan & Record<string, unknown>>(c, 'SELECT * FROM plans WHERE order_id = $1', [orderId]);
  if (!plan) throw notFound('Plan');
  const fulfilments = await many(c, `SELECT f.*, s.number AS shipment_no, s.status AS shipment_status, s.tracking_token, s.transporter_name, s.lr_number, s.eta_date, s.pod_condition, s.delivered_at AS shipment_delivered_at
    FROM fulfilments f LEFT JOIN shipments s ON s.fulfilment_id = f.id WHERE f.order_id = $1 ORDER BY f.created_at`, [orderId]);
  return { ...plan, fulfilments };
}

const planBody = z.object({
  order_id: z.uuid(), order_no: z.string(), customer_id: z.uuid(), customer_name: z.string(), customer_state_code: z.string().nullable().optional(), hold_until: z.string().nullable().optional(),
  existing_reservation: z.object({ reservation_id: z.uuid(), warehouse_id: z.uuid() }).nullable().optional(),
  lines: z.array(z.object({ order_line_id: z.uuid(), product_id: z.uuid(), sku: z.string(), product_name: z.string(), lot_id: z.uuid().nullable(), kg: z.number().positive(), price_per_kg: z.number().positive(), gst_rate: z.number(), hsn_code: z.string().nullable() })).min(1),
});

export function allocationRoutes(r: Router, { pool }: ServiceContext) {
  /** Called by commerce when an order is placed: recommend, and reserve if one warehouse can fulfil everything. */
  r.post('/plans', requirePermission('fulfilment.allocate'), async (req, res) => {
    const b = parse(planBody, req.body);
    const out = await tx(pool, async (c) => {
      if (await one(c, 'SELECT 1 FROM plans WHERE order_id = $1', [b.order_id])) throw conflict('This order already has a plan');
      await c.query(`INSERT INTO plans (order_id, order_no, customer_id, customer_name, customer_state_code, status, lines, hold_until) VALUES ($1,$2,$3,$4,$5,'needs_decision',$6,$7)`,
        [b.order_id, b.order_no, b.customer_id, b.customer_name, b.customer_state_code ?? null, JSON.stringify(b.lines), b.hold_until ?? null]);
      const plan = (await one<Plan>(c, 'SELECT * FROM plans WHERE order_id = $1', [b.order_id]))!;
      const whs = await getWarehouses();
      if (b.existing_reservation) {
        const w = whs.find((x) => x.id === b.existing_reservation!.warehouse_id)!;
        const picks = b.lines.map((l) => ({ order_line_id: l.order_line_id, lot_id: l.lot_id!, kg: l.kg }));
        const f = await reserveIn(c, plan, w, picks, b.hold_until ?? null, b.existing_reservation);
        await c.query(`UPDATE plans SET status = 'reserved', decision_mode = 'existing', recommended_warehouse_id = $2, selected = $3, decision_reason = 'Stock reserved when the quotation was accepted', decided_by_name = 'system', decided_at = now() WHERE order_id = $1`, [b.order_id, w.id, JSON.stringify([{ warehouse_id: w.id, code: w.code }])]);
        return { status: 'reserved', fulfilments: [f] };
      }
      const rec = await recommend(c, b.lines, b.customer_state_code ?? null);
      await c.query('UPDATE plans SET recommendation = $2, recommended_warehouse_id = $3 WHERE order_id = $1', [b.order_id, JSON.stringify(rec), rec.recommended_warehouse_id]);
      if (rec.recommended_warehouse_id) {
        const opt = rec.options.find((o) => o.warehouse_id === rec.recommended_warehouse_id)!;
        try {
          const f = await reserveIn(c, plan, whs.find((w) => w.id === opt.warehouse_id)!, opt.picks, b.hold_until ?? null);
          await c.query(`UPDATE plans SET status = 'reserved', decision_mode = 'auto', selected = $2, decision_reason = $3, decided_by_name = 'allocation engine', decided_at = now() WHERE order_id = $1`, [b.order_id, JSON.stringify([{ warehouse_id: opt.warehouse_id, code: opt.code }]), rec.rule]);
          return { status: 'reserved', recommended: opt.code, rule: rec.rule, fulfilments: [f] };
        } catch (e) {
          // Someone else took the stock between the check and the reservation: leave it to a person.
          await c.query(`UPDATE plans SET decision_reason = $2 WHERE order_id = $1`, [b.order_id, `Automatic reservation failed: ${(e as Error).message}`]);
        }
      }
      await notify(c, S, { audience_permission: 'fulfilment.allocate', kind: 'action', title: `Choose the warehouse for ${b.order_no} · ${b.customer_name}`, body: rec.rule, link: `/fulfilment/orders/${b.order_id}` });
      return { status: 'needs_decision', message: 'No single warehouse can supply the whole order right now. Our team will confirm the warehouse; you will then be asked to pay.', rule: rec.rule };
    });
    res.status(201).json(out);
  });

  r.get('/plans', requirePermission('fulfilment.read'), async (req, res) => {
    res.json(await many(pool, `
      SELECT p.order_id, p.order_no, p.customer_name, p.status, p.decision_mode, p.approval_status, p.booked, p.created_at, p.decision_reason,
        (SELECT sum((l->>'kg')::numeric) FROM jsonb_array_elements(p.lines) l)::float AS kg,
        (SELECT string_agg(f.warehouse_code, ', ') FROM fulfilments f WHERE f.order_id = p.order_id AND f.status <> 'cancelled') AS warehouses
      FROM plans p WHERE ($1::text IS NULL OR p.status = ANY(string_to_array($1, ','))) ORDER BY p.created_at DESC LIMIT 300`, [req.query.status ?? null]));
  });

  r.get('/plans/:orderId', requirePermission('fulfilment.read'), async (req, res) => {
    res.json(await planSummary(pool, String(req.params.orderId)));
  });

  r.post('/plans/:orderId/recommend', requirePermission('fulfilment.read'), async (req, res) => {
    const plan = await one<Plan>(pool, 'SELECT * FROM plans WHERE order_id = $1', [req.params.orderId]);
    if (!plan) throw notFound('Plan');
    const rec = await recommend(pool, plan.lines, plan.customer_state_code, plan.order_id);
    if (plan.status !== 'reserved') await pool.query('UPDATE plans SET recommendation = $2, recommended_warehouse_id = $3, updated_at = now() WHERE order_id = $1', [plan.order_id, JSON.stringify(rec), rec.recommended_warehouse_id]);
    res.json(rec);
  });

  /**
   * Choose one warehouse. Choosing anything but the recommendation is an override: a reason is mandatory and the
   * recommended and chosen options are both kept. A reserved order can be moved while nothing is picked yet.
   */
  r.post('/plans/:orderId/decide', requirePermission('fulfilment.allocate'), async (req, res) => {
    const b = parse(z.object({ warehouse_id: z.uuid(), reason: optText(500) }), req.body);
    const out = await tx(pool, async (c) => {
      const plan = await one<Plan>(c, 'SELECT * FROM plans WHERE order_id = $1 FOR UPDATE', [req.params.orderId]);
      if (!plan) throw notFound('Plan');
      if (['cancelled', 'pending_split_approval'].includes(plan.status)) throw conflict(`This plan is ${plan.status.replace(/_/g, ' ')}`);
      if (await one(c, `SELECT 1 FROM fulfilments WHERE order_id = $1 AND status IN ('picking','picked','packed','invoiced','dispatched','delivered')`, [plan.order_id])) throw conflict('Picking has started; the warehouse can no longer be changed');
      const rec = await recommend(c, plan.lines, plan.customer_state_code, plan.order_id);
      const opt = rec.options.find((o) => o.warehouse_id === b.warehouse_id);
      if (!opt) throw badRequest('Unknown warehouse');
      if (!opt.can_fulfil) throw conflict(`${opt.code} cannot fulfil the whole order (${opt.shortages.map((s) => `${s.sku} short ${s.short_kg} kg`).join(', ')}). Use a split.`);
      const override = rec.recommended_warehouse_id !== b.warehouse_id;
      if (override && !b.reason) throw badRequest(`${rec.options.find((o) => o.warehouse_id === rec.recommended_warehouse_id)?.code ?? 'Another warehouse'} is recommended. Give a reason to override.`, { fields: { reason: 'Required for an override' } });
      const wasReserved = plan.status === 'reserved';
      await releaseFulfilments(c, plan.order_id, override ? `Moved to ${opt.code}: ${b.reason}` : 'Re-allocated');
      const w = (await getWarehouses()).find((x) => x.id === opt.warehouse_id)!;
      const f = await reserveIn(c, plan, w, opt.picks, plan.hold_until);
      await c.query(`UPDATE plans SET status = 'reserved', recommendation = $2, recommended_warehouse_id = $3, decision_mode = $4, selected = $5, decision_reason = $6, decided_by_name = $7, decided_at = now(), updated_at = now() WHERE order_id = $1`,
        [plan.order_id, JSON.stringify(rec), rec.recommended_warehouse_id, override ? 'override' : 'auto', JSON.stringify([{ warehouse_id: w.id, code: w.code }]), b.reason ?? rec.rule, req.user!.name]);
      await auditReq(c, req, 'allocation', plan.order_id, override ? 'overridden' : 'confirmed', { before: { recommended: rec.options.find((o) => o.warehouse_id === rec.recommended_warehouse_id)?.code ?? null }, after: { selected: w.code }, reason: b.reason });
      if (!wasReserved) await publish(c, S, 'fulfilment.plan.reserved', { order_id: plan.order_id });
      return { status: 'reserved', fulfilment: f, override };
    });
    res.json(out);
  });

  /** Split across warehouses: shows as separate fulfilments, and needs management approval before anything is reserved. */
  r.post('/plans/:orderId/split', requirePermission('fulfilment.allocate'), async (req, res) => {
    const b = parse(z.object({ reason: reqText(500), allocations: z.array(z.object({ warehouse_id: z.uuid(), lines: z.array(z.object({ order_line_id: z.uuid(), kg: z.number().positive() })).min(1) })).min(2) }), req.body);
    const needsApproval = await setting('fulfilment.split_requires_approval', true);
    const out = await tx(pool, async (c) => {
      const plan = await one<Plan>(c, 'SELECT * FROM plans WHERE order_id = $1 FOR UPDATE', [req.params.orderId]);
      if (!plan) throw notFound('Plan');
      if (plan.status !== 'needs_decision') throw conflict(plan.status === 'reserved' ? 'This order is already reserved in one warehouse' : `This plan is ${plan.status.replace(/_/g, ' ')}`);
      for (const l of plan.lines) {
        const sum = b.allocations.reduce((s, a) => s + (a.lines.find((x) => x.order_line_id === l.order_line_id)?.kg ?? 0), 0);
        if (Math.abs(sum - l.kg) > 0.001) throw badRequest(`${l.sku}: the split covers ${round3(sum)} kg of ${l.kg} kg ordered`);
      }
      const whs = await getWarehouses();
      for (const a of b.allocations) await picksFor(c, plan, a.warehouse_id, new Map(a.lines.map((x) => [x.order_line_id, x.kg])));
      const selected = b.allocations.map((a) => ({ warehouse_id: a.warehouse_id, code: whs.find((w) => w.id === a.warehouse_id)?.code, lines: a.lines.map((x) => ({ ...x, sku: plan.lines.find((l) => l.order_line_id === x.order_line_id)?.sku })) }));
      await c.query(`UPDATE plans SET status = $2, decision_mode = 'split', selected = $3, decision_reason = $4, decided_by_name = $5, decided_at = now(), approval_status = $6, updated_at = now() WHERE order_id = $1`,
        [plan.order_id, needsApproval ? 'pending_split_approval' : 'needs_decision', JSON.stringify(selected), b.reason, req.user!.name, needsApproval ? 'pending' : 'approved']);
      await auditReq(c, req, 'allocation', plan.order_id, 'split_requested', { after: selected, reason: b.reason });
      if (needsApproval) {
        await requestApproval(c, req, {
          type: 'split_fulfilment', refId: plan.order_id, permission: 'fulfilment.split.approve',
          title: `Split ${plan.order_no} · ${plan.customer_name} across ${selected.map((s) => s.code).join(' + ')}`,
          summary: `${b.reason}. ${selected.map((s) => `${s.code}: ${s.lines.map((x) => `${x.sku} ${x.kg} kg`).join(', ')}`).join(' | ')}`,
          payload: { order: plan.order_no, warehouses: selected.map((s) => s.code), lines: selected.flatMap((s) => s.lines.map((x) => ({ warehouse: s.code, sku: x.sku, kg: x.kg }))) },
        });
        return { status: 'pending_split_approval' };
      }
      await executeSplit(c, plan.order_id);
      return { status: 'reserved' };
    });
    res.json(out);
  });

  r.post('/plans/:orderId/cancel', requirePermission('fulfilment.allocate', 'commerce.order.manage'), async (req, res) => {
    const { reason } = parse(z.object({ reason: reqText(300) }), req.body);
    const out = await tx(pool, async (c) => {
      const plan = await one<Plan>(c, 'SELECT * FROM plans WHERE order_id = $1 FOR UPDATE', [req.params.orderId]);
      if (!plan) throw notFound('Plan');
      const n = await releaseFulfilments(c, plan.order_id, reason);
      await c.query(`UPDATE plans SET status = 'cancelled', updated_at = now() WHERE order_id = $1`, [plan.order_id]);
      await auditReq(c, req, 'allocation', plan.order_id, 'cancelled', { reason });
      return { released: n };
    });
    res.json(out);
  });

  r.post('/plans/:orderId/extend', requirePermission('fulfilment.allocate'), async (req, res) => {
    const { until } = parse(z.object({ until: z.iso.datetime({ offset: true }) }), req.body);
    await extendPlan(pool, String(req.params.orderId), until);
    res.json({ ok: true });
  });
}

async function extendPlan(c: Pool | Client, orderId: string, until: string) {
  await c.query('UPDATE plans SET hold_until = $2, updated_at = now() WHERE order_id = $1', [orderId, until]);
  const fs = await many<{ reservation_id: string | null }>(c, `SELECT reservation_id FROM fulfilments WHERE order_id = $1 AND status IN ('reserved','released','picking','picked','packed','invoiced')`, [orderId]);
  for (const f of fs) if (f.reservation_id) await callService(S, 'inventory', 'POST', `/reservations/${f.reservation_id}/extend`, { until, reason: 'Order booking' }).catch(() => null);
}

async function executeSplit(c: Client, orderId: string) {
  const plan = (await one<Plan & { selected: { warehouse_id: string; lines: { order_line_id: string; kg: number }[] }[] }>(c, 'SELECT * FROM plans WHERE order_id = $1 FOR UPDATE', [orderId]))!;
  const whs = await getWarehouses();
  for (const a of plan.selected) {
    const picks = await picksFor(c, plan, a.warehouse_id, new Map(a.lines.map((x) => [x.order_line_id, x.kg])));
    await reserveIn(c, plan, whs.find((w) => w.id === a.warehouse_id)!, picks, plan.hold_until);
  }
  await c.query(`UPDATE plans SET status = 'reserved', updated_at = now() WHERE order_id = $1`, [orderId]);
  await publish(c, S, 'fulfilment.plan.reserved', { order_id: orderId });
}

export async function applySplitDecision(c: Client, p: { ref_id: string; decision: string; decided_by_name: string; comment: string | null }) {
  const plan = await one<Plan>(c, 'SELECT * FROM plans WHERE order_id = $1 FOR UPDATE', [p.ref_id]);
  if (!plan || plan.status !== 'pending_split_approval') return;
  await c.query(`UPDATE plans SET approval_status = $2, approved_by_name = $3, approved_at = now(), approval_comment = $4 WHERE order_id = $1`, [plan.order_id, p.decision === 'approved' ? 'approved' : 'rejected', p.decided_by_name, p.comment]);
  if (p.decision === 'approved') {
    try { await c.query('SAVEPOINT split'); await executeSplit(c, plan.order_id); await c.query('RELEASE SAVEPOINT split'); } catch (e) {
      await c.query('ROLLBACK TO SAVEPOINT split');
      await c.query(`UPDATE plans SET status = 'needs_decision', decision_reason = $2 WHERE order_id = $1`, [plan.order_id, `Approved split could not be reserved: ${(e as Error).message}`]);
      await notify(c, S, { audience_permission: 'fulfilment.allocate', kind: 'warning', title: `Split for ${plan.order_no} could not be reserved — stock moved`, body: (e as Error).message, link: `/fulfilment/orders/${plan.order_id}` });
    }
  } else await c.query(`UPDATE plans SET status = 'needs_decision' WHERE order_id = $1`, [plan.order_id]);
}

// ---------- events from commerce ----------
export function orderBookedConsumer() {
  return async (ev: BusEvent, c: Client) => {
    const p = ev.payload as { order_id: string; reserve_until: string | null; payment_terms: 'advance' | 'credit' };
    const plan = await one<Plan>(c, 'SELECT * FROM plans WHERE order_id = $1 FOR UPDATE', [p.order_id]);
    if (!plan) return;
    await c.query('UPDATE plans SET booked = true WHERE order_id = $1', [p.order_id]);
    await c.query(`UPDATE fulfilments SET status = CASE WHEN status = 'reserved' THEN 'released' ELSE status END, payment_terms = $2, updated_at = now() WHERE order_id = $1 AND status <> 'cancelled'`, [p.order_id, p.payment_terms]);
    if (p.reserve_until) await extendPlan(c, p.order_id, p.reserve_until);
  };
}
export function orderExtendedConsumer() {
  return async (ev: BusEvent, c: Client) => { const p = ev.payload as { order_id: string; reserve_until: string }; await extendPlan(c, p.order_id, p.reserve_until); };
}
export function orderCancelledConsumer() {
  return async (ev: BusEvent, c: Client) => {
    const p = ev.payload as { order_id: string; reason: string };
    const plan = await one<Plan>(c, 'SELECT * FROM plans WHERE order_id = $1 FOR UPDATE', [p.order_id]);
    if (!plan || plan.status === 'cancelled') return;
    await releaseFulfilments(c, p.order_id, p.reason ?? 'Order cancelled');
    await c.query(`UPDATE plans SET status = 'cancelled' WHERE order_id = $1`, [p.order_id]);
  };
}

export type { Request };
