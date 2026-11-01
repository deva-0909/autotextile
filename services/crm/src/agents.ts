import type { Request, Router } from 'express';
import { z } from 'zod';
import { type Client, type Pool, type ServiceContext, badRequest, callService, conflict, forbidden, many, notFound, one, optText, parse, publish, requirePermission, tx } from '@erp/platform';
import { S, addDays, auditReq, nextNumber, normEmail, normMobile, requestApproval, round2, stateOfCity, today } from './common.ts';
import { crmSettings } from './settings.ts';
import { captureLead, leadInput } from './leads.ts';

interface Agent { id: string; code: string; name: string; firm: string | null; mobile: string | null; email: string | null; city: string | null; state_code: string | null; pan: string | null; party_id: string | null; user_id: string | null; basis: 'pct' | 'per_kg'; rate: number; status: string }

/** A lead an agent brought in became a customer: the agent earns commission on its invoices for the set period. */
export async function linkAgentCustomer(c: Client, leadId: string, customer: { id: string; legal_name: string }) {
  const l = await one<{ agent_id: string | null }>(c, 'SELECT agent_id FROM leads WHERE id = $1', [leadId]);
  if (!l?.agent_id) return;
  const months = Number((await crmSettings(c)).agent_commission_months);
  await c.query(`INSERT INTO agent_accounts (customer_id, customer_name, agent_id, lead_id, from_date, until_date) VALUES ($1, $2, $3, $4, current_date, (current_date + make_interval(months => $5))::date)
    ON CONFLICT (customer_id) DO NOTHING`, [customer.id, customer.legal_name, l.agent_id, leadId, months]);
}

const commissionOf = (a: { basis: string; rate: number }, taxable: number, kg: number | null) => round2(a.basis === 'per_kg' ? Number(kg ?? 0) * Number(a.rate) : (Number(taxable) * Number(a.rate)) / 100);

/**
 * Brings commission in line with the books: every invoice to an agent's customer within the period accrues commission
 * (pending), which becomes earned once the invoice is fully paid.
 */
export async function syncCommissions(pool: Pool, agentId?: string) {
  const links = await many<{ customer_id: string; customer_name: string; agent_id: string; from_date: string; until_date: string; basis: string; rate: number }>(pool, `
    SELECT x.customer_id, x.customer_name, x.agent_id, x.from_date::text, x.until_date::text, a.basis, a.rate::float FROM agent_accounts x JOIN agents a ON a.id = x.agent_id
    WHERE a.status = 'active'${agentId ? ' AND a.id = $1' : ''}`, agentId ? [agentId] : []);
  if (!links.length) return { accrued: 0, earned: 0 };
  const from = links.map((l) => l.from_date).sort()[0];
  const invoices = await callService<{ party_id: string; doc_no: string; doc_date: string; taxable: number; kg: number | null; outstanding: number }[]>(S, 'finance', 'GET', `/sales-invoices?party_ids=${links.map((l) => l.customer_id).join(',')}&from=${from}`).catch(() => []);
  let accrued = 0, earned = 0;
  await tx(pool, async (c) => {
    for (const inv of invoices) {
      const link = links.find((l) => l.customer_id === inv.party_id && inv.doc_date >= l.from_date && inv.doc_date <= l.until_date);
      if (!link) continue;
      const paid = Number(inv.outstanding) <= 0.5;
      const r = await c.query(`INSERT INTO agent_commissions (agent_id, customer_id, customer_name, invoice_no, invoice_date, taxable, kg, basis, rate, amount, status, earned_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, CASE WHEN $11 = 'earned' THEN now() END) ON CONFLICT (agent_id, invoice_no) DO NOTHING`,
        [link.agent_id, link.customer_id, link.customer_name, inv.doc_no, inv.doc_date, inv.taxable, inv.kg, link.basis, link.rate, commissionOf(link, inv.taxable, inv.kg), paid ? 'earned' : 'pending']);
      if (r.rowCount) accrued++;
      else if (paid) { const u = await c.query(`UPDATE agent_commissions SET status = 'earned', earned_at = now() WHERE agent_id = $1 AND invoice_no = $2 AND status = 'pending'`, [link.agent_id, inv.doc_no]); earned += u.rowCount ?? 0; }
    }
  });
  return { accrued, earned };
}

