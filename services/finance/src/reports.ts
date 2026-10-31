import type { Router } from 'express';
import { z } from 'zod';
import { type Client, type ServiceContext, badRequest, callService, conflict, many, one, optText, parse, reqText, requirePermission, tx } from '@erp/platform';
import { S, auditReq, books, fyEnd, fyOf, fyStart, monthEnd, requestApproval, round2, setting, today } from './common.ts';
import { type Account, accounts, openBills, post } from './ledger.ts';
import { accountBalances, bookFilter } from './vouchers.ts';

interface Bal { a: Account; opening: number; debit: number; credit: number; closing: number }
/** Signed closing balances per account; consolidated views drop inter-unit accounts, which net to zero across books. */
async function balances(pool: ServiceContext['pool'] | Client, bookIds: string[] | null, from: string | null, to: string | null): Promise<Bal[]> {
  const raw = await accountBalances(pool, { bookIds, from, to });
  const all = await accounts(pool);
  const consolidated = !bookIds || bookIds.length > 1;
  return all.filter((a) => !(consolidated && a.eliminate_on_consolidation)).map((a) => {
    const b = raw.find((x) => x.account_id === a.id);
    const opening = b?.opening ?? 0, debit = b?.debit ?? 0, credit = b?.credit ?? 0;
    return { a, opening: round2(opening), debit: round2(debit), credit: round2(credit), closing: round2(opening + debit - credit) };
  });
}
const nat = (b: Bal) => (['asset', 'expense'].includes(b.a.type) ? b.closing : -b.closing);
const period = (b: Bal) => (['asset', 'expense'].includes(b.a.type) ? b.debit - b.credit : b.credit - b.debit);

/**
 * Stock not yet posted: when a report runs up to today, the difference between stock valued now and the inventory
 * account is shown as a provisional line, so margins are meaningful between month-end closes. Nothing is posted.
 */
async function provisionalStock(pool: ServiceContext['pool'] | Client, bookIds: string[] | null, to: string) {
  if (to < today()) return 0;
  const v = await valuation(pool).catch(() => null);
  if (!v) return 0;
  const value = v.by_book.filter((b) => !bookIds || bookIds.includes(b.book_id)).reduce((s, b) => s + b.value, 0);
  const inv = await one<{ b: number }>(pool, `SELECT coalesce(sum(l.debit - l.credit), 0)::float AS b FROM voucher_lines l JOIN vouchers v ON v.id = l.voucher_id JOIN accounts a ON a.id = l.account_id
    WHERE a.system_key = 'inventory' AND v.status IN ('posted','reversed') AND ($1::uuid[] IS NULL OR v.book_id = ANY($1))`, [bookIds]);
  return round2(value - inv!.b);
}

export async function profitAndLoss(pool: ServiceContext['pool'] | Client, bookIds: string[] | null, from: string, to: string) {
  const bs = (await balances(pool, bookIds, from, to)).filter((b) => ['income', 'expense'].includes(b.a.type));
  const sec = (s: string) => bs.filter((b) => b.a.section === s).map((b) => ({ code: b.a.code, name: b.a.name, account_id: b.a.id, amount: round2(period(b)) })).filter((x) => x.amount !== 0);
  const total = (rows: { amount: number }[]) => round2(rows.reduce((s, r) => s + r.amount, 0));
  const revenue = sec('revenue'), other = sec('other_income'), cos = sec('cost_of_sales'), opex = sec('operating_expenses'), fin = sec('finance_costs');
  const prov = await provisionalStock(pool, bookIds, to);
  if (prov) cos.push({ code: '—', name: 'Change in inventory — provisional, stock valued today', account_id: '', amount: -prov });
  const gross = round2(total(revenue) - total(cos));
  const net = round2(gross + total(other) - total(opex) - total(fin));
  return { from, to, revenue, revenue_total: total(revenue), cost_of_sales: cos, cost_of_sales_total: total(cos), gross_profit: gross, gross_margin_pct: total(revenue) ? round2((gross / total(revenue)) * 100) : null,
    other_income: other, other_income_total: total(other), operating_expenses: opex, operating_expenses_total: total(opex), finance_costs: fin, finance_costs_total: total(fin), net_profit: net, provisional_stock: prov };
}

