import { useQuery, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { ClipboardCheck, MapPin, Scissors, ShieldAlert } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, invalidatePrefix } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { fmtDate, fmtDateTime, fmtNum, humanize } from '../../lib/format';
import { ConfirmDialog, Modal, useToast } from '../../components/overlay';
import { PrintLabels, ScanInput, type ScanResult } from '../../components/scan';
import { Badge, Button, Card, EmptyState, Input, KeyValue, Notice, PageHeader, Skeleton, StatusBadge, Textarea } from '../../components/ui';

interface QueueLot { lot_id: string; lot_no: string; sku: string; product_name: string; party_name: string | null; source_ref: string; received_date: string; shade_code: string | null; dye_lot: string | null; warehouse_id: string; rolls: number; kg: number; roll_list: { id: string; barcode: string; weight_kg: number; gsm: number | null; width_in: number | null; shade_code: string | null }[] }
type Grade = 'A' | 'B' | 'C' | 'reject';
interface Row { grade: Grade; gsm: string; width_in: string; shade_code: string; defects: string }
const GRADES: { g: Grade; label: string; cls: string }[] = [
  { g: 'A', label: 'A', cls: 'bg-emerald-600 text-white' }, { g: 'B', label: 'B', cls: 'bg-sky-600 text-white' }, { g: 'C', label: 'C', cls: 'bg-amber-500 text-white' }, { g: 'reject', label: 'Reject', cls: 'bg-rose-600 text-white' },
];
const DEFECTS = ['Holes', 'Oil stains', 'Needle lines', 'Barre', 'Shade variation', 'Low GSM', 'Width short', 'Slubs', 'Pilling'];

