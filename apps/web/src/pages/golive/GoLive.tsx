import { useQuery, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { CheckCircle2, Circle, Download, FileUp, LifeBuoy, ListChecks, Plus, Rocket, XCircle } from 'lucide-react';
import { useState } from 'react';
import { api, invalidatePrefix } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { fmtDateTime, fmtNum, fmtRelative, humanize } from '../../lib/format';
import { SimpleTable } from '../../components/DataTable';
import { Drawer, Modal, useToast } from '../../components/overlay';
import { Badge, Button, Card, Checkbox, EmptyState, Input, Notice, PageHeader, Segmented, Select, Skeleton, Stat, StatusBadge, Tabs, Textarea } from '../../components/ui';

type Row = Record<string, any>;
const errMsg = (e: unknown) => (e as Error).message;
const crumbs = (label: string) => [{ label: 'Go-live', to: '/golive' }, { label }];

// ---------------------------------------------------------------- readiness
export function GoLivePage() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['gl-ready'], queryFn: () => api.get<{ ready: boolean; criteria: { key: string; label: string; ok: boolean; detail: string }[] }>('/golive/readiness') });
  const cut = useQuery({ queryKey: ['gl-cut'], queryFn: () => api.get<{ tasks: Row[]; decisions: Row[] }>('/golive/cutover') });
  const [open, setOpen] = useState(false);
  const [v, setV] = useState({ decision: 'go', rollback_plan: 'Stop the ERP, restore the last verified backup into a fresh database or return to the legacy system from its frozen state; re-enter transactions since the cut-off from the paper log.', notes: '' });
  const d = q.data;
  return (
    <>
      <PageHeader title="Go-live readiness" description="Live criteria for the go/no-go decision: UAT, defects, migration sign-offs, training, the cutover checklist and a verified backup. The decision and the rollback plan are recorded." breadcrumbs={[{ label: 'Go-live' }]}
        actions={can('golive.uat.signoff') && <Button variant="primary" icon={<Rocket className="size-4" />} onClick={() => setOpen(true)}>Record go / no-go</Button>} />
      {!d ? <Skeleton className="h-60" /> : (
        <>
          <div className="mb-4">{d.ready ? <Notice tone="success" title="Every go-live criterion is met">Hold the go/no-go meeting and record the decision.</Notice> : <Notice tone="warning" title={`${d.criteria.filter((c) => !c.ok).length} of ${d.criteria.length} criteria not met yet`}>Each item links to the work that is still open.</Notice>}</div>
          <Card padded={false}>
            <ul className="divide-y divide-slate-100">{d.criteria.map((c) => <li key={c.key} className="flex items-start gap-3 px-5 py-3.5">{c.ok ? <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-emerald-600" /> : <XCircle className="mt-0.5 size-5 shrink-0 text-rose-500" />}<div><p className="font-medium">{c.label}</p><p className="text-[12.5px] text-slate-500">{c.detail}</p></div></li>)}</ul>
          </Card>
        </>
      )}
      {cut.data?.decisions.length ? <Card className="mt-4" title="Decisions" padded={false}><SimpleTable rows={cut.data.decisions} rowKey={(x) => x.id} columns={[{ key: 'd', header: 'Decision', render: (x) => <Badge tone={x.decision === 'go' ? 'success' : 'danger'}>{x.decision === 'go' ? 'GO' : 'NO-GO'}</Badge> }, { key: 'b', header: 'By', render: (x) => x.decided_by_name }, { key: 'w', header: 'When', render: (x) => fmtDateTime(x.at) }, { key: 'n', header: 'Notes', render: (x) => <span className="text-[12.5px]">{x.notes ?? '—'}</span> }]} /></Card> : null}
      <Modal open={open} onClose={() => setOpen(false)} size="lg" title="Go / no-go decision" footer={<><Button onClick={() => setOpen(false)}>Cancel</Button><Button variant="primary" onClick={async () => { try { await api.post('/golive/go-decision', { ...v, notes: v.notes || null }); setOpen(false); invalidatePrefix(qc, 'gl-'); } catch (e) { toast({ tone: 'error', title: 'Not recorded', body: errMsg(e) }); } }}>Record decision</Button></>}>
        <div className="space-y-3"><Segmented value={v.decision} onChange={(x) => setV({ ...v, decision: x })} options={[{ value: 'go', label: 'Go' }, { value: 'no_go', label: 'No-go' }]} /><Textarea label="Rollback plan" rows={4} value={v.rollback_plan} onChange={(e) => setV({ ...v, rollback_plan: e.target.value })} /><Textarea label="Notes (required if a criterion is not met)" value={v.notes} onChange={(e) => setV({ ...v, notes: e.target.value })} /></div>
      </Modal>
    </>
  );
}

// ---------------------------------------------------------------- migration
const OBJ_LABEL: Record<string, string> = { parties: 'Customers & suppliers', opening_balances: 'Opening receivables & payables', opening_gl: 'Opening trial balance', opening_stock: 'Opening stock', open_pos: 'Open purchase orders', open_orders: 'Open sales orders', open_job_work: 'Open job work', gst_credit: 'GST credit carried forward', gst_cash: 'GST cash ledger', itc_reversals: 'Pending ITC reversals' };
export function MigrationPage() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const list = useQuery({ queryKey: ['gl-mig'], queryFn: () => api.get<Row[]>('/golive/migration/batches') });
  const tpl = useQuery({ queryKey: ['gl-tpl'], queryFn: () => api.get<Record<string, { label: string; columns: string[]; example: string[]; control: string; help: string }>>('/golive/migration/templates') });
  const [upload, setUpload] = useState<string | null>(null);
  const [csv, setCsv] = useState('');
  const [name, setName] = useState<string | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const det = useQuery({ queryKey: ['gl-batch', sel], queryFn: () => api.get<Row>(`/golive/migration/batches/${sel}`), enabled: !!sel });
  const latest = (t: string) => list.data?.find((b) => b.object_type === t && b.status !== 'abandoned');
  const download = (t: string) => { const x = tpl.data![t]!; const url = URL.createObjectURL(new Blob([`${x.columns.join(',')}\n${x.example.join(',')}\n`], { type: 'text/csv' })); const a = document.createElement('a'); a.href = url; a.download = `${t}-template.csv`; a.click(); URL.revokeObjectURL(url); };
  const act = async (path: string, body: Row = {}) => { setBusy(true); try { await api.post(path, body); invalidatePrefix(qc, 'gl-'); } catch (e) { toast({ tone: 'error', title: 'Not done', body: errMsg(e) }); } finally { setBusy(false); } };
  return (
    <>
      <PageHeader title="Data migration" description="Load masters and opening balances from the old system: upload a CSV, see every row that fails validation, load the rest through the same checks as daily work, reconcile against the file’s control total, and have a business owner sign each batch off." breadcrumbs={crumbs('Migration')} />
      <div className="mb-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {Object.entries(tpl.data ?? {}).map(([k, x]) => { const b = latest(k); return (
          <Card key={k} title={x.label} description={b ? `${b.number} · ${humanize(b.status)}` : 'Not loaded yet'}>
            {b && b.source_total != null && <p className="mb-2 text-[13px]">{x.control}: <b>{fmtNum(b.source_total)}</b> in file · <b>{b.erp_total == null ? '—' : fmtNum(b.erp_total)}</b> in ERP {b.difference != null && <Badge tone={Math.abs(b.difference) < 0.01 ? 'success' : 'danger'}>{Math.abs(b.difference) < 0.01 ? 'ties up' : `diff ${fmtNum(b.difference)}`}</Badge>}</p>}
            <p className="mb-3 text-[12px] text-slate-500">{x.help}</p>
            <div className="flex gap-2"><Button size="sm" icon={<Download className="size-3.5" />} onClick={() => download(k)}>Template</Button>{can('golive.migration.manage') && <Button size="sm" variant="primary" icon={<FileUp className="size-3.5" />} onClick={() => { setUpload(k); setCsv(''); }}>Upload</Button>}</div>
          </Card>
        ); })}
      </div>
      <Card title="Batches" padded={false}>{!list.data ? <Skeleton className="m-5 h-32" /> : <SimpleTable rows={list.data} rowKey={(b) => b.id} onRowClick={(b) => setSel(b.id)} empty={<EmptyState title="No batches yet" />} columns={[
        { key: 'n', header: 'Batch', render: (b) => <div><p className="font-mono text-[12.5px] font-semibold">{b.number}</p><p className="text-[12px] text-slate-500">{OBJ_LABEL[b.object_type]} · {b.file_name}</p></div> },
        { key: 'r', header: 'Rows', render: (b) => <span className="text-[12.5px]">{b.rows} · <span className="text-emerald-700">{b.valid} valid</span>{b.invalid ? <span className="text-rose-600"> · {b.invalid} invalid</span> : ''}{b.failed ? <span className="text-rose-600"> · {b.failed} failed</span> : ''}</span> },
        { key: 't', header: 'File / ERP', align: 'right', render: (b) => (b.source_total == null ? '—' : `${fmtNum(b.source_total)} / ${b.erp_total == null ? '—' : fmtNum(b.erp_total)}`) },
        { key: 's', header: 'Status', render: (b) => <div><StatusBadge status={b.status} />{b.signed_off_by_name && <p className="text-[11.5px] text-slate-500">{b.signed_off_by_name}</p>}</div> },
        { key: 'b', header: 'Loaded by', render: (b) => <span className="text-[12.5px]">{b.created_by_name} · {fmtRelative(b.created_at)}</span> },
      ]} />}</Card>
      <Modal open={!!upload} onClose={() => setUpload(null)} size="lg" title={`Upload ${upload ? OBJ_LABEL[upload] : ''}`} description={upload ? `Columns: ${tpl.data?.[upload]?.columns.join(', ')}` : undefined}
        footer={<><Button onClick={() => setUpload(null)}>Cancel</Button><Button variant="primary" loading={busy} disabled={csv.length < 5} onClick={async () => { setBusy(true); try { const r = await api.post<{ id: string }>('/golive/migration/batches', { object_type: upload, csv, file_name: name }); setUpload(null); invalidatePrefix(qc, 'gl-'); setSel(r.id); } catch (e) { toast({ tone: 'error', title: 'Not accepted', body: errMsg(e) }); } finally { setBusy(false); } }}>Validate</Button></>}>
        <div className="space-y-3"><input type="file" accept=".csv,text/csv" className="text-[13px]" onChange={async (e) => { const f = e.target.files?.[0]; if (f) { setName(f.name); setCsv(await f.text()); } }} /><Textarea label="…or paste" rows={8} className="font-mono text-[12px]" value={csv} onChange={(e) => setCsv(e.target.value)} /></div>
      </Modal>
      <Drawer open={!!sel} onClose={() => setSel(null)} width="xl" title={det.data ? `${det.data.number} · ${OBJ_LABEL[det.data.object_type]}` : ''} description={det.data ? `${humanize(det.data.status)} · ${det.data.rows} rows` : undefined}
        footer={det.data && <div className="flex w-full flex-wrap justify-end gap-2">
          {det.data.status === 'validated' && can('golive.migration.manage') && <><Button onClick={() => void act(`/golive/migration/batches/${sel}/abandon`)}>Abandon</Button><Button variant="primary" loading={busy} disabled={!det.data.valid} onClick={() => void act(`/golive/migration/batches/${sel}/import`)}>Load {det.data.valid} valid rows</Button></>}
          {['imported', 'reconciled'].includes(det.data.status) && <Button loading={busy} onClick={() => void act(`/golive/migration/batches/${sel}/reconcile`)}>Reconcile again</Button>}
          {det.data.status === 'reconciled' && can('golive.migration.signoff') && <Button variant="primary" loading={busy} onClick={() => void act(`/golive/migration/batches/${sel}/signoff`, Math.abs(det.data!.difference ?? 0) > 0.01 || det.data!.failed ? { accept_difference: true, note: prompt('Why is the difference accepted?') ?? '' } : {})}>Sign off</Button>}
        </div>}>
        {!det.data ? <Skeleton className="h-60" /> : (
          <div className="space-y-4">
            {det.data.notes && <Notice tone="warning">{det.data.notes}</Notice>}
            {det.data.source_total != null && <div className="grid grid-cols-3 gap-3"><Stat label={`${det.data.control_label} in file`} value={fmtNum(det.data.source_total)} /><Stat label="In the ERP" value={det.data.erp_total == null ? '—' : fmtNum(det.data.erp_total)} /><Stat label="Difference" value={det.data.difference == null ? '—' : fmtNum(det.data.difference)} tone={det.data.difference == null ? undefined : Math.abs(det.data.difference) < 0.01 ? 'success' : 'danger'} /></div>}
            {det.data.reconciliation?.note && <Notice tone="info">{det.data.reconciliation.note}</Notice>}
            <SimpleTable rows={det.data.rows} rowKey={(r: Row) => String(r.row_no)} columns={[
              { key: 'n', header: 'Line', render: (r: Row) => r.row_no },
              { key: 'd', header: 'Data', render: (r: Row) => <span className="font-mono text-[11.5px]">{Object.values(r.data).filter(Boolean).slice(0, 5).join(' · ')}</span> },
              { key: 's', header: 'Result', render: (r: Row) => <div><Badge tone={r.status === 'imported' ? 'success' : r.status === 'valid' ? 'info' : r.status === 'skipped' ? 'neutral' : 'danger'}>{r.status}</Badge>{r.result_ref && <span className="ml-1 font-mono text-[11.5px]">{r.result_ref}</span>}{[...(r.errors ?? []), r.error].filter(Boolean).map((e: string) => <p key={e} className="text-[11.5px] text-rose-600">{e}</p>)}</div> },
            ]} />
          </div>
        )}
      </Drawer>
    </>
  );
}

