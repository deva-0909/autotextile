import express, { type Request, type Router } from 'express';
import { z } from 'zod';
import {
  type Client, type Pool, type ServiceContext, badRequest, callService, conflict, gstinProblem, listQuery, many, notFound, one, orderLimit, page, parse, reqText,
  requirePermission, tx,
} from '@erp/platform';
import { auditReq, findPartyByGstin, getGstRegs, round2 } from './common.ts';
import { aiEnabled, extractInvoice, ExtractionFailed, type Extraction } from './extractor.ts';
import { createInvoice } from './invoices.ts';
import { S } from './common.ts';

const MAX_ATTEMPTS = 3;

/** Editable invoice data shown on the review screen. */
export interface CaptureData {
  supplier_id: string | null; supplier_name: string | null; supplier_gstin: string | null; buyer_gstin: string | null;
  invoice_number: string | null; invoice_date: string | null; po_id: string | null; po_reference: string | null;
  taxable_value: number | null; cgst: number | null; sgst: number | null; igst: number | null; total_value: number | null;
  lines: { description: string; hsn_code: string | null; qty_kg: number | null; unit: string | null; rate: number | null; gst_rate: number | null; confidence?: number }[];
  confidence: Record<string, number>;
}
export interface Warning { field?: string; severity: 'info' | 'warning' | 'critical'; message: string }

const emptyData = (): CaptureData => ({
  supplier_id: null, supplier_name: null, supplier_gstin: null, buyer_gstin: null, invoice_number: null, invoice_date: null, po_id: null, po_reference: null,
  taxable_value: null, cgst: null, sgst: null, igst: null, total_value: null, lines: [], confidence: {},
});

function fromExtraction(x: Extraction): CaptureData {
  const conf: Record<string, number> = {};
  const pick = <T>(k: string, f: { value: T | null; confidence: number }) => { conf[k] = Math.max(0, Math.min(1, f.confidence)); return f.value; };
  return {
    supplier_id: null, po_id: null,
    supplier_name: pick('supplier_name', x.supplier_name),
    supplier_gstin: pick('supplier_gstin', x.supplier_gstin)?.toUpperCase().replace(/\s/g, '') ?? null,
    buyer_gstin: pick('buyer_gstin', x.buyer_gstin)?.toUpperCase().replace(/\s/g, '') ?? null,
    invoice_number: pick('invoice_number', x.invoice_number),
    invoice_date: pick('invoice_date', x.invoice_date),
    po_reference: pick('po_reference', x.po_reference),
    taxable_value: pick('taxable_value', x.taxable_value), cgst: pick('cgst', x.cgst), sgst: pick('sgst', x.sgst), igst: pick('igst', x.igst),
    total_value: pick('total_value', x.total_value),
    lines: x.lines.map((l) => ({ description: l.description, hsn_code: l.hsn_code, qty_kg: l.quantity, unit: l.unit, rate: l.rate, gst_rate: l.gst_rate, confidence: Math.max(0, Math.min(1, l.confidence)) })),
    confidence: conf,
  };
}

