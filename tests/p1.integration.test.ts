/**
 * End-to-end tests for the P1 release: all four services and the gateway run in-process
 * against a throwaway PostgreSQL database (<DATABASE_URL name>_test).
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import pg from 'pg';
import { type RunningService, bootService, config, tx } from '@erp/platform';
import { identityService, syncRoles } from '../services/identity/src/service.ts';
import { organisationService } from '../services/organisation/src/service.ts';
import { mastersService } from '../services/masters/src/service.ts';
import { governanceService } from '../services/governance/src/service.ts';
import { procurementService } from '../services/procurement/src/service.ts';
import { jobworkService } from '../services/jobwork/src/service.ts';
import { inventoryService } from '../services/inventory/src/service.ts';
import { crmService } from '../services/crm/src/service.ts';
import { createGateway } from '../services/gateway/src/app.ts';
import { hashPassword, totp } from '../services/identity/src/security.ts';
import { DEMO_PASSWORD, DEMO_USERS, seedMasters, seedOrganisation } from '../scripts/seed-data.ts';

const base = new URL(config.databaseUrl());
const testDb = `${base.pathname.slice(1)}_test`;
const testUrl = new URL(base);
testUrl.pathname = `/${testDb}`;

let services: RunningService[] = [];
let servers: { close: () => void; closeAllConnections: () => void }[] = [];
let B = '';
const drain = async () => { for (const s of services) await s.consumer?.drain(); };

async function adminQuery(sql: string) {
  const u = new URL(base);
  u.pathname = '/postgres';
  const c = new pg.Client({ connectionString: u.toString() });
  await c.connect();
  await c.query(sql);
  await c.end();
}

async function call(token: string | null, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const raw = body instanceof Buffer;
  const r = await fetch(`${B}${path}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined && !raw ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => null), headers: r.headers };
}

async function login(email: string, password = DEMO_PASSWORD) {
  const r = await call(null, 'POST', '/api/identity/auth/login', { email, password });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.accessToken as string;
}

before(async () => {
  await adminQuery(`DROP DATABASE IF EXISTS "${testDb}" WITH (FORCE)`);
  await adminQuery(`CREATE DATABASE "${testDb}"`);
  for (const def of [governanceService, identityService, organisationService, mastersService, procurementService, jobworkService, inventoryService, crmService]) {
    services.push(await bootService(def, { databaseUrl: testUrl.toString(), pollMs: 100 }));
  }
  const [, identity] = services;
  await syncRoles(identity!.ctx.pool);
  await tx(identity!.ctx.pool, async (c) => {
    const org = await seedOrganisation(c);
    const hash = await hashPassword(DEMO_PASSWORD);
    for (const u of DEMO_USERS) {
      const { rows: [row] } = await c.query(`INSERT INTO identity.users (email, name, password_hash) VALUES ($1, $2, $3) RETURNING id`, [u.email, u.name, hash]);
      await c.query(`INSERT INTO identity.user_roles (user_id, role_id) SELECT $1, id FROM identity.roles WHERE code = $2`, [row.id, u.role]);
      if (u.scope === 'all') for (const k of ['entity', 'gstin', 'branch', 'warehouse']) await c.query(`INSERT INTO identity.user_scopes VALUES ($1, $2, NULL)`, [row.id, k]);
      else await c.query(`INSERT INTO identity.user_scopes VALUES ($1, 'warehouse', $2), ($1, 'gstin', $3)`, [row.id, org.warehouses.SRT, org.regs['24']]);
    }
    await seedMasters(c, null);
  });
  const ports: Record<string, number> = {};
  for (const s of services) {
    const srv = s.app.listen(0);
    servers.push(srv);
    ports[s.ctx.name] = (srv.address() as AddressInfo).port;
  }
  const gw = createGateway(ports as never, { loginAttemptsPerMinute: 10_000 }).listen(0);
  servers.push(gw);
  B = `http://127.0.0.1:${(gw.address() as AddressInfo).port}`;
});

after(async () => {
  for (const s of servers) { s.close(); s.closeAllConnections(); }
  for (const s of services) await s.close();
  services = [];
});

describe('identity & security', () => {
  test('gateway health reports every service', async () => {
    const r = await call(null, 'GET', '/api/health');
    assert.equal(r.status, 200);
    assert.ok(Object.values(r.body.services).every((s) => s === 'ok'));
  });

  test('protected routes need a token', async () => {
    assert.equal((await call(null, 'GET', '/api/masters/parties')).status, 401);
    assert.equal((await call('garbage', 'GET', '/api/masters/parties')).status, 401);
  });

  test('five wrong passwords lock the account', async () => {
    for (let i = 0; i < 4; i++) assert.equal((await call(null, 'POST', '/api/identity/auth/login', { email: 'sales@textile.local', password: 'nope' })).status, 401);
    const fifth = await call(null, 'POST', '/api/identity/auth/login', { email: 'sales@textile.local', password: 'nope' });
    assert.match(fifth.body.error.message, /locked/i);
    const correct = await call(null, 'POST', '/api/identity/auth/login', { email: 'sales@textile.local', password: DEMO_PASSWORD });
    assert.equal(correct.status, 401, 'locked even with the right password');
    const admin = await login('admin@textile.local');
    const users = await call(admin, 'GET', '/api/identity/users?q=sales@');
    assert.equal((await call(admin, 'POST', `/api/identity/users/${users.body.items[0].id}/unlock`)).status, 200);
    await login('sales@textile.local');
  });

  test('MFA enrolment makes sign-in require a TOTP code', async () => {
    const t = await login('owner@textile.local');
    const setup = await call(t, 'POST', '/api/identity/me/mfa/setup');
    assert.equal((await call(t, 'POST', '/api/identity/me/mfa/enable', { code: '000000' })).status, 400);
    assert.equal((await call(t, 'POST', '/api/identity/me/mfa/enable', { code: totp(setup.body.secret) })).status, 200);
    const step1 = await call(null, 'POST', '/api/identity/auth/login', { email: 'owner@textile.local', password: DEMO_PASSWORD });
    assert.equal(step1.body.mfaRequired, true);
    assert.equal(step1.body.accessToken, undefined);
    assert.equal((await call(null, 'POST', '/api/identity/auth/mfa', { mfaToken: step1.body.mfaToken, code: '123456' })).status, 401);
    const step2 = await call(null, 'POST', '/api/identity/auth/mfa', { mfaToken: step1.body.mfaToken, code: totp(setup.body.secret) });
    assert.equal(step2.status, 200);
    assert.ok(step2.body.accessToken);
  });

  test('refresh token rotates and the old one stops working', async () => {
    const r = await call(null, 'POST', '/api/identity/auth/login', { email: 'accounts@textile.local', password: DEMO_PASSWORD });
    const cookie = r.headers.get('set-cookie')!.split(';')[0]!;
    const r1 = await call(null, 'POST', '/api/identity/auth/refresh', undefined, { cookie });
    assert.equal(r1.status, 200);
    const again = await call(null, 'POST', '/api/identity/auth/refresh', undefined, { cookie });
    assert.equal(again.status, 401, 'reusing a rotated refresh token fails');
  });

  test('role permissions are enforced', async () => {
    const sales = await login('sales@textile.local');
    assert.equal((await call(sales, 'GET', '/api/identity/users')).status, 403);
    assert.equal((await call(sales, 'POST', '/api/masters/parties', { party_type: 'supplier', legal_name: 'X', gst_treatment: 'unregistered' })).status, 403);
    const ok = await call(sales, 'POST', '/api/masters/parties', { party_type: 'customer', legal_name: 'Walk-in Buyer', gst_treatment: 'unregistered' });
    assert.equal(ok.status, 201);
    assert.match(ok.body.code, /^CUS-\d{5}$/);
  });

  test('super admin cannot remove their own Super Admin role', async () => {
    const admin = await login('admin@textile.local');
    const me = await call(admin, 'GET', '/api/identity/me');
    const r = await call(admin, 'PUT', `/api/identity/users/${me.body.id}/access`, { roleIds: [], scope: { entity: '*', gstin: '*', branch: '*', warehouse: '*' } });
    assert.equal(r.status, 400);
  });
});

describe('organisation', () => {
  test('data scope limits a warehouse manager to Surat', async () => {
    const t = await login('surat.stores@textile.local');
    const w = await call(t, 'GET', '/api/organisation/warehouses');
    assert.deepEqual(w.body.map((x: { code: string }) => x.code), ['SRT']);
    const admin = await login('admin@textile.local');
    const kol = (await call(admin, 'GET', '/api/organisation/warehouses')).body.find((x: { code: string }) => x.code === 'KOL');
    assert.equal((await call(t, 'GET', `/api/organisation/warehouses/${kol.id}`)).status, 403);
  });

  test('GSTIN must match the entity PAN and cannot be edited later', async () => {
    const admin = await login('admin@textile.local');
    const entity = (await call(admin, 'GET', '/api/organisation/entities')).body[0];
    const foreign = await call(admin, 'POST', '/api/organisation/gst-registrations', { legal_entity_id: entity.id, gstin: '27AAPFU0939F1ZV', effective_from: '2026-04-01' });
    assert.equal(foreign.status, 400);
    assert.match(foreign.body.error.message, /PAN mismatch/);
    const reg = (await call(admin, 'GET', '/api/organisation/gst-registrations')).body[0];
    const edit = await call(admin, 'PATCH', `/api/organisation/gst-registrations/${reg.id}`, { ...reg, gstin: '27AAPFU0939F1ZV' });
    assert.equal(edit.status, 409);
  });

  test('stale edits are rejected (optimistic locking)', async () => {
    const admin = await login('admin@textile.local');
    const w = (await call(admin, 'GET', '/api/organisation/warehouses')).body.find((x: { code: string }) => x.code === 'TUP3');
    const body = { code: w.code, name: 'Tiruppur WH 3', branch_id: w.branch_id, gst_registration_id: w.gst_registration_id, warehouse_type: w.warehouse_type, dispatch_priority: w.dispatch_priority, city: w.city, version: w.version };
    assert.equal((await call(admin, 'PATCH', `/api/organisation/warehouses/${w.id}`, body)).status, 200);
    const stale = await call(admin, 'PATCH', `/api/organisation/warehouses/${w.id}`, { ...body, name: 'Other' });
    assert.equal(stale.status, 409);
  });

  test('document numbers are unique under concurrency', async () => {
    const admin = await login('admin@textile.local');
    const results = await Promise.all(Array.from({ length: 25 }, () => call(admin, 'POST', '/api/organisation/number-series/next', { doc_type: 'purchase_order' })));
    const numbers = results.map((r) => r.body.number);
    assert.equal(new Set(numbers).size, 25);
    assert.ok(numbers.every((n) => /^PO\/2627\/\d{5}$/.test(n)));
  });
});

describe('maker-checker & audit', () => {
  test('bank account needs approval by someone other than the maker', async () => {
    const purchase = await login('purchase@textile.local');
    const owner = await login('admin@textile.local');
    const supplier = (await call(purchase, 'GET', '/api/masters/parties?f_type=supplier&pageSize=1')).body.items[0];
    const req = await call(purchase, 'POST', `/api/masters/parties/${supplier.id}/bank-accounts`, { account_name: supplier.legal_name, account_number: '112233445566', ifsc: 'SBIN0001234', reason: 'New account letter' });
    assert.equal(req.status, 201);
    assert.equal(req.body.status, 'pending_approval');
    assert.equal(req.body.account_number, '•••• 5566', 'response never echoes the full number');
    await drain();
    const approval = (await call(owner, 'GET', '/api/governance/approvals?f_status=pending')).body.items.find((a: { ref_id: string }) => a.ref_id === req.body.id);
    assert.ok(approval, 'approval request created from the event');
    assert.equal((await call(purchase, 'POST', `/api/governance/approvals/${approval.id}/decide`, { decision: 'approved' })).status, 403);
    assert.equal((await call(owner, 'POST', `/api/governance/approvals/${approval.id}/decide`, { decision: 'rejected' })).status, 400, 'reject needs a comment');
    assert.equal((await call(owner, 'POST', `/api/governance/approvals/${approval.id}/decide`, { decision: 'approved', comment: 'Verified' })).status, 200);
    assert.equal((await call(owner, 'POST', `/api/governance/approvals/${approval.id}/decide`, { decision: 'approved' })).status, 409, 'cannot decide twice');
    await drain();
    const detail = await call(owner, 'GET', `/api/masters/parties/${supplier.id}`);
    assert.equal(detail.body.bank_accounts.find((b: { id: string }) => b.id === req.body.id).status, 'active');
    const masked = await call(purchase, 'GET', `/api/masters/parties/${supplier.id}`);
    assert.ok(masked.body.bank_accounts.every((b: { account_number: string }) => b.account_number.startsWith('••••')), 'purchase role sees masked numbers');
  });

  test('credit limit change is held until a checker approves it', async () => {
    const sales = await login('sales@textile.local');
    const admin = await login('admin@textile.local');
    const accounts = await login('accounts@textile.local');
    const c = (await call(sales, 'GET', '/api/masters/parties?f_type=customer&q=Murugan')).body.items[0];
    const full = (await call(sales, 'GET', `/api/masters/parties/${c.id}`)).body;
    assert.equal((await call(sales, 'PATCH', `/api/masters/parties/${c.id}`, { ...full, credit_limit: 900000 })).status, 400, 'reason required');
    const r = await call(sales, 'PATCH', `/api/masters/parties/${c.id}`, { ...full, credit_limit: 900000, segment: 'Key account', reason: 'Annual review' });
    assert.equal(r.status, 200);
    assert.equal(r.body.credit_limit, full.credit_limit, 'credit limit unchanged until approval');
    assert.equal(r.body.segment, 'Key account', 'ordinary fields apply immediately');
    await drain();
    const appr = (await call(admin, 'GET', '/api/governance/approvals?f_status=pending')).body.items.find((a: { ref_id: string }) => a.ref_id === r.body.pending_change.id);
    assert.equal((await call(accounts, 'POST', `/api/governance/approvals/${appr.id}/decide`, { decision: 'approved' })).status, 403, 'no approval permission');
    assert.equal((await call(admin, 'POST', `/api/governance/approvals/${appr.id}/decide`, { decision: 'approved' })).status, 200);
    await drain();
    assert.equal((await call(admin, 'GET', `/api/masters/parties/${c.id}`)).body.credit_limit, 900000);
  });

  test('audit trail is append-only and captures before/after', async () => {
    await drain();
    const admin = await login('admin@textile.local');
    const audit = await call(admin, 'GET', '/api/governance/audit?f_entity=warehouse&pageSize=5');
    const change = audit.body.items.find((a: { action: string }) => a.action === 'updated');
    assert.equal(change.before.name, 'Tiruppur Warehouse 3');
    assert.equal(change.after.name, 'Tiruppur WH 3');
    assert.equal(change.user_name, 'System Administrator');
    const governance = services[0]!;
    await assert.rejects(governance.ctx.pool.query('UPDATE audit_log SET action = $1', ['tampered']), /append-only/);
    await assert.rejects(governance.ctx.pool.query('DELETE FROM audit_log'), /append-only/);
  });
});

describe('master data & documents', () => {
  test('duplicate GSTIN is blocked and invalid attributes are rejected', async () => {
    const admin = await login('admin@textile.local');
    const existing = (await call(admin, 'GET', '/api/masters/parties?f_type=customer&q=Murugan')).body.items[0];
    const dup = await call(admin, 'POST', '/api/masters/parties', { party_type: 'customer', legal_name: 'Copy', gst_treatment: 'registered', gstin: existing.gstin });
    assert.equal(dup.status, 409);
    const cat = (await call(admin, 'GET', '/api/masters/fabric-categories')).body.find((c: { code: string }) => c.code === 'SJ');
    const bad = await call(admin, 'POST', '/api/masters/products', { sku: 'SJ-BAD', name: 'Bad', category_id: cat.id, hsn_code: '6006', attributes: { gsm: 5, knit_type: 'Single jersey' } });
    assert.equal(bad.status, 400);
    assert.ok(bad.body.error.details.fields['attributes.gsm']);
    assert.ok(bad.body.error.details.fields['attributes.composition'], 'required attribute missing');
  });

  test('documents: upload, version, content check and download', async () => {
    const admin = await login('admin@textile.local');
    const pdf = Buffer.from('%PDF-1.4\n%%EOF\n');
    const q = 'title=GST%20certificate&document_type=GST_CERT&entity_type=customer&entity_id=abc';
    const spoof = await call(admin, 'POST', `/api/governance/documents?${q}`, Buffer.from('MZ not a pdf'), { 'content-type': 'application/pdf', 'x-file-name': 'cert.pdf' });
    assert.equal(spoof.status, 400);
    const up = await call(admin, 'POST', `/api/governance/documents?${q}`, pdf, { 'content-type': 'application/pdf', 'x-file-name': 'cert.pdf' });
    assert.equal(up.status, 201);
    const v2 = await call(admin, 'POST', `/api/governance/documents/${up.body.id}/versions?note=renewed`, pdf, { 'content-type': 'application/pdf', 'x-file-name': 'cert-2.pdf' });
    assert.equal(v2.body.version, 2);
    const r = await fetch(`${B}/api/governance/documents/${up.body.id}/versions/1/content`, { headers: { authorization: `Bearer ${admin}` } });
    assert.equal(r.status, 200);
    assert.equal(Buffer.from(await r.arrayBuffer()).toString(), pdf.toString());
    const op = await login('sales@textile.local');
    assert.equal((await call(op, 'POST', `/api/governance/documents/${up.body.id}/archive`, { reason: 'x' })).status, 403);
  });
});