// ---------------------------------------------------------------- UAT
export function UatPage() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const [tab, setTab] = useState<'summary' | 'scenarios' | 'defects'>('summary');
  const [phase, setPhase] = useState('');
  const [status, setStatus] = useState('');
  const sum = useQuery({ queryKey: ['gl-uatsum'], queryFn: () => api.get<{ phases: Row[]; overall: Row }>('/golive/uat/summary') });
  const sc = useQuery({ queryKey: ['gl-sc', phase, status], queryFn: () => api.get<Row[]>(`/golive/uat/scenarios?${phase ? `phase=${phase}&` : ''}${status ? `status=${status}` : ''}`), enabled: tab === 'scenarios' });
  const defs = useQuery({ queryKey: ['gl-def'], queryFn: () => api.get<Row[]>('/golive/uat/defects'), enabled: tab === 'defects' });
  const [run, setRun] = useState<Row | null>(null);
  const [rv, setRv] = useState({ result: 'passed', evidence: '', title: '', severity: 'S3' });
  const [sign, setSign] = useState<string | null>(null);
  const [sv, setSv] = useState({ decision: 'approved', conditions: '', role: '' });
  const o = sum.data?.overall;
  return (
    <>
      <PageHeader title="UAT and sign-off" description="One scenario per requirement plus cross-cutting tests (exceptions, permissions, concurrency, tax, barcodes, integration, performance, security, backup). Failures raise defects; a phase is signed off when every scenario is run and no S1/S2 defect is open." breadcrumbs={crumbs('UAT')} />
      {o && <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-5"><Stat label="Scenarios" value={o.scenarios.total} /><Stat label="Passed" value={o.scenarios.passed} tone="success" /><Stat label="Failed / blocked" value={o.scenarios.failed + o.scenarios.blocked} tone={o.scenarios.failed + o.scenarios.blocked ? 'danger' : undefined} /><Stat label="Not run" value={o.scenarios.not_run} /><Stat label="Open S1 / S2" value={`${o.open_defects.s1} / ${o.open_defects.s2}`} tone={o.open_defects.s1 + o.open_defects.s2 ? 'danger' : undefined} /></div>}
      <Tabs className="mb-4" value={tab} onChange={setTab} tabs={[{ value: 'summary', label: 'By phase' }, { value: 'scenarios', label: 'Scenarios' }, { value: 'defects', label: 'Defects' }]} />
      {tab === 'summary' ? (
        <Card padded={false}>{!sum.data ? <Skeleton className="m-5 h-40" /> : <SimpleTable rows={sum.data.phases} rowKey={(p) => p.phase} columns={[
          { key: 'p', header: 'Phase', render: (p) => <span className="font-semibold">{p.phase === 'ALL' ? 'Cross-cutting' : p.phase}</span> },
          { key: 'r', header: 'Progress', render: (p) => { const s = p.scenarios; const pct = s.total ? Math.round(((s.passed + s.waived) / s.total) * 100) : 0; return <div className="w-48"><div className="h-2 rounded-full bg-slate-100"><div className="h-2 rounded-full bg-emerald-500" style={{ width: `${pct}%` }} /></div><p className="mt-1 text-[11.5px] text-slate-500">{s.passed + s.waived} of {s.total} done{s.failed ? ` · ${s.failed} failed` : ''}</p></div>; } },
          { key: 'd', header: 'Open defects', render: (p) => `${p.open_defects.s1 + p.open_defects.s2} S1/S2 · ${p.open_defects.other} other` },
          { key: 'k', header: 'Ready', render: (p) => (p.ready ? <Badge tone="success">Ready</Badge> : <Badge tone="warning">Not yet</Badge>) },
          { key: 's', header: 'Sign-off', render: (p) => (p.signoff ? <span className="text-[12.5px]"><StatusBadge status={p.signoff.decision} /> {p.signoff.signed_by_name}{p.signoff.conditions ? ' (with conditions)' : ''}</span> : can('golive.uat.signoff') ? <Button size="sm" onClick={() => setSign(p.phase)}>Sign off</Button> : '—') },
        ]} />}</Card>
      ) : tab === 'scenarios' ? (
        <>
          <div className="mb-3 flex flex-wrap gap-2"><Select className="w-40" value={phase} onChange={(e) => setPhase(e.target.value)} options={[{ value: '', label: 'All phases' }, ...(sum.data?.phases ?? []).map((p) => ({ value: p.phase, label: p.phase === 'ALL' ? 'Cross-cutting' : p.phase }))]} /><Segmented value={status} onChange={setStatus} options={[{ value: '', label: 'All' }, { value: 'not_run', label: 'Not run' }, { value: 'failed,blocked', label: 'Failed / blocked' }, { value: 'passed,waived', label: 'Done' }]} /></div>
          <Card padded={false}>{!sc.data ? <Skeleton className="m-5 h-40" /> : <SimpleTable rows={sc.data} rowKey={(s) => s.id} onRowClick={(s) => { setRun(s); setRv({ result: 'passed', evidence: '', title: '', severity: 'S3' }); }} columns={[
            { key: 'c', header: 'Scenario', render: (s) => <div><p className="font-medium">{s.title}</p><p className="text-[12px] text-slate-500">{s.code} · {s.module}{s.category !== 'normal' ? ` · ${s.category}` : ''}</p></div> },
            { key: 'e', header: 'Expected', render: (s) => <span className="line-clamp-2 max-w-md text-[12.5px] text-slate-600">{s.expected}</span> },
            { key: 'b', header: 'Last run', render: (s) => (s.executed_by_name ? <span className="text-[12px]">{s.executed_by_name} · {fmtRelative(s.executed_at)}</span> : '—') },
            { key: 's', header: 'Status', render: (s) => <div><Badge tone={s.status === 'passed' ? 'success' : s.status === 'failed' ? 'danger' : s.status === 'blocked' ? 'warning' : s.status === 'waived' ? 'violet' : 'neutral'}>{humanize(s.status)}</Badge>{s.open_defects ? <p className="text-[11px] text-rose-600">{s.open_defects} open defect(s)</p> : null}</div> },
          ]} />}</Card>
        </>
      ) : (
        <Card padded={false}>{!defs.data ? <Skeleton className="m-5 h-40" /> : <SimpleTable rows={defs.data} rowKey={(d) => d.id} empty={<EmptyState title="No defects" />} columns={[
          { key: 'v', header: '', render: (d) => <Badge tone={['S1', 'S2'].includes(d.severity) ? 'danger' : 'warning'}>{d.severity}</Badge> },
          { key: 't', header: 'Defect', render: (d) => <div><p className="font-medium">{d.title}</p><p className="text-[12px] text-slate-500">{d.number} · {d.scenario_code} · raised by {d.raised_by_name}</p></div> },
          { key: 'a', header: 'With', render: (d) => d.assigned_to_name ?? '—' },
          { key: 's', header: 'Status', render: (d) => can('golive.uat.execute') ? <Select className="w-32" value={d.status} onChange={async (e) => { await api.patch(`/golive/uat/defects/${d.id}`, { status: e.target.value }); invalidatePrefix(qc, 'gl-'); }} options={['open', 'in_progress', 'fixed', 'retest', 'closed', 'rejected'].map((x) => ({ value: x, label: humanize(x) }))} /> : <StatusBadge status={d.status} /> },
        ]} />}</Card>
      )}
      <Modal open={!!run} onClose={() => setRun(null)} size="lg" title={run?.title ?? ''} description={run ? `${run.code} · ${run.module}` : undefined}
        footer={can('golive.uat.execute') && <><Button onClick={() => setRun(null)}>Cancel</Button>{can('golive.uat.signoff') && <Button onClick={async () => { const reason = prompt('Why is this scenario waived?'); if (reason) { await api.post(`/golive/uat/scenarios/${run!.id}/waive`, { reason }); setRun(null); invalidatePrefix(qc, 'gl-'); } }}>Waive</Button>}<Button variant="primary" onClick={async () => { try { await api.post(`/golive/uat/scenarios/${run!.id}/result`, { result: rv.result, evidence: rv.evidence, defect: rv.result === 'failed' ? { title: rv.title, severity: rv.severity } : undefined }); setRun(null); invalidatePrefix(qc, 'gl-'); } catch (e) { toast({ tone: 'error', title: 'Not saved', body: errMsg(e) }); } }}>Record result</Button></>}>
        {run && <div className="space-y-3 text-[13.5px]"><div><p className="text-[12px] font-semibold text-slate-500 uppercase">Steps</p><p>{run.steps}</p></div><div><p className="text-[12px] font-semibold text-slate-500 uppercase">Expected</p><p>{run.expected}</p></div>
          {can('golive.uat.execute') && <><Segmented value={rv.result} onChange={(x) => setRv({ ...rv, result: x })} options={[{ value: 'passed', label: 'Passed' }, { value: 'failed', label: 'Failed' }, { value: 'blocked', label: 'Blocked' }]} /><Textarea label="Evidence (what you did and saw; document or screenshot reference)" value={rv.evidence} onChange={(e) => setRv({ ...rv, evidence: e.target.value })} />
            {rv.result === 'failed' && <div className="grid grid-cols-[1fr_120px] gap-2"><Input label="Defect title" value={rv.title} onChange={(e) => setRv({ ...rv, title: e.target.value })} /><Select label="Severity" value={rv.severity} onChange={(e) => setRv({ ...rv, severity: e.target.value })} options={[['S1', 'S1 — blocks go-live'], ['S2', 'S2 — major'], ['S3', 'S3 — minor'], ['S4', 'S4 — cosmetic']].map(([v, l]) => ({ value: v!, label: l! }))} /></div>}</>}</div>}
      </Modal>
      <Modal open={!!sign} onClose={() => setSign(null)} title={`Sign off ${sign === 'ALL' ? 'cross-cutting tests' : sign}`} footer={<><Button onClick={() => setSign(null)}>Cancel</Button><Button variant="primary" onClick={async () => { try { await api.post('/golive/uat/signoff', { scope: sign, decision: sv.decision, conditions: sv.conditions || null, role: sv.role || null }); setSign(null); invalidatePrefix(qc, 'gl-'); } catch (e) { toast({ tone: 'error', title: 'Not signed', body: errMsg(e) }); } }}>Sign</Button></>}>
        <div className="space-y-3"><Segmented value={sv.decision} onChange={(x) => setSv({ ...sv, decision: x })} options={[{ value: 'approved', label: 'Approve' }, { value: 'rejected', label: 'Reject' }]} /><Input label="Your role" value={sv.role} onChange={(e) => setSv({ ...sv, role: e.target.value })} placeholder="Business owner, Finance head…" /><Textarea label="Conditions (required if criteria are not met)" value={sv.conditions} onChange={(e) => setSv({ ...sv, conditions: e.target.value })} /></div>
      </Modal>
    </>
  );
}

