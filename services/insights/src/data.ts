import type { Request } from 'express';
import { type ServiceName, badRequest, callAsUser, forbidden, hasPermission } from '@erp/platform';

export const S = 'insights';
export const round2 = (n: number) => Math.round(n * 100) / 100;
export const today = () => new Date().toISOString().slice(0, 10);
export const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

/** Reads another service as the signed-in user, so their permissions and data scope apply. Returns null if not allowed. */
export async function asUser<T>(req: Request, service: ServiceName, path: string): Promise<T | null> {
  try { return await callAsUser<T>(String(req.headers.authorization ?? ''), service, 'GET', path); }
  catch (e) { if ([401, 403, 404].includes((e as { status?: number }).status ?? 0)) return null; throw e; }
}
const rowsOf = (x: unknown): Record<string, unknown>[] => (Array.isArray(x) ? x : ((x as { items?: unknown[]; rows?: unknown[]; lots?: unknown[] })?.items ?? (x as { rows?: unknown[] })?.rows ?? (x as { lots?: unknown[] })?.lots ?? [])) as Record<string, unknown>[];

export interface Dataset { key: string; label: string; module: string; permission: string; service: ServiceName; path: (from: string, to: string) => string; date_field: string | null; description: string }
/** Every dataset is an existing list API of the owning service; nothing reads another service's tables. */
export const DATASETS: Dataset[] = [
  { key: 'sales_register', label: 'Sales register (invoice lines)', module: 'Finance', permission: 'finance.read', service: 'finance', path: (f, t) => `/registers/sales?from=${f}&to=${t}`, date_field: 'doc_date', description: 'GST invoices, credit notes and branch transfers by line: customer, SKU, HSN, kg, taxable value and tax.' },
  { key: 'purchase_register', label: 'Purchase register', module: 'Finance', permission: 'finance.read', service: 'finance', path: (f, t) => `/registers/purchases?from=${f}&to=${t}`, date_field: 'doc_date', description: 'Supplier and mill invoices posted to accounts.' },
  { key: 'receivables', label: 'Customer outstanding and ageing', module: 'Finance', permission: 'finance.read', service: 'finance', path: () => '/ageing/receivables', date_field: null, description: 'Balance per customer by days overdue.' },
  { key: 'payables', label: 'Supplier outstanding and ageing', module: 'Finance', permission: 'finance.read', service: 'finance', path: () => '/ageing/payables', date_field: null, description: 'Balance per supplier and mill by days overdue.' },
  { key: 'stock_lots', label: 'Stock by lot with ageing', module: 'Inventory', permission: 'inventory.read', service: 'inventory', path: () => '/ageing', date_field: 'received_date', description: 'Every lot in stock: SKU, kg, rolls, value at cost, age and recommendation.' },
  { key: 'leads', label: 'Leads', module: 'Sales & CRM', permission: 'crm.read', service: 'crm', path: () => '/leads?pageSize=2000', date_field: 'created_at', description: 'Enquiries by source, stage, owner and value.' },
  { key: 'quotations', label: 'Quotations', module: 'Sales & CRM', permission: 'crm.read', service: 'crm', path: () => '/quotations?status=draft,pending_approval,approved,rejected_internal,sent,accepted,rejected,lost,expired', date_field: 'updated_at', description: 'Quotations with value, margin and outcome.' },
  { key: 'sales_orders', label: 'Sales orders', module: 'B2B commerce', permission: 'commerce.read', service: 'commerce', path: () => '/orders', date_field: 'created_at', description: 'Portal, quotation and phone orders with status and terms.' },
  { key: 'shipments', label: 'Shipments and freight', module: 'Fulfilment', permission: 'fulfilment.read', service: 'fulfilment', path: () => '/shipments', date_field: 'dispatched_at', description: 'Dispatches by transporter, lane, kg, freight and delivery.' },
  { key: 'purchase_orders', label: 'Purchase orders', module: 'Procurement', permission: 'procurement.read', service: 'procurement', path: () => '/purchase-orders?pageSize=2000', date_field: 'order_date', description: 'Purchase orders by supplier, status and value.' },
  { key: 'job_orders', label: 'Job-work orders', module: 'Mill job work', permission: 'jobwork.read', service: 'jobwork', path: () => '/orders?pageSize=2000', date_field: 'created_at', description: 'Mill orders with kg sent, returned, loss and status.' },
  { key: 'tasks', label: 'Tasks', module: 'Workflow', permission: 'workflow.read', service: 'workflow', path: () => '/tasks?status=open,in_progress,done,cancelled', date_field: 'created_at', description: 'Tasks by owner, priority, due date and outcome — for productivity.' },
  { key: 'employees', label: 'Employees', module: 'HR', permission: 'hrms.read', service: 'hrms', path: () => '/employees', date_field: 'date_of_joining', description: 'Headcount by department, location and status.' },
];

