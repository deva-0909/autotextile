/**
 * Demo data for counter sales, the cash closing, manual invoices with approval, scheduled stock counts, and a mill
 * return with wrong goods held in quarantine and a shortage still owed.
 */
type Call = <T = any>(svc: string, token: string | null, method: string, path: string, body?: unknown) => Promise<T>;

export async function seedOpsExtras(o: { call: Call; login: (email: string) => Promise<string>; party: (name: string) => string; drain: () => Promise<unknown> }) {
  const { call } = o;
  const admin = await o.login('admin@textile.local');
  const owner = await o.login('owner@textile.local');
  const accounts = await o.login('accounts@textile.local');
  const millops = await o.login('millops@textile.local');
  const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
  const wh = await call<{ id: string; code: string }[]>('organisation', admin, 'GET', '/warehouses');
  const SRT = wh.find((w) => w.code === 'SRT')!.id;
  const products = (await call<{ items: { id: string; sku: string }[] }>('masters', admin, 'GET', '/products?pageSize=50')).items;
  const sku = (s: string) => products.find((p) => p.sku === s)!.id;
  const books = await call<{ id: string; code: string; is_primary: boolean }[]>('finance', accounts, 'GET', '/books');
  const surat = books.find((b) => b.is_primary)!.id;
  const approve = async (refId: string) => {
    await o.drain();
    const a = (await call<{ items: { id: string; ref_id: string }[] }>('governance', owner, 'GET', '/approvals?f_status=pending&pageSize=200')).items.find((x) => x.ref_id === refId);
    if (a) await call('governance', owner, 'POST', `/approvals/${a.id}/decide`, { decision: 'approved', comment: 'Checked against the bill' });
    await o.drain();
  };

  // Stock count schedule for Surat: fast movers weekly, high value monthly, the whole warehouse at year end.
  await call('inventory', admin, 'POST', '/count-schedules', { name: 'Weekly fast movers', warehouse_id: SRT, scope: 'fast_moving', top_n: 5, frequency: 'weekly', next_due: day(2), blind: true });
  await call('inventory', admin, 'POST', '/count-schedules', { name: 'Monthly high value', warehouse_id: SRT, scope: 'high_value', top_n: 3, frequency: 'monthly', next_due: day(9), blind: true });
  const fy = new Date().getMonth() >= 3 ? new Date().getFullYear() + 1 : new Date().getFullYear();
  await call('inventory', admin, 'POST', '/count-schedules', { name: 'Year-end full count', warehouse_id: SRT, scope: 'full', frequency: 'yearly', next_due: `${fy}-03-31`, blind: true });

  // A counter cash sale of two rolls to a walk-in buyer, and the day's cash closing.
  const rolls = await call<{ barcode: string; price_per_kg: number | null; sku: string }[]>('inventory', admin, 'GET', `/rolls?warehouse=${SRT}&state=available`);
  const pick = rolls.filter((r) => r.price_per_kg && r.sku === 'SJ-160-NVY').slice(0, 2);
  const two = pick.length === 2 ? pick : rolls.filter((r) => r.price_per_kg).slice(0, 2);
  if (two.length) {
    const body = { book_id: surat, buyer_name: 'Hitesh Bhai (walk-in)', buyer_mobile: '9825566778', barcodes: two.map((r) => r.barcode), payment_mode: 'cash', notes: 'Walk-in at the Ring Road godown' };
    const pv = await call<{ total: number }>('finance', accounts, 'POST', '/counter-sales', { ...body, amount_received: 0, preview: true });
    await call('finance', accounts, 'POST', '/counter-sales', { ...body, amount_received: Math.ceil(pv.total / 100) * 100 });
    const cb = await call<{ closing: number }>('finance', accounts, 'GET', `/cash-book?book_id=${surat}`);
    await call('finance', accounts, 'POST', '/cash-closings', { book_id: surat, counted: cb.closing, denominations: { 500: Math.floor(cb.closing / 500) }, note: null });
  }

  // A manual purchase invoice (freight, no purchase order), approved and posted; and a manual sales invoice waiting for approval.
  const fr = await call<{ id: string }>('finance', accounts, 'POST', '/manual-invoices', { kind: 'purchase', book_id: surat, doc_date: day(-2), party_id: o.party('VRL Logistics'), supplier_invoice_no: 'VRL/SRT/26-27/1184', notes: 'Outward freight, October',
    lines: [{ description: 'Freight Surat → Tiruppur, 3 trips', hsn: '9965', qty: 3, uom: 'trip', rate: 14500, gst_rate: 12, account: '5310' }] });
  await call('finance', accounts, 'POST', `/manual-invoices/${fr.id}/submit`, {});
  await approve(fr.id);
  const ws = await call<{ id: string }>('finance', accounts, 'POST', '/manual-invoices', { kind: 'sales', book_id: surat, doc_date: day(0), party_id: o.party('Rupa Apparel House'), notes: 'Cutting waste collected from the godown',
    lines: [{ description: 'Knitted fabric cuttings (waste)', hsn: '6310', qty: 420, uom: 'kg', rate: 38, gst_rate: 5 }] });
  await call('finance', accounts, 'PUT', `/manual-invoices/${ws.id}`, { kind: 'sales', book_id: surat, doc_date: day(0), party_id: o.party('Rupa Apparel House'), notes: 'Cutting waste collected from the godown', change_note: 'Weighed again at the gate: 436 kg',
    lines: [{ description: 'Knitted fabric cuttings (waste)', hsn: '6310', qty: 436, uom: 'kg', rate: 38, gst_rate: 5 }] });
  await call('finance', accounts, 'POST', `/manual-invoices/${ws.id}/submit`, {});

  // A mill return with someone else's rolls mixed in (held in quarantine) and 40 kg still owed.
  const jw = await call<{ id: string }>('jobwork', millops, 'POST', '/orders', { mill_id: o.party('Palladam Compacting Works'), process_code: 'COMPACT_ONLY', expected_return_date: day(-20), instructions: 'Compact to 240 GSM, width 36"',
    lines: [{ source: 'warehouse', warehouse_id: SRT, product_id: sku('RIB-240-NVY'), kg_sent: 400 }] });
  await call('jobwork', millops, 'POST', `/orders/${jw.id}/issue`, { issue_date: day(-36) });
  await call('jobwork', millops, 'POST', `/orders/${jw.id}/acknowledge`, { kg_received: 400 });
  await call('jobwork', millops, 'POST', `/orders/${jw.id}/returns`, { return_date: day(-3), warehouse_id: SRT, mill_challan_no: 'PCW/RC/802', kg_good: 300, kg_process_loss: 20, loss_reason: 'Compacting loss', rolls: 12,
    kg_quarantine: 40, quarantine_rolls: 2, quarantine_reason: 'wrong_shade', quarantine_note: 'Two rolls are maroon (another party’s lot tag PCW-5521); ours were navy' });
  await o.drain();
}
