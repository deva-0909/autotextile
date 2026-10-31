import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { type Pool, ROOT_DIR, SERVICES, config, many, one, servicePort } from '@erp/platform';

/** The database this service is connected to (tests run against a throwaway one). */
const dbUrl = (pool: Pool) => new URL(((pool as unknown as { options: { connectionString?: string } }).options.connectionString) ?? config.databaseUrl());

/** Tables whose row counts prove a restore is complete: master data, stock, money and people. */
const KEY_TABLES = ['identity.users', 'masters.parties', 'masters.products', 'procurement.purchase_orders', 'inventory.rolls', 'inventory.stock_movements', 'commerce.orders', 'fulfilment.fulfilments', 'finance.vouchers', 'finance.voucher_lines', 'hrms.employees', 'governance.audit_log', 'bus.events'];
export const backupDir = () => path.resolve(process.env.BACKUP_DIR ?? path.join(ROOT_DIR, 'backups'));

export async function systemHealth(pool: Pool) {
  const services = await Promise.all(SERVICES.map(async (s) => {
    const t0 = Date.now();
    const ok = await fetch(`http://127.0.0.1:${servicePort(s)}/health`, { signal: AbortSignal.timeout(2500) }).then((r) => r.ok).catch(() => false);
    return { service: s, ok, ms: Date.now() - t0 };
  }));
  const [lag, dead, sizes, db, conns] = await Promise.all([
    many<{ consumer: string; last_id: number; behind: number }>(pool, `SELECT o.consumer, o.last_id::int, ((SELECT coalesce(max(id), 0) FROM bus.events) - o.last_id)::int AS behind FROM bus.offsets o ORDER BY behind DESC`),
    many(pool, `SELECT d.id, d.consumer, d.event_id, e.type, d.error, d.failed_at, d.replay_requested_at, d.replayed_at, d.replay_error FROM bus.dead_letters d LEFT JOIN bus.events e ON e.id = d.event_id ORDER BY d.id DESC LIMIT 100`),
    many<{ schema: string; bytes: number }>(pool, `SELECT n.nspname AS schema, sum(pg_total_relation_size(c.oid))::bigint AS bytes FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relkind IN ('r','m') AND n.nspname NOT IN ('pg_catalog','information_schema','pg_toast') GROUP BY 1 ORDER BY 2 DESC`),
    one<{ size: string; version: string }>(pool, `SELECT pg_size_pretty(pg_database_size(current_database())) AS size, split_part(version(), ' ', 2) AS version`),
    one<{ n: number }>(pool, `SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database()`),
  ]);
  const events = await one<{ total: number; last_hour: number }>(pool, `SELECT count(*)::int AS total, count(*) FILTER (WHERE occurred_at > now() - interval '1 hour')::int AS last_hour FROM bus.events`);
  return { services, bus: { consumers: lag, events, dead_letters: dead }, database: { ...db, connections: conns!.n, schemas: sizes.map((x) => ({ ...x, bytes: Number(x.bytes) })) }, checked_at: new Date().toISOString() };
}

const counts = async (client: pg.Client | Pool) => {
  const out: Record<string, number> = {};
  for (const t of KEY_TABLES) out[t] = Number((await client.query(`SELECT count(*)::int AS n FROM ${t}`).catch(() => ({ rows: [{ n: -1 }] }))).rows[0].n);
  return out;
};
function run(cmd: string, args: string[], env: NodeJS.ProcessEnv) {
  return new Promise<void>((resolve, reject) => {
    const p = spawn(cmd, args, { env, stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => { err += String(d); });
    p.on('error', (e) => reject(new Error(`${cmd} could not start: ${e.message}. Install the PostgreSQL client tools and put them on PATH.`)));
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err.trim().split('\n').slice(-3).join(' ') || `${cmd} exited with ${code}`))));
  });
}
const pgEnv = (url: URL) => ({ ...process.env, PGHOST: url.hostname, PGPORT: url.port || '5432', PGUSER: decodeURIComponent(url.username), PGPASSWORD: decodeURIComponent(url.password), PGDATABASE: url.pathname.slice(1) });

