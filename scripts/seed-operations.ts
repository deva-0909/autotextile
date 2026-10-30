/**
 * Loads example procurement and job-work activity through the services' own APIs,
 * so the demo data is validated, numbered and audited exactly like real use.
 */
import type { AddressInfo } from 'node:net';
import { type RunningService, type ServiceName, setServicePorts } from '@erp/platform';
import { DEMO_PASSWORD } from './seed-data.ts';
import { runProcurementChecks } from '../services/procurement/src/automation.ts';
import { runJobworkChecks } from '../services/jobwork/src/automation.ts';

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

    const wh = await call<{ id: string; code: string }[]>('organisation', admin, 'GET', '/warehouses');
    const SRT = wh.find((w) => w.code === 'SRT')!.id;
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

    // 7. Compacting job from the Surat warehouse, returned with low yield and a quality claim
    const jw2 = await call('jobwork', millops, 'POST', '/orders', { mill_id: party('Palladam Compacting Works'), process_code: 'COMPACT_ONLY', expected_return_date: daysAgo(2), lines: [{ source: 'warehouse', warehouse_id: SRT, product_id: sku('RIB-240-NVY'), kg_sent: 588, rolls: 24, lot_ref: 'L-SRT-0412' }] });
    await call('jobwork', millops, 'POST', `/orders/${jw2.id}/issue`, { issue_date: daysAgo(10) });
    await call('jobwork', millops, 'POST', `/orders/${jw2.id}/acknowledge`, { kg_received: 588 });
    await call('jobwork', millops, 'POST', `/orders/${jw2.id}/stages`, { stage_code: 'COMPACTING', status: 'completed' });
    await call('jobwork', millops, 'POST', `/orders/${jw2.id}/stages`, { stage_code: 'FINAL_QC', status: 'qc_failed', note: 'Shade bleeding on 3 rolls after compacting' });
    await call('jobwork', millops, 'POST', `/orders/${jw2.id}/ready`, { note: 'Ready for pickup' });
    await call('jobwork', millops, 'POST', `/orders/${jw2.id}/returns`, { return_date: daysAgo(1), warehouse_id: SRT, mill_challan_no: 'PCW/RC/771', kg_good: 498, kg_rejected: 60, kg_damaged: 6, kg_process_loss: 24, rolls: 24, lot_ref: 'L-SRT-0412-C', loss_reason: 'Shade bleeding and edge damage from compactor' });
    await call('jobwork', millops, 'POST', '/claims', { job_order_id: jw2.id, defect_types: ['Shade variation', 'Finishing defect'], description: 'Three rolls show shade bleeding after compacting; edges damaged on one roll.', kg_affected: 66, samples: 'Swatches kept at Surat QC desk', claim_type: 'debit_note', amount: 18150 });

    // 8. A challan the mill has not acknowledged, to show the overdue clock
    const jw3 = await call('jobwork', millops, 'POST', '/orders', { mill_id: party('Tiruppur Dyeing & Finishing'), process_code: 'REACTIVE_DYE', expected_return_date: inDays(6), lines: [{ source: 'warehouse', warehouse_id: SRT, product_id: sku('INT-220-RFD'), kg_sent: 1400, rolls: 56, lot_ref: 'L-SRT-0398' }] });
    await call('jobwork', millops, 'POST', `/orders/${jw3.id}/issue`, { issue_date: daysAgo(5) });

    await drain();
    await runProcurementChecks(services.find((s) => s.ctx.name === 'procurement')!.ctx.pool);
    await runJobworkChecks(services.find((s) => s.ctx.name === 'jobwork')!.ctx.pool);
    await drain();
  } finally {
    for (const s of servers) s.close();
  }
}
