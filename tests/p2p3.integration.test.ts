/** End-to-end tests for P2 (procurement, AI invoice workbench, supplier portal) and P3 (job work, mill portal). */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { bootAll } from './harness.ts';
import { runProcurementChecks } from '../services/procurement/src/automation.ts';
import { runJobworkChecks } from '../services/jobwork/src/automation.ts';
import { startCaptureWorker } from '../services/procurement/src/capture.ts';
import { chargeFor } from '../services/jobwork/src/rates.ts';

let h: Awaited<ReturnType<typeof bootAll>>;
const t: Record<string, string> = {};
const ids: Record<string, string> = {};
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

before(async () => {
  h = await bootAll('p2p3');
  for (const [k, email] of Object.entries({ admin: 'admin@textile.local', purchase: 'purchase@textile.local', accounts: 'accounts@textile.local', owner: 'owner@textile.local', millops: 'millops@textile.local', sales: 'sales@textile.local', supplier: 'supplier@ambica.example', mill: 'mill@suratprocess.example' }))
    t[k] = await h.login(email);
  const wh = await h.ok(t.admin!, 'GET', '/organisation/warehouses');
  ids.SRT = wh.find((w: { code: string }) => w.code === 'SRT').id;
  const products = (await h.ok(t.admin!, 'GET', '/masters/products?pageSize=50')).items;
  for (const p of products) ids[p.sku] = p.id;
});
after(async () => h.close());

async function approve(refId: string, token = t.owner!) {
  await h.drain();
  const a = (await h.ok(token, 'GET', '/governance/approvals?f_status=pending&pageSize=50')).items.find((x: { ref_id: string }) => x.ref_id === refId);
  assert.ok(a, 'approval request reached the inbox');
  await h.ok(token, 'POST', `/governance/approvals/${a.id}/decide`, { decision: 'approved', comment: 'ok' });
  await h.drain();
}

