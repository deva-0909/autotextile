/** End-to-end tests for P6 (B2B commerce, token, payments, wallet, customer portal) and P7 (allocation, pick, invoice, dispatch, delivery, returns). */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { bootAll } from './harness.ts';
import { sign } from '../services/commerce/src/gateway.ts';
import { runCommerceChecks } from '../services/commerce/src/automation.ts';

let h: Awaited<ReturnType<typeof bootAll>>;
const t: Record<string, string> = {};
const ids: Record<string, string> = {};

before(async () => {
  h = await bootAll('p6p7');
  for (const [k, email] of Object.entries({
    admin: 'admin@textile.local', owner: 'owner@textile.local', purchase: 'purchase@textile.local', stores: 'surat.stores@textile.local', mgr: 'salesmgr@textile.local',
    dispatch: 'dispatch@textile.local', accounts: 'accounts@textile.local', murugan: 'buyer@srimurugan.example', kolkata: 'purchase@kolkatahosiery.example',
  })) t[k] = await h.login(email);
  for (const w of await h.ok(t.admin!, 'GET', '/organisation/warehouses')) ids[w.code] = w.id;
  for (const p of (await h.ok(t.admin!, 'GET', '/masters/products?pageSize=50')).items) ids[p.sku] = p.id;
  // Stock: 4 × 50 kg navy jersey in Surat (dye lot A) and 3 × 50 kg in Kolkata (dye lot B), graded and priced at ₹300.
  for (const [wh, lot, n] of [['SRT', 'DL-A', 4], ['KOL', 'DL-B', 3]] as const) {
    const inw = await h.ok(t.admin!, 'POST', '/inventory/inwards', { warehouse_id: ids[wh], source_ref: `Opening ${wh}`, lines: [{ product_id: ids['SJ-160-NVY'], expected_kg: n * 50, cost_per_kg: 245, lot_ref: lot }] });
    const line = (await h.ok(t.admin!, 'GET', `/inventory/inwards/${inw.id}`)).lines[0].id;
    const rolls = [];
    for (let i = 0; i < n; i++) rolls.push(await h.ok(t.admin!, 'POST', `/inventory/inwards/${inw.id}/rolls`, { line_id: line, weight_kg: 50 }));
    await h.ok(t.admin!, 'POST', `/inventory/inwards/${inw.id}/complete`, {});
    await h.ok(t.admin!, 'POST', '/inventory/qc', { results: rolls.map((r) => ({ barcode: r.barcode, grade: 'A' })) });
    await h.ok(t.purchase!, 'POST', `/inventory/lots/${rolls[0].lot_id}/price`, { price_per_kg: 300 });
    ids[`lot${wh}`] = rolls[0].lot_id;
  }
});
after(async () => h.close());

async function approve(refId: string, token = t.owner!, decision: 'approved' | 'rejected' = 'approved') {
  await h.drain();
  const a = (await h.ok(token, 'GET', '/governance/approvals?f_status=pending&pageSize=100')).items.find((x: { ref_id: string }) => x.ref_id === refId);
  assert.ok(a, 'approval request reached the inbox');
  await h.ok(token, 'POST', `/governance/approvals/${a.id}/decide`, { decision, comment: 'ok' });
  await h.drain();
}
const pay = async (link: string, outcome: 'success' | 'failure' = 'success') => { const r = await h.ok(t.murugan!, 'POST', `/commerce/public/pay/${link}/simulate`, { outcome }); await h.drain(); return r; };

