import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ClipboardList, Factory, Plus, Undo2 } from 'lucide-react';
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Link } from '../../components/AppLink';
import { api, invalidatePrefix } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { fmtDate, fmtDateTime, fmtNum, fmtRelative, humanize } from '../../lib/format';
import { SimpleTable } from '../../components/DataTable';
import { ConfirmDialog, Drawer, Modal, useToast } from '../../components/overlay';
import { Bar, ScanInput } from '../../components/scan';
import { useParties, useWarehouses } from '../../components/business';
import { Badge, Button, Card, EmptyState, ErrorState, Input, KeyValue, Notice, PageHeader, Segmented, Select, Skeleton, Stat, StatusBadge, Textarea } from '../../components/ui';

// ---------- Stocktake ----------
interface StRow { id: string; number: string; warehouse_name: string; location_prefix: string | null; status: string; started_by_name: string; started_at: string; expected_rolls: number; counted_rolls: number; decided_by_name: string | null }
interface Variance {
  missing: { roll_id: string; barcode: string; sku: string; expected_kg: number; location_path: string | null }[];
  found: { roll_id: string; barcode: string; sku: string; kg: number; was: string; location_path: string | null }[];
  unknown: { barcode: string }[];
  weight: { roll_id: string; barcode: string; sku: string; expected_kg: number; counted_kg: number; diff: number }[];
  relocated: { roll_id: string; barcode: string; from: string | null; to: string | null }[];
  totals: { expected_rolls: number; counted_rolls: number; missing_kg: number; found_kg: number; weight_diff_kg: number };
}
interface St extends StRow { warehouse_id: string; reason: string | null; submitted_by_name: string | null; submitted_at: string | null; decided_at: string | null; decision_comment: string | null; counts: { barcode: string; sku: string | null; lot_no: string | null; counted_kg: number | null; location_path: string | null; counted_by_name: string; counted_at: string }[]; variance: Variance }

export function StocktakesPage() {
  const nav = useNavigate();
  const { can } = useAuth();
  const [starting, setStarting] = useState(false);
  const q = useQuery({ queryKey: ['inv-stocktakes'], queryFn: () => api.get<StRow[]>('/inventory/stocktakes') });
  return (
    <>
      <PageHeader title="Stock counts" description="Scan every roll in a warehouse or one area. Missing, unexpected, mis-located and re-weighed rolls form a variance that a checker approves before the ledger is adjusted."
        breadcrumbs={[{ label: 'Inventory', to: '/inventory' }, { label: 'Stock counts' }]} actions={can('inventory.stocktake.count') && <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setStarting(true)}>Start a count</Button>} />
      <Card padded={false}>
        {!q.data ? <Skeleton className="m-5 h-40" /> : (
          <SimpleTable rows={q.data} rowKey={(r) => r.id} onRowClick={(r) => nav(`/inventory/stocktakes/${r.id}`)} empty={<EmptyState icon={<ClipboardList className="size-5" />} title="No counts yet" />} columns={[
            { key: 'n', header: 'Count', render: (r) => <span className="font-mono text-[12.5px] font-semibold">{r.number}</span> },
            { key: 'w', header: 'Area', render: (r) => <span>{r.warehouse_name}{r.location_prefix && <span className="ml-1 font-mono text-[12px] text-slate-500">· {r.location_prefix}*</span>}</span> },
            { key: 'p', header: 'Progress', render: (r) => <div className="w-40"><div className="mb-1 text-[12px] tabular">{r.counted_rolls} of {r.expected_rolls} rolls</div><Bar value={r.counted_rolls} max={r.expected_rolls} /></div> },
            { key: 'b', header: 'Started', render: (r) => <span className="text-[12.5px]">{r.started_by_name}<span className="block text-slate-500">{fmtDateTime(r.started_at)}</span></span> },
            { key: 's', header: 'Status', render: (r) => <StatusBadge status={r.status} /> },
          ]} />
        )}
      </Card>
      {starting && <StartCountModal onClose={() => setStarting(false)} onDone={(id) => nav(`/inventory/stocktakes/${id}`)} />}
    </>
  );
}

