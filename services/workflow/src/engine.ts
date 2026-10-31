import type { Router } from 'express';
import { z } from 'zod';
import { type BusEvent, type Client, type Pool, type ServiceContext, badRequest, conflict, forbidden, hasPermission, many, notFound, notify, one, optText, parse, reqText, requirePermission, tx } from '@erp/platform';
import { auditReq, directory, localNumber } from './common.ts';
import { EVENT_VARIABLES, contextFor, enqueueForEvent, render, type EventContext } from './messaging.ts';

export interface Condition { field: string; op: 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'contains' | 'in'; value: unknown }
export interface Action { type: 'create_task' | 'notify' | 'send_message'; title?: string; description?: string; owner_field?: string; owner_id?: string; queue_permission?: string; permission?: string; priority?: 'low' | 'normal' | 'high' | 'urgent'; due_in_hours?: number; escalate_after_hours?: number; escalate_to_permission?: string; template_code?: string; delay_minutes?: number }

export function matches(conds: Condition[], match: 'all' | 'any', vars: Record<string, unknown>) {
  if (!conds.length) return true;
  const test = (c: Condition) => {
    const v = vars[c.field];
    const n = Number(v), m = Number(c.value);
    switch (c.op) {
      case 'eq': return String(v) === String(c.value);
      case 'neq': return String(v) !== String(c.value);
      case 'gt': return n > m; case 'gte': return n >= m; case 'lt': return n < m; case 'lte': return n <= m;
      case 'contains': return String(v ?? '').toLowerCase().includes(String(c.value).toLowerCase());
      case 'in': return String(c.value).split(',').map((x) => x.trim()).includes(String(v));
      default: return false;
    }
  };
  return match === 'all' ? conds.every(test) : conds.some(test);
}

export async function createTask(c: Client, t: { title: string; description?: string | null; source?: { service: string; type: string; id: string }; link?: string | null; owner_id?: string | null; queue_permission?: string | null; priority?: string; due_at?: Date | null; escalate_after_hours?: number | null; escalate_to_permission?: string | null; rule_id?: string | null; by: string }) {
  const owner = t.owner_id ? (await directory()).find((u) => u.id === t.owner_id) : null;
  if (!owner && !t.queue_permission) throw badRequest('A task needs an owner or a team queue');
  const number = await localNumber(c, 'task', 'TSK-');
  const row = await one<{ id: string }>(c, `INSERT INTO tasks (number, title, description, source_service, source_type, source_id, link, owner_id, owner_name, queue_permission, priority, due_at, escalate_after_hours, escalate_to_permission, rule_id, created_by_name)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING id`,
  [number, t.title.slice(0, 300), t.description ?? null, t.source?.service ?? null, t.source?.type ?? null, t.source?.id ?? null, t.link ?? null, owner?.id ?? null, owner?.name ?? null, owner ? null : t.queue_permission, t.priority ?? 'normal', t.due_at ?? null, t.escalate_after_hours ?? null, t.escalate_to_permission ?? null, t.rule_id ?? null, t.by]);
  await c.query(`INSERT INTO task_events (task_id, kind, note, by_name) VALUES ($1, 'created', $2, $3)`, [row!.id, owner ? `Assigned to ${owner.name}` : `Queued for ${t.queue_permission}`, t.by]);
  await notify(c, 'workflow', owner ? { user_id: owner.id, kind: 'action', title: `Task: ${t.title}`, body: number, link: '/my-work' } : { audience_permission: t.queue_permission!, kind: 'action', title: `New task for your team: ${t.title}`, body: number, link: '/my-work' });
  return { id: row!.id, number };
}

