import type { Router } from 'express';
import { z } from 'zod';
import { type Client, type Pool, type ServiceContext, badRequest, conflict, many, notFound, notify, one, parse, reqText, requirePermission, tx } from '@erp/platform';
import { S, auditReq, getParty, nextNumber, requestApproval, round2, setting, userId } from './common.ts';

interface Account { customer_id: string; customer_name: string; mode: 'advance' | 'credit'; credit_limit: number; credit_days: number; status: 'active' | 'blocked'; block_reason: string | null }

/**
 * Exposure is what the customer owes or has committed to: accepted quotations (confirmed orders until
 * sales orders arrive in P7) plus outstanding invoices (from accounts receivable in P8; zero until then).
 */
export async function exposureOf(c: Pool | Client, customerId: string) {
  const r = await one<{ confirmed: number }>(c, `SELECT coalesce(sum(total), 0)::float AS confirmed FROM quotations WHERE customer_id = $1 AND status = 'accepted'`, [customerId]);
  const outstanding = 0;
  return { confirmed_orders: round2(r!.confirmed), outstanding_invoices: outstanding, overdue: 0, total: round2(r!.confirmed + outstanding) };
}

/** Can this customer take an order of `amount` on credit? Advance customers always can (payment first). */
export async function creditCheck(c: Pool | Client, customerId: string, amount: number, quotationId: string | null = null) {
  const acc = await one<Account>(c, 'SELECT * FROM credit_accounts WHERE customer_id = $1', [customerId]);
  const exposure = await exposureOf(c, customerId);
  const mode = acc?.mode ?? 'advance';
  const limit = acc?.mode === 'credit' ? Number(acc.credit_limit) : 0;
  const override = await one<{ id: string; override_amount: number }>(c, `
    SELECT id, override_amount FROM credit_applications WHERE kind = 'override' AND customer_id = $1 AND status = 'approved' AND valid_until >= current_date
      AND (quotation_id IS NULL OR quotation_id = $2) ORDER BY created_at DESC LIMIT 1`, [customerId, quotationId]);
  const headroom = round2(limit - exposure.total + Number(override?.override_amount ?? 0));
  const base = { mode, credit_limit: limit, credit_days: acc?.credit_days ?? 0, status: acc?.status ?? 'active', exposure, available: round2(limit - exposure.total), override_amount: override ? Number(override.override_amount) : 0 };
  if (acc?.status === 'blocked') return { ...base, ok: false, reason: `Credit is blocked for ${acc.customer_name}: ${acc.block_reason ?? 'no reason given'}`, override_id: null };
  if (mode === 'advance') return { ...base, ok: true, reason: null, note: 'Advance customer: payment before dispatch', override_id: null };
  if (amount > headroom + 0.005)
    return { ...base, ok: false, reason: `₹${amount.toLocaleString('en-IN')} exceeds available credit of ₹${Math.max(0, headroom).toLocaleString('en-IN')} (limit ₹${limit.toLocaleString('en-IN')}, exposure ₹${exposure.total.toLocaleString('en-IN')}). Request a credit override.`, override_id: null };
  return { ...base, ok: true, reason: null, override_id: amount > base.available + 0.005 ? override?.id ?? null : null };
}

export async function markOverrideUsed(c: Client, id: string) {
  await c.query(`UPDATE credit_applications SET status = 'used' WHERE id = $1`, [id]);
}

export async function applyCreditDecision(c: Client, p: { ref_id: string; decision: string; decided_by_name: string; comment: string | null }) {
  const a = await one<{ id: string; number: string; kind: string; status: string; customer_id: string; customer_name: string; requested_mode: string; requested_limit: number; requested_days: number; requested_by: string | null }>(c, 'SELECT * FROM credit_applications WHERE id = $1 FOR UPDATE', [p.ref_id]);
  if (!a || a.status !== 'pending') return;
  const ok = p.decision === 'approved';
  await c.query(`UPDATE credit_applications SET status = $2, decided_by_name = $3, decided_at = now(), comment = $4 WHERE id = $1`, [a.id, ok ? 'approved' : 'rejected', p.decided_by_name, p.comment]);
  if (ok && a.kind === 'limit')
    await c.query(`
      INSERT INTO credit_accounts (customer_id, customer_name, mode, credit_limit, credit_days, approved_by_name, approved_at) VALUES ($1,$2,$3,$4,$5,$6,now())
      ON CONFLICT (customer_id) DO UPDATE SET mode = EXCLUDED.mode, credit_limit = EXCLUDED.credit_limit, credit_days = EXCLUDED.credit_days, approved_by_name = EXCLUDED.approved_by_name, approved_at = now(), updated_at = now()`,
      [a.customer_id, a.customer_name, a.requested_mode, a.requested_mode === 'credit' ? a.requested_limit : 0, a.requested_mode === 'credit' ? a.requested_days : 0, p.decided_by_name]);
  if (a.requested_by) await notify(c, S, { user_id: a.requested_by, kind: ok ? 'success' : 'warning', title: `${a.number} ${a.kind === 'override' ? 'credit override' : 'credit limit'} for ${a.customer_name} ${ok ? 'approved' : 'rejected'}`, body: p.comment, link: `/crm/credit/${a.customer_id}` });
}

