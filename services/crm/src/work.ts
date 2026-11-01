import type { Request, Router } from 'express';
import { z } from 'zod';
import { type Client, type ServiceContext, badRequest, conflict, hasPermission, many, notFound, notify, one, optText, parse, reqText, requirePermission, tx } from '@erp/platform';
import { S, type Lead, assertOwnerOrAll, auditReq, leadOrThrow, nextNumber, raiseException, resolveException, seesAll, userId } from './common.ts';
import { assignLead, autoAssign, decide } from './allocation.ts';
import { crmSettings } from './settings.ts';
import { rescore } from './score.ts';

export const CALL_OUTCOMES = ['connected', 'no_answer', 'busy', 'switched_off', 'call_back', 'not_interested', 'wrong_number'] as const;
const ORDER = ['new', 'assigned', 'contact_pending', 'contacted', 'qualified', 'quotation', 'negotiation', 'order_confirmed', 'won'];
export const isForward = (from: string, to: string) => ORDER.indexOf(to) > ORDER.indexOf(from) && ORDER.indexOf(to) > ORDER.indexOf('contacted');

/** Real progress (a stage forward, a positive sample or visit) resets the "many calls, no progress" count. */
export async function markProgress(c: Client, leadId: string, why: string) {
  await c.query('UPDATE leads SET attempts_since_progress = 0, no_progress = false WHERE id = $1', [leadId]);
  await resolveException(c, 'no_progress', leadId, why);
}

/** One more attempt on the lead; past the limit in Lead settings it is flagged and the manager told. */
export async function countAttempt(c: Client, lead: Lead, connected: boolean) {
  const limit = Number((await crmSettings(c)).no_progress_attempts);
  const row = await one<{ attempts_since_progress: number; no_progress: boolean }>(c, `
    UPDATE leads SET call_attempts = call_attempts + 1, connected_calls = connected_calls + $2::int, attempts_since_progress = attempts_since_progress + 1,
      last_contact_at = now(), first_response_at = coalesce(first_response_at, now()),
      first_connected_at = CASE WHEN $3 THEN coalesce(first_connected_at, now()) ELSE first_connected_at END,
      stage = CASE WHEN stage IN ('new','assigned','contact_pending') THEN 'contacted' ELSE stage END,
      no_progress = no_progress OR attempts_since_progress + 1 >= $4, updated_at = now(), version = version + 1
    WHERE id = $1 RETURNING attempts_since_progress, no_progress`, [lead.id, connected ? 1 : 0, connected, limit]);
  await resolveException(c, 'first_response_breach', lead.id, 'Called');
  if (row!.no_progress)
    await raiseException(c, { kind: 'no_progress', severity: 'warning', ref_type: 'lead', ref_id: lead.id, ref_label: `${lead.number} · ${lead.name}`, message: `${lead.number}: ${row!.attempts_since_progress} calls with no progress${lead.owner_name ? ` (${lead.owner_name})` : ''}`, notifyPermission: 'crm.lead.assign', notifyUser: lead.owner_id, link: `/crm/leads/${lead.id}` });
  return row!;
}

/** Closes a lead as lost with one of the standard objections. */
export async function closeLost(c: Client, req: Request, lead: Lead, objection: string, note: string | null) {
  const objections = (await crmSettings(c)).objections as string[];
  if (!objections.includes(objection)) throw badRequest('Choose one of the objections in Lead settings', { fields: { objection: 'Not in the list' } });
  if (objection === 'Other' && !note) throw badRequest('Say what the objection was', { fields: { note: 'Required for “Other”' } });
  const reason = note ? `${objection}: ${note}` : objection;
  await c.query(`UPDATE leads SET stage = 'lost', status = 'closed', lost_reason = $2, objection = $3, next_action_at = NULL, closed_at = now(), updated_at = now(), version = version + 1 WHERE id = $1`, [lead.id, reason, objection]);
  await c.query(`INSERT INTO lead_activities (lead_id, kind, summary, outcome, by_user, by_name) VALUES ($1, 'stage', $2, $3, $4, $5)`, [lead.id, `${lead.stage.replace(/_/g, ' ')} → lost`, reason, userId(req), req.user!.name]);
  for (const k of ['followup_overdue', 'first_response_breach', 'no_progress']) await resolveException(c, k, lead.id, 'Lead lost');
}

