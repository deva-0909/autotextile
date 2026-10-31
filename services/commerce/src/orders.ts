import type { Request, Router } from 'express';
import { z } from 'zod';
import {
  type BusEvent, type Client, type Pool, type ServiceContext, badRequest, callService, conflict, forbidden, hasPermission, many, notFound, notify, one, optText, parse, publish, reqText, requirePermission, tx,
} from '@erp/platform';
import {
  S, assertCustomerAccess, auditReq, clearLotCache, getLot, getParty, getProduct, getWarehouses, listProducts, nextNumber, portalCustomer, requestApproval, round2, round3, sellableLots, setting, userId, walletBalance, walletEntry,
} from './common.ts';
import { resolveToken } from './policies.ts';
import { createPaymentLink } from './payments.ts';

interface LineIn { product_id: string; lot_id: string | null; kg: number; price_per_kg?: number | null }
interface Order { id: string; number: string; customer_id: string; customer_name: string; status: string; payment_terms: string; token_amount: number; token_due_at: string | null; reservation_expires_at: string | null; total_estimate: number; taxable: number; channel: string; placed_by: string | null; token_refundable: boolean; token_cancellation_fee_pct: number; token_paid_at: string | null }

// ---------- catalogue ----------
export async function catalogue(q: string, category: string | null) {
  const [products, lots, showPrice] = await Promise.all([listProducts(), sellableLots(), setting('commerce.show_prices_in_catalogue', true)]);
  const moqDefault = Number(await setting('commerce.min_order_kg', 50));
  const term = q.trim().toLowerCase();
  return products
    .filter((p) => p.status === 'active' && (!category || p.category_name === category) && (!term || `${p.sku} ${p.name} ${p.category_name} ${JSON.stringify(p.attributes)}`.toLowerCase().includes(term)))
    .map((p) => {
      const ls = lots.filter((l) => l.product_id === p.id);
      const prices = ls.map((l) => Number(l.price_per_kg));
      return {
        id: p.id, sku: p.sku, name: p.name, category: p.category_name, attributes: p.attributes, moq_kg: Number(p.min_order_qty ?? moqDefault),
        available_kg: round3(ls.reduce((s, l) => s + Number(l.available_kg), 0)), lots: ls.length, shades: [...new Set(ls.map((l) => l.dye_lot ?? l.shade_code).filter(Boolean))].length,
        price_from: showPrice && prices.length ? Math.min(...prices) : null, price_to: showPrice && prices.length ? Math.max(...prices) : null,
        status: ls.length ? 'in_stock' : 'out_of_stock',
      };
    })
    .sort((a, b) => Number(b.available_kg > 0) - Number(a.available_kg > 0) || a.sku.localeCompare(b.sku));
}

async function productDetail(id: string) {
  const [p, lots, wh, showPrice] = await Promise.all([getProduct(id), sellableLots(), getWarehouses(), setting('commerce.show_prices_in_catalogue', true)]);
  const moq = Number(p.min_order_qty ?? (await setting('commerce.min_order_kg', 50)));
  return {
    id: p.id, sku: p.sku, name: p.name, category: p.category_name, description: p.description, attributes: p.attributes, hsn_code: p.hsn_code, gst_rate: Number(p.gst_rate), moq_kg: moq,
    lots: lots.filter((l) => l.product_id === id).map((l) => ({
      id: l.id, lot_no: l.lot_no, grade: l.grade, dye_lot: l.dye_lot, shade_code: l.shade_code, available_kg: Number(l.available_kg), price_per_kg: showPrice ? Number(l.price_per_kg) : null, received_date: l.received_date,
      locations: (l.warehouses ?? []).map((w) => wh.find((x) => x.id === w)?.city).filter(Boolean),
    })),
  };
}

// ---------- order creation (portal checkout, internal entry and accepted quotations) ----------
async function priceLines(lines: LineIn[]) {
  const moqDefault = Number(await setting('commerce.min_order_kg', 50));
  const out = [];
  for (const [i, l] of lines.entries()) {
    const p = await getProduct(l.product_id).catch(() => null);
    if (!p || p.status !== 'active') throw badRequest(`Line ${i + 1}: fabric not available`);
    let price = l.price_per_kg ?? null, lotNo: string | null = null;
    if (l.lot_id) {
      const lot = await getLot(l.lot_id).catch(() => null);
      if (!lot || lot.product_id !== p.id) throw badRequest(`Line ${i + 1}: that lot is not ${p.sku}`);
      lotNo = lot.lot_no;
      price ??= lot.price_per_kg === null ? null : Number(lot.price_per_kg);
      if (lot.summary.available_kg < l.kg - 0.001 && !l.price_per_kg) throw conflict(`${p.sku}: only ${lot.summary.available_kg} kg of lot ${lot.lot_no} is available`);
    }
    if (!price && !l.lot_id) {
      // No lot named: the fabric's list price is the highest tagged price among lots on sale.
      const prices = (await sellableLots()).filter((x) => x.product_id === p.id).map((x) => Number(x.price_per_kg));
      const avail = (await sellableLots()).filter((x) => x.product_id === p.id).reduce((s, x) => s + Number(x.available_kg), 0);
      if (prices.length) price = Math.max(...prices);
      if (avail < l.kg - 0.001) throw conflict(`${p.sku}: only ${round3(avail)} kg is available across warehouses`);
    }
    if (!price) throw badRequest(`Line ${i + 1}: ${p.sku} has no selling price yet`);
    const moq = Number(p.min_order_qty ?? moqDefault);
    if (l.kg < moq - 0.001 && l.price_per_kg == null) throw badRequest(`${p.sku}: minimum order is ${moq} kg`);
    out.push({ line_no: i + 1, product: p, lot_id: l.lot_id, lot_no: lotNo, kg: round3(l.kg), price: Number(price), taxable: round2(l.kg * Number(price)) });
  }
  return out;
}

