import { useQuery, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { AlertTriangle, CheckCircle2, Cpu, FileText, Info, Plus, RefreshCw, Sparkles, Trash2, Upload, XCircle } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Link } from '../../components/AppLink';
import { api, invalidatePrefix } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { fmtDateTime, fmtINR, fmtRelative, humanize } from '../../lib/format';
import { DataTable, FilterSelect } from '../../components/DataTable';
import { useParties } from '../../components/business';
import { ConfirmDialog, Modal, useToast } from '../../components/overlay';
import { Badge, Button, ErrorState, IconButton, Input, Notice, PageHeader, Select, Skeleton, Spinner, Stat, StatusBadge } from '../../components/ui';

interface Stats { ai_enabled: boolean; by_status: Record<string, number>; extracted_last_hour: number; avg_ms: number | null; concurrency: number }
interface CaptureRow { id: string; batch_name: string; file_name: string; status: string; extractor: string | null; confidence: number | null; supplier_name: string | null; invoice_number: string | null; total_value: number | null; warning_count: number; critical_count: number; error: string | null; created_at: string; invoice_id: string | null }
interface Warning { field?: string; severity: 'info' | 'warning' | 'critical'; message: string }
interface CapLine { description: string; hsn_code: string | null; qty_kg: number | null; unit: string | null; rate: number | null; gst_rate: number | null; po_line_id?: string | null; confidence?: number }
interface CapData { supplier_id: string | null; supplier_name: string | null; supplier_gstin: string | null; buyer_gstin: string | null; invoice_number: string | null; invoice_date: string | null; po_id: string | null; po_reference: string | null; taxable_value: number | null; cgst: number | null; sgst: number | null; igst: number | null; total_value: number | null; lines: CapLine[]; confidence: Record<string, number> }
interface Capture { id: string; batch_name: string; file_name: string; mime_type: string; status: string; extractor: string | null; data: CapData | null; warnings: Warning[]; confidence: number | null; error: string | null; history: { at: string; by: string; field: string; from: unknown; to: unknown }[]; invoice_id: string | null; reviewed_by_name: string | null; reviewed_at: string | null; extraction_ms: number | null; open_pos: { id: string; number: string; total_value: number }[]; po_lines: { id: string; line_no: number; sku: string; qty_kg: number; rate_per_kg: number; gst_rate: number; received_kg: number; invoiced_kg: number }[] }

const confTone = (c: number | undefined) => (c === undefined ? 'neutral' : c >= 0.9 ? 'success' : c >= 0.75 ? 'warning' : 'danger');