async function runAction(c: Client, a: Action, ctx: EventContext, ev: { id: number | null; type: string }, ruleId: string | null) {
  const vars = ctx.vars;
  if (a.type === 'create_task') {
    const owner = a.owner_id ?? (a.owner_field ? (vars[a.owner_field] as string | undefined) ?? null : null);
    const t = await createTask(c, { title: render(a.title ?? 'Follow up', vars), description: a.description ? render(a.description, vars) : null, source: { service: ev.type.split('.')[0]!, type: ctx.ref.type, id: ctx.ref.id }, link: ctx.ref.link,
      owner_id: owner, queue_permission: owner ? null : a.queue_permission ?? 'workflow.task.manage', priority: a.priority, due_at: a.due_in_hours ? new Date(Date.now() + a.due_in_hours * 3_600_000) : null, escalate_after_hours: a.escalate_after_hours ?? null, escalate_to_permission: a.escalate_to_permission ?? null, rule_id: ruleId, by: 'workflow rule' });
    return `task ${t.number}`;
  }
  if (a.type === 'notify') {
    const owner = a.owner_field ? (vars[a.owner_field] as string | undefined) : a.owner_id;
    await notify(c, 'workflow', owner ? { user_id: owner, kind: 'info', title: render(a.title ?? ev.type, vars), link: ctx.ref.link } : { audience_permission: a.permission ?? 'workflow.task.manage', kind: 'info', title: render(a.title ?? ev.type, vars), link: ctx.ref.link });
    return 'notified';
  }
  if (a.type === 'send_message' && a.template_code) return `${await enqueueForEvent(c, ev, ctx, a.template_code)} message(s)`;
  return 'nothing';
}

/** Every trigger event: queue customer messages, then run the rules that match. Lookups happen before anything publishes. */
export function eventHandler(type: string) {
  return async (ev: BusEvent, c: Client) => {
    const payload = ev.payload as Record<string, unknown>;
    const rules = await many<{ id: string; match: 'all' | 'any'; conditions: Condition[]; actions: Action[] }>(c, `SELECT * FROM rules WHERE active AND event_type = $1`, [type]);
    const hasTemplates = await one(c, `SELECT 1 FROM templates WHERE status = 'active' AND event_type = $1 LIMIT 1`, [type]);
    if (!rules.length && !hasTemplates) return;
    const ctx = await contextFor(type, payload);
    const e = { id: Number(ev.id), type };
    await enqueueForEvent(c, e, ctx);
    for (const r of rules) {
      if (await one(c, 'SELECT 1 FROM rule_runs WHERE rule_id = $1 AND event_id = $2', [r.id, e.id])) continue;
      // Conditions compare raw event values (numbers stay numbers); templates use the formatted ones.
      const ok = matches(r.conditions, r.match, { ...ctx.vars, ...payload });
      const outcomes: string[] = [];
      if (ok) {
        for (const a of r.actions) {
          if (a.delay_minutes && a.delay_minutes > 0) {
            await c.query(`INSERT INTO scheduled_actions (rule_id, action, context, run_at) VALUES ($1,$2,$3, now() + make_interval(mins => $4))`, [r.id, JSON.stringify({ ...a, delay_minutes: 0 }), JSON.stringify({ ctx, ev: e }), a.delay_minutes]);
            outcomes.push(`scheduled in ${a.delay_minutes} min`);
          } else outcomes.push(await runAction(c, a, ctx, e, r.id));
        }
        await c.query('UPDATE rules SET runs = runs + 1, last_run_at = now() WHERE id = $1', [r.id]);
      }
      await c.query(`INSERT INTO rule_runs (rule_id, event_id, event_type, matched, outcome) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`, [r.id, e.id, type, ok, outcomes.join('; ') || null]);
    }
  };
}

