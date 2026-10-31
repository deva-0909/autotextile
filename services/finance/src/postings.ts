import { type BusEvent, type Client, callService, one } from '@erp/platform';
import { S, addDays, bookByGstin, bookByRegistration, getParty, primaryBook, raiseAnomaly, round2, setting, fyOf, fyStart } from './common.ts';
import { post, type TaxLine } from './ledger.ts';

/**
 * Automatic postings. Every approved business document produces its voucher from the event the owning service
 * publishes, so the ledger never depends on someone re-keying an invoice. Postings are idempotent on the source id.
 * Synchronous lookups to other services happen before anything that publishes (anomaly notifications).
 */
const SYSTEM = 'system';

interface TdsSection { code: string; rate_company: number; rate_individual: number; rate_no_pan: number; threshold_single: number; threshold_annual: number; on_excess: boolean }
interface PartyTax { pan: string | null; tds_section: string | null; lower_rate: number | null; lower_valid_to: string | null }

/** TDS on a supplier bill under the party's configured section, with single and annual thresholds. */
export async function tdsFor(c: Client, partyId: string, panFromMaster: string | null, base: number, date: string) {
  const pt = await one<PartyTax>(c, 'SELECT * FROM party_tax WHERE party_id = $1', [partyId]);
  if (!pt?.tds_section) return null;
  const sec = await one<TdsSection>(c, `SELECT * FROM tds_sections WHERE code = $1 AND effective_from <= $2 AND (effective_to IS NULL OR effective_to >= $2)`, [pt.tds_section, date]);
  if (!sec) return null;
  const fy = fyOf(date);
  const before = Number((await one<{ s: number }>(c, `SELECT coalesce(sum(base_amount), 0)::float AS s FROM tds_entries WHERE party_id = $1 AND section = $2 AND deducted_on >= $3`, [partyId, sec.code, fyStart(fy)]))!.s)
    + Number((await one<{ s: number }>(c, `SELECT coalesce(sum(t.taxable), 0)::float AS s FROM tax_lines t JOIN vouchers v ON v.id = t.voucher_id
      WHERE t.party_id = $1 AND t.direction = 'inward' AND t.doc_date >= $2 AND v.status = 'posted' AND NOT EXISTS (SELECT 1 FROM tds_entries e WHERE e.voucher_id = v.id)`, [partyId, fyStart(fy)]))!.s);
  const after = before + base;
  let taxableBase = 0;
  if (sec.on_excess) taxableBase = Math.max(0, after - Math.max(Number(sec.threshold_annual), before));
  else if (base > Number(sec.threshold_single) && Number(sec.threshold_single) > 0) taxableBase = base;
  else if (Number(sec.threshold_annual) > 0 && after > Number(sec.threshold_annual)) taxableBase = base;
  else if (Number(sec.threshold_single) === 0 && Number(sec.threshold_annual) === 0) taxableBase = base;
  if (taxableBase <= 0) return null;
  const pan = pt.pan ?? panFromMaster;
  const lower = pt.lower_rate != null && pt.lower_valid_to && pt.lower_valid_to >= date;
  const rate = lower ? Number(pt.lower_rate) : !pan ? Number(sec.rate_no_pan) : ['P', 'H'].includes(pan[3] ?? '') ? Number(sec.rate_individual) : Number(sec.rate_company);
  return { section: sec.code, pan, base: round2(taxableBase), rate, amount: Math.round((taxableBase * rate) / 100) };
}

