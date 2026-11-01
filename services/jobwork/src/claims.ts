import type { Router } from 'express';
import { z } from 'zod';
import { type ServiceContext, badRequest, conflict, listQuery, many, notFound, notify, one, optText, orderLimit, page, parse, reqText, requirePermission, tx } from '@erp/platform';
import { S, auditReq, millDeduction, nextNumber, portalUsers } from './common.ts';

const MONEY = ['debit_note', 'shortage'];

const DEFECTS = ['Shade variation', 'Uneven dyeing', 'Holes', 'Stains / oil marks', 'GSM out of tolerance', 'Width out of tolerance', 'Shrinkage', 'Pilling', 'Finishing defect', 'Short quantity'];

export function claimRoutes(r: Router, { pool }: ServiceContext) {
  r.get('/claims/defect-types', requirePermission('jobwork.read', 'portal.mill.access'), (_req, res) => { res.json(DEFECTS); });

  r.get('/claims', requirePermission('jobwork.read'), async (req, res) => {
    const lq = listQuery(req, ['number', 'created_at', 'status', 'amount'], 'created_at');
    const params: unknown[] = [];
    const where: string[] = [];
    if (lq.filters.status) { params.push(lq.filters.status.split(',')); where.push(`q.status = ANY($${params.length})`); }
    if (lq.filters.mill) { params.push(lq.filters.mill); where.push(`q.mill_id = $${params.length}`); }
    if (lq.q) { params.push(`%${lq.q}%`); where.push(`(q.number ILIKE $${params.length} OR q.mill_name ILIKE $${params.length} OR q.description ILIKE $${params.length})`); }
    const rows = await many<{ total_count: number }>(pool, `
      SELECT q.*, j.number AS job_number, count(*) OVER ()::int AS total_count FROM quality_claims q JOIN job_orders j ON j.id = q.job_order_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ${orderLimit({ ...lq, dir: req.query.dir ? lq.dir : 'desc' }, params).replace('ORDER BY ', 'ORDER BY q.')}`, params);
    res.json(page(rows, lq));
  });

  r.get('/claims/:id', requirePermission('jobwork.read'), async (req, res) => {
    const q = await one(pool, 'SELECT q.*, j.number AS job_number, j.process_name FROM quality_claims q JOIN job_orders j ON j.id = q.job_order_id WHERE q.id = $1', [req.params.id]);
    if (!q) throw notFound('Quality claim');
    res.json(q);
  });

  r.post('/claims', requirePermission('jobwork.claim.manage'), async (req, res) => {
    const b = parse(z.object({
      job_order_id: z.uuid(), defect_types: z.array(z.string()).min(1, 'Choose at least one defect'), description: reqText(2000),
      kg_affected: z.number().positive(), samples: optText(500), claim_type: z.enum(['debit_note', 'rework', 'replacement', 'none', 'shortage']).default('debit_note'),
      amount: z.number().min(0).default(0),
    }), req.body);
    const out = await tx(pool, async (c) => {
      const o = await one<{ id: string; number: string; mill_id: string; mill_name: string; status: string; kg_sent: number }>(c, 'SELECT * FROM job_orders WHERE id = $1', [b.job_order_id]);
      if (!o) throw notFound('Job-work order');
      if (['draft', 'cancelled'].includes(o.status)) throw conflict('Claims can only be raised on issued orders');
      if (b.kg_affected > o.kg_sent) throw badRequest('Affected quantity exceeds what was sent');
      const q = await one<{ id: string; number: string }>(c, `
        INSERT INTO quality_claims (number, job_order_id, mill_id, mill_name, defect_types, description, kg_affected, samples, claim_type, amount, raised_by_name)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id, number`,
        [await nextNumber(c, 'quality_claim', 'QC-'), o.id, o.mill_id, o.mill_name, b.defect_types, b.description, b.kg_affected, b.samples ?? null, b.claim_type, b.amount, req.user!.name]);
      for (const uid of await portalUsers(o.mill_id))
        await notify(c, S, { user_id: uid, kind: 'warning', title: `Quality claim ${q!.number} on ${o.number}`, body: b.defect_types.join(', '), link: `/portal/claims/${q!.id}` });
      // In the mill's ledger from the moment it is raised: held from payments until it is decided.
      if (MONEY.includes(b.claim_type) && b.amount > 0)
        await millDeduction(c, { key: `claim:${q!.id}`, mill_id: o.mill_id, mill_name: o.mill_name, kind: b.claim_type === 'shortage' ? 'shortage_claim' : 'quality_claim', source_id: q!.id, ref: q!.number, job_ref: o.number,
          reason: `${b.defect_types.join(', ')}: ${b.description}`, state: 'held', amount: b.amount, expense_account: b.claim_type === 'shortage' ? 'purchases' : 'jobwork', by: req.user!.name });
      await auditReq(c, req, 'quality_claim', q!.id, 'raised', { after: b });
      return q;
    });
    res.status(201).json(out);
  });

  r.patch('/claims/:id', requirePermission('jobwork.claim.manage'), async (req, res) => {
    const b = parse(z.object({
      status: z.enum(['open', 'under_review', 'accepted', 'rejected', 'closed']),
      root_cause: optText(1000), responsibility: z.enum(['mill', 'supplier', 'internal', 'undetermined']),
      claim_type: z.enum(['debit_note', 'rework', 'replacement', 'none', 'shortage']), amount: z.number().min(0), resolution: optText(1000),
    }), req.body);
    if (['accepted', 'rejected', 'closed'].includes(b.status) && !b.resolution) throw badRequest('Record the resolution', { fields: { resolution: 'Required' } });
    res.json(await tx(pool, async (c) => {
      const before = await one<{ status: string; mill_id: string; number: string; mill_name: string; amount: number; job_order_id: string }>(c, 'SELECT * FROM quality_claims WHERE id = $1 FOR UPDATE', [req.params.id]);
      if (!before) throw notFound('Quality claim');
      if (before.status === 'closed') throw conflict('This claim is closed');
      const after = await one(c, `UPDATE quality_claims SET status = $2, root_cause = $3, responsibility = $4, claim_type = $5, amount = $6, resolution = $7, updated_at = now(),
        closed_at = CASE WHEN $2 = 'closed' THEN now() END WHERE id = $1 RETURNING *`,
        [req.params.id, b.status, b.root_cause ?? null, b.responsibility, b.claim_type, b.amount, b.resolution ?? null]);
      // Accounts follows every change: held while open, a debit note when accepted, reversed when rejected.
      if (!['accepted', 'rejected'].includes(before.status)) {
        const money = MONEY.includes(b.claim_type);
        const state = b.status === 'accepted' ? (money && b.amount > 0 ? 'confirmed' : 'released') : b.status === 'rejected' || b.status === 'closed' ? 'released' : 'held';
        const job = await one<{ number: string }>(c, 'SELECT number FROM job_orders WHERE id = $1', [before.job_order_id]);
        await millDeduction(c, { key: `claim:${req.params.id}`, mill_id: before.mill_id, mill_name: before.mill_name, kind: b.claim_type === 'shortage' ? 'shortage_claim' : 'quality_claim', source_id: String(req.params.id), ref: before.number, job_ref: job?.number ?? null,
          reason: b.resolution ?? null, state, amount: money ? b.amount : 0, expense_account: b.claim_type === 'shortage' ? 'purchases' : 'jobwork', by: req.user!.name });
      }
      await auditReq(c, req, 'quality_claim', String(req.params.id), 'updated', { before, after, reason: b.resolution });
      return after;
    }));
  });
}