describe('P6 commerce and customer portal', () => {
  test('catalogue shows only graded, priced stock; cart computes the token on taxable value excluding GST', async () => {
    const cat = await h.ok(t.murugan!, 'GET', '/commerce/catalogue');
    const nvy = cat.find((p: { sku: string }) => p.sku === 'SJ-160-NVY');
    assert.equal(nvy.available_kg, 350);
    assert.equal(nvy.price_from, 300);
    assert.equal(cat.find((p: { sku: string }) => p.sku === 'PIQ-210-WHT').status, 'out_of_stock');
    const d = await h.ok(t.murugan!, 'GET', `/commerce/catalogue/${ids['SJ-160-NVY']}`);
    assert.equal(d.lots.length, 2);
    assert.equal((await h.call(t.murugan!, 'POST', '/commerce/portal/cart/add', { product_id: ids['SJ-160-NVY'], lot_id: ids.lotSRT, kg: 120 })).status, 201);
    const cart = await h.ok(t.murugan!, 'GET', '/commerce/portal/cart');
    assert.equal(cart.taxable, 36000);
    assert.equal(cart.tax_estimate, 1800);
    assert.equal(cart.terms, 'advance');
    assert.equal(cart.token.amount, 3600, '10% of ₹36,000 taxable, GST excluded');
    assert.equal((await h.call(t.murugan!, 'GET', '/commerce/orders')).status, 403, 'customers cannot see internal order lists');
  });

  test('checkout reserves stock Surat-first and returns a token payment link; a second buyer cannot take the same kg', async () => {
    const o = await h.ok(t.murugan!, 'POST', '/commerce/portal/cart/checkout', { ship_to: 'Sri Murugan Garments, Tiruppur' });
    assert.equal(o.status, 'pending_payment');
    assert.equal(o.token_amount, 3600);
    assert.match(o.payment.url, /^\/pay\/[0-9a-f]{48}$/);
    ids.order = o.id; ids.link = o.payment.link_token;
    const plan = await h.ok(t.dispatch!, 'GET', `/fulfilment/plans/${o.id}`);
    assert.equal(plan.decision_mode, 'auto');
    assert.equal(plan.fulfilments[0].warehouse_code, 'SRT');
    assert.match(plan.decision_reason, /SRT is first in the dispatch priority/);
    await h.ok(t.kolkata!, 'POST', '/commerce/portal/cart/add', { product_id: ids['SJ-160-NVY'], lot_id: ids.lotSRT, kg: 100 });
    const race = await h.call(t.kolkata!, 'POST', '/commerce/portal/cart/checkout', {});
    assert.equal(race.status, 409, 'only 80 kg of that lot is left');
    assert.match(race.body.error.message, /only 80 kg/);
    await h.ok(t.kolkata!, 'PUT', '/commerce/portal/cart', { lines: [] });
  });

  test('payments: forged callbacks are rejected; success is verified server-side, books the order and is idempotent', async () => {
    const info = await h.ok(t.murugan!, 'GET', `/commerce/public/pay/${ids.link}`);
    assert.equal(info.amount, 3600);
    const p = (await h.ok(t.admin!, 'GET', `/commerce/orders/${ids.order}`)).payments[0];
    const forged = JSON.stringify({ gateway_order_id: (await h.svc('commerce').ctx.pool.query('SELECT gateway_order_id FROM payments WHERE id = $1', [p.id])).rows[0].gateway_order_id, txn_id: 'X', status: 'SUCCESS', amount: 3600 });
    assert.equal((await h.call(null, 'POST', '/commerce/public/payments/webhook', JSON.parse(forged), { 'x-signature': 'deadbeef' })).status, 401);
    // A correctly signed callback that the bank's status API does not confirm is not accepted either.
    const unconfirmed = await h.call(null, 'POST', '/commerce/public/payments/webhook', JSON.parse(forged), { 'x-signature': sign(forged) });
    assert.equal(unconfirmed.body.unverified, true);
    assert.equal((await h.ok(t.admin!, 'GET', `/commerce/orders/${ids.order}`)).status, 'pending_payment');
    const r = await pay(ids.link!);
    assert.equal(r.status, 'success');
    const o = await h.ok(t.murugan!, 'GET', `/commerce/portal/orders/${ids.order}`);
    assert.equal(o.status, 'booked');
    assert.equal(o.wallet_balance, 3600, 'token held as customer advance, not revenue');
    assert.ok(o.payments[0].utr);
    // the bank re-delivers its callback: nothing is credited twice
    const gw = (await h.svc('commerce').ctx.pool.query('SELECT gateway_order_id, gateway_txn_id FROM payments WHERE id = $1', [p.id])).rows[0];
    const again = JSON.stringify({ gateway_order_id: gw.gateway_order_id, txn_id: gw.gateway_txn_id, status: 'SUCCESS', amount: 3600 });
    assert.equal((await h.ok(null as never, 'POST', '/commerce/public/payments/webhook', JSON.parse(again), { 'x-signature': sign(again) })).duplicate, true);
    assert.equal((await h.ok(t.murugan!, 'GET', '/commerce/portal/wallet')).balance, 3600);
    await assert.rejects(h.svc('commerce').ctx.pool.query('UPDATE wallet_ledger SET amount = 0'), /append-only/);
  });

  test('token policies need a checker; the most specific policy wins', async () => {
    const p = await h.ok(t.mgr!, 'POST', '/commerce/token-policies', { name: 'Kolkata Hosiery — trusted buyer', scope: 'customer', scope_ref: h.parties['Kolkata Hosiery Works'], basis: 'percent', value: 5, min_amount: 2000, validity_days: 10, refundable: true, cancellation_fee_pct: 0, reason: 'Five years of on-time payments' });
    assert.equal(p.status, 'pending_approval');
    let prev = await h.ok(t.mgr!, 'POST', '/commerce/token-policies/preview', { customer_id: h.parties['Kolkata Hosiery Works'], lines: [{ product_id: ids['SJ-160-NVY'], taxable: 30000 }] });
    assert.equal(prev.amount, 3000, 'still the 10% default until approved');
    await approve(p.id);
    prev = await h.ok(t.mgr!, 'POST', '/commerce/token-policies/preview', { customer_id: h.parties['Kolkata Hosiery Works'], lines: [{ product_id: ids['SJ-160-NVY'], taxable: 30000 }] });
    assert.equal(prev.amount, 2000, '5% = ₹1,500, raised to the ₹2,000 minimum');
    assert.equal(prev.validity_days, 10);
  });

  test('website registration is approved into a customer and a company admin login', async () => {
    const reg = await h.call(null, 'POST', '/commerce/public/registrations', { company_name: 'Erode Knit Wear', city: 'Erode', contact_name: 'P. Kannan', email: 'kannan@erodeknit.example', phone: '9443012345' });
    assert.equal(reg.status, 201);
    const list = await h.ok(t.mgr!, 'GET', '/commerce/registrations?status=pending');
    const r = await h.ok(t.mgr!, 'POST', `/commerce/registrations/${list[0].id}/approve`, {});
    assert.match(r.temporary_password, /^Tx-/);
    const login = await h.call(null, 'POST', '/identity/auth/login', { email: 'kannan@erodeknit.example', password: r.temporary_password });
    assert.equal(login.status, 200);
    assert.equal(login.body.mustChangePassword, true);
  });
});

