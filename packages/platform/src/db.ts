import pg from 'pg';
import { config } from './config.ts';

export type Client = pg.PoolClient;
export type Pool = pg.Pool;

// Return NUMERIC and BIGINT as JS numbers (values in this ERP stay well within double precision).
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (v) => Number(v));
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number(v));
// Keep DATE columns as 'YYYY-MM-DD' strings instead of shifting them through local time.
pg.types.setTypeParser(pg.types.builtins.DATE, (v) => v);

/**
 * A pool whose search_path is the service's own schema, so services never touch each other's tables.
 * With DB_ROLE_PER_SERVICE=1 (hosted Postgres behind a transaction pooler such as Supabase's, where per-connection
 * settings do not survive between transactions) each service logs in as its own role, `erp_<schema>`, whose
 * search_path is fixed in the database; the user in DATABASE_URL is `erp_owner[.project-ref]` and is swapped per service.
 */
export function createPool(schema: string, databaseUrl = config.databaseUrl()): Pool {
  const max = Number(process.env.PG_POOL_MAX ?? 10);
  if (process.env.DB_ROLE_PER_SERVICE === '1') {
    const u = new URL(databaseUrl);
    u.username = u.username.replace(/^erp_owner/, `erp_${schema}`);
    return new pg.Pool({ connectionString: u.toString(), max, ssl: sslFor(u), idleTimeoutMillis: 5_000 });
  }
  return new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema},public`, max });
}
/** Hosted Postgres needs TLS; a local server usually has none. */
function sslFor(u: URL) {
  return ['localhost', '127.0.0.1'].includes(u.hostname) ? undefined : { rejectUnauthorized: false };
}

export async function tx<T>(pool: Pool, fn: (c: Client) => Promise<T>): Promise<T> {
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
