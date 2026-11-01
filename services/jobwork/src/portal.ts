import express, { type Request, type Router } from 'express';
import { z } from 'zod';
import { type ServiceContext, badRequest, callService, conflict, forbidden, many, notFound, notify, one, optText, parse, reqText, requirePermission, tx } from '@erp/platform';
import { S, auditReq } from './common.ts';
import { acknowledge, markReady, orderDetail, stageBody, stageUpdate } from './orders.ts';

const millOf = (req: Request) => {
  if (!req.user!.partyId) throw forbidden('Your account is not linked to a mill');
  return req.user!.partyId;
};

/** Mill portal: the mill's confirmations here are the authoritative operational record. */
export function portalRoutes(r: Router, { pool }: ServiceContext) {
  r.get('/portal/mill/summary', requirePermission('portal.mill.access'), async (req, res) => {
    res.json(await one(pool, `SELECT
      (SELECT count(*)::int FROM job_orders WHERE mill_id = $1 AND status = 'issued') AS awaiting_ack,
      (SELECT count(*)::int FROM job_orders WHERE mill_id = $1 AND status IN ('acknowledged','in_process')) AS in_process,
      (SELECT count(*)::int FROM job_orders WHERE mill_id = $1 AND status = 'ready') AS ready,
      (SELECT round(coalesce(sum(kg_sent - kg_good - kg_rejected - kg_damaged - kg_process_loss - kg_quarantine), 0), 1) FROM job_orders WHERE mill_id = $1 AND status IN ('issued','acknowledged','in_process','ready','partially_returned')) AS kg_with_you,
      (SELECT count(*)::int FROM quality_claims WHERE mill_id = $1 AND status IN ('open','under_review')) AS open_claims`, [millOf(req)]));
  });

  r.get('/portal/mill/jobs', requirePermission('portal.mill.access'), async (req, res) => {
    res.json(await many(pool, `SELECT id, number, process_name, status, issue_date, expected_return_date, kg_sent, ack_kg, current_stage, ready_at,
        round(kg_sent - kg_good - kg_rejected - kg_damaged - kg_process_loss - kg_quarantine, 3) AS kg_balance
      FROM job_orders WHERE mill_id = $1 AND status NOT IN ('draft','cancelled') ORDER BY CASE status WHEN 'issued' THEN 0 WHEN 'acknowledged' THEN 1 WHEN 'in_process' THEN 2 ELSE 3 END, issue_date DESC`, [millOf(req)]));
  });

  r.get('/portal/mill/jobs/:id', requirePermission('portal.mill.access'), async (req, res) => {
    const o = await orderDetail(pool, String(req.params.id));
    if (o.mill_id !== millOf(req) || ['draft', 'cancelled'].includes(o.status)) throw notFound('Job-work order');
    // Internal costing and exceptions stay internal.
    const { estimated_charge: _e, rate_summary: _r, processing_charge: _p, exceptions: _x, created_by: _c, ...shared } = o as Record<string, unknown>;
    res.json(shared);
  });

  r.post('/portal/mill/jobs/:id/acknowledge', requirePermission('portal.mill.access'), async (req, res) => {
    const b = parse(z.object({ kg_received: z.number().min(0), remarks: optText(500) }), req.body);
    await tx(pool, (c) => acknowledge(c, req, String(req.params.id), b, 'mill_portal'));
    res.json({ ok: true });
  });

  r.post('/portal/mill/jobs/:id/stages', requirePermission('portal.mill.access'), async (req, res) => {
    const b = parse(stageBody, req.body);
    await tx(pool, (c) => stageUpdate(c, req, String(req.params.id), b, 'mill_portal'));
    res.json({ ok: true });
  });

  r.post('/portal/mill/jobs/:id/ready', requirePermission('portal.mill.access'), async (req, res) => {
    const { note } = parse(z.object({ note: optText(500) }), req.body);
    await tx(pool, (c) => markReady(c, req, String(req.params.id), note ?? null, 'mill_portal'));
    res.json({ ok: true });
  });

  /** The mill's job-work invoice goes into procurement's capture queue for human review and matching. */
  r.post('/portal/mill/jobs/:id/invoice', requirePermission('portal.mill.access'), express.raw({ type: () => true, limit: 20 * 1024 * 1024 }), async (req, res) => {
    const o = await one<{ id: string; number: string; mill_id: string; mill_name: string; status: string }>(pool, 'SELECT * FROM job_orders WHERE id = $1', [req.params.id]);
    if (!o || o.mill_id !== millOf(req)) throw notFound('Job-work order');
    if (!['ready', 'partially_returned', 'returned', 'closed'].includes(o.status)) throw conflict('Invoice after the fabric is ready for collection');
    const mime = String(req.headers['content-type'] ?? '').split(';')[0]!;
    if (!['application/pdf', 'image/png', 'image/jpeg', 'image/webp'].includes(mime)) throw badRequest('Upload the invoice as PDF, PNG, JPEG or WebP');
    const fileName = decodeURIComponent(String(req.headers['x-file-name'] ?? 'invoice')).slice(0, 200);
    const q = new URLSearchParams({ title: `${o.number} job-work invoice`, document_type: 'SUPPLIER_INVOICE', entity_type: 'job_work_order', entity_id: o.id });
    const doc = await callService<{ id: string }>(S, 'governance', 'POST', `/documents?${q}`, req.body as Buffer, { 'content-type': mime, 'x-file-name': encodeURIComponent(fileName) });
    const cap = await callService<{ id: string }>(S, 'procurement', 'POST', '/captures/inbound', { batch_name: `Mill portal · ${o.mill_name}`, document_id: doc.id, file_name: fileName, mime_type: mime, po_reference: null });
    await tx(pool, async (c) => {
      await c.query(`INSERT INTO stage_updates (job_order_id, stage_code, stage_name, status, note, source, by_name) VALUES ($1, 'INVOICE', 'Invoice submitted', 'completed', $2, 'mill_portal', $3)`, [o.id, fileName, req.user!.name]);
      await notify(c, S, { audience_permission: 'procurement.invoice.capture', kind: 'action', title: `Job-work invoice for ${o.number}`, body: `${o.mill_name} · ${fileName}`, link: `/procurement/invoice-workbench/${cap.id}` });
      await auditReq(c, req, 'job_order', o.id, 'mill_invoice_uploaded', { after: { file: fileName } });
    });
    res.status(201).json({ capture_id: cap.id });
  });

  r.get('/portal/mill/claims', requirePermission('portal.mill.access'), async (req, res) => {
    res.json(await many(pool, `SELECT q.id, q.number, q.status, q.defect_types, q.description, q.kg_affected, q.claim_type, q.amount, q.mill_response, q.resolution, q.created_at, j.number AS job_number
      FROM quality_claims q JOIN job_orders j ON j.id = q.job_order_id WHERE q.mill_id = $1 ORDER BY q.created_at DESC`, [millOf(req)]));
  });

  r.post('/portal/mill/claims/:id/respond', requirePermission('portal.mill.access'), async (req, res) => {
    const { response } = parse(z.object({ response: reqText(2000) }), req.body);
    await tx(pool, async (c) => {
      const q = await one<{ mill_id: string; status: string; number: string }>(c, 'SELECT * FROM quality_claims WHERE id = $1 FOR UPDATE', [req.params.id]);
      if (!q || q.mill_id !== millOf(req)) throw notFound('Quality claim');
      if (!['open', 'under_review'].includes(q.status)) throw conflict('This claim is already settled');
      await c.query(`UPDATE quality_claims SET mill_response = $2, mill_response_at = now(), status = 'under_review', updated_at = now() WHERE id = $1`, [req.params.id, response]);
      await notify(c, S, { audience_permission: 'jobwork.claim.manage', kind: 'info', title: `Mill responded to ${q.number}`, body: response.slice(0, 140), link: `/jobwork/claims/${req.params.id}` });
      await auditReq(c, req, 'quality_claim', String(req.params.id), 'mill_responded', { reason: response });
    });
    res.json({ ok: true });
  });
}
