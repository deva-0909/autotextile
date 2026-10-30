import type { Request, Router } from 'express';
import { z } from 'zod';
import { type Client, type Pool, type ServiceContext, badRequest, callService, conflict, many, notFound, notify, one, optText, parse, publish, requirePermission, tx } from '@erp/platform';
import { S, addDays, assertOwnerOrAll, auditReq, getLot, getParty, getProduct, leadOrThrow, lotsOf, nextNumber, requestApproval, round2, round3, seesAll, setting, today, userId } from './common.ts';
import { creditCheck, markOverrideUsed } from './credit.ts';

const lineInput = z.object({ product_id: z.uuid(), lot_id: z.uuid().nullable().optional(), kg: z.number().positive().max(1_000_000), requested_price: z.number().positive().max(100000), approval_reason: optText(300) });
const quoteInput = z.object({
  lead_id: z.uuid().nullable().optional(),
  customer_id: z.uuid().nullable().optional(),
  valid_until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  warehouse_id: z.uuid().nullable().optional(),
  freight_amount: z.number().min(0).default(0),
  payment_terms: optText(200), delivery_terms: optText(200), notes: optText(2000),
  competitor_name: optText(120), competitor_price: z.number().positive().nullable().optional(),
  revision_reason: optText(500),
  lines: z.array(lineInput).min(1, 'Add at least one fabric').max(40),
});
type QuoteInput = z.infer<typeof quoteInput>;

/**
 * Prices each line against the list price (the lot's tagged selling price) and cost. A line needs approval
 * when its discount exceeds the salesperson's authority or its margin is below the company minimum.
 */
async function priceLines(lines: z.infer<typeof lineInput>[], ownerId: string | null, c: Client | Pool) {
  const minMargin = Number(await setting('sales.min_margin_percent', 8));
  const member = ownerId ? await one<{ max_discount_pct: number | null }>(c, 'SELECT max_discount_pct FROM sales_team WHERE user_id = $1', [ownerId]) : null;
  const maxDisc = member?.max_discount_pct != null ? Number(member.max_discount_pct) : Number(await setting('sales.max_discount_without_approval', 3));
  const out = [];
  const warnings: string[] = [];
  for (const [i, l] of lines.entries()) {
    const p = await getProduct(l.product_id).catch(() => null);
    if (!p || p.status !== 'active') throw badRequest(`Line ${i + 1}: choose an active fabric`);
    let list: number | null = null, cost: number | null = null, lotNo: string | null = null;
    if (l.lot_id) {
      const lot = await getLot(l.lot_id).catch(() => null);
      if (!lot || lot.product_id !== p.id) throw badRequest(`Line ${i + 1}: that lot is not ${p.sku}`);
      list = lot.price_per_kg === null ? null : Number(lot.price_per_kg);
      cost = lot.cost_per_kg === null ? null : Number(lot.cost_per_kg);
      lotNo = lot.lot_no;
      if (lot.summary.available_kg < l.kg - 0.001) warnings.push(`${lot.lot_no}: only ${lot.summary.available_kg} kg available for ${l.kg} kg quoted`);
    } else {
      const lots = await lotsOf(p.id);
      const priced = lots.filter((x) => x.price_per_kg !== null).sort((a, b) => b.available_kg - a.available_kg);
      list = priced[0] ? Number(priced[0].price_per_kg) : null;
      const costed = lots.filter((x) => x.cost_per_kg !== null && x.kg > 0);
      const kg = costed.reduce((s, x) => s + Number(x.kg), 0);
      cost = kg ? round2(costed.reduce((s, x) => s + Number(x.kg) * Number(x.cost_per_kg), 0) / kg) : null;
      const avail = lots.reduce((s, x) => s + Number(x.available_kg), 0);
      if (avail < l.kg - 0.001) warnings.push(`${p.sku}: ${round3(avail)} kg in stock for ${l.kg} kg quoted`);
    }
    const discount = list ? round2(((list - l.requested_price) / list) * 100) : null;
    const margin = cost ? round2(((l.requested_price - cost) / l.requested_price) * 100) : null;
    const reasons = [];
    if (discount !== null && discount > maxDisc) reasons.push(`discount ${discount}% above ${maxDisc}% authority`);
    if (margin !== null && margin < minMargin) reasons.push(`margin ${margin}% below ${minMargin}% minimum`);
    out.push({
      line_no: i + 1, product_id: p.id, sku: p.sku, product_name: p.name, category: p.category_name, lot_id: l.lot_id ?? null, lot_no: lotNo, kg: l.kg,
      list_price: list, requested_price: l.requested_price, discount_pct: discount, cost_per_kg: cost, margin_pct: margin, gst_rate: Number(p.gst_rate ?? 5),
      taxable: round2(l.kg * l.requested_price), needs_approval: reasons.length > 0, approval_reason: reasons.length ? `${reasons.join('; ')}${l.approval_reason ? ` — ${l.approval_reason}` : ''}` : null, why: l.approval_reason,
    });
  }
  return { lines: out, warnings, minMargin, maxDisc };
}

