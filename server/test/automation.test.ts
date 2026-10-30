import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, type DB } from '../src/db.ts';
import { seed } from '../src/seed.ts';
import * as auto from '../src/automation.ts';
import { pointsPer100SqYd } from '../src/qc.ts';
import { recipeConsumption } from '../src/recipes.ts';

const future = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);

function freshDb(): DB {
  const db = openDb(':memory:');
  seed(db, { simulateSteps: 0 });
  // start from an empty shop floor
  db.exec(`DELETE FROM stage_events; DELETE FROM inventory_txns; DELETE FROM lots; DELETE FROM orders; DELETE FROM alerts;
           UPDATE machines SET status = 'idle';`);
  return db;
}

const lotsOf = (db: DB, orderId: number) =>
  db.prepare('SELECT * FROM lots WHERE order_id = ? ORDER BY id').all(orderId) as unknown as auto.LotRow[];

/** Pushes a lot through stages with no loss until it reaches `stage`. */
function advanceTo(db: DB, lotId: number, stage: string) {
  for (let i = 0; i < 20; i++) {
    const lot = auto.getLot(db, lotId);
    if (lot.stage === stage && lot.status === 'in_process') return lot;
    if (lot.status !== 'in_process') throw new Error(`lot stuck in ${lot.stage}/${lot.status}`);
    auto.completeStage(db, lotId);
  }
  throw new Error('did not reach stage');
}

test('order is split into lots and the first lot starts on the warper', () => {
  const db = freshDb();
  const order = auto.createOrder(db, { customer: 'C', fabric: 'Poplin', gsm: 120, width_cm: 150, shade_code: 'NAVY-01', quantity_m: 4000, due_date: future });
  const lots = lotsOf(db, order.id);
  assert.equal(lots.length, 3);
  assert.equal(lots.reduce((s, l) => s + l.quantity_m, 0), 4000);
  assert.equal(lots[0].status, 'in_process');
  assert.equal(lots[1].status, 'queued');
  assert.equal(auto.getOrder(db, order.id).status, 'in_progress');
});

test('urgent orders are scheduled ahead of normal ones', () => {
  const db = freshDb();
  db.exec(`UPDATE machines SET status = 'maintenance' WHERE stage = 'WARPING'`);
  const normal = auto.createOrder(db, { customer: 'A', fabric: 'F', gsm: 100, width_cm: 150, quantity_m: 500, due_date: future, priority: 2 });
  const urgent = auto.createOrder(db, { customer: 'B', fabric: 'F', gsm: 100, width_cm: 150, quantity_m: 500, due_date: future, priority: 1 });
  const warper = db.prepare(`SELECT id FROM machines WHERE stage = 'WARPING'`).get() as { id: number };
  auto.setMachineStatus(db, warper.id, 'idle');
  assert.equal(lotsOf(db, urgent.id)[0].status, 'in_process');
  assert.equal(lotsOf(db, normal.id)[0].status, 'queued');
});

test('undyed orders skip the dyeing stage', () => {
  const db = freshDb();
  const order = auto.createOrder(db, { customer: 'A', fabric: 'F', gsm: 100, width_cm: 150, shade_code: null, quantity_m: 500, due_date: future });
  const lot = lotsOf(db, order.id)[0];
  advanceTo(db, lot.id, 'PRETREATMENT');
  auto.completeStage(db, lot.id);
  assert.equal(auto.getLot(db, lot.id).stage, 'FINISHING');
});

test('dyeing issues recipe chemicals from stock', () => {
  const db = freshDb();
  const order = auto.createOrder(db, { customer: 'A', fabric: 'F', gsm: 200, width_cm: 150, shade_code: 'RED-02', quantity_m: 1000, due_date: future });
  const lot = lotsOf(db, order.id)[0];
  const before = (db.prepare(`SELECT qty_on_hand FROM inventory_items WHERE code = 'D-RRED'`).get() as { qty_on_hand: number }).qty_on_hand;
  advanceTo(db, lot.id, 'DYEING');
  const after = (db.prepare(`SELECT qty_on_hand FROM inventory_items WHERE code = 'D-RRED'`).get() as { qty_on_hand: number }).qty_on_hand;
  // 1000 m x 1.5 m x 200 gsm = 300 kg fabric; 2.5% owf = 7.5 kg
  assert.ok(Math.abs(before - after - 7.5) < 1e-6);
});

