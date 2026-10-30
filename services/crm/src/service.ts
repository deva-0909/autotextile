import { type BusEvent, type Client, type ServiceDefinition, migrationsOf } from '@erp/platform';
import { S } from './common.ts';
import { leadRoutes, publicLeadRoutes } from './leads.ts';
import { allocationRoutes } from './allocation.ts';
import { applyQuoteDecision, quotationRoutes } from './quotations.ts';
import { applyCreditDecision, creditRoutes } from './credit.ts';
import { insightRoutes } from './insights.ts';

function approvalHandler() {
  return async (ev: BusEvent, c: Client) => {
    const p = ev.payload as { source_service: string; approval_type: string; ref_id: string; decision: string; decided_by_name: string; comment: string | null };
    if (p.source_service !== S) return;
    if (p.approval_type === 'quotation_price') await applyQuoteDecision(c, p);
    if (p.approval_type === 'credit_limit' || p.approval_type === 'credit_override') await applyCreditDecision(c, p);
  };
}

export const crmService: ServiceDefinition = {
  name: 'crm',
  migrationsDir: migrationsOf(import.meta.url),
  publicRoutes: (r, ctx) => publicLeadRoutes(r, ctx),
  routes: (r, ctx) => {
    leadRoutes(r, ctx);
    allocationRoutes(r, ctx);
    quotationRoutes(r, ctx);
    creditRoutes(r, ctx);
    insightRoutes(r, ctx);
  },
  consumers: () => ({ 'approval.decided': approvalHandler() }),
};
