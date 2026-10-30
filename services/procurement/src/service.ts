import { type ServiceDefinition, migrationsOf } from '@erp/platform';
import { sourcingRoutes } from './sourcing.ts';
import { approvalHandler, orderRoutes } from './orders.ts';
import { invoiceRoutes } from './invoices.ts';
import { captureRoutes } from './capture.ts';
import { supplierRoutes } from './suppliers.ts';
import { portalRoutes } from './portal.ts';

export const procurementService: ServiceDefinition = {
  name: 'procurement',
  migrationsDir: migrationsOf(import.meta.url),
  routes: (r, ctx) => {
    sourcingRoutes(r, ctx);
    orderRoutes(r, ctx);
    invoiceRoutes(r, ctx);
    captureRoutes(r, ctx);
    supplierRoutes(r, ctx);
    portalRoutes(r, ctx);
  },
  consumers: () => ({ 'approval.decided': approvalHandler() }),
};
