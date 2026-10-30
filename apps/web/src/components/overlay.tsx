import { clsx } from 'clsx';
import { X } from 'lucide-react';
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { CheckCircle2, AlertTriangle, Info, XCircle } from 'lucide-react';
import { Button, IconButton, Textarea } from './ui';

function useEscape(open: boolean, onClose: () => void) {
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [open, onClose]);
}

/** Right-hand panel used for create/edit forms and record previews. */
export function Drawer({ open, onClose, title, description, children, footer, width = 'md' }: {
  open: boolean; onClose: () => void; title: ReactNode; description?: ReactNode; children: ReactNode; footer?: ReactNode; width?: 'md' | 'lg' | 'xl';
}) {
  useEscape(open, onClose);
  if (!open) return null;
  const w = { md: 'max-w-[520px]', lg: 'max-w-[680px]', xl: 'max-w-[880px]' }[width];
  return createPortal(
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="animate-fade-in absolute inset-0 bg-slate-900/30 backdrop-blur-[1px]" onClick={onClose} />
      <aside role="dialog" aria-modal="true" className={clsx('animate-slide-in relative flex h-full w-full flex-col bg-white shadow-pop', w)}>
        <header className="flex items-start justify-between gap-4 border-b border-slate-200 px-6 py-4">
          <div className="min-w-0">
            <h2 className="text-[16px] font-semibold text-slate-900">{title}</h2>
            {description && <p className="mt-0.5 text-[13px] text-slate-500">{description}</p>}
          </div>
          <IconButton label="Close" onClick={onClose}><X className="size-4" /></IconButton>
        </header>
        <div className="scrollbar-thin flex-1 overflow-y-auto px-6 py-5">{children}</div>
        {footer && <footer className="flex items-center justify-end gap-2 border-t border-slate-200 bg-slate-50/70 px-6 py-3.5">{footer}</footer>}
      </aside>
    </div>,
    document.body,
  );
}

export function Modal({ open, onClose, title, description, children, footer, size = 'md' }: {
  open: boolean; onClose: () => void; title: ReactNode; description?: ReactNode; children?: ReactNode; footer?: ReactNode; size?: 'sm' | 'md' | 'lg';
}) {
  useEscape(open, onClose);
  if (!open) return null;
  const w = { sm: 'max-w-sm', md: 'max-w-lg', lg: 'max-w-2xl' }[size];
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-4 pt-[12vh]">
      <div className="animate-fade-in fixed inset-0 bg-slate-900/40 backdrop-blur-[1px]" onClick={onClose} />
      <div role="dialog" aria-modal="true" className={clsx('animate-pop-in relative w-full rounded-xl bg-white shadow-pop', w)}>
        <div className="px-6 pt-5 pb-4">
          <h2 className="text-[16px] font-semibold text-slate-900">{title}</h2>
          {description && <div className="mt-1 text-[13px] text-slate-500">{description}</div>}
          {children && <div className="mt-4">{children}</div>}
        </div>
        {footer && <div className="flex justify-end gap-2 rounded-b-xl border-t border-slate-100 bg-slate-50/70 px-6 py-3">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

/** Confirmation with an optional mandatory reason (for audited actions). */
export function ConfirmDialog({ open, onClose, onConfirm, title, description, confirmLabel = 'Confirm', tone = 'primary', requireReason, reasonLabel = 'Reason', loading }: {
  open: boolean; onClose: () => void; onConfirm: (reason: string) => void; title: string; description?: ReactNode; confirmLabel?: string;
  tone?: 'primary' | 'danger'; requireReason?: boolean; reasonLabel?: string; loading?: boolean;
}) {
  const [reason, setReason] = useState('');
  useEffect(() => { if (open) setReason(''); }, [open]);
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      description={description}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant={tone} loading={loading} disabled={requireReason && reason.trim().length < 3} onClick={() => onConfirm(reason.trim())}>{confirmLabel}</Button>
        </>
      }
    >
      {requireReason && (
        <Textarea label={reasonLabel} required value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Recorded in the audit trail" autoFocus />
      )}
    </Modal>
  );
}

// ---------- Toasts ----------
type ToastTone = 'success' | 'error' | 'info' | 'warning';
interface ToastItem { id: number; tone: ToastTone; title: string; body?: string }
const ToastCtx = createContext<(t: Omit<ToastItem, 'id'>) => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const id = useRef(0);
  const push = useCallback((t: Omit<ToastItem, 'id'>) => {
    const n = ++id.current;
    setItems((xs) => [...xs, { ...t, id: n }]);
    setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== n)), t.tone === 'error' ? 7000 : 4000);
  }, []);
  const icon = { success: <CheckCircle2 className="size-4.5 text-emerald-500" />, error: <XCircle className="size-4.5 text-rose-500" />, info: <Info className="size-4.5 text-sky-500" />, warning: <AlertTriangle className="size-4.5 text-amber-500" /> };
  return (
    <ToastCtx.Provider value={push}>
      {children}
      {createPortal(
        <div className="pointer-events-none fixed right-4 bottom-4 z-[60] flex w-[360px] flex-col gap-2">
          {items.map((t) => (
            <div key={t.id} className="animate-pop-in pointer-events-auto flex gap-3 rounded-lg border border-slate-200 bg-white px-4 py-3 shadow-pop">
              <span className="mt-0.5">{icon[t.tone]}</span>
              <div className="min-w-0 flex-1">
                <p className="text-[13.5px] font-medium text-slate-900">{t.title}</p>
                {t.body && <p className="mt-0.5 text-[12.5px] text-slate-500">{t.body}</p>}
              </div>
              <button className="text-slate-400 hover:text-slate-700" onClick={() => setItems((xs) => xs.filter((x) => x.id !== t.id))} aria-label="Dismiss"><X className="size-4" /></button>
            </div>
          ))}
        </div>,
        document.body,
      )}
    </ToastCtx.Provider>
  );
}

export const useToast = () => useContext(ToastCtx);

/** Small anchored menu. */
export function Menu({ trigger, children, align = 'right', width = 'w-56' }: { trigger: (toggle: () => void, open: boolean) => ReactNode; children: (close: () => void) => ReactNode; align?: 'left' | 'right'; width?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [open]);
  useEscape(open, () => setOpen(false));
  return (
    <div ref={ref} className="relative">
      {trigger(() => setOpen((o) => !o), open)}
      {open && (
        <div className={clsx('animate-pop-in absolute top-full z-40 mt-1.5 rounded-lg border border-slate-200 bg-white py-1 shadow-pop', width, align === 'right' ? 'right-0' : 'left-0')}>
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

export function MenuItem({ children, onClick, icon, danger }: { children: ReactNode; onClick: () => void; icon?: ReactNode; danger?: boolean }) {
  return (
    <button onClick={onClick} className={clsx('flex w-full items-center gap-2.5 px-3 py-2 text-left text-[13px] hover:bg-slate-50', danger ? 'text-rose-600' : 'text-slate-700')}>
      {icon && <span className="text-slate-400">{icon}</span>}
      {children}
    </button>
  );
}
