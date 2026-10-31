import { type BusEvent, type Client, type ServiceDefinition, migrationsOf } from '@erp/platform';
import { S } from './common.ts';
import { allocationRoutes, applySplitDecision, orderBookedConsumer, orderCancelledConsumer, orderExtendedConsumer } from './allocation.ts';
import { applyGateDecision, fulfilmentRoutes, paymentReceivedConsumer } from './fulfilments.ts';
import { deliveryRoutes, publicTrackingRoutes } from './delivery.ts';

function approvalHandler() {
  return async (ev: BusEvent, c: Client) => {
    const p = ev.payload as { source_service: string; approval_type: string; ref_id: string; decision: string; decided_by_name: string; comment: string | null };
    if (p.source_service !== S) return;
    if (p.approval_type === 'split_fulfilment') await applySplitDecision(c, p);
    if (p.approval_type === 'dispatch_gate_override') await applyGateDecision(c, p);
  };
}

export const fulfilmentService: ServiceDefinition = {
  name: 'fulfilment',
  migrationsDir: migrationsOf(import.meta.url),
  publicRoutes: (r, ctx) => publicTrackingRoutes(r, ctx),
  routes: (r, ctx) => {
    allocationRoutes(r, ctx);
    fulfilmentRoutes(r, ctx);
    deliveryRoutes(r, ctx);
  },
  consumers: () => ({
    'approval.decided': approvalHandler(),
    'commerce.order.booked': orderBookedConsumer(),
    'commerce.order.extended': orderExtendedConsumer(),
    'commerce.order.cancelled': orderCancelledConsumer(),
    'commerce.payment.received': paymentReceivedConsumer(),
  }),
};
