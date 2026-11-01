import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, Eye, FileText, History, Image as ImageIcon, Paperclip, Upload } from 'lucide-react';
import { useRef, useState } from 'react';
import { api, type Page } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fmtBytes, fmtDate, fmtDateTime, fmtRelative } from '../lib/format';
import { ConfirmDialog, Drawer, Modal, useToast } from './overlay';
import { Badge, Button, EmptyState, Input, Notice, Select, Spinner } from './ui';

export interface Doc { id: string; title: string; document_type: string; entity_type: string; entity_id: string; current_version: number; file_name: string; mime_type: string; size_bytes: number; uploaded_by_name: string; uploaded_at: string; expires_on: string | null; status: string }
interface Version { id: string; version: number; file_name: string; mime_type: string; size_bytes: number; sha256: string; note: string | null; uploaded_by_name: string; uploaded_at: string }
interface DocType { code: string; name: string; applies_to: string[]; requires_expiry: boolean; status: string }

export const ACCEPT = '.pdf,.png,.jpg,.jpeg,.webp,.csv,.xlsx,.docx';
const MIME_FALLBACK: Record<string, string> = { csv: 'text/csv', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };
const mimeOf = (f: File) => f.type || MIME_FALLBACK[f.name.split('.').pop()?.toLowerCase() ?? ''] || 'application/octet-stream';

export async function openDocument(id: string, version: number, download = false) {
  const blob = await api.blob(`/governance/documents/${id}/versions/${version}/content${download ? '?download=1' : ''}`);
  const url = URL.createObjectURL(blob);
  if (download) {
    const a = document.createElement('a');
    a.href = url;
    a.download = '';
    a.click();
  }
  return url;
}

export function Preview({ doc, version, onClose }: { doc: { id: string; title: string; mime_type: string }; version: number; onClose: () => void }) {
  const q = useQuery({ queryKey: ['doc-blob', doc.id, version], queryFn: () => openDocument(doc.id, version), staleTime: Infinity });
  const isImg = doc.mime_type.startsWith('image/');
  const isPdf = doc.mime_type === 'application/pdf';
  return (
    <Modal open onClose={onClose} title={doc.title} size="lg" footer={<Button onClick={onClose}>Close</Button>}>
      <div className="flex min-h-[300px] items-center justify-center rounded-lg bg-slate-100">
        {!q.data ? <Spinner /> : isImg ? <img src={q.data} alt={doc.title} className="max-h-[60vh] rounded" /> : isPdf ? <iframe src={q.data} title={doc.title} className="h-[60vh] w-full rounded" /> : (
          <div className="p-8 text-center text-[13px] text-slate-600">Preview isn’t available for this file type. <button className="link" onClick={() => openDocument(doc.id, version, true)}>Download it</button>.</div>
        )}
      </div>
    </Modal>
  );
}

