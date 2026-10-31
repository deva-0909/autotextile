import type { Request } from 'express';
import { asUser, daysAgo, round2, today } from './data.ts';

/**
 * Explainable business intelligence over the services' own APIs, read as the signed-in user. Every score carries
 * the factors that produced it; nothing here changes data — suggested actions link to the screen where a person acts.
 */
type Row = Record<string, any>;
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const days = (a: string, b: string) => Math.round((new Date(`${b.slice(0, 10)}T00:00:00Z`).getTime() - new Date(`${a.slice(0, 10)}T00:00:00Z`).getTime()) / 86_400_000);
const clamp = (n: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, n));

// ---------------------------------------------------------------- control tower
export async function controlTower(req: Request) {
  const [fin, inv, ageing, job, crm, ful, proc, hr, tasks, orders, sales, exc] = await Promise.all([
    asUser<Row>(req, 'finance', '/dashboard'), asUser<Row>(req, 'inventory', '/dashboard'), asUser<Row>(req, 'inventory', '/ageing'), asUser<Row>(req, 'jobwork', '/dashboard'),
    asUser<Row>(req, 'crm', '/dashboard'), asUser<Row>(req, 'fulfilment', '/dashboard'), asUser<Row>(req, 'procurement', '/dashboard'), asUser<Row>(req, 'hrms', '/dashboard'),
    asUser<Row[]>(req, 'workflow', '/tasks'), asUser<Row[]>(req, 'commerce', '/orders?status=pending_payment,booked,in_fulfilment,awaiting_allocation'),
    asUser<Row[]>(req, 'finance', `/registers/sales?from=${daysAgo(365)}&to=${today()}`), exceptions(req),
  ]);
  const monthly = new Map<string, { revenue: number; kg: number }>();
  for (const s of sales ?? []) { const m = String(s.doc_date).slice(0, 7); const x = monthly.get(m) ?? { revenue: 0, kg: 0 }; x.revenue += Number(s.taxable); x.kg += Number(s.kg ?? 0); monthly.set(m, x); }
  const months: string[] = [];
  for (let i = 5; i >= 0; i--) { const d = new Date(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - i); months.push(d.toISOString().slice(0, 7)); }
  const old = (ageing?.lots ?? []).filter((l: Row) => Number(l.age_days) > 90);
  return {
    sections: {
      finance: fin && { cash_and_bank: fin.cash_and_bank, receivables: fin.receivables, receivables_overdue: fin.receivables_overdue, payables: fin.payables, gst_payable: fin.gst_payable, revenue_ytd: fin.ytd?.revenue, gross_profit_ytd: fin.ytd?.gross_profit, net_profit_ytd: fin.ytd?.net_profit, alerts: fin.anomalies?.n },
      inventory: inv && { physical_kg: inv.physical_kg, value: ageing ? round2(sum((ageing.lots ?? []).map((l: Row) => Number(l.value ?? 0)))) : null, over_90_days_kg: round2(sum(old.map((l: Row) => Number(l.kg)))), over_90_days_value: round2(sum(old.map((l: Row) => Number(l.value ?? 0)))), qc_hold_kg: inv.qc_hold_kg, reserved_kg: inv.reserved_kg },
      mills: job && { at_mill_kg: job.kg_at_mill ?? job.at_mill_kg, open_orders: job.open_orders, overdue: job.overdue ?? job.operational_overdue, statutory_due: job.statutory_due },
      sales: crm && { open_leads: crm.open_leads, followups_due: crm.followups_due, quotes_open_value: crm.quotes_open_value, won_this_month: crm.won_this_month, conversion_pct: crm.conversion_pct },
      dispatch: ful && { to_pick: ful.to_pick, to_invoice: ful.to_invoice, awaiting_payment: ful.awaiting_payment, ready_to_dispatch: ful.ready_to_dispatch, in_transit: ful.in_transit, late: ful.late, open_orders_value: orders ? round2(sum(orders.map((o) => Number(o.total_estimate)))) : null },
      procurement: proc,
      people: hr && { headcount: hr.headcount, present_today: hr.present_today, on_leave_today: hr.on_leave_today, leave_pending: hr.leave_pending },
      work: tasks && { open: tasks.length, overdue: tasks.filter((t) => t.overdue).length, escalated: tasks.filter((t) => t.escalated_at).length },
    },
    trend: sales ? months.map((m) => ({ month: m, revenue: round2(monthly.get(m)?.revenue ?? 0), kg: round2(monthly.get(m)?.kg ?? 0) })) : null,
    exceptions: { total: exc.length, critical: exc.filter((e) => e.severity === 'critical').length, top: exc.slice(0, 8) },
  };
}

