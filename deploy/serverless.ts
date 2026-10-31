/**
 * Vercel entry: the gateway and every service in one function instance.
 *
 * Locally each service is its own process; here they boot together (as in the integration tests), each listening on
 * an ephemeral loopback port so service-to-service calls work unchanged. There are no background timers in a
 * serverless instance, so:
 *   - the event bus is drained after every request that changes something (and before reads, at most every few
 *     seconds, to pick up events written by other instances);
 *   - the services' periodic checks and the message dispatcher run in the background at most every few minutes,
 *     and once a day from Vercel Cron (`/api/_cron`).
 * The schema is migrated and the demo data loaded once, by `npm run setup` against the same database.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { waitUntil } from '@vercel/functions';
import pg from 'pg';
import { type Pool, type RunningService, type ServiceName, bootService, setServicePorts } from '@erp/platform';
import { SERVICE_DEFS } from '../scripts/services.ts';
import { createGateway } from '../services/gateway/src/app.ts';
import { runCommerceChecks } from '../services/commerce/src/automation.ts';
import { runCrmChecks } from '../services/crm/src/automation.ts';
import { runFinanceChecks } from '../services/finance/src/automation.ts';
import { runFulfilmentChecks } from '../services/fulfilment/src/automation.ts';
import { runHrChecks } from '../services/hrms/src/automation.ts';
import { runScheduledReports } from '../services/insights/src/automation.ts';
import { runInventoryChecks } from '../services/inventory/src/automation.ts';
import { runJobworkChecks } from '../services/jobwork/src/automation.ts';
import { runProcurementChecks } from '../services/procurement/src/automation.ts';
import { runContractChecks } from '../services/workflow/src/contracts.ts';
import { runScheduled } from '../services/workflow/src/engine.ts';
import { dispatchMessages } from '../services/workflow/src/messaging.ts';
import { setupDatabase } from '../scripts/setup-lib.ts';

/**
 * Supabase connection: either DATABASE_URL (transaction pooler, user erp_identity.<ref>) is set, or it is worked out from
 * SUPABASE_PROJECT_REF, SUPABASE_REGION and DB_PASSWORD by trying the region's pooler clusters (a project lives on one
 * of them; the other answers "tenant not found"). The session-mode URL (port 5432) is used for setup only.
 */
let resolved: Promise<{ transaction: string; session: string }> | null = null;
async function resolveDatabase() {
  if (process.env.DATABASE_URL) {
    const u = new URL(process.env.DATABASE_URL);
    const session = new URL(u); session.port = '5432';
    return { transaction: u.toString(), session: process.env.DATABASE_URL_SESSION ?? session.toString() };
  }
  const ref = process.env.SUPABASE_PROJECT_REF, region = process.env.SUPABASE_REGION, password = process.env.DB_PASSWORD;
  if (!ref || !region || !password) throw new Error('Set DATABASE_URL, or SUPABASE_PROJECT_REF, SUPABASE_REGION and DB_PASSWORD');
  const errors: string[] = [];
  for (const cluster of ['aws-0', 'aws-1', 'aws-2']) {
    const host = `${cluster}-${region}.pooler.supabase.com`;
    const c = new pg.Client({ host, port: 6543, user: `erp_identity.${ref}`, password, database: 'postgres', ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 5_000 });
    try {
      await c.connect();
      await c.end();
      const base = `postgres://erp_identity.${ref}:${encodeURIComponent(password)}@${host}`;
      return { transaction: `${base}:6543/postgres`, session: `${base}:5432/postgres` };
    } catch (e) {
      errors.push(`${host}: ${(e as Error).message}`);
      await c.end().catch(() => {});
    }
  }
  throw new Error(`No Supabase pooler accepted the login: ${errors.join('; ')}`);
}
const database = () => (resolved ??= resolveDatabase().catch((e) => { resolved = null; throw e; }));

type Booted = { gateway: ReturnType<typeof createGateway>; services: RunningService[] };
let booted: Promise<Booted> | null = null;

/**
 * First start on an empty database: migrate and load the demo data before serving (about 10 seconds, once).
 * A session-level advisory lock makes concurrent cold starts wait for the first one instead of seeding twice.
 */
async function ensureSetUp(session: string) {
  const c = new pg.Client({ connectionString: session.replace(/\/\/erp_owner/, '//erp_identity'), ssl: /localhost|127\.0\.0\.1/.test(session) ? undefined : { rejectUnauthorized: false } });
  await c.connect();
  try {
    const ready = async () => (await c.query(`SELECT to_regclass('identity.users') IS NOT NULL AND EXISTS (SELECT 1 FROM identity.users) AS ok`).catch(() => ({ rows: [{ ok: false }] }))).rows[0].ok;
    if (await ready()) return;
    await c.query(`SELECT pg_advisory_lock(hashtext('erp:setup'))`);
    try {
      if (await ready()) return;
      console.log('[setup] empty database: migrating and loading demo data');
      const transaction = process.env.DATABASE_URL;
      process.env.DATABASE_URL = session;
      try { await setupDatabase({ log: (l) => console.log(`[setup] ${l}`) }); } finally { process.env.DATABASE_URL = transaction; }
    } finally {
      await c.query(`SELECT pg_advisory_unlock(hashtext('erp:setup'))`).catch(() => {});
    }
  } finally {
    await c.end().catch(() => {});
  }
}