describe('P2 procurement', () => {
  test('requisition needs a different approver', async () => {
    const pr = await h.ok(t.purchase!, 'POST', '/procurement/requisitions', { title: 'Jersey top-up', deliver_to_type: 'warehouse', deliver_to_id: ids.SRT, required_by: daysAgo(-10), lines: [{ product_id: ids['SJ-160-NVY'], qty_kg: 1000 }] });
    assert.match(pr.number, /^PR\/2627\/\d{5}$/);
    await h.ok(t.purchase!, 'POST', `/procurement/requisitions/${pr.id}/submit`);
    assert.equal((await h.call(t.purchase!, 'POST', `/procurement/requisitions/${pr.id}/decide`, { decision: 'approved' })).status, 403);
    await h.ok(t.admin!, 'POST', `/procurement/requisitions/${pr.id}/decide`, { decision: 'approved' });
    ids.pr = pr.id;
  });

  test('RFQ compares landed cost and requires a reason to skip the cheapest', async () => {
    const rfq = await h.ok(t.purchase!, 'POST', '/procurement/rfqs', { title: 'Jersey top-up', requisition_id: ids.pr, due_date: daysAgo(-3), deliver_to_type: 'warehouse', deliver_to_id: ids.SRT, supplier_ids: [h.parties['Shree Ambica Knitters'], h.parties['Ganesh Yarn & Fabrics']], lines: [{ product_id: ids['SJ-160-NVY'], qty_kg: 1000 }] });
    const d = await h.ok(t.purchase!, 'GET', `/procurement/rfqs/${rfq.id}`);
    // Ambica cheaper per kg but charges freight; Ganesh is cheaper landed.
    await h.ok(t.purchase!, 'PUT', `/procurement/rfqs/${rfq.id}/quotes`, { supplier_id: h.parties['Shree Ambica Knitters'], freight_per_kg: 5, lead_time_days: 10, lines: [{ rfq_line_id: d.lines[0].id, rate_per_kg: 246 }] });
    await h.ok(t.purchase!, 'PUT', `/procurement/rfqs/${rfq.id}/quotes`, { supplier_id: h.parties['Ganesh Yarn & Fabrics'], freight_per_kg: 0, lead_time_days: 15, lines: [{ rfq_line_id: d.lines[0].id, rate_per_kg: 249 }] });
    assert.equal((await h.call(t.purchase!, 'PUT', `/procurement/rfqs/${rfq.id}/quotes`, { supplier_id: h.parties['Velavan Knit Fab'], lines: [{ rfq_line_id: d.lines[0].id, rate_per_kg: 200 }] })).status, 400, 'uninvited supplier');
    const cmp = (await h.ok(t.purchase!, 'GET', `/procurement/rfqs/${rfq.id}`)).comparison;
    assert.equal(cmp.lowest_landed, h.parties['Ganesh Yarn & Fabrics']);
    assert.equal(cmp.suppliers[0].landed_total, 249000);
    const ambica = cmp.suppliers.find((s: { supplier_id: string }) => s.supplier_id === h.parties['Shree Ambica Knitters']);
    assert.equal((await h.call(t.purchase!, 'POST', `/procurement/rfqs/${rfq.id}/award`, { quote_id: ambica.quote_id, expected_date: daysAgo(-12) })).status, 400);
    const po = await h.ok(t.purchase!, 'POST', `/procurement/rfqs/${rfq.id}/award`, { quote_id: ambica.quote_id, expected_date: daysAgo(-12), reason: 'Faster delivery needed' });
    const detail = await h.ok(t.purchase!, 'GET', `/procurement/purchase-orders/${po.id}`);
    assert.equal(detail.status, 'draft', 'awarding never sends a PO');
    assert.equal(detail.tax_type, 'intra', 'Gujarat supplier billed to Gujarat GSTIN');
  });

  test('PO lifecycle: approval, supplier portal acceptance, receipt tolerance', async () => {
    const po = await h.ok(t.purchase!, 'POST', '/procurement/purchase-orders', { supplier_id: h.parties['Shree Ambica Knitters'], deliver_to_type: 'warehouse', deliver_to_id: ids.SRT, expected_date: daysAgo(-5), lines: [{ product_id: ids['SJ-160-NVY'], qty_kg: 1000, rate_per_kg: 245 }] });
    ids.po = po.id;
    assert.equal((await h.ok(t.purchase!, 'POST', `/procurement/purchase-orders/${po.id}/submit`)).status, 'pending_approval');
    assert.equal((await h.call(t.purchase!, 'POST', `/procurement/purchase-orders/${po.id}/send`)).status, 409, 'cannot send before approval');
    await approve(po.id);
    await h.ok(t.purchase!, 'POST', `/procurement/purchase-orders/${po.id}/send`);
    // supplier portal sees only its own POs and cannot use internal APIs
    assert.equal((await h.call(t.supplier!, 'GET', '/procurement/purchase-orders')).status, 403);
    const mine = await h.ok(t.supplier!, 'GET', '/procurement/portal/supplier/orders');
    assert.ok(mine.some((p: { id: string }) => p.id === po.id));
    assert.ok(mine.every((p: { status: string }) => !['draft', 'pending_approval'].includes(p.status)));
    assert.equal((await h.call(t.supplier!, 'POST', `/procurement/portal/supplier/orders/${po.id}/respond`, { accept: true })).status, 400, 'promise date required');
    await h.ok(t.supplier!, 'POST', `/procurement/portal/supplier/orders/${po.id}/respond`, { accept: true, promise_date: daysAgo(-4) });
    await h.ok(t.supplier!, 'POST', `/procurement/portal/supplier/orders/${po.id}/dispatches`, { dispatch_date: daysAgo(0), kg: 1000, lr_number: 'LR-1' });
    const d = await h.ok(t.purchase!, 'GET', `/procurement/purchase-orders/${po.id}`);
    ids.poLine = d.lines[0].id;
    assert.equal(d.status, 'accepted');
    assert.equal((await h.call(t.purchase!, 'POST', `/procurement/purchase-orders/${po.id}/receipts`, { receipt_date: daysAgo(0), lines: [{ po_line_id: ids.poLine, received_kg: 1100 }] })).status, 400, 'over-receipt beyond 2% tolerance');
    const grn = await h.ok(t.purchase!, 'POST', `/procurement/purchase-orders/${po.id}/receipts`, { receipt_date: daysAgo(0), lines: [{ po_line_id: ids.poLine, received_kg: 600, rejected_kg: 10 }] });
    assert.match(grn.number, /^GRN\/2627\/\d{5}$/);
    assert.equal((await h.ok(t.purchase!, 'GET', `/procurement/purchase-orders/${po.id}`)).status, 'partially_received');
  });

  test('three-way match holds billing beyond receipt; variance needs a checker', async () => {
    const inv = await h.ok(t.purchase!, 'POST', '/procurement/invoices', { supplier_id: h.parties['Shree Ambica Knitters'], invoice_number: 'SAK/001', invoice_date: daysAgo(0), po_id: ids.po, taxable_value: 245000, cgst: 6125, sgst: 6125, total_value: 257250, lines: [{ description: 'SJ navy', qty_kg: 1000, rate: 245, gst_rate: 5 }] });
    const d = await h.ok(t.purchase!, 'GET', `/procurement/invoices/${inv.id}`);
    assert.equal(d.match_status, 'variance');
    assert.ok(d.match_result.some((i: { code: string }) => i.code === 'qty_exceeds_receipt'));
    assert.equal((await h.call(t.purchase!, 'POST', '/procurement/invoices', { supplier_id: h.parties['Shree Ambica Knitters'], invoice_number: 'sak/ 001', invoice_date: daysAgo(0), taxable_value: 1, total_value: 1, lines: [{ description: 'x', qty_kg: 1, rate: 1 }] })).status, 409, 'duplicate number (case/space-insensitive)');
    assert.equal((await h.call(t.admin!, 'POST', `/procurement/invoices/${inv.id}/post`, {})).status, 400, 'variance needs a reason');
    assert.equal((await h.ok(t.admin!, 'POST', `/procurement/invoices/${inv.id}/post`, { reason: 'Balance 400 kg arriving tomorrow' })).status, 'pending_approval');
    await approve(inv.id);
    const posted = await h.ok(t.purchase!, 'GET', `/procurement/invoices/${inv.id}`);
    assert.equal(posted.status, 'posted');
    assert.equal(posted.ledger[0].credit, 257250);
    const ap = await h.ok(t.accounts!, 'GET', '/procurement/ap/summary');
    assert.equal(ap.totals.outstanding, 257250);
    await h.ok(t.accounts!, 'POST', `/procurement/invoices/${inv.id}/approve-payment`);
    await assert.rejects(h.svc('procurement').ctx.pool.query('DELETE FROM ap_ledger'), /append-only/);
  });

  test('matched invoice posts directly but never by the person who entered it', async () => {
    const po = await h.ok(t.purchase!, 'POST', '/procurement/purchase-orders', { supplier_id: h.parties['Velavan Knit Fab'], deliver_to_type: 'warehouse', deliver_to_id: ids.SRT, expected_date: daysAgo(-5), lines: [{ product_id: ids['INT-220-RFD'], qty_kg: 500, rate_per_kg: 200 }] });
    await h.ok(t.purchase!, 'POST', `/procurement/purchase-orders/${po.id}/submit`);
    await approve(po.id);
    await h.ok(t.purchase!, 'POST', `/procurement/purchase-orders/${po.id}/send`);
    const line = (await h.ok(t.purchase!, 'GET', `/procurement/purchase-orders/${po.id}`)).lines[0];
    await h.ok(t.purchase!, 'POST', `/procurement/purchase-orders/${po.id}/receipts`, { receipt_date: daysAgo(0), lines: [{ po_line_id: line.id, received_kg: 500 }] });
    // Inter-state (Tamil Nadu supplier, Gujarat GSTIN): IGST
    const inv = await h.ok(t.admin!, 'POST', '/procurement/invoices', { supplier_id: h.parties['Velavan Knit Fab'], invoice_number: 'VKF-9', invoice_date: daysAgo(0), po_id: po.id, taxable_value: 100000, igst: 5000, total_value: 105000, lines: [{ description: 'Interlock', qty_kg: 500, rate: 200, gst_rate: 5 }] });
    assert.equal((await h.ok(t.admin!, 'GET', `/procurement/invoices/${inv.id}`)).match_status, 'matched');
    assert.equal((await h.call(t.admin!, 'POST', `/procurement/invoices/${inv.id}/post`, {})).status, 403, 'maker-checker');
    assert.equal((await h.call(t.purchase!, 'POST', `/procurement/invoices/${inv.id}/post`, {})).status, 403, 'purchase role cannot post');
    assert.equal((await h.ok(t.owner!, 'POST', `/procurement/invoices/${inv.id}/post`, {})).status, 'posted');
    const wrongTax = await h.ok(t.admin!, 'POST', '/procurement/invoices', { supplier_id: h.parties['Velavan Knit Fab'], invoice_number: 'VKF-10', invoice_date: daysAgo(0), po_id: po.id, taxable_value: 100, cgst: 2.5, sgst: 2.5, total_value: 105, lines: [{ description: 'Interlock', qty_kg: 0.5, rate: 200, gst_rate: 5 }] });
    assert.ok((await h.ok(t.admin!, 'GET', `/procurement/invoices/${wrongTax.id}`)).match_result.some((i: { code: string }) => i.code === 'tax_type'));
  });

  test('invoice workbench: upload, review with corrections, approve into a draft invoice', async () => {
    const worker = startCaptureWorker(h.svc('procurement').ctx.pool, { intervalMs: 60_000 });
    const batch = await h.ok(t.purchase!, 'POST', '/procurement/captures/batches', { name: 'October invoices' });
    const pdf = Buffer.from('%PDF-1.4\n%%EOF\n');
    assert.equal((await h.call(t.purchase!, 'POST', `/procurement/captures/batches/${batch.id}/files`, Buffer.from('hello'), { 'content-type': 'text/plain', 'x-file-name': 'a.txt' })).status, 400);
    const cap = await h.ok(t.purchase!, 'POST', `/procurement/captures/batches/${batch.id}/files`, pdf, { 'content-type': 'application/pdf', 'x-file-name': 'ambica-002.pdf' });
    await worker.tick();
    await new Promise((r) => setTimeout(r, 300));
    worker.stop();
    const c1 = await h.ok(t.purchase!, 'GET', `/procurement/captures/${cap.id}`);
    assert.equal(c1.status, 'needs_review');
    assert.equal(c1.extractor, process.env.ANTHROPIC_API_KEY ? 'claude' : 'manual');
    const po = await h.ok(t.purchase!, 'GET', `/procurement/purchase-orders/${ids.po}`);
    const data = { supplier_id: null, supplier_name: null, supplier_gstin: po.supplier_gstin, buyer_gstin: '27AAPFU0939F1ZV', invoice_number: 'SAK/002', invoice_date: daysAgo(0), po_id: null, po_reference: po.number,
      taxable_value: 100, cgst: 2.5, sgst: 2.5, igst: 0, total_value: 105, lines: [{ description: 'SJ navy', hsn_code: '6006', qty_kg: 0.5, unit: 'KG', rate: 200, gst_rate: 5 }] };
    const saved = await h.ok(t.purchase!, 'PUT', `/procurement/captures/${cap.id}`, data);
    assert.equal(saved.data.supplier_id, h.parties['Shree Ambica Knitters'], 'supplier linked from GSTIN');
    assert.equal(saved.data.po_id, ids.po, 'PO linked from reference');
    assert.ok(saved.warnings.some((w: { field: string; severity: string }) => w.field === 'buyer_gstin' && w.severity === 'critical'), 'billed to a foreign GSTIN');
    assert.equal((await h.call(t.purchase!, 'POST', `/procurement/captures/${cap.id}/approve`, data)).status, 400, 'critical warning blocks approval');
    const fixed = { ...data, buyer_gstin: po.bill_to_gstin };
    const appr = await h.ok(t.purchase!, 'POST', `/procurement/captures/${cap.id}/approve`, fixed);
    const inv = await h.ok(t.purchase!, 'GET', `/procurement/invoices/${appr.invoice_id}`);
    assert.equal(inv.status, 'draft', 'workbench never posts');
    assert.equal(inv.capture_id, cap.id);
    const hist = (await h.ok(t.purchase!, 'GET', `/procurement/captures/${cap.id}`)).history;
    assert.ok(hist.some((x: { field: string }) => x.field === 'buyer_gstin'), 'corrections are recorded');
  });

  test('automation flags POs not accepted and receipts without invoices', async () => {
    const pool = h.svc('procurement').ctx.pool;
    const po = await h.ok(t.purchase!, 'POST', '/procurement/purchase-orders', { supplier_id: h.parties['Ganesh Yarn & Fabrics'], deliver_to_type: 'warehouse', deliver_to_id: ids.SRT, expected_date: daysAgo(-5), lines: [{ product_id: ids['SJ-180-BLK'], qty_kg: 100, rate_per_kg: 260 }] });
    await h.ok(t.purchase!, 'POST', `/procurement/purchase-orders/${po.id}/submit`);
    await approve(po.id);
    await h.ok(t.purchase!, 'POST', `/procurement/purchase-orders/${po.id}/send`);
    await pool.query(`UPDATE purchase_orders SET sent_at = now() - interval '3 days' WHERE id = $1`, [po.id]);
    await runProcurementChecks(pool);
    assert.ok((await h.ok(t.purchase!, 'GET', '/procurement/exceptions')).some((e: { kind: string; ref_id: string }) => e.kind === 'po_not_accepted' && e.ref_id === po.id));
    const line = (await h.ok(t.purchase!, 'GET', `/procurement/purchase-orders/${po.id}`)).lines[0];
    await h.ok(t.purchase!, 'POST', `/procurement/purchase-orders/${po.id}/receipts`, { receipt_date: daysAgo(30), lines: [{ po_line_id: line.id, received_kg: 100 }] });
    await runProcurementChecks(pool);
    const ex = await h.ok(t.purchase!, 'GET', '/procurement/exceptions');
    assert.ok(!ex.some((e: { kind: string; ref_id: string }) => e.kind === 'po_not_accepted' && e.ref_id === po.id), 'receipt resolves the acceptance exception');
    assert.ok(ex.some((e: { kind: string; ref_id: string }) => e.kind === 'missing_invoice' && e.ref_id === po.id));
    await h.drain();
    const notes = await h.ok(t.purchase!, 'GET', '/governance/notifications');
    assert.ok(notes.some((n: { title: string }) => /has not accepted/.test(n.title)), 'buyer notified');
  });
});

