import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, ShieldAlert } from 'lucide-react';
import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Link } from '../../components/AppLink';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { fmtDate, fmtDateTime, fmtINR, fmtNum, humanize } from '../../lib/format';
import { DataTable, FilterSelect, SimpleTable } from '../../components/DataTable';
import { Modal, useToast } from '../../components/overlay';
import { Bar } from '../../components/scan';
import { useParties, useProducts, useWarehouses } from '../../components/business';
import { Badge, Button, Card, EmptyState, Input, Notice, PageHeader, Select, Skeleton, Stat, Tabs, Textarea } from '../../components/ui';

interface Avail { product_id: string; sku: string; product_name: string; warehouse_id: string; warehouse: string; physical: number; available: number; reserved: number; allocated: number; hold: number; damaged: number; rejected: number; in_transit_in: number; rolls_available: number }
interface AvailData { items: Avail[]; totals: Record<string, number>; at_mill: { product_id: string; sku: string; kg: number }[] }
interface Move { id: number; at: string; movement_type: string; barcode: string; lot_no: string; lot_id: string; sku: string; kg: number; moves_roll: boolean; from_warehouse: string | null; from_state: string | null; from_location: string | null; to_warehouse: string | null; to_state: string | null; to_location: string | null; ref_no: string | null; reason: string | null; by_name: string | null }
interface AgeLot { lot_id: string; lot_no: string; sku: string; product_name: string; received_date: string; age_days: number; kg: number; rolls: number; value: number | null; price_per_kg: number | null; cost_per_kg: number | null; last_out: string | null; bucket: string; slow: boolean; recommendation: string | null }
interface AgeData { buckets: { label: string; lots: number; kg: number; value: number }[]; slow_days: number; lots: AgeLot[] }
interface ShadeData { groups: { product_id: string; sku: string; product_name: string; shade_code: string; dye_lot: string; lots: number; rolls: number; kg: number; available_kg: number | null; lot_nos: string[] }[]; decisions: { id: string; customer_name: string; sku: string; shade_code: string; decision: string; note: string | null; recorded_by_name: string; recorded_at: string }[] }

type T = 'availability' | 'ledger' | 'ageing' | 'shades';
const MOVE_TYPES = ['inward', 'qc', 'putaway', 'move', 'reserve', 'release', 'pick', 'transfer_out', 'transfer_in', 'issue_to_mill', 'consume_at_mill', 'split', 'adjust_in', 'adjust_out', 'weight_adjust', 'damage', 'write_off'];

export function StockPage() {
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') as T) || 'availability';
  return (
    <>
      <PageHeader title="Stock ledger & availability" description="Balances are derived only from the immutable movement ledger — nothing is ever typed over. Physical = QC hold + available + reserved + allocated + damaged + rejected."
        breadcrumbs={[{ label: 'Inventory', to: '/inventory' }, { label: 'Stock & ledger' }]} />
      <Tabs className="mb-5" value={tab} onChange={(v) => setParams({ tab: v })} tabs={[{ value: 'availability', label: 'Availability' }, { value: 'ledger', label: 'Movement ledger' }, { value: 'ageing', label: 'Ageing & slow stock' }, { value: 'shades', label: 'Shades & dye lots' }]} />
      {tab === 'availability' && <Availability />}
      {tab === 'ledger' && <Ledger />}
      {tab === 'ageing' && <AgeingReport />}
      {tab === 'shades' && <Shades />}
    </>
  );
}