// ---------------------------------------------------------------- training
export function TrainingPage() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['gl-train'], queryFn: () => api.get<{ modules: Row[]; records: Row[]; staff: Row[]; completion: Row }>('/golive/training') });
  const [assign, setAssign] = useState(false);
  const [sel, setSel] = useState<{ users: string[]; mods: string[] }>({ users: [], mods: [] });
  const d = q.data;
  const manage = can('golive.uat.signoff', 'golive.migration.manage');
  return (
    <>
      <PageHeader title="Training" description="Role-based training modules (with the screens each covers) and who has completed them. Go-live needs every assigned module completed." breadcrumbs={crumbs('Training')} actions={manage && <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setAssign(true)}>Assign training</Button>} />
      {!d ? <Skeleton className="h-60" /> : (
        <>
          <div className="mb-4 grid grid-cols-3 gap-3"><Stat label="Modules completed" value={`${d.completion.completed} / ${d.completion.assigned}`} /><Stat label="Staff fully trained" value={`${d.completion.staff_trained} / ${d.completion.staff}`} /><Stat label="Modules" value={d.modules.length} /></div>
          <Card title="Who has done what" padded={false}>
            <div className="scrollbar-thin overflow-x-auto"><table className="w-full text-[12.5px]"><thead><tr className="border-b border-slate-200 bg-slate-50"><th className="px-3 py-2 text-left">Person</th>{d.modules.map((m) => <th key={m.code} title={m.title} className="px-2 py-2 font-mono text-[11px]">{m.code}</th>)}</tr></thead>
              <tbody className="divide-y divide-slate-100">{d.staff.map((u) => <tr key={u.id}><td className="px-3 py-1.5 whitespace-nowrap">{u.name}</td>{d.modules.map((m) => { const r = d.records.find((x) => x.user_id === u.id && x.module_code === m.code); return <td key={m.code} className="px-2 py-1.5 text-center">{!r ? <span className="text-slate-200">·</span> : r.status === 'completed' ? <CheckCircle2 className="mx-auto size-4 text-emerald-600" /> : manage ? <button title="Mark completed" onClick={async () => { await api.post('/golive/training/complete', { user_id: u.id, module_code: m.code }); invalidatePrefix(qc, 'gl-'); }}><Circle className="mx-auto size-4 text-amber-500" /></button> : <Circle className="mx-auto size-4 text-amber-500" />}</td>; })}</tr>)}</tbody></table></div>
          </Card>
          <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">{d.modules.map((m) => <Card key={m.code} title={`${m.code} · ${m.title}`} description={`${m.role} · ${m.duration_min} min`}><p className="text-[13px]">{m.outline}</p><p className="mt-2 text-[12px] text-slate-500">Screens: {m.screens.join(', ')}</p></Card>)}</div>
        </>
      )}
      <Modal open={assign} onClose={() => setAssign(false)} size="lg" title="Assign training" footer={<><Button onClick={() => setAssign(false)}>Cancel</Button><Button variant="primary" disabled={!sel.users.length || !sel.mods.length} onClick={async () => { await api.post('/golive/training/assign', { user_ids: sel.users, module_codes: sel.mods }); setAssign(false); invalidatePrefix(qc, 'gl-'); }}>Assign</Button></>}>
        <div className="grid grid-cols-2 gap-4"><div><p className="mb-2 text-[12.5px] font-semibold">People</p><div className="max-h-80 space-y-1 overflow-y-auto">{d?.staff.map((u) => <Checkbox key={u.id} label={u.name} checked={sel.users.includes(u.id)} onChange={(e) => setSel({ ...sel, users: e.target.checked ? [...sel.users, u.id] : sel.users.filter((x) => x !== u.id) })} />)}</div></div>
          <div><p className="mb-2 text-[12.5px] font-semibold">Modules</p><div className="max-h-80 space-y-1 overflow-y-auto">{d?.modules.map((m) => <Checkbox key={m.code} label={`${m.code} ${m.title}`} checked={sel.mods.includes(m.code)} onChange={(e) => setSel({ ...sel, mods: e.target.checked ? [...sel.mods, m.code] : sel.mods.filter((x) => x !== m.code) })} />)}</div></div></div>
      </Modal>
    </>
  );
}

