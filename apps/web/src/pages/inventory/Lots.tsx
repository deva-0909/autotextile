import { useQuery, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { ArrowDown, ArrowRight, Factory, PackageOpen, Tag, Truck } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, invalidatePrefix } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { fmtDate, fmtDateTime, fmtINR, fmtNum, humanize } from '../../lib/format';
import { DataTable, FilterSelect, SimpleTable } from '../../components/DataTable';
import { Modal, useToast } from '../../components/overlay';
import { PrintLabels } from '../../components/scan';
import { useProducts, useWarehouses } from '../../components/business';
import { Badge, Button, Card, EmptyState, ErrorState, Input, KeyValue, Notice, PageHeader, Segmented, Skeleton, StatusBadge, Tabs, Textarea, Timeline } from '../../components/ui';

export interface LotRow { id: string; lot_no: string; sku: string; product_name: string; source_type: string; source_ref: string; party_name: string | null; shade_code: string | null; dye_lot: string | null; grade: string | null; qc_status: string; cost_per_kg: number | null; price_per_kg: number | null; received_date: string; kg: number; available_kg: number; rolls: number; price_pending: string | null }
interface LotRef { id: string; lot_no: string; sku: string; product_name: string; source_type: string; source_ref: string; party_name: string | null; received_date: string; cost_per_kg?: number | null }
interface Roll { id: string; barcode: string; roll_no: number; parent_roll_id: string | null; weight_kg: number; initial_kg: number; state: string; warehouse_id: string | null; location_path: string | null; holder_ref: string | null; grade: string | null; gsm: number | null; width_in: number | null; shade_code: string | null; dye_lot: string | null; defects: string[] }
interface Movement { id: number; at: string; movement_type: string; barcode: string; kg: number; from_state: string | null; to_state: string | null; from_location: string | null; to_location: string | null; ref_type: string | null; ref_id: string | null; ref_no: string | null; reason: string | null; by_name: string | null }
interface Price { id: string; price_per_kg: number; previous_price: number | null; cost_per_kg: number | null; margin_pct: number | null; status: string; reason: string | null; requested_by_name: string; requested_at: string; decided_by_name: string | null; decided_at: string | null; decision_comment: string | null }
interface LotDetail extends Omit<LotRow, 'rolls'> { hsn_code: string | null; supplier_lot_ref: string | null; inward_id: string | null; rolls: Roll[]; parents: LotRef[]; children: LotRef[]; prices: Price[]; movements: Movement[]; inward: { id: string; number: string; source_type: string; source_ref: string; warehouse_name: string } | null; transfers: { id: string; number: string; status: string; from_warehouse_name: string; to_warehouse_name: string; document_type: string; document_no: string | null }[]; summary: { rolls: number; kg: number; available_kg: number } }

const SRC_ICON: Record<string, ReactNode> = { po_receipt: <PackageOpen className="size-4" />, job_return: <Factory className="size-4" />, opening: <Tag className="size-4" /> };
const SRC_LABEL: Record<string, string> = { po_receipt: 'Purchase receipt', job_return: 'Mill return', opening: 'Opening stock' };