describe('P3 job work', () => {
  test('direct-to-mill receipt on the mill portal becomes grey stock at that mill', async () => {
    const po = await h.ok(t.purchase!, 'POST', '/procurement/purchase-orders', { supplier_id: h.parties['Velavan Knit Fab'], deliver_to_type: 'mill', deliver_to_id: h.parties['Surat Process House'], expected_date: daysAgo(-5), lines: [{ product_id: ids['SJ-140-MEL'], qty_kg: 2000, rate_per_kg: 210 }] });
    await h.ok(t.purchase!, 'POST', `/procurement/purchase-orders/${po.id}/submit`);
    await approve(po.id);
    await h.ok(t.purchase!, 'POST', `/procurement/purchase-orders/${po.id}/send`);
    const incoming = await h.ok(t.mill!, 'GET', '/procurement/portal/mill/incoming');
    const mine = incoming.find((p: { id: string }) => p.id === po.id);
    assert.ok(mine);
    await h.ok(t.mill!, 'POST', `/procurement/portal/mill/incoming/${po.id}/receive`, { receipt_date: daysAgo(0), lines: [{ po_line_id: mine.lines[0].id, received_kg: 1990, rolls: 80 }] });
    await h.drain();
    const stock = await h.ok(t.millops!, 'GET', `/jobwork/mill-stock?millId=${h.parties['Surat Process House']}`);
    assert.equal(stock.length, 1);
    assert.equal(stock[0].kg_available, 1990);
    ids.stock = stock[0].id;
  });

  test('rate engine: history, product-specific override and slabs', async () => {
    const mill = h.parties['Surat Process House'];
    await h.ok(t.millops!, 'POST', '/jobwork/rate-cards', { mill_id: mill, process_code: 'REACTIVE_DYE', basis: 'per_kg', rate: 36, min_charge: 5000, effective_from: daysAgo(100) });
    await h.ok(t.millops!, 'POST', '/jobwork/rate-cards', { mill_id: mill, process_code: 'REACTIVE_DYE', basis: 'per_kg', rate: 38, min_charge: 5000, effective_from: daysAgo(10) });
    const cards = await h.ok(t.millops!, 'GET', `/jobwork/rate-cards?millId=${mill}`);
    assert.equal(cards.find((c: { rate: number }) => c.rate === 36).effective_to, daysAgo(11), 'previous rate closed the day before');
    const q = await h.ok(t.millops!, 'GET', `/jobwork/rate-quote?millId=${mill}&processCode=REACTIVE_DYE&productId=${ids['SJ-140-MEL']}&kg=100`);
    assert.equal(q.charge, 5000, 'minimum charge applies');
    await h.ok(t.millops!, 'POST', '/jobwork/rate-cards', { mill_id: mill, process_code: 'REACTIVE_DYE', product_id: ids['SJ-140-MEL'], basis: 'per_kg', rate: 34, effective_from: daysAgo(5), negotiated: true });
    assert.equal((await h.ok(t.millops!, 'GET', `/jobwork/rate-quote?millId=${mill}&processCode=REACTIVE_DYE&productId=${ids['SJ-140-MEL']}&kg=1000`)).charge, 34000, 'product-specific rate wins');
    const slab = { id: 'x', mill_id: mill!, process_code: 'X', product_id: null, category_id: null, basis: 'slab' as const, rate: null, slabs: [{ upto_kg: 1000, rate: 42 }, { upto_kg: null, rate: 37 }], min_charge: 0, negotiated: false, effective_from: '', effective_to: null };
    assert.equal(chargeFor(slab, 800), 33600);
    assert.equal(chargeFor(slab, 2000), 74000);
  });

  test('job-work cycle: allocation, mill acknowledgement, stages, return, yield and claim', async () => {
    const mill = h.parties['Surat Process House'];
    assert.equal((await h.call(t.millops!, 'POST', '/jobwork/orders', { mill_id: mill, process_code: 'REACTIVE_DYE', expected_return_date: daysAgo(-7), lines: [{ source: 'mill_stock', mill_stock_id: ids.stock, kg_sent: 5000 }] })).status, 400, 'cannot allocate more than is at the mill');
    assert.equal((await h.call(t.millops!, 'POST', '/jobwork/orders', { mill_id: h.parties['Palladam Compacting Works'], process_code: 'REACTIVE_DYE', expected_return_date: daysAgo(-7), lines: [{ source: 'mill_stock', mill_stock_id: ids.stock, kg_sent: 100 }] })).status, 400, 'grey stock is at a different mill');
    const jw = await h.ok(t.millops!, 'POST', '/jobwork/orders', { mill_id: mill, process_code: 'REACTIVE_DYE', expected_return_date: daysAgo(-7), lines: [{ source: 'mill_stock', mill_stock_id: ids.stock, kg_sent: 1990, rolls: 80 }] });
    let d = await h.ok(t.millops!, 'GET', `/jobwork/orders/${jw.id}`);
    assert.equal(d.estimated_charge, 67660, 'product-specific ₹34/kg × 1990 kg');
    assert.equal((await h.ok(t.millops!, 'GET', `/jobwork/mill-stock?millId=${mill}`)).length, 0, 'fully allocated');
    await h.ok(t.millops!, 'POST', `/jobwork/orders/${jw.id}/issue`, { issue_date: daysAgo(1) });
    d = await h.ok(t.millops!, 'GET', `/jobwork/orders/${jw.id}`);
    assert.equal(d.statutory_due_date, new Date(Date.now() + 364 * 86_400_000).toISOString().slice(0, 10));
    assert.ok(d.internal_due_date < d.expected_return_date, 'operational clock runs ahead of the commercial one');
    // other mills cannot see it
    assert.equal((await h.call(t.mill!, 'GET', `/jobwork/orders/${jw.id}`)).status, 403);
    assert.equal((await h.call(t.mill!, 'POST', `/jobwork/portal/mill/jobs/${jw.id}/stages`, { stage_code: 'DYEING', status: 'started' })).status, 409, 'acknowledge first');
    assert.equal((await h.call(t.mill!, 'POST', `/jobwork/portal/mill/jobs/${jw.id}/acknowledge`, { kg_received: 1950 })).status, 400, 'discrepancy needs remarks');
    await h.ok(t.mill!, 'POST', `/jobwork/portal/mill/jobs/${jw.id}/acknowledge`, { kg_received: 1950, remarks: 'Two rolls missing from the lorry' });
    const ex = await h.ok(t.millops!, 'GET', '/jobwork/exceptions');
    assert.ok(ex.some((e: { kind: string }) => e.kind === 'mill_receipt_discrepancy'));
    await h.ok(t.mill!, 'POST', `/jobwork/portal/mill/jobs/${jw.id}/stages`, { stage_code: 'DYEING', status: 'completed' });
    assert.equal((await h.call(t.mill!, 'POST', `/jobwork/portal/mill/jobs/${jw.id}/stages`, { stage_code: 'PRINTING', status: 'started' })).status, 400, 'stage not in this process');
    await h.ok(t.mill!, 'POST', `/jobwork/portal/mill/jobs/${jw.id}/ready`, { note: 'Packed' });
    const portalView = await h.ok(t.mill!, 'GET', `/jobwork/portal/mill/jobs/${jw.id}`);
    assert.equal(portalView.estimated_charge, undefined, 'internal costing not shown to the mill');
    assert.equal((await h.call(t.millops!, 'POST', `/jobwork/orders/${jw.id}/returns`, { return_date: daysAgo(0), warehouse_id: ids.SRT, kg_good: 3000 })).status, 400, 'cannot return more than sent');
    assert.equal((await h.call(t.millops!, 'POST', `/jobwork/orders/${jw.id}/returns`, { return_date: daysAgo(0), warehouse_id: ids.SRT, kg_good: 1600, kg_rejected: 200 })).status, 400, 'loss needs a reason');
    const ret = await h.ok(t.millops!, 'POST', `/jobwork/orders/${jw.id}/returns`, { return_date: daysAgo(0), warehouse_id: ids.SRT, kg_good: 1600, kg_rejected: 200, kg_process_loss: 150, loss_reason: 'Shade mismatch' });
    assert.equal(ret.reconciliation.kg_balance_at_mill, 40);
    assert.equal(ret.reconciliation.yield_pct, 82.05);
    assert.equal(ret.charge, 61200, '₹34 × (1600 good + 200 rejected)');
    assert.ok((await h.ok(t.millops!, 'GET', '/jobwork/exceptions')).some((e: { kind: string }) => e.kind === 'low_yield'));
    const claim = await h.ok(t.millops!, 'POST', '/jobwork/claims', { job_order_id: jw.id, defect_types: ['Shade variation'], description: 'Shade off on 8 rolls', kg_affected: 200, amount: 6800 });
    await h.ok(t.mill!, 'POST', `/jobwork/portal/mill/claims/${claim.id}/respond`, { response: 'Will re-dye at no cost' });
    assert.equal((await h.call(t.millops!, 'POST', `/jobwork/orders/${jw.id}/close`, {})).status, 400, 'unaccounted 40 kg needs a reason');
    assert.equal((await h.call(t.millops!, 'POST', `/jobwork/orders/${jw.id}/close`, { reason: 'Short-received at mill, see claim' })).status, 409, 'open claim blocks closing');
    await h.ok(t.millops!, 'PATCH', `/jobwork/claims/${claim.id}`, { status: 'closed', responsibility: 'mill', claim_type: 'rework', amount: 0, resolution: 'Mill re-dyed 200 kg free of charge' });
    await h.ok(t.millops!, 'POST', `/jobwork/orders/${jw.id}/close`, { reason: 'Short-received at mill, see claim' });
    assert.equal((await h.ok(t.millops!, 'GET', `/jobwork/orders/${jw.id}`)).status, 'closed');
  });

  test('deadline clocks and overdue automation', async () => {
    const jw = await h.ok(t.millops!, 'POST', '/jobwork/orders', { mill_id: h.parties['Palladam Compacting Works'], process_code: 'COMPACT_ONLY', expected_return_date: daysAgo(1), lines: [{ source: 'warehouse', warehouse_id: ids.SRT, product_id: ids['RIB-240-NVY'], kg_sent: 300 }] });
    await h.ok(t.millops!, 'POST', `/jobwork/orders/${jw.id}/issue`, { issue_date: daysAgo(6) });
    await runJobworkChecks(h.svc('jobwork').ctx.pool);
    const ex = await h.ok(t.millops!, 'GET', '/jobwork/exceptions');
    assert.ok(ex.some((e: { kind: string; ref_id: string }) => e.kind === 'mill_ack_overdue' && e.ref_id === jw.id));
    assert.ok(ex.some((e: { kind: string; ref_id: string }) => e.kind === 'operational_overdue' && e.ref_id === jw.id));
    const dl = await h.ok(t.millops!, 'GET', '/jobwork/deadlines');
    const row = dl.orders.find((o: { id: string }) => o.id === jw.id);
    assert.ok(row.operational_days < 0 && row.commercial_days < 0 && row.statutory_days > 300);
    assert.equal((await h.call(t.sales!, 'GET', '/jobwork/deadlines')).status, 403);
  });
});
