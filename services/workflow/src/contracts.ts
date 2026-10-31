import type { Router } from 'express';
import { z } from 'zod';
import { type Pool, type ServiceContext, badRequest, callService, conflict, many, notFound, notify, one, optText, parse, reqText, requirePermission, tx } from '@erp/platform';
import { auditReq, directory, getParty, localNumber } from './common.ts';
import { createTask } from './engine.ts';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const body = z.object({
  kind: z.enum(['supply', 'job_work', 'customer', 'transport', 'rent', 'service', 'other']), title: reqText(200),
  party_id: z.uuid().nullable().optional(), party_name: optText(200), start_date: date, end_date: date, value: z.number().min(0).nullable().optional(),
  rates: z.array(z.object({ item: z.string().min(1).max(120), rate: z.number().min(0), uom: z.string().max(20).default('kg'), note: optText(200) })).max(50).default([]),
  payment_terms: optText(500), quality_terms: optText(1000), delivery_terms: optText(500), penalties: optText(1000), auto_renew: z.boolean().default(false),
  owner_id: z.uuid().nullable().optional(), document_ids: z.array(z.uuid()).max(20).default([]),
});
const SEARCH = `setweight(to_tsvector('simple', coalesce(number,'') || ' ' || coalesce(title,'') || ' ' || coalesce(party_name,'')), 'A') ||
  setweight(to_tsvector('english', coalesce(payment_terms,'') || ' ' || coalesce(quality_terms,'') || ' ' || coalesce(delivery_terms,'') || ' ' || coalesce(penalties,'') || ' ' || coalesce(rates::text,'')), 'B')`;

