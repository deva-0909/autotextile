import { type BusEvent, type Client, type ServiceDefinition, migrationsOf } from '@erp/platform';
import { S } from './common.ts';
import { peopleRoutes } from './people.ts';
import { applyLeaveDecision, timeRoutes } from './time.ts';
import { applyPayrollDecision, payrollRoutes } from './payroll.ts';

function approvalHandler() {
  return async (ev: BusEvent, c: Client) => {
    const p = ev.payload as { source_service: string; approval_type: string; ref_id: string; decision: string; decided_by_name: string; comment: string | null };
    if (p.source_service !== S) return;
    if (p.approval_type === 'leave_request') await applyLeaveDecision(c, p);
    if (p.approval_type === 'payroll_run') await applyPayrollDecision(c, p);
  };
}

export const hrmsService: ServiceDefinition = {
  name: 'hrms',
  migrationsDir: migrationsOf(import.meta.url),
  routes: (r, ctx) => {
    peopleRoutes(r, ctx);
    timeRoutes(r, ctx);
    payrollRoutes(r, ctx);
  },
  consumers: () => ({ 'approval.decided': approvalHandler() }),
};