// ---------------------------------------------------------------- exceptions from every service
export interface Exception { source: string; kind: string; severity: string; message: string; ref: string | null; link: string | null; at: string }
export async function exceptions(req: Request): Promise<Exception[]> {
  const sources: [string, Parameters<typeof asUser>[1], string, string][] = [
    ['Finance', 'finance', '/anomalies?status=open', '/finance/anomalies'], ['Procurement', 'procurement', '/exceptions', '/procurement/match'], ['Mill job work', 'jobwork', '/exceptions', '/jobwork'],
    ['Inventory', 'inventory', '/exceptions', '/inventory'], ['Sales & CRM', 'crm', '/exceptions', '/crm/leads'], ['Fulfilment', 'fulfilment', '/exceptions', '/fulfilment'],
  ];
  const lists = await Promise.all(sources.map(async ([label, svc, path, link]) => ((await asUser<Row[]>(req, svc, path).catch(() => null)) ?? []).map((e): Exception => ({
    source: label, kind: String(e.kind), severity: String(e.severity ?? 'warning'), message: String(e.message), ref: e.ref_label ?? null,
    link: e.link ?? (e.ref_type === 'voucher' ? `/finance/vouchers/${e.ref_id}` : link), at: String(e.detected_at ?? e.created_at),
  }))));
  const rank = { critical: 0, warning: 1, info: 2 } as Record<string, number>;
  return lists.flat().sort((a, b) => (rank[a.severity] ?? 3) - (rank[b.severity] ?? 3) || b.at.localeCompare(a.at));
}

// ---------------------------------------------------------------- suppliers
export async function supplierIntel(req: Request, productId: string | null) {
  const [cards, rec] = await Promise.all([asUser<Row[]>(req, 'procurement', '/suppliers/scorecards'), productId ? asUser<Row[]>(req, 'procurement', `/suppliers/recommend?productId=${productId}`) : Promise.resolve(null)]);
  return { scorecards: cards ?? [], recommendation: rec, note: 'Recommendation = 50% price (against the best recent rate) + 50% performance (on-time delivery, rejections, invoice accuracy). A purchase order still needs the normal approval.' };
}

