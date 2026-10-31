import type { Request, Router } from 'express';
import { z } from 'zod';
import { type Client, type ServiceContext, type ServiceName, gstinCheckChar, audit, badRequest, callAsUser, conflict, contextOf, forbidden, many, notFound, one, optText, parse, requirePermission, tx } from '@erp/platform';

const S = 'golive';
const r2 = (n: number) => Math.round(n * 100) / 100;
const as = <T>(req: Request, svc: ServiceName, method: string, path: string, body?: unknown) => callAsUser<T>(String(req.headers.authorization ?? ''), svc, method, path, body);
export async function localNumber(c: Client, key: string, prefix: string) {
  const { rows: [r] } = await c.query(`INSERT INTO counters (doc_type, next_number) VALUES ($1, 2) ON CONFLICT (doc_type) DO UPDATE SET next_number = counters.next_number + 1 RETURNING next_number - 1 AS n`, [key]);
  return `${prefix}${String(r.n).padStart(4, '0')}`;
}

/** Column templates per object; the first row of the CSV must carry these headers. */
export const TEMPLATES: Record<string, { label: string; columns: string[]; example: string[]; control: string; help: string }> = {
  parties: { label: 'Customers, suppliers and mills', columns: ['party_type', 'legal_name', 'gstin', 'pan', 'state_code', 'email', 'phone', 'credit_limit', 'segment'], example: ['customer', 'Shakti Knitwear Pvt Ltd', '33AAJCS1234F1Z5', 'AAJCS1234F', '33', 'accounts@shakti.example', '9443000111', '500000', 'Exporter'], control: 'Number of parties', help: 'party_type is customer, supplier, manufacturer, mill or transporter. Existing names are skipped, not duplicated.' },
  opening_balances: { label: 'Opening receivables and payables (bill-wise)', columns: ['kind', 'party', 'doc_no', 'doc_date', 'due_date', 'amount'], example: ['receivable', 'Sri Murugan Garments', 'OLD/2526/0451', '2026-03-12', '2026-04-11', '125000'], control: 'Total amount (₹)', help: 'kind is receivable or payable; party is the legal name or code as in Business partners. Use one row per unpaid bill; for an advance, use a payable for a customer or a receivable for a supplier.' },
  opening_gl: { label: 'Opening trial balance', columns: ['account_code', 'debit', 'credit', 'date'], example: ['1200', '2500000', '0', '2026-04-01'], control: 'Total debits (₹)', help: 'One line per ledger account from the CA-certified trial balance. Leave out receivables, payables and stock: those come from their own batches and the difference account absorbs them. Debits must equal credits.' },
  gst_credit: { label: 'GST credit carried forward', columns: ['gstin', 'as_of_month', 'igst', 'cgst', 'sgst'], example: ['24AABCD1234E1Z5', '2026-04', '182500', '41250', '41250'], control: 'Total credit (₹)', help: 'One row per GSTIN: the electronic credit ledger closing balance from the last GSTR-3B filed in the old system. as_of_month is the first month run in the ERP; GSTR-3B brings the credit forward from then. Leave the input GST accounts out of the opening trial balance.' },
  gst_cash: { label: 'GST cash ledger balance', columns: ['gstin', 'as_of_month', 'igst', 'cgst', 'sgst'], example: ['24AABCD1234E1Z5', '2026-04', '12000', '3500', '3500'], control: 'Total cash balance (₹)', help: 'One row per GSTIN: the electronic cash ledger closing balance (tax heads only, not interest or fees). GSTR-3B uses it to pay tax left after credit, each head from its own balance.' },
  itc_reversals: { label: 'Pending ITC reversals', columns: ['gstin', 'supplier', 'doc_no', 'doc_date', 'reason', 'reverse_in_month', 'igst', 'cgst', 'sgst'], example: ['24AABCD1234E1Z5', 'Shree Ambica Knitters', 'AMB/2526/771', '2025-10-14', 'rule_37', '2026-04', '0', '2950', '2950'], control: 'Total credit reversed (₹)', help: 'One row per bill whose credit must be reversed in a coming GSTR-3B. reason is rule_37 (supplier unpaid after 180 days; reclaimable once paid), rule_42_43 (common credit) or other. The credit is still in the carried-forward balance; it leaves in reverse_in_month.' },
  opening_stock: { label: 'Opening stock by lot and roll', columns: ['warehouse', 'sku', 'lot_ref', 'roll_kg', 'cost_per_kg', 'grade', 'received_date'], example: ['SRT', 'SJ-160-NVY', 'OLD-L-4411', '24.8', '238', 'A', '2026-02-20'], control: 'Total kg', help: 'One row per roll from the physical count. Rolls get new barcodes; print labels from the inward afterwards. received_date keeps ageing true.' },
  open_pos: { label: 'Open purchase orders', columns: ['supplier', 'legacy_po_no', 'order_date', 'deliver_to', 'expected_date', 'sku', 'pending_kg', 'rate_per_kg'], example: ['Shree Ambica Knitters', 'PO/2526/0912', '2026-03-18', 'SRT', '2026-04-10', 'SJ-160-GRY', '1200', '246'], control: 'Total pending kg', help: 'One row per PO line, with only the quantity still to be received. Rows with the same supplier and legacy_po_no become one PO, loaded as already approved and accepted. deliver_to is a warehouse code or a mill’s name or code.' },
  open_job_work: { label: 'Open job work at mills', columns: ['mill', 'legacy_challan_no', 'challan_date', 'process', 'expected_return_date', 'sku', 'kg_at_mill', 'cost_per_kg', 'rolls', 'lot_ref'], example: ['Surat Process House', 'JWC/2526/0388', '2026-03-05', 'REACTIVE_DYE', '2026-04-08', 'SJ-160-GRY', '850', '246', '34', 'GR-0412'], control: 'Total kg at mills', help: 'One row per challan line, with only the kg still at the mill. Rows with the same mill and legacy_challan_no become one job order the mill has already acknowledged. challan_date keeps the 365-day GST return clock true; cost_per_kg values the fabric when it comes back.' },
  open_orders: { label: 'Open sales orders', columns: ['customer', 'legacy_order_no', 'sku', 'lot_no', 'pending_kg', 'price_per_kg', 'ship_to'], example: ['Sri Murugan Garments', 'SO/2526/1140', 'SJ-160-NVY', '', '300', '312', 'Tiruppur factory'], control: 'Total pending kg', help: 'One row per order line, with only the quantity still to be delivered, at the agreed price. Load opening stock first: each order reserves stock like a new order. Advances already received belong in the opening balances, so no new token is asked for.' },
};

