import { type DB, tx, nowIso } from './db.ts';
import { FIRST_STAGE, STAGES, getStage, nextStage, remainingStages } from './stages.ts';
import { type Defect, DEFECT_TYPES, QC_PASS_LIMIT, pointsPer100SqYd, totalPoints, validateDefects } from './qc.ts';
import { type Recipe, recipeConsumption } from './recipes.ts';

export const MAX_LOT_M = 1500;
export const MAX_REWORKS = 1;

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export interface OrderRow {
  id: number; order_no: string; customer: string; fabric: string; gsm: number; width_cm: number;
  shade_code: string | null; quantity_m: number; due_date: string; priority: number; status: string; created_at: string;
}
export interface LotRow {
  id: number; lot_no: string; order_id: number; quantity_m: number; stage: string; status: string;
  machine_id: number | null; rework_count: number; hold_reason: string | null; updated_at: string;
}
export interface MachineRow {
  id: number; code: string; name: string; stage: string; capacity_m_per_hr: number; status: string;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

// ---------- lookups ----------

export function getLot(db: DB, id: number): LotRow {
  const lot = db.prepare('SELECT * FROM lots WHERE id = ?').get(id) as LotRow | undefined;
  if (!lot) throw new HttpError(404, `Lot ${id} not found`);
  return lot;
}

export function getOrder(db: DB, id: number): OrderRow {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(id) as OrderRow | undefined;
  if (!order) throw new HttpError(404, `Order ${id} not found`);
  return order;
}

export function getRecipe(db: DB, shadeCode: string): Recipe | undefined {
  const row = db.prepare('SELECT * FROM recipes WHERE shade_code = ?').get(shadeCode) as
    | { shade_code: string; name: string; liquor_ratio: number; lines: string }
    | undefined;
  return row && { ...row, lines: JSON.parse(row.lines) };
}

// ---------- alerts ----------

/** Raises an alert unless an unacknowledged one with the same kind and ref already exists. */
export function raiseAlert(db: DB, kind: string, severity: 'info' | 'warning' | 'critical', message: string, ref: string) {
  const open = db.prepare('SELECT id FROM alerts WHERE kind = ? AND ref = ? AND acknowledged = 0').get(kind, ref);
  if (open) return;
  db.prepare('INSERT INTO alerts (kind, severity, message, ref, created_at) VALUES (?, ?, ?, ?, ?)').run(
    kind, severity, message, ref, nowIso(),
  );
}

// ---------- orders ----------

export interface NewOrder {
  customer: string; fabric: string; gsm: number; width_cm: number; shade_code?: string | null;
  quantity_m: number; due_date: string; priority?: number;
}

/** Creates an order and automatically splits it into production lots queued at the first stage. */
export function createOrder(db: DB, input: NewOrder): OrderRow {
  const customer = String(input.customer ?? '').trim();
  const fabric = String(input.fabric ?? '').trim();
  const gsm = Number(input.gsm);
  const width = Number(input.width_cm);
  const qty = Number(input.quantity_m);
  const priority = Number(input.priority ?? 2);
  const shade = input.shade_code ? String(input.shade_code).trim() : null;
  if (!customer || !fabric) throw new HttpError(400, 'customer and fabric are required');
  if (!(gsm > 0) || !(width > 0) || !(qty > 0)) throw new HttpError(400, 'gsm, width_cm and quantity_m must be positive');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.due_date ?? '') || isNaN(Date.parse(input.due_date)))
    throw new HttpError(400, 'due_date must be YYYY-MM-DD');
  if (![1, 2, 3].includes(priority)) throw new HttpError(400, 'priority must be 1 (urgent), 2 (normal) or 3 (low)');
  if (shade && !getRecipe(db, shade)) throw new HttpError(400, `No dye recipe for shade ${shade}`);

  return tx(db, () => {
    const { n } = db.prepare('SELECT COALESCE(MAX(id), 0) + 1 AS n FROM orders').get() as { n: number };
    const orderNo = `SO-${new Date().getFullYear()}-${String(n).padStart(4, '0')}`;
    const ts = nowIso();
    const { lastInsertRowid } = db
      .prepare(`INSERT INTO orders (order_no, customer, fabric, gsm, width_cm, shade_code, quantity_m, due_date, priority, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(orderNo, customer, fabric, gsm, width, shade, qty, input.due_date, priority, ts);
    const orderId = Number(lastInsertRowid);

    const lotCount = Math.ceil(qty / MAX_LOT_M);
    const perLot = round1(qty / lotCount);
    const insertLot = db.prepare(
      `INSERT INTO lots (lot_no, order_id, quantity_m, stage, status, updated_at) VALUES (?, ?, ?, ?, 'queued', ?)`,
    );
    for (let i = 1; i <= lotCount; i++) {
      const lotQty = i < lotCount ? perLot : round1(qty - perLot * (lotCount - 1));
      insertLot.run(`${orderNo}-L${i}`, orderId, lotQty, FIRST_STAGE, ts);
    }
    autoAssign(db);
    return getOrder(db, orderId);
  });
}

// ---------- scheduling ----------

/**
 * Dispatches queued lots to idle machines of the matching stage.
 * Priority order: order priority, then earliest due date, then FIFO.
 */
export function autoAssign(db: DB): { lot_no: string; machine: string }[] {
  return tx(db, () => {
    const started: { lot_no: string; machine: string }[] = [];
    const machines = db.prepare(`SELECT * FROM machines WHERE status = 'idle' ORDER BY id`).all() as unknown as MachineRow[];
    const nextLot = db.prepare(
      `SELECT l.* FROM lots l JOIN orders o ON o.id = l.order_id
       WHERE l.status = 'queued' AND l.stage = ?
       ORDER BY o.priority, o.due_date, l.id LIMIT 1`,
    );
    for (const machine of machines) {
      for (;;) {
        const lot = nextLot.get(machine.stage) as LotRow | undefined;
        if (!lot) break;
        if (startLot(db, lot, machine)) {
          started.push({ lot_no: lot.lot_no, machine: machine.code });
          break;
        }
        // lot was put on hold; try the next one for this machine
      }
    }
    return started;
  });
}

function startLot(db: DB, lot: LotRow, machine: MachineRow): boolean {
  const order = getOrder(db, lot.order_id);
  const ts = nowIso();

  if (lot.stage === 'DYEING' && order.shade_code) {
    const recipe = getRecipe(db, order.shade_code);
    if (!recipe) return holdLotInternal(db, lot, `No recipe for shade ${order.shade_code}`);
    const needs = recipeConsumption(recipe, lot.quantity_m, order.width_cm, order.gsm);
    const shortages: string[] = [];
    for (const need of needs) {
      const item = db.prepare('SELECT id, qty_on_hand FROM inventory_items WHERE code = ?').get(need.item_code) as
        | { id: number; qty_on_hand: number }
        | undefined;
      if (!item || item.qty_on_hand < need.kg)
        shortages.push(`${need.item_code} (need ${need.kg} kg, have ${item?.qty_on_hand ?? 0} kg)`);
    }
    if (shortages.length) {
      holdLotInternal(db, lot, `Material shortage: ${shortages.join(', ')}`);
      raiseAlert(db, 'material_shortage', 'critical', `${lot.lot_no} held at dyeing — short of ${shortages.join(', ')}`, lot.lot_no);
      return false;
    }
    for (const need of needs) {
      const item = db.prepare('SELECT id FROM inventory_items WHERE code = ?').get(need.item_code) as { id: number };
      db.prepare('UPDATE inventory_items SET qty_on_hand = qty_on_hand - ? WHERE id = ?').run(need.kg, item.id);
      db.prepare('INSERT INTO inventory_txns (item_id, qty, reason, lot_id, created_at) VALUES (?, ?, ?, ?, ?)').run(
        item.id, -need.kg, `Issued to dyeing ${lot.lot_no} (${order.shade_code})`, lot.id, ts,
      );
    }
    checkStock(db);
  }

  db.prepare(`UPDATE lots SET status = 'in_process', machine_id = ?, updated_at = ? WHERE id = ?`).run(machine.id, ts, lot.id);
  db.prepare(`UPDATE machines SET status = 'running' WHERE id = ?`).run(machine.id);
  db.prepare('INSERT INTO stage_events (lot_id, stage, machine_id, started_at, input_m) VALUES (?, ?, ?, ?, ?)').run(
    lot.id, lot.stage, machine.id, ts, lot.quantity_m,
  );
  if (order.status === 'planned') db.prepare(`UPDATE orders SET status = 'in_progress' WHERE id = ?`).run(order.id);
  return true;
}

function holdLotInternal(db: DB, lot: LotRow, reason: string): false {
  db.prepare(`UPDATE lots SET status = 'on_hold', hold_reason = ?, updated_at = ? WHERE id = ?`).run(reason, nowIso(), lot.id);
  return false;
}

/** Closes the open stage event, frees the machine and routes the lot to its next stage. */
function finishStage(db: DB, lot: LotRow, outputM: number, routeTo: { stage: string } | 'ready' | 'rejected') {
  const ts = nowIso();
  db.prepare(
    `UPDATE stage_events SET completed_at = ?, output_m = ? WHERE lot_id = ? AND completed_at IS NULL`,
  ).run(ts, outputM, lot.id);
  if (lot.machine_id) db.prepare(`UPDATE machines SET status = 'idle' WHERE id = ? AND status = 'running'`).run(lot.machine_id);
  if (routeTo === 'ready' || routeTo === 'rejected') {
    db.prepare(`UPDATE lots SET status = ?, quantity_m = ?, machine_id = NULL, updated_at = ? WHERE id = ?`).run(
      routeTo, outputM, ts, lot.id,
    );
  } else {
    db.prepare(
      `UPDATE lots SET status = 'queued', stage = ?, quantity_m = ?, machine_id = NULL, updated_at = ? WHERE id = ?`,
    ).run(routeTo.stage, outputM, ts, lot.id);
  }
  updateOrderStatus(db, lot.order_id);
}

// ---------- shop-floor commands ----------

export function completeStage(db: DB, lotId: number, outputM?: number): LotRow {
  return tx(db, () => {
    const lot = getLot(db, lotId);
    if (lot.status !== 'in_process') throw new HttpError(409, `${lot.lot_no} is not in process`);
    if (lot.stage === 'INSPECTION') throw new HttpError(409, 'Inspection stage is completed by recording a QC inspection');
    const output = outputM === undefined ? lot.quantity_m : Number(outputM);
    if (!(output > 0) || output > lot.quantity_m)
      throw new HttpError(400, `output_m must be between 0 and input ${lot.quantity_m} m`);

    const stage = getStage(lot.stage);
    const lossPct = ((lot.quantity_m - output) / lot.quantity_m) * 100;
    if (lossPct > stage.maxLossPct) {
      raiseAlert(db, 'process_loss', 'warning',
        `${lot.lot_no}: ${lossPct.toFixed(2)}% loss at ${stage.name} (limit ${stage.maxLossPct}%)`,
        `${lot.lot_no}:${lot.stage}`);
    }
    const order = getOrder(db, lot.order_id);
    const next = nextStage(lot.stage, order.shade_code);
    finishStage(db, lot, round1(output), next ? { stage: next } : 'ready');
    autoAssign(db);
    return getLot(db, lotId);
  });
}

export interface InspectionInput {
  defects: unknown;
  inspector?: string;
}

/** Records a 4-point inspection and routes the lot: pass → packing, fail → rework at finishing, repeat fail → reject. */
export function recordInspection(db: DB, lotId: number, input: InspectionInput) {
  return tx(db, () => {
    const lot = getLot(db, lotId);
    if (lot.status !== 'in_process' || lot.stage !== 'INSPECTION')
      throw new HttpError(409, `${lot.lot_no} is not on an inspection frame`);
    let defects: Defect[];
    try {
      defects = validateDefects(input.defects);
    } catch (e) {
      throw new HttpError(400, (e as Error).message);
    }
    const order = getOrder(db, lot.order_id);
    const total = totalPoints(defects);
    const rate = pointsPer100SqYd(total, lot.quantity_m, order.width_cm);
    const pass = rate <= QC_PASS_LIMIT;
    const result = pass ? 'pass' : lot.rework_count < MAX_REWORKS ? 'rework' : 'reject';

    db.prepare(
      `INSERT INTO inspections (lot_id, inspected_m, width_cm, defects, total_points, points_per_100sqyd, result, inspector, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(lot.id, lot.quantity_m, order.width_cm, JSON.stringify(defects), total, rate, result, input.inspector ?? null, nowIso());

    if (result === 'pass') {
      finishStage(db, lot, lot.quantity_m, { stage: 'PACKING' });
    } else if (result === 'rework') {
      db.prepare('UPDATE lots SET rework_count = rework_count + 1 WHERE id = ?').run(lot.id);
      finishStage(db, lot, lot.quantity_m, { stage: 'FINISHING' });
      raiseAlert(db, 'qc_rework', 'warning',
        `${lot.lot_no} failed QC (${rate} pts/100 sq yd > ${QC_PASS_LIMIT}); sent back to finishing`, lot.lot_no);
    } else {
      finishStage(db, lot, lot.quantity_m, 'rejected');
      raiseAlert(db, 'qc_reject', 'critical',
        `${lot.lot_no} rejected after rework (${rate} pts/100 sq yd)`, lot.lot_no);
    }
    autoAssign(db);
    return { lot: getLot(db, lotId), total_points: total, points_per_100sqyd: rate, result };
  });
}

export function dispatchLot(db: DB, lotId: number): LotRow {
  return tx(db, () => {
    const lot = getLot(db, lotId);
    if (lot.status !== 'ready') throw new HttpError(409, `${lot.lot_no} is not ready for dispatch`);
    db.prepare(`UPDATE lots SET status = 'dispatched', updated_at = ? WHERE id = ?`).run(nowIso(), lot.id);
    updateOrderStatus(db, lot.order_id);
    return getLot(db, lotId);
  });
}

export function holdLot(db: DB, lotId: number, reason: string): LotRow {
  return tx(db, () => {
    const lot = getLot(db, lotId);
    if (lot.status !== 'queued') throw new HttpError(409, 'Only queued lots can be put on hold');
    holdLotInternal(db, lot, reason?.trim() || 'Manual hold');
    return getLot(db, lotId);
  });
}

export function releaseLot(db: DB, lotId: number): LotRow {
  return tx(db, () => {
    const lot = getLot(db, lotId);
    if (lot.status !== 'on_hold') throw new HttpError(409, `${lot.lot_no} is not on hold`);
    db.prepare(`UPDATE lots SET status = 'queued', hold_reason = NULL, updated_at = ? WHERE id = ?`).run(nowIso(), lot.id);
    autoAssign(db);
    return getLot(db, lotId);
  });
}

function updateOrderStatus(db: DB, orderId: number) {
  const { open } = db
    .prepare(`SELECT COUNT(*) AS open FROM lots WHERE order_id = ? AND status NOT IN ('dispatched','rejected')`)
    .get(orderId) as { open: number };
  if (open === 0) db.prepare(`UPDATE orders SET status = 'completed' WHERE id = ?`).run(orderId);
}

// ---------- machines & inventory ----------

export function setMachineStatus(db: DB, machineId: number, status: string): MachineRow {
  return tx(db, () => {
    const m = db.prepare('SELECT * FROM machines WHERE id = ?').get(machineId) as MachineRow | undefined;
    if (!m) throw new HttpError(404, `Machine ${machineId} not found`);
    if (!['idle', 'maintenance'].includes(status)) throw new HttpError(400, 'status must be idle or maintenance');
    if (m.status === 'running') throw new HttpError(409, `${m.code} is running a lot; complete it first`);
    db.prepare('UPDATE machines SET status = ? WHERE id = ?').run(status, machineId);
    if (status === 'idle') autoAssign(db);
    return db.prepare('SELECT * FROM machines WHERE id = ?').get(machineId) as unknown as MachineRow;
  });
}

/** Receives stock, then automatically releases lots that were held for material shortage. */
export function receiveStock(db: DB, itemId: number, qty: number, reason = 'Goods receipt') {
  return tx(db, () => {
    const q = Number(qty);
    if (!(q > 0)) throw new HttpError(400, 'qty must be positive');
    const item = db.prepare('SELECT * FROM inventory_items WHERE id = ?').get(itemId);
    if (!item) throw new HttpError(404, `Item ${itemId} not found`);
    db.prepare('UPDATE inventory_items SET qty_on_hand = qty_on_hand + ? WHERE id = ?').run(q, itemId);
    db.prepare('INSERT INTO inventory_txns (item_id, qty, reason, created_at) VALUES (?, ?, ?, ?)').run(itemId, q, reason, nowIso());
    const held = db.prepare(`SELECT id, lot_no FROM lots WHERE status = 'on_hold' AND hold_reason LIKE 'Material shortage%'`).all() as {
      id: number; lot_no: string;
    }[];
    for (const lot of held) {
      db.prepare(`UPDATE lots SET status = 'queued', hold_reason = NULL, updated_at = ? WHERE id = ?`).run(nowIso(), lot.id);
      db.prepare(`UPDATE alerts SET acknowledged = 1 WHERE kind = 'material_shortage' AND ref = ?`).run(lot.lot_no);
    }
    autoAssign(db);
    return { item: db.prepare('SELECT * FROM inventory_items WHERE id = ?').get(itemId), released: held.map((l) => l.lot_no) };
  });
}

// ---------- periodic checks ----------

function checkStock(db: DB) {
  const low = db.prepare('SELECT code, name, qty_on_hand, reorder_level, unit FROM inventory_items WHERE qty_on_hand <= reorder_level').all() as {
    code: string; name: string; qty_on_hand: number; reorder_level: number; unit: string;
  }[];
  for (const i of low) {
    raiseAlert(db, 'low_stock', 'warning',
      `${i.name} at ${round1(i.qty_on_hand)} ${i.unit} (reorder level ${i.reorder_level} ${i.unit})`, i.code);
  }
}

/** Estimated machine hours left for an order, assuming each stage's machines share its lots in parallel. */
export function estimateRemainingHours(db: DB, order: OrderRow): number {
  const capacity = new Map<string, number>();
  for (const row of db
    .prepare(`SELECT stage, SUM(capacity_m_per_hr) AS cap FROM machines WHERE status != 'maintenance' GROUP BY stage`)
    .all() as { stage: string; cap: number }[]) capacity.set(row.stage, row.cap);

  const lots = db
    .prepare(`SELECT * FROM lots WHERE order_id = ? AND status IN ('queued','in_process','on_hold')`)
    .all(order.id) as unknown as LotRow[];
  let hours = 0;
  for (const lot of lots) {
    for (const s of remainingStages(lot.stage, order.shade_code)) {
      const cap = capacity.get(s.code) ?? 0;
      hours += cap > 0 ? lot.quantity_m / cap : Infinity;
    }
  }
  return hours;
}

export function runChecks(db: DB, now = new Date()) {
  return tx(db, () => {
    checkStock(db);
    const orders = db.prepare(`SELECT * FROM orders WHERE status != 'completed'`).all() as unknown as OrderRow[];
    for (const order of orders) {
      const hoursLeft = (Date.parse(`${order.due_date}T23:59:59`) - now.getTime()) / 3_600_000;
      const needed = estimateRemainingHours(db, order);
      if (hoursLeft < 0) {
        raiseAlert(db, 'overdue', 'critical', `${order.order_no} (${order.customer}) is past its due date ${order.due_date}`, order.order_no);
      } else if (needed > hoursLeft) {
        raiseAlert(db, 'due_risk', 'warning',
          `${order.order_no} needs ~${Math.round(needed)} machine-hours but only ${Math.round(hoursLeft)} h remain before ${order.due_date}`,
          order.order_no);
      }
    }
    autoAssign(db);
  });
}

// ---------- simulation (demo mode) ----------

/** Completes every in-process lot with realistic random losses and defects. */
export function simulateStep(db: DB, rng: () => number = Math.random) {
  return tx(db, () => {
    const lots = db.prepare(`SELECT * FROM lots WHERE status = 'in_process' ORDER BY id`).all() as unknown as LotRow[];
    const done: string[] = [];
    for (const lot of lots) {
      if (lot.stage === 'INSPECTION') {
        const order = getOrder(db, lot.order_id);
        const targetRate = 5 + rng() * 45; // ~11% of lots exceed the 40-point limit
        const sqYdFactor = (lot.quantity_m * 1.09361 * (order.width_cm / 2.54)) / 3600;
        let budget = Math.round(targetRate * sqYdFactor);
        const defects: Defect[] = [];
        while (budget > 0) {
          const points = 1 + Math.floor(rng() * 4);
          const count = Math.max(1, Math.min(Math.ceil(budget / points), Math.ceil(rng() * 15)));
          const type = DEFECT_TYPES[Math.floor(rng() * DEFECT_TYPES.length)];
          const existing = defects.find((d) => d.type === type && d.points === points);
          if (existing) existing.count += count;
          else defects.push({ type, points, count });
          budget -= points * count;
        }
        recordInspection(db, lot.id, { defects, inspector: 'Simulator' });
      } else {
        const loss = rng() * getStage(lot.stage).maxLossPct * 1.15;
        completeStage(db, lot.id, round1(lot.quantity_m * (1 - loss / 100)));
      }
      done.push(`${lot.lot_no}@${lot.stage}`);
    }
    // packed lots ship automatically in simulation
    const ready = db.prepare(`SELECT id FROM lots WHERE status = 'ready'`).all() as { id: number }[];
    for (const r of ready) dispatchLot(db, r.id);
    runChecks(db);
    return { completed: done, dispatched: ready.length };
  });
}

export { STAGES };