// ---------------------------------------------------------------- fabric substitution
export async function substitutes(req: Request, productId: string) {
  const [prods, lots] = await Promise.all([asUser<Row>(req, 'masters', '/products?pageSize=500'), asUser<Row>(req, 'inventory', '/lots?f_in_stock=true&pageSize=1000')]);
  const items: Row[] = prods?.items ?? [];
  const base = items.find((p) => p.id === productId);
  if (!base) return null;
  const a = base.attributes ?? {};
  const avail = new Map<string, number>();
  for (const l of lots?.items ?? []) if (l.qc_status === 'passed' || l.available_kg > 0) avail.set(l.product_id, (avail.get(l.product_id) ?? 0) + Number(l.available_kg ?? 0));
  const tolGsm = Number(a.weight_tolerance_pct ?? 5), tolWidth = Number(a.width_tolerance_pct ?? 3);
  const words = (s: unknown) => new Set(String(s ?? '').toLowerCase().match(/[a-z]+/g) ?? []);
  const out = items.filter((p) => p.id !== productId && p.status === 'active').map((p) => {
    const b = p.attributes ?? {};
    const reasons: string[] = [], fails: string[] = [];
    let score = 0;
    if (p.category_id === base.category_id) { score += 25; reasons.push('same fabric category'); }
    if (b.knit_type && b.knit_type === a.knit_type) { score += 15; reasons.push(`${b.knit_type}`); }
    const gsmDiff = a.gsm && b.gsm ? (Math.abs(Number(b.gsm) - Number(a.gsm)) / Number(a.gsm)) * 100 : null;
    if (gsmDiff !== null) { score += clamp(20 - gsmDiff * 2, 0, 20); (gsmDiff <= tolGsm ? reasons : fails).push(`GSM ${b.gsm} vs ${a.gsm} (${round2(gsmDiff)}%${gsmDiff <= tolGsm ? ' within' : ' outside'} ±${tolGsm}%)`); }
    const wDiff = a.width && b.width ? (Math.abs(Number(b.width) - Number(a.width)) / Number(a.width)) * 100 : null;
    if (wDiff !== null) { score += clamp(10 - wDiff, 0, 10); (wDiff <= tolWidth ? reasons : fails).push(`width ${b.width}" vs ${a.width}"`); }
    const ca = words(a.composition), cb = words(b.composition);
    const overlap = ca.size ? [...ca].filter((w) => cb.has(w)).length / ca.size : 0;
    score += overlap * 15;
    if (overlap >= 0.99) reasons.push('same composition'); else if (b.composition) fails.push(`composition ${b.composition}`);
    if (b.colour && a.colour && String(b.colour).toLowerCase() === String(a.colour).toLowerCase()) { score += 10; reasons.push(`same colour (${b.colour})`); } else if (b.colour) fails.push(`colour ${b.colour} vs ${a.colour}`);
    const finA = new Set([a.finish].flat().filter(Boolean)), finB = [b.finish].flat().filter(Boolean);
    if (finB.some((x: string) => finA.has(x))) { score += 5; reasons.push('shared finish'); }
    return { product_id: p.id, sku: p.sku, name: p.name, score: Math.round(score), available_kg: round2(avail.get(p.id) ?? 0), within_tolerance: fails.length === 0, matches: reasons, differences: fails, needs_customer_acceptance: fails.length > 0 || !reasons.includes('same composition') };
  }).filter((x) => x.score >= 40).sort((x, y) => Number(y.within_tolerance) - Number(x.within_tolerance) || y.score - x.score);
  return { base: { sku: base.sku, name: base.name, attributes: a }, substitutes: out.slice(0, 8), rule: `GSM within ±${tolGsm}% and width within ±${tolWidth}% are treated as compatible; any difference in colour or composition needs the customer’s written acceptance before dispatch.` };
}

