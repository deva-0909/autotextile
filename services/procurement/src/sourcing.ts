import type { Router } from 'express';
import { z } from 'zod';
import {
  type ServiceContext, badRequest, conflict, forbidden, listQuery, many, notFound, one, optText, orderLimit, page, parse, reqText, requirePermission, tx,
} from '@erp/platform';
import { auditReq, getParty, getProduct, nextNumber, resolveDestination, round2 } from './common.ts';
import { createPurchaseOrder } from './orders.ts';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const dest = { deliver_to_type: z.enum(['warehouse', 'mill']), deliver_to_id: z.uuid() };

const requisitionBody = z.object({
  title: reqText(160),
  ...dest,
  required_by: isoDate,
  purpose: optText(1000),
  lines: z.array(z.object({ product_id: z.uuid(), qty_kg: z.number().positive(), target_rate: z.number().positive().nullable().optional(), notes: optText(300) })).min(1, 'Add at least one line'),
  version: z.number().int().optional(),
});

const rfqBody = z.object({
  title: reqText(160),
  requisition_id: z.uuid().nullable().optional(),
  due_date: isoDate,
  ...dest,
  terms: optText(2000),
  supplier_ids: z.array(z.uuid()).min(1, 'Invite at least one supplier'),
  lines: z.array(z.object({ product_id: z.uuid(), qty_kg: z.number().positive(), notes: optText(300) })).min(1, 'Add at least one line'),
});

const quoteBody = z.object({
  supplier_id: z.uuid(),
  quote_ref: optText(60),
  valid_until: isoDate.nullable().optional(),
  lead_time_days: z.number().int().min(0).max(365).nullable().optional(),
  freight_per_kg: z.number().min(0).default(0),
  payment_terms: optText(200),
  quality_notes: optText(1000),
  lines: z.array(z.object({ rfq_line_id: z.uuid(), rate_per_kg: z.number().positive(), remarks: optText(300) })).min(1),
});

