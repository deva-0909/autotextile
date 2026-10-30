import { BASELINE_ROLES, ALL_PERMISSION_CODES, PERMISSIONS, type ServiceDefinition, type Pool, migrationsOf, tx } from '@erp/platform';
import { authRoutes } from './auth-routes.ts';
import { adminRoutes } from './admin-routes.ts';

/**
 * Creates missing baseline roles, grants permissions introduced by newer releases to baseline roles once,
 * and keeps Super Admin holding every permission in the catalog.
 */
export async function syncRoles(pool: Pool) {
  const since = new Map(PERMISSIONS.map((p) => [p.code, p.since ?? 'P1']));
  await tx(pool, async (c) => {
    const { rows: [{ n: tracked }] } = await c.query('SELECT count(*)::int AS n FROM baseline_grants');
    for (const role of BASELINE_ROLES) {
      const r = await c.query(
        `INSERT INTO roles (code, name, description, is_system) VALUES ($1, $2, $3, true) ON CONFLICT (code) DO NOTHING RETURNING id`,
        [role.code, role.name, role.description],
      );
      const created = !!r.rows[0];
      const { rows: [{ id: roleId }] } = await c.query('SELECT id FROM roles WHERE code = $1', [role.code]);
      for (const p of role.permissions) {
        const done = await c.query('SELECT 1 FROM baseline_grants WHERE role_code = $1 AND permission = $2', [role.code, p]);
        if (done.rowCount) continue;
        // A database from before grant tracking already received its P1 baseline; only newer permissions are added.
        const grant = created || tracked > 0 || since.get(p) !== 'P1';
        if (grant) await c.query('INSERT INTO role_permissions (role_id, permission) VALUES ($1, $2) ON CONFLICT DO NOTHING', [roleId, p]);
        await c.query('INSERT INTO baseline_grants (role_code, permission) VALUES ($1, $2)', [role.code, p]);
      }
    }
    await c.query(
      `INSERT INTO role_permissions (role_id, permission)
       SELECT r.id, p FROM roles r, unnest($1::text[]) p WHERE r.code = 'super_admin' ON CONFLICT DO NOTHING`,
      [ALL_PERMISSION_CODES],
    );
  });
}

export const identityService: ServiceDefinition = {
  name: 'identity',
  migrationsDir: migrationsOf(import.meta.url),
  publicRoutes: authRoutes,
  routes: adminRoutes,
};
