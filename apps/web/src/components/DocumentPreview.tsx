import { useQuery } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { Eye, History, Printer } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../lib/api';
import { GST_STATES, fmtDate, fmtDateTime, fmtINR, fmtNum, humanize } from '../lib/format';
import { Modal } from './overlay';
import { Badge, Button, Card, EmptyState, Notice } from './ui';

/** One print layout for every business document: quotation, invoice, purchase order, debit note, challan, voucher, statement. */
export interface DocLine { description: string; hsn?: string | null; qty?: number | null; uom?: string | null; rate?: number | null; taxable?: number | null; gst_rate?: number | null; amount?: number | null; note?: string | null }
export interface DocData {
  title: string; number: string; date: string; version?: number | null; status?: string | null;
  seller: { name: string; gstin?: string | null; lines?: (string | null | undefined)[] };
  party?: { label: string; name: string; gstin?: string | null; state?: string | null; lines?: (string | null | undefined)[] } | null;
  meta?: { label: string; value: ReactNode }[];
  lines: DocLine[];
  totals?: { label: string; value: number; strong?: boolean }[];
  notes?: string | null; terms?: string | null; footer?: string | null;
  signatory?: string | null;
}

export function DocumentSheet({ d, draft }: { d: DocData; draft?: boolean }) {
  const hasTax = d.lines.some((l) => l.gst_rate != null);
  const hasQty = d.lines.some((l) => l.qty != null);
  return (
    <div className="invoice-sheet relative mx-auto max-w-[210mm] overflow-hidden bg-white p-8 text-[12px] text-slate-900 shadow-sm ring-1 ring-slate-200 print:shadow-none print:ring-0">
      {draft && <div aria-hidden className="pointer-events-none absolute inset-0 flex items-center justify-center"><span className="rotate-[-28deg] text-[110px] font-black tracking-[0.2em] text-slate-900/[0.07] select-none">DRAFT</span></div>}
      <div className="flex items-start justify-between border-b border-slate-300 pb-4">
        <div><p className="text-[16px] font-bold">{d.seller.name}</p>{d.seller.lines?.filter(Boolean).map((x) => <p key={String(x)}>{x}</p>)}{d.seller.gstin && <p className="mt-1">GSTIN <b className="font-mono">{d.seller.gstin}</b></p>}</div>
        <div className="text-right"><p className="text-[18px] font-bold tracking-wide uppercase">{d.title}</p><p className="font-mono text-[13px] font-semibold">{draft ? `${d.number} (draft)` : d.number}</p><p>Date {fmtDate(d.date)}</p>{d.version ? <p className="text-slate-500">Version {d.version}</p> : null}</div>
      </div>
      {(d.party || d.meta?.length) && (
        <div className="grid grid-cols-2 gap-6 border-b border-slate-300 py-4">
          <div>{d.party && <><p className="text-[10.5px] font-semibold text-slate-500 uppercase">{d.party.label}</p><p className="font-semibold">{d.party.name}</p>{d.party.lines?.filter(Boolean).map((x) => <p key={String(x)}>{x}</p>)}{d.party.gstin && <p>GSTIN <span className="font-mono">{d.party.gstin}</span></p>}{d.party.state && <p>State {d.party.state} · {GST_STATES[d.party.state] ?? ''}</p>}</>}</div>
          <div className="space-y-0.5">{d.meta?.map((m) => <p key={m.label}><span className="text-slate-500">{m.label}: </span>{m.value}</p>)}</div>
        </div>
      )}
      <table className="mt-4 w-full border-collapse">
        <thead><tr className="border-y border-slate-300 bg-slate-50 text-left text-[10.5px] uppercase"><th className="py-1.5 pr-2">#</th><th className="pr-2">Description</th>{hasTax && <th className="pr-2">HSN</th>}{hasQty && <th className="pr-2 text-right">Qty</th>}{hasQty && <th className="pr-2 text-right">Rate</th>}{hasTax && <th className="pr-2 text-right">GST</th>}<th className="text-right">Amount</th></tr></thead>
        <tbody>{d.lines.map((l, i) => (
          <tr key={i} className="border-b border-slate-200 align-top"><td className="py-1.5 pr-2">{i + 1}</td><td className="pr-2">{l.description}{l.note && <span className="block text-slate-500">{l.note}</span>}</td>{hasTax && <td className="pr-2 font-mono">{l.hsn ?? ''}</td>}
            {hasQty && <td className="pr-2 text-right tabular">{l.qty != null ? `${fmtNum(l.qty)} ${l.uom ?? ''}` : ''}</td>}{hasQty && <td className="pr-2 text-right tabular">{l.rate != null ? fmtINR(l.rate) : ''}</td>}{hasTax && <td className="pr-2 text-right">{l.gst_rate != null ? `${l.gst_rate}%` : ''}</td>}
            <td className="text-right tabular">{fmtINR(l.amount ?? l.taxable ?? (l.qty ?? 0) * (l.rate ?? 0))}</td></tr>
        ))}</tbody>
      </table>
      {d.totals?.length ? <div className="mt-4 ml-auto w-72 space-y-1 text-[12.5px]">{d.totals.map((t) => <div key={t.label} className={clsx('flex justify-between', t.strong && 'border-t border-slate-300 pt-1 text-[14px] font-bold')}><span>{t.label}</span><span className="tabular">{fmtINR(t.value)}</span></div>)}</div> : null}
      {d.notes && <p className="mt-6 whitespace-pre-line"><span className="font-semibold">Notes: </span>{d.notes}</p>}
      {d.terms && <p className="mt-2 whitespace-pre-line text-slate-600"><span className="font-semibold">Terms: </span>{d.terms}</p>}
      <div className="mt-10 flex items-end justify-between text-[11px] text-slate-500"><span>{draft ? 'Draft for review — not a valid document until it is confirmed.' : d.footer ?? 'Computer-generated document.'}</span><span className="text-right">For {d.seller.name}<br /><br />{d.signatory ?? 'Authorised signatory'}</span></div>
    </div>
  );
}

