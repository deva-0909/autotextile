import { clsx } from 'clsx';
import { AlertTriangle, ArrowLeft, Inbox, Loader2, Lock, RefreshCw } from 'lucide-react';
import {
  forwardRef, useId, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes,
} from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Link } from './AppLink';
import { pageOf } from '../lib/nav';

// ---------- Button ----------
type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'subtle';
const VARIANTS: Record<Variant, string> = {
  primary: 'bg-brand-600 text-white shadow-[inset_0_1px_0_rgb(255_255_255/0.12),0_1px_2px_rgb(16_24_40/0.12)] hover:bg-brand-700 disabled:bg-brand-300',
  secondary: 'bg-white text-slate-700 border border-slate-300 shadow-[0_1px_2px_rgb(16_24_40/0.05)] hover:bg-slate-50 hover:text-slate-900 disabled:text-slate-400',
  ghost: 'text-slate-600 hover:bg-slate-100 hover:text-slate-900 disabled:text-slate-300',
  subtle: 'bg-brand-50 text-brand-700 hover:bg-brand-100 disabled:opacity-50',
  danger: 'bg-rose-600 text-white hover:bg-rose-700 shadow-[0_1px_2px_rgb(16_24_40/0.12)] disabled:bg-rose-300',
};
const SIZES = { xs: 'h-7 px-2 text-xs gap-1', sm: 'h-8 px-3 text-[13px] gap-1.5', md: 'h-9 px-3.5 text-[13.5px] gap-2', lg: 'h-10 px-4 text-sm gap-2' };

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: keyof typeof SIZES;
  loading?: boolean;
  icon?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', loading, icon, className, children, disabled, type = 'button', ...rest }, ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      className={clsx('inline-flex shrink-0 items-center justify-center rounded-md font-medium whitespace-nowrap transition-colors disabled:cursor-not-allowed', VARIANTS[variant], SIZES[size], className)}
      {...rest}
    >
      {loading ? <Loader2 className="size-4 animate-spin" /> : icon}
      {children}
    </button>
  );
});

export function IconButton({ label, children, className, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button type="button" aria-label={label} title={label} className={clsx('inline-flex size-8 items-center justify-center rounded-md text-slate-500 transition hover:bg-slate-100 hover:text-slate-900 disabled:opacity-40', className)} {...rest}>
      {children}
    </button>
  );
}

// ---------- Form fields ----------
export function Field({ label, error, hint, required, children, className, htmlFor }: {
  label?: ReactNode; error?: string; hint?: ReactNode; required?: boolean; children: ReactNode; className?: string; htmlFor?: string;
}) {
  return (
    <div className={className}>
      {label && (
        <label className="label" htmlFor={htmlFor}>
          {label}
          {required && <span className="ml-0.5 text-rose-500">*</span>}
        </label>
      )}
      {children}
      {error ? <p className="mt-1.5 text-xs font-medium text-rose-600">{error}</p> : hint ? <p className="mt-1.5 text-xs text-slate-500">{hint}</p> : null}
    </div>
  );
}

type InputProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'prefix'> & { label?: ReactNode; error?: string; hint?: ReactNode; prefix?: ReactNode; suffix?: ReactNode };
export const Input = forwardRef<HTMLInputElement, InputProps>(function Input({ label, error, hint, className, prefix, suffix, required, id, ...rest }, ref) {
  const auto = useId();
  const input = (
    <input ref={ref} id={id ?? auto} required={required} aria-invalid={!!error} aria-label={!label ? (rest['aria-label'] ?? (typeof rest.placeholder === 'string' ? rest.placeholder : undefined) ?? ({ month: 'Month', date: 'Date', search: 'Search', number: 'Amount' } as Record<string, string>)[rest.type ?? '']) : undefined} className={clsx('input', error && 'input-error', prefix && 'pl-9', suffix && 'pr-12')} {...rest} />
  );
  return (
    <Field label={label} error={error} hint={hint} required={required} className={className} htmlFor={id ?? auto}>
      {prefix || suffix ? (
        <div className="relative">
          {prefix && <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-slate-400">{prefix}</span>}
          {input}
          {suffix && <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs text-slate-500">{suffix}</span>}
        </div>
      ) : input}
    </Field>
  );
});

type SelectProps = SelectHTMLAttributes<HTMLSelectElement> & { label?: ReactNode; error?: string; hint?: ReactNode; options?: { value: string; label: string }[]; placeholder?: string };
export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select({ label, error, hint, className, options, placeholder, children, required, id, ...rest }, ref) {
  const auto = useId();
  return (
    <Field label={label} error={error} hint={hint} required={required} className={className} htmlFor={id ?? auto}>
      <select ref={ref} id={id ?? auto} required={required} aria-invalid={!!error} aria-label={!label ? (rest['aria-label'] ?? (typeof placeholder === 'string' ? placeholder : undefined) ?? (options?.find((o) => o.value === rest.value)?.label as string | undefined) ?? 'Choose') : undefined} className={clsx('input', error && 'input-error')} {...rest}>
        {placeholder !== undefined && <option value="">{placeholder}</option>}
        {options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        {children}
      </select>
    </Field>
  );
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement> & { label?: ReactNode; error?: string; hint?: ReactNode }>(
  function Textarea({ label, error, hint, className, required, id, rows = 3, ...rest }, ref) {
    const auto = useId();
    return (
      <Field label={label} error={error} hint={hint} required={required} className={className} htmlFor={id ?? auto}>
        <textarea ref={ref} id={id ?? auto} rows={rows} required={required} aria-label={!label ? (rest["aria-label"] ?? (typeof rest.placeholder === "string" ? rest.placeholder : undefined)) : undefined} className={clsx('input', error && 'input-error')} {...rest} />
      </Field>
    );
  },
);

export function Checkbox({ label, description, className, ...rest }: InputHTMLAttributes<HTMLInputElement> & { label: ReactNode; description?: ReactNode }) {
  return (
    <label className={clsx('flex cursor-pointer items-start gap-2.5 select-none', rest.disabled && 'cursor-not-allowed opacity-60', className)}>
      <input type="checkbox" className="mt-0.5 size-4 shrink-0 rounded border-slate-300 accent-brand-600" {...rest} />
      <span>
        <span className="block text-[13.5px] text-slate-800">{label}</span>
        {description && <span className="block text-xs text-slate-500">{description}</span>}
      </span>
    </label>
  );
}

export function Switch({ checked, onChange, label, disabled, 'aria-label': ariaLabel }: { checked: boolean; onChange: (v: boolean) => void; label?: ReactNode; disabled?: boolean; 'aria-label'?: string }) {
  return (
    <label className={clsx('inline-flex items-center gap-2.5', disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer')}>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={ariaLabel ?? (typeof label === 'string' ? label : 'Toggle')}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={clsx('relative h-5 w-9 rounded-full transition-colors', checked ? 'bg-brand-600' : 'bg-slate-300')}
      >
        <span className={clsx('absolute top-0.5 size-4 rounded-full bg-white shadow transition-all', checked ? 'left-[18px]' : 'left-0.5')} />
      </button>
      {label && <span className="text-[13.5px] text-slate-700">{label}</span>}
    </label>
  );
}

// ---------- Display ----------
const TONES = {
  neutral: 'bg-slate-100 text-slate-700 ring-slate-500/10',
  brand: 'bg-brand-50 text-brand-700 ring-brand-600/15',
  success: 'bg-emerald-50 text-emerald-700 ring-emerald-600/15',
  warning: 'bg-amber-50 text-amber-800 ring-amber-600/20',
  danger: 'bg-rose-50 text-rose-700 ring-rose-600/15',
  info: 'bg-sky-50 text-sky-700 ring-sky-600/15',
  violet: 'bg-violet-50 text-violet-700 ring-violet-600/15',
};
export type Tone = keyof typeof TONES;

export function Badge({ tone = 'neutral', children, dot, className }: { tone?: Tone; children: ReactNode; dot?: boolean; className?: string }) {
  return (
    <span className={clsx('inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-[11.5px] font-medium whitespace-nowrap ring-1 ring-inset', TONES[tone], className)}>
      {dot && <span className="size-1.5 rounded-full bg-current opacity-80" />}
      {children}
    </span>
  );
}

const STATUS: Record<string, [Tone, string]> = {
  active: ['success', 'Active'], inactive: ['neutral', 'Inactive'], blocked: ['danger', 'Blocked'], archived: ['neutral', 'Archived'],
  pending: ['warning', 'Pending'], pending_approval: ['warning', 'Awaiting approval'], approved: ['success', 'Approved'], rejected: ['danger', 'Rejected'],
  open: ['success', 'Open'], closed: ['neutral', 'Closed'], discontinued: ['neutral', 'Discontinued'], draft: ['neutral', 'Draft'],
  locked: ['danger', 'Locked'], success: ['success', 'Success'],
  submitted: ['info', 'Submitted'], converted: ['violet', 'Sourced'], cancelled: ['neutral', 'Cancelled'], awarded: ['success', 'Awarded'], not_awarded: ['neutral', 'Not awarded'], received_quote: ['info', 'Received'],
  sent: ['info', 'Sent'], accepted: ['success', 'Accepted'], rejected_by_supplier: ['danger', 'Rejected by supplier'], partially_received: ['warning', 'Partly received'], received: ['success', 'Received'],
  queued: ['neutral', 'Queued'], extracting: ['info', 'Extracting'], needs_review: ['warning', 'Needs review'], failed: ['danger', 'Failed'],
  posted: ['success', 'Posted'], matched: ['success', 'Matched'], variance: ['danger', 'Variance'], no_po: ['warning', 'No PO'], no_receipt: ['warning', 'No receipt'], not_run: ['neutral', 'Not matched'],
  unpaid: ['neutral', 'Unpaid'], paid: ['success', 'Paid'],
  issued: ['info', 'Issued'], acknowledged: ['violet', 'At mill'], in_process: ['brand', 'In process'], ready: ['success', 'Ready to collect'], partially_returned: ['warning', 'Partly returned'], returned: ['success', 'Returned'],
  under_review: ['warning', 'Under review'], resolved: ['success', 'Resolved'], dismissed: ['neutral', 'Dismissed'],
  info: ['info', 'Info'], warning: ['warning', 'Warning'], critical: ['danger', 'Critical'],
  qc_hold: ['warning', 'QC hold'], available: ['success', 'Available'], reserved: ['violet', 'Reserved'], allocated: ['brand', 'Allocated'], in_transit: ['info', 'In transit'],
  at_mill: ['violet', 'At mill'], damaged: ['danger', 'Damaged'], dispatched: ['neutral', 'Dispatched'], consumed: ['neutral', 'Consumed'], written_off: ['danger', 'Written off'],
  passed: ['success', 'QC passed'], partial: ['warning', 'Partly passed'], completed: ['success', 'Completed'], counting: ['info', 'Counting'], picked: ['success', 'Picked'], expired: ['neutral', 'Expired'],
  superseded: ['neutral', 'Superseded'], used: ['neutral', 'Used'], rejected_internal: ['danger', 'Price rejected'], lost: ['danger', 'Lost'], won: ['success', 'Won'], merged: ['neutral', 'Merged'],
  new: ['info', 'New'], assigned: ['brand', 'Assigned'], contact_pending: ['warning', 'Contact pending'], contacted: ['brand', 'Contacted'], qualified: ['violet', 'Qualified'], quotation: ['info', 'Quotation'],
  pending_company_approval: ['warning', 'Awaiting buyer approval'], awaiting_allocation: ['warning', 'Awaiting allocation'], pending_payment: ['warning', 'Awaiting token'], booked: ['success', 'Booked'],
  in_fulfilment: ['brand', 'In fulfilment'], partially_dispatched: ['warning', 'Partly dispatched'], delivered: ['success', 'Delivered'], created: ['warning', 'Awaiting payment'],
  refunded: ['neutral', 'Refunded'], partially_refunded: ['warning', 'Partly refunded'], in_progress: ['brand', 'In progress'],
  needs_decision: ['warning', 'Needs decision'], split_pending: ['warning', 'Split awaiting approval'], decided: ['success', 'Decided'], released: ['info', 'Released'], picking: ['brand', 'Picking'], packed: ['violet', 'Packed'], invoiced: ['info', 'Invoiced'],
  credit: ['violet', 'Credit'], override: ['warning', 'Override'], out_for_delivery: ['info', 'Out for delivery'], exception: ['danger', 'Exception'],
  requested: ['warning', 'Requested'], authorized: ['brand', 'Authorised'], inspected: ['violet', 'Inspected'], filed: ['info', 'Filed'], settled: ['success', 'Settled'],
  negotiation: ['warning', 'Negotiation'], order_confirmed: ['success', 'Order confirmed'], nurture: ['neutral', 'Nurture'], missing: ['danger', 'Missing'],
};
export function StatusBadge({ status }: { status: string }) {
  const [tone, label] = STATUS[status] ?? ['neutral', status.replace(/_/g, ' ')];
  return <Badge tone={tone} dot>{label}</Badge>;
}

export function Card({ title, description, actions, children, className, padded = true, footer }: {
  title?: ReactNode; description?: ReactNode; actions?: ReactNode; children?: ReactNode; className?: string; padded?: boolean; footer?: ReactNode;
}) {
  return (
    <section className={clsx('card', className)}>
      {(title || actions) && (
        <header className="flex items-start justify-between gap-4 border-b border-slate-100 px-4 py-2.5">
          <div className="min-w-0">
            {title && <h2 className="text-[14px] font-semibold text-slate-900">{title}</h2>}
            {description && <p className="mt-0.5 text-[12.5px] text-slate-500">{description}</p>}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={padded ? 'p-4' : undefined}>{children}</div>
      {footer && <footer className="border-t border-slate-100 bg-slate-50/60 px-4 py-2 rounded-b-xl">{footer}</footer>}
    </section>
  );
}

/**
 * Back from a detail page (any page that is not itself in the menu): to the previous screen in this session, or else
 * to the page's parent in the breadcrumb. A page can pass back={false} to hide it, or a path to override the target.
 */
export function BackButton({ to }: { to: string }) {
  const nav = useNavigate();
  const inApp = ((window.history.state as { idx?: number } | null)?.idx ?? 0) > 0;
  return (
    <button type="button" data-back aria-label="Back" title="Back" onClick={() => (inApp ? nav(-1) : nav(to))}
      className="flex size-8 shrink-0 items-center justify-center rounded-md border border-slate-200 bg-white text-slate-500 shadow-sm transition hover:bg-slate-50 hover:text-slate-800">
      <ArrowLeft className="size-4" />
    </button>
  );
}

export function PageHeader({ title, description, actions, breadcrumbs, meta, back }: {
  title: ReactNode; description?: ReactNode; actions?: ReactNode; breadcrumbs?: { label: string; to?: string }[]; meta?: ReactNode;
  back?: boolean | string;
}) {
  const loc = useLocation();
  const parent = [...(breadcrumbs ?? [])].reverse().find((b) => b.to)?.to;
  const page = pageOf(loc.pathname);
  const isDetail = !page || page.to !== loc.pathname;
  const backTo = typeof back === 'string' ? back : back === false ? null : isDetail && (parent || page) ? (parent ?? page!.to) : null;
  return (
    <div className="mb-4">
      {breadcrumbs && (
        <nav className="mb-1 flex items-center gap-1.5 text-[12.5px] text-slate-500" aria-label="Breadcrumb">
          {breadcrumbs.map((b, i) => (
            <span key={i} className="flex items-center gap-1.5">
              {i > 0 && <span className="text-slate-300">/</span>}
              {b.to ? <Link to={b.to} className="hover:text-slate-800">{b.label}</Link> : <span className="text-slate-700">{b.label}</span>}
            </span>
          ))}
        </nav>
      )}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-3">
          {backTo && <BackButton to={backTo} />}
          <div className="min-w-0">
          <h1 className="flex flex-wrap items-center gap-3 text-[20px] font-semibold tracking-[-0.01em] text-slate-900">{title}</h1>
          {description && <p className="mt-0.5 max-w-4xl text-[13px] text-slate-500">{description}</p>}
          {meta && <div className="mt-2 flex flex-wrap items-center gap-x-5 gap-y-2 text-[12.5px] text-slate-600">{meta}</div>}
          </div>
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
    </div>
  );
}

export function Tabs<T extends string>({ tabs, value, onChange, className }: { tabs: { value: T; label: ReactNode; count?: number }[]; value: T; onChange: (v: T) => void; className?: string }) {
  return (
    <div className={clsx('flex gap-1 overflow-x-auto border-b border-slate-200', className)} role="tablist">
      {tabs.map((t) => (
        <button
          key={t.value}
          role="tab"
          aria-selected={value === t.value}
          onClick={() => onChange(t.value)}
          className={clsx(
            '-mb-px flex items-center gap-2 border-b-2 px-3 py-2.5 text-[13.5px] font-medium whitespace-nowrap transition-colors',
            value === t.value ? 'border-brand-600 text-brand-700' : 'border-transparent text-slate-500 hover:border-slate-300 hover:text-slate-800',
          )}
        >
          {t.label}
          {t.count !== undefined && (
            <span className={clsx('rounded-full px-1.5 text-[11px] tabular', value === t.value ? 'bg-brand-100 text-brand-700' : 'bg-slate-100 text-slate-600')}>{t.count}</span>
          )}
        </button>
      ))}
    </div>
  );
}

export function Segmented<T extends string>({ options, value, onChange }: { options: { value: T; label: string }[]; value: T; onChange: (v: T) => void }) {
  return (
    <div className="inline-flex rounded-lg bg-slate-100 p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          className={clsx('rounded-md px-3 py-1 text-[12.5px] font-medium transition', value === o.value ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600 hover:text-slate-900')}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function KeyValue({ items, columns = 2 }: { items: { label: string; value: ReactNode; mono?: boolean }[]; columns?: 1 | 2 | 3 | 4 }) {
  const cols = { 1: 'sm:grid-cols-1', 2: 'sm:grid-cols-2', 3: 'sm:grid-cols-3', 4: 'sm:grid-cols-2 lg:grid-cols-4' }[columns];
  return (
    <dl className={clsx('grid grid-cols-1 gap-x-8 gap-y-4', cols)}>
      {items.map((i) => (
        <div key={i.label} className="min-w-0">
          <dt className="text-[12px] font-medium text-slate-500">{i.label}</dt>
          <dd className={clsx('mt-0.5 truncate text-[13.5px] text-slate-900', i.mono && 'font-mono text-[12.5px]')}>{i.value ?? '—'}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Avatar({ name, size = 'md' }: { name: string; size?: 'sm' | 'md' | 'lg' }) {
  const palette = ['bg-brand-100 text-brand-700', 'bg-emerald-100 text-emerald-700', 'bg-amber-100 text-amber-800', 'bg-sky-100 text-sky-700', 'bg-violet-100 text-violet-700', 'bg-rose-100 text-rose-700'];
  const hash = [...name].reduce((a, c) => a + c.charCodeAt(0), 0);
  const s = { sm: 'size-6 text-[10px]', md: 'size-8 text-[11.5px]', lg: 'size-11 text-sm' }[size];
  const ini = name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]!.toUpperCase()).join('');
  return <span className={clsx('inline-flex shrink-0 items-center justify-center rounded-full font-semibold', palette[hash % palette.length], s)}>{ini}</span>;
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={clsx('animate-pulse rounded-md bg-slate-200/70', className)} />;
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={clsx('size-5 animate-spin text-brand-600', className)} />;
}

// ---------- States ----------
export function EmptyState({ icon, title, description, action }: { icon?: ReactNode; title: string; description?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-14 text-center">
      <div className="mb-3 flex size-11 items-center justify-center rounded-xl bg-slate-100 text-slate-400">{icon ?? <Inbox className="size-5" />}</div>
      <p className="text-[14px] font-semibold text-slate-900">{title}</p>
      {description && <p className="mt-1 max-w-sm text-[13px] text-slate-500">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const e = error as { status?: number; message?: string };
  if (e?.status === 403) return <PermissionDenied />;
  return (
    <div className="flex flex-col items-center justify-center px-6 py-14 text-center">
      <div className="mb-3 flex size-11 items-center justify-center rounded-xl bg-rose-50 text-rose-500"><AlertTriangle className="size-5" /></div>
      <p className="text-[14px] font-semibold text-slate-900">Couldn’t load this</p>
      <p className="mt-1 max-w-sm text-[13px] text-slate-500">{e?.message ?? 'Something went wrong.'}</p>
      {onRetry && <Button className="mt-4" size="sm" icon={<RefreshCw className="size-3.5" />} onClick={onRetry}>Try again</Button>}
    </div>
  );
}

export function PermissionDenied({ message }: { message?: string }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-16 text-center">
      <div className="mb-3 flex size-11 items-center justify-center rounded-xl bg-amber-50 text-amber-700"><Lock className="size-5" /></div>
      <p className="text-[14px] font-semibold text-slate-900">You don’t have access to this</p>
      <p className="mt-1 max-w-sm text-[13px] text-slate-500">{message ?? 'Your role or data scope does not include this area. Ask an administrator if you need it.'}</p>
    </div>
  );
}

export function Notice({ tone = 'info', title, children, icon, action }: { tone?: 'info' | 'warning' | 'danger' | 'success'; title?: ReactNode; children?: ReactNode; icon?: ReactNode; action?: ReactNode }) {
  const t = {
    info: 'border-sky-200 bg-sky-50/70 text-sky-900',
    warning: 'border-amber-200 bg-amber-50/80 text-amber-900',
    danger: 'border-rose-200 bg-rose-50/80 text-rose-900',
    success: 'border-emerald-200 bg-emerald-50/70 text-emerald-900',
  }[tone];
  return (
    <div className={clsx('flex gap-3 rounded-lg border px-4 py-3 text-[13px]', t)}>
      {icon && <span className="mt-0.5 shrink-0">{icon}</span>}
      <div className="min-w-0 flex-1">
        {title && <p className="font-semibold">{title}</p>}
        {children && <div className={clsx(title && 'mt-0.5', 'opacity-90')}>{children}</div>}
      </div>
      {action}
    </div>
  );
}

export function Progress({ value, max, tone = 'brand', label }: { value: number; max: number; tone?: 'brand' | 'success' | 'warning' | 'danger'; label?: ReactNode }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  const bar = { brand: 'bg-brand-500', success: 'bg-emerald-500', warning: 'bg-amber-500', danger: 'bg-rose-500' }[tone];
  return (
    <div className="min-w-[90px]">
      {label && <div className="mb-1 text-[11.5px] text-slate-500 tabular">{label}</div>}
      <div className="h-1.5 overflow-hidden rounded-full bg-slate-100"><div className={clsx('h-full rounded-full transition-all', bar)} style={{ width: `${pct}%` }} /></div>
    </div>
  );
}

export function Stat({ label, value, sub, tone }: { label: ReactNode; value: ReactNode; sub?: ReactNode; tone?: 'danger' | 'warning' | 'success' }) {
  const t = tone === 'danger' ? 'text-rose-600' : tone === 'warning' ? 'text-amber-700' : tone === 'success' ? 'text-emerald-700' : 'text-slate-900';
  return (
    <div className="card px-4 py-2.5">
      <p className="text-[12px] font-medium text-slate-500">{label}</p>
      <p className={clsx('mt-0.5 text-[20px] leading-tight font-semibold tracking-tight tabular', t)}>{value}</p>
      {sub && <p className="mt-0.5 text-[12px] text-slate-500">{sub}</p>}
    </div>
  );
}

export interface TimelineItem { id: string | number; title: ReactNode; detail?: ReactNode; meta?: ReactNode; tone?: 'brand' | 'success' | 'warning' | 'danger' | 'neutral' }
export function Timeline({ items }: { items: TimelineItem[] }) {
  const dot = { brand: 'bg-brand-500', success: 'bg-emerald-500', warning: 'bg-amber-500', danger: 'bg-rose-500', neutral: 'bg-slate-300' };
  return (
    <ol className="relative space-y-4 before:absolute before:top-1.5 before:bottom-1.5 before:left-[5px] before:w-px before:bg-slate-200">
      {items.map((i) => (
        <li key={i.id} className="relative pl-6">
          <span className={clsx('absolute top-1.5 left-0 size-[11px] rounded-full ring-4 ring-white', dot[i.tone ?? 'brand'])} />
          <p className="text-[13px] font-medium text-slate-900">{i.title}</p>
          {i.detail && <p className="mt-0.5 text-[12.5px] text-slate-600">{i.detail}</p>}
          {i.meta && <p className="mt-0.5 text-[11.5px] text-slate-400">{i.meta}</p>}
        </li>
      ))}
    </ol>
  );
}
