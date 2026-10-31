import { type BusEvent, type Client, type ServiceDefinition, migrationsOf } from '@erp/platform';
import { S } from './common.ts';
import { EVENT_VARIABLES, applyTemplateDecision, messagingPublicRoutes, messagingRoutes } from './messaging.ts';
import { engineRoutes, eventHandler } from './engine.ts';
import { contractRoutes } from './contracts.ts';
import { handoverRoutes } from './handover.ts';

function approvalHandler() {
  return async (ev: BusEvent, c: Client) => {
    const p = ev.payload as { source_service: string; approval_type: string; ref_id: string; decision: string; decided_by_name: string };
    if (p.source_service === S && p.approval_type === 'message_template') await applyTemplateDecision(c, p);
  };
}

export const workflowService: ServiceDefinition = {
  name: 'workflow',
  migrationsDir: migrationsOf(import.meta.url),
  publicRoutes: (r, ctx) => messagingPublicRoutes(r, ctx),
  routes: (r, ctx) => {
    messagingRoutes(r, ctx);
    engineRoutes(r, ctx);
    contractRoutes(r, ctx);
    handoverRoutes(r, ctx);
  },
  consumers: () => ({
    'approval.decided': approvalHandler(),
    ...Object.fromEntries(Object.keys(EVENT_VARIABLES).map((t) => [t, eventHandler(t)])),
  }),
};
