import { DatabaseSync } from 'node:sqlite';

export type DB = DatabaseSync;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS machines (
  id INTEGER PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  stage TEXT NOT NULL,
  capacity_m_per_hr REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'idle' CHECK (status IN ('idle','running','maintenance'))
);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY,
  order_no TEXT UNIQUE NOT NULL,
  customer TEXT NOT NULL,
  fabric TEXT NOT NULL,
  gsm REAL NOT NULL,
  width_cm REAL NOT NULL,
  shade_code TEXT,
  quantity_m REAL NOT NULL,
  due_date TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 2 CHECK (priority BETWEEN 1 AND 3),
  status TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','in_progress','completed')),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS lots (
  id INTEGER PRIMARY KEY,
  lot_no TEXT UNIQUE NOT NULL,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  quantity_m REAL NOT NULL,
  stage TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued','in_process','on_hold','ready','dispatched','rejected')),
  machine_id INTEGER REFERENCES machines(id),
  rework_count INTEGER NOT NULL DEFAULT 0,
  hold_reason TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS stage_events (
  id INTEGER PRIMARY KEY,
  lot_id INTEGER NOT NULL REFERENCES lots(id),
  stage TEXT NOT NULL,
  machine_id INTEGER REFERENCES machines(id),
  started_at TEXT NOT NULL,
  completed_at TEXT,
  input_m REAL NOT NULL,
  output_m REAL
);

CREATE TABLE IF NOT EXISTS inspections (
  id INTEGER PRIMARY KEY,
  lot_id INTEGER NOT NULL REFERENCES lots(id),
  inspected_m REAL NOT NULL,
  width_cm REAL NOT NULL,
  defects TEXT NOT NULL,
  total_points INTEGER NOT NULL,
  points_per_100sqyd REAL NOT NULL,
  result TEXT NOT NULL CHECK (result IN ('pass','rework','reject')),
  inspector TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS inventory_items (
  id INTEGER PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  unit TEXT NOT NULL,
  qty_on_hand REAL NOT NULL DEFAULT 0,
  reorder_level REAL NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS inventory_txns (
  id INTEGER PRIMARY KEY,
  item_id INTEGER NOT NULL REFERENCES inventory_items(id),
  qty REAL NOT NULL,
  reason TEXT NOT NULL,
  lot_id INTEGER REFERENCES lots(id),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS recipes (
  id INTEGER PRIMARY KEY,
  shade_code TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  liquor_ratio REAL NOT NULL,
  lines TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('info','warning','critical')),
  message TEXT NOT NULL,
  ref TEXT,
  acknowledged INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_lots_stage_status ON lots(stage, status);
CREATE INDEX IF NOT EXISTS idx_events_lot ON stage_events(lot_id);
`;

export function openDb(file: string): DB {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON;');
  if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  return db;
}

const depth = new WeakMap<DB, number>();

/** Runs fn in a transaction. Nested calls join the outer transaction. */
export function tx<T>(db: DB, fn: () => T): T {
  const d = depth.get(db) ?? 0;
  if (d === 0) db.exec('BEGIN IMMEDIATE');
  depth.set(db, d + 1);
  try {
    const result = fn();
    if (d === 0) db.exec('COMMIT');
    return result;
  } catch (err) {
    if (d === 0) db.exec('ROLLBACK');
    throw err;
  } finally {
    depth.set(db, d);
  }
}

export const nowIso = () => new Date().toISOString();
