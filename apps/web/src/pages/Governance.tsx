import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, ChevronRight, Clock, ShieldAlert, XCircle } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, invalidatePrefix } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fmtBytes, fmtDate, fmtDateTime, fmtRelative, humanize } from '../lib/format';
import { DataTable, FilterSelect } from '../components/DataTable';
import { ACTION_TONE, Diff, type AuditRow } from '../components/AuditTrail';
import { Preview, VersionsDrawer, type Doc } from '../components/Documents';
import { Drawer, useToast } from '../components/overlay';
import { Avatar, Badge, Button, ErrorState, KeyValue, Notice, PageHeader, Skeleton, StatusBadge, Tabs, Textarea } from '../components/ui';

interface Facets { services: string[]; entities: string[]; actions: string[] }

const ENTITY_LINK: Record<string, (id: string) => string | null> = {
  party: (id) => `/partners/customer/${id}`,
  warehouse: (id) => (id === 'priority' ? '/organisation/warehouses' : `/organisation/warehouses/${id}`),
  legal_entity: () => '/organisation/entities',
  gst_registration: () => '/organisation/entities',
  approval_request: (id) => `/approvals/${id}`,
  setting: () => '/organisation/configuration',
};

export function AuditPage() {
  const facets = useQuery({ queryKey: ['audit-facets'], queryFn: () => api.get<Facets>('/governance/audit/facets') });
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [open, setOpen] = useState<AuditRow | null>(null);
  return (
    <>
      <PageHeader title="Audit trail" description="Append-only record of every change: who, when, from where, what changed (before and after), why, and who approved it. Entries cannot be edited or deleted." breadcrumbs={[{ label: 'Governance' }, { label: 'Audit trail' }]} />
      <DataTable<AuditRow>
        id="audit"
        endpoint="/governance/audit"
        filters={filters}
        onFiltersChange={setFilters}
        defaultSort={{ key: 'at', dir: 'desc' }}
        searchPlaceholder="Search user, record id, reason or values…"
        onRowClick={setOpen}
        toolbar={<>
          <FilterSelect placeholder="All services" value={filters.service} onChange={(v) => setFilters({ ...filters, service: v })} options={facets.data?.services.map((s) => ({ value: s, label: humanize(s) })) ?? []} />
          <FilterSelect placeholder="All record types" value={filters.entity} onChange={(v) => setFilters({ ...filters, entity: v })} options={facets.data?.entities.map((s) => ({ value: s, label: humanize(s) })) ?? []} />
          <FilterSelect placeholder="All actions" value={filters.action} onChange={(v) => setFilters({ ...filters, action: v })} options={facets.data?.actions.map((s) => ({ value: s, label: humanize(s) })) ?? []} />
          <input type="date" className="input h-8 w-[140px] text-[13px]" value={filters.from ?? ''} onChange={(e) => setFilters({ ...filters, from: e.target.value })} aria-label="From date" />
          <input type="date" className="input h-8 w-[140px] text-[13px]" value={filters.to ?? ''} onChange={(e) => setFilters({ ...filters, to: e.target.value })} aria-label="To date" />
        </>}
        columns={[
          { key: 'at', header: 'When', sort: 'at', csv: (r) => r.at, render: (r) => <span className="text-[12.5px] whitespace-nowrap">{fmtDateTime(r.at)}</span> },
          { key: 'user', header: 'User', sort: 'user_name', csv: (r) => r.user_name, render: (r) => <span className="flex items-center gap-2 whitespace-nowrap"><Avatar name={r.user_name ?? 'System'} size="sm" />{r.user_name ?? 'System'}</span> },
          { key: 'action', header: 'Action', sort: 'action', csv: (r) => r.action, render: (r) => <Badge tone={ACTION_TONE(r.action)}>{humanize(r.action)}</Badge> },
          { key: 'entity', header: 'Record', sort: 'entity', csv: (r) => `${r.entity} ${r.entity_id}`, render: (r) => <span><span className="text-slate-900">{humanize(r.entity)}</span> <span className="font-mono text-[11px] text-slate-400">{r.entity_id.slice(0, 8)}</span></span> },
          { key: 'changed', header: 'Changed fields', csv: (r) => Object.keys(r.after ?? {}).join('; '), render: (r) => <span className="block max-w-[260px] truncate text-[12.5px] text-slate-600">{Object.keys(r.after ?? r.before ?? {}).map(humanize).join(', ') || '—'}</span> },
          { key: 'reason', header: 'Reason', csv: (r) => r.reason, render: (r) => <span className="block max-w-[220px] truncate text-[12.5px]">{r.reason ?? '—'}</span> },
          { key: 'service', header: 'Service', sort: 'service', csv: (r) => r.service, render: (r) => <span className="text-[12.5px] text-slate-500">{r.service}</span>, defaultHidden: true },
          { key: 'ip', header: 'IP', csv: (r) => r.ip, render: (r) => <span className="font-mono text-[12px]">{r.ip ?? '—'}</span>, defaultHidden: true },
        ]}
      />
      {open && (
        <Drawer open onClose={() => setOpen(null)} width="lg" title={`${humanize(open.action)} · ${humanize(open.entity)}`} description={fmtDateTime(open.at)}>
          <div className="space-y-6">
            <KeyValue columns={2} items={[
              { label: 'User', value: open.user_name ?? 'System' },
              { label: 'Service', value: open.service },
              { label: 'Record id', value: open.entity_id, mono: true },
              { label: 'Approved by checker', value: open.approved_by ? 'Yes' : 'No' },
              { label: 'IP address', value: open.ip, mono: true },
              { label: 'Session', value: open.session_id, mono: true },
            ]} />
            {open.user_agent && <p className="text-[12px] text-slate-500">Device: {open.user_agent}</p>}
            {open.reason && <Notice tone="info" title="Reason">{open.reason}</Notice>}
            <div><h3 className="mb-2 text-[13px] font-semibold">What changed</h3><Diff before={open.before} after={open.after} /></div>
            {ENTITY_LINK[open.entity]?.(open.entity_id) && <Link className="link text-[13px]" to={ENTITY_LINK[open.entity]!(open.entity_id)!}>Open record →</Link>}
          </div>
        </Drawer>
      )}
    </>
  );
}

