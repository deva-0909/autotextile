import Anthropic from '@anthropic-ai/sdk';
import { betaZodTool } from '@anthropic-ai/sdk/helpers/beta/zod';
import type { Request } from 'express';
import { z } from 'zod';
import { config } from '@erp/platform';
import { DATASETS, asUser, round2, runReport, today } from './data.ts';
import { commercialIntel, controlTower, customerIntel, exceptions, financialIntel, stockIntel, substitutes, supplierIntel } from './intelligence.ts';

export const MODEL = 'claude-opus-5-5';
export const aiEnabled = () => !!config.anthropicKey();
let client: Anthropic | null = null;

const SYSTEM = `You are the business assistant inside the ERP of an Indian B2B knitted-fabric trading company (grey fabric bought from knitters, processed at dyeing mills, stocked in warehouses in Surat, Kolkata and Tiruppur, sold to garment makers). You answer questions from managers using the ERP tools.

Rules:
- Use the tools for every number. Never invent figures. If a tool returns null or an error, the user lacks access or the data does not exist; say so plainly.
- Amounts are Indian rupees; write them like ₹12,34,500. The financial year runs April to March. Fabric is measured in kg.
- Be brief and specific: lead with the answer, then the two or three facts that support it, then what to do. Use short bullet lists, not tables wider than four columns.
- When a score or recommendation comes with factors, quote the factors so the user can judge.
- You only read. You cannot create, change, approve or send anything. When an action is sensible, suggest it and add a line exactly like:
  ACTION: <short label> | <path>
  using one of these paths: /finance/receivables, /finance/payables, /finance/anomalies, /finance/statements, /finance/gst, /inventory/stock, /inventory/transfers, /inventory/pricing, /procurement/rfqs, /procurement/purchase-orders, /procurement/suppliers, /crm/quotations, /crm/customers, /commerce/orders, /fulfilment, /jobwork, /insights/intelligence, /insights/exceptions, /insights/reports, /my-work.`;

const clip = (x: unknown) => { const s = JSON.stringify(x ?? null); return s.length > 14000 ? `${s.slice(0, 14000)}… (truncated)` : s; };

const reportInput = z.object({
  dataset: z.enum(DATASETS.map((d) => d.key) as [string, ...string[]]), from: z.string().optional(), to: z.string().optional(),
  filters: z.array(z.object({ field: z.string(), op: z.enum(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'contains', 'in']), value: z.union([z.string(), z.number()]) })).optional(),
  group_by: z.array(z.string()).optional(), date_grain: z.enum(['day', 'month', 'quarter', 'year']).optional(),
  measures: z.array(z.object({ field: z.string(), agg: z.enum(['sum', 'count', 'avg', 'min', 'max', 'count_distinct']) })).optional(),
  sort: z.object({ field: z.string(), dir: z.enum(['asc', 'desc']) }).optional(), limit: z.number().int().min(1).max(200).optional(),
});

