import { useQuery, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { Award, Plus, Trophy } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, invalidatePrefix } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { fmtDate, fmtINR, fmtNum } from '../../lib/format';
import { DataTable, FilterSelect } from '../../components/DataTable';
import { DeliverTo, LineEditor, emptyLine, linesPayload, useParties, type Line } from '../../components/business';
import { Drawer, Modal, useToast } from '../../components/overlay';
import { Badge, Button, Card, Checkbox, EmptyState, ErrorState, Input, KeyValue, Notice, PageHeader, Skeleton, StatusBadge, Textarea } from '../../components/ui';

interface RfqRow { id: string; number: string; title: string; due_date: string; deliver_to_name: string; status: string; invited: number; quotes_received: number; total_kg: number; po_number: string | null; po_id: string | null }
interface RfqLine { id: string; line_no: number; product_id: string; sku: string; product_name: string; qty_kg: number; gst_rate: number }
interface Quote { id: string; supplier_id: string; supplier_name: string; quote_ref: string | null; valid_until: string | null; lead_time_days: number | null; freight_per_kg: number; payment_terms: string | null; quality_notes: string | null; status: string; lines: { rfq_line_id: string; rate_per_kg: number }[] }
interface Cmp { quote_id: string; supplier_id: string; supplier_name: string; landed_total: number; material_total: number; freight_total: number; complete: boolean; lead_time_days: number | null; past_pos: number; on_time_pct: number | null; rejection_pct: number | null }
interface RfqDetail extends RfqRow { terms: string | null; requisition_id: string | null; lines: RfqLine[]; suppliers: { supplier_id: string; supplier_name: string; supplier_code: string }[]; quotes: Quote[]; comparison: { line_count: number; suppliers: Cmp[]; lowest_landed: string | null } }

export function RfqsPage() {
  const { can } = useAuth();
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [creating, setCreating] = useState(!!params.get('fromRequisition'));
  return (
    <>
      <PageHeader title="RFQs & quotations" description="Invite several suppliers, record their quotes and compare landed cost, lead time and track record before awarding." breadcrumbs={[{ label: 'Procurement', to: '/procurement' }, { label: 'RFQs' }]}
        actions={can('procurement.rfq.manage') && <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>New RFQ</Button>} />
      <DataTable<RfqRow>
        id="rfqs" endpoint="/procurement/rfqs" filters={filters} onFiltersChange={setFilters} defaultSort={{ key: 'created_at', dir: 'desc' }} onRowClick={(r) => nav(`/procurement/rfqs/${r.id}`)}
        toolbar={<FilterSelect placeholder="All statuses" value={filters.status} onChange={(v) => setFilters({ ...filters, status: v })} options={[{ value: 'open', label: 'Open' }, { value: 'awarded', label: 'Awarded' }, { value: 'cancelled', label: 'Cancelled' }]} />}
        columns={[
          { key: 'number', header: 'Number', sort: 'number', csv: (r) => r.number, render: (r) => <span className="font-mono text-[12.5px] font-semibold text-slate-900">{r.number}</span> },
          { key: 'title', header: 'Title', csv: (r) => r.title, render: (r) => r.title },
          { key: 'kg', header: 'Quantity', align: 'right', csv: (r) => r.total_kg, render: (r) => fmtNum(r.total_kg, 'kg') },
          { key: 'quotes', header: 'Quotes', csv: (r) => `${r.quotes_received}/${r.invited}`, render: (r) => <span className="tabular">{r.quotes_received} of {r.invited}</span> },
          { key: 'due', header: 'Due', sort: 'due_date', csv: (r) => r.due_date, render: (r) => fmtDate(r.due_date) },
          { key: 'po', header: 'PO', csv: (r) => r.po_number, render: (r) => (r.po_number ? <span className="font-mono text-[12px]">{r.po_number}</span> : '—') },
          { key: 'status', header: 'Status', sort: 'status', csv: (r) => r.status, render: (r) => <StatusBadge status={r.status} /> },
        ]}
        empty={{ title: 'No RFQs yet' }}
      />
      {creating && <RfqForm requisitionId={params.get('fromRequisition')} onClose={() => { setCreating(false); setParams({}); }} onCreated={(id) => nav(`/procurement/rfqs/${id}`)} />}
    </>
  );
}

