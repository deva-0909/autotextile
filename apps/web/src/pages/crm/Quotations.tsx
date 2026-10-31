import { useQuery, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { AlertTriangle, CheckCircle2, FileText, Plus, Send, Trash2, XCircle } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Link } from '../../components/AppLink';
import { api, invalidatePrefix, type Page } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { fmtDate, fmtDateTime, fmtINR, fmtNum, humanize } from '../../lib/format';
import { SimpleTable } from '../../components/DataTable';
import { Modal, useToast } from '../../components/overlay';
import { useParties, useProducts, useWarehouses } from '../../components/business';
import { Badge, Button, Card, EmptyState, ErrorState, Input, KeyValue, Notice, PageHeader, Segmented, Select, Skeleton, StatusBadge, Textarea } from '../../components/ui';

interface QRow { id: string; number: string; version: number; status: string; customer_name: string | null; prospect_name: string | null; owner_name: string | null; kg: number; total: number; margin_pct: number | null; valid_until: string; skus: string | null; lines_needing_approval: number; updated_at: string; lead_id: string | null }
interface PricedLine { line_no: number; product_id: string; sku: string; product_name: string; lot_id: string | null; lot_no: string | null; kg: number; list_price: number | null; requested_price: number; discount_pct: number | null; cost_per_kg: number | null; margin_pct: number | null; gst_rate: number; taxable: number; needs_approval: boolean; approval_reason: string | null }
interface Credit { ok: boolean; mode: string; credit_limit: number; available: number; status: string; reason: string | null; exposure: { total: number; confirmed_orders: number; outstanding_invoices: number } }
interface Quote extends QRow { root_id: string; customer_id: string | null; owner_id: string | null; warehouse_id: string | null; warehouse_name: string | null; freight_amount: number; payment_terms: string | null; delivery_terms: string | null; notes: string | null; competitor_name: string | null; competitor_price: number | null; revision_reason: string | null; lost_reason: string | null; taxable: number; tax: number; needs_approval: boolean; approval_note: string | null; approved_by_name: string | null; approved_at: string | null; sent_at: string | null; decided_at: string | null; reservation_id: string | null; reservation_no: string | null; created_by_name: string; created_at: string;
  lines: PricedLine[]; versions: { id: string; version: number; status: string; kg: number; total: number; margin_pct: number | null; revision_reason: string | null; competitor_name: string | null; competitor_price: number | null; created_by_name: string; created_at: string; approved_by_name: string | null; lines: { sku: string; kg: number; list_price: number | null; requested_price: number; discount_pct: number | null; margin_pct: number | null }[] }[];
  lead: { id: string; number: string; name: string; company: string | null; stage: string; owner_name: string } | null; credit: Credit | null }

const ACTIVE = 'draft,pending_approval,approved,rejected_internal,sent';
export function QuotationsPage() {
  const nav = useNavigate();
  const { can } = useAuth();
  const [view, setView] = useState<'active' | 'won' | 'closed'>('active');
  const status = view === 'active' ? ACTIVE : view === 'won' ? 'accepted' : 'rejected,lost,expired';
  const q = useQuery({ queryKey: ['crm-quotes', view], queryFn: () => api.get<QRow[]>(`/crm/quotations?status=${status}`) });
  return (
    <>
      <PageHeader title="Quotations" description="Versioned quotations from stock lots: list price, requested price, discount, cost and margin on every line. Prices outside a salesperson’s authority go to an approver."
        breadcrumbs={[{ label: 'Sales & CRM', to: '/crm' }, { label: 'Quotations' }]} actions={can('crm.quote.manage') && <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => nav('/crm/quotations/new')}>New quotation</Button>} />
      <div className="mb-4"><Segmented value={view} onChange={setView} options={[{ value: 'active', label: 'In progress' }, { value: 'won', label: 'Accepted' }, { value: 'closed', label: 'Lost / expired' }]} /></div>
      <Card padded={false}>
        {!q.data ? <Skeleton className="m-5 h-40" /> : (
          <SimpleTable rows={q.data} rowKey={(r) => r.id} onRowClick={(r) => nav(`/crm/quotations/${r.id}`)} empty={<EmptyState icon={<FileText className="size-5" />} title="No quotations" />} columns={[
            { key: 'n', header: 'Quotation', render: (r) => <div><p className="font-mono text-[12.5px] font-semibold">{r.number} <span className="text-slate-400">v{r.version}</span></p><p className="text-[12px] text-slate-500">{r.owner_name}</p></div> },
            { key: 'c', header: 'Customer', render: (r) => r.customer_name ?? <span className="text-slate-500">{r.prospect_name} (prospect)</span> },
            { key: 's', header: 'Fabric', render: (r) => <span className="font-mono text-[12px]">{r.skus}</span> },
            { key: 'k', header: 'KG', align: 'right', render: (r) => fmtNum(Number(r.kg)) },
            { key: 't', header: 'Total', align: 'right', render: (r) => fmtINR(Number(r.total)) },
            { key: 'm', header: 'Margin', align: 'right', render: (r) => (r.margin_pct === null ? '—' : <span className={Number(r.margin_pct) < 8 ? 'font-semibold text-rose-600' : ''}>{r.margin_pct}%</span>) },
            { key: 'v', header: 'Valid until', render: (r) => fmtDate(r.valid_until) },
            { key: 'st', header: 'Status', render: (r) => <div className="flex gap-1"><StatusBadge status={r.status} />{r.lines_needing_approval > 0 && r.status === 'draft' && <Badge tone="warning">needs approval</Badge>}</div> },
          ]} />
        )}
      </Card>
    </>
  );
}

