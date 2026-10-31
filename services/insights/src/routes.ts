import type { Router } from 'express';
import { z } from 'zod';
import { type ServiceContext, audit, badRequest, conflict, contextOf, forbidden, hasPermission, many, notFound, one, optText, parse, reqText, requirePermission, tx } from '@erp/platform';
import { DATASETS, type Definition, fetchDataset, inferFields, runReport, toCsv, today } from './data.ts';
import { commercialIntel, controlTower, customerIntel, exceptions, financialIntel, simulate, stockIntel, substitutes, supplierIntel } from './intelligence.ts';
import { MODEL, aiEnabled, ask, brief } from './copilot.ts';
import { backupDir, restoreTest, runBackup, systemHealth } from './system.ts';

const rule = z.object({ field: z.string(), op: z.enum(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'contains', 'in', 'empty', 'not_empty']), value: z.union([z.string(), z.number()]).nullable().optional() });
const definition = z.object({
  dataset: z.string(), from: z.string().nullable().optional(), to: z.string().nullable().optional(),
  filters: z.object({ logic: z.enum(['and', 'or']), rules: z.array(rule).max(20), groups: z.array(z.object({ logic: z.enum(['and', 'or']), rules: z.array(rule).max(20) })).max(5).optional() }).optional(),
  columns: z.array(z.string()).max(40).optional(), group_by: z.array(z.string()).max(4).optional(), date_grain: z.enum(['day', 'month', 'quarter', 'year']).nullable().optional(),
  measures: z.array(z.object({ field: z.string(), agg: z.enum(['sum', 'count', 'avg', 'min', 'max', 'count_distinct']) })).max(8).optional(),
  sort: z.object({ field: z.string(), dir: z.enum(['asc', 'desc']) }).nullable().optional(), limit: z.number().int().min(1).max(5000).nullable().optional(),
});
const nextRun = (schedule: string) => {
  const d = new Date(); d.setUTCHours(1, 30, 0, 0); // 07:00 IST
  if (schedule === 'daily') d.setUTCDate(d.getUTCDate() + 1);
  else if (schedule === 'weekly') d.setUTCDate(d.getUTCDate() + ((8 - d.getUTCDay()) % 7 || 7));
  else if (schedule === 'monthly') { d.setUTCMonth(d.getUTCMonth() + 1, 1); }
  else return null;
  return d.toISOString();
};

