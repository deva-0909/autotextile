/**
 * Migrations and demo data, shared by `npm run setup` (local) and the deployed function's one-time setup endpoint.
 * The database must exist; on hosted Postgres (DB_ROLE_PER_SERVICE=1) a reset drops the application schemas.
 */
import { SERVICES, bootService, createPool, publish, tx } from '@erp/platform';
import { syncRoles } from '../services/identity/src/service.ts';
import { SERVICE_DEFS } from './services.ts';
import { hashPassword } from '../services/identity/src/security.ts';
import { DEMO_PASSWORD, DEMO_USERS, linkPortalUsers, seedMasters, seedOrganisation, seedSalesTeam, seedUsers } from './seed-data.ts';
import { seedOperations } from './seed-operations.ts';

export async function setupDatabase({ reset = false, log = console.log }: { reset?: boolean; log?: (line: string) => void } = {}) {
  // Hosted Postgres (DB_ROLE_PER_SERVICE=1, e.g. Supabase): the database exists and cannot be dropped, so a reset drops
  // the application's schemas instead.
  if (process.env.DB_ROLE_PER_SERVICE === '1') {
    if (reset) {
      log('• Dropping the application schemas');
      const pool = createPool('identity');
      for (const schema of [...SERVICES, 'bus']) await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await pool.end();
    }
  }

  log('• Running migrations');
  const services = [];
  for (const def of SERVICE_DEFS) {
    services.push(await bootService(def, { pollMs: 200 }));
    log(`  ✓ ${def.name}`);
  }
  const [governance, identity, , masters] = services;
  await syncRoles(identity.ctx.pool);

  const { rows: [{ n }] } = await identity.ctx.pool.query('SELECT count(*)::int AS n FROM users');
  if (n > 0) {
    log('• Data already present — skipped demo data (use --reset to start fresh)');
  } else {
    log('• Loading demo data');
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
    log(`  ✓ 1 legal entity, 3 GST registrations, 5 warehouses with locations, 15 parties, 8 fabric SKUs, ${DEMO_USERS.length} users`);
    await seedOperations(services);
    log('  ✓ procurement and job-work examples (requisition, RFQ, POs, receipts, invoices, job-work orders)');
    log('  ✓ inventory and sales examples (lots and rolls, transfers, a stock count, leads, quotations, credit)');
    log('  ✓ commerce and fulfilment examples (portal orders, token payments, a dispatched shipment, an order awaiting a split)');
  }

  for (const s of services) await s.close();
}