export function LotsPage() {
  const nav = useNavigate();
  const prods = useProducts();
  const wh = useWarehouses();
  const [filters, setFilters] = useState<Record<string, string>>({ in_stock: 'true' });
  return (
    <>
      <PageHeader title="Lots & rolls" description="Each lot is one batch of one fabric from one source. Open a lot for its genealogy: where it came from, every roll and every movement." breadcrumbs={[{ label: 'Inventory', to: '/inventory' }, { label: 'Lots' }]} />
      <DataTable<LotRow> id="lots" endpoint="/inventory/lots" filters={filters} onFiltersChange={setFilters} defaultSort={{ key: 'received_date', dir: 'desc' }} onRowClick={(r) => nav(`/inventory/lots/${r.id}`)} searchPlaceholder="Lot, SKU, party, shade or dye lot…"
        toolbar={<>
          <FilterSelect placeholder="All fabrics" value={filters.product} onChange={(v) => setFilters({ ...filters, product: v })} options={(prods.data ?? []).map((p) => ({ value: p.id, label: p.sku }))} />
          <FilterSelect placeholder="Any warehouse" value={filters.warehouse} onChange={(v) => setFilters({ ...filters, warehouse: v })} options={(wh.data ?? []).map((w) => ({ value: w.id, label: w.code }))} />
          <FilterSelect placeholder="Any QC status" value={filters.qc} onChange={(v) => setFilters({ ...filters, qc: v })} options={['pending', 'passed', 'partial', 'failed'].map((s) => ({ value: s, label: humanize(s) }))} />
          <FilterSelect placeholder="In stock or not" value={filters.in_stock} onChange={(v) => setFilters({ ...filters, in_stock: v })} options={[{ value: 'true', label: 'In stock only' }]} />
        </>}
        columns={[
          { key: 'lot', header: 'Lot', sort: 'lot_no', csv: (r) => r.lot_no, render: (r) => <span className="font-mono text-[12.5px] font-semibold text-slate-900">{r.lot_no}</span> },
          { key: 'sku', header: 'Fabric', sort: 'sku', csv: (r) => r.sku, render: (r) => <div><p className="font-mono text-[12.5px]">{r.sku}</p><p className="max-w-[220px] truncate text-[12px] text-slate-500">{r.product_name}</p></div> },
          { key: 'src', header: 'Source', csv: (r) => r.source_ref, render: (r) => <div className="text-[12.5px]"><Badge tone={r.source_type === 'job_return' ? 'violet' : r.source_type === 'po_receipt' ? 'brand' : 'neutral'}>{SRC_LABEL[r.source_type]}</Badge><p className="mt-0.5 text-slate-500">{r.party_name ?? r.source_ref}</p></div> },
          { key: 'sh', header: 'Dye lot / shade', csv: (r) => r.dye_lot, render: (r) => <span className="text-[12.5px]">{r.dye_lot ?? '—'}{r.shade_code ? ` · ${r.shade_code}` : ''}</span> },
          { key: 'q', header: 'QC', csv: (r) => r.qc_status, render: (r) => <div className="flex items-center gap-1.5"><StatusBadge status={r.qc_status} />{r.grade && <Badge>{r.grade}</Badge>}</div> },
          { key: 'kg', header: 'In stock', align: 'right', sort: 'kg', csv: (r) => r.kg, render: (r) => <div><p className="tabular">{fmtNum(r.kg)} kg</p><p className="text-[12px] text-slate-500">{r.rolls} rolls · {fmtNum(r.available_kg)} free</p></div> },
          { key: 'p', header: 'Price / kg', align: 'right', sort: 'price_per_kg', csv: (r) => r.price_per_kg, render: (r) => <div>{r.price_per_kg ? `₹${fmtNum(Number(r.price_per_kg))}` : <span className="text-amber-700">Not priced</span>}{r.price_pending && <p className="text-[11.5px] text-amber-700">change pending</p>}</div> },
          { key: 'd', header: 'Received', sort: 'received_date', csv: (r) => r.received_date, render: (r) => fmtDate(r.received_date) },
        ]}
        empty={{ title: 'No lots match' }} />
    </>
  );
}

function LotNode({ lot, current }: { lot: LotRef; current?: boolean }) {
  const body = (
    <div className={clsx('rounded-lg border px-3 py-2 text-left', current ? 'border-brand-400 bg-brand-50 ring-2 ring-brand-500/20' : 'border-slate-200 bg-white hover:border-slate-300')}>
      <p className="flex items-center gap-1.5 text-[11.5px] text-slate-500">{SRC_ICON[lot.source_type]}{SRC_LABEL[lot.source_type]}</p>
      <p className="font-mono text-[12.5px] font-semibold text-slate-900">{lot.lot_no}</p>
      <p className="text-[12px] text-slate-600">{lot.sku}</p>
      <p className="text-[11.5px] text-slate-500">{lot.party_name ?? lot.source_ref}</p>
    </div>
  );
  return current ? body : <Link to={`/inventory/lots/${lot.id}`}>{body}</Link>;
}

