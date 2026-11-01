import type { Request, Router } from 'express';
import { z } from 'zod';
import { type Client, type Pool, type ServiceContext, badRequest, many, notFound, notify, one, optText, parse, requirePermission, tx } from '@erp/platform';
import { crmSettings } from './settings.ts';
import { S, auditReq, getDirectory, getParty, normEmail, normGstin, normMobile, raiseException, resolveException, setting, today, type Lead } from './common.ts';

export interface Member { user_id: string; name: string; cities: string[]; states: string[]; categories: string[]; sources: string[]; languages: string[]; min_value: number | null; max_value: number | null; max_active_leads: number | null; weekly_off: number[]; active: boolean; last_assigned_at: string | null; shift_start: string | null; shift_end: string | null; shift_name: string | null }
interface Rule { id: string; name: string; priority: number; conditions: Conditions; strategy: 'round_robin' | 'least_loaded' | 'best_performer'; member_ids: string[] }
interface Conditions { cities?: string[]; states?: string[]; sources?: string[]; categories?: string[]; languages?: string[]; min_value?: number | null; max_value?: number | null }
export interface LeadFacts { city: string | null; state_code: string | null; source_code: string; category: string | null; language: string | null; est_value: number | null; mobile?: string | null; email?: string | null; gstin?: string | null; customer_id?: string | null; exclude_lead_id?: string | null; exclude_user_id?: string | null }
export interface TraceEntry { user_id: string; name: string; eligible: boolean; reason: string; active_leads: number; performance?: number | null }
export interface Decision { owner: Member | null; method: 'auto' | 'sticky' | 'unassigned'; rule: string | null; trace: TraceEntry[]; note: string }

const lc = (a: string[] | undefined) => (a ?? []).map((x) => x.trim().toLowerCase()).filter(Boolean);
const inList = (list: string[] | undefined, v: string | null) => !lc(list).length || (!!v && lc(list).includes(v.trim().toLowerCase()));
const valueOk = (min: number | null | undefined, max: number | null | undefined, v: number | null) => (min == null || (v ?? 0) >= Number(min)) && (max == null || (v ?? 0) <= Number(max));

export function ruleMatches(c: Conditions, f: LeadFacts) {
  return inList(c.cities, f.city) && inList(c.states, f.state_code) && inList(c.sources, f.source_code) && inList(c.categories, f.category) && inList(c.languages, f.language) && valueOk(c.min_value, c.max_value, f.est_value);
}
/** Profile fit for the fallback pool. Unlike rules, an unknown lead attribute does not rule anyone out. */
const fits = (list: string[] | undefined, v: string | null) => !v || inList(list, v);
const memberMatches = (m: Member, f: LeadFacts) =>
  fits(m.cities, f.city) && fits(m.states, f.state_code) && fits(m.sources, f.source_code) && fits(m.categories, f.category) && fits(m.languages, f.language) && valueOk(m.min_value, m.max_value, f.est_value);

/** Minutes since midnight in India (shift hours are set in IST). */
export const istMinutes = (d = new Date()) => { const t = new Date(d.getTime() + 330 * 60_000); return t.getUTCHours() * 60 + t.getUTCMinutes(); };
const hm = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
/** "Outside shift (09:30–18:30)" when the person's working hours (from HR) do not cover now; null otherwise. */
export function outsideShift(m: Pick<Member, 'shift_start' | 'shift_end'>, at = new Date()) {
  if (!m.shift_start || !m.shift_end) return null;
  const now = istMinutes(at), a = hm(m.shift_start), b = hm(m.shift_end);
  const inside = a <= b ? now >= a && now < b : now >= a || now < b;
  return inside ? null : `Outside shift (${m.shift_start.slice(0, 5)}–${m.shift_end.slice(0, 5)})`;
}

/** Contact and conversion rates over the window: 60% weight on reaching leads, 40% on winning them. */
export async function performanceOf(c: Pool | Client, ids: string[], windowDays: number) {
  const rows = await many<{ user_id: string; assigned: number; contacted: number; won: number }>(c, `
    WITH a AS (SELECT DISTINCT ON (x.lead_id, x.to_user) x.lead_id, x.to_user FROM lead_assignments x WHERE x.to_user = ANY($1) AND x.at > now() - make_interval(days => $2))
    SELECT a.to_user AS user_id, count(*)::int AS assigned, count(*) FILTER (WHERE l.first_response_at IS NOT NULL)::int AS contacted, count(*) FILTER (WHERE l.stage = 'won')::int AS won
    FROM a JOIN leads l ON l.id = a.lead_id GROUP BY a.to_user`, [ids, windowDays]);
  return new Map(ids.map((id) => {
    const r = rows.find((x) => x.user_id === id);
    const contact = r && r.assigned ? r.contacted / r.assigned : 0, conv = r && r.assigned ? r.won / r.assigned : 0;
    return [id, { assigned: r?.assigned ?? 0, contact_rate: Math.round(contact * 1000) / 10, conversion_rate: Math.round(conv * 1000) / 10, score: Math.round((contact * 0.6 + conv * 0.4) * 1000) / 10 }];
  }));
}

