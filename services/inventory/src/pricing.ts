import type { Router } from 'express';
import { z } from 'zod';
import { type Client, type ServiceContext, badRequest, conflict, many, notFound, one, optText, parse, publish, requirePermission, tx } from '@erp/platform';
import { S, auditReq, requestApproval, round2, setting } from './common.ts';

export const marginPct = (price: number, cost: number | null) => (cost && cost > 0 ? round2(((price - cost) / price) * 100) : null);

/** Makes a price the lot's current selling price and keeps the previous one in history. */
async function applyPrice(c: Client, tagId: string, decidedBy: string, comment: string | null) {
  const t = await one<{ id: string; lot_id: string; price_per_kg: number }>(c, `UPDATE price_tags SET status = 'approved', decided_by_name = $2, decided_at = now(), decision_comment = $3, effective_at = now() WHERE id = $1 RETURNING *`, [tagId, decidedBy, comment]);
  await c.query(`UPDATE price_tags SET status = 'superseded' WHERE lot_id = $1 AND status = 'approved' AND id <> $2`, [t!.lot_id, tagId]);
  const lot = await one<{ lot_no: string; product_id: string; sku: string }>(c, 'UPDATE lots SET price_per_kg = $2 WHERE id = $1 RETURNING lot_no, product_id, sku', [t!.lot_id, t!.price_per_kg]);
  await publish(c, S, 'inventory.price.changed', { lot_id: t!.lot_id, lot_no: lot!.lot_no, product_id: lot!.product_id, sku: lot!.sku, price_per_kg: Number(t!.price_per_kg) });
}

export async function applyPriceDecision(c: Client, p: { ref_id: string; decision: string; decided_by_name: string; comment: string | null }) {
  const t = await one<{ status: string }>(c, 'SELECT status FROM price_tags WHERE id = $1 FOR UPDATE', [p.ref_id]);
  if (!t || t.status !== 'pending') return;
  if (p.decision === 'approved') await applyPrice(c, p.ref_id, p.decided_by_name, p.comment);
  else await c.query(`UPDATE price_tags SET status = 'rejected', decided_by_name = $2, decided_at = now(), decision_comment = $3 WHERE id = $1`, [p.ref_id, p.decided_by_name, p.comment]);
}

export function pricingRoutes(r: Router, { pool }: ServiceContext) {
  /**
   * Tag a lot's selling price per kg. The first price is set directly; a change, or any price below the
   * minimum margin, goes to a checker. Every price stays in the lot's history.
   */
  r.post('/lots/:id/price', requirePermission('inventory.price.tag'), async (req, res) => {
    const b = parse(z.object({ price_per_kg: z.number().positive().max(100000), reason: optText(500) }), req.body);
    const needApproval = await setting('inventory.price_change_requires_approval', true);
    const minMargin = Number(await setting('sales.min_margin_percent', 8));
    const out = await tx(pool, async (c) => {
      const lot = await one<{ id: string; lot_no: string; sku: string; price_per_kg: number | null; cost_per_kg: number | null }>(c, 'SELECT * FROM lots WHERE id = $1 FOR UPDATE', [req.params.id]);
      if (!lot) throw notFound('Lot');
      if (await one(c, `SELECT 1 FROM price_tags WHERE lot_id = $1 AND status = 'pending'`, [lot.id])) throw conflict('A price change for this lot is already waiting for approval');
      const prev = lot.price_per_kg === null ? null : Number(lot.price_per_kg);
      if (prev !== null && Math.abs(prev - b.price_per_kg) < 0.005) throw badRequest('That is already the current price');
      const cost = lot.cost_per_kg === null ? null : Number(lot.cost_per_kg);
      const margin = marginPct(b.price_per_kg, cost);
      const belowMargin = margin !== null && margin < minMargin;
      const approval = (prev !== null && needApproval) || belowMargin;
      if (approval && !b.reason) throw badRequest(belowMargin ? `Margin ${margin}% is below the ${minMargin}% minimum. Give a reason for the approver.` : 'Give a reason for the price change', { fields: { reason: 'Required' } });
      const t = await one<{ id: string }>(c, `
        INSERT INTO price_tags (lot_id, price_per_kg, previous_price, cost_per_kg, margin_pct, status, reason, requested_by, requested_by_name) VALUES ($1,$2,$3,$4,$5,'pending',$6,$7,$8) RETURNING id`,
        [lot.id, b.price_per_kg, prev, cost, margin, b.reason ?? null, req.user!.id, req.user!.name]);
      if (approval) {
        await requestApproval(c, req, {
          type: 'price_change', refId: t!.id, permission: 'inventory.price.approve',
          title: `Selling price ${lot.lot_no} (${lot.sku}): ${prev === null ? 'new' : `₹${prev}`} → ₹${b.price_per_kg}/kg`,
          summary: `${margin === null ? 'Cost not known' : `Margin ${margin}%`}${belowMargin ? ` — below the ${minMargin}% minimum` : ''}. ${b.reason ?? ''}`.trim(),
          payload: { lot_id: lot.id, lot_no: lot.lot_no, sku: lot.sku, previous_price: prev, price_per_kg: b.price_per_kg, cost_per_kg: cost, margin_pct: margin },
        });
      } else await applyPrice(c, t!.id, req.user!.name, null);
      await auditReq(c, req, 'lot', lot.id, approval ? 'price_change_requested' : 'price_tagged', { before: { price_per_kg: prev }, after: { price_per_kg: b.price_per_kg, margin_pct: margin }, reason: b.reason });
      return { id: t!.id, status: approval ? 'pending' : 'approved', margin_pct: margin };
    });
    res.status(201).json(out);
  });

  r.get('/price-tags', requirePermission('inventory.read'), async (req, res) => {
    const status = (req.query.status as string) || null;
    res.json(await many(pool, `
      SELECT t.*, l.lot_no, l.sku, l.product_name, l.grade, l.received_date,
        (SELECT round(sum(weight_kg), 2) FROM rolls r WHERE r.lot_id = l.id AND r.state IN ('available','reserved','qc_hold'))::float AS kg
      FROM price_tags t JOIN lots l ON l.id = t.lot_id WHERE ($1::text IS NULL OR t.status = $1) ORDER BY t.requested_at DESC LIMIT 300`, [status]));
  });

  /** Lots in stock that still need a selling price. */
  r.get('/price-tags/untagged', requirePermission('inventory.read'), async (_req, res) => {
    res.json(await many(pool, `
      SELECT l.id, l.lot_no, l.sku, l.product_name, l.grade, l.qc_status, l.cost_per_kg, l.received_date, l.party_name,
        round(sum(r.weight_kg), 2)::float AS kg, count(*)::int AS rolls
      FROM lots l JOIN rolls r ON r.lot_id = l.id AND r.state IN ('available','qc_hold')
      WHERE l.price_per_kg IS NULL AND NOT EXISTS (SELECT 1 FROM price_tags t WHERE t.lot_id = l.id AND t.status = 'pending')
      GROUP BY l.id ORDER BY l.received_date`));
  });
}