function StartCountModal({ onClose, onDone }: { onClose: () => void; onDone: (id: string) => void }) {
  const wh = useWarehouses();
  const toast = useToast();
  const [v, setV] = useState({ warehouse_id: '', location_prefix: '' });
  return (
    <Modal open onClose={onClose} title="Start a stock count" description="The system freezes the list of rolls it expects in the area now; count against it." footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!v.warehouse_id} onClick={async () => {
      try { const r = await api.post<{ id: string }>('/inventory/stocktakes', { warehouse_id: v.warehouse_id, location_prefix: v.location_prefix || null }); onDone(r.id); } catch (e) { toast({ tone: 'error', title: (e as Error).message }); }
    }}>Start</Button></>}>
      <div className="grid grid-cols-2 gap-3">
        <Select label="Warehouse" value={v.warehouse_id} onChange={(e) => setV({ ...v, warehouse_id: e.target.value })} options={[{ value: '', label: 'Choose…' }, ...(wh.data ?? []).map((w) => ({ value: w.id, label: `${w.code} · ${w.name}` }))]} />
        <Input label="Area (optional)" placeholder="e.g. A-01" hint="Location path prefix; blank counts the whole warehouse" value={v.location_prefix} onChange={(e) => setV({ ...v, location_prefix: e.target.value.toUpperCase() })} />
      </div>
    </Modal>
  );
}

