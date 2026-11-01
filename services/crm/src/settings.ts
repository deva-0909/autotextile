import type { Router } from 'express';
import { z } from 'zod';
import { type Client, type Pool, type ServiceContext, badRequest, many, parse, requirePermission, tx } from '@erp/platform';
import { auditReq } from './common.ts';

/** CRM settings the sales manager can change. Defaults apply when a key has not been stored. */
export const DEFAULTS = {
  first_response_minutes: 15,
  sla_reassign_minutes: 30,
  no_progress_attempts: 20,
  objections: ['Price', 'Quality / GSM', 'Shade / colour', 'Delivery time', 'Payment terms / credit', 'Minimum order quantity', 'Comparing other suppliers', 'Invalid contact', 'Other'],
  stage_probability: { new: 0.03, assigned: 0.03, contact_pending: 0.04, contacted: 0.08, qualified: 0.2, quotation: 0.35, negotiation: 0.5, order_confirmed: 0.85, nurture: 0.02 } as Record<string, number>,
  performance_window_days: 90,
  agent_protection_days: 90,
  agent_commission_months: 12,
  attribution_months: 12,
};
export type CrmSettings = typeof DEFAULTS;

let cache: { at: number; v: CrmSettings } | null = null;
export async function crmSettings(c: Pool | Client): Promise<CrmSettings> {
  if (cache && Date.now() - cache.at < 15_000) return cache.v;
  const rows = await many<{ key: string; value: unknown }>(c, 'SELECT key, value FROM crm_settings');
  const v = { ...DEFAULTS } as Record<string, unknown>;
  for (const r of rows) if (r.key in DEFAULTS) v[r.key] = r.value;
  cache = { at: Date.now(), v: v as CrmSettings };
  return cache.v;
}
export const clearSettingsCache = () => { cache = null; };

const body = z.object({
  first_response_minutes: z.number().int().min(1, 'At least 1 minute').max(1440).optional(),
  sla_reassign_minutes: z.number().int().min(0).max(2880).optional(),
  no_progress_attempts: z.number().int().min(1).max(200).optional(),
  objections: z.array(z.string().trim().min(2).max(60)).min(1).max(30).optional(),
  stage_probability: z.record(z.string(), z.number().min(0).max(1)).optional(),
  performance_window_days: z.number().int().min(7).max(365).optional(),
  agent_protection_days: z.number().int().min(1).max(730).optional(),
  agent_commission_months: z.number().int().min(1).max(60).optional(),
  attribution_months: z.number().int().min(1).max(60).optional(),
});

export function settingsRoutes(r: Router, { pool }: ServiceContext) {
  r.get('/settings', requirePermission('crm.read'), async (_req, res) => {
    clearSettingsCache();
    res.json(await crmSettings(pool));
  });
  r.put('/settings', requirePermission('crm.config.manage'), async (req, res) => {
    const b = parse(body, req.body);
    if (b.sla_reassign_minutes && b.first_response_minutes && b.sla_reassign_minutes <= b.first_response_minutes)
      throw badRequest('Reassign after a longer time than the response target', { fields: { sla_reassign_minutes: 'Must be longer than the response target, or 0 to switch off' } });
    if (b.objections && !b.objections.includes('Other')) b.objections.push('Other');
    const before = await crmSettings(pool);
    await tx(pool, async (c) => {
      for (const [k, v] of Object.entries(b)) {
        if (v === undefined) continue;
        await c.query(`INSERT INTO crm_settings (key, value, updated_by_name) VALUES ($1, $2, $3) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by_name = EXCLUDED.updated_by_name, updated_at = now()`, [k, JSON.stringify(v), req.user!.name]);
      }
      await auditReq(c, req, 'crm_settings', '00000000-0000-0000-0000-000000000000', 'updated', { before: Object.fromEntries(Object.keys(b).map((k) => [k, (before as Record<string, unknown>)[k]])), after: b });
    });
    clearSettingsCache();
    res.json(await crmSettings(pool));
  });
}