function tools(req: Request, used: string[]) {
  const wrap = <T>(name: string, fn: (i: T) => Promise<unknown>) => async (i: T) => { used.push(name); try { return clip(await fn(i)); } catch (e) { return `Error: ${(e as Error).message}`; } };
  const productId = async (sku: string) => ((await asUser<{ items: { id: string; sku: string }[] }>(req, 'masters', `/products?pageSize=50&q=${encodeURIComponent(sku)}`))?.items ?? []).find((p) => p.sku.toLowerCase() === sku.toLowerCase())?.id ?? null;
  return [
    betaZodTool({ name: 'business_overview', description: 'Control-tower KPIs across finance, stock, mills, sales, dispatch, procurement, people and tasks, with a six-month sales trend and the top open exceptions.', inputSchema: z.object({}), run: wrap('business_overview', () => controlTower(req)) }),
    betaZodTool({ name: 'open_exceptions', description: 'All open exceptions and alerts from every module (financial anomalies, three-way match, mill deadlines, stock, leads, dispatch), most severe first.', inputSchema: z.object({ limit: z.number().int().min(1).max(100).optional() }), run: wrap('open_exceptions', async (i: { limit?: number }) => (await exceptions(req)).slice(0, i.limit ?? 40)) }),
    betaZodTool({
      name: 'run_report', description: `Flexible report over a dataset with filters, grouping and totals. Datasets: ${DATASETS.map((d) => `${d.key} (${d.description})`).join('; ')}. Group a date field with date_grain. Example: sales by customer this year = dataset sales_register, from 2026-04-01, group_by ["party_name"], measures [{field:"taxable",agg:"sum"},{field:"kg",agg:"sum"}], sort {field:"sum_taxable",dir:"desc"}.`,
      inputSchema: reportInput,
      run: wrap('run_report', (i: z.infer<typeof reportInput>) => runReport(req, { dataset: i.dataset, from: i.from, to: i.to, filters: i.filters ? { logic: 'and', rules: i.filters } : undefined, group_by: i.group_by, date_grain: i.date_grain, measures: i.measures, sort: i.sort, limit: i.limit ?? 50 })),
    }),
    betaZodTool({ name: 'receivables', description: 'Customer outstanding with ageing buckets (not due, 1–30, 31–60, 61–90, 90+ days).', inputSchema: z.object({}), run: wrap('receivables', () => asUser(req, 'finance', '/ageing/receivables')) }),
    betaZodTool({ name: 'payables', description: 'Supplier and mill outstanding with ageing buckets.', inputSchema: z.object({}), run: wrap('payables', () => asUser(req, 'finance', '/ageing/payables')) }),
    betaZodTool({ name: 'stock_health', description: 'Per-SKU stock health score with factors, days of cover, old stock, reorder suggestion and inter-warehouse transfer suggestions.', inputSchema: z.object({ sku: z.string().optional() }), run: wrap('stock_health', async (i: { sku?: string }) => { const s = await stockIntel(req); return s && i.sku ? { ...s, skus: s.skus.filter((x) => x.sku.toLowerCase() === i.sku!.toLowerCase()) } : s; }) }),
    betaZodTool({ name: 'customer_insights', description: 'Customers with buying cycle, next expected order, churn risk with factors, 12-month revenue and margin, overdue and credit.', inputSchema: z.object({ customer: z.string().optional() }), run: wrap('customer_insights', async (i: { customer?: string }) => { const c = await customerIntel(req); return c && i.customer ? { ...c, customers: c.customers.filter((x) => x.customer.toLowerCase().includes(i.customer!.toLowerCase())) } : c; }) }),
    betaZodTool({ name: 'supplier_intelligence', description: 'Supplier scorecards; with a fabric SKU, ranked supplier recommendation for buying it (price, on-time, rejections) with reasons.', inputSchema: z.object({ sku: z.string().optional() }), run: wrap('supplier_intelligence', async (i: { sku?: string }) => supplierIntel(req, i.sku ? await productId(i.sku) : null)) }),
    betaZodTool({ name: 'fabric_substitutes', description: 'Compatible substitute fabrics for a SKU with tolerance checks and available stock.', inputSchema: z.object({ sku: z.string() }), run: wrap('fabric_substitutes', async (i: { sku: string }) => { const id = await productId(i.sku); return id ? substitutes(req, id) : 'Unknown SKU'; }) }),
    betaZodTool({ name: 'quotation_pipeline', description: 'Win rates by margin band and salesperson, open quotations ranked for follow-up, and the competitor price register.', inputSchema: z.object({}), run: wrap('quotation_pipeline', () => commercialIntel(req)) }),
    betaZodTool({ name: 'working_capital_and_order_margin', description: 'Money tied up in stock, at mills, in unbilled orders and receivables, and margin per recent invoice after material and freight.', inputSchema: z.object({}), run: wrap('working_capital_and_order_margin', () => financialIntel(req)) }),
    betaZodTool({ name: 'purchase_order_match', description: 'A purchase order with its receipts and supplier invoices, to reconcile ordered, received and billed quantities and rates.', inputSchema: z.object({ po_number: z.string() }), run: wrap('purchase_order_match', async (i: { po_number: string }) => {
      const list = await asUser<{ items: { id: string; number: string }[] }>(req, 'procurement', `/purchase-orders?q=${encodeURIComponent(i.po_number)}&pageSize=5`);
      const po = list?.items.find((p) => p.number.toLowerCase() === i.po_number.toLowerCase()) ?? list?.items[0];
      return po ? asUser(req, 'procurement', `/purchase-orders/${po.id}`) : 'Purchase order not found';
    }) }),
  ];
}