/** Who can take a lead right now: active, present, not on a break or weekly off, and under their lead cap. */
async function availability(c: Pool | Client, members: Member[]) {
  const defaultCap = Number(await setting('crm.max_active_leads_default', 40));
  const ids = members.map((m) => m.user_id);
  const att = await many<{ user_id: string; status: string; on_break: boolean }>(c, 'SELECT user_id, status, on_break FROM attendance WHERE day = current_date AND user_id = ANY($1)', [ids]);
  const load = await many<{ owner_id: string; n: number }>(c, `SELECT owner_id, count(*)::int AS n FROM leads WHERE status = 'open' AND stage <> 'nurture' AND owner_id = ANY($1) GROUP BY owner_id`, [ids]);
  const dow = new Date().getDay();
  return members.map((m) => {
    const a = att.find((x) => x.user_id === m.user_id);
    const n = load.find((x) => x.owner_id === m.user_id)?.n ?? 0;
    const cap = m.max_active_leads ?? defaultCap;
    const status = a?.status ?? (m.weekly_off.includes(dow) ? 'weekly_off' : 'present');
    const off = outsideShift(m);
    const reason = !m.active ? 'Inactive' : status === 'absent' ? 'Absent today' : status === 'leave' ? 'On leave' : status === 'weekly_off' ? 'Weekly off' : a?.on_break ? 'On a break' : off ? off : n >= cap ? `At lead cap (${n}/${cap})` : 'Available';
    return { member: m, eligible: reason === 'Available', reason, active_leads: n };
  });
}

/**
 * Decides who gets a lead. Order: the salesperson already handling this contact (sticky), then the first
 * matching rule's pool, else everyone whose profile fits. Absent, on-leave, off, on-break, inactive or
 * capped people are skipped, and the trace records why. Round robin picks whoever waited longest.
 */
