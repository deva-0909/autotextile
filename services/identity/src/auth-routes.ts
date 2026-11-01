import type { Request, Response, Router } from 'express';
import { SignJWT, jwtVerify } from 'jose';
import { z } from 'zod';
import {
  type Client, type ServiceContext, audit, badRequest, config, contextOf, many, one, parse, signAccessToken, tx, unauthorized,
} from '@erp/platform';
import { hashPassword, passwordProblem, randomToken, sha256, verifyPassword, verifyTotp } from './security.ts';
import { loadAuthUser, loadMenu } from './users.ts';

export const MAX_FAILED = 5;
export const LOCK_MINUTES = 15;
const REFRESH_DAYS = 7;
const COOKIE = 'erp_rt';
const COOKIE_PATH = '/api/identity/auth';

const mfaSecret = () => new TextEncoder().encode(`${config.jwtSecret()}:mfa`);

interface UserRow {
  id: string; email: string; name: string; password_hash: string; status: string; mfa_enabled: boolean; mfa_secret: string | null;
  failed_attempts: number; locked_until: string | null; must_change_password: boolean;
}

async function logEvent(c: ServiceContext['pool'] | Client, req: Request, email: string, outcome: string, userId?: string) {
  await c.query('INSERT INTO login_events (user_id, email, outcome, ip, user_agent) VALUES ($1, $2, $3, $4, $5)', [
    userId ?? null, email, outcome, contextOf(req).ip, req.headers['user-agent'] ?? null,
  ]);
}

function readCookie(req: Request, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
}

function setRefreshCookie(res: Response, token: string | null) {
  const attrs = [`${COOKIE}=${token ?? ''}`, `Path=${COOKIE_PATH}`, 'HttpOnly', 'SameSite=Strict', `Max-Age=${token ? REFRESH_DAYS * 86400 : 0}`];
  if (process.env.NODE_ENV === 'production') attrs.push('Secure');
  res.setHeader('Set-Cookie', attrs.join('; '));
}

/** Creates a session, sets the refresh cookie and returns the access token payload. */
async function startSession(ctx: ServiceContext, req: Request, res: Response, user: UserRow) {
  const refresh = randomToken();
  const session = await tx(ctx.pool, async (c) => {
    const s = await one<{ id: string }>(
      c,
      `INSERT INTO sessions (user_id, refresh_hash, ip, user_agent, expires_at) VALUES ($1, $2, $3, $4, now() + interval '${REFRESH_DAYS} days') RETURNING id`,
      [user.id, sha256(refresh), contextOf(req).ip, req.headers['user-agent'] ?? null],
    );
    await c.query('UPDATE users SET failed_attempts = 0, locked_until = NULL, last_login_at = now() WHERE id = $1', [user.id]);
    await logEvent(c, req, user.email, 'success', user.id);
    return s!;
  });
  const authUser = await loadAuthUser(ctx.pool, user.id, session.id);
  setRefreshCookie(res, refresh);
  return { accessToken: await signAccessToken(authUser), user: { ...authUser, menu: await loadMenu(ctx.pool, user.id) }, mustChangePassword: user.must_change_password };
}