describe('P7 allocation, dispatch and delivery', () => {
  test('pick by scan, invoice from the Surat GSTIN, and hold dispatch until paid', async () => {
    const f = (await h.ok(t.dispatch!, 'GET', `/fulfilment/fulfilments?order=${ids.order}`))[0];
    ids.ful = f.id;
    assert.equal(f.status, 'released');
    const d = await h.ok(t.dispatch!, 'GET', `/fulfilment/fulfilments/${f.id}`);
    assert.equal(d.pick_list.length, 3, '120 kg = two rolls plus a 20 kg cut');
    const other = (await h.ok(t.admin!, 'GET', `/inventory/rolls?lot=${ids.lotSRT}&state=available`))[0].barcode;
    assert.equal((await h.call(t.dispatch!, 'POST', `/fulfilment/fulfilments/${f.id}/pick`, { barcode: other })).status, 409, 'a roll not on the pick list is refused');
    for (const r of d.pick_list) await h.ok(t.dispatch!, 'POST', `/fulfilment/fulfilments/${f.id}/pick`, { barcode: r.barcode, weight_kg: r.weight_kg });
    assert.equal((await h.call(t.dispatch!, 'POST', `/fulfilment/fulfilments/${f.id}/pick`, { barcode: d.pick_list[0].barcode })).status, 409, 'duplicate pick refused');
    await h.ok(t.dispatch!, 'POST', `/fulfilment/fulfilments/${f.id}/pack`, { packages: 3, gross_kg: 121.5 });
    const held = await h.call(t.dispatch!, 'POST', `/fulfilment/fulfilments/${f.id}/dispatch`, { transporter_name: 'VRL Logistics', mode: 'PTL' });
    assert.equal(held.status, 409);
    assert.match(held.body.error.message, /GST invoice/);
    const inv = await h.ok(t.dispatch!, 'POST', `/fulfilment/fulfilments/${f.id}/invoice`);
    assert.match(inv.invoice_no, /^SRTI\/2627\/\d{5}$/);
    assert.equal(inv.taxable, 36000);
    assert.equal(inv.igst, 1800, 'Gujarat warehouse to a Tamil Nadu buyer: IGST');
    assert.equal(inv.settled, 3600, 'token applied from the advance');
    assert.equal(inv.gate_payment, 'pending');
    const held2 = await h.call(t.dispatch!, 'POST', `/fulfilment/fulfilments/${f.id}/dispatch`, { transporter_name: 'VRL Logistics', mode: 'PTL' });
    assert.match(held2.body.error.message, /₹34,200 due/);
    ids.invoice = inv.invoice_no;
  });

  test('the customer pays the balance in the portal; the gate opens and the order ships with a tracking link', async () => {
    const link = await h.ok(t.murugan!, 'POST', `/commerce/portal/orders/${ids.order}/pay`, { purpose: 'invoice', ref_no: ids.invoice });
    assert.equal(link.amount, 34200);
    await pay(link.link_token);
    const f = await h.ok(t.dispatch!, 'GET', `/fulfilment/fulfilments/${ids.ful}`);
    assert.equal(f.gates.payment, 'paid');
    const s = await h.ok(t.dispatch!, 'POST', `/fulfilment/fulfilments/${ids.ful}/dispatch`, { transporter_name: 'VRL Logistics', mode: 'PTL', lr_number: 'VRL-90001', vehicle_no: 'GJ05XY1234', freight_amount: 900, eta_date: new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10) });
    assert.equal(s.kg, 120);
    await h.drain();
    assert.equal((await h.ok(t.murugan!, 'GET', `/commerce/portal/orders/${ids.order}`)).status, 'dispatched');
    const track = await h.call(null, 'GET', `/fulfilment/public/track/${s.tracking_token}`);
    assert.equal(track.status, 200);
    assert.equal(track.body.lr_number, 'VRL-90001');
    assert.equal(track.body.events[0].milestone, 'dispatched');
    assert.equal(track.body.taxable, undefined, 'no prices on the public page');
    ids.shipment = s.shipment_id;
    const inv = await h.ok(t.murugan!, 'GET', `/fulfilment/invoices/${encodeURIComponent(ids.invoice!)}`);
    assert.equal(inv.total, 37800);
    assert.equal((await h.call(t.kolkata!, 'GET', `/fulfilment/invoices/${encodeURIComponent(ids.invoice!)}`)).status, 404, 'another customer cannot read it');
    const ver = await h.ok(t.admin!, 'GET', '/inventory/ledger/verify');
    assert.ok(ver.ok);
  });

  test('ePOD from the portal reports a shortage and opens a transport claim', async () => {
    await h.ok(t.dispatch!, 'POST', `/fulfilment/shipments/${ids.shipment}/milestones`, { milestone: 'out_for_delivery', location: 'Tiruppur' });
    await h.ok(t.murugan!, 'POST', `/fulfilment/portal/shipments/${ids.shipment}/pod`, { received_by: 'Store keeper', kg_received: 118, condition: 'short', remarks: 'One roll torn, 2 kg missing' });
    await h.drain();
    assert.equal((await h.ok(t.murugan!, 'GET', `/commerce/portal/orders/${ids.order}`)).status, 'delivered');
    const claims = await h.ok(t.dispatch!, 'GET', '/fulfilment/claims');
    assert.equal(claims[0].kg, 2);
    assert.equal(claims[0].transporter_name, 'VRL Logistics');
  });

  test('return: request, authorise, receive into stock, restock, credit note to the advance', async () => {
    const d = await h.ok(t.dispatch!, 'GET', `/fulfilment/fulfilments/${ids.ful}`);
    const roll = d.pick_list.find((r: { weight_kg: number }) => Number(r.weight_kg) === 50).barcode;
    const rma = await h.ok(t.murugan!, 'POST', '/fulfilment/portal/returns', { fulfilment_id: ids.ful, barcodes: [roll], reason: 'Shade differs from sample' });
    assert.match(rma.number, /^RMA\/2627\/\d{5}$/);
    assert.equal((await h.call(t.dispatch!, 'POST', `/fulfilment/returns/${rma.id}/receive`, { warehouse_id: ids.SRT, barcodes: [roll] })).status, 409, 'authorise first');
    await h.ok(t.dispatch!, 'POST', `/fulfilment/returns/${rma.id}/authorize`, { approve: true });
    await h.ok(t.dispatch!, 'POST', `/fulfilment/returns/${rma.id}/receive`, { warehouse_id: ids.SRT, barcodes: [roll] });
    assert.equal((await h.ok(t.admin!, 'GET', `/inventory/scan/${roll}`)).roll.state, 'qc_hold');
    await h.ok(t.dispatch!, 'POST', `/fulfilment/returns/${rma.id}/disposition`, { lines: [{ barcode: roll, disposition: 'restock' }] });
    assert.equal((await h.ok(t.admin!, 'GET', `/inventory/scan/${roll}`)).roll.state, 'available');
    const res = await h.ok(t.dispatch!, 'POST', `/fulfilment/returns/${rma.id}/resolve`, { resolution: 'credit_note' });
    assert.match(res.credit_note_no, /^SRTCN\/2627\/\d{5}$/);
    assert.equal(res.total, 15750, '50 kg × ₹300 + 5% GST');
    assert.equal((await h.ok(t.murugan!, 'GET', '/commerce/portal/wallet')).balance, 15750);
    assert.ok((await h.ok(t.admin!, 'GET', '/inventory/ledger/verify')).ok);
  });

  test('no single warehouse can fulfil: shortage shown, override needs a reason, split needs management approval', async () => {
    // Surat now has 130 kg (80 + the returned 50), Kolkata 150 kg: 200 kg fits nowhere alone.
    const o = await h.ok(t.mgr!, 'POST', '/commerce/orders', { customer_id: h.parties['Kolkata Hosiery Works'], lines: [{ product_id: ids['SJ-160-NVY'], kg: 200 }] });
    assert.equal(o.status, 'awaiting_allocation');
    const rec = await h.ok(t.mgr!, 'POST', `/fulfilment/plans/${o.id}/recommend`);
    assert.equal(rec.recommended_warehouse_id, null);
    assert.ok(rec.options.find((x: { code: string }) => x.code === 'SRT').shortages[0].short_kg > 0);
    assert.ok(rec.split_suggestion?.length >= 2);
    assert.equal((await h.call(t.mgr!, 'POST', `/fulfilment/plans/${o.id}/decide`, { warehouse_id: ids.KOL })).status, 409, 'Kolkata alone cannot fulfil');
    const line = (await h.ok(t.mgr!, 'GET', `/commerce/orders/${o.id}`)).lines[0].id;
    const sp = await h.ok(t.mgr!, 'POST', `/fulfilment/plans/${o.id}/split`, { reason: 'Customer needs it this week; ship from both', allocations: [{ warehouse_id: ids.SRT, lines: [{ order_line_id: line, kg: 80 }] }, { warehouse_id: ids.KOL, lines: [{ order_line_id: line, kg: 120 }] }] });
    assert.equal(sp.status, 'pending_split_approval');
    assert.equal((await h.ok(t.mgr!, 'GET', `/fulfilment/plans/${o.id}`)).fulfilments.length, 0, 'nothing reserved before approval');
    await approve(o.id);
    const plan = await h.ok(t.mgr!, 'GET', `/fulfilment/plans/${o.id}`);
    assert.equal(plan.status, 'reserved');
    assert.deepEqual(plan.fulfilments.map((f: { warehouse_code: string }) => f.warehouse_code).sort(), ['KOL', 'SRT'], 'separate fulfilment records');
    assert.equal(plan.approved_by_name, 'Amit Deva');
    await h.drain();
    const ord = await h.ok(t.mgr!, 'GET', `/commerce/orders/${o.id}`);
    assert.equal(ord.status, 'pending_payment');
    assert.equal(ord.token_amount, 3000, 'the customer-specific 5% policy, min ₹2,000');
    ids.order2 = o.id;
  });

  test('a recommended single-warehouse plan can be overridden only with a reason, and both choices are kept', async () => {
    const o = await h.ok(t.mgr!, 'POST', '/commerce/orders', { customer_id: h.parties['Delhi Fashion Hub'], lines: [{ product_id: ids['SJ-160-NVY'], kg: 30 }] });
    assert.equal(o.status, 'pending_payment');
    const plan = await h.ok(t.mgr!, 'GET', `/fulfilment/plans/${o.id}`);
    const rec = plan.recommendation;
    const alt = rec.options.find((x: { can_fulfil: boolean; warehouse_id: string }) => x.can_fulfil && x.warehouse_id !== rec.recommended_warehouse_id);
    assert.equal((await h.call(t.mgr!, 'POST', `/fulfilment/plans/${o.id}/decide`, { warehouse_id: alt.warehouse_id })).status, 400, 'reason required');
    const r = await h.ok(t.mgr!, 'POST', `/fulfilment/plans/${o.id}/decide`, { warehouse_id: alt.warehouse_id, reason: 'Customer collects from Kolkata' });
    assert.equal(r.override, true);
    const after = await h.ok(t.mgr!, 'GET', `/fulfilment/plans/${o.id}`);
    assert.equal(after.decision_mode, 'override');
    assert.equal(after.recommended_warehouse_id, rec.recommended_warehouse_id);
    assert.equal(after.fulfilments.filter((f: { status: string }) => f.status !== 'cancelled').length, 1);
    // An unpaid order lapses and its stock goes back.
    await h.svc('commerce').ctx.pool.query(`UPDATE orders SET token_due_at = now() - interval '1 minute' WHERE id = $1`, [o.id]);
    await runCommerceChecks(h.svc('commerce').ctx.pool);
    await h.drain();
    assert.equal((await h.ok(t.mgr!, 'GET', `/commerce/orders/${o.id}`)).status, 'expired');
    assert.equal((await h.ok(t.mgr!, 'GET', `/fulfilment/plans/${o.id}`)).status, 'cancelled');
  });

  test('credit customers book without a token and pass the payment gate on approved credit', async () => {
    const app = await h.ok(t.mgr!, 'POST', '/crm/credit/applications', { customer_id: h.parties['Rupa Apparel House'], requested_mode: 'credit', requested_limit: 200000, requested_days: 30, justification: 'Brand account' });
    await approve(app.id, t.accounts!);
    const o = await h.ok(t.mgr!, 'POST', '/commerce/orders', { customer_id: h.parties['Rupa Apparel House'], lines: [{ product_id: ids['SJ-160-NVY'], kg: 50 }] });
    assert.equal(o.status, 'booked');
    await h.drain();
    const f = (await h.ok(t.dispatch!, 'GET', `/fulfilment/fulfilments?order=${o.id}`))[0];
    const d = await h.ok(t.dispatch!, 'GET', `/fulfilment/fulfilments/${f.id}`);
    for (const r of d.pick_list) await h.ok(t.dispatch!, 'POST', `/fulfilment/fulfilments/${f.id}/pick`, { barcode: r.barcode });
    await h.ok(t.dispatch!, 'POST', `/fulfilment/fulfilments/${f.id}/pack`, { packages: 1, gross_kg: 51 });
    const inv = await h.ok(t.dispatch!, 'POST', `/fulfilment/fulfilments/${f.id}/invoice`);
    assert.equal(inv.gate_payment, 'credit');
    assert.equal(inv.cgst, 0);
    assert.ok(inv.igst > 0, 'Maharashtra buyer');
    await h.ok(t.dispatch!, 'POST', `/fulfilment/fulfilments/${f.id}/dispatch`, { transporter_name: 'Gati Express', mode: 'PTL', lr_number: 'GATI-1' });
  });

  test('reservation extension needs approval; payment reconciliation ties up', async () => {
    const link = (await h.ok(t.mgr!, 'GET', `/commerce/orders/${ids.order2}`)).payments.find((p: { purpose: string }) => p.purpose === 'token').link_token;
    await pay(link);
    assert.equal((await h.ok(t.mgr!, 'GET', `/commerce/orders/${ids.order2}`)).status, 'booked');
    const ext = await h.ok(t.mgr!, 'POST', `/commerce/orders/${ids.order2}/extend`, { days: 3, reason: 'Customer’s truck delayed' });
    assert.equal(ext.status, 'pending');
    assert.equal((await h.call(t.mgr!, 'POST', `/commerce/orders/${ids.order2}/extend`, { days: 2, reason: 'again' })).status, 409);
    const before = (await h.ok(t.mgr!, 'GET', `/commerce/orders/${ids.order2}`)).reservation_expires_at;
    await approve(ext.id);
    const afterExt = (await h.ok(t.mgr!, 'GET', `/commerce/orders/${ids.order2}`)).reservation_expires_at;
    assert.equal(new Date(afterExt).getTime() - new Date(before).getTime(), 3 * 86400000);
    const rec = await h.ok(t.accounts!, 'GET', '/commerce/payments-reconciliation');
    assert.deepEqual(rec.issues, []);
    assert.equal(rec.received, 40800);
    assert.equal(rec.rejected_callbacks, 1);
  });
});
