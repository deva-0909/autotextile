import type { Router } from 'express';
import { z } from 'zod';
import { type Client, type Pool, type ServiceContext, badRequest, callService, conflict, many, notFound, one, optText, parse, requirePermission, tx } from '@erp/platform';
import { auditReq, getParty, getProduct, requestApproval, round2, today, userId } from './common.ts';

export interface Policy { id: string; name: string; scope: 'global' | 'category' | 'product' | 'customer' | 'campaign'; scope_ref: string | null; scope_label: string | null; basis: 'percent' | 'fixed'; value: number; min_amount: number | null; max_amount: number | null; validity_days: number; refundable: boolean; cancellation_fee_pct: number; valid_from: string | null; valid_to: string | null }
export interface TokenLine { product_id: string; category_id: string; taxable: number }
export interface TokenResult { amount: number; text: string; validity_days: number; refundable: boolean; cancellation_fee_pct: number; parts: { policy: string; base: number; amount: number }[] }

const RANK = { customer: 5, product: 4, category: 3, campaign: 2, global: 1 } as const;

/**
 * Token for an order. A customer-specific policy covers the whole order; otherwise each line takes the most
 * specific policy (product > category > campaign > global). Percent policies apply to taxable value excluding GST;
 * min and max are applied per policy.
 */
export async function resolveToken(c: Pool | Client, customerId: string, lines: TokenLine[]): Promise<TokenResult> {
  const d = today();
  const active = await many<Policy>(c, `SELECT * FROM token_policies WHERE status = 'active' AND (valid_from IS NULL OR valid_from <= $1) AND (valid_to IS NULL OR valid_to >= $1)`, [d]);
  const best = (cands: Policy[]) => cands.sort((a, b) => RANK[b.scope] - RANK[a.scope])[0];
  const cust = active.find((p) => p.scope === 'customer' && p.scope_ref === customerId);
  const groups = new Map<string, { p: Policy; base: number }>();
  for (const l of lines) {
    const p = cust ?? best(active.filter((x) => x.scope === 'global' || x.scope === 'campaign' || (x.scope === 'product' && x.scope_ref === l.product_id) || (x.scope === 'category' && x.scope_ref === l.category_id)));
    if (!p) continue;
    const g = groups.get(p.id) ?? { p, base: 0 };
    g.base += l.taxable;
    groups.set(p.id, g);
  }
  const parts = [...groups.values()].map(({ p, base }) => {
    let amt = p.basis === 'percent' ? (base * Number(p.value)) / 100 : Number(p.value);
    if (p.min_amount != null) amt = Math.max(amt, Number(p.min_amount));
    if (p.max_amount != null) amt = Math.min(amt, Number(p.max_amount));
    return { policy: p, base: round2(base), amount: round2(Math.min(amt, base)) };
  });
  const amount = round2(parts.reduce((s, x) => s + x.amount, 0));
  return {
    amount,
    text: parts.map((x) => `${x.policy.basis === 'percent' ? `${Number(x.policy.value)}% of ₹${x.base.toLocaleString('en-IN')} taxable` : `₹${Number(x.policy.value).toLocaleString('en-IN')} fixed`} (${x.policy.name})`).join(' + ') || 'No token policy applies',
    validity_days: parts.length ? Math.min(...parts.map((x) => x.policy.validity_days)) : 7,
    refundable: parts.every((x) => x.policy.refundable),
    cancellation_fee_pct: parts.length ? Math.max(...parts.map((x) => Number(x.policy.cancellation_fee_pct))) : 0,
    parts: parts.map((x) => ({ policy: x.policy.name, base: x.base, amount: x.amount })),
  };
}

export async function applyPolicyDecision(c: Client, p: { ref_id: string; decision: string; decided_by_name: string }) {
  const pol = await one<{ id: string; status: string; scope: string; scope_ref: string | null }>(c, 'SELECT * FROM token_policies WHERE id = $1 FOR UPDATE', [p.ref_id]);
  if (!pol || pol.status !== 'pending_approval') return;
  if (p.decision === 'approved') {
    // One active policy per scope target: the new one replaces the old.
    await c.query(`UPDATE token_policies SET status = 'inactive' WHERE status = 'active' AND scope = $1 AND scope_ref IS NOT DISTINCT FROM $2 AND scope <> 'campaign' AND id <> $3`, [pol.scope, pol.scope_ref, pol.id]);
    await c.query(`UPDATE token_policies SET status = 'active', decided_by_name = $2, decided_at = now() WHERE id = $1`, [pol.id, p.decided_by_name]);
  } else await c.query(`UPDATE token_policies SET status = 'rejected', decided_by_name = $2, decided_at = now() WHERE id = $1`, [pol.id, p.decided_by_name]);
}

const body = z.object({
  name: z.string().trim().min(3).max(120),
  scope: z.enum(['global', 'category', 'product', 'customer', 'campaign']),
  scope_ref: z.uuid().nullable().optional(),
  basis: z.enum(['percent', 'fixed']),
  value: z.number().min(0),
  min_amount: z.number().min(0).nullable().optional(),
  max_amount: z.number().min(0).nullable().optional(),
  validity_days: z.number().int().min(1).max(90).default(7),
  refundable: z.boolean().default(true),
  cancellation_fee_pct: z.number().min(0).max(100).default(0),
  valid_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  valid_to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  reason: optText(500),
});

