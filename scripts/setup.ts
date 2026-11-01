/**
 * One-time (and repeatable) local setup:
 *   1. creates the database if it does not exist
 *   2. runs every service's migrations
 *   3. loads demo data when the database is empty
 * Usage: npm run setup            (keep existing data)
 *        npm run setup -- --reset (drop and recreate the database)
 */
import pg from 'pg';
import { apiCalls, apiStats, config, transportMode } from '@erp/platform';
import { DEMO_PASSWORD, DEMO_USERS } from './seed-data.ts';
import { setupDatabase } from './setup-lib.ts';

const url = new URL(config.databaseUrl());
const dbName = url.pathname.slice(1);
const reset = process.argv.includes('--reset');

async function ensureDatabase() {
  const admin = new URL(url);
  admin.pathname = '/postgres';
  const client = new pg.Client({ connectionString: admin.toString() });
  try {
    await client.connect();
  } catch (err) {
    const e = err as { code?: string; message: string };
    console.error(`\n✖ Cannot connect to PostgreSQL at ${url.host} as "${url.username}".`);
    if (e.code === 'ECONNREFUSED') console.error('  PostgreSQL is not running, or is on a different port. Start it from Services (Windows) and try again.');
    else if (e.code === '28P01') console.error('  Wrong password. Update DATABASE_URL in the .env file with your PostgreSQL password.');
    else console.error(`  ${e.message}`);
    process.exit(1);
  }
  if (reset) {
    console.log(`• Dropping database ${dbName}`);
    await client.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
  }
  const exists = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
  if (!exists.rowCount) {
    console.log(`• Creating database ${dbName}`);
    await client.query(`CREATE DATABASE "${dbName}"`);
  }
  await client.end();
}

if (process.env.DB_ROLE_PER_SERVICE !== '1') await ensureDatabase();
await setupDatabase({ reset });
if (transportMode() !== 'pg') console.log(`• Database API calls: ${apiCalls.dry} scratch runs, ${apiCalls.commit} commits`);
if (process.env.ERP_API_STATS) for (const [k, n] of [...apiStats].sort((a, b) => b[1] - a[1]).slice(0, 40)) console.log(`  STAT ${String(n).padStart(6)}  ${k}`);
console.log(`
✔ Setup complete. Start everything with:  npm start
  Then open http://localhost:${config.port('gateway')}

  Demo sign-in (all users share the password ${DEMO_PASSWORD}):
${DEMO_USERS.map((u) => `    ${u.email.padEnd(30)} ${u.designation}`).join('\n')}
`);