export function InvoiceWorkbenchPage() {
  const { can } = useAuth();
  const nav = useNavigate();
  const qc = useQueryClient();
  const stats = useQuery({ queryKey: ['capture-stats'], queryFn: () => api.get<Stats>('/procurement/captures/stats'), refetchInterval: 4000 });
  const [filters, setFilters] = useState<Record<string, string>>({ status: 'queued,extracting,needs_review,failed' });
  const [upload, setUpload] = useState(false);
  const pending = (stats.data?.by_status.queued ?? 0) + (stats.data?.by_status.extracting ?? 0);
  useEffect(() => {
    if (!pending) return;
    const t = setInterval(() => invalidatePrefix(qc, '/procurement/captures'), 3000);
    return () => clearInterval(t);
  }, [pending, qc]);
  return (
    <>
      <PageHeader title="Invoice workbench" description="Bulk-upload supplier invoices. AI reads each one and a reviewer checks it side by side with the document. Nothing is posted without human approval."
        breadcrumbs={[{ label: 'Procurement', to: '/procurement' }, { label: 'Invoice workbench' }]}
        actions={can('procurement.invoice.capture') && <Button variant="primary" icon={<Upload className="size-4" />} onClick={() => setUpload(true)}>Upload invoices</Button>} />
      {stats.data && !stats.data.ai_enabled && (
        <div className="mb-5"><Notice tone="warning" icon={<Info className="size-4" />} title="AI extraction is off">Set <span className="font-mono">ANTHROPIC_API_KEY</span> in <span className="font-mono">.env</span> and restart to have invoices read automatically. Until then, uploads open for manual entry beside the document.</Notice></div>
      )}
      <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-5">
        <Stat label="In queue" value={pending} sub={stats.data?.ai_enabled ? `${stats.data.concurrency} in parallel` : 'Manual mode'} />
        <Stat label="Needs review" value={stats.data?.by_status.needs_review ?? 0} tone={stats.data?.by_status.needs_review ? 'warning' : undefined} />
        <Stat label="Failed" value={stats.data?.by_status.failed ?? 0} tone={stats.data?.by_status.failed ? 'danger' : undefined} />
        <Stat label="Extracted, last hour" value={stats.data?.extracted_last_hour ?? 0} sub={stats.data?.avg_ms ? `avg ${(stats.data.avg_ms / 1000).toFixed(1)} s each` : undefined} />
        <Stat label="Approved" value={stats.data?.by_status.approved ?? 0} tone="success" />
      </div>
      <DataTable<CaptureRow>
        id="captures" endpoint="/procurement/captures" filters={filters} onFiltersChange={setFilters} defaultSort={{ key: 'created_at', dir: 'desc' }} onRowClick={(r) => nav(`/procurement/invoice-workbench/${r.id}`)}
        searchPlaceholder="Search file, supplier or invoice number…"
        toolbar={<FilterSelect placeholder="All statuses" value={filters.status} onChange={(v) => setFilters({ ...filters, status: v })} options={[{ value: 'queued,extracting,needs_review,failed', label: 'Open work' }, { value: 'needs_review', label: 'Needs review' }, { value: 'failed', label: 'Failed' }, { value: 'approved', label: 'Approved' }, { value: 'rejected', label: 'Rejected' }]} />}
        columns={[
          { key: 'file', header: 'Document', csv: (r) => r.file_name, render: (r) => <div className="flex items-center gap-2.5"><FileText className="size-4 shrink-0 text-slate-400" /><div className="min-w-0"><p className="truncate font-medium text-slate-900">{r.file_name}</p><p className="truncate text-[12px] text-slate-500">{r.batch_name} · {fmtRelative(r.created_at)}</p></div></div> },
          { key: 'supplier', header: 'Supplier', csv: (r) => r.supplier_name, render: (r) => r.supplier_name ?? <span className="text-slate-400">—</span> },
          { key: 'number', header: 'Invoice no.', csv: (r) => r.invoice_number, render: (r) => <span className="font-mono text-[12.5px]">{r.invoice_number ?? '—'}</span> },
          { key: 'total', header: 'Total', align: 'right', csv: (r) => r.total_value, render: (r) => fmtINR(r.total_value) },
          { key: 'conf', header: 'Confidence', sort: 'confidence', csv: (r) => r.confidence, render: (r) => r.confidence != null ? <Badge tone={confTone(r.confidence)}>{Math.round(r.confidence * 100)}%</Badge> : r.extractor === 'manual' ? <Badge>Manual</Badge> : '—' },
          { key: 'issues', header: 'Checks', csv: (r) => r.warning_count, render: (r) => r.critical_count ? <Badge tone="danger">{r.critical_count} blocking</Badge> : r.warning_count ? <Badge tone="warning">{r.warning_count} to check</Badge> : r.status === 'needs_review' ? <Badge tone="success">Clean</Badge> : '—' },
          { key: 'status', header: 'Status', sort: 'status', csv: (r) => r.status, render: (r) => <span className="flex items-center gap-1.5">{r.status === 'extracting' && <Spinner className="size-3.5" />}<StatusBadge status={r.status} /></span> },
        ]}
        empty={{ title: 'Nothing in the workbench', description: 'Upload a batch of supplier invoices to start.' }}
      />
      {upload && <UploadBatch onClose={() => setUpload(false)} onDone={() => { setUpload(false); invalidatePrefix(qc, '/procurement/captures'); stats.refetch(); }} />}
    </>
  );
}

const ACCEPT = { 'application/pdf': 'PDF', 'image/png': 'PNG', 'image/jpeg': 'JPEG', 'image/webp': 'WebP' } as Record<string, string>;

