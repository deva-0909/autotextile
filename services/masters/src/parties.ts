import type { Request, Router } from 'express';
import { z } from 'zod';
import {
  type BusEvent, type Client, type Handler, type ServiceContext, GST_STATES, PAN_RE, audit, badRequest, conflict, contextOf, forbidden, gstinProblem, hasPermission,
  insertAudited, listQuery, many, notFound, one, optText, orderLimit, page, panOfGstin, parse, publish, reqText, requirePermission, tx, updateAudited,
} from '@erp/platform';

const S = 'masters';
export const PARTY_TYPES = ['customer', 'supplier', 'manufacturer', 'mill', 'transporter'] as const;
type PartyType = (typeof PARTY_TYPES)[number];

const MANAGE: Record<PartyType, string> = {
  customer: 'masters.customer.manage',
  supplier: 'masters.supplier.manage',
  manufacturer: 'masters.supplier.manage',
  mill: 'masters.mill.manage',
  transporter: 'masters.transporter.manage',
};
const PREFIX: Record<PartyType, string> = { customer: 'CUS', supplier: 'SUP', manufacturer: 'MFR', mill: 'MIL', transporter: 'TRN' };

/** Fields that must go through maker-checker approval when changed on an existing party. */
const SENSITIVE_FIELDS = ['gstin', 'gst_treatment', 'credit_limit', 'legal_name'] as const;

const blankToNull = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? null : v);

const partyBody = z.object({
  party_type: z.enum(PARTY_TYPES),
  legal_name: reqText(200),
  trade_name: optText(200),
  gst_treatment: z.enum(['registered', 'composition', 'unregistered', 'sez', 'overseas']),
  gstin: z.preprocess(blankToNull, z.string().trim().toUpperCase().nullable().optional()),
  pan: z.preprocess(blankToNull, z.string().trim().toUpperCase().regex(PAN_RE, 'PAN format is AAAAA9999A').nullable().optional()),
  state_code: z.preprocess(blankToNull, z.string().refine((v) => !!GST_STATES[v], 'Choose a state').nullable().optional()),
  email: z.preprocess(blankToNull, z.email().nullable().optional()),
  phone: z.preprocess(blankToNull, z.string().trim().regex(/^[+0-9 -]{7,20}$/, 'Enter a valid phone number').nullable().optional()),
  website: optText(200),
  payment_term_id: z.preprocess(blankToNull, z.uuid().nullable().optional()),
  credit_limit: z.number().nonnegative().nullable().optional(),
  segment: optText(80),
  rating: z.number().int().min(1).max(5).nullable().optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
  profile: z.record(z.string(), z.unknown()).default({}),
  owner_user_id: z.preprocess(blankToNull, z.uuid().nullable().optional()),
  notes: optText(2000),
  status: z.enum(['active', 'inactive', 'blocked']).default('active'),
  version: z.number().int().optional(),
  reason: optText(300),
});
type PartyBody = z.infer<typeof partyBody>;

/** Validates GST data and fills PAN and state from the GSTIN. */
function normaliseGst(body: PartyBody) {
  const needsGstin = ['registered', 'composition', 'sez'].includes(body.gst_treatment);
  if (needsGstin && !body.gstin) throw badRequest('GSTIN is required for registered parties', { fields: { gstin: 'Required' } });
  if (!needsGstin && body.gst_treatment !== 'overseas') body.gstin = body.gstin ?? null;
  if (body.gstin) {
    const problem = gstinProblem(body.gstin);
    if (problem) throw badRequest(problem, { fields: { gstin: problem } });
    const pan = panOfGstin(body.gstin);
    if (body.pan && body.pan !== pan) throw badRequest('PAN does not match the GSTIN', { fields: { pan: `GSTIN contains PAN ${pan}` } });
    body.pan = pan;
    body.state_code = body.gstin.slice(0, 2);
  }
  if (body.party_type !== 'customer') body.credit_limit = null;
}

function assertCanManage(req: Request, type: PartyType) {
  if (!hasPermission(req.user, MANAGE[type])) throw forbidden(`You cannot maintain ${type} records`);
}

const maskAccount = (n: string) => `•••• ${n.slice(-4)}`;

async function nextCode(c: Client, type: PartyType) {
  const r = await one<{ n: number }>(c, `
    INSERT INTO party_counters (party_type, next_number) VALUES ($1, 2)
    ON CONFLICT (party_type) DO UPDATE SET next_number = party_counters.next_number + 1
    RETURNING next_number - 1 AS n`, [type]);
  return `${PREFIX[type]}-${String(r!.n).padStart(5, '0')}`;
}