export async function createOrder(c: Client, req: Request, o: { customer_id: string; lines: LineIn[]; channel: 'portal' | 'crm_quotation' | 'internal'; source_id?: string | null; source_ref?: string | null; ship_to?: string | null; notes?: string | null; existing_reservation?: { reservation_id: string; warehouse_id: string } | null; skip_company_approval?: boolean; opening?: boolean }) {
  const cust = await getParty(o.customer_id);
  if (cust.party_type !== 'customer' || cust.status !== 'active') throw badRequest('Customer is not active');
  const lines = await priceLines(o.lines);
  const taxable = round2(lines.reduce((s, l) => s + l.taxable, 0));
  const tax = round2(lines.reduce((s, l) => s + (l.taxable * Number(l.product.gst_rate)) / 100, 0));
  const credit = await callService<{ ok: boolean; mode: string; status: string; reason: string | null }>(S, 'crm', 'GET', `/credit-check/${o.customer_id}?amount=${taxable + tax}`).catch(() => ({ ok: true, mode: 'advance', status: 'active', reason: null }));
  if (credit.status === 'blocked') throw conflict(credit.reason ?? 'Credit is blocked for this customer');
  const terms: 'credit' | 'advance' = credit.mode === 'credit' && credit.ok ? 'credit' : 'advance';
  // A legacy order's advance is already in the opening balances, so no new token is asked for.
  const token = terms === 'credit' || o.opening ? null : await resolveToken(c, o.customer_id, lines.map((l) => ({ product_id: l.product.id, category_id: l.product.category_id, taxable: l.taxable })));
  // Company-side approval: buyers above the company's limit need their own approver first.
  const cs = await one<{ order_approval_limit: number | null }>(c, 'SELECT order_approval_limit FROM customer_settings WHERE customer_id = $1', [o.customer_id]);
  const needsCompany = o.channel === 'portal' && !o.skip_company_approval && cs?.order_approval_limit != null && taxable + tax > Number(cs.order_approval_limit) && !hasPermission(req.user, 'portal.customer.approve');
  const number = await nextNumber(c, 'sales_order', 'SO-');
  const ord = await one<{ id: string }>(c, `
    INSERT INTO orders (number, customer_id, customer_name, customer_gstin, customer_state_code, channel, source_ref, source_id, placed_by, placed_by_name, status, payment_terms, kg, taxable, tax_estimate, total_estimate,
      token_amount, token_policy_text, token_refundable, token_cancellation_fee_pct, ship_to, notes)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22) RETURNING id`,
    [number, cust.id, cust.legal_name, cust.gstin, cust.state_code, o.channel, o.source_ref ?? null, o.source_id ?? null, userId(req), req.user!.name, needsCompany ? 'pending_company_approval' : 'awaiting_allocation', terms,
      round3(lines.reduce((s, l) => s + l.kg, 0)), taxable, tax, round2(taxable + tax), token?.amount ?? 0, terms === 'credit' ? `Approved credit (${credit.mode})` : token?.text ?? 'Legacy order: advance carried in the opening balances', token?.refundable ?? true, token?.cancellation_fee_pct ?? 0, o.ship_to ?? null, o.notes ?? null]);
  for (const l of lines)
    await c.query(`INSERT INTO order_lines (order_id, line_no, product_id, sku, product_name, category, hsn_code, gst_rate, lot_id, lot_no, kg, price_per_kg, taxable) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [ord!.id, l.line_no, l.product.id, l.product.sku, l.product.name, l.product.category_name, l.product.hsn_code, l.product.gst_rate, l.lot_id, l.lot_no, l.kg, l.price, l.taxable]);
  // Events (and the audit record) are written after the synchronous call to fulfilment: publishing takes the
  // bus lock until commit, and the services we call publish too.
  const audit = () => auditReq(c, req, 'sales_order', ord!.id, 'placed', { after: { number, customer: cust.legal_name, taxable, terms, token: token?.amount ?? 0, channel: o.channel } });
  if (needsCompany) {
    await audit();
    const { portalUsersOf } = await import('./accounts.ts');
    for (const u of await portalUsersOf(o.customer_id, 'portal.customer.approve'))
      await notify(c, S, { user_id: u, kind: 'action', title: `Order ${number} needs your approval`, body: `${req.user!.name} · ₹${(taxable + tax).toLocaleString('en-IN')}`, link: `/portal/orders/${ord!.id}` });
    return { id: ord!.id, number, status: 'pending_company_approval' };
  }
  const out = await allocate(c, req, ord!.id, o.existing_reservation ?? null, token?.validity_days ?? 7);
  await audit();
  return out;
}

/** Ask fulfilment to recommend a warehouse and reserve the stock; then the order waits for its token or is booked. */
export async function allocate(c: Client, req: Request, orderId: string, existing: { reservation_id: string; warehouse_id: string } | null, validityDays = 7) {
  const o = await one<Order & { customer_state_code: string | null }>(c, 'SELECT * FROM orders WHERE id = $1 FOR UPDATE', [orderId]);
  const lines = await many<{ id: string; product_id: string; sku: string; product_name: string; lot_id: string | null; kg: number; price_per_kg: number; gst_rate: number; hsn_code: string | null }>(c, 'SELECT * FROM order_lines WHERE order_id = $1 ORDER BY line_no', [orderId]);
  const windowMin = Number(await setting('commerce.payment_window_minutes', 60));
  const holdUntil = new Date(Date.now() + (o!.payment_terms === 'credit' || !Number(o!.token_amount) ? validityDays * 86_400_000 : windowMin * 60_000)).toISOString();
  const plan = await callService<{ status: 'reserved' | 'needs_decision'; fulfilments: unknown[]; message?: string }>(S, 'fulfilment', 'POST', '/plans', {
    order_id: o!.id, order_no: o!.number, customer_id: o!.customer_id, customer_name: o!.customer_name, customer_state_code: o!.customer_state_code, hold_until: holdUntil, existing_reservation: existing,
    lines: lines.map((l) => ({ order_line_id: l.id, product_id: l.product_id, sku: l.sku, product_name: l.product_name, lot_id: l.lot_id, kg: Number(l.kg), price_per_kg: Number(l.price_per_kg), gst_rate: Number(l.gst_rate), hsn_code: l.hsn_code })),
  });
  clearLotCache();
  if (plan.status === 'needs_decision') {
    await c.query(`UPDATE orders SET status = 'awaiting_allocation', updated_at = now() WHERE id = $1`, [orderId]);
    return { id: o!.id, number: o!.number, status: 'awaiting_allocation', message: plan.message ?? 'Our team is choosing the warehouse for this order; you will be asked to pay once stock is reserved.' };
  }
  return afterReserved(c, o!, validityDays, req.user!.name);
}

async function afterReserved(c: Client, o: Order, validityDays: number, by: string) {
  if (o.payment_terms === 'credit' || Number(o.token_amount) <= 0) {
    await bookOrder(c, o.id, validityDays, by);
    return { id: o.id, number: o.number, status: 'booked' };
  }
  const windowMin = Number(await setting('commerce.payment_window_minutes', 60));
  await c.query(`UPDATE orders SET status = 'pending_payment', token_due_at = now() + make_interval(mins => $2), updated_at = now() WHERE id = $1`, [o.id, windowMin]);
  const pay = await createPaymentLink(c, { customer_id: o.customer_id, customer_name: o.customer_name, order_id: o.id, purpose: 'token', ref_no: o.number, amount: Number(o.token_amount), by, expiresInMinutes: windowMin });
  return { id: o.id, number: o.number, status: 'pending_payment', token_amount: Number(o.token_amount), payment: pay };
}

/** Booked: the token is paid (or terms are credit). Stock stays reserved for the token validity. */
export async function bookOrder(c: Client, orderId: string, validityDays: number, by: string) {
  const o = await one<Order>(c, `UPDATE orders SET status = 'booked', token_paid_at = CASE WHEN token_amount > 0 THEN now() END, reservation_expires_at = now() + make_interval(days => $2), updated_at = now() WHERE id = $1 RETURNING *`, [orderId, validityDays]);
  await publish(c, S, 'commerce.order.booked', { order_id: orderId, number: o!.number, customer_id: o!.customer_id, reserve_until: o!.reservation_expires_at, payment_terms: o!.payment_terms, by });
  await notify(c, S, { audience_permission: 'fulfilment.pick', kind: 'action', title: `Order ${o!.number} booked — ready to pick`, body: o!.customer_name, link: `/fulfilment/orders/${orderId}` });
}

export async function orderDetail(c: Pool | Client, id: string) {
  const o = await one<Order & Record<string, unknown>>(c, 'SELECT * FROM orders WHERE id::text = $1 OR number = $1', [id]);
  if (!o) throw notFound('Order');
  const [lines, payments, wallet, extensions] = await Promise.all([
    many(c, 'SELECT * FROM order_lines WHERE order_id = $1 ORDER BY line_no', [o.id]),
    many(c, `SELECT id, number, purpose, ref_no, amount, status, utr, gateway, link_token, link_expires_at, verified_at, refunded_amount, created_at FROM payments WHERE order_id = $1 ORDER BY created_at`, [o.id]),
    many(c, 'SELECT * FROM wallet_ledger WHERE order_id = $1 ORDER BY id', [o.id]),
    many(c, 'SELECT * FROM reservation_extensions WHERE order_id = $1 ORDER BY created_at DESC', [o.id]),
  ]);
  const fulfilment = await callService<unknown>(S, 'fulfilment', 'GET', `/orders/${o.id}/summary`).catch(() => null);
  return { ...o, lines, payments, wallet, extensions, fulfilment, wallet_balance: await walletBalance(c, o.customer_id) };
}

export async function cancelOrder(c: Client, req: Request, id: string, reason: string) {
  const o = await one<Order>(c, 'SELECT * FROM orders WHERE id = $1 FOR UPDATE', [id]);
  if (!o) throw notFound('Order');
  if (!['pending_company_approval', 'awaiting_allocation', 'pending_payment', 'booked'].includes(o.status)) throw conflict('Orders already being picked or dispatched can’t be cancelled here; raise a return instead');
  if (o.status !== 'pending_company_approval') await callService(S, 'fulfilment', 'POST', `/plans/${o.id}/cancel`, { reason }).catch((e) => { if ((e as { status?: number }).status !== 404) throw e; });
  await c.query(`UPDATE orders SET status = 'cancelled', cancelled_reason = $2, cancelled_by_name = $3, cancelled_at = now(), updated_at = now() WHERE id = $1`, [o.id, reason, req.user!.name]);
  // A paid token stays as customer advance; a cancellation fee per the token policy is kept.
  let fee = 0;
  if (o.token_paid_at && Number(o.token_amount) > 0) {
    fee = o.token_refundable ? round2((Number(o.token_amount) * Number(o.token_cancellation_fee_pct)) / 100) : Number(o.token_amount);
    if (fee > 0) await walletEntry(c, { customer_id: o.customer_id, customer_name: o.customer_name, entry_type: 'cancellation_fee', amount: -fee, order_id: o.id, ref_type: 'order', ref_no: o.number, narration: o.token_refundable ? `Cancellation fee ${o.token_cancellation_fee_pct}% of token` : 'Non-refundable token forfeited', by_name: req.user!.name });
  }
  await publish(c, S, 'commerce.order.cancelled', { order_id: o.id, number: o.number, reason, customer_id: o.customer_id, customer_name: o.customer_name, cancellation_fee: fee });
  await auditReq(c, req, 'sales_order', o.id, 'cancelled', { reason, before: { status: o.status } });
}

const lineSchema = z.object({ product_id: z.uuid(), lot_id: z.uuid(), kg: z.number().positive().max(1_000_000) });
const internalLine = z.object({ product_id: z.uuid(), lot_id: z.uuid().nullable().optional(), kg: z.number().positive().max(1_000_000) });

export function orderRoutes(r: Router, { pool }: ServiceContext) {
  // ----- catalogue (customers and staff) -----
  r.get('/catalogue', requirePermission('portal.customer.order', 'commerce.read'), async (req, res) => {
    res.json(await catalogue(String(req.query.q ?? ''), (req.query.category as string) || null));
  });
  r.get('/catalogue/:id', requirePermission('portal.customer.order', 'commerce.read'), async (req, res) => {
    res.json(await productDetail(String(req.params.id)));
  });

  // ----- cart -----
  r.get('/portal/cart', requirePermission('portal.customer.order'), async (req, res) => {
    const cust = portalCustomer(req);
    const lines = await many<{ id: string; product_id: string; lot_id: string; kg: number }>(pool, 'SELECT * FROM cart_lines WHERE user_id = $1 ORDER BY added_at', [req.user!.id]);
    const out = [];
    for (const l of lines) {
      const [p, lot] = await Promise.all([getProduct(l.product_id), getLot(l.lot_id).catch(() => null)]);
      const moq = Number(p.min_order_qty ?? (await setting('commerce.min_order_kg', 50)));
      const problems = [];
      if (!lot || !lot.price_per_kg) problems.push('No longer available');
      else if (lot.summary.available_kg < Number(l.kg)) problems.push(`Only ${lot.summary.available_kg} kg available`);
      if (Number(l.kg) < moq) problems.push(`Minimum order ${moq} kg`);
      const price = lot?.price_per_kg ? Number(lot.price_per_kg) : 0;
      out.push({ id: l.id, product_id: p.id, sku: p.sku, product_name: p.name, gst_rate: Number(p.gst_rate), lot_id: l.lot_id, lot_no: lot?.lot_no, dye_lot: lot?.dye_lot, grade: lot?.grade, kg: Number(l.kg), price_per_kg: price, taxable: round2(Number(l.kg) * price), available_kg: lot?.summary.available_kg ?? 0, moq_kg: moq, problems, category_id: p.category_id });
    }
    const taxable = round2(out.reduce((s, l) => s + l.taxable, 0));
    const tax = round2(out.reduce((s, l) => s + (l.taxable * l.gst_rate) / 100, 0));
    const credit = await callService<{ ok: boolean; mode: string; status: string; available: number }>(S, 'crm', 'GET', `/credit-check/${cust}?amount=${taxable + tax}`).catch(() => null);
    const token = out.length ? await resolveToken(pool, cust, out.map((l) => ({ product_id: l.product_id, category_id: l.category_id, taxable: l.taxable }))) : null;
    const onCredit = credit?.mode === 'credit' && credit.ok;
    const cs = await one<{ order_approval_limit: number | null }>(pool, 'SELECT order_approval_limit FROM customer_settings WHERE customer_id = $1', [cust]);
    res.json({ lines: out, taxable, tax_estimate: tax, total_estimate: round2(taxable + tax), terms: onCredit ? 'credit' : 'advance', credit, token: onCredit ? null : token,
      needs_company_approval: cs?.order_approval_limit != null && taxable + tax > Number(cs.order_approval_limit) && !hasPermission(req.user, 'portal.customer.approve'), approval_limit: cs?.order_approval_limit ?? null });
  });

  r.put('/portal/cart', requirePermission('portal.customer.order'), async (req, res) => {
    const cust = portalCustomer(req);
    const { lines } = parse(z.object({ lines: z.array(lineSchema).max(40) }), req.body);
    await tx(pool, async (c) => {
      await c.query('DELETE FROM cart_lines WHERE user_id = $1', [req.user!.id]);
      for (const l of lines) await c.query('INSERT INTO cart_lines (user_id, customer_id, product_id, lot_id, kg) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (user_id, lot_id) DO UPDATE SET kg = EXCLUDED.kg', [req.user!.id, cust, l.product_id, l.lot_id, l.kg]);
    });
    res.json({ ok: true });
  });

  r.post('/portal/cart/add', requirePermission('portal.customer.order'), async (req, res) => {
    const cust = portalCustomer(req);
    const l = parse(lineSchema, req.body);
    await pool.query('INSERT INTO cart_lines (user_id, customer_id, product_id, lot_id, kg) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (user_id, lot_id) DO UPDATE SET kg = cart_lines.kg + EXCLUDED.kg', [req.user!.id, cust, l.product_id, l.lot_id, l.kg]);
    res.status(201).json({ ok: true });
  });

  /** Place the order: validates stock and terms, reserves stock, and returns the token payment link if one is due. */
  r.post('/portal/cart/checkout', requirePermission('portal.customer.order'), async (req, res) => {
    const cust = portalCustomer(req);
    const b = parse(z.object({ ship_to: optText(500), notes: optText(1000) }), req.body);
    const out = await tx(pool, async (c) => {
      const lines = await many<{ product_id: string; lot_id: string; kg: number }>(c, 'SELECT * FROM cart_lines WHERE user_id = $1 ORDER BY added_at FOR UPDATE', [req.user!.id]);
      if (!lines.length) throw badRequest('Your cart is empty');
      const o = await createOrder(c, req, { customer_id: cust, channel: 'portal', ship_to: b.ship_to, notes: b.notes, lines: lines.map((l) => ({ product_id: l.product_id, lot_id: l.lot_id, kg: Number(l.kg) })) });
      await c.query('DELETE FROM cart_lines WHERE user_id = $1', [req.user!.id]);
      return o;
    });
    res.status(201).json(out);
  });

  /** Repeat an earlier order: its lines go back in the cart at today’s availability and prices. */
  r.post('/portal/orders/:id/repeat', requirePermission('portal.customer.order'), async (req, res) => {
    const cust = portalCustomer(req);
    const o = await one<{ customer_id: string }>(pool, 'SELECT customer_id FROM orders WHERE id = $1', [req.params.id]);
    if (!o || o.customer_id !== cust) throw notFound('Order');
    const lines = await many<{ product_id: string; lot_id: string | null; kg: number }>(pool, 'SELECT product_id, lot_id, kg FROM order_lines WHERE order_id = $1', [req.params.id]);
    const lots = await sellableLots();
    let added = 0;
    const skipped: string[] = [];
    for (const l of lines) {
      const lot = lots.find((x) => x.id === l.lot_id && Number(x.available_kg) >= Number(l.kg)) ?? lots.find((x) => x.product_id === l.product_id && Number(x.available_kg) >= Number(l.kg));
      if (!lot) { skipped.push(l.product_id); continue; }
      await pool.query('INSERT INTO cart_lines (user_id, customer_id, product_id, lot_id, kg) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (user_id, lot_id) DO UPDATE SET kg = EXCLUDED.kg', [req.user!.id, cust, l.product_id, lot.id, l.kg]);
      added++;
    }
    res.json({ added, unavailable: skipped.length });
  });

  // ----- orders: portal -----
  r.get('/portal/orders', requirePermission('portal.customer.order', 'portal.customer.accounts', 'portal.customer.approve'), async (req, res) => {
    const cust = portalCustomer(req);
    res.json(await many(pool, `SELECT o.*, (SELECT string_agg(sku, ', ' ORDER BY line_no) FROM order_lines WHERE order_id = o.id) AS skus FROM orders o WHERE customer_id = $1 ORDER BY created_at DESC LIMIT 200`, [cust]));
  });
  r.get('/portal/orders/:id', requirePermission('portal.customer.order', 'portal.customer.accounts', 'portal.customer.approve'), async (req, res) => {
    const d = await orderDetail(pool, String(req.params.id));
    assertCustomerAccess(req, d.customer_id);
    res.json(d);
  });
  r.post('/portal/orders/:id/approve', requirePermission('portal.customer.approve'), async (req, res) => {
    const cust = portalCustomer(req);
    const out = await tx(pool, async (c) => {
      const o = await one<Order>(c, 'SELECT * FROM orders WHERE id = $1 FOR UPDATE', [req.params.id]);
      if (!o || o.customer_id !== cust) throw notFound('Order');
      if (o.status !== 'pending_company_approval') throw conflict('This order is not waiting for your approval');
      if (o.placed_by === req.user!.id) throw forbidden('You placed this order, so another approver in your company must approve it');
      await c.query(`UPDATE orders SET company_approved_by_name = $2, company_approved_at = now() WHERE id = $1`, [o.id, req.user!.name]);
      const r1 = await allocate(c, req, o.id, null);
      await auditReq(c, req, 'sales_order', o.id, 'company_approved');
      return r1;
    });
    res.json(out);
  });
  r.post('/portal/orders/:id/cancel', requirePermission('portal.customer.order', 'portal.customer.approve'), async (req, res) => {
    const cust = portalCustomer(req);
    const { reason } = parse(z.object({ reason: reqText(300) }), req.body);
    await tx(pool, async (c) => {
      const o = await one<{ customer_id: string }>(c, 'SELECT customer_id FROM orders WHERE id = $1', [req.params.id]);
      if (!o || o.customer_id !== cust) throw notFound('Order');
      await cancelOrder(c, req, String(req.params.id), reason);
    });
    res.json({ ok: true });
  });
  /** A fresh link for the token (if the old one lapsed) or for an invoice balance. */
  r.post('/portal/orders/:id/pay', requirePermission('portal.customer.order', 'portal.customer.accounts'), async (req, res) => {
    const cust = portalCustomer(req);
    const b = parse(z.object({ purpose: z.enum(['token', 'invoice']), ref_no: optText(40), amount: z.number().positive().optional() }), req.body);
    const out = await tx(pool, async (c) => {
      const o = await one<Order>(c, 'SELECT * FROM orders WHERE id = $1 FOR UPDATE', [req.params.id]);
      if (!o || o.customer_id !== cust) throw notFound('Order');
      if (b.purpose === 'token') {
        if (o.status !== 'pending_payment') throw conflict('No token is due on this order');
        const live = await one<{ link_token: string; number: string; amount: number }>(c, `SELECT * FROM payments WHERE order_id = $1 AND purpose = 'token' AND status = 'created' AND link_expires_at > now()`, [o.id]);
        if (live) return { link_token: live.link_token, number: live.number, amount: Number(live.amount) };
        const mins = Math.max(5, Math.round((new Date(o.token_due_at ?? Date.now()).getTime() - Date.now()) / 60000));
        return createPaymentLink(c, { customer_id: o.customer_id, customer_name: o.customer_name, order_id: o.id, purpose: 'token', ref_no: o.number, amount: Number(o.token_amount), by: req.user!.name, expiresInMinutes: mins });
      }
      const due = await callService<{ invoices: { invoice_no: string; balance_due: number }[] }>(S, 'fulfilment', 'GET', `/orders/${o.id}/summary`);
      const inv = due.invoices.find((x) => x.invoice_no === b.ref_no && x.balance_due > 0);
      if (!inv) throw conflict('Nothing is due on that invoice');
      const bal = await walletBalance(c, o.customer_id);
      const amount = round2(Math.max(0, inv.balance_due - Math.max(0, bal)));
      if (amount <= 0) throw conflict('Your advance balance already covers this invoice; it will be applied automatically');
      return createPaymentLink(c, { customer_id: o.customer_id, customer_name: o.customer_name, order_id: o.id, purpose: 'invoice', ref_no: inv.invoice_no, amount, by: req.user!.name });
    });
    res.json(out);
  });

  // ----- orders: internal -----
  r.get('/orders', requirePermission('commerce.read'), async (req, res) => {
    const params: unknown[] = [];
    const where: string[] = [];
    if (req.query.status) { params.push(String(req.query.status).split(',')); where.push(`o.status = ANY($${params.length})`); }
    if (req.query.customer) { params.push(req.query.customer); where.push(`o.customer_id = $${params.length}`); }
    if (req.query.q) { params.push(`%${req.query.q}%`); where.push(`(o.number ILIKE $${params.length} OR o.customer_name ILIKE $${params.length})`); }
    if (req.query.numbers) { params.push(String(req.query.numbers).split(',')); where.push(`o.number = ANY($${params.length})`); }
    res.json(await many(pool, `SELECT o.*, (SELECT string_agg(sku, ', ' ORDER BY line_no) FROM order_lines WHERE order_id = o.id) AS skus,
      (SELECT coalesce(sum(amount), 0)::float FROM payments WHERE order_id = o.id AND status IN ('success','partially_refunded','refunded')) AS paid
      FROM orders o ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY o.created_at DESC LIMIT ${req.query.numbers ? 5000 : 300}`, params));
  });
  r.get('/orders/:id', requirePermission('commerce.read', 'fulfilment.read'), async (req, res) => {
    res.json(await orderDetail(pool, String(req.params.id)));
  });
  /** Sales staff place an order for a customer (phone or email orders). */
  r.post('/orders', requirePermission('commerce.order.manage'), async (req, res) => {
    const b = parse(z.object({ customer_id: z.uuid(), lines: z.array(internalLine).min(1).max(40), ship_to: optText(500), notes: optText(1000) }), req.body);
    res.status(201).json(await tx(pool, (c) => createOrder(c, req, { customer_id: b.customer_id, lines: b.lines.map((l) => ({ ...l, lot_id: l.lot_id ?? null })), channel: 'internal', ship_to: b.ship_to, notes: b.notes })));
  });
  /**
   * Go-live: the undelivered balance of an order taken in the legacy system, at its agreed price. Stock is reserved
   * as for any order (load opening stock first); credit blocks still apply. Loading it twice returns the first order.
   */
  r.post('/orders/opening', requirePermission('commerce.order.manage'), async (req, res) => {
    const b = parse(z.object({ customer_id: z.uuid(), legacy_ref: z.string().trim().min(1).max(60), migration_ref: optText(40), ship_to: optText(500), notes: optText(1000),
      lines: z.array(internalLine.extend({ price_per_kg: z.number().positive() })).min(1).max(40) }), req.body);
    const ref = `Legacy ${b.legacy_ref}${b.migration_ref ? ` · ${b.migration_ref}` : ''}`;
    const out = await tx(pool, async (c) => {
      const existing = await one<{ id: string; number: string; status: string }>(c, `SELECT id, number, status FROM orders WHERE customer_id = $1 AND channel = 'internal' AND (source_ref = $2 OR source_ref LIKE $3)`, [b.customer_id, `Legacy ${b.legacy_ref}`, `Legacy ${b.legacy_ref} · %`]);
      if (existing) return { ...existing, existing: true };
      return { ...(await createOrder(c, req, { customer_id: b.customer_id, channel: 'internal', source_ref: ref, ship_to: b.ship_to, notes: b.notes, opening: true, lines: b.lines.map((l) => ({ ...l, lot_id: l.lot_id ?? null })) })), existing: false };
    });
    res.status(201).json(out);
  });
  r.post('/orders/:id/cancel', requirePermission('commerce.order.manage'), async (req, res) => {
    const { reason } = parse(z.object({ reason: reqText(300) }), req.body);
    await tx(pool, (c) => cancelOrder(c, req, String(req.params.id), reason));
    res.json({ ok: true });
  });
  /** Ask to hold the stock longer than the token validity; a checker must approve. */
  r.post('/orders/:id/extend', requirePermission('commerce.order.manage'), async (req, res) => {
    const b = parse(z.object({ days: z.number().int().min(1).max(60), reason: reqText(500) }), req.body);
    const max = Number(await setting('commerce.reservation_extension_max_days', 7));
    if (b.days > max) throw badRequest(`Extensions are limited to ${max} days`);
    const out = await tx(pool, async (c) => {
      const o = await one<Order>(c, 'SELECT * FROM orders WHERE id = $1 FOR UPDATE', [req.params.id]);
      if (!o) throw notFound('Order');
      if (o.status !== 'booked') throw conflict('Only booked orders waiting for dispatch can be extended');
      if (await one(c, `SELECT 1 FROM reservation_extensions WHERE order_id = $1 AND status = 'pending'`, [o.id])) throw conflict('An extension is already waiting for approval');
      const until = new Date(new Date(o.reservation_expires_at ?? Date.now()).getTime() + b.days * 86_400_000).toISOString();
      const ext = await one<{ id: string }>(c, `INSERT INTO reservation_extensions (order_id, current_until, requested_until, reason, requested_by_name) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [o.id, o.reservation_expires_at, until, b.reason, req.user!.name]);
      await requestApproval(c, req, { type: 'reservation_extension', refId: ext!.id, permission: 'commerce.policy.approve', title: `Hold stock ${b.days} more days for ${o.number} · ${o.customer_name}`, summary: b.reason, payload: { order: o.number, customer: o.customer_name, from: o.reservation_expires_at, to: until } });
      return { id: ext!.id, status: 'pending' };
    });
    res.status(201).json(out);
  });
}