function RfqForm({ requisitionId, onClose, onCreated }: { requisitionId: string | null; onClose: () => void; onCreated: (id: string) => void }) {
  const qc = useQueryClient();
  const suppliers = useParties('supplier,manufacturer');
  const pr = useQuery({ queryKey: ['requisition', requisitionId], queryFn: () => api.get<{ title: string; deliver_to_type: 'warehouse' | 'mill'; deliver_to_id: string; required_by: string; lines: { product_id: string; qty_kg: number }[] }>(`/procurement/requisitions/${requisitionId}`), enabled: !!requisitionId });
  const [title, setTitle] = useState('');
  const [due, setDue] = useState(new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10));
  const [dest, setDest] = useState<{ type: 'warehouse' | 'mill'; id: string }>({ type: 'warehouse', id: '' });
  const [terms, setTerms] = useState('');
  const [invite, setInvite] = useState<string[]>([]);
  const [lines, setLines] = useState<Line[]>([emptyLine()]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!pr.data) return;
    setTitle(pr.data.title);
    setDest({ type: pr.data.deliver_to_type, id: pr.data.deliver_to_id });
    setLines(pr.data.lines.map((l) => ({ product_id: l.product_id, qty_kg: String(l.qty_kg) })));
  }, [pr.data]);
  async function save() {
    try {
      const r = await api.post<{ id: string }>('/procurement/rfqs', { title, requisition_id: requisitionId, due_date: due, deliver_to_type: dest.type, deliver_to_id: dest.id, terms, supplier_ids: invite, lines: linesPayload(lines) });
      invalidatePrefix(qc, '/procurement/rfqs', '/procurement/requisitions');
      onCreated(r.id);
    } catch (e) { setError((e as Error).message); }
  }
  return (
    <Drawer open onClose={onClose} width="xl" title="New RFQ" description={requisitionId ? 'From an approved requisition' : undefined} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={save}>Create RFQ</Button></>}>
      <div className="space-y-5">
        {error && <Notice tone="danger">{error}</Notice>}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Input label="Title" required className="sm:col-span-2" value={title} onChange={(e) => setTitle(e.target.value)} />
          <Input label="Quotes due" type="date" required value={due} onChange={(e) => setDue(e.target.value)} />
        </div>
        <DeliverTo type={dest.type} id={dest.id} onChange={(type, id) => setDest({ type, id })} />
        <LineEditor lines={lines} onChange={setLines} />
        <div>
          <p className="label">Invite suppliers</p>
          <div className="grid max-h-56 grid-cols-1 gap-1.5 overflow-y-auto rounded-lg border border-slate-200 p-3 sm:grid-cols-2">
            {suppliers.data?.map((s) => <Checkbox key={s.id} label={s.legal_name} description={`${s.code}${s.gstin ? ` · ${s.gstin}` : ''}`} checked={invite.includes(s.id)} onChange={(e) => setInvite((x) => (e.target.checked ? [...x, s.id] : x.filter((y) => y !== s.id)))} />)}
          </div>
        </div>
        <Textarea label="Terms" value={terms} onChange={(e) => setTerms(e.target.value)} placeholder="Delivery, payment, quality requirements…" />
      </div>
    </Drawer>
  );
}

