import type { Router } from 'express';
import { z } from 'zod';
import { type ServiceContext, badRequest, callService, many, notFound, notify, one, optText, parse, reqText, requirePermission, tx } from '@erp/platform';
import { S, auditReq, directory, localNumber } from './common.ts';

/**
 * Handover when someone goes on leave, leaves, or moves role: their open tasks, CRM leads and contracts move to a
 * colleague in one recorded step. Approvals are routed by permission, so they need no transfer.
 */
export function handoverRoutes(r: Router, { pool }: ServiceContext) {
  r.get('/handovers', requirePermission('workflow.handover.manage', 'workflow.read'), async (_req, res) => {
    res.json(await many(pool, `SELECT h.*, (SELECT count(*)::int FROM handover_items i WHERE i.handover_id = h.id AND i.outcome = 'moved') AS moved, (SELECT count(*)::int FROM handover_items i WHERE i.handover_id = h.id AND i.outcome = 'skipped') AS skipped FROM handovers h ORDER BY created_at DESC LIMIT 100`));
  });
  r.get('/handovers/:id', requirePermission('workflow.handover.manage', 'workflow.read'), async (req, res) => {
    const h = await one(pool, 'SELECT * FROM handovers WHERE id = $1', [req.params.id]);
    if (!h) throw notFound('Handover');
    res.json({ ...h, items: await many(pool, 'SELECT * FROM handover_items WHERE handover_id = $1 ORDER BY id', [req.params.id]) });
  });

  /** What would move: used by the handover form and by HR before an exit. */
  r.get('/handovers/preview/:userId', requirePermission('workflow.handover.manage'), async (req, res) => {
    const id = String(req.params.userId);
    const [tasks, contracts, leads] = await Promise.all([
      many(pool, `SELECT id, number, title, due_at FROM tasks WHERE owner_id = $1 AND status IN ('open','in_progress')`, [id]),
      many(pool, `SELECT id, number, title, party_name, end_date::text FROM contracts WHERE owner_id = $1 AND status = 'active'`, [id]),
      callService<{ items: { id: string; number: string; name: string; stage: string }[] }>(S, 'crm', 'GET', `/leads?f_owner=${id}&f_view=open&pageSize=200`).then((x) => x.items).catch(() => []),
    ]);
    res.json({ tasks, contracts, leads });
  });

  r.post('/handovers', requirePermission('workflow.handover.manage'), async (req, res) => {
    const b = parse(z.object({ from_user_id: z.uuid(), to_user_id: z.uuid(), kind: z.enum(['leave', 'exit', 'transfer', 'rebalance']), reason: reqText(500), until: z.string().nullable().optional(), include: z.object({ tasks: z.boolean().default(true), leads: z.boolean().default(true), contracts: z.boolean().default(true) }).default({ tasks: true, leads: true, contracts: true }), note: optText(500) }), req.body);
    if (b.from_user_id === b.to_user_id) throw badRequest('Choose a different colleague');
    const dir = await directory();
    const from = dir.find((u) => u.id === b.from_user_id), to = dir.find((u) => u.id === b.to_user_id && u.status === 'active');
    if (!from || !to) throw badRequest('Choose people from the directory; the receiver must be active');
    // CRM reassignments are synchronous calls; do them before this transaction publishes anything.
    const items: { item_type: string; item_id: string; label: string; outcome: 'moved' | 'skipped'; note: string | null }[] = [];
    if (b.include.leads) {
      const leads = await callService<{ items: { id: string; number: string; name: string }[] }>(S, 'crm', 'GET', `/leads?f_owner=${from.id}&f_view=open&pageSize=500`).then((x) => x.items).catch(() => []);
      for (const l of leads) {
        try { await callService(S, 'crm', 'POST', `/leads/${l.id}/assign`, { user_id: to.id, reason: `Handover from ${from.name}: ${b.reason}` }); items.push({ item_type: 'lead', item_id: l.id, label: `${l.number} · ${l.name}`, outcome: 'moved', note: null }); }
        catch (e) { items.push({ item_type: 'lead', item_id: l.id, label: `${l.number} · ${l.name}`, outcome: 'skipped', note: (e as Error).message }); }
      }
    }
    const out = await tx(pool, async (c) => {
      const number = await localNumber(c, 'handover', 'HND-');
      if (b.include.tasks) for (const t of await many<{ id: string; number: string; title: string }>(c, `SELECT id, number, title FROM tasks WHERE owner_id = $1 AND status IN ('open','in_progress') FOR UPDATE`, [from.id])) {
        await c.query(`UPDATE tasks SET owner_id = $2, owner_name = $3, updated_at = now() WHERE id = $1`, [t.id, to.id, to.name]);
        await c.query(`INSERT INTO task_events (task_id, kind, note, by_name) VALUES ($1, 'reassigned', $2, $3)`, [t.id, `Handover ${number} from ${from.name} to ${to.name}`, req.user!.name]);
        items.push({ item_type: 'task', item_id: t.id, label: `${t.number} · ${t.title}`, outcome: 'moved', note: null });
      }
      if (b.include.contracts) for (const k of await many<{ id: string; number: string; title: string }>(c, `SELECT id, number, title FROM contracts WHERE owner_id = $1 AND status = 'active' FOR UPDATE`, [from.id])) {
        await c.query(`UPDATE contracts SET owner_id = $2, owner_name = $3, updated_at = now() WHERE id = $1`, [k.id, to.id, to.name]);
        items.push({ item_type: 'contract', item_id: k.id, label: `${k.number} · ${k.title}`, outcome: 'moved', note: null });
      }
      const summary = Object.fromEntries(['task', 'lead', 'contract'].map((t) => [t, items.filter((i) => i.item_type === t && i.outcome === 'moved').length]));
      const h = await one<{ id: string }>(c, `INSERT INTO handovers (number, from_user_id, from_name, to_user_id, to_name, reason, kind, until, summary, created_by_name) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
        [number, from.id, from.name, to.id, to.name, b.reason, b.kind, b.until ?? null, JSON.stringify(summary), req.user!.name]);
      for (const i of items) await c.query(`INSERT INTO handover_items (handover_id, item_type, item_id, label, outcome, note) VALUES ($1,$2,$3,$4,$5,$6)`, [h!.id, i.item_type, i.item_id, i.label, i.outcome, i.note]);
      await notify(c, S, { user_id: to.id, kind: 'action', title: `${from.name}'s work handed over to you`, body: `${summary.task} tasks, ${summary.lead} leads, ${summary.contract} contracts — ${b.reason}`, link: '/my-work' });
      await auditReq(c, req, 'handover', h!.id, 'completed', { after: { number, from: from.name, to: to.name, summary }, reason: b.reason });
      return { id: h!.id, number, summary, skipped: items.filter((i) => i.outcome === 'skipped').length };
    });
    res.status(201).json(out);
  });
}