// ---------------------------------------------------------------- stock
export async function stockIntel(req: Request) {
  const [val, ageing, sales, whs] = await Promise.all([asUser<Row>(req, 'finance', '/inventory-valuation'), asUser<Row>(req, 'inventory', '/ageing'), asUser<Row[]>(req, 'finance', `/registers/sales?from=${daysAgo(90)}&to=${today()}`), asUser<Row[]>(req, 'organisation', '/warehouses')]);
  if (!ageing) return null;
  const lots: Row[] = ageing.lots ?? [];
  const wh = new Map((whs ?? []).map((w) => [w.id, w]));
  const bySku = new Map<string, { sku: string; name: string; kg: number; value: number; old_kg: number; by_wh: Map<string, number>; sold_kg: number; sold_by_state: Map<string, number> }>();
  for (const l of lots) {
    const x = bySku.get(l.sku) ?? { sku: l.sku, name: l.product_name, kg: 0, value: 0, old_kg: 0, by_wh: new Map(), sold_kg: 0, sold_by_state: new Map() };
    x.kg += Number(l.kg); x.value += Number(l.value ?? 0); if (Number(l.age_days) > 90) x.old_kg += Number(l.kg);
    for (const w of l.warehouses ?? []) x.by_wh.set(w, (x.by_wh.get(w) ?? 0) + Number(l.kg) / (l.warehouses.length || 1));
    bySku.set(l.sku, x);
  }
  for (const s of sales ?? []) {
    if (!s.sku) continue;
    const x = bySku.get(s.sku) ?? { sku: s.sku, name: s.sku, kg: 0, value: 0, old_kg: 0, by_wh: new Map(), sold_kg: 0, sold_by_state: new Map() };
    x.sold_kg += Number(s.kg ?? 0);
    const st = String(s.gstin ?? '').slice(0, 2);
    x.sold_by_state.set(st, (x.sold_by_state.get(st) ?? 0) + Number(s.kg ?? 0));
    bySku.set(s.sku, x);
  }
  const leadTime = 15, safety = 10;
  const skus = [...bySku.values()].map((x) => {
    const daily = x.sold_kg / 90;
    const cover = daily > 0 ? Math.round(x.kg / daily) : null;
    const oldShare = x.kg ? x.old_kg / x.kg : 0;
    // Health: coverage between 15 and 90 days is ideal; too little risks stock-outs, too much ties up cash; old stock lowers it.
    const coverScore = cover === null ? (x.kg > 0 ? 40 : 100) : cover < leadTime ? clamp((cover / leadTime) * 70) : cover <= 90 ? 100 : clamp(100 - (cover - 90));
    const health = Math.round(clamp(coverScore * 0.7 + (1 - oldShare) * 30));
    const reorder = daily > 0 ? Math.max(0, Math.round(daily * (leadTime + safety) - x.kg)) : 0;
    const factors = [`${round2(x.kg)} kg on hand`, daily > 0 ? `selling ${round2(daily * 30)} kg a month (last 90 days)` : 'no sales in 90 days', cover !== null ? `${cover} days of cover` : 'cover not measurable', `${Math.round(oldShare * 100)}% older than 90 days`];
    const action = reorder > 0 ? `Reorder about ${reorder} kg (lead time ${leadTime} + safety ${safety} days)` : oldShare > 0.4 ? 'Push sales or offer a discount on old lots; avoid reordering' : cover !== null && cover > 120 ? 'Overstocked: hold purchases' : 'No action';
    return { sku: x.sku, name: x.name, kg: round2(x.kg), value: round2(x.value), sold_90d_kg: round2(x.sold_kg), cover_days: cover, old_kg: round2(x.old_kg), health, factors, action, reorder_kg: reorder,
      by_warehouse: [...x.by_wh.entries()].map(([id, kg]) => ({ warehouse: wh.get(id)?.code ?? id, state: wh.get(id)?.state_code, kg: round2(kg) })), demand_by_state: Object.fromEntries(x.sold_by_state) };
  }).sort((a, b) => a.health - b.health);
  // Transfers: stock in a warehouse whose state sells little, while another state sells the same SKU and has little stock.
  const transfers = skus.flatMap((s) => {
    const out: Row[] = [];
    for (const from of s.by_warehouse) for (const to of s.by_warehouse.concat((whs ?? []).filter((w) => !s.by_warehouse.some((x) => x.warehouse === w.code)).map((w) => ({ warehouse: w.code, state: w.state_code, kg: 0 })))) {
      if (from.warehouse === to.warehouse) continue;
      const dFrom = Number(s.demand_by_state[from.state] ?? 0), dTo = Number(s.demand_by_state[to.state] ?? 0);
      if (dTo > 0 && to.kg < dTo / 3 && from.kg > dFrom + 100) out.push({ sku: s.sku, from: from.warehouse, to: to.warehouse, kg: Math.round(Math.min(from.kg - dFrom, dTo - to.kg) / 10) * 10, why: `${to.warehouse} sold ${round2(dTo)} kg in 90 days but holds ${round2(to.kg)} kg; ${from.warehouse} holds ${round2(from.kg)} kg against ${round2(dFrom)} kg sold` });
    }
    return out.filter((t) => t.kg > 0);
  });
  return { skus, transfers, valuation_method: val?.method ?? null, assumptions: `Lead time ${leadTime} days, safety stock ${safety} days, demand from the last 90 days of invoices. Open purchase orders are not netted off the reorder quantity.` };
}

