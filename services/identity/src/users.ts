import { type AuthUser, type Client, type DataScope, type Pool, many, one } from '@erp/platform';

const KINDS = ['entity', 'gstin', 'branch', 'warehouse'] as const;

/** Builds the token identity (roles, effective permissions, data scope) for a user. */
export async function loadAuthUser(c: Pool | Client, userId: string, sessionId?: string): Promise<AuthUser> {
  const u = await one<{ id: string; name: string; email: string; party_id: string | null }>(c, 'SELECT id, name, email, party_id FROM users WHERE id = $1', [userId]);
  if (!u) throw new Error('user vanished');
  const roles = await many<{ code: string }>(c, 'SELECT r.code FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = $1 ORDER BY r.code', [userId]);
  const perms = await many<{ permission: string }>(
    c,
    'SELECT DISTINCT rp.permission FROM user_roles ur JOIN role_permissions rp ON rp.role_id = ur.role_id WHERE ur.user_id = $1 ORDER BY 1',
    [userId],
  );
  return { id: u.id, name: u.name, email: u.email, roles: roles.map((r) => r.code), permissions: perms.map((p) => p.permission), scope: await loadScope(c, userId), sessionId, partyId: u.party_id };
}

/**
 * Pages this user sees in the menu, or null for every page their permissions allow. Roles with no menu row are
 * unrestricted; otherwise the user sees the union of their roles' pages, narrowed by their own row if there is one.
 */
export async function loadMenu(c: Pool | Client, userId: string): Promise<string[] | null> {
  const roles = await many<{ code: string; items: string[] | null }>(c, `
    SELECT r.code, m.items FROM user_roles ur JOIN roles r ON r.id = ur.role_id
    LEFT JOIN menu_access m ON m.scope = 'role' AND m.ref = r.code WHERE ur.user_id = $1`, [userId]).catch(() => []);
  const own = await one<{ items: string[] }>(c, `SELECT items FROM menu_access WHERE scope = 'user' AND ref = $1`, [userId]).catch(() => null);
  const byRole = !roles.length || roles.some((r) => !r.items) ? null : [...new Set(roles.flatMap((r) => r.items!))];
  if (!own) return byRole;
  return byRole ? own.items.filter((i) => byRole.includes(i)) : own.items;
}

export async function loadScope(c: Pool | Client, userId: string): Promise<DataScope> {
  const rows = await many<{ kind: (typeof KINDS)[number]; ref_id: string | null }>(c, 'SELECT kind, ref_id FROM user_scopes WHERE user_id = $1', [userId]);
  const scope: DataScope = { entity: [], gstin: [], branch: [], warehouse: [] };
  for (const k of KINDS) {
    const mine = rows.filter((r) => r.kind === k);
    scope[k] = mine.some((r) => r.ref_id === null) ? '*' : mine.map((r) => r.ref_id!);
  }
  return scope;
}

export async function saveScope(c: Client, userId: string, scope: DataScope) {
  await c.query('DELETE FROM user_scopes WHERE user_id = $1', [userId]);
  for (const k of KINDS) {
    const v = scope[k];
    if (v === '*') await c.query('INSERT INTO user_scopes (user_id, kind, ref_id) VALUES ($1, $2, NULL)', [userId, k]);
    else for (const id of v) await c.query('INSERT INTO user_scopes (user_id, kind, ref_id) VALUES ($1, $2, $3)', [userId, k, id]);
  }
}

export const PUBLIC_USER_COLUMNS = `u.id, u.email, u.name, u.phone, u.employee_code, u.designation, u.status, u.mfa_enabled,
  u.must_change_password, u.last_login_at, u.locked_until, u.failed_attempts, u.party_id, u.parent_user_id, u.created_at, u.updated_at`;