export async function balanceSheet(pool: ServiceContext['pool'] | Client, bookIds: string[] | null, asOf: string) {
  const bs = await balances(pool, bookIds, null, asOf);
  const line = (b: Bal) => ({ code: b.a.code, name: b.a.name, account_id: b.a.id, amount: round2(nat(b)) });
  // Customer and supplier balances on the wrong side are advances, shown under the opposite heading.
  const ar = await openBills(pool, 'receivable', null, asOf), ap = await openBills(pool, 'payable', null, asOf);
  // Party balances are company-wide (receipts land in the primary book), so the gross-up applies to consolidated views.
  const consolidated = !bookIds || bookIds.length > 1;
  const custAdv = consolidated ? round2(-ar.parties.filter((p) => p.balance < 0).reduce((s, p) => s + p.balance, 0)) : 0;
  const suppAdv = consolidated ? round2(-ap.parties.filter((p) => p.balance < 0).reduce((s, p) => s + p.balance, 0)) : 0;
  const pick = (sec: string) => bs.filter((b) => b.a.section === sec && b.closing !== 0).map(line).map((l) => {
    const a = bs.find((b) => b.a.id === l.account_id)!.a;
    if (a.control === 'receivable') return { ...l, amount: round2(l.amount + custAdv) };
    if (a.control === 'payable') return { ...l, amount: round2(l.amount + suppAdv) };
    return l;
  });
  const ca = pick('current_assets'), nca = pick('non_current_assets'), cl = pick('current_liabilities'), ncl = pick('non_current_liabilities'), eq = pick('equity');
  if (suppAdv) ca.push({ code: '—', name: 'Advances to suppliers', account_id: '', amount: suppAdv });
  if (custAdv) cl.push({ code: '—', name: 'Advances from customers', account_id: '', amount: custAdv });
  // Profit not yet closed to retained earnings: all income and expense to date.
  const unclosed = round2(bs.filter((b) => ['income', 'expense'].includes(b.a.type)).reduce((s, b) => s - b.closing, 0));
  const prov = await provisionalStock(pool, bookIds, asOf);
  if (prov) ca.push({ code: '—', name: 'Inventory — provisional, valued today (not yet posted)', account_id: '', amount: prov });
  eq.push({ code: '—', name: 'Profit for the period (not yet closed)', account_id: '', amount: round2(unclosed + prov) });
  const t = (r: { amount: number }[]) => round2(r.reduce((s, x) => s + x.amount, 0));
  const assets = round2(t(ca) + t(nca)), liabilities = round2(t(cl) + t(ncl)), equity = t(eq);
  return { as_of: asOf, current_assets: ca, non_current_assets: nca, total_assets: assets, current_liabilities: cl, non_current_liabilities: ncl, equity: eq, total_liabilities: liabilities, total_equity: equity, balanced: Math.abs(assets - liabilities - equity) < 0.05, difference: round2(assets - liabilities - equity) };
}