export function LotDetailPage() {
  const { id = '' } = useParams();
  const { can } = useAuth();
  const [tab, setTab] = useState<'rolls' | 'ledger' | 'prices'>('rolls');
  const [pricing, setPricing] = useState(false);
  const q = useQuery({ queryKey: ['inv-lot', id], queryFn: () => api.get<LotDetail>(`/inventory/lots/${id}`) });
  if (q.isError) return <ErrorState error={q.error} />;
  const l = q.data;
  if (!l) return <Skeleton className="h-96" />;
  const rolls = l.rolls;
  const margin = l.price_per_kg && l.cost_per_kg ? Math.round(((Number(l.price_per_kg) - Number(l.cost_per_kg)) / Number(l.price_per_kg)) * 1000) / 10 : null;
  return (
    <>
      <PageHeader title={<span className="font-mono">{l.lot_no}</span>} description={`${l.sku} · ${l.product_name}`} meta={<><StatusBadge status={l.qc_status} />{l.grade && <Badge>Grade {l.grade}</Badge>}</>}
        breadcrumbs={[{ label: 'Inventory', to: '/inventory' }, { label: 'Lots', to: '/inventory/lots' }, { label: l.lot_no }]}
        actions={<>
          <PrintLabels rolls={rolls.filter((r) => ['qc_hold', 'available', 'reserved', 'damaged', 'rejected'].includes(r.state)).map((r) => ({ ...r, sku: l.sku, product_name: l.product_name, lot_no: l.lot_no }))}>Print labels</PrintLabels>
          {can('inventory.price.tag') && <Button variant="primary" icon={<Tag className="size-4" />} onClick={() => setPricing(true)}>{l.price_per_kg ? 'Change price' : 'Set price'}</Button>}
        </>} />
      <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-5">
        <div className="card p-4"><p className="text-[12px] text-slate-500">In stock</p><p className="text-[22px] font-semibold tabular">{fmtNum(l.summary.kg)} kg</p><p className="text-[12px] text-slate-500">{l.summary.rolls} rolls</p></div>
        <div className="card p-4"><p className="text-[12px] text-slate-500">Available</p><p className="text-[22px] font-semibold tabular">{fmtNum(l.summary.available_kg)} kg</p></div>
        <div className="card p-4"><p className="text-[12px] text-slate-500">Cost / kg</p><p className="text-[22px] font-semibold tabular">{l.cost_per_kg ? `₹${fmtNum(Number(l.cost_per_kg))}` : '—'}</p><p className="text-[12px] text-slate-500">{l.source_type === 'job_return' ? 'Grey + processing, after yield' : 'From the purchase order'}</p></div>
        <div className="card p-4"><p className="text-[12px] text-slate-500">Selling price / kg</p><p className="text-[22px] font-semibold tabular">{l.price_per_kg ? `₹${fmtNum(Number(l.price_per_kg))}` : '—'}</p><p className="text-[12px] text-slate-500">{margin !== null ? `${margin}% margin` : 'Not priced'}</p></div>
        <div className="card p-4"><p className="text-[12px] text-slate-500">Received</p><p className="text-[16px] font-semibold">{fmtDate(l.received_date)}</p><p className="text-[12px] text-slate-500">Dye lot {l.dye_lot ?? '—'}{l.shade_code ? ` · ${l.shade_code}` : ''}</p></div>
      </div>
      <Card title="Genealogy" description="Where this lot came from and what it became" className="mb-6">
        <div className="flex flex-col items-stretch gap-3 lg:flex-row lg:items-center">
          {l.parents.length > 0 && (<><div className="flex flex-col gap-2">{l.parents.map((p) => <LotNode key={p.id} lot={p} />)}</div><ArrowRight className="hidden size-5 shrink-0 text-slate-300 lg:block" /><ArrowDown className="mx-auto size-5 text-slate-300 lg:hidden" /></>)}
          {l.inward && (<><Link to={`/inventory/inward/${l.inward.id}`} className="rounded-lg border border-dashed border-slate-300 px-3 py-2 text-[12px] text-slate-600 hover:border-slate-400"><p className="font-semibold text-slate-800">{l.inward.number}</p><p>{l.inward.source_ref}</p><p className="text-slate-500">→ {l.inward.warehouse_name}</p></Link><ArrowRight className="hidden size-5 shrink-0 text-slate-300 lg:block" /></>)}
          <LotNode lot={l} current />
          {l.children.length > 0 && (<><ArrowRight className="hidden size-5 shrink-0 text-slate-300 lg:block" /><div className="flex flex-col gap-2">{l.children.map((c) => <LotNode key={c.id} lot={c} />)}</div></>)}
          {l.transfers.length > 0 && (<div className="ml-auto flex flex-col gap-2">{l.transfers.map((t) => <Link key={t.id} to={`/inventory/transfers/${t.id}`} className="flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-[12px] hover:border-slate-300"><Truck className="size-4 text-slate-400" /><span><span className="font-semibold">{t.number}</span> {t.from_warehouse_name} → {t.to_warehouse_name}<span className="block text-slate-500">{t.document_no ?? humanize(t.document_type)} · {humanize(t.status)}</span></span></Link>)}</div>)}
        </div>
        {!l.parents.length && l.source_type === 'job_return' && <p className="mt-3 text-[12.5px] text-slate-500">Processed from grey that was delivered straight to the mill by the supplier (no warehouse lot).</p>}
      </Card>
      <Tabs value={tab} onChange={setTab} tabs={[{ value: 'rolls', label: `Rolls (${rolls.length})` }, { value: 'ledger', label: `Movements (${l.movements.length})` }, { value: 'prices', label: `Price history (${l.prices.length})` }]} className="mb-4" />
      {tab === 'rolls' && (
        <Card padded={false}>
          <SimpleTable rows={rolls} rowKey={(r) => r.id} columns={[
            { key: 'b', header: 'Barcode', render: (r) => <div><span className="font-mono text-[12.5px] font-semibold">{r.barcode}</span>{r.parent_roll_id && <p className="text-[11.5px] text-slate-500">cut from {rolls.find((x) => x.id === r.parent_roll_id)?.barcode ?? 'another roll'}</p>}</div> },
            { key: 'kg', header: 'KG', align: 'right', render: (r) => <span className="tabular">{fmtNum(Number(r.weight_kg))}{Number(r.weight_kg) !== Number(r.initial_kg) && <span className="block text-[11.5px] text-slate-500">of {fmtNum(Number(r.initial_kg))}</span>}</span> },
            { key: 'g', header: 'Grade', render: (r) => r.grade ?? '—' },
            { key: 'm', header: 'GSM / width', render: (r) => `${r.gsm ?? '—'} / ${r.width_in ? `${r.width_in}"` : '—'}` },
            { key: 'sh', header: 'Shade', render: (r) => r.shade_code ?? '—' },
            { key: 'd', header: 'Defects', render: (r) => (r.defects.length ? r.defects.join(', ') : '—') },
            { key: 's', header: 'State', render: (r) => <StatusBadge status={r.state} /> },
            { key: 'l', header: 'Where', render: (r) => <span className="font-mono text-[12px]">{r.location_path ?? r.holder_ref ?? '—'}</span> },
          ]} />
        </Card>
      )}
      {tab === 'ledger' && (
        <Card padded={false}>
          <SimpleTable rows={[...l.movements].reverse()} rowKey={(m) => String(m.id)} columns={[
            { key: 'at', header: 'When', render: (m) => <span className="text-[12.5px]">{fmtDateTime(m.at)}</span> },
            { key: 't', header: 'Movement', render: (m) => <Badge>{humanize(m.movement_type)}</Badge> },
            { key: 'b', header: 'Roll', render: (m) => <span className="font-mono text-[12px]">{m.barcode}</span> },
            { key: 'kg', header: 'KG', align: 'right', render: (m) => fmtNum(Number(m.kg)) },
            { key: 'f', header: 'From → to', render: (m) => <span className="text-[12.5px]">{m.from_state ? humanize(m.from_state) : '—'}{m.from_location ? ` @${m.from_location}` : ''} → {m.to_state ? humanize(m.to_state) : '—'}{m.to_location ? ` @${m.to_location}` : ''}</span> },
            { key: 'r', header: 'Reference', render: (m) => <span className="text-[12.5px]">{m.ref_no ?? '—'}{m.reason && <span className="block text-slate-500">{m.reason}</span>}</span> },
            { key: 'u', header: 'By', render: (m) => m.by_name },
          ]} />
        </Card>
      )}
      {tab === 'prices' && (
        <Card>{l.prices.length ? <Timeline items={l.prices.map((p) => ({
          id: p.id, tone: p.status === 'approved' ? 'success' : p.status === 'pending' ? 'warning' : p.status === 'rejected' ? 'danger' : 'neutral',
          title: <span>₹{fmtNum(Number(p.price_per_kg))}/kg {p.previous_price ? <span className="text-slate-500">(was ₹{fmtNum(Number(p.previous_price))})</span> : null} <StatusBadge status={p.status} /></span>,
          detail: <>{p.margin_pct !== null && `Margin ${p.margin_pct}% · `}{p.reason}{p.decided_by_name && <span className="block">Decided by {p.decided_by_name}{p.decision_comment ? `: “${p.decision_comment}”` : ''}</span>}</>,
          meta: `${p.requested_by_name} · ${fmtDateTime(p.requested_at)}`,
        }))} /> : <EmptyState title="Not priced yet" />}</Card>
      )}
      {pricing && <PriceModal lot={l} onClose={() => setPricing(false)} onDone={() => { setPricing(false); q.refetch(); }} />}
    </>
  );
}

export function PriceModal({ lot, onClose, onDone }: { lot: { id: string; lot_no: string; sku: string; cost_per_kg: number | null; price_per_kg: number | null }; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [price, setPrice] = useState(lot.price_per_kg ? String(lot.price_per_kg) : '');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const p = Number(price);
  const cost = lot.cost_per_kg ? Number(lot.cost_per_kg) : null;
  const margin = cost && p ? Math.round(((p - cost) / p) * 1000) / 10 : null;
  const change = lot.price_per_kg !== null;
  return (
    <Modal open onClose={onClose} title={`${change ? 'Change' : 'Set'} selling price · ${lot.lot_no}`} description={change ? 'Changes go to a checker; the current price holds until approved.' : 'The first price is set directly unless it is below the minimum margin.'}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} disabled={!p} onClick={async () => {
        setBusy(true);
        try {
          const r = await api.post<{ status: string }>(`/inventory/lots/${lot.id}/price`, { price_per_kg: p, reason: reason || null });
          toast({ tone: 'success', title: r.status === 'pending' ? 'Sent for approval' : 'Price set' });
          invalidatePrefix(qc, 'inv'); onDone();
        } catch (e) { toast({ tone: 'error', title: (e as Error).message }); } finally { setBusy(false); }
      }}>{change ? 'Request change' : 'Set price'}</Button></>}>
      <div className="space-y-4">
        <KeyValue columns={3} items={[{ label: 'Cost / kg', value: cost ? fmtINR(cost) : 'Unknown' }, { label: 'Current price', value: lot.price_per_kg ? fmtINR(Number(lot.price_per_kg)) : '—' }, { label: 'Margin at new price', value: margin === null ? '—' : <span className={margin < 8 ? 'font-semibold text-rose-600' : 'font-semibold text-emerald-700'}>{margin}%</span> }]} />
        <Input label="Selling price per kg" type="number" prefix="₹" value={price} onChange={(e) => setPrice(e.target.value)} autoFocus />
        <Textarea label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} hint="Required for changes and for any price below the minimum margin" />
      </div>
    </Modal>
  );
}

