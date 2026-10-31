/** End-to-end tests for P8: automatic postings, TDS, AR/AP ageing, maker-checker vouchers, period locks, bank reconciliation, GST returns and statements. */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { publish, tx } from '@erp/platform';
import { bootAll } from './harness.ts';
import { runFinanceChecks } from '../services/finance/src/automation.ts';

let h: Awaited<ReturnType<typeof bootAll>>;
const t: Record<string, string> = {};
const ids: Record<string, string> = {};
const today = new Date().toISOString().slice(0, 10);
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

/** Raise a business event as the owning service would, then let consumers run. */
async function emit(service: 'procurement' | 'fulfilment' | 'commerce' | 'inventory', type: string, payload: object) {
  await tx(h.svc(service).ctx.pool, (c) => publish(c, service, type, payload));
  await h.drain();
}
const tb = async (q = '') => h.ok(t.accounts!, 'GET', `/finance/reports/trial-balance?from=2020-04-01${q}`);

before(async () => {
  h = await bootAll('p8');
  for (const [k, email] of Object.entries({ admin: 'admin@textile.local', owner: 'owner@textile.local', accounts: 'accounts@textile.local', auditor: 'auditor@textile.local', sales: 'sales@textile.local' })) t[k] = await h.login(email);
  const books = await h.ok(t.accounts!, 'GET', '/finance/books');
  for (const b of books) ids[`book${b.state_code}`] = b.id;
  ids.bank = (await h.ok(t.accounts!, 'GET', '/finance/accounts')).find((a: { system_key: string }) => a.system_key === 'bank_main').id;
});
after(async () => h.close());

