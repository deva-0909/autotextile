/**
 * Loads example procurement and job-work activity through the services' own APIs,
 * so the demo data is validated, numbered and audited exactly like real use.
 */
import type { AddressInfo } from 'node:net';
import { type RunningService, type ServiceName, setServicePorts } from '@erp/platform';
import { DEMO_PASSWORD } from './seed-data.ts';
import { runProcurementChecks } from '../services/procurement/src/automation.ts';
import { runJobworkChecks } from '../services/jobwork/src/automation.ts';
import { runCrmChecks } from '../services/crm/src/automation.ts';

export async function seedOperations(services: RunningService[]) {
  const ports: Partial<Record<ServiceName, number>> = {};
  const servers = services.map((s) => {
    const srv = s.app.listen(0);
    ports[s.ctx.name] = (srv.address() as AddressInfo).port;
    return srv;
  });
  setServicePorts(ports);
  const drain = async () => { for (let i = 0; i < 2; i++) for (const s of services) await s.consumer?.drain(); };
  const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
  const inDays = (n: number) => daysAgo(-n);

  async function call<T = any>(svc: ServiceName, token: string | null, method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
    const raw = body instanceof Buffer;
    const r = await fetch(`http://127.0.0.1:${ports[svc]}${path}`, {
      method,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined && !raw ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body === undefined ? undefined : raw ? new Blob([body]) : JSON.stringify(body),
    });
    const json = await r.json().catch(() => null);
    if (!r.ok) throw new Error(`${method} ${svc}${path} → ${r.status} ${JSON.stringify(json)}`);
    return json as T;
  }
  const login = async (email: string) => (await call('identity', null, 'POST', '/auth/login', { email, password: DEMO_PASSWORD })).accessToken as string;

  try {
    const admin = await login('admin@textile.local');
    const purchase = await login('purchase@textile.local');
    const accounts = await login('accounts@textile.local');
    const millops = await login('millops@textile.local');
    const supplierPortal = await login('supplier@ambica.example');
    const millPortal = await login('mill@suratprocess.example');
    const stores = await login('surat.stores@textile.local');
    const salesMgr = await login('salesmgr@textile.local');
    const salesWest = await login('sales@textile.local');
    const salesSouth = await login('sales.south@textile.local');

    const wh = await call<{ id: string; code: string }[]>('organisation', admin, 'GET', '/warehouses');
    const SRT = wh.find((w) => w.code === 'SRT')!.id;
    const KOL = wh.find((w) => w.code === 'KOL')!.id;
    const parties = (await call<{ items: { id: string; legal_name: string }[] }>('masters', admin, 'GET', '/parties?pageSize=100')).items;
    const party = (name: string) => parties.find((p) => p.legal_name === name)!.id;
    const products = (await call<{ items: { id: string; sku: string }[] }>('masters', admin, 'GET', '/products?pageSize=100')).items;
    const sku = (s: string) => products.find((p) => p.sku === s)!.id;
    const approveAll = async () => {
      await drain();
      const pending = await call<{ items: { id: string; requested_by: string }[] }>('governance', admin, 'GET', '/approvals?f_status=pending&pageSize=50');
      return pending;
    };

    // 1. Requisition → RFQ with two quotes (left open for comparison)
    const pr = await call('procurement', purchase, 'POST', '/requisitions', {
      title: 'Navy & black jersey for Diwali programme', deliver_to_type: 'warehouse', deliver_to_id: SRT, required_by: inDays(20), purpose: 'Customer bookings from Tiruppur exporters',
      lines: [{ product_id: sku('SJ-160-NVY'), qty_kg: 2000, target_rate: 248 }, { product_id: sku('SJ-180-BLK'), qty_kg: 1500, target_rate: 262 }],
    });
    await call('procurement', purchase, 'POST', `/requisitions/${pr.id}/submit`);
    await call('procurement', admin, 'POST', `/requisitions/${pr.id}/decide`, { decision: 'approved', comment: 'Within budget' });
    const rfq = await call('procurement', purchase, 'POST', '/rfqs', {
      title: 'Navy & black jersey for Diwali programme', requisition_id: pr.id, due_date: inDays(3), deliver_to_type: 'warehouse', deliver_to_id: SRT,
      terms: 'Delivery to Surat, 45 days credit', supplier_ids: [party('Shree Ambica Knitters'), party('Ganesh Yarn & Fabrics'), party('Velavan Knit Fab')],
      lines: [{ product_id: sku('SJ-160-NVY'), qty_kg: 2000 }, { product_id: sku('SJ-180-BLK'), qty_kg: 1500 }],
    });
    const rfqDetail = await call('procurement', purchase, 'GET', `/rfqs/${rfq.id}`);
    const [l1, l2] = rfqDetail.lines;
    await call('procurement', purchase, 'PUT', `/rfqs/${rfq.id}/quotes`, { supplier_id: party('Shree Ambica Knitters'), quote_ref: 'SAK/Q/2231', lead_time_days: 12, freight_per_kg: 2.5, payment_terms: '45 days', lines: [{ rfq_line_id: l1.id, rate_per_kg: 246 }, { rfq_line_id: l2.id, rate_per_kg: 259 }] });
    await call('procurement', purchase, 'PUT', `/rfqs/${rfq.id}/quotes`, { supplier_id: party('Ganesh Yarn & Fabrics'), quote_ref: 'GYF-118', lead_time_days: 18, freight_per_kg: 0, payment_terms: '30 days', lines: [{ rfq_line_id: l1.id, rate_per_kg: 249 }, { rfq_line_id: l2.id, rate_per_kg: 258 }] });

    // 2. Completed warehouse PO: approved, sent, accepted on the supplier portal, received, invoiced and posted
    const po1 = await call('procurement', purchase, 'POST', '/purchase-orders', {
      supplier_id: party('Shree Ambica Knitters'), deliver_to_type: 'warehouse', deliver_to_id: SRT, expected_date: daysAgo(3), freight_terms: 'Freight included',
      lines: [{ product_id: sku('SJ-160-NVY'), qty_kg: 1200, rate_per_kg: 245 }, { product_id: sku('RIB-240-NVY'), qty_kg: 600, rate_per_kg: 288 }],
    });
    await call('procurement', purchase, 'POST', `/purchase-orders/${po1.id}/submit`);
    await approveAll();
    const decide = async (refId: string) => {
      await drain();
      const list = await call<{ items: { id: string; ref_id: string }[] }>('governance', admin, 'GET', '/approvals?f_status=pending&pageSize=50');
      const a = list.items.find((x) => x.ref_id === refId)!;
      await call('governance', admin, 'POST', `/approvals/${a.id}/decide`, { decision: 'approved', comment: 'Rates in line with last purchase' });
      await drain();
    };
    await decide(po1.id);
    await call('procurement', purchase, 'POST', `/purchase-orders/${po1.id}/send`);
    await call('procurement', supplierPortal, 'POST', `/portal/supplier/orders/${po1.id}/respond`, { accept: true, promise_date: daysAgo(4), remarks: 'Will ship in two lots' });
    await call('procurement', supplierPortal, 'POST', `/portal/supplier/orders/${po1.id}/dispatches`, { dispatch_date: daysAgo(6), kg: 1800, rolls: 72, lr_number: 'VRL-558123', transporter_name: 'VRL Logistics', eway_bill_no: '381234567890' });
    const po1d = await call('procurement', purchase, 'GET', `/purchase-orders/${po1.id}`);
    await call('procurement', purchase, 'POST', `/purchase-orders/${po1.id}/receipts`, { receipt_date: daysAgo(4), challan_no: 'SAK/DC/914', lr_number: 'VRL-558123',
      lines: [{ po_line_id: po1d.lines[0].id, received_kg: 1196.5, rejected_kg: 0, rolls: 48 }, { po_line_id: po1d.lines[1].id, received_kg: 600, rejected_kg: 12, rolls: 24, remarks: 'Two rolls with needle lines' }] });
    const inv1 = await call('procurement', purchase, 'POST', '/invoices', {
      supplier_id: party('Shree Ambica Knitters'), invoice_number: 'SAK/26-27/0418', invoice_date: daysAgo(4), po_id: po1.id,
      taxable_value: 462486.5, cgst: 11562.16, sgst: 11562.16, igst: 0, total_value: 485610.82,
      lines: [{ description: 'Single jersey 160 GSM navy', hsn_code: '6006', qty_kg: 1196.5, rate: 245, gst_rate: 5 }, { description: '2x2 rib 240 GSM navy', hsn_code: '6006', qty_kg: 588, rate: 288, gst_rate: 5 }],
    });
    await call('procurement', admin, 'POST', `/invoices/${inv1.id}/post`, {});
    await call('procurement', accounts, 'POST', `/invoices/${inv1.id}/approve-payment`);

    // 3. Direct-to-mill PO: grey melange goes straight to Surat Process House; the mill confirms receipt on its portal
    const po2 = await call('procurement', purchase, 'POST', '/purchase-orders', {
      supplier_id: party('Velavan Knit Fab'), deliver_to_type: 'mill', deliver_to_id: party('Surat Process House'), expected_date: daysAgo(8),
      bill_to_gst_registration_id: null, freight_terms: 'Supplier to deliver to mill', notes: 'Grey for reactive dyeing — deliver directly to Surat Process House',
      lines: [{ product_id: sku('SJ-140-MEL'), qty_kg: 3000, rate_per_kg: 212 }],
    });
    await call('procurement', purchase, 'POST', `/purchase-orders/${po2.id}/submit`);
    await decide(po2.id);
    await call('procurement', purchase, 'POST', `/purchase-orders/${po2.id}/send`);
    const po2d = await call('procurement', purchase, 'GET', `/purchase-orders/${po2.id}`);
    await call('procurement', millPortal, 'POST', `/portal/mill/incoming/${po2.id}/receive`, { receipt_date: daysAgo(9), challan_no: 'VKF/DC/2207', lines: [{ po_line_id: po2d.lines[0].id, received_kg: 2950, rejected_kg: 0, rolls: 118 }] });
    await drain();
    // Supplier billed a higher rate than agreed → held for review.
    await call('procurement', purchase, 'POST', '/invoices', {
      supplier_id: party('Velavan Knit Fab'), invoice_number: 'VKF-2627-1093', invoice_date: daysAgo(8), po_id: po2.id,
      taxable_value: 637937.5, cgst: 0, sgst: 0, igst: 31896.88, total_value: 669834.38,
      lines: [{ description: 'Grey melange single jersey 140 GSM', hsn_code: '6006', qty_kg: 2950, rate: 216.25, gst_rate: 5 }],
    });

    // 4. A PO awaiting approval, for the approvals inbox
    const po3 = await call('procurement', purchase, 'POST', '/purchase-orders', {
      supplier_id: party('Ganesh Yarn & Fabrics'), deliver_to_type: 'warehouse', deliver_to_id: SRT, expected_date: inDays(15),
      lines: [{ product_id: sku('SJL-200-WHT'), qty_kg: 900, rate_per_kg: 318 }],
    });
    await call('procurement', purchase, 'POST', `/purchase-orders/${po3.id}/submit`);

    // 5. Mill rate cards (per-KG, slab and fixed+minimum)
    await call('jobwork', millops, 'POST', '/rate-cards', { mill_id: party('Surat Process House'), process_code: 'REACTIVE_DYE', basis: 'per_kg', rate: 36, min_charge: 5000, effective_from: daysAgo(200), notes: 'Annual contract' });
    await call('jobwork', millops, 'POST', '/rate-cards', { mill_id: party('Surat Process House'), process_code: 'REACTIVE_DYE', basis: 'per_kg', rate: 38, min_charge: 5000, effective_from: daysAgo(30), negotiated: true, notes: 'Revised for dye cost increase' });
    await call('jobwork', millops, 'POST', '/rate-cards', { mill_id: party('Tiruppur Dyeing & Finishing'), process_code: 'REACTIVE_DYE', basis: 'slab', slabs: [{ upto_kg: 1000, rate: 42 }, { upto_kg: 3000, rate: 39 }, { upto_kg: null, rate: 37 }], min_charge: 4000, effective_from: daysAgo(90) });
    await call('jobwork', millops, 'POST', '/rate-cards', { mill_id: party('Palladam Compacting Works'), process_code: 'COMPACT_ONLY', basis: 'per_kg', rate: 6.5, min_charge: 2500, effective_from: daysAgo(90) });

    // 6. Job work on the grey at Surat Process House (direct-to-mill material), in process
    const stock = await call<{ id: string; kg_available: number }[]>('jobwork', millops, 'GET', `/mill-stock?millId=${party('Surat Process House')}`);
    const jw1 = await call('jobwork', millops, 'POST', '/orders', { mill_id: party('Surat Process House'), process_code: 'REACTIVE_DYE', expected_return_date: inDays(4), instructions: 'Dye to shade NAVY-118, bio-wash, compact to 160 GSM', lines: [{ source: 'mill_stock', mill_stock_id: stock[0]!.id, kg_sent: 2950, rolls: 118, lot_ref: 'G-VKF-2207' }] });
    await call('jobwork', millops, 'POST', `/orders/${jw1.id}/issue`, { issue_date: daysAgo(8) });
    await call('jobwork', millPortal, 'POST', `/portal/mill/jobs/${jw1.id}/acknowledge`, { kg_received: 2950 });
    for (const [code, status] of [['INSPECTION', 'completed'], ['PRETREATMENT', 'completed'], ['DYEING', 'completed'], ['WASHING', 'started']] as const)
      await call('jobwork', millPortal, 'POST', `/portal/mill/jobs/${jw1.id}/stages`, { stage_code: code, status });

    // ---------- P4 helpers: weigh/scan rolls, grade, put away ----------
    const weights = (n: number, base: number, total?: number) => {
      const w = Array.from({ length: n }, (_, i) => Math.round((base + (((i * 37) % 11) - 5) * 0.12) * 10) / 10);
      if (total) w[n - 1] = Math.round((total - w.slice(0, -1).reduce((a, b) => a + b, 0)) * 10) / 10;
      return w;
    };
    async function scanInward(inwardId: string, perLine: { weights: number[]; dye_lot?: string; shade?: string; gsm?: number; width?: number }[]) {
      const d = await call('inventory', stores, 'GET', `/inwards/${inwardId}`);
      const out: { barcode: string; lot_id: string }[][] = [];
      for (const [i, l] of perLine.entries()) {
        const rolls = [];
        for (const w of l.weights) rolls.push(await call('inventory', stores, 'POST', `/inwards/${inwardId}/rolls`, { line_id: d.lines[i].id, weight_kg: w, dye_lot: l.dye_lot ?? null, shade_code: l.shade ?? null, gsm: l.gsm ?? null, width_in: l.width ?? null }));
        out.push(rolls);
      }
      return out;
    }
    const grade = (rolls: { barcode: string }[], g: (i: number) => 'A' | 'B' | 'C' | 'reject' = () => 'A', defects: (i: number) => string[] = () => []) =>
      call('inventory', stores, 'POST', '/qc', { results: rolls.map((r, i) => ({ barcode: r.barcode, grade: g(i), defects: defects(i) })) });
    const srtMap = await call('inventory', stores, 'GET', `/warehouses/${SRT}/map`);
    const bins = srtMap.locations.filter((l: { kind: string; purpose: string }) => l.kind === 'bin' && l.purpose === 'storage').map((l: { id: string }) => l.id);
    let binIx = 0;
    const putaway = async (rolls: { barcode: string }[], per = 8) => {
      for (let i = 0; i < rolls.length; i += per) await call('inventory', stores, 'POST', '/putaway', { barcodes: rolls.slice(i, i + per).map((r) => r.barcode), location_id: bins[binIx++ % bins.length] });
    };
    async function opening(sku_: string, n: number, base: number, cost: number, days: number, ref: string, opts: { total?: number; dye_lot?: string; shade?: string; price?: number } = {}) {
      const inw = await call('inventory', stores, 'POST', '/inwards', { warehouse_id: SRT, source_ref: ref, party_name: 'Opening stock', received_date: daysAgo(days), lines: [{ product_id: sku(sku_), expected_kg: opts.total ?? Math.round(n * base * 10) / 10, cost_per_kg: cost, lot_ref: opts.dye_lot ?? null }] });
      const [rolls] = await scanInward(inw.id, [{ weights: weights(n, base, opts.total), dye_lot: opts.dye_lot, shade: opts.shade }]);
      await call('inventory', stores, 'POST', `/inwards/${inw.id}/complete`, { note: 'Opening stock count' });
      await grade(rolls, (i) => (i % 9 === 4 ? 'B' : 'A'));
      await putaway(rolls);
      if (opts.price) await call('inventory', purchase, 'POST', `/lots/${rolls[0].lot_id}/price`, { price_per_kg: opts.price });
      return rolls;
    }
    // Opening stock in Surat, with its original receipt dates (drives ageing).
    const ribRolls = await opening('RIB-240-NVY', 26, 24.5, 288, 40, 'OPENING/RIB/01', { total: 637, dye_lot: 'DL-R412', shade: 'NVY-1', price: 332 });
    const intRolls = await opening('INT-220-RFD', 56, 25.4, 232, 25, 'OPENING/INT/01', { price: 266 });
    await opening('SJ-180-BLK', 36, 25, 258, 200, 'OPENING/BLK/01', { dye_lot: 'DL-B209', shade: 'BLK-1', price: 299 });
    await opening('PIQ-210-WHT', 14, 22, 276, 400, 'OPENING/PIQ/01', { price: 318 });
    await opening('FLC-320-CHR', 20, 20, 305, 75, 'OPENING/FLC/01', { price: 352 });
    const scanIssue = async (jobOrderId: string, rolls: { barcode: string }[], kg: number) => {
      await drain();
      const issue = (await call<{ id: string; job_order_id: string }[]>('inventory', stores, 'GET', '/mill-issues?status=open')).find((i) => i.job_order_id === jobOrderId)!;
      let sent = 0;
      for (const r of rolls) {
        if (sent >= kg - 0.5) break;
        const x = await call('inventory', stores, 'POST', `/mill-issues/${issue.id}/scan`, { barcode: r.barcode });
        sent += x.kg;
        if (x.done) break;
      }
    };

    // 7. Compacting job from the Surat warehouse, returned with low yield and a quality claim
    const jw2 = await call('jobwork', millops, 'POST', '/orders', { mill_id: party('Palladam Compacting Works'), process_code: 'COMPACT_ONLY', expected_return_date: daysAgo(2), lines: [{ source: 'warehouse', warehouse_id: SRT, product_id: sku('RIB-240-NVY'), kg_sent: 588, rolls: 24, lot_ref: 'L-SRT-0412' }] });
    await call('jobwork', millops, 'POST', `/orders/${jw2.id}/issue`, { issue_date: daysAgo(10) });
    await scanIssue(jw2.id, ribRolls, 588);
    await call('jobwork', millops, 'POST', `/orders/${jw2.id}/acknowledge`, { kg_received: 588 });
    await call('jobwork', millops, 'POST', `/orders/${jw2.id}/stages`, { stage_code: 'COMPACTING', status: 'completed' });
    await call('jobwork', millops, 'POST', `/orders/${jw2.id}/stages`, { stage_code: 'FINAL_QC', status: 'qc_failed', note: 'Shade bleeding on 3 rolls after compacting' });
    await call('jobwork', millops, 'POST', `/orders/${jw2.id}/ready`, { note: 'Ready for pickup' });
    await call('jobwork', millops, 'POST', `/orders/${jw2.id}/returns`, { return_date: daysAgo(1), warehouse_id: SRT, mill_challan_no: 'PCW/RC/771', kg_good: 498, kg_rejected: 60, kg_damaged: 6, kg_process_loss: 24, rolls: 24, lot_ref: 'L-SRT-0412-C', loss_reason: 'Shade bleeding and edge damage from compactor' });
    await call('jobwork', millops, 'POST', '/claims', { job_order_id: jw2.id, defect_types: ['Shade variation', 'Finishing defect'], description: 'Three rolls show shade bleeding after compacting; edges damaged on one roll.', kg_affected: 66, samples: 'Swatches kept at Surat QC desk', claim_type: 'debit_note', amount: 18150 });

    // 8. A challan the mill has not acknowledged, to show the overdue clock
    const jw3 = await call('jobwork', millops, 'POST', '/orders', { mill_id: party('Tiruppur Dyeing & Finishing'), process_code: 'REACTIVE_DYE', expected_return_date: inDays(6), lines: [{ source: 'warehouse', warehouse_id: SRT, product_id: sku('INT-220-RFD'), kg_sent: 1400, rolls: 56, lot_ref: 'L-SRT-0398' }] });
    await call('jobwork', millops, 'POST', `/orders/${jw3.id}/issue`, { issue_date: daysAgo(5) });

    // ---------- P4: weigh and scan the Ambica receipt, transfers, reservations, approvals, a count in progress ----------
    await drain();
    const inwards = await call<{ id: string; source_type: string; source_ref: string }[]>('inventory', stores, 'GET', '/inwards?status=open');
    const grn = inwards.find((i) => i.source_type === 'po_receipt')!;
    const [sjRolls, ribNew] = await scanInward(grn.id, [
      { weights: weights(48, 24.9, 1194.8), dye_lot: 'SAK-N118', shade: 'NVY-118', gsm: 161, width: 72 },
      { weights: weights(24, 24.5, 588), dye_lot: 'SAK-R77', shade: 'NVY-2', gsm: 238, width: 36 },
    ]);
    await call('inventory', stores, 'POST', `/inwards/${grn.id}/complete`, {});
    await grade(sjRolls, (i) => (i === 7 ? 'reject' : i % 6 === 5 ? 'B' : 'A'), (i) => (i === 7 ? ['Holes', 'Oil stains'] : i % 6 === 5 ? ['Minor slubs'] : []));
    await grade(ribNew.slice(0, 18));
    await putaway(sjRolls.filter((_, i) => i !== 7).slice(0, 32));
    await putaway(ribNew.slice(0, 18), 6);
    const sjLot = sjRolls[0].lot_id;
    await call('inventory', purchase, 'POST', `/lots/${sjLot}/price`, { price_per_kg: 289 });

    // Inter-GSTIN transfer Surat → Kolkata: approved, dispatched on a tax invoice, partly received.
    const tr1 = await call('inventory', stores, 'POST', '/transfers', { from_warehouse_id: SRT, to_warehouse_id: KOL, reason: 'Kolkata hosiery orders for navy jersey', needed_by: inDays(4), lines: [{ product_id: sku('SJ-160-NVY'), requested_kg: 250, lot_id: sjLot }] });
    await decide(tr1.id);
    const loadable = sjRolls.filter((_, i) => i !== 7).slice(30, 40);
    for (const r of loadable) await call('inventory', stores, 'POST', `/transfers/${tr1.id}/scan-out`, { barcode: r.barcode });
    await call('inventory', stores, 'POST', `/transfers/${tr1.id}/dispatch`, { transporter_name: 'VRL Logistics', lr_number: 'VRL-771204', vehicle_no: 'GJ05AB4471', eway_bill_no: '381200441122' });
    for (const r of loadable.slice(0, 6)) await call('inventory', admin, 'POST', `/transfers/${tr1.id}/scan-in`, { barcode: r.barcode });
    // A second transfer waiting for approval (Surat → Tiruppur, different GSTIN).
    await call('inventory', stores, 'POST', '/transfers', { from_warehouse_id: SRT, to_warehouse_id: wh.find((w) => w.code === 'TUP1')!.id, reason: 'Exporter programme in Tiruppur', needed_by: inDays(6), lines: [{ product_id: sku('INT-220-RFD'), requested_kg: 300 }] });
    // Clearance price on aged black jersey: below margin, so it waits for a checker.
    const blk = (await call<{ items: { id: string; sku: string }[] }>('inventory', admin, 'GET', `/lots?f_product=${sku('SJ-180-BLK')}`)).items[0];
    await call('inventory', purchase, 'POST', `/lots/${blk.id}/price`, { price_per_kg: 272, reason: 'Clearance: 200 days old, move before winter' });
    // A count in progress on one aisle.
    const st = await call('inventory', stores, 'POST', '/stocktakes', { warehouse_id: SRT, location_prefix: 'A-01' });
    const toCount = await call<{ barcode: string; location_path: string }[]>('inventory', stores, 'GET', `/rolls?warehouse=${SRT}&state=available`);
    for (const r of toCount.filter((x) => x.location_path?.startsWith('A-01')).slice(0, 12)) await call('inventory', stores, 'POST', `/stocktakes/${st.id}/count`, { barcode: r.barcode });

    // ---------- P5: leads from every channel, allocation, pipeline, quotations, credit, targets ----------
    const team = await call<{ user_id: string; name: string }[]>('crm', salesMgr, 'GET', '/team');
    const member = (n: string) => team.find((m) => m.name === n)!.user_id;
    await call('crm', salesMgr, 'PUT', '/attendance', { user_id: member('Sourav Ghosh'), day: daysAgo(0), status: 'leave', note: 'Family function' });
    const sources = await call<{ code: string; webhook_key: string }[]>('crm', salesMgr, 'GET', '/sources');
    const hook = (code: string) => sources.find((x) => x.code === code)!.webhook_key;
    const webhook = (code: string, body: object) => fetch(`http://127.0.0.1:${ports.crm}/public/leads/${hook(code)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
    await webhook('INDIAMART', { UNIQUE_QUERY_ID: 'IM-2611-8841', SENDER_NAME: 'Murali Krishnan', SENDER_MOBILE: '+91-9843011111', SENDER_COMPANY: 'Kovai Knits', SENDER_CITY: 'Coimbatore', QUERY_PRODUCT_NAME: 'Cotton single jersey 160 GSM', QUERY_MESSAGE: 'Need 800 kg navy single jersey 160 GSM, compacted. Please share best rate.' });
    await webhook('META', { leadgen_id: 'FB-55102', full_name: 'Harpreet Singh', phone_number: '+919814022222', email: 'harpreet@ludhianaknits.example', city: 'Ludhiana', company_name: 'HS Knit Exports', message: 'Fleece 320 GSM for winter programme, 2 tonnes' });
    await webhook('WEBSITE', { id: 'WEB-1032', name: 'Ritika Jain', phone: '9820133333', email: 'ritika@jainfashions.example', company: 'Jain Fashions', city: 'Mumbai', message: 'Pique 210 white for polo T-shirts', quantity_kg: 600 });
    await webhook('JUSTDIAL', { leadid: 'JD-90021', name: 'Subrata Paul', mobile: '9830144444', city: 'Kolkata', category: 'Hosiery fabric dealers' });
    await webhook('INDIAMART', { UNIQUE_QUERY_ID: 'IM-2611-8902', SENDER_NAME: 'Murali K', SENDER_MOBILE: '9843011111', SENDER_COMPANY: 'Kovai Knits', SENDER_CITY: 'Coimbatore', QUERY_MESSAGE: 'Also need rib 2x2 navy matching' });
    const manual = async (token: string, body: object) => call('crm', token, 'POST', '/leads', body);
    const big = await manual(salesMgr, { source_code: 'EXHIBITION', name: 'Anand Rao', company: 'Bengaluru Apparel Co', mobile: '9845055555', email: 'anand@blrapparel.example', city: 'Bengaluru', state_code: '29', category: 'Single Jersey', est_value: 1800000, requirement_kg: 6000, message: 'Met at Knit Show Tiruppur; annual contract for jersey and rib' });
    const smg = await manual(salesMgr, { source_code: 'REFERRAL', name: 'S. Murugan', company: 'Sri Murugan Garments', mobile: '9443066666', city: 'Tiruppur', state_code: '33', est_value: 450000, requirement_kg: 1500, message: 'Repeat buyer; navy jersey for export order', owner_id: member('Selvi Raman') });
    const delhi = await manual(salesWest, { source_code: 'PHONE', name: 'Vikas Arora', company: 'Delhi Fashion Hub', mobile: '9810077777', city: 'Delhi', state_code: '07', est_value: 260000, requirement_kg: 900, message: 'Interlock RFD for dyeing at their end' });
    const lost = await manual(salesWest, { source_code: 'TRADE', name: 'Pooja Desai', company: 'Surat Kids Wear', mobile: '9825088888', city: 'Surat', state_code: '24', est_value: 120000 });
    const leads = (await call<{ items: { id: string; name: string; owner_id: string | null }[] }>('crm', salesMgr, 'GET', '/leads?pageSize=50')).items;
    const lead = (n: string) => leads.find((l) => l.name === n)!;
    // Work the pipeline.
    const at = (d: number, h = 11) => new Date(Date.now() + d * 86_400_000 + h * 3_600_000).toISOString();
    await call('crm', salesSouth, 'POST', `/leads/${lead('Murali Krishnan').id}/activities`, { kind: 'call', summary: 'Called Murali; needs 800 kg navy SJ 160, compacted, within 10 days', outcome: 'Interested', next_action_at: at(1), next_action: 'Send quotation' });
    await call('crm', salesSouth, 'POST', `/leads/${lead('Murali Krishnan').id}/stage`, { stage: 'qualified', next_action_at: at(1) });
    await call('crm', salesSouth, 'POST', `/leads/${smg.id}/activities`, { kind: 'visit', summary: 'Visited factory, confirmed export programme', next_action_at: at(0, 4) });
    await call('crm', salesWest, 'POST', `/leads/${delhi.id}/activities`, { kind: 'whatsapp', summary: 'Shared interlock RFD photos and GSM report', next_action_at: at(-1), next_action: 'Chase for sample feedback' });
    await call('crm', salesWest, 'POST', `/leads/${lead('Ritika Jain').id}/activities`, { kind: 'email', summary: 'Sent pique swatch card', next_action_at: at(2) });
    await call('crm', salesWest, 'POST', `/leads/${lost.id}/activities`, { kind: 'call', summary: 'Wants price below ₹240 for jersey', next_action_at: at(1) });
    await call('crm', salesWest, 'POST', `/leads/${lost.id}/stage`, { stage: 'lost', lost_reason: 'Price: buying from a local knitter at ₹236', competitor: 'Local knitter' });
    await call('crm', salesMgr, 'POST', `/leads/${big.id}/stage`, { stage: 'nurture', nurture_reason: 'Budget approval in January', next_action_at: at(30) });

    // Customers, credit and quotations.
    const murugan = party('Sri Murugan Garments');
    await call('crm', salesSouth, 'POST', `/leads/${smg.id}/convert`, { customer_id: murugan });
    await call('crm', salesSouth, 'POST', `/leads/${lead('Murali Krishnan').id}/convert`, { legal_name: 'Kovai Knits', state_code: '33' });
    const cr1 = await call('crm', salesSouth, 'POST', '/credit/applications', { customer_id: murugan, requested_mode: 'credit', requested_limit: 500000, requested_days: 45, justification: 'Buying from us since 2021, pays within 40 days' });
    await decide(cr1.id);
    await call('crm', salesWest, 'POST', '/credit/applications', { customer_id: party('Delhi Fashion Hub'), requested_mode: 'credit', requested_limit: 300000, requested_days: 30, justification: 'New wholesale account; bank reference attached' });
    await call('crm', accounts, 'POST', `/credit/${party('Ludhiana Knit Exports')}/block`, { blocked: true, reason: 'Two cheques returned in September' });
    const quote = async (token: string, body: object) => call('crm', token, 'POST', '/quotations', body);
    const q1 = await quote(salesSouth, { lead_id: smg.id, warehouse_id: SRT, freight_amount: 2500, payment_terms: '45 days credit', delivery_terms: 'Door delivery Tiruppur', lines: [{ product_id: sku('SJ-160-NVY'), lot_id: sjLot, kg: 400, requested_price: 286 }] });
    await call('crm', salesSouth, 'POST', `/quotations/${q1.id}/submit`);
    await call('crm', salesSouth, 'POST', `/quotations/${q1.id}/send`);
    await call('crm', salesSouth, 'POST', `/quotations/${q1.id}/outcome`, { outcome: 'accepted' });
    const q2 = await quote(salesSouth, { lead_id: lead('Murali Krishnan').id, warehouse_id: SRT, freight_amount: 1800, payment_terms: 'Advance', lines: [{ product_id: sku('SJ-160-NVY'), lot_id: sjLot, kg: 300, requested_price: 262, approval_reason: 'Kovai matched a Tiruppur mill at ₹265; first order' }] });
    await call('crm', salesSouth, 'POST', `/quotations/${q2.id}/submit`);
    const q3 = await quote(salesWest, { lead_id: delhi.id, warehouse_id: SRT, freight_amount: 4200, payment_terms: 'Advance 50%, balance on delivery', lines: [{ product_id: sku('INT-220-RFD'), kg: 900, requested_price: 264 }] });
    await call('crm', salesWest, 'POST', `/quotations/${q3.id}/submit`);
    await call('crm', salesWest, 'POST', `/quotations/${q3.id}/send`);
    for (const [n, rev, kg] of [['Selvi Raman', 900000, 3000], ['Arjun Mehta', 1200000, 4500], ['Sourav Ghosh', 600000, 2200]] as const)
      await call('crm', salesMgr, 'PUT', '/targets', { user_id: member(n), period: new Date().toISOString().slice(0, 7), leads: 40, qualified: 15, quotes: 12, kg, revenue: rev, margin_pct: 10, new_customers: 3 });

    // ---------- P6/P7: customer portal orders, payments, allocation, dispatch ----------
    await drain();
    const dispatcher = await login('dispatch@textile.local');
    const muruganBuyer = await login('buyer@srimurugan.example');
    const kolkataBuyer = await login('purchase@kolkatahosiery.example');
    const simulatePay = async (link: string) => { await call('commerce', null, 'POST', `/public/pay/${link}/simulate`, { outcome: 'success' }); await drain(); };
    // Freight rates on the main lanes.
    for (const [tr, mode, from, to, rate, min, eta] of [['VRL Logistics', 'PTL', '24', '33', 4.5, 1500, 4], ['Gati Express', 'PTL', '24', '33', 5, 1200, 3], ['VRL Logistics', 'PTL', '24', '19', 5.5, 1800, 5], ['Gati Express', 'PTL', '24', '27', 3.2, 900, 2], ['VRL Logistics', 'FTL', '24', '07', 2.8, 18000, 3]] as const)
      await call('fulfilment', dispatcher, 'POST', '/freight-rates', { transporter_id: party(tr), mode, from_state: from, to_state: to, rate_per_kg: rate, min_charge: min, eta_days: eta });
    // The accepted Sri Murugan quotation became a sales order (credit customer: booked, stock already reserved). Pick, pack, invoice, dispatch.
    const soMurugan = (await call<{ id: string; channel: string; customer_name: string }[]>('commerce', admin, 'GET', '/orders')).find((o) => o.channel === 'crm_quotation')!;
    const fM = (await call<{ id: string }[]>('fulfilment', dispatcher, 'GET', `/fulfilments?order=${soMurugan.id}`))[0]!;
    const pickM = (await call<{ pick_list: { barcode: string; weight_kg: number }[] }>('fulfilment', dispatcher, 'GET', `/fulfilments/${fM.id}`)).pick_list;
    for (const r of pickM) await call('fulfilment', dispatcher, 'POST', `/fulfilments/${fM.id}/pick`, { barcode: r.barcode, weight_kg: r.weight_kg });
    await call('fulfilment', dispatcher, 'POST', `/fulfilments/${fM.id}/pack`, { packages: Math.ceil(pickM.length / 4), gross_kg: Math.ceil(pickM.reduce((s, r) => s + Number(r.weight_kg), 0) + 6) });
    await call('fulfilment', accounts, 'POST', `/fulfilments/${fM.id}/invoice`);
    const shipM = await call<{ shipment_id: string }>('fulfilment', dispatcher, 'POST', `/fulfilments/${fM.id}/dispatch`, { transporter_id: party('VRL Logistics'), transporter_name: 'VRL Logistics', mode: 'PTL', lr_number: 'VRL-771950', vehicle_no: 'GJ05BX7012', driver_name: 'Ramesh', driver_phone: '9898012345', eway_bill_no: '381200559911', freight_amount: 1800, eta_date: inDays(2) });
    await call('fulfilment', dispatcher, 'POST', `/shipments/${shipM.shipment_id}/milestones`, { milestone: 'in_transit', location: 'Vadodara hub', note: 'Departed hub' });
    // Kolkata Hosiery orders fleece on the portal, pays the token, and the order waits to be picked.
    const flc = (await call<{ items: { id: string; product_id: string }[] }>('inventory', admin, 'GET', `/lots?f_product=${sku('FLC-320-CHR')}&f_in_stock=true`)).items[0]!;
    await call('commerce', kolkataBuyer, 'POST', '/portal/cart/add', { product_id: sku('FLC-320-CHR'), lot_id: flc.id, kg: 120 });
    const soK1 = await call<{ id: string; payment: { link_token: string } }>('commerce', kolkataBuyer, 'POST', '/portal/cart/checkout', { ship_to: 'Kolkata Hosiery Works, Howrah' });
    await simulatePay(soK1.payment.link_token);
    // A second Kolkata order left unpaid (shows the token and the pay button).
    const blkLot = (await call<{ items: { id: string }[] }>('inventory', admin, 'GET', `/lots?f_product=${sku('SJ-180-BLK')}&f_in_stock=true`)).items[0]!;
    await call('commerce', kolkataBuyer, 'POST', '/portal/cart/add', { product_id: sku('SJ-180-BLK'), lot_id: blkLot.id, kg: 150 });
    await call('commerce', kolkataBuyer, 'POST', '/portal/cart/checkout', {});
    // Sri Murugan reorders interlock on the portal (credit: booked straight away).
    const intLot = (await call<{ items: { id: string }[] }>('inventory', admin, 'GET', `/lots?f_product=${sku('INT-220-RFD')}&f_in_stock=true`)).items[0]!;
    await call('commerce', muruganBuyer, 'POST', '/portal/cart/add', { product_id: sku('INT-220-RFD'), lot_id: intLot.id, kg: 250 });
    await call('commerce', muruganBuyer, 'POST', '/portal/cart/checkout', { ship_to: 'Unit 2, Tiruppur' });
    await call('commerce', muruganBuyer, 'POST', '/portal/complaints', { order_id: soMurugan.id, category: 'delivery', subject: 'Please confirm delivery date', description: 'We need the navy jersey by Monday for cutting.' });
    // A large phone order no single warehouse can supply: waits for an allocation decision (split suggested).
    await call('commerce', salesMgr, 'POST', '/orders', { customer_id: party('Delhi Fashion Hub'), lines: [{ product_id: sku('SJ-160-NVY'), kg: 600 }], notes: 'Phone order — Vikas' });
    // Customer-specific token policy waiting for approval; a website registration waiting for review.
    await call('commerce', salesMgr, 'POST', '/token-policies', { name: 'Kolkata Hosiery — trusted buyer', scope: 'customer', scope_ref: party('Kolkata Hosiery Works'), basis: 'percent', value: 5, min_amount: 2000, validity_days: 10, refundable: true, cancellation_fee_pct: 0, reason: 'Five years of on-time payments' });
    await call('commerce', null, 'POST', '/public/registrations', { company_name: 'Erode Knit Wear', gstin: null, city: 'Erode', contact_name: 'P. Kannan', email: 'kannan@erodeknit.example', phone: '9443012345', message: 'Interested in interlock and pique for school uniforms' });

    await drain();
    await runProcurementChecks(services.find((s) => s.ctx.name === 'procurement')!.ctx.pool);
    await runJobworkChecks(services.find((s) => s.ctx.name === 'jobwork')!.ctx.pool);
    await runCrmChecks(services.find((s) => s.ctx.name === 'crm')!.ctx.pool);
    await drain();
  } finally {
    for (const s of servers) s.close();
  }
}
