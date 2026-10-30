import fs from 'node:fs';
import { type DB, openDb, tx } from './db.ts';
import { createOrder, simulateStep, runChecks } from './automation.ts';
import { DB_FILE } from './config.ts';

const MACHINES: [string, string, string, number][] = [
  ['WRP-01', 'Sectional Warper', 'WARPING', 900],
  ['SIZ-01', 'Sizing Machine', 'SIZING', 700],
  ['LOOM-01', 'Air-jet Loom 1', 'WEAVING', 120],
  ['LOOM-02', 'Air-jet Loom 2', 'WEAVING', 120],
  ['LOOM-03', 'Rapier Loom 3', 'WEAVING', 90],
  ['LOOM-04', 'Rapier Loom 4', 'WEAVING', 90],
  ['PRT-01', 'Desize & Scour Range', 'PRETREATMENT', 1800],
  ['JET-01', 'Soft-flow Jet Dyeing 1', 'DYEING', 350],
  ['JET-02', 'Soft-flow Jet Dyeing 2', 'DYEING', 350],
  ['STN-01', 'Stenter', 'FINISHING', 1500],
  ['INS-01', 'Inspection Frame 1', 'INSPECTION', 500],
  ['INS-02', 'Inspection Frame 2', 'INSPECTION', 500],
  ['PCK-01', 'Rolling & Packing', 'PACKING', 1200],
];

const ITEMS: [string, string, string, string, number, number][] = [
  ['Y-CT40', 'Cotton yarn 40s combed', 'yarn', 'kg', 4200, 800],
  ['Y-PC30', 'PC yarn 30s', 'yarn', 'kg', 2600, 600],
  ['D-RRED', 'Reactive Red ME4BL', 'dye', 'kg', 60, 10],
  ['D-RYEL', 'Reactive Yellow ME4GL', 'dye', 'kg', 55, 10],
  ['D-RBLU', 'Reactive Blue RR', 'dye', 'kg', 45, 10],
  ['D-RBLK', 'Reactive Black B', 'dye', 'kg', 12, 15],
  ['C-SALT', "Glauber's salt", 'chemical', 'kg', 3200, 600],
  ['C-SODA', 'Soda ash', 'chemical', 'kg', 1400, 300],
  ['C-WET', 'Wetting agent', 'chemical', 'kg', 180, 40],
  ['C-SEQ', 'Sequestering agent', 'chemical', 'kg', 160, 40],
  ['C-SOFT', 'Silicone softener', 'chemical', 'kg', 220, 50],
];

const RECIPES = [
  { shade_code: 'NAVY-01', name: 'Navy Blue', liquor_ratio: 8, lines: [
    { item_code: 'D-RBLU', basis: 'owf', amount: 3.2 }, { item_code: 'D-RRED', basis: 'owf', amount: 0.6 },
    { item_code: 'D-RBLK', basis: 'owf', amount: 0.8 }, { item_code: 'C-SALT', basis: 'gpl', amount: 70 },
    { item_code: 'C-SODA', basis: 'gpl', amount: 20 }, { item_code: 'C-WET', basis: 'gpl', amount: 1 },
  ] },
  { shade_code: 'RED-02', name: 'Crimson Red', liquor_ratio: 8, lines: [
    { item_code: 'D-RRED', basis: 'owf', amount: 2.5 }, { item_code: 'D-RYEL', basis: 'owf', amount: 0.3 },
    { item_code: 'C-SALT', basis: 'gpl', amount: 60 }, { item_code: 'C-SODA', basis: 'gpl', amount: 18 },
    { item_code: 'C-SEQ', basis: 'gpl', amount: 1 },
  ] },
  { shade_code: 'BLACK-03', name: 'Jet Black', liquor_ratio: 7, lines: [
    { item_code: 'D-RBLK', basis: 'owf', amount: 6 }, { item_code: 'C-SALT', basis: 'gpl', amount: 90 },
    { item_code: 'C-SODA', basis: 'gpl', amount: 22 }, { item_code: 'C-WET', basis: 'gpl', amount: 1 },
  ] },
  { shade_code: 'BEIGE-04', name: 'Sand Beige', liquor_ratio: 9, lines: [
    { item_code: 'D-RYEL', basis: 'owf', amount: 0.4 }, { item_code: 'D-RRED', basis: 'owf', amount: 0.1 },
    { item_code: 'D-RBLK', basis: 'owf', amount: 0.05 }, { item_code: 'C-SALT', basis: 'gpl', amount: 30 },
    { item_code: 'C-SODA', basis: 'gpl', amount: 10 }, { item_code: 'C-SOFT', basis: 'gpl', amount: 2 },
  ] },
];

const daysFromNow = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString().slice(0, 10);

/** Deterministic PRNG so the seeded demo looks the same on every machine. */
function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function seed(db: DB, opts: { simulateSteps?: number } = {}) {
  tx(db, () => {
    const m = db.prepare('INSERT INTO machines (code, name, stage, capacity_m_per_hr) VALUES (?, ?, ?, ?)');
    for (const row of MACHINES) m.run(...row);
    const i = db.prepare('INSERT INTO inventory_items (code, name, category, unit, qty_on_hand, reorder_level) VALUES (?, ?, ?, ?, ?, ?)');
    for (const row of ITEMS) i.run(...row);
    const r = db.prepare('INSERT INTO recipes (shade_code, name, liquor_ratio, lines) VALUES (?, ?, ?, ?)');
    for (const rec of RECIPES) r.run(rec.shade_code, rec.name, rec.liquor_ratio, JSON.stringify(rec.lines));
  });

  createOrder(db, { customer: 'Arvind Apparels', fabric: 'Cotton Poplin 40x40', gsm: 115, width_cm: 147, shade_code: 'NAVY-01', quantity_m: 4200, due_date: daysFromNow(12), priority: 2 });
  createOrder(db, { customer: 'Zara Sourcing', fabric: 'Cotton Twill 2/1', gsm: 210, width_cm: 152, shade_code: 'BLACK-03', quantity_m: 3000, due_date: daysFromNow(6), priority: 1 });
  createOrder(db, { customer: 'FabIndia', fabric: 'Cambric 60x60', gsm: 90, width_cm: 142, shade_code: 'RED-02', quantity_m: 2400, due_date: daysFromNow(18), priority: 2 });
  createOrder(db, { customer: 'Raymond Exports', fabric: 'PC Oxford', gsm: 140, width_cm: 150, shade_code: null, quantity_m: 1800, due_date: daysFromNow(9), priority: 3 });
  createOrder(db, { customer: 'H&M Supply', fabric: 'Cotton Canvas', gsm: 280, width_cm: 150, shade_code: 'BEIGE-04', quantity_m: 1500, due_date: daysFromNow(3), priority: 1 });

  const rng = mulberry32(42);
  for (let s = 0; s < (opts.simulateSteps ?? 7); s++) simulateStep(db, rng);
  runChecks(db);
}

const isMain = process.argv[1]?.endsWith('seed.ts');
if (isMain) {
  if (process.argv.includes('--reset')) for (const f of [DB_FILE, `${DB_FILE}-wal`, `${DB_FILE}-shm`]) fs.rmSync(f, { force: true });
  const db = openDb(DB_FILE);
  seed(db);
  console.log(`Seeded ${DB_FILE}`);
}