interface LotOpt { id: string; lot_no: string; price_per_kg: number | null; cost_per_kg: number | null; available_kg: number; grade: string | null; dye_lot: string | null; shade_code: string | null; warehouses: string[] | null }
interface DraftLine { product_id: string; lot_id: string; kg: string; requested_price: string; approval_reason: string }
const emptyLine = (): DraftLine => ({ product_id: '', lot_id: '', kg: '', requested_price: '', approval_reason: '' });

function useLots(productId: string, warehouseId: string) {
  return useQuery({ queryKey: ['crm-lots', productId], queryFn: () => api.get<Page<LotOpt>>(`/inventory/lots?f_product=${productId}&f_in_stock=true&pageSize=50&sort=received_date&dir=asc`).then((r) => r.items), enabled: !!productId, select: (lots) => lots.filter((l) => !warehouseId || l.warehouses?.includes(warehouseId)) });
}

function LineRow({ line, priced, warehouseId, onChange, onRemove }: { line: DraftLine; priced?: PricedLine; warehouseId: string; onChange: (l: DraftLine) => void; onRemove?: () => void }) {
  const prods = useProducts();
  const lots = useLots(line.product_id, warehouseId);
  return (
    <div className={clsx('rounded-lg border p-3', priced?.needs_approval ? 'border-amber-300 bg-amber-50/40' : 'border-slate-200')}>
      <div className="grid grid-cols-1 gap-2 md:grid-cols-[2fr_2fr_1fr_1fr_auto]">
        <select className="input" value={line.product_id} onChange={(e) => onChange({ ...line, product_id: e.target.value, lot_id: '' })}><option value="">Fabric…</option>{(prods.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.sku} · {p.name}</option>)}</select>
        <select className="input" value={line.lot_id} onChange={(e) => onChange({ ...line, lot_id: e.target.value })} disabled={!line.product_id}>
          <option value="">Any lot (from stock)</option>
          {(lots.data ?? []).map((l) => <option key={l.id} value={l.id}>{l.lot_no} · {fmtNum(Number(l.available_kg))} kg free · {l.price_per_kg ? `₹${l.price_per_kg}` : 'no price'}{l.dye_lot ? ` · ${l.dye_lot}` : ''}{l.grade ? ` · ${l.grade}` : ''}</option>)}
        </select>
        <input className="input" type="number" placeholder="KG" value={line.kg} onChange={(e) => onChange({ ...line, kg: e.target.value })} />
        <input className="input" type="number" placeholder="₹ / kg" value={line.requested_price} onChange={(e) => onChange({ ...line, requested_price: e.target.value })} />
        {onRemove ? <Button variant="ghost" icon={<Trash2 className="size-4" />} onClick={onRemove} aria-label="Remove line" /> : <span />}
      </div>
      {priced && (
        <div className="mt-2 flex flex-wrap items-center gap-x-5 gap-y-1 text-[12px] text-slate-600">
          <span>List {priced.list_price ? `₹${fmtNum(priced.list_price)}` : '—'}</span>
          <span>Discount <b className={clsx(priced.discount_pct !== null && priced.discount_pct > 0 && 'text-amber-700')}>{priced.discount_pct === null ? '—' : `${priced.discount_pct}%`}</b></span>
          <span>Cost {priced.cost_per_kg ? `₹${fmtNum(priced.cost_per_kg)}` : '—'}</span>
          <span>Margin <b className={clsx(priced.margin_pct !== null && priced.margin_pct < 8 ? 'text-rose-600' : 'text-emerald-700')}>{priced.margin_pct === null ? '—' : `${priced.margin_pct}%`}</b></span>
          <span>GST {priced.gst_rate}%</span>
          <span className="ml-auto font-medium text-slate-800">{fmtINR(priced.taxable)}</span>
        </div>
      )}
      {priced?.needs_approval && (
        <div className="mt-2 space-y-1.5">
          <p className="flex items-center gap-1.5 text-[12px] font-medium text-amber-800"><AlertTriangle className="size-3.5" />Needs approval: {priced.approval_reason?.split(' — ')[0]}</p>
          <input className="input h-8 text-[12.5px]" placeholder="Justification for the approver (required), e.g. competitor price, volume, first order" value={line.approval_reason} onChange={(e) => onChange({ ...line, approval_reason: e.target.value })} />
        </div>
      )}
    </div>
  );
}