export function policyRoutes(r: Router, { pool }: ServiceContext) {
  r.get('/token-policies', requirePermission('commerce.read'), async (_req, res) => {
    res.json(await many(pool, `SELECT * FROM token_policies ORDER BY (status = 'active') DESC, status, CASE scope WHEN 'customer' THEN 1 WHEN 'product' THEN 2 WHEN 'category' THEN 3 WHEN 'campaign' THEN 4 ELSE 5 END, created_at DESC`));
  });

  /** Propose a policy; it becomes active only after a checker approves it. */
  r.post('/token-policies', requirePermission('commerce.policy.manage'), async (req, res) => {
    const b = parse(body, req.body);
    if (b.basis === 'percent' && b.value > 100) throw badRequest('A percentage cannot exceed 100');
    if (b.min_amount != null && b.max_amount != null && b.min_amount > b.max_amount) throw badRequest('Minimum is above maximum');
    if (!['global', 'campaign'].includes(b.scope) && !b.scope_ref) throw badRequest('Choose what this policy applies to', { fields: { scope_ref: 'Required' } });
    if (b.scope === 'campaign' && (!b.valid_from || !b.valid_to)) throw badRequest('A campaign needs start and end dates');
    let label: string | null = null;
    if (b.scope === 'customer') label = (await getParty(b.scope_ref!).catch(() => null))?.legal_name ?? null;
    if (b.scope === 'product') label = (await getProduct(b.scope_ref!).catch(() => null))?.sku ?? null;
    if (b.scope === 'category') {
      const cats = await callService<{ id: string; name: string }[]>('commerce', 'masters', 'GET', '/fabric-categories');
      label = cats.find((x) => x.id === b.scope_ref)?.name ?? null;
    }
    if (!['global', 'campaign'].includes(b.scope) && !label) throw badRequest('That target was not found');
    const out = await tx(pool, async (c) => {
      if (await one(c, `SELECT 1 FROM token_policies WHERE status = 'pending_approval' AND scope = $1 AND scope_ref IS NOT DISTINCT FROM $2`, [b.scope, b.scope_ref ?? null])) throw conflict('A change for this target is already waiting for approval');
      const p = await one<{ id: string }>(c, `
        INSERT INTO token_policies (name, scope, scope_ref, scope_label, basis, value, min_amount, max_amount, validity_days, refundable, cancellation_fee_pct, valid_from, valid_to, reason, requested_by, requested_by_name)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING id`,
        [b.name, b.scope, b.scope_ref ?? null, label, b.basis, b.value, b.min_amount ?? null, b.max_amount ?? null, b.validity_days, b.refundable, b.cancellation_fee_pct, b.valid_from ?? null, b.valid_to ?? null, b.reason ?? null, userId(req), req.user!.name]);
      const what = b.basis === 'percent' ? `${b.value}% of taxable value` : `₹${b.value.toLocaleString('en-IN')} fixed`;
      await requestApproval(c, req, {
        type: 'token_policy', refId: p!.id, permission: 'commerce.policy.approve',
        title: `Token policy: ${b.name} (${b.scope}${label ? ` · ${label}` : ''})`,
        summary: `${what}${b.min_amount != null ? `, min ₹${b.min_amount}` : ''}${b.max_amount != null ? `, max ₹${b.max_amount}` : ''}; valid ${b.validity_days} days; ${b.refundable ? `refundable less ${b.cancellation_fee_pct}% fee` : 'non-refundable'}. ${b.reason ?? ''}`,
        payload: { scope: b.scope, target: label, basis: b.basis, value: b.value, min_amount: b.min_amount ?? null, max_amount: b.max_amount ?? null, validity_days: b.validity_days, refundable: b.refundable, cancellation_fee_pct: b.cancellation_fee_pct },
      });
      await auditReq(c, req, 'token_policy', p!.id, 'proposed', { after: b, reason: b.reason });
      return { id: p!.id, status: 'pending_approval' };
    });
    res.status(201).json(out);
  });

  r.post('/token-policies/:id/deactivate', requirePermission('commerce.policy.manage'), async (req, res) => {
    const { reason } = parse(z.object({ reason: z.string().trim().min(3).max(300) }), req.body);
    await tx(pool, async (c) => {
      const p = await one<{ scope: string }>(c, `SELECT scope FROM token_policies WHERE id = $1 AND status = 'active' FOR UPDATE`, [req.params.id]);
      if (!p) throw notFound('Active policy');
      if (p.scope === 'global') throw conflict('The company default cannot be switched off; replace it with a new one');
      await c.query(`UPDATE token_policies SET status = 'inactive' WHERE id = $1`, [req.params.id]);
      await auditReq(c, req, 'token_policy', String(req.params.id), 'deactivated', { reason });
    });
    res.json({ ok: true });
  });

  /** What token a customer would pay on given lines (used by the policy screen to test rules). */
  r.post('/token-policies/preview', requirePermission('commerce.read'), async (req, res) => {
    const b = parse(z.object({ customer_id: z.uuid(), lines: z.array(z.object({ product_id: z.uuid(), taxable: z.number().positive() })).min(1) }), req.body);
    const lines = await Promise.all(b.lines.map(async (l) => ({ ...l, category_id: (await getProduct(l.product_id)).category_id })));
    res.json(await resolveToken(pool, b.customer_id, lines));
  });
}