async function recordTds(c: Client, voucherId: string, bookId: string, partyId: string, partyName: string, t: NonNullable<Awaited<ReturnType<typeof tdsFor>>>, date: string) {
  await c.query(`INSERT INTO tds_entries (voucher_id, book_id, party_id, party_name, pan, section, base_amount, rate, tds_amount, deducted_on) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [voucherId, bookId, partyId, partyName, t.pan, t.section, t.base, t.rate, t.amount, date]);
}

/** Supplier and mill invoices posted in procurement → purchase voucher, input tax credit, AP bill and TDS. */
export function supplierInvoiceConsumer() {
  return async (ev: BusEvent, c: Client) => {
    const p = ev.payload as { invoice_id: string; supplier_id: string; invoice_number: string; invoice_date: string; taxable_value: number; cgst: number; sgst: number; igst: number; total_value: number; po_id: string | null };
    const inv = await callService<{ supplier_name: string; supplier_gstin: string | null; due_date: string | null; lines?: { hsn_code: string | null; gst_rate: number | null; taxable_value?: number }[] }>(S, 'procurement', 'GET', `/invoices/${p.invoice_id}`).catch(() => null);
    const po = p.po_id ? await callService<{ bill_to_gst_registration_id: string; bill_to_state: string }>(S, 'procurement', 'GET', `/purchase-orders/${p.po_id}`).catch(() => null) : null;
    const party = await getParty(p.supplier_id);
    const book = po ? await bookByRegistration(c, po.bill_to_gst_registration_id) : await primaryBook(c);
    const date = String(p.invoice_date).slice(0, 10);
    const taxable = Number(p.taxable_value), total = Number(p.total_value);
    const tds = await tdsFor(c, party.id, party.pan, taxable, date);
    const payable = round2(total - (tds?.amount ?? 0));
    const isMill = party.party_type === 'mill';
    const rate = taxable > 0 ? Math.round(((Number(p.cgst) + Number(p.sgst) + Number(p.igst)) / taxable) * 1000) / 10 : 0;
    const tax: TaxLine[] = [{ direction: 'inward', doc_type: 'invoice', doc_no: p.invoice_number, doc_date: date, party_id: party.id, party_name: party.legal_name, party_gstin: inv?.supplier_gstin ?? party.gstin, place_of_supply: po?.bill_to_state ?? book.state_code, hsn: inv?.lines?.[0]?.hsn_code ?? null, rate, taxable, cgst: Number(p.cgst), sgst: Number(p.sgst), igst: Number(p.igst) }];
    const v = await post(c, {
      type: 'purchase', book_id: book.id, date, auto: true, by: SYSTEM, approved_by: 'procurement approval',
      narration: `${isMill ? 'Job-work charges' : 'Purchase'} — ${party.legal_name} invoice ${p.invoice_number}`, party_id: party.id, party_name: party.legal_name,
      source: { service: 'procurement', type: 'supplier_invoice', id: p.invoice_id, ref: p.invoice_number },
      lines: [
        { account: isMill ? 'jobwork' : 'purchases', debit: taxable },
        { account: 'input_cgst', debit: Number(p.cgst) }, { account: 'input_sgst', debit: Number(p.sgst) }, { account: 'input_igst', debit: Number(p.igst) },
        { account: 'payables', credit: payable, party_id: party.id, party_name: party.legal_name, bill_ref: p.invoice_number },
        ...(tds ? [{ account: 'tds_payable', credit: tds.amount, narration: `TDS ${tds.section} @ ${tds.rate}% on ₹${tds.base}` }] : []),
      ],
      tax, bill: { kind: 'payable', party_id: party.id, party_name: party.legal_name, doc_no: p.invoice_number, doc_date: date, due_date: inv?.due_date?.slice(0, 10) ?? addDays(date, 30), amount: payable },
    });
    if (v.existing) return;
    if (tds) await recordTds(c, v.id, book.id, party.id, party.legal_name, tds, date);
    // Same supplier, same amount within a week: possible duplicate under a different invoice number.
    const dup = await one<{ doc_no: string }>(c, `SELECT doc_no FROM bills WHERE kind = 'payable' AND party_id = $1 AND amount = $2 AND doc_no <> $3 AND abs(doc_date - $4::date) <= 7 LIMIT 1`, [party.id, payable, p.invoice_number, date]);
    if (dup) await raiseAnomaly(c, { kind: 'duplicate_supplier_bill', severity: 'warning', ref_type: 'voucher', ref_id: v.id, ref_label: `${v.number} · ${party.legal_name}`, message: `${party.legal_name} invoice ${p.invoice_number} has the same amount as ${dup.doc_no} within a week`, amount: payable });
  };
}

/** GST tax invoice from fulfilment → sales voucher, output tax, AR bill; flags unusual discounts. */
export function salesInvoiceConsumer() {
  return async (ev: BusEvent, c: Client) => {
    const p = ev.payload as { fulfilment_id: string; invoice_no: string; invoice_date?: string; gstin: string; customer_id: string; customer_name?: string; customer_gstin?: string | null; place_of_supply?: string | null; payment_terms?: string; taxable: number; cgst: number; sgst: number; igst: number; total: number };
    const inv = await callService<{ lines: { sku: string; hsn_code: string | null; gst_rate: number; kg: number; price_per_kg: number; taxable: number; tax: number }[]; buyer: { legal_name: string; gstin: string | null } }>(S, 'fulfilment', 'GET', `/invoices/${p.fulfilment_id}`).catch(() => null);
    const party = await getParty(p.customer_id);
    const creditDays = Number(await setting('finance.default_credit_days', 30));
    const book = await bookByGstin(c, p.gstin);
    const date = (p.invoice_date ?? new Date().toISOString()).slice(0, 10);
    const name = p.customer_name ?? party.legal_name;
    const gstin = p.customer_gstin ?? party.gstin;
    const pos = p.place_of_supply ?? party.state_code;
    const taxable = Number(p.taxable);
    const lines = inv?.lines ?? [{ sku: '', hsn_code: null, gst_rate: taxable ? Math.round(((Number(p.cgst) + Number(p.sgst) + Number(p.igst)) / taxable) * 100) : 0, kg: 0, price_per_kg: 0, taxable, tax: Number(p.cgst) + Number(p.sgst) + Number(p.igst) }];
    const share = (x: number, l: { taxable: number }) => (taxable ? round2((x * Number(l.taxable)) / taxable) : 0);
    const tax: TaxLine[] = lines.map((l) => ({ direction: 'outward', doc_type: 'invoice', doc_no: p.invoice_no, doc_date: date, party_id: party.id, party_name: name, party_gstin: gstin, place_of_supply: pos, hsn: l.hsn_code, rate: Number(l.gst_rate), taxable: Number(l.taxable), cgst: share(Number(p.cgst), l), sgst: share(Number(p.sgst), l), igst: share(Number(p.igst), l), sku: l.sku || null, qty_kg: Number(l.kg) || null }));
    // Recent average selling rate per SKU, before this invoice is added.
    const avg = new Map<string, number>();
    for (const l of lines.filter((x) => x.sku)) {
      const r = await one<{ rate: number | null; n: number }>(c, `SELECT (sum(taxable) / nullif(sum(qty_kg), 0))::float AS rate, count(*)::int AS n FROM tax_lines WHERE sku = $1 AND direction = 'outward' AND doc_type = 'invoice' AND doc_date >= $2::date - 90`, [l.sku, date]);
      if (r?.rate && r.n >= 2) avg.set(l.sku, r.rate);
    }
    const v = await post(c, {
      type: 'sales', book_id: book.id, date, auto: true, by: SYSTEM, approved_by: 'dispatch invoice',
      narration: `Sales invoice ${p.invoice_no} — ${name}`, party_id: party.id, party_name: name,
      source: { service: 'fulfilment', type: 'tax_invoice', id: p.fulfilment_id, ref: p.invoice_no },
      lines: [
        { account: 'receivables', debit: Number(p.total), party_id: party.id, party_name: name, bill_ref: p.invoice_no },
        { account: 'sales', credit: taxable },
        { account: 'output_cgst', credit: Number(p.cgst) }, { account: 'output_sgst', credit: Number(p.sgst) }, { account: 'output_igst', credit: Number(p.igst) },
      ],
      tax, bill: { kind: 'receivable', party_id: party.id, party_name: name, doc_no: p.invoice_no, doc_date: date, due_date: addDays(date, p.payment_terms === 'credit' ? creditDays : 0), amount: Number(p.total) },
    });
    if (v.existing) return;
    const maxDisc = Number(await setting('finance.alert_discount_pct', 15));
    for (const l of lines) {
      const a = avg.get(l.sku);
      if (a && Number(l.price_per_kg) < a * (1 - maxDisc / 100))
        await raiseAnomaly(c, { kind: 'unusual_discount', severity: 'warning', ref_type: 'voucher', ref_id: v.id, ref_label: `${p.invoice_no} · ${name}`, message: `${l.sku} sold at ₹${l.price_per_kg}/kg on ${p.invoice_no}, ${Math.round((1 - Number(l.price_per_kg) / a) * 100)}% below the 90-day average of ₹${round2(a)}`, amount: Number(l.taxable) });
    }
  };
}

/** Credit notes for returns → reverse sales and output tax, credit the customer. */
export function creditNoteConsumer() {
  return async (ev: BusEvent, c: Client) => {
    const p = ev.payload as { return_id: string; credit_note_no: string; gstin?: string; original_invoice_no?: string | null; customer_id: string; customer_name?: string; customer_gstin?: string | null; place_of_supply?: string | null; taxable: number; tax: number; total: number; cgst?: number; sgst?: number; igst?: number };
    const party = await getParty(p.customer_id);
    const book = await bookByGstin(c, p.gstin);
    const date = new Date().toISOString().slice(0, 10);
    const name = p.customer_name ?? party.legal_name;
    const cgst = Number(p.cgst ?? 0), sgst = Number(p.sgst ?? 0), igst = p.igst != null ? Number(p.igst) : (p.cgst == null ? Number(p.tax) : 0);
    const v = await post(c, {
      type: 'credit_note', book_id: book.id, date, auto: true, by: SYSTEM, approved_by: 'return resolution',
      narration: `Credit note ${p.credit_note_no} for return${p.original_invoice_no ? ` against ${p.original_invoice_no}` : ''} — ${name}`, party_id: party.id, party_name: name,
      source: { service: 'fulfilment', type: 'credit_note', id: p.return_id, ref: p.credit_note_no },
      lines: [
        { account: 'sales_returns', debit: Number(p.taxable) },
        { account: 'output_cgst', debit: cgst }, { account: 'output_sgst', debit: sgst }, { account: 'output_igst', debit: igst },
        { account: 'receivables', credit: Number(p.total), party_id: party.id, party_name: name, bill_ref: p.credit_note_no },
      ],
      tax: [{ direction: 'outward', doc_type: 'credit_note', doc_no: p.credit_note_no, doc_date: date, party_id: party.id, party_name: name, party_gstin: p.customer_gstin ?? party.gstin, place_of_supply: p.place_of_supply ?? party.state_code, rate: Number(p.taxable) ? Math.round((Number(p.tax) / Number(p.taxable)) * 1000) / 10 : 0, taxable: Number(p.taxable), cgst, sgst, igst }],
    });
    if (v.existing) return;
    const limit = Number(await setting('finance.alert_credit_note_amount', 50000));
    if (Number(p.total) >= limit) await raiseAnomaly(c, { kind: 'large_credit_note', severity: 'warning', ref_type: 'voucher', ref_id: v.id, ref_label: `${p.credit_note_no} · ${name}`, message: `Credit note ${p.credit_note_no} of ₹${Number(p.total).toLocaleString('en-IN')} to ${name} is above the review limit`, amount: Number(p.total) });
  };
}

/** Gateway receipts → money in the gateway clearing account, credited to the customer. */
export function paymentReceivedConsumer() {
  return async (ev: BusEvent, c: Client) => {
    const p = ev.payload as { payment_id: string; number?: string; utr?: string | null; customer_id: string; customer_name?: string; purpose: string; ref_no: string | null; amount: number };
    const party = p.customer_name ? null : await getParty(p.customer_id);
    const name = p.customer_name ?? party!.legal_name;
    const book = await primaryBook(c);
    await post(c, {
      type: 'receipt', book_id: book.id, date: new Date().toISOString().slice(0, 10), auto: true, by: SYSTEM, approved_by: 'gateway verified',
      narration: `${p.purpose === 'token' ? 'Booking token' : p.purpose === 'invoice' ? `Payment against ${p.ref_no}` : 'Advance'} from ${name} via payment gateway${p.utr ? ` · UTR ${p.utr}` : ''}`, party_id: p.customer_id, party_name: name,
      source: { service: 'commerce', type: 'payment', id: p.payment_id, ref: p.utr ?? p.number ?? null },
      lines: [{ account: 'gateway_clearing', debit: Number(p.amount) }, { account: 'receivables', credit: Number(p.amount), party_id: p.customer_id, party_name: name, bill_ref: p.number ?? null }],
    });
  };
}

export function paymentRefundedConsumer() {
  return async (ev: BusEvent, c: Client) => {
    const p = ev.payload as { payment_id: string; number: string; customer_id: string; customer_name: string; amount: number; refund_id: string; reason: string };
    const book = await primaryBook(c);
    const v = await post(c, {
      type: 'payment', book_id: book.id, date: new Date().toISOString().slice(0, 10), auto: true, by: SYSTEM, approved_by: 'commerce refund',
      narration: `Refund of ${p.number} to ${p.customer_name}: ${p.reason}`, party_id: p.customer_id, party_name: p.customer_name,
      source: { service: 'commerce', type: 'refund', id: p.refund_id, ref: p.number },
      lines: [{ account: 'receivables', debit: Number(p.amount), party_id: p.customer_id, party_name: p.customer_name }, { account: 'gateway_clearing', credit: Number(p.amount) }],
    });
    if (!v.existing && Number(p.amount) >= Number(await setting('finance.alert_refund_amount', 25000)))
      await raiseAnomaly(c, { kind: 'large_refund', severity: 'warning', ref_type: 'voucher', ref_id: v.id, ref_label: `${p.number} · ${p.customer_name}`, message: `Refund of ₹${Number(p.amount).toLocaleString('en-IN')} to ${p.customer_name}`, amount: Number(p.amount) });
  };
}

/** A forfeited or charged part of a token on cancellation is income. */
export function orderCancelledConsumer() {
  return async (ev: BusEvent, c: Client) => {
    const p = ev.payload as { order_id: string; number: string; customer_id?: string; customer_name?: string; cancellation_fee?: number };
    if (!p.customer_id || !(Number(p.cancellation_fee) > 0)) return;
    const book = await primaryBook(c);
    await post(c, {
      type: 'journal', book_id: book.id, date: new Date().toISOString().slice(0, 10), auto: true, by: SYSTEM, approved_by: 'token policy',
      narration: `Cancellation fee retained on ${p.number}`, party_id: p.customer_id, party_name: p.customer_name ?? null,
      source: { service: 'commerce', type: 'cancellation_fee', id: p.order_id, ref: p.number },
      lines: [{ account: 'receivables', debit: Number(p.cancellation_fee), party_id: p.customer_id, party_name: p.customer_name ?? null }, { account: 'cancellation_income', credit: Number(p.cancellation_fee) }],
    });
  };
}

/** Stock sent between two GSTINs is a taxable supply: a sale in the sending book, a purchase in the receiving one. */
export function transferConsumer() {
  return async (ev: BusEvent, c: Client) => {
    const p = ev.payload as { transfer_id: string; number: string; inter_gstin: boolean; document_type: string; document_no: string; from_gstin: string; to_gstin: string; kg: number; taxable_value: number; cgst: number; sgst: number; igst: number };
    if (!p.inter_gstin || p.document_type !== 'tax_invoice') return;
    const from = await bookByGstin(c, p.from_gstin), to = await bookByGstin(c, p.to_gstin);
    const date = new Date().toISOString().slice(0, 10);
    const taxable = Number(p.taxable_value), total = round2(taxable + Number(p.cgst) + Number(p.sgst) + Number(p.igst));
    const rate = taxable ? Math.round(((total - taxable) / taxable) * 1000) / 10 : 0;
    await post(c, {
      type: 'transfer', book_id: from.id, date, auto: true, by: SYSTEM, approved_by: 'stock transfer',
      narration: `Stock transfer ${p.number} (${p.kg} kg) to ${p.to_gstin} — tax invoice ${p.document_no}`,
      source: { service: 'inventory', type: 'transfer_out', id: p.transfer_id, ref: p.document_no },
      lines: [{ account: 'inter_unit', debit: total, narration: `Due from ${to.code}` }, { account: 'transfer_out', credit: taxable }, { account: 'output_cgst', credit: Number(p.cgst) }, { account: 'output_sgst', credit: Number(p.sgst) }, { account: 'output_igst', credit: Number(p.igst) }],
      tax: [{ direction: 'outward', doc_type: 'transfer', doc_no: p.document_no, doc_date: date, party_name: to.name, party_gstin: p.to_gstin, place_of_supply: p.to_gstin.slice(0, 2), rate, taxable, cgst: Number(p.cgst), sgst: Number(p.sgst), igst: Number(p.igst), qty_kg: Number(p.kg) }],
    });
    await post(c, {
      type: 'transfer', book_id: to.id, date, auto: true, by: SYSTEM, approved_by: 'stock transfer',
      narration: `Stock received on transfer ${p.number} from ${p.from_gstin} — tax invoice ${p.document_no}`,
      source: { service: 'inventory', type: 'transfer_in', id: p.transfer_id, ref: p.document_no },
      lines: [{ account: 'transfer_in', debit: taxable }, { account: 'input_cgst', debit: Number(p.cgst) }, { account: 'input_sgst', debit: Number(p.sgst) }, { account: 'input_igst', debit: Number(p.igst) }, { account: 'inter_unit', credit: total, narration: `Due to ${from.code}` }],
      tax: [{ direction: 'inward', doc_type: 'transfer', doc_no: p.document_no, doc_date: date, party_name: from.name, party_gstin: p.from_gstin, place_of_supply: to.state_code, rate, taxable, cgst: Number(p.cgst), sgst: Number(p.sgst), igst: Number(p.igst), qty_kg: Number(p.kg) }],
    });
  };
}

/** Bank details changed in masters (after approval): payments to that party are checked for 30 days. */
export function approvalDecidedConsumer(applyFinance: (c: Client, p: { approval_type: string; ref_id: string; decision: string; decided_by_name: string; comment: string | null }) => Promise<void>) {
  return async (ev: BusEvent, c: Client) => {
    const p = ev.payload as { source_service: string; approval_type: string; ref_id: string; decision: string; decided_by_name: string; comment: string | null; payload?: Record<string, unknown> };
    if (p.source_service === S) return applyFinance(c, p);
    if (p.source_service === 'masters' && p.decision === 'approved' && ['party_bank_account', 'party_sensitive_change'].includes(p.approval_type)) {
      const partyId = String(p.payload?.party_id ?? '');
      if (partyId) await c.query('INSERT INTO bank_changes (party_id, detail) VALUES ($1, $2)', [partyId, p.approval_type]);
    }
  };
}

export const recentBankChange = (c: Client, partyId: string) => one<{ changed_at: string }>(c, `SELECT changed_at FROM bank_changes WHERE party_id = $1 AND changed_at > now() - interval '30 days' ORDER BY changed_at DESC LIMIT 1`, [partyId]);


/** Payroll approved in HR: salary cost and the liabilities to employees, PF/ESIC/PT and salary TDS (section 192). */
export function payrollApprovedConsumer() {
  return async (ev: BusEvent, c: Client) => {
    const p = ev.payload as { run_id: string; month: string; reference: string; gross: number; net: number; pf_employee: number; esic_employee: number; pt: number; tds: number; pf_employer: number; esic_employer: number };
    const book = await primaryBook(c);
    const statutory = round2(Number(p.pf_employee) + Number(p.esic_employee) + Number(p.pt) + Number(p.pf_employer) + Number(p.esic_employer));
    await post(c, {
      type: 'payroll', book_id: book.id, date: monthEndOf(p.month), auto: true, by: SYSTEM, approved_by: 'payroll approval',
      narration: `Salaries for ${p.month.slice(0, 7)}`, source: { service: 'hrms', type: 'payroll_run', id: p.run_id, ref: p.reference },
      lines: [
        { account: 'salaries', debit: Number(p.gross) }, { account: 'employer_contribution', debit: round2(Number(p.pf_employer) + Number(p.esic_employer)) },
        { account: 'salaries_payable', credit: Number(p.net) }, { account: 'payroll_statutory', credit: statutory, narration: 'PF, ESIC and professional tax' },
        { account: 'tds_payable', credit: Number(p.tds), narration: 'Salary TDS (section 192)' },
      ],
    });
  };
}
export function payrollPaidConsumer() {
  return async (ev: BusEvent, c: Client) => {
    const p = ev.payload as { run_id: string; month: string; paid_on: string; net: number; reference: string };
    const book = await primaryBook(c);
    await post(c, {
      type: 'payment', book_id: book.id, date: p.paid_on, auto: true, by: SYSTEM, approved_by: 'payroll release',
      narration: `Salary transfer for ${p.month.slice(0, 7)}`, source: { service: 'hrms', type: 'payroll_payment', id: p.run_id, ref: p.reference },
      lines: [{ account: 'salaries_payable', debit: Number(p.net) }, { account: 'bank_main', credit: Number(p.net) }],
    });
  };
}
const monthEndOf = (m: string) => { const d = new Date(`${m.slice(0, 7)}-01T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() + 1); d.setUTCDate(0); return d.toISOString().slice(0, 10); };