export function parseActions(text: string) {
  const actions: { label: string; path: string }[] = [];
  const body = text.split('\n').filter((l) => { const m = l.match(/^\s*ACTION:\s*(.+?)\s*\|\s*(\/\S+)\s*$/); if (m) { actions.push({ label: m[1]!, path: m[2]! }); return false; } return true; }).join('\n').trim();
  return { body, actions };
}

export interface Answer { answer: string; actions: { label: string; path: string }[]; mode: 'ai' | 'built_in'; tools: string[]; model?: string; usage?: { input: number; output: number }; data?: unknown }

/** Ask a question. With an API key, Claude answers using read-only tools that run with the user's own permissions. */
export async function ask(req: Request, question: string, history: { role: 'user' | 'assistant'; content: string }[] = []): Promise<Answer> {
  if (!aiEnabled()) return builtIn(req, question);
  client ??= new Anthropic({ apiKey: config.anthropicKey()!, maxRetries: 2, timeout: 180_000 });
  const used: string[] = [];
  const msg = await client.beta.messages.toolRunner({
    model: MODEL, max_tokens: 16000, max_iterations: 8,
    thinking: { type: 'adaptive' },
    system: `${SYSTEM}\n\nToday is ${today()}. The user is ${req.user!.name}.`,
    tools: tools(req, used),
    messages: [...history.slice(-6).map((h) => ({ role: h.role, content: h.content })), { role: 'user' as const, content: question }],
  });
  if (msg.stop_reason === 'refusal') return { answer: 'I can’t help with that request.', actions: [], mode: 'ai', tools: used, model: MODEL };
  const text = msg.content.filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text').map((b) => b.text).join('\n').trim();
  const { body, actions } = parseActions(text || 'I could not find an answer.');
  return { answer: body, actions, mode: 'ai', tools: [...new Set(used)], model: MODEL, usage: { input: msg.usage.input_tokens, output: msg.usage.output_tokens } };
}