export function StocktakeDetailPage() {
  const { id = '' } = useParams();
  const { can } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['inv-stocktake', id], queryFn: () => api.get<St>(`/inventory/stocktakes/${id}`) });
  const [weight, setWeight] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  if (q.isError) return <ErrorState error={q.error} />;
  const st = q.data;
  if (!st) return <Skeleton className="h-96" />;
  const v = st.variance;
  const counting = st.status === 'counting' && can('inventory.stocktake.count');
  const issues = v.missing.length + v.found.length + v.weight.length + v.relocated.length;
  const refresh = () => { q.refetch(); invalidatePrefix(qc, 'inv'); };
  return (
    <>
      <PageHeader title={`Stock count ${st.number}`} description={`${st.warehouse_name}${st.location_prefix ? ` · area ${st.location_prefix}` : ' · whole warehouse'}`} meta={<StatusBadge status={st.status} />}
        breadcrumbs={[{ label: 'Inventory', to: '/inventory' }, { label: 'Stock counts', to: '/inventory/stocktakes' }, { label: st.number }]}
        actions={counting && <><Button variant="ghost" onClick={() => setCancelling(true)}>Cancel count</Button><Button variant="primary" onClick={() => setSubmitting(true)}>Submit count</Button></>} />
      <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-5">
        <Stat label="Counted" value={`${v.totals.counted_rolls} / ${v.totals.expected_rolls}`} sub="rolls" />
        <Stat label="Missing" value={v.missing.length} sub={`${fmtNum(v.totals.missing_kg)} kg`} tone={v.missing.length ? 'danger' : undefined} />
        <Stat label="Found (unexpected)" value={v.found.length} sub={`${fmtNum(v.totals.found_kg)} kg`} tone={v.found.length ? 'warning' : undefined} />
        <Stat label="Weight differences" value={v.weight.length} sub={`${v.totals.weight_diff_kg > 0 ? '+' : ''}${fmtNum(v.totals.weight_diff_kg)} kg`} tone={v.weight.length ? 'warning' : undefined} />
        <Stat label="In another bin" value={v.relocated.length} />
      </div>
      {st.status === 'submitted' && <div className="mb-5"><Notice tone="warning">Submitted by {st.submitted_by_name}. A checker must approve the adjustment in the <Link className="link" to="/approvals">Approvals inbox</Link> before the ledger changes.</Notice></div>}
      {st.status === 'approved' && <div className="mb-5"><Notice tone="success">Approved by {st.decided_by_name} · {fmtDateTime(st.decided_at)}. Adjustments were posted to the stock ledger with reference {st.number}.</Notice></div>}
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
        <div className="space-y-6 xl:col-span-2">
          {counting && (
            <Card title="Count by scanning" description="Optionally enter the weight to check it; scanning the same roll again updates its count.">
              <ScanInput extra={<input className="input h-11 w-28" type="number" placeholder="Weight kg" value={weight} onChange={(e) => setWeight(e.target.value)} />} onScan={async (code) => {
                const r = await api.post<{ known: boolean; expected: boolean; recounted: boolean; system_kg: number | null }>(`/inventory/stocktakes/${id}/count`, { barcode: code, weight_kg: weight ? Number(weight) : null });
                setWeight(''); q.refetch();
                return { ok: r.known, title: !r.known ? 'Unknown barcode — recorded for review' : r.expected ? (r.recounted ? 'Counted again' : 'Counted') : 'Not expected here — recorded as found', detail: r.system_kg !== null ? `System weight ${fmtNum(r.system_kg)} kg` : undefined };
              }} />
            </Card>
          )}
          <Card title="Variance" description={issues ? undefined : 'No differences so far'} padded={false}>
            {issues + v.unknown.length === 0 ? <EmptyState title="Count matches the system" /> : (
              <div className="divide-y divide-slate-100">
                {v.missing.length > 0 && <VarianceList title="Missing — will be written off" tone="danger" rows={v.missing.map((m) => ({ k: m.roll_id, a: m.barcode, b: m.sku, c: `${fmtNum(m.expected_kg)} kg`, d: m.location_path ?? '' }))} />}
                {v.found.length > 0 && <VarianceList title="Found but not expected — will be brought into this warehouse" tone="warning" rows={v.found.map((m) => ({ k: m.roll_id, a: m.barcode, b: m.sku, c: `${fmtNum(m.kg)} kg`, d: `was ${humanize(m.was)}` }))} />}
                {v.weight.length > 0 && <VarianceList title="Weight differences — will be corrected" tone="warning" rows={v.weight.map((m) => ({ k: m.roll_id, a: m.barcode, b: m.sku, c: `${fmtNum(m.expected_kg)} → ${fmtNum(m.counted_kg)} kg`, d: `${m.diff > 0 ? '+' : ''}${m.diff} kg` }))} />}
                {v.relocated.length > 0 && <VarianceList title="In a different bin — will be moved" tone="info" rows={v.relocated.map((m) => ({ k: m.roll_id, a: m.barcode, b: '', c: `${m.from ?? '—'} → ${m.to}`, d: '' }))} />}
                {v.unknown.length > 0 && <VarianceList title="Unknown barcodes — not adjusted" tone="neutral" rows={v.unknown.map((m) => ({ k: m.barcode, a: m.barcode, b: 'Not in the system', c: '', d: '' }))} />}
              </div>
            )}
          </Card>
        </div>
        <Card title={`Counted (${st.counts.length})`} padded={false} className="self-start">
          <ul className="max-h-[560px] divide-y divide-slate-100 overflow-y-auto">
            {st.counts.map((c) => (
              <li key={c.barcode} className="flex items-center justify-between gap-2 px-5 py-2 text-[12.5px]">
                <span><span className="font-mono font-semibold">{c.barcode}</span><span className="block text-slate-500">{c.sku ?? 'unknown'}{c.counted_kg ? ` · ${fmtNum(Number(c.counted_kg))} kg` : ''}</span></span>
                <span className="flex items-center gap-2 text-slate-400">{fmtRelative(c.counted_at)}{counting && <button title="Remove" onClick={async () => { await api.post(`/inventory/stocktakes/${id}/uncount`, { barcode: c.barcode }); q.refetch(); }}><Undo2 className="size-3.5" /></button>}</span>
              </li>
            ))}
            {!st.counts.length && <li><EmptyState title="Nothing counted yet" /></li>}
          </ul>
        </Card>
      </div>
      <ConfirmDialog open={submitting} onClose={() => setSubmitting(false)} title="Submit the count" description={issues ? `${issues} difference(s) will go to a checker for approval.` : 'No differences: the count closes straight away.'}
        requireReason={issues > 0} reasonLabel="Explanation for the approver" confirmLabel="Submit"
        onConfirm={async (reason) => { try { await api.post(`/inventory/stocktakes/${id}/submit`, { reason: reason || null }); setSubmitting(false); refresh(); } catch (e) { toast({ tone: 'error', title: (e as Error).message }); } }} />
      <ConfirmDialog open={cancelling} onClose={() => setCancelling(false)} title="Cancel this count" requireReason tone="danger" confirmLabel="Cancel count"
        onConfirm={async (reason) => { try { await api.post(`/inventory/stocktakes/${id}/cancel`, { reason }); setCancelling(false); refresh(); } catch (e) { toast({ tone: 'error', title: (e as Error).message }); } }} />
    </>
  );
}

