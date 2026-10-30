import { useQuery } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { useState } from 'react';
import { api, type Page } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fmtDateTime, humanize } from '../lib/format';
import { Avatar, Badge, EmptyState, Notice } from './ui';

export interface AuditRow {
  id: number; service: string; entity: string; entity_id: string; action: string; before: Record<string, unknown> | null; after: Record<string, unknown> | null;
  reason: string | null; approved_by: string | null; user_id: string | null; user_name: string | null; session_id: string | null; ip: string | null; user_agent: string | null; at: string;
}

const fmtVal = (v: unknown) => (v === null || v === undefined || v === '' ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v));

/** Before/after comparison of an audited change. */
export function Diff({ before, after }: { before: Record<string, unknown> | null; after: Record<string, unknown> | null }) {
  const keys = [...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])];
  if (!keys.length) return <p className="text-[12.5px] text-slate-500">No field values recorded for this action.</p>;
  return (
    <table className="w-full overflow-hidden rounded-md border border-slate-200 text-[12.5px]">
      <thead className="bg-slate-50 text-left text-[11px] tracking-wide text-slate-500 uppercase">
        <tr><th className="w-1/4 px-3 py-1.5">Field</th><th className="px-3 py-1.5">Before</th><th className="px-3 py-1.5">After</th></tr>
      </thead>
      <tbody className="divide-y divide-slate-100">
        {keys.map((k) => (
          <tr key={k}>
            <td className="px-3 py-1.5 font-medium text-slate-700">{humanize(k)}</td>
            <td className="px-3 py-1.5 font-mono break-all text-rose-700/90">{before ? fmtVal(before[k]) : '—'}</td>
            <td className="px-3 py-1.5 font-mono break-all text-emerald-700">{after ? fmtVal(after[k]) : '—'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export const ACTION_TONE = (a: string) =>
  a.includes('reject') || a.includes('deactiv') || a.includes('archived') || a.includes('deleted') ? 'danger' : a.includes('approv') || a === 'created' || a.includes('enabled') ? 'success' : a.includes('request') ? 'warning' : 'neutral';

/** Timeline of audited changes for one record. */
export function AuditTimeline({ entityId, entity }: { entityId: string; entity?: string }) {
  const { can } = useAuth();
  const q = useQuery({
    queryKey: ['audit', entity, entityId],
    queryFn: () => api.get<Page<AuditRow>>(`/governance/audit?f_entityId=${entityId}${entity ? `&f_entity=${entity}` : ''}&pageSize=100`),
    enabled: can('governance.audit.read'),
  });
  const [open, setOpen] = useState<number | null>(null);
  if (!can('governance.audit.read')) return <Notice tone="info">Your role cannot view the audit trail.</Notice>;
  if (q.data?.items.length === 0) return <EmptyState title="No recorded changes" />;
  return (
    <ol className="relative space-y-1 before:absolute before:top-2 before:bottom-2 before:left-[15px] before:w-px before:bg-slate-200">
      {q.data?.items.map((a) => (
        <li key={a.id} className="relative pl-10">
          <span className="absolute top-1.5 left-0"><Avatar name={a.user_name ?? 'System'} /></span>
          <button className={clsx('w-full rounded-lg px-3 py-2 text-left hover:bg-slate-50', open === a.id && 'bg-slate-50')} onClick={() => setOpen(open === a.id ? null : a.id)}>
            <p className="flex flex-wrap items-center gap-2 text-[13px]">
              <span className="font-medium text-slate-900">{a.user_name ?? 'System'}</span>
              <Badge tone={ACTION_TONE(a.action)}>{humanize(a.action)}</Badge>
              <span className="text-slate-500">{humanize(a.entity).toLowerCase()}</span>
              {a.approved_by && <Badge tone="success">Approved by checker</Badge>}
              <span className="ml-auto text-[12px] text-slate-400">{fmtDateTime(a.at)}</span>
            </p>
            {a.reason && <p className="mt-0.5 text-[12.5px] text-slate-600">Reason: {a.reason}</p>}
          </button>
          {open === a.id && <div className="mt-1 mb-3 px-3"><Diff before={a.before} after={a.after} /></div>}
        </li>
      ))}
    </ol>
  );
}