/** Cross-checks extracted data against masters, POs and arithmetic; links supplier and PO when unambiguous. */
export async function validate(c: Pool | Client, d: CaptureData, captureId: string): Promise<Warning[]> {
  const w: Warning[] = [];
  if (d.supplier_gstin) {
    const p = gstinProblem(d.supplier_gstin);
    if (p) w.push({ field: 'supplier_gstin', severity: 'critical', message: `Supplier GSTIN: ${p}` });
    else if (!d.supplier_id) {
      const party = await findPartyByGstin(d.supplier_gstin).catch(() => null);
      if (party) { d.supplier_id = party.id; d.supplier_name = party.legal_name; }
      else w.push({ field: 'supplier_gstin', severity: 'critical', message: 'No supplier with this GSTIN in master data. Onboard the supplier or correct the GSTIN.' });
    }
  } else w.push({ field: 'supplier_gstin', severity: 'warning', message: 'Supplier GSTIN not found on the document' });
  if (d.buyer_gstin) {
    const ours = (await getGstRegs().catch(() => [])).map((g) => g.gstin);
    if (!ours.includes(d.buyer_gstin)) w.push({ field: 'buyer_gstin', severity: 'critical', message: `Billed to ${d.buyer_gstin}, which is not one of our GST registrations` });
  }
  if (d.po_reference && !d.po_id) {
    const po = await one<{ id: string; supplier_id: string }>(c, `SELECT id, supplier_id FROM purchase_orders WHERE upper(number) = upper($1) OR upper(replace(number, '/', '')) = upper(replace($1, '/', ''))`, [d.po_reference.trim()]);
    if (!po) w.push({ field: 'po_reference', severity: 'warning', message: `PO ${d.po_reference} not found` });
    else if (d.supplier_id && po.supplier_id !== d.supplier_id) w.push({ field: 'po_reference', severity: 'critical', message: `PO ${d.po_reference} belongs to another supplier` });
    else d.po_id = po.id;
  }
  if (!d.po_id) w.push({ field: 'po_id', severity: 'warning', message: 'Link this invoice to a purchase order for three-way matching' });
  if (d.supplier_id && d.invoice_number) {
    const dup = await one<{ id: string }>(c, `SELECT id FROM supplier_invoices WHERE supplier_id = $1 AND upper(regexp_replace(invoice_number, '\\s', '', 'g')) = upper(regexp_replace($2, '\\s', '', 'g')) AND status <> 'rejected'`, [d.supplier_id, d.invoice_number]);
    if (dup) w.push({ field: 'invoice_number', severity: 'critical', message: 'Duplicate: this invoice number is already recorded for the supplier' });
    const other = await one<{ id: string }>(c, `SELECT id FROM invoice_captures WHERE id <> $1 AND status IN ('needs_review','approved') AND data->>'supplier_id' = $2 AND upper(data->>'invoice_number') = upper($3)`, [captureId, d.supplier_id, d.invoice_number]);
    if (other) w.push({ field: 'invoice_number', severity: 'critical', message: 'The same invoice was uploaded more than once in the workbench' });
  }
  if (d.invoice_date && !/^\d{4}-\d{2}-\d{2}$/.test(d.invoice_date)) w.push({ field: 'invoice_date', severity: 'critical', message: 'Invoice date must be YYYY-MM-DD' });
  if (d.invoice_date && new Date(d.invoice_date) > new Date()) w.push({ field: 'invoice_date', severity: 'warning', message: 'Invoice date is in the future' });
  const lineTotal = round2(d.lines.reduce((s, l) => s + (l.qty_kg ?? 0) * (l.rate ?? 0), 0));
  if (d.taxable_value != null && d.lines.length && Math.abs(lineTotal - d.taxable_value) > 1) w.push({ field: 'taxable_value', severity: 'warning', message: `Lines add up to ₹${lineTotal}, taxable value is ₹${d.taxable_value}` });
  const tax = (d.cgst ?? 0) + (d.sgst ?? 0) + (d.igst ?? 0);
  if (d.taxable_value != null && d.total_value != null && Math.abs(d.taxable_value + tax - d.total_value) > 1) w.push({ field: 'total_value', severity: 'warning', message: `Taxable + tax = ₹${round2(d.taxable_value + tax)}, total shows ₹${d.total_value}` });
  for (const [i, l] of d.lines.entries()) if (l.unit && !/^(kg|kgs|kilo)/i.test(l.unit)) w.push({ field: `lines.${i}`, severity: 'warning', message: `Line ${i + 1} is in ${l.unit}; convert the quantity to KG` });
  for (const [k, v] of Object.entries(d.confidence)) if (v < 0.8) w.push({ field: k, severity: 'info', message: `Low confidence (${Math.round(v * 100)}%) — check ${k.replace(/_/g, ' ')} against the document` });
  return w;
}

const overall = (d: CaptureData) => {
  const keys = ['supplier_gstin', 'invoice_number', 'invoice_date', 'taxable_value', 'total_value'];
  const v = keys.map((k) => d.confidence[k]).filter((x): x is number => x !== undefined);
  return v.length ? Math.min(...v) : null;
};

