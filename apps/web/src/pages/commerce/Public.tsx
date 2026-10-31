import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, CircleDot, Lock, MapPin, ShieldCheck, Truck, XCircle } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useParams } from 'react-router-dom';
import { Link } from '../../components/AppLink';
import { clsx } from 'clsx';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { fmtDate, fmtDateTime, fmtINR, fmtNum, humanize } from '../../lib/format';
import { Badge, Button, Card, Input, Notice, Skeleton, Textarea } from '../../components/ui';

/** Minimal frame for pages opened from a link (payment, tracking, registration), signed in or not. */
export function PublicFrame({ children, wide }: { children: ReactNode; wide?: boolean }) {
  return (
    <div className="min-h-screen bg-slate-50">
      <header className="border-b border-slate-200 bg-white">
        <div className={clsx('mx-auto flex h-14 items-center gap-2.5 px-4', wide ? 'max-w-5xl' : 'max-w-2xl')}>
          <img src="/favicon.svg" alt="" className="size-7" />
          <div className="leading-tight"><p className="text-[13.5px] font-semibold">Demo Textile Trading</p><p className="text-[11px] text-slate-500">Knitted fabrics · Surat · Kolkata · Tiruppur</p></div>
        </div>
      </header>
      <main className={clsx('mx-auto px-4 py-8', wide ? 'max-w-5xl' : 'max-w-2xl')}>{children}</main>
    </div>
  );
}

interface PayInfo { number: string; customer_name: string; purpose: string; ref_no: string | null; order_no: string | null; order_id: string | null; amount: number; status: string; utr: string | null; expired: boolean; expires_at: string; gateway: string }

/** Payment page behind a payment link. In sandbox mode it plays the bank; with ICICI it hands over to their page. */
export function PayPage() {
  const { token = '' } = useParams();
  const { user } = useAuth();
  const q = useQuery({ queryKey: ['pay', token], queryFn: () => api.get<PayInfo>(`/commerce/public/pay/${token}`), refetchInterval: (x) => (x.state.data?.status === 'created' ? 4000 : false) });
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const p = q.data;
  const back = user?.partyId && p?.order_id ? `/portal/orders/${p.order_id}` : null;
  const simulate = async (outcome: 'success' | 'failure') => {
    setBusy(outcome); setErr(null);
    try { await api.post(`/commerce/public/pay/${token}/simulate`, { outcome }); await q.refetch(); } catch (e) { setErr((e as Error).message); } finally { setBusy(null); }
  };
  return (
    <PublicFrame>
      {q.isError ? <Notice tone="danger">This payment link is not valid.</Notice> : !p ? <Skeleton className="h-72" /> : (
        <Card>
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-[12.5px] text-slate-500">{p.purpose === 'token' ? 'Booking token' : p.purpose === 'invoice' ? `Payment for invoice ${p.ref_no}` : 'Advance payment'}{p.order_no ? ` · order ${p.order_no}` : ''}</p>
              <p className="mt-1 text-[32px] font-semibold tracking-tight tabular">{fmtINR(p.amount)}</p>
              <p className="text-[13px] text-slate-600">{p.customer_name} · reference {p.number}</p>
            </div>
            <Badge tone={p.status === 'success' ? 'success' : p.status === 'failed' ? 'danger' : p.expired ? 'neutral' : 'warning'} dot>{p.status === 'created' ? (p.expired ? 'Link expired' : 'Awaiting payment') : humanize(p.status)}</Badge>
          </div>
          {p.status === 'success' ? (
            <div className="mt-6 rounded-lg bg-emerald-50 p-4 ring-1 ring-emerald-600/20"><p className="flex items-center gap-2 font-semibold text-emerald-900"><CheckCircle2 className="size-5" />Payment received and verified with the bank</p><p className="mt-1 text-[13px] text-emerald-800">UTR {p.utr}. The amount is held as your advance and set against your invoice when goods are dispatched.</p></div>
          ) : p.status === 'failed' ? (
            <div className="mt-6 rounded-lg bg-rose-50 p-4 ring-1 ring-rose-600/20"><p className="flex items-center gap-2 font-semibold text-rose-900"><XCircle className="size-5" />The bank declined this payment</p><p className="mt-1 text-[13px] text-rose-800">No money was taken. Ask for a new link from your order page.</p></div>
          ) : p.expired ? (
            <Notice tone="warning">This link expired on {fmtDateTime(p.expires_at)}. Open your order to get a new one.</Notice>
          ) : p.gateway === 'sandbox' ? (
            <div className="mt-6 space-y-4">
              <Notice tone="info" title="Sandbox payment page">This stands in for the bank’s payment page until ICICI merchant credentials are configured. Nothing is charged. The ERP still verifies the result exactly as it will with the real gateway: a signed callback plus a server-side status check.</Notice>
              {err && <Notice tone="danger">{err}</Notice>}
              <div className="flex flex-wrap gap-2"><Button variant="primary" loading={busy === 'success'} icon={<Lock className="size-4" />} onClick={() => void simulate('success')}>Pay {fmtINR(p.amount)}</Button><Button loading={busy === 'failure'} onClick={() => void simulate('failure')}>Simulate a declined payment</Button></div>
              <p className="text-[12px] text-slate-500">Link valid until {fmtDateTime(p.expires_at)}.</p>
            </div>
          ) : <Notice tone="info">Continue on the bank’s secure page.</Notice>}
          <p className="mt-6 flex items-center gap-1.5 text-[12px] text-slate-500"><ShieldCheck className="size-3.5" />Card and bank details are entered only on the bank’s page; this site never sees them.</p>
          {back && <Link to={back} className="link mt-3 inline-block text-[13px]">Back to your order →</Link>}
        </Card>
      )}
    </PublicFrame>
  );
}

