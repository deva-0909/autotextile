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

export async function seedCoverage(o: { call: Call; login: (email: string) => Promise<string>; party: (name: string) => string; drain: () => Promise<unknown> }) {
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
  const books = await call<{ id: string; is_primary: boolean }[]>('finance', await as('accounts@textile.local'), 'GET', '/books');
  const book = books.find((b) => b.is_primary)!.id;

  await step('sales return', async () => {
    const fs = list(await call<{ id: string; status: string }[]>('fulfilment', await as('dispatch@textile.local'), 'GET', '/fulfilments?pageSize=200'));
    for (const f of fs.filter((x) => ['dispatched', 'delivered'].includes(x.status)).slice(0, 6)) {
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
    const ps = list(await call<{ id: string; status: string; amount: number }[]>('commerce', await as('accounts@textile.local'), 'GET', '/payments?pageSize=200'));
    const p = ps.find((x) => x.status === 'success' && Number(x.amount) > 2000);
    if (!p) throw new Error('no successful payment');
    await call('commerce', await as('accounts@textile.local'), 'POST', `/payments/${p.id}/refund`, { amount: 1500, reason: 'Freight charged twice on the order; refund of the extra freight' });
  });

  await step('reservation extension', async () => {
    const os = list(await call<{ id: string; status: string }[]>('commerce', await as('salesmgr@textile.local'), 'GET', '/orders?pageSize=200'));
    const b = os.find((x) => x.status === 'booked');
    if (!b) throw new Error('no booked order');
    await by(['salesmgr@textile.local', 'sales@textile.local', 'care@textile.local'], (t) => call('commerce', t, 'POST', `/orders/${b.id}/extend`, { days: 3, reason: 'Buyer’s payment is in their bank’s approval queue; asked us to hold the rolls till Friday' }));
  });

  await step('purchase order revision', async () => {
    const pos = list(await call<{ id: string; status: string }[]>('procurement', await as('purchase@textile.local'), 'GET', '/purchase-orders?pageSize=200'));
    const po = pos.find((x) => ['approved', 'sent', 'accepted'].includes(x.status));
    if (!po) throw new Error('no approved purchase order');
    await call('procurement', await as('purchase@textile.local'), 'POST', `/purchase-orders/${po.id}/revise`, { reason: 'Supplier can deliver only 80% this month; quantity and delivery date to be revised' });
  });

  await step('GSTR-1 filing', async () => {
    await call('finance', await as('accounts@textile.local'), 'POST', '/gst/gstr1-filings', { book_id: book, period: `${month(1)}-01`, filed_on: `${month(0)}-10`, arn: 'AA2410250123456' });
  });

  await step('ITC reversal', async () => {
    await call('finance', await as('accounts@textile.local'), 'POST', '/gst/itc-reversals', { gstin: '24AABCS1429B1Z5', supplier_name: 'Shree Ambica Knitters', doc_no: 'SAK/0915', doc_date: `${month(2)}-15`, reason: 'rule_37', period: `${month(0)}-01`, igst: 0, cgst: 1250, sgst: 1250, note: 'Not paid within 180 days of the invoice' });
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
    await by(['purchase@textile.local', 'accounts@textile.local'], (t) => call('masters', t, 'POST', `/parties/${o.party('Shree Ambica Knitters')}/bank-accounts`, { account_name: 'Shree Ambica Knitters', account_number: '50200061234567', ifsc: 'HDFC0001234', bank_name: 'HDFC Bank, Ring Road' }));
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
}
