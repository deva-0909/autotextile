import { type BusEvent, type Client, type ServiceDefinition, migrationsOf } from '@erp/platform';
import { S } from './common.ts';
import { leadRoutes, publicLeadRoutes } from './leads.ts';
import { allocationRoutes } from './allocation.ts';
import { applyQuoteDecision, quotationRoutes } from './quotations.ts';
import { applyCreditDecision, creditRoutes } from './credit.ts';
import { insightRoutes } from './insights.ts';
import { settingsRoutes } from './settings.ts';
import { workRoutes } from './work.ts';
import { analyticsRoutes } from './analytics.ts';
import { agentRoutes, applyPayoutDecision } from './agents.ts';

function approvalHandler() {
  return async (ev: BusEvent, c: Client) => {
    const p = ev.payload as { source_service: string; approval_type: string; ref_id: string; decision: string; decided_by_name: string; comment: string | null };
    if (p.source_service !== S) return;
    if (p.approval_type === 'quotation_price') await applyQuoteDecision(c, p);
    if (p.approval_type === 'credit_limit' || p.approval_type === 'credit_override') await applyCreditDecision(c, p);
    if (p.approval_type === 'agent_commission') await applyPayoutDecision(c, p);
  };
}

export const crmService: ServiceDefinition = {
  name: 'crm',
  migrationsDir: migrationsOf(import.meta.url),
  publicRoutes: (r, ctx) => publicLeadRoutes(r, ctx),
  routes: (r, ctx) => {
    // Fixed paths before /leads/:id.
    workRoutes(r, ctx);
    leadRoutes(r, ctx);
    settingsRoutes(r, ctx);
    analyticsRoutes(r, ctx);
    agentRoutes(r, ctx);
    allocationRoutes(r, ctx);
    quotationRoutes(r, ctx);
    creditRoutes(r, ctx);
    insightRoutes(r, ctx);
  },
  consumers: () => ({
    'approval.decided': approvalHandler(),
    // Attendance and approved leave from HRMS (P9) drive allocation: absent and on-leave salespeople are skipped.
    'hrms.attendance.marked': async (ev: BusEvent, c: Client) => {
      const p = ev.payload as { user_id: string; day: string; status: string };
      if (!(await c.query('SELECT 1 FROM sales_team WHERE user_id = $1', [p.user_id])).rowCount) return;
      await c.query(`INSERT INTO attendance (user_id, day, status, recorded_by_name) VALUES ($1,$2,$3,'HRMS') ON CONFLICT (user_id, day) DO UPDATE SET status = EXCLUDED.status, recorded_by_name = 'HRMS', recorded_at = now()`, [p.user_id, p.day, p.status]);
    },
    // Working hours set by HR for each employee: leads go only to people inside their shift.
    'hrms.shift.changed': async (ev: BusEvent, c: Client) => {
      const p = ev.payload as { user_id: string | null; start_time: string | null; end_time: string | null; shift_name: string | null };
      if (!p.user_id) return;
      await c.query('UPDATE sales_team SET shift_start = $2, shift_end = $3, shift_name = $4, updated_at = now() WHERE user_id = $1', [p.user_id, p.start_time, p.end_time, p.shift_name]);
    },
    'hrms.leave.approved': async (ev: BusEvent, c: Client) => {
      const p = ev.payload as { user_id: string | null; from: string; to: string; half_day: boolean; leave_type: string };
      if (!p.user_id || !(await c.query('SELECT 1 FROM sales_team WHERE user_id = $1', [p.user_id])).rowCount) return;
      await c.query(`INSERT INTO attendance (user_id, day, status, note, recorded_by_name) SELECT $1, d::date, $4, $5, 'HRMS' FROM generate_series($2::date, $3::date, interval '1 day') d
        ON CONFLICT (user_id, day) DO UPDATE SET status = EXCLUDED.status, note = EXCLUDED.note, recorded_by_name = 'HRMS', recorded_at = now()`, [p.user_id, p.from, p.to, p.half_day ? 'half_day' : 'leave', `${p.leave_type} leave approved in HRMS`]);
    },
  }),
};
