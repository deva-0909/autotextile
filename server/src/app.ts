import express, { type NextFunction, type Request, type Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import type { DB } from './db.ts';
import { STAGES } from './stages.ts';
import { DEFECT_TYPES, QC_PASS_LIMIT } from './qc.ts';
import { recipeConsumption, type RecipeLine } from './recipes.ts';
import * as auto from './automation.ts';
import * as q from './queries.ts';

const id = (req: Request) => Number(req.params.id);

export function createApp(db: DB, opts: { staticDir?: string } = {}) {
  const app = express();
  app.use(express.json());
  const api = express.Router();

  api.get('/health', (_req, res) => { res.json({ ok: true }); });
  api.get('/meta', (_req, res) => {
    res.json({ stages: STAGES, defect_types: DEFECT_TYPES, qc_pass_limit: QC_PASS_LIMIT, max_lot_m: auto.MAX_LOT_M });
  });
  api.get('/dashboard', (_req, res) => { res.json(q.dashboard(db)); });

  api.get('/orders', (_req, res) => { res.json(q.listOrders(db)); });
  api.post('/orders', (req, res) => { res.status(201).json(auto.createOrder(db, req.body)); });
  api.get('/orders/:id', (req, res) => {
    const order = auto.getOrder(db, id(req));
    res.json({ ...order, ...q.orderDetail(db, order.id), remaining_hours: Math.round(auto.estimateRemainingHours(db, order)) });
  });

  api.get('/lots', (req, res) => {
    res.json(q.listLots(db, { stage: req.query.stage as string | undefined, status: req.query.status as string | undefined }));
  });
  api.post('/lots/:id/complete', (req, res) => { res.json(auto.completeStage(db, id(req), req.body?.output_m)); });
  api.post('/lots/:id/inspection', (req, res) => { res.json(auto.recordInspection(db, id(req), req.body ?? {})); });
  api.post('/lots/:id/dispatch', (req, res) => { res.json(auto.dispatchLot(db, id(req))); });
  api.post('/lots/:id/hold', (req, res) => { res.json(auto.holdLot(db, id(req), req.body?.reason)); });
  api.post('/lots/:id/release', (req, res) => { res.json(auto.releaseLot(db, id(req))); });

  api.get('/machines', (_req, res) => {
    res.json(db.prepare(
      `SELECT m.*, l.id AS lot_id, l.lot_no, l.quantity_m AS lot_quantity_m, e.started_at
       FROM machines m
       LEFT JOIN lots l ON l.machine_id = m.id AND l.status = 'in_process'
       LEFT JOIN stage_events e ON e.lot_id = l.id AND e.completed_at IS NULL
       ORDER BY m.id`,
    ).all());
  });
  api.patch('/machines/:id', (req, res) => { res.json(auto.setMachineStatus(db, id(req), req.body?.status)); });

  api.get('/inspections', (_req, res) => { res.json(q.listInspections(db)); });

  api.get('/inventory', (_req, res) => { res.json(db.prepare('SELECT * FROM inventory_items ORDER BY category, code').all()); });
  api.get('/inventory/txns', (_req, res) => {
    res.json(db.prepare(
      `SELECT t.*, i.code, i.name, i.unit FROM inventory_txns t JOIN inventory_items i ON i.id = t.item_id ORDER BY t.id DESC LIMIT 100`,
    ).all());
  });
  api.post('/inventory/:id/receive', (req, res) => { res.json(auto.receiveStock(db, id(req), req.body?.qty, req.body?.reason)); });

  api.get('/recipes', (_req, res) => { res.json(q.listRecipes(db)); });
  api.post('/recipes', (req, res) => {
    const { shade_code, name, liquor_ratio, lines } = req.body ?? {};
    if (!shade_code || !name || !(Number(liquor_ratio) > 0) || !Array.isArray(lines) || !lines.length)
      throw new auto.HttpError(400, 'shade_code, name, liquor_ratio and lines are required');
    for (const l of lines as RecipeLine[]) {
      if (!['owf', 'gpl'].includes(l.basis) || !(Number(l.amount) > 0)) throw new auto.HttpError(400, 'Invalid recipe line');
      if (!db.prepare('SELECT 1 FROM inventory_items WHERE code = ?').get(l.item_code))
        throw new auto.HttpError(400, `Unknown inventory item ${l.item_code}`);
    }
    db.prepare(
      `INSERT INTO recipes (shade_code, name, liquor_ratio, lines) VALUES (?, ?, ?, ?)
       ON CONFLICT(shade_code) DO UPDATE SET name = excluded.name, liquor_ratio = excluded.liquor_ratio, lines = excluded.lines`,
    ).run(shade_code, name, Number(liquor_ratio), JSON.stringify(lines));
    res.status(201).json(auto.getRecipe(db, shade_code));
  });
  api.get('/recipes/:shade/consumption', (req, res) => {
    const recipe = auto.getRecipe(db, String(req.params.shade));
    if (!recipe) throw new auto.HttpError(404, 'Recipe not found');
    const { quantity_m, width_cm, gsm } = req.query;
    const needs = recipeConsumption(recipe, Number(quantity_m), Number(width_cm), Number(gsm));
    res.json(needs.map((n) => {
      const item = db.prepare('SELECT name, qty_on_hand FROM inventory_items WHERE code = ?').get(n.item_code) as
        | { name: string; qty_on_hand: number } | undefined;
      return { ...n, name: item?.name, on_hand: item?.qty_on_hand ?? 0, sufficient: (item?.qty_on_hand ?? 0) >= n.kg };
    }));
  });

  api.get('/alerts', (req, res) => {
    const all = req.query.all === '1';
    res.json(db.prepare(`SELECT * FROM alerts ${all ? '' : 'WHERE acknowledged = 0'} ORDER BY id DESC LIMIT 200`).all());
  });
  api.post('/alerts/:id/ack', (req, res) => {
    db.prepare('UPDATE alerts SET acknowledged = 1 WHERE id = ?').run(id(req));
    res.json({ ok: true });
  });

  api.post('/automation/run', (_req, res) => { auto.runChecks(db); res.json({ ok: true }); });
  api.post('/simulation/step', (_req, res) => { res.json(auto.simulateStep(db)); });

  app.use('/api', api);

  if (opts.staticDir && fs.existsSync(opts.staticDir)) {
    app.use(express.static(opts.staticDir));
    app.get(/^(?!\/api).*/, (_req, res) => { res.sendFile(path.join(opts.staticDir!, 'index.html')); });
  }

  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    const status = err instanceof auto.HttpError ? err.status : (err as { status?: number }).status ?? 500;
    if (status >= 500) console.error(err);
    res.status(status).json({ error: err.message });
  });
  return app;
}