/** Cash flow (direct method) from movements on cash, bank and gateway clearing, classified by the other side of each voucher. */
async function cashFlow(pool: ServiceContext['pool'], bookIds: string[] | null, from: string, to: string) {
  const rows = await many<{ cls: string; amount: number }>(pool, `
    WITH cash AS (SELECT id FROM accounts WHERE is_bank OR system_key = 'gateway_clearing'),
    moves AS (
      SELECT v.id, sum(l.debit - l.credit) AS amount FROM voucher_lines l JOIN vouchers v ON v.id = l.voucher_id
      WHERE l.account_id IN (SELECT id FROM cash) AND v.status IN ('posted','reversed') AND v.voucher_date BETWEEN $2 AND $3 AND ($1::uuid[] IS NULL OR v.book_id = ANY($1))
      GROUP BY v.id HAVING sum(l.debit - l.credit) <> 0)
    SELECT coalesce((SELECT CASE
        WHEN bool_or(a.control = 'receivable') THEN 'customers'
        WHEN bool_or(a.control = 'payable') THEN 'suppliers'
        WHEN bool_or(a.system_key IN ('salaries_payable','salaries','payroll_statutory','employer_contribution')) THEN 'employees'
        WHEN bool_or(a.group_name IN ('GST payable','GST input credit','Statutory dues','Advance tax and TDS')) THEN 'taxes'
        WHEN bool_or(a.section = 'non_current_assets') THEN 'investing'
        WHEN bool_or(a.section IN ('equity','non_current_liabilities')) THEN 'financing'
        ELSE 'other_operating' END
      FROM voucher_lines l2 JOIN accounts a ON a.id = l2.account_id WHERE l2.voucher_id = m.id AND a.id NOT IN (SELECT id FROM cash)), 'internal') AS cls,
      sum(m.amount)::float AS amount
    FROM moves m GROUP BY 1`, [bookIds, from, to]);
  const get = (k: string) => round2(rows.find((r) => r.cls === k)?.amount ?? 0);
  const operating = round2(get('customers') + get('suppliers') + get('employees') + get('taxes') + get('other_operating'));
  const opening = await one<{ b: number }>(pool, `SELECT coalesce(sum(l.debit - l.credit), 0)::float AS b FROM voucher_lines l JOIN vouchers v ON v.id = l.voucher_id JOIN accounts a ON a.id = l.account_id
    WHERE (a.is_bank OR a.system_key = 'gateway_clearing') AND v.status IN ('posted','reversed') AND v.voucher_date < $2 AND ($1::uuid[] IS NULL OR v.book_id = ANY($1))`, [bookIds, from]);
  const net = round2(operating + get('investing') + get('financing'));
  return { from, to, receipts_from_customers: get('customers'), payments_to_suppliers: get('suppliers'), payments_to_employees: get('employees'), taxes_paid: get('taxes'), other_operating: get('other_operating'), operating, investing: get('investing'), financing: get('financing'), net_change: net, opening_cash: round2(opening!.b), closing_cash: round2(opening!.b + net) };
}

async function ratios(pool: ServiceContext['pool'], bookIds: string[] | null, asOf: string) {
  const from = new Date(`${asOf}T00:00:00Z`); from.setUTCDate(from.getUTCDate() - 364);
  const f = from.toISOString().slice(0, 10);
  const pl = await profitAndLoss(pool, bookIds, f, asOf);
  const bs = await balances(pool, bookIds, null, asOf);
  const key = (k: string) => { const b = bs.find((x) => x.a.system_key === k); return b ? nat(b) : 0; };
  const purchases = (await balances(pool, bookIds, f, asOf)).filter((b) => ['purchases', 'jobwork', 'freight_in'].includes(b.a.system_key ?? '')).reduce((s, b) => s + period(b), 0);
  const ar = Math.max(0, key('receivables')), ap = Math.max(0, key('payables')), inv = key('inventory');
  const sales = pl.revenue_total;
  const ca = bs.filter((b) => b.a.section === 'current_assets').reduce((s, b) => s + nat(b), 0), cl = bs.filter((b) => b.a.section === 'current_liabilities').reduce((s, b) => s + nat(b), 0);
  return { as_of: asOf, trailing_from: f, sales_12m: round2(sales), purchases_12m: round2(purchases), receivables: round2(ar), payables: round2(ap), inventory: round2(inv),
    dso_days: sales > 0 ? Math.round((ar / (sales * 1.05)) * 365) : null, dpo_days: purchases > 0 ? Math.round((ap / (purchases * 1.05)) * 365) : null, inventory_days: purchases > 0 ? Math.round((inv / purchases) * 365) : null,
    working_capital: round2(ca - cl), current_ratio: cl > 0 ? round2(ca / cl) : null, gross_margin_pct: pl.gross_margin_pct, net_profit_12m: pl.net_profit };
}