// ---------------------------------------------------------------- customers
export async function customerIntel(req: Request) {
  const [sales, ar, credit, val] = await Promise.all([asUser<Row[]>(req, 'finance', `/registers/sales?from=${daysAgo(540)}&to=${today()}`), asUser<Row>(req, 'finance', '/ageing/receivables'), asUser<{ accounts: Row[] }>(req, 'crm', '/credit').then((x) => x?.accounts ?? null), asUser<Row>(req, 'finance', '/inventory-valuation')]);
  if (!sales) return null;
  const cost = new Map<string, number>((val?.by_sku ?? []).map((s: Row) => [s.sku, Number(s.rate)]));
  const byCust = new Map<string, Row[]>();
  for (const s of sales.filter((x) => x.party_id && x.doc_type !== 'transfer')) byCust.set(s.party_id, [...(byCust.get(s.party_id) ?? []), s]);
  const t = today();
  const rows = [...byCust.entries()].map(([id, ls]) => {
    const inv = ls.filter((l) => l.doc_type === 'invoice');
    const dates = [...new Set(inv.map((l) => String(l.doc_date)))].sort();
    const gaps = dates.slice(1).map((d, i) => days(dates[i]!, d));
    const cycle = gaps.length ? Math.round(sum(gaps) / gaps.length) : null;
    const last = dates.at(-1) ?? null;
    const since = last ? days(last, t) : null;
    const rev = (from: number, to: number) => sum(ls.filter((l) => { const d = days(String(l.doc_date), t); return d >= from && d < to; }).map((l) => Number(l.taxable)));
    const r90 = rev(0, 90), p90 = rev(90, 180), r12 = rev(0, 365);
    const returns = -sum(ls.filter((l) => l.doc_type === 'credit_note').map((l) => Number(l.taxable)));
    const costKnown = inv.filter((l) => l.sku && cost.has(l.sku));
    const margin = costKnown.length ? round2(sum(costKnown.map((l) => Number(l.taxable) - Number(l.kg ?? 0) * cost.get(l.sku)!))) : null;
    const age = (ar?.rows ?? []).find((x: Row) => x.party_id === id);
    const overdue = age ? round2(Number(age.d1_30) + Number(age.d31_60) + Number(age.d61_90) + Number(age.d90_plus)) : 0;
    const cr = (credit ?? []).find((c) => c.customer_id === id);
    const factors: string[] = [];
    let risk = 0;
    if (cycle && since !== null && since > cycle * 1.5) { risk += clamp(((since - cycle) / cycle) * 30, 0, 40); factors.push(`no order for ${since} days against a usual ${cycle}-day cycle`); }
    if (p90 > 0 && r90 < p90 * 0.6) { risk += 25; factors.push(`sales down ${Math.round((1 - r90 / p90) * 100)}% on the previous 90 days`); }
    if (overdue > 0) { risk += clamp((overdue / Math.max(r12, 1)) * 100, 5, 20); factors.push(`₹${overdue.toLocaleString('en-IN')} overdue`); }
    if (r12 > 0 && returns / r12 > 0.05) { risk += 15; factors.push(`returns ${Math.round((returns / r12) * 100)}% of sales`); }
    if (!factors.length) factors.push('buying on its usual pattern');
    const next = last && cycle ? new Date(new Date(`${last}T00:00:00Z`).getTime() + cycle * 86_400_000).toISOString().slice(0, 10) : null;
    return { customer_id: id, customer: ls[0]!.party_name, invoices: dates.length, revenue_12m: round2(r12), revenue_90d: round2(r90), margin_12m: margin, margin_pct: margin !== null && r12 ? round2((margin / r12) * 100) : null, returns: round2(returns), last_order: last, cycle_days: cycle, next_expected: next,
      repeat_due: !!(next && next <= t), churn_risk: Math.round(clamp(risk)), factors, overdue, credit_limit: cr?.credit_limit ?? null, exposure: cr ? Number(cr.exposure ?? cr.outstanding ?? 0) : null, score: Math.round(clamp(100 - risk + (margin && r12 ? (margin / r12) * 100 : 0))) };
  }).sort((a, b) => b.churn_risk - a.churn_risk);
  return { customers: rows, method: 'Cycle = average days between invoices; risk adds points for a late repeat order, falling sales, overdue money and returns. Margin uses the current average cost per kg of each SKU.' };
}