/** Full backup with pg_dump (custom format), its checksum and the row counts at that moment. */
export async function runBackup(pool: Pool, by: string) {
  const dir = backupDir();
  fs.mkdirSync(dir, { recursive: true });
  const url = dbUrl(pool);
  const name = `${url.pathname.slice(1)}-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.dump`;
  const row = await one<{ id: string }>(pool, `INSERT INTO backups (file_name, status, started_by_name) VALUES ($1, 'running', $2) RETURNING id`, [name, by]);
  const t0 = Date.now();
  try {
    const tableCounts = await counts(pool);
    await run('pg_dump', ['-Fc', '-f', path.join(dir, name)], pgEnv(url));
    const buf = fs.readFileSync(path.join(dir, name));
    const sha = crypto.createHash('sha256').update(buf).digest('hex');
    await pool.query(`UPDATE backups SET status = 'completed', size_bytes = $2, sha256 = $3, table_counts = $4, duration_ms = $5, finished_at = now() WHERE id = $1`, [row!.id, buf.length, sha, JSON.stringify(tableCounts), Date.now() - t0]);
  } catch (e) {
    await pool.query(`UPDATE backups SET status = 'failed', error = $2, duration_ms = $3, finished_at = now() WHERE id = $1`, [row!.id, (e as Error).message, Date.now() - t0]);
  }
  return one(pool, 'SELECT * FROM backups WHERE id = $1', [row!.id]);
}

/**
 * Restore test: checks the file's checksum, restores it into a scratch database, compares row counts with those
 * taken at backup time, then drops the scratch database. The time taken is the measured restore time (RTO evidence).
 */
export async function restoreTest(pool: Pool, id: string) {
  const b = await one<{ file_name: string; sha256: string; table_counts: Record<string, number>; status: string }>(pool, 'SELECT * FROM backups WHERE id = $1', [id]);
  if (!b || b.status !== 'completed') throw new Error('Only completed backups can be restore-tested');
  const file = path.join(backupDir(), b.file_name);
  const url = dbUrl(pool);
  const scratch = `${url.pathname.slice(1)}_restore_check`;
  const admin = new URL(url); admin.pathname = '/postgres';
  const t0 = Date.now();
  const detail: Record<string, unknown> = {};
  let passed = false;
  try {
    if (!fs.existsSync(file)) throw new Error(`Backup file ${b.file_name} is missing from ${backupDir()}`);
    const sha = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    detail.checksum_ok = sha === b.sha256;
    if (!detail.checksum_ok) throw new Error('Checksum does not match: the file changed after the backup');
    const a = new pg.Client({ connectionString: admin.toString() });
    await a.connect();
    await a.query(`DROP DATABASE IF EXISTS "${scratch}" WITH (FORCE)`);
    await a.query(`CREATE DATABASE "${scratch}"`);
    await a.end();
    const target = new URL(url); target.pathname = `/${scratch}`;
    await run('pg_restore', ['--no-owner', '-d', scratch, file], pgEnv(target));
    const c = new pg.Client({ connectionString: target.toString() });
    await c.connect();
    const restored = await counts(c);
    await c.end();
    const diffs = Object.entries(b.table_counts).filter(([t, n]) => restored[t] !== n).map(([t, n]) => ({ table: t, at_backup: n, restored: restored[t] }));
    detail.tables = Object.keys(b.table_counts).length;
    detail.mismatches = diffs;
    passed = diffs.length === 0;
  } catch (e) {
    detail.error = (e as Error).message;
  } finally {
    const a = new pg.Client({ connectionString: admin.toString() });
    await a.connect().then(() => a.query(`DROP DATABASE IF EXISTS "${scratch}" WITH (FORCE)`)).catch(() => undefined).finally(() => a.end().catch(() => undefined));
  }
  await pool.query(`UPDATE backups SET restore_status = $2, restore_detail = $3, restore_ms = $4, restored_at = now() WHERE id = $1`, [id, passed ? 'passed' : 'failed', JSON.stringify(detail), Date.now() - t0]);
  return one(pool, 'SELECT * FROM backups WHERE id = $1', [id]);
}