// ---------- inventory valuation ----------
interface ValRow { lot_id: string; lot_no: string; product_id: string; sku: string; product_name: string; cost_per_kg: number | null; warehouse_id: string | null; place: string; kg: number; rolls: number }
export async function valuation(c: ServiceContext['pool'] | Client) {
  const [rows, whs, bks] = await Promise.all([
    callService<ValRow[]>(S, 'inventory', 'GET', '/valuation'),
    callService<{ id: string; code: string; gst_registration_id: string }[]>(S, 'organisation', 'GET', '/warehouses'),
    books(c),
  ]);
  const method = String(await setting('finance.inventory_valuation_method', 'weighted_average'));
  const primary = bks.find((b) => b.is_primary) ?? bks[0]!;
  // Weighted average cost per SKU across owned stock with a known cost; lots without cost use the SKU average.
  const avg = new Map<string, number>();
  for (const sku of new Set(rows.map((r) => r.sku))) {
    const rs = rows.filter((r) => r.sku === sku && r.cost_per_kg != null);
    const kg = rs.reduce((s, r) => s + r.kg, 0);
    if (kg > 0) avg.set(sku, rs.reduce((s, r) => s + r.kg * Number(r.cost_per_kg), 0) / kg);
  }
  const lines = rows.map((r) => {
    const wh = whs.find((w) => w.id === r.warehouse_id);
    const book = bks.find((b) => b.gst_registration_id === wh?.gst_registration_id) ?? primary;
    const rate = method === 'fifo' ? (r.cost_per_kg ?? avg.get(r.sku) ?? 0) : (avg.get(r.sku) ?? 0);
    return { ...r, warehouse_code: wh?.code ?? (r.place === 'at_mill' ? 'At mill' : '—'), book_id: book.id, book_code: book.code, rate: round2(rate), value: round2(r.kg * rate), no_cost: r.cost_per_kg == null };
  });
  const byBook = bks.map((b) => ({ book_id: b.id, book_code: b.code, kg: round2(lines.filter((l) => l.book_id === b.id).reduce((s, l) => s + l.kg, 0)), value: round2(lines.filter((l) => l.book_id === b.id).reduce((s, l) => s + l.value, 0)) }));
  const bySku = [...new Set(lines.map((l) => l.sku))].map((sku) => { const ls = lines.filter((l) => l.sku === sku); const kg = ls.reduce((s, l) => s + l.kg, 0); const v = ls.reduce((s, l) => s + l.value, 0); return { sku, product_name: ls[0]!.product_name, kg: round2(kg), value: round2(v), rate: kg ? round2(v / kg) : 0, lots: new Set(ls.map((l) => l.lot_id)).size, at_mill_kg: round2(ls.filter((l) => l.place === 'at_mill').reduce((s, l) => s + l.kg, 0)) }; });
  return { method, as_of: today(), total_kg: round2(lines.reduce((s, l) => s + l.kg, 0)), total_value: round2(lines.reduce((s, l) => s + l.value, 0)), by_book: byBook, by_sku: bySku, lines, missing_cost_lots: lines.filter((l) => l.no_cost).length };
}