/** Where the record behind an approval lives, by request type. */
function recordLink(a: { approval_type: string; ref_id: string; payload: Record<string, unknown> }) {
  const p = a.payload;
  switch (a.approval_type) {
    case 'purchase_order': return `/procurement/purchase-orders/${a.ref_id}`;
    case 'invoice_posting': return `/procurement/invoices/${a.ref_id}`;
    case 'requisition': return '/procurement/requisitions';
    case 'price_change': return p.lot_id ? `/inventory/lots/${p.lot_id}` : '/inventory/pricing';
    case 'stock_transfer': return `/inventory/transfers/${a.ref_id}`;
    case 'stock_adjustment': return `/inventory/stocktakes/${a.ref_id}`;
    case 'quotation_price': return `/crm/quotations/${a.ref_id}`;
    case 'credit_limit': case 'credit_override': return p.customer_id ? `/crm/credit/${p.customer_id}` : '/crm/credit';
    case 'token_policy': return '/commerce/token-policies';
    case 'reservation_extension': return p.order ? `/commerce/orders/${encodeURIComponent(String(p.order))}` : '/commerce/orders';
    case 'split_fulfilment': return `/fulfilment/orders/${a.ref_id}`;
    case 'dispatch_gate_override': return `/fulfilment/${a.ref_id}`;
    default: return null;
  }
}

/** Approval payload values can be lists of lines; show them readably instead of [object Object]. */
function showValue(v: unknown): ReactNode {
  if (v === null || v === undefined || v === '') return '—';
  if (Array.isArray(v)) return <span className="block whitespace-pre-line">{v.map((x) => (x && typeof x === 'object' ? Object.entries(x).filter(([, y]) => y !== null && y !== '').map(([k, y]) => `${humanize(k)}: ${y}`).join(' · ') : String(x))).join('\n')}</span>;
  if (typeof v === 'object') return Object.entries(v as Record<string, unknown>).map(([k, y]) => `${humanize(k)}: ${y}`).join(' · ');
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  return String(v);
}

interface Approval { id: string; source_service: string; approval_type: string; ref_id: string; title: string; summary: string | null; payload: Record<string, unknown>; required_permission: string; status: string; requested_by: string; requested_by_name: string | null; requested_at: string; decided_by_name: string | null; decided_at: string | null; comment: string | null }

