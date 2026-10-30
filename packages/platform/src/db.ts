import pg from 'pg';
import { config } from './config.ts';

export type Client = pg.PoolClient;
export type Pool = pg.Pool;

// Return NUMERIC and BIGINT as JS numbers (values in this ERP stay well within double precision).
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (v) => Number(v));
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number(v));
// Keep DATE columns as 'YYYY-MM-DD' strings instead of shifting them through local time.
pg.types.setTypeParser(pg.types.builtins.DATE, (v) => v);

/** A pool whose search_path is the service's own schema, so services never touch each other's tables. */
export function createPool(schema: string, databaseUrl = config.databaseUrl()): Pool {
  return new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema},public`, max: 10 });
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
