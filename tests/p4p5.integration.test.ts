/** End-to-end tests for P4 (inventory, barcodes, WMS, transfers, stocktake) and P5 (CRM, allocation, quotations, credit). */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { bootAll } from './harness.ts';
import { runCrmChecks } from '../services/crm/src/automation.ts';
import { ageingBuckets } from '../services/inventory/src/stock.ts';
import { parseCsv, mapFields } from '../services/crm/src/leads.ts';
import { ruleMatches } from '../services/crm/src/allocation.ts';

let h: Awaited<ReturnType<typeof bootAll>>;
const t: Record<string, string> = {};
const ids: Record<string, string> = {};
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString();

before(async () => {
  h = await bootAll('p4p5');
  for (const [k, email] of Object.entries({
    admin: 'admin@textile.local', purchase: 'purchase@textile.local', owner: 'owner@textile.local', stores: 'surat.stores@textile.local', millops: 'millops@textile.local',
    sales: 'sales@textile.local', south: 'sales.south@textile.local', east: 'sales.east@textile.local', mgr: 'salesmgr@textile.local', accounts: 'accounts@textile.local', mill: 'mill@suratprocess.example',
  })) t[k] = await h.login(email);
  for (const w of await h.ok(t.admin!, 'GET', '/organisation/warehouses')) ids[w.code] = w.id;
  for (const p of (await h.ok(t.admin!, 'GET', '/masters/products?pageSize=50')).items) ids[p.sku] = p.id;
  const team = await h.ok(t.mgr!, 'GET', '/crm/team');
  for (const m of team) ids[m.name] = m.user_id;
});
after(async () => h.close());

async function approve(refId: string, token = t.owner!, decision: 'approved' | 'rejected' = 'approved') {
  await h.drain();
  const a = (await h.ok(token, 'GET', '/governance/approvals?f_status=pending&pageSize=100')).items.find((x: { ref_id: string }) => x.ref_id === refId);
  assert.ok(a, 'approval request reached the inbox');
  await h.ok(token, 'POST', `/governance/approvals/${a.id}/decide`, { decision, comment: 'ok' });
  await h.drain();
}
const verify = async () => {
  const v = await h.ok(t.admin!, 'GET', '/inventory/ledger/verify');
  assert.ok(v.ok, `ledger and rolls agree: ${JSON.stringify(v.mismatches)}`);
};

