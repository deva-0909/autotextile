import type { Router } from 'express';
import { z } from 'zod';
import { type Client, type Pool, type ServiceContext, badRequest, many, notFound, notify, one, optText, parse, requirePermission, tx } from '@erp/platform';
import { auditReq, getWarehouse } from './common.ts';
import { startCount } from './stocktake.ts';

const FREQ = { weekly: 7, monthly: 30, quarterly: 91, yearly: 365 } as const;
const advance = (d: string, f: keyof typeof FREQ) => {
  const x = new Date(`${d}T00:00:00Z`);
  if (f === 'weekly') x.setUTCDate(x.getUTCDate() + 7); else x.setUTCMonth(x.getUTCMonth() + (f === 'monthly' ? 1 : f === 'quarterly' ? 3 : 12));
  return x.toISOString().slice(0, 10);
};
interface Schedule { id: string; name: string; warehouse_id: string; warehouse_name: string; scope: 'fast_moving' | 'high_value' | 'location' | 'full'; location_prefix: string | null; top_n: number; frequency: keyof typeof FREQ; next_due: string; blind: boolean; active: boolean }

/** The fabrics a scheduled count covers: the most dispatched in the last 30 days, or the highest stock value, in that warehouse. */
async function scopeProducts(c: Pool | Client, s: Schedule) {
  if (s.scope === 'fast_moving')
    return (await many<{ product_id: string }>(c, `SELECT product_id FROM stock_movements WHERE movement_type = 'pick' AND from_warehouse_id = $1 AND at > now() - interval '30 days' GROUP BY product_id ORDER BY sum(kg) DESC LIMIT $2`, [s.warehouse_id, s.top_n])).map((x) => x.product_id);
  if (s.scope === 'high_value')
    return (await many<{ product_id: string }>(c, `SELECT r.product_id FROM rolls r JOIN lots l ON l.id = r.lot_id WHERE r.warehouse_id = $1 AND r.state IN ('available','reserved','allocated') GROUP BY r.product_id ORDER BY sum(r.weight_kg * coalesce(l.cost_per_kg, l.price_per_kg, 0)) DESC LIMIT $2`, [s.warehouse_id, s.top_n])).map((x) => x.product_id);
  return [];
}

/** Opens the counts that are due and moves each schedule to its next date; the warehouse team is told. */
export async function runCountSchedules(pool: Pool) {
  const due = await many<Schedule>(pool, `SELECT *, next_due::text FROM count_schedules WHERE active AND next_due <= current_date`);
  let opened = 0;
  for (const s of due) {
    await tx(pool, async (c) => {
      const w = await getWarehouse(s.warehouse_id);
      const products = await scopeProducts(c, s);
      const label = s.scope === 'full' ? 'Full warehouse' : s.scope === 'location' ? `Area ${s.location_prefix}` : `${s.scope === 'fast_moving' ? 'Fast-moving' : 'High-value'} fabric (top ${s.top_n})`;
      try {
        const st = await startCount(c, w, { location_prefix: s.scope === 'location' ? s.location_prefix : null, product_ids: products, blind: s.blind, schedule_id: s.id, due_date: s.next_due, scope_label: `${s.name}: ${label}`, by: 'count schedule' });
        await c.query('UPDATE count_schedules SET last_stocktake_id = $2 WHERE id = $1', [s.id, st.id]);
        await notify(c, 'inventory', { audience_permission: 'inventory.stocktake.count', kind: 'action', title: `Stock count ${st.number} due: ${s.name}`, body: `${w.code} · ${label} · ${st.expected_rolls} rolls${s.blind ? ' · blind count' : ''}`, link: `/inventory/stocktakes/${st.id}` });
        opened++;
      } catch (e) { if (!/already open/.test((e as Error).message)) throw e; }
      await c.query('UPDATE count_schedules SET next_due = $2, updated_at = now() WHERE id = $1', [s.id, advance(s.next_due, s.frequency)]);
    });
  }
  return opened;
}