export async function decide(c: Pool | Client, f: LeadFacts): Promise<Decision> {
  const members = await many<Member>(c, 'SELECT * FROM sales_team');
  const avail = await availability(c, members);
  const trace = (list: typeof avail) => list.map((a) => ({ user_id: a.member.user_id, name: a.member.name, eligible: a.eligible, reason: a.reason, active_leads: a.active_leads }));
  // Sticky: an open lead for the same contact, or the customer's account owner.
  const keys = [f.mobile, f.email, f.gstin].filter(Boolean);
  let stickyId: string | null = null;
  let stickyWhy = '';
  if (keys.length) {
    const prev = await one<{ owner_id: string; number: string }>(c, `
      SELECT owner_id, number FROM leads WHERE status = 'open' AND owner_id IS NOT NULL AND ($4::uuid IS NULL OR id <> $4)
        AND ((mobile IS NOT NULL AND mobile = $1) OR (email IS NOT NULL AND email = $2) OR (gstin IS NOT NULL AND gstin = $3)) ORDER BY created_at DESC LIMIT 1`,
      [f.mobile ?? null, f.email ?? null, f.gstin ?? null, f.exclude_lead_id ?? null]);
    if (prev) { stickyId = prev.owner_id; stickyWhy = `Already handling ${prev.number} for this contact`; }
  }
  if (!stickyId && f.customer_id) {
    const p = await getParty(f.customer_id).catch(() => null);
    if (p?.owner_user_id) { stickyId = p.owner_user_id; stickyWhy = `Account owner of ${p.legal_name}`; }
  }
  if (stickyId) {
    const a = avail.find((x) => x.member.user_id === stickyId);
    if (a?.eligible && a.member.user_id !== f.exclude_user_id) return { owner: a.member, method: 'sticky', rule: null, trace: trace([a]), note: stickyWhy };
  }
  const rules = await many<Rule>(c, `SELECT * FROM allocation_rules WHERE status = 'active' ORDER BY priority, created_at`);
  const rule = rules.find((r) => ruleMatches(r.conditions, f) && r.member_ids.length);
  const pool = rule ? avail.filter((a) => rule.member_ids.includes(a.member.user_id)) : avail.filter((a) => memberMatches(a.member, f));
  const eligible = pool.filter((a) => a.eligible && a.member.user_id !== f.exclude_user_id);
  const strategy = rule?.strategy ?? 'round_robin';
  const perf = strategy === 'best_performer' ? await performanceOf(c, pool.map((a) => a.member.user_id), Number((await crmSettings(c)).performance_window_days)) : null;
  const t = trace(pool).map((x) => ({ ...x, performance: perf?.get(x.user_id)?.score ?? null }));
  const stickyNote = stickyId ? `${stickyWhy}, but ${avail.find((x) => x.member.user_id === stickyId)?.reason.toLowerCase() ?? 'not in the sales team'}. ` : '';
  if (!eligible.length) return { owner: null, method: 'unassigned', rule: rule?.name ?? null, trace: t, note: `${stickyNote}Nobody in ${rule ? `“${rule.name}”` : 'the matching team'} is available` };
  const pick = eligible.sort((a, b) =>
    strategy === 'best_performer' && perf!.get(a.member.user_id)!.score !== perf!.get(b.member.user_id)!.score ? perf!.get(b.member.user_id)!.score - perf!.get(a.member.user_id)!.score
      : strategy === 'least_loaded' && a.active_leads !== b.active_leads ? a.active_leads - b.active_leads
      : (a.member.last_assigned_at ? new Date(a.member.last_assigned_at).getTime() : 0) - (b.member.last_assigned_at ? new Date(b.member.last_assigned_at).getTime() : 0) || a.member.name.localeCompare(b.member.name))[0];
  const pf = perf?.get(pick.member.user_id);
  return { owner: pick.member, method: 'auto', rule: rule?.name ?? null, trace: t, note: `${stickyNote}${rule ? `Rule “${rule.name}”` : 'Profile match'}, ${strategy.replace(/_/g, ' ')}${pf ? ` (${pf.contact_rate}% contact, ${pf.conversion_rate}% conversion)` : ''}` };
}