/** Builder for a new quotation, an edit of a draft, or a revision (new version) of a sent one. */
export function QuotationBuilderPage() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const nav = useNavigate();
  const toast = useToast();
  const qc = useQueryClient();
  const mode: 'new' | 'edit' | 'revise' = id ? (params.get('revise') ? 'revise' : 'edit') : 'new';
  const existing = useQuery({ queryKey: ['crm-quote', id], queryFn: () => api.get<Quote>(`/crm/quotations/${id}`), enabled: !!id });
  const leadId = params.get('lead') ?? existing.data?.lead_id ?? '';
  const lead = useQuery({ queryKey: ['crm-lead', leadId], queryFn: () => api.get<{ id: string; number: string; name: string; company: string | null; customer_id: string | null; customer_name: string | null }>(`/crm/leads/${leadId}`), enabled: !!leadId });
  const customers = useParties('customer');
  const wh = useWarehouses();
  const [h, setH] = useState({ customer_id: params.get('customer') ?? '', warehouse_id: '', valid_until: '', freight_amount: '0', payment_terms: 'Advance', delivery_terms: '', notes: '', competitor_name: '', competitor_price: '', revision_reason: '' });
  const [lines, setLines] = useState<DraftLine[]>([emptyLine()]);
  const [priced, setPriced] = useState<{ lines: PricedLine[]; warnings: string[]; totals: { kg: number; taxable: number; tax: number; total: number; margin_pct: number | null }; minMargin: number; maxDisc: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    const q = existing.data;
    if (!q) return;
    setH({ customer_id: q.customer_id ?? '', warehouse_id: q.warehouse_id ?? '', valid_until: mode === 'revise' ? '' : String(q.valid_until).slice(0, 10), freight_amount: String(q.freight_amount), payment_terms: q.payment_terms ?? '', delivery_terms: q.delivery_terms ?? '', notes: q.notes ?? '', competitor_name: q.competitor_name ?? '', competitor_price: q.competitor_price ? String(q.competitor_price) : '', revision_reason: '' });
    setLines(q.lines.map((l) => ({ product_id: l.product_id, lot_id: l.lot_id ?? '', kg: String(l.kg), requested_price: String(l.requested_price), approval_reason: l.approval_reason?.split(' — ')[1] ?? '' })));
  }, [existing.data, mode]);
  useEffect(() => { if (!h.warehouse_id && wh.data?.length) setH((x) => ({ ...x, warehouse_id: wh.data!.find((w) => w.code === 'SRT')?.id ?? wh.data![0]!.id })); }, [wh.data, h.warehouse_id]);
  const ready = lines.filter((l) => l.product_id && Number(l.kg) > 0 && Number(l.requested_price) > 0);
  const key = JSON.stringify([ready.map((l) => [l.product_id, l.lot_id, l.kg, l.requested_price]), h.freight_amount]);
  useEffect(() => {
    if (!ready.length) { setPriced(null); return; }
    const t = setTimeout(async () => {
      try { setPriced(await api.post('/crm/quotations/price', { freight_amount: Number(h.freight_amount || 0), lines: ready.map((l) => ({ product_id: l.product_id, lot_id: l.lot_id || null, kg: Number(l.kg), requested_price: Number(l.requested_price) })) })); } catch { /* keep last */ }
    }, 350);
    return () => clearTimeout(t);
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  const pricedFor = (l: DraftLine) => { const i = ready.indexOf(l); return i >= 0 ? priced?.lines[i] : undefined; };
  async function save(submit: boolean) {
    setBusy(true); setErr(null);
    const body = {
      lead_id: leadId || null, customer_id: h.customer_id || null, warehouse_id: h.warehouse_id || null, valid_until: h.valid_until || null, freight_amount: Number(h.freight_amount || 0),
      payment_terms: h.payment_terms || null, delivery_terms: h.delivery_terms || null, notes: h.notes || null, competitor_name: h.competitor_name || null, competitor_price: h.competitor_price ? Number(h.competitor_price) : null, revision_reason: h.revision_reason || null,
      lines: ready.map((l) => ({ product_id: l.product_id, lot_id: l.lot_id || null, kg: Number(l.kg), requested_price: Number(l.requested_price), approval_reason: l.approval_reason || null })),
    };
    try {
      const r = mode === 'new' ? await api.post<{ id: string }>('/crm/quotations', body) : mode === 'edit' ? await api.put<{ id: string }>(`/crm/quotations/${id}`, body) : await api.post<{ id: string }>(`/crm/quotations/${id}/revise`, body);
      if (submit) await api.post(`/crm/quotations/${r.id}/submit`);
      invalidatePrefix(qc, 'crm');
      toast({ tone: 'success', title: submit ? 'Submitted' : 'Saved as draft' });
      nav(`/crm/quotations/${r.id}`);
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }
  const t = priced?.totals;
  const needApproval = priced?.lines.some((l) => l.needs_approval);
  const title = mode === 'revise' ? `Revise ${existing.data?.number ?? ''} → v${(existing.data?.version ?? 0) + 1}` : mode === 'edit' ? `Edit ${existing.data?.number ?? ''}` : 'New quotation';
  return (
    <>
      <PageHeader title={title} description={lead.data ? `For lead ${lead.data.number} · ${lead.data.name}${lead.data.company ? `, ${lead.data.company}` : ''}` : 'Quote an existing customer, or open a lead and quote from there.'}
        breadcrumbs={[{ label: 'Sales & CRM', to: '/crm' }, { label: 'Quotations', to: '/crm/quotations' }, { label: title }]} />
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
        <div className="space-y-6 xl:col-span-2">
          <Card title="Customer & terms">
            <div className="grid grid-cols-2 gap-3">
              {lead.data?.customer_id || !leadId ? (
                <Select label="Customer" value={h.customer_id || lead.data?.customer_id || ''} onChange={(e) => setH({ ...h, customer_id: e.target.value })} disabled={!!lead.data?.customer_id} options={[{ value: '', label: leadId ? 'Prospect (no account yet)' : 'Choose…' }, ...(customers.data ?? []).map((c) => ({ value: c.id, label: c.legal_name }))]} />
              ) : <Input label="Customer" disabled value={`${lead.data?.company ?? lead.data?.name ?? ''} (prospect)`} hint="Convert the lead to accept an order" />}
              <Select label="Ship from" value={h.warehouse_id} onChange={(e) => setH({ ...h, warehouse_id: e.target.value })} options={(wh.data ?? []).map((w) => ({ value: w.id, label: `${w.code} · ${w.name}` }))} />
              <Input label="Payment terms" value={h.payment_terms} onChange={(e) => setH({ ...h, payment_terms: e.target.value })} />
              <Input label="Delivery terms" value={h.delivery_terms} onChange={(e) => setH({ ...h, delivery_terms: e.target.value })} />
              <Input label="Freight" type="number" prefix="₹" value={h.freight_amount} onChange={(e) => setH({ ...h, freight_amount: e.target.value })} />
              <Input label="Valid until" type="date" value={h.valid_until} onChange={(e) => setH({ ...h, valid_until: e.target.value })} hint="Blank = company default" />
              <Input label="Competitor" value={h.competitor_name} onChange={(e) => setH({ ...h, competitor_name: e.target.value })} />
              <Input label="Competitor price / kg" type="number" prefix="₹" value={h.competitor_price} onChange={(e) => setH({ ...h, competitor_price: e.target.value })} />
              {mode === 'revise' && <Textarea className="col-span-2" label="What changed in this revision?" required value={h.revision_reason} onChange={(e) => setH({ ...h, revision_reason: e.target.value })} />}
            </div>
          </Card>
          <Card title="Fabric" actions={<Button size="sm" variant="ghost" icon={<Plus className="size-3.5" />} onClick={() => setLines([...lines, emptyLine()])}>Add line</Button>}>
            <div className="space-y-2">
              {lines.map((l, i) => <LineRow key={i} line={l} priced={pricedFor(l)} warehouseId={h.warehouse_id} onChange={(n) => setLines(lines.map((x, j) => (j === i ? n : x)))} onRemove={lines.length > 1 ? () => setLines(lines.filter((_, j) => j !== i)) : undefined} />)}
            </div>
            {priced?.warnings.length ? <div className="mt-3"><Notice tone="warning">{priced.warnings.join(' · ')}</Notice></div> : null}
          </Card>
          <Textarea label="Notes for the customer" value={h.notes} onChange={(e) => setH({ ...h, notes: e.target.value })} />
        </div>
        <div className="space-y-4 xl:sticky xl:top-4 xl:self-start">
          <Card title="Summary">
            <KeyValue columns={1} items={[{ label: 'Quantity', value: t ? `${fmtNum(t.kg)} kg` : '—' }, { label: 'Taxable (incl. freight)', value: fmtINR(t?.taxable) }, { label: 'GST', value: fmtINR(t?.tax) }, { label: 'Total', value: <span className="text-[18px] font-semibold">{fmtINR(t?.total)}</span> }, { label: 'Margin', value: t?.margin_pct === null || !t ? '—' : <span className={t.margin_pct < (priced?.minMargin ?? 8) ? 'font-semibold text-rose-600' : 'font-semibold text-emerald-700'}>{t.margin_pct}%</span> }]} />
            {priced && <p className="mt-3 text-[12px] text-slate-500">Your discount authority: {priced.maxDisc}% · minimum margin {priced.minMargin}%.</p>}
            {needApproval ? <div className="mt-3"><Notice tone="warning">Some lines are outside your authority and will go to an approver when you submit.</Notice></div> : priced ? <div className="mt-3 flex items-center gap-1.5 text-[12.5px] text-emerald-700"><CheckCircle2 className="size-4" />Within your authority — approved on submit.</div> : null}
          </Card>
          {err && <Notice tone="danger">{err}</Notice>}
          <div className="flex gap-2"><Button className="flex-1" loading={busy} disabled={!ready.length} onClick={() => void save(false)}>Save draft</Button><Button className="flex-1" variant="primary" loading={busy} disabled={!ready.length} onClick={() => void save(true)}>{needApproval ? 'Submit for approval' : 'Save & approve'}</Button></div>
        </div>
      </div>
    </>
  );
}

export function QuotationDetailPage() {
  const { id = '' } = useParams();
  const nav = useNavigate();
  const { can } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['crm-quote', id], queryFn: () => api.get<Quote>(`/crm/quotations/${id}`) });
  const [outcome, setOutcome] = useState<'accepted' | 'lost' | null>(null);
  if (q.isError) return <ErrorState error={q.error} />;
  const x = q.data;
  if (!x) return <Skeleton className="h-96" />;
  const manage = can('crm.quote.manage');
  const latest = x.versions[x.versions.length - 1]?.id === x.id;
  const act = async (path: string, msg: string) => { try { await api.post(`/crm/quotations/${id}/${path}`); q.refetch(); invalidatePrefix(qc, 'crm'); toast({ tone: 'success', title: msg }); } catch (e) { toast({ tone: 'error', title: (e as Error).message }); } };
  return (
    <>
      <PageHeader title={<span className="font-mono">{x.number} <span className="text-slate-400">v{x.version}</span></span>} description={`${x.customer_name ?? `${x.prospect_name} (prospect)`} · ${x.owner_name}`} meta={<StatusBadge status={x.status} />}
        breadcrumbs={[{ label: 'Sales & CRM', to: '/crm' }, { label: 'Quotations', to: '/crm/quotations' }, { label: `${x.number} v${x.version}` }]}
        actions={manage && latest && <>
          {['draft', 'rejected_internal'].includes(x.status) && <><Button onClick={() => nav(`/crm/quotations/${x.id}/edit`)}>Edit</Button><Button variant="primary" onClick={() => void act('submit', 'Submitted')}>{x.needs_approval ? 'Submit for approval' : 'Approve'}</Button></>}
          {x.status === 'approved' && <Button variant="primary" icon={<Send className="size-4" />} onClick={() => void act('send', 'Marked as sent')}>Mark sent</Button>}
          {['pending_approval', 'approved', 'sent', 'rejected_internal', 'expired', 'rejected'].includes(x.status) && <Button onClick={() => nav(`/crm/quotations/${x.id}/edit?revise=1`)}>Revise</Button>}
          {x.status === 'sent' && <><Button variant="danger" icon={<XCircle className="size-4" />} onClick={() => setOutcome('lost')}>Lost</Button><Button variant="primary" icon={<CheckCircle2 className="size-4" />} onClick={() => setOutcome('accepted')}>Customer accepted</Button></>}
        </>} />
      {x.status === 'pending_approval' && <div className="mb-5"><Notice tone="warning">Waiting for price approval. Approvers see it under <Link className="link" to="/crm/price-approvals">Price approvals</Link>.</Notice></div>}
      {x.approval_note && x.status === 'rejected_internal' && <div className="mb-5"><Notice tone="danger" title={`Rejected by ${x.approved_by_name}`}>{x.approval_note}</Notice></div>}
      {x.status === 'accepted' && <div className="mb-5"><Notice tone="success" title="Order confirmed">{x.reservation_no ? <>Stock reserved on <Link className="link" to="/inventory/reservations">{x.reservation_no}</Link>. </> : null}Sales orders, invoicing and dispatch follow in P7.</Notice></div>}
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
        <div className="space-y-6 xl:col-span-2">
          <Card title="Lines" padded={false}>
            <SimpleTable rows={x.lines} rowKey={(l) => String(l.line_no)} columns={[
              { key: 's', header: 'Fabric', render: (l) => <div><p className="font-mono text-[12.5px] font-semibold">{l.sku}</p><p className="text-[12px] text-slate-500">{l.lot_no ? `Lot ${l.lot_no}` : 'Any lot'}</p></div> },
              { key: 'k', header: 'KG', align: 'right', render: (l) => fmtNum(Number(l.kg)) },
              { key: 'lp', header: 'List', align: 'right', render: (l) => (l.list_price ? `₹${fmtNum(Number(l.list_price))}` : '—') },
              { key: 'rp', header: 'Price', align: 'right', render: (l) => <span className="font-semibold">₹{fmtNum(Number(l.requested_price))}</span> },
              { key: 'd', header: 'Discount', align: 'right', render: (l) => (l.discount_pct === null ? '—' : `${l.discount_pct}%`) },
              { key: 'c', header: 'Cost', align: 'right', render: (l) => (l.cost_per_kg ? `₹${fmtNum(Number(l.cost_per_kg))}` : '—') },
              { key: 'm', header: 'Margin', align: 'right', render: (l) => (l.margin_pct === null ? '—' : <span className={Number(l.margin_pct) < 8 ? 'font-semibold text-rose-600' : 'text-emerald-700'}>{l.margin_pct}%</span>) },
              { key: 't', header: 'Taxable', align: 'right', render: (l) => fmtINR(Number(l.taxable)) },
              { key: 'a', header: '', render: (l) => (l.needs_approval ? <span title={l.approval_reason ?? ''}><Badge tone="warning">Exception</Badge></span> : null) },
            ]} />
            <div className="flex justify-end gap-8 border-t border-slate-100 px-5 py-3 text-[13px]"><span>Freight {fmtINR(Number(x.freight_amount))}</span><span>GST {fmtINR(Number(x.tax))}</span><span className="font-semibold">Total {fmtINR(Number(x.total))}</span></div>
          </Card>
          <Card title="Negotiation history" description="Every version is kept" padded={false}>
            <SimpleTable rows={[...x.versions].reverse()} rowKey={(v) => v.id} onRowClick={(v) => nav(`/crm/quotations/${v.id}`)} columns={[
              { key: 'v', header: 'Version', render: (v) => <span className={clsx('font-mono', v.id === x.id && 'font-semibold')}>v{v.version}</span> },
              { key: 'p', header: 'Prices', render: (v) => <span className="text-[12.5px]">{v.lines.map((l) => `${l.sku} ₹${l.requested_price}${l.discount_pct ? ` (−${l.discount_pct}%)` : ''}`).join(', ')}</span> },
              { key: 't', header: 'Total', align: 'right', render: (v) => fmtINR(Number(v.total)) },
              { key: 'm', header: 'Margin', align: 'right', render: (v) => (v.margin_pct === null ? '—' : `${v.margin_pct}%`) },
              { key: 'c', header: 'Competitor', render: (v) => (v.competitor_name ? `${v.competitor_name}${v.competitor_price ? ` ₹${v.competitor_price}` : ''}` : '—') },
              { key: 'r', header: 'Why revised', render: (v) => <span className="text-[12.5px] text-slate-600">{v.revision_reason ?? '—'}</span> },
              { key: 'b', header: 'By', render: (v) => <span className="text-[12.5px]">{v.created_by_name}<span className="block text-slate-500">{fmtDate(v.created_at)}</span></span> },
              { key: 's', header: 'Status', render: (v) => <StatusBadge status={v.status} /> },
            ]} />
          </Card>
        </div>
        <div className="space-y-6">
          <Card title="Details">
            <KeyValue columns={1} items={[
              { label: 'Lead', value: x.lead ? <Link className="link" to={`/crm/leads/${x.lead.id}`}>{x.lead.number} · {humanize(x.lead.stage)}</Link> : '—' },
              { label: 'Customer', value: x.customer_id ? <Link className="link" to={`/crm/customers/${x.customer_id}`}>{x.customer_name}</Link> : `${x.prospect_name} (prospect)` },
              { label: 'Ship from', value: x.warehouse_name }, { label: 'Valid until', value: fmtDate(x.valid_until) }, { label: 'Payment', value: x.payment_terms }, { label: 'Delivery', value: x.delivery_terms },
              { label: 'Price approval', value: x.approved_by_name ? `${x.approved_by_name} · ${fmtDateTime(x.approved_at)}` : x.needs_approval ? 'Required' : '—' },
              { label: 'Sent', value: fmtDateTime(x.sent_at) }, ...(x.lost_reason ? [{ label: 'Lost because', value: x.lost_reason }] : []), ...(x.notes ? [{ label: 'Notes', value: x.notes }] : []),
            ]} />
          </Card>
          {x.credit && <CreditCard credit={x.credit} total={Number(x.total)} customerId={x.customer_id!} />}
        </div>
      </div>
      {outcome && <OutcomeModal quote={x} outcome={outcome} onClose={() => setOutcome(null)} onDone={() => { setOutcome(null); q.refetch(); invalidatePrefix(qc, 'crm'); }} />}
    </>
  );
}