export function ApprovalsPage() {
  const { can } = useAuth();
  const nav = useNavigate();
  const { id } = useParams();
  const [params, setParams] = useSearchParams();
  const canDecide = can('governance.approval.decide');
  const box = params.get('box') ?? (canDecide ? 'inbox' : 'mine');
  const filters: Record<string, string> = box === 'inbox' ? { status: 'pending' } : box === 'mine' ? { box: 'mine' } : {};
  return (
    <>
      <PageHeader title="Approvals" description="Maker-checker control for sensitive changes. The person who requests a change can never approve it." breadcrumbs={[{ label: 'Governance' }, { label: 'Approvals' }]} />
      <Tabs className="mb-5" value={box} onChange={(b) => setParams({ box: b })} tabs={[
        ...(canDecide ? [{ value: 'inbox', label: 'Waiting for decision' }] : []),
        { value: 'mine', label: 'My requests' },
        ...(canDecide || can('governance.approval.read') ? [{ value: 'all', label: 'All requests' }] : []),
      ]} />
      <DataTable<Approval>
        key={box}
        id={`approvals-${box}`}
        endpoint="/governance/approvals"
        filters={filters}
        defaultSort={{ key: 'requested_at', dir: 'desc' }}
        searchPlaceholder="Search requests…"
        onRowClick={(r) => nav(`/approvals/${r.id}?box=${box}`)}
        empty={{ title: box === 'inbox' ? 'Nothing waiting for you' : 'No requests', description: box === 'inbox' ? 'You’re all caught up.' : undefined }}
        columns={[
          { key: 'title', header: 'Request', csv: (r) => r.title, render: (r) => (
            <div className="flex items-center gap-3">
              <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-amber-50 text-amber-600"><ShieldAlert className="size-4" /></span>
              <div className="min-w-0"><p className="truncate font-medium text-slate-900">{r.title}</p><p className="truncate text-[12px] text-slate-500">{r.summary}</p></div>
            </div>
          ) },
          { key: 'type', header: 'Type', sort: 'approval_type', csv: (r) => r.approval_type, render: (r) => <Badge>{humanize(r.approval_type)}</Badge> },
          { key: 'by', header: 'Requested by', csv: (r) => r.requested_by_name, render: (r) => <span className="whitespace-nowrap">{r.requested_by_name}</span> },
          { key: 'at', header: 'Requested', sort: 'requested_at', csv: (r) => r.requested_at, render: (r) => <span className="text-[12.5px] whitespace-nowrap">{fmtRelative(r.requested_at)}</span> },
          { key: 'status', header: 'Status', sort: 'status', csv: (r) => r.status, render: (r) => <StatusBadge status={r.status} /> },
          { key: 'go', header: '', render: () => <ChevronRight className="size-4 text-slate-300" /> },
        ]}
      />
      {id && <ApprovalDrawer id={id} onClose={() => nav(`/approvals?box=${box}`)} />}
    </>
  );
}

function ApprovalDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const { can, user } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['approval', id], queryFn: () => api.get<Approval>(`/governance/approvals/${id}`) });
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const a = q.data;
  const own = a?.requested_by === user?.id;
  const canAct = a?.status === 'pending' && can(a.required_permission) && !own;

  async function decide(decision: 'approved' | 'rejected') {
    setBusy(decision);
    try {
      await api.post(`/governance/approvals/${id}/decide`, { decision, comment: comment || null });
      invalidatePrefix(qc, '/governance/approvals');
      qc.invalidateQueries({ queryKey: ['approval', id] });
      qc.invalidateQueries({ queryKey: ['governance-summary'] });
      qc.invalidateQueries({ queryKey: ['approvals-dash'] });
      qc.invalidateQueries({ queryKey: ['party'] });
      toast({ tone: decision === 'approved' ? 'success' : 'warning', title: `Request ${decision}`, body: decision === 'approved' ? 'The change is being applied.' : undefined });
      onClose();
    } catch (e) { toast({ tone: 'error', title: (e as Error).message }); } finally { setBusy(null); }
  }

  const payload = a?.payload ?? {};
  const before = payload.before as Record<string, unknown> | undefined;
  const after = payload.after as Record<string, unknown> | undefined;
  const details = Object.entries(payload).filter(([k]) => !['before', 'after', 'party_id'].includes(k));
  const partyLink = payload.party_id ? `/partners/${payload.party_type ?? 'supplier'}/${payload.party_id}` : a ? recordLink(a) : null;

  return (
    <Drawer open onClose={onClose} width="lg" title={a?.title ?? 'Approval request'} description={a && <>Requested by {a.requested_by_name} · {fmtDateTime(a.requested_at)}</>}
      footer={canAct && <>
        <Button variant="danger" icon={<XCircle className="size-4" />} loading={busy === 'rejected'} disabled={!comment.trim()} onClick={() => decide('rejected')}>Reject</Button>
        <Button variant="primary" icon={<CheckCircle2 className="size-4" />} loading={busy === 'approved'} onClick={() => decide('approved')}>Approve</Button>
      </>}>
      {q.isError ? <ErrorState error={q.error} /> : !a ? <Skeleton className="h-64" /> : (
        <div className="space-y-6">
          <div className="flex items-center gap-2"><StatusBadge status={a.status} /><Badge>{humanize(a.approval_type)}</Badge><Badge tone="neutral">{a.source_service}</Badge></div>
          {a.summary && <Notice tone="info" title="Maker’s reason">{a.summary}</Notice>}
          {before || after ? (
            <div><h3 className="mb-2 text-[13px] font-semibold">Proposed change</h3><Diff before={before ?? null} after={after ?? null} /></div>
          ) : (
            <div><h3 className="mb-2 text-[13px] font-semibold">Details</h3>
              <KeyValue columns={2} items={details.map(([k, v]) => ({ label: humanize(k), value: showValue(v), mono: /number|ifsc|code/.test(k) }))} />
            </div>
          )}
          {partyLink && <Link className="link text-[13px]" to={partyLink}>Open the record →</Link>}
          {a.status === 'pending' && own && <Notice tone="warning">You raised this request, so someone else must approve it.</Notice>}
          {a.status === 'pending' && !own && !can(a.required_permission) && <Notice tone="info">You don’t have approval rights for this request type.</Notice>}
          {canAct && <Textarea label="Comment" value={comment} onChange={(e) => setComment(e.target.value)} hint="Required when rejecting. Shared with the requester and stored in the audit trail." />}
          {a.status !== 'pending' && (
            <div className="rounded-lg border border-slate-200 p-4">
              <p className="flex items-center gap-2 text-[13.5px] font-medium">{a.status === 'approved' ? <CheckCircle2 className="size-4 text-emerald-500" /> : <XCircle className="size-4 text-rose-500" />}{humanize(a.status)} by {a.decided_by_name}</p>
              <p className="mt-0.5 flex items-center gap-1.5 text-[12.5px] text-slate-500"><Clock className="size-3.5" />{fmtDateTime(a.decided_at)}</p>
              {a.comment && <p className="mt-2 text-[13px] text-slate-700">“{a.comment}”</p>}
            </div>
          )}
        </div>
      )}
    </Drawer>
  );
}

