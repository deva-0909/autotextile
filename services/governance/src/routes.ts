import express, { type Request, type Router } from 'express';
import { z } from 'zod';
import {
  type BusEvent, type Client, type Handler, type ServiceContext, audit, badRequest, conflict, contextOf, forbidden, hasPermission,
  listQuery, many, notFound, one, optText, orderLimit, page, parse, publish, reqText, requirePermission, tx,
} from '@erp/platform';
import { MAX_UPLOAD_BYTES, checkFile, load, store } from './storage.ts';

const S = 'governance';
/** Service-to-service calls carry a non-UUID identity (svc:<name>); store it as unknown. */
const uuidOrNull = (id: string | undefined) => (id && /^[0-9a-f-]{36}$/i.test(id) ? id : null);

/** Notifications visible to the user: addressed to them or to a permission they hold. */
function audienceClause(req: Request, params: unknown[]) {
  params.push(req.user!.id, req.user!.permissions);
  return `(n.user_id = $${params.length - 1} OR n.audience_permission = ANY($${params.length}) OR ('*' = ANY($${params.length}) AND n.audience_permission IS NOT NULL))`;
}

export function routes(r: Router, { pool }: ServiceContext) {
  // ---------- document versions (read-only history) ----------
  r.get('/document-versions', requirePermission('crm.read', 'procurement.read', 'finance.read', 'jobwork.read', 'inventory.read', 'fulfilment.read', 'governance.document.read'), async (req, res) => {
    const docType = String(req.query.doc_type ?? ''), docId = String(req.query.doc_id ?? '');
    if (!docType || !/^[0-9a-f-]{36}$/i.test(docId)) { res.json([]); return; }
    res.json(await many(pool, 'SELECT id, service, doc_type, doc_id, number, version, status, data, change_note, by_name, at FROM record_versions WHERE doc_type = $1 AND doc_id = $2 ORDER BY version DESC, id DESC', [docType, docId]));
  });

  // ---------- audit trail ----------
  r.get('/audit', requirePermission('governance.audit.read'), async (req, res) => {
    const lq = listQuery(req, ['at', 'service', 'entity', 'action', 'user_name'], 'at');
    const params: unknown[] = [];
    const where: string[] = [];
    const f = lq.filters;
    const add = (sql: string, v: unknown) => { params.push(v); where.push(sql.replace('?', `$${params.length}`)); };
    if (f.service) add('service = ?', f.service);
    if (f.entity) add('entity = ?', f.entity);
    if (f.entityId) add('entity_id = ?', f.entityId);
    if (f.action) add('action = ?', f.action);
    if (f.userId) add('user_id = ?', f.userId);
    if (f.from) add('at >= ?::date', f.from);
    if (f.to) add(`at < (?::date + interval '1 day')`, f.to);
    if (lq.q) {
      params.push(`%${lq.q}%`);
      const i = params.length;
      where.push(`(entity_id ILIKE $${i} OR user_name ILIKE $${i} OR reason ILIKE $${i} OR after::text ILIKE $${i} OR before::text ILIKE $${i})`);
    }
    const rows = await many<{ total_count: number }>(pool, `
      SELECT *, count(*) OVER ()::int AS total_count FROM audit_log
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ${orderLimit({ ...lq, dir: req.query.dir ? lq.dir : 'desc' }, params)}`, params);
    res.json(page(rows, lq));
  });

  r.get('/audit/facets', requirePermission('governance.audit.read'), async (_req, res) => {
    const [services, entities, actions] = await Promise.all([
      many<{ v: string }>(pool, 'SELECT DISTINCT service AS v FROM audit_log ORDER BY 1'),
      many<{ v: string }>(pool, 'SELECT DISTINCT entity AS v FROM audit_log ORDER BY 1'),
      many<{ v: string }>(pool, 'SELECT DISTINCT action AS v FROM audit_log ORDER BY 1'),
    ]);
    res.json({ services: services.map((x) => x.v), entities: entities.map((x) => x.v), actions: actions.map((x) => x.v) });
  });

  // ---------- approvals (maker-checker) ----------
  r.get('/approvals', async (req, res) => {
    const lq = listQuery(req, ['requested_at', 'decided_at', 'status', 'approval_type'], 'requested_at');
    const params: unknown[] = [];
    const where: string[] = [];
    const canSeeAll = hasPermission(req.user, 'governance.approval.read') || req.user!.permissions.includes('*');
    if (lq.filters.box === 'mine') { params.push(req.user!.id); where.push(`requested_by = $${params.length}`); }
    else if (lq.filters.box === 'inbox' || !canSeeAll) {
      // Requests this user can decide, plus their own.
      params.push(req.user!.permissions, req.user!.id);
      where.push(`(required_permission = ANY($${params.length - 1}) OR '*' = ANY($${params.length - 1}) OR requested_by = $${params.length})`);
      if (lq.filters.box === 'inbox') where.push(`requested_by <> $${params.length}`);
    }
    if (lq.filters.status) { params.push(lq.filters.status); where.push(`status = $${params.length}`); }
    if (lq.q) { params.push(`%${lq.q}%`); where.push(`(title ILIKE $${params.length} OR summary ILIKE $${params.length})`); }
    const rows = await many<{ total_count: number }>(pool, `
      SELECT *, count(*) OVER ()::int AS total_count FROM approval_requests
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ${orderLimit({ ...lq, dir: req.query.dir ? lq.dir : 'desc' }, params)}`, params);
    res.json(page(rows, lq));
  });

  r.get('/approvals/:id', async (req, res) => {
    const a = await one<{ requested_by: string; required_permission: string }>(pool, 'SELECT * FROM approval_requests WHERE id = $1', [req.params.id]);
    if (!a) throw notFound('Approval request');
    if (a.requested_by !== req.user!.id && !hasPermission(req.user, 'governance.approval.read') && !hasPermission(req.user, a.required_permission)) throw forbidden();
    res.json(a);
  });

  r.post('/approvals/:id/decide', async (req, res) => {
    const { decision, comment } = parse(z.object({ decision: z.enum(['approved', 'rejected']), comment: optText(500) }), req.body);
    if (decision === 'rejected' && !comment) throw badRequest('Give a reason for rejecting', { fields: { comment: 'Required when rejecting' } });
    const out = await tx(pool, async (c) => {
      const a = await one<{ id: string; status: string; requested_by: string; required_permission: string; source_service: string; approval_type: string; ref_id: string; title: string; payload: unknown }>(
        c, 'SELECT * FROM approval_requests WHERE id = $1 FOR UPDATE', [req.params.id]);
      if (!a) throw notFound('Approval request');
      if (!hasPermission(req.user, a.required_permission)) throw forbidden('You are not an approver for this request');
      if (a.requested_by === req.user!.id) throw forbidden('Maker-checker: you cannot approve your own request');
      if (a.status !== 'pending') throw conflict(`This request was already ${a.status}`);
      const updated = await one(c, `
        UPDATE approval_requests SET status = $2, decided_by = $3, decided_by_name = $4, decided_at = now(), comment = $5 WHERE id = $1 RETURNING *`,
        [a.id, decision, req.user!.id, req.user!.name, comment ?? null]);
      await publish(c, S, 'approval.decided', {
        approval_id: a.id, source_service: a.source_service, approval_type: a.approval_type, ref_id: a.ref_id, payload: a.payload,
        decision, decided_by: req.user!.id, decided_by_name: req.user!.name, comment: comment ?? null,
      });
      await audit(c, S, contextOf(req), { entity: 'approval_request', entityId: a.id, action: decision, reason: comment, after: { title: a.title } });
      await c.query(`INSERT INTO notifications (user_id, kind, title, body, link) VALUES ($1, $2, $3, $4, $5)`, [
        a.requested_by, decision === 'approved' ? 'success' : 'warning', `Request ${decision}: ${a.title}`,
        comment ? `${req.user!.name}: ${comment}` : `By ${req.user!.name}`, `/approvals/${a.id}`,
      ]);
      return updated;
    });
    res.json(out);
  });

  // ---------- notifications ----------
  r.get('/notifications', async (req, res) => {
    const params: unknown[] = [];
    const aud = audienceClause(req, params);
    params.push(req.user!.id);
    res.json(await many(pool, `
      SELECT n.*, (nr.read_at IS NOT NULL) AS read
      FROM notifications n LEFT JOIN notification_reads nr ON nr.notification_id = n.id AND nr.user_id = $${params.length}
      WHERE ${aud} ORDER BY n.created_at DESC LIMIT 50`, params));
  });

  r.post('/notifications/:id/read', async (req, res) => {
    await pool.query('INSERT INTO notification_reads (notification_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [req.params.id, req.user!.id]);
    res.json({ ok: true });
  });

  r.post('/notifications/read-all', async (req, res) => {
    const params: unknown[] = [];
    const aud = audienceClause(req, params);
    params.push(req.user!.id);
    await pool.query(`INSERT INTO notification_reads (notification_id, user_id) SELECT n.id, $${params.length} FROM notifications n WHERE ${aud} ON CONFLICT DO NOTHING`, params);
    res.json({ ok: true });
  });

  // ---------- documents ----------
  // Personnel files (ID proofs, offer and relieving letters) are seen only by people who manage employees.
  const PRIVATE: Record<string, string> = { employee: 'hrms.employee.manage' };
  const mayOpen = (req: Request, entityType: string) => !PRIVATE[entityType] || hasPermission(req.user, PRIVATE[entityType]);
  async function docFor(req: Request, id: string) {
    const d = await one<{ id: string; entity_type: string; status: string; current_version: number }>(pool, 'SELECT * FROM documents WHERE id::text = $1', [id]);
    if (!d || !mayOpen(req, d.entity_type)) throw notFound('Document');
    return d;
  }
  r.get('/documents', requirePermission('governance.document.read'), async (req, res) => {
    const lq = listQuery(req, ['title', 'updated_at', 'document_type', 'expires_on'], 'updated_at');
    const params: unknown[] = [];
    const where: string[] = [];
    const f = lq.filters;
    if (f.entityType) { params.push(f.entityType); where.push(`d.entity_type = $${params.length}`); }
    if (f.entityId) { params.push(f.entityId); where.push(`d.entity_id = $${params.length}`); }
    params.push(f.status ?? 'active'); where.push(`d.status = $${params.length}`);
    const hidden = Object.keys(PRIVATE).filter((t) => !mayOpen(req, t));
    if (hidden.length) { params.push(hidden); where.push(`NOT (d.entity_type = ANY($${params.length}))`); }
    if (lq.q) { params.push(`%${lq.q}%`); where.push(`(d.title ILIKE $${params.length} OR d.document_type ILIKE $${params.length})`); }
    const rows = await many<{ total_count: number }>(pool, `
      SELECT d.*, v.file_name, v.mime_type, v.size_bytes, v.uploaded_by_name, v.uploaded_at, count(*) OVER ()::int AS total_count
      FROM documents d JOIN document_versions v ON v.document_id = d.id AND v.version = d.current_version
      WHERE ${where.join(' AND ')} ${orderLimit({ ...lq, dir: req.query.dir ? lq.dir : 'desc' }, params).replace('ORDER BY ', 'ORDER BY d.')}`, params);
    res.json(page(rows, lq));
  });

  r.get('/documents/:id', requirePermission('governance.document.read'), async (req, res) => {
    const d = await docFor(req, String(req.params.id));
    const versions = await many(pool, 'SELECT id, version, file_name, mime_type, size_bytes, sha256, note, uploaded_by_name, uploaded_at FROM document_versions WHERE document_id = $1 ORDER BY version DESC', [req.params.id]);
    res.json({ ...d, versions });
  });

  const raw = express.raw({ type: () => true, limit: MAX_UPLOAD_BYTES });
  const meta = z.object({
    title: reqText(200),
    document_type: z.string().trim().regex(/^[A-Z0-9_]{2,24}$/),
    entity_type: z.string().trim().regex(/^[a-z_]{2,40}$/),
    entity_id: z.string().trim().min(1).max(64),
    expires_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional().or(z.literal('').transform(() => null)),
    note: optText(300),
  });
  const fileInfo = (req: Request) => ({
    fileName: decodeURIComponent(String(req.headers['x-file-name'] ?? 'file')).replace(/[\\/]/g, '_').slice(0, 200),
    mime: String(req.headers['content-type'] ?? '').split(';')[0],
  });

  r.post('/documents', requirePermission('governance.document.upload'), raw, async (req, res) => {
    const m = parse(meta, req.query);
    if (!mayOpen(req, m.entity_type)) throw forbidden('Only HR can file documents for an employee');
    const body = req.body as Buffer;
    const { fileName, mime } = fileInfo(req);
    checkFile(mime, body);
    const stored = await store(body, pool);
    const doc = await tx(pool, async (c) => {
      const d = await one<{ id: string }>(c, `
        INSERT INTO documents (document_type, title, entity_type, entity_id, expires_on, created_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [m.document_type, m.title, m.entity_type, m.entity_id, m.expires_on ?? null, uuidOrNull(req.user!.id)]);
      await c.query(`
        INSERT INTO document_versions (document_id, version, file_name, mime_type, size_bytes, sha256, storage_key, note, uploaded_by, uploaded_by_name)
        VALUES ($1, 1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [d!.id, fileName, mime, body.length, stored.sha256, stored.key, m.note ?? null, uuidOrNull(req.user!.id), req.user!.name]);
      await audit(c, S, contextOf(req), { entity: 'document', entityId: d!.id, action: 'uploaded', after: { ...m, file_name: fileName, size_bytes: body.length, sha256: stored.sha256 } });
      return d;
    });
    res.status(201).json(doc);
  });

  r.post('/documents/:id/versions', requirePermission('governance.document.upload'), raw, async (req, res) => {
    const { note } = parse(z.object({ note: optText(300) }), req.query);
    await docFor(req, String(req.params.id));
    const body = req.body as Buffer;
    const { fileName, mime } = fileInfo(req);
    checkFile(mime, body);
    const stored = await store(body, pool);
    const out = await tx(pool, async (c) => {
      const d = await one<{ current_version: number; status: string }>(c, 'SELECT current_version, status FROM documents WHERE id = $1 FOR UPDATE', [req.params.id]);
      if (!d) throw notFound('Document');
      if (d.status !== 'active') throw conflict('Archived documents cannot get new versions');
      const v = d.current_version + 1;
      await c.query(`
        INSERT INTO document_versions (document_id, version, file_name, mime_type, size_bytes, sha256, storage_key, note, uploaded_by, uploaded_by_name)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [req.params.id, v, fileName, mime, body.length, stored.sha256, stored.key, note ?? null, uuidOrNull(req.user!.id), req.user!.name]);
      await c.query('UPDATE documents SET current_version = $2, updated_at = now() WHERE id = $1', [req.params.id, v]);
      await audit(c, S, contextOf(req), { entity: 'document', entityId: String(req.params.id), action: 'new_version', after: { version: v, file_name: fileName, sha256: stored.sha256 }, reason: note });
      return { version: v };
    });
    res.status(201).json(out);
  });

  r.get('/documents/:id/versions/:version/content', requirePermission('governance.document.read'), async (req, res) => {
    await docFor(req, String(req.params.id));
    const v = await one<{ storage_key: string; mime_type: string; file_name: string }>(pool,
      'SELECT storage_key, mime_type, file_name FROM document_versions WHERE document_id = $1 AND version = $2', [req.params.id, Number(req.params.version)]);
    if (!v) throw notFound('Document version');
    res.setHeader('Content-Type', v.mime_type);
    res.setHeader('Content-Disposition', `${req.query.download ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(v.file_name)}`);
    res.setHeader('Cache-Control', 'private, no-store');
    const body = await load(v.storage_key, pool);
    if (!body) throw notFound('The file for this document version');
    res.send(body);
  });

  // Archiving needs the archive right, except that HR manages its own personnel files.
  r.post('/documents/:id/archive', requirePermission('governance.document.delete', 'hrms.employee.manage'), async (req, res) => {
    const { reason } = parse(z.object({ reason: reqText(300) }), req.body);
    const d = await docFor(req, String(req.params.id));
    if (!hasPermission(req.user, 'governance.document.delete') && !PRIVATE[d.entity_type]) throw forbidden('Archiving this document needs the archive permission');
    await tx(pool, async (c) => {
      const r1 = await c.query(`UPDATE documents SET status = 'archived', updated_at = now() WHERE id = $1 AND status = 'active'`, [req.params.id]);
      if (!r1.rowCount) throw notFound('Active document');
      await audit(c, S, contextOf(req), { entity: 'document', entityId: String(req.params.id), action: 'archived', reason });
    });
    res.json({ ok: true });
  });

  // ---------- dashboard summary ----------
  r.get('/summary', async (req, res) => {
    const [pending, mine, events, docs, expiring] = await Promise.all([
      one<{ n: number }>(pool, `SELECT count(*)::int AS n FROM approval_requests WHERE status = 'pending' AND requested_by <> $1 AND (required_permission = ANY($2) OR '*' = ANY($2))`, [req.user!.id, req.user!.permissions]),
      one<{ n: number }>(pool, `SELECT count(*)::int AS n FROM approval_requests WHERE status = 'pending' AND requested_by = $1`, [req.user!.id]),
      hasPermission(req.user, 'governance.audit.read') ? one<{ n: number }>(pool, `SELECT count(*)::int AS n FROM audit_log WHERE at > now() - interval '24 hours'`) : { n: 0 },
      one<{ n: number }>(pool, `SELECT count(*)::int AS n FROM documents WHERE status = 'active'`),
      one<{ n: number }>(pool, `SELECT count(*)::int AS n FROM documents WHERE status = 'active' AND expires_on <= current_date + 30`),
    ]);
    res.json({ approvalsToDecide: pending!.n, myPendingRequests: mine!.n, auditEvents24h: events!.n, documents: docs!.n, documentsExpiring30d: expiring!.n });
  });
}

export function consumers(): Record<string, Handler> {
  return {
    'audit.recorded': async (ev: BusEvent, c: Client) => {
      const p = ev.payload as Record<string, unknown>;
      await c.query(`
        INSERT INTO audit_log (event_id, service, entity, entity_id, action, before, after, reason, approved_by, user_id, user_name, session_id, ip, user_agent, at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) ON CONFLICT (event_id) DO NOTHING`,
        [ev.id, p.service, p.entity, p.entityId, p.action, p.before === undefined ? null : JSON.stringify(p.before), p.after === undefined ? null : JSON.stringify(p.after),
          p.reason ?? null, p.approvedBy ?? null, p.userId ?? null, p.userName ?? null, p.sessionId ?? null, p.ip ?? null, p.userAgent ?? null, p.at]);
    },
    'document.version.recorded': async (ev: BusEvent, c: Client) => {
      const p = ev.payload as { service: string; doc_type: string; doc_id: string; number?: string | null; version: number; status?: string | null; data: unknown; change_note?: string | null; by_name?: string | null };
      await c.query(`INSERT INTO record_versions (event_id, service, doc_type, doc_id, number, version, status, data, change_note, by_name, at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, coalesce($11::timestamptz, now()))
        ON CONFLICT DO NOTHING`, [ev.id, p.service, p.doc_type, p.doc_id, p.number ?? null, p.version, p.status ?? null, JSON.stringify(p.data ?? {}), p.change_note ?? null, p.by_name ?? null, (ev as { created_at?: string }).created_at ?? null]);
    },
    'notification.requested': async (ev: BusEvent, c: Client) => {
      const n = ev.payload as { user_id?: string | null; audience_permission?: string | null; kind?: string; title: string; body?: string | null; link?: string | null };
      if (!n.user_id && !n.audience_permission) return;
      await c.query(`INSERT INTO notifications (user_id, audience_permission, kind, title, body, link) VALUES ($1, $2, $3, $4, $5, $6)`,
        [n.user_id ?? null, n.user_id ? null : n.audience_permission, ['info', 'success', 'warning', 'action'].includes(n.kind ?? '') ? n.kind : 'info', n.title, n.body ?? null, n.link ?? null]);
    },
    'approval.requested': async (ev: BusEvent, c: Client) => {
      const p = ev.payload as Record<string, string> & { payload: object };
      const r = await c.query(`
        INSERT INTO approval_requests (source_service, approval_type, ref_id, title, summary, payload, required_permission, requested_by, requested_by_name)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT DO NOTHING RETURNING id`,
        [p.source_service, p.approval_type, p.ref_id, p.title, p.summary ?? null, JSON.stringify(p.payload ?? {}), p.required_permission, p.requested_by, p.requested_by_name ?? null]);
      if (r.rows[0])
        await c.query(`INSERT INTO notifications (audience_permission, kind, title, body, link) VALUES ($1, 'action', $2, $3, $4)`,
          [p.required_permission, `Approval needed: ${p.title}`, `Requested by ${p.requested_by_name ?? 'a user'}${p.summary ? ` — ${p.summary}` : ''}`, `/approvals/${r.rows[0].id}`]);
    },
  };
}
