import pg from 'pg';
import { config } from './config.ts';
import { RpcPool, httpRunner, installApi, localRunner, rpcTx, transportMode, type RunFn } from './transport.ts';

export type Client = pg.PoolClient;
export type Pool = pg.Pool;

// Return NUMERIC and BIGINT as JS numbers (values in this ERP stay well within double precision).
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (v) => Number(v));
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number(v));
// Keep DATE columns as 'YYYY-MM-DD' strings instead of shifting them through local time.
pg.types.setTypeParser(pg.types.builtins.DATE, (v) => v);

/**
 * A pool whose search_path is the service's own schema, so services never touch each other's tables.
 *
 * With DB_ROLE_PER_SERVICE=1 (hosted Postgres behind a transaction pooler such as Supabase's) per-connection settings
 * do not survive between transactions, and every distinct login role gets its own server-side pool, which would
 * exhaust a small database's connection slots. So every service logs in as one role (`erp_identity`, which acts as
 * erp_owner) and its search_path is set with SET LOCAL inside each transaction; a statement outside a transaction is
 * wrapped in one of its own. The user in DATABASE_URL is `erp_owner[.project-ref]` or `erp_identity[.project-ref]`.
 */
// One runner per database for the web-API transports (all services share it; nothing is held open).
const runners = new Map<string, { run: RunFn; ready: Promise<unknown> }>();
function runnerFor(databaseUrl: string) {
  const mode = transportMode();
  const key = mode === 'http' ? 'http' : databaseUrl;
  let r = runners.get(key);
  if (!r) {
    if (mode === 'http') {
      const url = process.env.SUPABASE_URL, k = process.env.SUPABASE_SERVICE_ROLE_KEY;
      if (!url || !k) throw new Error('DB_TRANSPORT=http needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY');
      r = { run: httpRunner(url, k), ready: Promise.resolve() };
    } else {
      const l = localRunner(databaseUrl);
      r = { run: l.run, ready: installApi(l.raw) };
    }
    runners.set(key, r);
  }
  return r;
}
/** Ready when the database API functions are installed (local and test databases install them on first use). */
export const apiReady = (databaseUrl = config.databaseUrl()) => (transportMode() === 'pg' ? Promise.resolve() : runnerFor(databaseUrl).ready);

export function createPool(schema: string, databaseUrl = config.databaseUrl()): Pool {
  if (transportMode() !== 'pg') {
    const r = runnerFor(databaseUrl);
    return new RpcPool(schema, async (p) => { await r.ready; return r.run(p); }, transportMode() === 'rpc' ? databaseUrl : undefined) as unknown as Pool;
  }
  const max = Number(process.env.PG_POOL_MAX ?? 10);
  if (process.env.DB_ROLE_PER_SERVICE === '1') {
    const u = new URL(databaseUrl);
    u.username = u.username.replace(/^erp_owner/, 'erp_identity');
    return new pg.Pool({ connectionString: u.toString(), max, ssl: sslFor(u), idleTimeoutMillis: 5_000, Client: scopedClient(schema) });
  }
  return new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema},public`, max });
}

/** A pg Client that keeps every transaction's search_path on one schema, for transaction-mode poolers. */
function scopedClient(schema: string) {
  const setPath = `SET LOCAL search_path TO ${schema}, public`;
  return class ScopedClient extends pg.Client {
    #inTx = false;
    // pg calls query(text | config, values?, callback?); the pool itself uses the callback form.
    override query(...args: unknown[]): never {
      const cb = typeof args[args.length - 1] === 'function' ? (args.pop() as (e: Error | null, r?: unknown) => void) : null;
      const run = this.#run(args);
      if (cb) { run.then((r) => cb(null, r), (e) => cb(e)); return undefined as never; }
      return run as never;
    }
    async #run(args: unknown[]) {
      const q = (super.query as (...a: unknown[]) => Promise<unknown>).bind(this);
      const first = args[0];
      const text = (typeof first === 'string' ? first : (first as { text?: string })?.text ?? '').trimStart();
      if (/^(BEGIN|START TRANSACTION)\b/i.test(text)) {
        const r = await q(...args);
        await q(setPath);
        this.#inTx = true;
        return r;
      }
      if (/^(COMMIT|END|ROLLBACK)\b/i.test(text) && !/^ROLLBACK\s+TO\b/i.test(text)) {
        this.#inTx = false;
        return q(...args);
      }
      if (this.#inTx) return q(...args);
      await q('BEGIN');
      try {
        await q(setPath);
        const r = await q(...args);
        await q('COMMIT');
        return r;
      } catch (e) {
        await q('ROLLBACK').catch(() => {});
        throw e;
      }
    }
  };
}
/** Hosted Postgres needs TLS; a local server usually has none. */
/** TLS for remote databases; none for a local one, unless the URL says otherwise (sslmode=disable, require or no-verify). */
function sslFor(u: URL) {
  const mode = u.searchParams.get('sslmode');
  if (mode === 'disable') return undefined;
  if (mode === 'require' || mode === 'no-verify') return { rejectUnauthorized: false };
  return ['localhost', '127.0.0.1'].includes(u.hostname) ? undefined : { rejectUnauthorized: false };
}

export async function tx<T>(pool: Pool, fn: (c: Client) => Promise<T>): Promise<T> {
  if (pool instanceof RpcPool) return rpcTx(pool, fn as never);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function one<T>(c: Pool | Client, sql: string, params: unknown[] = []): Promise<T | undefined> {
  const r = await c.query(sql, params);
  return r.rows[0] as T | undefined;
}

export async function many<T>(c: Pool | Client, sql: string, params: unknown[] = []): Promise<T[]> {
  const r = await c.query(sql, params);
  return r.rows as T[];
}
