import { BASELINE_ROLES, ALL_PERMISSION_CODES, type ServiceDefinition, type Pool, migrationsOf, tx } from '@erp/platform';
import { authRoutes } from './auth-routes.ts';
import { adminRoutes } from './admin-routes.ts';

/** Creates missing baseline roles and keeps Super Admin holding every permission in the catalog. */
export async function syncRoles(pool: Pool) {
  await tx(pool, async (c) => {
    for (const role of BASELINE_ROLES) {
      const r = await c.query(
        `INSERT INTO roles (code, name, description, is_system) VALUES ($1, $2, $3, true) ON CONFLICT (code) DO NOTHING RETURNING id`,
        [role.code, role.name, role.description],
      );
      if (r.rows[0]) for (const p of role.permissions) await c.query('INSERT INTO role_permissions (role_id, permission) VALUES ($1, $2)', [r.rows[0].id, p]);
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