// ---------------------------------------------------------------- commercial
export async function commercialIntel(req: Request) {
  const quotes = await asUser<Row[]>(req, 'crm', '/quotations?status=draft,pending_approval,approved,sent,accepted,rejected,lost,expired');
  if (!quotes) return null;
  const decided = quotes.filter((q) => ['accepted', 'rejected', 'lost', 'expired'].includes(q.status));
  const win = (qs: Row[]) => (qs.length ? round2((qs.filter((q) => q.status === 'accepted').length / qs.length) * 100) : null);
  const bands = [[-100, 8], [8, 12], [12, 16], [16, 100]].map(([lo, hi]) => { const qs = decided.filter((q) => q.margin_pct != null && Number(q.margin_pct) >= lo! && Number(q.margin_pct) < hi!); return { band: lo === -100 ? `under ${hi}%` : hi === 100 ? `${lo}% and above` : `${lo}–${hi}%`, quotes: qs.length, win_rate: win(qs), lo, hi }; });
  const owners = [...new Set(quotes.map((q) => q.owner_name).filter(Boolean))].map((o) => { const qs = decided.filter((q) => q.owner_name === o); return { owner: o, decided: qs.length, win_rate: win(qs), open_value: round2(sum(quotes.filter((q) => q.owner_name === o && q.status === 'sent').map((q) => Number(q.total)))) }; });
  const overall = win(decided) ?? 30;
  const prob = (m: number | null) => { const b = bands.find((x) => m !== null && m >= x.lo! && m < x.hi!); return b?.win_rate ?? overall; };
  const open = quotes.filter((q) => q.status === 'sent').map((q) => {
    const p = prob(q.margin_pct == null ? null : Number(q.margin_pct));
    const daysLeft = days(t(), String(q.valid_until));
    return { id: q.id, number: q.number, customer: q.customer_name ?? q.prospect_name, owner: q.owner_name, total: Number(q.total), margin_pct: q.margin_pct, win_probability: p, valid_until: q.valid_until, days_left: daysLeft, priority: Math.round((Number(q.total) / 1000) * ((p ?? 30) / 100) * (daysLeft <= 3 ? 2 : 1)) };
  }).sort((a, b) => b.priority - a.priority);
  const competitors = quotes.filter((q) => q.competitor_name).map((q) => ({ quotation: q.number, competitor: q.competitor_name, competitor_price: q.competitor_price, our_status: q.status, customer: q.customer_name ?? q.prospect_name, at: q.updated_at }));
  return { totals: { quotes: quotes.length, decided: decided.length, win_rate: win(decided), open_value: round2(sum(open.map((o) => o.total))) }, margin_bands: bands.map(({ lo: _l, hi: _h, ...b }) => b), owners, followups: open, competitors };
}
const t = today;

/** Negotiation simulator: what a price does to margin and to the chance of winning, from past outcomes. */
export async function simulate(req: Request, sku: string, listPrice: number, offerPrice: number) {
  const [com, val] = await Promise.all([commercialIntel(req), asUser<Row>(req, 'finance', '/inventory-valuation')]);
  const cost = Number((val?.by_sku ?? []).find((s: Row) => s.sku === sku)?.rate ?? 0) || null;
  const margin = cost ? round2(((offerPrice - cost) / offerPrice) * 100) : null;
  const band = com?.margin_bands.find((b) => { const r = b.band.match(/(\d+)/g)?.map(Number) ?? []; return margin !== null && (b.band.startsWith('under') ? margin < r[0]! : b.band.includes('above') ? margin >= r[0]! : margin >= r[0]! && margin < r[1]!); });
  return { sku, list_price: listPrice, offer_price: offerPrice, discount_pct: round2(((listPrice - offerPrice) / listPrice) * 100), cost_per_kg: cost, margin_pct: margin, expected_win_rate: band?.win_rate ?? com?.totals.win_rate ?? null, based_on: band ? `${band.quotes} decided quotations with margin ${band.band}` : 'overall win rate', below_minimum_margin: margin !== null && margin < 8 };
}

