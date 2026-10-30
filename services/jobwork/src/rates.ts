import type { Router } from 'express';
import { z } from 'zod';
import { type Client, type Pool, type ServiceContext, badRequest, many, notFound, one, optText, parse, reqText, requirePermission, tx } from '@erp/platform';
import { auditReq, getParty, getProduct, listMills, round2 } from './common.ts';

export interface RateCard { id: string; mill_id: string; process_code: string; product_id: string | null; category_id: string | null; basis: 'per_kg' | 'fixed' | 'slab'; rate: number | null; slabs: { upto_kg: number | null; rate: number }[] | null; min_charge: number; negotiated: boolean; effective_from: string; effective_to: string | null }

/** Most specific active rate card: product-specific, then category, then mill-wide for the process. */
export async function pickRateCard(c: Client | Pool, millId: string, processCode: string, productId: string, categoryId: string | null, onDate: string) {
  return one<RateCard>(c, `
    SELECT * FROM rate_cards
    WHERE mill_id = $1 AND process_code = $2 AND effective_from <= $5 AND (effective_to IS NULL OR effective_to >= $5)
      AND (product_id IS NULL OR product_id = $3) AND (category_id IS NULL OR category_id = $4)
    ORDER BY (product_id IS NOT NULL) DESC, (category_id IS NOT NULL) DESC, effective_from DESC LIMIT 1`, [millId, processCode, productId, categoryId, onDate]);
}

/** Processing charge for a quantity under a rate card (per-KG, fixed, or slab by quantity), never below the minimum charge. */
export function chargeFor(card: RateCard, kg: number) {
  let charge: number;
  if (card.basis === 'fixed') charge = Number(card.rate);
  else if (card.basis === 'per_kg') charge = kg * Number(card.rate);
  else {
    const slabs = [...(card.slabs ?? [])].sort((a, b) => (a.upto_kg ?? Infinity) - (b.upto_kg ?? Infinity));
    const slab = slabs.find((s) => s.upto_kg === null || kg <= s.upto_kg) ?? slabs[slabs.length - 1]!;
    charge = kg * slab.rate;
  }
  return round2(Math.max(charge, Number(card.min_charge)));
}

export function describeCard(c: RateCard) {
  if (c.basis === 'fixed') return `₹${c.rate} fixed`;
  if (c.basis === 'per_kg') return `₹${c.rate}/kg`;
  const slabs = [...(c.slabs ?? [])].sort((a, b) => (a.upto_kg ?? Infinity) - (b.upto_kg ?? Infinity));
  return `slab ${slabs.map((s, i) => (s.upto_kg === null ? `>${slabs[i - 1]?.upto_kg ?? 0} kg ₹${s.rate}` : `≤${s.upto_kg} kg ₹${s.rate}`)).join(', ')}`;
}

const cardBody = z.object({
  mill_id: z.uuid(),
  process_code: z.string(),
  product_id: z.uuid().nullable().optional(),
  category_id: z.uuid().nullable().optional(),
  basis: z.enum(['per_kg', 'fixed', 'slab']),
  rate: z.number().min(0).nullable().optional(),
  slabs: z.array(z.object({ upto_kg: z.number().positive().nullable(), rate: z.number().min(0) })).nullable().optional(),
  min_charge: z.number().min(0).default(0),
  negotiated: z.boolean().default(false),
  effective_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  notes: optText(500),
});

const templateBody = z.object({
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9_]{2,24}$/, 'A–Z, 0–9 and _'),
  name: reqText(80),
  description: optText(300),
  stages: z.array(z.object({ code: z.string().trim().toUpperCase().regex(/^[A-Z0-9_]{2,24}$/), name: reqText(60) })).min(1, 'Add at least one stage'),
  status: z.enum(['active', 'inactive']).default('active'),
});

