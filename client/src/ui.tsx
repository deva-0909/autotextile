import type { ReactNode } from 'react';

export function Badge({ tone, children }: { tone: string; children: ReactNode }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

const STATUS_TONE: Record<string, string> = {
  queued: 'neutral', in_process: 'info', on_hold: 'warn', ready: 'good', dispatched: 'good', rejected: 'bad',
  planned: 'neutral', in_progress: 'info', completed: 'good',
  idle: 'neutral', running: 'info', maintenance: 'warn',
  pass: 'good', rework: 'warn', reject: 'bad',
  info: 'info', warning: 'warn', critical: 'bad',
};

export function StatusBadge({ status }: { status: string }) {
  return <Badge tone={STATUS_TONE[status] ?? 'neutral'}>{status.replace('_', ' ')}</Badge>;
}

export function Card({ title, actions, children }: { title?: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="card">
      {(title || actions) && (
        <header className="card-head">
          {title && <h2>{title}</h2>}
          {actions}
        </header>
      )}
      {children}
    </section>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="empty">{children}</p>;
}