/** Gives a lead to someone, keeps the reassignment history and tells the new owner. */
export async function assignLead(c: Client, lead: Lead, to: { user_id: string; name: string } | null, method: 'auto' | 'sticky' | 'manual' | 'reassign' | 'unassigned' | 'override' | 'bulk' | 'rebalance' | 'sla' | 'revive' | 'agent', p: { rule?: string | null; reason?: string | null; by: string; trace?: unknown; suggested?: string | null }) {
  await c.query(`
    UPDATE leads SET owner_id = $2, owner_name = $3, assigned_at = CASE WHEN $2::uuid IS NULL THEN assigned_at ELSE now() END,
      stage = CASE WHEN stage = 'new' AND $2::uuid IS NOT NULL THEN 'assigned' ELSE stage END,
      allocation_trace = coalesce($4, allocation_trace), updated_at = now(), version = version + 1 WHERE id = $1`,
    [lead.id, to?.user_id ?? null, to?.name ?? null, p.trace ? JSON.stringify(p.trace) : null]);
  await c.query(`INSERT INTO lead_assignments (lead_id, from_user, from_name, to_user, to_name, method, rule_name, reason, by_name, suggested_name) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [lead.id, lead.owner_id, lead.owner_name, to?.user_id ?? null, to?.name ?? null, method, p.rule ?? null, p.reason ?? null, p.by, p.suggested ?? null]);
  if (to) {
    await c.query('UPDATE sales_team SET last_assigned_at = now() WHERE user_id = $1', [to.user_id]);
    await c.query(`INSERT INTO lead_activities (lead_id, kind, summary, by_name) VALUES ($1, 'assignment', $2, $3)`, [lead.id, `Assigned to ${to.name} (${method}${p.rule ? `, ${p.rule}` : ''})${p.reason ? `: ${p.reason}` : ''}`, p.by]);
    await notify(c, S, { user_id: to.user_id, kind: 'action', title: `New lead ${lead.number}: ${lead.name}${lead.company ? `, ${lead.company}` : ''}`, body: lead.message?.slice(0, 160) ?? null, link: `/crm/leads/${lead.id}` });
    await resolveException(c, 'unassigned_lead', lead.id, `Assigned to ${to.name}`);
  }
}

export async function autoAssign(c: Client, lead: Lead, by: string, o: { method?: 'auto' | 'bulk' | 'rebalance' | 'sla' | 'revive'; exclude_user_id?: string | null; reason?: string } = {}) {
  const d = await decide(c, { ...lead, exclude_lead_id: lead.id, exclude_user_id: o.exclude_user_id ?? null });
  const trace = { at: new Date().toISOString(), method: d.method, rule: d.rule, note: d.note, candidates: d.trace, chosen: d.owner?.name ?? null };
  if (d.owner) await assignLead(c, lead, { user_id: d.owner.user_id, name: d.owner.name }, d.method === 'auto' && o.method ? o.method : d.method, { rule: d.rule, reason: o.reason ? `${o.reason}. ${d.note}` : d.note, by, trace });
  else {
    await c.query('UPDATE leads SET allocation_trace = $2 WHERE id = $1', [lead.id, JSON.stringify(trace)]);
    await c.query(`INSERT INTO lead_assignments (lead_id, method, rule_name, reason, by_name) VALUES ($1, 'unassigned', $2, $3, $4)`, [lead.id, d.rule, d.note, by]);
    await raiseException(c, { kind: 'unassigned_lead', severity: 'warning', ref_type: 'lead', ref_id: lead.id, ref_label: `${lead.number} · ${lead.name}`, message: `${lead.number} could not be assigned: ${d.note}`, notifyPermission: 'crm.lead.assign', link: `/crm/leads/${lead.id}` });
  }
  return d;
}

const memberBody = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  cities: z.array(z.string().trim().max(60)).max(50).default([]),
  states: z.array(z.string().trim().max(2)).max(40).default([]),
  categories: z.array(z.string().trim().max(60)).max(30).default([]),
  sources: z.array(z.string().trim().max(24)).max(20).default([]),
  languages: z.array(z.string().trim().max(30)).max(10).default([]),
  specialisations: z.array(z.string().trim().max(60)).max(10).default([]),
  min_value: z.number().nonnegative().nullable().optional(),
  max_value: z.number().nonnegative().nullable().optional(),
  max_active_leads: z.number().int().positive().nullable().optional(),
  max_discount_pct: z.number().min(0).max(100).nullable().optional(),
  weekly_off: z.array(z.number().int().min(0).max(6)).max(7).default([0]),
  active: z.boolean().default(true),
});
const conditionsBody = z.object({
  cities: z.array(z.string().trim().max(60)).max(50).optional(), states: z.array(z.string().trim().max(2)).max(40).optional(),
  sources: z.array(z.string().trim().max(24)).max(20).optional(), categories: z.array(z.string().trim().max(60)).max(30).optional(),
  languages: z.array(z.string().trim().max(30)).max(10).optional(), min_value: z.number().nonnegative().nullable().optional(), max_value: z.number().nonnegative().nullable().optional(),
});
const ruleBody = z.object({
  name: z.string().trim().min(2).max(120), priority: z.number().int().min(1).max(10000).default(100), conditions: conditionsBody.default({}),
  strategy: z.enum(['round_robin', 'least_loaded', 'best_performer']).default('round_robin'), member_ids: z.array(z.uuid()).min(1, 'Choose at least one salesperson').max(50),
  status: z.enum(['active', 'inactive']).default('active'),
});
const sourceBody = z.object({
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9_]{2,24}$/, 'Use 2–24 capital letters, digits or _'),
  name: z.string().trim().min(2).max(120),
  kind: z.enum(['meta', 'indiamart', 'justdial', 'website', 'whatsapp', 'phone', 'email', 'referral', 'exhibition', 'trade_platform', 'manual', 'api', 'csv']),
  field_map: z.record(z.string(), z.string().max(120)).default({}),
  status: z.enum(['active', 'inactive']).default('active'),
});

export function allocationRoutes(r: Router, { pool }: ServiceContext) {
  r.get('/team', requirePermission('crm.read'), async (_req, res) => {
    const members = await many<Member & Record<string, unknown>>(pool, 'SELECT * FROM sales_team ORDER BY active DESC, name');
    const avail = await availability(pool, members);
    const att = await many<{ user_id: string; status: string; on_break: boolean; note: string | null }>(pool, 'SELECT * FROM attendance WHERE day = current_date');
    const perf = await performanceOf(pool, members.map((m) => m.user_id), Number((await crmSettings(pool)).performance_window_days));
    res.json(avail.map((a) => ({ ...a.member, available: a.eligible, availability: a.reason, active_leads: a.active_leads, attendance: att.find((x) => x.user_id === a.member.user_id) ?? null, performance: perf.get(a.member.user_id) })));
  });

  /** People who could join the sales team (internal users not yet in it). */
  r.get('/team/candidates', requirePermission('crm.config.manage'), async (_req, res) => {
    const dir = await getDirectory();
    const inTeam = new Set((await many<{ user_id: string }>(pool, 'SELECT user_id FROM sales_team')).map((m) => m.user_id));
    res.json(dir.filter((u) => u.status === 'active' && !u.party_id && !inTeam.has(u.id)));
  });

  r.put('/team/:userId', requirePermission('crm.config.manage'), async (req, res) => {
    const b = parse(memberBody, req.body);
    const user = (await getDirectory()).find((u) => u.id === req.params.userId);
    if (!user) throw notFound('User');
    const out = await tx(pool, async (c) => {
      const before = await one(c, 'SELECT * FROM sales_team WHERE user_id = $1', [user.id]);
      const row = await one(c, `
        INSERT INTO sales_team (user_id, name, email, cities, states, categories, sources, languages, specialisations, min_value, max_value, max_active_leads, max_discount_pct, weekly_off, active)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
        ON CONFLICT (user_id) DO UPDATE SET name = EXCLUDED.name, cities = EXCLUDED.cities, states = EXCLUDED.states, categories = EXCLUDED.categories, sources = EXCLUDED.sources,
          languages = EXCLUDED.languages, specialisations = EXCLUDED.specialisations, min_value = EXCLUDED.min_value, max_value = EXCLUDED.max_value, max_active_leads = EXCLUDED.max_active_leads,
          max_discount_pct = EXCLUDED.max_discount_pct, weekly_off = EXCLUDED.weekly_off, active = EXCLUDED.active, updated_at = now() RETURNING *`,
        [user.id, b.name ?? user.name, user.email, b.cities, b.states, b.categories, b.sources.map((s) => s.toUpperCase()), b.languages, b.specialisations, b.min_value ?? null, b.max_value ?? null, b.max_active_leads ?? null, b.max_discount_pct ?? null, b.weekly_off, b.active]);
      await auditReq(c, req, 'sales_team', user.id, before ? 'updated' : 'added', { before, after: b });
      return row;
    });
    res.json(out);
  });

  r.get('/attendance', requirePermission('crm.read'), async (req, res) => {
    const day = (req.query.day as string) || today();
    res.json(await many(pool, `
      SELECT m.user_id, m.name, m.weekly_off, a.status, a.on_break, a.note, a.recorded_by_name, a.recorded_at,
        coalesce(a.status, CASE WHEN extract(dow FROM $1::date)::int = ANY(m.weekly_off) THEN 'weekly_off' ELSE 'present' END) AS effective_status
      FROM sales_team m LEFT JOIN attendance a ON a.user_id = m.user_id AND a.day = $1::date WHERE m.active ORDER BY m.name`, [day]));
  });

  r.put('/attendance', requirePermission('crm.config.manage'), async (req, res) => {
    const b = parse(z.object({ user_id: z.uuid(), day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), status: z.enum(['present', 'absent', 'leave', 'weekly_off', 'half_day']), on_break: z.boolean().default(false), note: optText(300) }), req.body);
    await tx(pool, async (c) => {
      if (!(await one(c, 'SELECT 1 FROM sales_team WHERE user_id = $1', [b.user_id]))) throw badRequest('Add this person to the sales team first');
      await c.query(`
        INSERT INTO attendance (user_id, day, status, on_break, note, recorded_by_name) VALUES ($1,$2,$3,$4,$5,$6)
        ON CONFLICT (user_id, day) DO UPDATE SET status = EXCLUDED.status, on_break = EXCLUDED.on_break, note = EXCLUDED.note, recorded_by_name = EXCLUDED.recorded_by_name, recorded_at = now()`,
        [b.user_id, b.day, b.status, b.on_break, b.note ?? null, req.user!.name]);
      await auditReq(c, req, 'attendance', b.user_id, 'marked', { after: b });
    });
    res.json({ ok: true });
  });

  r.get('/rules', requirePermission('crm.read'), async (_req, res) => {
    res.json(await many(pool, `SELECT r.*, (SELECT array_agg(name ORDER BY name) FROM sales_team WHERE user_id = ANY(r.member_ids)) AS member_names FROM allocation_rules r ORDER BY r.status, r.priority, r.created_at`));
  });
  r.post('/rules', requirePermission('crm.config.manage'), async (req, res) => {
    const b = parse(ruleBody, req.body);
    const out = await tx(pool, async (c) => {
      const row = await one<{ id: string }>(c, `INSERT INTO allocation_rules (name, priority, conditions, strategy, member_ids, status) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`, [b.name, b.priority, JSON.stringify(b.conditions), b.strategy, b.member_ids, b.status]);
      await auditReq(c, req, 'allocation_rule', row!.id, 'created', { after: b });
      return row;
    });
    res.status(201).json(out);
  });
  r.patch('/rules/:id', requirePermission('crm.config.manage'), async (req, res) => {
    const b = parse(ruleBody, req.body);
    const out = await tx(pool, async (c) => {
      const before = await one(c, 'SELECT * FROM allocation_rules WHERE id = $1 FOR UPDATE', [req.params.id]);
      if (!before) throw notFound('Rule');
      const row = await one(c, `UPDATE allocation_rules SET name = $2, priority = $3, conditions = $4, strategy = $5, member_ids = $6, status = $7, updated_at = now() WHERE id = $1 RETURNING *`, [req.params.id, b.name, b.priority, JSON.stringify(b.conditions), b.strategy, b.member_ids, b.status]);
      await auditReq(c, req, 'allocation_rule', String(req.params.id), 'updated', { before, after: b });
      return row;
    });
    res.json(out);
  });

  /** Dry run: who would get a lead like this, and why everyone else was skipped. */
  r.post('/allocation/preview', requirePermission('crm.read'), async (req, res) => {
    const b = parse(z.object({ city: optText(60), state_code: optText(2), source_code: z.string().default('MANUAL'), category: optText(60), language: optText(30), est_value: z.number().nonnegative().nullable().optional(), mobile: optText(20), email: optText(120), gstin: optText(15) }), req.body);
    const d = await decide(pool, { city: b.city ?? null, state_code: b.state_code ?? null, source_code: b.source_code, category: b.category ?? null, language: b.language ?? null, est_value: b.est_value ?? null, mobile: normMobile(b.mobile), email: normEmail(b.email), gstin: normGstin(b.gstin) });
    res.json({ owner: d.owner ? { user_id: d.owner.user_id, name: d.owner.name } : null, method: d.method, rule: d.rule, note: d.note, candidates: d.trace });
  });

  r.get('/sources', requirePermission('crm.read'), async (req: Request, res) => {
    const rows = await many<Record<string, unknown>>(pool, 'SELECT * FROM lead_sources ORDER BY status, name');
    const manage = req.user!.permissions.includes('crm.config.manage') || req.user!.permissions.includes('*');
    res.json(rows.map((s) => ({ ...s, webhook_key: manage ? s.webhook_key : undefined, webhook_path: manage ? `/api/crm/public/leads/${s.webhook_key}` : undefined })));
  });
  r.post('/sources', requirePermission('crm.config.manage'), async (req, res) => {
    const b = parse(sourceBody, req.body);
    const out = await tx(pool, async (c) => {
      const row = await one<{ id: string }>(c, `INSERT INTO lead_sources (code, name, kind, field_map, status) VALUES ($1,$2,$3,$4,$5) RETURNING *`, [b.code, b.name, b.kind, JSON.stringify(b.field_map), b.status]);
      await auditReq(c, req, 'lead_source', row!.id, 'created', { after: b });
      return row;
    });
    res.status(201).json(out);
  });
  r.patch('/sources/:id', requirePermission('crm.config.manage'), async (req, res) => {
    const b = parse(sourceBody.omit({ code: true }), req.body);
    const out = await tx(pool, async (c) => {
      const row = await one(c, `UPDATE lead_sources SET name = $2, kind = $3, field_map = $4, status = $5 WHERE id = $1 RETURNING *`, [req.params.id, b.name, b.kind, JSON.stringify(b.field_map), b.status]);
      if (!row) throw notFound('Source');
      await auditReq(c, req, 'lead_source', String(req.params.id), 'updated', { after: b });
      return row;
    });
    res.json(out);
  });
  r.post('/sources/:id/rotate-key', requirePermission('crm.config.manage'), async (req, res) => {
    const out = await tx(pool, async (c) => {
      const row = await one(c, `UPDATE lead_sources SET webhook_key = replace(gen_random_uuid()::text, '-', '') WHERE id = $1 RETURNING id, webhook_key`, [req.params.id]);
      if (!row) throw notFound('Source');
      await auditReq(c, req, 'lead_source', String(req.params.id), 'key_rotated');
      return row;
    });
    res.json(out);
  });
}

export { S };