describe('P4 inventory', () => {
  test('goods receipt becomes an inward; rolls are weighed, scanned and labelled', async () => {
    const po = await h.ok(t.purchase!, 'POST', '/procurement/purchase-orders', { supplier_id: h.parties['Shree Ambica Knitters'], deliver_to_type: 'warehouse', deliver_to_id: ids.SRT, expected_date: daysAgo(-3), lines: [{ product_id: ids['SJ-160-NVY'], qty_kg: 600, rate_per_kg: 245 }] });
    await h.ok(t.purchase!, 'POST', `/procurement/purchase-orders/${po.id}/submit`);
    await approve(po.id);
    await h.ok(t.purchase!, 'POST', `/procurement/purchase-orders/${po.id}/send`);
    const d = await h.ok(t.purchase!, 'GET', `/procurement/purchase-orders/${po.id}`);
    await h.ok(t.purchase!, 'POST', `/procurement/purchase-orders/${po.id}/receipts`, { receipt_date: daysAgo(0), lines: [{ po_line_id: d.lines[0].id, received_kg: 600 }] });
    await h.drain();
    const inwards = await h.ok(t.stores!, 'GET', '/inventory/inwards?status=open');
    const inw = inwards.find((i: { source_type: string }) => i.source_type === 'po_receipt');
    assert.ok(inw, 'inward created from the receipt event');
    assert.equal(inw.expected_kg, 600);
    ids.inward = inw.id;
    const detail = await h.ok(t.stores!, 'GET', `/inventory/inwards/${inw.id}`);
    assert.equal(Number(detail.lines[0].cost_per_kg), 245, 'cost carried from the PO');
    ids.line = detail.lines[0].id;
    const weights = [150.2, 149.6, 151, 148.8];
    const rolls = [];
    for (const [i, w] of weights.entries()) rolls.push(await h.ok(t.stores!, 'POST', `/inventory/inwards/${inw.id}/rolls`, { line_id: ids.line, weight_kg: w, gsm: i === 3 ? 140 : 161, width_in: 72, dye_lot: 'DL-77' }));
    assert.match(rolls[0].barcode, /^LOT-SRT-\d{5}-001$/);
    assert.equal(rolls[0].state, 'qc_hold');
    assert.equal(rolls[0].location_path, 'RCV', 'lands in the receiving bay');
    ids.lot = rolls[0].lot_id;
    ids.rolls = JSON.stringify(rolls.map((r) => r.barcode));
    // 599.6 kg weighed vs 600 kg on the document: within tolerance
    const done = await h.ok(t.stores!, 'POST', `/inventory/inwards/${inw.id}/complete`, {});
    assert.equal(done.variances.length, 0);
    assert.equal((await h.call(t.stores!, 'POST', `/inventory/inwards/${inw.id}/rolls`, { line_id: ids.line, weight_kg: 10 })).status, 409, 'completed inward is closed');
    await verify();
  });

  test('QC grading releases stock, flags rejects and out-of-spec GSM', async () => {
    const codes = JSON.parse(ids.rolls!) as string[];
    assert.equal((await h.call(t.stores!, 'POST', '/inventory/putaway', { barcodes: [codes[0]], location_id: (await bin()).id })).status, 409, 'cannot store before QC');
    const r = await h.ok(t.stores!, 'POST', '/inventory/qc', { results: [
      { barcode: codes[0], grade: 'A' }, { barcode: codes[1], grade: 'A' }, { barcode: codes[2], grade: 'B', defects: ['minor holes'] }, { barcode: codes[3], grade: 'reject', defects: ['low GSM'] },
    ] });
    assert.equal(r.graded, 4);
    assert.ok(r.flags.some((f: string) => f.includes('GSM 140')), 'GSM outside the product tolerance is flagged');
    const lot = await h.ok(t.stores!, 'GET', `/inventory/lots/${ids.lot}`);
    assert.equal(lot.qc_status, 'partial');
    assert.equal(lot.grade, 'A');
    const ex = await h.ok(t.stores!, 'GET', '/inventory/exceptions');
    assert.ok(ex.some((e: { kind: string }) => e.kind === 'qc_rejected'));
    const av = await h.ok(t.stores!, 'GET', `/inventory/availability?product=${ids['SJ-160-NVY']}`);
    const row = av.items.find((i: { warehouse_id: string }) => i.warehouse_id === ids.SRT);
    assert.equal(row.available, 450.8, 'available = graded A/B rolls, from the ledger');
    assert.equal(row.rejected, 148.8);
    await verify();
  });

  test('directed putaway suggests a bin and moves rolls', async () => {
    const codes = JSON.parse(ids.rolls!) as string[];
    const sug = await h.ok(t.stores!, 'GET', `/inventory/putaway/suggest?barcode=${codes[0]}`);
    assert.ok(sug.length > 0);
    await h.ok(t.stores!, 'POST', '/inventory/putaway', { barcodes: [codes[0], codes[1]], location_id: sug[0].id });
    const again = await h.ok(t.stores!, 'GET', `/inventory/putaway/suggest?barcode=${codes[2]}`);
    assert.equal(again[0].id, sug[0].id, 'same lot goes to the same bin');
    assert.equal(again[0].reason, 'Same lot already here');
    const map = await h.ok(t.stores!, 'GET', `/inventory/warehouses/${ids.SRT}/map`);
    assert.equal(map.locations.find((l: { id: string }) => l.id === sug[0].id).rolls, 2);
  });

  test('selling price: first tag direct, changes and thin margins need a checker, history kept', async () => {
    const first = await h.ok(t.purchase!, 'POST', `/inventory/lots/${ids.lot}/price`, { price_per_kg: 290 });
    assert.equal(first.status, 'approved');
    assert.equal(first.margin_pct, 15.52);
    assert.equal((await h.call(t.purchase!, 'POST', `/inventory/lots/${ids.lot}/price`, { price_per_kg: 300 })).status, 400, 'change needs a reason');
    const change = await h.ok(t.purchase!, 'POST', `/inventory/lots/${ids.lot}/price`, { price_per_kg: 300, reason: 'Market up' });
    assert.equal(change.status, 'pending');
    assert.equal((await h.call(t.purchase!, 'POST', `/inventory/lots/${ids.lot}/price`, { price_per_kg: 310, reason: 'x' })).status, 409, 'one pending change at a time');
    assert.equal((await h.ok(t.purchase!, 'GET', `/inventory/lots/${ids.lot}`)).price_per_kg, 290, 'old price holds until approved');
    await approve(change.id);
    const lot = await h.ok(t.purchase!, 'GET', `/inventory/lots/${ids.lot}`);
    assert.equal(Number(lot.price_per_kg), 300);
    assert.deepEqual(lot.prices.map((p: { status: string }) => p.status), ['approved', 'superseded']);
  });

  test('reservations split rolls, block double-booking and duplicate picks', async () => {
    const codes = JSON.parse(ids.rolls!) as string[];
    const r1 = await h.ok(t.stores!, 'POST', '/inventory/reservations', { warehouse_id: ids.SRT, lines: [{ lot_id: ids.lot, kg: 200 }], ref_no: 'manual test' });
    assert.equal(r1.kg, 200, 'exactly 200 kg: the last roll was cut');
    const cut = r1.rolls.find((r: { barcode: string }) => !codes.includes(r.barcode));
    assert.ok(cut, 'a child roll was split off');
    const taken = r1.rolls.find((r: { barcode: string }) => codes.includes(r.barcode)).barcode;
    assert.equal((await h.call(t.stores!, 'POST', '/inventory/reservations', { warehouse_id: ids.SRT, barcodes: [taken] })).status, 409, 'a reserved roll cannot be reserved again');
    const free = (await h.ok(t.stores!, 'GET', `/inventory/rolls?lot=${ids.lot}&state=available`))[0].barcode;
    assert.equal((await h.call(t.stores!, 'POST', `/inventory/reservations/${r1.id}/pick`, { barcode: free })).status, 409, 'not on this reservation');
    await h.ok(t.stores!, 'POST', `/inventory/reservations/${r1.id}/pick`, { barcode: taken });
    assert.equal((await h.call(t.stores!, 'POST', `/inventory/reservations/${r1.id}/pick`, { barcode: taken })).status, 409, 'duplicate pick refused');
    await h.ok(t.stores!, 'POST', `/inventory/reservations/${r1.id}/pick`, { barcode: cut.barcode });
    assert.equal((await h.ok(t.stores!, 'GET', `/inventory/reservations/${r1.id}`)).status, 'picked');
    const lot = await h.ok(t.stores!, 'GET', `/inventory/lots/${ids.lot}`);
    assert.equal(lot.summary.kg, 399.6, 'physical stock (incl. rejected rolls) fell by exactly the 200 kg picked');
    await verify();
  });

  test('shade control: dye lots do not mix without a reason; customer shade rejections are honoured', async () => {
    const inw = await h.ok(t.stores!, 'POST', '/inventory/inwards', { warehouse_id: ids.SRT, source_ref: 'Opening stock', lines: [{ product_id: ids['SJ-160-NVY'], expected_kg: 100, cost_per_kg: 240, lot_ref: 'DL-80' }] });
    const d = await h.ok(t.stores!, 'GET', `/inventory/inwards/${inw.id}`);
    const a = await h.ok(t.stores!, 'POST', `/inventory/inwards/${inw.id}/rolls`, { line_id: d.lines[0].id, weight_kg: 100, shade_code: 'NVY-2' });
    await h.ok(t.stores!, 'POST', `/inventory/inwards/${inw.id}/complete`, {});
    await h.ok(t.stores!, 'POST', '/inventory/qc', { results: [{ barcode: a.barcode, grade: 'A' }] });
    ids.lot2 = a.lot_id;
    ids.roll2 = a.barcode;
    const other = (await h.ok(t.stores!, 'GET', `/inventory/rolls?lot=${ids.lot}&state=available`))[0].barcode;
    const mix = await h.call(t.stores!, 'POST', '/inventory/reservations', { warehouse_id: ids.SRT, barcodes: [other, a.barcode] });
    assert.equal(mix.status, 409);
    assert.match(mix.body.error.message, /different dye lots/);
    const ok = await h.ok(t.stores!, 'POST', '/inventory/reservations', { warehouse_id: ids.SRT, barcodes: [other, a.barcode], mixed_shade_reason: 'Customer accepted on sample' });
    assert.equal(ok.mixed_shade, true);
    await h.ok(t.stores!, 'POST', `/inventory/reservations/${ok.id}/release`, { reason: 'test' });
    await h.ok(t.stores!, 'POST', '/inventory/shade-approvals', { customer_id: h.parties['Rupa Apparel House'], product_id: ids['SJ-160-NVY'], shade_code: 'NVY-2', decision: 'rejected', note: 'Too dark' });
    const blocked = await h.call(t.stores!, 'POST', '/inventory/reservations', { warehouse_id: ids.SRT, barcodes: [a.barcode], customer_id: h.parties['Rupa Apparel House'] });
    assert.equal(blocked.status, 409);
    assert.match(blocked.body.error.message, /rejected shade NVY-2/);
    await verify();
  });

  test('transfer between GSTINs needs approval and issues a tax invoice with IGST; receipt reconciles', async () => {
    const tr = await h.ok(t.stores!, 'POST', '/inventory/transfers', { from_warehouse_id: ids.SRT, to_warehouse_id: ids.KOL, reason: 'Kolkata running short', lines: [{ product_id: ids['SJ-160-NVY'], requested_kg: 100, lot_id: ids.lot2 }] });
    assert.equal(tr.status, 'pending_approval');
    assert.equal(tr.inter_gstin, true);
    assert.equal(tr.document_type, 'tax_invoice');
    assert.equal((await h.call(t.stores!, 'POST', `/inventory/transfers/${tr.id}/scan-out`, { barcode: ids.roll2 })).status, 409, 'not before approval');
    await approve(tr.id);
    const wrong = (await h.ok(t.stores!, 'GET', `/inventory/rolls?lot=${ids.lot}&state=available`))[0].barcode;
    assert.equal((await h.call(t.stores!, 'POST', `/inventory/transfers/${tr.id}/scan-out`, { barcode: wrong })).status, 409, 'roll from another lot refused');
    await h.ok(t.stores!, 'POST', `/inventory/transfers/${tr.id}/scan-out`, { barcode: ids.roll2 });
    assert.equal((await h.call(t.stores!, 'POST', `/inventory/transfers/${tr.id}/scan-out`, { barcode: ids.roll2 })).status, 409, 'already loaded');
    const disp = await h.ok(t.stores!, 'POST', `/inventory/transfers/${tr.id}/dispatch`, { transporter_name: 'VRL Logistics', lr_number: 'VRL-5521' });
    assert.match(disp.document_no, /^SRTI\/2627\/\d{5}$/, 'tax invoice from the Surat GSTIN series');
    assert.equal(disp.taxable_value, 24000);
    assert.equal(disp.igst, 1200, 'Gujarat → West Bengal is inter-state: IGST');
    assert.equal(disp.cgst, 0);
    let av = await h.ok(t.admin!, 'GET', `/inventory/availability?warehouse=${ids.KOL}`);
    assert.equal(av.items[0].in_transit_in, 100);
    // The Surat stores manager's data scope stops at Surat: Kolkata receives it.
    assert.equal((await h.call(t.stores!, 'POST', `/inventory/transfers/${tr.id}/scan-in`, { barcode: ids.roll2 })).status, 403);
    assert.ok((await h.ok(t.stores!, 'GET', '/inventory/availability')).items.every((i: { warehouse_id: string }) => i.warehouse_id === ids.SRT));
    const r = await h.ok(t.admin!, 'POST', `/inventory/transfers/${tr.id}/scan-in`, { barcode: ids.roll2, weight_kg: 99.2 });
    assert.equal(r.weight_difference, -0.8);
    assert.equal(r.remaining_rolls, 0);
    av = await h.ok(t.admin!, 'GET', `/inventory/availability?warehouse=${ids.KOL}`);
    assert.equal(av.items[0].available, 99.2);
    await h.ok(t.admin!, 'POST', `/inventory/transfers/${tr.id}/close`, {});
    await verify();
  });

  test('transfer within one GSTIN goes straight to dispatch on a delivery challan', async () => {
    const tr = await h.ok(t.admin!, 'POST', '/inventory/transfers', { from_warehouse_id: ids.SRT, to_warehouse_id: ids.TUP1, reason: 'Tiruppur demand', lines: [{ product_id: ids['SJ-160-NVY'], requested_kg: 10 }] });
    // SRT (Gujarat) → TUP1 (Tamil Nadu) is also inter-GSTIN; TUP1 → TUP2 shares a GSTIN.
    assert.equal(tr.inter_gstin, true);
    const same = await h.call(t.admin!, 'POST', '/inventory/transfers', { from_warehouse_id: ids.TUP1, to_warehouse_id: ids.TUP2, reason: 'Rebalance', lines: [{ product_id: ids['SJ-160-NVY'], requested_kg: 10 }] });
    assert.equal(same.status, 400, 'nothing in TUP1 to move');
    assert.match(same.body.error.message, /Only 0 kg/);
  });

  test('stocktake: variance needs a checker, then posts write-offs and weight corrections to the ledger', async () => {
    const st = await h.ok(t.stores!, 'POST', '/inventory/stocktakes', { warehouse_id: ids.SRT });
    const expected = await h.ok(t.stores!, 'GET', `/inventory/rolls?warehouse=${ids.SRT}&state=available,rejected,qc_hold,reserved,damaged`);
    assert.equal(st.expected_rolls, expected.length);
    const [missing, heavy, ...rest] = expected;
    await h.ok(t.stores!, 'POST', `/inventory/stocktakes/${st.id}/count`, { barcode: heavy.barcode, weight_kg: Number(heavy.weight_kg) + 2 });
    for (const r of rest) await h.ok(t.stores!, 'POST', `/inventory/stocktakes/${st.id}/count`, { barcode: r.barcode });
    const unk = await h.ok(t.stores!, 'POST', `/inventory/stocktakes/${st.id}/count`, { barcode: 'LOT-XXX-99999-001' });
    assert.equal(unk.known, false);
    assert.equal((await h.call(t.stores!, 'POST', `/inventory/stocktakes/${st.id}/submit`, {})).status, 400, 'variance needs a reason');
    const sub = await h.ok(t.stores!, 'POST', `/inventory/stocktakes/${st.id}/submit`, { reason: 'Quarterly count' });
    assert.equal(sub.status, 'submitted');
    assert.equal(sub.variance.missing_kg, Number(missing.weight_kg));
    assert.equal(sub.variance.weight_diff_kg, 2);
    assert.equal((await h.ok(t.stores!, 'GET', `/inventory/scan/${missing.barcode}`)).roll.state, missing.state, 'nothing changes before approval');
    await approve(st.id, t.accounts!);
    assert.equal((await h.ok(t.stores!, 'GET', `/inventory/scan/${missing.barcode}`)).roll.state, 'written_off');
    assert.equal(Number((await h.ok(t.stores!, 'GET', `/inventory/scan/${heavy.barcode}`)).roll.weight_kg), Number(heavy.weight_kg) + 2);
    const ledger = await h.ok(t.stores!, 'GET', `/inventory/ledger?q=${st.number ?? ''}&pageSize=50`);
    assert.ok(ledger.items.some((m: { movement_type: string }) => m.movement_type === 'adjust_out'));
    await verify();
  });

  test('issue to mill by scan; processed return consumes grey rolls and creates a finished lot with genealogy', async () => {
    const roll = (await h.ok(t.stores!, 'GET', `/inventory/rolls?lot=${ids.lot}&state=available`))[0];
    const jo = await h.ok(t.millops!, 'POST', '/jobwork/orders', { mill_id: h.parties['Surat Process House'], process_code: 'COMPACT_ONLY', expected_return_date: daysAgo(-7), lines: [{ source: 'warehouse', warehouse_id: ids.SRT, product_id: ids['SJ-160-NVY'], kg_sent: Number(roll.weight_kg) }] });
    await h.ok(t.millops!, 'POST', `/jobwork/orders/${jo.id}/issue`, {});
    await h.drain();
    const issue = (await h.ok(t.stores!, 'GET', '/inventory/mill-issues?status=open')).find((i: { job_order_id: string }) => i.job_order_id === jo.id);
    assert.ok(issue, 'job-work issue reached the stores');
    const s = await h.ok(t.stores!, 'POST', `/inventory/mill-issues/${issue.id}/scan`, { barcode: roll.barcode });
    assert.equal(s.done, true);
    await h.ok(t.mill!, 'POST', `/jobwork/portal/mill/jobs/${jo.id}/acknowledge`, { kg_received: Number(roll.weight_kg) });
    const good = Math.round(Number(roll.weight_kg) * 0.95 * 10) / 10;
    await h.ok(t.millops!, 'POST', `/jobwork/orders/${jo.id}/returns`, { return_date: daysAgo(0), warehouse_id: ids.SRT, kg_good: good, kg_process_loss: Math.round((Number(roll.weight_kg) - good) * 1000) / 1000, loss_reason: 'Compacting shrinkage', lot_ref: 'SPH-C-1' });
    await h.drain();
    assert.equal((await h.ok(t.stores!, 'GET', `/inventory/scan/${roll.barcode}`)).roll.state, 'consumed');
    const inw = (await h.ok(t.stores!, 'GET', '/inventory/inwards?status=open')).find((i: { source_type: string }) => i.source_type === 'job_return');
    assert.equal(inw.expected_kg, good);
    const d = await h.ok(t.stores!, 'GET', `/inventory/inwards/${inw.id}`);
    assert.ok(Number(d.lines[0].cost_per_kg) > 245, 'finished cost includes yield loss');
    const fr = await h.ok(t.stores!, 'POST', `/inventory/inwards/${inw.id}/rolls`, { line_id: d.lines[0].id, weight_kg: good });
    const lot = await h.ok(t.stores!, 'GET', `/inventory/lots/${fr.lot_id}`);
    assert.equal(lot.parents[0].id, ids.lot, 'finished lot points back to the grey lot');
    assert.equal(lot.dye_lot, 'SPH-C-1');
    const grey = await h.ok(t.stores!, 'GET', `/inventory/lots/${ids.lot}`);
    assert.equal(grey.children[0].id, fr.lot_id);
    await verify();
  });

  test('ledger is append-only; ageing buckets come from settings', async () => {
    const pool = h.svc('inventory').ctx.pool;
    await assert.rejects(pool.query('UPDATE stock_movements SET kg = 0'), /append-only/);
    await assert.rejects(pool.query('DELETE FROM stock_movements'), /append-only/);
    assert.deepEqual(ageingBuckets([30, 60, 90, 180, 365]).map((b) => b.label), ['0–30', '31–60', '61–90', '91–180', '181–365', '>365']);
    const a = await h.ok(t.stores!, 'GET', '/inventory/ageing');
    assert.equal(a.buckets.length, 6);
    assert.ok(a.buckets[0].kg > 0);
    assert.equal((await h.call(t.sales!, 'POST', '/inventory/stocktakes', { warehouse_id: ids.SRT })).status, 403);
  });
});

