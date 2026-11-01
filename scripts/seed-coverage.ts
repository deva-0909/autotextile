/**
 * Demo data for the features the main load leaves empty, so every screen has something to open: sales returns and a
 * transport claim, a refund, a reservation extension waiting for approval, a revised purchase order, GSTR-1 filing,
 * an ITC reversal, TDS deducted on a mill bill and its challan, a rejected shade, filed documents, a leave handover,
 * contract correspondence, a supplier bank change waiting for approval, a duplicate enquiry, an invoice in the capture
 * workbench, a saved report snapshot, and go-live incidents and decisions.
 *
 * Each step stands alone: one that fails is reported and the rest still run.
 */
type Call = <T = any>(svc: string, token: string | null, method: string, path: string, body?: unknown, headers?: Record<string, string>) => Promise<T>;

type Q = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> };
export async function seedCoverage(o: { call: Call; login: (email: string) => Promise<string>; party: (name: string) => string; drain: () => Promise<unknown>; finance?: Q }) {
  const { call } = o;
  const tok: Record<string, string> = {};
  const as = async (email: string) => (tok[email] ??= await o.login(email));
  const list = <T>(x: T[] | { items: T[] }) => (Array.isArray(x) ? x : x?.items ?? []);
  const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
  const month = (back: number) => { const d = new Date(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - back); return d.toISOString().slice(0, 7); };
  const pdf = (title: string) => Buffer.from(`%PDF-1.4\n1 0 obj<< /Title (${title}) >>endobj\ntrailer<<>>\n%%EOF`);
  // Who does it: the first of these logins the action is allowed for.
  const by = async <T>(emails: string[], f: (t: string) => Promise<T>): Promise<T> => {
    let last: unknown;
    for (const e of emails) {
      try { return await f(await as(e)); } catch (err) { last = err; if (!/→ 403/.test((err as Error).message)) throw err; }
    }
    throw last;
  };
  const step = async (name: string, f: () => Promise<unknown>) => {
    try { await f(); await o.drain(); } catch (e) { console.error(`[seed] coverage: ${name} skipped: ${(e as Error).message}`); }
  };

  const wh = await call<{ id: string; code: string }[]>('organisation', await as('admin@textile.local'), 'GET', '/warehouses');
  const SRT = wh.find((w) => w.code === 'SRT')!.id;
  const books = await call<{ id: string; is_primary: boolean; gstin: string }[]>('finance', await as('accounts@textile.local'), 'GET', '/books');
  const book = books.find((b) => b.is_primary)!.id;
  const ourGstin = books.find((b) => b.is_primary)!.gstin;

  await step('sales return', async () => {
    const fs = list(await call<{ id: string; status: string; customer_id: string }[]>('fulfilment', await as('dispatch@textile.local'), 'GET', '/fulfilments?pageSize=200'));
    // A customer who paid online first: the credit note leaves them money that can then be refunded to the card or UPI.
    const online = new Set(list(await call<{ customer_id: string; gateway: string; status: string }[]>('commerce', await as('accounts@textile.local'), 'GET', '/payments?pageSize=300'))
      .filter((x) => x.gateway !== 'offline' && x.status === 'success').map((x) => x.customer_id));
    const ready = fs.filter((x) => ['dispatched', 'delivered'].includes(x.status)).sort((a, b) => Number(online.has(b.customer_id)) - Number(online.has(a.customer_id)));
    for (const f of ready.slice(0, 6)) {
      const d = await call<{ pick_list?: { barcode: string }[] }>('fulfilment', await as('dispatch@textile.local'), 'GET', `/fulfilments/${f.id}`);
      const roll = d.pick_list?.[0]?.barcode;
      if (!roll) continue;
      const rma = await by(['dispatch@textile.local', 'care@textile.local'], (t) => call<{ id: string }>('fulfilment', t, 'POST', '/returns', { fulfilment_id: f.id, barcodes: [roll], reason: 'Customer reports shade lighter than the approved sample' }));
      await call('fulfilment', await as('dispatch@textile.local'), 'POST', `/returns/${rma.id}/authorize`, { approve: true });
      await call('fulfilment', await as('dispatch@textile.local'), 'POST', `/returns/${rma.id}/receive`, { warehouse_id: SRT, barcodes: [roll] });
      await call('fulfilment', await as('dispatch@textile.local'), 'POST', `/returns/${rma.id}/disposition`, { lines: [{ barcode: roll, disposition: 'restock' }] });
      await call('fulfilment', await as('dispatch@textile.local'), 'POST', `/returns/${rma.id}/resolve`, { resolution: 'credit_note' });
      // A second request left waiting for authorisation.
      const second = d.pick_list?.[1]?.barcode;
      if (second) await by(['care@textile.local', 'dispatch@textile.local'], (t) => call('fulfilment', t, 'POST', '/returns', { fulfilment_id: f.id, barcodes: [second], reason: 'Two holes found while cutting; buyer wants a replacement' }));
      return;
    }
    throw new Error('no dispatched order with rolls to return');
  });

  await step('transport claim', async () => {
    const ships = list(await call<{ id: string; status: string; kg?: number; total_kg?: number }[]>('fulfilment', await as('dispatch@textile.local'), 'GET', '/shipments?pageSize=200'));
    const s = ships.find((x) => !['delivered', 'cancelled'].includes(x.status));
    if (!s) throw new Error('no shipment in transit');
    const kg = Number(s.kg ?? s.total_kg ?? 100);
    await call('fulfilment', await as('dispatch@textile.local'), 'POST', `/shipments/${s.id}/pod`, { received_by: 'Godown supervisor', kg_received: Math.max(1, Math.round((kg - 12) * 100) / 100), condition: 'short', remarks: 'One roll short on arrival; seal on the bale was broken' });
  });

  await step('refund', async () => {
    // Only online (gateway) payments are refunded here; bank and cash ones are refunded through Finance.
    const ps = list(await call<{ id: string; status: string; amount: number; gateway: string }[]>('commerce', await as('accounts@textile.local'), 'GET', '/payments?pageSize=200'));
    // A refund cannot exceed the customer's money not yet set against invoices: try each online payment in turn.
    for (const p of ps.filter((x) => x.status === 'success' && x.gateway !== 'offline'))
      for (const amount of [1500, 500]) {
        try {
          await call('commerce', await as('accounts@textile.local'), 'POST', `/payments/${p.id}/refund`, { amount, reason: 'Freight charged twice on the order; refund of the extra freight' });
          return;
        } catch (e) { if (!/→ (409|400)/.test((e as Error).message)) throw e; }
      }
    console.log('[seed] coverage: no customer has unapplied money to refund; refund demo left out');
  });

  await step('reservation extension', async () => {
    const os = list(await call<{ id: string; status: string }[]>('commerce', await as('salesmgr@textile.local'), 'GET', '/orders?pageSize=200'));
    const b = os.find((x) => x.status === 'booked');
    if (!b) throw new Error('no booked order');
    await by(['salesmgr@textile.local', 'sales@textile.local', 'care@textile.local'], (t) => call('commerce', t, 'POST', `/orders/${b.id}/extend`, { days: 3, reason: 'Buyer’s payment is in their bank’s approval queue; asked us to hold the rolls till Friday' }));
  });

  await step('purchase order revision', async () => {
    const pos = list(await call<{ id: string; status: string }[]>('procurement', await as('purchase@textile.local'), 'GET', '/purchase-orders?pageSize=200'));
    let po = pos.find((x) => ['approved', 'sent', 'accepted'].includes(x.status));
    if (!po) {
      // Approve the one waiting, then revise it.
      const waiting = pos.find((x) => x.status === 'pending_approval');
      if (!waiting) throw new Error('no purchase order to revise');
      const owner = await as('owner@textile.local');
      const a = list(await call<{ id: string; ref_id: string }[]>('governance', owner, 'GET', '/approvals?f_status=pending&pageSize=200')).find((x) => x.ref_id === waiting.id);
      if (!a) throw new Error('approval for the waiting PO not found');
      await call('governance', owner, 'POST', `/approvals/${a.id}/decide`, { decision: 'approved', comment: 'Rates checked against the last three POs' });
      await o.drain();
      po = waiting;
    }
    await call('procurement', await as('purchase@textile.local'), 'POST', `/purchase-orders/${po.id}/revise`, { reason: 'Supplier can deliver only 80% this month; quantity and delivery date to be revised' });
  });

  await step('GSTR-1 filing', async () => {
    await call('finance', await as('accounts@textile.local'), 'POST', '/gst/gstr1-filings', { book_id: book, period: `${month(1)}-01`, filed_on: day(0), arn: 'AA2410250123456' });
  });

  await step('ITC reversal', async () => {
    await call('finance', await as('accounts@textile.local'), 'POST', '/gst/itc-reversals', { gstin: ourGstin, supplier_name: 'Shree Ambica Knitters', doc_no: 'SAK/0915', doc_date: `${month(2)}-15`, reason: 'rule_37', period: `${month(0)}-01`, igst: 0, cgst: 1250, sgst: 1250, note: 'Not paid within 180 days of the invoice' });
  });

  await step('TDS on a mill bill and its challan', async () => {
    const mill = o.party('Surat Process House');
    await call('finance', await as('accounts@textile.local'), 'PUT', `/tds/parties/${mill}`, { pan: 'AAFCS3131E', tds_section: '194C' });
    const inv = await call<{ id: string }>('finance', await as('accounts.exec@textile.local'), 'POST', '/manual-invoices', {
      kind: 'purchase', book_id: book, doc_date: day(-3), party_id: mill, supplier_invoice_no: 'SPH/JW/2211',
      lines: [{ description: 'Dyeing and compacting charges, 1,850 kg', hsn: '998821', qty: 1850, uom: 'kg', rate: 34, gst_rate: 5 }],
    });
    await call('finance', await as('accounts.exec@textile.local'), 'POST', `/manual-invoices/${inv.id}/submit`, {});
    await o.drain();
    const owner = await as('owner@textile.local');
    const a = list(await call<{ id: string; ref_id: string }[]>('governance', owner, 'GET', '/approvals?f_status=pending&pageSize=200')).find((x) => x.ref_id === inv.id);
    if (a) await call('governance', owner, 'POST', `/approvals/${a.id}/decide`, { decision: 'approved', comment: 'Matches the job-work return' });
    await o.drain();
    const m = day(-3).slice(0, 7);
    await call('finance', await as('accounts@textile.local'), 'POST', '/tds/challans', { section: '194C', month: `${m}-01`, bsr_code: '0510308', challan_no: '00417', paid_on: day(0) });
  });

  await step('shade rejection', async () => {
    const products = list(await call<{ id: string; sku: string }[]>('masters', await as('admin@textile.local'), 'GET', '/products?pageSize=50'));
    const p = products.find((x) => /NVY/.test(x.sku)) ?? products[0]!;
    await by(['stores.assistant@textile.local', 'surat.stores@textile.local'], (t) => call('inventory', t, 'POST', '/shade-approvals', { customer_id: o.party('Rupa Apparel House'), product_id: p.id, shade_code: 'NVY-2', decision: 'rejected', note: 'Buyer finds lot NVY-2 too dark against the approved lab dip' }));
  });

  await step('documents', async () => {
    const hr = await as('hr@textile.local');
    const emps = list(await call<{ id: string; name: string }[]>('hrms', hr, 'GET', '/employees?pageSize=50'));
    for (const [i, e] of emps.slice(0, 3).entries()) {
      const q = new URLSearchParams({ title: `Offer letter — ${e.name}`, document_type: 'OFFER_LETTER', entity_type: 'employee', entity_id: e.id });
      await call('governance', hr, 'POST', `/documents?${q}`, pdf(`Offer letter ${i + 1}`), { 'content-type': 'application/pdf', 'x-file-name': `offer-${i + 1}.pdf` });
    }
  });

  await step('leave handover', async () => {
    const admin = await as('admin@textile.local');
    const users = list(await call<{ id: string; email: string }[]>('identity', admin, 'GET', '/users?pageSize=100'));
    const id = (e: string) => users.find((u) => u.email === e)?.id;
    const from = id('sales.east@textile.local'), to = id('sales.south@textile.local');
    if (!from || !to) throw new Error('sales users not found');
    await call('workflow', admin, 'POST', '/tasks', { title: 'Follow up Kolkata Hosiery on the winter range', owner_id: from });
    await call('workflow', admin, 'POST', '/handovers', { from_user_id: from, to_user_id: to, kind: 'leave', reason: 'Ten days of leave for a family wedding', include: { tasks: true, leads: true, contracts: true } });
  });

  await step('contract correspondence', async () => {
    const purchase = await as('purchase@textile.local');
    const ks = list(await call<{ id: string }[]>('workflow', purchase, 'GET', '/contracts'));
    if (!ks.length) throw new Error('no contracts');
    await call('workflow', purchase, 'POST', `/contracts/${ks[0]!.id}/notes`, { kind: 'email', body: 'Supplier asks to revise the lycra surcharge from next month; we asked for the yarn price index backing it.' });
    if (ks[1]) await call('workflow', purchase, 'POST', `/contracts/${ks[1].id}/notes`, { kind: 'call', body: 'Agreed on the phone to keep payment terms at 45 days for the renewal.' });
  });

  await step('supplier bank change', async () => {
    await by(['purchase@textile.local', 'accounts@textile.local'], (t) => call('masters', t, 'POST', `/parties/${o.party('Shree Ambica Knitters')}/bank-accounts`, { account_name: 'Shree Ambica Knitters', account_number: '50200061234567', ifsc: 'HDFC0001234', bank_name: 'HDFC Bank, Ring Road', reason: 'Supplier moved its account to HDFC; letter on company letterhead received' }));
  });

  await step('duplicate enquiry', async () => {
    const mgr = await as('salesmgr@textile.local');
    const leads = list(await call<{ mobile: string | null; name: string }[]>('crm', mgr, 'GET', '/leads?pageSize=50'));
    const l = leads.find((x) => x.mobile);
    if (!l) throw new Error('no lead with a mobile');
    await call('crm', mgr, 'POST', '/leads', { source_code: 'PHONE', name: `${l.name} (called again)`, mobile: l.mobile, state_code: '24' });
  });

  await step('invoice capture', async () => {
    const purchase = await as('purchase@textile.local');
    const b = await call<{ id: string }>('procurement', purchase, 'POST', '/captures/batches', { name: 'Supplier bills received this week' });
    for (const n of ['ambica-0922.pdf', 'surat-process-1180.pdf'])
      await call('procurement', purchase, 'POST', `/captures/batches/${b.id}/files`, pdf(n), { 'content-type': 'application/pdf', 'x-file-name': n });
  });

  await step('report snapshot', async () => {
    const owner = await as('owner@textile.local');
    const reps = list(await call<{ id: string }[]>('insights', owner, 'GET', '/reports'));
    if (!reps.length) throw new Error('no saved reports');
    await call('insights', owner, 'POST', `/reports/${reps[0]!.id}/snapshot`, {});
  });

  await step('go-live incident and decision', async () => {
    await call('golive', await as('sales@textile.local'), 'POST', '/incidents', { title: 'Invoice print shows the old address', description: 'Print preview on the dispatch PC still shows the Udhna address', severity: 'P3', module: 'Fulfilment' });
    await call('golive', await as('owner@textile.local'), 'POST', '/go-decision', { decision: 'no_go', rollback_plan: 'Not applicable', notes: 'Finish UAT on accounts and the payroll dry run first' });
  });

  await step('price list from invoiced rates', async () => {
    if (!o.finance) throw new Error('finance pool not given');
    // Rates actually charged this year: list price at the top of the range, volume tiers at the average and the lowest.
    const { rows } = await o.finance.query(`SELECT sku, round(max(taxable / qty_kg)) AS top, round(sum(taxable) / sum(qty_kg)) AS avg, round(min(taxable / qty_kg)) AS low
      FROM tax_lines WHERE direction = 'outward' AND doc_type = 'invoice' AND qty_kg > 0 AND sku IS NOT NULL GROUP BY sku`);
    const admin = await as('admin@textile.local');
    const products = list(await call<{ id: string; sku: string }[]>('masters', admin, 'GET', '/products?pageSize=50'));
    const fyFrom = `${new Date().getMonth() >= 3 ? new Date().getFullYear() : new Date().getFullYear() - 1}-04-01`;
    const pl = await call<{ id: string }>('masters', admin, 'POST', '/price-lists', { code: 'STD-2627', name: 'Standard dealer price list 2026-27', valid_from: fyFrom, valid_to: null, status: 'active' });
    const items = rows.flatMap((r: { sku: string; top: string; avg: string; low: string }) => {
      const p = products.find((x) => x.sku === r.sku);
      return p ? [{ product_id: p.id, rate_per_uom: Number(r.top), min_qty: 0 }, { product_id: p.id, rate_per_uom: Number(r.avg), min_qty: 500 }, { product_id: p.id, rate_per_uom: Number(r.low), min_qty: 2000 }] : [];
    });
    if (!items.length) throw new Error('no invoiced rates to build the price list from');
    await call('masters', admin, 'PUT', `/price-lists/${pl.id}/items`, { items });
  });

  await step('customer portal cart and company settings', async () => {
    const buyer = await as('buyer@srimurugan.example');
    const cat = list(await call<{ id: string }[]>('commerce', buyer, 'GET', '/catalogue'));
    const lines: { product_id: string; lot_id: string; kg: number }[] = [];
    for (const p of cat.slice(0, 4)) {
      const d = await call<{ id: string; moq_kg: number; lots: { id: string; available_kg: number }[] }>('commerce', buyer, 'GET', `/catalogue/${p.id}`);
      const lot = d.lots.find((l) => l.available_kg >= Math.max(100, d.moq_kg));
      if (lot && lines.length < 2) lines.push({ product_id: d.id, lot_id: lot.id, kg: Math.max(100, d.moq_kg) });
    }
    if (!lines.length) throw new Error('no lot with enough stock for a cart');
    await call('commerce', buyer, 'PUT', '/portal/cart', { lines });
    await call('commerce', buyer, 'PUT', '/portal/company/settings', { order_approval_limit: 250000, default_ship_to: 'Sri Murugan Garments, 14 Kumaran Road, Tiruppur 641601' });
  });

  await step('enquiry from an existing customer', async () => {
    const mgr = await as('salesmgr@textile.local');
    const parties = list(await call<{ id: string; party_type: string; phone: string | null; legal_name: string }[]>('masters', await as('admin@textile.local'), 'GET', '/parties?pageSize=200'));
    const leads = list(await call<{ mobile: string | null }[]>('crm', mgr, 'GET', '/leads?pageSize=200'));
    const known = new Set(leads.map((l) => l.mobile));
    const c = parties.find((p) => p.party_type === 'customer' && p.phone && !known.has(p.phone.replace(/\D/g, '').slice(-10)));
    if (!c) throw new Error('no customer phone free for an enquiry');
    // Someone at an existing customer calls in as if new: the lead is flagged as a possible duplicate of the customer.
    await call('crm', mgr, 'POST', '/leads', { source_code: 'PHONE', name: 'Purchase desk', company: c.legal_name, mobile: c.phone!.replace(/\D/g, '').slice(-10), state_code: '33' });
  });

  await step('supplier bank change approved', async () => {
    const owner = await as('owner@textile.local');
    const pend = list(await call<{ id: string; approval_type: string; ref_id: string }[]>('governance', owner, 'GET', '/approvals?f_status=pending&pageSize=200')).filter((x) => x.approval_type === 'party_bank_account');
    if (!pend.length) throw new Error('no bank change waiting');
    // The first is approved after a call-back to the supplier; payments to it are then watched for 30 days.
    await call('governance', owner, 'POST', `/approvals/${pend[0]!.id}/decide`, { decision: 'approved', comment: 'Confirmed on a call-back to the supplier’s accounts head on the number in our records' });
  });

  await step('customer credit limit change for approval', async () => {
    const mgr = await as('salesmgr@textile.local');
    const id = o.party('Rupa Apparel House');
    const p = await call<Record<string, unknown> & { credit_limit: number | null; version: number }>('masters', mgr, 'GET', `/parties/${id}`);
    const limit = Math.round((Number(p.credit_limit ?? 500000) * 1.5) / 50000) * 50000;
    await call('masters', mgr, 'PATCH', `/parties/${id}`, { ...p, credit_limit: limit, reason: 'Buyer has paid within terms for six months and asked for a higher limit for the winter range' });
  });

  await step('blind count of one rack', async () => {
    const op = await as('stores.operator@textile.local');
    const st = await call<{ id: string }>('inventory', op, 'POST', '/stocktakes', { warehouse_id: SRT, location_prefix: 'A-01-R1', blind: true });
    const view = await call<{ variance: { missing: { barcode: string; expected_kg?: number; weight_kg?: number }[] } }>('inventory', await as('owner@textile.local'), 'GET', `/stocktakes/${st.id}`);
    const rolls = view.variance?.missing ?? [];
    if (rolls.length < 3) throw new Error(`rack A-01-R1 has only ${rolls.length} rolls`);
    const [notFound, light, ...rest] = rolls;
    const kg = (r: { expected_kg?: number; weight_kg?: number }) => Number(r.expected_kg ?? r.weight_kg);
    await call('inventory', op, 'POST', `/stocktakes/${st.id}/count`, { barcode: light!.barcode, weight_kg: Math.round((kg(light!) - 1.8) * 100) / 100 });
    for (const r of rest) await call('inventory', op, 'POST', `/stocktakes/${st.id}/count`, { barcode: r.barcode, weight_kg: kg(r) });
    await call('inventory', op, 'PUT', `/stocktakes/${st.id}/reasons`, { reasons: [
      { barcode: notFound!.barcode, reason_code: 'not_found', note: 'Searched rack A-01 and the dispatch bay; not found' },
      { barcode: light!.barcode, reason_code: 'weight_moisture', note: 'Roll dried out near the window; 1.8 kg lighter' },
    ] });
    await call('inventory', op, 'POST', `/stocktakes/${st.id}/submit`, { reason: 'Monthly cycle count of rack A-01-R1' });
    await o.drain();
    for (const who of ['accounts@textile.local', 'owner@textile.local']) {
      const t = await as(who);
      const a = list(await call<{ id: string; ref_id: string }[]>('governance', t, 'GET', '/approvals?f_status=pending&pageSize=200')).find((x) => x.ref_id === st.id);
      if (a) { await call('governance', t, 'POST', `/approvals/${a.id}/decide`, { decision: 'approved', comment: 'Checked the count sheet with the stores manager' }); await o.drain(); }
    }
  });

  await step('notifications read', async () => {
    for (const who of ['owner@textile.local', 'accounts@textile.local', 'salesmgr@textile.local']) {
      const t = await as(who);
      const ns = list(await call<{ id: string }[]>('governance', t, 'GET', '/notifications'));
      for (const n of ns.slice(Math.ceil(ns.length / 2))) await call('governance', t, 'POST', `/notifications/${n.id}/read`, {});
    }
  });

  await step('password reset request', async () => {
    await call('identity', null, 'POST', '/auth/password-reset/request', { email: 'purchase.exec@textile.local' });
  });

  await step('daily brief and assistant question', async () => {
    const owner = await as('owner@textile.local');
    await call('insights', owner, 'GET', '/brief');
    // The assistant answers from the data (or says why it cannot, when no AI key is set); either way the question is logged.
    await call('insights', owner, 'POST', '/assistant/ask', { question: 'Which customers are overdue by more than 30 days, and by how much?' }).catch(() => undefined);
  });

  await step('UAT sign-off', async () => {
    await call('golive', await as('owner@textile.local'), 'POST', '/uat/signoff', { scope: 'P2', decision: 'approved', conditions: 'Approved for purchasing; invoice capture to be re-tested with October bills', role: 'Owner' });
  });

  // Last: close the three months before this one as a normal month-end close. Last month's closing stock is valued and posted, so the
  // books carry the stock actually on hand. Later demo entries are dated in November.
  await step('month-end close of the last three months', async () => {
    const acc = await as('accounts@textile.local');
    // The three months before this one, oldest first; earlier months of the year are already closed.
    for (const m of [month(3), month(2), month(1)]) await call('finance', acc, 'POST', `/periods/${m}/lock`, { note: 'Month-end close: bank reconciled, GST and TDS returns reviewed', value_stock: true });
  });
}