/** Delayed actions, overdue escalations. */
export async function runScheduled(pool: Pool) {
  const due = await many<{ id: string; rule_id: string | null; action: Action; context: { ctx: EventContext; ev: { id: number | null; type: string } } }>(pool, `SELECT * FROM scheduled_actions WHERE status = 'pending' AND run_at <= now() ORDER BY run_at LIMIT 50`);
  for (const s of due) {
    await tx(pool, async (c) => {
      const lock = await one(c, `SELECT 1 FROM scheduled_actions WHERE id = $1 AND status = 'pending' FOR UPDATE SKIP LOCKED`, [s.id]);
      if (!lock) return;
      try { await runAction(c, s.action, s.context.ctx, s.context.ev, s.rule_id); await c.query(`UPDATE scheduled_actions SET status = 'done' WHERE id = $1`, [s.id]); }
      catch (e) { await c.query(`UPDATE scheduled_actions SET status = 'failed', error = $2 WHERE id = $1`, [s.id, (e as Error).message]); }
    });
  }
  const late = await many<{ id: string; number: string; title: string; escalate_to_permission: string; owner_name: string | null }>(pool, `
    SELECT * FROM tasks WHERE status IN ('open','in_progress') AND escalated_at IS NULL AND escalate_after_hours IS NOT NULL AND escalate_to_permission IS NOT NULL
      AND coalesce(due_at, created_at) + make_interval(secs => (escalate_after_hours * 3600)::int) < now()`);
  for (const t of late) {
    await tx(pool, async (c) => {
      await c.query(`UPDATE tasks SET escalated_at = now(), priority = 'urgent', updated_at = now() WHERE id = $1`, [t.id]);
      await c.query(`INSERT INTO task_events (task_id, kind, note, by_name) VALUES ($1, 'escalated', $2, 'workflow')`, [t.id, `Overdue; escalated to ${t.escalate_to_permission}`]);
      await notify(c, 'workflow', { audience_permission: t.escalate_to_permission, kind: 'warning', title: `Escalated: ${t.title}`, body: `${t.number}${t.owner_name ? ` · ${t.owner_name}` : ''} is overdue`, link: '/workflow/tasks' });
    });
  }
  return { scheduled: due.length, escalated: late.length };
}

const ruleBody = z.object({
  name: reqText(120), event_type: z.string(), match: z.enum(['all', 'any']).default('all'), active: z.boolean().default(true),
  conditions: z.array(z.object({ field: z.string().min(1), op: z.enum(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'contains', 'in']), value: z.union([z.string(), z.number()]) })).max(10),
  actions: z.array(z.object({ type: z.enum(['create_task', 'notify', 'send_message']), title: optText(300), description: optText(1000), owner_field: optText(40), queue_permission: optText(80), permission: optText(80),
    priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(), due_in_hours: z.number().min(0).max(720).optional(), escalate_after_hours: z.number().min(0).max(720).optional(), escalate_to_permission: optText(80), template_code: optText(60), delay_minutes: z.number().int().min(0).max(43200).optional() })).min(1).max(8),
});

