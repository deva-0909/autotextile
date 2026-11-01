/**
 * Database access without a database connection: every statement goes to the `erp_run` function, over HTTPS to
 * Supabase's REST API (DB_TRANSPORT=http) or, for tests, through a local connection that only ever calls that
 * function (DB_TRANSPORT=rpc). See sql/erp_api.sql for how a transaction is run optimistically.
 *
 * RpcPool and RpcClient expose the small part of node-postgres the services use (query, connect, release, end),
 * so the services' code is unchanged. Inside a transaction:
 *   - each statement is tried in a scratch run (always rolled back) together with the changes made so far, so it
 *     sees them, and its real result is returned;
 *   - plain INSERT ... VALUES statements without RETURNING are only queued (nothing reads their result);
 *   - COMMIT replays every change in one atomic call, checking that rows read FOR UPDATE and rows returned by
 *     changes are unchanged; on a conflict tx() runs the whole transaction again.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
// node-postgres' own conversion of JS values to their text form (dates, arrays, buffers, objects).
import pgUtils from 'pg/lib/utils.js';

type Kind = 'rows' | 'dml_rows' | 'exec';
interface Step { s: string; q: string; k: Kind; write: boolean; lock: boolean; deferred: boolean; ran?: boolean; v?: { rc?: number; h?: string } }
interface RunResult { results: { i: number; rows: Record<string, unknown>[]; rc: number; h: string }[]; uuids: string[]; seqs: [string, number][] }
export type RunFn = (p: { mode: 'dry' | 'commit'; steps: Omit<Step, 'write' | 'lock' | 'deferred'>[]; uuids?: string[]; seqs?: [string, number][] }) => Promise<RunResult>;
interface QueryResult { rows: Record<string, unknown>[]; rowCount: number }

/** Calls made to erp_run so far in this process, by mode (for measuring). */
export const apiCalls = { dry: 0, commit: 0 };
/** With ERP_API_STATS=1: scratch runs counted by statement shape, to see what costs calls. */
export const apiStats = new Map<string, number>();
const shapeOf = (q: string) => stripComments(q).replace(/'(?:[^']|'')*'/g, '?').replace(/\s+/g, ' ').slice(0, 90);
export const transportMode = () => (process.env.DB_TRANSPORT ?? 'pg') as 'pg' | 'rpc' | 'http';

/** Per-transaction context: whether the transaction called another service (then it is not safe to retry). */
export const txContext = new AsyncLocalStorage<{ external: boolean }>();
export function markExternalCall() { const c = txContext.getStore(); if (c) c.external = true; }

