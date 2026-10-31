import { type ServiceDefinition, migrationsOf } from '@erp/platform';
import { insightRoutes } from './routes.ts';

export const insightsService: ServiceDefinition = {
  name: 'insights',
  migrationsDir: migrationsOf(import.meta.url),
  routes: (r, ctx) => insightRoutes(r, ctx),
};