async function requestApproval(c: Client, req: Request, p: { type: string; refId: string; title: string; summary: string; payload: object }) {
  await publish(c, S, 'approval.requested', {
    source_service: S,
    approval_type: p.type,
    ref_id: p.refId,
    title: p.title,
    summary: p.summary,
    payload: p.payload,
    requested_by: req.user!.id,
    requested_by_name: req.user!.name,
    required_permission: 'governance.approval.decide',
  });
}

export function partyRoutes(r: Router, { pool }: ServiceContext) {
  r.get('/parties', requirePermission('masters.party.read'), async (req, res) => {
    const lq = listQuery(req, ['code', 'legal_name', 'state_code', 'status', 'created_at', 'updated_at'], 'legal_name');
    const params: unknown[] = [];
    const where: string[] = [];
    if (lq.filters.type) { params.push(lq.filters.type.split(',')); where.push(`p.party_type = ANY($${params.length})`); }
    if (lq.filters.status) { params.push(lq.filters.status); where.push(`p.status = $${params.length}`); }
    if (lq.filters.state) { params.push(lq.filters.state); where.push(`p.state_code = $${params.length}`); }
    if (lq.filters.tag) { params.push(lq.filters.tag); where.push(`$${params.length} = ANY(p.tags)`); }
    if (lq.q) {
      params.push(`%${lq.q}%`);
      where.push(`(p.legal_name ILIKE $${params.length} OR p.trade_name ILIKE $${params.length} OR p.code ILIKE $${params.length} OR p.gstin ILIKE $${params.length} OR p.phone ILIKE $${params.length} OR p.email ILIKE $${params.length})`);
    }
    const rows = await many<{ total_count: number }>(pool, `
      SELECT p.id, p.party_type, p.code, p.legal_name, p.trade_name, p.gstin, p.state_code, p.email, p.phone, p.segment,
        p.credit_limit, p.rating, p.tags, p.profile, p.status, p.updated_at, pt.name AS payment_term,
        EXISTS (SELECT 1 FROM pending_changes pc WHERE pc.party_id = p.id AND pc.status = 'pending')
          OR EXISTS (SELECT 1 FROM party_bank_accounts b WHERE b.party_id = p.id AND b.status = 'pending_approval') AS has_pending_approval,
        (SELECT c.name FROM party_contacts c WHERE c.party_id = p.id ORDER BY c.is_primary DESC, c.created_at LIMIT 1) AS primary_contact,
        count(*) OVER ()::int AS total_count
      FROM parties p LEFT JOIN payment_terms pt ON pt.id = p.payment_term_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ${orderLimit(lq, params).replace('ORDER BY ', 'ORDER BY p.')}`, params);
    res.json(page(rows, lq));
  });

  r.get('/parties/duplicates', requirePermission('masters.party.read'), async (req, res) => {
    const { gstin, phone, email, excludeId } = req.query as Record<string, string | undefined>;
    const conds: string[] = [];
    const params: unknown[] = [];
    if (gstin) { params.push(gstin.toUpperCase()); conds.push(`gstin = $${params.length}`); }
    if (phone) { params.push(phone.replace(/\D/g, '').slice(-10)); conds.push(`right(regexp_replace(phone, '\\D', '', 'g'), 10) = $${params.length}`); }
    if (email) { params.push(email.toLowerCase()); conds.push(`lower(email) = $${params.length}`); }
    if (!conds.length) return void res.json([]);
    params.push(excludeId ?? '00000000-0000-0000-0000-000000000000');
    res.json(await many(pool, `
      SELECT id, party_type, code, legal_name, gstin, phone, email, status FROM parties
      WHERE (${conds.join(' OR ')}) AND id <> $${params.length} LIMIT 10`, params));
  });

  r.get('/parties/:id', requirePermission('masters.party.read'), async (req, res) => {
    const p = await one<Record<string, unknown>>(pool, `
      SELECT p.*, pt.name AS payment_term FROM parties p LEFT JOIN payment_terms pt ON pt.id = p.payment_term_id WHERE p.id = $1`, [req.params.id]);
    if (!p) throw notFound('Party');
    const canSeeBank = hasPermission(req.user, 'masters.party.bank.view');
    const [contacts, addresses, banks, pending] = await Promise.all([
      many(pool, 'SELECT * FROM party_contacts WHERE party_id = $1 ORDER BY is_primary DESC, name', [req.params.id]),
      many(pool, 'SELECT * FROM party_addresses WHERE party_id = $1 ORDER BY is_default DESC, kind', [req.params.id]),
      many<{ account_number: string }>(pool, 'SELECT * FROM party_bank_accounts WHERE party_id = $1 ORDER BY created_at DESC', [req.params.id]),
      many(pool, 'SELECT * FROM pending_changes WHERE party_id = $1 ORDER BY requested_at DESC LIMIT 20', [req.params.id]),
    ]);
    res.json({
      ...p,
      contacts,
      addresses,
      bank_accounts: banks.map((b) => ({ ...b, account_number: canSeeBank ? b.account_number : maskAccount(b.account_number), masked: !canSeeBank })),
      pending_changes: pending,
    });
  });

  r.post('/parties', async (req, res) => {
    const body = parse(partyBody, req.body);
    assertCanManage(req, body.party_type);
    normaliseGst(body);
    const { version: _v, reason: _r, ...data } = body;
    const created = await tx(pool, async (c) => {
      if (data.gstin) {
        const dup = await one<{ code: string }>(c, 'SELECT code FROM parties WHERE party_type = $1 AND gstin = $2', [data.party_type, data.gstin]);
        if (dup) throw conflict(`A ${data.party_type} with this GSTIN already exists (${dup.code})`);
      }
      return insertAudited(c, req, S, 'parties', 'party', { ...data, code: await nextCode(c, data.party_type), profile: JSON.stringify(data.profile) });
    });
    res.status(201).json(created);
  });

  r.patch('/parties/:id', async (req, res) => {
    const body = parse(partyBody, req.body);
    assertCanManage(req, body.party_type);
    normaliseGst(body);
    const { version, reason, ...data } = body;
    const result = await tx(pool, async (c) => {
      const cur = await one<Record<string, unknown>>(c, 'SELECT * FROM parties WHERE id = $1 FOR UPDATE', [req.params.id]);
      if (!cur) throw notFound('Party');
      if (cur.party_type !== data.party_type) throw badRequest('Party type cannot be changed');
      if (version !== undefined && cur.version !== version) throw conflict('Someone else changed this record. Reload to see the latest version.');

      // Split the update into ordinary fields (applied now) and sensitive ones (held for approval).
      const sensitive: Record<string, unknown> = {};
      const previous: Record<string, unknown> = {};
      for (const f of SENSITIVE_FIELDS) {
        const next = (data as Record<string, unknown>)[f] ?? null;
        if (JSON.stringify(next) !== JSON.stringify(cur[f] ?? null)) {
          sensitive[f] = next;
          previous[f] = cur[f] ?? null;
          (data as Record<string, unknown>)[f] = cur[f];
        }
      }
      // PAN/state follow the GSTIN, so they wait with it.
      if ('gstin' in sensitive) { data.pan = cur.pan as string | null; data.state_code = cur.state_code as string | null; }

      const updated = await updateAudited(c, req, S, 'parties', 'party', String(req.params.id), { ...data, profile: JSON.stringify(data.profile) }, { reason });
      let pendingChange = null;
      if (Object.keys(sensitive).length) {
        if (!reason) throw badRequest('Give a reason for changing GSTIN, legal name or credit limit', { fields: { reason: 'Required for sensitive changes' } });
        const open = await one(c, `SELECT 1 FROM pending_changes WHERE party_id = $1 AND status = 'pending'`, [req.params.id]);
        if (open) throw conflict('A sensitive change for this party is already awaiting approval');
        pendingChange = await one<{ id: string }>(c, `
          INSERT INTO pending_changes (party_id, changes, previous, reason, requested_by) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
          [req.params.id, JSON.stringify(sensitive), JSON.stringify(previous), reason, req.user!.id]);
        await requestApproval(c, req, {
          type: 'party_sensitive_change',
          refId: pendingChange!.id,
          title: `${cur.code} ${cur.legal_name}: change ${Object.keys(sensitive).join(', ').replace(/_/g, ' ')}`,
          summary: reason,
          payload: { party_id: req.params.id, party_code: cur.code, party_type: cur.party_type, before: previous, after: sensitive },
        });
        await audit(c, S, contextOf(req), { entity: 'party', entityId: String(req.params.id), action: 'sensitive_change_requested', before: previous, after: sensitive, reason });
      }
      return { ...updated, pending_change: pendingChange };
    });
    res.json(result);
  });

  // ---------- contacts & addresses ----------
  const contactBody = z.object({
    name: reqText(120), designation: optText(80),
    email: z.preprocess(blankToNull, z.email().nullable().optional()),
    phone: optText(20), is_primary: z.boolean().default(false), version: z.number().int().optional(),
  });
  const addressBody = z.object({
    kind: z.enum(['billing', 'shipping', 'registered', 'factory', 'warehouse']),
    line1: reqText(200), line2: optText(200), city: reqText(80),
    state_code: z.string().refine((v) => !!GST_STATES[v], 'Choose a state'),
    pincode: z.string().regex(/^\d{6}$/, '6-digit PIN code'),
    gstin: z.preprocess(blankToNull, z.string().toUpperCase().nullable().optional()),
    is_default: z.boolean().default(false), version: z.number().int().optional(),
  });

  async function partyFor(c: Client, req: Request) {
    const p = await one<{ party_type: PartyType }>(c, 'SELECT party_type FROM parties WHERE id = $1', [req.params.id]);
    if (!p) throw notFound('Party');
    assertCanManage(req, p.party_type);
  }

  r.post('/parties/:id/contacts', async (req, res) => {
    const body = parse(contactBody, req.body);
    res.status(201).json(await tx(pool, async (c) => {
      await partyFor(c, req);
      if (body.is_primary) await c.query('UPDATE party_contacts SET is_primary = false WHERE party_id = $1', [req.params.id]);
      const { version: _v, ...data } = body;
      return insertAudited(c, req, S, 'party_contacts', 'party_contact', { ...data, party_id: req.params.id });
    }));
  });

  r.patch('/parties/:id/contacts/:cid', async (req, res) => {
    const body = parse(contactBody, req.body);
    res.json(await tx(pool, async (c) => {
      await partyFor(c, req);
      if (body.is_primary) await c.query('UPDATE party_contacts SET is_primary = false WHERE party_id = $1 AND id <> $2', [req.params.id, req.params.cid]);
      const { version, ...data } = body;
      return updateAudited(c, req, S, 'party_contacts', 'party_contact', String(req.params.cid), data, { version });
    }));
  });

  r.delete('/parties/:id/contacts/:cid', async (req, res) => {
    await tx(pool, async (c) => {
      await partyFor(c, req);
      const before = await one(c, 'DELETE FROM party_contacts WHERE id = $1 AND party_id = $2 RETURNING *', [req.params.cid, req.params.id]);
      if (!before) throw notFound('Contact');
      await audit(c, S, contextOf(req), { entity: 'party_contact', entityId: String(req.params.cid), action: 'deleted', before });
    });
    res.json({ ok: true });
  });

  r.post('/parties/:id/addresses', async (req, res) => {
    const body = parse(addressBody, req.body);
    if (body.gstin && gstinProblem(body.gstin)) throw badRequest(gstinProblem(body.gstin)!, { fields: { gstin: gstinProblem(body.gstin) } });
    res.status(201).json(await tx(pool, async (c) => {
      await partyFor(c, req);
      if (body.is_default) await c.query('UPDATE party_addresses SET is_default = false WHERE party_id = $1 AND kind = $2', [req.params.id, body.kind]);
      const { version: _v, ...data } = body;
      return insertAudited(c, req, S, 'party_addresses', 'party_address', { ...data, party_id: req.params.id });
    }));
  });

  r.patch('/parties/:id/addresses/:aid', async (req, res) => {
    const body = parse(addressBody, req.body);
    if (body.gstin && gstinProblem(body.gstin)) throw badRequest(gstinProblem(body.gstin)!, { fields: { gstin: gstinProblem(body.gstin) } });
    res.json(await tx(pool, async (c) => {
      await partyFor(c, req);
      if (body.is_default) await c.query('UPDATE party_addresses SET is_default = false WHERE party_id = $1 AND kind = $2 AND id <> $3', [req.params.id, body.kind, req.params.aid]);
      const { version, ...data } = body;
      return updateAudited(c, req, S, 'party_addresses', 'party_address', String(req.params.aid), data, { version });
    }));
  });

  // ---------- bank accounts (maker-checker) ----------
  r.post('/parties/:id/bank-accounts', requirePermission('masters.party.bank.request'), async (req, res) => {
    const body = parse(z.object({
      account_name: reqText(120),
      account_number: z.string().trim().regex(/^[0-9]{6,18}$/, '6–18 digits'),
      ifsc: z.string().trim().toUpperCase().regex(/^[A-Z]{4}0[A-Z0-9]{6}$/, 'IFSC format is ABCD0123456'),
      bank_name: optText(120),
      branch: optText(120),
      reason: reqText(300),
    }), req.body);
    const created = await tx(pool, async (c) => {
      const p = await one<{ code: string; legal_name: string }>(c, 'SELECT code, legal_name FROM parties WHERE id = $1', [req.params.id]);
      if (!p) throw notFound('Party');
      const { reason, ...data } = body;
      const bank = await one<{ id: string }>(c, `
        INSERT INTO party_bank_accounts (party_id, account_name, account_number, ifsc, bank_name, branch, created_by)
        VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [req.params.id, data.account_name, data.account_number, data.ifsc, data.bank_name ?? null, data.branch ?? null, req.user!.id]);
      await requestApproval(c, req, {
        type: 'party_bank_account',
        refId: bank!.id,
        title: `${p.code} ${p.legal_name}: new bank account`,
        summary: reason,
        payload: { party_id: req.params.id, party_code: p.code, account_name: data.account_name, account_number: maskAccount(data.account_number), ifsc: data.ifsc, bank_name: data.bank_name },
      });
      await audit(c, S, contextOf(req), {
        entity: 'party_bank_account', entityId: bank!.id, action: 'requested', reason,
        after: { ...data, account_number: maskAccount(data.account_number) },
      });
      return { ...bank, account_number: maskAccount(data.account_number) };
    });
    res.status(201).json(created);
  });

  r.post('/parties/:id/bank-accounts/:bid/deactivate', requirePermission('masters.party.bank.request'), async (req, res) => {
    const { reason } = parse(z.object({ reason: reqText(300) }), req.body);
    await tx(pool, async (c) => {
      const r1 = await c.query(`UPDATE party_bank_accounts SET status = 'inactive', updated_at = now(), updated_by = $3 WHERE id = $1 AND party_id = $2 AND status = 'active'`, [req.params.bid, req.params.id, req.user!.id]);
      if (!r1.rowCount) throw notFound('Active bank account');
      await audit(c, S, contextOf(req), { entity: 'party_bank_account', entityId: String(req.params.bid), action: 'deactivated', reason });
    });
    res.json({ ok: true });
  });
}

/** Applies checker decisions coming back from the governance service. */
export function approvalConsumers(): Record<string, Handler> {
  return {
    'approval.decided': async (ev: BusEvent, c: Client) => {
      const p = ev.payload as { source_service: string; approval_type: string; ref_id: string; decision: 'approved' | 'rejected'; decided_by: string; decided_by_name: string; comment: string | null };
      if (p.source_service !== S) return;
      const ctx = { userId: p.decided_by, userName: p.decided_by_name, sessionId: null, ip: null, userAgent: 'approval-workflow' };
      if (p.approval_type === 'party_bank_account') {
        const r1 = await c.query(`
          UPDATE party_bank_accounts SET status = $2, approved_by = $3, decided_at = now(), decision_comment = $4, version = version + 1, updated_at = now()
          WHERE id = $1 AND status = 'pending_approval' RETURNING party_id`,
          [p.ref_id, p.decision === 'approved' ? 'active' : 'rejected', p.decided_by, p.comment]);
        if (r1.rowCount) await audit(c, S, ctx, { entity: 'party_bank_account', entityId: p.ref_id, action: p.decision, approvedBy: p.decided_by, reason: p.comment });
      }
      if (p.approval_type === 'party_sensitive_change') {
        const pc = await one<{ party_id: string; changes: Record<string, unknown>; previous: Record<string, unknown> }>(
          c, `UPDATE pending_changes SET status = $2, decided_by = $3, decided_at = now(), decision_comment = $4 WHERE id = $1 AND status = 'pending' RETURNING *`,
          [p.ref_id, p.decision, p.decided_by, p.comment]);
        if (!pc) return;
        if (p.decision === 'approved') {
          const changes = { ...pc.changes };
          if (typeof changes.gstin === 'string') {
            changes.pan = changes.gstin.slice(2, 12);
            changes.state_code = changes.gstin.slice(0, 2);
          }
          const cols = Object.keys(changes);
          await c.query(
            `UPDATE parties SET ${cols.map((k, i) => `${k} = $${i + 2}`).join(', ')}, version = version + 1, updated_at = now(), updated_by = $${cols.length + 2} WHERE id = $1`,
            [pc.party_id, ...cols.map((k) => changes[k]), p.decided_by],
          );
          await publish(c, S, 'masters.party.changed', { id: pc.party_id, action: 'updated' });
        }
        await audit(c, S, ctx, { entity: 'party', entityId: pc.party_id, action: `sensitive_change_${p.decision}`, before: pc.previous, after: pc.changes, approvedBy: p.decided_by, reason: p.comment });
      }
    },
  };
}