const callBody = z.object({
  outcome: z.enum(CALL_OUTCOMES),
  duration_sec: z.number().int().min(0).max(36_000).nullable().optional(),
  notes: optText(1000),
  next_action_at: z.iso.datetime({ offset: true }).nullable().optional(),
  next_action: optText(200),
  objection: optText(60),
  stage: z.enum(['contacted', 'qualified']).optional(),
});

const reviveFilter = z.object({
  lead_ids: z.array(z.uuid()).max(500).optional(),
  objection: optText(60),
  owner_id: z.uuid().optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  source: optText(24),
});

async function lostLeads(c: Client | ServiceContext['pool'], f: z.infer<typeof reviveFilter>) {
  const p: unknown[] = []; const w = [`l.stage = 'lost'`, `l.status = 'closed'`];
  if (f.lead_ids?.length) { p.push(f.lead_ids); w.push(`l.id = ANY($${p.length})`); }
  if (f.objection) { p.push(f.objection); w.push(`l.objection = $${p.length}`); }
  if (f.owner_id) { p.push(f.owner_id); w.push(`l.owner_id = $${p.length}`); }
  if (f.source) { p.push(f.source); w.push(`l.source_code = $${p.length}`); }
  if (f.from) { p.push(f.from); w.push(`l.closed_at >= $${p.length}::date`); }
  if (f.to) { p.push(f.to); w.push(`l.closed_at < $${p.length}::date + 1`); }
  return many<Lead & { objection: string | null; closed_at: string; revived_count: number; source_name: string }>(c, `
    SELECT l.*, s.name AS source_name FROM leads l JOIN lead_sources s ON s.id = l.source_id WHERE ${w.join(' AND ')} ORDER BY l.closed_at DESC LIMIT 500`, p);
}

class Preview extends Error { plan: unknown; constructor(plan: unknown) { super('preview'); this.plan = plan; } }
/** Runs the change inside a transaction and rolls it back, returning what would have happened. */
async function dryRun<T>(pool: ServiceContext['pool'], f: (c: Client) => Promise<T>): Promise<T> {
  try { await tx(pool, async (c) => { throw new Preview(await f(c)); }); } catch (e) { if (e instanceof Preview) return e.plan as T; throw e; }
  throw new Error('unreachable');
}