interface Track { number: string; order_no: string; customer: string; from: string; transporter: string; lr_number: string | null; mode: string; status: string; kg: number; rolls: number; eta_date: string | null; dispatched_at: string; delivered_at: string | null; received_by: string | null; events: { milestone: string; location: string | null; note: string | null; at: string }[] }
const STEPS = ['dispatched', 'in_transit', 'out_for_delivery', 'delivered'];

export function TrackPage() {
  const { token = '' } = useParams();
  const q = useQuery({ queryKey: ['track', token], queryFn: () => api.get<Track>(`/fulfilment/public/track/${token}`) });
  const s = q.data;
  const reached = s ? Math.max(...s.events.map((e) => STEPS.indexOf(e.milestone === 'reached_hub' || e.milestone === 'picked_up' ? 'in_transit' : e.milestone))) : 0;
  return (
    <PublicFrame>
      {q.isError ? <Notice tone="danger">Tracking link not found.</Notice> : !s ? <Skeleton className="h-72" /> : (
        <Card>
          <div className="flex items-start justify-between gap-4">
            <div><p className="text-[12.5px] text-slate-500">Shipment {s.number} · order {s.order_no}</p><p className="mt-1 text-[22px] font-semibold">{s.status === 'delivered' ? 'Delivered' : s.status === 'out_for_delivery' ? 'Out for delivery' : s.status === 'exception' ? 'Delayed' : 'On the way'}</p><p className="text-[13px] text-slate-600">{s.rolls} rolls · {fmtNum(s.kg)} kg for {s.customer}</p></div>
            <Truck className="size-8 text-brand-500" />
          </div>
          <div className="my-6 flex items-center gap-1">
            {STEPS.map((st, i) => <div key={st} className="flex flex-1 flex-col items-center gap-1.5"><div className={clsx('h-1.5 w-full rounded-full', i <= reached ? 'bg-brand-500' : 'bg-slate-200')} /><span className={clsx('text-[11.5px]', i <= reached ? 'font-medium text-slate-800' : 'text-slate-400')}>{humanize(st)}</span></div>)}
          </div>
          <div className="grid grid-cols-2 gap-4 text-[13px] sm:grid-cols-4">
            <div><p className="text-slate-500">From</p><p className="font-medium">{s.from}</p></div>
            <div><p className="text-slate-500">Transporter</p><p className="font-medium">{s.transporter}</p></div>
            <div><p className="text-slate-500">LR / docket</p><p className="font-medium">{s.lr_number ?? '—'}</p></div>
            <div><p className="text-slate-500">{s.delivered_at ? 'Delivered' : 'Expected'}</p><p className="font-medium">{s.delivered_at ? fmtDate(s.delivered_at) : fmtDate(s.eta_date)}</p></div>
          </div>
          <ol className="mt-6 space-y-3 border-t border-slate-100 pt-5">
            {[...s.events].reverse().map((e, i) => (
              <li key={i} className="flex gap-3 text-[13px]"><CircleDot className={clsx('mt-0.5 size-4 shrink-0', i === 0 ? 'text-brand-600' : 'text-slate-300')} /><div><p className="font-medium">{humanize(e.milestone)}{e.location && <span className="font-normal text-slate-500"> · <MapPin className="inline size-3" /> {e.location}</span>}</p>{e.note && <p className="text-slate-600">{e.note}</p>}<p className="text-[12px] text-slate-400">{fmtDateTime(e.at)}</p></div></li>
            ))}
          </ol>
          <p className="mt-5 text-[12px] text-slate-500">Milestones are updated by our dispatch team. Live GPS will appear here once the transporter provides a tracking feed.</p>
        </Card>
      )}
    </PublicFrame>
  );
}

