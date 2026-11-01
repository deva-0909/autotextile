import { type Pool, many, tx } from '@erp/platform';
import { raiseException, setting } from './common.ts';
import { autoAssign } from './allocation.ts';
import { crmSettings, clearSettingsCache } from './settings.ts';
import { rescore } from './score.ts';
import { syncCommissions } from './agents.ts';
import type { Lead } from './common.ts';

/**
 * Every 10 minutes: first-response target breaches (the time is set by the sales manager in Lead settings), one automatic
 * reassignment when a lead stays uncalled past the second limit, overdue follow-ups, expired quotations, another try at
 * leads nobody could take earlier (someone may have come back from a break or started their shift), scores brought up
 * to date, and agent commission matched to the invoices and payments in the books.
 */
export async function runCrmChecks(pool: Pool) {
  clearSettingsCache();
  const st = await crmSettings(pool);
  const sla = Number(st.first_response_minutes);
  const reassignAfter = Number(st.sla_reassign_minutes);
  const grace = Number(await setting('crm.followup_grace_hours', 4));
  const out = { sla_breaches: 0, sla_reassigned: 0, overdue_followups: 0, expired_quotes: 0, reassigned: 0, rescored: 0, commissions: 0 };
  await tx(pool, async (c) => {
    const slow = await many<{ id: string; number: string; name: string; owner_id: string | null; owner_name: string | null }>(c, `
      SELECT id, number, name, owner_id, owner_name FROM leads WHERE status = 'open' AND first_response_at IS NULL AND coalesce(assigned_at, created_at) < now() - make_interval(mins => $1)`, [sla]);
    for (const l of slow)
      if (await raiseException(c, { kind: 'first_response_breach', severity: 'warning', ref_type: 'lead', ref_id: l.id, ref_label: `${l.number} · ${l.name}`, message: `${l.number} not contacted within ${sla} minutes${l.owner_name ? ` (${l.owner_name})` : ''}`, notifyPermission: 'crm.lead.assign', notifyUser: l.owner_id, link: `/crm/leads/${l.id}` })) out.sla_breaches++;
    const due = await many<{ id: string; number: string; name: string; owner_id: string | null; next_action_at: string | null }>(c, `
      SELECT id, number, name, owner_id, next_action_at FROM leads WHERE status = 'open' AND stage <> 'nurture' AND owner_id IS NOT NULL AND first_response_at IS NOT NULL
        AND (next_action_at IS NULL OR next_action_at < now() - make_interval(hours => $1))`, [grace]);
    for (const l of due)
      if (await raiseException(c, { kind: 'followup_overdue', severity: 'info', ref_type: 'lead', ref_id: l.id, ref_label: `${l.number} · ${l.name}`, message: l.next_action_at ? `Follow-up on ${l.number} is overdue` : `${l.number} has no next follow-up`, notifyUser: l.owner_id, link: `/crm/leads/${l.id}` })) out.overdue_followups++;
    const exp = await c.query(`UPDATE quotations SET status = 'expired', updated_at = now() WHERE status = 'sent' AND valid_until < current_date`);
    out.expired_quotes = exp.rowCount ?? 0;
  });
  // Still not called after the second limit: moved once to the next available person, with the reason on record.
  if (reassignAfter > 0) {
    const stale = await many<Lead>(pool, `SELECT * FROM leads WHERE status = 'open' AND owner_id IS NOT NULL AND first_response_at IS NULL AND NOT sla_reassigned
      AND coalesce(assigned_at, created_at) < now() - make_interval(mins => $1) AND coalesce(assigned_at, created_at) > now() - interval '3 days'`, [reassignAfter]);
    for (const l of stale) await tx(pool, async (c) => {
      await c.query('UPDATE leads SET sla_reassigned = true WHERE id = $1', [l.id]);
      const d = await autoAssign(c, l, 'system', { method: 'sla', exclude_user_id: l.owner_id, reason: `Not called within ${reassignAfter} minutes by ${l.owner_name}` });
      if (d.owner) out.sla_reassigned++;
    });
  }
  const waiting = await many<Lead>(pool, `SELECT * FROM leads WHERE status = 'open' AND owner_id IS NULL AND created_at > now() - interval '3 days'`);
  for (const l of waiting) await tx(pool, async (c) => { if ((await autoAssign(c, l, 'system')).owner) out.reassigned++; });
  out.rescored = await tx(pool, (c) => rescore(c));
  out.commissions = await syncCommissions(pool).then((r) => r.accrued + r.earned, () => 0);
  return out;
}

export function startCrmAutomation(pool: Pool) {
  const run = () => runCrmChecks(pool).catch((e) => console.error('[crm] automation failed', (e as Error).message));
  setTimeout(run, 12_000);
  setInterval(run, 10 * 60_000).unref();
}