// ------------------------------------------------------------------ SQL text
const literal = (v: unknown): string => {
  if (v === null || v === undefined) return 'NULL';
  const s = String(pgUtils.prepareValue(v));
  return `'${s.replace(/'/g, "''")}'`;
};
/** Puts parameter values into the SQL as quoted literals (untyped, so Postgres infers their type as it does for $n). */
export function interpolate(sql: string, params: unknown[] = []): string {
  if (!params.length) return sql;
  return sql.replace(/\$(\d+)\b/g, (m, n: string) => {
    const i = Number(n) - 1;
    return i >= 0 && i < params.length ? literal(params[i]) : m;
  });
}
const stripComments = (sql: string) => sql.replace(/^(\s|--[^\n]*\n|\/\*[\s\S]*?\*\/)+/, '');
const SIDE_EFFECT_FN = /\b(pg_advisory\w*|pg_notify|set_config|nextval|setval|erp_nextval|erp_uuid|gen_random_uuid|pg_terminate_backend)\s*\(/i;

function classify(sql: string): { kind: Kind | 'begin' | 'commit' | 'rollback' | 'savepoint' | 'release' | 'rollback_to'; write: boolean; lock: boolean; deferrable: boolean; expect?: number } {
  // Hints from the code: /* erp:defer */ a change whose result is not used (applied at commit);
  // /* erp:expect N */ a guarded change that must touch N rows (checked at commit; until then it reports N).
  const hint = sql.match(/^\s*\/\*\s*erp:(defer|expect\s+(\d+))\s*\*\//);
  if (hint) return { kind: 'exec', write: true, lock: false, deferrable: true, ...(hint[2] ? { expect: Number(hint[2]) } : {}) };
  const t = stripComments(sql);
  const w = (t.match(/^[A-Za-z]+/)?.[0] ?? '').toUpperCase();
  const lock = /\bFOR\s+(UPDATE|SHARE|NO\s+KEY\s+UPDATE|KEY\s+SHARE)\b/i.test(t);
  if (w === 'BEGIN' || w === 'START') return { kind: 'begin', write: false, lock, deferrable: false };
  if (w === 'COMMIT' || w === 'END') return { kind: 'commit', write: false, lock, deferrable: false };
  if (w === 'ROLLBACK') return { kind: /^ROLLBACK\s+TO\b/i.test(t) ? 'rollback_to' : 'rollback', write: false, lock, deferrable: false };
  if (w === 'SAVEPOINT') return { kind: 'savepoint', write: false, lock, deferrable: false };
  if (w === 'RELEASE') return { kind: 'release', write: false, lock, deferrable: false };
  // A lock or notification whose result nobody reads (the event bus's publish): queued, applied at commit.
  if (w === 'SELECT' && /^SELECT\s+pg_(advisory_xact_lock|notify)\s*\([^;()]*(\([^;()]*\)[^;()]*)*\)\s*;?\s*$/i.test(t)) return { kind: 'rows', write: true, lock, deferrable: true };
  if (w === 'SELECT' || w === 'VALUES' || w === 'TABLE') return { kind: 'rows', write: SIDE_EFFECT_FN.test(t), lock, deferrable: false };
  if (w === 'WITH') {
    // A data-modifying WITH cannot be wrapped in a subquery: run it as is (its RETURNING rows are not available).
    const dml = /\b(INSERT\s+INTO|UPDATE\s+\w|DELETE\s+FROM)\b/i.test(t);
    return { kind: dml ? 'exec' : 'rows', write: dml || SIDE_EFFECT_FN.test(t), lock, deferrable: false };
  }
  if (w === 'INSERT' || w === 'UPDATE' || w === 'DELETE' || w === 'MERGE') {
    const returning = /\bRETURNING\b/i.test(t);
    const deferrable = w === 'INSERT' && !returning && !/\bON\s+CONFLICT\b/i.test(t) && !/\bSELECT\b/i.test(t);
    return { kind: returning ? 'dml_rows' : 'exec', write: true, lock, deferrable };
  }
  return { kind: 'exec', write: true, lock, deferrable: false };
}

// ------------------------------------------------------------------ results like node-postgres'
const ISO_TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?([+-]\d{2}:\d{2}|Z)?$/;
const HEX = /^\\x([0-9a-f]{2})*$/;
/** Top-level timestamps as Date and bytea as Buffer, as node-postgres returns them (nested JSON stays as text). */
function shape(rows: Record<string, unknown>[]) {
  for (const r of rows) for (const [k, v] of Object.entries(r)) {
    if (typeof v !== 'string') continue;
    if (ISO_TS.test(v)) r[k] = new Date(v);
    else if (v.length > 2 && HEX.test(v)) r[k] = Buffer.from(v.slice(2), 'hex');
  }
  return rows;
}

/** An error shaped like node-postgres' (code, message, detail), so errors.ts maps it the same way. */
export class RpcError extends Error {
  code?: string; detail?: string; hint?: string;
  constructor(message: string, code?: string, detail?: string, hint?: string) { super(message); this.code = code; this.detail = detail; this.hint = hint; }
}
const isConflict = (e: unknown) => (e as { code?: string })?.code === '40001';

// ------------------------------------------------------------------ transports
/** HTTPS to Supabase: POST /rest/v1/rpc/erp_run with the server-only key. */
export function httpRunner(url: string, key: string): RunFn {
  const endpoint = `${url.replace(/\/$/, '')}/rest/v1/rpc/erp_run`;
  return async (p) => {
    apiCalls[p.mode]++;
    for (let attempt = 1; ; attempt++) {
      let res: Response;
      try {
        res = await fetch(endpoint, { method: 'POST', headers: { apikey: key, authorization: `Bearer ${key}`, 'content-type': 'application/json', prefer: 'return=representation' }, body: JSON.stringify({ p }) });
      } catch (e) {
        if (attempt < 3) continue; // network blip: the call is atomic, so retrying is safe
        throw new RpcError(`Database API unreachable: ${(e as Error).message}`, '08006');
      }
      const body = await res.json().catch(() => null) as { code?: string; message?: string; details?: string; hint?: string } | RunResult | null;
      if (res.ok) return body as RunResult;
      const err = (body ?? {}) as { code?: string; message?: string; details?: string; hint?: string };
      if ((res.status === 503 || res.status === 502 || res.status === 504) && attempt < 3) continue;
      throw new RpcError(err.message ?? `Database API error ${res.status}`, err.code, err.details, err.hint);
    }
  };
}

/** For tests: the same function, called through one local connection pool (no transaction is ever held open). */
export function localRunner(databaseUrl: string): { run: RunFn; raw: pg.Pool } {
  const raw = new pg.Pool({ connectionString: databaseUrl, max: Number(process.env.PG_POOL_MAX ?? 10) });
  return {
    raw,
    run: async (p) => {
      apiCalls[p.mode]++;
      const { rows } = await raw.query('SELECT public.erp_run($1::jsonb) AS out', [JSON.stringify(p)]);
      return rows[0].out as RunResult;
    },
  };
}

/** Installs erp_run and friends (local and CI databases; on Supabase they are installed once as a migration). */
export async function installApi(raw: pg.Pool) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // One connection for lock, install and unlock (a pooled query may land on a different connection each time).
  const c = await raw.connect();
  try {
    await c.query('BEGIN');
    await c.query(`SELECT pg_advisory_xact_lock(hashtext('erp:api'))`);
    await c.query(fs.readFileSync(path.join(here, 'sql', 'erp_api.sql'), 'utf8'));
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

// ------------------------------------------------------------------ pool and client
export class RpcPool {
  schema: string; run: RunFn;
  /** The database's address when it is reachable directly (tests, on-premise); empty over HTTPS. */
  options: { connectionString?: string };
  constructor(schema: string, run: RunFn, connectionString?: string) { this.schema = schema; this.run = run; this.options = { connectionString }; }
  /** A statement on its own: one atomic call. */
  async query(sql: string, params?: unknown[]): Promise<QueryResult> {
    const text = interpolate(sql, params);
    const c = classify(text);
    if (process.env.ERP_API_STATS) { const k = `[single] ${shapeOf(text)}`; apiStats.set(k, (apiStats.get(k) ?? 0) + 1); }
    if (c.kind === 'begin' || c.kind === 'commit' || c.kind === 'rollback') return { rows: [], rowCount: 0 };
    if (c.kind === 'savepoint' || c.kind === 'release' || c.kind === 'rollback_to') throw new RpcError('Savepoints need a transaction');
    const out = await this.run({ mode: 'commit', steps: [{ s: this.schema, q: text, k: c.kind as Kind, r: true } as never] });
    const r = out.results[0];
    return { rows: shape(r?.rows ?? []), rowCount: r?.rc ?? 0 };
  }
  async connect() { return new RpcClient(this); }
  async end() { /* nothing held open */ }
  on() { return this; }
}

export class RpcClient {
  private log: Step[] = [];
  private marks: { name: string; len: number; uuids: number; seqs: number }[] = [];
  private uuids: string[] = [];
  private seqs: [string, number][] = [];
  private inTx = false;
  private pool: RpcPool;
  constructor(pool: RpcPool) { this.pool = pool; }
  release() { this.reset(); }
  on() { return this; }
  private reset() { this.log = []; this.marks = []; this.uuids = []; this.seqs = []; this.inTx = false; }
  private replaySteps() { return this.log.filter((s) => s.write).map(({ s, q, k }) => ({ s, q, k })); }

  async query(sql: string | { text: string; values?: unknown[] }, params?: unknown[]): Promise<QueryResult> {
    const text = typeof sql === 'string' ? interpolate(sql, params) : interpolate(sql.text, sql.values ?? params);
    const c = classify(text);
    switch (c.kind) {
      case 'begin': this.reset(); this.inTx = true; return { rows: [], rowCount: 0 };
      case 'rollback': this.reset(); return { rows: [], rowCount: 0 };
      case 'commit': await this.commit(); return { rows: [], rowCount: 0 };
      case 'savepoint': {
        if (this.log.some((s) => s.deferred && !s.ran)) await this.dry(null); // record keys queued changes will use
        this.marks.push({ name: text.trim().split(/\s+/)[1] ?? '', len: this.log.length, uuids: this.uuids.length, seqs: this.seqs.length });
        return { rows: [], rowCount: 0 };
      }
      case 'release': { const n = text.trim().split(/\s+/).pop(); this.marks = this.marks.filter((m) => m.name !== n); return { rows: [], rowCount: 0 }; }
      case 'rollback_to': {
        const n = text.trim().split(/\s+/).pop();
        const m = [...this.marks].reverse().find((x) => x.name === n);
        if (!m) throw new RpcError(`No savepoint ${n}`);
        this.log.length = m.len; this.uuids.length = m.uuids; this.seqs.length = m.seqs;
        return { rows: [], rowCount: 0 };
      }
    }
    if (!this.inTx) return this.pool.query(text);
    const step: Step = { s: this.pool.schema, q: text, k: c.kind as Kind, write: c.write, lock: c.lock, deferred: c.deferrable };
    if (c.deferrable) {
      if (c.expect !== undefined) step.v = { rc: c.expect };
      this.log.push(step);
      return { rows: [], rowCount: c.expect ?? 1 };
    }
    const r = await this.dry(step);
    // What the code saw, checked again at commit: rows read for update, and rows or counts from changes.
    if (c.lock || (c.write && c.kind === 'dml_rows')) step.v = { rc: r.rc, h: r.h };
    else if (c.write && c.kind === 'exec') step.v = { rc: r.rc };
    this.log.push(step);
    return { rows: shape(r.rows), rowCount: r.rc };
  }

  /** Scratch run of the changes so far plus `step` (rolled back), returning the step's result. */
  private async dry(step: Step | null) {
    if (process.env.ERP_API_STATS && step) apiStats.set(shapeOf(step.q), (apiStats.get(shapeOf(step.q)) ?? 0) + 1);
    const steps = [...this.replaySteps(), ...(step ? [{ s: step.s, q: step.q, k: step.k, r: true }] : [])];
    const out = await this.pool.run({ mode: 'dry', steps: steps as never, uuids: this.uuids, seqs: this.seqs });
    this.uuids = out.uuids ?? this.uuids;
    this.seqs = out.seqs ?? this.seqs;
    for (const s of this.log) if (s.deferred) s.ran = true; // queued changes have now run once
    return out.results[0] ?? { i: 0, rows: [], rc: 0, h: '' };
  }

  private async commit() {
    const steps = this.log.filter((s) => s.write || s.lock).map(({ s, q, k, v, write }) => ({ s, q, k, ...(v && (v.rc !== undefined || v.h) ? { v } : {}), ...(write ? {} : {}) }));
    const changes = this.log.some((s) => s.write);
    try {
      if (changes) await this.pool.run({ mode: 'commit', steps: steps as never, uuids: this.uuids, seqs: this.seqs });
    } finally {
      this.reset();
    }
  }
}

/** Runs fn as one optimistic transaction, retrying on a conflict unless it called another service. */
export async function rpcTx<T>(pool: RpcPool, fn: (c: RpcClient) => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    const ctx = { external: false };
    const c = await pool.connect();
    try {
      return await txContext.run(ctx, async () => {
        await c.query('BEGIN');
        const result = await fn(c);
        await c.query('COMMIT');
        return result;
      });
    } catch (e) {
      await c.query('ROLLBACK').catch(() => {});
      if (isConflict(e) && !ctx.external && attempt < 4) continue;
      if (isConflict(e)) throw Object.assign(new RpcError('Someone else changed this at the same moment. Please try again.', '40001'), { status: 409 });
      throw e;
    } finally {
      c.release();
    }
  }
}