export function authRoutes(r: Router, ctx: ServiceContext) {
  r.post('/auth/login', async (req, res) => {
    const { email, password } = parse(z.object({ email: z.string().trim().min(1), password: z.string().min(1) }), req.body);
    const user = await one<UserRow>(ctx.pool, 'SELECT * FROM users WHERE lower(email) = lower($1)', [email]);
    const generic = unauthorized('Email or password is incorrect');
    if (!user) {
      await logEvent(ctx.pool, req, email, 'unknown_user');
      throw generic;
    }
    if (user.status !== 'active') {
      await logEvent(ctx.pool, req, email, 'inactive', user.id);
      throw unauthorized('This account is deactivated. Contact your administrator.');
    }
    if (user.locked_until && new Date(user.locked_until) > new Date()) {
      await logEvent(ctx.pool, req, email, 'locked', user.id);
      throw unauthorized(`Account locked after repeated failed attempts. Try again after ${new Date(user.locked_until).toLocaleTimeString('en-IN')}.`);
    }
    if (!(await verifyPassword(password, user.password_hash))) {
      const failed = user.failed_attempts + 1;
      const lock = failed >= MAX_FAILED;
      // On lock the counter restarts, so the next window allows MAX_FAILED attempts again.
      await ctx.pool.query(
        `UPDATE users SET failed_attempts = $2, locked_until = CASE WHEN $3 THEN now() + interval '${LOCK_MINUTES} minutes' END WHERE id = $1`,
        [user.id, lock ? 0 : failed, lock],
      );
      await logEvent(ctx.pool, req, email, lock ? 'locked' : 'bad_password', user.id);
      throw lock ? unauthorized(`Too many failed attempts. Account locked for ${LOCK_MINUTES} minutes.`) : generic;
    }
    if (user.mfa_enabled) {
      const mfaToken = await new SignJWT({ purpose: 'mfa' }).setProtectedHeader({ alg: 'HS256' }).setSubject(user.id).setExpirationTime('5m').sign(mfaSecret());
      await logEvent(ctx.pool, req, email, 'password_ok_mfa_pending', user.id);
      return void res.json({ mfaRequired: true, mfaToken });
    }
    res.json(await startSession(ctx, req, res, user));
  });

  /**
   * Demo mode only (DEMO_MODE=1, for client walkthroughs on a demo database): list the active users and sign in as
   * any of them without a password, so the presenter can switch roles in one click. Absent otherwise.
   */
  if (process.env.DEMO_MODE === '1') {
    r.get('/auth/demo-users', async (_req, res) => {
      res.json(await many(ctx.pool, `
        SELECT u.email, u.name, u.designation, u.party_id IS NOT NULL AS portal, string_agg(DISTINCT ro.name, ', ') AS roles, min(ro.code) AS role_code
        FROM users u LEFT JOIN user_roles ur ON ur.user_id = u.id LEFT JOIN roles ro ON ro.id = ur.role_id
        WHERE u.status = 'active' GROUP BY u.id
        ORDER BY (u.party_id IS NOT NULL), coalesce(array_position(ARRAY['owner','super_admin','management_approver','purchase_manager','purchase_executive','warehouse_manager','mill_ops_manager','sales_manager','sales_executive','dispatch_manager','customer_care','accounts_manager','accounts_executive','hr_manager','auditor','customer_company_admin','customer_buyer','supplier_portal','mill_user','commission_agent'], min(ro.code)), 99), u.name`));
    });
    r.post('/auth/demo-login', async (req, res) => {
      const { email } = parse(z.object({ email: z.string().trim().min(1) }), req.body);
      const user = await one<UserRow>(ctx.pool, 'SELECT * FROM users WHERE lower(email) = lower($1)', [email]);
      if (!user || user.status !== 'active') throw unauthorized('No such active demo user');
      res.json({ ...(await startSession(ctx, req, res, user)), mustChangePassword: false });
    });
  }

  r.post('/auth/mfa', async (req, res) => {
    const { mfaToken, code } = parse(z.object({ mfaToken: z.string(), code: z.string().regex(/^\d{6}$/, 'Enter the 6-digit code') }), req.body);
    let userId: string;
    try {
      const { payload } = await jwtVerify(mfaToken, mfaSecret());
      if (payload.purpose !== 'mfa') throw new Error();
      userId = String(payload.sub);
    } catch {
      throw unauthorized('Verification expired. Sign in again.');
    }
    const user = await one<UserRow>(ctx.pool, 'SELECT * FROM users WHERE id = $1', [userId]);
    if (!user || user.status !== 'active' || !user.mfa_secret) throw unauthorized();
    if (!verifyTotp(user.mfa_secret, code)) {
      await logEvent(ctx.pool, req, user.email, 'mfa_failed', user.id);
      throw unauthorized('That code is not valid. Check your authenticator app and try again.');
    }
    res.json(await startSession(ctx, req, res, user));
  });

  r.post('/auth/refresh', async (req, res) => {
    const token = readCookie(req, COOKIE);
    if (!token) throw unauthorized('No session');
    const s = await one<{ id: string; user_id: string; status: string }>(
      ctx.pool,
      `SELECT s.id, s.user_id, u.status FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.refresh_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()`,
      [sha256(token)],
    );
    if (!s || s.status !== 'active') {
      setRefreshCookie(res, null);
      throw unauthorized('Session expired. Sign in again.');
    }
    // Rotate the refresh token on every use.
    const next = randomToken();
    await ctx.pool.query('UPDATE sessions SET refresh_hash = $2, last_used_at = now() WHERE id = $1', [s.id, sha256(next)]);
    setRefreshCookie(res, next);
    const user = await loadAuthUser(ctx.pool, s.user_id, s.id);
    const flags = await one<{ must_change_password: boolean }>(ctx.pool, 'SELECT must_change_password FROM users WHERE id = $1', [s.user_id]);
    res.json({ accessToken: await signAccessToken(user), user: { ...user, menu: await loadMenu(ctx.pool, s.user_id) },
      // Demo sign-in skips the first-sign-in password change; a reload must not bring it back.
      mustChangePassword: process.env.DEMO_MODE === '1' ? false : flags!.must_change_password });
  });

  r.post('/auth/logout', async (req, res) => {
    const token = readCookie(req, COOKIE);
    if (token) await ctx.pool.query('UPDATE sessions SET revoked_at = now() WHERE refresh_hash = $1 AND revoked_at IS NULL', [sha256(token)]);
    setRefreshCookie(res, null);
    res.json({ ok: true });
  });

  r.post('/auth/password-reset/request', async (req, res) => {
    const { email } = parse(z.object({ email: z.string().trim().min(1) }), req.body);
    const user = await one<{ id: string }>(ctx.pool, `SELECT id FROM users WHERE lower(email) = lower($1) AND status = 'active'`, [email]);
    let devToken: string | undefined;
    if (user) {
      const token = randomToken();
      await ctx.pool.query(`INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '30 minutes')`, [user.id, sha256(token)]);
      await logEvent(ctx.pool, req, email, 'password_reset_requested', user.id);
      // Email delivery arrives with the notification service (P9). Until then the link is shown only outside production.
      if (process.env.NODE_ENV !== 'production') devToken = token;
    }
    res.json({ message: 'If that account exists, a reset link has been issued.', devToken });
  });

  r.post('/auth/password-reset/confirm', async (req, res) => {
    const { token, password } = parse(z.object({ token: z.string(), password: z.string() }), req.body);
    const problem = passwordProblem(password);
    if (problem) throw badRequest(problem);
    await tx(ctx.pool, async (c) => {
      const pr = await one<{ id: string; user_id: string }>(
        c, 'SELECT id, user_id FROM password_resets WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now() FOR UPDATE', [sha256(token)],
      );
      if (!pr) throw badRequest('This reset link is invalid or has expired');
      await c.query('UPDATE password_resets SET used_at = now() WHERE id = $1', [pr.id]);
      await c.query(
        'UPDATE users SET password_hash = $2, password_changed_at = now(), must_change_password = false, failed_attempts = 0, locked_until = NULL WHERE id = $1',
        [pr.user_id, await hashPassword(password)],
      );
      await c.query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [pr.user_id]);
      await audit(c, 'identity', { ...contextOf(req), userId: pr.user_id }, { entity: 'user', entityId: pr.user_id, action: 'password_reset' });
    });
    res.json({ ok: true });
  });

  // Exposed for the login screen footer: active login policy.
  r.get('/auth/policy', async (_req, res) => {
    const [{ n }] = await many<{ n: number }>(ctx.pool, 'SELECT count(*)::int AS n FROM users');
    res.json({ minPasswordLength: 10, lockoutAttempts: MAX_FAILED, lockoutMinutes: LOCK_MINUTES, initialised: n > 0 });
  });
}