export async function fetchDataset(req: Request, key: string, from = '2000-01-01', to = '9999-12-31') {
  const d = DATASETS.find((x) => x.key === key);
  if (!d) throw badRequest('Unknown dataset');
  if (!hasPermission(req.user, d.permission)) throw forbidden(`You need ${d.permission} to use ${d.label}`);
  const raw = await asUser<unknown>(req, d.service, d.path(from, to));
  // Arrays inside rows (warehouse lists) are flattened to text; everything else passes through as is.
  return rowsOf(raw).map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => !k.endsWith('_id') && k !== 'id' && k !== 'total_count').map(([k, v]) => [k, Array.isArray(v) ? v.join(', ') : v && typeof v === 'object' ? JSON.stringify(v) : v])));
}

export type FieldType = 'number' | 'date' | 'text' | 'boolean';
export function inferFields(rows: Record<string, unknown>[]) {
  const keys = new Set<string>();
  for (const r of rows.slice(0, 200)) Object.keys(r).forEach((k) => keys.add(k));
  return [...keys].map((k) => {
    const vals = rows.slice(0, 200).map((r) => r[k]).filter((v) => v !== null && v !== undefined && v !== '');
    const type: FieldType = vals.every((v) => typeof v === 'boolean') && vals.length ? 'boolean'
      : vals.length && vals.every((v) => typeof v === 'number' || (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v) && !/^0\d/.test(v) && k !== 'number' && !k.endsWith('_no'))) ? 'number'
        : vals.length && vals.every((v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)) ? 'date' : 'text';
    return { key: k, label: k.replace(/_/g, ' ').replace(/\b\w/, (c) => c.toUpperCase()), type };
  });
}

export interface Rule { field: string; op: 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'contains' | 'in' | 'empty' | 'not_empty'; value?: string | number | null }
export interface Definition {
  dataset: string; from?: string | null; to?: string | null;
  filters?: { logic: 'and' | 'or'; rules: Rule[]; groups?: { logic: 'and' | 'or'; rules: Rule[] }[] };
  columns?: string[]; group_by?: string[]; date_grain?: 'day' | 'month' | 'quarter' | 'year' | null;
  measures?: { field: string; agg: 'sum' | 'count' | 'avg' | 'min' | 'max' | 'count_distinct' }[];
  sort?: { field: string; dir: 'asc' | 'desc' } | null; limit?: number | null;
}

function test(r: Rule, row: Record<string, unknown>) {
  const v = row[r.field];
  const n = Number(v), m = Number(r.value);
  switch (r.op) {
    case 'eq': return String(v ?? '').toLowerCase() === String(r.value ?? '').toLowerCase();
    case 'neq': return String(v ?? '').toLowerCase() !== String(r.value ?? '').toLowerCase();
    case 'gt': return typeof v === 'string' && /^\d{4}-/.test(v) ? v > String(r.value) : n > m;
    case 'gte': return typeof v === 'string' && /^\d{4}-/.test(v) ? v >= String(r.value) : n >= m;
    case 'lt': return typeof v === 'string' && /^\d{4}-/.test(v) ? v < String(r.value) : n < m;
    case 'lte': return typeof v === 'string' && /^\d{4}-/.test(v) ? v <= String(r.value) : n <= m;
    case 'contains': return String(v ?? '').toLowerCase().includes(String(r.value ?? '').toLowerCase());
    case 'in': return String(r.value ?? '').split(',').map((x) => x.trim().toLowerCase()).includes(String(v ?? '').toLowerCase());
    case 'empty': return v === null || v === undefined || v === '';
    case 'not_empty': return !(v === null || v === undefined || v === '');
  }
}
const grain = (d: unknown, g: Definition['date_grain']) => {
  const s = String(d ?? '').slice(0, 10);
  if (!s) return '';
  if (g === 'month') return s.slice(0, 7);
  if (g === 'year') return s.slice(0, 4);
  if (g === 'quarter') { const m = Number(s.slice(5, 7)); const fyq = m >= 4 && m <= 6 ? 'Q1' : m <= 9 && m >= 7 ? 'Q2' : m >= 10 ? 'Q3' : 'Q4'; const y = m >= 4 ? Number(s.slice(0, 4)) : Number(s.slice(0, 4)) - 1; return `FY${String(y).slice(2)}-${String(y + 1).slice(2)} ${fyq}`; }
  return s;
};