export function contractRoutes(r: Router, { pool }: ServiceContext) {
  r.get('/contracts', requirePermission('workflow.contract.read'), async (req, res) => {
    const params: unknown[] = [];
    const where: string[] = [];
    if (req.query.status) { params.push(String(req.query.status).split(',')); where.push(`c.status = ANY($${params.length})`); }
    if (req.query.kind) { params.push(req.query.kind); where.push(`c.kind = $${params.length}`); }
    if (req.query.party) { params.push(req.query.party); where.push(`c.party_id = $${params.length}`); }
    let rank = '0';
    // Search the contract text and the correspondence; matches in notes count too.
    if (req.query.q) {
      params.push(String(req.query.q));
      const q = `websearch_to_tsquery('english', $${params.length})`;
      where.push(`(c.search @@ ${q} OR c.search @@ websearch_to_tsquery('simple', $${params.length}) OR EXISTS (SELECT 1 FROM contract_notes n WHERE n.contract_id = c.id AND n.search @@ ${q}) OR c.party_name ILIKE '%' || $${params.length} || '%')`);
      rank = `ts_rank(c.search, ${q})`;
    }
    res.json(await many(pool, `SELECT c.id, c.number, c.kind, c.title, c.party_id, c.party_name, c.start_date::text, c.end_date::text, c.value::float, c.status, c.owner_name, c.auto_renew,
      (c.end_date - current_date) AS days_left, (SELECT count(*)::int FROM contract_notes n WHERE n.contract_id = c.id) AS notes, ${rank} AS rank
      FROM contracts c ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY ${req.query.q ? 'rank DESC,' : ''} c.end_date LIMIT 300`, params));
  });

  r.get('/contracts/:id', requirePermission('workflow.contract.read'), async (req, res) => {
    const k = await one<{ id: string; document_ids: string[] }>(pool, `SELECT *, start_date::text, end_date::text, value::float, (end_date - current_date) AS days_left FROM contracts WHERE id::text = $1 OR number = $1`, [req.params.id]);
    if (!k) throw notFound('Contract');
    const docs = k.document_ids.length ? await Promise.all(k.document_ids.map((d) => callService<{ id: string; title: string }>('workflow', 'governance', 'GET', `/documents/${d}`).catch(() => null))) : [];
    res.json({ ...k, notes: await many(pool, 'SELECT id, kind, body, by_name, at FROM contract_notes WHERE contract_id = $1 ORDER BY at DESC', [k.id]), documents: docs.filter(Boolean),
      history: await many(pool, `SELECT id, number, start_date::text, end_date::text, status FROM contracts WHERE id = (SELECT renewed_from FROM contracts WHERE id = $1) OR renewed_from = $1`, [k.id]) });
  });

  r.post('/contracts', requirePermission('workflow.contract.manage'), async (req, res) => {
    const b = parse(body, req.body);
    const party = b.party_id ? await getParty(b.party_id) : null;
    if (!party && !b.party_name) throw badRequest('Choose the other party');
    const owner = b.owner_id ? (await directory()).find((u) => u.id === b.owner_id) : null;
    const out = await tx(pool, async (c) => {
      const number = await localNumber(c, 'contract', 'AGR-');
      const k = await one<{ id: string }>(c, `INSERT INTO contracts (number, kind, title, party_id, party_name, party_type, start_date, end_date, value, rates, payment_terms, quality_terms, delivery_terms, penalties, auto_renew, status, owner_id, owner_name, document_ids, created_by_name)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) RETURNING id`,
      [number, b.kind, b.title, party?.id ?? null, party?.legal_name ?? b.party_name, party?.party_type ?? null, b.start_date, b.end_date, b.value ?? null, JSON.stringify(b.rates), b.payment_terms ?? null, b.quality_terms ?? null, b.delivery_terms ?? null, b.penalties ?? null, b.auto_renew,
        b.end_date < new Date().toISOString().slice(0, 10) ? 'expired' : 'active', owner?.id ?? req.user!.id, owner?.name ?? req.user!.name, b.document_ids, req.user!.name]);
      await c.query(`UPDATE contracts SET search = ${SEARCH} WHERE id = $1`, [k!.id]);
      await auditReq(c, req, 'contract', k!.id, 'created', { after: { number, ...b } });
      return { id: k!.id, number };
    });
    res.status(201).json(out);
  });

  r.put('/contracts/:id', requirePermission('workflow.contract.manage'), async (req, res) => {
    const b = parse(body, req.body);
    await tx(pool, async (c) => {
      const before = await one<{ status: string }>(c, 'SELECT * FROM contracts WHERE id = $1 FOR UPDATE', [req.params.id]);
      if (!before) throw notFound('Contract');
      if (['terminated', 'renewed'].includes(before.status)) throw conflict(`A ${before.status} contract cannot be edited`);
      await c.query(`UPDATE contracts SET kind = $2, title = $3, start_date = $4, end_date = $5, value = $6, rates = $7, payment_terms = $8, quality_terms = $9, delivery_terms = $10, penalties = $11, auto_renew = $12, document_ids = $13, updated_at = now(),
        status = CASE WHEN $5::date < current_date THEN 'expired' ELSE 'active' END, alerts_sent = CASE WHEN end_date <> $5::date THEN '{}' ELSE alerts_sent END WHERE id = $1`,
      [req.params.id, b.kind, b.title, b.start_date, b.end_date, b.value ?? null, JSON.stringify(b.rates), b.payment_terms ?? null, b.quality_terms ?? null, b.delivery_terms ?? null, b.penalties ?? null, b.auto_renew, b.document_ids]);
      await c.query(`UPDATE contracts SET search = ${SEARCH} WHERE id = $1`, [req.params.id]);
      await c.query(`INSERT INTO contract_notes (contract_id, kind, body, search, by_name) VALUES ($1, 'amendment', $2, to_tsvector('english', $2), $3)`, [req.params.id, `Contract amended by ${req.user!.name}`, req.user!.name]);
      await auditReq(c, req, 'contract', String(req.params.id), 'amended', { before, after: b });
    });
    res.json({ ok: true });
  });

  r.post('/contracts/:id/notes', requirePermission('workflow.contract.manage'), async (req, res) => {
    const b = parse(z.object({ kind: z.enum(['note', 'email', 'call', 'meeting', 'letter']), body: reqText(5000) }), req.body);
    await tx(pool, async (c) => {
      if (!(await one(c, 'SELECT 1 FROM contracts WHERE id = $1', [req.params.id]))) throw notFound('Contract');
      await c.query(`INSERT INTO contract_notes (contract_id, kind, body, search, by_name) VALUES ($1,$2,$3, to_tsvector('english', $3), $4)`, [req.params.id, b.kind, b.body, req.user!.name]);
    });
    res.status(201).json({ ok: true });
  });

  /** Renew: a new contract for the next period, linked to this one; or terminate with a reason. */
  r.post('/contracts/:id/renew', requirePermission('workflow.contract.manage'), async (req, res) => {
    const b = parse(z.object({ start_date: date, end_date: date, rates: body.shape.rates.optional(), note: optText(500) }), req.body);
    const out = await tx(pool, async (c) => {
      const k = await one<Record<string, unknown> & { id: string; status: string; number: string; rates: unknown }>(c, 'SELECT * FROM contracts WHERE id = $1 FOR UPDATE', [req.params.id]);
      if (!k) throw notFound('Contract');
      if (!['active', 'expired'].includes(k.status)) throw conflict(`This contract is ${k.status}`);
      const number = await localNumber(c, 'contract', 'AGR-');
      const n = await one<{ id: string }>(c, `INSERT INTO contracts (number, kind, title, party_id, party_name, party_type, start_date, end_date, value, rates, payment_terms, quality_terms, delivery_terms, penalties, auto_renew, status, owner_id, owner_name, document_ids, renewed_from, created_by_name)
        SELECT $2, kind, title, party_id, party_name, party_type, $3, $4, value, $5, payment_terms, quality_terms, delivery_terms, penalties, auto_renew, 'active', owner_id, owner_name, document_ids, id, $6 FROM contracts WHERE id = $1 RETURNING id`,
      [k.id, number, b.start_date, b.end_date, JSON.stringify(b.rates ?? k.rates), req.user!.name]);
      await c.query(`UPDATE contracts SET search = ${SEARCH} WHERE id = $1`, [n!.id]);
      await c.query(`UPDATE contracts SET status = 'renewed', updated_at = now() WHERE id = $1`, [k.id]);
      await c.query(`UPDATE tasks SET status = 'done', resolution = $2, completed_by_name = $3, completed_at = now() WHERE source_type = 'contract' AND source_id = $1 AND status IN ('open','in_progress')`, [k.id, `Renewed as ${number}`, req.user!.name]);
      await auditReq(c, req, 'contract', k.id, 'renewed', { after: { new: number, ...b } });
      return { id: n!.id, number };
    });
    res.status(201).json(out);
  });
  r.post('/contracts/:id/terminate', requirePermission('workflow.contract.manage'), async (req, res) => {
    const { reason } = parse(z.object({ reason: reqText(500) }), req.body);
    await tx(pool, async (c) => {
      const r1 = await c.query(`UPDATE contracts SET status = 'terminated', updated_at = now() WHERE id = $1 AND status IN ('active','expired')`, [req.params.id]);
      if (!r1.rowCount) throw conflict('Only active or expired contracts can be terminated');
      await c.query(`INSERT INTO contract_notes (contract_id, kind, body, search, by_name) VALUES ($1, 'note', $2, to_tsvector('english', $2), $3)`, [req.params.id, `Terminated: ${reason}`, req.user!.name]);
      await auditReq(c, req, 'contract', String(req.params.id), 'terminated', { reason });
    });
    res.json({ ok: true });
  });
}

