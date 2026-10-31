/** End-to-end tests for P11: data migration with validation, loading through owning services, reconciliation and sign-off; UAT, defects, sign-off; training; cutover readiness; hypercare. */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { bootAll } from './harness.ts';
import { gstin } from '../scripts/seed-data.ts';

let h: Awaited<ReturnType<typeof bootAll>>;
const t: Record<string, string> = {};

before(async () => {
  h = await bootAll('p11');
  for (const [k, email] of Object.entries({ admin: 'admin@textile.local', owner: 'owner@textile.local', accounts: 'accounts@textile.local', sales: 'sales@textile.local' })) t[k] = await h.login(email);
});
after(async () => h.close());

async function load(token: string, object_type: string, csv: string) {
  const b = await h.ok(token, 'POST', '/golive/migration/batches', { object_type, csv, file_name: `${object_type}.csv` });
  return b;
}

describe('P11 data migration', () => {
  test('parties: invalid rows are listed with reasons; existing names are skipped; counts reconcile; loader cannot sign off', async () => {
    const csv = `party_type,legal_name,gstin,pan,state_code,email,phone,credit_limit,segment
customer,Shakti Knitwear Pvt Ltd,${gstin('33', 'AAJCS1234F')},AAJCS1234F,33,accounts@shakti.example,9443000111,500000,Exporter
customer,Sri Murugan Garments,,,33,,,,
seller,Bad Type,,,,,,,
supplier,Ganga Knits,24AAGCG1111A1Z,,24,,,,`;
    const b = await load(t.admin!, 'parties', csv);
    assert.equal(b.valid, 2);
    assert.equal(b.invalid, 2);
    const d = await h.ok(t.admin!, 'GET', `/golive/migration/batches/${b.id}`);
    assert.match(d.rows.find((r: { row_no: number }) => r.row_no === 4).errors[0], /party_type/);
    assert.match(d.rows.find((r: { row_no: number }) => r.row_no === 5).errors[0], /GSTIN/);
    const imp = await h.ok(t.admin!, 'POST', `/golive/migration/batches/${b.id}/import`);
    assert.equal(imp.status, 'reconciled');
    assert.equal(imp.source_total, 2);
    assert.equal(imp.erp_total, 2, JSON.stringify((await h.ok(t.admin!, 'GET', `/golive/migration/batches/${b.id}`)).rows.map((r: { status: string; error: string }) => [r.status, r.error])));
    assert.equal(imp.difference, 0);
    const rows = (await h.ok(t.admin!, 'GET', `/golive/migration/batches/${b.id}`)).rows;
    assert.equal(rows.find((r: { row_no: number }) => r.row_no === 3).status, 'skipped');
    assert.equal((await h.call(t.admin!, 'POST', `/golive/migration/batches/${b.id}/signoff`, {})).status, 403, 'loader cannot sign off');
    await h.ok(t.owner!, 'POST', `/golive/migration/batches/${b.id}/signoff`, {});
    assert.equal((await h.ok(t.owner!, 'GET', '/masters/parties?q=Shakti')).items[0].tags.includes('migrated'), true);
  });

  test('opening receivables become bill-wise balances that age; totals reconcile', async () => {
    const csv = `kind,party,doc_no,doc_date,due_date,amount
receivable,Sri Murugan Garments,OLD/0451,2026-03-12,2026-04-11,125000
receivable,Delhi Fashion Hub,OLD/0460,2026-03-20,2026-04-19,"40,500"
payable,Shree Ambica Knitters,AMB/991,2026-03-25,2026-04-24,88000`;
    const b = await load(t.accounts!, 'opening_balances', csv);
    assert.equal(b.valid, 3);
    const imp = await h.ok(t.accounts!, 'POST', `/golive/migration/batches/${b.id}/import`);
    assert.equal(imp.source_total, 253500);
    assert.equal(imp.erp_total, 253500, JSON.stringify((await h.ok(t.accounts!, 'GET', `/golive/migration/batches/${b.id}`)).rows.map((r: { status: string; error: string }) => [r.status, r.error])));
    const ar = await h.ok(t.accounts!, 'GET', '/finance/ageing/receivables');
    assert.equal(ar.totals.balance, 165500);
    assert.ok(ar.totals.d90_plus + ar.totals.d61_90 + ar.totals.d31_60 + ar.totals.d1_30 > 0, 'old bills are overdue');
    const tb = await h.ok(t.accounts!, 'GET', '/finance/reports/trial-balance?from=2020-04-01');
    assert.ok(tb.balanced);
    // Loading the same file again does not double the balances.
    const again = await h.ok(t.accounts!, 'POST', `/golive/migration/batches/${(await load(t.accounts!, 'opening_balances', csv)).id}/import`);
    assert.equal((await h.ok(t.accounts!, 'GET', '/finance/ageing/receivables')).totals.balance, 165500);
    assert.equal(again.difference, 0);
  });

  test('opening trial balance must balance; it waits for a checker, then reconciles', async () => {
    const bad = await load(t.accounts!, 'opening_gl', `account_code,debit,credit,date\n1200,500000,0,2026-04-01\n3100,0,400000,2026-04-01`);
    assert.equal((await h.call(t.accounts!, 'POST', `/golive/migration/batches/${bad.id}/import`)).status, 409);
    const ctl = await load(t.accounts!, 'opening_gl', `account_code,debit,credit,date\n1300,100,0,2026-04-01\n3100,0,100,2026-04-01`);
    assert.equal(ctl.invalid, 1, 'receivables come from the bill-wise batch');
    const b = await load(t.accounts!, 'opening_gl', `account_code,debit,credit,date\n1200,2500000,0,2026-04-01\n1800,350000,0,2026-04-01\n3100,0,2000000,2026-04-01\n2400,0,850000,2026-04-01`);
    const imp = await h.ok(t.accounts!, 'POST', `/golive/migration/batches/${b.id}/import`);
    assert.equal(imp.erp_total, 0, 'pending approval');
    assert.match(imp.reconciliation.note, /waiting for a checker/);
    await h.drain();
    const appr = (await h.ok(t.owner!, 'GET', '/governance/approvals?f_status=pending&pageSize=50')).items.find((a: { approval_type: string }) => a.approval_type === 'finance_voucher');
    await h.ok(t.owner!, 'POST', `/governance/approvals/${appr.id}/decide`, { decision: 'approved', comment: 'Agrees to the CA-certified TB' });
    await h.drain();
    const rec = await h.ok(t.accounts!, 'POST', `/golive/migration/batches/${b.id}/reconcile`);
    assert.equal(rec.erp_total, 2850000);
    assert.equal(rec.difference, 0);
  });

  test('opening stock: rolls created by lot with barcodes, graded, and kg reconciled', async () => {
    const csv = `warehouse,sku,lot_ref,roll_kg,cost_per_kg,grade,received_date
SRT,SJ-160-NVY,OLD-L-1,25.4,238,A,2026-02-20
SRT,SJ-160-NVY,OLD-L-1,24.6,238,A,2026-02-20
KOL,FLC-320-CHR,OLD-L-2,30,300,B,2026-01-05
SRT,NOPE,OLD-L-3,10,100,A,2026-01-05`;
    const b = await load(t.admin!, 'opening_stock', csv);
    assert.equal(b.invalid, 1);
    const imp = await h.ok(t.admin!, 'POST', `/golive/migration/batches/${b.id}/import`);
    assert.equal(imp.imported, 3);
    assert.equal(imp.source_total, 80);
    assert.equal(imp.erp_total, 80);
    const lots = (await h.ok(t.admin!, 'GET', '/inventory/lots?q=OLD-L&pageSize=10')).items;
    assert.equal(lots.length, 2);
    const old = lots.find((l: { sku: string }) => l.sku === 'FLC-320-CHR');
    assert.equal(old.received_date.slice(0, 10), '2026-01-05', 'ageing keeps the original receipt date');
  });

  test('open purchase orders: lines group into one accepted PO per legacy number; reload does not duplicate', async () => {
    const csv = `supplier,legacy_po_no,order_date,deliver_to,expected_date,sku,pending_kg,rate_per_kg
Shree Ambica Knitters,PO/2526/0912,2026-03-18,SRT,2026-04-10,SJ-160-NVY,1200,246
Shree Ambica Knitters,PO/2526/0912,2026-03-18,SRT,2026-04-10,FLC-320-CHR,300,310
Surat Process House,PO/2526/0913,,SRT,2026-04-10,SJ-160-NVY,50,246
Shree Ambica Knitters,PO/2526/0914,,Surat Process House,2026-04-12,SJ-160-NVY,400,240`;
    const b = await load(t.admin!, 'open_pos', csv);
    assert.equal(b.valid, 3);
    const d = await h.ok(t.admin!, 'GET', `/golive/migration/batches/${b.id}`);
    assert.match(d.rows.find((r: { row_no: number }) => r.row_no === 4).errors[0], /not a supplier/);
    const imp = await h.ok(t.admin!, 'POST', `/golive/migration/batches/${b.id}/import`);
    assert.equal(imp.source_total, 1900);
    assert.equal(imp.erp_total, 1900, JSON.stringify((await h.ok(t.admin!, 'GET', `/golive/migration/batches/${b.id}`)).rows.map((r: { status: string; error: string }) => [r.status, r.error])));
    assert.equal(imp.reconciliation.purchase_orders, 2);
    const pos = (await h.ok(t.admin!, 'GET', '/procurement/purchase-orders?q=Ambica&pageSize=50')).items.filter((p: { notes: string | null }) => p.notes?.includes('Legacy PO'));
    assert.equal(pos.length, 2);
    assert.ok(pos.every((p: { status: string }) => p.status === 'accepted'), 'ready to receive against');
    assert.equal(pos.find((p: { deliver_to_type: string }) => p.deliver_to_type === 'mill').ordered_kg, 400);
    const again = await h.ok(t.admin!, 'POST', `/golive/migration/batches/${(await load(t.admin!, 'open_pos', csv)).id}/import`);
    assert.equal(again.difference, 0, 'a reload points at the POs created the first time');
    assert.equal((await h.ok(t.admin!, 'GET', '/procurement/purchase-orders?q=Ambica&pageSize=50')).items.filter((p: { notes: string | null }) => p.notes?.includes('Legacy PO')).length, 2);
    await h.ok(t.owner!, 'POST', `/golive/migration/batches/${b.id}/signoff`, {});
  });

  test('open sales orders: the undelivered balance at the agreed price reserves stock without asking for a new token', async () => {
    const lot = (await h.ok(t.admin!, 'GET', '/inventory/lots?q=SJ-160-NVY&pageSize=20')).items.find((l: { lot_no: string; received_date: string }) => l.received_date.startsWith('2026-02-20'));
    const csv = `customer,legacy_order_no,sku,lot_no,pending_kg,price_per_kg,ship_to
Kolkata Hosiery Works,SO/2526/1140,SJ-160-NVY,${lot.lot_no},20,312,Howrah unit
Kolkata Hosiery Works,SO/2526/1140,SJ-160-NVY,NO-SUCH-LOT,5,312,Howrah unit
Shree Ambica Knitters,SO/2526/1141,SJ-160-NVY,,10,300,`;
    const b = await load(t.admin!, 'open_orders', csv);
    assert.equal(b.valid, 1);
    const rows = (await h.ok(t.admin!, 'GET', `/golive/migration/batches/${b.id}`)).rows;
    assert.match(rows.find((r: { row_no: number }) => r.row_no === 3).errors[0], /not in stock/);
    assert.match(rows.find((r: { row_no: number }) => r.row_no === 4).errors[0], /not a customer/);
    const imp = await h.ok(t.admin!, 'POST', `/golive/migration/batches/${b.id}/import`);
    assert.equal(imp.erp_total, 20, JSON.stringify((await h.ok(t.admin!, 'GET', `/golive/migration/batches/${b.id}`)).rows.map((r: { status: string; error: string }) => [r.status, r.error])));
    assert.equal(imp.difference, 0);
    const so = (await h.ok(t.admin!, 'GET', '/commerce/orders?q=Kolkata')).find((o: { source_ref: string | null }) => o.source_ref?.startsWith('Legacy SO/2526/1140'));
    assert.equal(Number(so.token_amount), 0, 'advance is already in the opening balances');
    assert.equal(so.status, 'booked');
    assert.equal(Number(so.taxable), 6240);
  });

  test('open job work: balance at the mill becomes an acknowledged job order with the original statutory clock', async () => {
    const csv = `mill,legacy_challan_no,challan_date,process,expected_return_date,sku,kg_at_mill,cost_per_kg,rolls,lot_ref
Surat Process House,JWC/0388,2026-03-05,REACTIVE_DYE,2026-04-08,SJ-160-NVY,850,246,34,GR-0412
Surat Process House,JWC/0388,2026-03-05,REACTIVE_DYE,2026-04-08,FLC-320-CHR,150.5,300,,
Surat Process House,JWC/0390,2026-03-09,SCREEN_PRINT,2026-04-08,SJ-160-NVY,10,246,,
Shree Ambica Knitters,JWC/0391,2026-03-09,RFD,2026-04-08,SJ-160-NVY,10,246,,`;
    const b = await load(t.admin!, 'open_job_work', csv);
    assert.equal(b.valid, 2);
    const rows = (await h.ok(t.admin!, 'GET', `/golive/migration/batches/${b.id}`)).rows;
    assert.match(rows.find((r: { row_no: number }) => r.row_no === 4).errors[0], /not an active process/);
    assert.match(rows.find((r: { row_no: number }) => r.row_no === 5).errors[0], /not a mill/);
    const imp = await h.ok(t.admin!, 'POST', `/golive/migration/batches/${b.id}/import`);
    assert.equal(imp.erp_total, 1000.5, JSON.stringify((await h.ok(t.admin!, 'GET', `/golive/migration/batches/${b.id}`)).rows.map((r: { status: string; error: string }) => [r.status, r.error])));
    assert.equal(imp.difference, 0);
    const ref = (await h.ok(t.admin!, 'GET', `/golive/migration/batches/${b.id}`)).rows[0].result_ref;
    const jo = (await h.ok(t.admin!, 'GET', `/jobwork/orders?q=${ref}`)).items[0];
    assert.equal(jo.status, 'acknowledged', 'the mill already has the fabric');
    assert.equal(jo.issue_date.slice(0, 10), '2026-03-05');
    assert.equal(jo.statutory_due_date.slice(0, 10), '2027-03-05', '365 days from the original challan');
    const det = await h.ok(t.admin!, 'GET', `/jobwork/orders/${jo.id}`);
    assert.equal(det.lines.length, 2);
    assert.equal(det.reconciliation.kg_balance_at_mill, 1000.5);
    const srt = (await h.ok(t.admin!, 'GET', '/organisation/warehouses')).find((w: { code: string }) => w.code === 'SRT');
    await h.ok(t.admin!, 'POST', `/jobwork/orders/${jo.id}/returns`, { return_date: new Date().toISOString().slice(0, 10), warehouse_id: srt.id, kg_good: 400, kg_process_loss: 20, loss_reason: 'Normal dyeing loss' });
    const after1 = await h.ok(t.admin!, 'GET', `/jobwork/orders/${jo.id}`);
    assert.equal(after1.status, 'partially_returned');
    assert.equal(after1.reconciliation.kg_balance_at_mill, 580.5);
    const again = await h.ok(t.admin!, 'POST', `/golive/migration/batches/${(await load(t.admin!, 'open_job_work', csv)).id}/import`);
    assert.equal(again.difference, 0);
    assert.equal((await h.ok(t.admin!, 'GET', '/jobwork/orders?q=Surat&pageSize=100')).items.filter((o: { instructions: string | null }) => o.instructions?.includes('JWC/0388')).length, 1, 'no duplicate');
  });

  test('GST credit carried forward: posts to input GST and feeds GSTR-3B from its month on', async () => {
    const book = (await h.ok(t.accounts!, 'GET', '/finance/books')).find((x: { is_primary: boolean }) => x.is_primary);
    const month = new Date().toISOString().slice(0, 7);
    const tbRow = await load(t.accounts!, 'opening_gl', `account_code,debit,credit,date\n1502,100,0,2026-04-01\n3100,0,100,2026-04-01`);
    assert.equal(tbRow.invalid, 1, 'input credit cannot also come through the trial balance');
    const b = await load(t.accounts!, 'gst_credit', `gstin,as_of_month,igst,cgst,sgst\n${book.gstin},${month},182500,41250,41250\n27AAAAA0000A1Z5,${month},1,0,0\n${book.gstin},${month},5,1,2`);
    assert.equal(b.valid, 1);
    const imp = await h.ok(t.accounts!, 'POST', `/golive/migration/batches/${b.id}/import`);
    assert.equal(imp.source_total, 265000);
    assert.equal(imp.erp_total, 265000, JSON.stringify((await h.ok(t.accounts!, 'GET', `/golive/migration/batches/${b.id}`)).rows.map((r: { status: string; error: string }) => [r.status, r.error])));
    const g = await h.ok(t.accounts!, 'GET', `/finance/gst/returns?month=${month}&book=${book.id}`);
    assert.deepEqual(g.gstr3b.credit_brought_forward, { igst: 182500, cgst: 41250, sgst: 41250 });
    const prev = new Date(); prev.setUTCDate(1); prev.setUTCMonth(prev.getUTCMonth() - 1);
    const before = await h.ok(t.accounts!, 'GET', `/finance/gst/returns?month=${prev.toISOString().slice(0, 7)}&book=${book.id}`);
    assert.equal(before.gstr3b.credit_brought_forward.igst, 0, 'no credit before the carry-forward month');
    assert.equal((await h.call(t.accounts!, 'POST', '/finance/gst/opening-credit', { gstin: book.gstin, as_of: month, igst: 1, cgst: 0, sgst: 0 })).status, 409, 'different figures are refused');
    assert.ok((await h.ok(t.accounts!, 'GET', '/finance/reports/trial-balance?from=2020-04-01')).balanced);
  });
});