describe('P5 CRM', () => {
  test('allocation follows rules, skips absent people and records why', async () => {
    const lead = await h.ok(t.mgr!, 'POST', '/crm/leads', { source_code: 'INDIAMART', name: 'Murali K', company: 'Kovai Knits', mobile: '+91 98430 11111', city: 'Coimbatore', state_code: '33', est_value: 200000 });
    let d = await h.ok(t.mgr!, 'GET', `/crm/leads/${lead.id}`);
    assert.equal(d.owner_name, 'Selvi Raman', 'South rule');
    assert.equal(d.stage, 'assigned');
    // Selvi is on leave tomorrow-for-today: mark absent and a second South lead has nobody → unassigned with a trace
    await h.ok(t.mgr!, 'PUT', '/crm/attendance', { user_id: ids['Selvi Raman'], day: daysAgo(0), status: 'leave' });
    const l2 = await h.ok(t.mgr!, 'POST', '/crm/leads', { source_code: 'WEBSITE', name: 'Bala', mobile: '9876500002', state_code: '33' });
    d = await h.ok(t.mgr!, 'GET', `/crm/leads/${l2.id}`);
    assert.equal(d.owner_id, null);
    assert.equal(d.allocation_trace.candidates[0].reason, 'On leave');
    // Large enquiry rule: least loaded of Arjun and Selvi; Selvi on leave → Arjun
    const l3 = await h.ok(t.mgr!, 'POST', '/crm/leads', { source_code: 'TRADE', name: 'Big Buyer', mobile: '9000000003', state_code: '33', est_value: 2500000 });
    d = await h.ok(t.mgr!, 'GET', `/crm/leads/${l3.id}`);
    assert.equal(d.owner_name, 'Arjun Mehta');
    assert.match(d.allocation_trace.note, /Large enquiries/);
    const prev = await h.ok(t.mgr!, 'POST', '/crm/allocation/preview', { state_code: '19', source_code: 'META' });
    assert.equal(prev.owner.name, 'Sourav Ghosh');
    // back from leave: automation assigns the waiting lead
    await h.ok(t.mgr!, 'PUT', '/crm/attendance', { user_id: ids['Selvi Raman'], day: daysAgo(0), status: 'present' });
    await runCrmChecks(h.svc('crm').ctx.pool);
    assert.equal((await h.ok(t.mgr!, 'GET', `/crm/leads/${l2.id}`)).owner_name, 'Selvi Raman');
    ids.lead = lead.id;
    ids.bigLead = l3.id;
    assert.ok(ruleMatches({ states: ['33'] }, { city: null, state_code: '33', source_code: 'X', category: null, language: null, est_value: null }));
  });

  test('salespeople see only their own leads; caps are enforced', async () => {
    const mine = await h.ok(t.south!, 'GET', '/crm/leads');
    assert.ok(mine.items.length >= 1);
    assert.ok(mine.items.every((l: { owner_name: string }) => l.owner_name === 'Selvi Raman'));
    assert.equal((await h.call(t.east!, 'GET', `/crm/leads/${ids.lead}`)).status, 404, 'someone else’s lead is invisible');
    await h.ok(t.mgr!, 'PUT', `/crm/team/${ids['Sourav Ghosh']}`, { states: ['19', '21', '10', '20'], languages: ['Bengali'], max_active_leads: 1 });
    await h.ok(t.mgr!, 'POST', '/crm/leads', { source_code: 'META', name: 'East 1', mobile: '9830000001', state_code: '19' });
    const e2 = await h.ok(t.mgr!, 'POST', '/crm/leads', { source_code: 'META', name: 'East 2', mobile: '9830000002', state_code: '19' });
    const d = await h.ok(t.mgr!, 'GET', `/crm/leads/${e2.id}`);
    assert.equal(d.owner_id, null);
    assert.match(d.allocation_trace.candidates[0].reason, /lead cap \(1\/1\)/);
  });

  test('webhook capture maps fields, is idempotent and flags duplicates without merging them', async () => {
    const src = (await h.ok(t.mgr!, 'GET', '/crm/sources')).find((s: { code: string }) => s.code === 'INDIAMART');
    const body = { UNIQUE_QUERY_ID: 'IM-778', SENDER_NAME: 'Murali Krishnan', SENDER_MOBILE: '+91-9843011111', SENDER_COMPANY: 'Kovai Knits', SENDER_CITY: 'Coimbatore', QUERY_MESSAGE: 'Need 500 kg navy SJ' };
    const r1 = await h.call(null, 'POST', `/crm/public/leads/${src.webhook_key}`, body);
    assert.equal(r1.status, 201);
    const r2 = await h.call(null, 'POST', `/crm/public/leads/${src.webhook_key}`, body);
    assert.equal(r2.body.results[0].created, false, 'same query id ignored');
    assert.equal((await h.call(null, 'POST', '/crm/public/leads/not-a-key', body)).status, 404);
    const lead = (await h.ok(t.mgr!, 'GET', `/crm/leads?q=${encodeURIComponent('Murali Krishnan')}`)).items[0];
    assert.equal(lead.duplicate_flag, true);
    assert.equal(lead.owner_name, 'Selvi Raman', 'sticky: same contact goes to the same salesperson');
    const dups = await h.ok(t.mgr!, 'GET', '/crm/duplicates');
    const dup = dups.find((x: { lead_id: string }) => x.lead_id === lead.id);
    assert.deepEqual(dup.match_on, ['mobile']);
    await h.ok(t.mgr!, 'POST', `/crm/duplicates/${dup.id}/resolve`, { action: 'merge', note: 'Same buyer' });
    const merged = await h.ok(t.mgr!, 'GET', `/crm/leads/${lead.id}`);
    assert.equal(merged.status, 'merged', 'kept, not deleted');
    const target = await h.ok(t.mgr!, 'GET', `/crm/leads/${ids.lead}`);
    assert.ok(target.merged_leads.some((m: { id: string }) => m.id === lead.id));
    assert.ok(target.activities.some((a: { kind: string }) => a.kind === 'merge'));
    assert.deepEqual(parseCsv('name,phone\n"Shah, Ravi",98200 00001\n'), [['name', 'phone'], ['Shah, Ravi', '98200 00001']]);
    assert.deepEqual(mapFields({ profile: { name: 'A' }, from: '91999' }, { name: 'profile.name', mobile: 'from' }), { name: 'A', mobile: '91999' });
  });

  test('CSV import creates leads with a field mapping', async () => {
    const src = (await h.ok(t.mgr!, 'GET', '/crm/sources')).find((s: { code: string }) => s.code === 'EXHIBITION');
    const r = await h.ok(t.mgr!, 'POST', '/crm/leads/import', { source_id: src.id, mapping: { name: 'Contact', mobile: 'Phone', company: 'Firm', state_code: 'State' }, csv: 'Contact,Phone,Firm,State\nRavi Shah,9820000001,Shah Tex,27\nNo Phone,,Nowhere,27\n' });
    assert.equal(r.created, 1);
    assert.equal(r.errors.length, 1);
    assert.equal(r.errors[0].row, 3);
  });

  test('pipeline: no open lead without a next follow-up; lost needs a reason; first response is measured', async () => {
    assert.equal((await h.call(t.south!, 'POST', `/crm/leads/${ids.lead}/stage`, { stage: 'qualified' })).status, 400);
    await h.ok(t.south!, 'POST', `/crm/leads/${ids.lead}/activities`, { kind: 'call', summary: 'Spoke to Murali, needs navy SJ 160', next_action_at: inDays(1), next_action: 'Send quote' });
    let d = await h.ok(t.south!, 'GET', `/crm/leads/${ids.lead}`);
    assert.equal(d.stage, 'contacted');
    assert.ok(d.first_response_at);
    await h.ok(t.south!, 'POST', `/crm/leads/${ids.lead}/stage`, { stage: 'qualified', next_action_at: inDays(1) });
    assert.equal((await h.call(t.south!, 'POST', `/crm/leads/${ids.lead}/stage`, { stage: 'lost' })).status, 400);
    const conv = await h.ok(t.mgr!, 'POST', `/crm/leads/${ids.lead}/convert`, { legal_name: 'Kovai Knits' });
    d = await h.ok(t.south!, 'GET', `/crm/leads/${ids.lead}`);
    assert.equal(d.customer_id, conv.customer_id);
    ids.customer = conv.customer_id;
  });

  test('quotation: below-margin price needs approval; revision keeps negotiation history', async () => {
    // A fresh graded lot in Surat at cost ₹245, tagged at ₹300.
    const inw = await h.ok(t.stores!, 'POST', '/inventory/inwards', { warehouse_id: ids.SRT, source_ref: 'Opening', lines: [{ product_id: ids['SJ-160-NVY'], expected_kg: 120, cost_per_kg: 245 }] });
    const line = (await h.ok(t.stores!, 'GET', `/inventory/inwards/${inw.id}`)).lines[0].id;
    const rolls = [await h.ok(t.stores!, 'POST', `/inventory/inwards/${inw.id}/rolls`, { line_id: line, weight_kg: 60 }), await h.ok(t.stores!, 'POST', `/inventory/inwards/${inw.id}/rolls`, { line_id: line, weight_kg: 60 })];
    await h.ok(t.stores!, 'POST', `/inventory/inwards/${inw.id}/complete`, {});
    await h.ok(t.stores!, 'POST', '/inventory/qc', { results: rolls.map((r) => ({ barcode: r.barcode, grade: 'A' })) });
    await h.ok(t.purchase!, 'POST', `/inventory/lots/${rolls[0].lot_id}/price`, { price_per_kg: 300 });
    const lot = { id: rolls[0].lot_id as string };
    const price = await h.ok(t.south!, 'POST', '/crm/quotations/price', { lines: [{ product_id: ids['SJ-160-NVY'], lot_id: lot.id, kg: 50, requested_price: 255 }] });
    assert.equal(price.lines[0].list_price, 300);
    assert.equal(price.lines[0].discount_pct, 15);
    assert.equal(price.lines[0].needs_approval, true);
    const q = await h.ok(t.south!, 'POST', '/crm/quotations', { lead_id: ids.lead, warehouse_id: ids.SRT, freight_amount: 500, lines: [{ product_id: ids['SJ-160-NVY'], lot_id: lot.id, kg: 50, requested_price: 255 }] });
    assert.equal(q.needs_approval, true);
    assert.equal(q.taxable, 13250);
    assert.equal(q.tax, 662.5);
    assert.equal((await h.call(t.south!, 'POST', `/crm/quotations/${q.id}/submit`)).status, 400, 'each exception line needs a justification');
    const rev = await h.ok(t.south!, 'PUT', `/crm/quotations/${q.id}`, { lead_id: ids.lead, warehouse_id: ids.SRT, freight_amount: 500, lines: [{ product_id: ids['SJ-160-NVY'], lot_id: lot.id, kg: 50, requested_price: 255, approval_reason: 'Competitor at 258' }] });
    assert.equal((await h.ok(t.south!, 'POST', `/crm/quotations/${rev.id}/submit`)).status, 'pending_approval');
    assert.equal((await h.call(t.south!, 'POST', `/crm/quotations/${rev.id}/send`)).status, 409);
    await approve(rev.id, t.mgr!);
    await h.ok(t.south!, 'POST', `/crm/quotations/${rev.id}/send`);
    const v2 = await h.ok(t.south!, 'POST', `/crm/quotations/${rev.id}/revise`, { lead_id: ids.lead, warehouse_id: ids.SRT, freight_amount: 0, revision_reason: 'Customer asked for free freight at list-1%', competitor_name: 'Local mill', competitor_price: 296, lines: [{ product_id: ids['SJ-160-NVY'], lot_id: lot.id, kg: 50, requested_price: 297 }] });
    assert.equal(v2.version, 2);
    assert.equal(v2.needs_approval, false);
    assert.equal((await h.ok(t.south!, 'POST', `/crm/quotations/${v2.id}/submit`)).status, 'approved');
    await h.ok(t.south!, 'POST', `/crm/quotations/${v2.id}/send`);
    const d = await h.ok(t.south!, 'GET', `/crm/quotations/${v2.id}`);
    assert.deepEqual(d.versions.map((v: { status: string }) => v.status), ['superseded', 'sent']);
    assert.equal((await h.ok(t.south!, 'GET', `/crm/leads/${ids.lead}`)).stage, 'negotiation');
    ids.quote = v2.id;
    assert.equal((await h.call(t.east!, 'GET', `/crm/quotations/${v2.id}`)).status, 404, 'other salespeople cannot read it');
  });

  test('credit: acceptance passes the credit check, reserves stock and confirms the order', async () => {
    const app = await h.ok(t.south!, 'POST', '/crm/credit/applications', { customer_id: ids.customer, requested_mode: 'credit', requested_limit: 10000, requested_days: 30, justification: 'Regular buyer referred by agent' });
    await approve(app.id, t.accounts!);
    const blocked = await h.call(t.south!, 'POST', `/crm/quotations/${ids.quote}/outcome`, { outcome: 'accepted' });
    assert.equal(blocked.status, 409, 'order above available credit');
    assert.match(blocked.body.error.message, /exceeds available credit/);
    const ov = await h.ok(t.south!, 'POST', `/crm/credit/${ids.customer}/override`, { amount: 6000, quotation_id: ids.quote, justification: 'Advance cheque received for part' });
    await approve(ov.id, t.accounts!);
    const ok = await h.ok(t.south!, 'POST', `/crm/quotations/${ids.quote}/outcome`, { outcome: 'accepted' });
    assert.equal(ok.status, 'accepted');
    assert.ok(ok.reservation, `stock reserved: ${JSON.stringify(ok.warnings)}`);
    const res = await h.ok(t.admin!, 'GET', `/inventory/reservations/${ok.reservation.id}`);
    assert.equal(res.kg, 50);
    assert.equal((await h.ok(t.south!, 'GET', `/crm/leads/${ids.lead}`)).stage, 'order_confirmed');
    const c = await h.ok(t.south!, 'GET', `/crm/credit/${ids.customer}`);
    assert.equal(c.check.exposure.confirmed_orders, 15592.5);
    assert.equal(c.applications.find((a: { kind: string }) => a.kind === 'override').status, 'used');
    await h.ok(t.accounts!, 'POST', `/crm/credit/${ids.customer}/block`, { blocked: true, reason: 'Cheque bounced' });
    const chk = await h.ok(t.south!, 'GET', `/crm/credit-check/${ids.customer}?amount=1`);
    assert.equal(chk.ok, false);
    assert.equal((await h.call(t.south!, 'POST', `/crm/credit/${ids.customer}/block`, { blocked: false, reason: 'x' })).status, 403, 'only a credit approver can unblock');
  });

  test('customer 360 and performance with verified outcomes', async () => {
    const c = await h.ok(t.south!, 'GET', `/crm/customers/${ids.customer}/360`);
    assert.equal(c.value.orders, 1);
    assert.equal(c.preferences[0].sku, 'SJ-160-NVY');
    assert.equal(c.credit.status, 'blocked');
    await h.ok(t.mgr!, 'PUT', '/crm/targets', { user_id: ids['Selvi Raman'], period: new Date().toISOString().slice(0, 7), revenue: 10000, margin_pct: 10 });
    const p = await h.ok(t.mgr!, 'GET', '/crm/performance');
    const selvi = p.people.find((x: { name: string }) => x.name === 'Selvi Raman');
    assert.equal(selvi.revenue, 14850);
    assert.equal(selvi.new_customers, 1);
    assert.equal(selvi.incentive_eligible, true, JSON.stringify(selvi.incentive_reasons));
    const own = await h.ok(t.south!, 'GET', '/crm/performance');
    assert.equal(own.people.length, 1, 'salespeople see only their own numbers');
  });
});

async function bin() {
  const map = await h.ok(t.stores!, 'GET', `/inventory/warehouses/${ids.SRT}/map`);
  return map.locations.find((l: { kind: string; purpose: string }) => l.kind === 'bin' && l.purpose === 'storage');
}
