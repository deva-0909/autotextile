/** Boots every service and the gateway in-process against a throwaway database, with demo master data. */
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import pg from 'pg';
import { type RunningService, type ServiceName, bootService, config, setServicePorts, tx } from '@erp/platform';
import { identityService, syncRoles } from '../services/identity/src/service.ts';
import { organisationService } from '../services/organisation/src/service.ts';
import { mastersService } from '../services/masters/src/service.ts';
import { governanceService } from '../services/governance/src/service.ts';
import { procurementService } from '../services/procurement/src/service.ts';
import { jobworkService } from '../services/jobwork/src/service.ts';
import { inventoryService } from '../services/inventory/src/service.ts';
import { crmService } from '../services/crm/src/service.ts';
import { createGateway } from '../services/gateway/src/app.ts';
import { hashPassword } from '../services/identity/src/security.ts';
import { DEMO_PASSWORD, linkPortalUsers, seedMasters, seedOrganisation, seedSalesTeam, seedUsers } from '../scripts/seed-data.ts';

export async function bootAll(dbSuffix: string) {
  const base = new URL(config.databaseUrl());
  const admin = new URL(base);
  admin.pathname = '/postgres';
  const testUrl = new URL(base);
  testUrl.pathname = `/${base.pathname.slice(1)}_${dbSuffix}`;
  const c0 = new pg.Client({ connectionString: admin.toString() });
  await c0.connect();
  await c0.query(`DROP DATABASE IF EXISTS "${testUrl.pathname.slice(1)}" WITH (FORCE)`);
  await c0.query(`CREATE DATABASE "${testUrl.pathname.slice(1)}"`);
  await c0.end();

  const services: RunningService[] = [];
  for (const def of [governanceService, identityService, organisationService, mastersService, procurementService, jobworkService, inventoryService, crmService])
    services.push(await bootService(def, { databaseUrl: testUrl.toString(), pollMs: 100 }));
  const svc = (n: ServiceName) => services.find((s) => s.ctx.name === n)!;
  await syncRoles(svc('identity').ctx.pool);
  let parties: Record<string, string> = {};
  await tx(svc('identity').ctx.pool, async (c) => {
    const org = await seedOrganisation(c);
    const ids = await seedUsers(c, org, await hashPassword(DEMO_PASSWORD));
    parties = await seedMasters(c, ids['sales@textile.local']!);
    await linkPortalUsers(c, parties);
    await seedSalesTeam(c, ids);
  });
  const ports: Partial<Record<ServiceName, number>> = {};
  const servers: { close: () => void; closeAllConnections: () => void }[] = [];
  for (const s of services) {
    const srv = s.app.listen(0);
    servers.push(srv);
    ports[s.ctx.name] = (srv.address() as AddressInfo).port;
  }
  setServicePorts(ports);
  const gw = createGateway(ports as never, { loginAttemptsPerMinute: 10_000 }).listen(0);
  servers.push(gw);
  const B = `http://127.0.0.1:${(gw.address() as AddressInfo).port}/api`;

  async function call(token: string | null, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const raw = body instanceof Buffer;
    const r = await fetch(`${B}${path}`, {
      method,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined && !raw ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body === undefined ? undefined : raw ? new Blob([body]) : JSON.stringify(body),
    });
    return { status: r.status, body: (await r.json().catch(() => null)) as any };
  }
  async function ok(token: string, method: string, path: string, body?: unknown, headers?: Record<string, string>) {
    const r = await call(token, method, path, body, headers);
    assert.ok(r.status < 300, `${method} ${path} → ${r.status} ${JSON.stringify(r.body)}`);
    return r.body;
  }
  async function login(email: string) {
    const r = await call(null, 'POST', '/identity/auth/login', { email, password: DEMO_PASSWORD });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body.accessToken as string;
  }
  const drain = async () => { for (let i = 0; i < 2; i++) for (const s of services) await s.consumer?.drain(); };
  async function close() {
    for (const s of servers) { s.close(); s.closeAllConnections(); }
    for (const s of services) await s.close();
  }
  return { call, ok, login, drain, close, svc, parties };
}