export function engineRoutes(r: Router, { pool }: ServiceContext) {
  // ----- rules -----
  r.get('/rules', requirePermission('workflow.read'), async (_req, res) => {
    res.json(await many(pool, `SELECT r.*, (SELECT count(*)::int FROM rule_runs x WHERE x.rule_id = r.id AND x.matched AND x.at > now() - interval '30 days') AS matched_30d FROM rules r ORDER BY r.event_type, r.name`));
  });
  r.get('/rules/:id', requirePermission('workflow.read'), async (req, res) => {
    const rule = await one(pool, 'SELECT * FROM rules WHERE id = $1', [req.params.id]);
    if (!rule) throw notFound('Rule');
    res.json({ ...rule, runs_log: await many(pool, 'SELECT * FROM rule_runs WHERE rule_id = $1 ORDER BY id DESC LIMIT 50', [req.params.id]) });
  });
  const save = async (req: Parameters<Parameters<Router['post']>[1]>[0], id: string | null) => {
    const b = parse(ruleBody, req.body);
    const vars = EVENT_VARIABLES[b.event_type];
    if (!vars) throw badRequest('Unknown trigger event');
    for (const a of b.actions) {
      if (a.type === 'create_task' && !a.title) throw badRequest('A task action needs a title');
      if (a.type === 'send_message') { if (!a.template_code || !(await one(pool, `SELECT 1 FROM templates WHERE code = $1 AND status = 'active'`, [a.template_code]))) throw badRequest('Choose an active message template'); }
    }
    return tx(pool, async (c) => {
      let rid = id;
      if (id) {
        const r1 = await c.query(`UPDATE rules SET name = $2, event_type = $3, match = $4, conditions = $5, actions = $6, active = $7, updated_by_name = $8, updated_at = now() WHERE id = $1`, [id, b.name, b.event_type, b.match, JSON.stringify(b.conditions), JSON.stringify(b.actions), b.active, req.user!.name]);
        if (!r1.rowCount) throw notFound('Rule');
      } else rid = (await one<{ id: string }>(c, `INSERT INTO rules (name, event_type, match, conditions, actions, active, created_by_name) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`, [b.name, b.event_type, b.match, JSON.stringify(b.conditions), JSON.stringify(b.actions), b.active, req.user!.name]))!.id;
      await auditReq(c, req, 'workflow_rule', rid!, id ? 'updated' : 'created', { after: b });
      return { id: rid };
    });
  };
  r.post('/rules', requirePermission('workflow.rule.manage'), async (req, res) => { res.status(201).json(await save(req, null)); });
  r.put('/rules/:id', requirePermission('workflow.rule.manage'), async (req, res) => { res.json(await save(req, String(req.params.id))); });
  /** Dry run against sample values, so the builder can show what would happen. */
  r.post('/rules/test', requirePermission('workflow.read'), async (req, res) => {
    const b = parse(z.object({ conditions: ruleBody.shape.conditions, match: z.enum(['all', 'any']), sample: z.record(z.string(), z.unknown()) }), req.body);
    res.json({ matched: matches(b.conditions, b.match, b.sample) });
  });

  // ----- tasks and My Work -----
  r.get('/my-work', async (req, res) => {
    const u = req.user!;
    const tasks = await many<{ queue_permission: string | null; owner_id: string | null }>(pool, `SELECT t.*, (t.due_at < now()) AS overdue FROM tasks t WHERE status IN ('open','in_progress') AND (owner_id = $1 OR (owner_id IS NULL AND queue_permission IS NOT NULL)) ORDER BY (due_at < now()) DESC NULLS LAST, CASE priority WHEN 'urgent' THEN 1 WHEN 'high' THEN 2 WHEN 'normal' THEN 3 ELSE 4 END, due_at NULLS LAST LIMIT 300`, [u.id]);
    const mine = tasks.filter((t) => t.owner_id === u.id || (t.queue_permission && hasPermission(u, t.queue_permission)));
    const done = await one(pool, `SELECT count(*)::int AS n FROM tasks WHERE completed_by_name = $1 AND completed_at > now() - interval '7 days'`, [u.name]);
    res.json({ tasks: mine, done_7d: (done as { n: number }).n });
  });
  r.get('/tasks', requirePermission('workflow.read'), async (req, res) => {
    const st = (req.query.status as string) || 'open,in_progress';
    res.json(await many(pool, `SELECT t.*, (t.due_at < now() AND status IN ('open','in_progress')) AS overdue FROM tasks t WHERE status = ANY($1) AND ($2::uuid IS NULL OR owner_id = $2) ORDER BY created_at DESC LIMIT 500`, [st.split(','), req.query.owner ?? null]));
  });
  r.get('/tasks/:id', async (req, res) => {
    const t = await one<{ owner_id: string | null; queue_permission: string | null }>(pool, 'SELECT * FROM tasks WHERE id::text = $1 OR number = $1', [req.params.id]);
    if (!t) throw notFound('Task');
    res.json({ ...t, events: await many(pool, 'SELECT * FROM task_events WHERE task_id = (SELECT id FROM tasks WHERE id::text = $1 OR number = $1) ORDER BY id', [req.params.id]) });
  });
  r.post('/tasks', async (req, res) => {
    const b = parse(z.object({ title: reqText(300), description: optText(2000), owner_id: z.uuid().nullable().optional(), queue_permission: optText(80), priority: z.enum(['low', 'normal', 'high', 'urgent']).default('normal'), due_at: z.string().nullable().optional(), link: optText(300) }), req.body);
    if (b.owner_id && b.owner_id !== req.user!.id && !hasPermission(req.user, 'workflow.task.manage')) throw forbidden('Only team leads can give tasks to others');
    const out = await tx(pool, async (c) => createTask(c, { ...b, owner_id: b.owner_id ?? (b.queue_permission ? null : req.user!.id), due_at: b.due_at ? new Date(b.due_at) : null, source: { service: 'workflow', type: 'manual', id: '' }, by: req.user!.name }));
    res.status(201).json(out);
  });
  /** Pick up from a queue, start, complete, cancel, reassign. Completing needs a resolution note. */
  r.post('/tasks/:id/action', async (req, res) => {
    const b = parse(z.object({ action: z.enum(['claim', 'start', 'complete', 'cancel', 'reassign', 'reopen']), note: optText(1000), owner_id: z.uuid().optional() }), req.body);
    const u = req.user!;
    const dir = b.action === 'reassign' ? await directory() : [];
    await tx(pool, async (c) => {
      const t = await one<{ id: string; status: string; owner_id: string | null; queue_permission: string | null; title: string; number: string }>(c, 'SELECT * FROM tasks WHERE id = $1 FOR UPDATE', [req.params.id]);
      if (!t) throw notFound('Task');
      const isOwner = t.owner_id === u.id;
      const inQueue = !t.owner_id && !!t.queue_permission && hasPermission(u, t.queue_permission);
      const lead = hasPermission(u, 'workflow.task.manage');
      if (!isOwner && !inQueue && !lead) throw forbidden('This task is not yours');
      const ev = (kind: string, note: string | null) => c.query(`INSERT INTO task_events (task_id, kind, note, by_name) VALUES ($1,$2,$3,$4)`, [t.id, kind, note, u.name]);
      switch (b.action) {
        case 'claim': if (t.owner_id) throw conflict('Already taken'); await c.query(`UPDATE tasks SET owner_id = $2, owner_name = $3, updated_at = now() WHERE id = $1`, [t.id, u.id, u.name]); await ev('claimed', null); break;
        case 'start': if (t.status !== 'open') throw conflict(`Task is ${t.status}`); await c.query(`UPDATE tasks SET status = 'in_progress', owner_id = coalesce(owner_id, $2), owner_name = coalesce(owner_name, $3), updated_at = now() WHERE id = $1`, [t.id, u.id, u.name]); await ev('started', b.note ?? null); break;
        case 'complete': case 'cancel':
          if (!['open', 'in_progress'].includes(t.status)) throw conflict(`Task is ${t.status}`);
          if (!b.note || b.note.length < 3) throw badRequest('Add a short resolution note', { fields: { note: 'Required' } });
          await c.query(`UPDATE tasks SET status = $2, resolution = $3, completed_by_name = $4, completed_at = now(), updated_at = now() WHERE id = $1`, [t.id, b.action === 'complete' ? 'done' : 'cancelled', b.note, u.name]);
          await ev(b.action === 'complete' ? 'completed' : 'cancelled', b.note); break;
        case 'reopen': if (!['done', 'cancelled'].includes(t.status)) throw conflict('Task is still open'); await c.query(`UPDATE tasks SET status = 'open', completed_at = NULL, updated_at = now() WHERE id = $1`, [t.id]); await ev('reopened', b.note ?? null); break;
        case 'reassign': {
          const to = dir.find((x) => x.id === b.owner_id && x.status === 'active');
          if (!to) throw badRequest('Choose an active colleague');
          if (!b.note) throw badRequest('Give a reason for reassigning', { fields: { note: 'Required' } });
          await c.query(`UPDATE tasks SET owner_id = $2, owner_name = $3, updated_at = now() WHERE id = $1`, [t.id, to.id, to.name]);
          await ev('reassigned', `${t.owner_id ? '' : 'From queue '}to ${to.name}: ${b.note}`);
          await notify(c, 'workflow', { user_id: to.id, kind: 'action', title: `Task reassigned to you: ${t.title}`, body: `${t.number} · ${b.note}`, link: '/my-work' });
          break;
        }
      }
      await auditReq(c, req, 'task', t.id, b.action, { reason: b.note ?? null });
    });
    res.json({ ok: true });
  });
}
