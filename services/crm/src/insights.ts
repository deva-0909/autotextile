import type { Router } from 'express';
import { z } from 'zod';
import { type ServiceContext, badRequest, callService, hasPermission, many, notFound, one, parse, requirePermission, tx } from '@erp/platform';
import { S, auditReq, round2, seesAll, setting } from './common.ts';
import { creditCheck } from './credit.ts';

const periodRe = /^\d{4}-\d{2}$/;
const monthRange = (p: string) => {
  const [y, m] = p.split('-').map(Number);
  return { from: `${p}-01`, to: new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10) };
};

export function insightRoutes(r: Router, { pool }: ServiceContext) {
  r.get('/dashboard', requirePermission('crm.read'), async (req, res) => {
    const params: unknown[] = [];
    let own = '';
    if (!seesAll(req)) { params.push(req.user!.id); own = ` AND owner_id = $1`; }
    const k = await one<Record<string, unknown>>(pool, `SELECT
      (SELECT count(*)::int FROM leads WHERE created_at >= current_date${own}) AS leads_today,
      (SELECT count(*)::int FROM leads WHERE status = 'open'${own}) AS open_leads,
      (SELECT count(*)::int FROM leads WHERE status = 'open' AND owner_id IS NULL) AS unassigned,
      (SELECT count(*)::int FROM leads WHERE status = 'open' AND stage <> 'nurture' AND (next_action_at IS NULL OR next_action_at < now())${own}) AS followups_due,
      (SELECT count(*)::int FROM leads WHERE status = 'open' AND duplicate_flag${own}) AS possible_duplicates,
      (SELECT count(*)::int FROM quotations WHERE status = 'pending_approval'${own}) AS quotes_pending_approval,
      (SELECT coalesce(sum(total), 0)::float FROM quotations WHERE status = 'sent'${own}) AS quotes_open_value,
      (SELECT coalesce(sum(total), 0)::float FROM quotations WHERE status = 'accepted' AND decided_at >= date_trunc('month', now())${own}) AS won_this_month,
      (SELECT round(avg(extract(epoch FROM first_response_at - created_at) / 60))::int FROM leads WHERE first_response_at IS NOT NULL AND created_at > now() - interval '30 days'${own}) AS avg_first_response_min,
      (SELECT count(*)::int FROM credit_applications WHERE status = 'pending') AS credit_pending`, params);
    const stages = await many(pool, `SELECT stage, count(*)::int AS n, coalesce(sum(est_value), 0)::float AS value FROM leads WHERE status <> 'merged'${own} GROUP BY stage`, params);
    const sources = await many(pool, `SELECT source_code, count(*)::int AS n, count(*) FILTER (WHERE stage IN ('won','order_confirmed'))::int AS converted FROM leads WHERE created_at > now() - interval '90 days' AND status <> 'merged'${own} GROUP BY source_code ORDER BY n DESC`, params);
    res.json({ ...k, stages, sources });
  });

  r.get('/targets', requirePermission('crm.read'), async (req, res) => {
    const period = String(req.query.period ?? new Date().toISOString().slice(0, 7));
    res.json(await many(pool, `SELECT m.user_id, m.name, t.* FROM sales_team m LEFT JOIN targets t ON t.user_id = m.user_id AND t.period = $1 WHERE m.active ORDER BY m.name`, [period]));
  });

  r.put('/targets', requirePermission('crm.target.manage'), async (req, res) => {
    const b = parse(z.object({
      user_id: z.uuid(), period: z.string().regex(periodRe), leads: z.number().int().min(0).nullable().optional(), qualified: z.number().int().min(0).nullable().optional(), quotes: z.number().int().min(0).nullable().optional(),
      kg: z.number().min(0).nullable().optional(), revenue: z.number().min(0).nullable().optional(), margin_pct: z.number().min(0).max(100).nullable().optional(), new_customers: z.number().int().min(0).nullable().optional(), collections: z.number().min(0).nullable().optional(),
    }), req.body);
    await tx(pool, async (c) => {
      if (!(await one(c, 'SELECT 1 FROM sales_team WHERE user_id = $1', [b.user_id]))) throw badRequest('Add this person to the sales team first');
      await c.query(`
        INSERT INTO targets (user_id, period, leads, qualified, quotes, kg, revenue, margin_pct, new_customers, collections, updated_by_name) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        ON CONFLICT (user_id, period) DO UPDATE SET leads = EXCLUDED.leads, qualified = EXCLUDED.qualified, quotes = EXCLUDED.quotes, kg = EXCLUDED.kg, revenue = EXCLUDED.revenue, margin_pct = EXCLUDED.margin_pct,
          new_customers = EXCLUDED.new_customers, collections = EXCLUDED.collections, updated_by_name = EXCLUDED.updated_by_name, updated_at = now()`,
        [b.user_id, b.period, b.leads ?? null, b.qualified ?? null, b.quotes ?? null, b.kg ?? null, b.revenue ?? null, b.margin_pct ?? null, b.new_customers ?? null, b.collections ?? null, req.user!.name]);
      await auditReq(c, req, 'sales_target', b.user_id, 'set', { after: b });
    });
    res.json({ ok: true });
  });

  /**
   * Performance against target. Only verified outcomes count: revenue, kg and margin come from quotations
   * the customer accepted at an approved price for a customer account. Collections arrive with P8.
   */
  r.get('/performance', requirePermission('crm.read'), async (req, res) => {
    const period = String(req.query.period ?? new Date().toISOString().slice(0, 7));
    if (!periodRe.test(period)) throw badRequest('Period is YYYY-MM');
    const { from, to } = monthRange(period);
    const minMargin = Number(await setting('sales.min_margin_percent', 8));
    const all = hasPermission(req.user, 'crm.target.manage') || seesAll(req);
    const rows = await many<Record<string, number | string | null> & { user_id: string; name: string }>(pool, `
      SELECT m.user_id, m.name,
        (SELECT count(*)::int FROM lead_assignments a WHERE a.to_user = m.user_id AND a.at >= $1 AND a.at < $2) AS leads,
        (SELECT round(avg(extract(epoch FROM l.first_response_at - coalesce(l.assigned_at, l.created_at)) / 60))::int FROM leads l WHERE l.owner_id = m.user_id AND l.first_response_at >= $1 AND l.first_response_at < $2) AS avg_response_min,
        (SELECT count(*)::int FROM leads l WHERE l.owner_id = m.user_id AND l.created_at < $2 AND l.stage IN ('qualified','quotation','negotiation','order_confirmed','won') AND l.updated_at >= $1) AS qualified,
        (SELECT count(*)::int FROM quotations q WHERE q.owner_id = m.user_id AND q.sent_at >= $1 AND q.sent_at < $2) AS quotes,
        (SELECT coalesce(sum(q.kg), 0)::float FROM quotations q WHERE q.owner_id = m.user_id AND q.status = 'accepted' AND q.decided_at >= $1 AND q.decided_at < $2) AS kg,
        (SELECT coalesce(sum(q.taxable - q.freight_amount), 0)::float FROM quotations q WHERE q.owner_id = m.user_id AND q.status = 'accepted' AND q.decided_at >= $1 AND q.decided_at < $2) AS revenue,
        (SELECT round(sum((l.requested_price - l.cost_per_kg) * l.kg) / nullif(sum(l.requested_price * l.kg), 0) * 100, 2)::float FROM quotation_lines l JOIN quotations q ON q.id = l.quotation_id
           WHERE q.owner_id = m.user_id AND q.status = 'accepted' AND q.decided_at >= $1 AND q.decided_at < $2 AND l.cost_per_kg IS NOT NULL) AS margin_pct,
        (SELECT count(DISTINCT q.customer_id)::int FROM quotations q WHERE q.owner_id = m.user_id AND q.status = 'accepted' AND q.decided_at >= $1 AND q.decided_at < $2
           AND NOT EXISTS (SELECT 1 FROM quotations p WHERE p.customer_id = q.customer_id AND p.status = 'accepted' AND p.decided_at < $1)) AS new_customers,
        (SELECT count(DISTINCT q.customer_id)::int FROM quotations q WHERE q.owner_id = m.user_id AND q.status = 'accepted' AND q.decided_at >= $1 AND q.decided_at < $2
           AND EXISTS (SELECT 1 FROM quotations p WHERE p.customer_id = q.customer_id AND p.status = 'accepted' AND p.decided_at < $1)) AS repeat_customers,
        t.leads AS t_leads, t.qualified AS t_qualified, t.quotes AS t_quotes, t.kg AS t_kg, t.revenue AS t_revenue, t.margin_pct AS t_margin_pct, t.new_customers AS t_new_customers, t.collections AS t_collections
      FROM sales_team m LEFT JOIN targets t ON t.user_id = m.user_id AND t.period = $3
      WHERE m.active ${all ? '' : 'AND m.user_id = $4'} ORDER BY m.name`, all ? [from, to, period] : [from, to, period, req.user!.id]);
    res.json({
      period, min_margin: minMargin, collections_note: 'Collections are measured from accounts receivable (P8).',
      people: rows.map((p) => {
        const reasons: string[] = [];
        if (p.t_revenue == null) reasons.push('No revenue target set');
        else if (Number(p.revenue) < Number(p.t_revenue)) reasons.push(`Revenue ${Math.round((Number(p.revenue) / Number(p.t_revenue)) * 100)}% of target`);
        const marginFloor = p.t_margin_pct != null ? Number(p.t_margin_pct) : minMargin;
        if (p.margin_pct !== null && Number(p.margin_pct) < marginFloor) reasons.push(`Margin ${p.margin_pct}% below ${marginFloor}%`);
        return { ...p, revenue: round2(Number(p.revenue)), incentive_eligible: reasons.length === 0, incentive_reasons: reasons };
      }),
    });
  });

  /** Customer 360: account, enquiries, quotations and prices, preferences, credit, salesperson and value in one place. */
  r.get('/customers/:id/360', requirePermission('crm.read'), async (req, res) => {
    const id = String(req.params.id);
    const party = await callService<Record<string, unknown> & { id: string; party_type: string; owner_user_id: string | null; contacts: unknown[]; addresses: unknown[] }>(S, 'masters', 'GET', `/parties/${id}`).catch(() => null);
    if (!party || party.party_type !== 'customer') throw notFound('Customer');
    const own = seesAll(req) ? '' : ` AND owner_id = '${req.user!.id.replace(/[^0-9a-f-]/gi, '')}'`;
    const [leads, quotes, activities, preferences, prices, credit] = await Promise.all([
      many(pool, `SELECT id, number, source_code, stage, status, owner_name, est_value, requirement_kg, created_at, lost_reason FROM leads WHERE customer_id = $1 AND status <> 'merged'${own} ORDER BY created_at DESC`, [id]),
      many(pool, `SELECT id, number, version, status, kg, total, margin_pct, owner_name, created_at, decided_at, lost_reason, competitor_name, competitor_price FROM quotations WHERE customer_id = $1 AND status <> 'superseded'${own} ORDER BY created_at DESC`, [id]),
      many(pool, `SELECT a.*, l.number AS lead_number FROM lead_activities a JOIN leads l ON l.id = a.lead_id WHERE l.customer_id = $1 AND a.kind <> 'system' ORDER BY a.at DESC LIMIT 50`, [id]),
      many(pool, `SELECT l.category, l.sku, l.product_name, round(sum(l.kg), 1)::float AS kg_quoted, round(sum(l.kg) FILTER (WHERE q.status = 'accepted'), 1)::float AS kg_bought, count(DISTINCT q.root_id)::int AS quotes
        FROM quotation_lines l JOIN quotations q ON q.id = l.quotation_id WHERE q.customer_id = $1 AND q.status <> 'superseded' GROUP BY 1, 2, 3 ORDER BY kg_quoted DESC LIMIT 10`, [id]),
      many(pool, `SELECT DISTINCT ON (l.sku) l.sku, l.requested_price, l.list_price, q.status, q.created_at FROM quotation_lines l JOIN quotations q ON q.id = l.quotation_id
        WHERE q.customer_id = $1 AND q.status IN ('sent','accepted','rejected','lost') ORDER BY l.sku, q.created_at DESC`, [id]),
      creditCheck(pool, id, 0),
    ]);
    const shades = await callService<{ decisions: { customer_id: string }[] }>(S, 'inventory', 'GET', '/shades').then((r) => r.decisions.filter((d) => d.customer_id === id)).catch(() => []);
    const reservations = await callService<{ customer_id: string | null }[]>(S, 'inventory', 'GET', '/reservations').then((r) => r.filter((x) => x.customer_id === id).slice(0, 10)).catch(() => []);
    const accepted = (quotes as { status: string; total: number; kg: number }[]).filter((q) => q.status === 'accepted');
    const decided = (quotes as { status: string }[]).filter((q) => ['accepted', 'rejected', 'lost'].includes(q.status)).length;
    const owner = party.owner_user_id ? await one<{ name: string }>(pool, 'SELECT name FROM sales_team WHERE user_id = $1', [party.owner_user_id]) : null;
    res.json({
      customer: party, salesperson: owner?.name ?? (leads[0] as { owner_name?: string } | undefined)?.owner_name ?? null,
      value: { orders: accepted.length, revenue: round2(accepted.reduce((s, q) => s + Number(q.total), 0)), kg: round2(accepted.reduce((s, q) => s + Number(q.kg), 0)),
        win_rate: decided ? Math.round((accepted.length / decided) * 100) : null },
      leads, quotations: quotes, activities, preferences, prices, credit, shade_decisions: shades, reservations,
      pending: { orders_dispatch: 'Sales orders and dispatch history arrive with P7', payments: 'Invoices, payments and outstanding arrive with P8', complaints: 'Complaints arrive with customer care (P7)' },
    });
  });

  r.get('/customers', requirePermission('crm.read'), async (req, res) => {
    const q = String(req.query.q ?? '');
    const parties = await callService<{ items: { id: string; code: string; legal_name: string; city?: string; gstin: string | null; segment: string | null; state_code: string | null }[] }>(S, 'masters', 'GET', `/parties?f_type=customer&pageSize=100&sort=legal_name${q ? `&q=${encodeURIComponent(q)}` : ''}`);
    const stats = await many<{ customer_id: string; leads: number; open_leads: number; accepted: number; revenue: number; last_activity: string | null }>(pool, `
      SELECT c.customer_id, count(DISTINCT l.id)::int AS leads, count(DISTINCT l.id) FILTER (WHERE l.status = 'open')::int AS open_leads,
        count(DISTINCT q.id) FILTER (WHERE q.status = 'accepted')::int AS accepted, coalesce(sum(DISTINCT q.total) FILTER (WHERE q.status = 'accepted'), 0)::float AS revenue,
        greatest(max(l.updated_at), max(q.updated_at)) AS last_activity
      FROM (SELECT DISTINCT customer_id FROM leads WHERE customer_id IS NOT NULL UNION SELECT DISTINCT customer_id FROM quotations WHERE customer_id IS NOT NULL) c
      LEFT JOIN leads l ON l.customer_id = c.customer_id LEFT JOIN quotations q ON q.customer_id = c.customer_id GROUP BY c.customer_id`);
    const accounts = await many<{ customer_id: string; mode: string; credit_limit: number; status: string }>(pool, 'SELECT customer_id, mode, credit_limit, status FROM credit_accounts');
    res.json(parties.items.map((p) => ({ ...p, ...(stats.find((s) => s.customer_id === p.id) ?? { leads: 0, open_leads: 0, accepted: 0, revenue: 0, last_activity: null }), credit: accounts.find((a) => a.customer_id === p.id) ?? null })));
  });

}
