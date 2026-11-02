import { useQuery, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { AlertTriangle, ArrowRight, Building2, CheckCircle2, CreditCard, FileText, LifeBuoy, LogOut, Minus, Package, Plus, RotateCcw, Search, ShoppingCart, Trash2, Truck, Users, Wallet } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { NavLink, useNavigate, useParams } from 'react-router-dom';
import { Link } from '../../components/AppLink';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { fmtDate, fmtDateTime, fmtINR, fmtNum, humanize } from '../../lib/format';
import { SimpleTable } from '../../components/DataTable';
import { Modal, useToast } from '../../components/overlay';
import { Avatar, Badge, Button, Card, EmptyState, ErrorState, Input, KeyValue, Notice, Select, Skeleton, Stat, StatusBadge, Textarea, BackButton } from '../../components/ui';

// ---------- layout ----------
export function CustomerPortalLayout({ children }: { children: ReactNode }) {
  const { user, can, signOut } = useAuth();
  const nav = useNavigate();
  const cart = useQuery({ queryKey: ['cust-cart-count'], queryFn: () => api.get<{ lines: unknown[] }>('/commerce/portal/cart').then((c) => c.lines.length), enabled: can('portal.customer.order'), refetchInterval: 30_000 });
  const links: [string, string, ReactNode][] = [
    ...(can('portal.customer.order') ? [['/shop', 'Fabrics', <Package key="p" className="size-4" />] as [string, string, ReactNode]] : []),
    ['/portal/orders', 'Orders', <FileText key="o" className="size-4" />],
    ...(can('portal.customer.accounts', 'portal.customer.order') ? [['/portal/account', 'Account', <Wallet key="w" className="size-4" />] as [string, string, ReactNode]] : []),
    ['/portal/support', 'Support', <LifeBuoy key="s" className="size-4" />],
    ...(can('portal.customer.admin') ? [['/portal/company', 'Company', <Building2 key="c" className="size-4" />] as [string, string, ReactNode]] : []),
  ];
  return (
    <div className="min-h-screen bg-slate-50">
      <header className="sticky top-0 z-20 border-b border-slate-200 bg-white/95 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-4 px-4">
          <Link to="/shop" aria-label="Demo Textile Trading: trade portal home" className="flex items-center gap-2.5"><img src="/favicon.svg" alt="" className="size-7" /><div className="hidden leading-tight sm:block"><p className="text-[13.5px] font-semibold">Demo Textile Trading</p><p className="text-[11px] text-slate-500">Trade portal</p></div></Link>
          <nav className="flex gap-0.5 overflow-x-auto">
            {links.map(([to, label, icon]) => <NavLink key={to} to={to} aria-label={label} title={label} className={({ isActive }) => clsx('flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[13.5px] whitespace-nowrap', isActive ? 'bg-brand-50 font-medium text-brand-700' : 'text-slate-600 hover:bg-slate-100')}>{icon}<span className="hidden md:inline">{label}</span></NavLink>)}
          </nav>
          <div className="ml-auto flex items-center gap-2">
            {can('portal.customer.order') && <Link to="/cart" className="relative rounded-md p-2 text-slate-600 hover:bg-slate-100" aria-label="Cart"><ShoppingCart className="size-5" />{!!cart.data && <span className="absolute -top-0.5 -right-0.5 flex size-4 items-center justify-center rounded-full bg-brand-600 text-[10px] font-bold text-white">{cart.data}</span>}</Link>}
            <Avatar name={user?.name ?? '?'} size="sm" /><span className="hidden text-[13px] lg:block">{user?.name}</span>
            <Button size="sm" variant="ghost" aria-label="Sign out" icon={<LogOut className="size-4" />} onClick={() => void signOut().then(() => nav('/login'))}><span className="hidden sm:inline">Sign out</span></Button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-7">{children}</main>
    </div>
  );
}

const SWATCH: Record<string, string> = { navy: '#1e2a4a', black: '#1f1f22', white: '#f4f4f0', 'optical white': '#fafafa', charcoal: '#3b3f46', 'grey melange': '#9ca3af', 'charcoal melange': '#4b5058' };
const swatch = (a: Record<string, unknown>) => SWATCH[String(a.colour ?? '').toLowerCase()] ?? (String(a.processing_type ?? '').includes('RFD') ? '#ede7da' : '#cbd5e1');

// ---------- catalogue ----------
interface CatItem { id: string; sku: string; name: string; category: string; attributes: Record<string, unknown>; moq_kg: number; available_kg: number; lots: number; shades: number; price_from: number | null; price_to: number | null; status: string }

export function ShopPage() {
  const nav = useNavigate();
  const [q, setQ] = useState('');
  const [dq, setDq] = useState('');
  const [cat, setCat] = useState('');
  useEffect(() => { const t = setTimeout(() => setDq(q), 250); return () => clearTimeout(t); }, [q]);
  const list = useQuery({ queryKey: ['shop', dq], queryFn: () => api.get<CatItem[]>(`/commerce/catalogue${dq ? `?q=${encodeURIComponent(dq)}` : ''}`) });
  const cats = [...new Set((list.data ?? []).map((x) => x.category))];
  const items = (list.data ?? []).filter((x) => !cat || x.category === cat);
  return (
    <>
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div><h1 className="text-[24px] font-semibold tracking-tight">Knitted fabrics in stock</h1><p className="text-[13.5px] text-slate-600">Graded, QC-passed lots ready to dispatch from Surat, Kolkata and Tiruppur. Prices per kg, GST extra.</p></div>
        <div className="relative w-full max-w-xs"><Search className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-slate-400" /><input className="input pl-9" placeholder="GSM, colour, SKU…" value={q} onChange={(e) => setQ(e.target.value)} /></div>
      </div>
      <div className="mb-5 flex flex-wrap gap-1.5">
        <Button size="sm" variant={!cat ? 'primary' : 'secondary'} onClick={() => setCat('')}>All</Button>
        {cats.map((c) => <Button key={c} size="sm" variant={cat === c ? 'primary' : 'secondary'} onClick={() => setCat(c)}>{c}</Button>)}
      </div>
      {list.isError ? <ErrorState error={list.error} /> : !list.data ? <Skeleton className="h-72" /> : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {items.map((p) => (
            <button key={p.id} onClick={() => nav(`/shop/${p.id}`)} className={clsx('card group overflow-hidden text-left transition hover:border-slate-300 hover:shadow-md', p.status !== 'in_stock' && 'bg-slate-50')}>
              <div className={clsx('relative h-28', p.status !== 'in_stock' && 'grayscale')} style={{ background: `linear-gradient(135deg, ${swatch(p.attributes)} 0%, ${swatch(p.attributes)}dd 100%)` }}>
                <div className="absolute inset-0 opacity-20" style={{ backgroundImage: 'repeating-linear-gradient(90deg, transparent 0 3px, rgba(255,255,255,.35) 3px 4px)' }} />
                <span className="absolute top-3 left-3 rounded bg-white/90 px-1.5 py-0.5 font-mono text-[11px] font-semibold text-slate-800">{p.sku}</span>
                {p.status !== 'in_stock' && <span className="absolute top-3 right-3 rounded bg-white/90 px-1.5 py-0.5 text-[11px] font-medium text-slate-700">Out of stock</span>}
              </div>
              <div className="p-4">
                <p className="text-[12px] text-slate-500">{p.category}</p>
                <p className="font-medium text-slate-900">{p.name}</p>
                <p className="mt-1 text-[12.5px] text-slate-600">{[p.attributes.gsm && `${p.attributes.gsm} GSM`, p.attributes.width && `${p.attributes.width}"`, p.attributes.composition].filter(Boolean).join(' · ')}</p>
                <div className="mt-3 flex items-end justify-between">
                  <div><p className="text-[18px] font-semibold tabular">{p.price_from ? `₹${fmtNum(p.price_from)}${p.price_to && p.price_to !== p.price_from ? `–${fmtNum(p.price_to)}` : ''}` : <span className="text-[14px] text-slate-500">Price on request</span>}<span className="text-[12px] font-normal text-slate-500">{p.price_from ? ' /kg' : ''}</span></p><p className="text-[12px] text-slate-500">MOQ {fmtNum(p.moq_kg)} kg</p></div>
                  <div className="text-right"><p className="text-[13px] font-semibold text-emerald-700 tabular">{fmtNum(Math.floor(p.available_kg))} kg</p><p className="text-[11.5px] text-slate-500">{p.lots} lot{p.lots === 1 ? '' : 's'} · {p.shades} shade{p.shades === 1 ? '' : 's'}</p></div>
                </div>
              </div>
            </button>
          ))}
          {!items.length && <div className="col-span-full"><EmptyState title="No fabrics match" /></div>}
        </div>
      )}
    </>
  );
}

