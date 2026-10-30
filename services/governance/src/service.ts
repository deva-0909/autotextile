import { type ServiceDefinition, migrationsOf } from '@erp/platform';
import { consumers, routes } from './routes.ts';

export const governanceService: ServiceDefinition = {
  name: 'governance',
  migrationsDir: migrationsOf(import.meta.url),
  routes,
  consumers,
};