/** Filter (AND/OR with one level of groups), group with aggregates or pick columns, sort and limit. */
export async function runReport(req: Request, def: Definition) {
  const ds = DATASETS.find((x) => x.key === def.dataset);
  if (!ds) throw badRequest('Unknown dataset');
  let rows = await fetchDataset(req, def.dataset, def.from ?? undefined, def.to ?? undefined);
  const fields = inferFields(rows);
  if (ds.date_field && (def.from || def.to)) rows = rows.filter((r) => { const d = String(r[ds.date_field!] ?? '').slice(0, 10); return (!def.from || d >= def.from) && (!def.to || d <= def.to); });
  const f = def.filters;
  if (f && (f.rules.length || f.groups?.length)) {
    const parts = (r: Record<string, unknown>) => [...f.rules.map((x) => test(x, r)), ...(f.groups ?? []).map((g) => (g.logic === 'and' ? g.rules.every((x) => test(x, r)) : g.rules.some((x) => test(x, r))))];
    rows = rows.filter((r) => (f.logic === 'and' ? parts(r).every(Boolean) : parts(r).some(Boolean)));
  }
  const total_rows = rows.length;
  let out: Record<string, unknown>[];
  let columns: { key: string; label: string; type: FieldType }[];
  if (def.group_by?.length || def.measures?.length) {
    const gb = def.group_by ?? [];
    const meas = def.measures?.length ? def.measures : [{ field: '*', agg: 'count' as const }];
    const groups = new Map<string, Record<string, unknown>[]>();
    for (const r of rows) {
      const k = gb.map((g) => (fields.find((x) => x.key === g)?.type === 'date' ? grain(r[g], def.date_grain ?? 'month') : String(r[g] ?? '—'))).join('\u0001');
      groups.set(k, [...(groups.get(k) ?? []), r]);
    }
    out = [...groups.entries()].map(([k, rs]) => {
      const row: Record<string, unknown> = Object.fromEntries(gb.map((g, i) => [g, k.split('\u0001')[i]]));
      for (const m of meas) {
        const vals = rs.map((r) => Number(r[m.field])).filter((n) => Number.isFinite(n));
        const key = m.agg === 'count' ? 'count' : `${m.agg}_${m.field}`;
        row[key] = m.agg === 'count' ? rs.length : m.agg === 'count_distinct' ? new Set(rs.map((r) => r[m.field])).size : !vals.length ? null
          : m.agg === 'sum' ? round2(vals.reduce((a, b) => a + b, 0)) : m.agg === 'avg' ? round2(vals.reduce((a, b) => a + b, 0) / vals.length) : m.agg === 'min' ? Math.min(...vals) : Math.max(...vals);
      }
      return row;
    });
    columns = [...gb.map((g) => ({ key: g, label: fields.find((x) => x.key === g)?.label ?? g, type: (fields.find((x) => x.key === g)?.type === 'date' ? 'text' : fields.find((x) => x.key === g)?.type ?? 'text') as FieldType })),
      ...meas.map((m) => ({ key: m.agg === 'count' ? 'count' : `${m.agg}_${m.field}`, label: m.agg === 'count' ? 'Count' : `${m.agg === 'count_distinct' ? 'Distinct' : m.agg[0]!.toUpperCase() + m.agg.slice(1)} of ${fields.find((x) => x.key === m.field)?.label ?? m.field}`, type: 'number' as FieldType }))];
  } else {
    const cols = def.columns?.length ? def.columns : fields.slice(0, 12).map((x) => x.key);
    out = rows.map((r) => Object.fromEntries(cols.map((c) => [c, r[c] ?? null])));
    columns = cols.map((c) => fields.find((x) => x.key === c) ?? { key: c, label: c, type: 'text' as FieldType });
  }
  if (def.sort?.field) {
    const k = def.sort.field, dir = def.sort.dir === 'asc' ? 1 : -1;
    out.sort((a, b) => { const x = a[k], y = b[k]; if (typeof x === 'number' && typeof y === 'number') return (x - y) * dir; return String(x ?? '').localeCompare(String(y ?? '')) * dir; });
  }
  const limit = Math.min(def.limit ?? 5000, 5000);
  const totals = Object.fromEntries(columns.filter((c) => c.type === 'number' && !/^(avg|min|max)_/.test(c.key)).map((c) => [c.key, round2(out.reduce((s, r) => s + (Number(r[c.key]) || 0), 0))]));
  return { dataset: ds.label, columns, rows: out.slice(0, limit), total_rows, result_rows: out.length, totals, truncated: out.length > limit };
}

export function toCsv(columns: { key: string; label: string }[], rows: Record<string, unknown>[]) {
  const esc = (v: unknown) => { const s = v === null || v === undefined ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return [columns.map((c) => esc(c.label)).join(','), ...rows.map((r) => columns.map((c) => esc(r[c.key])).join(','))].join('\r\n');
}
