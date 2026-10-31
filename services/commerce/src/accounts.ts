import { randomBytes } from 'node:crypto';
import type { Router } from 'express';
import { z } from 'zod';
import { type ServiceContext, badRequest, callService, conflict, gstinProblem, many, notFound, notify, one, optText, parse, reqText, requirePermission, tx } from '@erp/platform';
import { S, auditReq, getParty, localNumber, portalCustomer } from './common.ts';

const NO_SCOPE = { entity: [], gstin: [], branch: [], warehouse: [] };
const PORTAL_ROLES = { admin: 'customer_company_admin', buyer: 'customer_buyer', accounts: 'customer_accounts' } as const;
const tempPassword = () => `Tx-${randomBytes(4).toString('hex')}#${Math.floor(10 + Math.random() * 89)}A`;

interface DirUser { id: string; name: string; email: string; status: string; party_id: string | null }
/** Active portal users of a customer company (for notifications). */
export async function portalUsersOf(customerId: string, _permission?: string) {
  const dir = await callService<DirUser[]>(S, 'identity', 'GET', '/directory').catch(() => []);
  return dir.filter((u) => u.party_id === customerId && u.status === 'active').map((u) => u.id);
}

async function createPortalUser(p: { email: string; name: string; phone?: string | null; customer_id: string; role: keyof typeof PORTAL_ROLES }) {
  const roles = await callService<{ id: string; code: string }[]>(S, 'identity', 'GET', '/roles');
  const role = roles.find((r) => r.code === PORTAL_ROLES[p.role]);
  if (!role) throw badRequest('Portal role is missing');
  const password = tempPassword();
  const u = await callService<{ id: string }>(S, 'identity', 'POST', '/users', { email: p.email, name: p.name, phone: p.phone ?? null, party_id: p.customer_id, password, roleIds: [role.id], scope: NO_SCOPE, designation: `${p.role === 'admin' ? 'Company admin' : p.role === 'buyer' ? 'Buyer' : 'Accounts'} (customer portal)` });
  return { id: u.id, temporary_password: password };
}

