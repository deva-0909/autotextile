import fs from 'node:fs';
import path from 'node:path';
import type { Pool } from './db.ts';

/**
 * Applies <dir>/*.sql in name order, once each, inside the service's schema. Each file runs in its own transaction
 * under a transaction-scoped advisory lock, so concurrent starts apply it once and nothing outlives the transaction
 * (session locks would leak behind a transaction pooler).
 */
export async function migrate(pool: Pool, schema: string, dir: string) {
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort() : [];
  const client = await pool.connect();
  try {
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
    await client.query(`CREATE TABLE IF NOT EXISTS ${schema}.schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
    for (const file of files) {
      await client.query('BEGIN');
      try {
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`migrate:${schema}`]);
        const done = await client.query(`SELECT 1 FROM ${schema}.schema_migrations WHERE name = $1`, [file]);
        if (!done.rowCount) {
          await client.query(fs.readFileSync(path.join(dir, file), 'utf8'));
          await client.query(`INSERT INTO ${schema}.schema_migrations (name) VALUES ($1)`, [file]);
        }
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw new Error(`Migration ${schema}/${file} failed: ${(err as Error).message}`);
      }
    }
  } finally {
    client.release();
  }
}
