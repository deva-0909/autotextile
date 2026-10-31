import type { Router } from 'express';
import { z } from 'zod';
import { type ServiceContext, many, notFound, notify, one, optText, parse, reqText, requirePermission, tx } from '@erp/platform';
import { S, auditReq, getParty, localNumber, portalCustomer } from './common.ts';

export function supportRoutes(r: Router, { pool }: ServiceContext) {
  r.get('/portal/complaints', requirePermission('portal.customer.order', 'portal.customer.accounts'), async (req, res) => {
    res.json(await many(pool, `SELECT c.*, o.number AS order_no FROM complaints c LEFT JOIN orders o ON o.id = c.order_id WHERE c.customer_id = $1 ORDER BY c.created_at DESC`, [portalCustomer(req)]));
  });
  r.post('/portal/complaints', requirePermission('portal.customer.order', 'portal.customer.accounts'), async (req, res) => {
    const cust = portalCustomer(req);
    const b = parse(z.object({ order_id: z.uuid().nullable().optional(), category: z.enum(['quality', 'delivery', 'billing', 'payment', 'other']), subject: reqText(160), description: reqText(2000) }), req.body);
    const p = await getParty(cust);
    const out = await tx(pool, async (c) => {
      if (b.order_id && !(await one(c, 'SELECT 1 FROM orders WHERE id = $1 AND customer_id = $2', [b.order_id, cust]))) throw notFound('Order');
      const number = await localNumber(c, 'complaint', 'CMP-');
      const row = await one<{ id: string }>(c, `INSERT INTO complaints (number, customer_id, customer_name, order_id, category, subject, description, raised_by_name) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`, [number, cust, p.legal_name, b.order_id ?? null, b.category, b.subject, b.description, req.user!.name]);
      await notify(c, S, { audience_permission: 'fulfilment.returns.manage', kind: 'action', title: `Complaint ${number} from ${p.legal_name}: ${b.subject}`, body: b.category, link: '/commerce/complaints' });
      return { id: row!.id, number };
    });
    res.status(201).json(out);
  });
  r.get('/complaints', requirePermission('commerce.read'), async (req, res) => {
    res.json(await many(pool, `SELECT c.*, o.number AS order_no FROM complaints c LEFT JOIN orders o ON o.id = c.order_id WHERE ($1::text IS NULL OR c.status = ANY(string_to_array($1, ','))) ORDER BY c.created_at DESC LIMIT 300`, [req.query.status ?? null]));
  });
  r.patch('/complaints/:id', requirePermission('fulfilment.returns.manage', 'commerce.order.manage'), async (req, res) => {
    const b = parse(z.object({ status: z.enum(['open', 'in_progress', 'resolved', 'closed']), resolution: optText(2000) }), req.body);
    await tx(pool, async (c) => {
      const r1 = await c.query(`UPDATE complaints SET status = $2, resolution = coalesce($3, resolution), assigned_to_name = $4, updated_at = now() WHERE id = $1`, [req.params.id, b.status, b.resolution ?? null, req.user!.name]);
      if (!r1.rowCount) throw notFound('Complaint');
      await auditReq(c, req, 'complaint', String(req.params.id), b.status, { reason: b.resolution });
    });
    res.json({ ok: true });
  });
}
