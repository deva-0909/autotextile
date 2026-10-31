import { type ServiceDefinition, migrationsOf } from '@erp/platform';
import { migrationRoutes } from './migration.ts';
import { readinessRoutes } from './readiness.ts';

export const goliveService: ServiceDefinition = {
  name: 'golive',
  migrationsDir: migrationsOf(import.meta.url),
  routes: (r, ctx) => {
    migrationRoutes(r, ctx);
    readinessRoutes(r, ctx);
  },
};
