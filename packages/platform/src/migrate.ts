import fs from 'node:fs';
import path from 'node:path';
import type { Pool } from './db.ts';

/** Applies <dir>/*.sql in name order, once each, inside the service's schema. */
export async function migrate(pool: Pool, schema: string, dir: string) {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(hashtext($1))', [`migrate:${schema}`]);
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
    await client.query(`CREATE TABLE IF NOT EXISTS ${schema}.schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
    const done = new Set((await client.query(`SELECT name FROM ${schema}.schema_migrations`)).rows.map((r) => r.name));
    const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort() : [];
    for (const file of files) {
      if (done.has(file)) continue;
      await client.query('BEGIN');
      try {
        await client.query(fs.readFileSync(path.join(dir, file), 'utf8'));
        await client.query(`INSERT INTO ${schema}.schema_migrations (name) VALUES ($1)`, [file]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${schema}/${file} failed: ${(err as Error).message}`);
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(hashtext($1))', [`migrate:${schema}`]).catch(() => {});
    client.release();
  }
}
