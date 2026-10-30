import { type ServiceDefinition, migrationsOf } from '@erp/platform';
import { rateRoutes } from './rates.ts';
import { orderRoutes, receiptConsumer } from './orders.ts';
import { claimRoutes } from './claims.ts';
import { portalRoutes } from './portal.ts';

export const jobworkService: ServiceDefinition = {
  name: 'jobwork',
  migrationsDir: migrationsOf(import.meta.url),
  routes: (r, ctx) => {
    rateRoutes(r, ctx);
    orderRoutes(r, ctx);
    claimRoutes(r, ctx);
    portalRoutes(r, ctx);
  },
  consumers: () => ({ 'procurement.receipt.recorded': receiptConsumer() }),
};