export function UploadDialog({ entityType, entityId, onClose, docId }: { entityType: string; entityId: string; onClose: () => void; docId?: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const types = useQuery({ queryKey: ['document-types'], queryFn: () => api.get<DocType[]>('/masters/document-types'), enabled: !docId });
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState('');
  const [type, setType] = useState('');
  const [expires, setExpires] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const applicable = types.data?.filter((t) => t.status === 'active' && (t.applies_to.includes(entityType) || !t.applies_to.length)) ?? [];
  const needsExpiry = types.data?.find((t) => t.code === type)?.requires_expiry;

  async function upload() {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const headers = { 'Content-Type': mimeOf(file), 'X-File-Name': encodeURIComponent(file.name) };
      const body = await file.arrayBuffer();
      if (docId) await api.post(`/governance/documents/${docId}/versions?note=${encodeURIComponent(note)}`, body, headers);
      else await api.post(`/governance/documents?${new URLSearchParams({ title: title || file.name, document_type: type, entity_type: entityType, entity_id: entityId, expires_on: expires, note })}`, body, headers);
      qc.invalidateQueries({ queryKey: ['documents'] });
      qc.invalidateQueries({ queryKey: ['document'] });
      toast({ tone: 'success', title: docId ? 'New version uploaded' : 'Document uploaded' });
      onClose();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }

  return (
    <Modal open onClose={onClose} title={docId ? 'Upload new version' : 'Upload document'} description="PDF, images, CSV, XLSX or DOCX up to 20 MB. Stored privately; every upload is audited."
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} disabled={!file || (!docId && !type) || (needsExpiry && !expires)} onClick={upload}>Upload</Button></>}>
      <div className="space-y-4">
        {error && <Notice tone="danger">{error}</Notice>}
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) { setFile(f); if (!title) setTitle(f.name.replace(/\.[^.]+$/, '')); } }}
          className="flex w-full flex-col items-center justify-center rounded-lg border-2 border-dashed border-slate-300 bg-slate-50 px-6 py-8 text-center hover:border-brand-400 hover:bg-brand-50/30"
        >
          <Upload className="mb-2 size-5 text-slate-400" />
          {file ? <span className="text-[13.5px] font-medium text-slate-900">{file.name} <span className="font-normal text-slate-500">· {fmtBytes(file.size)}</span></span>
            : <span className="text-[13px] text-slate-600"><span className="font-medium text-brand-700">Choose a file</span> or drag it here</span>}
        </button>
        <input ref={inputRef} type="file" accept={ACCEPT} className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) { setFile(f); if (!title) setTitle(f.name.replace(/\.[^.]+$/, '')); } }} />
        {!docId && (
          <>
            <Select label="Document type" required placeholder="Select type" value={type} onChange={(e) => setType(e.target.value)} options={applicable.map((t) => ({ value: t.code, label: t.name }))} />
            <Input label="Title" value={title} onChange={(e) => setTitle(e.target.value)} />
            <Input label="Expires on" type="date" required={needsExpiry} value={expires} onChange={(e) => setExpires(e.target.value)} hint={needsExpiry ? 'Required for this document type' : 'Optional — used for renewal reminders'} />
          </>
        )}
        <Input label="Note" value={note} onChange={(e) => setNote(e.target.value)} />
      </div>
    </Modal>
  );
}