describe('P8 accounting', () => {
  test('one book per GSTIN, Surat (registered office) is primary; finance is closed to sales users', async () => {
    const books = await h.ok(t.accounts!, 'GET', '/finance/books');
    assert.equal(books.length, 3);
    assert.equal(books.find((b: { is_primary: boolean }) => b.is_primary).state_code, '24');
    assert.equal((await h.call(t.sales!, 'GET', '/finance/vouchers')).status, 403);
    assert.equal((await h.call(t.auditor!, 'GET', '/finance/vouchers')).status, 200, 'auditor reads');
    assert.equal((await h.call(t.auditor!, 'POST', '/finance/vouchers', {})).status, 403, 'auditor cannot post');
  });

  test('supplier invoice posts purchase, input GST, AP net of TDS 194C; replay is idempotent', async () => {
    const mill = h.parties['Surat Process House']!;
    await h.ok(t.accounts!, 'PUT', `/finance/tds/parties/${mill}`, { pan: 'AAFCS3131E', tds_section: '194C' });
    const ev = { invoice_id: '00000000-0000-4000-8000-000000000001', supplier_id: mill, invoice_number: 'SPH/101', invoice_date: daysAgo(40), taxable_value: 100000, cgst: 2500, sgst: 2500, igst: 0, total_value: 105000, po_id: null };
    await emit('procurement', 'procurement.invoice.posted', ev);
    await emit('procurement', 'procurement.invoice.posted', ev);
    const vs = await h.ok(t.accounts!, 'GET', '/finance/vouchers?type=purchase');
    assert.equal(vs.length, 1, 'posted once');
    const v = await h.ok(t.accounts!, 'GET', `/finance/vouchers/${vs[0].id}`);
    const line = (key: string) => v.lines.find((l: { code: string }) => l.code === key);
    assert.equal(line('5200').debit, 100000, 'a mill bill is job-work charges');
    assert.equal(line('1500').debit, 2500);
    assert.equal(line('2210').credit, 2000, 'TDS 194C at 2% for a company on the taxable value');
    assert.equal(line('2100').credit, 103000);
    assert.equal(v.tds[0].section, '194C');
    const ap = await h.ok(t.accounts!, 'GET', '/finance/ageing/payables');
    assert.equal(ap.rows[0].balance, 103000);
    assert.equal(ap.rows[0].d1_30, 103000, 'due 30 days after a 40-day-old invoice: 10 days overdue');
    assert.ok((await tb()).balanced);
  });

  test('sales invoice, gateway receipt and credit note: AR settles first-in-first-out; advances show as a liability', async () => {
    const cust = h.parties['Sri Murugan Garments']!;
    const sur = (await h.ok(t.accounts!, 'GET', '/finance/books')).find((b: { state_code: string }) => b.state_code === '24');
    await emit('fulfilment', 'fulfilment.invoiced', { fulfilment_id: '00000000-0000-4000-8000-000000000011', invoice_no: 'SRTI/2627/00001', invoice_date: daysAgo(10), gstin: sur.gstin, customer_id: cust, customer_name: 'Sri Murugan Garments', customer_gstin: '33ABCFS1234K1Z5', place_of_supply: '33', payment_terms: 'credit', taxable: 100000, cgst: 0, sgst: 0, igst: 5000, total: 105000 });
    await emit('fulfilment', 'fulfilment.invoiced', { fulfilment_id: '00000000-0000-4000-8000-000000000012', invoice_no: 'SRTI/2627/00002', invoice_date: daysAgo(2), gstin: sur.gstin, customer_id: cust, customer_name: 'Sri Murugan Garments', customer_gstin: '33ABCFS1234K1Z5', place_of_supply: '33', payment_terms: 'credit', taxable: 50000, cgst: 0, sgst: 0, igst: 2500, total: 52500 });
    await emit('commerce', 'commerce.payment.received', { payment_id: '00000000-0000-4000-8000-000000000021', number: 'PAY-00009', utr: 'UTR777001', customer_id: cust, customer_name: 'Sri Murugan Garments', purpose: 'invoice', ref_no: 'SRTI/2627/00001', amount: 105000 });
    let d = await h.ok(t.accounts!, 'GET', `/finance/parties/receivables/${cust}`);
    assert.equal(d.party.balance, 52500);
    assert.deepEqual(d.open_bills.map((b: { doc_no: string }) => b.doc_no), ['SRTI/2627/00002'], 'the older invoice is settled first');
    await emit('fulfilment', 'fulfilment.credit_note.issued', { return_id: '00000000-0000-4000-8000-000000000031', credit_note_no: 'SRTCN/2627/00001', gstin: sur.gstin, customer_id: cust, customer_name: 'Sri Murugan Garments', customer_gstin: '33ABCFS1234K1Z5', place_of_supply: '33', taxable: 60000, tax: 3000, cgst: 0, sgst: 0, igst: 3000, total: 63000 });
    d = await h.ok(t.accounts!, 'GET', `/finance/parties/receivables/${cust}`);
    assert.equal(d.party.balance, -10500, 'credit balance: money owed to the customer');
    const bs = await h.ok(t.accounts!, 'GET', '/finance/reports/balance-sheet');
    assert.ok(bs.balanced, `balance sheet balances (difference ${bs.difference})`);
    assert.equal(bs.current_liabilities.find((l: { name: string }) => l.name === 'Advances from customers').amount, 10500);
    const an = await h.ok(t.accounts!, 'GET', '/finance/anomalies?status=open');
    assert.ok(an.some((a: { kind: string }) => a.kind === 'large_credit_note'));
  });

  test('GST returns: GSTR-1 B2B, credit notes and HSN; GSTR-3B sets off IGST credit before cash', async () => {
    const sur = (await h.ok(t.accounts!, 'GET', '/finance/books')).find((b: { state_code: string }) => b.state_code === '24');
    const months = [...new Set([daysAgo(40), daysAgo(10), daysAgo(2), today].map((d) => d.slice(0, 7)))];
    let b2b = 0, cn = 0, cash = 0, itc = 0;
    for (const m of months) {
      const g = await h.ok(t.accounts!, 'GET', `/finance/gst/returns?book=${sur.id}&month=${m}`);
      b2b += g.gstr1.b2b.length; cn += g.gstr1.cdnr.length; cash += g.gstr3b.cash_payable.igst + g.gstr3b.cash_payable.cgst + g.gstr3b.cash_payable.sgst; itc += g.gstr3b.itc_4a.cgst + g.gstr3b.itc_4a.sgst;
    }
    assert.equal(b2b, 2);
    assert.equal(cn, 1);
    assert.equal(itc, 5000);
    // Output IGST 7,500 − 3,000 credit note = 4,500; CGST/SGST credit of 5,000 can be set off against IGST only in the same month.
    assert.ok(cash >= 0 && cash <= 4500);
    const json = await h.ok(t.accounts!, 'GET', `/finance/gst/gstr1-json?book=${sur.id}&month=${daysAgo(10).slice(0, 7)}`);
    assert.equal(json.gstin, sur.gstin);
    assert.equal(json.b2b[0].ctin, '33ABCFS1234K1Z5');
  });

  test('manual journal above the limit waits for a checker; the maker cannot approve it', async () => {
    const acc = await h.ok(t.accounts!, 'GET', '/finance/accounts');
    const rent = acc.find((a: { code: string }) => a.code === '5500').id;
    const v = await h.ok(t.accounts!, 'POST', '/finance/vouchers', { voucher_type: 'payment', book_id: ids.book24, date: daysAgo(1), narration: 'Godown rent October', lines: [{ account_id: rent, debit: 150000 }, { account_id: ids.bank, credit: 150000 }] });
    assert.equal(v.status, 'pending_approval');
    const before = (await tb()).rows.find((r: { code: string }) => r.code === '5500');
    assert.equal(before, undefined, 'pending vouchers do not touch balances');
    await h.drain();
    const appr = (await h.ok(t.owner!, 'GET', '/governance/approvals?f_status=pending&pageSize=50')).items.find((a: { ref_id: string }) => a.ref_id === v.id);
    assert.equal((await h.call(t.accounts!, 'POST', `/governance/approvals/${appr.id}/decide`, { decision: 'approved', comment: 'ok' })).status, 403, 'maker-checker');
    await h.ok(t.owner!, 'POST', `/governance/approvals/${appr.id}/decide`, { decision: 'approved', comment: 'ok' });
    await h.drain();
    assert.equal((await h.ok(t.accounts!, 'GET', `/finance/vouchers/${v.id}`)).status, 'posted');
    // Unbalanced and system-only accounts are refused.
    assert.equal((await h.call(t.accounts!, 'POST', '/finance/vouchers', { voucher_type: 'journal', book_id: ids.book24, date: today, narration: 'x', lines: [{ account_id: rent, debit: 10 }, { account_id: ids.bank, credit: 9 }] })).status, 400);
    const sales = acc.find((a: { code: string }) => a.code === '4100').id;
    assert.equal((await h.call(t.accounts!, 'POST', '/finance/vouchers', { voucher_type: 'journal', book_id: ids.book24, date: today, narration: 'x', lines: [{ account_id: sales, debit: 10 }, { account_id: ids.bank, credit: 10 }] })).status, 400, 'sales are posted only from invoices');
  });

  test('posted entries cannot be edited in the database; reversal leaves both visible', async () => {
    const v = (await h.ok(t.accounts!, 'GET', '/finance/vouchers?type=payment'))[0];
    await assert.rejects(h.svc('finance').ctx.pool.query('UPDATE finance.voucher_lines SET debit = 1 WHERE voucher_id = $1', [v.id]));
    await assert.rejects(h.svc('finance').ctx.pool.query('DELETE FROM finance.vouchers WHERE id = $1', [v.id]));
    const r = await h.ok(t.accounts!, 'POST', `/finance/vouchers/${v.id}/reverse`, { reason: 'Rent paid twice by mistake' });
    assert.ok(r.number.startsWith('PY/'));
    assert.equal((await h.ok(t.accounts!, 'GET', `/finance/vouchers/${v.id}`)).status, 'reversed');
    assert.equal((await tb()).rows.find((x: { code: string }) => x.code === '5500').closing_debit, 0);
  });

  test('bank statement: auto-match by amount and UTR, duplicates kept aside, bank charges created from a line', async () => {
    const ba = await h.ok(t.accounts!, 'POST', '/finance/bank-accounts', { account_id: ids.bank, book_id: ids.book24, bank_name: 'ICICI Bank', account_no: '000405001234', ifsc: 'ICIC0000004' });
    // The gateway settles into the bank: a contra from clearing.
    const csv = `Txn Date,Description,Ref No,Debit,Credit,Balance
${daysAgo(1).split('-').reverse().join('/')},ICICI PG SETTLEMENT,UTR777001,,105000.00,105000.00
${today.split('-').reverse().join('/')},SMS CHARGES,,59.00,,104941.00`;
    const imp = await h.ok(t.accounts!, 'POST', `/finance/bank-accounts/${ba.id}/statements`, { file_name: 'oct.csv', csv });
    assert.equal(imp.lines, 2);
    const again = await h.ok(t.accounts!, 'POST', `/finance/bank-accounts/${ba.id}/statements`, { file_name: 'oct-again.csv', csv });
    assert.equal(again.duplicates, 2, 'a re-imported statement is not counted twice');
    const rec = await h.ok(t.accounts!, 'GET', `/finance/bank-accounts/${ba.id}/reconciliation`);
    const settle = rec.lines.find((l: { ref: string }) => l.ref === 'UTR777001');
    await h.ok(t.accounts!, 'POST', `/finance/bank-lines/${settle.id}/create`, { kind: 'gateway_settlement' });
    const fee = rec.lines.find((l: { description: string }) => l.description === 'SMS CHARGES');
    await h.ok(t.accounts!, 'POST', `/finance/bank-lines/${fee.id}/create`, { kind: 'bank_charges' });
    const rec2 = await h.ok(t.accounts!, 'GET', `/finance/bank-accounts/${ba.id}/reconciliation`);
    assert.equal(rec2.lines.length, 0, 'nothing left unmatched');
    assert.equal(rec2.summary.book_balance, 104941);
    assert.equal(rec2.summary.difference, 0);
  });

  test('TDS challan clears the month; overdue TDS raises an alert', async () => {
    const m = daysAgo(40).slice(0, 7);
    await runFinanceChecks(h.svc('finance').ctx.pool);
    const due = new Date(`${m}-01T00:00:00Z`); due.setUTCMonth(due.getUTCMonth() + 1); due.setUTCDate(7);
    const overdue = due.toISOString().slice(0, 10) < today;
    assert.equal((await h.ok(t.accounts!, 'GET', '/finance/anomalies?status=open')).some((a: { kind: string }) => a.kind === 'tds_overdue'), overdue);
    const ch = await h.ok(t.accounts!, 'POST', '/finance/tds/challans', { section: '194C', month: m, bsr_code: '0510308', challan_no: '00123', paid_on: today });
    assert.equal(ch.amount, 2000);
    const reg = await h.ok(t.accounts!, 'GET', `/finance/tds/register?fy=${ch.voucher.split('/')[1]}`);
    assert.equal(reg.summary.find((s: { section: string }) => s.section === '194C').pending, 0);
  });

  test('period lock: manual entries refused, automatic postings move to the next open month; reopening needs approval', async () => {
    const m = daysAgo(40).slice(0, 7);
    await h.ok(t.accounts!, 'GET', `/finance/periods?fy=${(await h.ok(t.accounts!, 'GET', '/finance/vouchers?type=purchase'))[0].number.split('/')[1]}`);
    // Lock every month up to and including m.
    const periods = await h.ok(t.accounts!, 'GET', `/finance/periods?fy=${(await h.ok(t.accounts!, 'GET', '/finance/vouchers?type=purchase'))[0].number.split('/')[1]}`);
    for (const p of periods.filter((x: { month: string }) => x.month.slice(0, 7) <= m)) await h.ok(t.accounts!, 'POST', `/finance/periods/${p.month}/lock`, { value_stock: false });
    const acc = await h.ok(t.accounts!, 'GET', '/finance/accounts');
    const rent = acc.find((a: { code: string }) => a.code === '5500').id;
    assert.equal((await h.call(t.accounts!, 'POST', '/finance/vouchers', { voucher_type: 'journal', book_id: ids.book24, date: `${m}-15`, narration: 'late', lines: [{ account_id: rent, debit: 10 }, { account_id: ids.bank, credit: 10 }] })).status, 409);
    await emit('procurement', 'procurement.invoice.posted', { invoice_id: '00000000-0000-4000-8000-000000000002', supplier_id: h.parties['Shree Ambica Knitters'], invoice_number: 'SAK/77', invoice_date: `${m}-20`, taxable_value: 1000, cgst: 25, sgst: 25, igst: 0, total_value: 1050, po_id: null });
    const v = (await h.ok(t.accounts!, 'GET', '/finance/vouchers?q=SAK/77'))[0];
    assert.ok(v.date > `${m}-31`.slice(0, 10) || v.date.slice(0, 7) > m, 'moved out of the locked month');
    await h.ok(t.accounts!, 'POST', `/finance/periods/${m}-01/reopen`, { reason: 'Supplier bill received late' });
    await h.drain();
    const appr = (await h.ok(t.owner!, 'GET', '/governance/approvals?f_status=pending&pageSize=50')).items.find((a: { approval_type: string }) => a.approval_type === 'period_reopen');
    await h.ok(t.owner!, 'POST', `/governance/approvals/${appr.id}/decide`, { decision: 'approved', comment: 'ok' });
    await h.drain();
    assert.equal((await h.ok(t.accounts!, 'GET', `/finance/periods?fy=${v.number.split('/')[1]}`)).find((p: { month: string }) => p.month.startsWith(m)).status, 'open');
  });

  test('statements tie out: trial balance, P&L and balance sheet (consolidated and per book)', async () => {
    const all = await tb();
    assert.ok(all.balanced);
    for (const b of Object.keys(ids).filter((k) => k.startsWith('book'))) assert.ok((await tb(`&book=${ids[b]}`)).balanced, `${b} balances`);
    const pl = await h.ok(t.accounts!, 'GET', '/finance/reports/profit-and-loss?from=2020-04-01');
    assert.equal(pl.revenue_total, 150000 - 60000 + 0, 'sales less returns');
    const bs = await h.ok(t.accounts!, 'GET', '/finance/reports/balance-sheet');
    assert.ok(bs.balanced, `difference ${bs.difference}`);
    const cf = await h.ok(t.accounts!, 'GET', '/finance/reports/cash-flow?from=2020-04-01');
    assert.equal(cf.receipts_from_customers, 105000);
    const dash = await h.ok(t.accounts!, 'GET', '/finance/dashboard');
    assert.ok(dash.cash_and_bank > 0);
  });
});