export function RfqDetailPage() {
  const { id = '' } = useParams();
  const { can } = useAuth();
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['rfq', id], queryFn: () => api.get<RfqDetail>(`/procurement/rfqs/${id}`) });
  const [quoteFor, setQuoteFor] = useState<string | null>(null);
  const [award, setAward] = useState<Cmp | null>(null);
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  if (!q.data) return <Skeleton className="h-96" />;
  const r = q.data;
  const open = r.status === 'open' && can('procurement.rfq.manage');
  const cheapest = r.comparison.lowest_landed;
  const rate = (supplierId: string, lineId: string) => r.quotes.find((x) => x.supplier_id === supplierId)?.lines.find((l) => l.rfq_line_id === lineId)?.rate_per_kg;
  const bestRate = (lineId: string) => Math.min(...r.quotes.map((x) => x.lines.find((l) => l.rfq_line_id === lineId)?.rate_per_kg ?? Infinity));

  return (
    <>
      <PageHeader breadcrumbs={[{ label: 'Procurement', to: '/procurement' }, { label: 'RFQs', to: '/procurement/rfqs' }, { label: r.number }]} title={<>{r.title} <StatusBadge status={r.status} /></>}
        meta={<><span className="font-mono">{r.number}</span><span>Due {fmtDate(r.due_date)}</span><span>Deliver to {r.deliver_to_name}</span>{r.po_id && <Link className="link" to={`/procurement/purchase-orders/${r.po_id}`}>PO {r.po_number}</Link>}</>} />
      <div className="space-y-6">
        <Card title="Quote comparison" description="Landed cost = material + freight. Lowest complete landed cost is marked; track record comes from past purchase orders." padded={false}>
          {r.quotes.length === 0 ? <EmptyState title="No quotes recorded yet" description="Record each supplier's quote as it arrives." /> : (
            <div className="scrollbar-thin overflow-x-auto">
              <table className="w-full text-left text-[13px]">
                <thead className="bg-slate-50 text-[11px] tracking-wide text-slate-500 uppercase">
                  <tr>
                    <th className="px-4 py-2">Line</th>
                    {r.comparison.suppliers.map((s) => <th key={s.supplier_id} className={clsx('px-4 py-2 text-right', s.supplier_id === cheapest && 'bg-emerald-50 text-emerald-800')}>{s.supplier_name}{s.supplier_id === cheapest && <Trophy className="ml-1 inline size-3.5" />}</th>)}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {r.lines.map((l) => (
                    <tr key={l.id}>
                      <td className="px-4 py-2.5"><p className="font-mono text-[12px] font-semibold">{l.sku}</p><p className="text-[12px] text-slate-500">{fmtNum(l.qty_kg, 'kg')}</p></td>
                      {r.comparison.suppliers.map((s) => {
                        const v = rate(s.supplier_id, l.id);
                        return <td key={s.supplier_id} className={clsx('px-4 py-2.5 text-right tabular', v === bestRate(l.id) && 'font-semibold text-emerald-700')}>{v ? `₹${v}/kg` : <span className="text-slate-300">—</span>}</td>;
                      })}
                    </tr>
                  ))}
                  {[
                    ['Material', (s: Cmp) => fmtINR(s.material_total)],
                    ['Freight', (s: Cmp) => fmtINR(s.freight_total)],
                    ['Landed total', (s: Cmp) => <span className="font-semibold text-slate-900">{fmtINR(s.landed_total)}</span>],
                    ['Lead time', (s: Cmp) => (s.lead_time_days != null ? `${s.lead_time_days} days` : '—')],
                    ['On-time history', (s: Cmp) => (s.on_time_pct != null ? `${s.on_time_pct}% of ${s.past_pos} POs` : 'No history')],
                    ['Rejections', (s: Cmp) => (s.rejection_pct != null ? `${s.rejection_pct}%` : '—')],
                  ].map(([label, fn]) => (
                    <tr key={label as string} className="bg-slate-50/50">
                      <td className="px-4 py-2 text-[12px] font-medium text-slate-600">{label as string}</td>
                      {r.comparison.suppliers.map((s) => <td key={s.supplier_id} className="px-4 py-2 text-right text-[12.5px] tabular">{(fn as (s: Cmp) => React.ReactNode)(s)}</td>)}
                    </tr>
                  ))}
                  {open && (
                    <tr>
                      <td />
                      {r.comparison.suppliers.map((s) => <td key={s.supplier_id} className="px-4 py-3 text-right">{s.complete ? <Button size="sm" variant={s.supplier_id === cheapest ? 'primary' : 'secondary'} icon={<Award className="size-3.5" />} onClick={() => setAward(s)}>Award</Button> : <Badge tone="warning">Incomplete</Badge>}</td>)}
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </Card>
        <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
          <Card title="Invited suppliers" padded={false}>
            <ul className="divide-y divide-slate-100">
              {r.suppliers.map((s) => {
                const quote = r.quotes.find((x) => x.supplier_id === s.supplier_id);
                return (
                  <li key={s.supplier_id} className="flex items-center gap-3 px-5 py-3">
                    <div className="min-w-0 flex-1"><p className="text-[13.5px] font-medium text-slate-900">{s.supplier_name}</p><p className="text-[12px] text-slate-500">{quote ? `Quote ${quote.quote_ref ?? ''} · ${quote.payment_terms ?? 'terms not stated'}` : 'Awaiting quote'}</p></div>
                    {quote ? <StatusBadge status={quote.status === 'received' ? 'received_quote' : quote.status} /> : <Badge>Pending</Badge>}
                    {open && <Button size="xs" onClick={() => setQuoteFor(s.supplier_id)}>{quote ? 'Edit quote' : 'Record quote'}</Button>}
                  </li>
                );
              })}
            </ul>
          </Card>
          <Card title="Details"><KeyValue columns={2} items={[{ label: 'Deliver to', value: r.deliver_to_name }, { label: 'Quotes due', value: fmtDate(r.due_date) }, { label: 'Terms', value: r.terms }]} /></Card>
        </div>
      </div>
      {quoteFor && <QuoteModal rfq={r} supplierId={quoteFor} onClose={() => setQuoteFor(null)} onSaved={() => { q.refetch(); invalidatePrefix(qc, '/procurement/rfqs'); }} />}
      {award && <AwardModal rfq={r} cmp={award} lowest={cheapest} onClose={() => setAward(null)} onDone={(poId) => { toast({ tone: 'success', title: 'Draft PO created', body: 'Review it and submit for approval.' }); nav(`/procurement/purchase-orders/${poId}`); }} />}
    </>
  );
}

function QuoteModal({ rfq, supplierId, onClose, onSaved }: { rfq: RfqDetail; supplierId: string; onClose: () => void; onSaved: () => void }) {
  const existing = rfq.quotes.find((q) => q.supplier_id === supplierId);
  const toast = useToast();
  const [v, setV] = useState({ quote_ref: existing?.quote_ref ?? '', valid_until: existing?.valid_until ?? '', lead_time_days: existing?.lead_time_days?.toString() ?? '', freight_per_kg: existing?.freight_per_kg?.toString() ?? '0', payment_terms: existing?.payment_terms ?? '', quality_notes: existing?.quality_notes ?? '' });
  const [rates, setRates] = useState<Record<string, string>>(Object.fromEntries(rfq.lines.map((l) => [l.id, existing?.lines.find((x) => x.rfq_line_id === l.id)?.rate_per_kg?.toString() ?? ''])));
  const [error, setError] = useState<string | null>(null);
  async function save() {
    try {
      await api.put(`/procurement/rfqs/${rfq.id}/quotes`, { supplier_id: supplierId, quote_ref: v.quote_ref, valid_until: v.valid_until || null, lead_time_days: v.lead_time_days ? Number(v.lead_time_days) : null, freight_per_kg: Number(v.freight_per_kg || 0), payment_terms: v.payment_terms, quality_notes: v.quality_notes, lines: rfq.lines.filter((l) => rates[l.id]).map((l) => ({ rfq_line_id: l.id, rate_per_kg: Number(rates[l.id]) })) });
      toast({ tone: 'success', title: 'Quote saved' });
      onSaved();
      onClose();
    } catch (e) { setError((e as Error).message); }
  }
  return (
    <Modal open onClose={onClose} size="lg" title={`Quote from ${rfq.suppliers.find((s) => s.supplier_id === supplierId)?.supplier_name}`} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={save}>Save quote</Button></>}>
      <div className="space-y-4">
        {error && <Notice tone="danger">{error}</Notice>}
        <div className="grid grid-cols-3 gap-3">
          <Input label="Quote reference" value={v.quote_ref} onChange={(e) => setV({ ...v, quote_ref: e.target.value })} />
          <Input label="Valid until" type="date" value={v.valid_until} onChange={(e) => setV({ ...v, valid_until: e.target.value })} />
          <Input label="Lead time" type="number" suffix="days" value={v.lead_time_days} onChange={(e) => setV({ ...v, lead_time_days: e.target.value })} />
          <Input label="Freight" type="number" suffix="₹/kg" value={v.freight_per_kg} onChange={(e) => setV({ ...v, freight_per_kg: e.target.value })} />
          <Input label="Payment terms" className="col-span-2" value={v.payment_terms} onChange={(e) => setV({ ...v, payment_terms: e.target.value })} />
        </div>
        <div className="rounded-lg border border-slate-200">
          {rfq.lines.map((l) => (
            <div key={l.id} className="flex items-center gap-3 border-b border-slate-100 px-3 py-2 last:border-0">
              <span className="flex-1 text-[13px]"><span className="font-mono font-semibold">{l.sku}</span> · {fmtNum(l.qty_kg, 'kg')}</span>
              <input className="input h-8 w-32 text-right tabular" type="number" placeholder="₹/kg" value={rates[l.id]} onChange={(e) => setRates({ ...rates, [l.id]: e.target.value })} />
            </div>
          ))}
        </div>
        <Textarea label="Quality notes" value={v.quality_notes} onChange={(e) => setV({ ...v, quality_notes: e.target.value })} />
      </div>
    </Modal>
  );
}

function AwardModal({ rfq, cmp, lowest, onClose, onDone }: { rfq: RfqDetail; cmp: Cmp; lowest: string | null; onClose: () => void; onDone: (poId: string) => void }) {
  const [expected, setExpected] = useState(new Date(Date.now() + (cmp.lead_time_days ?? 14) * 86_400_000).toISOString().slice(0, 10));
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const notLowest = cmp.supplier_id !== lowest;
  return (
    <Modal open onClose={onClose} title={`Award to ${cmp.supplier_name}?`} description={`Landed ${fmtINR(cmp.landed_total)}. A draft purchase order is created for approval; nothing is sent yet.`}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={notLowest && reason.trim().length < 3} onClick={async () => {
        try { const po = await api.post<{ id: string }>(`/procurement/rfqs/${rfq.id}/award`, { quote_id: cmp.quote_id, expected_date: expected, reason: reason || null }); onDone(po.id); } catch (e) { setError((e as Error).message); }
      }}>Create draft PO</Button></>}>
      <div className="space-y-4">
        {error && <Notice tone="danger">{error}</Notice>}
        {notLowest && <Notice tone="warning">This is not the lowest landed cost. Record why.</Notice>}
        <Input label="Expected delivery" type="date" value={expected} onChange={(e) => setExpected(e.target.value)} />
        {notLowest && <Textarea label="Reason" required value={reason} onChange={(e) => setReason(e.target.value)} />}
      </div>
    </Modal>
  );
}