function VarianceList({ title, tone, rows }: { title: string; tone: 'danger' | 'warning' | 'info' | 'neutral'; rows: { k: string; a: string; b: string; c: string; d: string }[] }) {
  return (
    <div className="px-5 py-3">
      <p className="mb-2 flex items-center gap-2 text-[12.5px] font-semibold text-slate-700"><Badge tone={tone}>{rows.length}</Badge>{title}</p>
      <ul className="space-y-1">{rows.map((r) => <li key={r.k} className="grid grid-cols-[1.3fr_1fr_1fr_1fr] gap-2 text-[12.5px]"><span className="font-mono">{r.a}</span><span className="text-slate-600">{r.b}</span><span className="tabular">{r.c}</span><span className="text-slate-500">{r.d}</span></li>)}</ul>
    </div>
  );
}

// ---------- Reservations ----------
interface ResRow { id: string; number: string; ref_type: string; ref_no: string | null; customer_name: string | null; warehouse_name: string; status: string; expires_at: string; created_by_name: string; created_at: string; rolls_reserved: number; kg_reserved: number | null; rolls_picked: number; mixed_shade_reason: string | null }
interface ResDetail extends ResRow { rolls: { id: string; barcode: string; weight_kg: number; state: string; shade_code: string | null; dye_lot: string | null; grade: string | null; location_path: string | null; lot_no: string; sku: string }[]; kg: number; close_reason: string | null }

export function ReservationsPage() {
  const { can } = useAuth();
  const [status, setStatus] = useState<'active' | 'picked' | 'released' | 'expired'>('active');
  const [open, setOpen] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const q = useQuery({ queryKey: ['inv-res', status], queryFn: () => api.get<ResRow[]>(`/inventory/reservations?status=${status}`) });
  return (
    <>
      <PageHeader title="Reservations & picking" description="Rolls held for a customer or quotation. A roll can only be on one reservation, and only rolls on the reservation can be picked — each exactly once."
        breadcrumbs={[{ label: 'Inventory', to: '/inventory' }, { label: 'Reservations' }]} actions={can('inventory.reserve') && <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>Reserve rolls</Button>} />
      <div className="mb-4"><Segmented value={status} onChange={setStatus} options={[{ value: 'active', label: 'Active' }, { value: 'picked', label: 'Picked' }, { value: 'released', label: 'Released' }, { value: 'expired', label: 'Expired' }]} /></div>
      <Card padded={false}>
        {!q.data ? <Skeleton className="m-5 h-40" /> : (
          <SimpleTable rows={q.data} rowKey={(r) => r.id} onRowClick={(r) => setOpen(r.id)} empty={<EmptyState title="No reservations" />} columns={[
            { key: 'n', header: 'Reservation', render: (r) => <div><p className="font-mono text-[12.5px] font-semibold">{r.number}</p><p className="text-[12px] text-slate-500">{humanize(r.ref_type)}{r.ref_no ? ` · ${r.ref_no}` : ''}</p></div> },
            { key: 'c', header: 'Customer', render: (r) => r.customer_name ?? '—' },
            { key: 'w', header: 'Warehouse', render: (r) => r.warehouse_name },
            { key: 'k', header: 'Reserved', align: 'right', render: (r) => `${fmtNum(r.kg_reserved ?? 0)} kg · ${r.rolls_reserved}` },
            { key: 'p', header: 'Picked', align: 'right', render: (r) => r.rolls_picked },
            { key: 'e', header: 'Expires', render: (r) => (r.status === 'active' ? fmtDateTime(r.expires_at) : '—') },
            { key: 's', header: 'Status', render: (r) => <div className="flex gap-1"><StatusBadge status={r.status} />{r.mixed_shade_reason && <Badge tone="warning">Mixed shade</Badge>}</div> },
          ]} />
        )}
      </Card>
      {open && <ReservationDrawer id={open} onClose={() => { setOpen(null); q.refetch(); }} />}
      {creating && <NewReservationModal onClose={() => setCreating(false)} onDone={(id) => { setCreating(false); q.refetch(); setOpen(id); }} />}
    </>
  );
}

function ReservationDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const { can } = useAuth();
  const toast = useToast();
  const q = useQuery({ queryKey: ['inv-reservation', id], queryFn: () => api.get<ResDetail>(`/inventory/reservations/${id}`) });
  const [releasing, setReleasing] = useState(false);
  const r = q.data;
  return (
    <Drawer open onClose={onClose} width="lg" title={r ? `${r.number}${r.customer_name ? ` · ${r.customer_name}` : ''}` : 'Reservation'} description={r && <StatusBadge status={r.status} />}
      footer={r?.status === 'active' && can('inventory.reserve') && <Button variant="danger" onClick={() => setReleasing(true)}>Release</Button>}>
      {!r ? <Skeleton className="h-64" /> : (
        <div className="space-y-6">
          <KeyValue columns={2} items={[{ label: 'For', value: `${humanize(r.ref_type)}${r.ref_no ? ` · ${r.ref_no}` : ''}` }, { label: 'Warehouse', value: r.warehouse_name }, { label: 'Reserved', value: `${fmtNum(r.kg)} kg in ${r.rolls.length} rolls` }, { label: 'Expires', value: fmtDateTime(r.expires_at) }, ...(r.mixed_shade_reason ? [{ label: 'Mixed shades accepted', value: r.mixed_shade_reason }] : [])]} />
          {r.status === 'active' && (can('inventory.reserve') || can('inventory.move')) && (
            <Card title="Pick by scanning"><ScanInput onScan={async (code) => {
              const x = await api.post<{ kg: number; remaining_rolls: number }>(`/inventory/reservations/${id}/pick`, { barcode: code });
              q.refetch();
              return { ok: true, title: `${fmtNum(x.kg)} kg picked`, detail: `${x.remaining_rolls} roll(s) left` };
            }} /></Card>
          )}
          <SimpleTable rows={r.rolls} rowKey={(x) => x.id} columns={[
            { key: 'b', header: 'Roll', render: (x) => <span className="font-mono text-[12.5px]">{x.barcode}</span> },
            { key: 's', header: 'Fabric', render: (x) => <span className="text-[12.5px]">{x.sku}<span className="block text-slate-500">{x.dye_lot ?? '—'}{x.shade_code ? ` · ${x.shade_code}` : ''}</span></span> },
            { key: 'k', header: 'KG', align: 'right', render: (x) => fmtNum(Number(x.weight_kg)) },
            { key: 'l', header: 'Bin', render: (x) => <span className="font-mono text-[12px]">{x.location_path ?? '—'}</span> },
            { key: 'st', header: 'State', render: (x) => <StatusBadge status={x.state === 'dispatched' ? 'picked' : x.state} /> },
          ]} />
        </div>
      )}
      <ConfirmDialog open={releasing} onClose={() => setReleasing(false)} title="Release reservation" description="All unpicked rolls become available again." requireReason tone="danger" confirmLabel="Release"
        onConfirm={async (reason) => { try { await api.post(`/inventory/reservations/${id}/release`, { reason }); setReleasing(false); q.refetch(); } catch (e) { toast({ tone: 'error', title: (e as Error).message }); } }} />
    </Drawer>
  );
}

function NewReservationModal({ onClose, onDone }: { onClose: () => void; onDone: (id: string) => void }) {
  const wh = useWarehouses();
  const customers = useParties('customer');
  const [v, setV] = useState({ warehouse_id: '', customer_id: '', ref_no: '', barcodes: '', mixed_shade_reason: '' });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <Modal open onClose={onClose} title="Reserve rolls" footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} onClick={async () => {
      setBusy(true); setErr(null);
      try {
        const r = await api.post<{ id: string }>('/inventory/reservations', { warehouse_id: v.warehouse_id, customer_id: v.customer_id || null, ref_type: 'manual', ref_no: v.ref_no || null, barcodes: v.barcodes.split(/[\s,]+/).filter(Boolean), mixed_shade_reason: v.mixed_shade_reason || null });
        onDone(r.id);
      } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
    }}>Reserve</Button></>}>
      <div className="grid grid-cols-2 gap-3">
        {err && <div className="col-span-2"><Notice tone="danger">{err}</Notice></div>}
        <Select label="Warehouse" value={v.warehouse_id} onChange={(e) => setV({ ...v, warehouse_id: e.target.value })} options={[{ value: '', label: 'Choose…' }, ...(wh.data ?? []).map((w) => ({ value: w.id, label: `${w.code} · ${w.name}` }))]} />
        <Select label="Customer" value={v.customer_id} onChange={(e) => setV({ ...v, customer_id: e.target.value })} options={[{ value: '', label: 'None' }, ...(customers.data ?? []).map((c) => ({ value: c.id, label: c.legal_name }))]} />
        <Input className="col-span-2" label="Reference" placeholder="e.g. phone order from Murugan" value={v.ref_no} onChange={(e) => setV({ ...v, ref_no: e.target.value })} />
        <Textarea className="col-span-2" label="Roll barcodes" required placeholder="Scan or paste, one per line" value={v.barcodes} onChange={(e) => setV({ ...v, barcodes: e.target.value })} />
        <Input className="col-span-2" label="Reason to mix dye lots (only if needed)" value={v.mixed_shade_reason} onChange={(e) => setV({ ...v, mixed_shade_reason: e.target.value })} />
      </div>
    </Modal>
  );
}