function Availability() {
  const wh = useWarehouses();
  const [w, setW] = useState('');
  const q = useQuery({ queryKey: ['inv-avail', w], queryFn: () => api.get<AvailData>(`/inventory/availability${w ? `?warehouse=${w}` : ''}`) });
  const verify = useQuery({ queryKey: ['inv-verify'], queryFn: () => api.get<{ ok: boolean; movements: number; rolls: number; mismatches: unknown[] }>('/inventory/ledger/verify') });
  const t = q.data?.totals;
  return (
    <>
      <div className="mb-5 grid grid-cols-2 gap-4 lg:grid-cols-6">
        <Stat label="Physical" value={fmtNum(t?.physical, 'kg')} />
        <Stat label="Available" value={fmtNum(t?.available, 'kg')} tone="success" />
        <Stat label="Reserved / allocated" value={fmtNum(t ? t.reserved + t.allocated : undefined, 'kg')} />
        <Stat label="QC hold / damaged / rejected" value={fmtNum(t ? t.hold + t.damaged + t.rejected : undefined, 'kg')} tone={t && t.hold + t.damaged + t.rejected > 0 ? 'warning' : undefined} />
        <Stat label="In transit" value={fmtNum(t?.in_transit_in, 'kg')} />
        <Stat label="At mills" value={fmtNum(t ? t.at_mill + t.grey_at_mills : undefined, 'kg')} sub={t ? `${fmtNum(t.at_mill)} issued · ${fmtNum(t.grey_at_mills)} grey direct` : undefined} />
      </div>
      {verify.data && (verify.data.ok
        ? <div className="mb-4 flex items-center gap-2 text-[12.5px] text-emerald-700"><CheckCircle2 className="size-4" />Ledger verified: {fmtNum(verify.data.movements)} movements reconcile exactly to {fmtNum(verify.data.rolls)} rolls.</div>
        : <div className="mb-4"><Notice tone="danger">The roll positions do not match the ledger in {verify.data.mismatches.length} place(s). Contact support.</Notice></div>)}
      <Card padded={false} actions={<select aria-label="Warehouse" className="input h-8 w-auto text-[13px]" value={w} onChange={(e) => setW(e.target.value)}><option value="">All warehouses</option>{(wh.data ?? []).map((x) => <option key={x.id} value={x.id}>{x.code}</option>)}</select>} title="By fabric and warehouse">
        {!q.data ? <Skeleton className="m-5 h-40" /> : (
          <SimpleTable rows={q.data.items} rowKey={(r) => `${r.product_id}${r.warehouse_id}`} empty={<EmptyState title="No stock" />} columns={[
            { key: 's', header: 'Fabric', render: (r) => <div><p className="font-mono text-[12.5px] font-semibold">{r.sku}</p><p className="max-w-[220px] truncate text-[12px] text-slate-500">{r.product_name}</p></div> },
            { key: 'w', header: 'Warehouse', render: (r) => r.warehouse },
            { key: 'p', header: 'Physical', align: 'right', render: (r) => <span className="font-semibold">{fmtNum(r.physical)}</span> },
            { key: 'a', header: 'Available', align: 'right', render: (r) => <span className="text-emerald-700">{fmtNum(r.available)}<span className="block text-[11.5px] text-slate-500">{r.rolls_available} rolls</span></span> },
            { key: 'r', header: 'Reserved', align: 'right', render: (r) => fmtNum(r.reserved + r.allocated) },
            { key: 'h', header: 'QC hold', align: 'right', render: (r) => fmtNum(r.hold) },
            { key: 'd', header: 'Damaged', align: 'right', render: (r) => fmtNum(r.damaged) },
            { key: 'rj', header: 'Rejected', align: 'right', render: (r) => fmtNum(r.rejected) },
            { key: 't', header: 'Incoming', align: 'right', render: (r) => fmtNum(r.in_transit_in) },
            { key: 'bar', header: '', render: (r) => <div className="w-28"><Bar value={r.available} max={r.physical} tone="success" /></div> },
          ]} />
        )}
      </Card>
      {q.data && q.data.at_mill.length > 0 && (
        <Card className="mt-6" title="Issued to mills" description="Rolls scanned out for job work and not yet returned" padded={false}>
          <SimpleTable rows={q.data.at_mill} rowKey={(r) => r.product_id} columns={[{ key: 's', header: 'Fabric', render: (r) => <span className="font-mono text-[12.5px]">{r.sku}</span> }, { key: 'k', header: 'KG at mills', align: 'right', render: (r) => fmtNum(r.kg) }]} />
        </Card>
      )}
    </>
  );
}