export function sourcingRoutes(r: Router, { pool }: ServiceContext) {
  // ---------- requisitions ----------
  r.get('/requisitions', requirePermission('procurement.read'), async (req, res) => {
    const lq = listQuery(req, ['number', 'required_by', 'created_at', 'status'], 'created_at');
    const params: unknown[] = [];
    const where: string[] = [];
    if (lq.filters.status) { params.push(lq.filters.status); where.push(`r.status = $${params.length}`); }
    if (lq.q) { params.push(`%${lq.q}%`); where.push(`(r.number ILIKE $${params.length} OR r.title ILIKE $${params.length})`); }
    const rows = await many<{ total_count: number }>(pool, `
      SELECT r.*, (SELECT count(*)::int FROM requisition_lines l WHERE l.requisition_id = r.id) AS line_count,
             (SELECT sum(qty_kg) FROM requisition_lines l WHERE l.requisition_id = r.id) AS total_kg,
             count(*) OVER ()::int AS total_count
      FROM requisitions r ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ${orderLimit({ ...lq, dir: req.query.dir ? lq.dir : 'desc' }, params).replace('ORDER BY ', 'ORDER BY r.')}`, params);
    res.json(page(rows, lq));
  });

  r.get('/requisitions/:id', requirePermission('procurement.read'), async (req, res) => {
    const pr = await one<Record<string, unknown>>(pool, 'SELECT * FROM requisitions WHERE id = $1', [req.params.id]);
    if (!pr) throw notFound('Requisition');
    const lines = await many(pool, 'SELECT * FROM requisition_lines WHERE requisition_id = $1 ORDER BY line_no', [req.params.id]);
    const rfqs = await many(pool, 'SELECT id, number, status FROM rfqs WHERE requisition_id = $1', [req.params.id]);
    const pos = await many(pool, 'SELECT id, number, status FROM purchase_orders WHERE requisition_id = $1', [req.params.id]);
    res.json({ ...pr, lines, rfqs, purchase_orders: pos });
  });

  async function prLines(body: z.infer<typeof requisitionBody>) {
    return Promise.all(body.lines.map(async (l, i) => {
      const p = await getProduct(l.product_id).catch(() => null);
      if (!p || p.status !== 'active') throw badRequest(`Line ${i + 1}: choose an active product`);
      return { ...l, sku: p.sku, product_name: p.name, line_no: i + 1 };
    }));
  }

  r.post('/requisitions', requirePermission('procurement.requisition.create'), async (req, res) => {
    const body = parse(requisitionBody, req.body);
    const d = await resolveDestination(body.deliver_to_type, body.deliver_to_id);
    const lines = await prLines(body);
    const out = await tx(pool, async (c) => {
      const pr = await one<{ id: string; number: string }>(c, `
        INSERT INTO requisitions (number, title, deliver_to_type, deliver_to_id, deliver_to_name, required_by, purpose, requested_by, requested_by_name, created_by)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $8) RETURNING id, number`,
        [await nextNumber(c, 'purchase_requisition', 'PR-'), body.title, body.deliver_to_type, body.deliver_to_id, d.name, body.required_by, body.purpose ?? null, req.user!.id, req.user!.name]);
      for (const l of lines) await c.query(`INSERT INTO requisition_lines (requisition_id, line_no, product_id, sku, product_name, qty_kg, target_rate, notes) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [pr!.id, l.line_no, l.product_id, l.sku, l.product_name, l.qty_kg, l.target_rate ?? null, l.notes ?? null]);
      await auditReq(c, req, 'requisition', pr!.id, 'created', { after: { number: pr!.number, title: body.title, lines: lines.length } });
      return pr;
    });
    res.status(201).json(out);
  });

  r.patch('/requisitions/:id', requirePermission('procurement.requisition.create'), async (req, res) => {
    const body = parse(requisitionBody, req.body);
    const d = await resolveDestination(body.deliver_to_type, body.deliver_to_id);
    const lines = await prLines(body);
    await tx(pool, async (c) => {
      const pr = await one<{ status: string; version: number }>(c, 'SELECT status, version FROM requisitions WHERE id = $1 FOR UPDATE', [req.params.id]);
      if (!pr) throw notFound('Requisition');
      if (pr.status !== 'draft' && pr.status !== 'rejected') throw conflict('Only draft or rejected requisitions can be edited');
      if (body.version !== undefined && body.version !== pr.version) throw conflict('Someone else changed this requisition. Reload to see the latest version.');
      await c.query(`UPDATE requisitions SET title = $2, deliver_to_type = $3, deliver_to_id = $4, deliver_to_name = $5, required_by = $6, purpose = $7, status = 'draft', version = version + 1, updated_at = now(), updated_by = $8 WHERE id = $1`,
        [req.params.id, body.title, body.deliver_to_type, body.deliver_to_id, d.name, body.required_by, body.purpose ?? null, req.user!.id]);
      await c.query('DELETE FROM requisition_lines WHERE requisition_id = $1', [req.params.id]);
      for (const l of lines) await c.query(`INSERT INTO requisition_lines (requisition_id, line_no, product_id, sku, product_name, qty_kg, target_rate, notes) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [req.params.id, l.line_no, l.product_id, l.sku, l.product_name, l.qty_kg, l.target_rate ?? null, l.notes ?? null]);
      await auditReq(c, req, 'requisition', String(req.params.id), 'updated');
    });
    res.json({ ok: true });
  });

  r.post('/requisitions/:id/submit', requirePermission('procurement.requisition.create'), async (req, res) => {
    await tx(pool, async (c) => {
      const r1 = await c.query(`UPDATE requisitions SET status = 'submitted', updated_at = now() WHERE id = $1 AND status = 'draft' RETURNING number`, [req.params.id]);
      if (!r1.rowCount) throw conflict('Only draft requisitions can be submitted');
      await auditReq(c, req, 'requisition', String(req.params.id), 'submitted');
    });
    res.json({ ok: true });
  });

  r.post('/requisitions/:id/decide', requirePermission('procurement.requisition.approve'), async (req, res) => {
    const { decision, comment } = parse(z.object({ decision: z.enum(['approved', 'rejected']), comment: optText(500) }), req.body);
    if (decision === 'rejected' && !comment) throw badRequest('Give a reason for rejecting', { fields: { comment: 'Required' } });
    await tx(pool, async (c) => {
      const pr = await one<{ status: string; requested_by: string }>(c, 'SELECT status, requested_by FROM requisitions WHERE id = $1 FOR UPDATE', [req.params.id]);
      if (!pr) throw notFound('Requisition');
      if (pr.status !== 'submitted') throw conflict('Only submitted requisitions can be decided');
      if (pr.requested_by === req.user!.id) throw forbidden('Maker-checker: you cannot approve your own requisition');
      await c.query(`UPDATE requisitions SET status = $2, decided_by = $3, decided_by_name = $4, decided_at = now(), decision_comment = $5, updated_at = now() WHERE id = $1`,
        [req.params.id, decision, req.user!.id, req.user!.name, comment ?? null]);
      await auditReq(c, req, 'requisition', String(req.params.id), decision, { reason: comment });
    });
    res.json({ ok: true });
  });

  r.post('/requisitions/:id/cancel', requirePermission('procurement.requisition.create'), async (req, res) => {
    const { reason } = parse(z.object({ reason: reqText(300) }), req.body);
    await tx(pool, async (c) => {
      const r1 = await c.query(`UPDATE requisitions SET status = 'cancelled', updated_at = now() WHERE id = $1 AND status IN ('draft','submitted','approved','rejected')`, [req.params.id]);
      if (!r1.rowCount) throw conflict('This requisition can no longer be cancelled');
      await auditReq(c, req, 'requisition', String(req.params.id), 'cancelled', { reason });
    });
    res.json({ ok: true });
  });

  // ---------- RFQs ----------
  r.get('/rfqs', requirePermission('procurement.read'), async (req, res) => {
    const lq = listQuery(req, ['number', 'due_date', 'created_at', 'status'], 'created_at');
    const params: unknown[] = [];
    const where: string[] = [];
    if (lq.filters.status) { params.push(lq.filters.status); where.push(`q.status = $${params.length}`); }
    if (lq.q) { params.push(`%${lq.q}%`); where.push(`(q.number ILIKE $${params.length} OR q.title ILIKE $${params.length})`); }
    const rows = await many<{ total_count: number }>(pool, `
      SELECT q.*, (SELECT count(*)::int FROM rfq_suppliers s WHERE s.rfq_id = q.id) AS invited,
             (SELECT count(*)::int FROM quotes x WHERE x.rfq_id = q.id) AS quotes_received,
             (SELECT sum(qty_kg) FROM rfq_lines l WHERE l.rfq_id = q.id) AS total_kg,
             (SELECT number FROM purchase_orders p WHERE p.id = q.po_id) AS po_number,
             count(*) OVER ()::int AS total_count
      FROM rfqs q ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ${orderLimit({ ...lq, dir: req.query.dir ? lq.dir : 'desc' }, params).replace('ORDER BY ', 'ORDER BY q.')}`, params);
    res.json(page(rows, lq));
  });

  r.get('/rfqs/:id', requirePermission('procurement.read'), async (req, res) => {
    const rfq = await one<Record<string, unknown>>(pool, 'SELECT * FROM rfqs WHERE id = $1', [req.params.id]);
    if (!rfq) throw notFound('RFQ');
    const [lines, suppliers, quotes, quoteLines] = await Promise.all([
      many(pool, 'SELECT * FROM rfq_lines WHERE rfq_id = $1 ORDER BY line_no', [req.params.id]),
      many(pool, 'SELECT * FROM rfq_suppliers WHERE rfq_id = $1 ORDER BY supplier_name', [req.params.id]),
      many<{ id: string }>(pool, 'SELECT * FROM quotes WHERE rfq_id = $1 ORDER BY supplier_name', [req.params.id]),
      many<{ quote_id: string }>(pool, 'SELECT ql.* FROM quote_lines ql JOIN quotes q ON q.id = ql.quote_id WHERE q.rfq_id = $1', [req.params.id]),
    ]);
    res.json({ ...rfq, lines, suppliers, quotes: quotes.map((q) => ({ ...q, lines: quoteLines.filter((l) => l.quote_id === q.id) })), comparison: await compare(String(req.params.id)) });
  });

  /** Landed-cost comparison: rate + freight per KG, with lead time, terms and price history. */
  async function compare(rfqId: string) {
    const rows = await many<{ quote_id: string; supplier_id: string; supplier_name: string; rfq_line_id: string; qty_kg: number; rate_per_kg: number; freight_per_kg: number; lead_time_days: number | null; product_id: string }>(pool, `
      SELECT q.id AS quote_id, q.supplier_id, q.supplier_name, ql.rfq_line_id, l.qty_kg, l.product_id, ql.rate_per_kg, q.freight_per_kg, q.lead_time_days
      FROM quotes q JOIN quote_lines ql ON ql.quote_id = q.id JOIN rfq_lines l ON l.id = ql.rfq_line_id WHERE q.rfq_id = $1`, [rfqId]);
    const lineCount = (await one<{ n: number }>(pool, 'SELECT count(*)::int AS n FROM rfq_lines WHERE rfq_id = $1', [rfqId]))!.n;
    const bySupplier = new Map<string, { quote_id: string; supplier_id: string; supplier_name: string; landed_total: number; material_total: number; freight_total: number; lines_quoted: number; lead_time_days: number | null }>();
    for (const r of rows) {
      const s = bySupplier.get(r.supplier_id) ?? { quote_id: r.quote_id, supplier_id: r.supplier_id, supplier_name: r.supplier_name, landed_total: 0, material_total: 0, freight_total: 0, lines_quoted: 0, lead_time_days: r.lead_time_days };
      s.material_total += r.qty_kg * r.rate_per_kg;
      s.freight_total += r.qty_kg * r.freight_per_kg;
      s.landed_total = s.material_total + s.freight_total;
      s.lines_quoted++;
      bySupplier.set(r.supplier_id, s);
    }
    // On-time and quality history from past POs, so price is not the only signal.
    const ids = [...bySupplier.keys()];
    const history = ids.length ? await many<{ supplier_id: string; pos: number; on_time: number; received: number; rejected_kg: number; received_kg: number }>(pool, `
      SELECT p.supplier_id, count(DISTINCT p.id)::int AS pos,
        count(DISTINCT p.id) FILTER (WHERE p.status IN ('received','closed') AND (SELECT min(r.receipt_date) FROM receipts r WHERE r.po_id = p.id) <= p.expected_date)::int AS on_time,
        count(DISTINCT p.id) FILTER (WHERE p.status IN ('received','closed'))::int AS received,
        coalesce(sum(l.rejected_kg), 0) AS rejected_kg, coalesce(sum(l.received_kg), 0) AS received_kg
      FROM purchase_orders p JOIN po_lines l ON l.po_id = p.id WHERE p.supplier_id = ANY($1) GROUP BY p.supplier_id`, [ids]) : [];
    const ranked = [...bySupplier.values()].map((s) => {
      const h = history.find((x) => x.supplier_id === s.supplier_id);
      return {
        ...s,
        landed_total: round2(s.landed_total), material_total: round2(s.material_total), freight_total: round2(s.freight_total),
        complete: s.lines_quoted === lineCount,
        past_pos: h?.pos ?? 0,
        on_time_pct: h?.received ? Math.round((h.on_time / h.received) * 100) : null,
        rejection_pct: h && h.received_kg + h.rejected_kg > 0 ? round2((h.rejected_kg / (h.received_kg + h.rejected_kg)) * 100) : null,
      };
    }).sort((a, b) => Number(b.complete) - Number(a.complete) || a.landed_total - b.landed_total);
    return { line_count: lineCount, suppliers: ranked, lowest_landed: ranked.find((r) => r.complete)?.supplier_id ?? null };
  }

  r.post('/rfqs', requirePermission('procurement.rfq.manage'), async (req, res) => {
    const body = parse(rfqBody, req.body);
    const d = await resolveDestination(body.deliver_to_type, body.deliver_to_id);
    const lines = await Promise.all(body.lines.map(async (l, i) => {
      const p = await getProduct(l.product_id).catch(() => null);
      if (!p || p.status !== 'active') throw badRequest(`Line ${i + 1}: choose an active product`);
      return { ...l, sku: p.sku, product_name: p.name, hsn_code: p.hsn_code, gst_rate: p.gst_rate, line_no: i + 1 };
    }));
    const suppliers = await Promise.all(body.supplier_ids.map(async (id) => {
      const s = await getParty(id).catch(() => null);
      if (!s || !['supplier', 'manufacturer'].includes(s.party_type) || s.status !== 'active') throw badRequest('Only active suppliers or manufacturers can be invited');
      return s;
    }));
    const out = await tx(pool, async (c) => {
      if (body.requisition_id) {
        const pr = await one<{ status: string }>(c, 'SELECT status FROM requisitions WHERE id = $1 FOR UPDATE', [body.requisition_id]);
        if (pr?.status !== 'approved') throw conflict('Only approved requisitions can be sourced');
        await c.query(`UPDATE requisitions SET status = 'converted', updated_at = now() WHERE id = $1`, [body.requisition_id]);
      }
      const rfq = await one<{ id: string; number: string }>(c, `
        INSERT INTO rfqs (number, title, requisition_id, due_date, deliver_to_type, deliver_to_id, deliver_to_name, terms, created_by)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id, number`,
        [await nextNumber(c, 'rfq', 'RFQ-'), body.title, body.requisition_id ?? null, body.due_date, body.deliver_to_type, body.deliver_to_id, d.name, body.terms ?? null, req.user!.id]);
      for (const l of lines) await c.query(`INSERT INTO rfq_lines (rfq_id, line_no, product_id, sku, product_name, hsn_code, gst_rate, qty_kg, notes) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [rfq!.id, l.line_no, l.product_id, l.sku, l.product_name, l.hsn_code, l.gst_rate, l.qty_kg, l.notes ?? null]);
      for (const s of suppliers) await c.query(`INSERT INTO rfq_suppliers (rfq_id, supplier_id, supplier_code, supplier_name) VALUES ($1, $2, $3, $4)`, [rfq!.id, s.id, s.code, s.legal_name]);
      await auditReq(c, req, 'rfq', rfq!.id, 'created', { after: { number: rfq!.number, suppliers: suppliers.map((s) => s.code) } });
      return rfq;
    });
    res.status(201).json(out);
  });

  r.put('/rfqs/:id/quotes', requirePermission('procurement.rfq.manage'), async (req, res) => {
    const body = parse(quoteBody, req.body);
    res.json(await tx(pool, async (c) => {
      const rfq = await one<{ status: string }>(c, 'SELECT status FROM rfqs WHERE id = $1 FOR UPDATE', [req.params.id]);
      if (!rfq) throw notFound('RFQ');
      if (rfq.status !== 'open') throw conflict('Quotes can only be recorded while the RFQ is open');
      const inv = await one<{ supplier_name: string }>(c, 'SELECT supplier_name FROM rfq_suppliers WHERE rfq_id = $1 AND supplier_id = $2', [req.params.id, body.supplier_id]);
      if (!inv) throw badRequest('This supplier was not invited to the RFQ');
      const valid = new Set((await many<{ id: string }>(c, 'SELECT id FROM rfq_lines WHERE rfq_id = $1', [req.params.id])).map((l) => l.id));
      if (body.lines.some((l) => !valid.has(l.rfq_line_id))) throw badRequest('Quote lines must belong to this RFQ');
      const q = await one<{ id: string }>(c, `
        INSERT INTO quotes (rfq_id, supplier_id, supplier_name, quote_ref, valid_until, lead_time_days, freight_per_kg, payment_terms, quality_notes, created_by)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        ON CONFLICT (rfq_id, supplier_id) DO UPDATE SET quote_ref = excluded.quote_ref, valid_until = excluded.valid_until, lead_time_days = excluded.lead_time_days,
          freight_per_kg = excluded.freight_per_kg, payment_terms = excluded.payment_terms, quality_notes = excluded.quality_notes, updated_at = now()
        RETURNING id`,
        [req.params.id, body.supplier_id, inv.supplier_name, body.quote_ref ?? null, body.valid_until ?? null, body.lead_time_days ?? null, body.freight_per_kg, body.payment_terms ?? null, body.quality_notes ?? null, req.user!.id]);
      await c.query('DELETE FROM quote_lines WHERE quote_id = $1', [q!.id]);
      for (const l of body.lines) await c.query('INSERT INTO quote_lines (quote_id, rfq_line_id, rate_per_kg, remarks) VALUES ($1, $2, $3, $4)', [q!.id, l.rfq_line_id, l.rate_per_kg, l.remarks ?? null]);
      await auditReq(c, req, 'rfq', String(req.params.id), 'quote_recorded', { after: { supplier: inv.supplier_name, lines: body.lines } });
      return q;
    }));
  });

  /** Awarding never sends a PO by itself: it creates a draft PO that goes through approval. */
  r.post('/rfqs/:id/award', requirePermission('procurement.rfq.manage'), async (req, res) => {
    const { quote_id, reason, expected_date } = parse(z.object({ quote_id: z.uuid(), reason: optText(500), expected_date: isoDate }), req.body);
    const rfq = await one<{ status: string; deliver_to_type: 'warehouse' | 'mill'; deliver_to_id: string; requisition_id: string | null; title: string }>(pool, 'SELECT * FROM rfqs WHERE id = $1', [req.params.id]);
    if (!rfq) throw notFound('RFQ');
    if (rfq.status !== 'open') throw conflict('This RFQ is not open');
    const cmp = await compare(String(req.params.id));
    const chosen = cmp.suppliers.find((s) => s.quote_id === quote_id);
    if (!chosen) throw badRequest('Unknown quote');
    if (!chosen.complete) throw badRequest('This quote does not cover every line');
    if (chosen.supplier_id !== cmp.lowest_landed && !reason) throw badRequest('Give a reason for not awarding to the lowest landed cost', { fields: { reason: 'Required' } });
    const lines = await many<{ product_id: string; qty_kg: number; rate_per_kg: number }>(pool, `
      SELECT l.product_id, l.qty_kg, ql.rate_per_kg FROM rfq_lines l JOIN quote_lines ql ON ql.rfq_line_id = l.id AND ql.quote_id = $2 WHERE l.rfq_id = $1 ORDER BY l.line_no`, [req.params.id, quote_id]);
    const quote = await one<{ payment_terms: string | null; freight_per_kg: number }>(pool, 'SELECT payment_terms, freight_per_kg FROM quotes WHERE id = $1', [quote_id]);
    const po = await tx(pool, async (c) => {
      const created = await createPurchaseOrder(c, req, {
        supplier_id: chosen.supplier_id, deliver_to_type: rfq.deliver_to_type, deliver_to_id: rfq.deliver_to_id, expected_date,
        freight_terms: quote!.freight_per_kg > 0 ? `Freight ₹${quote!.freight_per_kg}/kg extra` : 'Freight included', notes: `From ${rfq.title}`,
        lines: lines.map((l) => ({ product_id: l.product_id, qty_kg: Number(l.qty_kg), rate_per_kg: Number(l.rate_per_kg) })),
      }, { rfqId: String(req.params.id), requisitionId: rfq.requisition_id });
      await c.query(`UPDATE quotes SET status = CASE WHEN id = $2 THEN 'awarded' ELSE 'not_awarded' END WHERE rfq_id = $1`, [req.params.id, quote_id]);
      await c.query(`UPDATE rfqs SET status = 'awarded', awarded_quote_id = $2, po_id = $3, updated_at = now() WHERE id = $1`, [req.params.id, quote_id, created.id]);
      await auditReq(c, req, 'rfq', String(req.params.id), 'awarded', { reason, after: { supplier: chosen.supplier_name, landed_total: chosen.landed_total, po: created.number } });
      return created;
    });
    res.json(po);
  });
}