export function insightRoutes(r: Router, { pool }: ServiceContext) {
  // ----- report builder -----
  r.get('/datasets', requirePermission('insights.read'), (req, res) => {
    res.json(DATASETS.filter((d) => hasPermission(req.user, d.permission)).map(({ path: _p, service: _s, ...d }) => d));
  });
  r.get('/datasets/:key/fields', requirePermission('insights.read'), async (req, res) => {
    res.json(inferFields(await fetchDataset(req, String(req.params.key))));
  });
  r.post('/reports/run', requirePermission('insights.read'), async (req, res) => {
    const def = parse(definition, req.body) as Definition;
    const out = await runReport(req, def);
    if (req.query.format === 'csv') { res.setHeader('content-type', 'text/csv; charset=utf-8'); res.setHeader('content-disposition', 'attachment; filename="report.csv"'); res.send(`﻿${toCsv(out.columns, out.rows)}`); return; }
    res.json(out);
  });
  r.get('/reports', requirePermission('insights.read'), async (req, res) => {
    res.json(await many(pool, `SELECT r.id, r.name, r.description, r.definition->>'dataset' AS dataset, r.owner_name, r.shared, r.schedule, r.last_run_at, r.next_run_at, r.owner_id = $1 AS mine,
      (SELECT created_at FROM report_snapshots s WHERE s.report_id = r.id ORDER BY created_at DESC LIMIT 1) AS last_snapshot FROM reports r WHERE r.owner_id = $1 OR r.shared OR $1 = ANY(r.recipients) ORDER BY r.updated_at DESC`, [req.user!.id]));
  });
  r.get('/reports/:id', requirePermission('insights.read'), async (req, res) => {
    const rep = await one<{ owner_id: string; shared: boolean; recipients: string[] }>(pool, 'SELECT * FROM reports WHERE id = $1', [req.params.id]);
    if (!rep || (rep.owner_id !== req.user!.id && !rep.shared && !rep.recipients.includes(req.user!.id))) throw notFound('Report');
    res.json({ ...rep, snapshots: await many(pool, 'SELECT id, row_count, created_at FROM report_snapshots WHERE report_id = $1 ORDER BY created_at DESC LIMIT 12', [req.params.id]) });
  });
  r.get('/reports/:id/snapshots/:sid', requirePermission('insights.read'), async (req, res) => {
    const s = await one<{ result: { columns: unknown; rows: unknown } }>(pool, `SELECT s.* FROM report_snapshots s JOIN reports r ON r.id = s.report_id WHERE s.id = $1 AND r.id = $2 AND (r.owner_id = $3 OR r.shared OR $3 = ANY(r.recipients))`, [req.params.sid, req.params.id, req.user!.id]);
    if (!s) throw notFound('Snapshot');
    res.json(s);
  });
  const reportBody = z.object({ name: reqText(120), description: optText(500), definition, shared: z.boolean().default(false), schedule: z.enum(['none', 'daily', 'weekly', 'monthly']).default('none'), recipients: z.array(z.uuid()).max(30).default([]) });
  r.post('/reports', requirePermission('insights.report.manage'), async (req, res) => {
    const b = parse(reportBody, req.body);
    const ds = DATASETS.find((d) => d.key === b.definition.dataset);
    if (!ds || !hasPermission(req.user, ds.permission)) throw forbidden('You cannot save a report on data you cannot see');
    const out = await tx(pool, async (c) => {
      const row = await one<{ id: string }>(c, `INSERT INTO reports (name, description, definition, owner_id, owner_name, shared, schedule, recipients, next_run_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [b.name, b.description ?? null, JSON.stringify(b.definition), req.user!.id, req.user!.name, b.shared, b.schedule, b.recipients, nextRun(b.schedule)]);
      await audit(c, 'insights', contextOf(req), { entity: 'report', entityId: row!.id, action: 'created', after: b });
      return row;
    });
    res.status(201).json(out);
  });
  r.put('/reports/:id', requirePermission('insights.report.manage'), async (req, res) => {
    const b = parse(reportBody, req.body);
    await tx(pool, async (c) => {
      const r1 = await c.query(`UPDATE reports SET name = $2, description = $3, definition = $4, shared = $5, schedule = $6, recipients = $7, next_run_at = $8, updated_at = now() WHERE id = $1 AND owner_id = $9`,
        [req.params.id, b.name, b.description ?? null, JSON.stringify(b.definition), b.shared, b.schedule, b.recipients, nextRun(b.schedule), req.user!.id]);
      if (!r1.rowCount) throw notFound('Report (only the owner can change it)');
    });
    res.json({ ok: true });
  });
  r.delete('/reports/:id', requirePermission('insights.report.manage'), async (req, res) => {
    const r1 = await pool.query('DELETE FROM reports WHERE id = $1 AND owner_id = $2', [req.params.id, req.user!.id]);
    if (!r1.rowCount) throw notFound('Report');
    res.json({ ok: true });
  });
  /** Run a saved report now and keep the result as a snapshot (scheduled runs do the same). */
  r.post('/reports/:id/snapshot', requirePermission('insights.read'), async (req, res) => {
    const rep = await one<{ id: string; definition: Definition; owner_id: string; shared: boolean }>(pool, 'SELECT * FROM reports WHERE id = $1', [req.params.id]);
    if (!rep || (rep.owner_id !== req.user!.id && !rep.shared)) throw notFound('Report');
    const out = await runReport(req, rep.definition);
    const s = await one<{ id: string }>(pool, `INSERT INTO report_snapshots (report_id, result, row_count) VALUES ($1,$2,$3) RETURNING id`, [rep.id, JSON.stringify({ columns: out.columns, rows: out.rows.slice(0, 2000), totals: out.totals }), out.result_rows]);
    await pool.query('UPDATE reports SET last_run_at = now() WHERE id = $1', [rep.id]);
    res.json({ id: s!.id, rows: out.result_rows });
  });

  // ----- dashboards and intelligence -----
  r.get('/control-tower', requirePermission('insights.read'), async (req, res) => { res.json(await controlTower(req)); });
  r.get('/exceptions', requirePermission('insights.read'), async (req, res) => { res.json(await exceptions(req)); });
  r.get('/intel/suppliers', requirePermission('insights.read'), async (req, res) => { res.json(await supplierIntel(req, (req.query.productId as string) || null)); });
  r.get('/intel/substitutes/:productId', requirePermission('insights.read'), async (req, res) => { const out = await substitutes(req, String(req.params.productId)); if (!out) throw notFound('Product'); res.json(out); });
  r.get('/intel/stock', requirePermission('insights.read'), async (req, res) => { res.json(await stockIntel(req)); });
  r.get('/intel/customers', requirePermission('insights.read'), async (req, res) => { res.json(await customerIntel(req)); });
  r.get('/intel/commercial', requirePermission('insights.read'), async (req, res) => { res.json(await commercialIntel(req)); });
  r.post('/intel/simulate', requirePermission('insights.read'), async (req, res) => {
    const b = parse(z.object({ sku: z.string(), list_price: z.number().positive(), offer_price: z.number().positive() }), req.body);
    res.json(await simulate(req, b.sku, b.list_price, b.offer_price));
  });
  r.get('/intel/finance', requirePermission('insights.read'), async (req, res) => { res.json(await financialIntel(req)); });

  // ----- assistant -----
  r.get('/assistant/status', requirePermission('insights.ai.use'), (_req, res) => { res.json({ ai: aiEnabled(), model: aiEnabled() ? MODEL : null }); });
  r.post('/assistant/ask', requirePermission('insights.ai.use'), async (req, res) => {
    const b = parse(z.object({ question: z.string().trim().min(2).max(2000), history: z.array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().max(8000) })).max(12).default([]) }), req.body);
    let out;
    try { out = await ask(req, b.question, b.history); }
    catch (e) {
      await pool.query(`INSERT INTO assistant_log (user_id, user_name, question, mode, model, error) VALUES ($1,$2,$3,'ai',$4,$5)`, [req.user!.id, req.user!.name, b.question, MODEL, (e as Error).message]);
      throw badRequest(`The assistant could not answer: ${(e as Error).message}`);
    }
    const log = await one<{ id: string }>(pool, `INSERT INTO assistant_log (user_id, user_name, question, answer, tools_used, mode, model, input_tokens, output_tokens) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [req.user!.id, req.user!.name, b.question, out.answer, out.tools, out.mode, out.model ?? null, out.usage?.input ?? null, out.usage?.output ?? null]);
    res.json({ ...out, id: log!.id });
  });
  r.post('/assistant/:id/feedback', requirePermission('insights.ai.use'), async (req, res) => {
    const { feedback } = parse(z.object({ feedback: z.enum(['helpful', 'not_helpful']) }), req.body);
    await pool.query('UPDATE assistant_log SET feedback = $2 WHERE id = $1 AND user_id = $3', [req.params.id, feedback, req.user!.id]);
    res.json({ ok: true });
  });
  r.get('/assistant/history', requirePermission('insights.ai.use'), async (req, res) => {
    res.json(await many(pool, `SELECT id, question, answer, mode, tools_used, feedback, created_at FROM assistant_log WHERE user_id = $1 ORDER BY created_at DESC LIMIT 30`, [req.user!.id]));
  });
  r.get('/brief', requirePermission('insights.read'), async (req, res) => {
    const cached = req.query.refresh ? null : await one<{ body: unknown }>(pool, 'SELECT body FROM briefs WHERE user_id = $1 AND day = $2', [req.user!.id, today()]);
    if (cached) { res.json(cached.body); return; }
    const b = await brief(req);
    await pool.query(`INSERT INTO briefs (user_id, day, body) VALUES ($1,$2,$3) ON CONFLICT (user_id, day) DO UPDATE SET body = EXCLUDED.body, created_at = now()`, [req.user!.id, today(), JSON.stringify(b)]);
    res.json(b);
  });

  // ----- continuity -----
  r.get('/system/health', requirePermission('system.health.read'), async (_req, res) => {
    const backups = await many(pool, `SELECT id, file_name, size_bytes, sha256, status, error, duration_ms, started_by_name, started_at, finished_at, restore_status, restore_detail, restore_ms, restored_at FROM backups ORDER BY started_at DESC LIMIT 20`);
    const last = backups.find((b) => (b as { status: string }).status === 'completed') as { finished_at: string } | undefined;
    res.json({ ...(await systemHealth(pool)), backups, backup_dir: backupDir(), rpo_hours: Number(process.env.RPO_HOURS ?? 24), rto_hours: Number(process.env.RTO_HOURS ?? 4), hours_since_backup: last ? Math.round((Date.now() - new Date(last.finished_at).getTime()) / 360_000) / 10 : null });
  });
  r.post('/system/backups', requirePermission('system.backup.manage'), async (req, res) => {
    if (await one(pool, `SELECT 1 FROM backups WHERE status = 'running' AND started_at > now() - interval '1 hour'`)) throw conflict('A backup is already running');
    const out = await runBackup(pool, req.user!.name);
    await tx(pool, (c) => audit(c, 'insights', contextOf(req), { entity: 'backup', entityId: String((out as { id: string }).id), action: 'created', after: { status: (out as { status: string }).status } }));
    res.status(201).json(out);
  });
  r.post('/system/backups/:id/restore-test', requirePermission('system.backup.manage'), async (req, res) => {
    const out = await restoreTest(pool, String(req.params.id)).catch((e) => { throw badRequest((e as Error).message); });
    res.json(out);
  });
  r.post('/system/dead-letters/:id/replay', requirePermission('system.backup.manage'), async (req, res) => {
    const r1 = await pool.query(`UPDATE bus.dead_letters SET replay_requested_at = now(), replay_error = NULL WHERE id = $1 AND replayed_at IS NULL`, [req.params.id]);
    if (!r1.rowCount) throw conflict('Already replayed or not found');
    await tx(pool, (c) => audit(c, 'insights', contextOf(req), { entity: 'dead_letter', entityId: String(req.params.id), action: 'replay_requested' }));
    res.json({ ok: true });
  });
}