/** Preview (DRAFT watermark before confirming) and print (the final numbered document). */
export function DocumentPreviewButton({ d, draft, label }: { d: DocData | (() => Promise<DocData>); draft?: boolean; label?: string }) {
  const [open, setOpen] = useState<DocData | null>(null);
  const [err, setErr] = useState<string | null>(null);
  return (
    <>
      <Button icon={draft ? <Eye className="size-4" /> : <Printer className="size-4" />} onClick={async () => { try { setErr(null); setOpen(typeof d === 'function' ? await d() : d); } catch (e) { setErr((e as Error).message); setOpen(null); } }}>{label ?? (draft ? 'Preview' : 'Print')}</Button>
      {err && <span className="text-[12px] text-rose-600">{err}</span>}
      {open && <PreviewModal d={open} draft={draft} onClose={() => setOpen(null)} />}
    </>
  );
}

export function PreviewModal({ d, draft, onClose }: { d: DocData; draft?: boolean; onClose: () => void }) {
  const [printing, setPrinting] = useState(false);
  useEffect(() => {
    if (!printing) return;
    const t = setTimeout(() => { window.print(); setPrinting(false); }, 300);
    return () => clearTimeout(t);
  }, [printing]);
  return (
    <Modal open onClose={onClose} size="lg" title={draft ? `Preview: ${d.title}` : d.title} description={draft ? 'How the document will look once confirmed. Nothing is saved or sent from here.' : undefined}
      footer={<><Button onClick={onClose}>Close</Button><Button variant="primary" icon={<Printer className="size-4" />} onClick={() => setPrinting(true)}>{draft ? 'Print draft' : 'Print / save as PDF'}</Button></>}>
      <div className="max-h-[70vh] overflow-y-auto bg-slate-100 p-3"><DocumentSheet d={d} draft={draft} /></div>
      {printing && createPortal(<div className="print-only"><DocumentSheet d={d} draft={draft} /></div>, document.body)}
    </Modal>
  );
}

