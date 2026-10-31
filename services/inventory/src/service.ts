import { type BusEvent, type Client, type ServiceDefinition, migrationsOf } from '@erp/platform';
import { S } from './common.ts';
import { inwardRoutes, jobReturnConsumer, receiptConsumer } from './inward.ts';
import { jobIssuedConsumer, stockRoutes } from './stock.ts';
import { applyPriceDecision, pricingRoutes } from './pricing.ts';
import { reservationRoutes } from './reservations.ts';
import { applyTransferDecision, transferRoutes } from './transfers.ts';
import { applyStocktakeDecision, stocktakeRoutes } from './stocktake.ts';
import { dispatchRoutes } from './dispatch.ts';

function approvalHandler() {
  return async (ev: BusEvent, c: Client) => {
    const p = ev.payload as { source_service: string; approval_type: string; ref_id: string; decision: string; decided_by: string; decided_by_name: string; comment: string | null };
    if (p.source_service !== S) return;
    if (p.approval_type === 'price_change') await applyPriceDecision(c, p);
    if (p.approval_type === 'stock_transfer') await applyTransferDecision(c, p);
    if (p.approval_type === 'stock_adjustment') await applyStocktakeDecision(c, p);
  };
}

export const inventoryService: ServiceDefinition = {
  name: 'inventory',
  migrationsDir: migrationsOf(import.meta.url),
  routes: (r, ctx) => {
    inwardRoutes(r, ctx);
    stockRoutes(r, ctx);
    pricingRoutes(r, ctx);
    reservationRoutes(r, ctx);
    transferRoutes(r, ctx);
    stocktakeRoutes(r, ctx);
    dispatchRoutes(r, ctx);
  },
  consumers: () => ({
    'procurement.receipt.recorded': receiptConsumer(),
    'jobwork.order.issued': jobIssuedConsumer(),
    'jobwork.return.recorded': jobReturnConsumer(),
    'approval.decided': approvalHandler(),
  }),
};