export function rateRoutes(r: Router, { pool }: ServiceContext) {
  r.get('/process-templates', requirePermission('jobwork.read', 'portal.mill.access'), async (_req, res) => {
    res.json(await many(pool, 'SELECT * FROM process_templates ORDER BY name'));
  });
  r.post('/process-templates', requirePermission('jobwork.rate.manage'), async (req, res) => {
    const b = parse(templateBody, req.body);
    res.status(201).json(await tx(pool, async (c) => {
      const t = await one<{ id: string }>(c, 'INSERT INTO process_templates (code, name, description, stages, status, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *', [b.code, b.name, b.description ?? null, JSON.stringify(b.stages), b.status, req.user!.id]);
      await auditReq(c, req, 'process_template', t!.id, 'created', { after: b });
      return t;
    }));
  });
  r.patch('/process-templates/:id', requirePermission('jobwork.rate.manage'), async (req, res) => {
    const b = parse(templateBody, req.body);
    res.json(await tx(pool, async (c) => {
      const before = await one(c, 'SELECT * FROM process_templates WHERE id = $1 FOR UPDATE', [req.params.id]);
      if (!before) throw notFound('Process template');
      const after = await one(c, 'UPDATE process_templates SET name = $2, description = $3, stages = $4, status = $5, version = version + 1, updated_at = now() WHERE id = $1 RETURNING *', [req.params.id, b.name, b.description ?? null, JSON.stringify(b.stages), b.status]);
      await auditReq(c, req, 'process_template', String(req.params.id), 'updated', { before, after });
      return after;
    }));
  });

  r.get('/rate-cards', requirePermission('jobwork.read'), async (req, res) => {
    const params: unknown[] = [];
    const where: string[] = [];
    if (req.query.millId) { params.push(req.query.millId); where.push(`mill_id = $${params.length}`); }
    if (req.query.current === '1') where.push(`effective_from <= current_date AND (effective_to IS NULL OR effective_to >= current_date)`);
    res.json(await many(pool, `SELECT * FROM rate_cards ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY mill_name, process_code, product_label NULLS FIRST, effective_from DESC`, params));
  });

  /** A new rate supersedes the current card for the same scope from its effective date; history is kept. */
  r.post('/rate-cards', requirePermission('jobwork.rate.manage'), async (req, res) => {
    const b = parse(cardBody, req.body);
    if (b.basis === 'slab' && !b.slabs?.length) throw badRequest('Add at least one slab', { fields: { slabs: 'Required' } });
    if (b.basis !== 'slab' && b.rate == null) throw badRequest('Enter the rate', { fields: { rate: 'Required' } });
    const mill = await getParty(b.mill_id).catch(() => null);
    if (!mill || mill.party_type !== 'mill') throw badRequest('Choose a mill');
    const product = b.product_id ? await getProduct(b.product_id) : null;
    res.status(201).json(await tx(pool, async (c) => {
      const proc = await one(c, 'SELECT 1 FROM process_templates WHERE code = $1', [b.process_code]);
      if (!proc) throw badRequest('Unknown process');
      await c.query(`
        UPDATE rate_cards SET effective_to = $5::date - 1
        WHERE mill_id = $1 AND process_code = $2 AND product_id IS NOT DISTINCT FROM $3 AND category_id IS NOT DISTINCT FROM $4
          AND effective_from < $5 AND (effective_to IS NULL OR effective_to >= $5)`,
        [b.mill_id, b.process_code, b.product_id ?? null, b.category_id ?? null, b.effective_from]);
      const card = await one<{ id: string }>(c, `
        INSERT INTO rate_cards (mill_id, mill_name, process_code, product_id, product_label, category_id, category_label, basis, rate, slabs, min_charge, negotiated, effective_from, notes, created_by_name)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
        [b.mill_id, mill.legal_name, b.process_code, b.product_id ?? null, product ? `${product.sku}` : null, b.category_id ?? null, null, b.basis, b.rate ?? null,
          b.slabs ? JSON.stringify(b.slabs) : null, b.min_charge, b.negotiated, b.effective_from, b.notes ?? null, req.user!.name]);
      await auditReq(c, req, 'rate_card', card!.id, 'created', { after: b });
      return card;
    }));
  });

  r.get('/rate-quote', requirePermission('jobwork.read'), async (req, res) => {
    const { millId, processCode, productId, kg } = req.query as Record<string, string>;
    const product = await getProduct(productId);
    const card = await pickRateCard(pool, millId, processCode, productId, product.category_id, new Date().toISOString().slice(0, 10));
    res.json(card ? { card, description: describeCard(card), charge: chargeFor(card, Number(kg)) } : { card: null, charge: null });
  });

  // ---------- mill master view: capability, rates, performance ----------
  r.get('/mills', requirePermission('jobwork.read'), async (_req, res) => {
    const mills = await listMills();
    const perf = await millPerformance(pool);
    const grey = await many<{ mill_id: string; kg: number }>(pool, 'SELECT mill_id, round(sum(kg_in - kg_allocated), 1) AS kg FROM mill_stock GROUP BY mill_id');
    res.json(mills.map((m) => ({ ...m, ...(perf.find((p) => p.mill_id === m.id) ?? emptyPerf), grey_available_kg: grey.find((g) => g.mill_id === m.id)?.kg ?? 0 })));
  });

  r.get('/mills/:id', requirePermission('jobwork.read'), async (req, res) => {
    const mill = await getParty(String(req.params.id));
    const [perf] = await millPerformance(pool, String(req.params.id));
    const [cards, orders, claims, stock] = await Promise.all([
      many(pool, 'SELECT * FROM rate_cards WHERE mill_id = $1 ORDER BY process_code, product_label NULLS FIRST, effective_from DESC', [req.params.id]),
      many(pool, 'SELECT id, number, process_name, status, issue_date, expected_return_date, kg_sent, kg_good FROM job_orders WHERE mill_id = $1 ORDER BY created_at DESC LIMIT 15', [req.params.id]),
      many(pool, 'SELECT id, number, status, kg_affected, amount, created_at FROM quality_claims WHERE mill_id = $1 ORDER BY created_at DESC LIMIT 15', [req.params.id]),
      many(pool, 'SELECT *, kg_in - kg_allocated AS kg_available FROM mill_stock WHERE mill_id = $1 AND kg_in - kg_allocated > 0.001 ORDER BY received_date', [req.params.id]),
    ]);
    res.json({ mill, performance: perf ?? { ...emptyPerf, mill_id: req.params.id }, rate_cards: cards, recent_orders: orders, claims, grey_stock: stock });
  });
}

const emptyPerf = { orders: 0, open_orders: 0, kg_at_mill: 0, avg_tat_days: null, on_time_pct: null, avg_yield_pct: null, open_claims: 0, grey_available_kg: 0 };

export async function millPerformance(pool: Pool, millId?: string) {
  return many<{ mill_id: string; orders: number; open_orders: number; kg_at_mill: number; avg_tat_days: number | null; on_time_pct: number | null; avg_yield_pct: number | null; open_claims: number; grey_available_kg: number }>(pool, `
    WITH o AS (
      SELECT j.*, (SELECT max(r.return_date) FROM job_returns r WHERE r.job_order_id = j.id) AS last_return FROM job_orders j
      WHERE j.status NOT IN ('draft','cancelled') ${millId ? 'AND j.mill_id = $1' : ''}
    )
    SELECT o.mill_id, count(*)::int AS orders,
      count(*) FILTER (WHERE o.status IN ('issued','acknowledged','in_process','ready','partially_returned'))::int AS open_orders,
      round(coalesce(sum(o.kg_sent - o.kg_good - o.kg_rejected - o.kg_damaged - o.kg_process_loss) FILTER (WHERE o.status NOT IN ('closed','returned')), 0), 1) AS kg_at_mill,
      round(avg(o.last_return - o.issue_date) FILTER (WHERE o.status IN ('returned','closed')), 1) AS avg_tat_days,
      round(100.0 * count(*) FILTER (WHERE o.status IN ('returned','closed') AND o.last_return <= o.expected_return_date) / nullif(count(*) FILTER (WHERE o.status IN ('returned','closed')), 0))::int AS on_time_pct,
      round(100.0 * sum(o.kg_good) FILTER (WHERE o.status IN ('returned','closed')) / nullif(sum(o.kg_sent) FILTER (WHERE o.status IN ('returned','closed')), 0), 1) AS avg_yield_pct,
      (SELECT count(*)::int FROM quality_claims q WHERE q.mill_id = o.mill_id AND q.status IN ('open','under_review')) AS open_claims,
      (SELECT round(coalesce(sum(kg_in - kg_allocated), 0), 1) FROM mill_stock s WHERE s.mill_id = o.mill_id) AS grey_available_kg
    FROM o GROUP BY o.mill_id`, millId ? [millId] : []);
}
