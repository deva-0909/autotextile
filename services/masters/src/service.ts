import { type ServiceDefinition, migrationsOf } from '@erp/platform';
import { partyRoutes, approvalConsumers } from './parties.ts';
import { catalogRoutes } from './catalog.ts';
import { referenceRoutes } from './reference.ts';

export const mastersService: ServiceDefinition = {
  name: 'masters',
  migrationsDir: migrationsOf(import.meta.url),
  routes: (r, ctx) => {
    partyRoutes(r, ctx);
    catalogRoutes(r, ctx);
    referenceRoutes(r, ctx);
  },
  consumers: approvalConsumers,
};
