/** Interest on late GSTR-3B payment (Section 50(1), Rule 88B) and late fee for late GSTR-3B and GSTR-1 filing (Section 47), with alerts and settlement. */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { publish, tx } from '@erp/platform';
import { bootAll } from './harness.ts';
import { runFinanceChecks } from '../services/finance/src/automation.ts';

let h: Awaited<ReturnType<typeof bootAll>>;
let tok = '';
let book: { id: string; gstin: string };
let customer = '';
const monthsAgo = (n: number) => { const d = new Date(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - n); return d.toISOString().slice(0, 7); };
const plusDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const P = monthsAgo(4), P1 = monthsAgo(3), P2 = monthsAgo(2), P3 = monthsAgo(1);
const dueOf = (m: string, day = 20) => { const d = new Date(`${m}-01T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() + 1); return `${d.toISOString().slice(0, 8)}${day}`; };

async function invoice(no: string, date: string, igst: number) {
  await tx(h.svc('fulfilment').ctx.pool, (c) => publish(c, 'fulfilment', 'fulfilment.invoiced', { fulfilment_id: crypto.randomUUID(), invoice_no: no, invoice_date: date, gstin: book.gstin, customer_id: customer,
    customer_name: 'Sri Murugan Garments', customer_gstin: '33ABCFS1234K1Z5', place_of_supply: '33', payment_terms: 'credit', taxable: igst * 20, cgst: 0, sgst: 0, igst, total: igst * 21 }));
  await h.drain();
}

before(async () => {
  h = await bootAll('gstint');
  tok = await h.login('accounts@textile.local');
  book = (await h.ok(tok, 'GET', '/finance/books')).find((b: { is_primary: boolean }) => !b.is_primary);
  customer = (await h.ok(tok, 'GET', '/masters/parties?q=Sri%20Murugan')).items[0].id;
  // Tracking starts with the carried-over cash ledger: ₹1,000 IGST already there.
  await h.ok(tok, 'POST', '/finance/gst/opening-cash', { gstin: book.gstin, as_of: P, igst: 1000, cgst: 0, sgst: 0 });
  await invoice('GSTINT/1', `${P}-10`, 5000);
  await invoice('GSTINT/2', `${P1}-10`, 2000);
  await invoice('GSTINT/3', `${P2}-10`, 3000);
});
after(async () => h.close());

describe('interest on late GST payment', () => {
  test('an unpaid month past its due date shows interest so far and raises an alert', async () => {
    const r = await h.ok(tok, 'GET', `/finance/gst/returns?book=${book.id}&month=${P}`);
    assert.equal(r.payment.due_date, dueOf(P));
    assert.equal(r.payment.status, 'overdue');
    assert.deepEqual(r.gstr3b.paid_from_cash_ledger, { igst: 1000, cgst: 0, sgst: 0 });
    assert.equal(r.gstr3b.cash_payable.igst, 4000);
    assert.equal(r.payment.interest_so_far.igst, Math.round((4000 * 0.18 * r.payment.days_late) / 365), 'only the cash deposited is charged (Rule 88B)');
    await runFinanceChecks(h.svc('finance').ctx.pool);
    const an = await h.ok(tok, 'GET', '/finance/anomalies');
    const list = Array.isArray(an) ? an : an.items;
    assert.ok(list.some((a: { kind: string; ref_id: string; status: string }) => a.kind === 'gstr3b_overdue' && a.ref_id === `${book.id}:${P}-01` && a.status === 'open'));
  });

  test('paid 30 days late: 18% a year on the cash portion, booked as interest owed for the next return, alert resolved', async () => {
    const paid = plusDays(dueOf(P), 30);
    const r = await h.ok(tok, 'POST', '/finance/gst/payments', { book_id: book.id, period: P, paid_on: paid, arn: 'AA2407260123456' });
    assert.equal(r.days_late, 30);
    assert.deepEqual(r.interest, { igst: Math.round(4000 * 0.18 * 30 / 365), cgst: 0, sgst: 0 });
    assert.equal(r.interest.igst, 59);
    assert.ok(r.voucher);
    // Filed 30 days late too: ₹25 + ₹25 a day, within the ₹1,000 + ₹1,000 cap (turnover up to ₹1.5 crore); paid with the return.
    assert.equal(r.filing_days_late, 30);
    assert.deepEqual(r.late_fee, { igst: 0, cgst: 750, sgst: 750 });
    assert.equal(r.late_fee_cap, 2000);
    assert.equal(r.late_fee_settled.from_challan, 1500);
    assert.equal((await h.call(tok, 'POST', '/finance/gst/payments', { book_id: book.id, period: P, paid_on: paid })).status, 409, 'recorded once');
    const next = await h.ok(tok, 'GET', `/finance/gst/returns?book=${book.id}&month=${P1}`);
    assert.deepEqual(next.gstr3b.interest_5_1, { igst: 59, cgst: 0, sgst: 0 }, 'shows in the next return, as the portal does');
    const dues = await h.ok(tok, 'GET', `/finance/gst/dues?book=${book.id}`);
    assert.ok(dues.dues.some((d: { minor_head: string; status: string; igst: number }) => d.minor_head === 'interest' && d.status === 'open' && d.igst === 59));
    const an = await h.ok(tok, 'GET', '/finance/anomalies');
    const list = Array.isArray(an) ? an : an.items;
    assert.ok(!list.some((a: { kind: string; ref_id: string; status: string }) => a.kind === 'gstr3b_overdue' && a.ref_id === `${book.id}:${P}-01` && a.status === 'open'), 'alert resolved');
  });

  test('paid on the due date: no interest', async () => {
    const r = await h.ok(tok, 'POST', '/finance/gst/payments', { book_id: book.id, period: P1, paid_on: dueOf(P1) });
    assert.equal(r.days_late, 0);
    assert.deepEqual(r.interest, { igst: 0, cgst: 0, sgst: 0 });
    assert.equal(r.voucher, null);
    assert.deepEqual(r.late_fee, { igst: 0, cgst: 0, sgst: 0 });
    assert.equal(r.late_fee_voucher, null);
  });

  test('interest paid with the return is settled at once; a portal figure needs a reason', async () => {
    const paid = plusDays(dueOf(P2), 5);
    assert.equal((await h.call(tok, 'POST', '/finance/gst/payments', { book_id: book.id, period: P2, paid_on: paid, interest_override: { igst: 8, cgst: 0, sgst: 0 } })).status, 400);
    const r = await h.ok(tok, 'POST', '/finance/gst/payments', { book_id: book.id, period: P2, paid_on: paid, interest_with_return: true, challan_ref: 'CPIN 24271000999', interest_override: { igst: 8, cgst: 0, sgst: 0 }, override_reason: 'Portal computed ₹8' });
    assert.deepEqual(r.calculated, { igst: Math.round(3000 * 0.18 * 5 / 365), cgst: 0, sgst: 0 });
    assert.deepEqual(r.interest, { igst: 8, cgst: 0, sgst: 0 });
    assert.equal(r.settled.from_challan, 8);
    assert.deepEqual(r.late_fee, { igst: 0, cgst: 125, sgst: 125 });
    const st = (await h.ok(tok, 'GET', `/finance/gst/returns?book=${book.id}&month=${P2}`)).payment;
    assert.equal(st.status, 'paid');
    assert.equal(st.interest_status, 'settled');
    assert.ok((await h.ok(tok, 'GET', '/finance/reports/trial-balance?from=2020-04-01')).balanced);
  });

  test('GSTR-1 filed late: the late fee is capped and levied in the next GSTR-3B not yet filed', async () => {
    const filed = plusDays(dueOf(P, 11), 50);
    const r = await h.ok(tok, 'POST', '/finance/gst/gstr1-filings', { book_id: book.id, period: P, filed_on: filed, arn: 'AA240726R1' });
    assert.equal(r.days_late, 50);
    assert.equal(r.nil_return, false);
    assert.deepEqual(r.late_fee, { igst: 0, cgst: 1000, sgst: 1000 }, '50 × ₹25 = ₹1,250 a head, capped at ₹1,000');
    assert.equal(r.pay_in_month, `${P3}-01`, 'GSTR-3B for P, P1 and P2 are already filed');
    const g = await h.ok(tok, 'GET', `/finance/gst/returns?book=${book.id}&month=${P3}`);
    assert.deepEqual(g.gstr3b.late_fee_5_1, { igst: 0, cgst: 1000, sgst: 1000 });
    const st = (await h.ok(tok, 'GET', `/finance/gst/returns?book=${book.id}&month=${P}`)).gstr1_filing;
    assert.equal(st.status, 'filed');
    assert.equal(st.late_fee_status, 'open');
    assert.equal((await h.call(tok, 'POST', '/finance/gst/gstr1-filings', { book_id: book.id, period: P, filed_on: filed })).status, 409);
  });

  test('a nil GSTR-1 costs ₹10 + ₹10 a day, capped at ₹500; a waiver needs a reason', async () => {
    const m = monthsAgo(6);
    const r = await h.ok(tok, 'POST', '/finance/gst/gstr1-filings', { book_id: book.id, period: m, filed_on: plusDays(dueOf(m, 11), 60) });
    assert.equal(r.nil_return, true);
    assert.deepEqual(r.late_fee, { igst: 0, cgst: 250, sgst: 250 });
    const m2 = monthsAgo(7);
    assert.equal((await h.call(tok, 'POST', '/finance/gst/gstr1-filings', { book_id: book.id, period: m2, filed_on: plusDays(dueOf(m2, 11), 5), late_fee_override: { cgst: 0, sgst: 0 } })).status, 400);
    const w = await h.ok(tok, 'POST', '/finance/gst/gstr1-filings', { book_id: book.id, period: m2, filed_on: plusDays(dueOf(m2, 11), 5), late_fee_override: { cgst: 0, sgst: 0 }, late_fee_reason: 'Waived by notification' });
    assert.deepEqual(w.late_fee_calculated, { igst: 0, cgst: 50, sgst: 50 });
    assert.equal(w.voucher, null);
    assert.ok((await h.ok(tok, 'GET', '/finance/reports/trial-balance?from=2020-04-01')).balanced);
  });

  test('a payment cannot be dated before the month ends or in the future', async () => {
    const m = monthsAgo(1);
    assert.equal((await h.call(tok, 'POST', '/finance/gst/payments', { book_id: book.id, period: m, paid_on: `${m}-15` })).status, 400);
    assert.equal((await h.call(tok, 'POST', '/finance/gst/payments', { book_id: book.id, period: m, paid_on: plusDays(new Date().toISOString().slice(0, 10), 2) })).status, 400);
  });
});