// ---------------------------------------------------------------- financial
export async function financialIntel(req: Request) {
  const [val, bs, orders, sales, ships] = await Promise.all([asUser<Row>(req, 'finance', '/inventory-valuation'), asUser<Row>(req, 'finance', '/reports/balance-sheet'), asUser<Row[]>(req, 'commerce', '/orders?status=booked,in_fulfilment,partially_dispatched,awaiting_allocation,pending_payment'), asUser<Row[]>(req, 'finance', `/registers/sales?from=${daysAgo(180)}&to=${today()}`), asUser<Row[]>(req, 'fulfilment', '/shipments')]);
  if (!val && !bs) return null;
  const place = (p: string) => round2(sum((val?.lines ?? []).filter((l: Row) => l.place === p).map((l: Row) => Number(l.value))));
  const line = (rows: Row[] | undefined, name: string) => Number((rows ?? []).find((r) => r.name === name)?.amount ?? 0);
  const ar = Number((bs?.current_assets ?? []).find((r: Row) => r.name === 'Trade receivables')?.amount ?? 0);
  const blocked = [
    { item: 'Stock in warehouses', amount: place('warehouse') }, { item: 'Stock at mills (job work)', amount: place('at_mill') }, { item: 'Stock in transit', amount: place('in_transit') },
    { item: 'Orders booked, not yet invoiced', amount: round2(sum((orders ?? []).map((o) => Number(o.taxable ?? o.total_estimate ?? 0)))) },
    { item: 'Receivables', amount: ar }, { item: 'Advances from customers (reduce the need)', amount: -line(bs?.current_liabilities, 'Advances from customers') },
    { item: 'Payables (supplier credit)', amount: -Number((bs?.current_liabilities ?? []).find((r: Row) => r.name === 'Trade payables')?.amount ?? 0) },
  ];
  const cost = new Map<string, number>((val?.by_sku ?? []).map((s: Row) => [s.sku, Number(s.rate)]));
  const byInv = new Map<string, Row[]>();
  for (const s of (sales ?? []).filter((x) => x.doc_type === 'invoice')) byInv.set(s.doc_no, [...(byInv.get(s.doc_no) ?? []), s]);
  const freight = new Map<string, number>((ships ?? []).filter((s) => s.invoice_no).map((s) => [s.invoice_no, Number(s.freight_amount ?? 0)]));
  const returns = new Map<string, number>();
  for (const s of (sales ?? []).filter((x) => x.doc_type === 'credit_note')) returns.set(s.party_id, (returns.get(s.party_id) ?? 0) - Number(s.taxable));
  const orderProfit = [...byInv.entries()].map(([doc, ls]) => {
    const revenue = sum(ls.map((l) => Number(l.taxable)));
    const material = sum(ls.map((l) => Number(l.kg ?? 0) * (cost.get(l.sku) ?? 0)));
    const fr = freight.get(doc) ?? 0;
    const margin = revenue - material - fr;
    return { invoice: doc, date: ls[0]!.doc_date, customer: ls[0]!.party_name, kg: round2(sum(ls.map((l) => Number(l.kg ?? 0)))), revenue: round2(revenue), material_cost: round2(material), freight: round2(fr), margin: round2(margin), margin_pct: revenue ? round2((margin / revenue) * 100) : null, cost_known: ls.every((l) => cost.has(l.sku)) };
  }).sort((a, b) => (a.margin_pct ?? 0) - (b.margin_pct ?? 0));
  return { blocked, net_working_capital: round2(sum(blocked.map((b) => b.amount))), order_profitability: orderProfit, method: 'Material cost = kg × current average landed cost of the SKU (purchase, processing and freight in), freight from the shipment. Commission and discounts already sit in the invoice price; returns are shown per customer in customer intelligence.' };
}