export async function applyPayoutDecision(c: Client, p: { ref_id: string; decision: string; decided_by_name: string; comment: string | null }) {
  const po = await one<{ id: string; number: string; agent_id: string; amount: number; status: string }>(c, 'SELECT * FROM agent_payouts WHERE id = $1 FOR UPDATE', [p.ref_id]);
  if (!po || po.status !== 'pending_approval') return;
  const ok = p.decision === 'approved';
  await c.query(`UPDATE agent_payouts SET status = $2, decided_by_name = $3, decided_at = now(), comment = $4 WHERE id = $1`, [po.id, ok ? 'approved' : 'rejected', p.decided_by_name, p.comment]);
  if (!ok) { await c.query(`UPDATE agent_commissions SET status = 'earned', payout_id = NULL WHERE payout_id = $1`, [po.id]); return; }
  await c.query(`UPDATE agent_commissions SET status = 'paid' WHERE payout_id = $1`, [po.id]);
  const a = await one<Agent>(c, 'SELECT * FROM agents WHERE id = $1', [po.agent_id]);
  const n = await one<{ n: number }>(c, 'SELECT count(*)::int AS n FROM agent_commissions WHERE payout_id = $1', [po.id]);
  await publish(c, S, 'crm.commission.approved', { payout_id: po.id, number: po.number, party_id: a!.party_id, agent_name: a!.firm ?? a!.name, date: today(), amount: Number(po.amount), pan: a!.pan, invoices: n!.n });
}

const agentBody = z.object({
  name: z.string().trim().min(2).max(120), firm: optText(160), mobile: optText(20), email: optText(160), city: optText(60), state_code: optText(2),
  pan: z.preprocess((v) => (v === '' ? null : v), z.string().trim().toUpperCase().regex(/^[A-Z]{5}\d{4}[A-Z]$/, 'PAN looks wrong').nullable().optional()),
  basis: z.enum(['pct', 'per_kg']).default('pct'), rate: z.number().min(0).max(1000), status: z.enum(['active', 'inactive']).default('active'), party_id: z.uuid().nullable().optional(),
});

async function agentSummary(c: Pool | Client, id: string) {
  const [leads, customers, commissions, payouts] = await Promise.all([
    many(c, `SELECT id, number, name, company, stage, status, owner_name, est_value, created_at, agent_protected_until, customer_id, customer_name FROM leads WHERE agent_id = $1 AND status <> 'merged' ORDER BY created_at DESC LIMIT 300`, [id]),
    many(c, 'SELECT * FROM agent_accounts WHERE agent_id = $1 ORDER BY from_date DESC', [id]),
    many(c, 'SELECT c.*, p.number AS payout_number FROM agent_commissions c LEFT JOIN agent_payouts p ON p.id = c.payout_id WHERE c.agent_id = $1 ORDER BY c.invoice_date DESC', [id]),
    many(c, 'SELECT * FROM agent_payouts WHERE agent_id = $1 ORDER BY created_at DESC', [id]),
  ]);
  const sum = (st: string[]) => round2((commissions as { status: string; amount: number }[]).filter((x) => st.includes(x.status)).reduce((s, x) => s + Number(x.amount), 0));
  return { leads, customers, commissions, payouts, totals: { pending: sum(['pending']), earned: sum(['earned']), in_payout: sum(['in_payout']), paid: sum(['paid']) } };
}

async function agentOfUser(c: Pool | Client, req: Request) {
  const partyId = (req.user as { partyId?: string | null }).partyId;
  const a = partyId ? await one<Agent>(c, `SELECT * FROM agents WHERE party_id = $1 AND status = 'active'`, [partyId]) : null;
  if (!a) throw forbidden('This login is not linked to an active agent');
  return a;
}

