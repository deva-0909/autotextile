/** Operations: mill shortages and quarantine, counter cash sales and cash closing, scheduled and blind stock counts,
 * manual sales and purchase invoices with maker-checker, and read-only version history. */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { bootAll } from './harness.ts';
import { runCountSchedules } from '../services/inventory/src/schedules.ts';
import { computeTotals } from '../services/finance/src/invoices.ts';

let h: Awaited<ReturnType<typeof bootAll>>;
const t: Record<string, string> = {};
const ids: Record<string, string> = {};
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
let rolls: { barcode: string; lot_id: string }[] = [];

async function approve(refId: string, token = t.owner!) {
  await h.drain();
  const a = (await h.ok(token, 'GET', '/governance/approvals?f_status=pending&pageSize=100')).items.find((x: { ref_id: string }) => x.ref_id === refId);
  assert.ok(a, 'approval request reached the inbox');
  await h.ok(token, 'POST', `/governance/approvals/${a.id}/decide`, { decision: 'approved', comment: 'ok' });
  await h.drain();
}
/** Graded, priced rolls in Surat to sell and count. */
async function stock(n: number, kg: number, cost: number, price: number) {
  const inw = await h.ok(t.stores!, 'POST', '/inventory/inwards', { warehouse_id: ids.SRT, source_ref: 'Opening', lines: [{ product_id: ids['SJ-160-NVY'], expected_kg: n * kg, cost_per_kg: cost }] });
  const line = (await h.ok(t.stores!, 'GET', `/inventory/inwards/${inw.id}`)).lines[0].id;
  const out = [];
  for (let i = 0; i < n; i++) out.push(await h.ok(t.stores!, 'POST', `/inventory/inwards/${inw.id}/rolls`, { line_id: line, weight_kg: kg }));
  await h.ok(t.stores!, 'POST', `/inventory/inwards/${inw.id}/complete`, {});
  await h.ok(t.stores!, 'POST', '/inventory/qc', { results: out.map((r) => ({ barcode: r.barcode, grade: 'A' })) });
  await h.ok(t.purchase!, 'POST', `/inventory/lots/${out[0].lot_id}/price`, { price_per_kg: price });
  await h.drain();
  return out as { barcode: string; lot_id: string }[];
}

before(async () => {
  h = await bootAll('ops');
  for (const [k, email] of Object.entries({ admin: 'admin@textile.local', owner: 'owner@textile.local', purchase: 'purchase@textile.local', stores: 'surat.stores@textile.local', millops: 'millops@textile.local', accounts: 'accounts@textile.local', dispatch: 'dispatch@textile.local' }))
    t[k] = await h.login(email);
  for (const w of await h.ok(t.admin!, 'GET', '/organisation/warehouses')) ids[w.code] = w.id;
  for (const p of (await h.ok(t.admin!, 'GET', '/masters/products?pageSize=50')).items) ids[p.sku] = p.id;
  const books = await h.ok(t.accounts!, 'GET', '/finance/books');
  ids.book = books.find((b: { is_primary: boolean }) => b.is_primary).id;
  rolls = await stock(6, 50, 240, 300);
});
after(async () => h.close());