function UploadBatch({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [name, setName] = useState(`Invoices ${new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })}`);
  const [files, setFiles] = useState<File[]>([]);
  const [progress, setProgress] = useState<Record<string, 'pending' | 'done' | string>>({});
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const add = (list: FileList | null) => setFiles((f) => [...f, ...Array.from(list ?? []).filter((x) => ACCEPT[x.type] && !f.some((y) => y.name === x.name))]);
  async function start() {
    setBusy(true);
    const batch = await api.post<{ id: string }>('/procurement/captures/batches', { name });
    let ok = 0;
    for (const f of files) {
      setProgress((p) => ({ ...p, [f.name]: 'pending' }));
      try {
        await api.post(`/procurement/captures/batches/${batch.id}/files`, await f.arrayBuffer(), { 'Content-Type': f.type, 'X-File-Name': encodeURIComponent(f.name) });
        setProgress((p) => ({ ...p, [f.name]: 'done' }));
        ok++;
      } catch (e) { setProgress((p) => ({ ...p, [f.name]: (e as Error).message })); }
    }
    setBusy(false);
    toast({ tone: ok === files.length ? 'success' : 'warning', title: `${ok} of ${files.length} invoices queued for extraction` });
    if (ok === files.length) onDone();
  }
  return (
    <Modal open onClose={onClose} size="lg" title="Upload supplier invoices" description="PDFs (including multi-page and scans) or photos. Up to 20 MB each."
      footer={<><Button onClick={onClose}>Close</Button><Button variant="primary" loading={busy} disabled={!files.length} onClick={start}>Queue {files.length || ''} for extraction</Button></>}>
      <div className="space-y-4">
        <Input label="Batch name" value={name} onChange={(e) => setName(e.target.value)} />
        <button type="button" onClick={() => input.current?.click()} onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); add(e.dataTransfer.files); }}
          className="flex w-full flex-col items-center justify-center rounded-lg border-2 border-dashed border-slate-300 bg-slate-50 px-6 py-10 text-center hover:border-brand-400 hover:bg-brand-50/30">
          <Upload className="mb-2 size-6 text-slate-400" />
          <span className="text-[13.5px] text-slate-700"><span className="font-medium text-brand-700">Choose files</span> or drag them here</span>
          <span className="mt-1 text-[12px] text-slate-500">PDF, PNG, JPEG, WebP</span>
        </button>
        <input ref={input} type="file" multiple accept=".pdf,.png,.jpg,.jpeg,.webp" className="hidden" onChange={(e) => add(e.target.files)} />
        {files.length > 0 && (
          <ul className="max-h-60 divide-y divide-slate-100 overflow-y-auto rounded-lg border border-slate-200">
            {files.map((f) => (
              <li key={f.name} className="flex items-center gap-3 px-3 py-2 text-[13px]">
                <FileText className="size-4 text-slate-400" /><span className="flex-1 truncate">{f.name}</span><span className="text-[12px] text-slate-400">{(f.size / 1024).toFixed(0)} KB</span>
                {progress[f.name] === 'done' ? <CheckCircle2 className="size-4 text-emerald-500" /> : progress[f.name] === 'pending' ? <Spinner className="size-4" /> : progress[f.name] ? <span className="text-[12px] text-rose-600" title={progress[f.name]}>Failed</span>
                  : <IconButton label="Remove" onClick={() => setFiles(files.filter((x) => x !== f))}><Trash2 className="size-3.5" /></IconButton>}
              </li>
            ))}
          </ul>
        )}
      </div>
    </Modal>
  );
}

function ConfField({ label, field, data, set, warnings, type = 'text', mono, required }: { label: string; field: keyof CapData; data: CapData; set: (k: keyof CapData, v: unknown) => void; warnings: Warning[]; type?: string; mono?: boolean; required?: boolean }) {
  const c = data.confidence[field as string];
  const w = warnings.find((x) => x.field === field && x.severity !== 'info');
  const v = data[field] as string | number | null;
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between">
        <label className="text-[12.5px] font-medium text-slate-700">{label}{required && <span className="ml-0.5 text-rose-500">*</span>}</label>
        {c !== undefined && <Badge tone={confTone(c)}>{c === 1 ? 'Verified' : `${Math.round(c * 100)}%`}</Badge>}
      </div>
      <input aria-label={typeof label === 'string' ? label : undefined} className={clsx('input', mono && 'font-mono', w?.severity === 'critical' && 'input-error', c !== undefined && c < 0.75 && 'border-amber-400 bg-amber-50/40')} type={type} step="any"
        value={v ?? ''} onChange={(e) => set(field, type === 'number' ? (e.target.value === '' ? null : Number(e.target.value)) : e.target.value || null)} />
      {w && <p className={clsx('mt-1 text-[11.5px] font-medium', w.severity === 'critical' ? 'text-rose-600' : 'text-amber-700')}>{w.message}</p>}
    </div>
  );
}