interface Untagged { id: string; lot_no: string; sku: string; product_name: string; grade: string | null; qc_status: string; cost_per_kg: number | null; received_date: string; party_name: string | null; kg: number; rolls: number }
interface Tag_ { id: string; lot_id: string; lot_no: string; sku: string; product_name: string; price_per_kg: number; previous_price: number | null; cost_per_kg: number | null; margin_pct: number | null; status: string; reason: string | null; requested_by_name: string; requested_at: string; decided_by_name: string | null; kg: number | null }

export function PricingPage() {
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') as 'untagged' | 'pending' | 'history') || 'untagged';
  const { can } = useAuth();
  const untagged = useQuery({ queryKey: ['inv-untagged'], queryFn: () => api.get<Untagged[]>('/inventory/price-tags/untagged'), enabled: tab === 'untagged' });
  const tags = useQuery({ queryKey: ['inv-tags', tab], queryFn: () => api.get<Tag_[]>(`/inventory/price-tags${tab === 'pending' ? '?status=pending' : ''}`), enabled: tab !== 'untagged' });
  const [lot, setLot] = useState<Untagged | null>(null);
  return (
    <>
      <PageHeader title="Price tagging" description="Selling price per kg is tagged at lot level when stock arrives. Price changes and any price below the minimum margin need a checker; every price is kept in the lot’s history."
        breadcrumbs={[{ label: 'Inventory', to: '/inventory' }, { label: 'Price tagging' }]} />
      <div className="mb-4"><Segmented value={tab} onChange={(v) => setParams({ tab: v })} options={[{ value: 'untagged', label: 'Needs a price' }, { value: 'pending', label: 'Awaiting approval' }, { value: 'history', label: 'All prices' }]} /></div>
      {tab === 'untagged' ? (
        <Card padded={false}>
          {!untagged.data ? <Skeleton className="m-5 h-40" /> : (
            <SimpleTable rows={untagged.data} rowKey={(r) => r.id} empty={<EmptyState icon={<Tag className="size-5" />} title="Every lot in stock has a price" />} columns={[
              { key: 'l', header: 'Lot', render: (r) => <Link className="link font-mono text-[12.5px]" to={`/inventory/lots/${r.id}`}>{r.lot_no}</Link> },
              { key: 's', header: 'Fabric', render: (r) => <div><p className="font-mono text-[12.5px]">{r.sku}</p><p className="text-[12px] text-slate-500">{r.party_name}</p></div> },
              { key: 'q', header: 'QC', render: (r) => <div className="flex gap-1"><StatusBadge status={r.qc_status} />{r.grade && <Badge>{r.grade}</Badge>}</div> },
              { key: 'kg', header: 'Stock', align: 'right', render: (r) => `${fmtNum(r.kg)} kg · ${r.rolls}` },
              { key: 'c', header: 'Cost / kg', align: 'right', render: (r) => (r.cost_per_kg ? `₹${fmtNum(Number(r.cost_per_kg))}` : '—') },
              { key: 'd', header: 'Received', render: (r) => fmtDate(r.received_date) },
              { key: 'a', header: '', align: 'right', render: (r) => (can('inventory.price.tag') ? <Button size="sm" variant="primary" onClick={() => setLot(r)}>Set price</Button> : null) },
            ]} />
          )}
        </Card>
      ) : (
        <Card padded={false}>
          {!tags.data ? <Skeleton className="m-5 h-40" /> : (
            <SimpleTable rows={tags.data} rowKey={(r) => r.id} empty={<EmptyState title={tab === 'pending' ? 'No price changes waiting' : 'No prices yet'} />} columns={[
              { key: 'l', header: 'Lot', render: (r) => <Link className="link font-mono text-[12.5px]" to={`/inventory/lots/${r.lot_id}`}>{r.lot_no}</Link> },
              { key: 's', header: 'Fabric', render: (r) => <span className="font-mono text-[12.5px]">{r.sku}</span> },
              { key: 'p', header: 'Price / kg', align: 'right', render: (r) => <span>₹{fmtNum(Number(r.price_per_kg))}{r.previous_price && <span className="block text-[11.5px] text-slate-500">was ₹{fmtNum(Number(r.previous_price))}</span>}</span> },
              { key: 'm', header: 'Margin', align: 'right', render: (r) => (r.margin_pct === null ? '—' : <span className={Number(r.margin_pct) < 8 ? 'font-semibold text-rose-600' : ''}>{r.margin_pct}%</span>) },
              { key: 'r', header: 'Reason', render: (r) => <span className="text-[12.5px] text-slate-600">{r.reason ?? '—'}</span> },
              { key: 'b', header: 'Requested', render: (r) => <span className="text-[12.5px]">{r.requested_by_name}<span className="block text-slate-500">{fmtDateTime(r.requested_at)}</span></span> },
              { key: 'st', header: 'Status', render: (r) => <StatusBadge status={r.status} /> },
            ]} />
          )}
          {tab === 'pending' && <div className="border-t border-slate-100 px-5 py-3"><Notice tone="info">Approve or reject in the <Link className="link" to="/approvals">Approvals inbox</Link> — the person who proposed a price can’t approve it.</Notice></div>}
        </Card>
      )}
      {lot && <PriceModal lot={{ ...lot, price_per_kg: null }} onClose={() => setLot(null)} onDone={() => { setLot(null); untagged.refetch(); }} />}
    </>
  );
}

