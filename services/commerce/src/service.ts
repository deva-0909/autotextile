import { type BusEvent, type Client, type ServiceDefinition, migrationsOf } from '@erp/platform';
import { S } from './common.ts';
import { applyPolicyDecision, policyRoutes } from './policies.ts';
import { applyExtensionDecision, fulfilmentStatusConsumer, orderRoutes, planReservedConsumer, quotationAcceptedConsumer } from './orders.ts';
import { paymentRoutes, publicPaymentRoutes } from './payments.ts';
import { accountRoutes, publicAccountRoutes } from './accounts.ts';
import { walletRoutes } from './wallet.ts';
import { supportRoutes } from './support.ts';

function approvalHandler() {
  return async (ev: BusEvent, c: Client) => {
    const p = ev.payload as { source_service: string; approval_type: string; ref_id: string; decision: string; decided_by_name: string };
    if (p.source_service !== S) return;
    if (p.approval_type === 'token_policy') await applyPolicyDecision(c, p);
    if (p.approval_type === 'reservation_extension') await applyExtensionDecision(c, p);
  };
}

export const commerceService: ServiceDefinition = {
  name: 'commerce',
  migrationsDir: migrationsOf(import.meta.url),
  publicRoutes: (r, ctx) => { publicPaymentRoutes(r, ctx); publicAccountRoutes(r, ctx); },
  routes: (r, ctx) => {
    policyRoutes(r, ctx);
    orderRoutes(r, ctx);
    paymentRoutes(r, ctx);
    accountRoutes(r, ctx);
    walletRoutes(r, ctx);
    supportRoutes(r, ctx);
  },
  consumers: () => {
    const status = fulfilmentStatusConsumer();
    return {
      'approval.decided': approvalHandler(),
      'crm.quotation.accepted': quotationAcceptedConsumer(),
      'fulfilment.plan.reserved': planReservedConsumer(),
      'fulfilment.started': status,
      'fulfilment.dispatched': status,
      'fulfilment.delivered': status,
    };
  },
};