export function DocumentsPage() {
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [versions, setVersions] = useState<string | null>(null);
  const [preview, setPreview] = useState<Doc | null>(null);
  return (
    <>
      <PageHeader title="Documents" description="All documents across partners, products and the organisation. Upload from each record’s Documents tab; versions are never overwritten." breadcrumbs={[{ label: 'Governance' }, { label: 'Documents' }]} />
      <DataTable<Doc>
        id="documents"
        endpoint="/governance/documents"
        filters={filters}
        onFiltersChange={setFilters}
        defaultSort={{ key: 'updated_at', dir: 'desc' }}
        searchPlaceholder="Search title or type…"
        onRowClick={(r) => setPreview(r)}
        toolbar={<>
          <FilterSelect placeholder="All record types" value={filters.entityType} onChange={(v) => setFilters({ ...filters, entityType: v })} options={['customer', 'supplier', 'manufacturer', 'mill', 'transporter', 'product'].map((v) => ({ value: v, label: humanize(v) }))} />
          <FilterSelect placeholder="Active" value={filters.status} onChange={(v) => setFilters({ ...filters, status: v })} options={[{ value: 'archived', label: 'Archived' }]} />
        </>}
        empty={{ title: 'No documents yet', description: 'Open a business partner or product and use its Documents tab to upload.' }}
        columns={[
          { key: 'title', header: 'Title', sort: 'title', csv: (r) => r.title, render: (r) => <div><p className="font-medium text-slate-900">{r.title}</p><p className="text-[12px] text-slate-500">{r.file_name} · {fmtBytes(r.size_bytes)}</p></div> },
          { key: 'type', header: 'Type', sort: 'document_type', csv: (r) => r.document_type, render: (r) => <Badge>{humanize(r.document_type.toLowerCase())}</Badge> },
          { key: 'record', header: 'Attached to', csv: (r) => r.entity_type, render: (r) => humanize(r.entity_type) },
          { key: 'ver', header: 'Version', align: 'right', csv: (r) => r.current_version, render: (r) => <button className="link" onClick={(e) => { e.stopPropagation(); setVersions(r.id); }}>v{r.current_version}</button> },
          { key: 'exp', header: 'Expires', sort: 'expires_on', csv: (r) => r.expires_on, render: (r) => r.expires_on ? <span className={new Date(r.expires_on) < new Date() ? 'font-medium text-rose-600' : ''}>{fmtDate(r.expires_on)}</span> : '—' },
          { key: 'up', header: 'Updated', sort: 'updated_at', csv: (r) => r.uploaded_at, render: (r) => <span className="text-[12.5px] whitespace-nowrap">{r.uploaded_by_name} · {fmtRelative(r.uploaded_at)}</span> },
        ]}
      />
      {versions && <VersionsDrawer docId={versions} onClose={() => setVersions(null)} />}
      {preview && <Preview doc={preview} version={preview.current_version} onClose={() => setPreview(null)} />}
    </>
  );
}