interface MapLoc { id: string; parent_id: string | null; kind: 'zone' | 'aisle' | 'rack' | 'bin'; code: string; path: string; name: string | null; purpose: string; capacity_kg: number | null; status: string; rolls: number; kg: number; lots: number; skus: string | null }
interface MapData { warehouse: { id: string; code: string; name: string }; unplaced: { rolls: number; kg: number }; locations: MapLoc[] }

export function WarehouseMapPage() {
  const wh = useWarehouses();
  const [whId, setWhId] = useState('');
  const id = whId || wh.data?.[0]?.id || '';
  const q = useQuery({ queryKey: ['inv-map', id], queryFn: () => api.get<MapData>(`/inventory/warehouses/${id}/map`), enabled: !!id });
  const [bin, setBin] = useState<MapLoc | null>(null);
  const rolls = useQuery({ queryKey: ['inv-bin', bin?.id], queryFn: () => api.get<Roll[] & { lot_no: string; sku: string }[]>(`/inventory/rolls?location=${bin!.id}`), enabled: !!bin });
  const locs = q.data?.locations ?? [];
  const kids = (p: string | null) => locs.filter((l) => l.parent_id === p);
  const sum = (l: MapLoc): { kg: number; rolls: number } => {
    const c = kids(l.id);
    return c.length ? c.reduce((a, x) => { const s = sum(x); return { kg: a.kg + s.kg, rolls: a.rolls + s.rolls }; }, { kg: l.kg, rolls: l.rolls }) : { kg: l.kg, rolls: l.rolls };
  };
  return (
    <>
      <PageHeader title="Warehouse map" description="Zones, aisles, racks and bins with what each holds. Colour shows how full a bin is against its capacity." breadcrumbs={[{ label: 'Inventory', to: '/inventory' }, { label: 'Warehouse map' }]}
        actions={<select className="input h-9 w-auto" value={id} onChange={(e) => { setWhId(e.target.value); setBin(null); }}>{(wh.data ?? []).map((w) => <option key={w.id} value={w.id}>{w.code} · {w.name}</option>)}</select>} />
      {!q.data ? <Skeleton className="h-96" /> : (
        <div className="grid grid-cols-1 gap-6 xl:grid-cols-[1fr_360px]">
          <div className="space-y-4">
            {q.data.unplaced.rolls > 0 && <Notice tone="warning">{q.data.unplaced.rolls} rolls ({fmtNum(q.data.unplaced.kg)} kg) have no location yet — put them away from the <Link className="link" to="/inventory/scan">scan station</Link>.</Notice>}
            {kids(null).length === 0 && <Card><EmptyState title="No locations set up" description="Create zones, aisles, racks and bins under Organisation → Warehouses." /></Card>}
            {kids(null).map((z) => {
              const zs = sum(z);
              return (
                <Card key={z.id} title={<span>{z.code} · {z.name ?? humanize(z.purpose)}</span>} description={`${humanize(z.purpose)} · ${zs.rolls} rolls · ${fmtNum(Math.round(zs.kg))} kg`}>
                  {kids(z.id).length === 0 ? (
                    <button onClick={() => setBin(z)} className="w-full rounded-lg border border-dashed border-slate-300 px-4 py-3 text-left text-[13px] text-slate-600 hover:border-slate-400">{z.rolls ? `${z.rolls} rolls · ${fmtNum(z.kg)} kg — ${z.skus}` : 'Empty area'}</button>
                  ) : (
                    <div className="space-y-3">
                      {kids(z.id).map((a) => (
                        <div key={a.id}>
                          <p className="mb-1.5 text-[12px] font-semibold text-slate-500">Aisle {a.code}</p>
                          <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                            {kids(a.id).map((r) => (
                              <div key={r.id} className="rounded-lg bg-slate-50 p-2">
                                <p className="mb-1.5 text-[11.5px] font-medium text-slate-500">Rack {r.code}</p>
                                <div className="grid grid-cols-3 gap-1.5">
                                  {kids(r.id).map((b) => {
                                    const fill = b.capacity_kg ? b.kg / Number(b.capacity_kg) : b.kg > 0 ? 0.5 : 0;
                                    return (
                                      <button key={b.id} onClick={() => setBin(b)} title={b.skus ?? 'Empty'} className={clsx('rounded-md border px-2 py-1.5 text-left transition', bin?.id === b.id ? 'border-brand-500 ring-2 ring-brand-500/20' : 'border-transparent',
                                        b.rolls === 0 ? 'bg-white text-slate-400' : fill > 0.9 ? 'bg-rose-100 text-rose-900' : fill > 0.6 ? 'bg-amber-100 text-amber-900' : 'bg-emerald-100 text-emerald-900')}>
                                        <p className="font-mono text-[11.5px] font-semibold">{b.code}</p>
                                        <p className="text-[11px] tabular">{b.rolls ? `${b.rolls} · ${fmtNum(Math.round(b.kg))} kg` : 'empty'}</p>
                                      </button>
                                    );
                                  })}
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </Card>
              );
            })}
          </div>
          <Card title={bin ? <span className="font-mono">{bin.path}</span> : 'Select a bin'} description={bin ? `${bin.rolls} rolls · ${fmtNum(bin.kg)} kg${bin.capacity_kg ? ` of ${fmtNum(Number(bin.capacity_kg))} kg` : ''}` : 'Click any bin to see its rolls'} padded={false} className="self-start xl:sticky xl:top-4">
            {bin && (rolls.data ? (
              <ul className="divide-y divide-slate-100">{(rolls.data as unknown as (Roll & { lot_no: string; sku: string; lot_id: string })[]).map((r) => (
                <li key={r.id} className="flex items-center justify-between px-5 py-2 text-[12.5px]"><span><span className="font-mono font-semibold">{r.barcode}</span><span className="block text-slate-500">{r.sku} · {r.grade ?? '—'}</span></span><span className="text-right"><span className="tabular">{fmtNum(Number(r.weight_kg))} kg</span><span className="block"><StatusBadge status={r.state} /></span></span></li>
              ))}{rolls.data.length === 0 && <li><EmptyState title="Empty" /></li>}</ul>
            ) : <Skeleton className="m-5 h-24" />)}
          </Card>
        </div>
      )}
    </>
  );
}
