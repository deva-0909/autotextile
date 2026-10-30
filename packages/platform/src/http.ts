import type { Request } from 'express';
import { z, type ZodType } from 'zod';
import { badRequest, fromZod } from './errors.ts';

export function parse<T>(schema: ZodType<T>, data: unknown): T {
  const r = schema.safeParse(data);
  if (!r.success) throw fromZod(r.error);
  return r.data;
}

/** Optional text that turns '' into null. */
export const optText = (max = 500) =>
  z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? null : typeof v === 'string' ? v.trim() : v), z.string().max(max).nullable().optional());
export const reqText = (max = 200) => z.string().trim().min(1, 'Required').max(max);

export interface ListQuery {
  q: string;
  page: number;
  pageSize: number;
  sort: string;
  dir: 'asc' | 'desc';
  filters: Record<string, string>;
}

/** Parses ?q=&page=&pageSize=&sort=&dir= and f_<field>= filters. `sortable` whitelists sort columns. */
export function listQuery(req: Request, sortable: string[], defaultSort: string): ListQuery {
  const q = req.query as Record<string, string | undefined>;
  const sort = q.sort && sortable.includes(q.sort) ? q.sort : defaultSort;
  if (q.sort && !sortable.includes(q.sort)) throw badRequest(`Cannot sort by ${q.sort}`);
  const filters: Record<string, string> = {};
  for (const [k, v] of Object.entries(q)) if (k.startsWith('f_') && v) filters[k.slice(2)] = v;
  return {
    q: (q.q ?? '').trim(),
    page: Math.max(1, Number(q.page) || 1),
    pageSize: Math.min(200, Math.max(1, Number(q.pageSize) || 25)),
    sort,
    dir: q.dir === 'desc' ? 'desc' : 'asc',
    filters,
  };
}

/** Standard paginated envelope. `sql` must select `count(*) OVER () AS total_count` to fill `total`. */
export function page<T extends { total_count?: number }>(rows: T[], lq: ListQuery) {
  const total = rows[0]?.total_count ?? 0;
  return {
    items: rows.map(({ total_count: _t, ...rest }) => rest),
    total,
    page: lq.page,
    pageSize: lq.pageSize,
  };
}

export function orderLimit(lq: ListQuery, params: unknown[]) {
  params.push(lq.pageSize, (lq.page - 1) * lq.pageSize);
  return `ORDER BY ${lq.sort} ${lq.dir} NULLS LAST LIMIT $${params.length - 1} OFFSET $${params.length}`;
}
