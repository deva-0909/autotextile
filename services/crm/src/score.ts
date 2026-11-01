import { type Client, type Pool, many } from '@erp/platform';
import { getProduct } from './common.ts';

/**
 * Lead score, 0–100, with the reasons behind it. Recomputed whenever a lead changes and on the
 * ten-minute check (so "no contact for weeks" takes effect without anyone touching the lead).
 */
export interface ScoreFacts {
  stage: string; status: string; source_code: string; est_value: number | null; requirement_kg: number | null; customer_id: string | null;
  created_at: string; first_response_at: string | null; last_contact_at: string | null; connected_calls: number; no_progress: boolean; reenquiry_count: number;
  agent_id: string | null; moq_kg: number | null; outcomes: string[];
}
export interface Score { score: number; band: 'hot' | 'warm' | 'cold'; reasons: { text: string; points: number }[] }

const SOURCE_POINTS: Record<string, number> = { REFERRAL: 15, AGENT: 15, WEBSITE: 10, PHONE: 10, EMAIL: 8, EXHIBITION: 10, WHATSAPP: 8, INDIAMART: 6, TRADE: 6, JUSTDIAL: 4, META: 4, MANUAL: 5 };
const STAGE_POINTS: Record<string, number> = { contacted: 5, qualified: 12, quotation: 18, negotiation: 22, order_confirmed: 30, nurture: -10 };
const OUTCOME_POINTS: Record<string, number> = { very_interested: 20, interested: 12, needs_changes: 5, not_interested: -15 };
const DAY = 86_400_000;

export function scoreLead(f: ScoreFacts, now = Date.now()): Score {
  const reasons: { text: string; points: number }[] = [];
  const add = (points: number, text: string) => { if (points) reasons.push({ text, points }); };
  let s = 10;
  const v = f.est_value != null ? Number(f.est_value) : null;
  if (v == null || v <= 0) reasons.push({ text: 'Order value not captured', points: 0 });
  else add(v >= 1_000_000 ? 20 : v >= 300_000 ? 15 : v >= 100_000 ? 10 : 5, `Order value ₹${Math.round(v).toLocaleString('en-IN')}`);
  if (f.moq_kg && f.requirement_kg != null && Number(f.requirement_kg) > 0 && Number(f.requirement_kg) < Number(f.moq_kg)) add(-10, `Below minimum order (${f.requirement_kg} of ${f.moq_kg} kg)`);
  else if (f.moq_kg && f.requirement_kg != null && Number(f.requirement_kg) >= Number(f.moq_kg)) add(5, 'Meets the minimum order');
  const sp = SOURCE_POINTS[f.source_code] ?? 5;
  add(sp, `Source: ${f.agent_id ? 'commission agent' : f.source_code.toLowerCase()}`);
  if (f.customer_id) add(15, 'Repeat buyer (existing customer)');
  add(STAGE_POINTS[f.stage] ?? 0, `Stage: ${f.stage.replace(/_/g, ' ')}`);
  const best = f.outcomes.map((o) => OUTCOME_POINTS[o] ?? 0).sort((a, b) => b - a)[0];
  if (best !== undefined) add(best, best > 0 ? (best >= 20 ? 'Very interested after sample or visit' : best >= 12 ? 'Interested after sample or visit' : 'Wants changes after sample') : 'Not interested after sample or visit');
  if (f.reenquiry_count > 0) add(Math.min(16, 8 * f.reenquiry_count), `Enquired again${f.reenquiry_count > 1 ? ` (${f.reenquiry_count} times)` : ''}`);
  if (f.connected_calls > 0) add(5, 'Spoken to on the phone');
  const last = f.last_contact_at ?? f.first_response_at;
  if (last) {
    const days = Math.floor((now - new Date(last).getTime()) / DAY);
    if (days <= 3) add(7, 'Contacted in the last 3 days');
    else if (days > 21) add(-10, `No contact for ${days} days`);
  } else if (now - new Date(f.created_at).getTime() > 2 * DAY) add(-5, 'Never contacted');
  if (f.no_progress) add(-15, 'Many calls, no progress');
  for (const r of reasons) s += r.points;
  s = Math.max(0, Math.min(100, Math.round(s)));
  reasons.sort((a, b) => Math.abs(b.points) - Math.abs(a.points));
  return { score: s, band: s >= 65 ? 'hot' : s >= 40 ? 'warm' : 'cold', reasons };
}

/** Recomputes and stores the score of the given leads (open ones; closed leads lose their score). */
export async function rescore(c: Pool | Client, leadIds?: string[]) {
  const where = leadIds ? 'l.id = ANY($1)' : `l.status = 'open'`;
  const rows = await many<ScoreFacts & { id: string; product_id: string | null; score: number | null }>(c, `
    SELECT l.id, l.stage, l.status, l.source_code, l.est_value::float, l.requirement_kg::float, l.customer_id, l.created_at, l.first_response_at, l.last_contact_at, l.connected_calls,
      l.no_progress, l.reenquiry_count, l.agent_id, l.product_id, l.score, NULL::float AS moq_kg,
      coalesce((SELECT array_agg(e.outcome) FROM lead_engagements e WHERE e.lead_id = l.id AND e.outcome IS NOT NULL), '{}') AS outcomes
    FROM leads l WHERE ${where}`, leadIds ? [leadIds] : []);
  const moq = new Map<string, number | null>();
  for (const pid of [...new Set(rows.map((r) => r.product_id).filter(Boolean))] as string[])
    moq.set(pid, await getProduct(pid).then((p) => Number((p as { min_order_qty?: number }).min_order_qty) || null, () => null));
  for (const r of rows) {
    if (r.product_id) r.moq_kg = moq.get(r.product_id) ?? null;
    if (r.status !== 'open') {
      if (r.score !== null) await c.query(`/* erp:defer */ UPDATE leads SET score = NULL, score_band = NULL, score_reasons = NULL, scored_at = now() WHERE id = $1`, [r.id]);
      continue;
    }
    const s = scoreLead(r);
    await c.query(`/* erp:defer */ UPDATE leads SET score = $2, score_band = $3, score_reasons = $4, scored_at = now() WHERE id = $1`, [r.id, s.score, s.band, JSON.stringify(s.reasons)]);
  }
  return rows.length;
}