function parseCsv(text: string) {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim());
  const split = (line: string) => { const out: string[] = []; let cur = '', q = false; for (const ch of line) { if (ch === '"') q = !q; else if (ch === ',' && !q) { out.push(cur.trim()); cur = ''; } else cur += ch; } out.push(cur.trim()); return out; };
  const head = split(lines[0] ?? '').map((h) => h.toLowerCase().replace(/\s+/g, '_'));
  return { head, rows: lines.slice(1).map((l) => Object.fromEntries(split(l).map((v, i) => [head[i] ?? `col${i}`, v]))) };
}
const isDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
const GSTIN = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const PAN = /^[A-Z]{5}\d{4}[A-Z]$/;

type Party = { id: string; code: string; legal_name: string; party_type: string };
async function lookups(req: Request, type: string, rows: Record<string, string>[] = []) {
  const out: { parties?: Party[]; products?: { id: string; sku: string }[]; warehouses?: { id: string; code: string }[]; lots?: { id: string; lot_no: string; product_id: string }[]; processes?: { code: string; name: string; status: string }[]; accounts?: { id: string; code: string; control: string | null; status: string; system_key: string | null }[]; books?: { id: string; gstin: string; is_primary: boolean }[] } = {};
  if (['parties', 'opening_balances', 'open_pos', 'open_orders', 'open_job_work'].includes(type)) out.parties = (await as<{ items: Party[] }>(req, 'masters', 'GET', '/parties?pageSize=5000')).items;
  if (type === 'open_job_work') out.processes = await as(req, 'jobwork', 'GET', '/process-templates');
  if (['gst_credit', 'gst_cash', 'itc_reversals'].includes(type)) out.books = await as(req, 'finance', 'GET', '/books');
  if (['open_pos', 'open_orders', 'open_job_work'].includes(type)) out.products = (await as<{ items: { id: string; sku: string }[] }>(req, 'masters', 'GET', '/products?pageSize=2000')).items;
  if (type === 'open_pos') out.warehouses = await as(req, 'organisation', 'GET', '/warehouses');
  if (type === 'open_orders') {
    out.lots = [];
    for (const no of [...new Set(rows.map((d) => d.lot_no).filter(Boolean))])
      out.lots.push(...(await as<{ items: { id: string; lot_no: string; product_id: string }[] }>(req, 'inventory', 'GET', `/lots?q=${encodeURIComponent(no!)}&pageSize=20`)).items.filter((l) => l.lot_no === no));
  }
  if (type === 'opening_stock') { out.products = (await as<{ items: { id: string; sku: string }[] }>(req, 'masters', 'GET', '/products?pageSize=2000')).items; out.warehouses = await as(req, 'organisation', 'GET', '/warehouses'); }
  if (type === 'opening_gl') { out.accounts = await as(req, 'finance', 'GET', '/accounts'); out.books = await as(req, 'finance', 'GET', '/books'); }
  return out;
}

/** A PO destination: a warehouse code, or a mill by legal name or code. */
function deliverTo(v: string, L: Awaited<ReturnType<typeof lookups>>): { type: 'warehouse' | 'mill'; id: string } | null {
  const w = L.warehouses?.find((x) => x.code.toLowerCase() === v.toLowerCase());
  if (w) return { type: 'warehouse', id: w.id };
  const m = L.parties?.find((x) => x.party_type === 'mill' && (x.legal_name.toLowerCase() === v.toLowerCase() || x.code.toLowerCase() === v.toLowerCase()));
  return m ? { type: 'mill', id: m.id } : null;
}