interface Product { id: string; sku: string; name: string; category: string; description: string | null; attributes: Record<string, unknown>; hsn_code: string; gst_rate: number; moq_kg: number; lots: { id: string; lot_no: string; grade: string | null; dye_lot: string | null; shade_code: string | null; available_kg: number; price_per_kg: number | null; received_date: string; locations: string[] }[] }

export function ProductPage() {
  const { id = '' } = useParams();
  const toast = useToast();
  const qc = useQueryClient();
  const nav = useNavigate();
  const q = useQuery({ queryKey: ['shop-product', id], queryFn: () => api.get<Product>(`/commerce/catalogue/${id}`) });
  const [kg, setKg] = useState<Record<string, string>>({});
  if (q.isError) return <ErrorState error={q.error} />;
  const p = q.data;
  if (!p) return <Skeleton className="h-96" />;
  const add = async (lotId: string) => {
    const v = Number(kg[lotId]);
    if (!v) return;
    try { await api.post('/commerce/portal/cart/add', { product_id: p.id, lot_id: lotId, kg: v }); qc.invalidateQueries({ queryKey: ['cust-cart-count'] }); toast({ tone: 'success', title: `${v} kg added to cart`, body: p.sku }); setKg({ ...kg, [lotId]: '' }); } catch (e) { toast({ tone: 'error', title: (e as Error).message }); }
  };
  const specs = Object.entries(p.attributes).filter(([, v]) => v !== null && v !== '').map(([k, v]) => ({ label: humanize(k), value: Array.isArray(v) ? v.join(', ') : String(v) }));
  return (
    <>
      <Link to="/shop" className="link mb-4 inline-block text-[13px]">← All fabrics</Link>
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_1.4fr]">
        <div className="space-y-4">
          <div className="h-56 rounded-xl" style={{ background: swatch(p.attributes), backgroundImage: 'repeating-linear-gradient(90deg, transparent 0 3px, rgba(255,255,255,.18) 3px 4px)' }} />
          <Card title="Specification"><KeyValue columns={2} items={[{ label: 'HSN', value: p.hsn_code }, { label: 'GST', value: `${p.gst_rate}%` }, { label: 'Minimum order', value: `${fmtNum(p.moq_kg)} kg` }, ...specs]} /></Card>
        </div>
        <div>
          <p className="font-mono text-[12.5px] text-slate-500">{p.sku} · {p.category}</p>
          <h1 className="text-[24px] font-semibold tracking-tight">{p.name}</h1>
          {p.description && <p className="mt-1 text-[13.5px] text-slate-600">{p.description}</p>}
          <Card className="mt-5" title="Choose a lot" description="Each lot is one dye lot — order from a single lot for an even shade. Stock shown is graded and ready to dispatch." padded={false}>
            {!p.lots.length ? <EmptyState title="Out of stock" description="Ask your account manager for the next arrival." /> : (
              <div className="divide-y divide-slate-100">
                {p.lots.map((l) => (
                  <div key={l.id} className="flex flex-wrap items-center gap-3 px-5 py-3">
                    <div className="min-w-[160px] flex-1">
                      <p className="font-mono text-[12.5px] font-semibold">{l.lot_no}</p>
                      <p className="text-[12px] text-slate-500">Dye lot {l.dye_lot ?? '—'}{l.shade_code ? ` · shade ${l.shade_code}` : ''} · Grade {l.grade ?? '—'} · {l.locations.join(', ')}</p>
                    </div>
                    <div className="text-right"><p className="font-semibold tabular">{l.price_per_kg ? `₹${fmtNum(l.price_per_kg)}/kg` : 'On request'}</p><p className="text-[12px] text-emerald-700 tabular">{fmtNum(Math.floor(l.available_kg))} kg available</p></div>
                    <div className="flex items-center gap-1.5">
                      <input className="input h-9 w-24" type="number" min={p.moq_kg} placeholder={`${p.moq_kg}+ kg`} value={kg[l.id] ?? ''} onChange={(e) => setKg({ ...kg, [l.id]: e.target.value })} />
                      <Button variant="primary" icon={<ShoppingCart className="size-4" />} disabled={!Number(kg[l.id])} onClick={() => void add(l.id)}>Add</Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Card>
          <div className="mt-4 flex justify-end"><Button icon={<ArrowRight className="size-4" />} onClick={() => nav('/cart')}>Go to cart</Button></div>
        </div>
      </div>
    </>
  );
}

// ---------- cart & checkout ----------
interface Cart { lines: { id: string; product_id: string; sku: string; product_name: string; lot_id: string; lot_no: string; dye_lot: string | null; grade: string | null; kg: number; price_per_kg: number; taxable: number; available_kg: number; moq_kg: number; problems: string[]; gst_rate: number }[]; taxable: number; tax_estimate: number; total_estimate: number; terms: 'advance' | 'credit'; credit: { available: number; mode: string } | null; token: { amount: number; text: string; validity_days: number; refundable: boolean; cancellation_fee_pct: number } | null; needs_company_approval: boolean; approval_limit: number | null }

export function CartPage() {
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['cust-cart'], queryFn: () => api.get<Cart>('/commerce/portal/cart') });
  const [shipTo, setShipTo] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const c = q.data;
  const save = async (lines: { product_id: string; lot_id: string; kg: number }[]) => { await api.put('/commerce/portal/cart', { lines }); q.refetch(); qc.invalidateQueries({ queryKey: ['cust-cart-count'] }); };
  const setKg = (id: string, kg: number) => c && void save(c.lines.map((l) => ({ product_id: l.product_id, lot_id: l.lot_id, kg: l.id === id ? Math.max(1, kg) : l.kg })));
  const checkout = async () => {
    setBusy(true);
    try {
      const o = await api.post<{ id: string; status: string; payment?: { link_token: string }; message?: string }>('/commerce/portal/cart/checkout', { ship_to: shipTo || null, notes: notes || null });
      qc.invalidateQueries({ queryKey: ['cust-cart-count'] });
      if (o.status === 'pending_payment' && o.payment) nav(`/pay/${o.payment.link_token}`);
      else nav(`/portal/orders/${o.id}`);
    } catch (e) { toast({ tone: 'error', title: (e as Error).message }); q.refetch(); } finally { setBusy(false); }
  };
  const problems = c?.lines.some((l) => l.problems.length);
  return (
    <>
      <h1 className="mb-5 text-[24px] font-semibold tracking-tight">Cart</h1>
      {!c ? <Skeleton className="h-72" /> : !c.lines.length ? <Card><EmptyState icon={<ShoppingCart className="size-5" />} title="Your cart is empty" action={<Link to="/shop"><Button variant="primary">Browse fabrics</Button></Link>} /></Card> : (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_340px]">
          <Card padded={false}>
            <ul className="divide-y divide-slate-100">
              {c.lines.map((l) => (
                <li key={l.id} className="flex flex-wrap items-center gap-4 px-5 py-4">
                  <div className="min-w-[200px] flex-1"><p className="font-medium">{l.product_name}</p><p className="font-mono text-[12px] text-slate-500">{l.sku} · lot {l.lot_no} · dye lot {l.dye_lot ?? '—'} · grade {l.grade ?? '—'}</p>
                    {l.problems.map((x) => <p key={x} className="mt-1 flex items-center gap-1 text-[12.5px] text-rose-600"><AlertTriangle className="size-3.5" />{x}</p>)}</div>
                  <div className="flex items-center gap-1">
                    <Button size="sm" variant="ghost" icon={<Minus className="size-3.5" />} onClick={() => setKg(l.id, l.kg - 10)} aria-label="Less" />
                    <input className="input h-8 w-20 text-center" type="number" defaultValue={l.kg} key={l.kg} onBlur={(e) => Number(e.target.value) !== l.kg && setKg(l.id, Number(e.target.value))} />
                    <Button size="sm" variant="ghost" icon={<Plus className="size-3.5" />} onClick={() => setKg(l.id, l.kg + 10)} aria-label="More" />
                    <span className="text-[12px] text-slate-500">kg</span>
                  </div>
                  <div className="w-28 text-right"><p className="font-semibold tabular">{fmtINR(l.taxable)}</p><p className="text-[12px] text-slate-500">₹{fmtNum(l.price_per_kg)}/kg</p></div>
                  <Button size="sm" variant="ghost" icon={<Trash2 className="size-4" />} aria-label="Remove" onClick={() => void save(c.lines.filter((x) => x.id !== l.id).map((x) => ({ product_id: x.product_id, lot_id: x.lot_id, kg: x.kg })))} />
                </li>
              ))}
            </ul>
          </Card>
          <div className="space-y-4">
            <Card title="Summary">
              <KeyValue columns={1} items={[{ label: 'Fabric (taxable value)', value: fmtINR(c.taxable) }, { label: 'GST (estimate)', value: fmtINR(c.tax_estimate) }, { label: 'Total', value: <span className="text-[18px] font-semibold">{fmtINR(c.total_estimate)}</span> }]} />
              <div className="mt-4 rounded-lg bg-slate-50 p-3 text-[13px]">
                {c.terms === 'credit' ? <p className="flex items-start gap-2"><CreditCard className="mt-0.5 size-4 text-emerald-700" /><span><b>On your approved credit.</b> No token needed; the order is booked straight away.</span></p>
                  : c.token ? <p className="flex items-start gap-2"><CreditCard className="mt-0.5 size-4 text-brand-600" /><span><b>Token to book now: {fmtINR(c.token.amount)}</b><br /><span className="text-slate-600">{c.token.text}. Holds your stock for {c.token.validity_days} days; {c.token.refundable ? `refundable to your advance${c.token.cancellation_fee_pct ? ` less ${c.token.cancellation_fee_pct}%` : ''} if you cancel` : 'non-refundable'}. The balance is due before dispatch.</span></span></p> : null}
              </div>
              {c.needs_company_approval && <div className="mt-3"><Notice tone="warning">Above your company’s approval limit of {fmtINR(c.approval_limit)}: an approver in your company must approve this order first.</Notice></div>}
            </Card>
            <Textarea label="Deliver to" placeholder="Delivery address if different from billing" value={shipTo} onChange={(e) => setShipTo(e.target.value)} />
            <Input label="Note for us" value={notes} onChange={(e) => setNotes(e.target.value)} />
            <Button className="w-full" variant="primary" loading={busy} disabled={problems} onClick={() => void checkout()}>{c.needs_company_approval ? 'Send for approval' : c.terms === 'credit' ? 'Place order' : `Place order & pay ${fmtINR(c.token?.amount)}`}</Button>
            <p className="text-[12px] text-slate-500">Stock is reserved for you the moment you place the order, so nobody else can book the same rolls.</p>
          </div>
        </div>
      )}
    </>
  );
}

// ---------- orders ----------
interface OrderRow { id: string; number: string; status: string; payment_terms: string; kg: number; total_estimate: number; token_amount: number; created_at: string; skus: string; placed_by_name: string }
const ORDER_STEPS = ['placed', 'paid', 'picking', 'dispatched', 'delivered'];
const stepOf = (s: string) => ({ pending_company_approval: 0, awaiting_allocation: 0, pending_payment: 0, booked: 1, in_fulfilment: 2, partially_dispatched: 3, dispatched: 3, delivered: 4 } as Record<string, number>)[s] ?? 0;
const ORDER_LABEL: Record<string, string> = { pending_company_approval: 'Waiting for your approver', awaiting_allocation: 'Confirming warehouse', pending_payment: 'Token due', booked: 'Booked', in_fulfilment: 'Being packed', partially_dispatched: 'Part dispatched', dispatched: 'Dispatched', delivered: 'Delivered', cancelled: 'Cancelled', expired: 'Expired' };

export function CustomerOrdersPage() {
  const nav = useNavigate();
  const q = useQuery({ queryKey: ['cust-orders'], queryFn: () => api.get<OrderRow[]>('/commerce/portal/orders') });
  return (
    <>
      <h1 className="mb-5 text-[24px] font-semibold tracking-tight">Orders</h1>
      <Card padded={false}>
        {!q.data ? <Skeleton className="m-5 h-40" /> : (
          <SimpleTable rows={q.data} rowKey={(r) => r.id} onRowClick={(r) => nav(`/portal/orders/${r.id}`)} empty={<EmptyState title="No orders yet" action={<Link to="/shop"><Button variant="primary">Browse fabrics</Button></Link>} />} columns={[
            { key: 'n', header: 'Order', render: (r) => <div><p className="font-mono text-[12.5px] font-semibold">{r.number}</p><p className="text-[12px] text-slate-500">{fmtDate(r.created_at)} · {r.placed_by_name}</p></div> },
            { key: 's', header: 'Fabric', render: (r) => <span className="font-mono text-[12px]">{r.skus}</span> },
            { key: 'k', header: 'KG', align: 'right', render: (r) => fmtNum(Number(r.kg)) },
            { key: 't', header: 'Value', align: 'right', render: (r) => fmtINR(Number(r.total_estimate)) },
            { key: 'st', header: 'Status', render: (r) => <Badge tone={r.status === 'pending_payment' || r.status === 'pending_company_approval' ? 'warning' : ['cancelled', 'expired'].includes(r.status) ? 'neutral' : r.status === 'delivered' ? 'success' : 'brand'} dot>{ORDER_LABEL[r.status] ?? humanize(r.status)}</Badge> },
          ]} />
        )}
      </Card>
    </>
  );
}

interface Fulfil { id: string; number: string; warehouse_code: string; warehouse_name: string; status: string; picked_kg: number; invoice_no: string | null; invoice_total: number; amount_settled: number; gate_payment: string; dispatched_at: string | null; shipment_id: string | null; shipment_no: string | null; shipment_status: string | null; transporter_name: string | null; lr_number: string | null; eta_date: string | null; tracking_token: string | null; pod_condition: string | null; shipped_kg: number | null }
interface OrderD { id: string; number: string; status: string; payment_terms: string; customer_id: string; kg: number; taxable: number; tax_estimate: number; total_estimate: number; token_amount: number; token_policy_text: string; token_due_at: string | null; token_paid_at: string | null; reservation_expires_at: string | null; placed_by: string | null; placed_by_name: string; company_approved_by_name: string | null; ship_to: string | null; created_at: string; cancelled_reason: string | null; wallet_balance: number;
  lines: { id: string; sku: string; product_name: string; lot_no: string | null; kg: number; price_per_kg: number; taxable: number }[];
  payments: { id: string; number: string; purpose: string; ref_no: string | null; amount: number; status: string; utr: string | null; link_token: string; link_expires_at: string; created_at: string }[];
  fulfilment: { fulfilments: Fulfil[]; invoices: { invoice_no: string; total: number; settled: number; balance_due: number; on_credit: boolean }[]; returns: { id: string; number: string; status: string; credit_note_no: string | null; credit_total: number | null }[] } | null }

export function CustomerOrderPage() {
  const { id = '' } = useParams();
  const { can, user } = useAuth();
  const toast = useToast();
  const nav = useNavigate();
  const q = useQuery({ queryKey: ['cust-order', id], queryFn: () => api.get<OrderD>(`/commerce/portal/orders/${id}`) });
  const [modal, setModal] = useState<{ kind: 'pod'; f: Fulfil } | { kind: 'return'; f: Fulfil } | { kind: 'cancel' } | null>(null);
  if (q.isError) return <ErrorState error={q.error} />;
  const o = q.data;
  if (!o) return <Skeleton className="h-96" />;
  const payToken = async () => { try { const r = await api.post<{ link_token: string }>(`/commerce/portal/orders/${id}/pay`, { purpose: 'token' }); nav(`/pay/${r.link_token}`); } catch (e) { toast({ tone: 'error', title: (e as Error).message }); } };
  const payInvoice = async (inv: string) => { try { const r = await api.post<{ link_token: string }>(`/commerce/portal/orders/${id}/pay`, { purpose: 'invoice', ref_no: inv }); nav(`/pay/${r.link_token}`); } catch (e) { toast({ tone: 'error', title: (e as Error).message }); } };
  const step = stepOf(o.status);
  const closed = ['cancelled', 'expired'].includes(o.status);
  return (
    <>
      <Link to="/portal/orders" className="link mb-3 inline-block text-[13px]">← Orders</Link>
      <div className="mb-5 flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-start gap-3"><BackButton to="/portal/orders" /><div><h1 className="text-[24px] font-semibold tracking-tight">Order {o.number}</h1><p className="text-[13px] text-slate-600">Placed {fmtDateTime(o.created_at)} by {o.placed_by_name} · {o.payment_terms === 'credit' ? 'on credit' : 'advance terms'}</p></div></div>
        <div className="flex flex-wrap gap-2">
          {o.status === 'pending_company_approval' && can('portal.customer.approve') && o.placed_by !== user?.id && <Button variant="primary" onClick={async () => { try { await api.post(`/commerce/portal/orders/${id}/approve`); q.refetch(); } catch (e) { toast({ tone: 'error', title: (e as Error).message }); } }}>Approve order</Button>}
          {o.status === 'pending_payment' && <Button variant="primary" icon={<CreditCard className="size-4" />} onClick={() => void payToken()}>Pay token {fmtINR(Number(o.token_amount))}</Button>}
          {['pending_company_approval', 'awaiting_allocation', 'pending_payment', 'booked'].includes(o.status) && <Button variant="ghost" onClick={() => setModal({ kind: 'cancel' })}>Cancel order</Button>}
          {can('portal.customer.order') && <Button icon={<RotateCcw className="size-4" />} onClick={async () => { const r = await api.post<{ added: number; unavailable: number }>(`/commerce/portal/orders/${id}/repeat`); toast({ tone: 'success', title: `${r.added} line(s) added to cart`, body: r.unavailable ? `${r.unavailable} no longer in stock` : undefined }); nav('/cart'); }}>Order again</Button>}
        </div>
      </div>
      {closed ? <div className="mb-5"><Notice tone="warning" title={humanize(o.status)}>{o.cancelled_reason}</Notice></div> : (
        <div className="card mb-6 flex items-center gap-2 px-5 py-4">
          {ORDER_STEPS.map((s, i) => <div key={s} className="flex flex-1 items-center gap-2"><div className={clsx('flex size-7 shrink-0 items-center justify-center rounded-full text-[12px] font-semibold', i <= step ? 'bg-brand-600 text-white' : 'bg-slate-100 text-slate-500')}>{i < step ? <CheckCircle2 className="size-4" /> : i + 1}</div><span className={clsx('text-[13px]', i <= step ? 'font-medium' : 'text-slate-500')}>{s === 'paid' && o.payment_terms === 'credit' ? 'Booked' : humanize(s)}</span>{i < ORDER_STEPS.length - 1 && <div className={clsx('h-px flex-1', i < step ? 'bg-brand-400' : 'bg-slate-200')} />}</div>)}
        </div>
      )}
      {o.status === 'pending_payment' && <div className="mb-5"><Notice tone="warning" title={`Pay the token of ${fmtINR(Number(o.token_amount))} by ${fmtDateTime(o.token_due_at)}`}>Your stock is held until then. {o.token_policy_text}.</Notice></div>}
      {o.status === 'awaiting_allocation' && <div className="mb-5"><Notice tone="info">We’re confirming which warehouse ships your order; you’ll be asked to pay the token as soon as the stock is reserved.</Notice></div>}
      {o.status === 'pending_company_approval' && <div className="mb-5"><Notice tone="info">This order is above your company’s approval limit and is waiting for an approver in your company.</Notice></div>}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Card title="Fabric" padded={false}>
            <SimpleTable rows={o.lines} rowKey={(l) => l.id} columns={[
              { key: 's', header: 'Fabric', render: (l) => <div><p className="font-medium">{l.product_name}</p><p className="font-mono text-[12px] text-slate-500">{l.sku}{l.lot_no ? ` · lot ${l.lot_no}` : ''}</p></div> },
              { key: 'k', header: 'KG', align: 'right', render: (l) => fmtNum(Number(l.kg)) },
              { key: 'p', header: 'Price', align: 'right', render: (l) => `₹${fmtNum(Number(l.price_per_kg))}` },
              { key: 't', header: 'Value', align: 'right', render: (l) => fmtINR(Number(l.taxable)) },
            ]} />
          </Card>
          {o.fulfilment?.fulfilments.map((f) => (
            <Card key={f.id} title={<span className="flex items-center gap-2"><Truck className="size-4 text-slate-400" />From {f.warehouse_name}</span>} description={f.shipment_no ? `${f.transporter_name}${f.lr_number ? ` · LR ${f.lr_number}` : ''}${f.eta_date ? ` · expected ${fmtDate(f.eta_date)}` : ''}` : humanize(f.status)}
              actions={<StatusBadge status={f.shipment_status ?? f.status} />}>
              <div className="flex flex-wrap gap-2">
                {f.invoice_no && <Link to={`/portal/invoices/${f.id}`}><Button size="sm" icon={<FileText className="size-3.5" />}>Invoice {f.invoice_no}</Button></Link>}
                {f.tracking_token && <Link to={`/track/${f.tracking_token}`}><Button size="sm" icon={<Truck className="size-3.5" />}>Track shipment</Button></Link>}
                {f.shipment_id && f.shipment_status !== 'delivered' && <Button size="sm" variant="primary" onClick={() => setModal({ kind: 'pod', f })}>Confirm delivery</Button>}
                {f.shipment_status === 'delivered' && can('portal.customer.order') && <Button size="sm" icon={<RotateCcw className="size-3.5" />} onClick={() => setModal({ kind: 'return', f })}>Return rolls</Button>}
              </div>
              {f.pod_condition && f.pod_condition !== 'ok' && <p className="mt-3 text-[12.5px] text-amber-800">You reported this delivery as {f.pod_condition}; we have raised it with the transporter.</p>}
            </Card>
          ))}
          {o.fulfilment?.returns.length ? (
            <Card title="Returns" padded={false}>
              <ul className="divide-y divide-slate-100">{o.fulfilment.returns.map((r) => <li key={r.id} className="flex items-center justify-between px-5 py-2.5 text-[13px]"><span className="font-mono">{r.number}</span><span>{r.credit_note_no ? `Credit note ${r.credit_note_no} · ${fmtINR(Number(r.credit_total))}` : ''}</span><StatusBadge status={r.status} /></li>)}</ul>
            </Card>
          ) : null}
        </div>
        <div className="space-y-6">
          <Card title="Payment">
            <KeyValue columns={1} items={[
              { label: 'Order value (est. incl. GST)', value: fmtINR(Number(o.total_estimate)) },
              ...(o.payment_terms === 'advance' ? [{ label: 'Token', value: `${fmtINR(Number(o.token_amount))} · ${o.token_paid_at ? `paid ${fmtDate(o.token_paid_at)}` : 'not paid'}` }] : [{ label: 'Terms', value: 'Approved credit' }]),
              { label: 'Your advance balance', value: fmtINR(o.wallet_balance) },
              ...(o.reservation_expires_at && o.status === 'booked' ? [{ label: 'Stock held until', value: fmtDateTime(o.reservation_expires_at) }] : []),
            ]} />
            {o.fulfilment?.invoices.map((inv) => (
              <div key={inv.invoice_no} className="mt-4 rounded-lg border border-slate-200 p-3 text-[13px]">
                <div className="flex justify-between"><span className="font-mono font-semibold">{inv.invoice_no}</span><span>{fmtINR(inv.total)}</span></div>
                <p className="text-slate-600">{inv.on_credit ? 'On credit' : inv.balance_due > 0 ? `${fmtINR(inv.balance_due)} to pay before dispatch` : 'Paid'}</p>
                {inv.balance_due > 0 && !inv.on_credit && <Button className="mt-2" size="sm" variant="primary" onClick={() => void payInvoice(inv.invoice_no)}>Pay {fmtINR(Math.max(0, inv.balance_due - Math.max(0, o.wallet_balance)))}</Button>}
              </div>
            ))}
            {o.payments.length > 0 && <ul className="mt-4 space-y-1.5 border-t border-slate-100 pt-3">{o.payments.map((p) => <li key={p.id} className="flex justify-between text-[12.5px]"><span>{humanize(p.purpose)} · {p.number}</span><span className="flex items-center gap-1.5">{fmtINR(Number(p.amount))}<StatusBadge status={p.status === 'success' ? 'paid' : p.status} /></span></li>)}</ul>}
          </Card>
          {o.ship_to && <Card title="Deliver to"><p className="text-[13px] whitespace-pre-line text-slate-700">{o.ship_to}</p></Card>}
          {o.company_approved_by_name && <p className="text-[12.5px] text-slate-500">Approved in your company by {o.company_approved_by_name}.</p>}
        </div>
      </div>
      {modal?.kind === 'pod' && <PodModal f={modal.f} onClose={() => setModal(null)} onDone={() => { setModal(null); q.refetch(); }} />}
      {modal?.kind === 'return' && <ReturnModal f={modal.f} onClose={() => setModal(null)} onDone={() => { setModal(null); q.refetch(); }} />}
      {modal?.kind === 'cancel' && <CancelModal id={o.id} onClose={() => setModal(null)} onDone={() => { setModal(null); q.refetch(); }} />}
    </>
  );
}

function PodModal({ f, onClose, onDone }: { f: Fulfil; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [v, setV] = useState({ received_by: '', kg_received: String(f.shipped_kg ?? f.picked_kg), condition: 'ok', remarks: '' });
  return (
    <Modal open onClose={onClose} title="Confirm delivery" description={`${f.shipment_no} · ${fmtNum(Number(f.shipped_kg ?? f.picked_kg))} kg dispatched`} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={async () => {
      try { await api.post(`/fulfilment/portal/shipments/${f.shipment_id}/pod`, { received_by: v.received_by, kg_received: Number(v.kg_received), condition: v.condition, remarks: v.remarks || null }); toast({ tone: 'success', title: 'Delivery confirmed' }); onDone(); } catch (e) { toast({ tone: 'error', title: (e as Error).message }); }
    }}>Confirm</Button></>}>
      <div className="grid grid-cols-2 gap-3">
        <Input label="Received by" required value={v.received_by} onChange={(e) => setV({ ...v, received_by: e.target.value })} />
        <Input label="KG received" type="number" value={v.kg_received} onChange={(e) => setV({ ...v, kg_received: e.target.value })} />
        <Select className="col-span-2" label="Condition" value={v.condition} onChange={(e) => setV({ ...v, condition: e.target.value })} options={[{ value: 'ok', label: 'Received in good condition' }, { value: 'short', label: 'Short delivery' }, { value: 'damaged', label: 'Damaged in transit' }]} />
        {v.condition !== 'ok' && <Textarea className="col-span-2" label="What’s wrong?" required value={v.remarks} onChange={(e) => setV({ ...v, remarks: e.target.value })} />}
      </div>
    </Modal>
  );
}

function ReturnModal({ f, onClose, onDone }: { f: Fulfil; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const inv = useQuery({ queryKey: ['cust-inv', f.id], queryFn: () => api.get<{ lines: { sku: string; barcodes: string[]; kg: number; rolls: number }[] }>(`/fulfilment/invoices/${f.id}`) });
  const [sel, setSel] = useState<string[]>([]);
  const [reason, setReason] = useState('');
  return (
    <Modal open onClose={onClose} title="Return rolls" description="Choose the rolls (barcodes on the labels) and tell us why. We’ll authorise the return and arrange collection." footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!sel.length || reason.length < 3} onClick={async () => {
      try { const r = await api.post<{ number: string }>('/fulfilment/portal/returns', { fulfilment_id: f.id, barcodes: sel, reason }); toast({ tone: 'success', title: `Return ${r.number} requested` }); onDone(); } catch (e) { toast({ tone: 'error', title: (e as Error).message }); }
    }}>Request return</Button></>}>
      <div className="space-y-3">
        {inv.data?.lines.map((l) => (
          <div key={l.sku}><p className="mb-1 text-[12.5px] font-semibold">{l.sku}</p><div className="flex flex-wrap gap-1.5">{l.barcodes.map((b) => <button key={b} onClick={() => setSel(sel.includes(b) ? sel.filter((x) => x !== b) : [...sel, b])} className={clsx('rounded-md border px-2 py-1 font-mono text-[11.5px]', sel.includes(b) ? 'border-brand-500 bg-brand-50 text-brand-800' : 'border-slate-200')}>{b}</button>)}</div></div>
        ))}
        <Textarea label="Reason" required value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. shade differs from the approved sample" />
      </div>
    </Modal>
  );
}

