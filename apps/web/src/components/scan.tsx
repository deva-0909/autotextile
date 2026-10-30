import { clsx } from 'clsx';
import { CheckCircle2, Printer, ScanLine, XCircle } from 'lucide-react';
import QRCode from 'qrcode';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { fmtNum } from '../lib/format';
import { Button } from './ui';

export interface ScanResult { ok: boolean; title: string; detail?: ReactNode }

/**
 * Barcode entry for handheld scanners (which type the code and press Enter) and manual typing.
 * Keeps focus so a stores operator can scan roll after roll, and shows the outcome of each scan.
 */
export function ScanInput({ onScan, placeholder = 'Scan or type a roll barcode', label, disabled, extra, autoFocus = true }: {
  onScan: (code: string) => Promise<ScanResult>; placeholder?: string; label?: ReactNode; disabled?: boolean; extra?: ReactNode; autoFocus?: boolean;
}) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<(ScanResult & { code: string; at: number })[]>([]);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { if (autoFocus) ref.current?.focus(); }, [autoFocus]);
  async function submit() {
    const c = code.trim().toUpperCase();
    if (!c || busy) return;
    setBusy(true);
    try {
      const r = await onScan(c);
      setLog((l) => [{ ...r, code: c, at: Date.now() }, ...l].slice(0, 8));
      if (r.ok) setCode('');
    } catch (e) {
      setLog((l) => [{ ok: false, title: (e as Error).message, code: c, at: Date.now() }, ...l].slice(0, 8));
    } finally {
      setBusy(false);
      ref.current?.select();
    }
  }
  const last = log[0];
  return (
    <div>
      {label && <p className="mb-1.5 text-[12.5px] font-medium text-slate-700">{label}</p>}
      <div className="flex flex-wrap items-end gap-2">
        <div className="relative min-w-[240px] flex-1">
          <ScanLine className="pointer-events-none absolute top-1/2 left-3 size-5 -translate-y-1/2 text-slate-400" />
          <input ref={ref} value={code} disabled={disabled || busy} onChange={(e) => setCode(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void submit(); } }}
            placeholder={placeholder} className="input h-11 pl-10 font-mono text-[15px] tracking-wide uppercase" autoComplete="off" spellCheck={false} />
        </div>
        {extra}
        <Button variant="primary" className="h-11" loading={busy} disabled={disabled || !code.trim()} onClick={() => void submit()}>Scan</Button>
      </div>
      {last && (
        <div className={clsx('mt-3 flex items-start gap-3 rounded-lg px-4 py-3 ring-1 ring-inset', last.ok ? 'bg-emerald-50 ring-emerald-600/20' : 'bg-rose-50 ring-rose-600/20')} role="status">
          {last.ok ? <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-emerald-600" /> : <XCircle className="mt-0.5 size-5 shrink-0 text-rose-600" />}
          <div className="min-w-0">
            <p className={clsx('text-[14px] font-semibold', last.ok ? 'text-emerald-900' : 'text-rose-900')}><span className="font-mono">{last.code}</span> · {last.title}</p>
            {last.detail && <div className="mt-0.5 text-[12.5px] text-slate-600">{last.detail}</div>}
          </div>
        </div>
      )}
      {log.length > 1 && (
        <ul className="mt-2 space-y-1">
          {log.slice(1).map((l) => (
            <li key={l.at} className="flex items-center gap-2 text-[12px] text-slate-500">
              {l.ok ? <CheckCircle2 className="size-3.5 text-emerald-500" /> : <XCircle className="size-3.5 text-rose-500" />}<span className="font-mono">{l.code}</span><span className="truncate">{l.title}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export interface LabelRoll { barcode: string; weight_kg: number | string; sku?: string; product_name?: string; lot_no?: string; grade?: string | null; shade_code?: string | null; dye_lot?: string | null; gsm?: number | string | null; width_in?: number | string | null }

function useQr(text: string) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => { void QRCode.toDataURL(text, { margin: 0, width: 160, errorCorrectionLevel: 'M' }).then(setSrc); }, [text]);
  return src;
}

/** A 100 × 50 mm roll label: QR of the barcode plus the details a picker reads by eye. */
export function RollLabel({ roll }: { roll: LabelRoll }) {
  const qr = useQr(roll.barcode);
  return (
    <div className="roll-label flex h-[50mm] w-[100mm] items-center gap-3 rounded-md border border-slate-300 bg-white p-3 text-slate-900">
      {qr ? <img src={qr} alt="" className="size-[34mm] shrink-0" /> : <div className="size-[34mm] shrink-0 bg-slate-100" />}
      <div className="min-w-0 flex-1 leading-tight">
        <p className="font-mono text-[13px] font-bold">{roll.barcode}</p>
        <p className="mt-1 truncate text-[11px] font-semibold">{roll.sku}</p>
        <p className="truncate text-[10px] text-slate-600">{roll.product_name}</p>
        <p className="mt-1.5 text-[20px] font-bold tabular">{fmtNum(Number(roll.weight_kg))} kg</p>
        <p className="mt-1 text-[10px] text-slate-700">
          {[roll.lot_no && `Lot ${roll.lot_no}`, roll.dye_lot && `Dye ${roll.dye_lot}`, roll.shade_code && `Shade ${roll.shade_code}`, roll.grade && `Grade ${roll.grade}`, roll.gsm && `${roll.gsm} GSM`, roll.width_in && `${roll.width_in}"`].filter(Boolean).join(' · ')}
        </p>
      </div>
    </div>
  );
}

/** Prints labels on their own (the rest of the app is hidden while printing). */
export function PrintLabels({ rolls, children = 'Print labels' }: { rolls: LabelRoll[]; children?: ReactNode }) {
  const [printing, setPrinting] = useState(false);
  useEffect(() => {
    if (!printing) return;
    const t = setTimeout(() => { window.print(); setPrinting(false); }, 400);
    return () => clearTimeout(t);
  }, [printing]);
  return (
    <>
      <Button icon={<Printer className="size-4" />} disabled={!rolls.length} onClick={() => setPrinting(true)}>{children}</Button>
      {printing && createPortal(<div className="print-only grid gap-[4mm] p-[4mm]">{rolls.map((r) => <RollLabel key={r.barcode} roll={r} />)}</div>, document.body)}
    </>
  );
}

/** Horizontal bar for a share of a whole (stock states, ageing buckets, utilisation). */
export function Bar({ value, max, tone = 'brand', className }: { value: number; max: number; tone?: 'brand' | 'success' | 'warning' | 'danger' | 'neutral' | 'info'; className?: string }) {
  const pct = max > 0 ? Math.min(100, Math.max(0, (value / max) * 100)) : 0;
  const c = { brand: 'bg-brand-500', success: 'bg-emerald-500', warning: 'bg-amber-500', danger: 'bg-rose-500', neutral: 'bg-slate-400', info: 'bg-sky-500' }[tone];
  return <div className={clsx('h-2 overflow-hidden rounded-full bg-slate-100', className)}><div className={clsx('h-full rounded-full', c)} style={{ width: `${pct}%` }} /></div>;
}