export function CreditCard({ credit, total, customerId }: { credit: Credit; total?: number; customerId: string }) {
  const fits = credit.mode === 'advance' || (total ?? 0) <= credit.available;
  return (
    <Card title="Credit" actions={<Link to={`/crm/credit/${customerId}`} className="link text-[12.5px]">Credit file</Link>}>
      {credit.status === 'blocked' ? <Notice tone="danger">Credit blocked: {credit.reason}</Notice> : credit.mode === 'advance' ? <Notice tone="info">Advance customer: payment before dispatch.</Notice> : (
        <>
          <KeyValue columns={1} items={[{ label: 'Limit', value: fmtINR(credit.credit_limit) }, { label: 'Exposure', value: fmtINR(credit.exposure.total) }, { label: 'Available', value: <span className={credit.available < 0 ? 'font-semibold text-rose-600' : 'font-semibold'}>{fmtINR(credit.available)}</span> }]} />
          {total !== undefined && <p className={clsx('mt-3 text-[12.5px]', fits ? 'text-emerald-700' : 'text-rose-600')}>{fits ? 'This quotation fits within available credit.' : 'This quotation exceeds available credit; acceptance needs an approved override.'}</p>}
        </>
      )}
    </Card>
  );
}

function OutcomeModal({ quote, outcome, onClose, onDone }: { quote: Quote; outcome: 'accepted' | 'lost'; onClose: () => void; onDone: () => void }) {
  const [v, setV] = useState({ lost_reason: '', competitor_name: quote.competitor_name ?? '', competitor_price: quote.competitor_price ? String(quote.competitor_price) : '', reserve: true });
  const [err, setErr] = useState<string | null>(null);
  const [res, setRes] = useState<{ warnings: string[]; reservation: { number: string } | null } | null>(null);
  return (
    <Modal open onClose={res ? onDone : onClose} title={outcome === 'accepted' ? 'Customer accepted' : 'Quotation lost'} footer={res ? <Button variant="primary" onClick={onDone}>Done</Button> : <><Button onClick={onClose}>Cancel</Button><Button variant={outcome === 'accepted' ? 'primary' : 'danger'} onClick={async () => {
      try {
        const r = await api.post<{ warnings?: string[]; reservation?: { number: string } | null }>(`/crm/quotations/${quote.id}/outcome`, outcome === 'accepted' ? { outcome, reserve: v.reserve } : { outcome, lost_reason: v.lost_reason, competitor_name: v.competitor_name || null, competitor_price: v.competitor_price ? Number(v.competitor_price) : null });
        if (outcome === 'accepted') setRes({ warnings: r.warnings ?? [], reservation: r.reservation ?? null }); else onDone();
      } catch (e) { setErr((e as Error).message); }
    }}>Confirm</Button></>}>
      <div className="space-y-3">
        {err && <Notice tone="danger" action={err.includes('credit') && quote.customer_id ? <Link className="link" to={`/crm/credit/${quote.customer_id}?override=${quote.id}`}>Request override</Link> : undefined}>{err}</Notice>}
        {res ? <Notice tone="success" title="Order confirmed">{res.reservation ? `Stock reserved on ${res.reservation.number}.` : 'No lots on the quote to reserve.'}{res.warnings.map((w) => <span key={w} className="block text-amber-800">{w}</span>)}</Notice>
          : outcome === 'accepted' ? <><p className="text-[13px] text-slate-600">The credit check runs now. Lots named on the quotation are reserved in {quote.warehouse_name ?? 'the warehouse'}.</p><label className="flex items-center gap-2 text-[13px]"><input type="checkbox" checked={v.reserve} onChange={(e) => setV({ ...v, reserve: e.target.checked })} />Reserve the stock</label></>
          : <><Input label="Why was it lost?" required value={v.lost_reason} onChange={(e) => setV({ ...v, lost_reason: e.target.value })} /><div className="grid grid-cols-2 gap-3"><Input label="Lost to" value={v.competitor_name} onChange={(e) => setV({ ...v, competitor_name: e.target.value })} /><Input label="Their price / kg" type="number" prefix="₹" value={v.competitor_price} onChange={(e) => setV({ ...v, competitor_price: e.target.value })} /></div></>}
      </div>
    </Modal>
  );
}

