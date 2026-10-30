import type { Router } from 'express';
import { z } from 'zod';
import {
  ALL_PERMISSION_CODES, PERMISSIONS, type DataScope, type ServiceContext, audit, badRequest, conflict, contextOf, diff, forbidden,
  listQuery, many, notFound, one, optText, orderLimit, page, parse, reqText, requirePermission, tx,
} from '@erp/platform';
import { hashPassword, newTotpSecret, otpauthUrl, passwordProblem, verifyPassword, verifyTotp } from './security.ts';
import { PUBLIC_USER_COLUMNS, loadAuthUser, loadScope, saveScope } from './users.ts';

const scopeList = z.union([z.literal('*'), z.array(z.uuid())]);
const scopeSchema = z.object({ entity: scopeList, gstin: scopeList, branch: scopeList, warehouse: scopeList });

const userBody = z.object({
  email: z.email('Enter a valid email').transform((s) => s.toLowerCase()),
  name: reqText(120),
  phone: optText(20),
  employee_code: optText(30),
  designation: optText(80),
});

export function adminRoutes(r: Router, ctx: ServiceContext) {
  const { pool } = ctx;

  // ---------- current user ----------
  r.get('/me', async (req, res) => {
    const u = await one<Record<string, unknown>>(pool, `SELECT ${PUBLIC_USER_COLUMNS} FROM users u WHERE u.id = $1`, [req.user!.id]);
    res.json({ ...u, ...(await loadAuthUser(pool, req.user!.id, req.user!.sessionId)) });
  });

  r.post('/me/password', async (req, res) => {
    const { current, next } = parse(z.object({ current: z.string(), next: z.string() }), req.body);
    const u = await one<{ password_hash: string }>(pool, 'SELECT password_hash FROM users WHERE id = $1', [req.user!.id]);
    if (!u || !(await verifyPassword(current, u.password_hash))) throw badRequest('Current password is incorrect');
    const problem = passwordProblem(next);
    if (problem) throw badRequest(problem);
    if (await verifyPassword(next, u.password_hash)) throw badRequest('Choose a password different from the current one');
    await tx(pool, async (c) => {
      await c.query('UPDATE users SET password_hash = $2, password_changed_at = now(), must_change_password = false WHERE id = $1', [req.user!.id, await hashPassword(next)]);
      await c.query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND id <> $2 AND revoked_at IS NULL', [req.user!.id, req.user!.sessionId ?? null]);
      await audit(c, 'identity', contextOf(req), { entity: 'user', entityId: req.user!.id, action: 'password_changed' });
    });
    res.json({ ok: true });
  });

  r.post('/me/mfa/setup', async (req, res) => {
    const secret = newTotpSecret();
    await pool.query('UPDATE users SET mfa_pending_secret = $2 WHERE id = $1', [req.user!.id, secret]);
    res.json({ secret, otpauthUrl: otpauthUrl(secret, req.user!.email) });
  });

  r.post('/me/mfa/enable', async (req, res) => {
    const { code } = parse(z.object({ code: z.string() }), req.body);
    const u = await one<{ mfa_pending_secret: string | null }>(pool, 'SELECT mfa_pending_secret FROM users WHERE id = $1', [req.user!.id]);
    if (!u?.mfa_pending_secret) throw badRequest('Start MFA setup first');
    if (!verifyTotp(u.mfa_pending_secret, code)) throw badRequest('That code is not valid. Check the time on your phone and try again.');
    await tx(pool, async (c) => {
      await c.query('UPDATE users SET mfa_enabled = true, mfa_secret = mfa_pending_secret, mfa_pending_secret = NULL WHERE id = $1', [req.user!.id]);
      await audit(c, 'identity', contextOf(req), { entity: 'user', entityId: req.user!.id, action: 'mfa_enabled' });
    });
    res.json({ ok: true });
  });

  r.post('/me/mfa/disable', async (req, res) => {
    const { code } = parse(z.object({ code: z.string() }), req.body);
    const u = await one<{ mfa_secret: string | null }>(pool, 'SELECT mfa_secret FROM users WHERE id = $1', [req.user!.id]);
    if (!u?.mfa_secret || !verifyTotp(u.mfa_secret, code)) throw badRequest('That code is not valid');
    await tx(pool, async (c) => {
      await c.query('UPDATE users SET mfa_enabled = false, mfa_secret = NULL WHERE id = $1', [req.user!.id]);
      await audit(c, 'identity', contextOf(req), { entity: 'user', entityId: req.user!.id, action: 'mfa_disabled' });
    });
    res.json({ ok: true });
  });

  // ---------- permission catalog & roles ----------
  r.get('/permissions', requirePermission('identity.role.read', 'identity.user.read'), (_req, res) => {
    res.json(PERMISSIONS);
  });

  r.get('/roles', requirePermission('identity.role.read', 'identity.user.read'), async (_req, res) => {
    res.json(await many(pool, `
      SELECT r.*, (SELECT count(*)::int FROM user_roles ur JOIN users u ON u.id = ur.user_id WHERE ur.role_id = r.id AND u.status = 'active') AS user_count,
             COALESCE((SELECT json_agg(json_build_object('code', rp.permission, 'limit', rp.limit_value) ORDER BY rp.permission)
                       FROM role_permissions rp WHERE rp.role_id = r.id), '[]') AS permissions
      FROM roles r ORDER BY r.is_system DESC, r.name`));
  });

  const roleBody = z.object({
    code: z.string().trim().regex(/^[a-z][a-z0-9_]{2,40}$/, 'Lowercase letters, digits and underscores'),
    name: reqText(80),
    description: optText(300),
  });

  r.post('/roles', requirePermission('identity.role.manage'), async (req, res) => {
    const body = parse(roleBody, req.body);
    const role = await tx(pool, async (c) => {
      const row = await one<{ id: string }>(c, 'INSERT INTO roles (code, name, description) VALUES ($1, $2, $3) RETURNING *', [body.code, body.name, body.description ?? null]);
      await audit(c, 'identity', contextOf(req), { entity: 'role', entityId: row!.id, action: 'created', after: body });
      return row;
    });
    res.status(201).json(role);
  });

  r.patch('/roles/:id', requirePermission('identity.role.manage'), async (req, res) => {
    const body = parse(roleBody.omit({ code: true }), req.body);
    const out = await tx(pool, async (c) => {
      const before = await one<Record<string, unknown>>(c, 'SELECT * FROM roles WHERE id = $1 FOR UPDATE', [req.params.id]);
      if (!before) throw notFound('Role');
      const after = await one<Record<string, unknown>>(c, 'UPDATE roles SET name = $2, description = $3, updated_at = now() WHERE id = $1 RETURNING *', [req.params.id, body.name, body.description ?? null]);
      await audit(c, 'identity', contextOf(req), { entity: 'role', entityId: String(req.params.id), action: 'updated', ...diff(before, after!) });
      return after;
    });
    res.json(out);
  });

  r.put('/roles/:id/permissions', requirePermission('identity.role.manage'), async (req, res) => {
    const { permissions, reason } = parse(z.object({
      permissions: z.array(z.object({ code: z.string(), limit: z.number().nonnegative().nullable().optional() })),
      reason: optText(300),
    }), req.body);
    const unknown = permissions.filter((p) => !ALL_PERMISSION_CODES.includes(p.code));
    if (unknown.length) throw badRequest(`Unknown permissions: ${unknown.map((p) => p.code).join(', ')}`);
    await tx(pool, async (c) => {
      const role = await one<{ code: string }>(c, 'SELECT code FROM roles WHERE id = $1 FOR UPDATE', [req.params.id]);
      if (!role) throw notFound('Role');
      if (role.code === 'super_admin') throw forbidden('Super Admin always has every permission');
      const before = (await many<{ permission: string }>(c, 'SELECT permission FROM role_permissions WHERE role_id = $1 ORDER BY 1', [req.params.id])).map((p) => p.permission);
      await c.query('DELETE FROM role_permissions WHERE role_id = $1', [req.params.id]);
      for (const p of permissions) await c.query('INSERT INTO role_permissions (role_id, permission, limit_value) VALUES ($1, $2, $3)', [req.params.id, p.code, p.limit ?? null]);
      const after = permissions.map((p) => p.code).sort();
      await audit(c, 'identity', contextOf(req), {
        entity: 'role', entityId: String(req.params.id), action: 'permissions_changed', reason,
        before: { granted: before.filter((p) => !after.includes(p)) }, after: { granted: after.filter((p) => !before.includes(p)) },
      });
    });
    res.json({ ok: true });
  });

  // ---------- users ----------
  r.get('/users', requirePermission('identity.user.read'), async (req, res) => {
    const lq = listQuery(req, ['name', 'email', 'status', 'last_login_at', 'created_at'], 'name');
    const params: unknown[] = [];
    const where: string[] = [];
    if (lq.q) {
      params.push(`%${lq.q}%`);
      where.push(`(u.name ILIKE $${params.length} OR u.email ILIKE $${params.length} OR u.employee_code ILIKE $${params.length})`);
    }
    if (lq.filters.status) { params.push(lq.filters.status); where.push(`u.status = $${params.length}`); }
    if (lq.filters.role) { params.push(lq.filters.role); where.push(`EXISTS (SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = u.id AND r.code = $${params.length})`); }
    const rows = await many<{ total_count: number }>(pool, `
      SELECT ${PUBLIC_USER_COLUMNS},
        COALESCE((SELECT json_agg(json_build_object('code', r.code, 'name', r.name) ORDER BY r.name) FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = u.id), '[]') AS roles,
        count(*) OVER ()::int AS total_count
      FROM users u ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ${orderLimit(lq, params).replace(/ORDER BY (\w+)/, 'ORDER BY u.$1')}`, params);
    res.json(page(rows, lq));
  });

  r.get('/users/:id', requirePermission('identity.user.read'), async (req, res) => {
    const u = await one<Record<string, unknown>>(pool, `SELECT ${PUBLIC_USER_COLUMNS} FROM users u WHERE u.id = $1`, [req.params.id]);
    if (!u) throw notFound('User');
    const roles = await many(pool, 'SELECT r.id, r.code, r.name FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = $1 ORDER BY r.name', [req.params.id]);
    res.json({ ...u, roles, scope: await loadScope(pool, String(req.params.id)) });
  });

  r.post('/users', requirePermission('identity.user.manage'), async (req, res) => {
    const body = parse(userBody.extend({ password: z.string(), roleIds: z.array(z.uuid()).default([]), scope: scopeSchema }), req.body);
    const problem = passwordProblem(body.password);
    if (problem) throw badRequest(`Temporary password: ${problem}`);
    const created = await tx(pool, async (c) => {
      const u = await one<{ id: string }>(c, `
        INSERT INTO users (email, name, phone, employee_code, designation, password_hash, must_change_password, created_by)
        VALUES ($1, $2, $3, $4, $5, $6, true, $7) RETURNING id`,
        [body.email, body.name, body.phone ?? null, body.employee_code ?? null, body.designation ?? null, await hashPassword(body.password), req.user!.id]);
      for (const roleId of body.roleIds) await c.query('INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)', [u!.id, roleId]);
      await saveScope(c, u!.id, body.scope as DataScope);
      const { password: _p, ...safe } = body;
      await audit(c, 'identity', contextOf(req), { entity: 'user', entityId: u!.id, action: 'created', after: safe });
      return u!;
    });
    res.status(201).json(created);
  });

  r.patch('/users/:id', requirePermission('identity.user.manage'), async (req, res) => {
    const body = parse(userBody.extend({ status: z.enum(['active', 'inactive']) }), req.body);
    if (req.params.id === req.user!.id && body.status === 'inactive') throw badRequest('You cannot deactivate your own account');
    const out = await tx(pool, async (c) => {
      const before = await one<Record<string, unknown>>(c, `SELECT ${PUBLIC_USER_COLUMNS} FROM users u WHERE id = $1 FOR UPDATE`, [req.params.id]);
      if (!before) throw notFound('User');
      const after = await one<Record<string, unknown>>(c, `
        UPDATE users u SET email = $2, name = $3, phone = $4, employee_code = $5, designation = $6, status = $7, updated_at = now()
        WHERE id = $1 RETURNING ${PUBLIC_USER_COLUMNS}`,
        [req.params.id, body.email, body.name, body.phone ?? null, body.employee_code ?? null, body.designation ?? null, body.status]);
      if (body.status === 'inactive') await c.query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [req.params.id]);
      await audit(c, 'identity', contextOf(req), { entity: 'user', entityId: String(req.params.id), action: 'updated', ...diff(before, after!) });
      return after;
    });
    res.json(out);
  });

  r.put('/users/:id/access', requirePermission('identity.user.manage'), async (req, res) => {
    const { roleIds, scope, reason } = parse(z.object({ roleIds: z.array(z.uuid()), scope: scopeSchema, reason: optText(300) }), req.body);
    await tx(pool, async (c) => {
      const exists = await one(c, 'SELECT 1 FROM users WHERE id = $1 FOR UPDATE', [req.params.id]);
      if (!exists) throw notFound('User');
      const beforeRoles = (await many<{ code: string }>(c, 'SELECT r.code FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = $1 ORDER BY 1', [req.params.id])).map((r) => r.code);
      const beforeScope = await loadScope(c, String(req.params.id));
      await c.query('DELETE FROM user_roles WHERE user_id = $1', [req.params.id]);
      for (const roleId of roleIds) await c.query('INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)', [req.params.id, roleId]);
      const afterRoles = (await many<{ code: string }>(c, 'SELECT r.code FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = $1 ORDER BY 1', [req.params.id])).map((r) => r.code);
      if (req.params.id === req.user!.id && beforeRoles.includes('super_admin') && !afterRoles.includes('super_admin'))
        throw badRequest('You cannot remove the Super Admin role from yourself');
      const admins = await one<{ n: number }>(c, `SELECT count(*)::int AS n FROM user_roles ur JOIN roles r ON r.id = ur.role_id JOIN users u ON u.id = ur.user_id WHERE r.code = 'super_admin' AND u.status = 'active'`);
      if (!admins?.n) throw conflict('At least one active Super Admin is required');
      await saveScope(c, String(req.params.id), scope as DataScope);
      await audit(c, 'identity', contextOf(req), {
        entity: 'user', entityId: String(req.params.id), action: 'access_changed', reason,
        before: { roles: beforeRoles, scope: beforeScope }, after: { roles: afterRoles, scope },
      });
    });
    res.json({ ok: true });
  });

  r.post('/users/:id/reset-password', requirePermission('identity.user.manage'), async (req, res) => {
    const { password } = parse(z.object({ password: z.string() }), req.body);
    const problem = passwordProblem(password);
    if (problem) throw badRequest(problem);
    await tx(pool, async (c) => {
      const r1 = await c.query(
        'UPDATE users SET password_hash = $2, must_change_password = true, failed_attempts = 0, locked_until = NULL, password_changed_at = now() WHERE id = $1',
        [req.params.id, await hashPassword(password)],
      );
      if (!r1.rowCount) throw notFound('User');
      await c.query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [req.params.id]);
      await audit(c, 'identity', contextOf(req), { entity: 'user', entityId: String(req.params.id), action: 'password_reset_by_admin' });
    });
    res.json({ ok: true });
  });

  r.post('/users/:id/unlock', requirePermission('identity.user.manage'), async (req, res) => {
    await tx(pool, async (c) => {
      await c.query('UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE id = $1', [req.params.id]);
      await audit(c, 'identity', contextOf(req), { entity: 'user', entityId: String(req.params.id), action: 'unlocked' });
    });
    res.json({ ok: true });
  });

  r.post('/users/:id/mfa-reset', requirePermission('identity.user.manage'), async (req, res) => {
    const { reason } = parse(z.object({ reason: reqText(300) }), req.body);
    await tx(pool, async (c) => {
      await c.query('UPDATE users SET mfa_enabled = false, mfa_secret = NULL, mfa_pending_secret = NULL WHERE id = $1', [req.params.id]);
      await audit(c, 'identity', contextOf(req), { entity: 'user', entityId: String(req.params.id), action: 'mfa_reset_by_admin', reason });
    });
    res.json({ ok: true });
  });

  // ---------- sessions & login history ----------
  r.get('/sessions', requirePermission('identity.session.read'), async (req, res) => {
    const params: unknown[] = [];
    const userFilter = req.query.userId ? (params.push(req.query.userId), `AND s.user_id = $1`) : '';
    res.json(await many(pool, `
      SELECT s.id, s.user_id, u.name AS user_name, u.email, s.ip, s.user_agent, s.created_at, s.last_used_at, s.expires_at
      FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.revoked_at IS NULL AND s.expires_at > now() ${userFilter} ORDER BY s.last_used_at DESC LIMIT 200`, params));
  });

  r.post('/sessions/:id/revoke', requirePermission('identity.user.manage'), async (req, res) => {
    await tx(pool, async (c) => {
      await c.query('UPDATE sessions SET revoked_at = now() WHERE id = $1', [req.params.id]);
      await audit(c, 'identity', contextOf(req), { entity: 'session', entityId: String(req.params.id), action: 'revoked' });
    });
    res.json({ ok: true });
  });

  r.get('/login-events', requirePermission('identity.session.read'), async (req, res) => {
    const lq = listQuery(req, ['at', 'email', 'outcome'], 'at');
    const params: unknown[] = [];
    const where: string[] = [];
    if (lq.q) { params.push(`%${lq.q}%`); where.push(`(email ILIKE $${params.length} OR ip ILIKE $${params.length})`); }
    if (lq.filters.outcome) { params.push(lq.filters.outcome); where.push(`outcome = $${params.length}`); }
    if (lq.filters.userId) { params.push(lq.filters.userId); where.push(`user_id = $${params.length}`); }
    const rows = await many<{ total_count: number }>(pool, `
      SELECT id, user_id, email, outcome, ip, user_agent, at, count(*) OVER ()::int AS total_count
      FROM login_events ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ${orderLimit({ ...lq, dir: req.query.dir ? lq.dir : 'desc' }, params)}`, params);
    res.json(page(rows, lq));
  });

  // Directory lookup for other screens (names for audit/approvals). Minimal fields only.
  r.get('/directory', async (_req, res) => {
    res.json(await many(pool, `SELECT id, name, email, status FROM users ORDER BY name`));
  });
}