function Ledger() {
  const wh = useWarehouses();
  const prods = useProducts();
  const [filters, setFilters] = useState<Record<string, string>>({});
  return (
    <DataTable<Move> id="stock-ledger" endpoint="/inventory/ledger" filters={filters} onFiltersChange={setFilters} defaultSort={{ key: 'id', dir: 'desc' }} searchPlaceholder="Barcode, lot, SKU or reference…" pageSize={50}
      toolbar={<>
        <FilterSelect placeholder="All movements" value={filters.type} onChange={(v) => setFilters({ ...filters, type: v })} options={MOVE_TYPES.map((m) => ({ value: m, label: humanize(m) }))} />
        <FilterSelect placeholder="All warehouses" value={filters.warehouse} onChange={(v) => setFilters({ ...filters, warehouse: v })} options={(wh.data ?? []).map((w) => ({ value: w.id, label: w.code }))} />
        <FilterSelect placeholder="All fabrics" value={filters.product} onChange={(v) => setFilters({ ...filters, product: v })} options={(prods.data ?? []).map((p) => ({ value: p.id, label: p.sku }))} />
      </>}
      columns={[
        { key: 'id', header: '#', sort: 'id', csv: (r) => r.id, render: (r) => <span className="text-[12px] text-slate-400 tabular">{r.id}</span> },
        { key: 'at', header: 'When', sort: 'at', csv: (r) => r.at, render: (r) => <span className="text-[12.5px]">{fmtDateTime(r.at)}</span> },
        { key: 't', header: 'Movement', sort: 'movement_type', csv: (r) => r.movement_type, render: (r) => <Badge tone={['adjust_out', 'write_off', 'damage'].includes(r.movement_type) ? 'danger' : ['inward', 'adjust_in', 'transfer_in'].includes(r.movement_type) ? 'success' : 'neutral'}>{humanize(r.movement_type)}</Badge> },
        { key: 'b', header: 'Roll / lot', csv: (r) => r.barcode, render: (r) => <div><p className="font-mono text-[12px]">{r.barcode}</p><Link to={`/inventory/lots/${r.lot_id}`} className="link text-[11.5px]">{r.sku}</Link></div> },
        { key: 'kg', header: 'KG', align: 'right', sort: 'kg', csv: (r) => r.kg, render: (r) => <span className="tabular">{fmtNum(Number(r.kg))}{!r.moves_roll && <span className="block text-[11px] text-slate-400">weight only</span>}</span> },
        { key: 'f', header: 'From', csv: (r) => `${r.from_warehouse ?? ''} ${r.from_state ?? ''}`, render: (r) => (r.from_state ? <span className="text-[12.5px]">{r.from_warehouse} · {humanize(r.from_state)}{r.from_location && <span className="block font-mono text-[11px] text-slate-500">{r.from_location}</span>}</span> : <span className="text-slate-300">—</span>) },
        { key: 'to', header: 'To', csv: (r) => `${r.to_warehouse ?? ''} ${r.to_state ?? ''}`, render: (r) => (r.to_state ? <span className="text-[12.5px]">{r.to_warehouse ?? '—'} · {humanize(r.to_state)}{r.to_location && <span className="block font-mono text-[11px] text-slate-500">{r.to_location}</span>}</span> : <span className="text-slate-300">—</span>) },
        { key: 'ref', header: 'Reference', csv: (r) => r.ref_no, render: (r) => <span className="text-[12.5px]">{r.ref_no ?? '—'}{r.reason && <span className="block max-w-[220px] truncate text-slate-500" title={r.reason}>{r.reason}</span>}</span> },
        { key: 'u', header: 'By', csv: (r) => r.by_name, render: (r) => <span className="text-[12.5px]">{r.by_name}</span> },
      ]}
      empty={{ title: 'No movements' }} />
  );
}