function totals(lines: { kg: number; taxable: number; gst_rate: number; cost_per_kg: number | null }[], freight: number) {
  const taxable = round2(lines.reduce((s, l) => s + l.taxable, 0) + freight);
  // Freight follows the principal supply, so it is taxed at the highest line rate.
  const topRate = Math.max(...lines.map((l) => l.gst_rate));
  const tax = round2(lines.reduce((s, l) => s + (l.taxable * l.gst_rate) / 100, 0) + (freight * topRate) / 100);
  const costed = lines.filter((l) => l.cost_per_kg !== null);
  const rev = costed.reduce((s, l) => s + l.taxable, 0);
  const margin = rev ? round2(((rev - costed.reduce((s, l) => s + l.kg * Number(l.cost_per_kg), 0)) / rev) * 100) : null;
  return { kg: round3(lines.reduce((s, l) => s + l.kg, 0)), taxable, tax, total: round2(taxable + tax), margin_pct: margin };
}

async function writeQuote(c: Client, req: Request, b: QuoteInput, prior: { root_id: string; number: string; version: number } | null) {
  let lead = null;
  if (b.lead_id) { lead = await leadOrThrow(c, b.lead_id); assertOwnerOrAll(req, lead.owner_id); }
  const customerId = b.customer_id ?? lead?.customer_id ?? null;
  let customerName: string | null = null;
  if (customerId) {
    const p = await getParty(customerId).catch(() => null);
    if (!p || p.party_type !== 'customer') throw badRequest('Choose a customer', { fields: { customer_id: 'Unknown customer' } });
    customerName = p.legal_name;
  }
  if (!lead && !customerId) throw badRequest('Quote against a lead or a customer');
  const ownerId = lead?.owner_id ?? userId(req);
  const ownerName = lead?.owner_name ?? req.user!.name;
  const priced = await priceLines(b.lines, ownerId, c);
  const t = totals(priced.lines, b.freight_amount);
  const validity = Number(await setting('crm.quotation_validity_days', 7));
  const number = prior?.number ?? (await nextNumber(c, 'quotation', 'QT-'));
  let wh: string | null = null;
  if (b.warehouse_id) {
    const w = (await callService<{ id: string; code: string; name: string }[]>(S, 'organisation', 'GET', '/warehouses')).find((x) => x.id === b.warehouse_id);
    if (!w) throw badRequest('Unknown warehouse');
    wh = `${w.code} · ${w.name}`;
  }
  const q = await one<{ id: string }>(c, `
    INSERT INTO quotations (number, version, root_id, lead_id, customer_id, customer_name, prospect_name, owner_id, owner_name, valid_until, warehouse_id, warehouse_name, freight_amount,
      payment_terms, delivery_terms, notes, competitor_name, competitor_price, revision_reason, kg, taxable, tax, total, margin_pct, needs_approval, created_by, created_by_name)
    VALUES ($1,$2,coalesce($3, gen_random_uuid()),$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27) RETURNING id`,
    [number, (prior?.version ?? 0) + 1, prior?.root_id ?? null, lead?.id ?? null, customerId, customerName, customerName ? null : lead?.company ?? lead?.name ?? null, ownerId, ownerName,
      b.valid_until ?? addDays(today(), validity), b.warehouse_id ?? null, wh, b.freight_amount, b.payment_terms ?? null, b.delivery_terms ?? null, b.notes ?? null,
      b.competitor_name ?? null, b.competitor_price ?? null, b.revision_reason ?? null, t.kg, t.taxable, t.tax, t.total, t.margin_pct, priced.lines.some((l) => l.needs_approval), userId(req), req.user!.name]);
  if (!prior) await c.query('UPDATE quotations SET root_id = id WHERE id = $1 AND root_id IS DISTINCT FROM id AND version = 1', [q!.id]);
  for (const l of priced.lines)
    await c.query(`INSERT INTO quotation_lines (quotation_id, line_no, product_id, sku, product_name, category, lot_id, lot_no, kg, list_price, requested_price, discount_pct, cost_per_kg, margin_pct, gst_rate, taxable, needs_approval, approval_reason)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
      [q!.id, l.line_no, l.product_id, l.sku, l.product_name, l.category, l.lot_id, l.lot_no, l.kg, l.list_price, l.requested_price, l.discount_pct, l.cost_per_kg, l.margin_pct, l.gst_rate, l.taxable, l.needs_approval, l.approval_reason]);
  return { id: q!.id, number, version: (prior?.version ?? 0) + 1, ...t, needs_approval: priced.lines.some((l) => l.needs_approval), warnings: priced.warnings, lines: priced.lines };
}

export async function quotationDetail(c: Pool | Client, req: Request, id: string) {
  const q = await one<Record<string, unknown> & { id: string; root_id: string; owner_id: string | null; customer_id: string | null; lead_id: string | null }>(c, 'SELECT * FROM quotations WHERE id = $1', [id]);
  if (!q) throw notFound('Quotation');
  assertOwnerOrAll(req, q.owner_id, 'Quotation');
  const [lines, versions] = await Promise.all([
    many(c, 'SELECT * FROM quotation_lines WHERE quotation_id = $1 ORDER BY line_no', [q.id]),
    many(c, `SELECT q.id, q.version, q.status, q.kg, q.taxable, q.total, q.margin_pct, q.revision_reason, q.competitor_name, q.competitor_price, q.created_by_name, q.created_at, q.approved_by_name,
      (SELECT json_agg(json_build_object('sku', l.sku, 'kg', l.kg, 'list_price', l.list_price, 'requested_price', l.requested_price, 'discount_pct', l.discount_pct, 'margin_pct', l.margin_pct) ORDER BY l.line_no) FROM quotation_lines l WHERE l.quotation_id = q.id) AS lines
      FROM quotations q WHERE q.root_id = $1 ORDER BY q.version`, [q.root_id]),
  ]);
  const lead = q.lead_id ? await one(c, 'SELECT id, number, name, company, stage, owner_name FROM leads WHERE id = $1', [q.lead_id]) : null;
  const credit = q.customer_id ? await creditCheck(c, q.customer_id, 0).catch(() => null) : null;
  return { ...q, lines, versions, lead, credit };
}

export async function applyQuoteDecision(c: Client, p: { ref_id: string; decision: string; decided_by_name: string; comment: string | null }) {
  const q = await one<{ id: string; status: string; owner_id: string | null; number: string; version: number }>(c, 'SELECT * FROM quotations WHERE id = $1 FOR UPDATE', [p.ref_id]);
  if (!q || q.status !== 'pending_approval') return;
  const ok = p.decision === 'approved';
  await c.query(`UPDATE quotations SET status = $2, approved_by_name = $3, approved_at = now(), approval_note = $4, updated_at = now() WHERE id = $1`, [q.id, ok ? 'approved' : 'rejected_internal', p.decided_by_name, p.comment]);
  if (q.owner_id) await notify(c, S, { user_id: q.owner_id, kind: ok ? 'success' : 'warning', title: `${q.number} v${q.version} price ${ok ? 'approved' : 'rejected'} by ${p.decided_by_name}`, body: p.comment, link: `/crm/quotations/${q.id}` });
}

const STAGE_ORDER = ['new', 'assigned', 'contact_pending', 'contacted', 'qualified', 'quotation', 'negotiation', 'order_confirmed', 'won'];
async function advanceLead(c: Client, leadId: string | null, stage: string, summary: string, by: string) {
  if (!leadId) return;
  const l = await one<{ stage: string; status: string }>(c, 'SELECT stage, status FROM leads WHERE id = $1 FOR UPDATE', [leadId]);
  if (!l || l.status !== 'open') return;
  if (STAGE_ORDER.indexOf(stage) > STAGE_ORDER.indexOf(l.stage))
    await c.query(`UPDATE leads SET stage = $2, next_action_at = greatest(coalesce(next_action_at, now()), now() + interval '2 days'), first_response_at = coalesce(first_response_at, now()), updated_at = now() WHERE id = $1`, [leadId, stage]);
  await c.query(`INSERT INTO lead_activities (lead_id, kind, summary, by_name) VALUES ($1, 'quotation', $2, $3)`, [leadId, summary, by]);
}

export function quotationRoutes(r: Router, { pool }: ServiceContext) {
  r.get('/quotations', requirePermission('crm.read'), async (req, res) => {
    const params: unknown[] = [];
    const where = [`q.status <> 'superseded'`];
    if (!seesAll(req)) { params.push(req.user!.id); where.push(`q.owner_id = $${params.length}`); }
    if (req.query.status) { params.push(String(req.query.status).split(',')); where.push(`q.status = ANY($${params.length})`); }
    if (req.query.customer) { params.push(req.query.customer); where.push(`q.customer_id = $${params.length}`); }
    if (req.query.lead) { params.push(req.query.lead); where.push(`q.lead_id = $${params.length}`); }
    if (req.query.q) { params.push(`%${req.query.q}%`); where.push(`(q.number ILIKE $${params.length} OR q.customer_name ILIKE $${params.length} OR q.prospect_name ILIKE $${params.length})`); }
    res.json(await many(pool, `
      SELECT q.*, (SELECT string_agg(sku, ', ' ORDER BY line_no) FROM quotation_lines WHERE quotation_id = q.id) AS skus,
        (SELECT count(*)::int FROM quotation_lines WHERE quotation_id = q.id AND needs_approval) AS lines_needing_approval
      FROM quotations q WHERE ${where.join(' AND ')} ORDER BY q.updated_at DESC LIMIT 300`, params));
  });

  r.get('/quotations/:id', requirePermission('crm.read'), async (req, res) => {
    res.json(await quotationDetail(pool, req, String(req.params.id)));
  });

  /** Live pricing for the builder: list price, cost, discount, margin and whether approval will be needed. */
  r.post('/quotations/price', requirePermission('crm.quote.manage'), async (req, res) => {
    const b = parse(z.object({ owner_id: z.uuid().nullable().optional(), freight_amount: z.number().min(0).default(0), lines: z.array(lineInput).min(1).max(40) }), req.body);
    const p = await priceLines(b.lines, b.owner_id ?? userId(req), pool);
    res.json({ ...p, totals: totals(p.lines, b.freight_amount) });
  });

  r.post('/quotations', requirePermission('crm.quote.manage'), async (req, res) => {
    const b = parse(quoteInput, req.body);
    const out = await tx(pool, async (c) => {
      const q = await writeQuote(c, req, b, null);
      await auditReq(c, req, 'quotation', q.id, 'created', { after: { number: q.number, total: q.total, margin_pct: q.margin_pct } });
      return q;
    });
    res.status(201).json(out);
  });

  /** Edit a draft in place. */
  r.put('/quotations/:id', requirePermission('crm.quote.manage'), async (req, res) => {
    const b = parse(quoteInput, req.body);
    const out = await tx(pool, async (c) => {
      const q = await one<{ id: string; status: string; owner_id: string | null; root_id: string; number: string; version: number }>(c, 'SELECT * FROM quotations WHERE id = $1 FOR UPDATE', [req.params.id]);
      if (!q) throw notFound('Quotation');
      assertOwnerOrAll(req, q.owner_id, 'Quotation');
      if (!['draft', 'rejected_internal'].includes(q.status)) throw conflict('Only drafts can be edited; revise the quotation instead');
      await c.query('DELETE FROM quotations WHERE id = $1', [q.id]);
      return writeQuote(c, req, b, { root_id: q.root_id, number: q.number, version: q.version - 1 });
    });
    res.json(out);
  });

  /** A new version for negotiation; earlier versions stay for the history. */
  r.post('/quotations/:id/revise', requirePermission('crm.quote.manage'), async (req, res) => {
    const b = parse(quoteInput, req.body);
    if (!b.revision_reason) throw badRequest('Say what changed in this revision', { fields: { revision_reason: 'Required' } });
    const out = await tx(pool, async (c) => {
      const q = await one<{ id: string; status: string; owner_id: string | null; root_id: string; number: string; version: number; lead_id: string | null; customer_id: string | null }>(c, 'SELECT * FROM quotations WHERE id = $1 FOR UPDATE', [req.params.id]);
      if (!q) throw notFound('Quotation');
      assertOwnerOrAll(req, q.owner_id, 'Quotation');
      if (!['pending_approval', 'approved', 'sent', 'rejected_internal', 'expired', 'rejected'].includes(q.status)) throw conflict(`A ${q.status.replace('_', ' ')} quotation can’t be revised`);
      const latest = await one<{ version: number }>(c, 'SELECT max(version) AS version FROM quotations WHERE root_id = $1', [q.root_id]);
      if (latest!.version !== q.version) throw conflict('Revise the latest version');
      await c.query(`UPDATE quotations SET status = 'superseded', updated_at = now() WHERE id = $1`, [q.id]);
      const nq = await writeQuote(c, req, { ...b, lead_id: b.lead_id ?? q.lead_id, customer_id: b.customer_id ?? q.customer_id }, { root_id: q.root_id, number: q.number, version: q.version });
      await advanceLead(c, q.lead_id, 'negotiation', `${q.number} revised to v${nq.version}: ${b.revision_reason}`, req.user!.name);
      await auditReq(c, req, 'quotation', nq.id, 'revised', { after: { number: q.number, version: nq.version, total: nq.total }, reason: b.revision_reason });
      return nq;
    });
    res.status(201).json(out);
  });

  /** Submit for pricing approval when needed; otherwise the quotation is approved at once. */
  r.post('/quotations/:id/submit', requirePermission('crm.quote.manage'), async (req, res) => {
    const out = await tx(pool, async (c) => {
      const q = await one<{ id: string; status: string; owner_id: string | null; number: string; version: number; needs_approval: boolean; customer_name: string | null; prospect_name: string | null; total: number; margin_pct: number | null }>(c, 'SELECT * FROM quotations WHERE id = $1 FOR UPDATE', [req.params.id]);
      if (!q) throw notFound('Quotation');
      assertOwnerOrAll(req, q.owner_id, 'Quotation');
      if (!['draft', 'rejected_internal'].includes(q.status)) throw conflict(`This quotation is ${q.status.replace('_', ' ')}`);
      if (q.needs_approval) {
        const lines = await many<{ sku: string; kg: number; list_price: number | null; requested_price: number; discount_pct: number | null; cost_per_kg: number | null; margin_pct: number | null; approval_reason: string | null }>(c, 'SELECT * FROM quotation_lines WHERE quotation_id = $1 AND needs_approval ORDER BY line_no', [q.id]);
        if (lines.some((l) => !l.approval_reason?.includes('—'))) throw badRequest('Explain each below-margin or over-discount line for the approver', { fields: { approval_reason: 'Required on lines that need approval' } });
        await c.query(`UPDATE quotations SET status = 'pending_approval', updated_at = now() WHERE id = $1`, [q.id]);
        await requestApproval(c, req, {
          type: 'quotation_price', refId: q.id, permission: 'crm.price.approve',
          title: `Price approval ${q.number} v${q.version} · ${q.customer_name ?? q.prospect_name}`,
          summary: lines.map((l) => `${l.sku} ${l.kg} kg at ₹${l.requested_price} (list ${l.list_price ?? '—'}, cost ${l.cost_per_kg ?? '—'}): ${l.approval_reason}`).join(' | '),
          payload: { number: q.number, version: q.version, total: Number(q.total), margin_pct: q.margin_pct, lines },
        });
        return { status: 'pending_approval' };
      }
      await c.query(`UPDATE quotations SET status = 'approved', approved_by_name = 'within authority', approved_at = now(), updated_at = now() WHERE id = $1`, [q.id]);
      return { status: 'approved' };
    });
    res.json(out);
  });

  r.post('/quotations/:id/send', requirePermission('crm.quote.manage'), async (req, res) => {
    const out = await tx(pool, async (c) => {
      const q = await one<{ id: string; status: string; owner_id: string | null; number: string; version: number; lead_id: string | null; total: number; valid_until: string }>(c, 'SELECT * FROM quotations WHERE id = $1 FOR UPDATE', [req.params.id]);
      if (!q) throw notFound('Quotation');
      assertOwnerOrAll(req, q.owner_id, 'Quotation');
      if (q.status !== 'approved') throw conflict(q.status === 'pending_approval' ? 'Waiting for price approval' : `A ${q.status.replace('_', ' ')} quotation can’t be sent`);
      if (String(q.valid_until).slice(0, 10) < today()) throw conflict('Validity has passed; revise the quotation');
      await c.query(`UPDATE quotations SET status = 'sent', sent_at = now(), updated_at = now() WHERE id = $1`, [q.id]);
      await advanceLead(c, q.lead_id, 'quotation', `${q.number} v${q.version} sent: ₹${Number(q.total).toLocaleString('en-IN')}`, req.user!.name);
      await auditReq(c, req, 'quotation', q.id, 'sent');
      return { status: 'sent' };
    });
    res.json(out);
  });

  /**
   * Customer's answer. Acceptance needs a customer account and passes the credit check (advance customers
   * always pass; credit customers need headroom or an approved override). Lots on the quote are reserved.
   */
  r.post('/quotations/:id/outcome', requirePermission('crm.quote.manage'), async (req, res) => {
    const b = parse(z.object({ outcome: z.enum(['accepted', 'rejected', 'lost']), lost_reason: optText(300), competitor_name: optText(120), competitor_price: z.number().positive().nullable().optional(), reserve: z.boolean().default(true) }), req.body);
    const q0 = await one<{ customer_id: string | null; total: number }>(pool, 'SELECT customer_id, total FROM quotations WHERE id = $1', [req.params.id]);
    if (!q0) throw notFound('Quotation');
    const out = await tx(pool, async (c) => {
      const q = await one<{ id: string; status: string; owner_id: string | null; number: string; version: number; lead_id: string | null; customer_id: string | null; customer_name: string | null; total: number; warehouse_id: string | null }>(c, 'SELECT * FROM quotations WHERE id = $1 FOR UPDATE', [req.params.id]);
      assertOwnerOrAll(req, q!.owner_id, 'Quotation');
      if (q!.status !== 'sent') throw conflict('Record the customer’s answer on a sent quotation');
      if (b.outcome !== 'accepted') {
        if (!b.lost_reason) throw badRequest('Give the reason', { fields: { lost_reason: 'Required' } });
        await c.query(`UPDATE quotations SET status = $2, lost_reason = $3, competitor_name = coalesce($4, competitor_name), competitor_price = coalesce($5, competitor_price), decided_at = now(), updated_at = now() WHERE id = $1`,
          [q!.id, b.outcome, b.lost_reason, b.competitor_name ?? null, b.competitor_price ?? null]);
        if (q!.lead_id) await c.query(`INSERT INTO lead_activities (lead_id, kind, summary, outcome, by_name) VALUES ($1, 'quotation', $2, $3, $4)`, [q!.lead_id, `${q!.number} v${q!.version} ${b.outcome} by customer`, b.lost_reason, req.user!.name]);
        await auditReq(c, req, 'quotation', q!.id, b.outcome, { reason: b.lost_reason, after: { competitor: b.competitor_name, competitor_price: b.competitor_price } });
        return { status: b.outcome };
      }
      if (!q!.customer_id) throw conflict('Convert the lead to a customer before accepting the order');
      const credit = await creditCheck(c, q!.customer_id, Number(q!.total), q!.id);
      if (!credit.ok) throw conflict(credit.reason!);
      let reservation: { id: string; number: string } | null = null;
      const warnings: string[] = [];
      const lotLines = await many<{ lot_id: string; kg: number }>(c, 'SELECT lot_id, kg FROM quotation_lines WHERE quotation_id = $1 AND lot_id IS NOT NULL', [q!.id]);
      if (b.reserve && lotLines.length && q!.warehouse_id) {
        try {
          reservation = await callService<{ id: string; number: string }>(S, 'inventory', 'POST', '/reservations', { warehouse_id: q!.warehouse_id, ref_type: 'quotation', ref_id: q!.id, ref_no: `${q!.number} v${q!.version}`, customer_id: q!.customer_id, lines: lotLines.map((l) => ({ lot_id: l.lot_id, kg: Number(l.kg) })) });
        } catch (e) { warnings.push(`Stock not reserved: ${(e as Error).message}`); }
      }
      await c.query(`UPDATE quotations SET status = 'accepted', decided_at = now(), reservation_id = $2, reservation_no = $3, updated_at = now() WHERE id = $1`, [q!.id, reservation?.id ?? null, reservation?.number ?? null]);
      if (credit.override_id) await markOverrideUsed(c, credit.override_id);
      await advanceLead(c, q!.lead_id, 'order_confirmed', `${q!.number} v${q!.version} accepted${reservation ? `, stock reserved (${reservation.number})` : ''}`, req.user!.name);
      // Sales orders (P7) are created from this event.
      await publish(c, S, 'crm.quotation.accepted', { quotation_id: q!.id, number: q!.number, version: q!.version, customer_id: q!.customer_id, total: Number(q!.total), reservation_id: reservation?.id ?? null });
      await auditReq(c, req, 'quotation', q!.id, 'accepted', { after: { total: q!.total, credit: credit.mode, reservation: reservation?.number } });
      return { status: 'accepted', credit, reservation, warnings };
    });
    res.json(out);
  });
}