export function workRoutes(r: Router, { pool }: ServiceContext) {
  // ---------- structured call logging ----------
  r.post('/leads/:id/calls', requirePermission('crm.lead.manage'), async (req, res) => {
    const b = parse(callBody, req.body);
    const out = await tx(pool, async (c) => {
      const lead = await leadOrThrow(c, String(req.params.id), true);
      assertOwnerOrAll(req, lead.owner_id);
      if (lead.status !== 'open') throw conflict(`This lead is ${lead.status}`);
      if (!lead.owner_id) throw conflict('Assign the lead before working it');
      const closing = b.outcome === 'wrong_number' || b.outcome === 'not_interested';
      if (b.outcome === 'not_interested' && !b.objection) throw badRequest('Choose the main objection', { fields: { objection: 'Required when the customer is not interested' } });
      if (!closing && !b.next_action_at) throw badRequest('Set the next follow-up', { fields: { next_action_at: 'Required unless the lead is closing' } });
      if (b.next_action_at && new Date(b.next_action_at) < new Date(Date.now() - 60_000)) throw badRequest('The next follow-up cannot be in the past', { fields: { next_action_at: 'Choose a future time' } });
      const label = { connected: 'Connected', no_answer: 'No answer', busy: 'Busy', switched_off: 'Switched off', call_back: 'Asked to call back', not_interested: 'Not interested', wrong_number: 'Wrong number' }[b.outcome];
      await c.query(`INSERT INTO lead_activities (lead_id, kind, summary, outcome, call_outcome, duration_sec, by_user, by_name) VALUES ($1, 'call', $2, $3, $4, $5, $6, $7)`,
        [lead.id, b.notes ? `${label}: ${b.notes}` : label, label, b.outcome, b.duration_sec ?? null, userId(req), req.user!.name]);
      const n = await countAttempt(c, lead, b.outcome === 'connected');
      if (b.outcome === 'wrong_number') await closeLost(c, req, lead, 'Invalid contact', 'Wrong number');
      else if (b.outcome === 'not_interested') await closeLost(c, req, lead, b.objection!, b.notes ?? null);
      else {
        await c.query(`UPDATE leads SET next_action_at = $2, next_action = coalesce($3, next_action), updated_at = now() WHERE id = $1`, [lead.id, b.next_action_at, b.next_action ?? null]);
        await resolveException(c, 'followup_overdue', lead.id, 'Follow-up scheduled');
        if (b.stage === 'qualified' && b.outcome === 'connected' && ['contacted', 'new', 'assigned', 'contact_pending'].includes(lead.stage)) {
          await c.query(`UPDATE leads SET stage = 'qualified' WHERE id = $1`, [lead.id]);
          await c.query(`INSERT INTO lead_activities (lead_id, kind, summary, by_user, by_name) VALUES ($1, 'stage', 'contacted → qualified', $2, $3)`, [lead.id, userId(req), req.user!.name]);
          await markProgress(c, lead.id, 'Qualified');
        }
      }
      await rescore(c, [lead.id]);
      return { attempts_since_progress: closing ? 0 : n.attempts_since_progress, no_progress: closing ? false : n.no_progress, closed: closing };
    });
    res.status(201).json(out);
  });

  // ---------- samples and showroom visits ----------
  r.post('/leads/:id/engagements', requirePermission('crm.lead.manage'), async (req, res) => {
    const b = parse(z.object({
      kind: z.enum(['sample', 'visit']), items: reqText(500), qty_kg: z.number().min(0).nullable().optional(), courier: optText(80), tracking_no: optText(60),
      scheduled_at: z.iso.datetime({ offset: true }).nullable().optional(), host_name: optText(120),
    }), req.body);
    const out = await tx(pool, async (c) => {
      const lead = await leadOrThrow(c, String(req.params.id), true);
      assertOwnerOrAll(req, lead.owner_id);
      if (lead.status !== 'open') throw conflict(`This lead is ${lead.status}`);
      if (b.kind === 'visit' && !b.scheduled_at) throw badRequest('Choose the date and time of the visit', { fields: { scheduled_at: 'Required' } });
      const number = await nextNumber(c, b.kind === 'sample' ? 'lead_sample' : 'lead_visit', b.kind === 'sample' ? 'SMP-' : 'VIS-');
      const status = b.kind === 'visit' ? 'scheduled' : b.courier || b.tracking_no ? 'dispatched' : 'requested';
      const e = await one<{ id: string }>(c, `INSERT INTO lead_engagements (number, lead_id, kind, items, qty_kg, courier, tracking_no, scheduled_at, host_name, status, owner_id, owner_name, created_by_name)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
        [number, lead.id, b.kind, b.items, b.qty_kg ?? null, b.courier ?? null, b.tracking_no ?? null, b.scheduled_at ?? null, b.host_name ?? null, status, lead.owner_id, lead.owner_name, req.user!.name]);
      await c.query(`INSERT INTO lead_activities (lead_id, kind, summary, by_user, by_name) VALUES ($1, $2, $3, $4, $5)`,
        [lead.id, b.kind, b.kind === 'sample' ? `Sample ${number}: ${b.items}${b.courier ? ` by ${b.courier}${b.tracking_no ? ` (${b.tracking_no})` : ''}` : ''}` : `Showroom visit ${number} booked for ${new Date(b.scheduled_at!).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' })}${b.host_name ? `, hosted by ${b.host_name}` : ''}`, userId(req), req.user!.name]);
      await c.query(`UPDATE leads SET last_contact_at = now(), first_response_at = coalesce(first_response_at, now()), stage = CASE WHEN stage IN ('new','assigned','contact_pending') THEN 'contacted' ELSE stage END, updated_at = now() WHERE id = $1`, [lead.id]);
      await auditReq(c, req, 'lead_engagement', e!.id, 'created', { after: { number, ...b } });
      return { id: e!.id, number };
    });
    res.status(201).json(out);
  });

  r.post('/engagements/:id/status', requirePermission('crm.lead.manage'), async (req, res) => {
    const b = parse(z.object({ status: z.enum(['dispatched', 'delivered', 'held', 'cancelled', 'no_show', 'scheduled']), courier: optText(80), tracking_no: optText(60), scheduled_at: z.iso.datetime({ offset: true }).nullable().optional(), note: optText(300) }), req.body);
    await tx(pool, async (c) => {
      const e = await one<{ id: string; lead_id: string; number: string; kind: string; status: string }>(c, 'SELECT * FROM lead_engagements WHERE id = $1 FOR UPDATE', [req.params.id]);
      if (!e) throw notFound('Sample or visit');
      const lead = await leadOrThrow(c, e.lead_id);
      assertOwnerOrAll(req, lead.owner_id);
      if (['cancelled'].includes(e.status)) throw conflict('This is cancelled');
      await c.query(`UPDATE lead_engagements SET status = $2, courier = coalesce($3, courier), tracking_no = coalesce($4, tracking_no), scheduled_at = coalesce($5, scheduled_at), updated_at = now() WHERE id = $1`, [e.id, b.status, b.courier ?? null, b.tracking_no ?? null, b.scheduled_at ?? null]);
      await c.query(`INSERT INTO lead_activities (lead_id, kind, summary, by_user, by_name) VALUES ($1, $2, $3, $4, $5)`, [e.lead_id, e.kind, `${e.number}: ${b.status.replace(/_/g, ' ')}${b.note ? ` — ${b.note}` : ''}`, userId(req), req.user!.name]);
    });
    res.json({ ok: true });
  });

  /** The customer's response. Not interested can close the lead (with an objection) or park it. */
  r.post('/engagements/:id/outcome', requirePermission('crm.lead.manage'), async (req, res) => {
    const b = parse(z.object({ outcome: z.enum(['very_interested', 'interested', 'needs_changes', 'not_interested']), note: optText(500), close_lead: z.boolean().default(false), objection: optText(60), next_action_at: z.iso.datetime({ offset: true }).nullable().optional() }), req.body);
    await tx(pool, async (c) => {
      const e = await one<{ id: string; lead_id: string; number: string; kind: string; status: string }>(c, 'SELECT * FROM lead_engagements WHERE id = $1 FOR UPDATE', [req.params.id]);
      if (!e) throw notFound('Sample or visit');
      const lead = await leadOrThrow(c, e.lead_id, true);
      assertOwnerOrAll(req, lead.owner_id);
      await c.query(`UPDATE lead_engagements SET outcome = $2, outcome_note = $3, outcome_at = now(), status = CASE WHEN kind = 'visit' AND status = 'scheduled' THEN 'delivered' WHEN kind = 'sample' AND status IN ('requested','dispatched') THEN 'delivered' ELSE status END, updated_at = now() WHERE id = $1`, [e.id, b.outcome, b.note ?? null]);
      const label = { very_interested: 'Very interested', interested: 'Interested', needs_changes: 'Needs changes', not_interested: 'Not interested' }[b.outcome];
      await c.query(`INSERT INTO lead_activities (lead_id, kind, summary, outcome, by_user, by_name) VALUES ($1, $2, $3, $4, $5, $6)`, [e.lead_id, e.kind, `${e.number} feedback: ${label}`, b.note ?? null, userId(req), req.user!.name]);
      if (['very_interested', 'interested'].includes(b.outcome)) await markProgress(c, lead.id, `${label} after ${e.kind}`);
      if (b.outcome === 'not_interested' && b.close_lead && lead.status === 'open') {
        if (!b.objection) throw badRequest('Choose the main objection to close the lead', { fields: { objection: 'Required' } });
        await closeLost(c, req, lead, b.objection, b.note ?? null);
      } else if (b.next_action_at && lead.status === 'open') await c.query('UPDATE leads SET next_action_at = $2 WHERE id = $1', [lead.id, b.next_action_at]);
      await rescore(c, [lead.id]);
    });
    res.json({ ok: true });
  });

  r.get('/engagements', requirePermission('crm.read'), async (req, res) => {
    const p: unknown[] = []; const w = ['true'];
    if (!seesAll(req)) { p.push(req.user!.id); w.push(`e.owner_id = $${p.length}`); }
    if (req.query.lead) { p.push(req.query.lead); w.push(`e.lead_id = $${p.length}`); }
    if (req.query.pending === '1') w.push(`e.outcome IS NULL AND e.status NOT IN ('cancelled','no_show')`);
    res.json(await many(pool, `SELECT e.*, l.number AS lead_number, l.name AS lead_name, l.company FROM lead_engagements e JOIN leads l ON l.id = e.lead_id WHERE ${w.join(' AND ')} ORDER BY coalesce(e.scheduled_at, e.created_at) DESC LIMIT 300`, p));
  });

  // ---------- reviving lost leads: selected, all matching, or by objection ----------
  r.post('/leads/revive/preview', requirePermission('crm.lead.assign'), async (req, res) => {
    const f = parse(reviveFilter, req.body);
    const rows = await lostLeads(pool, f);
    res.json({ count: rows.length, leads: rows.map((l) => ({ id: l.id, number: l.number, name: l.name, company: l.company, objection: l.objection, lost_reason: l.lost_reason, owner_name: l.owner_name, closed_at: l.closed_at, revived_count: l.revived_count, source_name: l.source_name, est_value: l.est_value })) });
  });
  r.post('/leads/revive', requirePermission('crm.lead.assign'), async (req, res) => {
    const b = parse(reviveFilter.extend({ assign: z.enum(['previous', 'auto', 'user']).default('previous'), user_id: z.uuid().optional(), note: reqText(300), next_action_at: z.iso.datetime({ offset: true }).nullable().optional() }), req.body);
    if (!b.lead_ids?.length && !b.objection && !b.from && !b.owner_id && !b.source) throw badRequest('Choose leads, or filter by objection, date, salesperson or source');
    if (b.assign === 'user' && !b.user_id) throw badRequest('Choose the salesperson', { fields: { user_id: 'Required' } });
    const rows = await lostLeads(pool, b);
    if (!rows.length) throw badRequest('No lost leads match');
    const out = { revived: 0, unassigned: 0, numbers: [] as string[] };
    for (const l of rows) {
      await tx(pool, async (c) => {
        const lead = await leadOrThrow(c, l.id, true);
        if (lead.stage !== 'lost') return;
        const next = b.next_action_at ?? new Date(Date.now() + 60 * 60_000).toISOString();
        await c.query(`UPDATE leads SET stage = 'contact_pending', status = 'open', closed_at = NULL, lost_reason = NULL, objection = NULL, next_action_at = $2, next_action = 'Call again (revived)',
            attempts_since_progress = 0, no_progress = false, revived_count = revived_count + 1, last_revived_at = now(), sla_reassigned = false, assigned_at = now(), first_response_at = NULL, updated_at = now(), version = version + 1 WHERE id = $1`, [lead.id, next]);
        await c.query(`INSERT INTO lead_activities (lead_id, kind, summary, outcome, by_user, by_name) VALUES ($1, 'revive', $2, $3, $4, $5)`, [lead.id, `Revived for calling again (was lost: ${l.lost_reason ?? l.objection ?? 'no reason'})`, b.note, userId(req), req.user!.name]);
        const fresh = await leadOrThrow(c, lead.id);
        let owner: string | null = null;
        if (b.assign === 'user') {
          const m = await one<{ user_id: string; name: string; active: boolean }>(c, 'SELECT user_id, name, active FROM sales_team WHERE user_id = $1', [b.user_id]);
          if (!m?.active) throw badRequest('That person is not an active member of the sales team');
          await assignLead(c, fresh, m, 'revive', { reason: b.note, by: req.user!.name }); owner = m.name;
        } else if (b.assign === 'previous' && lead.owner_id && (await one(c, 'SELECT 1 FROM sales_team WHERE user_id = $1 AND active', [lead.owner_id]))) {
          await c.query(`INSERT INTO lead_assignments (lead_id, from_user, from_name, to_user, to_name, method, reason, by_name) VALUES ($1,$2,$3,$2,$3,'revive',$4,$5)`, [lead.id, lead.owner_id, lead.owner_name, b.note, req.user!.name]);
          await notify(c, S, { user_id: lead.owner_id, kind: 'action', title: `Lead ${lead.number} revived: call ${lead.name} again`, body: b.note, link: `/crm/leads/${lead.id}` });
          owner = lead.owner_name;
        } else {
          await c.query('UPDATE leads SET owner_id = NULL, owner_name = NULL WHERE id = $1', [lead.id]);
          owner = (await autoAssign(c, { ...fresh, owner_id: null, owner_name: null }, req.user!.name, { method: 'revive', reason: 'Revived' })).owner?.name ?? null;
        }
        await rescore(c, [lead.id]);
        await auditReq(c, req, 'lead', lead.id, 'revived', { before: { stage: 'lost', reason: l.lost_reason }, after: { stage: 'contact_pending', owner }, reason: b.note });
        out.revived++; if (!owner) out.unassigned++; out.numbers.push(lead.number);
      });
    }
    res.json(out);
  });

  // ---------- assignment: engine suggestion, manual override, bulk and rebalance ----------
  r.get('/leads/:id/suggestion', requirePermission('crm.lead.assign'), async (req, res) => {
    const lead = await leadOrThrow(pool, String(req.params.id));
    const d = await decide(pool, { ...lead, exclude_lead_id: lead.id, exclude_user_id: lead.owner_id });
    res.json({ owner: d.owner ? { user_id: d.owner.user_id, name: d.owner.name } : null, method: d.method, rule: d.rule, note: d.note, candidates: d.trace });
  });

  r.post('/leads/bulk-assign', requirePermission('crm.lead.assign'), async (req, res) => {
    const b = parse(z.object({ lead_ids: z.array(z.uuid()).min(1).max(300), user_id: z.uuid().optional(), auto: z.boolean().default(false), reason: reqText(300) }), req.body);
    if (!b.auto && !b.user_id) throw badRequest('Choose a salesperson, or assign automatically');
    const m = b.user_id ? await one<{ user_id: string; name: string; active: boolean }>(pool, 'SELECT user_id, name, active FROM sales_team WHERE user_id = $1', [b.user_id]) : null;
    if (b.user_id && !m?.active) throw badRequest('That person is not an active member of the sales team');
    // Hot leads first, so the best leads get the best-placed people while capacity lasts.
    const leads = await many<Lead>(pool, `SELECT * FROM leads WHERE id = ANY($1) AND status = 'open' ORDER BY score DESC NULLS LAST, created_at`, [b.lead_ids]);
    const out = { assigned: 0, unchanged: 0, unassigned: 0, skipped: b.lead_ids.length - leads.length };
    for (const l of leads) {
      await tx(pool, async (c) => {
        const lead = await leadOrThrow(c, l.id, true);
        if (m) {
          if (lead.owner_id === m.user_id) { out.unchanged++; return; }
          await assignLead(c, lead, m, 'bulk', { reason: b.reason, by: req.user!.name });
          out.assigned++;
        } else {
          const d = await autoAssign(c, lead, req.user!.name, { method: 'bulk', exclude_user_id: null, reason: b.reason });
          if (d.owner) out.assigned++; else out.unassigned++;
        }
        await auditReq(c, req, 'lead', lead.id, 'bulk_assigned', { before: { owner: lead.owner_name }, after: { owner: m?.name ?? 'auto' }, reason: b.reason });
      });
    }
    res.json(out);
  });

  /**
   * Shares out unassigned leads and leads held by people who are inactive, or absent / on leave today with the lead
   * not yet called or due today. Hot first; caps are respected. preview=true shows the plan without changing anything.
   */
  r.post('/leads/rebalance', requirePermission('crm.lead.assign'), async (req, res) => {
    const b = parse(z.object({ preview: z.boolean().default(true), reason: optText(300) }), req.body);
    const candidates = await many<Lead & { why: string }>(pool, `
      SELECT l.*, CASE WHEN l.owner_id IS NULL THEN 'Unassigned' WHEN NOT m.active THEN 'Owner inactive' ELSE 'Owner ' || replace(a.status, '_', ' ') || ' today' END AS why
      FROM leads l LEFT JOIN sales_team m ON m.user_id = l.owner_id LEFT JOIN attendance a ON a.user_id = l.owner_id AND a.day = current_date
      WHERE l.status = 'open' AND l.stage <> 'nurture' AND (l.owner_id IS NULL OR m.active = false OR m.user_id IS NULL
        OR (a.status IN ('absent','leave') AND (l.first_response_at IS NULL OR l.next_action_at < (current_date + 1)::timestamptz)))
      ORDER BY l.score DESC NULLS LAST, l.created_at LIMIT 300`);
    const run = async (c: Client) => {
      const plan: { lead_id: string; number: string; name: string; score: number | null; why: string; from: string | null; to: string | null; note: string }[] = [];
      for (const l of candidates) {
        const lead = await leadOrThrow(c, l.id, true);
        const d = await decide(c, { ...lead, exclude_lead_id: lead.id, exclude_user_id: lead.owner_id });
        plan.push({ lead_id: lead.id, number: lead.number, name: lead.name, score: (lead as Lead & { score: number | null }).score ?? null, why: l.why, from: lead.owner_name, to: d.owner?.name ?? null, note: d.note });
        if (d.owner) await assignLead(c, lead, { user_id: d.owner.user_id, name: d.owner.name }, 'rebalance', { rule: d.rule, reason: `${b.reason ?? 'Rebalanced'} (${l.why.toLowerCase()})`, by: req.user!.name });
      }
      if (!b.preview) await auditReq(c, req, 'lead_rebalance', '00000000-0000-0000-0000-000000000000', 'applied', { after: { moved: plan.filter((x) => x.to).length }, reason: b.reason });
      return plan;
    };
    const plan = b.preview ? await dryRun(pool, run) : await tx(pool, run);
    res.json({ preview: b.preview, moved: plan.filter((x) => x.to).length, stays: plan.filter((x) => !x.to).length, plan });
  });

  // ---------- the daily call list ----------
  r.get('/my-day', requirePermission('crm.read'), async (req, res) => {
    const who = req.query.user && (seesAll(req) || hasPermission(req.user, 'crm.lead.assign')) ? String(req.query.user) : req.user!.id;
    const leads = await many<Lead & { score: number | null; score_band: string | null; score_reasons: unknown; call_attempts: number; no_progress: boolean; reenquiry_count: number; source_name: string }>(pool, `
      SELECT l.*, s.name AS source_name FROM leads l JOIN lead_sources s ON s.id = l.source_id
      WHERE l.owner_id = $1 AND l.status = 'open' AND l.stage <> 'nurture' AND (l.first_response_at IS NULL OR l.next_action_at IS NULL OR l.next_action_at < (current_date + 8)::timestamptz)`, [who]);
    const settings = await crmSettings(pool);
    const ist = (d: Date) => new Date(d.getTime() + 330 * 60_000).toISOString().slice(0, 10);
    const today = ist(new Date());
    const byScore = (a: { score: number | null }, b: { score: number | null }) => (b.score ?? 0) - (a.score ?? 0);
    const slim = (l: (typeof leads)[number]) => ({ id: l.id, number: l.number, name: l.name, company: l.company, mobile: l.mobile, city: l.city, stage: l.stage, source_name: l.source_name, score: l.score, score_band: l.score_band, score_reasons: l.score_reasons,
      next_action_at: l.next_action_at, next_action: l.next_action, call_attempts: l.call_attempts, no_progress: l.no_progress, reenquiry_count: l.reenquiry_count, est_value: l.est_value, assigned_at: l.assigned_at, created_at: l.created_at,
      sla_due_at: l.first_response_at ? null : new Date(new Date(l.assigned_at ?? l.created_at).getTime() + Number(settings.first_response_minutes) * 60_000).toISOString() });
    const callNow = leads.filter((l) => !l.first_response_at).sort((a, b) => new Date(a.assigned_at ?? a.created_at).getTime() - new Date(b.assigned_at ?? b.created_at).getTime() || byScore(a, b));
    const rest = leads.filter((l) => l.first_response_at);
    const overdue = rest.filter((l) => !l.next_action_at || ist(new Date(l.next_action_at)) < today).sort(byScore);
    const dueToday = rest.filter((l) => l.next_action_at && ist(new Date(l.next_action_at)) === today).sort(byScore);
    const upcoming = rest.filter((l) => l.next_action_at && ist(new Date(l.next_action_at)) > today).sort((a, b) => new Date(a.next_action_at!).getTime() - new Date(b.next_action_at!).getTime());
    const engagements = await many(pool, `SELECT e.*, l.number AS lead_number, l.name AS lead_name, l.company FROM lead_engagements e JOIN leads l ON l.id = e.lead_id
      WHERE e.owner_id = $1 AND e.outcome IS NULL AND e.status NOT IN ('cancelled','no_show') AND l.status = 'open' ORDER BY coalesce(e.scheduled_at, e.created_at)`, [who]);
    const member = await one<{ name: string }>(pool, 'SELECT name FROM sales_team WHERE user_id = $1', [who]);
    res.json({ user_id: who, name: member?.name ?? req.user!.name, first_response_minutes: settings.first_response_minutes, call_now: callNow.map(slim), overdue: overdue.map(slim), due_today: dueToday.map(slim), upcoming: upcoming.map(slim), engagements });
  });
}
