/**
 * One-time (and repeatable) local setup:
 *   1. creates the database if it does not exist
 *   2. runs every service's migrations
 *   3. loads demo data when the database is empty
 * Usage: npm run setup            (keep existing data)
 *        npm run setup -- --reset (drop and recreate the database)
 */
import pg from 'pg';
import { SERVICES, bootService, config, createPool, publish, tx } from '@erp/platform';
import { syncRoles } from '../services/identity/src/service.ts';
import { SERVICE_DEFS } from './services.ts';
import { hashPassword } from '../services/identity/src/security.ts';
import { DEMO_PASSWORD, DEMO_USERS, linkPortalUsers, seedMasters, seedOrganisation, seedSalesTeam, seedUsers } from './seed-data.ts';
import { seedOperations } from './seed-operations.ts';

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

// Hosted Postgres (DB_ROLE_PER_SERVICE=1, e.g. Supabase): the database exists and cannot be dropped, so a reset drops
// the application's schemas instead.
if (process.env.DB_ROLE_PER_SERVICE === '1') {
  if (reset) {
    console.log('• Dropping the application schemas');
    const pool = createPool('identity');
    for (const schema of [...SERVICES, 'bus']) await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await pool.end();
  }
} else await ensureDatabase();

console.log('• Running migrations');
const services = [];
for (const def of SERVICE_DEFS) {
  services.push(await bootService(def, { pollMs: 200 }));
  console.log(`  ✓ ${def.name}`);
}
const [governance, identity, , masters] = services;
await syncRoles(identity.ctx.pool);

const { rows: [{ n }] } = await identity.ctx.pool.query('SELECT count(*)::int AS n FROM users');
if (n > 0) {
  console.log('• Data already present — skipped demo data (use --reset to start fresh)');
} else {
  console.log('• Loading demo data');
  const pool = identity.ctx.pool;
  await tx(pool, async (c) => {
    const org = await seedOrganisation(c);
    const hash = await hashPassword(DEMO_PASSWORD);
    const userIds = await seedUsers(c, org, hash);
    const parties = await seedMasters(c, userIds['sales@textile.local']);
    await linkPortalUsers(c, parties);
    await seedSalesTeam(c, userIds);

    // One open maker-checker request so the approvals inbox has something to show.
    const purchase = userIds['purchase@textile.local'];
    const party = parties['Velavan Knit Fab'];
    const { rows: [bank] } = await c.query(`
      INSERT INTO masters.party_bank_accounts (party_id, account_name, account_number, ifsc, bank_name, created_by)
      VALUES ($1, 'Velavan Knit Fab', '918020045566771', 'ICIC0006023', 'ICICI Bank', $2) RETURNING id`, [party, purchase]);
    await publish(c, 'masters', 'approval.requested', {
      source_service: 'masters', approval_type: 'party_bank_account', ref_id: bank.id,
      title: 'SUP-00002 Velavan Knit Fab: new bank account', summary: 'Supplier moved collections to ICICI; letter on file',
      payload: { party_id: party, party_code: 'SUP-00002', account_name: 'Velavan Knit Fab', account_number: '•••• 6771', ifsc: 'ICIC0006023', bank_name: 'ICICI Bank' },
      requested_by: purchase, requested_by_name: 'Priya Shah', required_permission: 'governance.approval.decide',
    });
  });
  await governance.consumer?.drain();
  await masters.consumer?.drain();
  console.log(`  ✓ 1 legal entity, 3 GST registrations, 5 warehouses with locations, 15 parties, 8 fabric SKUs, ${DEMO_USERS.length} users`);
  await seedOperations(services);
  console.log('  ✓ procurement and job-work examples (requisition, RFQ, POs, receipts, invoices, job-work orders)');
  console.log('  ✓ inventory and sales examples (lots and rolls, transfers, a stock count, leads, quotations, credit)');
  console.log('  ✓ commerce and fulfilment examples (portal orders, token payments, a dispatched shipment, an order awaiting a split)');
}

for (const s of services) await s.close();
console.log(`
✔ Setup complete. Start everything with:  npm start
  Then open http://localhost:${config.port('gateway')}

  Demo sign-in (all users share the password ${DEMO_PASSWORD}):
${DEMO_USERS.map((u) => `    ${u.email.padEnd(30)} ${u.designation}`).join('\n')}
`);