describe('P11 UAT, training, cutover and hypercare', () => {
  test('UAT: one scenario per requirement plus cross-cutting ones; a failure with an S1 defect blocks sign-off until fixed and retested', async () => {
    const all = await h.ok(t.owner!, 'GET', '/golive/uat/scenarios');
    assert.ok(all.length >= 90);
    assert.ok(all.some((s: { category: string }) => s.category === 'concurrency'));
    const s = all.find((x: { requirement_id: string }) => x.requirement_id === 'REQ-0060');
    assert.equal((await h.call(t.sales!, 'POST', `/golive/uat/scenarios/${s.id}/result`, { result: 'failed', evidence: 'x' })).status, 400, 'failure needs a defect');
    const r = await h.ok(t.sales!, 'POST', `/golive/uat/scenarios/${s.id}/result`, { result: 'failed', evidence: 'Dispatched without payment on an advance order', defect: { title: 'Payment gate bypassed', severity: 'S1' } });
    const sum = await h.ok(t.owner!, 'GET', '/golive/uat/summary');
    const p7 = sum.phases.find((p: { phase: string }) => p.phase === 'P7');
    assert.equal(p7.ready, false);
    assert.equal(p7.open_defects.s1, 1);
    assert.equal((await h.call(t.owner!, 'POST', '/golive/uat/signoff', { scope: 'P7', decision: 'approved' })).status, 409);
    await h.ok(t.sales!, 'PATCH', `/golive/uat/defects/${r.defect}`, { status: 'retest', resolution: 'Gate re-checked inside the dispatch transaction' });
    assert.equal((await h.ok(t.owner!, 'GET', `/golive/uat/scenarios/${s.id}`)).status, 'not_run');
    await h.ok(t.sales!, 'POST', `/golive/uat/scenarios/${s.id}/result`, { result: 'passed', evidence: 'Refused with the payment gate message' });
    await h.ok(t.sales!, 'PATCH', `/golive/uat/defects/${r.defect}`, { status: 'closed' });
    // Approving a phase that is not fully run needs recorded conditions.
    const ok = await h.ok(t.owner!, 'POST', '/golive/uat/signoff', { scope: 'P7', decision: 'approved', conditions: 'Remaining P7 scenarios to be run in week 2 of hypercare' });
    assert.equal(ok.criteria.open_defects.s1, 0);
  });

  test('training assignment and completion; readiness criteria report what is missing; go decision needs reasons when not ready', async () => {
    const tr = await h.ok(t.owner!, 'GET', '/golive/training');
    assert.ok(tr.modules.length >= 10);
    const sales = tr.staff.find((u: { email: string }) => u.email === 'sales@textile.local');
    await h.ok(t.owner!, 'POST', '/golive/training/assign', { user_ids: [sales.id], module_codes: ['SAL-1', 'SAL-2'] });
    await h.ok(t.owner!, 'POST', '/golive/training/complete', { user_id: sales.id, module_code: 'SAL-1', score: 90 });
    const rd = await h.ok(t.owner!, 'GET', '/golive/readiness');
    assert.equal(rd.ready, false);
    assert.equal(rd.criteria.find((c: { key: string }) => c.key === 'training').detail, '1 of 2 modules');
    assert.equal((await h.call(t.owner!, 'POST', '/golive/go-decision', { decision: 'go', rollback_plan: 'Restore last night’s backup and resume the legacy system' })).status, 409);
    await h.ok(t.owner!, 'POST', '/golive/go-decision', { decision: 'no_go', rollback_plan: 'Not applicable', notes: 'Finish UAT and training first' });
    assert.equal((await h.ok(t.owner!, 'GET', '/golive/cutover')).decisions[0].decision, 'no_go');
  });

  test('hypercare incidents carry SLA deadlines by severity and need a resolution to close', async () => {
    const i = await h.ok(t.sales!, 'POST', '/golive/incidents', { title: 'Cannot print invoice', description: 'Print preview blank on the dispatch PC', severity: 'P2', module: 'Fulfilment' });
    const list = await h.ok(t.owner!, 'GET', '/golive/incidents');
    const row = list.find((x: { id: string }) => x.id === i.id);
    const hours = (new Date(row.resolve_by).getTime() - new Date(row.created_at).getTime()) / 3_600_000;
    assert.equal(Math.round(hours), 24);
    assert.equal((await h.call(t.owner!, 'PATCH', `/golive/incidents/${i.id}`, { status: 'resolved' })).status, 400);
    await h.ok(t.owner!, 'PATCH', `/golive/incidents/${i.id}`, { status: 'resolved', resolution: 'Browser pop-up blocker; allowed the ERP site' });
  });
});