/** Row-level validation; nothing is written to the ERP at this stage. */
function validate(type: string, rows: Record<string, string>[], L: Awaited<ReturnType<typeof lookups>>) {
  const seen = new Set<string>();
  const heads = new Map<string, Record<string, string>>();
  const findParty = (p: string) => L.parties!.find((x) => x.legal_name.toLowerCase() === p.toLowerCase() || x.code.toLowerCase() === p.toLowerCase());
  return rows.map((d) => {
    const e: string[] = [];
    const num = (k: string, min = 0) => { const n = Number(String(d[k] ?? '').replace(/,/g, '')); if (!d[k] || !Number.isFinite(n) || n < min) e.push(`${k} must be a number${min > 0 ? ' above 0' : ''}`); return n; };
    if (type === 'parties') {
      if (!['customer', 'supplier', 'manufacturer', 'mill', 'transporter'].includes(d.party_type ?? '')) e.push('party_type must be customer, supplier, manufacturer, mill or transporter');
      if (!d.legal_name || d.legal_name.length < 2) e.push('legal_name is required');
      if (d.gstin && (!GSTIN.test(d.gstin.toUpperCase()) || gstinCheckChar(d.gstin.toUpperCase().slice(0, 14)) !== d.gstin.toUpperCase()[14])) e.push('gstin is not a valid GSTIN (format or check digit)');
      if (d.gstin && d.state_code && d.gstin.slice(0, 2) !== d.state_code.padStart(2, '0')) e.push('state_code does not match the GSTIN');
      if (d.pan && !PAN.test(d.pan.toUpperCase())) e.push('pan is not a valid PAN');
      if (d.credit_limit) num('credit_limit');
      const k = `${d.party_type}|${(d.legal_name ?? '').toLowerCase()}`; if (seen.has(k)) e.push('duplicate row in this file'); seen.add(k);
    } else if (type === 'opening_balances') {
      if (!['receivable', 'payable'].includes(d.kind ?? '')) e.push('kind must be receivable or payable');
      if (!d.party || !findParty(d.party)) e.push(`party "${d.party ?? ''}" is not in Business partners — load parties first`);
      if (!d.doc_no) e.push('doc_no is required');
      if (!isDate(d.doc_date ?? '')) e.push('doc_date must be YYYY-MM-DD');
      if (!isDate(d.due_date ?? '')) e.push('due_date must be YYYY-MM-DD');
      num('amount', 0.01);
      const k = `${d.kind}|${d.party}|${d.doc_no}`.toLowerCase(); if (seen.has(k)) e.push('duplicate bill in this file'); seen.add(k);
    } else if (type === 'opening_gl') {
      const a = L.accounts!.find((x) => x.code === d.account_code);
      if (!a) e.push(`account ${d.account_code ?? ''} is not in the chart of accounts`);
      else if (a.control) e.push(`${d.account_code} is a ${a.control} control account — load it with the bill-wise batch`);
      else if (a.system_key?.startsWith('input_')) e.push(`${d.account_code} is GST input credit — load it with the GST credit carried forward batch`);
      else if (a.system_key === 'gst_cash_ledger') e.push(`${d.account_code} is the GST cash ledger — load it with the GST cash ledger batch`);
      const dr = Number(d.debit || 0), cr = Number(d.credit || 0);
      if (!(dr > 0) === !(cr > 0)) e.push('give either a debit or a credit');
      if (d.date && !isDate(d.date)) e.push('date must be YYYY-MM-DD');
    } else if (type === 'open_pos') {
      const sup = d.supplier ? findParty(d.supplier) : undefined;
      if (!sup || !['supplier', 'manufacturer'].includes(sup.party_type)) e.push(`supplier "${d.supplier ?? ''}" is not a supplier or manufacturer in Business partners`);
      if (!d.legacy_po_no) e.push('legacy_po_no is required');
      if (!deliverTo(d.deliver_to ?? '', L)) e.push(`deliver_to "${d.deliver_to ?? ''}" is not a warehouse code or a mill`);
      if (d.order_date && !isDate(d.order_date)) e.push('order_date must be YYYY-MM-DD');
      if (!isDate(d.expected_date ?? '')) e.push('expected_date must be YYYY-MM-DD');
      if (!L.products!.find((p) => p.sku === d.sku)) e.push(`sku ${d.sku ?? ''} is not in the fabric catalogue`);
      num('pending_kg', 0.01); num('rate_per_kg', 0.01);
      const g = `${(d.supplier ?? '').toLowerCase()}|${d.legacy_po_no}`;
      const first = heads.get(g);
      if (first && (first.deliver_to !== d.deliver_to || first.expected_date !== d.expected_date || (first.order_date ?? '') !== (d.order_date ?? ''))) e.push(`deliver_to, expected_date and order_date must be the same on every line of ${d.legacy_po_no}`);
      if (!first) heads.set(g, d);
      const k = `${g}|${d.sku}`; if (seen.has(k)) e.push('the same SKU appears twice on this PO — combine the lines'); seen.add(k);
    } else if (type === 'open_job_work') {
      const mill = d.mill ? findParty(d.mill) : undefined;
      if (!mill || mill.party_type !== 'mill') e.push(`mill "${d.mill ?? ''}" is not a mill in Business partners`);
      if (!d.legacy_challan_no) e.push('legacy_challan_no is required');
      if (!isDate(d.challan_date ?? '')) e.push('challan_date must be YYYY-MM-DD');
      else if (d.challan_date! > new Date().toISOString().slice(0, 10)) e.push('challan_date is in the future');
      if (!isDate(d.expected_return_date ?? '')) e.push('expected_return_date must be YYYY-MM-DD');
      const proc = L.processes!.find((p) => p.code === d.process || p.name.toLowerCase() === (d.process ?? '').toLowerCase());
      if (!proc || proc.status !== 'active') e.push(`process "${d.process ?? ''}" is not an active process (${L.processes!.filter((p) => p.status === 'active').map((p) => p.code).join(', ')})`);
      if (!L.products!.find((p) => p.sku === d.sku)) e.push(`sku ${d.sku ?? ''} is not in the fabric catalogue`);
      num('kg_at_mill', 0.01); num('cost_per_kg', 0.01);
      if (d.rolls && !/^\d+$/.test(d.rolls)) e.push('rolls must be a whole number');
      const g = `${(d.mill ?? '').toLowerCase()}|${d.legacy_challan_no}`;
      const first = heads.get(g);
      if (first && (first.challan_date !== d.challan_date || first.process !== d.process || first.expected_return_date !== d.expected_return_date)) e.push(`challan_date, process and expected_return_date must be the same on every line of ${d.legacy_challan_no}`);
      if (!first) heads.set(g, d);
    } else if (type === 'itc_reversals') {
      const gstin = (d.gstin ?? '').toUpperCase();
      if (!L.books!.find((b) => b.gstin === gstin)) e.push(`gstin ${d.gstin ?? ''} is not one of your GST registrations`);
      if (!d.supplier || d.supplier.length < 2) e.push('supplier is required');
      if (!d.doc_no) e.push('doc_no is required');
      if (!isDate(d.doc_date ?? '')) e.push('doc_date must be YYYY-MM-DD');
      if (!['rule_37', 'rule_42_43', 'other'].includes(d.reason ?? '')) e.push('reason must be rule_37, rule_42_43 or other');
      if (!/^\d{4}-\d{2}(-01)?$/.test(d.reverse_in_month ?? '')) e.push('reverse_in_month must be YYYY-MM');
      for (const k of ['igst', 'cgst', 'sgst']) num(k);
      if (!(Number(d.igst || 0) + Number(d.cgst || 0) + Number(d.sgst || 0) > 0)) e.push('enter the credit to reverse');
      if (d.reason === 'rule_37' && isDate(d.doc_date ?? '') && /^\d{4}-\d{2}/.test(d.reverse_in_month ?? '') && Date.parse(`${d.reverse_in_month!.slice(0, 7)}-01`) - Date.parse(d.doc_date!) < 150 * 86_400_000) e.push('a Rule 37 reversal falls due 180 days after the bill date — check reverse_in_month');
      const k = `${gstin}|${(d.supplier ?? '').toLowerCase()}|${d.doc_no}|${d.reason}`; if (seen.has(k)) e.push('duplicate row in this file'); seen.add(k);
    } else if (type === 'gst_credit' || type === 'gst_cash') {
      const gstin = (d.gstin ?? '').toUpperCase();
      if (!L.books!.find((b) => b.gstin === gstin)) e.push(`gstin ${d.gstin ?? ''} is not one of your GST registrations`);
      if (!/^\d{4}-\d{2}(-01)?$/.test(d.as_of_month ?? '')) e.push('as_of_month must be YYYY-MM');
      for (const k of ['igst', 'cgst', 'sgst']) num(k);
      if (type === 'gst_credit' && Number(d.cgst || 0) !== Number(d.sgst || 0)) e.push('cgst and sgst credit are normally equal — check the electronic credit ledger');
      if (seen.has(gstin)) e.push('one row per GSTIN'); seen.add(gstin);
    } else if (type === 'open_orders') {
      const cust = d.customer ? findParty(d.customer) : undefined;
      if (!cust || cust.party_type !== 'customer') e.push(`customer "${d.customer ?? ''}" is not a customer in Business partners`);
      if (!d.legacy_order_no) e.push('legacy_order_no is required');
      const prod = L.products!.find((p) => p.sku === d.sku);
      if (!prod) e.push(`sku ${d.sku ?? ''} is not in the fabric catalogue`);
      if (d.lot_no && !L.lots!.find((l) => l.lot_no === d.lot_no && (!prod || l.product_id === prod.id))) e.push(`lot ${d.lot_no} of ${d.sku ?? ''} is not in stock — load opening stock first, or leave lot_no empty`);
      num('pending_kg', 0.01); num('price_per_kg', 0.01);
      const g = `${(d.customer ?? '').toLowerCase()}|${d.legacy_order_no}`;
      const first = heads.get(g);
      if (first && (first.ship_to ?? '') !== (d.ship_to ?? '')) e.push(`ship_to must be the same on every line of ${d.legacy_order_no}`);
      if (!first) heads.set(g, d);
      const k = `${g}|${d.sku}|${d.lot_no ?? ''}`; if (seen.has(k)) e.push('the same SKU and lot appear twice on this order — combine the lines'); seen.add(k);
      if (rows.filter((x) => `${(x.customer ?? '').toLowerCase()}|${x.legacy_order_no}` === g).length > 40 && first === undefined) e.push(`${d.legacy_order_no} has more than 40 lines — split it`);
    } else if (type === 'opening_stock') {
      if (!L.warehouses!.find((w) => w.code === d.warehouse)) e.push(`warehouse ${d.warehouse ?? ''} is unknown`);
      if (!L.products!.find((p) => p.sku === d.sku)) e.push(`sku ${d.sku ?? ''} is not in the fabric catalogue`);
      if (!d.lot_ref) e.push('lot_ref is required');
      num('roll_kg', 0.01);
      if (d.cost_per_kg) num('cost_per_kg', 0.01); else e.push('cost_per_kg is required for valuation');
      if (d.grade && !['A', 'B', 'C', 'reject'].includes(d.grade)) e.push('grade must be A, B, C or reject');
      if (d.received_date && !isDate(d.received_date)) e.push('received_date must be YYYY-MM-DD');
    }
    return { data: d, errors: e };
  });
}

