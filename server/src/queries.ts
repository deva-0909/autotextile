import type { DB } from './db.ts';
import { STAGES } from './stages.ts';
import { getRecipe } from './automation.ts';

export function dashboard(db: DB) {
  const one = <T>(sql: string, ...p: (string | number)[]) => db.prepare(sql).get(...p) as T;
  const machines = one<{ total: number; running: number; maintenance: number }>(
    `SELECT COUNT(*) AS total, SUM(status = 'running') AS running, SUM(status = 'maintenance') AS maintenance FROM machines`,
  );
  const wip = one<{ lots: number; meters: number }>(
    `SELECT COUNT(*) AS lots, COALESCE(SUM(quantity_m), 0) AS meters FROM lots WHERE status IN ('queued','in_process','on_hold')`,
  );
  const qc = one<{ total: number; passed: number }>(
    `SELECT COUNT(*) AS total, COALESCE(SUM(result = 'pass'), 0) AS passed FROM inspections`,
  );
  const stageRows = db
    .prepare(
      `SELECT stage, SUM(status = 'queued') AS queued, SUM(status = 'in_process') AS in_process,
              SUM(status = 'on_hold') AS on_hold, SUM(quantity_m) AS meters
       FROM lots WHERE status IN ('queued','in_process','on_hold') GROUP BY stage`,
    )
    .all() as { stage: string; queued: number; in_process: number; on_hold: number; meters: number }[];

  return {
    kpis: {
      open_orders: one<{ n: number }>(`SELECT COUNT(*) AS n FROM orders WHERE status != 'completed'`).n,
      wip_lots: wip.lots,
      wip_meters: Math.round(wip.meters),
      machines_total: machines.total,
      machines_running: machines.running ?? 0,
      machines_maintenance: machines.maintenance ?? 0,
      utilization_pct: machines.total ? Math.round(((machines.running ?? 0) / machines.total) * 100) : 0,
      qc_pass_rate: qc.total ? Math.round((qc.passed / qc.total) * 1000) / 10 : null,
      dispatched_meters: Math.round(one<{ m: number }>(`SELECT COALESCE(SUM(quantity_m), 0) AS m FROM lots WHERE status = 'dispatched'`).m),
      low_stock: one<{ n: number }>(`SELECT COUNT(*) AS n FROM inventory_items WHERE qty_on_hand <= reorder_level`).n,
      open_alerts: one<{ n: number }>(`SELECT COUNT(*) AS n FROM alerts WHERE acknowledged = 0`).n,
    },
    stages: STAGES.map((s) => {
      const r = stageRows.find((x) => x.stage === s.code);
      return {
        code: s.code, name: s.name,
        queued: r?.queued ?? 0, in_process: r?.in_process ?? 0, on_hold: r?.on_hold ?? 0,
        meters: Math.round(r?.meters ?? 0),
      };
    }),
    recent_events: db
      .prepare(
        `SELECT e.*, l.lot_no, m.code AS machine_code FROM stage_events e
         JOIN lots l ON l.id = e.lot_id LEFT JOIN machines m ON m.id = e.machine_id
         ORDER BY e.id DESC LIMIT 12`,
      )
      .all(),
  };
}

export function listOrders(db: DB) {
  return db
    .prepare(
      `SELECT o.*,
         COUNT(l.id) AS lot_count,
         SUM(l.status = 'dispatched') AS lots_dispatched,
         SUM(l.status = 'rejected') AS lots_rejected
       FROM orders o LEFT JOIN lots l ON l.order_id = o.id
       GROUP BY o.id ORDER BY o.status = 'completed', o.priority, o.due_date`,
    )
    .all();
}

export function orderDetail(db: DB, id: number) {
  return {
    lots: db
      .prepare(
        `SELECT l.*, m.code AS machine_code FROM lots l LEFT JOIN machines m ON m.id = l.machine_id
         WHERE l.order_id = ? ORDER BY l.id`,
      )
      .all(id),
    events: db
      .prepare(
        `SELECT e.*, l.lot_no, m.code AS machine_code FROM stage_events e
         JOIN lots l ON l.id = e.lot_id LEFT JOIN machines m ON m.id = e.machine_id
         WHERE l.order_id = ? ORDER BY e.id`,
      )
      .all(id),
    inspections: db
      .prepare(
        `SELECT i.*, l.lot_no FROM inspections i JOIN lots l ON l.id = i.lot_id WHERE l.order_id = ? ORDER BY i.id`,
      )
      .all(id)
      .map((i) => ({ ...i, defects: JSON.parse(String(i.defects)) })),
  };
}

export function listLots(db: DB, filter: { stage?: string; status?: string }) {
  const where: string[] = [];
  const params: string[] = [];
  if (filter.stage) { where.push('l.stage = ?'); params.push(filter.stage); }
  if (filter.status) { where.push('l.status = ?'); params.push(filter.status); }
  return db
    .prepare(
      `SELECT l.*, o.order_no, o.customer, o.fabric, o.shade_code, o.due_date, o.priority, o.width_cm, m.code AS machine_code
       FROM lots l JOIN orders o ON o.id = l.order_id LEFT JOIN machines m ON m.id = l.machine_id
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY o.priority, o.due_date, l.id`,
    )
    .all(...params);
}

export function listInspections(db: DB) {
  return db
    .prepare(
      `SELECT i.*, l.lot_no, o.order_no, o.customer FROM inspections i
       JOIN lots l ON l.id = i.lot_id JOIN orders o ON o.id = l.order_id ORDER BY i.id DESC LIMIT 100`,
    )
    .all()
    .map((i) => ({ ...i, defects: JSON.parse(String(i.defects)) }));
}

export function listRecipes(db: DB) {
  return (db.prepare('SELECT shade_code FROM recipes ORDER BY shade_code').all() as { shade_code: string }[]).map(
    (r) => getRecipe(db, r.shade_code)!,
  );
}
