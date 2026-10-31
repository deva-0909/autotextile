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
  consumers: () => ({
    'approval.decided': approvalHandler(),
    // Finance posted the payment: the invoice is paid once nothing is owed on it.
    'finance.supplier.paid': async (ev, c) => {
      const p = ev.payload as { party_id: string; invoice_number: string; fully_paid: boolean };
      if (p.fully_paid) await c.query(`UPDATE supplier_invoices SET payment_status = 'paid', updated_at = now() WHERE supplier_id = $1 AND invoice_number = $2 AND status = 'posted'`, [p.party_id, p.invoice_number]);
    },
  }),
};
