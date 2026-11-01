/**
 * Loads example procurement and job-work activity through the services' own APIs,
 * so the demo data is validated, numbered and audited exactly like real use.
 */
import { seedScenarios } from '../services/golive/src/readiness.ts';
import type { AddressInfo } from 'node:net';
import { type RunningService, type ServiceName, drainMany, setServicePorts } from '@erp/platform';
import { DEMO_PASSWORD } from './seed-data.ts';
import { runProcurementChecks } from '../services/procurement/src/automation.ts';
import { runJobworkChecks } from '../services/jobwork/src/automation.ts';
import { runFinanceChecks } from '../services/finance/src/automation.ts';
import { runContractChecks } from '../services/workflow/src/contracts.ts';
import { dispatchMessages } from '../services/workflow/src/messaging.ts';
import { runScheduled } from '../services/workflow/src/engine.ts';
import { runCrmChecks } from '../services/crm/src/automation.ts';

export async function seedOperations(services: RunningService[]) {
  const ports: Partial<Record<ServiceName, number>> = {};
  const servers = services.map((s) => {
    const srv = s.app.listen(0);
    ports[s.ctx.name] = (srv.address() as AddressInfo).port;
    return srv;
  });
  setServicePorts(ports);
  const drain = () => drainMany(services[0]!.ctx.pool, services.map((s) => s.consumer));
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

    // A sub-user: the Surat stores manager's assistant, in the same role but with a narrower menu.
    {
      const dir = await call<{ items: { id: string; email: string }[] }>('identity', admin, 'GET', '/users?pageSize=100');
      const rakesh = await call<{ id: string; roles: { id: string }[]; scope: unknown }>('identity', admin, 'GET', `/users/${dir.items.find((u) => u.email === 'surat.stores@textile.local')!.id}`);
      await call('identity', admin, 'POST', '/users', { email: 'stores.assistant@textile.local', name: 'Mahesh Vasava', designation: 'Stores Assistant (sub-user of Rakesh Patel)',
        password: DEMO_PASSWORD, roleIds: rakesh.roles.map((r) => r.id), scope: rakesh.scope, parent_user_id: rakesh.id,
        menu: ['/inventory/scan', '/inventory/inward', '/inventory/qc', '/inventory/stock', '/inventory/stocktakes', '/workflow/tasks'] });
    }
    const wh = await call<{ id: string; code: string }[]>('organisation', admin, 'GET', '/warehouses');
    // ---------- P9: customers who opted in to WhatsApp and SMS updates (recorded before any order is placed) ----------
    {
      const all = (await call<{ items: { id: string; party_type: string; phone: string | null }[] }>('masters', admin, 'GET', '/parties?pageSize=100&f_type=customer')).items;
      for (const p of all.filter((x) => x.phone)) for (const ch of ['whatsapp', 'sms'])
        await call('workflow', admin, 'POST', '/consents', { party_id: p.id, address: p.phone, channel: ch, status: 'opted_in', scope: 'transactional', source: 'Signed customer account form' });
    }
    // ---------- P8: TDS sections for mills (194C) and grey-fabric suppliers (194Q), before their bills post ----------
    {
      const all = (await call<{ items: { id: string; legal_name: string; party_type: string; pan: string | null }[] }>('masters', admin, 'GET', '/parties?pageSize=100')).items;
      for (const p of all.filter((x) => ['mill', 'supplier'].includes(x.party_type)))
        await call('finance', accounts, 'PUT', `/tds/parties/${p.id}`, { pan: p.pan ?? null, tds_section: p.party_type === 'mill' ? '194C' : '194Q' });
    }
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
    // Value of the stock carried in from before the year (weighed kg × cost), for the opening balance in the books.
    let openingValue = 0;
    async function opening(sku_: string, n: number, base: number, cost: number, days: number, ref: string, opts: { total?: number; dye_lot?: string; shade?: string; price?: number } = {}) {
      const inw = await call('inventory', stores, 'POST', '/inwards', { warehouse_id: SRT, source_ref: ref, party_name: 'Opening stock', received_date: daysAgo(days), lines: [{ product_id: sku(sku_), expected_kg: opts.total ?? Math.round(n * base * 10) / 10, cost_per_kg: cost, lot_ref: opts.dye_lot ?? null }] });
      const w = weights(n, base, opts.total);
      openingValue += w.reduce((t, x) => t + x, 0) * cost;
      const [rolls] = await scanInward(inw.id, [{ weights: w, dye_lot: opts.dye_lot, shade: opts.shade }]);
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
    // The compacted rib back from Palladam: weighed in, checked and put away (it is stock again only once scanned).
    const back = inwards.find((i) => i.source_type === 'job_return');
    if (back) {
      const [compacted] = await scanInward(back.id, [{ weights: weights(24, 20.75, 498), dye_lot: 'L-SRT-0412-C', shade: 'NVY-1' }]);
      await call('inventory', stores, 'POST', `/inwards/${back.id}/complete`, { note: 'Compacted rib weighed in' });
      await grade(compacted, (i) => (i % 8 === 3 ? 'B' : 'A'));
      await putaway(compacted);
    }
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
    // The demo can be reloaded on any day: if today is the team's weekly off (Sunday), nobody would be available and the
    // new leads would stay unassigned, so the rest of the team is marked present today.
    for (const m of team) if (m.name !== 'Sourav Ghosh') await call('crm', salesMgr, 'PUT', '/attendance', { user_id: m.user_id, day: daysAgo(0), status: 'present', note: 'Working today' });
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

    // ---------- History: earlier weeks of trading, so registers, ageing, GST and dashboards have depth ----------
    // Each story runs through the same APIs as real use. A failure is logged and the rest of the seed carries on.
    const story = async (name: string, f: () => Promise<unknown>) => { try { await f(); } catch (e) { console.error(`[seed] history "${name}" skipped: ${(e as Error).message}`); } };
    const decideIfPending = async (refId: string) => {
      await drain();
      const list = await call<{ items: { id: string; ref_id: string }[] }>('governance', admin, 'GET', '/approvals?f_status=pending&pageSize=100');
      const ap = list.items.find((x) => x.ref_id === refId);
      if (ap) await call('governance', admin, 'POST', `/approvals/${ap.id}/decide`, { decision: 'approved', comment: 'Within the agreed rate contract' });
      await drain();
    };
    const r2 = (n: number) => Math.round(n * 100) / 100;
    /** A purchase from order to stock: PO, receipt, weighed rolls, QC, put-away, the supplier's bill posted and approved for payment. */
    const buy = async (h: { supplier: string; ref: string; ordered: number; received: number; billNo: string; lines: { sku: string; kg: number; rate: number; desc: string; rolls: number; base: number; dye_lot: string; shade: string; price: number }[] }) => {
      const po = await call('procurement', purchase, 'POST', '/purchase-orders', { supplier_id: party(h.supplier), deliver_to_type: 'warehouse', deliver_to_id: SRT, expected_date: daysAgo(h.received), freight_terms: 'Freight included',
        lines: h.lines.map((l) => ({ product_id: sku(l.sku), qty_kg: l.kg, rate_per_kg: l.rate })) });
      await call('procurement', purchase, 'POST', `/purchase-orders/${po.id}/submit`);
      await decideIfPending(po.id);
      await call('procurement', purchase, 'POST', `/purchase-orders/${po.id}/send`);
      const d = await call('procurement', purchase, 'GET', `/purchase-orders/${po.id}`);
      const kgOf = (l: (typeof h.lines)[number]) => Math.round(l.rolls * l.base * 10) / 10;
      await call('procurement', purchase, 'POST', `/purchase-orders/${po.id}/receipts`, { receipt_date: daysAgo(h.received), challan_no: `${h.ref}/DC`, lr_number: `${h.ref}/LR`,
        lines: d.lines.map((pl: { id: string }, i: number) => ({ po_line_id: pl.id, received_kg: kgOf(h.lines[i]!), rejected_kg: 0, rolls: h.lines[i]!.rolls })) });
      await drain();
      const inward = (await call<{ id: string; source_type: string }[]>('inventory', stores, 'GET', '/inwards?status=open')).find((i) => i.source_type === 'po_receipt')!;
      const rolls = await scanInward(inward.id, h.lines.map((l) => ({ weights: weights(l.rolls, l.base, kgOf(l)), dye_lot: l.dye_lot, shade: l.shade })));
      await call('inventory', stores, 'POST', `/inwards/${inward.id}/complete`, {});
      for (const [i, rs] of rolls.entries()) {
        await grade(rs, (k) => (k % 11 === 6 ? 'B' : 'A'));
        await putaway(rs);
        await call('inventory', purchase, 'POST', `/lots/${rs[0]!.lot_id}/price`, { price_per_kg: h.lines[i]!.price });
      }
      const inter = d.tax_type === 'inter' || d.tax_type === 'inter_state' || d.tax_type === 'igst';
      const lines = h.lines.map((l) => ({ description: l.desc, hsn_code: '6006', qty_kg: kgOf(l), rate: l.rate, gst_rate: 5 }));
      const taxable = r2(lines.reduce((s, l) => s + l.qty_kg * l.rate, 0));
      const half = r2(taxable * 0.025), igst = r2(taxable * 0.05);
      const inv = await call('procurement', purchase, 'POST', '/invoices', { supplier_id: party(h.supplier), invoice_number: h.billNo, invoice_date: daysAgo(h.received), po_id: po.id, taxable_value: taxable,
        cgst: inter ? 0 : half, sgst: inter ? 0 : half, igst: inter ? igst : 0, total_value: r2(taxable + (inter ? igst : 2 * half)), lines });
      await call('procurement', admin, 'POST', `/invoices/${inv.id}/post`, {});
      await call('procurement', accounts, 'POST', `/invoices/${inv.id}/approve-payment`);
      await drain();
      return rolls.map((rs) => rs[0]!.lot_id);
    };
    /** Pays a posted supplier bill from the bank (finance settles the payable; procurement marks the invoice paid). */
    const paySupplier = (supplier: string, billNo: string, daysBack: number, utr: string) =>
      call('finance', accounts, 'POST', '/supplier-payments', { party_id: party(supplier), invoice_number: billNo, date: daysAgo(daysBack), mode: 'neft', reference: utr });

    const lotsPiq: string[] = [], lotsNvy: string[] = [], lotsFlc: string[] = [];
    await story('Ganesh pique purchase', async () => {
      lotsPiq.push(...(await buy({ supplier: 'Ganesh Yarn & Fabrics', ref: 'GYF', ordered: 52, received: 48, billNo: 'GYF/2627/0388',
        lines: [{ sku: 'PIQ-210-WHT', kg: 800, rate: 274, desc: 'Pique 210 GSM white', rolls: 32, base: 24.6, dye_lot: 'GYF-P31', shade: 'WHT', price: 322 }] })));
      await paySupplier('Ganesh Yarn & Fabrics', 'GYF/2627/0388', 18, 'NEFT ICICN52026091');
    });
    await story('Ambica jersey and rib purchase', async () => {
      lotsNvy.push(...(await buy({ supplier: 'Shree Ambica Knitters', ref: 'SAK/H2', ordered: 36, received: 33, billNo: 'SAK/26-27/0371',
        lines: [{ sku: 'SJ-160-NVY', kg: 1000, rate: 244, desc: 'Single jersey 160 GSM navy', rolls: 40, base: 24.8, dye_lot: 'SAK-N109', shade: 'NVY-109', price: 288 },
          { sku: 'RIB-240-NVY', kg: 400, rate: 286, desc: '2x2 rib 240 GSM navy', rolls: 16, base: 24.6, dye_lot: 'SAK-R71', shade: 'NVY-2', price: 334 }] })));
      await paySupplier('Shree Ambica Knitters', 'SAK/26-27/0371', 6, 'NEFT ICICN52026127');
    });
    await story('Velavan fleece purchase', async () => {
      lotsFlc.push(...(await buy({ supplier: 'Velavan Knit Fab', ref: 'VKF/H3', ordered: 24, received: 20, billNo: 'VKF-2627-1041',
        lines: [{ sku: 'FLC-320-CHR', kg: 600, rate: 304, desc: 'Fleece 320 GSM charcoal', rolls: 24, base: 25.1, dye_lot: 'VKF-F12', shade: 'CHR-3', price: 356 }] })));
      // Approved for payment, due later this month: shows in the payables forecast.
    });

    /** A sale from order to cash: order, token (if the customer is on advance terms), pick, pack, invoice, payment, dispatch and delivery. */
    const sell = async (s: { customer: string; buyer?: string; lot: string; product: string; kg: number; pay: 'before_dispatch' | 'after_delivery' | 'none'; deliver: boolean; lr: string; utr: string }) => {
      const o = await call<{ id: string; number: string; status: string; payment?: { link_token: string } }>('commerce', salesMgr, 'POST', '/orders', { customer_id: party(s.customer), lines: [{ product_id: sku(s.product), lot_id: s.lot, kg: s.kg }], notes: 'Phone order' });
      if (o.status === 'pending_payment' && o.payment?.link_token) await simulatePay(o.payment.link_token);
      else if (o.status !== 'booked') throw new Error(`${o.number} is ${o.status}`);
      await drain();
      const f = (await call<{ id: string }[]>('fulfilment', dispatcher, 'GET', `/fulfilments?order=${o.id}`))[0]!;
      const pick = (await call<{ pick_list: { barcode: string; weight_kg: number }[] }>('fulfilment', dispatcher, 'GET', `/fulfilments/${f.id}`)).pick_list;
      for (const r of pick) await call('fulfilment', dispatcher, 'POST', `/fulfilments/${f.id}/pick`, { barcode: r.barcode, weight_kg: r.weight_kg });
      const kg = pick.reduce((t, r) => t + Number(r.weight_kg), 0);
      await call('fulfilment', dispatcher, 'POST', `/fulfilments/${f.id}/pack`, { packages: Math.ceil(pick.length / 4), gross_kg: Math.ceil(kg + 6) });
      const inv = await call<{ invoice_no: string; total: number; settled: number; gate_payment: string }>('fulfilment', accounts, 'POST', `/fulfilments/${f.id}/invoice`);
      const due = r2(inv.total - inv.settled);
      const receive = () => call('commerce', accounts, 'POST', '/payments/offline', { customer_id: party(s.customer), amount: due, mode: 'rtgs', reference: s.utr, received_on: daysAgo(0), purpose: 'invoice', ref_no: inv.invoice_no });
      if (s.pay === 'before_dispatch' && inv.gate_payment === 'pending' && due > 0) {
        await receive();
        await drain();
        await call('fulfilment', dispatcher, 'POST', `/fulfilments/${f.id}/refresh-payment`);
      }
      if (inv.gate_payment === 'pending' && s.pay !== 'before_dispatch') return; // dispatch waits for the money
      const sh = await call<{ shipment_id: string }>('fulfilment', dispatcher, 'POST', `/fulfilments/${f.id}/dispatch`, { transporter_id: party('VRL Logistics'), transporter_name: 'VRL Logistics', mode: 'PTL', lr_number: s.lr, vehicle_no: 'GJ05BX7012', eway_bill_no: `3812${s.lr.replace(/\D/g, '').padStart(8, '0').slice(-8)}` });
      await call('fulfilment', dispatcher, 'POST', `/shipments/${sh.shipment_id}/milestones`, { milestone: 'in_transit', location: 'Vadodara hub' });
      if (s.deliver) {
        await call('fulfilment', dispatcher, 'POST', `/shipments/${sh.shipment_id}/pod`, { received_by: 'Stores in-charge', kg_received: r2(kg), condition: 'ok', remarks: 'Received in good condition' });
        if (s.pay === 'after_delivery' && due > 0) await receive();
      }
      await drain();
    };
    await story('Sri Murugan pique on credit, delivered and paid', () => lotsPiq[0] ? sell({ customer: 'Sri Murugan Garments', lot: lotsPiq[0], product: 'PIQ-210-WHT', kg: 300, pay: 'after_delivery', deliver: true, lr: 'VRL-770412', utr: 'HDFCR52026102511' }) : Promise.resolve());
    await story('Rupa Apparel jersey, paid before dispatch', () => lotsNvy[0] ? sell({ customer: 'Rupa Apparel House', lot: lotsNvy[0], product: 'SJ-160-NVY', kg: 250, pay: 'before_dispatch', deliver: true, lr: 'VRL-770655', utr: 'SBINR52026102877' }) : Promise.resolve());
    await story('Kolkata Hosiery fleece, in transit', () => lotsFlc[0] ? sell({ customer: 'Kolkata Hosiery Works', lot: lotsFlc[0], product: 'FLC-320-CHR', kg: 200, pay: 'before_dispatch', deliver: false, lr: 'VRL-771020', utr: 'UTIBR52026103042' }) : Promise.resolve());
    await story('Sri Murugan rib, invoiced and on the way', () => lotsNvy[1] ? sell({ customer: 'Sri Murugan Garments', lot: lotsNvy[1], product: 'RIB-240-NVY', kg: 150, pay: 'none', deliver: false, lr: 'VRL-771101', utr: '' }) : Promise.resolve());

    // ---------- P8: opening balances, bank, supplier payment, expenses, bank statement, GSTR-2B ----------
    await drain();
    const owner = await login('owner@textile.local');
    const decideAll = async () => {
      await drain();
      const pend = await call<{ items: { id: string; source_service: string }[] }>('governance', owner, 'GET', '/approvals?f_status=pending&pageSize=100');
      for (const a of pend.items.filter((x) => x.source_service === 'finance')) await call('governance', owner, 'POST', `/approvals/${a.id}/decide`, { decision: 'approved', comment: 'Checked' });
      await drain();
    };
    const books = await call<{ id: string; state_code: string; gstin: string }[]>('finance', accounts, 'GET', '/books');
    const surat = books.find((b) => b.state_code === '24')!;
    const acc = await call<{ id: string; code: string }[]>('finance', accounts, 'GET', '/accounts');
    const a = (code: string) => acc.find((x) => x.code === code)!.id;
    // Opening stock: the stock carried in from before 1 April, at its cost. This year's purchases are booked as they
    // happen, and stock on hand is valued at the period end, so cost of sales comes out right.
    const openingStock = Math.round(openingValue * 100) / 100;
    await call('finance', accounts, 'POST', '/vouchers', { voucher_type: 'opening', book_id: surat.id, date: '2026-04-01', narration: 'Opening balances as on 1 April 2026 (from the previous system, CA-certified)',
      lines: [{ account_id: a('1200'), debit: 9500000 }, { account_id: a('1800'), debit: 350000 }, { account_id: a('1700'), debit: 150000 }, ...(openingStock ? [{ account_id: a('1400'), debit: openingStock }, { account_id: a('3200'), credit: openingStock }] : []), { account_id: a('3100'), credit: 2000000 }, { account_id: a('2400'), credit: 8000000 }] });
    const ba = await call<{ id: string }>('finance', accounts, 'POST', '/bank-accounts', { account_id: a('1200'), book_id: surat.id, bank_name: 'ICICI Bank, Ring Road Surat', account_no: '000405012345', ifsc: 'ICIC0000004' });
    // ---------- Trading before go-live: April to the month before the ERP went live, from the previous system ----------
    // Loaded the way the client will load theirs: sales and purchase history CSVs through Go-live → Data migration
    // (posted on their own dates to sales, purchases, GST and party accounts), monthly overheads, and the GSTR-3B
    // payments. Purchases match what was sold at cost, so today's physical stock is unaffected.
    // Trading moved to the ERP at the start of this month: the ERP's own sales in the demo are recent, so every earlier
    // month is the previous system's. HR and payroll moved earlier (the payroll below covers those months), so the
    // previous system's books stop there for salaries.
    const goLive = `${daysAgo(0).slice(0, 7)}-01`;
    const erpRentMonth = daysAgo(6).slice(0, 7);
    const erpPayrollMonth = daysAgo(60).slice(0, 7);
    const legacyMonths: string[] = [];
    for (let d = new Date('2026-04-01T00:00:00Z'); d.toISOString().slice(0, 10) < goLive; d.setUTCMonth(d.getUTCMonth() + 1)) legacyMonths.push(d.toISOString().slice(0, 7));
    const SKUS: Record<string, { cost: number; sell: number; supplier: string }> = {
      'SJ-160-NVY': { cost: 245, sell: 292, supplier: 'Shree Ambica Knitters' }, 'RIB-240-NVY': { cost: 288, sell: 344, supplier: 'Shree Ambica Knitters' },
      'SJ-180-BLK': { cost: 258, sell: 308, supplier: 'Shree Ambica Knitters' }, 'INT-220-RFD': { cost: 232, sell: 276, supplier: 'Velavan Knit Fab' },
      'FLC-320-CHR': { cost: 305, sell: 364, supplier: 'Velavan Knit Fab' }, 'SJ-140-MEL': { cost: 212, sell: 252, supplier: 'Velavan Knit Fab' },
      'PIQ-210-WHT': { cost: 276, sell: 329, supplier: 'Ganesh Yarn & Fabrics' }, 'SJL-200-WHT': { cost: 318, sell: 379, supplier: 'Ganesh Yarn & Fabrics' },
    };
    const skuList = Object.keys(SKUS);
    const buyers: [string, number, number][] = [['Sri Murugan Garments', 40, 30], ['Kolkata Hosiery Works', 25, 20], ['Rupa Apparel House', 30, 20], ['Delhi Fashion Hub', 35, 15], ['Ludhiana Knit Exports', 55, 15]];
    const pick = (i: number) => { let x = (i * 37) % 100; for (const b of buyers) { if (x < b[2]) return b; x -= b[2]; } return buyers[0]!; };
    const day = (m: string, d: number) => `${m}-${String(Math.min(28, Math.max(1, d))).padStart(2, '0')}`;
    const plusDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
    const salesRows = ['customer,invoice_no,invoice_date,sku,kg,rate_per_kg,gst_rate,paid_on'];
    const buyRows = ['supplier,bill_no,bill_date,sku,kg,rate_per_kg,gst_rate,paid_on'];
    const openSales: { customer: string; doc: string; date: string; due: string; total: number }[] = [];
    const openBuys: { supplier: string; doc: string; date: string }[] = [];
    let inv = 0, bill = 0;
    for (const [mi, m] of legacyMonths.entries()) {
      const bought = new Map<string, number>();
      const count = 22 + (mi % 3) + Math.min(mi, 3);
      for (let k = 0; k < count; k++) {
        const n = mi * 40 + k;
        const [cust, days] = pick(n);
        const no = `OLD/2627/${String(++inv).padStart(4, '0')}`;
        const date = day(m, 1 + Math.round((k * 27) / count));
        const lines = 1 + (n % 3 === 0 ? 1 : 0);
        let total = 0;
        const paid = plusDays(date, days);
        // Ludhiana's cheques for the last month before go-live bounced: those invoices are still owed (credit is blocked).
        const settled = paid < goLive && !(cust === 'Ludhiana Knit Exports' && m === legacyMonths[legacyMonths.length - 1]);
        for (let l = 0; l < lines; l++) {
          const sku = skuList[(n * 3 + l * 5) % skuList.length]!;
          const kg = 600 + ((n * 131 + l * 77) % 9) * 120;
          const rate = SKUS[sku]!.sell + ((n + l) % 5) - 2;
          salesRows.push(`${cust},${no},${date},${sku},${kg},${rate},5,${settled ? paid : ''}`);
          bought.set(sku, (bought.get(sku) ?? 0) + kg);
          total += kg * rate * 1.05;
        }
        if (!settled) openSales.push({ customer: cust, doc: no, date, due: paid, total: Math.round(total * 100) / 100 });
      }
      // Bought what was sold, from each fabric's usual supplier, in two lots a month.
      const bySupplier = new Map<string, [string, number][]>();
      for (const [sku, kg] of bought) bySupplier.set(SKUS[sku]!.supplier, [...(bySupplier.get(SKUS[sku]!.supplier) ?? []), [sku, kg]]);
      for (const [sup, items] of bySupplier) for (const half of [0, 1]) {
        const no = `${sup.split(' ').map((w) => w[0]).join('')}/OLD/${String(++bill).padStart(4, '0')}`;
        const date = day(m, half ? 16 : 3);
        const paid = plusDays(date, 30);
        const settled = paid < goLive;
        for (const [sku, kg] of items) buyRows.push(`${sup},${no},${date},${sku},${Math.round(kg / 2)},${SKUS[sku]!.cost},5,${settled ? paid : ''}`);
        if (!settled) openBuys.push({ supplier: sup, doc: no, date });
      }
    }
    // One recent Delhi invoice stays open: the bank statement below carries their transfer for it, to match on screen.
    const heldOpen = openSales.filter((o) => o.customer === 'Delhi Fashion Hub').pop();
    const migrate = async (object_type: string, csv: string) => {
      const b = await call<{ id: string; invalid: number }>('golive', admin, 'POST', '/migration/batches', { object_type, csv, file_name: `${object_type}-previous-system.csv` });
      if (b.invalid) console.error(`[seed] ${object_type}: ${b.invalid} rows did not validate`);
      await call('golive', admin, 'POST', `/migration/batches/${b.id}/import`);
      await drain();
      await call('golive', admin, 'POST', `/migration/batches/${b.id}/reconcile`);
    };
    try {
      await migrate('purchase_history', buyRows.join('\n'));
      await migrate('sales_history', salesRows.join('\n'));
      // Overheads in the previous system, month by month: salaries, rent, power, freight.
      for (const m of legacyMonths) {
        const end = day(m, 28);
        if (m < erpPayrollMonth) await call('finance', accounts, 'POST', '/vouchers', { voucher_type: 'payment', book_id: surat.id, date: end, narration: `Salaries for ${m} (previous system)`, reference: `SAL-${m}`,
          lines: [{ account_id: a('5400'), debit: 905000 }, { account_id: a('5410'), debit: 51500 }, { account_id: a('1200'), credit: 956500 }] });
        if (m !== erpRentMonth) await call('finance', accounts, 'POST', '/vouchers', { voucher_type: 'payment', book_id: surat.id, date: day(m, 5), narration: `Godown rent, Surat — ${m} (previous system)`, reference: `RENT-${m}`,
          lines: [{ account_id: a('5500'), debit: 85000 }, { account_id: a('1200'), credit: 85000 }] });
        // The last month's power bill is paid after go-live, in the ERP (below).
        const power = m === legacyMonths[legacyMonths.length - 1] ? 0 : 19800;
        await call('finance', accounts, 'POST', '/vouchers', { voucher_type: 'payment', book_id: surat.id, date: day(m, 12), narration: `${power ? 'DGVCL power and freight' : 'Freight'} outward — ${m} (previous system)`, reference: `EXP-${m}`,
          lines: [...(power ? [{ account_id: a('5510'), debit: power }] : []), { account_id: a('5310'), debit: 64000 }, { account_id: a('1200'), credit: 64000 + power }] });
      }
      // After go-live: customers pay the invoices open at cutover when due (Ludhiana's bounced cheques stay unpaid),
      // and the older open bills are paid.
      for (const o of openSales) {
        if (o.customer === 'Ludhiana Knit Exports' || o === heldOpen) continue;
        await call('finance', accounts, 'POST', '/vouchers', { voucher_type: 'receipt', book_id: surat.id, date: [goLive, [o.due, daysAgo(2)].sort()[0]!].sort()[1], narration: `Received from ${o.customer} against ${o.doc}`, reference: `NEFT-IN-${o.doc.slice(-4)}`,
          lines: [{ account_id: a('1200'), debit: o.total }, { account_id: a('1300'), credit: o.total, party_id: party(o.customer), bill_ref: o.doc }] });
      }
      for (const [i, o] of openBuys.entries())
        if (o.date < plusDays(goLive, -15)) await call('finance', accounts, 'POST', '/supplier-payments', { party_id: party(o.supplier), invoice_number: o.doc, date: [goLive, [plusDays(goLive, 5 + (i * 5) % 45), daysAgo(2)].sort()[0]!].sort()[1], mode: 'neft', reference: `NEFT-OUT-${o.doc.slice(-4)}` });
      await decideAll();
      // GSTR-3B paid on the 20th of each following month, for every month the return is due.
      for (const m of [...legacyMonths, ...[daysAgo(60), daysAgo(30)].map((d) => d.slice(0, 7))].filter((x, i, arr) => arr.indexOf(x) === i)) {
        const paidOn = day(new Date(Date.parse(`${m}-01T00:00:00Z`) + 32 * 86_400_000).toISOString().slice(0, 7), 20);
        if (paidOn > daysAgo(0)) continue;
        await call('finance', accounts, 'POST', '/gst/payments', { book_id: surat.id, period: `${m}-01`, paid_on: paidOn, arn: `AA24${m.replace('-', '')}0${String(m.slice(5)).padStart(2, '0')}1`, challan_ref: `CPIN-${m.replace('-', '')}` }).catch((e) => console.error(`[seed] GSTR-3B ${m}: ${(e as Error).message}`));
      }
    } catch (e) { console.error(`[seed] history before go-live skipped: ${(e as Error).message}`); }
    await call('finance', accounts, 'POST', '/vouchers', { voucher_type: 'payment', book_id: surat.id, date: daysAgo(6), narration: `Godown rent, Surat — ${new Date(`${erpRentMonth}-01T00:00:00Z`).toLocaleString('en-IN', { month: 'long', timeZone: 'UTC' })}`, reference: 'NEFT 2610-778', lines: [{ account_id: a('5500'), debit: 85000 }, { account_id: a('1200'), credit: 85000 }] });
    await call('finance', accounts, 'POST', '/vouchers', { voucher_type: 'payment', book_id: surat.id, date: daysAgo(4), narration: `DGVCL power bill — ${new Date(`${legacyMonths[legacyMonths.length - 1] ?? daysAgo(30).slice(0, 7)}-01T00:00:00Z`).toLocaleString('en-IN', { month: 'long', timeZone: 'UTC' })}`, lines: [{ account_id: a('5510'), debit: 18450 }, { account_id: a('1200'), credit: 18450 }] });
    // Pay the oldest supplier bill outstanding.
    const apAge = await call<{ rows: { party_id: string; party_name: string; balance: number }[] }>('finance', accounts, 'GET', '/ageing/payables');
    const payee = apAge.rows.find((r) => r.balance > 0);
    let paid = 0;
    if (payee) {
      paid = Math.min(payee.balance, 95000);
      await call('finance', accounts, 'POST', '/vouchers', { voucher_type: 'payment', book_id: surat.id, date: daysAgo(3), narration: `Part payment to ${payee.party_name}`, reference: 'NEFT ICICN52026103', lines: [{ account_id: a('2100'), debit: paid, party_id: payee.party_id }, { account_id: a('1200'), credit: paid }] });
    }
    // A supplier payment run for the bills now due: one bank file for everything released (approved payments join it).
    {
      const due = (await call<{ party_id: string; doc_no: string; days_overdue: number; bank: unknown; awaiting_approval: boolean }[]>('finance', accounts, 'GET', '/payment-run/candidates'))
        .filter((x) => x.bank && !x.awaiting_approval && x.days_overdue >= 0).slice(0, 4);
      if (due.length) await call('finance', accounts, 'POST', '/payment-runs', { date: daysAgo(1), mode: 'neft', items: due.map((x) => ({ party_id: x.party_id, invoice_number: x.doc_no })) }).catch((e) => console.error(`[seed] payment run: ${(e as Error).message}`));
    }
    // A small write-off typed by hand against a customer: allowed, but flagged for review.
    await call('finance', accounts, 'POST', '/vouchers', { voucher_type: 'journal', book_id: surat.id, date: daysAgo(2), narration: 'Short payment written off on SO/2627/00001 freight', lines: [{ account_id: a('5900'), debit: 1180 }, { account_id: a('1300'), credit: 1180, party_id: party('Sri Murugan Garments') }] });
    await decideAll();
    // Gateway settlements into the bank, the payments above, charges, and a direct NEFT from a customer still to identify.
    const gw = (await call<{ amount: number; status: string; utr: string | null }[]>('commerce', accounts, 'GET', '/payments')).filter((p) => p.status === 'success');
    const fmt = (d: string) => d.split('-').reverse().join('/');
    let bal = 2500000;
    const rows: string[] = ['Txn Date,Description,Ref No,Debit,Credit,Balance'];
    const line = (d: string, desc: string, ref: string, dr: number, cr: number) => { bal += cr - dr; rows.push(`${fmt(d)},${desc},${ref},${dr || ''},${cr || ''},${bal.toFixed(2)}`); };
    line(daysAgo(6), 'NEFT-DR-SHREE LAXMI ESTATES-RENT', 'NEFT 2610-778', 85000, 0);
    line(daysAgo(4), 'BILLDESK DGVCL', 'BD7781120', 18450, 0);
    if (paid) line(daysAgo(3), `NEFT-DR-${payee!.party_name.toUpperCase()}`, 'NEFT ICICN52026103', paid, 0);
    for (const g of gw) line(daysAgo(1), 'ICICI PG SETTLEMENT', g.utr ?? 'PGSETTLE', 0, Number(g.amount));
    line(daysAgo(1), 'NEFT-CR-RUPA APPAREL HOUSE-ADV', 'SBIN426101155', 0, 50000);
    if (heldOpen) line(daysAgo(1), 'NEFT-CR-DELHI FASHION HUB PVT-PYMT', 'HDFC426101871', 0, heldOpen.total);
    line(daysAgo(0), 'SMS ALERT CHARGES', '', 59, 0);
    await call('finance', accounts, 'POST', `/bank-accounts/${ba.id}/statements`, { file_name: `icici-${daysAgo(0).slice(0, 7)}.csv`, csv: rows.join('\n') });
    // GSTR-2B for Surat: one supplier invoice matches, one differs, and one bill the supplier filed that we have not booked.
    const months = [...new Set([daysAgo(45), daysAgo(15), daysAgo(0)].map((d) => d.slice(0, 7)))];
    for (const m of months) {
      const g = await call<{ inward: { doc_no: string; doc_date: string; party_gstin: string | null; party_name: string; taxable: number; cgst: number; sgst: number; igst: number; doc_type: string }[] }>('finance', accounts, 'GET', `/gst/returns?book=${surat.id}&month=${m}`);
      const inv = g.inward.filter((x) => x.doc_type === 'invoice' && x.party_gstin);
      if (!inv.length) continue;
      const lines = inv.map((x, i) => ({ supplier_gstin: x.party_gstin!, supplier_name: x.party_name, invoice_no: x.doc_no, invoice_date: x.doc_date, taxable: x.taxable, igst: x.igst, cgst: i === 1 ? x.cgst + 250 : x.cgst, sgst: i === 1 ? x.sgst + 250 : x.sgst }));
      lines.push({ supplier_gstin: inv[0]!.party_gstin!, supplier_name: inv[0]!.party_name, invoice_no: 'GYF/2627/0419', invoice_date: `${m}-12`, taxable: 42000, igst: 0, cgst: 1050, sgst: 1050 });
      await call('finance', accounts, 'POST', '/gst/2b', { book_id: surat.id, month: m, lines });
      break;
    }
    // Months with no trading since the opening balances are reviewed and locked.
    const lastMonth = daysAgo(95).slice(0, 7);
    for (const pr of await call<{ month: string; status: string }[]>('finance', accounts, 'GET', '/periods'))
      if (pr.month.slice(0, 7) <= lastMonth && pr.status === 'open') await call('finance', accounts, 'POST', `/periods/${pr.month}/lock`, { value_stock: false, note: 'Reviewed with the CA' });
    await runFinanceChecks(services.find((s) => s.ctx.name === 'finance')!.ctx.pool);

    // ---------- P9: employees, attendance, leave, payroll; contracts; message delivery ----------
    await drain();
    const hr = await login('hr@textile.local');
    const users = await call<{ id: string; email: string; name: string }[]>('identity', admin, 'GET', '/directory');
    const uid = (e: string) => users.find((u) => u.email === e)?.id ?? null;
    const staff: [string, string | null, string, string, string, number, string, number, boolean][] = [
      // name, login, designation, department, location, basic, shift, weekly off, overtime eligible
      ['Amit Deva', 'owner@textile.local', 'Director', 'Management', 'Surat', 120000, 'GEN', 0, false],
      ['Priya Shah', 'purchase@textile.local', 'Purchase Manager', 'Procurement', 'Surat', 45000, 'GEN', 0, false],
      ['Rakesh Patel', 'surat.stores@textile.local', 'Stores Manager', 'Warehouse', 'Surat', 32000, 'WH1', 0, false],
      ['Lakshmi Narayanan', 'accounts@textile.local', 'Accounts Manager', 'Finance', 'Surat', 42000, 'GEN', 0, false],
      ['Neha Kapoor', 'salesmgr@textile.local', 'Sales Manager', 'Sales', 'Surat', 50000, 'GEN', 0, false],
      ['Arjun Mehta', 'sales@textile.local', 'Sales Executive', 'Sales', 'Surat', 22000, 'GEN', 0, false],
      ['Selvi Raman', 'sales.south@textile.local', 'Sales Executive', 'Sales', 'Tiruppur', 21000, 'GEN', 0, false],
      ['Sourav Ghosh', 'sales.east@textile.local', 'Sales Executive', 'Sales', 'Kolkata', 21000, 'GEN', 0, false],
      ['Karthik Raman', 'millops@textile.local', 'Mill Operations Manager', 'Operations', 'Surat', 38000, 'GEN', 0, false],
      ['Imran Shaikh', 'dispatch@textile.local', 'Dispatch Manager', 'Warehouse', 'Surat', 30000, 'WH1', 0, false],
      ['Farida Khan', 'hr@textile.local', 'HR Manager', 'Human Resources', 'Surat', 36000, 'GEN', 0, false],
      ['Mahesh Vasava', null, 'Warehouse Operator', 'Warehouse', 'Surat', 9500, 'WH1', 3, true],
      ['Sunil Rathod', null, 'Warehouse Operator', 'Warehouse', 'Surat', 9500, 'WH2', 3, true],
      ['Bapi Das', null, 'Loader', 'Warehouse', 'Kolkata', 8500, 'WH1', 0, true],
      ['Rekha Solanki', null, 'Accounts Assistant', 'Finance', 'Surat', 14000, 'GEN', 0, false],
    ];
    const emp: Record<string, string> = {};
    for (const [i, [name, login, desig, dept, loc, basic, shift, off, ot]] of staff.entries()) {
      const joined = name === 'Rekha Solanki' ? daysAgo(50) : `20${String(19 + (i % 6)).padStart(2, '0')}-0${1 + (i % 9)}-1${i % 9}`;
      const e = await call<{ id: string }>('hrms', hr, 'POST', '/employees', { name, email: login, phone: `98250${String(10000 + i * 731).slice(0, 5)}`, designation: desig, department: dept, location: loc, date_of_joining: joined, user_id: login ? uid(login) : null,
        pan: `ABCP${String.fromCharCode(65 + i)}${1000 + i}K`.slice(0, 10), uan: `1009${String(42210000 + i * 37)}`, bank_account: `5010${String(20044000 + i * 113)}`, ifsc: 'HDFC0001234', shift_code: shift, weekly_off: off, pt_state: loc === 'Kolkata' ? '19' : loc === 'Tiruppur' ? '33' : '24', overtime_eligible: ot });
      emp[name] = e.id;
      const hra = Math.round(basic * 0.4), special = Math.round(basic * 0.25);
      await call('hrms', hr, 'POST', `/employees/${e.id}/salary`, { effective_from: '2026-04-01', basic, hra, conveyance: 1600, special, other: 0, pf_applicable: true, pf_on_capped_wage: true });
      await call('hrms', hr, 'POST', `/employees/${e.id}/lifecycle`, { action: 'start_probation', effective_date: joined });
      if (name !== 'Rekha Solanki') await call('hrms', hr, 'POST', `/employees/${e.id}/lifecycle`, { action: 'confirm', effective_date: joined });
    }
    // Attendance for the last two months and this month to date: mostly present, a few late arrivals, absences and Sunday work.
    const days: string[] = [];
    for (let d = new Date(`${daysAgo(60).slice(0, 7)}-01T00:00:00Z`); d.toISOString().slice(0, 10) < daysAgo(0); d.setUTCDate(d.getUTCDate() + 1)) days.push(d.toISOString().slice(0, 10));
    const offOf = Object.fromEntries(staff.map((x) => [x[0], x[7]]));
    for (const [di, day] of days.entries()) {
      const dowN = new Date(`${day}T00:00:00Z`).getUTCDay();
      const entries = staff.filter(([name]) => !(name === 'Rekha Solanki' && day < daysAgo(50))).map(([name, , , , , , shift], k) => {
        const off = dowN === offOf[name];
        if (off && !(name === 'Mahesh Vasava' && di % 14 === 3)) return { employee_id: emp[name]!, status: 'weekly_off' as const };
        if ((k * 7 + di) % 41 === 0) return { employee_id: emp[name]!, status: 'absent' as const, note: 'Did not report' };
        if ((k * 5 + di) % 53 === 0) return { employee_id: emp[name]!, status: 'half_day' as const };
        const start = shift === 'WH1' ? 8 : shift === 'WH2' ? 14 : 9;
        const late = (k + di) % 9 === 0 ? 25 : 0;
        const inT = `${String(start).padStart(2, '0')}:${String((shift === 'GEN' ? 25 : 0) + late).padStart(2, '0')}`;
        const outH = Math.min(23, start + (shift === 'GEN' ? 9 : 8) + ((k + di) % 6 === 0 && shift !== 'GEN' ? 2 : 0));
        return { employee_id: emp[name]!, status: 'present' as const, in_time: inT, out_time: `${String(outH).padStart(2, '0')}:${shift === 'GEN' ? '40' : '35'}` };
      });
      await call('hrms', hr, 'PUT', '/attendance', { day, entries });
    }
    // Sourav is on approved leave today (lead allocation skips him); Selvi has leave waiting for approval.
    const sourav = await call<{ id: string }>('hrms', hr, 'POST', '/leave', { employee_id: emp['Sourav Ghosh'], leave_type: 'EL', from_date: daysAgo(0), to_date: inDays(2), reason: 'Family function in Siliguri' });
    await call('hrms', hr, 'POST', '/leave', { employee_id: emp['Selvi Raman'], leave_type: 'CL', from_date: inDays(6), to_date: inDays(7), reason: 'Personal work' });
    await drain();
    const ownerTok = await login('owner@textile.local');
    const pendingApprovals = await call<{ items: { id: string; ref_id: string }[] }>('governance', ownerTok, 'GET', '/approvals?f_status=pending&pageSize=100');
    const lv = pendingApprovals.items.find((a) => a.ref_id === sourav.id);
    if (lv) await call('governance', ownerTok, 'POST', `/approvals/${lv.id}/decide`, { decision: 'approved', comment: 'Approved; Arjun covers East leads' });
    await drain();
    // The last two months' payroll: prepared, approved and paid (finance posts the salary and the bank transfer).
    const runPayroll = async (payMonth: string, paidOn: string) => {
      await call('hrms', hr, 'POST', `/payroll/${payMonth}/prepare`);
      await call('hrms', hr, 'POST', `/payroll/${payMonth}/submit`);
      await drain();
      const prApproval = (await call<{ items: { id: string; approval_type: string }[] }>('governance', ownerTok, 'GET', '/approvals?f_status=pending&pageSize=100')).items.find((a) => a.approval_type === 'payroll_run');
      if (prApproval) await call('governance', ownerTok, 'POST', `/approvals/${prApproval.id}/decide`, { decision: 'approved', comment: 'Checked against attendance' });
      await drain();
      await call('hrms', hr, 'POST', `/payroll/${payMonth}/pay`, { paid_on: paidOn });
      await drain();
    };
    try { await runPayroll(daysAgo(60).slice(0, 7), `${daysAgo(30).slice(0, 7)}-01`); } catch (e) { console.error(`[seed] history payroll skipped: ${(e as Error).message}`); }
    await runPayroll(daysAgo(30).slice(0, 7), `${daysAgo(0).slice(0, 7)}-01`);
    // A warehouse operator has resigned; the exit checklist and a handover task are open.
    await call('hrms', hr, 'POST', `/employees/${emp['Sunil Rathod']}/lifecycle`, { action: 'resign', effective_date: daysAgo(5), last_working_day: inDays(25), reason: 'Moving back to his village' });
    // Recruitment for the Kolkata warehouse.
    const op = await call<{ id: string }>('hrms', hr, 'POST', '/openings', { title: 'Warehouse picker', department: 'Warehouse', location: 'Kolkata', positions: 2 });
    for (const [n, st] of [['Rahul Mondal', 'interview'], ['Tapas Saha', 'screening'], ['Imtiaz Ali', 'applied']] as const) {
      const cnd = await call<{ id: string }>('hrms', hr, 'POST', `/openings/${op.id}/candidates`, { name: n, phone: '9830012345', source: 'Walk-in' });
      if (st !== 'applied') await call('hrms', hr, 'POST', `/candidates/${cnd.id}/stage`, { stage: st });
    }
    // Contracts: supply rates with Ambica, job-work rates with Surat Process House (renewal due soon), transport and the godown lease.
    await call('workflow', purchase, 'POST', '/contracts', { kind: 'supply', title: 'Annual grey fabric supply 2026-27', party_id: party('Shree Ambica Knitters'), start_date: '2026-04-01', end_date: '2027-03-31', value: 4500000,
      rates: [{ item: 'SJ-160 grey', rate: 246, uom: 'kg' }, { item: 'RIB-240 grey', rate: 268, uom: 'kg' }], payment_terms: '30 days from invoice; 1% discount if paid in 7 days', quality_terms: 'GSM ±3%, width ±1 inch; shade variation per lot; rejection replaced within 10 days', delivery_terms: 'Ex-mill Surat, within 10 days of PO', penalties: '0.5% per day of delay beyond 5 days, capped at 5%' });
    await call('workflow', millops, 'POST', '/contracts', { kind: 'job_work', title: 'Dyeing and compacting rate contract', party_id: party('Surat Process House'), start_date: daysAgo(353), end_date: inDays(12), value: 1800000,
      rates: [{ item: 'Reactive dyeing — dark shades', rate: 62, uom: 'kg' }, { item: 'Reactive dyeing — light shades', rate: 48, uom: 'kg' }, { item: 'Compacting', rate: 9, uom: 'kg' }], payment_terms: '45 days', quality_terms: 'Process loss up to 8%; shade within ΔE 1.0 of the approved lab dip', delivery_terms: '7 working days from receipt', penalties: 'Re-processing at mill cost for shade or GSM failures' });
    await call('workflow', admin, 'POST', '/contracts', { kind: 'transport', title: 'PTL freight agreement', party_id: party('VRL Logistics'), start_date: '2026-06-01', end_date: '2027-05-31', rates: [{ item: 'Surat → Tiruppur PTL', rate: 4.5, uom: 'kg' }, { item: 'Surat → Kolkata PTL', rate: 5.5, uom: 'kg' }], payment_terms: 'Fortnightly billing, 15 days', penalties: 'Shortage or damage settled at invoice value within 30 days' });
    await call('workflow', admin, 'POST', '/contracts', { kind: 'rent', title: 'Godown lease, Ring Road Surat', party_name: 'Shree Laxmi Estates', start_date: '2024-11-01', end_date: '2027-10-31', value: 1020000, rates: [{ item: 'Monthly rent', rate: 85000, uom: 'month' }], payment_terms: 'By the 5th of each month', penalties: '3 months notice; 5% escalation each November' });
    // A manual task in the dispatch queue.
    await call('workflow', salesMgr, 'POST', '/tasks', { title: 'Confirm transport slot for the Delhi 600 kg order once allocation is decided', queue_permission: 'fulfilment.dispatch', priority: 'high', due_at: new Date(Date.now() + 86_400_000).toISOString() });
    await drain();
    // ---------- P10: shared reports ----------
    await call('insights', accounts, 'POST', '/reports', { name: 'Sales by customer, month by month', definition: { dataset: 'sales_register', from: '2026-04-01', group_by: ['party_name', 'doc_date'], date_grain: 'month', measures: [{ field: 'taxable', agg: 'sum' }, { field: 'kg', agg: 'sum' }], sort: { field: 'sum_taxable', dir: 'desc' } }, shared: true, schedule: 'monthly' });
    await call('insights', stores, 'POST', '/reports', { name: 'Stock older than 60 days', definition: { dataset: 'stock_lots', filters: { logic: 'and', rules: [{ field: 'age_days', op: 'gt', value: 60 }] }, columns: ['lot_no', 'sku', 'kg', 'value', 'age_days', 'recommendation'], sort: { field: 'age_days', dir: 'desc' } }, shared: true, schedule: 'weekly' });
    await call('insights', salesMgr, 'POST', '/reports', { name: 'Leads by source and stage', definition: { dataset: 'leads', group_by: ['source_name', 'stage'], measures: [{ field: 'est_value', agg: 'sum' }, { field: 'number', agg: 'count_distinct' }] }, shared: true });
    // ---------- P11: UAT in progress, training under way, first cutover steps done ----------
    {
      const owner = await login('owner@textile.local');
      await seedScenarios(services.find((s) => s.ctx.name === 'golive')!.ctx.pool);
      const scen = await call<{ id: string; code: string; phase: string }[]>('golive', admin, 'GET', '/uat/scenarios');
      for (const sc of scen.filter((x) => ['P1', 'P2', 'P4'].includes(x.phase)))
        await call('golive', admin, 'POST', `/uat/scenarios/${sc.id}/result`, { result: 'passed', evidence: 'Run on the demo data; result matched the expected outcome' });
      const p7 = scen.find((x) => x.phase === 'P7');
      if (p7) await call('golive', stores, 'POST', `/uat/scenarios/${p7.id}/result`, { result: 'failed', evidence: 'Packing slip prints the roll count but not the total kg', defect: { title: 'Packing slip missing total weight', severity: 'S3' } });
      const tr = await call<{ staff: { id: string; email: string }[] }>('golive', admin, 'GET', '/training');
      const plan: Record<string, string[]> = { 'purchase@textile.local': ['PUR-1', 'PUR-2'], 'surat.stores@textile.local': ['STO-1'], 'accounts@textile.local': ['ACC-1'], 'salesmgr@textile.local': ['SAL-1'], 'admin@textile.local': ['ADM-1'] };
      const mods = (await call<{ modules: { code: string }[] }>('golive', admin, 'GET', '/training')).modules.map((m) => m.code);
      for (const [email, codes] of Object.entries(plan)) {
        const u = tr.staff.find((x) => x.email === email);
        const valid = codes.filter((c) => mods.includes(c));
        if (!u || !valid.length) continue;
        await call('golive', admin, 'POST', '/training/assign', { user_ids: [u.id], module_codes: valid });
        if (email !== 'accounts@textile.local') await call('golive', admin, 'POST', '/training/complete', { user_id: u.id, module_code: valid[0], score: 85 });
      }
      const cut = (await call<{ tasks: { id: string; seq: number }[] }>('golive', owner, 'GET', '/cutover')).tasks;
      for (const t of cut.filter((x) => x.seq <= 20)) await call('golive', owner, 'PATCH', `/cutover/${t.id}`, { status: 'done', notes: 'Checked during the dry run' });
    }
    const wf = services.find((s) => s.ctx.name === 'workflow')!.ctx.pool;
    await runContractChecks(wf);
    await dispatchMessages(wf);
    await runScheduled(wf);

    await drain();
    await runProcurementChecks(services.find((s) => s.ctx.name === 'procurement')!.ctx.pool);
    await runJobworkChecks(services.find((s) => s.ctx.name === 'jobwork')!.ctx.pool);
    await runCrmChecks(services.find((s) => s.ctx.name === 'crm')!.ctx.pool);
    await drain();
  } finally {
    for (const s of servers) s.close();
  }
}