/** Background worker: claims queued captures and extracts them, a few at a time. */
export function startCaptureWorker(pool: Pool, opts: { concurrency?: number; intervalMs?: number } = {}) {
  const concurrency = opts.concurrency ?? Number(process.env.EXTRACTION_CONCURRENCY ?? 4);
  let active = 0;
  let stopped = false;

  async function processOne(cap: { id: string; document_id: string; mime_type: string; attempts: number }) {
    const started = Date.now();
    try {
      if (!aiEnabled()) {
        const data = emptyData();
        const warnings: Warning[] = [{ severity: 'info', message: 'AI extraction is not configured (ANTHROPIC_API_KEY). Enter the invoice details from the document.' }];
        await pool.query(`UPDATE invoice_captures SET status = 'needs_review', extractor = 'manual', data = $2, warnings = $3, updated_at = now() WHERE id = $1`, [cap.id, JSON.stringify(data), JSON.stringify(warnings)]);
        return;
      }
      const file = await callService<Buffer>(S, 'governance', 'GET', `/documents/${cap.document_id}/versions/1/content`);
      const extraction = await extractInvoice(file, cap.mime_type);
      const data = fromExtraction(extraction);
      const warnings = await validate(pool, data, cap.id);
      if (!extraction.is_tax_invoice) warnings.unshift({ severity: 'critical', message: `This does not look like a tax invoice${extraction.notes ? `: ${extraction.notes}` : ''}` });
      await pool.query(`UPDATE invoice_captures SET status = 'needs_review', extractor = 'claude', extraction = $2, data = $3, warnings = $4, confidence = $5, extraction_ms = $6, error = NULL, updated_at = now() WHERE id = $1`,
        [cap.id, JSON.stringify(extraction), JSON.stringify(data), JSON.stringify(warnings), overall(data), Date.now() - started]);
    } catch (err) {
      const retry = err instanceof ExtractionFailed ? err.retryable : true;
      const failed = !retry || cap.attempts >= MAX_ATTEMPTS;
      await pool.query(`UPDATE invoice_captures SET status = $2, error = $3, data = COALESCE(data, $4), updated_at = now() WHERE id = $1`,
        [cap.id, failed ? 'failed' : 'queued', (err as Error).message, JSON.stringify(emptyData())]);
    }
  }

  async function tick() {
    if (stopped || active >= concurrency) return;
    const { rows } = await pool.query(`
      UPDATE invoice_captures SET status = 'extracting', attempts = attempts + 1, updated_at = now()
      WHERE id IN (SELECT id FROM invoice_captures WHERE status = 'queued' AND (attempts = 0 OR updated_at < now() - interval '20 seconds' * attempts)
                   ORDER BY created_at LIMIT $1 FOR UPDATE SKIP LOCKED)
      RETURNING id, document_id, mime_type, attempts`, [concurrency - active]);
    for (const cap of rows) {
      active++;
      void processOne(cap).finally(() => { active--; });
    }
  }
  // Recover captures interrupted by a restart.
  void pool.query(`UPDATE invoice_captures SET status = 'queued' WHERE status = 'extracting' AND updated_at < now() - interval '5 minutes'`).catch(() => {});
  const timer = setInterval(() => void tick().catch((e) => console.error('[capture-worker]', e.message)), opts.intervalMs ?? 1500);
  timer.unref();
  return { stop: () => { stopped = true; clearInterval(timer); }, tick };
}