describe('Mill shortages and wrong goods', () => {
  test('wrong goods are held in quarantine, not stocked; a shortage becomes a claim that posts a debit note', async () => {
    const mill = h.parties['Palladam Compacting Works']!;
    const jw = await h.ok(t.millops!, 'POST', '/jobwork/orders', { mill_id: mill, process_code: 'COMPACT_ONLY', expected_return_date: daysAgo(-7), lines: [{ source: 'warehouse', warehouse_id: ids.SRT, product_id: ids['RIB-240-NVY'], kg_sent: 1000 }] });
    await h.ok(t.millops!, 'POST', `/jobwork/orders/${jw.id}/issue`, { issue_date: daysAgo(40) });
    await h.ok(t.millops!, 'POST', `/jobwork/orders/${jw.id}/acknowledge`, { kg_received: 1000 });
    assert.equal((await h.call(t.millops!, 'POST', `/jobwork/orders/${jw.id}/returns`, { return_date: daysAgo(1), warehouse_id: ids.SRT, kg_good: 800, kg_quarantine: 60 })).status, 400, 'say what is wrong');
    await h.ok(t.millops!, 'POST', `/jobwork/orders/${jw.id}/returns`, { return_date: daysAgo(1), warehouse_id: ids.SRT, kg_good: 800, kg_process_loss: 60, loss_reason: 'Compacting loss', kg_quarantine: 60, quarantine_reason: 'other_party', quarantine_note: 'Two rolls carry another party’s lot tags' });
    let d = await h.ok(t.millops!, 'GET', `/jobwork/orders/${jw.id}`);
    assert.equal(d.reconciliation.kg_quarantine, 60);
    assert.equal(d.reconciliation.kg_balance_at_mill, 80);
    assert.equal(d.quarantine.length, 1);
    // Other party's goods go back to the mill: our 60 kg is still owed.
    await h.ok(t.millops!, 'POST', `/jobwork/quarantine/${d.quarantine[0].id}/resolve`, { action: 'return_to_mill', note: 'Sent back on the next lorry' });
    d = await h.ok(t.millops!, 'GET', `/jobwork/orders/${jw.id}`);
    assert.equal(d.reconciliation.kg_quarantine, 0);
    assert.equal(d.reconciliation.kg_balance_at_mill, 140);
    // Shortage: 140 kg not returned + process loss 60 above 3% of 1000 (30) = 170 kg.
    const sh = await h.ok(t.millops!, 'GET', `/jobwork/orders/${jw.id}/shortage`);
    assert.equal(sh.kg, 170);
    const close = await h.ok(t.millops!, 'POST', `/jobwork/orders/${jw.id}/close`, { reason: 'Mill could not trace the rest' });
    assert.equal(close.closed, false, 'a shortage claim comes first');
    assert.ok(close.shortage_claim.number);
    const claims = (await h.ok(t.millops!, 'GET', '/jobwork/claims')).items;
    const c = claims.find((x: { job_order_id: string; claim_type: string }) => x.job_order_id === jw.id && x.claim_type === 'shortage');
    assert.equal(Number(c.kg_affected), 170);
    await h.ok(t.millops!, 'PATCH', `/jobwork/claims/${c.id}`, { status: 'accepted', responsibility: 'mill', claim_type: 'shortage', amount: Number(c.amount) || 40800, resolution: 'Mill agreed to the shortage' });
    await h.drain();
    const v = await h.ok(t.accounts!, 'GET', '/finance/vouchers?type=debit_note');
    assert.ok(v.some((x: { source_ref: string }) => x.source_ref === c.number), 'debit note posted against the mill');
    const loss = await h.ok(t.millops!, 'GET', '/jobwork/analytics/mill-loss');
    const row = loss.find((r: { mill_id: string }) => r.mill_id === mill);
    assert.ok(row.loss_pct > 0 && row.claims >= 1);
  });
});

