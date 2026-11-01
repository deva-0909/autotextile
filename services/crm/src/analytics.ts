import type { Request, Router } from 'express';
import { z } from 'zod';
import { type ServiceContext, badRequest, callService, many, notFound, one, optText, parse, requirePermission, tx } from '@erp/platform';
import { S, auditReq, round2, seesAll } from './common.ts';
import { crmSettings } from './settings.ts';
import { performanceOf } from './allocation.ts';

const isDate = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
/** Period from ?from=&to= (dates), defaulting to the last 90 days. */
function period(req: Request) {
  const to = isDate(req.query.to) ? req.query.to : new Date().toISOString().slice(0, 10);
  const from = isDate(req.query.from) ? req.query.from : new Date(Date.now() - 89 * 86_400_000).toISOString().slice(0, 10);
  if (from > to) throw badRequest('“From” is after “to”');
  return { from, to };
}
const months = (from: string, to: string) => {
  const out: string[] = [];
  for (let d = new Date(`${from.slice(0, 7)}-01T00:00:00Z`); d.toISOString().slice(0, 10) <= to; d.setUTCMonth(d.getUTCMonth() + 1)) out.push(d.toISOString().slice(0, 10));
  return out;
};

export function analyticsRoutes(r: Router, { pool }: ServiceContext) {
  /** Team leaderboard for a period: workload, speed, contact, samples, quotes, wins and revenue against target. */
  r.get('/leaderboard', requirePermission('crm.read'), async (req, res) => {
    const { from, to } = period(req);
    const p: unknown[] = [from, to];
    const mine = seesAll(req) ? '' : (p.push(req.user!.id), ` AND m.user_id = $${p.length}`);
    const rows = await many<Record<string, number | string | null>>(pool, `
      WITH assigned AS (SELECT DISTINCT x.lead_id, x.to_user FROM lead_assignments x WHERE x.to_user IS NOT NULL AND x.at >= $1::date AND x.at < $2::date + 1)
      SELECT m.user_id, m.name, m.active,
        (SELECT count(*)::int FROM assigned a WHERE a.to_user = m.user_id) AS assigned,
        (SELECT count(*)::int FROM assigned a JOIN leads l ON l.id = a.lead_id WHERE a.to_user = m.user_id AND l.first_response_at IS NOT NULL) AS contacted,
        (SELECT round(avg(extract(epoch FROM l.first_response_at - coalesce(l.assigned_at, l.created_at)) / 60))::int FROM leads l WHERE l.owner_id = m.user_id AND l.first_response_at >= $1::date AND l.first_response_at < $2::date + 1 AND l.first_response_at >= coalesce(l.assigned_at, l.created_at)) AS avg_first_response_min,
        (SELECT count(*)::int FROM leads l WHERE l.owner_id = m.user_id AND l.status = 'open' AND l.first_response_at IS NULL) AS never_contacted,
        (SELECT count(*)::int FROM leads l WHERE l.owner_id = m.user_id AND l.status = 'open' AND l.stage <> 'nurture' AND (l.next_action_at IS NULL OR l.next_action_at < now())) AS overdue,
        (SELECT count(*)::int FROM leads l WHERE l.owner_id = m.user_id AND l.status = 'open' AND l.no_progress) AS no_progress,
        (SELECT count(*)::int FROM lead_activities x JOIN leads l ON l.id = x.lead_id WHERE l.owner_id = m.user_id AND x.kind = 'call' AND x.at >= $1::date AND x.at < $2::date + 1) AS calls,
        (SELECT count(*)::int FROM lead_engagements e WHERE e.owner_id = m.user_id AND e.kind = 'sample' AND e.created_at >= $1::date AND e.created_at < $2::date + 1) AS samples,
        (SELECT count(*)::int FROM lead_engagements e WHERE e.owner_id = m.user_id AND e.kind = 'visit' AND e.created_at >= $1::date AND e.created_at < $2::date + 1) AS visits,
        (SELECT count(*)::int FROM quotations q WHERE q.owner_id = m.user_id AND q.version = 1 AND q.sent_at >= $1::date AND q.sent_at < $2::date + 1) AS quotes_sent,
        (SELECT count(*)::int FROM quotations q WHERE q.owner_id = m.user_id AND q.status = 'accepted' AND q.decided_at >= $1::date AND q.decided_at < $2::date + 1) AS quotes_won,
        (SELECT coalesce(sum(q.total), 0)::float FROM quotations q WHERE q.owner_id = m.user_id AND q.status = 'accepted' AND q.decided_at >= $1::date AND q.decided_at < $2::date + 1) AS won_value,
        (SELECT count(*)::int FROM leads l WHERE l.owner_id = m.user_id AND l.stage = 'won' AND l.closed_at >= $1::date AND l.closed_at < $2::date + 1) AS won,
        (SELECT count(*)::int FROM leads l WHERE l.owner_id = m.user_id AND l.stage = 'lost' AND l.closed_at >= $1::date AND l.closed_at < $2::date + 1) AS lost,
        (SELECT count(*)::int FROM lead_assignments x WHERE x.method = 'override' AND x.to_user = m.user_id AND x.at >= $1::date AND x.at < $2::date + 1) AS overrides_in,
        (SELECT coalesce(sum(t.revenue), 0)::float FROM targets t WHERE t.user_id = m.user_id AND t.period BETWEEN to_char($1::date, 'YYYY-MM') AND to_char($2::date, 'YYYY-MM')) AS target_revenue
      FROM sales_team m WHERE true${mine} ORDER BY m.active DESC, m.name`, p);
    res.json({ from, to, rows: rows.map((x) => ({ ...x, contact_rate: Number(x.assigned) ? Math.round((Number(x.contacted) / Number(x.assigned)) * 1000) / 10 : null, target_pct: Number(x.target_revenue) ? Math.round((Number(x.won_value) / Number(x.target_revenue)) * 1000) / 10 : null })) });
  });

  /** Why we lose: lost leads by objection, by category and by salesperson. */
  r.get('/lost-analysis', requirePermission('crm.read'), async (req, res) => {
    const { from, to } = period(req);
    const p: unknown[] = [from, to];
    const mine = seesAll(req) ? '' : (p.push(req.user!.id), ` AND l.owner_id = $${p.length}`);
    const base = `FROM leads l WHERE l.stage = 'lost' AND l.closed_at >= $1::date AND l.closed_at < $2::date + 1${mine}`;
    const [total, byObjection, byCategory, byOwner, bySource, competitors] = await Promise.all([
      one<{ n: number; value: number }>(pool, `SELECT count(*)::int AS n, coalesce(sum(est_value), 0)::float AS value ${base}`, p),
      many(pool, `SELECT coalesce(l.objection, 'Not recorded') AS objection, count(*)::int AS n, coalesce(sum(l.est_value), 0)::float AS value ${base} GROUP BY 1 ORDER BY 2 DESC`, p),
      many(pool, `SELECT coalesce(l.category, l.product_label, 'Not stated') AS category, coalesce(l.objection, 'Not recorded') AS objection, count(*)::int AS n ${base} GROUP BY 1, 2 ORDER BY 3 DESC`, p),
      many(pool, `SELECT coalesce(l.owner_name, 'Unassigned') AS owner, coalesce(l.objection, 'Not recorded') AS objection, count(*)::int AS n ${base} GROUP BY 1, 2 ORDER BY 3 DESC`, p),
      many(pool, `SELECT l.source_code AS source, count(*)::int AS n ${base} GROUP BY 1 ORDER BY 2 DESC`, p),
      many(pool, `SELECT l.competitor, count(*)::int AS n ${base} AND l.competitor IS NOT NULL GROUP BY 1 ORDER BY 2 DESC LIMIT 10`, p),
    ]);
    res.json({ from, to, total: total!.n, value: total!.value, by_objection: (byObjection as { n: number }[]).map((x) => ({ ...x, pct: total!.n ? Math.round((x.n / total!.n) * 1000) / 10 : 0 })), by_category: byCategory, by_owner: byOwner, by_source: bySource, competitors });
  });

  /** Expected orders and revenue from the open pipeline: stage likelihood × score, in 30/60/90-day windows. */
  r.get('/forecast', requirePermission('crm.read'), async (req, res) => {
    const st = await crmSettings(pool);
    const p: unknown[] = [];
    const mine = seesAll(req) ? '' : (p.push(req.user!.id), ` AND l.owner_id = $${p.length}`);
    const leads = await many<{ id: string; stage: string; score: number | null; est_value: number | null; requirement_kg: number | null; category: string | null; product_label: string | null; owner_name: string | null; next_action_at: string | null }>(pool, `
      SELECT l.id, l.stage, l.score, l.est_value::float, l.requirement_kg::float, l.category, l.product_label, l.owner_name, l.next_action_at FROM leads l WHERE l.status = 'open'${mine}`, p);
    // Average order value and rate per kg by category, from accepted quotations; the overall average when a category has none.
    const avg = await many<{ category: string | null; value: number; per_kg: number | null }>(pool, `
      SELECT ql.category, avg(q.total)::float AS value, (sum(ql.taxable) / nullif(sum(ql.kg), 0))::float AS per_kg FROM quotations q JOIN quotation_lines ql ON ql.quotation_id = q.id WHERE q.status = 'accepted' GROUP BY ql.category`);
    const overall = avg.length ? avg.reduce((s, x) => s + x.value, 0) / avg.length : 0;
    const prob = st.stage_probability as Record<string, number>;
    const windowOf = (stage: string) => (['order_confirmed', 'negotiation'].includes(stage) ? 30 : ['quotation', 'qualified'].includes(stage) ? 60 : 90);
    const rows = leads.map((l) => {
      const cat = l.category ?? l.product_label ?? 'Not stated';
      const a = avg.find((x) => (x.category ?? '').toLowerCase() === (l.category ?? '').toLowerCase());
      const value = l.est_value ?? (l.requirement_kg && a?.per_kg ? l.requirement_kg * a.per_kg * 1.05 : null) ?? a?.value ?? overall;
      const likelihood = Math.min(0.95, (prob[l.stage] ?? 0.03) * (0.5 + (l.score ?? 40) / 100));
      return { category: cat, owner: l.owner_name ?? 'Unassigned', stage: l.stage, window: windowOf(l.stage), value, likelihood, expected: value * likelihood, estimated: l.est_value == null };
    });
    const group = (key: 'category' | 'owner' | 'stage') => Object.values(rows.reduce<Record<string, { key: string; open: number; pipeline: number; expected_orders: number; expected_value: number }>>((m, x) => {
      const k = x[key]; m[k] ??= { key: k, open: 0, pipeline: 0, expected_orders: 0, expected_value: 0 };
      m[k].open++; m[k].pipeline += x.value; m[k].expected_orders += x.likelihood; m[k].expected_value += x.expected; return m;
    }, {})).map((g) => ({ ...g, pipeline: round2(g.pipeline), expected_orders: Math.round(g.expected_orders * 10) / 10, expected_value: round2(g.expected_value) })).sort((a, b) => b.expected_value - a.expected_value);
    const win = (d: number) => ({ days: d, expected_orders: Math.round(rows.filter((x) => x.window <= d).reduce((s, x) => s + x.likelihood, 0) * 10) / 10, expected_value: round2(rows.filter((x) => x.window <= d).reduce((s, x) => s + x.expected, 0)) });
    res.json({ open: rows.length, estimated_values: rows.filter((x) => x.estimated).length, stage_probability: prob, windows: [win(30), win(60), win(90)], by_category: group('category'), by_owner: group('owner'), by_stage: group('stage') });
  });

  /**
   * Lead-source performance and return. Spend = cost per lead × leads + monthly fee × months + spend entered for the period.
   * Revenue = invoices (taxable) to customers first won from that source, within the attribution period after conversion.
   */
  r.get('/source-performance', requirePermission('crm.read'), async (req, res) => {
    const { from, to } = period(req);
    const st = await crmSettings(pool);
    const sources = await many<{ id: string; code: string; name: string; kind: string; status: string; cost_per_lead: number; monthly_fee: number }>(pool, 'SELECT id, code, name, kind, status, cost_per_lead::float, monthly_fee::float FROM lead_sources ORDER BY name');
    const funnel = await many<Record<string, number | string>>(pool, `
      SELECT l.source_code, count(*)::int AS leads,
        count(*) FILTER (WHERE l.first_response_at IS NOT NULL)::int AS contacted,
        count(*) FILTER (WHERE l.stage IN ('qualified','quotation','negotiation','order_confirmed','won') OR EXISTS (SELECT 1 FROM quotations q WHERE q.lead_id = l.id))::int AS qualified,
        count(*) FILTER (WHERE EXISTS (SELECT 1 FROM lead_engagements e WHERE e.lead_id = l.id AND e.kind = 'sample'))::int AS samples,
        count(*) FILTER (WHERE EXISTS (SELECT 1 FROM quotations q WHERE q.lead_id = l.id AND q.sent_at IS NOT NULL))::int AS quoted,
        count(*) FILTER (WHERE l.stage = 'won' OR (l.customer_id IS NOT NULL AND EXISTS (SELECT 1 FROM quotations q WHERE q.lead_id = l.id AND q.status = 'accepted')))::int AS won,
        count(*) FILTER (WHERE l.stage = 'lost')::int AS lost,
        round(avg(extract(epoch FROM l.first_response_at - coalesce(l.assigned_at, l.created_at)) / 60) FILTER (WHERE l.first_response_at >= coalesce(l.assigned_at, l.created_at)))::int AS avg_response_min,
        count(*) FILTER (WHERE l.reenquiry_count > 0)::int AS reenquired
      FROM leads l WHERE l.status <> 'merged' AND l.created_at >= $1::date AND l.created_at < $2::date + 1 GROUP BY l.source_code`, [from, to]);
    const spend = await many<{ source_id: string; amount: number }>(pool, `SELECT source_id, sum(amount)::float AS amount FROM lead_source_spend WHERE month >= date_trunc('month', $1::date) AND month <= $2::date GROUP BY source_id`, [from, to]);
    // First source per customer: the earliest lead that converted to it.
    const firstTouch = await many<{ customer_id: string; source_code: string; won_at: string }>(pool, `
      SELECT DISTINCT ON (customer_id) customer_id, source_code, created_at::date::text AS won_at FROM leads WHERE customer_id IS NOT NULL AND status <> 'merged' ORDER BY customer_id, created_at`);
    const sales = firstTouch.length ? await callService<{ party_id: string; taxable: number; invoices: number }[]>(S, 'finance', 'GET', `/sales-invoices?party_ids=${firstTouch.map((x) => x.customer_id).join(',')}&from=${from}`)
      .then((inv) => inv as unknown as { party_id: string; doc_date: string; taxable: number }[]).catch(() => []) : [];
    const attr = Number(st.attribution_months);
    const revenue = new Map<string, { value: number; customers: Set<string> }>();
    for (const inv of sales as unknown as { party_id: string; doc_date: string; taxable: number }[]) {
      const t = firstTouch.find((x) => x.customer_id === inv.party_id);
      if (!t || inv.doc_date > to) continue;
      const until = new Date(`${t.won_at}T00:00:00Z`); until.setUTCMonth(until.getUTCMonth() + attr);
      if (inv.doc_date < t.won_at.slice(0, 10) || inv.doc_date > until.toISOString().slice(0, 10)) continue;
      const r1 = revenue.get(t.source_code) ?? { value: 0, customers: new Set<string>() };
      r1.value += Number(inv.taxable); r1.customers.add(inv.party_id); revenue.set(t.source_code, r1);
    }
    const nMonths = months(from, to).length;
    const rows = sources.map((s) => {
      const f = funnel.find((x) => x.source_code === s.code) ?? {};
      const leads = Number(f.leads ?? 0);
      const cost = round2(Number(s.cost_per_lead) * leads + Number(s.monthly_fee) * nMonths + (spend.find((x) => x.source_id === s.id)?.amount ?? 0));
      const rev = revenue.get(s.code);
      const value = round2(rev?.value ?? 0);
      const won = Number(f.won ?? 0);
      return {
        source_id: s.id, code: s.code, name: s.name, kind: s.kind, status: s.status, cost_per_lead: s.cost_per_lead, monthly_fee: s.monthly_fee,
        leads, contacted: Number(f.contacted ?? 0), qualified: Number(f.qualified ?? 0), samples: Number(f.samples ?? 0), quoted: Number(f.quoted ?? 0), won, lost: Number(f.lost ?? 0), reenquired: Number(f.reenquired ?? 0), avg_response_min: f.avg_response_min ?? null,
        contact_rate: leads ? Math.round((Number(f.contacted ?? 0) / leads) * 1000) / 10 : null, conversion: leads ? Math.round((won / leads) * 1000) / 10 : null,
        spend: cost, cost_per_lead_actual: leads ? round2(cost / leads) : null, cost_per_win: won ? round2(cost / won) : null,
        revenue: value, paying_customers: rev?.customers.size ?? 0, return_multiple: cost ? Math.round((value / cost) * 10) / 10 : null, roi_pct: cost ? Math.round(((value - cost) / cost) * 1000) / 10 : null,
      };
    }).filter((x) => x.leads || x.spend || x.revenue).sort((a, b) => b.revenue - a.revenue || b.leads - a.leads);
    const sum = (k: 'leads' | 'won' | 'spend' | 'revenue') => round2(rows.reduce((s, x) => s + Number(x[k]), 0));
    const tot = { leads: sum('leads'), won: sum('won'), spend: sum('spend'), revenue: sum('revenue') };
    res.json({ from, to, attribution_months: attr, rows, totals: { ...tot, return_multiple: tot.spend ? Math.round((tot.revenue / tot.spend) * 10) / 10 : null, cost_per_win: tot.won ? round2(tot.spend / tot.won) : null } });
  });

  r.get('/sources/:id/spend', requirePermission('crm.read'), async (req, res) => {
    res.json(await many(pool, 'SELECT id, month::text, amount::float, note, by_name, created_at FROM lead_source_spend WHERE source_id = $1 ORDER BY month DESC, created_at DESC', [req.params.id]));
  });
  r.post('/sources/:id/spend', requirePermission('crm.config.manage'), async (req, res) => {
    const b = parse(z.object({ month: z.string().regex(/^\d{4}-\d{2}$/, 'Choose a month'), amount: z.number().positive('Enter the amount'), note: optText(300) }), req.body);
    const out = await tx(pool, async (c) => {
      if (!(await one(c, 'SELECT 1 FROM lead_sources WHERE id = $1', [req.params.id]))) throw notFound('Source');
      const row = await one<{ id: string }>(c, `INSERT INTO lead_source_spend (source_id, month, amount, note, by_name) VALUES ($1, $2, $3, $4, $5) RETURNING id`, [req.params.id, `${b.month}-01`, b.amount, b.note ?? null, req.user!.name]);
      await auditReq(c, req, 'lead_source', String(req.params.id), 'spend_recorded', { after: b });
      return row;
    });
    res.status(201).json(out);
  });
  r.put('/sources/:id/costs', requirePermission('crm.config.manage'), async (req, res) => {
    const b = parse(z.object({ cost_per_lead: z.number().min(0), monthly_fee: z.number().min(0) }), req.body);
    await tx(pool, async (c) => {
      const before = await one(c, 'SELECT cost_per_lead, monthly_fee FROM lead_sources WHERE id = $1 FOR UPDATE', [req.params.id]);
      if (!before) throw notFound('Source');
      await c.query('UPDATE lead_sources SET cost_per_lead = $2, monthly_fee = $3 WHERE id = $1', [req.params.id, b.cost_per_lead, b.monthly_fee]);
      await auditReq(c, req, 'lead_source', String(req.params.id), 'costs_updated', { before, after: b });
    });
    res.json({ ok: true });
  });

  /** Contact and conversion rates the best-performer strategy uses. */
  r.get('/team/performance', requirePermission('crm.read'), async (_req, res) => {
    const team = await many<{ user_id: string; name: string }>(pool, 'SELECT user_id, name FROM sales_team WHERE active ORDER BY name');
    const days = Number((await crmSettings(pool)).performance_window_days);
    const perf = await performanceOf(pool, team.map((t) => t.user_id), days);
    res.json({ window_days: days, rows: team.map((t) => ({ ...t, ...perf.get(t.user_id) })) });
  });
}