test('material shortage holds the lot, and receiving stock releases it', () => {
  const db = freshDb();
  db.exec(`UPDATE inventory_items SET qty_on_hand = 0 WHERE code = 'D-RBLK'`);
  const order = auto.createOrder(db, { customer: 'A', fabric: 'F', gsm: 200, width_cm: 150, shade_code: 'BLACK-03', quantity_m: 1000, due_date: future });
  const lot = lotsOf(db, order.id)[0];
  advanceTo(db, lot.id, 'PRETREATMENT');
  auto.completeStage(db, lot.id);
  let held = auto.getLot(db, lot.id);
  assert.equal(held.status, 'on_hold');
  assert.match(held.hold_reason!, /Material shortage: D-RBLK/);
  assert.ok(db.prepare(`SELECT 1 FROM alerts WHERE kind = 'material_shortage'`).get());

  const item = db.prepare(`SELECT id FROM inventory_items WHERE code = 'D-RBLK'`).get() as { id: number };
  const res = auto.receiveStock(db, item.id, 100);
  assert.deepEqual(res.released, [held.lot_no]);
  held = auto.getLot(db, lot.id);
  assert.equal(held.status, 'in_process');
  assert.equal(held.stage, 'DYEING');
});

test('excess process loss raises an alert', () => {
  const db = freshDb();
  const order = auto.createOrder(db, { customer: 'A', fabric: 'F', gsm: 100, width_cm: 150, quantity_m: 1000, due_date: future });
  const lot = lotsOf(db, order.id)[0];
  auto.completeStage(db, lot.id, 950); // 5% at warping, limit 0.5%
  assert.ok(db.prepare(`SELECT 1 FROM alerts WHERE kind = 'process_loss'`).get());
  assert.equal(auto.getLot(db, lot.id).quantity_m, 950);
});

test('QC: pass goes to packing, first fail is reworked, second fail is rejected', () => {
  const db = freshDb();
  const order = auto.createOrder(db, { customer: 'A', fabric: 'F', gsm: 100, width_cm: 150, quantity_m: 1000, due_date: future });
  const lot = lotsOf(db, order.id)[0];
  const badDefects = [{ type: 'Hole', points: 4, count: 500 }];

  advanceTo(db, lot.id, 'INSPECTION');
  const r1 = auto.recordInspection(db, lot.id, { defects: badDefects });
  assert.equal(r1.result, 'rework');
  assert.equal(r1.lot.stage, 'FINISHING');

  advanceTo(db, lot.id, 'INSPECTION');
  const r2 = auto.recordInspection(db, lot.id, { defects: badDefects });
  assert.equal(r2.result, 'reject');
  assert.equal(r2.lot.status, 'rejected');
  assert.equal(auto.getOrder(db, order.id).status, 'completed');
});

test('a passed lot can be packed and dispatched, completing the order', () => {
  const db = freshDb();
  const order = auto.createOrder(db, { customer: 'A', fabric: 'F', gsm: 100, width_cm: 150, quantity_m: 800, due_date: future });
  const lot = lotsOf(db, order.id)[0];
  advanceTo(db, lot.id, 'INSPECTION');
  assert.equal(auto.recordInspection(db, lot.id, { defects: [{ type: 'Slub', points: 1, count: 5 }] }).result, 'pass');
  advanceTo(db, lot.id, 'PACKING');
  auto.completeStage(db, lot.id);
  assert.equal(auto.getLot(db, lot.id).status, 'ready');
  auto.dispatchLot(db, lot.id);
  assert.equal(auto.getOrder(db, order.id).status, 'completed');
});

test('due-date risk alert when remaining work exceeds time left', () => {
  const db = freshDb();
  const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  auto.createOrder(db, { customer: 'A', fabric: 'F', gsm: 100, width_cm: 150, quantity_m: 20000, due_date: tomorrow });
  auto.runChecks(db);
  assert.ok(db.prepare(`SELECT 1 FROM alerts WHERE kind = 'due_risk'`).get());
});

test('validation rejects bad orders', () => {
  const db = freshDb();
  assert.throws(() => auto.createOrder(db, { customer: '', fabric: 'F', gsm: 1, width_cm: 1, quantity_m: 1, due_date: future }), /required/);
  assert.throws(() => auto.createOrder(db, { customer: 'A', fabric: 'F', gsm: 1, width_cm: 1, quantity_m: 1, due_date: future, shade_code: 'NOPE' }), /No dye recipe/);
});

test('4-point and recipe calculations', () => {
  // 100 points over 100 yd x 36 in = 100 points per 100 sq yd
  assert.equal(pointsPer100SqYd(100, 100 / 1.09361, 36 * 2.54), 100);
  const needs = recipeConsumption({ shade_code: 'X', name: 'X', liquor_ratio: 10, lines: [
    { item_code: 'D', basis: 'owf', amount: 2 }, { item_code: 'S', basis: 'gpl', amount: 50 },
  ] }, 1000, 100, 100); // 100 kg fabric, 1000 L bath
  assert.deepEqual(needs, [{ item_code: 'D', kg: 2 }, { item_code: 'S', kg: 50 }]);
});

test('seeded simulation runs without errors', () => {
  const db = openDb(':memory:');
  seed(db, { simulateSteps: 25 });
  const { n } = db.prepare(`SELECT COUNT(*) AS n FROM lots WHERE status = 'dispatched'`).get() as { n: number };
  assert.ok(n > 0);
});