describe('Counter cash sale', () => {
  test('scan, preview with GST, take cash; rolls leave stock; cash book and closing; 269ST stops large cash', async () => {
    const pv = await h.ok(t.accounts!, 'POST', '/finance/counter-sales', { book_id: ids.book, barcodes: [rolls[0]!.barcode, rolls[1]!.barcode], payment_mode: 'cash', amount_received: 0, preview: true });
    assert.equal(pv.kg, 100);
    assert.equal(pv.taxable, 30000);
    assert.equal(pv.total, 31500, '5% GST, intra-state');
    assert.equal(pv.b2c, true);
    assert.equal((await h.call(t.accounts!, 'POST', '/finance/counter-sales', { book_id: ids.book, barcodes: [rolls[0]!.barcode, rolls[1]!.barcode], payment_mode: 'cash', amount_received: 20000 })).status, 400, 'paid in full');
    const sale = await h.ok(t.accounts!, 'POST', '/finance/counter-sales', { book_id: ids.book, buyer_name: 'Ramesh', buyer_mobile: '9876500111', barcodes: [rolls[0]!.barcode, rolls[1]!.barcode], payment_mode: 'cash', amount_received: 32000 });
    assert.equal(sale.change, 500);
    const scan = await h.ok(t.stores!, 'GET', `/inventory/scan/${rolls[0]!.barcode}`);
    assert.equal(scan.roll.state, 'dispatched');
    assert.equal((await h.call(t.accounts!, 'POST', '/finance/counter-sales', { book_id: ids.book, barcodes: [rolls[0]!.barcode], payment_mode: 'cash', amount_received: 20000 })).status, 409, 'a sold roll cannot be sold again');
    const inv = await h.ok(t.accounts!, 'GET', `/finance/manual-invoices/${sale.id}`);
    assert.equal(inv.status, 'posted');
    assert.equal(inv.mode, 'counter');
    const cb = await h.ok(t.accounts!, 'GET', `/finance/cash-book?book_id=${ids.book}`);
    assert.ok(cb.rows.some((r: { debit: number; narration: string }) => r.debit === 31500 && r.narration.includes(sale.number)));
    // Section 269ST: the same buyer cannot pay ₹2 lakh or more in cash in a day.
    const big = await stock(14, 50, 240, 300);
    const p2 = await h.ok(t.accounts!, 'POST', '/finance/counter-sales', { book_id: ids.book, buyer_mobile: '9876500111', barcodes: big.map((x) => x.barcode), payment_mode: 'cash', amount_received: 0, preview: true });
    assert.ok(p2.warning && /269ST/.test(p2.warning));
    assert.equal((await h.call(t.accounts!, 'POST', '/finance/counter-sales', { book_id: ids.book, buyer_mobile: '9876500111', barcodes: big.map((x) => x.barcode), payment_mode: 'cash', amount_received: p2.total })).status, 400);
    await h.ok(t.accounts!, 'POST', '/finance/counter-sales', { book_id: ids.book, buyer_mobile: '9876500111', barcodes: big.slice(0, 2).map((x) => x.barcode), payment_mode: 'upi', amount_received: 31500 });
    // Closing: a difference needs an explanation.
    assert.equal((await h.call(t.accounts!, 'POST', '/finance/cash-closings', { book_id: ids.book, counted: cb.closing - 200 })).status, 400);
    const cl = await h.ok(t.accounts!, 'POST', '/finance/cash-closings', { book_id: ids.book, counted: cb.closing - 200, note: '₹200 paid for tea and courier, slip missing' });
    assert.equal(cl.difference, -200);
    assert.equal((await h.call(t.accounts!, 'POST', '/finance/cash-closings', { book_id: ids.book, counted: cb.closing })).status, 409, 'one closing a day');
    ids.big = JSON.stringify(big.slice(2).map((x) => x.barcode));
  });
});