export function agentRoutes(r: Router, { pool }: ServiceContext) {
  r.get('/agents', requirePermission('crm.read'), async (_req, res) => {
    res.json(await many(pool, `SELECT a.*,
        (SELECT count(*)::int FROM leads l WHERE l.agent_id = a.id AND l.status <> 'merged') AS leads,
        (SELECT count(*)::int FROM agent_accounts x WHERE x.agent_id = a.id) AS customers,
        (SELECT coalesce(sum(amount), 0)::float FROM agent_commissions c WHERE c.agent_id = a.id AND c.status = 'pending') AS pending,
        (SELECT coalesce(sum(amount), 0)::float FROM agent_commissions c WHERE c.agent_id = a.id AND c.status = 'earned') AS earned,
        (SELECT coalesce(sum(amount), 0)::float FROM agent_commissions c WHERE c.agent_id = a.id AND c.status = 'paid') AS paid
      FROM agents a ORDER BY a.status, a.name`));
  });
  r.get('/agents/:id', requirePermission('crm.read'), async (req, res) => {
    const a = await one<Agent>(pool, 'SELECT * FROM agents WHERE id::text = $1 OR code = $1', [req.params.id]);
    if (!a) throw notFound('Agent');
    res.json({ ...a, ...(await agentSummary(pool, a.id)) });
  });
  r.post('/agents', requirePermission('crm.config.manage'), async (req, res) => {
    const b = parse(agentBody, req.body);
    // Payouts need a payable account: the agent is also a supplier-type party in masters.
    const party = b.party_id ? { id: b.party_id } : await callService<{ id: string }>(S, 'masters', 'POST', '/parties', {
      party_type: 'supplier', legal_name: b.firm ?? b.name, gst_treatment: 'unregistered', state_code: b.state_code ?? stateOfCity(b.city) ?? '24', phone: normMobile(b.mobile), email: normEmail(b.email), pan: b.pan ?? null,
      segment: 'Commission agent', tags: ['commission_agent'], notes: 'Commission agent (dalal); paid through payables',
    });
    const out = await tx(pool, async (c) => {
      const code = await nextNumber(c, 'agent', 'AG-');
      const a = await one<{ id: string }>(c, `INSERT INTO agents (code, name, firm, mobile, email, city, state_code, pan, party_id, basis, rate, status, created_by_name) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id, code`,
        [code, b.name, b.firm ?? null, normMobile(b.mobile), normEmail(b.email), b.city ?? null, b.state_code ?? stateOfCity(b.city), b.pan ?? null, party.id, b.basis, b.rate, b.status, req.user!.name]);
      await auditReq(c, req, 'agent', a!.id, 'created', { after: { ...b, code } });
      return a;
    });
    res.status(201).json(out);
  });
  r.put('/agents/:id', requirePermission('crm.config.manage'), async (req, res) => {
    const b = parse(agentBody.omit({ party_id: true }), req.body);
    await tx(pool, async (c) => {
      const before = await one(c, 'SELECT * FROM agents WHERE id = $1 FOR UPDATE', [req.params.id]);
      if (!before) throw notFound('Agent');
      await c.query(`UPDATE agents SET name = $2, firm = $3, mobile = $4, email = $5, city = $6, state_code = $7, pan = $8, basis = $9, rate = $10, status = $11, updated_at = now() WHERE id = $1`,
        [req.params.id, b.name, b.firm ?? null, normMobile(b.mobile), normEmail(b.email), b.city ?? null, b.state_code ?? null, b.pan ?? null, b.basis, b.rate, b.status]);
      await auditReq(c, req, 'agent', String(req.params.id), 'updated', { before, after: b });
    });
    res.json({ ok: true });
  });
  r.post('/agents/:id/sync', requirePermission('crm.read'), async (req, res) => {
    res.json(await syncCommissions(pool, String(req.params.id)));
  });
  /** Earned commission goes to the owner or accounts for approval; once approved it is payable to the agent. */
  r.post('/agents/:id/payouts', requirePermission('crm.config.manage'), async (req, res) => {
    const b = parse(z.object({ commission_ids: z.array(z.uuid()).max(500).optional(), note: optText(300) }), req.body);
    await syncCommissions(pool, String(req.params.id));
    const out = await tx(pool, async (c) => {
      const a = await one<Agent>(c, 'SELECT * FROM agents WHERE id = $1', [req.params.id]);
      if (!a) throw notFound('Agent');
      const rows = await many<{ id: string; amount: number }>(c, `SELECT id, amount::float FROM agent_commissions WHERE agent_id = $1 AND status = 'earned'${b.commission_ids?.length ? ' AND id = ANY($2)' : ''} FOR UPDATE`, b.commission_ids?.length ? [a.id, b.commission_ids] : [a.id]);
      if (!rows.length) throw badRequest('No earned commission to pay: commission is earned once the customer has paid the invoice');
      const amount = round2(rows.reduce((s, x) => s + Number(x.amount), 0));
      const number = await nextNumber(c, 'agent_payout', 'COM-');
      const po = await one<{ id: string }>(c, `INSERT INTO agent_payouts (number, agent_id, amount, requested_by_name, comment) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [number, a.id, amount, req.user!.name, b.note ?? null]);
      await c.query(`UPDATE agent_commissions SET status = 'in_payout', payout_id = $2 WHERE id = ANY($1)`, [rows.map((x) => x.id), po!.id]);
      await requestApproval(c, req, { type: 'agent_commission', refId: po!.id, title: `Agent commission ${number}: ${a.firm ?? a.name} ₹${amount.toLocaleString('en-IN')}`, summary: `${rows.length} paid invoices${b.note ? ` · ${b.note}` : ''}`, permission: 'crm.commission.approve', payload: { agent: a.name, amount, invoices: rows.length } });
      await auditReq(c, req, 'agent_payout', po!.id, 'requested', { after: { number, amount, invoices: rows.length } });
      return { id: po!.id, number, amount, invoices: rows.length };
    });
    res.status(201).json(out);
  });

  // ---------- the agent's own portal ----------
  r.get('/portal/agent', requirePermission('portal.agent.access'), async (req, res) => {
    const a = await agentOfUser(pool, req);
    await syncCommissions(pool, a.id).catch(() => null);
    const s = await agentSummary(pool, a.id);
    const settings = await crmSettings(pool);
    // Agents see their buyers' progress, never the salesperson's notes.
    res.json({ agent: { code: a.code, name: a.name, firm: a.firm, basis: a.basis, rate: a.rate }, protection_days: settings.agent_protection_days, commission_months: settings.agent_commission_months,
      leads: (s.leads as Record<string, unknown>[]).map((l) => ({ id: l.id, number: l.number, name: l.name, company: l.company, stage: l.stage, status: l.status, created_at: l.created_at, protected_until: l.agent_protected_until, customer: l.customer_name, owner_name: l.owner_name })),
      customers: s.customers, commissions: (s.commissions as Record<string, unknown>[]).map((x) => ({ id: x.id, customer_name: x.customer_name, invoice_no: x.invoice_no, invoice_date: x.invoice_date, taxable: x.taxable, kg: x.kg, amount: x.amount, status: x.status, payout_number: x.payout_number })), payouts: s.payouts, totals: s.totals });
  });
  r.post('/portal/agent/leads', requirePermission('portal.agent.access'), async (req, res) => {
    const a = await agentOfUser(pool, req);
    const b = parse(leadInput.pick({ name: true, company: true, mobile: true, email: true, gstin: true, city: true, state_code: true, category: true, product_label: true, requirement_kg: true, est_value: true, message: true }), req.body);
    const days = Number((await crmSettings(pool)).agent_protection_days);
    const out = await tx(pool, async (c) => {
      const o = await captureLead(c, { ...b, source_code: 'AGENT' }, { id: null, name: `${a.name} (agent ${a.code})`, canAssign: false, selfAssign: false, agent: { id: a.id, name: a.firm ?? a.name, protectDays: days } });
      if (o.duplicates?.some((d) => d.type === 'customer')) throw conflict('This buyer is already our customer');
      await auditReq(c, req, 'lead', o.id, 'registered_by_agent', { after: { agent: a.code, number: o.number } });
      return { id: o.id, number: o.number, protected_until: addDays(today(), days) };
    });
    res.status(201).json(out);
  });
}