export function captureRoutes(r: Router, { pool }: ServiceContext) {
  r.get('/captures/stats', requirePermission('procurement.invoice.read'), async (_req, res) => {
    const byStatus = await many<{ status: string; n: number }>(pool, 'SELECT status, count(*)::int AS n FROM invoice_captures GROUP BY status');
    const perf = await one<Record<string, unknown>>(pool, `SELECT count(*)::int AS extracted_last_hour, round(avg(extraction_ms))::int AS avg_ms FROM invoice_captures WHERE extraction_ms IS NOT NULL AND updated_at > now() - interval '1 hour'`);
    res.json({ ai_enabled: aiEnabled(), by_status: Object.fromEntries(byStatus.map((s) => [s.status, s.n])), ...perf, concurrency: Number(process.env.EXTRACTION_CONCURRENCY ?? 4) });
  });

  r.get('/captures/batches', requirePermission('procurement.invoice.read'), async (_req, res) => {
    res.json(await many(pool, `
      SELECT b.*, count(c.id)::int AS files,
        count(c.id) FILTER (WHERE c.status IN ('queued','extracting'))::int AS pending,
        count(c.id) FILTER (WHERE c.status = 'needs_review')::int AS to_review,
        count(c.id) FILTER (WHERE c.status = 'approved')::int AS approved,
        count(c.id) FILTER (WHERE c.status IN ('failed','rejected'))::int AS failed
      FROM capture_batches b LEFT JOIN invoice_captures c ON c.batch_id = b.id GROUP BY b.id ORDER BY b.created_at DESC LIMIT 100`));
  });

  r.post('/captures/batches', requirePermission('procurement.invoice.capture'), async (req, res) => {
    const { name } = parse(z.object({ name: reqText(120) }), req.body);
    res.status(201).json(await one(pool, 'INSERT INTO capture_batches (name, created_by, created_by_name) VALUES ($1, $2, $3) RETURNING *', [name, req.user!.id, req.user!.name]));
  });

  r.post('/captures/batches/:id/files', requirePermission('procurement.invoice.capture'), express.raw({ type: () => true, limit: 20 * 1024 * 1024 }), async (req, res) => {
    const batch = await one<{ id: string; name: string }>(pool, 'SELECT * FROM capture_batches WHERE id = $1', [req.params.id]);
    if (!batch) throw notFound('Batch');
    const fileName = decodeURIComponent(String(req.headers['x-file-name'] ?? 'invoice')).slice(0, 200);
    const mime = String(req.headers['content-type'] ?? '').split(';')[0]!;
    if (!['application/pdf', 'image/png', 'image/jpeg', 'image/webp'].includes(mime)) throw badRequest('Upload PDF, PNG, JPEG or WebP invoices');
    // Stored in the governance document service, linked to the batch.
    const q = new URLSearchParams({ title: fileName.replace(/\.[^.]+$/, ''), document_type: 'SUPPLIER_INVOICE', entity_type: 'invoice_capture_batch', entity_id: batch.id });
    const doc = await callService<{ id: string }>(S, 'governance', 'POST', `/documents?${q}`, req.body as Buffer, { 'content-type': mime, 'x-file-name': encodeURIComponent(fileName) });
    const cap = await one(pool, `INSERT INTO invoice_captures (batch_id, document_id, file_name, mime_type) VALUES ($1, $2, $3, $4) RETURNING id, status`, [batch.id, doc.id, fileName, mime]);
    res.status(201).json(cap);
  });

  /** Queue a document that is already stored in governance (e.g. a mill's job-work invoice) for capture and review. */
  r.post('/captures/inbound', requirePermission('procurement.invoice.capture'), async (req, res) => {
    const body = parse(z.object({ batch_name: reqText(120), document_id: z.uuid(), file_name: reqText(200), mime_type: z.enum(['application/pdf', 'image/png', 'image/jpeg', 'image/webp']), po_reference: z.string().nullable().optional() }), req.body);
    const out = await tx(pool, async (c) => {
      const batch = await one<{ id: string }>(c, 'SELECT id FROM capture_batches WHERE name = $1', [body.batch_name])
        ?? await one<{ id: string }>(c, `INSERT INTO capture_batches (name, created_by_name) VALUES ($1, 'Partner portal') RETURNING id`, [body.batch_name]);
      return one(c, `INSERT INTO invoice_captures (batch_id, document_id, file_name, mime_type, data) VALUES ($1, $2, $3, $4, $5) RETURNING id, status`,
        [batch!.id, body.document_id, body.file_name, body.mime_type, JSON.stringify({ po_reference: body.po_reference ?? null })]);
    });
    res.status(201).json(out);
  });

  r.get('/captures', requirePermission('procurement.invoice.read'), async (req, res) => {
    const lq = listQuery(req, ['created_at', 'status', 'confidence'], 'created_at');
    const params: unknown[] = [];
    const where: string[] = [];
    if (lq.filters.status) { params.push(lq.filters.status.split(',')); where.push(`c.status = ANY($${params.length})`); }
    if (lq.filters.batch) { params.push(lq.filters.batch); where.push(`c.batch_id = $${params.length}`); }
    if (lq.q) { params.push(`%${lq.q}%`); where.push(`(c.file_name ILIKE $${params.length} OR c.data->>'invoice_number' ILIKE $${params.length} OR c.data->>'supplier_name' ILIKE $${params.length})`); }
    const rows = await many<{ total_count: number }>(pool, `
      SELECT c.id, c.batch_id, b.name AS batch_name, c.file_name, c.status, c.extractor, c.confidence, c.error, c.extraction_ms, c.invoice_id, c.created_at, c.reviewed_by_name,
        c.data->>'supplier_name' AS supplier_name, c.data->>'invoice_number' AS invoice_number, (c.data->>'total_value')::numeric AS total_value,
        jsonb_array_length(c.warnings) AS warning_count,
        (SELECT count(*) FROM jsonb_array_elements(c.warnings) w WHERE w->>'severity' = 'critical')::int AS critical_count,
        count(*) OVER ()::int AS total_count
      FROM invoice_captures c JOIN capture_batches b ON b.id = c.batch_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ${orderLimit({ ...lq, dir: req.query.dir ? lq.dir : 'desc' }, params).replace('ORDER BY ', 'ORDER BY c.')}`, params);
    res.json(page(rows, lq));
  });

  r.get('/captures/:id', requirePermission('procurement.invoice.read'), async (req, res) => {
    const cap = await one<Record<string, unknown> & { data: CaptureData | null }>(pool, `SELECT c.*, b.name AS batch_name FROM invoice_captures c JOIN capture_batches b ON b.id = c.batch_id WHERE c.id = $1`, [req.params.id]);
    if (!cap) throw notFound('Invoice capture');
    const supplierId = cap.data?.supplier_id;
    const pos = supplierId ? await many<Record<string, unknown>>(pool, `SELECT id, number, total_value, status, order_date FROM purchase_orders WHERE supplier_id = $1 AND status IN ('sent','accepted','partially_received','received') ORDER BY order_date DESC`, [supplierId]) : [];
    const poLines = cap.data?.po_id ? await many(pool, 'SELECT id, line_no, sku, product_name, qty_kg, rate_per_kg, gst_rate, received_kg, invoiced_kg FROM po_lines WHERE po_id = $1 ORDER BY line_no', [cap.data.po_id]) : [];
    res.json({ ...cap, open_pos: pos, po_lines: poLines });
  });

  r.get('/captures/:id/file', requirePermission('procurement.invoice.read'), async (req, res) => {
    const cap = await one<{ document_id: string; mime_type: string }>(pool, 'SELECT document_id, mime_type FROM invoice_captures WHERE id = $1', [req.params.id]);
    if (!cap) throw notFound('Invoice capture');
    const file = await callService<Buffer>(S, 'governance', 'GET', `/documents/${cap.document_id}/versions/1/content`);
    res.setHeader('Content-Type', cap.mime_type);
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(file);
  });

  const dataBody = z.object({
    supplier_id: z.uuid().nullable(), supplier_name: z.string().nullable(), supplier_gstin: z.string().nullable(), buyer_gstin: z.string().nullable(),
    invoice_number: z.string().nullable(), invoice_date: z.string().nullable(), po_id: z.uuid().nullable(), po_reference: z.string().nullable(),
    taxable_value: z.number().nullable(), cgst: z.number().nullable(), sgst: z.number().nullable(), igst: z.number().nullable(), total_value: z.number().nullable(),
    lines: z.array(z.object({ description: z.string(), hsn_code: z.string().nullable(), qty_kg: z.number().nullable(), unit: z.string().nullable(), rate: z.number().nullable(), gst_rate: z.number().nullable(), po_line_id: z.uuid().nullable().optional() })),
  });

  /** Saves reviewer corrections with a field-level history, then re-validates. */
  async function saveData(c: Client, req: Request, id: string, next: z.infer<typeof dataBody>) {
    const cap = await one<{ status: string; data: CaptureData; history: unknown[] }>(c, 'SELECT status, data, history FROM invoice_captures WHERE id = $1 FOR UPDATE', [id]);
    if (!cap) throw notFound('Invoice capture');
    if (!['needs_review', 'failed'].includes(cap.status)) throw conflict(`This capture is ${cap.status}`);
    const prev = cap.data ?? emptyData();
    const changes = Object.keys(next).filter((k) => k !== 'lines' && JSON.stringify((prev as unknown as Record<string, unknown>)[k] ?? null) !== JSON.stringify((next as Record<string, unknown>)[k] ?? null))
      .map((k) => ({ at: new Date().toISOString(), by: req.user!.name, field: k, from: (prev as unknown as Record<string, unknown>)[k] ?? null, to: (next as Record<string, unknown>)[k] ?? null }));
    if (JSON.stringify(prev.lines) !== JSON.stringify(next.lines)) changes.push({ at: new Date().toISOString(), by: req.user!.name, field: 'lines', from: `${prev.lines.length} lines`, to: `${next.lines.length} lines` });
    const data: CaptureData = { ...next, confidence: prev.confidence } as CaptureData;
    // A corrected field is now human-verified.
    for (const ch of changes) if (ch.field in data.confidence) data.confidence[ch.field] = 1;
    const warnings = await validate(c, data, id);
    await c.query(`UPDATE invoice_captures SET data = $2, warnings = $3, history = history || $4::jsonb, status = 'needs_review', updated_at = now() WHERE id = $1`,
      [id, JSON.stringify(data), JSON.stringify(warnings), JSON.stringify(changes)]);
    return { data, warnings, changes: changes.length };
  }

  r.put('/captures/:id', requirePermission('procurement.invoice.capture'), async (req, res) => {
    const body = parse(dataBody, req.body);
    res.json(await tx(pool, (c) => saveData(c, req, String(req.params.id), body)));
  });

  /** Human approval of the extracted data: creates a draft supplier invoice (never posted automatically). */
  r.post('/captures/:id/approve', requirePermission('procurement.invoice.capture'), async (req, res) => {
    const body = parse(dataBody, req.body);
    const out = await tx(pool, async (c) => {
      const { data, warnings } = await saveData(c, req, String(req.params.id), body);
      const blocking = warnings.filter((w) => w.severity === 'critical');
      if (blocking.length) throw badRequest(`Resolve before approving: ${blocking.map((w) => w.message).join(' · ')}`);
      const missing = (['supplier_id', 'invoice_number', 'invoice_date', 'taxable_value', 'total_value'] as const).filter((k) => data[k] == null || data[k] === '');
      if (missing.length) throw badRequest('Complete the required fields', { fields: Object.fromEntries(missing.map((k) => [k, 'Required'])) });
      if (!data.lines.length || data.lines.some((l) => l.qty_kg == null || l.rate == null)) throw badRequest('Every line needs a quantity and rate');
      const cap = await one<{ document_id: string }>(c, 'SELECT document_id FROM invoice_captures WHERE id = $1', [req.params.id]);
      const inv = await createInvoice(c, req, {
        supplier_id: data.supplier_id!, invoice_number: data.invoice_number!, invoice_date: data.invoice_date!, po_id: data.po_id, document_id: cap!.document_id,
        taxable_value: data.taxable_value!, cgst: data.cgst ?? 0, sgst: data.sgst ?? 0, igst: data.igst ?? 0, total_value: data.total_value!,
        lines: body.lines.map((l) => ({ po_line_id: l.po_line_id ?? null, description: l.description, hsn_code: l.hsn_code, qty_kg: l.qty_kg!, rate: l.rate!, gst_rate: l.gst_rate ?? 0 })),
      }, { captureId: String(req.params.id) });
      await c.query(`UPDATE invoice_captures SET status = 'approved', invoice_id = $2, reviewed_by = $3, reviewed_by_name = $4, reviewed_at = now(), updated_at = now() WHERE id = $1`, [req.params.id, inv.id, req.user!.id, req.user!.name]);
      await auditReq(c, req, 'invoice_capture', String(req.params.id), 'approved', { after: { invoice_id: inv.id, invoice_number: data.invoice_number } });
      return { invoice_id: inv.id };
    });
    res.json(out);
  });

  r.post('/captures/:id/reject', requirePermission('procurement.invoice.capture'), async (req, res) => {
    const { reason } = parse(z.object({ reason: reqText(300) }), req.body);
    await tx(pool, async (c) => {
      const r1 = await c.query(`UPDATE invoice_captures SET status = 'rejected', error = $2, reviewed_by = $3, reviewed_by_name = $4, reviewed_at = now(), updated_at = now() WHERE id = $1 AND status IN ('needs_review','failed')`, [req.params.id, reason, req.user!.id, req.user!.name]);
      if (!r1.rowCount) throw conflict('Only captures awaiting review can be rejected');
      await auditReq(c, req, 'invoice_capture', String(req.params.id), 'rejected', { reason });
    });
    res.json({ ok: true });
  });

  r.post('/captures/:id/retry', requirePermission('procurement.invoice.capture'), async (req, res) => {
    const r1 = await pool.query(`UPDATE invoice_captures SET status = 'queued', attempts = 0, error = NULL, updated_at = now() WHERE id = $1 AND status IN ('failed','needs_review')`, [req.params.id]);
    if (!r1.rowCount) throw conflict('Only failed or unreviewed captures can be re-extracted');
    res.json({ ok: true });
  });
}
