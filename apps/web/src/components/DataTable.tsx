import { useQuery } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { ArrowDown, ArrowUp, ArrowUpDown, Bookmark, ChevronLeft, ChevronRight, Columns3, Download, RefreshCw, Search, Trash2, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api, qs, type Page } from '../lib/api';
import { Button, EmptyState, ErrorState, IconButton, Skeleton } from './ui';
import { Menu, useToast } from './overlay';

export interface Column<T> {
  key: string;
  header: ReactNode;
  render: (row: T) => ReactNode;
  /** Server sort key; omit for unsortable columns. */
  sort?: string;
  /** Plain value used for CSV export. */
  csv?: (row: T) => string | number | null | undefined;
  align?: 'left' | 'right' | 'center';
  width?: string;
  defaultHidden?: boolean;
}

interface SavedView { name: string; q: string; filters: Record<string, string>; sort: string; dir: 'asc' | 'desc'; hidden: string[] }

export interface DataTableProps<T> {
  /** Unique id; used for saved views and column preferences. */
  id: string;
  endpoint: string;
  columns: Column<T>[];
  filters?: Record<string, string | undefined>;
  onFiltersChange?: (f: Record<string, string>) => void;
  toolbar?: ReactNode;
  defaultSort?: { key: string; dir: 'asc' | 'desc' };
  onRowClick?: (row: T) => void;
  rowKey?: (row: T) => string;
  empty?: { title: string; description?: string; action?: ReactNode };
  searchPlaceholder?: string;
  pageSize?: number;
  exportName?: string;
}

const readViews = (id: string): SavedView[] => {
  try { return JSON.parse(localStorage.getItem(`views:${id}`) ?? '[]'); } catch { return []; }
};