function controlTotal(type: string, rows: Record<string, string>[]) {
  if (type === 'parties') return rows.length;
  if (type === 'opening_balances') return r2(rows.reduce((s, d) => s + Number(String(d.amount).replace(/,/g, '')), 0));
  if (type === 'opening_gl') return r2(rows.reduce((s, d) => s + Number(d.debit || 0), 0));
  if (type === 'open_job_work') return r2(rows.reduce((s, d) => s + Number(d.kg_at_mill), 0));
  if (type === 'gst_credit' || type === 'gst_cash' || type === 'itc_reversals') return r2(rows.reduce((s, d) => s + Number(d.igst || 0) + Number(d.cgst || 0) + Number(d.sgst || 0), 0));
  if (type === 'open_pos' || type === 'open_orders') return r2(rows.reduce((s, d) => s + Number(d.pending_kg), 0));
  return r2(rows.reduce((s, d) => s + Number(d.roll_kg), 0));
}

export function migrationRoutes(r: Router, { pool }: ServiceContext) {
  r.get('/migration/templates', requirePermission('golive.read'), (_req, res) => { res.json(TEMPLATES); });
  r.get('/migration/batches', requirePermission('golive.read'), async (_req, res) => {
    res.json(await many(pool, `SELECT *, source_total::float, erp_total::float, difference::float FROM migration_batches ORDER BY created_at DESC`));
  });
  r.get('/migration/batches/:id', requirePermission('golive.read'), async (req, res) => {
    const b = await one(pool, `SELECT *, source_total::float, erp_total::float, difference::float FROM migration_batches WHERE id = $1`, [req.params.id]);
    if (!b) throw notFound('Batch');
    res.json({ ...b, rows: await many(pool, `SELECT row_no, data, errors, status, result_ref, error FROM migration_rows WHERE batch_id = $1 ORDER BY row_no LIMIT 5000`, [req.params.id]) });
  });

  /** Upload: parse and validate every row. Invalid rows are listed with their reasons; nothing is loaded yet. */
  r.post('/migration/batches', requirePermission('golive.migration.manage'), async (req, res) => {
    const b = parse(z.object({ object_type: z.enum(['parties', 'opening_balances', 'opening_gl', 'opening_stock', 'open_pos', 'open_orders', 'open_job_work', 'gst_credit', 'gst_cash', 'itc_reversals']), csv: z.string().min(5).max(5_000_000), file_name: optText(200) }), req.body);
    const t = TEMPLATES[b.object_type]!;
    const { head, rows } = parseCsv(b.csv);
    const missing = t.columns.filter((c) => !head.includes(c) && !['gstin', 'pan', 'email', 'phone', 'credit_limit', 'segment', 'state_code', 'date', 'grade', 'received_date', 'order_date', 'lot_no', 'ship_to', 'rolls', 'lot_ref', 'igst', 'cgst', 'sgst'].includes(c));
    if (missing.length) throw badRequest(`Missing columns: ${missing.join(', ')}`);
    if (!rows.length) throw badRequest('The file has no rows');
    if (rows.length > 5000) throw badRequest('Load at most 5,000 rows per batch');
    const L = await lookups(req, b.object_type, rows);
    const checked = validate(b.object_type, rows, L);
    const batchErrors: string[] = [];
    if (b.object_type === 'opening_gl') {
      const dr = r2(rows.reduce((s, d) => s + Number(d.debit || 0), 0)), cr = r2(rows.reduce((s, d) => s + Number(d.credit || 0), 0));
      if (Math.abs(dr - cr) > 0.01) batchErrors.push(`Debits ₹${dr.toLocaleString('en-IN')} and credits ₹${cr.toLocaleString('en-IN')} differ by ₹${r2(dr - cr).toLocaleString('en-IN')}`);
    }
    const out = await tx(pool, async (c) => {
      const number = await localNumber(c, 'batch', 'MIG-');
      const valid = checked.filter((x) => !x.errors.length).length;
      const bt = await one<{ id: string }>(c, `INSERT INTO migration_batches (number, object_type, file_name, rows, valid, invalid, control_label, source_total, notes, created_by_name) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
        [number, b.object_type, b.file_name ?? null, rows.length, valid, rows.length - valid, t.control, controlTotal(b.object_type, checked.filter((x) => !x.errors.length).map((x) => x.data)), batchErrors.join('; ') || null, req.user!.name]);
      for (const [i, x] of checked.entries()) await c.query(`INSERT INTO migration_rows (batch_id, row_no, data, errors, status) VALUES ($1,$2,$3,$4,$5)`, [bt!.id, i + 2, JSON.stringify(x.data), x.errors, x.errors.length ? 'invalid' : 'valid']);
      await audit(c, S, contextOf(req), { entity: 'migration_batch', entityId: bt!.id, action: 'uploaded', after: { number, type: b.object_type, rows: rows.length, valid } });
      return { id: bt!.id, number, rows: rows.length, valid, invalid: rows.length - valid, batch_errors: batchErrors };
    });
    res.status(201).json(out);
  });

  /** Load the valid rows through the owning services' own APIs, as the signed-in user (their checks and approvals apply). */
  r.post('/migration/batches/:id/import', requirePermission('golive.migration.manage'), async (req, res) => {
    const b = await one<{ id: string; number: string; object_type: string; status: string; invalid: number; notes: string | null }>(pool, 'SELECT * FROM migration_batches WHERE id = $1', [req.params.id]);
    if (!b) throw notFound('Batch');
    if (b.status !== 'validated') throw conflict(`This batch is ${b.status}`);
    if (b.object_type === 'opening_gl' && b.notes) throw conflict(`Fix the file first: ${b.notes}`);
    const upd = await pool.query(`UPDATE migration_batches SET status = 'importing', updated_at = now() WHERE id = $1 AND status = 'validated'`, [b.id]);
    if (!upd.rowCount) throw conflict('Already importing');
    const rows = await many<{ id: number; row_no: number; data: Record<string, string> }>(pool, `SELECT id, row_no, data FROM migration_rows WHERE batch_id = $1 AND status = 'valid' ORDER BY row_no`, [b.id]);
    const L = await lookups(req, b.object_type, rows.map((x) => x.data));
    const mark = (id: number, status: string, ref: string | null, error: string | null = null) => pool.query('UPDATE migration_rows SET status = $2, result_ref = $3, error = $4 WHERE id = $1', [id, status, ref, error]);
    const party = (p: string) => L.parties!.find((x) => x.legal_name.toLowerCase() === p.toLowerCase() || x.code.toLowerCase() === p.toLowerCase())!;
    try {
      if (b.object_type === 'parties') {
        for (const r1 of rows) {
          const d = r1.data;
          const existing = L.parties!.find((x) => x.legal_name.toLowerCase() === d.legal_name!.toLowerCase() && x.party_type === d.party_type);
          if (existing) { await mark(r1.id, 'skipped', existing.code, 'Already in Business partners'); continue; }
          try {
            const p = await as<{ id: string; code: string }>(req, 'masters', 'POST', '/parties', { party_type: d.party_type, legal_name: d.legal_name, gst_treatment: d.gstin ? 'registered' : 'unregistered', gstin: d.gstin || null, pan: d.pan || null, state_code: d.state_code ? d.state_code.padStart(2, '0') : d.gstin ? d.gstin.slice(0, 2) : null, email: d.email || null, phone: d.phone || null, credit_limit: d.credit_limit ? Number(d.credit_limit) : null, segment: d.segment || null, tags: ['migrated', b.number] });
            await mark(r1.id, 'imported', p.code);
          } catch (e) { await mark(r1.id, 'failed', null, (e as Error).message); }
        }
      } else if (b.object_type === 'opening_balances') {
        for (const r1 of rows) {
          const d = r1.data;
          try { const v = await as<{ number: string }>(req, 'finance', 'POST', '/opening-bills', { kind: d.kind, party_id: party(d.party!).id, doc_no: d.doc_no, doc_date: d.doc_date, due_date: d.due_date, amount: Number(String(d.amount).replace(/,/g, '')), reference: b.number }); await mark(r1.id, 'imported', v.number); }
          catch (e) { await mark(r1.id, 'failed', null, (e as Error).message); }
        }
      } else if (b.object_type === 'opening_gl') {
        const book = L.books!.find((x) => x.is_primary) ?? L.books![0]!;
        const date = rows.find((x) => x.data.date)?.data.date ?? `${new Date().getUTCFullYear()}-04-01`;
        try {
          const v = await as<{ id: string; number: string; status: string }>(req, 'finance', 'POST', '/vouchers', { voucher_type: 'opening', book_id: book.id, date, narration: `Opening trial balance (migration ${b.number})`, reference: b.number,
            lines: rows.map((x) => ({ account_id: L.accounts!.find((a) => a.code === x.data.account_code)!.id, debit: Number(x.data.debit || 0), credit: Number(x.data.credit || 0) })) });
          for (const r1 of rows) await mark(r1.id, 'imported', v.number);
        } catch (e) { for (const r1 of rows) await mark(r1.id, 'failed', null, (e as Error).message); }
      } else if (b.object_type === 'open_pos' || b.object_type === 'open_orders') {
        // One document per legacy number; every line of it shares the result.
        const po = b.object_type === 'open_pos';
        const groups = new Map<string, typeof rows>();
        for (const r1 of rows) { const g = `${(po ? r1.data.supplier : r1.data.customer)!.toLowerCase()}|${po ? r1.data.legacy_po_no : r1.data.legacy_order_no}`; groups.set(g, [...(groups.get(g) ?? []), r1]); }
        for (const rs of groups.values()) {
          const d = rs[0]!.data;
          const product = (sku: string) => L.products!.find((p) => p.sku === sku)!.id;
          try {
            const out = po
              ? await as<{ number: string; existing: boolean }>(req, 'procurement', 'POST', '/purchase-orders/opening', { supplier_id: party(d.supplier!).id, legacy_ref: d.legacy_po_no, order_date: d.order_date || undefined, migration_ref: b.number,
                  deliver_to_type: deliverTo(d.deliver_to!, L)!.type, deliver_to_id: deliverTo(d.deliver_to!, L)!.id, expected_date: d.expected_date,
                  lines: rs.map((x) => ({ product_id: product(x.data.sku!), qty_kg: Number(x.data.pending_kg), rate_per_kg: Number(x.data.rate_per_kg) })) })
              : await as<{ number: string; existing: boolean }>(req, 'commerce', 'POST', '/orders/opening', { customer_id: party(d.customer!).id, legacy_ref: d.legacy_order_no, migration_ref: b.number, ship_to: d.ship_to || null,
                  lines: rs.map((x) => ({ product_id: product(x.data.sku!), lot_id: x.data.lot_no ? L.lots!.find((l) => l.lot_no === x.data.lot_no && l.product_id === product(x.data.sku!))!.id : null, kg: Number(x.data.pending_kg), price_per_kg: Number(x.data.price_per_kg) })) });
            for (const r1 of rs) await mark(r1.id, out.existing ? 'skipped' : 'imported', out.number, out.existing ? 'Already loaded' : null);
          } catch (e) { for (const r1 of rs) await mark(r1.id, 'failed', null, (e as Error).message); }
        }
      } else if (b.object_type === 'open_job_work') {
        const groups = new Map<string, typeof rows>();
        for (const r1 of rows) { const g = `${r1.data.mill!.toLowerCase()}|${r1.data.legacy_challan_no}`; groups.set(g, [...(groups.get(g) ?? []), r1]); }
        for (const rs of groups.values()) {
          const d = rs[0]!.data;
          try {
            const out = await as<{ number: string; existing: boolean }>(req, 'jobwork', 'POST', '/orders/opening', { mill_id: party(d.mill!).id, legacy_challan_no: d.legacy_challan_no, challan_date: d.challan_date, expected_return_date: d.expected_return_date, migration_ref: b.number,
              process_code: L.processes!.find((p) => p.code === d.process || p.name.toLowerCase() === d.process!.toLowerCase())!.code,
              lines: rs.map((x) => ({ product_id: L.products!.find((p) => p.sku === x.data.sku)!.id, kg_at_mill: Number(x.data.kg_at_mill), cost_per_kg: Number(x.data.cost_per_kg), rolls: x.data.rolls ? Number(x.data.rolls) : null, lot_ref: x.data.lot_ref || null })) });
            for (const r1 of rs) await mark(r1.id, out.existing ? 'skipped' : 'imported', out.number, out.existing ? 'Already loaded' : null);
          } catch (e) { for (const r1 of rs) await mark(r1.id, 'failed', null, (e as Error).message); }
        }
      } else if (b.object_type === 'itc_reversals') {
        for (const r1 of rows) {
          const d = r1.data;
          try {
            const out = await as<{ number: string; existing: boolean }>(req, 'finance', 'POST', '/gst/itc-reversals', { gstin: d.gstin!.toUpperCase(), supplier_name: d.supplier, doc_no: d.doc_no, doc_date: d.doc_date, reason: d.reason, period: d.reverse_in_month,
              igst: Number(d.igst || 0), cgst: Number(d.cgst || 0), sgst: Number(d.sgst || 0), reference: b.number });
            await mark(r1.id, out.existing ? 'skipped' : 'imported', out.number, out.existing ? 'Already loaded' : null);
          } catch (e) { await mark(r1.id, 'failed', null, (e as Error).message); }
        }
      } else if (b.object_type === 'gst_credit' || b.object_type === 'gst_cash') {
        for (const r1 of rows) {
          const d = r1.data;
          try {
            const out = await as<{ number: string | null; existing: boolean }>(req, 'finance', 'POST', `/gst/opening-${b.object_type === 'gst_credit' ? 'credit' : 'cash'}`, { gstin: d.gstin!.toUpperCase(), as_of: d.as_of_month, igst: Number(d.igst || 0), cgst: Number(d.cgst || 0), sgst: Number(d.sgst || 0), reference: b.number });
            await mark(r1.id, out.existing ? 'skipped' : 'imported', d.gstin!.toUpperCase(), out.existing ? 'Already loaded' : null);
          } catch (e) { await mark(r1.id, 'failed', null, (e as Error).message); }
        }
      } else if (b.object_type === 'opening_stock') {
        const byWh = new Map<string, typeof rows>();
        for (const r1 of rows) byWh.set(r1.data.warehouse!, [...(byWh.get(r1.data.warehouse!) ?? []), r1]);
        for (const [wh, rs] of byWh) {
          const lots = new Map<string, typeof rows>();
          for (const r1 of rs) lots.set(`${r1.data.sku}|${r1.data.lot_ref}`, [...(lots.get(`${r1.data.sku}|${r1.data.lot_ref}`) ?? []), r1]);
          try {
            const received = rs.map((x) => x.data.received_date).filter(Boolean).sort()[0] ?? null;
            const inw = await as<{ id: string; number: string }>(req, 'inventory', 'POST', '/inwards', { warehouse_id: L.warehouses!.find((w) => w.code === wh)!.id, source_ref: `Opening stock ${b.number}`, received_date: received, notes: `Migration ${b.number}`,
              lines: [...lots.values()].map((ls) => ({ product_id: L.products!.find((p) => p.sku === ls[0]!.data.sku)!.id, expected_kg: r2(ls.reduce((s, x) => s + Number(x.data.roll_kg), 0)), expected_rolls: ls.length, cost_per_kg: Number(ls[0]!.data.cost_per_kg), lot_ref: ls[0]!.data.lot_ref })) });
            const det = await as<{ lines: { id: string; lot_ref: string; product_id: string }[] }>(req, 'inventory', 'GET', `/inwards/${inw.id}`);
            const graded: { barcode: string; grade: string }[] = [];
            for (const ls of lots.values()) {
              const pid = L.products!.find((p) => p.sku === ls[0]!.data.sku)!.id;
              const line = det.lines.find((l) => l.lot_ref === ls[0]!.data.lot_ref && l.product_id === pid)!;
              for (const r1 of ls) {
                try { const roll = await as<{ barcode: string }>(req, 'inventory', 'POST', `/inwards/${inw.id}/rolls`, { line_id: line.id, weight_kg: Number(r1.data.roll_kg) }); graded.push({ barcode: roll.barcode, grade: r1.data.grade || 'A' }); await mark(r1.id, 'imported', roll.barcode); }
                catch (e) { await mark(r1.id, 'failed', null, (e as Error).message); }
              }
            }
            await as(req, 'inventory', 'POST', `/inwards/${inw.id}/complete`, {});
            if (graded.length) await as(req, 'inventory', 'POST', '/qc', { results: graded, note: `Opening stock ${b.number}` }).catch(() => undefined);
          } catch (e) { for (const r1 of rs) await pool.query(`UPDATE migration_rows SET status = 'failed', error = $2 WHERE id = $1 AND status = 'valid'`, [r1.id, (e as Error).message]); }
        }
      }
    } finally {
      const c = await one<{ imported: number; failed: number }>(pool, `SELECT count(*) FILTER (WHERE status IN ('imported','skipped'))::int AS imported, count(*) FILTER (WHERE status = 'failed')::int AS failed FROM migration_rows WHERE batch_id = $1`, [b.id]);
      await pool.query(`UPDATE migration_batches SET status = 'imported', imported = $2, failed = $3, updated_at = now() WHERE id = $1`, [b.id, c!.imported, c!.failed]);
    }
    await reconcile(req, pool, b.id);
    res.json(await one(pool, `SELECT *, source_total::float, erp_total::float, difference::float FROM migration_batches WHERE id = $1`, [b.id]));
  });

  r.post('/migration/batches/:id/reconcile', requirePermission('golive.migration.manage', 'golive.migration.signoff'), async (req, res) => {
    res.json(await reconcile(req, pool, String(req.params.id)));
  });

  /** A business owner (not the person who loaded it) signs the batch off once it reconciles. */
  r.post('/migration/batches/:id/signoff', requirePermission('golive.migration.signoff'), async (req, res) => {
    const b2 = parse(z.object({ note: optText(500), accept_difference: z.boolean().default(false) }), req.body);
    await tx(pool, async (c) => {
      const b = await one<{ status: string; created_by_name: string; difference: number | null; failed: number }>(c, 'SELECT * FROM migration_batches WHERE id = $1 FOR UPDATE', [req.params.id]);
      if (!b) throw notFound('Batch');
      if (b.created_by_name === req.user!.name) throw forbidden('The person who loaded a batch cannot sign it off');
      if (b.status !== 'reconciled') throw conflict('Reconcile the batch first');
      if ((Math.abs(Number(b.difference ?? 0)) > 0.01 || b.failed > 0) && !b2.accept_difference) throw conflict('The batch does not tie up; accept the difference explicitly with a note, or fix and reload');
      if (b2.accept_difference && !b2.note) throw badRequest('Explain why the difference is accepted');
      await c.query(`UPDATE migration_batches SET status = 'signed_off', signed_off_by_name = $2, signed_off_at = now(), notes = coalesce($3, notes), updated_at = now() WHERE id = $1`, [req.params.id, req.user!.name, b2.note ?? null]);
      await audit(c, S, contextOf(req), { entity: 'migration_batch', entityId: String(req.params.id), action: 'signed_off', reason: b2.note ?? null });
    });
    res.json({ ok: true });
  });
  r.post('/migration/batches/:id/abandon', requirePermission('golive.migration.manage'), async (req, res) => {
    const r1 = await pool.query(`UPDATE migration_batches SET status = 'abandoned', updated_at = now() WHERE id = $1 AND status = 'validated'`, [req.params.id]);
    if (!r1.rowCount) throw conflict('Only batches not yet loaded can be abandoned');
    res.json({ ok: true });
  });
}

/** Compare the file's control total with what the ERP now holds, read back from the owning service. */
async function reconcile(req: Request, pool: ServiceContext['pool'], id: string) {
  const b = await one<{ id: string; number: string; object_type: string; source_total: number; status: string }>(pool, 'SELECT * FROM migration_batches WHERE id = $1', [id]);
  if (!b) throw notFound('Batch');
  if (!['imported', 'reconciled'].includes(b.status)) throw conflict('Load the batch first');
  const rows = await many<{ data: Record<string, string>; status: string; result_ref: string | null }>(pool, `SELECT data, status, result_ref FROM migration_rows WHERE batch_id = $1 AND status IN ('imported','skipped')`, [id]);
  let erp = 0;
  const detail: Record<string, unknown> = {};
  if (b.object_type === 'parties') {
    const all = (await as<{ items: { legal_name: string; party_type: string }[] }>(req, 'masters', 'GET', '/parties?pageSize=5000')).items;
    erp = rows.filter((r) => all.some((p) => p.legal_name.toLowerCase() === r.data.legal_name!.toLowerCase() && p.party_type === r.data.party_type)).length;
    detail.skipped_existing = rows.filter((r) => r.status === 'skipped').length;
  } else if (b.object_type === 'opening_balances') {
    // Read back the vouchers this batch produced (a re-loaded bill points at the voucher created the first time).
    const refs = new Set(rows.map((r) => r.result_ref).filter(Boolean));
    const v = (await as<{ number: string; amount: number; status: string }[]>(req, 'finance', 'GET', '/vouchers?type=opening')).filter((x) => refs.has(x.number));
    erp = r2(v.filter((x) => x.status === 'posted').reduce((s, x) => s + Number(x.amount), 0));
    detail.vouchers = v.length;
  } else if (b.object_type === 'opening_gl') {
    const refs = new Set(rows.map((r) => r.result_ref).filter(Boolean));
    const v = (await as<{ number: string; amount: number; status: string }[]>(req, 'finance', 'GET', '/vouchers?type=opening')).filter((x) => refs.has(x.number));
    erp = r2(v.filter((x) => x.status === 'posted').reduce((s, x) => s + Number(x.amount), 0));
    detail.voucher_status = v.map((x) => `${x.number}: ${x.status.replace('_', ' ')}`);
    if (v.some((x) => x.status === 'pending_approval')) detail.note = 'The opening voucher is waiting for a checker in Approvals; reconcile again after approval.';
  } else if (b.object_type === 'open_pos') {
    // Read back the POs this batch produced; a PO loaded by an earlier batch is matched by its number too.
    const nums = [...new Set(rows.map((r) => r.result_ref).filter(Boolean))] as string[];
    const pos: { number: string; status: string; ordered_kg: number }[] = [];
    for (let i = 0; i < nums.length; i += 150) pos.push(...(await as<{ items: typeof pos }>(req, 'procurement', 'GET', `/purchase-orders?pageSize=200&f_numbers=${encodeURIComponent(nums.slice(i, i + 150).join(','))}`)).items);
    erp = r2(pos.filter((x) => x.status !== 'cancelled').reduce((s, x) => s + Number(x.ordered_kg), 0));
    detail.purchase_orders = pos.length;
  } else if (b.object_type === 'open_orders') {
    const nums = [...new Set(rows.map((r) => r.result_ref).filter(Boolean))] as string[];
    const orders: { number: string; status: string; kg: number }[] = [];
    for (let i = 0; i < nums.length; i += 150) orders.push(...(await as<typeof orders>(req, 'commerce', 'GET', `/orders?numbers=${encodeURIComponent(nums.slice(i, i + 150).join(','))}`)));
    const live = orders.filter((x) => x.status !== 'cancelled');
    erp = r2(live.reduce((s, x) => s + Number(x.kg), 0));
    detail.sales_orders = orders.length;
    detail.by_status = Object.fromEntries([...new Set(live.map((x) => x.status))].map((st) => [st, live.filter((x) => x.status === st).length]));
    if (live.some((x) => x.status === 'awaiting_allocation')) detail.note = 'Some orders wait for a warehouse decision in Fulfilment → Allocation (no single warehouse holds the stock).';
  } else if (b.object_type === 'open_job_work') {
    const nums = [...new Set(rows.map((r) => r.result_ref).filter(Boolean))] as string[];
    const jobs: { number: string; status: string; kg_sent: number }[] = [];
    for (let i = 0; i < nums.length; i += 150) jobs.push(...(await as<{ items: typeof jobs }>(req, 'jobwork', 'GET', `/orders?pageSize=200&f_numbers=${encodeURIComponent(nums.slice(i, i + 150).join(','))}`)).items);
    erp = r2(jobs.filter((x) => x.status !== 'cancelled').reduce((s, x) => s + Number(x.kg_sent), 0));
    detail.job_orders = jobs.length;
  } else if (b.object_type === 'itc_reversals') {
    const refs = new Set(rows.map((r) => r.result_ref));
    const rv = (await as<{ voucher_number: string | null; voucher_status: string | null; igst: number; cgst: number; sgst: number; period: string }[]>(req, 'finance', 'GET', '/gst/itc-reversals')).filter((x) => x.voucher_number && refs.has(x.voucher_number));
    erp = r2(rv.filter((x) => x.voucher_status === 'posted').reduce((s, x) => s + x.igst + x.cgst + x.sgst, 0));
    detail.reversals = rv.length;
    detail.by_month = Object.fromEntries([...new Set(rv.map((x) => x.period.slice(0, 7)))].sort().map((m) => [m, rv.filter((x) => x.period.startsWith(m)).length]));
  } else if (b.object_type === 'gst_credit' || b.object_type === 'gst_cash') {
    const gstins = new Set(rows.map((r) => r.result_ref));
    const cr = (await as<{ gstin: string; igst: number; cgst: number; sgst: number; voucher_number: string | null; voucher_status: string | null }[]>(req, 'finance', 'GET', `/gst/opening-${b.object_type === 'gst_credit' ? 'credit' : 'cash'}`)).filter((x) => gstins.has(x.gstin));
    erp = r2(cr.filter((x) => !x.voucher_number || x.voucher_status === 'posted').reduce((s, x) => s + x.igst + x.cgst + x.sgst, 0));
    detail.gstins = cr.map((x) => `${x.gstin}: ${x.voucher_number ?? 'nil credit'}`);
  } else if (b.object_type === 'opening_stock') {
    const list = await as<{ id: string; source_ref: string; weighed_kg: number }[]>(req, 'inventory', 'GET', '/inwards');
    const mine = list.filter((x) => x.source_ref.includes(b.number));
    erp = mine.reduce((s, x) => s + Number(x.weighed_kg), 0);
    detail.inwards = mine.length;
    erp = r2(erp);
  }
  const diff = r2(Number(b.source_total) - erp);
  await pool.query(`UPDATE migration_batches SET status = 'reconciled', erp_total = $2, difference = $3, reconciliation = $4, updated_at = now() WHERE id = $1`, [id, erp, diff, JSON.stringify(detail)]);
  return { source_total: Number(b.source_total), erp_total: erp, difference: diff, detail };
}