interface Version { id: number; version: number; status: string | null; number: string | null; data: Record<string, unknown>; change_note: string | null; by_name: string | null; at: string }

const SKIP = new Set(['lines', 'barcodes']);
function changes(a: Record<string, unknown>, b: Record<string, unknown> | undefined) {
  if (!b) return [];
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => !SKIP.has(k));
  const out = keys.filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k])).map((k) => ({ field: humanize(k), from: b[k], to: a[k] }));
  if (JSON.stringify(a.lines) !== JSON.stringify(b.lines)) out.push({ field: 'Lines', from: `${(b.lines as unknown[] | undefined)?.length ?? 0} line(s)`, to: `${(a.lines as unknown[] | undefined)?.length ?? 0} line(s), changed` });
  return out;
}
const show = (v: unknown) => (v == null || v === '' ? '—' : typeof v === 'number' ? v.toLocaleString('en-IN') : typeof v === 'object' ? JSON.stringify(v) : String(v));

/**
 * Every saved version of a document. Only the latest can be edited (in its own screen); older versions open read-only
 * here, with what changed, who changed it and why. `render` turns a stored version into a printable sheet.
 */
export function VersionHistory({ docType, docId, render }: { docType: string; docId: string; render?: (v: Version) => DocData | null }) {
  const q = useQuery({ queryKey: ['doc-versions', docType, docId], queryFn: () => api.get<Version[]>(`/governance/document-versions?doc_type=${docType}&doc_id=${docId}`) });
  const [view, setView] = useState<Version | null>(null);
  const rows = q.data ?? [];
  return (
    <Card title={<span className="flex items-center gap-2"><History className="size-4" />Version history</span>} description="Only the latest version can be changed; earlier versions are kept read-only.">
      {!rows.length ? <EmptyState title="No versions recorded yet" /> : (
        <ol className="space-y-2.5">{rows.map((v, i) => {
          const diff = changes(v.data, rows[i + 1]?.data);
          return (
            <li key={v.id} className="rounded-lg border border-slate-200 p-3 text-[12.5px]">
              <div className="flex items-center justify-between gap-2"><span className="font-medium">Version {v.version}{i === 0 && <Badge tone="info" className="ml-1.5">Latest</Badge>}{v.status && <Badge className="ml-1.5">{humanize(v.status)}</Badge>}</span><Button size="sm" variant="ghost" onClick={() => setView(v)}>View</Button></div>
              <p className="text-slate-600">{v.change_note ?? '—'}</p>
              <p className="text-slate-400">{v.by_name ?? 'system'} · {fmtDateTime(v.at)}</p>
              {diff.length > 0 && <ul className="mt-1.5 space-y-0.5 border-t border-slate-100 pt-1.5">{diff.slice(0, 8).map((x) => <li key={x.field}><span className="text-slate-500">{x.field}: </span><span className="text-rose-600 line-through">{show(x.from)}</span> → <span className="text-emerald-700">{show(x.to)}</span></li>)}</ul>}
            </li>
          );
        })}</ol>
      )}
      {view && (() => {
        const d = render?.(view);
        return d ? <PreviewModal d={{ ...d, version: view.version }} draft={view.status !== 'posted' && view.status !== 'sent' && view.status !== 'approved' && view.status !== 'accepted'} onClose={() => setView(null)} /> : (
          <Modal open onClose={() => setView(null)} title={`Version ${view.version} (read-only)`} footer={<Button onClick={() => setView(null)}>Close</Button>}>
            <Notice tone="info">This is how the document stood at version {view.version}. It cannot be edited.</Notice>
            <dl className="mt-3 grid grid-cols-2 gap-2 text-[12.5px]">{Object.entries(view.data).filter(([k]) => !SKIP.has(k)).map(([k, x]) => <div key={k}><dt className="text-slate-500">{humanize(k)}</dt><dd>{show(x)}</dd></div>)}</dl>
          </Modal>
        );
      })()}
    </Card>
  );
}
