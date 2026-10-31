import { type ServiceDefinition, migrationsOf } from '@erp/platform';
import { applyFinanceDecision, voucherRoutes } from './vouchers.ts';
import { approvalDecidedConsumer, creditNoteConsumer, orderCancelledConsumer, payrollApprovedConsumer, payrollPaidConsumer, paymentReceivedConsumer, paymentRefundedConsumer, salesInvoiceConsumer, supplierInvoiceConsumer, transferConsumer } from './postings.ts';
import { partyRoutes } from './parties.ts';
import { gstRoutes } from './gst.ts';
import { tdsRoutes } from './tds.ts';
import { bankRoutes } from './bank.ts';
import { reportRoutes } from './reports.ts';

export const financeService: ServiceDefinition = {
  name: 'finance',
  migrationsDir: migrationsOf(import.meta.url),
  routes: (r, ctx) => {
    voucherRoutes(r, ctx);
    partyRoutes(r, ctx);
    gstRoutes(r, ctx);
    tdsRoutes(r, ctx);
    bankRoutes(r, ctx);
    reportRoutes(r, ctx);
  },
  consumers: () => ({
    'approval.decided': approvalDecidedConsumer(applyFinanceDecision),
    'procurement.invoice.posted': supplierInvoiceConsumer(),
    'fulfilment.invoiced': salesInvoiceConsumer(),
    'fulfilment.credit_note.issued': creditNoteConsumer(),
    'commerce.payment.received': paymentReceivedConsumer(),
    'commerce.payment.refunded': paymentRefundedConsumer(),
    'commerce.order.cancelled': orderCancelledConsumer(),
    'inventory.transfer.dispatched': transferConsumer(),
    'hrms.payroll.approved': payrollApprovedConsumer(),
    'hrms.payroll.paid': payrollPaidConsumer(),
  }),
};