export function creditRoutes(r: Router, { pool }: ServiceContext) {
  r.get('/credit', requirePermission('crm.read'), async (_req, res) => {
    const accounts = await many<Account>(pool, 'SELECT * FROM credit_accounts ORDER BY customer_name');
    const out = [];
    for (const a of accounts) {
      const e = await exposureOf(pool, a.customer_id);
      out.push({ ...a, exposure: e.total, available: a.mode === 'credit' ? round2(Number(a.credit_limit) - e.total) : null, utilisation_pct: a.mode === 'credit' && Number(a.credit_limit) > 0 ? round2((e.total / Number(a.credit_limit)) * 100) : null });
    }
    const pending = await many(pool, `SELECT * FROM credit_applications WHERE status = 'pending' ORDER BY created_at DESC`);
    res.json({ accounts: out, pending });
  });

  r.get('/credit/:customerId', requirePermission('crm.read'), async (req, res) => {
    const id = String(req.params.customerId);
    const party = await getParty(id).catch(() => null);
    if (!party) throw notFound('Customer');
    const [account, applications, check] = await Promise.all([
      one(pool, 'SELECT * FROM credit_accounts WHERE customer_id = $1', [id]),
      many(pool, 'SELECT * FROM credit_applications WHERE customer_id = $1 ORDER BY created_at DESC', [id]),
      creditCheck(pool, id, 0),
    ]);
    const orders = await many(pool, `SELECT id, number, version, total, decided_at FROM quotations WHERE customer_id = $1 AND status = 'accepted' ORDER BY decided_at DESC`, [id]);
    res.json({ customer: { id: party.id, code: party.code, legal_name: party.legal_name, gstin: party.gstin, master_credit_limit: party.credit_limit, payment_term: party.payment_term }, account, applications, check, orders });
  });

  /** Apply for advance or credit terms. The limit takes effect only after a checker approves it. */
  r.post('/credit/applications', requirePermission('crm.credit.request'), async (req, res) => {
    const b = parse(z.object({ customer_id: z.uuid(), requested_mode: z.enum(['advance', 'credit']), requested_limit: z.number().min(0).default(0), requested_days: z.number().int().min(0).max(180).nullable().optional(), justification: reqText(1000) }), req.body);
    const party = await getParty(b.customer_id).catch(() => null);
    if (!party || party.party_type !== 'customer') throw badRequest('Choose a customer');
    if (b.requested_mode === 'credit' && b.requested_limit <= 0) throw badRequest('Enter the credit limit', { fields: { requested_limit: 'Required for credit' } });
    const days = b.requested_mode === 'credit' ? b.requested_days ?? Number(await setting('credit.default_terms_days', 30)) : 0;
    const out = await tx(pool, async (c) => {
      if (await one(c, `SELECT 1 FROM credit_applications WHERE customer_id = $1 AND kind = 'limit' AND status = 'pending'`, [party.id])) throw conflict('An application for this customer is already waiting for approval');
      const cur = await one<Account>(c, 'SELECT * FROM credit_accounts WHERE customer_id = $1', [party.id]);
      const exp = await exposureOf(c, party.id);
      const number = await nextNumber(c, 'credit_application', 'CR-');
      const a = await one<{ id: string }>(c, `
        INSERT INTO credit_applications (number, kind, customer_id, customer_name, requested_mode, requested_limit, requested_days, current_limit, current_mode, exposure_at_request, justification, requested_by, requested_by_name)
        VALUES ($1,'limit',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
        [number, party.id, party.legal_name, b.requested_mode, b.requested_mode === 'credit' ? b.requested_limit : 0, days, cur?.credit_limit ?? 0, cur?.mode ?? 'advance', exp.total, b.justification, userId(req), req.user!.name]);
      await requestApproval(c, req, {
        type: 'credit_limit', refId: a!.id, permission: 'crm.credit.approve',
        title: `${number} ${party.legal_name}: ${b.requested_mode === 'credit' ? `credit ₹${b.requested_limit.toLocaleString('en-IN')} for ${days} days` : 'advance only'}`,
        summary: `Now ${cur?.mode ?? 'advance'}${cur?.mode === 'credit' ? ` ₹${Number(cur.credit_limit).toLocaleString('en-IN')}` : ''}; exposure ₹${exp.total.toLocaleString('en-IN')}. ${b.justification}`,
        payload: { customer_id: party.id, customer: party.legal_name, requested_mode: b.requested_mode, requested_limit: b.requested_limit, requested_days: days, current_limit: cur?.credit_limit ?? 0, exposure: exp.total },
      });
      await auditReq(c, req, 'credit_application', a!.id, 'requested', { after: { number, ...b, requested_days: days }, reason: b.justification });
      return { id: a!.id, number, status: 'pending' };
    });
    res.status(201).json(out);
  });

  /** One-time headroom above the limit for a specific order, approved by a checker, valid for 7 days. */
  r.post('/credit/:customerId/override', requirePermission('crm.credit.request'), async (req, res) => {
    const b = parse(z.object({ amount: z.number().positive(), quotation_id: z.uuid().nullable().optional(), justification: reqText(1000) }), req.body);
    const party = await getParty(String(req.params.customerId)).catch(() => null);
    if (!party) throw notFound('Customer');
    const out = await tx(pool, async (c) => {
      const exp = await exposureOf(c, party.id);
      const number = await nextNumber(c, 'credit_application', 'CR-');
      const a = await one<{ id: string }>(c, `
        INSERT INTO credit_applications (number, kind, customer_id, customer_name, override_amount, quotation_id, exposure_at_request, justification, valid_until, requested_by, requested_by_name)
        VALUES ($1,'override',$2,$3,$4,$5,$6,$7,current_date + 7,$8,$9) RETURNING id`, [number, party.id, party.legal_name, b.amount, b.quotation_id ?? null, exp.total, b.justification, userId(req), req.user!.name]);
      await requestApproval(c, req, {
        type: 'credit_override', refId: a!.id, permission: 'crm.credit.approve',
        title: `${number} credit override ₹${b.amount.toLocaleString('en-IN')} · ${party.legal_name}`,
        summary: `Exposure ₹${exp.total.toLocaleString('en-IN')}. ${b.justification}`,
        payload: { customer_id: party.id, customer: party.legal_name, amount: b.amount, exposure: exp.total, quotation_id: b.quotation_id ?? null },
      });
      await auditReq(c, req, 'credit_application', a!.id, 'override_requested', { after: { number, amount: b.amount }, reason: b.justification });
      return { id: a!.id, number, status: 'pending' };
    });
    res.status(201).json(out);
  });

  r.post('/credit/:customerId/block', requirePermission('crm.credit.approve'), async (req, res) => {
    const b = parse(z.object({ blocked: z.boolean(), reason: reqText(500) }), req.body);
    const party = await getParty(String(req.params.customerId)).catch(() => null);
    if (!party) throw notFound('Customer');
    await tx(pool, async (c) => {
      const before = await one<Account>(c, 'SELECT * FROM credit_accounts WHERE customer_id = $1', [party.id]);
      await c.query(`
        INSERT INTO credit_accounts (customer_id, customer_name, status, block_reason) VALUES ($1,$2,$3,$4)
        ON CONFLICT (customer_id) DO UPDATE SET status = EXCLUDED.status, block_reason = EXCLUDED.block_reason, updated_at = now()`,
        [party.id, party.legal_name, b.blocked ? 'blocked' : 'active', b.blocked ? b.reason : null]);
      await auditReq(c, req, 'credit_account', party.id, b.blocked ? 'blocked' : 'unblocked', { before: { status: before?.status ?? 'active' }, reason: b.reason });
    });
    res.json({ ok: true });
  });

  r.get('/credit-check/:customerId', requirePermission('crm.read'), async (req, res) => {
    const amount = Number(req.query.amount ?? 0);
    res.json(await creditCheck(pool, String(req.params.customerId), Number.isFinite(amount) ? amount : 0));
  });

}