/** Post closing stock per book for a month: the change against the previous valuation goes through "change in inventory". */
async function postValuation(c: Client, month: string, by: string) {
  const val = await valuation(c);
  const end = monthEnd(month);
  const out = [];
  for (const b of val.by_book) {
    if (await one(c, 'SELECT 1 FROM stock_valuations WHERE month = $1 AND book_id = $2', [month, b.book_id])) continue;
    const inv = await one<{ b: number }>(c, `SELECT coalesce(sum(l.debit - l.credit), 0)::float AS b FROM voucher_lines l JOIN vouchers v ON v.id = l.voucher_id JOIN accounts a ON a.id = l.account_id WHERE a.system_key = 'inventory' AND v.book_id = $1 AND v.status IN ('posted','reversed')`, [b.book_id]);
    const delta = round2(b.value - inv!.b);
    let voucherId: string | null = null;
    if (Math.abs(delta) >= 0.01) {
      const v = await post(c, { type: 'journal', book_id: b.book_id, date: end, narration: `Closing stock ${month.slice(0, 7)} — ${round2(b.kg)} kg valued at ₹${b.value.toLocaleString('en-IN')} (${val.method.replace('_', ' ')})`, by, approved_by: by,
        source: { service: 'finance', type: 'stock_valuation', id: `${month}:${b.book_id}` },
        lines: delta > 0 ? [{ account: 'inventory', debit: delta }, { account: 'inventory_change', credit: delta }] : [{ account: 'inventory_change', debit: -delta }, { account: 'inventory', credit: -delta }] });
      voucherId = v.id;
    }
    await c.query(`INSERT INTO stock_valuations (month, book_id, method, value, kg, detail, voucher_id, created_by_name) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [month, b.book_id, val.method, b.value, b.kg, JSON.stringify(val.by_sku), voucherId, by]);
    out.push({ book: b.book_code, value: b.value, change: delta });
  }
  return out;
}

/** The twelve months of a financial year exist as open periods until someone locks them. */
export async function ensurePeriods(pool: ServiceContext['pool'] | Client, fy: string) {
  for (let i = 0; i < 12; i++) {
    const d = new Date(`${fyStart(fy)}T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() + i);
    await pool.query(`INSERT INTO periods (month, fy) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [d.toISOString().slice(0, 10), fy]);
  }
}

export function reportRoutes(r: Router, { pool }: ServiceContext) {
  const range = (q: Record<string, unknown>) => {
    const fy = fyOf(today());
    return { bk: bookFilter(q.book), from: (q.from as string) || fyStart(fy), to: (q.to as string) || today() };
  };
  r.get('/reports/trial-balance', requirePermission('finance.read'), async (req, res) => {
    const { bk, from, to } = range(req.query);
    const bs = (await balances(pool, bk, from, to)).filter((b) => b.opening || b.debit || b.credit);
    const rows = bs.map((b) => ({ account_id: b.a.id, code: b.a.code, name: b.a.name, type: b.a.type, group: b.a.group_name, opening: b.opening, debit: b.debit, credit: b.credit, closing_debit: b.closing > 0 ? b.closing : 0, closing_credit: b.closing < 0 ? -b.closing : 0 }));
    const t = (k: 'debit' | 'credit' | 'closing_debit' | 'closing_credit') => round2(rows.reduce((s, x) => s + x[k], 0));
    res.json({ from, to, rows, totals: { debit: t('debit'), credit: t('credit'), closing_debit: t('closing_debit'), closing_credit: t('closing_credit') }, balanced: Math.abs(t('closing_debit') - t('closing_credit')) < 0.05 });
  });
  r.get('/reports/profit-and-loss', requirePermission('finance.read'), async (req, res) => { const { bk, from, to } = range(req.query); res.json(await profitAndLoss(pool, bk, from, to)); });
  r.get('/reports/balance-sheet', requirePermission('finance.read'), async (req, res) => { const { bk, to } = range(req.query); res.json(await balanceSheet(pool, bk, to)); });
  r.get('/reports/cash-flow', requirePermission('finance.read'), async (req, res) => { const { bk, from, to } = range(req.query); res.json(await cashFlow(pool, bk, from, to)); });
  r.get('/reports/ratios', requirePermission('finance.read'), async (req, res) => { const { bk, to } = range(req.query); res.json(await ratios(pool, bk, to)); });

  r.get('/dashboard', requirePermission('finance.read'), async (_req, res) => {
    await ensurePeriods(pool, fyOf(today()));
    const bs = await balances(pool, null, null, today());
    const key = (k: string) => { const b = bs.find((x) => x.a.system_key === k); return b ? round2(nat(b)) : 0; };
    const cash = round2(bs.filter((b) => b.a.is_bank || b.a.system_key === 'gateway_clearing').reduce((s, b) => s + nat(b), 0));
    const ar = await openBills(pool, 'receivable', null, today()), ap = await openBills(pool, 'payable', null, today());
    const overdue = (x: typeof ar) => round2(x.bills.filter((b) => b.due_date < today()).reduce((s, b) => s + b.outstanding, 0));
    const [anom, pending, periods, recent, gst] = await Promise.all([
      one<{ n: number; critical: number }>(pool, `SELECT count(*)::int AS n, count(*) FILTER (WHERE severity = 'critical')::int AS critical FROM anomalies WHERE status = 'open'`),
      one<{ n: number }>(pool, `SELECT count(*)::int AS n FROM vouchers WHERE status = 'pending_approval'`),
      many(pool, `SELECT month::text, status FROM periods WHERE month <= current_date ORDER BY month DESC LIMIT 3`),
      many(pool, `SELECT v.id, v.number, v.voucher_type, v.voucher_date::text AS date, v.narration, v.amount::float, v.status, b.code AS book FROM vouchers v JOIN books b ON b.id = v.book_id ORDER BY v.created_at DESC LIMIT 8`),
      one<{ out_tax: number; in_tax: number }>(pool, `SELECT coalesce(sum(cgst + sgst + igst) FILTER (WHERE direction = 'outward' AND doc_type <> 'credit_note'), 0)::float - coalesce(sum(cgst + sgst + igst) FILTER (WHERE direction = 'outward' AND doc_type = 'credit_note'), 0)::float AS out_tax,
        coalesce(sum(cgst + sgst + igst) FILTER (WHERE direction = 'inward' AND itc_eligible), 0)::float AS in_tax FROM tax_lines WHERE doc_date >= date_trunc('month', current_date)`),
    ]);
    const fy = fyOf(today());
    const pl = await profitAndLoss(pool, null, fyStart(fy), today());
    res.json({ cash_and_bank: cash, receivables: key('receivables'), receivables_overdue: overdue(ar), payables: key('payables'), payables_overdue: overdue(ap), gst_payable: round2(key('output_cgst') + key('output_sgst') + key('output_igst') - key('input_cgst') - key('input_sgst') - key('input_igst')),
      gst_this_month: { output: round2(gst!.out_tax), input: round2(gst!.in_tax) }, tds_payable: key('tds_payable'), inventory: key('inventory'),
      ytd: { revenue: pl.revenue_total, gross_profit: pl.gross_profit, net_profit: pl.net_profit }, anomalies: anom, pending_approval: pending!.n, periods, recent });
  });

  // ---------- periods and close ----------
  r.get('/periods', requirePermission('finance.read'), async (req, res) => {
    const fy = (req.query.fy as string) || fyOf(today());
    await ensurePeriods(pool, fy);
    res.json(await many(pool, `SELECT p.*, p.month::text,
      (SELECT count(*)::int FROM vouchers v WHERE v.voucher_date BETWEEN p.month AND (p.month + interval '1 month' - interval '1 day')::date AND v.status IN ('posted','reversed')) AS vouchers,
      (SELECT count(*)::int FROM vouchers v WHERE v.voucher_date BETWEEN p.month AND (p.month + interval '1 month' - interval '1 day')::date AND v.status = 'pending_approval') AS pending,
      (SELECT sum(value)::float FROM stock_valuations s WHERE s.month = p.month) AS stock_value
      FROM periods p WHERE p.fy = $1 ORDER BY p.month`, [fy]));
  });

  /** Lock a month: nothing pending approval, then closing stock is valued and posted (for the latest month only, since stock is valued as it stands now). */
  r.post('/periods/:month/lock', requirePermission('finance.period.manage'), async (req, res) => {
    const b = parse(z.object({ note: optText(300), value_stock: z.boolean().default(true) }), req.body);
    const month = `${String(req.params.month).slice(0, 7)}-01`;
    const out = await tx(pool, async (c) => {
      const p = await one<{ status: string }>(c, 'SELECT status FROM periods WHERE month = $1 FOR UPDATE', [month]);
      if (!p) throw badRequest('Unknown period');
      if (p.status === 'locked') throw conflict('Already locked');
      const prev = await one(c, `SELECT 1 FROM periods WHERE month < $1 AND status = 'open' AND fy = $2`, [month, fyOf(month)]);
      if (prev) throw conflict('Lock earlier months first');
      const pend = await one<{ n: number }>(c, `SELECT count(*)::int AS n FROM vouchers WHERE status = 'pending_approval' AND voucher_date BETWEEN $1 AND $2`, [month, monthEnd(month)]);
      if (pend!.n) throw conflict(`${pend!.n} voucher(s) dated in this month are waiting for approval`);
      // Stock can only be valued as it stands now, so only the month just ended (or the current one) gets a valuation.
      const prevMonth = (() => { const d = new Date(`${today().slice(0, 7)}-01T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() - 1); return d.toISOString().slice(0, 10); })();
      const stock = b.value_stock && month >= prevMonth ? await postValuation(c, month, req.user!.name) : [];
      await c.query(`UPDATE periods SET status = 'locked', locked_by_name = $2, locked_at = now(), note = $3 WHERE month = $1`, [month, req.user!.name, b.note ?? null]);
      await auditReq(c, req, 'period', month, 'locked', { after: { stock }, reason: b.note });
      return { month, stock };
    });
    res.json(out);
  });
  r.post('/periods/:month/reopen', requirePermission('finance.period.manage'), async (req, res) => {
    const { reason } = parse(z.object({ reason: reqText(500) }), req.body);
    const month = `${String(req.params.month).slice(0, 7)}-01`;
    await tx(pool, async (c) => {
      const p = await one<{ status: string }>(c, 'SELECT status FROM periods WHERE month = $1', [month]);
      if (p?.status !== 'locked') throw conflict('Only locked periods can be reopened');
      await requestApproval(c, req, { type: 'period_reopen', refId: month, permission: 'finance.period.approve', title: `Reopen ${month.slice(0, 7)} for posting`, summary: reason, payload: { month: month.slice(0, 7) } });
      await auditReq(c, req, 'period', month, 'reopen_requested', { reason });
    });
    res.json({ ok: true, status: 'pending_approval' });
  });

  r.get('/inventory-valuation', requirePermission('finance.read'), async (_req, res) => {
    const v = await valuation(pool);
    const snapshots = await many(pool, `SELECT s.month::text, s.value::float, s.kg::float, s.method, b.code AS book, v.number AS voucher_no FROM stock_valuations s JOIN books b ON b.id = s.book_id LEFT JOIN vouchers v ON v.id = s.voucher_id ORDER BY s.month DESC LIMIT 24`);
    res.json({ ...v, lines: v.lines.slice(0, 500), snapshots });
  });

  /** Year-end: move every income and expense balance to retained earnings, per book. All months must be locked first. */
  r.post('/year-end/:fy', requirePermission('finance.period.manage'), async (req, res) => {
    const fy = String(req.params.fy);
    const out = await tx(pool, async (c) => {
      const open = await one<{ n: number }>(c, `SELECT count(*)::int AS n FROM periods WHERE fy = $1 AND status = 'open'`, [fy]);
      const months = await one<{ n: number }>(c, `SELECT count(*)::int AS n FROM periods WHERE fy = $1`, [fy]);
      if (!months!.n || open!.n) throw conflict('Lock all twelve months of the year first');
      const done = [];
      for (const b of await books(c)) {
        const bs = (await balances(c, [b.id], null, fyEnd(fy))).filter((x) => ['income', 'expense'].includes(x.a.type) && x.closing !== 0);
        if (!bs.length) continue;
        const net = round2(bs.reduce((s, x) => s + x.closing, 0));
        // Year-end entries are allowed on the last day even though March is locked.
        await c.query(`UPDATE periods SET status = 'open' WHERE month = $1`, [`${fyEnd(fy).slice(0, 7)}-01`]);
        const v = await post(c, { type: 'closing', book_id: b.id, date: fyEnd(fy), narration: `Year-end close FY ${fy}: profit and loss to retained earnings`, by: req.user!.name, approved_by: req.user!.name, source: { service: 'finance', type: 'year_end', id: `${fy}:${b.id}` },
          lines: [...bs.map((x) => ({ account: x.a.id, debit: x.closing < 0 ? -x.closing : 0, credit: x.closing > 0 ? x.closing : 0 })), { account: 'retained_earnings', debit: net > 0 ? net : 0, credit: net < 0 ? -net : 0 }] });
        await c.query(`UPDATE periods SET status = 'locked' WHERE month = $1`, [`${fyEnd(fy).slice(0, 7)}-01`]);
        done.push({ book: b.code, voucher: v.number, profit: round2(-net) });
      }
      await auditReq(c, req, 'fiscal_year', fy, 'closed', { after: done });
      return done;
    });
    res.json(out);
  });

  // ---------- anomalies ----------
  r.get('/anomalies', requirePermission('finance.read'), async (req, res) => {
    res.json(await many(pool, `SELECT *, amount::float FROM anomalies WHERE ($1::text IS NULL OR status = ANY(string_to_array($1, ','))) ORDER BY CASE severity WHEN 'critical' THEN 1 WHEN 'warning' THEN 2 ELSE 3 END, created_at DESC LIMIT 300`, [req.query.status ?? null]));
  });
  r.post('/anomalies/:id/close', requirePermission('finance.anomaly.manage'), async (req, res) => {
    const b = parse(z.object({ status: z.enum(['resolved', 'dismissed']), resolution: reqText(500) }), req.body);
    await tx(pool, async (c) => {
      const r1 = await c.query(`UPDATE anomalies SET status = $2, resolution = $3, resolved_by_name = $4, resolved_at = now() WHERE id = $1 AND status = 'open'`, [req.params.id, b.status, b.resolution, req.user!.name]);
      if (!r1.rowCount) throw conflict('Already closed');
      await auditReq(c, req, 'anomaly', String(req.params.id), b.status, { reason: b.resolution });
    });
    res.json({ ok: true });
  });
}
