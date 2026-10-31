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

type Booted = { gateway: ReturnType<typeof createGateway>; services: RunningService[] };
let booted: Promise<Booted> | null = null;

async function boot(): Promise<Booted> {
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
  const { gateway, services } = await (booted ??= boot().catch((e) => { booted = null; throw e; }));
  // The route sends /api/<rest> here as /api?__path=<rest>; put the original path back for the gateway.
  const u = new URL(req.url ?? '/', 'http://x');
  const rest = u.searchParams.get('__path');
  if (rest !== null) {
    u.searchParams.delete('__path');
    req.url = `/api/${rest}${u.search}`;
  }
  const url = req.url ?? '/';
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