export function CaptureReviewPage() {
  const { id = '' } = useParams();
  const { can } = useAuth();
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const suppliers = useParties('supplier,manufacturer,mill,transporter');
  const q = useQuery({ queryKey: ['capture', id], queryFn: () => api.get<Capture>(`/procurement/captures/${id}`), refetchInterval: (query) => (['queued', 'extracting'].includes(query.state.data?.status ?? '') ? 2000 : false) });
  const file = useQuery({ queryKey: ['capture-file', id], queryFn: () => api.blob(`/procurement/captures/${id}/file`).then((b) => URL.createObjectURL(b)), staleTime: Infinity });
  const [data, setData] = useState<CapData | null>(null);
  const [warnings, setWarnings] = useState<Warning[]>([]);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [reject, setReject] = useState(false);
  useEffect(() => { if (q.data?.data && !dirty) { setData(q.data.data); setWarnings(q.data.warnings); } }, [q.data, dirty]);
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  if (!q.data || !data) return <Skeleton className="h-[80vh]" />;
  const cap = q.data;
  const editable = ['needs_review', 'failed'].includes(cap.status) && can('procurement.invoice.capture');
  const set = (k: keyof CapData, v: unknown) => { setData({ ...data, [k]: v }); setDirty(true); };
  const setLine = (i: number, patch: Partial<CapLine>) => { setData({ ...data, lines: data.lines.map((l, j) => (j === i ? { ...l, ...patch } : l)) }); setDirty(true); };
  const body = () => ({ ...data, lines: data.lines.map(({ confidence: _c, ...l }) => l) });
  const save = async () => {
    setBusy('save');
    try { const r = await api.put<{ data: CapData; warnings: Warning[] }>(`/procurement/captures/${id}`, body()); setData(r.data); setWarnings(r.warnings); setDirty(false); q.refetch(); toast({ tone: 'success', title: 'Saved and re-checked' }); } catch (e) { toast({ tone: 'error', title: (e as Error).message }); } finally { setBusy(null); }
  };
  const approve = async () => {
    setBusy('approve');
    try {
      const r = await api.post<{ invoice_id: string }>(`/procurement/captures/${id}/approve`, body());
      invalidatePrefix(qc, '/procurement/captures', '/procurement/invoices');
      toast({ tone: 'success', title: 'Invoice created for matching', body: 'Posting to AP happens on the invoice after three-way match.' });
      nav(`/procurement/invoices/${r.invoice_id}`);
    } catch (e) { toast({ tone: 'error', title: (e as Error).message }); q.refetch(); } finally { setBusy(null); }
  };
  const lineTotal = data.lines.reduce((s, l) => s + (l.qty_kg ?? 0) * (l.rate ?? 0), 0);
  const blocking = warnings.filter((w) => w.severity === 'critical');

  return (
    <div className="flex h-[calc(100vh-7.5rem)] flex-col">
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-[12.5px] text-slate-500"><Link to="/procurement/invoice-workbench" className="hover:text-slate-800">Invoice workbench</Link> / {cap.batch_name}</p>
          <h1 className="flex items-center gap-2 truncate text-[19px] font-semibold">{cap.file_name} <StatusBadge status={cap.status} />{cap.extractor === 'claude' && <Badge tone="violet"><Sparkles className="size-3" />AI extracted{cap.extraction_ms ? ` in ${(cap.extraction_ms / 1000).toFixed(1)}s` : ''}</Badge>}{cap.extractor === 'manual' && <Badge><Cpu className="size-3" />Manual entry</Badge>}</h1>
        </div>
        {editable && <>
          {cap.status === 'failed' || cap.extractor === 'manual' ? <Button icon={<RefreshCw className="size-4" />} onClick={async () => { await api.post(`/procurement/captures/${id}/retry`); q.refetch(); }}>Re-extract</Button> : null}
          <Button variant="ghost" icon={<XCircle className="size-4" />} onClick={() => setReject(true)}>Reject</Button>
          <Button loading={busy === 'save'} disabled={!dirty} onClick={save}>Save & re-check</Button>
          <Button variant="primary" loading={busy === 'approve'} icon={<CheckCircle2 className="size-4" />} onClick={approve}>Approve for matching</Button>
        </>}
        {cap.invoice_id && <Link to={`/procurement/invoices/${cap.invoice_id}`}><Button variant="primary">Open invoice</Button></Link>}
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 xl:grid-cols-2">
        <div className="card flex min-h-[420px] items-center justify-center overflow-hidden bg-slate-100">
          {!file.data ? <Spinner /> : cap.mime_type === 'application/pdf' ? <iframe title="Invoice" src={file.data} className="h-full w-full" /> : <img src={file.data} alt="Invoice" className="max-h-full max-w-full object-contain" />}
        </div>
        <div className="card scrollbar-thin min-h-0 overflow-y-auto p-5">
          {['queued', 'extracting'].includes(cap.status) && <div className="mb-4"><Notice tone="info" icon={<Spinner className="size-4" />}>Reading the document…</Notice></div>}
          {cap.error && <div className="mb-4"><Notice tone="danger" title="Extraction failed">{cap.error}. You can enter the values manually or re-extract.</Notice></div>}
          {warnings.length > 0 && (
            <ul className="mb-5 space-y-1.5">
              {warnings.map((w, i) => (
                <li key={i} className={clsx('flex gap-2 rounded-md px-3 py-2 text-[12.5px]', w.severity === 'critical' ? 'bg-rose-50 text-rose-800' : w.severity === 'warning' ? 'bg-amber-50 text-amber-900' : 'bg-slate-50 text-slate-600')}>
                  {w.severity === 'info' ? <Info className="mt-0.5 size-3.5 shrink-0" /> : <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />}{w.message}
                </li>
              ))}
            </ul>
          )}
          <fieldset disabled={!editable} className="space-y-5">
            <div className="grid grid-cols-2 gap-4">
              <div className="col-span-2">
                <Select label="Supplier (matched by GSTIN)" required placeholder="Not matched — check the GSTIN" value={data.supplier_id ?? ''} onChange={(e) => { const s = suppliers.data?.find((x) => x.id === e.target.value); setData({ ...data, supplier_id: e.target.value || null, supplier_name: s?.legal_name ?? data.supplier_name, supplier_gstin: s?.gstin ?? data.supplier_gstin }); setDirty(true); }}
                  options={suppliers.data?.map((s) => ({ value: s.id, label: `${s.legal_name} (${s.code})` })) ?? []} hint={data.supplier_name ? `On document: ${data.supplier_name}` : undefined} />
              </div>
              <ConfField label="Supplier GSTIN" field="supplier_gstin" data={data} set={set} warnings={warnings} mono />
              <ConfField label="Billed to GSTIN" field="buyer_gstin" data={data} set={set} warnings={warnings} mono />
              <ConfField label="Invoice number" field="invoice_number" data={data} set={set} warnings={warnings} mono required />
              <ConfField label="Invoice date" field="invoice_date" data={data} set={set} warnings={warnings} type="date" required />
              <ConfField label="PO reference on invoice" field="po_reference" data={data} set={set} warnings={warnings} mono />
              <Select label="Match to PO" placeholder="No PO" value={data.po_id ?? ''} onChange={(e) => set('po_id', e.target.value || null)} options={cap.open_pos.map((p) => ({ value: p.id, label: `${p.number} · ${fmtINR(p.total_value)}` }))} />
            </div>
            <div>
              <div className="mb-2 flex items-center justify-between"><p className="text-[13px] font-semibold">Lines</p><Button size="xs" variant="ghost" icon={<Plus className="size-3" />} onClick={() => { setData({ ...data, lines: [...data.lines, { description: '', hsn_code: null, qty_kg: null, unit: 'KG', rate: null, gst_rate: null }] }); setDirty(true); }}>Add line</Button></div>
              <div className="overflow-x-auto rounded-lg border border-slate-200">
                <table className="w-full text-[12.5px]">
                  <thead className="bg-slate-50 text-[10.5px] tracking-wide text-slate-500 uppercase"><tr><th className="px-2 py-1.5 text-left">Description</th><th className="w-20 px-2 py-1.5">HSN</th><th className="w-24 px-2 py-1.5">Qty (kg)</th><th className="w-24 px-2 py-1.5">Rate</th><th className="w-16 px-2 py-1.5">GST %</th>{cap.po_lines.length > 0 && <th className="w-32 px-2 py-1.5">PO line</th>}<th className="w-8" /></tr></thead>
                  <tbody className="divide-y divide-slate-100">
                    {data.lines.map((l, i) => (
                      <tr key={i} className={clsx(l.confidence !== undefined && l.confidence < 0.75 && 'bg-amber-50/50')}>
                        <td className="px-1.5 py-1"><input aria-label={`Line ${i + 1} description`} className="input h-7 text-[12.5px]" value={l.description} onChange={(e) => setLine(i, { description: e.target.value })} />{l.unit && !/^kg/i.test(l.unit) && <span className="text-[11px] text-amber-700">Unit on invoice: {l.unit}</span>}</td>
                        <td className="px-1.5 py-1"><input aria-label={`Line ${i + 1} HSN`} className="input h-7 font-mono text-[12px]" value={l.hsn_code ?? ''} onChange={(e) => setLine(i, { hsn_code: e.target.value || null })} /></td>
                        <td className="px-1.5 py-1"><input className="input h-7 text-right tabular" type="number" aria-label={`Line ${i + 1} kg`} value={l.qty_kg ?? ''} onChange={(e) => setLine(i, { qty_kg: e.target.value === '' ? null : Number(e.target.value) })} /></td>
                        <td className="px-1.5 py-1"><input className="input h-7 text-right tabular" type="number" aria-label={`Line ${i + 1} rate`} value={l.rate ?? ''} onChange={(e) => setLine(i, { rate: e.target.value === '' ? null : Number(e.target.value) })} /></td>
                        <td className="px-1.5 py-1"><input className="input h-7 text-right tabular" type="number" aria-label={`Line ${i + 1} GST %`} value={l.gst_rate ?? ''} onChange={(e) => setLine(i, { gst_rate: e.target.value === '' ? null : Number(e.target.value) })} /></td>
                        {cap.po_lines.length > 0 && <td className="px-1.5 py-1"><select aria-label="PO line" className="input h-7 text-[12px]" value={l.po_line_id ?? ''} onChange={(e) => setLine(i, { po_line_id: e.target.value || null })}><option value="">Auto</option>{cap.po_lines.map((p) => <option key={p.id} value={p.id}>{p.sku} · ₹{p.rate_per_kg}</option>)}</select></td>}
                        <td><IconButton label="Remove" onClick={() => { setData({ ...data, lines: data.lines.filter((_, j) => j !== i) }); setDirty(true); }}><Trash2 className="size-3" /></IconButton></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="mt-1 text-right text-[12px] text-slate-500 tabular">Lines total {fmtINR(lineTotal)}</p>
            </div>
            <div className="grid grid-cols-5 gap-3">
              <ConfField label="Taxable" field="taxable_value" data={data} set={set} warnings={warnings} type="number" required />
              <ConfField label="CGST" field="cgst" data={data} set={set} warnings={warnings} type="number" />
              <ConfField label="SGST" field="sgst" data={data} set={set} warnings={warnings} type="number" />
              <ConfField label="IGST" field="igst" data={data} set={set} warnings={warnings} type="number" />
              <ConfField label="Total" field="total_value" data={data} set={set} warnings={warnings} type="number" required />
            </div>
          </fieldset>
          {editable && blocking.length > 0 && <div className="mt-5"><Notice tone="danger">{blocking.length} blocking issue{blocking.length > 1 ? 's' : ''} must be fixed before approval.</Notice></div>}
          {cap.reviewed_by_name && <p className="mt-5 text-[12px] text-slate-500">Reviewed by {cap.reviewed_by_name} · {fmtDateTime(cap.reviewed_at)}</p>}
          {cap.history.length > 0 && (
            <details className="mt-5 text-[12.5px]">
              <summary className="cursor-pointer font-medium text-slate-700">Correction history ({cap.history.length})</summary>
              <ul className="mt-2 space-y-1 text-slate-600">{cap.history.map((h, i) => <li key={i}>{h.by} changed <span className="font-medium">{humanize(h.field)}</span> from <span className="font-mono">{String(h.from ?? '—')}</span> to <span className="font-mono">{String(h.to ?? '—')}</span> · {fmtRelative(h.at)}</li>)}</ul>
            </details>
          )}
        </div>
      </div>
      <ConfirmDialog open={reject} onClose={() => setReject(false)} requireReason tone="danger" title="Reject this document?" description="For example: not a tax invoice, duplicate, or illegible." confirmLabel="Reject"
        onConfirm={async (r) => { await api.post(`/procurement/captures/${id}/reject`, { reason: r }); setReject(false); invalidatePrefix(qc, '/procurement/captures'); nav('/procurement/invoice-workbench'); }} />
    </div>
  );
}