export function QcPage() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['inv-qc'], queryFn: () => api.get<QueueLot[]>('/inventory/qc/queue') });
  const [lotId, setLotId] = useState<string | null>(null);
  const lot = q.data?.find((l) => l.lot_id === lotId) ?? q.data?.[0];
  const [rows, setRows] = useState<Record<string, Row>>({});
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [flags, setFlags] = useState<string[]>([]);
  useEffect(() => {
    if (!lot) return;
    setRows(Object.fromEntries(lot.roll_list.map((r) => [r.barcode, { grade: 'A', gsm: r.gsm ? String(r.gsm) : '', width_in: r.width_in ? String(r.width_in) : '', shade_code: r.shade_code ?? '', defects: '' }])));
  }, [lot?.lot_id]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = (b: string, patch: Partial<Row>) => setRows((r) => ({ ...r, [b]: { ...r[b]!, ...patch } }));
  const all = (g: Grade) => setRows((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, { ...v, grade: g }])));
  async function submit() {
    if (!lot) return;
    setBusy(true);
    try {
      const results = Object.entries(rows).map(([barcode, v]) => ({ barcode, grade: v.grade, gsm: v.gsm ? Number(v.gsm) : null, width_in: v.width_in ? Number(v.width_in) : null, shade_code: v.shade_code || null, defects: v.defects ? v.defects.split(',').map((d) => d.trim()).filter(Boolean) : [] }));
      const r = await api.post<{ graded: number; flags: string[] }>('/inventory/qc', { results, note: note || null });
      setFlags(r.flags);
      toast({ tone: 'success', title: `${r.graded} rolls graded`, body: r.flags.length ? `${r.flags.length} out-of-spec measurement(s) flagged` : undefined });
      setLotId(null); setNote('');
      q.refetch(); invalidatePrefix(qc, 'inv');
    } catch (e) { toast({ tone: 'error', title: (e as Error).message }); } finally { setBusy(false); }
  }
  const counts = Object.values(rows).reduce((m, r) => ({ ...m, [r.grade]: (m[r.grade] ?? 0) + 1 }), {} as Record<string, number>);
  return (
    <>
      <PageHeader title="Quality inspection & grading" description="Grade each roll A, B, C or reject and record measured GSM, width, shade and defects. Measurements outside the product’s tolerance are flagged; rejects go to purchase for return or claim."
        breadcrumbs={[{ label: 'Inventory', to: '/inventory' }, { label: 'Quality inspection' }]} />
      {flags.length > 0 && <div className="mb-4"><Notice tone="warning" title="Out-of-spec measurements">{flags.join(' · ')}</Notice></div>}
      {!q.data ? <Skeleton className="h-80" /> : q.data.length === 0 ? <Card><EmptyState icon={<ClipboardCheck className="size-5" />} title="Nothing waiting for QC" description="Rolls scanned at inward appear here." /></Card> : (
        <div className="grid grid-cols-1 gap-6 xl:grid-cols-[320px_1fr]">
          <Card title="Lots on QC hold" padded={false}>
            <ul className="divide-y divide-slate-100">
              {q.data.map((l) => (
                <li key={l.lot_id}>
                  <button onClick={() => setLotId(l.lot_id)} className={clsx('w-full px-4 py-3 text-left hover:bg-slate-50', lot?.lot_id === l.lot_id && 'bg-brand-50/60')}>
                    <div className="flex items-center justify-between"><span className="font-mono text-[12.5px] font-semibold">{l.lot_no}</span><span className="text-[12px] text-slate-500 tabular">{l.rolls} rolls · {fmtNum(l.kg)} kg</span></div>
                    <p className="text-[12.5px] text-slate-700">{l.sku}</p>
                    <p className="text-[11.5px] text-slate-500">{l.party_name ?? l.source_ref} · {fmtDate(l.received_date)}</p>
                  </button>
                </li>
              ))}
            </ul>
          </Card>
          {lot && (
            <Card title={<span><span className="font-mono">{lot.lot_no}</span> · {lot.sku}</span>} description={`${lot.product_name}${lot.dye_lot ? ` · dye lot ${lot.dye_lot}` : ''}`} padded={false}
              actions={<div className="flex items-center gap-1.5"><span className="text-[12px] text-slate-500">Set all:</span>{GRADES.map((g) => <Button key={g.g} size="sm" onClick={() => all(g.g)}>{g.label}</Button>)}</div>}>
              <div className="scrollbar-thin overflow-x-auto">
                <table className="w-full text-left text-[13px]">
                  <thead><tr className="border-b border-slate-200 bg-slate-50/80 text-[11.5px] font-semibold tracking-wide text-slate-500 uppercase">
                    <th className="px-4 py-2">Roll</th><th className="px-2 py-2 text-right">KG</th><th className="px-2 py-2">Grade</th><th className="px-2 py-2">GSM</th><th className="px-2 py-2">Width"</th><th className="px-2 py-2">Shade</th><th className="px-2 py-2">Defects</th>
                  </tr></thead>
                  <tbody className="divide-y divide-slate-100">
                    {lot.roll_list.map((r) => {
                      const v = rows[r.barcode];
                      if (!v) return null;
                      return (
                        <tr key={r.barcode}>
                          <td className="px-4 py-2 font-mono text-[12.5px]">{r.barcode}</td>
                          <td className="px-2 py-2 text-right tabular">{fmtNum(Number(r.weight_kg))}</td>
                          <td className="px-2 py-2"><div className="inline-flex overflow-hidden rounded-md ring-1 ring-slate-200">{GRADES.map((g) => (
                            <button key={g.g} onClick={() => set(r.barcode, { grade: g.g })} className={clsx('px-2.5 py-1 text-[12px] font-semibold', v.grade === g.g ? g.cls : 'bg-white text-slate-600 hover:bg-slate-50')}>{g.label}</button>
                          ))}</div></td>
                          <td className="px-2 py-2"><input className="input h-8 w-20" type="number" value={v.gsm} onChange={(e) => set(r.barcode, { gsm: e.target.value })} /></td>
                          <td className="px-2 py-2"><input className="input h-8 w-16" type="number" value={v.width_in} onChange={(e) => set(r.barcode, { width_in: e.target.value })} /></td>
                          <td className="px-2 py-2"><input className="input h-8 w-24" value={v.shade_code} onChange={(e) => set(r.barcode, { shade_code: e.target.value })} /></td>
                          <td className="px-2 py-2"><input className="input h-8 w-44" list="defects" placeholder={v.grade === 'A' ? '' : 'e.g. Holes, Slubs'} value={v.defects} onChange={(e) => set(r.barcode, { defects: e.target.value })} /></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                <datalist id="defects">{DEFECTS.map((d) => <option key={d} value={d} />)}</datalist>
              </div>
              <div className="flex flex-wrap items-end gap-4 border-t border-slate-100 px-5 py-4">
                <div className="flex gap-1.5">{GRADES.map((g) => counts[g.g] ? <Badge key={g.g} tone={g.g === 'reject' ? 'danger' : g.g === 'A' ? 'success' : g.g === 'B' ? 'info' : 'warning'}>{g.label}: {counts[g.g]}</Badge> : null)}</div>
                <Input className="min-w-[240px] flex-1" placeholder="Inspection note (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
                <Button variant="primary" loading={busy} disabled={!can('inventory.qc.record')} onClick={() => void submit()}>Save grades</Button>
              </div>
            </Card>
          )}
        </div>
      )}
    </>
  );
}

interface ScanRoll { id: string; barcode: string; lot_id: string; lot_no: string; sku: string; product_name: string; weight_kg: number; initial_kg: number; state: string; warehouse_id: string | null; location_id: string | null; location_path: string | null; grade: string | null; gsm: number | null; width_in: number | null; shade_code: string | null; dye_lot: string | null; price_per_kg: number | null; holder_ref: string | null; defects: string[] }
interface ScanResp { kind: 'roll' | 'lot'; lot_id?: string; roll?: ScanRoll; history?: { id: number; at: string; movement_type: string; kg: number; to_state: string | null; to_location: string | null; ref_no: string | null; by_name: string | null; reason: string | null }[]; suggestions?: { id: string; path: string; free_kg: number | null; reason: string }[] }

/** Warehouse app: scan any roll to see where it is, what it is, and act on it (put away, split, damage). Built for a phone or a handheld. */
export function ScanStationPage() {
  const { can } = useAuth();
  const toast = useToast();
  const [cur, setCur] = useState<ScanResp | null>(null);
  const [modal, setModal] = useState<'move' | 'split' | 'damage' | null>(null);
  const nav = useNavigate();
  const lookup = async (code: string): Promise<ScanResult> => {
    const r = await api.get<ScanResp>(`/inventory/scan/${encodeURIComponent(code)}`);
    if (r.kind === 'lot') { nav(`/inventory/lots/${r.lot_id}`); return { ok: true, title: 'Lot — opening' }; }
    setCur(r);
    return { ok: true, title: `${r.roll!.sku} · ${fmtNum(Number(r.roll!.weight_kg))} kg`, detail: `${humanize(r.roll!.state)}${r.roll!.location_path ? ` · ${r.roll!.location_path}` : ''}` };
  };
  const refresh = async () => { if (cur?.roll) setCur(await api.get<ScanResp>(`/inventory/scan/${cur.roll.barcode}`)); };
  const r = cur?.roll;
  return (
    <>
      <PageHeader title="Scan station" description="Scan a roll or lot barcode with a handheld scanner or type it. Works on a phone." breadcrumbs={[{ label: 'Inventory', to: '/inventory' }, { label: 'Scan station' }]} />
      <div className="mx-auto max-w-3xl space-y-6">
        <Card><ScanInput onScan={lookup} placeholder="Scan roll or lot barcode" /></Card>
        {r && (
          <Card title={<span className="font-mono">{r.barcode}</span>} description={`${r.sku} · ${r.product_name}`} actions={<StatusBadge status={r.state} />}>
            <div className="mb-5 grid grid-cols-2 gap-4 sm:grid-cols-4">
              <div><p className="text-[12px] text-slate-500">Weight</p><p className="text-[22px] font-semibold tabular">{fmtNum(Number(r.weight_kg))} kg</p></div>
              <div><p className="text-[12px] text-slate-500">Location</p><p className="flex items-center gap-1 text-[16px] font-semibold"><MapPin className="size-4 text-slate-400" />{r.location_path ?? (r.holder_ref || '—')}</p></div>
              <div><p className="text-[12px] text-slate-500">Grade</p><p className="text-[16px] font-semibold">{r.grade ?? 'Not graded'}</p></div>
              <div><p className="text-[12px] text-slate-500">Price</p><p className="text-[16px] font-semibold">{r.price_per_kg ? `₹${fmtNum(Number(r.price_per_kg))}/kg` : '—'}</p></div>
            </div>
            <KeyValue columns={3} items={[
              { label: 'Lot', value: <Link className="link font-mono" to={`/inventory/lots/${r.lot_id}`}>{r.lot_no}</Link> },
              { label: 'Dye lot / shade', value: `${r.dye_lot ?? '—'} / ${r.shade_code ?? '—'}` },
              { label: 'GSM / width', value: `${r.gsm ?? '—'} / ${r.width_in ? `${r.width_in}"` : '—'}` },
              { label: 'Initial weight', value: `${fmtNum(Number(r.initial_kg))} kg` },
              { label: 'Defects', value: r.defects.length ? r.defects.join(', ') : '—' },
            ]} />
            {r.state === 'available' && cur?.suggestions?.length ? (
              <div className="mt-5 rounded-lg bg-slate-50 p-4"><p className="mb-2 text-[12.5px] font-semibold text-slate-700">Suggested bins</p>
                <div className="flex flex-wrap gap-2">{cur.suggestions.map((s) => <Badge key={s.id} tone="brand">{s.path} · {s.reason}{s.free_kg !== null ? ` · ${fmtNum(s.free_kg)} kg free` : ''}</Badge>)}</div></div>
            ) : null}
            <div className="mt-5 flex flex-wrap gap-2">
              {can('inventory.move') && ['available', 'rejected', 'damaged', 'reserved'].includes(r.state) && <Button variant="primary" icon={<MapPin className="size-4" />} onClick={() => setModal('move')}>Put away / move</Button>}
              {can('inventory.move') && ['available', 'qc_hold', 'damaged'].includes(r.state) && <Button icon={<Scissors className="size-4" />} onClick={() => setModal('split')}>Cut / split</Button>}
              {can('inventory.move') && r.state === 'available' && <Button variant="danger" icon={<ShieldAlert className="size-4" />} onClick={() => setModal('damage')}>Mark damaged</Button>}
              <PrintLabels rolls={[r]}>Reprint label</PrintLabels>
            </div>
          </Card>
        )}
        {cur?.history?.length ? (
          <Card title="Movement history" padded={false}>
            <ul className="divide-y divide-slate-100">
              {cur.history.map((h) => (
                <li key={h.id} className="flex items-start gap-3 px-5 py-2.5 text-[13px]">
                  <Badge>{humanize(h.movement_type)}</Badge>
                  <span className="flex-1 text-slate-700">{fmtNum(Number(h.kg))} kg{h.to_state ? ` → ${humanize(h.to_state)}` : ''}{h.to_location ? ` @ ${h.to_location}` : ''}{h.ref_no ? ` · ${h.ref_no}` : ''}{h.reason ? <span className="block text-[12px] text-slate-500">{h.reason}</span> : null}</span>
                  <span className="text-right text-[12px] text-slate-500">{h.by_name}<br />{fmtDateTime(h.at)}</span>
                </li>
              ))}
            </ul>
          </Card>
        ) : null}
      </div>
      {modal === 'move' && r && <MoveModal roll={r} suggestions={cur?.suggestions ?? []} onClose={() => setModal(null)} onDone={() => { setModal(null); void refresh(); }} />}
      {modal === 'split' && r && <SplitModal roll={r} onClose={() => setModal(null)} onDone={() => { setModal(null); void refresh(); }} />}
      <ConfirmDialog open={modal === 'damage'} onClose={() => setModal(null)} title={`Mark ${r?.barcode} damaged`} description="The roll moves to the damaged area and stops being available." requireReason tone="danger" confirmLabel="Mark damaged"
        onConfirm={async (reason) => { try { await api.post(`/inventory/rolls/${r!.barcode}/damage`, { reason }); setModal(null); void refresh(); } catch (e) { toast({ tone: 'error', title: (e as Error).message }); } }} />
    </>
  );
}

interface Loc { id: string; path: string; kind: string; purpose: string; status: string; rolls: number; kg: number }
export function MoveModal({ roll, suggestions, onClose, onDone }: { roll: { barcode: string; warehouse_id: string | null }; suggestions: { id: string; path: string }[]; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const map = useQuery({ queryKey: ['inv-map', roll.warehouse_id], queryFn: () => api.get<{ locations: Loc[] }>(`/inventory/warehouses/${roll.warehouse_id}/map`), enabled: !!roll.warehouse_id });
  const [loc, setLoc] = useState(suggestions[0]?.id ?? '');
  const [busy, setBusy] = useState(false);
  const options = (map.data?.locations ?? []).filter((l) => l.status === 'active' && (l.kind === 'bin' || l.purpose !== 'storage'));
  return (
    <Modal open onClose={onClose} title={`Move ${roll.barcode}`} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} disabled={!loc} onClick={async () => {
      setBusy(true);
      try { await api.post('/inventory/putaway', { barcodes: [roll.barcode], location_id: loc }); toast({ tone: 'success', title: 'Moved' }); onDone(); } catch (e) { toast({ tone: 'error', title: (e as Error).message }); } finally { setBusy(false); }
    }}>Move</Button></>}>
      <div className="space-y-3">
        {suggestions.length > 0 && <div className="flex flex-wrap gap-2">{suggestions.map((s) => <Button key={s.id} size="sm" variant={loc === s.id ? 'primary' : 'secondary'} onClick={() => setLoc(s.id)}>{s.path}</Button>)}</div>}
        <select className="input" value={loc} onChange={(e) => setLoc(e.target.value)}>
          <option value="">Choose a location…</option>
          {options.map((l) => <option key={l.id} value={l.id}>{l.path} · {humanize(l.purpose)}{l.rolls ? ` · ${l.rolls} rolls, ${fmtNum(l.kg)} kg` : ' · empty'}</option>)}
        </select>
      </div>
    </Modal>
  );
}

function SplitModal({ roll, onClose, onDone }: { roll: ScanRoll; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [kg, setKg] = useState('');
  const [reason, setReason] = useState('');
  const [child, setChild] = useState<ScanRoll | null>(null);
  return (
    <Modal open onClose={child ? onDone : onClose} title={`Cut ${roll.barcode}`} description="The cut piece becomes a new roll with its own barcode in the same lot; nothing is counted twice."
      footer={child ? <><PrintLabels rolls={[{ ...child, sku: roll.sku, product_name: roll.product_name, lot_no: roll.lot_no }]}>Print label</PrintLabels><Button variant="primary" onClick={onDone}>Done</Button></> : <><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!kg} onClick={async () => {
        try { setChild(await api.post<ScanRoll>(`/inventory/rolls/${roll.barcode}/split`, { kg: Number(kg), reason: reason || null })); } catch (e) { toast({ tone: 'error', title: (e as Error).message }); }
      }}>Cut</Button></>}>
      {child ? <Notice tone="success" title={`New roll ${child.barcode}`}>{fmtNum(Number(child.weight_kg))} kg cut from {roll.barcode}.</Notice> : (
        <div className="space-y-3">
          <Input label="Weight to cut" type="number" suffix="kg" hint={`Roll weighs ${fmtNum(Number(roll.weight_kg))} kg`} value={kg} onChange={(e) => setKg(e.target.value)} autoFocus />
          <Textarea label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Sample cut for customer" />
        </div>
      )}
    </Modal>
  );
}