const body = z.object({
  name: z.string().trim().min(2).max(120), warehouse_id: z.uuid(), scope: z.enum(['fast_moving', 'high_value', 'location', 'full']), location_prefix: optText(40),
  top_n: z.number().int().min(1).max(50).default(5), frequency: z.enum(['weekly', 'monthly', 'quarterly', 'yearly']), next_due: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), blind: z.boolean().default(true), active: z.boolean().default(true),
});

export function scheduleRoutes(r: Router, { pool }: ServiceContext) {
  r.get('/count-schedules', requirePermission('inventory.read'), async (_req, res) => {
    res.json(await many(pool, `SELECT s.*, s.next_due::text, t.number AS last_number, t.status AS last_status FROM count_schedules s LEFT JOIN stocktakes t ON t.id = s.last_stocktake_id ORDER BY s.active DESC, s.next_due`));
  });
  r.post('/count-schedules', requirePermission('inventory.stocktake.approve'), async (req, res) => {
    const b = parse(body, req.body);
    if (b.scope === 'location' && !b.location_prefix) throw badRequest('Give the area (location prefix), e.g. A-01', { fields: { location_prefix: 'Required' } });
    const w = await getWarehouse(b.warehouse_id);
    const out = await tx(pool, async (c) => {
      const row = await one<{ id: string }>(c, `INSERT INTO count_schedules (name, warehouse_id, warehouse_name, scope, location_prefix, top_n, frequency, next_due, blind, active, created_by_name) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
        [b.name, w.id, `${w.code} · ${w.name}`, b.scope, b.location_prefix ?? null, b.top_n, b.frequency, b.next_due, b.blind, b.active, req.user!.name]);
      await auditReq(c, req, 'count_schedule', row!.id, 'created', { after: b });
      return row;
    });
    res.status(201).json(out);
  });
  r.put('/count-schedules/:id', requirePermission('inventory.stocktake.approve'), async (req, res) => {
    const b = parse(body, req.body);
    const w = await getWarehouse(b.warehouse_id);
    await tx(pool, async (c) => {
      const before = await one(c, 'SELECT * FROM count_schedules WHERE id = $1 FOR UPDATE', [req.params.id]);
      if (!before) throw notFound('Count schedule');
      await c.query(`UPDATE count_schedules SET name = $2, warehouse_id = $3, warehouse_name = $4, scope = $5, location_prefix = $6, top_n = $7, frequency = $8, next_due = $9, blind = $10, active = $11, updated_at = now() WHERE id = $1`,
        [req.params.id, b.name, w.id, `${w.code} · ${w.name}`, b.scope, b.location_prefix ?? null, b.top_n, b.frequency, b.next_due, b.blind, b.active]);
      await auditReq(c, req, 'count_schedule', String(req.params.id), 'updated', { before, after: b });
    });
    res.json({ ok: true });
  });
  /** Start the next count of a schedule now instead of waiting for its date. */
  r.post('/count-schedules/:id/run', requirePermission('inventory.stocktake.count'), async (req, res) => {
    await pool.query('UPDATE count_schedules SET next_due = least(next_due, current_date) WHERE id = $1', [req.params.id]);
    res.json({ opened: await runCountSchedules(pool) });
  });

  /** Shrinkage by warehouse and month from approved counts: kg and rupees lost or found. */
  r.get('/shrinkage', requirePermission('inventory.read'), async (req, res) => {
    const months = Math.min(24, Math.max(1, Number(req.query.months) || 12));
    res.json(await many(pool, `
      SELECT warehouse_name, to_char(date_trunc('month', decided_at), 'YYYY-MM') AS month, count(*)::int AS counts,
        coalesce(sum((variance_summary->'totals'->>'missing_kg')::numeric), 0)::float AS missing_kg,
        coalesce(sum((variance_summary->'totals'->>'found_kg')::numeric), 0)::float AS found_kg,
        coalesce(sum((variance_summary->'totals'->>'weight_diff_kg')::numeric), 0)::float AS weight_diff_kg,
        coalesce(sum(value_diff), 0)::float AS value_diff
      FROM stocktakes WHERE status = 'approved' AND decided_at > now() - make_interval(months => $1) GROUP BY 1, 2 ORDER BY 2 DESC, 1`, [months]));
  });
}
