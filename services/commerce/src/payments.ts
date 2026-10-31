import type { Router } from 'express';
import express from 'express';
import { z } from 'zod';
import { AppError, type Client, type Pool, type ServiceContext, badRequest, config, conflict, many, notFound, one, optText, parse, publish, reqText, requirePermission, tx } from '@erp/platform';
import { S, auditReq, getParty, localNumber, raiseException, round2, setting, walletBalance, walletEntry } from './common.ts';
import { gateway, newToken, sign, signatureOk } from './gateway.ts';

export async function createPaymentLink(c: Client, p: { customer_id: string; customer_name: string; order_id: string | null; purpose: 'token' | 'invoice' | 'advance'; ref_no: string | null; amount: number; by: string; expiresInMinutes?: number }) {
  const hours = Number(await setting('commerce.payment_link_hours', 24));
  const mins = p.expiresInMinutes ?? hours * 60;
  const number = await localNumber(c, 'payment', 'PAY-');
  const gw = gateway();
  const gatewayOrderId = `${number}-${newToken().slice(0, 8)}`.toUpperCase();
  const link = newToken();
  const expires = new Date(Date.now() + mins * 60_000);
  const pay = await one<{ id: string }>(c, `
    INSERT INTO payments (number, customer_id, customer_name, order_id, purpose, ref_no, amount, gateway, gateway_order_id, link_token, link_expires_at, created_by_name)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
    [number, p.customer_id, p.customer_name, p.order_id, p.purpose, p.ref_no, round2(p.amount), gw.name, gatewayOrderId, link, expires, p.by]);
  await gw.createOrder(c, { gatewayOrderId, amount: round2(p.amount), reference: p.ref_no ?? number, expiresAt: expires });
  await c.query(`INSERT INTO payment_events (payment_id, kind, detail) VALUES ($1, 'created', $2)`, [pay!.id, JSON.stringify({ amount: p.amount, purpose: p.purpose, expires })]);
  return { id: pay!.id, number, amount: round2(p.amount), link_token: link, url: `/pay/${link}`, expires_at: expires.toISOString() };
}

interface Payment { id: string; number: string; customer_id: string; customer_name: string; order_id: string | null; purpose: 'token' | 'invoice' | 'advance'; ref_no: string | null; amount: number; status: string; gateway_order_id: string; gateway_txn_id: string | null; link_expires_at: string; refunded_amount: number }

/**
 * Gateway callback. The body must carry a valid HMAC signature; then the payment is confirmed only if the
 * gateway's own status API agrees on status and amount. Re-delivered callbacks are harmless (idempotent).
 */
export async function handleCallback(pool: Pool, raw: string, signature: string | undefined) {
  const okSig = signatureOk(raw, signature);
  let body: { gateway_order_id?: string; txn_id?: string; status?: string; amount?: number; utr?: string } = {};
  try { body = JSON.parse(raw); } catch { /* recorded below */ }
  if (!okSig) {
    // Recorded in its own transaction so the rejection is kept even though the request fails.
    await tx(pool, async (c) => {
      const pay = body.gateway_order_id ? await one<Payment>(c, 'SELECT * FROM payments WHERE gateway_order_id = $1', [body.gateway_order_id]) : null;
      await c.query(`INSERT INTO payment_events (payment_id, kind, signature_ok, detail) VALUES ($1, 'rejected', false, $2)`, [pay?.id ?? null, JSON.stringify(body)]);
      if (pay) await raiseException(c, { kind: 'payment_signature_invalid', severity: 'critical', ref_type: 'payment', ref_id: pay.id, ref_label: pay.number, message: `Rejected a payment callback for ${pay.number} with an invalid signature`, notifyPermission: 'commerce.payment.manage', link: '/commerce/payments' });
    });
    throw new AppError(401, 'bad_signature', 'Invalid signature');
  }
  return tx(pool, async (c) => {
    const pay = body.gateway_order_id ? await one<Payment>(c, 'SELECT * FROM payments WHERE gateway_order_id = $1 FOR UPDATE', [body.gateway_order_id]) : null;
    await c.query(`INSERT INTO payment_events (payment_id, kind, signature_ok, detail) VALUES ($1, 'webhook', true, $2)`, [pay?.id ?? null, JSON.stringify(body)]);
    if (!pay) throw notFound('Payment');
    if (pay.status !== 'created') return { status: pay.status, duplicate: true };
    const v = await gateway().verify(c, pay.gateway_order_id);
    await c.query(`INSERT INTO payment_events (payment_id, kind, detail) VALUES ($1, 'verified', $2)`, [pay.id, JSON.stringify(v)]);
    if (v.status === 'success' && Math.abs(v.amount - Number(pay.amount)) < 0.005 && (!body.txn_id || body.txn_id === v.txn_id)) {
      await c.query(`UPDATE payments SET status = 'success', gateway_txn_id = $2, utr = $3, verified_at = now(), updated_at = now() WHERE id = $1`, [pay.id, v.txn_id, v.utr]);
      await onPaid(c, pay, v.utr);
      return { status: 'success' };
    }
    if (v.status === 'failed') {
      await c.query(`UPDATE payments SET status = 'failed', failure_reason = $2, updated_at = now() WHERE id = $1`, [pay.id, 'Declined by bank']);
      return { status: 'failed' };
    }
    // Callback says one thing, the bank's status API another: leave it pending and flag it.
    await raiseException(c, { kind: 'payment_unverified', severity: 'warning', ref_type: 'payment', ref_id: pay.id, ref_label: pay.number, message: `${pay.number}: callback status "${body.status}" not confirmed by the gateway (${v.status}, ₹${v.amount})`, notifyPermission: 'commerce.payment.manage', link: '/commerce/payments' });
    return { status: 'created', unverified: true };
  });
}

/** Money received goes to the customer's advance; a token payment also books its order. */
async function onPaid(c: Client, pay: Payment, utr: string | null) {
  const type = pay.purpose === 'token' ? 'token_received' : pay.purpose === 'invoice' ? 'invoice_payment_received' : 'advance_received';
  await walletEntry(c, { customer_id: pay.customer_id, customer_name: pay.customer_name, entry_type: type, amount: Number(pay.amount), order_id: pay.order_id, ref_type: 'payment', ref_no: pay.number, narration: `${pay.purpose === 'token' ? 'Booking token' : pay.purpose === 'invoice' ? `Payment for ${pay.ref_no}` : 'Advance'} · UTR ${utr ?? '—'}`, by_name: 'gateway' });
  if (pay.purpose === 'token' && pay.order_id) {
    const o = await one<{ status: string }>(c, 'SELECT status FROM orders WHERE id = $1 FOR UPDATE', [pay.order_id]);
    if (o?.status === 'pending_payment') {
      const { bookOrder } = await import('./orders.ts');
      await bookOrder(c, pay.order_id, Number(await setting('commerce.token_validity_days', 7)), 'gateway');
    }
  }
  await publish(c, S, 'commerce.payment.received', { payment_id: pay.id, number: pay.number, utr, customer_name: pay.customer_name, customer_id: pay.customer_id, order_id: pay.order_id, purpose: pay.purpose, ref_no: pay.ref_no, amount: Number(pay.amount) });
}

export function publicPaymentRoutes(r: Router, { pool }: ServiceContext) {
  /** The payment page behind a link: what is being paid, by whom, and whether the link is still valid. */
  r.get('/public/pay/:token', async (req, res) => {
    const p = await one<Payment & { link_expires_at: string; utr: string | null }>(pool, 'SELECT * FROM payments WHERE link_token = $1', [req.params.token]);
    if (!p) throw notFound('Payment link');
    const order = p.order_id ? await one<{ number: string }>(pool, 'SELECT number FROM orders WHERE id = $1', [p.order_id]) : null;
    res.json({ number: p.number, customer_name: p.customer_name, purpose: p.purpose, ref_no: p.ref_no, order_no: order?.number ?? null, order_id: p.order_id, amount: Number(p.amount), status: p.status, utr: p.utr,
      expired: p.status === 'created' && new Date(p.link_expires_at) < new Date(), expires_at: p.link_expires_at, gateway: config.paymentGateway() });
  });

  /** Sandbox only: plays the bank. Records the outcome on the bank side, then sends us a signed callback. */
  r.post('/public/pay/:token/simulate', async (req, res) => {
    if (config.paymentGateway() !== 'sandbox') throw new AppError(404, 'not_found', 'Not available');
    const { outcome } = parse(z.object({ outcome: z.enum(['success', 'failure']) }), req.body);
    const p = await one<Payment>(pool, 'SELECT * FROM payments WHERE link_token = $1', [req.params.token]);
    if (!p) throw notFound('Payment link');
    if (p.status !== 'created') throw conflict(`This payment is already ${p.status}`);
    if (new Date(p.link_expires_at) < new Date()) throw conflict('This payment link has expired');
    const txn = `TXN${Date.now()}${Math.floor(Math.random() * 1000)}`;
    const utr = `UTR${String(Date.now()).slice(-10)}`;
    await pool.query(`UPDATE gateway_sandbox SET status = $2, txn_id = $3, utr = $4, paid_at = now() WHERE gateway_order_id = $1`, [p.gateway_order_id, outcome === 'success' ? 'success' : 'failed', txn, outcome === 'success' ? utr : null]);
    const raw = JSON.stringify({ gateway_order_id: p.gateway_order_id, txn_id: txn, status: outcome === 'success' ? 'SUCCESS' : 'FAILURE', amount: Number(p.amount), utr: outcome === 'success' ? utr : null });
    res.json(await handleCallback(pool, raw, sign(raw)));
  });

  /** Where the real gateway posts its callback. The signature is checked against the raw bytes. */
  r.post('/public/payments/webhook', express.text({ type: () => true, limit: '64kb' }), async (req, res) => {
    const raw = (req as typeof req & { rawBody?: string }).rawBody ?? (typeof req.body === 'string' ? req.body : JSON.stringify(req.body));
    res.json(await handleCallback(pool, raw, (req.headers['x-signature'] as string | undefined) ?? undefined));
  });
}

export function paymentRoutes(r: Router, { pool }: ServiceContext) {
  r.get('/payments', requirePermission('commerce.read'), async (req, res) => {
    const params: unknown[] = [];
    const where: string[] = [];
    if (req.query.status) { params.push(String(req.query.status).split(',')); where.push(`p.status = ANY($${params.length})`); }
    if (req.query.customer) { params.push(req.query.customer); where.push(`p.customer_id = $${params.length}`); }
    res.json(await many(pool, `SELECT p.*, o.number AS order_no FROM payments p LEFT JOIN orders o ON o.id = p.order_id ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY p.created_at DESC LIMIT 300`, params));
  });

  r.get('/payments/:id', requirePermission('commerce.read'), async (req, res) => {
    const p = await one(pool, 'SELECT * FROM payments WHERE id = $1', [req.params.id]);
    if (!p) throw notFound('Payment');
    res.json({ ...p, events: await many(pool, 'SELECT * FROM payment_events WHERE payment_id = $1 ORDER BY id', [req.params.id]), refunds: await many(pool, 'SELECT * FROM refunds WHERE payment_id = $1 ORDER BY created_at', [req.params.id]) });
  });

  /** A link for an advance or a specific amount, sent to the customer by the accounts team. */
  r.post('/payments/links', requirePermission('commerce.payment.manage'), async (req, res) => {
    const b = parse(z.object({ customer_id: z.uuid(), amount: z.number().positive(), purpose: z.enum(['advance', 'invoice']).default('advance'), ref_no: optText(40), order_id: z.uuid().nullable().optional() }), req.body);
    const cust = await getParty(b.customer_id);
    const out = await tx(pool, async (c) => {
      const l = await createPaymentLink(c, { customer_id: cust.id, customer_name: cust.legal_name, order_id: b.order_id ?? null, purpose: b.purpose, ref_no: b.ref_no ?? null, amount: b.amount, by: req.user!.name });
      await auditReq(c, req, 'payment', l.id, 'link_created', { after: { amount: b.amount, purpose: b.purpose } });
      return l;
    });
    res.status(201).json(out);
  });

  /** Refund money still held as customer advance, back to the original payment. */
  r.post('/payments/:id/refund', requirePermission('commerce.payment.manage'), async (req, res) => {
    const b = parse(z.object({ amount: z.number().positive(), reason: reqText(300) }), req.body);
    const out = await tx(pool, async (c) => {
      const p = await one<Payment>(c, 'SELECT * FROM payments WHERE id = $1 FOR UPDATE', [req.params.id]);
      if (!p) throw notFound('Payment');
      if (!['success', 'partially_refunded'].includes(p.status)) throw conflict('Only successful payments can be refunded');
      const left = round2(Number(p.amount) - Number(p.refunded_amount));
      if (b.amount > left + 0.005) throw badRequest(`At most ₹${left.toLocaleString('en-IN')} can still be refunded on this payment`);
      const bal = await walletBalance(c, p.customer_id);
      if (b.amount > bal + 0.005) throw conflict(`Only ₹${round2(bal).toLocaleString('en-IN')} of the customer’s money is unapplied; the rest is already set against invoices`);
      const r1 = await gateway().refund(c, { gatewayOrderId: p.gateway_order_id, txnId: p.gateway_txn_id!, amount: b.amount });
      await c.query(`INSERT INTO refunds (payment_id, amount, reason, status, gateway_refund_id, created_by_name) VALUES ($1,$2,$3,$4,$5,$6)`, [p.id, b.amount, b.reason, r1.ok ? 'success' : 'failed', r1.refundId, req.user!.name]);
      if (!r1.ok) throw conflict('The gateway declined the refund');
      const refunded = round2(Number(p.refunded_amount) + b.amount);
      await c.query(`UPDATE payments SET refunded_amount = $2, status = $3, updated_at = now() WHERE id = $1`, [p.id, refunded, refunded >= Number(p.amount) - 0.005 ? 'refunded' : 'partially_refunded']);
      await walletEntry(c, { customer_id: p.customer_id, customer_name: p.customer_name, entry_type: 'refund', amount: -b.amount, order_id: p.order_id, ref_type: 'refund', ref_no: r1.refundId, narration: `Refund of ${p.number}: ${b.reason}`, by_name: req.user!.name });
      await c.query(`INSERT INTO payment_events (payment_id, kind, detail) VALUES ($1, 'refund', $2)`, [p.id, JSON.stringify({ amount: b.amount, refund_id: r1.refundId })]);
      await publish(c, S, 'commerce.payment.refunded', { payment_id: p.id, number: p.number, customer_id: p.customer_id, customer_name: p.customer_name, amount: b.amount, refund_id: r1.refundId, reason: b.reason });
      await auditReq(c, req, 'payment', p.id, 'refunded', { after: { amount: b.amount, refund_id: r1.refundId }, reason: b.reason });
      return { refund_id: r1.refundId, refunded_amount: refunded };
    });
    res.json(out);
  });

  /** Payments against the gateway's records and the advance ledger: anything that does not tie up. */
  r.get('/payments-reconciliation', requirePermission('commerce.read'), async (_req, res) => {
    const rows = await many<Payment & { utr: string | null; created_at: string; wallet_credit: number | null }>(pool, `
      SELECT p.*, (SELECT sum(amount)::float FROM wallet_ledger w WHERE w.ref_type = 'payment' AND w.ref_no = p.number) AS wallet_credit
      FROM payments p WHERE p.created_at > now() - interval '90 days' ORDER BY p.created_at DESC`);
    const issues: { payment: string; issue: string; amount: number }[] = [];
    let received = 0, refunded = 0;
    await tx(pool, async (c) => {
      for (const p of rows) {
        const g = await gateway().verify(c, p.gateway_order_id).catch(() => null);
        const paid = ['success', 'partially_refunded', 'refunded'].includes(p.status);
        if (paid) { received += Number(p.amount); refunded += Number(p.refunded_amount); }
        if (paid && Math.abs(Number(p.wallet_credit ?? 0) - Number(p.amount)) > 0.005) issues.push({ payment: p.number, issue: 'Paid but not credited to the customer advance', amount: Number(p.amount) });
        if (g && paid && g.status !== 'success') issues.push({ payment: p.number, issue: `Marked paid here, gateway says ${g.status}`, amount: Number(p.amount) });
        if (g && !paid && g.status === 'success') issues.push({ payment: p.number, issue: 'Gateway shows success but we have not confirmed it', amount: Number(p.amount) });
      }
    });
    const ev = await one<{ bad: number }>(pool, `SELECT count(*)::int AS bad FROM payment_events WHERE kind = 'rejected' AND at > now() - interval '90 days'`);
    res.json({ payments: rows.length, received: round2(received), refunded: round2(refunded), net: round2(received - refunded), rejected_callbacks: ev!.bad, issues });
  });
}