function CancelModal({ id, onClose, onDone }: { id: string; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [reason, setReason] = useState('');
  return (
    <Modal open onClose={onClose} title="Cancel order" description="Reserved stock is released. A paid token stays as your advance, less any cancellation fee in the token terms." footer={<><Button onClick={onClose}>Keep order</Button><Button variant="danger" disabled={reason.length < 3} onClick={async () => { try { await api.post(`/commerce/portal/orders/${id}/cancel`, { reason }); onDone(); } catch (e) { toast({ tone: 'error', title: (e as Error).message }); } }}>Cancel order</Button></>}>
      <Textarea label="Reason" required value={reason} onChange={(e) => setReason(e.target.value)} />
    </Modal>
  );
}

// ---------- account, support, company ----------
export function CustomerAccountPage() {
  const w = useQuery({ queryKey: ['cust-wallet'], queryFn: () => api.get<{ balance: number; entries: { id: number; entry_type: string; amount: number; ref_no: string | null; narration: string | null; at: string; running: number }[] }>('/commerce/portal/wallet') });
  const co = useQuery({ queryKey: ['cust-company'], queryFn: () => api.get<{ credit: { mode: string; credit_limit: number; available: number; exposure: { total: number }; status: string } | null }>('/commerce/portal/company') });
  const cr = co.data?.credit;
  return (
    <>
      <h1 className="mb-5 text-[24px] font-semibold tracking-tight">Account</h1>
      <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="Advance balance" value={fmtINR(w.data?.balance)} sub="Tokens, payments and credit notes not yet used" />
        <Stat label="Terms" value={cr?.status === 'blocked' ? 'On hold' : cr?.mode === 'credit' ? 'Credit' : 'Advance'} tone={cr?.status === 'blocked' ? 'danger' : undefined} />
        {cr?.mode === 'credit' && <><Stat label="Credit limit" value={fmtINR(cr.credit_limit)} /><Stat label="Available credit" value={fmtINR(cr.available)} /></>}
      </div>
      <Card title="Advance statement" padded={false}>
        {!w.data ? <Skeleton className="m-5 h-32" /> : (
          <SimpleTable rows={w.data.entries} rowKey={(e) => String(e.id)} empty={<EmptyState title="No entries" />} columns={[
            { key: 'd', header: 'Date', render: (e) => fmtDateTime(e.at) },
            { key: 't', header: 'Entry', render: (e) => <span>{humanize(e.entry_type)}<span className="block text-[12px] text-slate-500">{e.narration}</span></span> },
            { key: 'r', header: 'Reference', render: (e) => <span className="font-mono text-[12px]">{e.ref_no}</span> },
            { key: 'a', header: 'Amount', align: 'right', render: (e) => <span className={Number(e.amount) < 0 ? 'text-slate-700' : 'text-emerald-700'}>{Number(e.amount) > 0 ? '+' : ''}{fmtINR(Number(e.amount))}</span> },
            { key: 'b', header: 'Balance', align: 'right', render: (e) => fmtINR(e.running) },
          ]} />
        )}
      </Card>
    </>
  );
}

export function CustomerSupportPage() {
  const toast = useToast();
  const q = useQuery({ queryKey: ['cust-complaints'], queryFn: () => api.get<{ id: string; number: string; category: string; subject: string; status: string; resolution: string | null; order_no: string | null; created_at: string }[]>('/commerce/portal/complaints') });
  const orders = useQuery({ queryKey: ['cust-orders'], queryFn: () => api.get<OrderRow[]>('/commerce/portal/orders') });
  const [open, setOpen] = useState(false);
  const [v, setV] = useState({ order_id: '', category: 'delivery', subject: '', description: '' });
  return (
    <>
      <div className="mb-5 flex items-center justify-between"><h1 className="text-[24px] font-semibold tracking-tight">Support</h1><Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setOpen(true)}>New request</Button></div>
      <Card padded={false}>
        {!q.data ? <Skeleton className="m-5 h-32" /> : (
          <SimpleTable rows={q.data} rowKey={(r) => r.id} empty={<EmptyState icon={<LifeBuoy className="size-5" />} title="No requests" />} columns={[
            { key: 'n', header: 'Ref', render: (r) => <span className="font-mono text-[12.5px]">{r.number}</span> },
            { key: 's', header: 'Subject', render: (r) => <span>{r.subject}<span className="block text-[12px] text-slate-500">{humanize(r.category)}{r.order_no ? ` · ${r.order_no}` : ''}</span></span> },
            { key: 'r', header: 'Our reply', render: (r) => <span className="text-[12.5px] text-slate-600">{r.resolution ?? '—'}</span> },
            { key: 'st', header: 'Status', render: (r) => <StatusBadge status={r.status} /> },
          ]} />
        )}
      </Card>
      {open && (
        <Modal open onClose={() => setOpen(false)} title="New support request" footer={<><Button onClick={() => setOpen(false)}>Cancel</Button><Button variant="primary" onClick={async () => {
          try { await api.post('/commerce/portal/complaints', { ...v, order_id: v.order_id || null }); setOpen(false); q.refetch(); } catch (e) { toast({ tone: 'error', title: (e as Error).message }); }
        }}>Send</Button></>}>
          <div className="grid grid-cols-2 gap-3">
            <Select label="About" value={v.category} onChange={(e) => setV({ ...v, category: e.target.value })} options={['quality', 'delivery', 'billing', 'payment', 'other'].map((c) => ({ value: c, label: humanize(c) }))} />
            <Select label="Order" value={v.order_id} onChange={(e) => setV({ ...v, order_id: e.target.value })} options={[{ value: '', label: 'Not about an order' }, ...(orders.data ?? []).map((o) => ({ value: o.id, label: o.number }))]} />
            <Input className="col-span-2" label="Subject" value={v.subject} onChange={(e) => setV({ ...v, subject: e.target.value })} />
            <Textarea className="col-span-2" label="Details" value={v.description} onChange={(e) => setV({ ...v, description: e.target.value })} />
          </div>
        </Modal>
      )}
    </>
  );
}