// ---------------------------------------------------------------- cutover & hypercare
const STAGES = ['prepare', 'freeze', 'migrate', 'verify', 'go_live', 'hypercare'];
export function CutoverPage() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['gl-cut'], queryFn: () => api.get<{ tasks: Row[] }>('/golive/cutover') });
  const done = (q.data?.tasks ?? []).filter((t) => ['done', 'not_applicable'].includes(t.status)).length;
  return (
    <>
      <PageHeader title="Cutover checklist" description="Every step from preparing the server to stabilisation, with an owner. Freeze, migrate and verify happen in one planned window." breadcrumbs={crumbs('Cutover')} meta={q.data && <Badge tone="info">{done} of {q.data.tasks.length} done</Badge>} />
      {!q.data ? <Skeleton className="h-80" /> : STAGES.map((st) => (
        <Card key={st} className="mb-4" title={humanize(st)} padded={false}>
          <ul className="divide-y divide-slate-100">{q.data!.tasks.filter((t) => t.stage === st).map((t) => (
            <li key={t.id} className="flex items-center gap-3 px-5 py-2.5 text-[13px]">
              {t.status === 'done' ? <CheckCircle2 className="size-5 shrink-0 text-emerald-600" /> : t.status === 'blocked' ? <XCircle className="size-5 shrink-0 text-rose-500" /> : <Circle className="size-5 shrink-0 text-slate-300" />}
              <div className="flex-1"><p className={clsx(t.status === 'not_applicable' && 'text-slate-400 line-through')}>{t.title}</p><p className="text-[12px] text-slate-500">{t.owner_role}{t.done_by_name ? ` · ${t.done_by_name}, ${fmtRelative(t.done_at)}` : ''}{t.notes ? ` · ${t.notes}` : ''}</p></div>
              {can('golive.cutover.manage') && <Select className="w-40" value={t.status} onChange={async (e) => { await api.patch(`/golive/cutover/${t.id}`, { status: e.target.value }); invalidatePrefix(qc, 'gl-'); }} options={['todo', 'done', 'blocked', 'not_applicable'].map((x) => ({ value: x, label: humanize(x) }))} />}
            </li>))}</ul>
        </Card>
      ))}
    </>
  );
}