export function DataTable<T>({
  id, endpoint, columns, filters = {}, onFiltersChange, toolbar, defaultSort, onRowClick, rowKey = (r) => String((r as { id?: unknown }).id), empty, searchPlaceholder = 'Search…', pageSize: initialSize = 25, exportName,
}: DataTableProps<T>) {
  const toast = useToast();
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(initialSize);
  const [sort, setSort] = useState(defaultSort ?? { key: '', dir: 'asc' as const });
  const [hidden, setHidden] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem(`cols:${id}`) ?? 'null') ?? columns.filter((c) => c.defaultHidden).map((c) => c.key); } catch { return []; }
  });
  const [views, setViews] = useState<SavedView[]>(() => readViews(id));
  const [exporting, setExporting] = useState(false);

  useEffect(() => { const t = setTimeout(() => setDebounced(q), 250); return () => clearTimeout(t); }, [q]);
  useEffect(() => setPage(1), [debounced, JSON.stringify(filters), size]);
  useEffect(() => { localStorage.setItem(`cols:${id}`, JSON.stringify(hidden)); }, [id, hidden]);

  const fParams = Object.fromEntries(Object.entries(filters).filter(([, v]) => v).map(([k, v]) => [`f_${k}`, v]));
  const params = { q: debounced, page, pageSize: size, sort: sort.key || undefined, dir: sort.key ? sort.dir : undefined, ...fParams };
  const sep = endpoint.includes('?') ? '&' : '?';
  const url = `${endpoint}${qs(params).replace('?', sep)}`;
  const query = useQuery({ queryKey: [endpoint, params], queryFn: () => api.get<Page<T>>(url), placeholderData: (prev) => prev });

  const visible = columns.filter((c) => !hidden.includes(c.key));
  const data = query.data;
  const from = data && data.total ? (data.page - 1) * data.pageSize + 1 : 0;
  const to = data ? Math.min(data.page * data.pageSize, data.total) : 0;
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  const activeFilters = Object.values(filters).filter(Boolean).length + (debounced ? 1 : 0);

  function toggleSort(c: Column<T>) {
    if (!c.sort) return;
    setSort((s) => (s.key === c.sort ? { key: c.sort, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key: c.sort!, dir: 'asc' }));
  }

  async function exportCsv() {
    setExporting(true);
    try {
      const all: T[] = [];
      for (let p = 1; p <= 50; p++) {
        const r = await api.get<Page<T>>(`${endpoint}${qs({ ...params, page: p, pageSize: 200 }).replace('?', sep)}`);
        all.push(...r.items);
        if (all.length >= r.total) break;
      }
      const cols = visible.filter((c) => c.csv);
      const esc = (v: unknown) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
      const csv = [cols.map((c) => esc(typeof c.header === 'string' ? c.header : c.key)).join(','), ...all.map((r) => cols.map((c) => esc(c.csv!(r))).join(','))].join('\n');
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv' }));
      a.download = `${exportName ?? id}-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(a.href);
      toast({ tone: 'success', title: `Exported ${all.length} rows` });
    } catch (e) {
      toast({ tone: 'error', title: 'Export failed', body: (e as Error).message });
    } finally {
      setExporting(false);
    }
  }

  function saveView() {
    const name = window.prompt('Name this view');
    if (!name) return;
    const next = [...views.filter((v) => v.name !== name), { name, q, filters: filters as Record<string, string>, sort: sort.key, dir: sort.dir, hidden }];
    setViews(next);
    localStorage.setItem(`views:${id}`, JSON.stringify(next));
    toast({ tone: 'success', title: `View “${name}” saved` });
  }
  function applyView(v: SavedView) {
    setQ(v.q);
    setSort({ key: v.sort, dir: v.dir });
    setHidden(v.hidden);
    onFiltersChange?.(v.filters);
  }
  function deleteView(name: string) {
    const next = views.filter((v) => v.name !== name);
    setViews(next);
    localStorage.setItem(`views:${id}`, JSON.stringify(next));
  }

  return (
    <div className="card overflow-hidden">
      <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 px-3 py-2.5">
        <div className="relative w-full max-w-xs">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-slate-400" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={searchPlaceholder} className="input h-8 pl-8 text-[13px]" aria-label="Search" />
          {q && <button className="absolute top-1/2 right-2 -translate-y-1/2 text-slate-400 hover:text-slate-700" onClick={() => setQ('')} aria-label="Clear search"><X className="size-3.5" /></button>}
        </div>
        {toolbar}
        <div className="ml-auto flex items-center gap-1">
          {activeFilters > 0 && onFiltersChange && (
            <Button size="sm" variant="ghost" onClick={() => { setQ(''); onFiltersChange({}); }}>Clear filters</Button>
          )}
          <Menu
            width="w-60"
            trigger={(toggle) => <Button size="sm" variant="ghost" icon={<Bookmark className="size-3.5" />} onClick={toggle}>Views</Button>}
          >
            {(close) => (
              <div>
                {views.length === 0 && <p className="px-3 py-2 text-xs text-slate-500">No saved views yet.</p>}
                {views.map((v) => (
                  <div key={v.name} className="group flex items-center hover:bg-slate-50">
                    <button className="flex-1 px-3 py-2 text-left text-[13px] text-slate-700" onClick={() => { applyView(v); close(); }}>{v.name}</button>
                    <button className="px-2 text-slate-300 opacity-0 group-hover:opacity-100 hover:text-rose-600" onClick={() => deleteView(v.name)} aria-label={`Delete ${v.name}`}><Trash2 className="size-3.5" /></button>
                  </div>
                ))}
                <div className="mt-1 border-t border-slate-100 pt-1">
                  <button className="w-full px-3 py-2 text-left text-[13px] font-medium text-brand-700 hover:bg-slate-50" onClick={() => { close(); saveView(); }}>Save current view…</button>
                </div>
              </div>
            )}
          </Menu>
          <Menu
            width="w-56"
            trigger={(toggle) => <IconButton label="Columns" onClick={toggle}><Columns3 className="size-4" /></IconButton>}
          >
            {() => (
              <div className="max-h-72 overflow-y-auto py-1">
                <p className="px-3 pt-1 pb-2 text-[11px] font-semibold tracking-wide text-slate-400 uppercase">Show columns</p>
                {columns.map((c) => (
                  <label key={c.key} className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-[13px] text-slate-700 hover:bg-slate-50">
                    <input type="checkbox" className="accent-brand-600" checked={!hidden.includes(c.key)} onChange={() => setHidden((h) => (h.includes(c.key) ? h.filter((x) => x !== c.key) : [...h, c.key]))} />
                    {c.header}
                  </label>
                ))}
              </div>
            )}
          </Menu>
          <IconButton label="Export CSV" onClick={exportCsv} disabled={exporting || !data?.total}><Download className="size-4" /></IconButton>
          <IconButton label="Refresh" onClick={() => query.refetch()}><RefreshCw className={clsx('size-4', query.isFetching && 'animate-spin')} /></IconButton>
        </div>
      </div>

      {query.isError && !data ? (
        <ErrorState error={query.error} onRetry={() => query.refetch()} />
      ) : (
        <div className="scrollbar-thin overflow-x-auto">
          <table className="w-full text-left">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50/80">
                {visible.map((c) => (
                  <th
                    key={c.key}
                    style={{ width: c.width }}
                    className={clsx('px-4 py-2 text-[11.5px] font-semibold tracking-wide text-slate-500 uppercase whitespace-nowrap', c.align === 'right' && 'text-right', c.align === 'center' && 'text-center')}
                  >
                    {c.sort ? (
                      <button className={clsx('inline-flex items-center gap-1 hover:text-slate-800', sort.key === c.sort && 'text-slate-800')} onClick={() => toggleSort(c)}>
                        {c.header}
                        {sort.key === c.sort ? (sort.dir === 'asc' ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" />) : <ArrowUpDown className="size-3 opacity-40" />}
                      </button>
                    ) : c.header}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className={clsx('divide-y divide-slate-100', query.isFetching && data && 'opacity-60 transition-opacity')}>
              {!data && query.isLoading &&
                Array.from({ length: 6 }).map((_, i) => (
                  <tr key={i}>{visible.map((c) => <td key={c.key} className="px-4 py-3"><Skeleton className="h-4 w-3/4" /></td>)}</tr>
                ))}
              {data?.items.map((row) => (
                <tr
                  key={rowKey(row)}
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                  className={clsx('group', onRowClick && 'cursor-pointer hover:bg-brand-50/40')}
                >
                  {visible.map((c) => (
                    <td key={c.key} className={clsx('px-4 py-2 align-middle text-[13px] text-slate-700', c.align === 'right' && 'text-right tabular', c.align === 'center' && 'text-center')}>
                      {c.render(row)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {data && data.items.length === 0 && (
            <EmptyState
              title={activeFilters ? 'No matching records' : empty?.title ?? 'Nothing here yet'}
              description={activeFilters ? 'Try a different search or clear the filters.' : empty?.description}
              action={activeFilters ? undefined : empty?.action}
            />
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 bg-slate-50/50 px-4 py-2 text-[12.5px] text-slate-600">
        <span className="tabular">{data ? (data.total ? `${from}–${to} of ${data.total.toLocaleString('en-IN')}` : '0 records') : 'Loading…'}</span>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2">
            Rows
            <select className="input h-7 w-[72px] py-0 text-[12.5px]" value={size} onChange={(e) => setSize(Number(e.target.value))}>
              {[10, 25, 50, 100].map((n) => <option key={n}>{n}</option>)}
            </select>
          </label>
          <div className="flex items-center gap-1">
            <IconButton label="Previous page" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}><ChevronLeft className="size-4" /></IconButton>
            <span className="tabular min-w-16 text-center">{page} / {pages}</span>
            <IconButton label="Next page" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}><ChevronRight className="size-4" /></IconButton>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Compact client-side table for short lists that are already loaded. */
/** A rendered cell's text for CSV: amounts become plain numbers (₹1,23,456.50 → 123456.50) so spreadsheets can add them. */
function cellValue(text: string) {
  const t = text.replace(/\s+/g, ' ').trim();
  const m = /^(-?)₹?\s?(-?[\d,]+(?:\.\d+)?)\s*(Dr|Cr)?$/.exec(t);
  return m && /\d/.test(m[2]!) ? `${m[1]}${m[2]!.replace(/,/g, '')}${m[3] ? ` ${m[3]}` : ''}` : t;
}
const csvEsc = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

/** Downloads a rendered table as CSV: headers as written, cells as shown, amounts as plain numbers, empty columns skipped. */
export function exportTable(t: HTMLTableElement, name?: string) {
  const heads = [...t.querySelectorAll('thead th')].map((th) => (th.textContent ?? '').replace(/\s+/g, ' ').trim());
  const width = Math.max(heads.length, ...[...t.querySelectorAll('tbody tr')].map((tr) => tr.children.length));
  const keep = heads.length ? heads.map((h, i) => (h ? i : -1)).filter((i) => i >= 0) : Array.from({ length: width }, (_, i) => i);
  const lines = heads.length ? [keep.map((i) => csvEsc(heads[i]!)).join(',')] : [];
  for (const tr of t.querySelectorAll('tbody tr')) {
    const cells = [...tr.children].map((td) => cellValue((td as HTMLElement).innerText));
    lines.push(keep.map((i) => csvEsc(cells[i] ?? '')).join(','));
  }
  const title = name ?? (document.querySelector('main h1') as HTMLElement | null)?.innerText.split('\n')[0] ?? 'export';
  const url = URL.createObjectURL(new Blob(['\uFEFF' + lines.join('\n')], { type: 'text/csv' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: `${title.replace(/[^\w.-]+/g, '-').replace(/^-|-$/g, '').toLowerCase() || 'export'}-${new Date().toISOString().slice(0, 10)}.csv` });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/** CSV download for a hand-built table: exports the table(s) inside the same card or section. */
export function TableCsvButton({ name }: { name?: string }) {
  return (
    <button type="button" aria-label="Download CSV" title="Download as CSV" className="inline-flex items-center gap-1 rounded px-2 py-1 text-[12.5px] text-slate-500 hover:bg-slate-100 hover:text-slate-800"
      onClick={(e) => {
        const box = (e.currentTarget as HTMLElement).closest('.card, section, [data-csv-scope]');
        const tables = [...(box?.querySelectorAll('table') ?? [])] as HTMLTableElement[];
        if (tables.length === 1) exportTable(tables[0]!, name);
        else if (tables.length > 1) {
          // Several tables (a statement in sections): export them one after another in a single file.
          const merged = document.createElement('table');
          const body = document.createElement('tbody');
          for (const t of tables) for (const tr of t.querySelectorAll('tr')) body.appendChild(tr.cloneNode(true));
          merged.appendChild(body);
          merged.style.position = 'absolute'; merged.style.left = '-99999px';
          document.body.appendChild(merged);
          exportTable(merged, name);
          merged.remove();
        }
      }}><Download className="size-3.5" />CSV</button>
  );
}

export function SimpleTable<T>({ rows, columns, rowKey, onRowClick, empty, pageSize, csv, csvName }: {
  rows: T[]; columns: Omit<Column<T>, 'sort' | 'csv'>[]; rowKey: (r: T) => string; onRowClick?: (r: T) => void; empty?: ReactNode;
  /** Show this many rows at a time, with a pager underneath, when there are more. */
  pageSize?: number;
  /** Offer a CSV download of every row (default: when the table has 3 rows or more). */
  csv?: boolean;
  /** File name for the CSV (default: the page title). */
  csvName?: string;
}) {
  const [pg, setPg] = useState(0);
  const [exporting, setExporting] = useState(false);
  const tableRef = useRef<HTMLTableElement>(null);
  const pages = pageSize ? Math.max(1, Math.ceil(rows.length / pageSize)) : 1;
  const at = Math.min(pg, pages - 1);
  useEffect(() => { setPg(0); }, [rows.length]);
  // While exporting, every row is rendered so the file holds what the screen would show across all pages.
  const body = useMemo(() => (pageSize && !exporting ? rows.slice(at * pageSize, (at + 1) * pageSize) : rows), [rows, pageSize, at, exporting]);
  const offerCsv = csv ?? rows.length >= 3;
  useEffect(() => {
    if (!exporting || !tableRef.current) return;
    exportTable(tableRef.current, csvName);
    setExporting(false);
  }, [exporting, csvName]);
  const showPager = !!pageSize && rows.length > pageSize;
  return (
    <div className="scrollbar-thin overflow-x-auto">
      <table ref={tableRef} className="w-full text-left">
        <thead>
          <tr className="border-b border-slate-200 bg-slate-50/80">
            {columns.map((c) => (
              <th key={c.key} style={{ width: c.width }} className={clsx('px-4 py-2 text-[11.5px] font-semibold tracking-wide text-slate-500 uppercase whitespace-nowrap', c.align === 'right' && 'text-right')}>{c.header}</th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {body.map((r) => (
            <tr key={rowKey(r)} onClick={onRowClick ? () => onRowClick(r) : undefined} className={clsx(onRowClick && 'cursor-pointer hover:bg-brand-50/40')}>
              {columns.map((c) => (
                <td key={c.key} className={clsx('px-4 py-2 text-[13px] text-slate-700', c.align === 'right' && 'text-right tabular')}>{c.render(r)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {body.length === 0 && (empty ?? <EmptyState title="Nothing here yet" />)}
      {(showPager || (offerCsv && rows.length > 0)) && (
        <div className="flex items-center justify-between gap-3 border-t border-slate-100 px-4 py-1.5 text-[12.5px] text-slate-500">
          <span className="tabular">{showPager ? `${at * pageSize! + 1}–${Math.min(rows.length, (at + 1) * pageSize!)} of ${rows.length}` : `${rows.length} rows`}</span>
          <span className="flex items-center gap-1">
            {offerCsv && rows.length > 0 && <button type="button" className="flex items-center gap-1 rounded px-2 py-1 hover:bg-slate-100 hover:text-slate-800" onClick={() => setExporting(true)} aria-label="Download CSV" title="Download every row as CSV"><Download className="size-3.5" />CSV</button>}
            {showPager && <>
              <button className="rounded px-2 py-1 hover:bg-slate-100 disabled:opacity-40" disabled={at === 0} onClick={() => setPg(at - 1)} aria-label="Previous page">‹ Previous</button>
              <span className="tabular">Page {at + 1} of {pages}</span>
              <button className="rounded px-2 py-1 hover:bg-slate-100 disabled:opacity-40" disabled={at >= pages - 1} onClick={() => setPg(at + 1)} aria-label="Next page">Next ›</button>
            </>}
          </span>
        </div>
      )}
    </div>
  );
}

export function FilterSelect({ value, onChange, options, placeholder }: { value?: string; onChange: (v: string) => void; options: { value: string; label: string }[]; placeholder: string }) {
  return (
    <select aria-label={placeholder} value={value ?? ''} onChange={(e) => onChange(e.target.value)} className={clsx('input h-8 w-auto min-w-[140px] text-[13px]', value && 'border-brand-300 bg-brand-50/50 text-brand-800')}>
      <option value="">{placeholder}</option>
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}