export async function applyExtensionDecision(c: Client, p: { ref_id: string; decision: string; decided_by_name: string }) {
  const e = await one<{ id: string; order_id: string; status: string; requested_until: string }>(c, 'SELECT * FROM reservation_extensions WHERE id = $1 FOR UPDATE', [p.ref_id]);
  if (!e || e.status !== 'pending') return;
  const ok = p.decision === 'approved';
  await c.query(`UPDATE reservation_extensions SET status = $2, decided_by_name = $3, decided_at = now() WHERE id = $1`, [e.id, ok ? 'approved' : 'rejected', p.decided_by_name]);
  if (!ok) return;
  await c.query('UPDATE orders SET reservation_expires_at = $2, updated_at = now() WHERE id = $1', [e.order_id, e.requested_until]);
  await publish(c, S, 'commerce.order.extended', { order_id: e.order_id, reserve_until: e.requested_until });
}

// ---------- events ----------
/** An accepted CRM quotation becomes a sales order; its stock is already reserved by the quotation. */
export function quotationAcceptedConsumer() {
  return async (ev: BusEvent, c: Client) => {
    const p = ev.payload as { quotation_id: string; number: string; version: number; customer_id: string; reservation_id: string | null };
    if (await one(c, `SELECT 1 FROM orders WHERE channel = 'crm_quotation' AND source_id = $1`, [p.quotation_id])) return;
    const q = await callService<{ warehouse_id: string | null; lines: { product_id: string; lot_id: string | null; kg: number; requested_price: number }[]; owner_name: string | null; notes: string | null; delivery_terms: string | null }>(S, 'crm', 'GET', `/quotations/${p.quotation_id}`);
    const req = { user: { id: 'svc:commerce', name: q.owner_name ?? 'Sales', permissions: ['*'] }, headers: {}, socket: {} } as unknown as Request;
    await createOrder(c, req, {
      customer_id: p.customer_id, channel: 'crm_quotation', source_id: p.quotation_id, source_ref: `${p.number} v${p.version}`, notes: q.notes, ship_to: q.delivery_terms,
      lines: q.lines.map((l) => ({ product_id: l.product_id, lot_id: l.lot_id, kg: Number(l.kg), price_per_kg: Number(l.requested_price) })),
      existing_reservation: p.reservation_id && q.warehouse_id ? { reservation_id: p.reservation_id, warehouse_id: q.warehouse_id } : null,
    });
  };
}