export function RegisterPage() {
  const [v, setV] = useState({ company_name: '', gstin: '', city: '', address: '', contact_name: '', email: '', phone: '', message: '' });
  const [done, setDone] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <PublicFrame>
      <h1 className="text-[22px] font-semibold">Open a trade account</h1>
      <p className="mb-6 text-[13.5px] text-slate-600">For garment manufacturers, exporters and wholesalers. We verify your GSTIN and email your login, usually within one working day.</p>
      {done ? <Notice tone="success" title={`Thank you — reference ${done}`}>Our team will verify your details and email your login. <Link className="link" to="/login">Back to sign in</Link></Notice> : (
        <Card>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {err && <div className="sm:col-span-2"><Notice tone="danger">{err}</Notice></div>}
            <Input className="sm:col-span-2" label="Company name" required value={v.company_name} onChange={(e) => setV({ ...v, company_name: e.target.value })} />
            <Input label="GSTIN" hint="Leave blank if unregistered" value={v.gstin} onChange={(e) => setV({ ...v, gstin: e.target.value.toUpperCase() })} />
            <Input label="City" value={v.city} onChange={(e) => setV({ ...v, city: e.target.value })} />
            <Input label="Your name" required value={v.contact_name} onChange={(e) => setV({ ...v, contact_name: e.target.value })} />
            <Input label="Mobile" required value={v.phone} onChange={(e) => setV({ ...v, phone: e.target.value })} />
            <Input className="sm:col-span-2" label="Work email" type="email" required value={v.email} onChange={(e) => setV({ ...v, email: e.target.value })} />
            <Textarea className="sm:col-span-2" label="Address" value={v.address} onChange={(e) => setV({ ...v, address: e.target.value })} />
            <Textarea className="sm:col-span-2" label="What fabrics do you buy?" value={v.message} onChange={(e) => setV({ ...v, message: e.target.value })} />
          </div>
          <div className="mt-5 flex items-center justify-between"><Link to="/login" className="link text-[13px]">Already have an account? Sign in</Link><Button variant="primary" loading={busy} onClick={async () => {
            setBusy(true); setErr(null);
            try { const r = await api.post<{ number: string }>('/commerce/public/registrations', Object.fromEntries(Object.entries(v).map(([k, x]) => [k, x || null]))); setDone(r.number); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
          }}>Submit</Button></div>
        </Card>
      )}
    </PublicFrame>
  );
}