describe('Manual invoices and versions', () => {
  test('a manual sales invoice is drafted, edited as versions, approved by another person, posted and revised', async () => {
    assert.deepEqual(computeTotals([{ description: 'x', qty: 10, rate: 100, gst_rate: 18, uom: 'nos' }], '24', '27').igst, 180);
    const cust = h.parties['Rupa Apparel House']!;
    const d1 = await h.ok(t.accounts!, 'POST', '/finance/manual-invoices', { kind: 'sales', book_id: ids.book, doc_date: daysAgo(0), party_id: cust, lines: [{ description: 'Fabric waste (cuttings)', hsn: '6310', qty: 200, uom: 'kg', rate: 40, gst_rate: 5 }] });
    assert.equal(d1.total, 8400);
    const d2 = await h.ok(t.accounts!, 'PUT', `/finance/manual-invoices/${d1.id}`, { kind: 'sales', book_id: ids.book, doc_date: daysAgo(0), party_id: cust, change_note: 'Rate agreed at ₹45', lines: [{ description: 'Fabric waste (cuttings)', hsn: '6310', qty: 200, uom: 'kg', rate: 45, gst_rate: 5 }] });
    assert.equal(d2.version, 2);
    await h.ok(t.accounts!, 'POST', `/finance/manual-invoices/${d1.id}/submit`, {});
    assert.equal((await h.call(t.accounts!, 'PUT', `/finance/manual-invoices/${d1.id}`, { kind: 'sales', book_id: ids.book, doc_date: daysAgo(0), party_id: cust, lines: [{ description: 'x', qty: 1, rate: 1, gst_rate: 5 }] })).status, 409, 'not editable once submitted');
    await approve(d1.id);
    const posted = await h.ok(t.accounts!, 'GET', `/finance/manual-invoices/${d1.id}`);
    assert.equal(posted.status, 'posted');
    assert.ok(posted.number);
    assert.equal(Number(posted.total), 9450);
    const versions = await h.ok(t.accounts!, 'GET', `/governance/document-versions?doc_type=manual_sales_invoice&doc_id=${posted.root_id}`);
    assert.ok(versions.length >= 4, 'created, edited, sent for approval, posted');
    assert.ok(versions.some((v: { change_note: string }) => v.change_note === 'Rate agreed at ₹45'));
    assert.equal((await h.call(t.accounts!, 'PUT', `/finance/manual-invoices/${d1.id}`, { kind: 'sales', book_id: ids.book, doc_date: daysAgo(0), party_id: cust, lines: [{ description: 'x', qty: 1, rate: 1, gst_rate: 5 }] })).status, 409, 'a posted invoice is never edited');
    const rev = await h.ok(t.accounts!, 'POST', `/finance/manual-invoices/${d1.id}/revise`, { reason: 'Quantity was 180 kg' });
    const old = await h.ok(t.accounts!, 'GET', `/finance/manual-invoices/${d1.id}`);
    assert.equal(old.status, 'cancelled');
    assert.equal(old.is_latest, false);
    const nv = await h.ok(t.accounts!, 'GET', `/finance/manual-invoices/${rev.id}`);
    assert.equal(nv.status, 'draft');
    assert.equal(nv.version, rev.version);
    assert.equal(nv.editable, true);
    const ar = await h.ok(t.accounts!, 'GET', `/finance/parties/receivables/${cust}`);
    assert.ok(!ar.open_bills.some((b: { doc_no: string }) => b.doc_no === posted.number), 'the cancelled invoice no longer counts as owed');
  });

  test('a manual purchase invoice for a service posts input GST and the payable', async () => {
    const tr = h.parties['VRL Logistics']!;
    const d = await h.ok(t.accounts!, 'POST', '/finance/manual-invoices', { kind: 'purchase', book_id: ids.book, doc_date: daysAgo(0), party_id: tr, supplier_invoice_no: 'VRL/7781', lines: [{ description: 'Freight Surat → Tiruppur, October', hsn: '9965', qty: 1, uom: 'trip', rate: 18000, gst_rate: 12, account: '5310' }] });
    await h.ok(t.accounts!, 'POST', `/finance/manual-invoices/${d.id}/submit`, {});
    await approve(d.id);
    const p = await h.ok(t.accounts!, 'GET', `/finance/manual-invoices/${d.id}`);
    assert.equal(p.status, 'posted');
    const ap = await h.ok(t.accounts!, 'GET', `/finance/parties/payables/${tr}`);
    assert.ok(ap.open_bills.some((b: { doc_no: string }) => b.doc_no === 'VRL/7781'));
  });

  test('quotations and purchase orders keep their versions', async () => {
    const po = await h.ok(t.purchase!, 'POST', '/procurement/purchase-orders', { supplier_id: h.parties['Shree Ambica Knitters'], deliver_to_type: 'warehouse', deliver_to_id: ids.SRT, expected_date: daysAgo(-3), lines: [{ product_id: ids['SJ-160-NVY'], qty_kg: 600, rate_per_kg: 245 }] });
    await h.ok(t.purchase!, 'POST', `/procurement/purchase-orders/${po.id}/submit`);
    await h.drain();
    const v = await h.ok(t.purchase!, 'GET', `/governance/document-versions?doc_type=purchase_order&doc_id=${po.id}`);
    assert.ok(v.length >= 2);
    assert.equal(v[0].change_note, 'Sent for approval');
    assert.equal((await h.call(t.purchase!, 'POST', '/governance/document-versions', {})).status, 404, 'versions are read-only');
  });
});