export function VersionsDrawer({ docId, onClose }: { docId: string; onClose: () => void }) {
  const q = useQuery({ queryKey: ['document', docId], queryFn: () => api.get<Doc & { versions: Version[] }>(`/governance/documents/${docId}`) });
  const { can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const [upload, setUpload] = useState(false);
  const [archive, setArchive] = useState(false);
  const [preview, setPreview] = useState<Version | null>(null);
  // Archiving needs the archive right; HR archives the personnel files it keeps.
  const mayArchive = q.data?.status === 'active' && (can('governance.document.delete') || (q.data.entity_type === 'employee' && can('hrms.employee.manage')));
  return (
    <Drawer open onClose={onClose} title={q.data?.title ?? 'Document'} description={q.data?.status === 'archived' ? 'Archived — kept for the record, no longer listed as current' : 'Version history — every version is kept'}
      footer={(mayArchive || (can('governance.document.upload') && q.data?.status === 'active')) && <div className="flex gap-2">{mayArchive && <Button variant="danger" onClick={() => setArchive(true)}>Archive</Button>}{can('governance.document.upload') && q.data?.status === 'active' && <Button variant="primary" icon={<Upload className="size-4" />} onClick={() => setUpload(true)}>Upload new version</Button>}</div>}>
      <ol className="space-y-3">
        {q.data?.versions.map((v) => (
          <li key={v.id} className="rounded-lg border border-slate-200 p-3.5">
            <div className="flex items-center justify-between">
              <p className="text-[13.5px] font-medium text-slate-900">Version {v.version} {v.version === q.data!.current_version && <Badge tone="brand">Current</Badge>}</p>
              <div className="flex gap-1">
                <Button size="xs" variant="ghost" icon={<Eye className="size-3" />} onClick={() => setPreview(v)}>View</Button>
                <Button size="xs" variant="ghost" icon={<Download className="size-3" />} onClick={() => openDocument(docId, v.version, true)}>Download</Button>
              </div>
            </div>
            <p className="mt-1 text-[12.5px] text-slate-600">{v.file_name} · {fmtBytes(v.size_bytes)}</p>
            <p className="text-[12px] text-slate-500">{v.uploaded_by_name} · {fmtDateTime(v.uploaded_at)}</p>
            {v.note && <p className="mt-1 text-[12.5px] text-slate-700">“{v.note}”</p>}
            <p className="mt-1 truncate font-mono text-[10.5px] text-slate-400" title="SHA-256 fingerprint">sha256 {v.sha256}</p>
          </li>
        ))}
      </ol>
      {upload && q.data && <UploadDialog entityType={q.data.entity_type} entityId={q.data.entity_id} docId={docId} onClose={() => setUpload(false)} />}
      <ConfirmDialog open={archive} onClose={() => setArchive(false)} title={`Archive ${q.data?.title ?? 'this document'}?`} description="It leaves the current list but is kept with all its versions; find it under Archived on the Documents page." requireReason tone="danger" confirmLabel="Archive"
        onConfirm={async (reason) => { try { await api.post(`/governance/documents/${docId}/archive`, { reason }); setArchive(false); void qc.invalidateQueries({ queryKey: ['documents'] }); void qc.invalidateQueries({ queryKey: ['document', docId] }); toast({ tone: 'success', title: 'Document archived' }); onClose(); } catch (e) { toast({ tone: 'error', title: 'Not archived', body: (e as Error).message }); } }} />
      {preview && q.data && <Preview doc={{ id: docId, title: `${q.data.title} · v${preview.version}`, mime_type: preview.mime_type }} version={preview.version} onClose={() => setPreview(null)} />}
    </Drawer>
  );
}

/** Document panel for any record (party, product, warehouse…). */
export function DocumentsPanel({ entityType, entityId }: { entityType: string; entityId: string }) {
  const { can } = useAuth();
  const q = useQuery({ queryKey: ['documents', entityType, entityId], queryFn: () => api.get<Page<Doc>>(`/governance/documents?f_entityType=${entityType}&f_entityId=${entityId}&pageSize=100`), enabled: can('governance.document.read') });
  const [upload, setUpload] = useState(false);
  const [versions, setVersions] = useState<string | null>(null);
  const [preview, setPreview] = useState<Doc | null>(null);
  if (!can('governance.document.read')) return <Notice tone="info">You don’t have access to documents.</Notice>;
  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <p className="text-[13px] text-slate-500">{q.data?.total ?? 0} documents</p>
        {can('governance.document.upload') && <Button size="sm" variant="primary" icon={<Paperclip className="size-3.5" />} onClick={() => setUpload(true)}>Upload</Button>}
      </div>
      {q.data?.items.length === 0 && <EmptyState icon={<FileText className="size-5" />} title="No documents yet" description="Upload GST certificates, agreements, cancelled cheques and other records." />}
      <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200">
        {q.data?.items.map((d) => {
          const expired = d.expires_on && new Date(d.expires_on) < new Date();
          return (
            <li key={d.id} className="flex items-center gap-3 px-4 py-3">
              <span className="flex size-9 items-center justify-center rounded-md bg-slate-100 text-slate-500">{d.mime_type.startsWith('image/') ? <ImageIcon className="size-4" /> : <FileText className="size-4" />}</span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13.5px] font-medium text-slate-900">{d.title} <span className="font-normal text-slate-400">v{d.current_version}</span></p>
                <p className="truncate text-[12px] text-slate-500">{d.document_type.replace(/_/g, ' ').toLowerCase()} · {d.file_name} · {fmtBytes(d.size_bytes)} · {d.uploaded_by_name} {fmtRelative(d.uploaded_at)}</p>
              </div>
              {d.expires_on && <Badge tone={expired ? 'danger' : 'neutral'}>{expired ? 'Expired' : 'Expires'} {fmtDate(d.expires_on)}</Badge>}
              <Button size="xs" variant="ghost" icon={<Eye className="size-3" />} onClick={() => setPreview(d)}>View</Button>
              <Button size="xs" variant="ghost" icon={<History className="size-3" />} onClick={() => setVersions(d.id)}>Versions</Button>
            </li>
          );
        })}
      </ul>
      {upload && <UploadDialog entityType={entityType} entityId={entityId} onClose={() => setUpload(false)} />}
      {versions && <VersionsDrawer docId={versions} onClose={() => setVersions(null)} />}
      {preview && <Preview doc={preview} version={preview.current_version} onClose={() => setPreview(null)} />}
    </div>
  );
}