export function CustomerCompanyPage() {
  const toast = useToast();
  const q = useQuery({ queryKey: ['cust-company'], queryFn: () => api.get<{ company: { legal_name: string; code: string; gstin: string | null; email: string | null; phone: string | null }; settings: { order_approval_limit: number | null }; users: { id: string; name: string; email: string; status: string }[] }>('/commerce/portal/company') });
  const [add, setAdd] = useState(false);
  const [nu, setNu] = useState({ name: '', email: '', role: 'buyer' });
  const [created, setCreated] = useState<{ email: string; temporary_password: string } | null>(null);
  const [limit, setLimit] = useState<string | null>(null);
  const d = q.data;
  if (!d) return <Skeleton className="h-72" />;
  return (
    <>
      <h1 className="mb-5 text-[24px] font-semibold tracking-tight">{d.company.legal_name}</h1>
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <Card title="Company users" padded={false} className="lg:col-span-2" actions={<Button size="sm" variant="primary" icon={<Users className="size-3.5" />} onClick={() => setAdd(true)}>Add user</Button>}>
          <SimpleTable rows={d.users} rowKey={(u) => u.id} columns={[
            { key: 'n', header: 'Name', render: (u) => <span className="flex items-center gap-2"><Avatar name={u.name} size="sm" />{u.name}</span> },
            { key: 'e', header: 'Email', render: (u) => u.email },
            { key: 's', header: 'Status', render: (u) => <StatusBadge status={u.status} /> },
            { key: 'x', header: '', align: 'right', render: (u) => (u.status === 'active' ? <Button size="sm" variant="ghost" onClick={async () => { try { await api.post(`/commerce/portal/company/users/${u.id}/deactivate`); q.refetch(); } catch (e) { toast({ tone: 'error', title: (e as Error).message }); } }}>Deactivate</Button> : null) },
          ]} />
        </Card>
        <div className="space-y-6">
          <Card title="Company"><KeyValue columns={1} items={[{ label: 'Customer code', value: d.company.code }, { label: 'GSTIN', value: d.company.gstin, mono: true }, { label: 'Email', value: d.company.email }, { label: 'Phone', value: d.company.phone }]} /></Card>
          <Card title="Order approval" description="Orders above this value placed by buyers need an approver in your company.">
            <div className="flex items-end gap-2"><Input className="flex-1" label="Limit (₹, incl. GST)" type="number" value={limit ?? (d.settings.order_approval_limit ?? '')} onChange={(e) => setLimit(e.target.value)} placeholder="No limit" />
              <Button onClick={async () => { await api.put('/commerce/portal/company/settings', { order_approval_limit: limit === null ? d.settings.order_approval_limit : limit === '' ? null : Number(limit) }); toast({ tone: 'success', title: 'Saved' }); q.refetch(); }}>Save</Button></div>
          </Card>
        </div>
      </div>
      {add && (
        <Modal open onClose={() => { setAdd(false); setCreated(null); }} title="Add a company user" footer={created ? <Button variant="primary" onClick={() => { setAdd(false); setCreated(null); q.refetch(); }}>Done</Button> : <><Button onClick={() => setAdd(false)}>Cancel</Button><Button variant="primary" onClick={async () => {
          try { setCreated(await api.post('/commerce/portal/company/users', nu)); } catch (e) { toast({ tone: 'error', title: (e as Error).message }); }
        }}>Create</Button></>}>
          {created ? <Notice tone="success" title="User created">Share these with {created.email} privately; they must change the password on first sign-in.<br /><span className="font-mono">Temporary password: {created.temporary_password}</span></Notice> : (
            <div className="grid grid-cols-2 gap-3">
              <Input label="Name" value={nu.name} onChange={(e) => setNu({ ...nu, name: e.target.value })} />
              <Input label="Email" type="email" value={nu.email} onChange={(e) => setNu({ ...nu, email: e.target.value })} />
              <Select className="col-span-2" label="Role" value={nu.role} onChange={(e) => setNu({ ...nu, role: e.target.value })} options={[{ value: 'buyer', label: 'Buyer — browse, order and pay' }, { value: 'accounts', label: 'Accounts — invoices, payments and statement' }, { value: 'admin', label: 'Admin — everything, including approving orders and users' }]} />
            </div>
          )}
        </Modal>
      )}
    </>
  );
}