const inr = (n: unknown) => `₹${Math.round(Number(n ?? 0)).toLocaleString('en-IN')}`;
/** Without an API key: match the question to a built-in analysis and answer from it. Honest about what it is. */
async function builtIn(req: Request, q: string): Promise<Answer> {
  const s = q.toLowerCase();
  const note = '\n\n_Built-in answer — set ANTHROPIC_API_KEY to ask free-form questions._';
  if (/(overdue|receivable|outstanding|owe|collect|debtor)/.test(s)) {
    const r = await asUser<{ rows: { party_name: string; balance: number; d61_90: number; d90_plus: number; d1_30: number; d31_60: number }[]; totals: Record<string, number> }>(req, 'finance', '/ageing/receivables');
    if (!r) return { answer: 'You do not have access to receivables.', actions: [], mode: 'built_in', tools: ['receivables'] };
    const top = r.rows.filter((x) => x.balance > 0).slice(0, 5);
    const overdue = Number(r.totals.d1_30 ?? 0) + Number(r.totals.d31_60 ?? 0) + Number(r.totals.d61_90 ?? 0) + Number(r.totals.d90_plus ?? 0);
    return { answer: `Customers owe ${inr(r.totals.balance)}, of which ${inr(overdue)} is overdue (${inr(r.totals.d90_plus)} over 90 days).\n\nLargest balances:\n${top.map((x) => `- ${x.party_name}: ${inr(x.balance)}${x.d90_plus ? `, ${inr(x.d90_plus)} over 90 days` : ''}`).join('\n')}${note}`, actions: [{ label: 'Open receivables', path: '/finance/receivables' }], mode: 'built_in', tools: ['receivables'], data: r.totals };
  }
  if (/(stock|reorder|inventory|ageing|aging|transfer|cover)/.test(s)) {
    const st = await stockIntel(req);
    if (!st) return { answer: 'You do not have access to inventory.', actions: [], mode: 'built_in', tools: ['stock_health'] };
    const weak = st.skus.slice(0, 5);
    return { answer: `Lowest stock health first:\n${weak.map((x) => `- ${x.sku}: health ${x.health}/100 — ${x.factors.slice(1, 3).join(', ')}. ${x.action}.`).join('\n')}${st.transfers.length ? `\n\nSuggested transfers:\n${st.transfers.slice(0, 3).map((t) => `- ${t.kg} kg ${t.sku} ${t.from} → ${t.to}: ${t.why}`).join('\n')}` : ''}${note}`, actions: [{ label: 'Stock intelligence', path: '/insights/intelligence' }], mode: 'built_in', tools: ['stock_health'] };
  }
  if (/(customer|churn|repeat|buying|retention)/.test(s)) {
    const c = await customerIntel(req);
    if (!c) return { answer: 'You do not have access to sales data.', actions: [], mode: 'built_in', tools: ['customer_insights'] };
    return { answer: `Customers most at risk:\n${c.customers.slice(0, 5).map((x) => `- ${x.customer}: risk ${x.churn_risk}/100 — ${x.factors.join('; ')}`).join('\n')}\n\nRepeat orders due now: ${c.customers.filter((x) => x.repeat_due).map((x) => x.customer).join(', ') || 'none'}.${note}`, actions: [{ label: 'Customer intelligence', path: '/insights/intelligence' }], mode: 'built_in', tools: ['customer_insights'] };
  }
  if (/(supplier|vendor|buy from|procure)/.test(s)) {
    const x = await supplierIntel(req, null);
    return { answer: `Supplier scorecards:\n${(x.scorecards as { supplier_name: string; score: number | null; on_time_pct: number | null; rejection_pct: number | null }[]).slice(0, 6).map((r) => `- ${r.supplier_name}: score ${r.score ?? '—'}, ${r.on_time_pct ?? '—'}% on time, ${r.rejection_pct ?? '—'}% rejected`).join('\n')}${note}`, actions: [{ label: 'Supplier scorecards', path: '/procurement/suppliers' }], mode: 'built_in', tools: ['supplier_intelligence'] };
  }
  if (/(exception|alert|anomal|problem|risk|wrong)/.test(s)) {
    const e = await exceptions(req);
    return { answer: `${e.length} open exceptions (${e.filter((x) => x.severity === 'critical').length} critical):\n${e.slice(0, 8).map((x) => `- [${x.source}] ${x.message}`).join('\n')}${note}`, actions: [{ label: 'Exception centre', path: '/insights/exceptions' }], mode: 'built_in', tools: ['open_exceptions'] };
  }
  if (/(quot|win|conversion|negotiat|competitor)/.test(s)) {
    const c = await commercialIntel(req);
    if (!c) return { answer: 'You do not have access to quotations.', actions: [], mode: 'built_in', tools: ['quotation_pipeline'] };
    return { answer: `Win rate ${c.totals.win_rate ?? '—'}% on ${c.totals.decided} decided quotations; ${inr(c.totals.open_value)} open.\n\nFollow up first:\n${c.followups.slice(0, 5).map((f) => `- ${f.number} ${f.customer}: ${inr(f.total)}, ${f.days_left} days left, ~${f.win_probability}% chance`).join('\n')}${note}`, actions: [{ label: 'Quotations', path: '/crm/quotations' }], mode: 'built_in', tools: ['quotation_pipeline'] };
  }
  const t = await controlTower(req);
  const f = t.sections.finance, sl = t.sections.sales, d = t.sections.dispatch;
  return { answer: `Here is where things stand today:\n${f ? `- Revenue this year ${inr(f.revenue_ytd)}, cash and bank ${inr(f.cash_and_bank)}, receivables ${inr(f.receivables)} (${inr(f.receivables_overdue)} overdue).\n` : ''}${sl ? `- ${sl.open_leads} open leads, ${sl.followups_due} follow-ups due, ${inr(sl.quotes_open_value)} in open quotations.\n` : ''}${d ? `- Dispatch: ${d.to_pick} to pick, ${d.ready_to_dispatch} ready, ${d.late} late shipments.\n` : ''}- ${t.exceptions.total} open exceptions (${t.exceptions.critical} critical).${note}`, actions: [{ label: 'Control tower', path: '/insights' }], mode: 'built_in', tools: ['business_overview'] };
}