async function boot(): Promise<Booted> {
  const db = await database();
  process.env.DATABASE_URL = db.transaction;
  await ensureSetUp(db.session);
  const services = await Promise.all(SERVICE_DEFS.map((def) => bootService(def, { serverless: true })));
  const ports: Partial<Record<ServiceName, number>> = {};
  await Promise.all(services.map((s) => new Promise<void>((resolve) => {
    const srv = s.app.listen(0, '127.0.0.1', () => { ports[s.ctx.name] = (srv.address() as AddressInfo).port; resolve(); });
  })));
  setServicePorts(ports);
  return { gateway: createGateway(ports as Record<ServiceName, number>), services };
}

// ---- event bus ----
let draining: Promise<void> | null = null;
let lastDrain = 0;
async function drainAll(services: RunningService[]) {
  if (draining) return draining;
  draining = (async () => {
    // Two rounds: handlers publish events that other services consume.
    for (let round = 0; round < 2; round++)
      for (const s of services) await s.consumer?.drain().catch((e) => console.error(`[drain:${s.ctx.name}]`, (e as Error).message));
    lastDrain = Date.now();
  })().finally(() => { draining = null; });
  return draining;
}

// ---- periodic checks (the timers of the long-running services) ----
const pool = (services: RunningService[], n: ServiceName): Pool => services.find((s) => s.ctx.name === n)!.ctx.pool;
let lastChecks = 0;
let lastDispatch = 0;
async function runChecks(services: RunningService[], force = false) {
  const now = Date.now();
  const p = (n: ServiceName) => pool(services, n);
  const safe = (name: string, f: () => Promise<unknown>) => f().catch((e) => console.error(`[${name}]`, (e as Error).message));
  if (force || now - lastDispatch > 20_000) {
    lastDispatch = now;
    await safe('messages', () => dispatchMessages(p('workflow')));
    await safe('scheduler', () => runScheduled(p('workflow')));
  }
  if (!force && now - lastChecks < 10 * 60_000) return;
  lastChecks = now;
  await safe('procurement', () => runProcurementChecks(p('procurement')));
  await safe('jobwork', () => runJobworkChecks(p('jobwork')));
  await safe('inventory', () => runInventoryChecks(p('inventory')));
  await safe('crm', () => runCrmChecks(p('crm')));
  await safe('commerce', () => runCommerceChecks(p('commerce')));
  await safe('fulfilment', () => runFulfilmentChecks(p('fulfilment')));
  await safe('finance', () => runFinanceChecks(p('finance')));
  await safe('hrms', () => runHrChecks(p('hrms')));
  await safe('contracts', () => runContractChecks(p('workflow')));
  await safe('reports', () => runScheduledReports(p('insights')));
  await drainAll(services);
}

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  // The route sends /api/<rest> here as /api?__path=<rest>; put the original path back for the gateway.
  const u = new URL(req.url ?? '/', 'http://x');
  const rest = u.searchParams.get('__path');
  if (rest !== null) {
    u.searchParams.delete('__path');
    req.url = `/api/${rest}${u.search}`;
  }
  const url = req.url ?? '/';
  // One-time (repeatable) schema and demo data load, streamed back as it runs: POST /api/_setup[?reset=1]
  // with `Authorization: Bearer $SETUP_SECRET`. Disabled when SETUP_SECRET is not set.
  if (url.startsWith('/api/_setup')) {
    if (!process.env.SETUP_SECRET || req.method !== 'POST' || req.headers.authorization !== `Bearer ${process.env.SETUP_SECRET}`) {
      res.statusCode = 404;
      return res.end();
    }
    res.setHeader('content-type', 'text/plain; charset=utf-8');
    const db = await database();
    const transaction = process.env.DATABASE_URL;
    process.env.DATABASE_URL = db.session;
    try {
      await setupDatabase({ reset: new URL(url, 'http://x').searchParams.get('reset') === '1', log: (line) => void res.write(`${line}\n`) });
      res.end('✔ setup complete\n');
    } catch (e) {
      res.end(`✖ setup failed: ${(e as Error).stack ?? e}\n`);
    } finally {
      if (transaction === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = transaction;
    }
    return;
  }
  const { gateway, services } = await (booted ??= boot().catch((e) => { booted = null; throw e; }));
  if (url.startsWith('/api/_cron')) {
    if (process.env.CRON_SECRET && req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
      res.statusCode = 401;
      return res.end();
    }
    await runChecks(services, true);
    res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify({ ok: true }));
  }
  const writes = !['GET', 'HEAD', 'OPTIONS'].includes(req.method ?? 'GET');
  // Pick up events written by other instances before answering a read.
  if (!writes && (draining || Date.now() - lastDrain > 3_000)) await drainAll(services);
  res.on('finish', () => {
    waitUntil((async () => {
      if (writes) await drainAll(services);
      await runChecks(services);
    })());
  });
  gateway(req as never, res as never);
}