interface Approval { id: string; ref_id: string; approval_type: string; requested_by: string; requested_by_name: string; requested_at: string; status: string }
/** Approver’s view of quotations waiting on price: list, requested, discount, cost and margin per line. */
export function PriceApprovalsPage() {
  const { can, user } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const quotes = useQuery({ queryKey: ['crm-quotes', 'pending'], queryFn: () => api.get<QRow[]>('/crm/quotations?status=pending_approval') });
  const approvals = useQuery({ queryKey: ['approvals-pending'], queryFn: () => api.get<Page<Approval>>('/governance/approvals?f_status=pending&pageSize=200').then((r) => r.items) });
  const [comment, setComment] = useState<Record<string, string>>({});
  const details = useQuery({ queryKey: ['crm-quote-details', quotes.data?.map((x) => x.id).join()], queryFn: () => Promise.all((quotes.data ?? []).map((x) => api.get<Quote>(`/crm/quotations/${x.id}`))), enabled: !!quotes.data });
  const byRef = useMemo(() => new Map((approvals.data ?? []).filter((a) => a.approval_type === 'quotation_price').map((a) => [a.ref_id, a])), [approvals.data]);
  const decide = async (q: Quote, decision: 'approved' | 'rejected') => {
    const a = byRef.get(q.id);
    if (!a) return toast({ tone: 'error', title: 'Approval request not found' });
    try { await api.post(`/governance/approvals/${a.id}/decide`, { decision, comment: comment[q.id] || null }); toast({ tone: 'success', title: `${q.number} ${decision}` }); setTimeout(() => { quotes.refetch(); approvals.refetch(); invalidatePrefix(qc, 'crm'); }, 400); } catch (e) { toast({ tone: 'error', title: (e as Error).message }); }
  };
  return (
    <>
      <PageHeader title="Price approvals" description="Quotations where a line is below the minimum margin or beyond the salesperson’s discount authority. List price, requested price, cost and margin are preserved with the approver and reason."
        breadcrumbs={[{ label: 'Sales & CRM', to: '/crm' }, { label: 'Price approvals' }]} />
      {!details.data ? <Skeleton className="h-60" /> : details.data.length === 0 ? <Card><EmptyState icon={<CheckCircle2 className="size-5" />} title="Nothing waiting for price approval" /></Card> : (
        <div className="space-y-4">
          {details.data.map((x) => {
            const a = byRef.get(x.id);
            const own = a?.requested_by === user?.id;
            return (
              <Card key={x.id} title={<Link className="hover:underline" to={`/crm/quotations/${x.id}`}><span className="font-mono">{x.number} v{x.version}</span> · {x.customer_name ?? x.prospect_name}</Link>} description={`${x.owner_name} · ${fmtINR(Number(x.total))} · overall margin ${x.margin_pct ?? '—'}%${x.competitor_name ? ` · competitor ${x.competitor_name}${x.competitor_price ? ` at ₹${x.competitor_price}` : ''}` : ''}`} padded={false}>
                <SimpleTable rows={x.lines} rowKey={(l) => String(l.line_no)} columns={[
                  { key: 's', header: 'Fabric', render: (l) => <span className="font-mono text-[12.5px]">{l.sku}{l.lot_no ? ` · ${l.lot_no}` : ''}</span> },
                  { key: 'k', header: 'KG', align: 'right', render: (l) => fmtNum(Number(l.kg)) },
                  { key: 'lp', header: 'List', align: 'right', render: (l) => (l.list_price ? `₹${l.list_price}` : '—') },
                  { key: 'rp', header: 'Requested', align: 'right', render: (l) => <b>₹{l.requested_price}</b> },
                  { key: 'd', header: 'Discount', align: 'right', render: (l) => (l.discount_pct === null ? '—' : `${l.discount_pct}%`) },
                  { key: 'c', header: 'Cost', align: 'right', render: (l) => (l.cost_per_kg ? `₹${l.cost_per_kg}` : '—') },
                  { key: 'm', header: 'Margin', align: 'right', render: (l) => (l.margin_pct === null ? '—' : <span className={Number(l.margin_pct) < 8 ? 'font-semibold text-rose-600' : ''}>{l.margin_pct}%</span>) },
                  { key: 'r', header: 'Why', render: (l) => (l.needs_approval ? <span className="text-[12.5px] text-amber-800">{l.approval_reason}</span> : <span className="text-slate-400">within authority</span>) },
                ]} />
                <div className="flex flex-wrap items-center gap-2 border-t border-slate-100 px-5 py-3">
                  {own ? <Notice tone="warning">You raised this quotation, so someone else must approve it.</Notice> : !can('crm.price.approve') ? <span className="text-[12.5px] text-slate-500">You don’t have price approval rights.</span> : <>
                    <input className="input h-9 min-w-[240px] flex-1" placeholder="Comment (required to reject)" value={comment[x.id] ?? ''} onChange={(e) => setComment({ ...comment, [x.id]: e.target.value })} />
                    <Button variant="danger" disabled={!comment[x.id]} onClick={() => void decide(x, 'rejected')}>Reject</Button>
                    <Button variant="primary" onClick={() => void decide(x, 'approved')}>Approve</Button>
                  </>}
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </>
  );
}