function AgeingReport() {
  const wh = useWarehouses();
  const [w, setW] = useState('');
  const [onlySlow, setOnlySlow] = useState(false);
  const q = useQuery({ queryKey: ['inv-ageing', w], queryFn: () => api.get<AgeData>(`/inventory/ageing${w ? `?warehouse=${w}` : ''}`) });
  if (!q.data) return <Skeleton className="h-80" />;
  const max = Math.max(1, ...q.data.buckets.map((b) => b.kg));
  const rows = onlySlow ? q.data.lots.filter((l) => l.slow || l.recommendation) : q.data.lots;
  return (
    <>
      <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        {q.data.buckets.map((b, i) => (
          <div key={b.label} className="card p-4">
            <p className="text-[12px] text-slate-500">{b.label} days</p>
            <p className="text-[20px] font-semibold tabular">{fmtNum(b.kg)} kg</p>
            <p className="mb-2 text-[12px] text-slate-500">{b.lots} lots · {fmtINR(b.value)}</p>
            <Bar value={b.kg} max={max} tone={i >= 4 ? 'danger' : i === 3 ? 'warning' : 'brand'} />
          </div>
        ))}
      </div>
      <Card title="Lots by age" description={`Slow = older than ${q.data.slow_days} days with nothing sold, transferred or issued in that time.`} padded={false}
        actions={<div className="flex items-center gap-2"><label className="flex items-center gap-1.5 text-[12.5px]"><input type="checkbox" checked={onlySlow} onChange={(e) => setOnlySlow(e.target.checked)} />Slow and aged only</label><select className="input h-8 w-auto text-[13px]" value={w} onChange={(e) => setW(e.target.value)}><option value="">All warehouses</option>{(wh.data ?? []).map((x) => <option key={x.id} value={x.id}>{x.code}</option>)}</select></div>}>
        <SimpleTable rows={rows} rowKey={(r) => r.lot_id} empty={<EmptyState title="No slow stock" />} columns={[
          { key: 'l', header: 'Lot', render: (r) => <Link className="link font-mono text-[12.5px]" to={`/inventory/lots/${r.lot_id}`}>{r.lot_no}</Link> },
          { key: 's', header: 'Fabric', render: (r) => <span className="font-mono text-[12.5px]">{r.sku}</span> },
          { key: 'a', header: 'Age', align: 'right', render: (r) => <span className={r.age_days > 180 ? 'font-semibold text-rose-600' : r.age_days > 90 ? 'text-amber-700' : ''}>{r.age_days} d<span className="block text-[11.5px] text-slate-500">{fmtDate(r.received_date)}</span></span> },
          { key: 'k', header: 'Stock', align: 'right', render: (r) => `${fmtNum(r.kg)} kg · ${r.rolls}` },
          { key: 'v', header: 'Value at cost', align: 'right', render: (r) => fmtINR(r.value) },
          { key: 'o', header: 'Last out', render: (r) => (r.last_out ? fmtDate(r.last_out) : <span className="text-slate-400">never</span>) },
          { key: 'r', header: 'Recommendation', render: (r) => (r.recommendation ? <span className="flex items-center gap-1.5 text-[12.5px] text-amber-800"><ShieldAlert className="size-3.5 shrink-0" />{r.recommendation}</span> : <span className="text-slate-400">—</span>) },
        ]} />
      </Card>
    </>
  );
}