export function publicAccountRoutes(r: Router, { pool }: ServiceContext) {
  /** Self-registration from the website. An internal approver creates the account. */
  r.post('/public/registrations', async (req, res) => {
    const b = parse(z.object({
      company_name: z.string().trim().min(3).max(200), gstin: optText(15), city: optText(80), address: optText(500),
      contact_name: z.string().trim().min(2).max(120), email: z.email(), phone: z.string().trim().regex(/^[+0-9 -]{10,20}$/, 'Enter a valid mobile number'), message: optText(1000),
    }), req.body);
    const gstin = b.gstin?.toUpperCase() ?? null;
    if (gstin) { const p = gstinProblem(gstin); if (p) throw badRequest(p, { fields: { gstin: p } }); }
    const out = await tx(pool, async (c) => {
      if (await one(c, `SELECT 1 FROM registrations WHERE lower(email) = lower($1) AND status = 'pending'`, [b.email])) throw conflict('A registration with this email is already being reviewed');
      const number = await localNumber(c, 'registration', 'REG-');
      await c.query(`INSERT INTO registrations (number, company_name, gstin, state_code, city, address, contact_name, email, phone, message) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [number, b.company_name, gstin, gstin?.slice(0, 2) ?? null, b.city ?? null, b.address ?? null, b.contact_name, b.email.toLowerCase(), b.phone, b.message ?? null]);
      await notify(c, S, { audience_permission: 'commerce.registration.approve', kind: 'action', title: `New customer registration: ${b.company_name}`, body: `${b.contact_name} · ${b.city ?? ''}`, link: '/commerce/registrations' });
      return { number };
    });
    res.status(201).json({ ...out, message: 'Thank you. Our team will verify your details and email your login.' });
  });
}

export function accountRoutes(r: Router, { pool }: ServiceContext) {
  r.get('/registrations', requirePermission('commerce.registration.approve', 'commerce.read'), async (req, res) => {
    res.json(await many(pool, `SELECT * FROM registrations WHERE ($1::text IS NULL OR status = $1) ORDER BY created_at DESC LIMIT 200`, [req.query.status ?? null]));
  });

  /** Approve: create (or link) the customer master and the company admin login. The temporary password is shown once. */
  r.post('/registrations/:id/approve', requirePermission('commerce.registration.approve'), async (req, res) => {
    const b = parse(z.object({ customer_id: z.uuid().nullable().optional(), note: optText(500) }), req.body);
    const reg = await one<{ id: string; status: string; company_name: string; gstin: string | null; state_code: string | null; contact_name: string; email: string; phone: string; city: string | null; address: string | null }>(pool, 'SELECT * FROM registrations WHERE id = $1', [req.params.id]);
    if (!reg) throw notFound('Registration');
    if (reg.status !== 'pending') throw conflict(`Already ${reg.status}`);
    let customerId = b.customer_id ?? null;
    if (customerId) { const p = await getParty(customerId).catch(() => null); if (!p || p.party_type !== 'customer') throw badRequest('Choose a customer'); }
    else {
      const p = await callService<{ id: string }>(S, 'masters', 'POST', '/parties', { party_type: 'customer', legal_name: reg.company_name, gst_treatment: reg.gstin ? 'registered' : 'unregistered', gstin: reg.gstin, state_code: reg.state_code, email: reg.email, phone: reg.phone, tags: ['portal'], notes: `Registered on the website (${req.params.id})` });
      customerId = p.id;
    }
    const user = await createPortalUser({ email: reg.email, name: reg.contact_name, phone: reg.phone, customer_id: customerId!, role: 'admin' });
    await tx(pool, async (c) => {
      await c.query(`UPDATE registrations SET status = 'approved', customer_id = $2, user_id = $3, decided_by_name = $4, decided_at = now(), note = $5 WHERE id = $1`, [reg.id, customerId, user.id, req.user!.name, b.note ?? null]);
      await auditReq(c, req, 'registration', reg.id, 'approved', { after: { customer_id: customerId, user: reg.email } });
    });
    res.json({ customer_id: customerId, user_id: user.id, email: reg.email, temporary_password: user.temporary_password });
  });

  r.post('/registrations/:id/reject', requirePermission('commerce.registration.approve'), async (req, res) => {
    const { reason } = parse(z.object({ reason: reqText(500) }), req.body);
    await tx(pool, async (c) => {
      const r1 = await c.query(`UPDATE registrations SET status = 'rejected', decided_by_name = $2, decided_at = now(), note = $3 WHERE id = $1 AND status = 'pending'`, [req.params.id, req.user!.name, reason]);
      if (!r1.rowCount) throw conflict('Not pending');
      await auditReq(c, req, 'registration', String(req.params.id), 'rejected', { reason });
    });
    res.json({ ok: true });
  });

  // ----- company profile, users and settings (customer admin) -----
  r.get('/portal/company', requirePermission('portal.customer.order', 'portal.customer.accounts', 'portal.customer.admin'), async (req, res) => {
    const cust = portalCustomer(req);
    const [p, s, dir] = await Promise.all([callService<Record<string, unknown>>(S, 'masters', 'GET', `/parties/${cust}`), one(pool, 'SELECT * FROM customer_settings WHERE customer_id = $1', [cust]), callService<DirUser[]>(S, 'identity', 'GET', '/directory').catch(() => [])]);
    const credit = await callService(S, 'crm', 'GET', `/credit-check/${cust}`).catch(() => null);
    res.json({ company: p, settings: s ?? { order_approval_limit: null }, users: dir.filter((u) => u.party_id === cust), credit });
  });

  r.post('/portal/company/users', requirePermission('portal.customer.admin'), async (req, res) => {
    const cust = portalCustomer(req);
    const b = parse(z.object({ name: z.string().trim().min(2).max(120), email: z.email(), phone: optText(20), role: z.enum(['admin', 'buyer', 'accounts']) }), req.body);
    const u = await createPortalUser({ ...b, customer_id: cust });
    await tx(pool, (c) => auditReq(c, req, 'portal_user', u.id, 'created', { after: { email: b.email, role: b.role } }));
    res.status(201).json({ id: u.id, email: b.email, temporary_password: u.temporary_password });
  });

  r.post('/portal/company/users/:id/deactivate', requirePermission('portal.customer.admin'), async (req, res) => {
    const cust = portalCustomer(req);
    if (req.params.id === req.user!.id) throw badRequest('You cannot deactivate yourself');
    const u = await callService<{ id: string; email: string; name: string; phone: string | null; designation: string | null; party_id: string | null }>(S, 'identity', 'GET', `/users/${req.params.id}`).catch(() => null);
    if (!u || u.party_id !== cust) throw notFound('User');
    await callService(S, 'identity', 'PATCH', `/users/${u.id}`, { email: u.email, name: u.name, phone: u.phone, designation: u.designation, party_id: u.party_id, status: 'inactive' });
    await tx(pool, (c) => auditReq(c, req, 'portal_user', u.id, 'deactivated'));
    res.json({ ok: true });
  });

  r.put('/portal/company/settings', requirePermission('portal.customer.admin'), async (req, res) => {
    const cust = portalCustomer(req);
    const b = parse(z.object({ order_approval_limit: z.number().min(0).nullable(), default_ship_to: optText(500) }), req.body);
    await tx(pool, async (c) => {
      await c.query(`INSERT INTO customer_settings (customer_id, order_approval_limit, default_ship_to, updated_by_name) VALUES ($1,$2,$3,$4)
        ON CONFLICT (customer_id) DO UPDATE SET order_approval_limit = EXCLUDED.order_approval_limit, default_ship_to = EXCLUDED.default_ship_to, updated_by_name = EXCLUDED.updated_by_name, updated_at = now()`, [cust, b.order_approval_limit, b.default_ship_to ?? null, req.user!.name]);
      await auditReq(c, req, 'customer_settings', cust, 'updated', { after: b });
    });
    res.json({ ok: true });
  });
}