/** Renewal alerts at 30, 15 and 7 days before expiry: a task for the owner and a notification. Expired contracts are marked. */
export async function runContractChecks(pool: Pool) {
  const due = await many<{ id: string; number: string; title: string; party_name: string; end_date: string; days_left: number; owner_id: string | null; alerts_sent: number[] }>(pool,
    `SELECT id, number, title, party_name, end_date::text, (end_date - current_date) AS days_left, owner_id, alerts_sent FROM contracts WHERE status = 'active' AND end_date - current_date <= 30`);
  let alerts = 0;
  for (const k of due) {
    const stage = [7, 15, 30].find((d) => k.days_left <= d && !k.alerts_sent.includes(d));
    if (k.days_left < 0) { await pool.query(`UPDATE contracts SET status = 'expired', updated_at = now() WHERE id = $1`, [k.id]); continue; }
    if (!stage) continue;
    await tx(pool, async (c) => {
      await c.query(`UPDATE contracts SET alerts_sent = array_append(alerts_sent, $2) WHERE id = $1`, [k.id, stage]);
      await c.query(`UPDATE contracts SET alerts_sent = array_append(alerts_sent, x) FROM unnest(ARRAY[30,15,7]) x WHERE id = $1 AND x > $2 AND NOT (x = ANY(alerts_sent))`, [k.id, stage]);
      const open = await one(c, `SELECT 1 FROM tasks WHERE source_type = 'contract' AND source_id = $1 AND status IN ('open','in_progress')`, [k.id]);
      if (!open) await createTask(c, { title: `Renew or close ${k.number} with ${k.party_name} (expires ${k.end_date})`, source: { service: 'workflow', type: 'contract', id: k.id }, link: `/contracts/${k.id}`, owner_id: k.owner_id, queue_permission: k.owner_id ? null : 'workflow.contract.manage', priority: stage === 7 ? 'high' : 'normal', due_at: new Date(`${k.end_date}T00:00:00Z`), by: 'contract monitor' });
      else await notify(c, 'workflow', k.owner_id ? { user_id: k.owner_id, kind: 'warning', title: `${k.number} with ${k.party_name} expires in ${k.days_left} days`, link: `/contracts/${k.id}` } : { audience_permission: 'workflow.contract.manage', kind: 'warning', title: `${k.number} expires in ${k.days_left} days`, link: `/contracts/${k.id}` });
    });
    alerts++;
  }
  return { alerts };
}