/** Fulfilment reserved stock after a manual or split decision: the order can now be paid or booked. */
export function planReservedConsumer() {
  return async (ev: BusEvent, c: Client) => {
    const p = ev.payload as { order_id: string };
    const o = await one<Order>(c, 'SELECT * FROM orders WHERE id = $1 FOR UPDATE', [p.order_id]);
    if (!o || o.status !== 'awaiting_allocation') return;
    await afterReserved(c, o, 7, 'system');
    const { portalUsersOf } = await import('./accounts.ts');
    for (const u of await portalUsersOf(o.customer_id, 'portal.customer.order'))
      await notify(c, S, { user_id: u, kind: 'action', title: `Stock reserved for ${o.number}`, body: o.payment_terms === 'credit' ? 'Your order is booked.' : `Please pay the token of ₹${Number(o.token_amount).toLocaleString('en-IN')}.`, link: `/portal/orders/${o.id}` });
  };
}

export function fulfilmentStatusConsumer() {
  return async (ev: BusEvent, c: Client) => {
    const p = ev.payload as { order_id: string; all_dispatched?: boolean; all_delivered?: boolean };
    const next = ev.type === 'fulfilment.delivered' ? (p.all_delivered ? 'delivered' : null) : ev.type === 'fulfilment.dispatched' ? (p.all_dispatched ? 'dispatched' : 'partially_dispatched') : 'in_fulfilment';
    if (next) await c.query(`UPDATE orders SET status = $2, updated_at = now() WHERE id = $1 AND status NOT IN ('cancelled','expired','delivered')`, [p.order_id, next]);
  };
}

export { round3, getWarehouses };