function Shades() {
  const { can } = useAuth();
  const prods = useProducts();
  const [p, setP] = useState('');
  const [rec, setRec] = useState(false);
  const q = useQuery({ queryKey: ['inv-shades', p], queryFn: () => api.get<ShadeData>(`/inventory/shades${p ? `?product=${p}` : ''}`) });
  return (
    <>
      <Notice tone="info">Rolls of one fabric from different dye lots can differ visibly. Reservations are blocked from mixing dye lots unless a reason is given, and shades a customer has rejected are never reserved for that customer.</Notice>
      <div className="mt-5 grid grid-cols-1 gap-6 xl:grid-cols-3">
        <Card title="Shade groups in stock" padded={false} className="xl:col-span-2" actions={<select aria-label="Warehouse" className="input h-8 w-auto text-[13px]" value={p} onChange={(e) => setP(e.target.value)}><option value="">All fabrics</option>{(prods.data ?? []).map((x) => <option key={x.id} value={x.id}>{x.sku}</option>)}</select>}>
          {!q.data ? <Skeleton className="m-5 h-32" /> : (
            <SimpleTable rows={q.data.groups} rowKey={(r) => `${r.product_id}${r.shade_code}${r.dye_lot}`} columns={[
              { key: 's', header: 'Fabric', render: (r) => <span className="font-mono text-[12.5px]">{r.sku}</span> },
              { key: 'd', header: 'Dye lot', render: (r) => <span className="font-semibold">{r.dye_lot}</span> },
              { key: 'sh', header: 'Shade', render: (r) => r.shade_code },
              { key: 'k', header: 'Stock', align: 'right', render: (r) => `${fmtNum(r.kg)} kg · ${r.rolls}` },
              { key: 'a', header: 'Available', align: 'right', render: (r) => fmtNum(r.available_kg ?? 0) },
              { key: 'l', header: 'Lots', render: (r) => <span className="font-mono text-[11.5px] text-slate-500">{r.lot_nos.join(', ')}</span> },
            ]} />
          )}
        </Card>
        <Card title="Customer shade decisions" padded={false} actions={can('inventory.reserve') && <Button size="sm" onClick={() => setRec(true)}>Record decision</Button>}>
          {q.data?.decisions.length ? (
            <ul className="divide-y divide-slate-100">{q.data.decisions.map((d) => (
              <li key={d.id} className="px-5 py-3 text-[13px]"><div className="flex items-center justify-between"><span className="font-medium">{d.customer_name}</span><Badge tone={d.decision === 'accepted' ? 'success' : 'danger'}>{humanize(d.decision)}</Badge></div><p className="text-slate-600">{d.sku} · shade {d.shade_code}</p>{d.note && <p className="text-[12px] text-slate-500">“{d.note}”</p>}<p className="text-[11.5px] text-slate-400">{d.recorded_by_name} · {fmtDate(d.recorded_at)}</p></li>
            ))}</ul>
          ) : <EmptyState title="No decisions recorded" />}
        </Card>
      </div>
      {rec && <ShadeDecisionModal onClose={() => setRec(false)} onDone={() => { setRec(false); q.refetch(); }} />}
    </>
  );
}

function ShadeDecisionModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const customers = useParties('customer');
  const prods = useProducts();
  const [v, setV] = useState({ customer_id: '', product_id: '', shade_code: '', decision: 'accepted', note: '' });
  return (
    <Modal open onClose={onClose} title="Customer shade decision" footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={async () => {
      try { await api.post('/inventory/shade-approvals', { ...v, note: v.note || null }); onDone(); } catch (e) { toast({ tone: 'error', title: (e as Error).message }); }
    }}>Save</Button></>}>
      <div className="grid grid-cols-2 gap-3">
        <Select className="col-span-2" label="Customer" value={v.customer_id} onChange={(e) => setV({ ...v, customer_id: e.target.value })} options={[{ value: '', label: 'Choose…' }, ...(customers.data ?? []).map((c) => ({ value: c.id, label: c.legal_name }))]} />
        <Select label="Fabric" value={v.product_id} onChange={(e) => setV({ ...v, product_id: e.target.value })} options={[{ value: '', label: 'Choose…' }, ...(prods.data ?? []).map((p) => ({ value: p.id, label: p.sku }))]} />
        <Input label="Shade code" value={v.shade_code} onChange={(e) => setV({ ...v, shade_code: e.target.value })} />
        <Select label="Decision" value={v.decision} onChange={(e) => setV({ ...v, decision: e.target.value })} options={[{ value: 'accepted', label: 'Accepted' }, { value: 'rejected', label: 'Rejected' }]} />
        <Textarea className="col-span-2" label="Note" value={v.note} onChange={(e) => setV({ ...v, note: e.target.value })} />
      </div>
    </Modal>
  );
}
