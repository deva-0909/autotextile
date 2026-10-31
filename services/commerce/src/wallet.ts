import type { Router } from 'express';
import { z } from 'zod';
import { type ServiceContext, badRequest, many, one, optText, parse, reqText, requirePermission, tx } from '@erp/platform';
import { getParty, portalCustomer, round2, walletBalance, walletEntry } from './common.ts';

/**
 * Customer advance (wallet). Receipts credit it; invoices consume it at dispatch. The balance is money owed to
 * the customer (a liability), kept apart from revenue. GST on advances follows the CA-approved treatment.
 */
export function walletRoutes(r: Router, { pool }: ServiceContext) {
  r.get('/wallet', requirePermission('commerce.read'), async (_req, res) => {
    res.json(await many(pool, `
      SELECT customer_id, max(customer_name) AS customer_name, round(sum(amount), 2)::float AS balance,
        round(sum(amount) FILTER (WHERE amount > 0), 2)::float AS received, round(-sum(amount) FILTER (WHERE entry_type = 'applied_to_invoice'), 2)::float AS applied,
        round(-sum(amount) FILTER (WHERE entry_type = 'refund'), 2)::float AS refunded, max(at) AS last_entry
      FROM wallet_ledger GROUP BY customer_id ORDER BY balance DESC`));
  });

  r.get('/wallet/:customerId', requirePermission('commerce.read'), async (req, res) => {
    const id = String(req.params.customerId);
    res.json({ balance: await walletBalance(pool, id), entries: await many(pool, `SELECT w.*, sum(w.amount) OVER (ORDER BY w.id)::float AS running FROM wallet_ledger w WHERE customer_id = $1 ORDER BY id DESC`, [id]) });
  });

  r.get('/portal/wallet', requirePermission('portal.customer.accounts', 'portal.customer.order'), async (req, res) => {
    const id = portalCustomer(req);
    res.json({ balance: await walletBalance(pool, id), entries: await many(pool, `SELECT w.id, w.entry_type, w.amount, w.ref_no, w.narration, w.at, sum(w.amount) OVER (ORDER BY w.id)::float AS running FROM wallet_ledger w WHERE customer_id = $1 ORDER BY id DESC`, [id]) });
  });

  /** Fulfilment applies advance to an invoice before dispatch. Idempotent per invoice: never applies more than its total. */
  r.post('/wallet/apply', requirePermission('fulfilment.invoice', 'commerce.payment.manage'), async (req, res) => {
    const b = parse(z.object({ customer_id: z.uuid(), order_id: z.uuid().nullable().optional(), invoice_no: reqText(40), amount: z.number().positive() }), req.body);
    const out = await tx(pool, async (c) => {
      await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`wallet:${b.customer_id}`]);
      const already = Number((await one<{ a: number }>(c, `SELECT coalesce(-sum(amount), 0)::float AS a FROM wallet_ledger WHERE customer_id = $1 AND entry_type = 'applied_to_invoice' AND ref_no = $2`, [b.customer_id, b.invoice_no]))!.a);
      const bal = await walletBalance(c, b.customer_id);
      const take = round2(Math.max(0, Math.min(bal, b.amount - already)));
      if (take > 0) {
        const p = await getParty(b.customer_id);
        await walletEntry(c, { customer_id: b.customer_id, customer_name: p.legal_name, entry_type: 'applied_to_invoice', amount: -take, order_id: b.order_id ?? null, ref_type: 'invoice', ref_no: b.invoice_no, narration: `Applied to invoice ${b.invoice_no}`, by_name: req.user!.name });
      }
      const applied = round2(already + take);
      return { applied_now: take, applied_total: applied, balance_due: round2(Math.max(0, b.amount - applied)), wallet_balance: round2(bal - take) };
    });
    res.json(out);
  });

  /** Credit notes (returns) and other credits to the customer’s advance. */
  r.post('/wallet/credit', requirePermission('fulfilment.returns.manage', 'commerce.payment.manage'), async (req, res) => {
    const b = parse(z.object({ customer_id: z.uuid(), amount: z.number().positive(), entry_type: z.enum(['credit_note', 'reversal']).default('credit_note'), ref_no: reqText(40), order_id: z.uuid().nullable().optional(), narration: optText(300) }), req.body);
    const p = await getParty(b.customer_id);
    await tx(pool, async (c) => {
      if (await one(c, 'SELECT 1 FROM wallet_ledger WHERE customer_id = $1 AND entry_type = $2 AND ref_no = $3', [b.customer_id, b.entry_type, b.ref_no])) throw badRequest(`${b.ref_no} is already credited`);
      await walletEntry(c, { customer_id: p.id, customer_name: p.legal_name, entry_type: b.entry_type, amount: b.amount, order_id: b.order_id ?? null, ref_type: b.entry_type, ref_no: b.ref_no, narration: b.narration ?? null, by_name: req.user!.name });
    });
    res.status(201).json({ ok: true, balance: await walletBalance(pool, b.customer_id) });
  });
}
