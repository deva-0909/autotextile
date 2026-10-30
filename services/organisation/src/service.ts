import { type ServiceDefinition, migrationsOf } from '@erp/platform';
import { routes } from './routes.ts';

export const organisationService: ServiceDefinition = {
  name: 'organisation',
  migrationsDir: migrationsOf(import.meta.url),
  routes,
};