/** Daily management brief: the day's numbers and what needs attention, written by Claude when available. */
export async function brief(req: Request) {
  const [tower, exc, tasks] = await Promise.all([controlTower(req), exceptions(req), asUser<{ tasks: { title: string; overdue: boolean; priority: string }[] }>(req, 'workflow', '/my-work')]);
  const facts = { date: today(), sections: tower.sections, trend: tower.trend, exceptions: exc.slice(0, 12).map((e) => `${e.severity}: [${e.source}] ${e.message}`), my_overdue_tasks: (tasks?.tasks ?? []).filter((t) => t.overdue).map((t) => t.title).slice(0, 8) };
  if (!aiEnabled()) {
    const f = tower.sections.finance, inv = tower.sections.inventory, d = tower.sections.dispatch, sl = tower.sections.sales;
    const points = [
      f && `Revenue this year ${inr(f.revenue_ytd)}; cash and bank ${inr(f.cash_and_bank)}; ${inr(f.receivables_overdue)} of receivables overdue.`,
      inv && `${round2(Number(inv.physical_kg ?? 0)).toLocaleString('en-IN')} kg in stock; ${round2(Number(inv.over_90_days_kg ?? 0)).toLocaleString('en-IN')} kg older than 90 days (${inr(inv.over_90_days_value)}).`,
      sl && `${sl.followups_due} lead follow-ups are due; ${inr(sl.quotes_open_value)} is in open quotations.`,
      d && `Dispatch: ${d.to_pick} to pick, ${d.awaiting_payment} waiting for payment, ${d.late} shipments late.`,
      exc.length ? `${exc.length} open exceptions, ${exc.filter((e) => e.severity === 'critical').length} critical — top: ${exc[0]!.message}` : 'No open exceptions.',
      facts.my_overdue_tasks.length ? `You have ${facts.my_overdue_tasks.length} overdue task(s): ${facts.my_overdue_tasks.slice(0, 3).join('; ')}.` : null,
    ].filter(Boolean) as string[];
    return { mode: 'built_in' as const, points, generated_at: new Date().toISOString() };
  }
  client ??= new Anthropic({ apiKey: config.anthropicKey()!, maxRetries: 2, timeout: 120_000 });
  const msg = await client.messages.create({
    model: MODEL, max_tokens: 4000, thinking: { type: 'adaptive' },
    system: `${SYSTEM}\n\nWrite this manager's daily brief from the JSON facts: at most six bullet points, most important first, each one sentence with the number that matters and, where useful, what to do today. Output only the bullets, each starting with "- ".`,
    messages: [{ role: 'user', content: JSON.stringify(facts) }],
  });
  const text = msg.content.filter((b): b is Anthropic.TextBlock => b.type === 'text').map((b) => b.text).join('\n');
  return { mode: 'ai' as const, points: text.split('\n').map((l) => l.replace(/^\s*[-•]\s*/, '').trim()).filter(Boolean), generated_at: new Date().toISOString() };
}