// ---------- Issue to mill ----------
interface Issue { id: string; job_order_id: string; job_order_no: string; mill_name: string; warehouse_name: string; sku: string; requested_kg: number; issued_kg: number; consumed_kg: number; status: string; created_at: string; rolls_issued: number }

export function MillIssuesPage() {
  const { can } = useAuth();
  const [status, setStatus] = useState<'open' | 'issued'>('open');
  const q = useQuery({ queryKey: ['inv-mill-issues', status], queryFn: () => api.get<Issue[]>(`/inventory/mill-issues?status=${status}`) });
  const [scan, setScan] = useState<Issue | null>(null);
  return (
    <>
      <PageHeader title="Issue to mill" description="Job-work orders that take fabric from a warehouse appear here. Scan the rolls onto the vehicle; they stay trader-owned stock at the mill until the processed fabric comes back."
        breadcrumbs={[{ label: 'Inventory', to: '/inventory' }, { label: 'Issue to mill' }]} />
      <div className="mb-4"><Segmented value={status} onChange={setStatus} options={[{ value: 'open', label: 'To issue' }, { value: 'issued', label: 'Issued' }]} /></div>
      <Card padded={false}>
        {!q.data ? <Skeleton className="m-5 h-40" /> : (
          <SimpleTable rows={q.data} rowKey={(r) => r.id} empty={<EmptyState icon={<Factory className="size-5" />} title={status === 'open' ? 'Nothing to issue' : 'Nothing issued yet'} />} columns={[
            { key: 'j', header: 'Job-work order', render: (r) => <Link className="link font-mono text-[12.5px]" to={`/jobwork/orders/${r.job_order_id}`}>{r.job_order_no}</Link> },
            { key: 'm', header: 'Mill', render: (r) => r.mill_name },
            { key: 'w', header: 'From', render: (r) => r.warehouse_name },
            { key: 's', header: 'Fabric', render: (r) => <span className="font-mono text-[12.5px]">{r.sku}</span> },
            { key: 'p', header: 'Issued / requested', render: (r) => <div className="w-44"><div className="mb-1 text-[12px] tabular">{fmtNum(Number(r.issued_kg))} / {fmtNum(Number(r.requested_kg))} kg · {r.rolls_issued} rolls</div><Bar value={Number(r.issued_kg)} max={Number(r.requested_kg)} tone={r.status === 'issued' ? 'success' : 'brand'} /></div> },
            { key: 'c', header: 'Consumed', align: 'right', render: (r) => fmtNum(Number(r.consumed_kg)) },
            { key: 'd', header: 'Since', render: (r) => fmtDate(r.created_at) },
            { key: 'a', header: '', align: 'right', render: (r) => (r.status === 'open' && can('inventory.move') ? <Button size="sm" variant="primary" onClick={() => setScan(r)}>Scan rolls</Button> : <StatusBadge status={r.status} />) },
          ]} />
        )}
      </Card>
      {scan && (
        <Modal open onClose={() => { setScan(null); q.refetch(); }} title={`Issue ${scan.sku} to ${scan.mill_name}`} description={`${scan.job_order_no} · ${fmtNum(Number(scan.requested_kg))} kg requested`} footer={<Button variant="primary" onClick={() => { setScan(null); q.refetch(); }}>Done</Button>}>
          <ScanInput onScan={async (code) => {
            const r = await api.post<{ kg: number; issued_kg: number; requested_kg: number; done: boolean }>(`/inventory/mill-issues/${scan.id}/scan`, { barcode: code });
            return { ok: true, title: `${fmtNum(r.kg)} kg issued`, detail: `${fmtNum(r.issued_kg)} of ${fmtNum(r.requested_kg)} kg${r.done ? ' — complete' : ''}` };
          }} />
        </Modal>
      )}
    </>
  );
}