describe('Stock counts', () => {
  test('blind count: counters do not see expectations; every difference needs a reason; large differences need the owner and post to accounts', async () => {
    const st = await h.ok(t.stores!, 'POST', '/inventory/stocktakes', { warehouse_id: ids.SRT, blind: true });
    const big = JSON.parse(ids.big!) as string[];
    // Count all but two of the rolls; one lighter.
    const all = await h.ok(t.stores!, 'GET', `/inventory/stocktakes/${st.id}`);
    assert.equal(all.hidden, true, 'the counter does not see what the system expects');
    assert.equal(all.variance, null);
    const expected = (await h.ok(t.stores!, 'GET', `/inventory/rolls?warehouse=${ids.SRT}&state=available,reserved,allocated,qc_hold`)) as { barcode: string; weight_kg: number }[];
    assert.equal((await h.call(t.stores!, 'POST', `/inventory/stocktakes/${st.id}/count`, { barcode: big[0] })).status, 400, 'blind counts weigh every roll');
    for (const r of expected.slice(2)) await h.ok(t.stores!, 'POST', `/inventory/stocktakes/${st.id}/count`, { barcode: r.barcode, weight_kg: r.barcode === big[2] ? Number(r.weight_kg) - 5 : Number(r.weight_kg) });
    assert.equal((await h.call(t.stores!, 'POST', `/inventory/stocktakes/${st.id}/submit`, { reason: 'Count done' })).status, 400, 'reasons first');
    const sup = await h.ok(t.owner!, 'GET', `/inventory/stocktakes/${st.id}`);
    assert.equal(sup.hidden, false, 'the approver sees the comparison');
    const v = sup.variance;
    assert.equal(v.missing.length, 2);
    await h.ok(t.stores!, 'PUT', `/inventory/stocktakes/${st.id}/reasons`, { reasons: [...v.missing, ...v.found, ...v.weight].map((x: { barcode: string }) => ({ barcode: x.barcode, reason_code: 'not_found', note: 'Searched both bays' })) });
    const sub = await h.ok(t.stores!, 'POST', `/inventory/stocktakes/${st.id}/submit`, { reason: 'Two rolls not found' });
    assert.equal(sub.status, 'submitted');
    const after = await h.ok(t.stores!, 'GET', `/inventory/stocktakes/${st.id}`);
    assert.ok(after.value_diff < 0);
    await h.drain();
    const pending = (await h.ok(t.owner!, 'GET', '/governance/approvals?f_status=pending&pageSize=100')).items.find((x: { ref_id: string }) => x.ref_id === st.id);
    assert.ok(pending);
    await approve(st.id);
    assert.equal((await h.ok(t.stores!, 'GET', `/inventory/stocktakes/${st.id}`)).status, 'approved');
    const j = await h.ok(t.accounts!, 'GET', '/finance/vouchers?type=journal');
    assert.ok(j.some((x: { narration: string }) => /Stock count .*shortage/.test(x.narration)), 'the loss shows on its own line in the books');
    const shr = await h.ok(t.stores!, 'GET', '/inventory/shrinkage');
    assert.ok(shr.some((r: { value_diff: number }) => r.value_diff < 0));
  });

  test('a count schedule opens blind counts when due and moves to its next date', async () => {
    const s = await h.ok(t.stores!, 'POST', '/inventory/count-schedules', { name: 'Weekly high value, Surat', warehouse_id: ids.SRT, scope: 'high_value', top_n: 2, frequency: 'weekly', next_due: daysAgo(0), blind: true });
    const n = await runCountSchedules(h.svc('inventory').ctx.pool);
    assert.equal(n, 1);
    const list = await h.ok(t.stores!, 'GET', '/inventory/count-schedules');
    const row = list.find((x: { id: string }) => x.id === s.id);
    assert.equal(row.next_due, new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10));
    const sts = await h.ok(t.stores!, 'GET', '/inventory/stocktakes');
    const opened = sts.find((x: { schedule_id: string }) => x.schedule_id === s.id);
    assert.ok(opened.blind);
    assert.match(opened.scope_label, /High-value/);
  });
});