export function HypercarePage() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['gl-inc'], queryFn: () => api.get<Row[]>('/golive/incidents') });
  const [open, setOpen] = useState(false);
  const [v, setV] = useState({ title: '', description: '', module: '', severity: 'P3' });
  const [sel, setSel] = useState<Row | null>(null);
  const [res, setRes] = useState('');
  const openN = (q.data ?? []).filter((i) => ['open', 'investigating'].includes(i.status));
  return (
    <>
      <PageHeader title="Hypercare" description="Problems reported after go-live, with response and resolution deadlines by severity: P1 30 min / 4 h, P2 2 h / 1 day, P3 8 h / 3 days, P4 1 day / 10 days." breadcrumbs={crumbs('Hypercare')} actions={<Button variant="primary" icon={<LifeBuoy className="size-4" />} onClick={() => setOpen(true)}>Report a problem</Button>} />
      <div className="mb-4 grid grid-cols-3 gap-3"><Stat label="Open" value={openN.length} /><Stat label="P1 / P2 open" value={openN.filter((i) => ['P1', 'P2'].includes(i.severity)).length} tone={openN.some((i) => ['P1', 'P2'].includes(i.severity)) ? 'danger' : undefined} /><Stat label="Past resolution deadline" value={openN.filter((i) => i.breached).length} tone={openN.some((i) => i.breached) ? 'danger' : undefined} /></div>
      <Card padded={false}>{!q.data ? <Skeleton className="m-5 h-40" /> : <SimpleTable rows={q.data} rowKey={(i) => i.id} onRowClick={(i) => { setSel(i); setRes(i.resolution ?? ''); }} empty={<EmptyState icon={<ListChecks className="size-5" />} title="No incidents" />} columns={[
        { key: 's', header: '', render: (i) => <Badge tone={['P1', 'P2'].includes(i.severity) ? 'danger' : 'warning'}>{i.severity}</Badge> },
        { key: 't', header: 'Incident', render: (i) => <div><p className="font-medium">{i.title}</p><p className="text-[12px] text-slate-500">{i.number} · {i.module ?? '—'} · {i.reported_by_name}</p></div> },
        { key: 'd', header: 'Resolve by', render: (i) => <span className={i.breached ? 'font-semibold text-rose-600' : ''}>{fmtDateTime(i.resolve_by)}</span> },
        { key: 'a', header: 'With', render: (i) => i.assigned_to_name ?? '—' },
        { key: 'x', header: 'Status', render: (i) => <StatusBadge status={i.status} /> },
      ]} />}</Card>
      <Modal open={open} onClose={() => setOpen(false)} title="Report a problem" footer={<><Button onClick={() => setOpen(false)}>Cancel</Button><Button variant="primary" onClick={async () => { try { await api.post('/golive/incidents', { ...v, module: v.module || null }); setOpen(false); invalidatePrefix(qc, 'gl-'); } catch (e) { toast({ tone: 'error', title: 'Not saved', body: errMsg(e) }); } }}>Report</Button></>}>
        <div className="space-y-3"><Input label="What is wrong" value={v.title} onChange={(e) => setV({ ...v, title: e.target.value })} /><Textarea label="Details (screen, record, what you expected)" value={v.description} onChange={(e) => setV({ ...v, description: e.target.value })} /><div className="grid grid-cols-2 gap-2"><Input label="Module" value={v.module} onChange={(e) => setV({ ...v, module: e.target.value })} /><Select label="Severity" value={v.severity} onChange={(e) => setV({ ...v, severity: e.target.value })} options={[['P1', 'P1 — business stopped'], ['P2', 'P2 — major function down'], ['P3', 'P3 — workaround exists'], ['P4', 'P4 — minor']].map(([a, b]) => ({ value: a!, label: b! }))} /></div></div>
      </Modal>
      <Modal open={!!sel} onClose={() => setSel(null)} title={sel?.title ?? ''} description={sel ? `${sel.number} · ${sel.severity}` : undefined} footer={can('golive.cutover.manage') && sel && <><Button onClick={async () => { await api.patch(`/golive/incidents/${sel.id}`, { status: 'investigating', assigned_to_name: null }); setSel(null); invalidatePrefix(qc, 'gl-'); }}>Investigating</Button><Button variant="primary" disabled={res.trim().length < 3} onClick={async () => { await api.patch(`/golive/incidents/${sel.id}`, { status: 'resolved', resolution: res }); setSel(null); invalidatePrefix(qc, 'gl-'); }}>Resolved</Button></>}>
        {sel && <div className="space-y-3 text-[13.5px]"><p className="whitespace-pre-wrap">{sel.description}</p><p className="text-[12px] text-slate-500">Respond by {fmtDateTime(sel.respond_by)} · resolve by {fmtDateTime(sel.resolve_by)}</p>{can('golive.cutover.manage') && <Textarea label="Resolution" value={res} onChange={(e) => setRes(e.target.value)} />}</div>}
      </Modal>
    </>
  );
}
