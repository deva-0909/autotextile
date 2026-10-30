import type { Request, Router } from 'express';
import { z } from 'zod';
import {
  type Client, type ServiceContext, badRequest, callService, conflict, hasPermission, listQuery, many, notFound, notify, one, optText, orderLimit, page, parse, publish, reqText, requirePermission, tx,
} from '@erp/platform';
import {
  S, type Lead, assertOwnerOrAll, auditReq, getParty, leadOrThrow, nextNumber, normEmail, normGstin, normMobile, raiseException, resolveException, seesAll, stateOfCity, userId,
} from './common.ts';
import { assignLead, autoAssign } from './allocation.ts';

export const OPEN_STAGES = ['new', 'assigned', 'contact_pending', 'contacted', 'qualified', 'quotation', 'negotiation', 'order_confirmed', 'nurture'];
const STAGES = [...OPEN_STAGES, 'won', 'lost'] as const;
const CONTACT_KINDS = ['call', 'whatsapp', 'email', 'meeting', 'visit', 'sample'];

export const leadInput = z.object({
  source_id: z.uuid().optional(),
  source_code: z.string().optional(),
  source_ref: optText(120),
  name: z.string().trim().min(2, 'Enter a name').max(120),
  company: optText(160),
  mobile: optText(20),
  email: optText(160),
  gstin: optText(15),
  city: optText(60),
  state_code: optText(2),
  language: optText(30),
  category: optText(60),
  product_id: z.uuid().nullable().optional(),
  product_label: optText(160),
  requirement_kg: z.coerce.number().nonnegative().nullable().optional(),
  est_value: z.coerce.number().nonnegative().nullable().optional(),
  message: optText(2000),
  owner_id: z.uuid().nullable().optional(),
});
type LeadInput = z.infer<typeof leadInput>;

/**
 * Creates a lead from any channel. The same enquiry posted twice by a source is ignored; a contact that
 * matches an open lead or a customer is flagged for review (never merged silently) and goes to the
 * salesperson already handling it.
 */
export async function captureLead(c: Client, input: LeadInput, by: { id: string | null; name: string; canAssign: boolean; selfAssign: boolean }) {
  const src = await one<{ id: string; code: string; name: string; status: string }>(c, `SELECT * FROM lead_sources WHERE ${input.source_id ? 'id = $1' : 'code = upper($1)'}`, [input.source_id ?? input.source_code ?? 'MANUAL']);
  if (!src) throw badRequest('Unknown lead source', { fields: { source_id: 'Choose a source' } });
  if (src.status !== 'active') throw badRequest(`${src.name} is switched off`);
  const mobile = normMobile(input.mobile), email = normEmail(input.email), gstin = normGstin(input.gstin);
  if (!mobile && !email) throw badRequest('Enter a mobile number or an email', { fields: { mobile: 'Mobile or email required' } });
  if (input.source_ref) {
    const existing = await one<{ id: string; number: string }>(c, 'SELECT id, number FROM leads WHERE source_id = $1 AND source_ref = $2', [src.id, input.source_ref]);
    if (existing) return { ...existing, duplicate_of_source: true, created: false };
  }
  const number = await nextNumber(c, 'lead', 'LD-');
  const lead = await one<Lead>(c, `
    INSERT INTO leads (number, source_id, source_code, source_ref, name, company, mobile, email, gstin, city, state_code, language, category, product_id, product_label, requirement_kg, est_value, message, created_by_name)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING *`,
    [number, src.id, src.code, input.source_ref ?? null, input.name, input.company ?? null, mobile, email, gstin, input.city ?? null, input.state_code ?? (gstin ? gstin.slice(0, 2) : null) ?? stateOfCity(input.city), input.language ?? null,
      input.category ?? null, input.product_id ?? null, input.product_label ?? null, input.requirement_kg ?? null, input.est_value ?? null, input.message ?? null, by.name]);
  await c.query('UPDATE lead_sources SET leads_received = leads_received + 1, last_received_at = now() WHERE id = $1', [src.id]);
  await c.query(`INSERT INTO lead_activities (lead_id, kind, summary, by_name) VALUES ($1, 'system', $2, $3)`, [lead!.id, `Enquiry received via ${src.name}`, by.name]);
  const dups = await findDuplicates(c, lead!);
  // Assignment: explicit owner (managers), the creator themselves (salesperson entering their own lead), else the engine.
  if (input.owner_id && by.canAssign) {
    const m = await one<{ user_id: string; name: string }>(c, 'SELECT user_id, name FROM sales_team WHERE user_id = $1 AND active', [input.owner_id]);
    if (!m) throw badRequest('That person is not an active member of the sales team', { fields: { owner_id: 'Choose a salesperson' } });
    await assignLead(c, lead!, m, 'manual', { reason: 'Chosen when the lead was entered', by: by.name });
  } else if (by.selfAssign && by.id && (await one(c, 'SELECT 1 FROM sales_team WHERE user_id = $1 AND active', [by.id]))) {
    await assignLead(c, lead!, { user_id: by.id, name: by.name }, 'manual', { reason: 'Entered by the salesperson', by: by.name });
  } else await autoAssign(c, lead!, by.name);
  await publish(c, S, 'crm.lead.created', { lead_id: lead!.id, number, source: src.code });
  return { id: lead!.id, number, created: true, duplicates: dups };
}

async function findDuplicates(c: Client, lead: Lead) {
  const found: { type: 'lead' | 'customer'; id: string; label: string; on: string[] }[] = [];
  const others = await many<{ id: string; number: string; name: string; company: string | null; mobile: string | null; email: string | null; gstin: string | null }>(c, `
    SELECT id, number, name, company, mobile, email, gstin FROM leads WHERE id <> $1 AND status <> 'merged'
      AND ((mobile IS NOT NULL AND mobile = $2) OR (email IS NOT NULL AND email = $3) OR (gstin IS NOT NULL AND gstin = $4)) ORDER BY created_at DESC LIMIT 10`,
    [lead.id, lead.mobile, lead.email, lead.gstin]);
  for (const o of others)
    found.push({ type: 'lead', id: o.id, label: `${o.number} · ${o.name}${o.company ? `, ${o.company}` : ''}`, on: [o.mobile && o.mobile === lead.mobile ? 'mobile' : '', o.email && o.email === lead.email ? 'email' : '', o.gstin && o.gstin === lead.gstin ? 'gstin' : ''].filter(Boolean) });
  const qs = new URLSearchParams();
  if (lead.gstin) qs.set('gstin', lead.gstin);
  if (lead.mobile) qs.set('phone', lead.mobile);
  if (lead.email) qs.set('email', lead.email);
  const parties = await callService<{ id: string; party_type: string; code: string; legal_name: string; gstin: string | null; phone: string | null; email: string | null }[]>(S, 'masters', 'GET', `/parties/duplicates?${qs}`).catch(() => []);
  for (const p of parties.filter((x) => x.party_type === 'customer'))
    found.push({ type: 'customer', id: p.id, label: `${p.code} · ${p.legal_name}`, on: [p.gstin && p.gstin === lead.gstin ? 'gstin' : '', p.phone && normMobile(p.phone) === lead.mobile ? 'mobile' : '', p.email && p.email.toLowerCase() === lead.email ? 'email' : ''].filter(Boolean) });
  for (const f of found)
    await c.query(`INSERT INTO duplicate_candidates (lead_id, match_type, match_id, match_label, match_on) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`, [lead.id, f.type, f.id, f.label, f.on.length ? f.on : ['contact']]);
  if (found.length) {
    await c.query('UPDATE leads SET duplicate_flag = true WHERE id = $1', [lead.id]);
    // A known customer's enquiry is linked to the account straight away; the flag stays for review.
    const cust = found.find((f) => f.type === 'customer');
    if (cust) await c.query('UPDATE leads SET customer_id = $2, customer_name = $3 WHERE id = $1 AND customer_id IS NULL', [lead.id, cust.id, cust.label.replace(/^[A-Z]+-\d+ · /, '')]);
    const prev = found.find((f) => f.type === 'lead');
    if (prev) await c.query(`INSERT INTO lead_activities (lead_id, kind, summary, by_name) VALUES ($1, 'system', $2, 'system')`, [prev.id, `Repeat enquiry: ${lead.number} from the same contact`]);
    if (cust) lead.customer_id = cust.id;
  }
  return found;
}

/** Reads a dotted path such as "profile.name" from a webhook body. */
const pick = (o: unknown, path: string) => path.split('.').reduce<unknown>((v, k) => (v && typeof v === 'object' ? (v as Record<string, unknown>)[k] : undefined), o);
export function mapFields(raw: Record<string, unknown>, map: Record<string, string>) {
  const out: Record<string, unknown> = {};
  for (const [field, path] of Object.entries(map)) {
    const v = pick(raw, path);
    if (v !== undefined && v !== null && v !== '') out[field] = typeof v === 'string' ? v.trim() : v;
  }
  return out;
}

/** Minimal RFC 4180 CSV reader (quoted fields, escaped quotes, CRLF). */
export function parseCsv(text: string) {
  const rows: string[][] = [];
  let row: string[] = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') q = false; else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((x) => x.trim()));
}

export async function leadDetail(c: Client | import('@erp/platform').Pool, req: Request, id: string) {
  const lead = await leadOrThrow(c, id);
  assertOwnerOrAll(req, lead.owner_id);
  const merged = await many<{ id: string; number: string }>(c, 'SELECT id, number, source_code, created_at FROM leads WHERE merged_into = $1', [lead.id]);
  const ids = [lead.id, ...merged.map((m) => m.id)];
  const [activities, assignments, duplicates, quotations, source] = await Promise.all([
    many(c, `SELECT a.*, l.number AS lead_number FROM lead_activities a JOIN leads l ON l.id = a.lead_id WHERE a.lead_id = ANY($1) ORDER BY a.at DESC`, [ids]),
    many(c, 'SELECT * FROM lead_assignments WHERE lead_id = $1 ORDER BY at DESC', [lead.id]),
    many(c, `SELECT * FROM duplicate_candidates WHERE lead_id = $1 OR (match_type = 'lead' AND match_id = $1) ORDER BY created_at DESC`, [lead.id]),
    many(c, `SELECT id, number, version, status, total, kg, margin_pct, valid_until, created_at FROM quotations WHERE lead_id = ANY($1) AND status <> 'superseded' ORDER BY created_at DESC`, [ids]),
    one(c, 'SELECT code, name, kind FROM lead_sources WHERE id = $1', [lead.source_id]),
  ]);
  return { ...lead, source, merged_leads: merged, activities, assignments, duplicates, quotations };
}

const stageBody = z.object({
  stage: z.enum(STAGES),
  next_action_at: z.iso.datetime({ offset: true }).nullable().optional(),
  next_action: optText(200),
  lost_reason: optText(300),
  competitor: optText(120),
  nurture_reason: optText(300),
  note: optText(1000),
});

export function leadRoutes(r: Router, { pool }: ServiceContext) {
  /** Webhook for lead sources (IndiaMART, Meta, website…). The key in the URL identifies and authorises the source. */
  r.get('/leads', requirePermission('crm.read'), async (req, res) => {
    const lq = listQuery(req, ['number', 'created_at', 'name', 'stage', 'next_action_at', 'est_value', 'owner_name'], 'created_at');
    const params: unknown[] = [];
    const where: string[] = [`l.status <> 'merged'`];
    if (!seesAll(req)) { params.push(req.user!.id); where.push(`l.owner_id = $${params.length}`); }
    if (lq.filters.stage) { params.push(lq.filters.stage.split(',')); where.push(`l.stage = ANY($${params.length})`); }
    if (lq.filters.source) { params.push(lq.filters.source.split(',')); where.push(`l.source_code = ANY($${params.length})`); }
    if (lq.filters.owner) { if (lq.filters.owner === 'none') where.push('l.owner_id IS NULL'); else { params.push(lq.filters.owner === 'me' ? req.user!.id : lq.filters.owner); where.push(`l.owner_id = $${params.length}`); } }
    if (lq.filters.view === 'overdue') where.push(`l.status = 'open' AND l.stage <> 'nurture' AND (l.next_action_at IS NULL OR l.next_action_at < now())`);
    if (lq.filters.view === 'duplicates') where.push(`EXISTS (SELECT 1 FROM duplicate_candidates d WHERE d.lead_id = l.id AND d.status = 'open')`);
    if (lq.filters.view === 'open') where.push(`l.status = 'open'`);
    if (lq.filters.customer) { params.push(lq.filters.customer); where.push(`l.customer_id = $${params.length}`); }
    if (lq.q) { params.push(`%${lq.q}%`); where.push(`(l.number ILIKE $${params.length} OR l.name ILIKE $${params.length} OR l.company ILIKE $${params.length} OR l.mobile ILIKE $${params.length} OR l.email ILIKE $${params.length} OR l.city ILIKE $${params.length})`); }
    const rows = await many<{ total_count: number }>(pool, `
      SELECT l.*, s.name AS source_name,
        (SELECT count(*)::int FROM duplicate_candidates d WHERE d.lead_id = l.id AND d.status = 'open') AS open_duplicates,
        (l.status = 'open' AND l.stage <> 'nurture' AND (l.next_action_at IS NULL OR l.next_action_at < now())) AS follow_up_due,
        count(*) OVER ()::int AS total_count
      FROM leads l JOIN lead_sources s ON s.id = l.source_id WHERE ${where.join(' AND ')} ${orderLimit({ ...lq, dir: req.query.dir ? lq.dir : 'desc' }, params)}`, params);
    res.json(page(rows, lq));
  });

  r.get('/leads/:id', requirePermission('crm.read'), async (req, res) => {
    res.json(await leadDetail(pool, req, String(req.params.id)));
  });

  r.post('/leads', requirePermission('crm.lead.manage'), async (req, res) => {
    const b = parse(leadInput, req.body);
    const canAssign = hasPermission(req.user, 'crm.lead.assign');
    const out = await tx(pool, async (c) => {
      const o = await captureLead(c, b, { id: userId(req), name: req.user!.name, canAssign, selfAssign: !canAssign });
      await auditReq(c, req, 'lead', o.id, 'created', { after: { number: o.number, name: b.name, source: b.source_code ?? b.source_id } });
      return o;
    });
    res.status(201).json(out);
  });

  /** Bulk import from a CSV export (exhibition lists, trade platforms). `mapping` maps lead fields to CSV headers. */
  r.post('/leads/import', requirePermission('crm.lead.assign'), async (req, res) => {
    const b = parse(z.object({ source_id: z.uuid(), csv: z.string().min(5).max(2_000_000), mapping: z.record(z.string(), z.string()) }), req.body);
    const rows = parseCsv(b.csv);
    if (rows.length < 2) throw badRequest('The file needs a header row and at least one lead');
    const header = rows[0].map((h) => h.trim().toLowerCase());
    const col = (name: string) => header.indexOf(name.trim().toLowerCase());
    const missing = Object.entries(b.mapping).filter(([, h]) => col(h) < 0).map(([, h]) => h);
    if (missing.length) throw badRequest(`Column(s) not found in the file: ${missing.join(', ')}`);
    const result = { created: 0, skipped: 0, duplicates: 0, errors: [] as { row: number; error: string }[] };
    for (const [i, row] of rows.slice(1).entries()) {
      const raw: Record<string, unknown> = { source_id: b.source_id };
      for (const [field, h] of Object.entries(b.mapping)) raw[field] = row[col(h)]?.trim() || null;
      try {
        const input = parse(leadInput, raw);
        await tx(pool, async (c) => {
          const o = await captureLead(c, input, { id: userId(req), name: req.user!.name, canAssign: true, selfAssign: false });
          if (!o.created) result.skipped++; else { result.created++; if (o.duplicates?.length) result.duplicates++; }
        });
      } catch (e) {
        result.errors.push({ row: i + 2, error: (e as Error).message });
      }
    }
    await tx(pool, (c) => auditReq(c, req, 'lead_import', b.source_id, 'imported', { after: { ...result, errors: result.errors.length } }));
    res.json(result);
  });

  r.post('/leads/:id/activities', requirePermission('crm.lead.manage'), async (req, res) => {
    const b = parse(z.object({
      kind: z.enum(['note', 'call', 'whatsapp', 'email', 'meeting', 'visit', 'sample']), summary: reqText(1000), outcome: optText(300),
      next_action_at: z.iso.datetime({ offset: true }).nullable().optional(), next_action: optText(200),
    }), req.body);
    await tx(pool, async (c) => {
      const lead = await leadOrThrow(c, String(req.params.id), true);
      assertOwnerOrAll(req, lead.owner_id);
      if (lead.status !== 'open') throw conflict(`This lead is ${lead.status}`);
      await c.query(`INSERT INTO lead_activities (lead_id, kind, summary, outcome, by_user, by_name) VALUES ($1,$2,$3,$4,$5,$6)`, [lead.id, b.kind, b.summary, b.outcome ?? null, userId(req), req.user!.name]);
      const contact = CONTACT_KINDS.includes(b.kind);
      await c.query(`UPDATE leads SET
          first_response_at = CASE WHEN $2 AND first_response_at IS NULL THEN now() ELSE first_response_at END,
          stage = CASE WHEN $2 AND stage IN ('new','assigned','contact_pending') THEN 'contacted' ELSE stage END,
          next_action_at = coalesce($3, next_action_at), next_action = coalesce($4, next_action), updated_at = now(), version = version + 1 WHERE id = $1`,
        [lead.id, contact, b.next_action_at ?? null, b.next_action ?? null]);
      if (contact) await resolveException(c, 'first_response_breach', lead.id, 'Contacted');
      if (b.next_action_at) await resolveException(c, 'followup_overdue', lead.id, 'Follow-up scheduled');
    });
    res.status(201).json({ ok: true });
  });

  /** Move a lead through the pipeline. Every open lead must have a next follow-up; closing needs a reason. */
  r.post('/leads/:id/stage', requirePermission('crm.lead.manage'), async (req, res) => {
    const b = parse(stageBody, req.body);
    const out = await tx(pool, async (c) => {
      const lead = await leadOrThrow(c, String(req.params.id), true);
      assertOwnerOrAll(req, lead.owner_id);
      if (lead.status === 'merged') throw conflict('This lead was merged into another');
      if (!lead.owner_id && !['lost'].includes(b.stage)) throw conflict('Assign the lead before working it');
      if (b.stage === 'lost' && !b.lost_reason) throw badRequest('Give the reason the lead was lost', { fields: { lost_reason: 'Required' } });
      if (b.stage === 'nurture' && !b.nurture_reason) throw badRequest('Say why the lead is parked for nurturing', { fields: { nurture_reason: 'Required' } });
      const open = OPEN_STAGES.includes(b.stage);
      const next = b.next_action_at ?? (open && lead.next_action_at && new Date(lead.next_action_at) > new Date() ? lead.next_action_at : null);
      if (open && !next) throw badRequest('Set the next follow-up date', { fields: { next_action_at: 'Required for an open lead' } });
      if (b.stage === 'won' && !lead.customer_id) throw conflict('Convert the lead to a customer before marking it won');
      const status = open ? 'open' : 'closed';
      await c.query(`UPDATE leads SET stage = $2, status = $3, next_action_at = $4, next_action = coalesce($5, next_action), lost_reason = $6, competitor = coalesce($7, competitor), nurture_reason = $8,
          first_response_at = CASE WHEN $2 NOT IN ('new','assigned','contact_pending') AND first_response_at IS NULL THEN now() ELSE first_response_at END,
          closed_at = CASE WHEN $3 = 'closed' THEN now() END, updated_at = now(), version = version + 1 WHERE id = $1`,
        [lead.id, b.stage, status, open ? next : null, b.next_action ?? null, b.stage === 'lost' ? b.lost_reason : null, b.competitor ?? null, b.stage === 'nurture' ? b.nurture_reason : null]);
      await c.query(`INSERT INTO lead_activities (lead_id, kind, summary, outcome, by_user, by_name) VALUES ($1, 'stage', $2, $3, $4, $5)`,
        [lead.id, `${lead.stage.replace(/_/g, ' ')} → ${b.stage.replace(/_/g, ' ')}`, b.lost_reason ?? b.nurture_reason ?? b.note ?? null, userId(req), req.user!.name]);
      if (!open) for (const k of ['followup_overdue', 'first_response_breach']) await resolveException(c, k, lead.id, `Lead ${b.stage}`);
      if (next) await resolveException(c, 'followup_overdue', lead.id, 'Follow-up scheduled');
      await auditReq(c, req, 'lead', lead.id, 'stage_changed', { before: { stage: lead.stage }, after: { stage: b.stage, next_action_at: next }, reason: b.lost_reason ?? b.nurture_reason ?? b.note });
      return { stage: b.stage, status };
    });
    res.json(out);
  });

  /** Assign or reassign. The history keeps who had it, who moved it and why. */
  r.post('/leads/:id/assign', requirePermission('crm.lead.assign'), async (req, res) => {
    const b = parse(z.object({ user_id: z.uuid().nullable().optional(), auto: z.boolean().default(false), reason: optText(300) }), req.body);
    const out = await tx(pool, async (c) => {
      const lead = await leadOrThrow(c, String(req.params.id), true);
      if (lead.status !== 'open') throw conflict(`This lead is ${lead.status}`);
      if (b.auto) {
        const d = await autoAssign(c, lead, req.user!.name);
        return { owner: d.owner?.name ?? null, note: d.note };
      }
      if (!b.user_id) throw badRequest('Choose a salesperson');
      if (lead.owner_id && !b.reason) throw badRequest('Give a reason for reassigning', { fields: { reason: 'Required' } });
      const m = await one<{ user_id: string; name: string; active: boolean }>(c, 'SELECT user_id, name, active FROM sales_team WHERE user_id = $1', [b.user_id]);
      if (!m?.active) throw badRequest('That person is not an active member of the sales team');
      if (m.user_id === lead.owner_id) throw badRequest(`${m.name} already owns this lead`);
      await assignLead(c, lead, m, lead.owner_id ? 'reassign' : 'manual', { reason: b.reason, by: req.user!.name });
      await auditReq(c, req, 'lead', lead.id, lead.owner_id ? 'reassigned' : 'assigned', { before: { owner: lead.owner_name }, after: { owner: m.name }, reason: b.reason });
      return { owner: m.name };
    });
    res.json(out);
  });

  /** Create the customer in master data from the lead, or link an existing customer. */
  r.post('/leads/:id/convert', requirePermission('crm.lead.manage'), async (req, res) => {
    const b = parse(z.object({ customer_id: z.uuid().nullable().optional(), legal_name: optText(200), gstin: optText(15), state_code: optText(2) }), req.body);
    const lead = await leadOrThrow(pool, String(req.params.id));
    assertOwnerOrAll(req, lead.owner_id);
    if (lead.customer_id && !b.customer_id) throw conflict(`Already linked to ${lead.customer_name}`);
    let customer: { id: string; legal_name: string };
    if (b.customer_id) {
      const p = await getParty(b.customer_id).catch(() => null);
      if (!p || p.party_type !== 'customer') throw badRequest('Choose a customer');
      customer = p;
    } else {
      if (!hasPermission(req.user, 'masters.customer.manage')) throw badRequest('You cannot create customers; ask a manager or link an existing customer');
      const gstin = normGstin(b.gstin ?? lead.gstin);
      customer = await callService<{ id: string; legal_name: string }>(S, 'masters', 'POST', '/parties', {
        party_type: 'customer', legal_name: b.legal_name ?? lead.company ?? lead.name, gst_treatment: gstin ? 'registered' : 'unregistered', gstin,
        state_code: b.state_code ?? lead.state_code, phone: lead.mobile, email: lead.email, owner_user_id: lead.owner_id, segment: lead.category, tags: [`lead:${lead.number}`],
        notes: `Created from lead ${lead.number} (${lead.source_code})`,
      });
    }
    await tx(pool, async (c) => {
      await c.query('UPDATE leads SET customer_id = $2, customer_name = $3, updated_at = now() WHERE id = $1', [lead.id, customer.id, customer.legal_name]);
      await c.query(`UPDATE duplicate_candidates SET status = 'linked', decided_by_name = $3, decided_at = now() WHERE lead_id = $1 AND match_type = 'customer' AND match_id = $2 AND status = 'open'`, [lead.id, customer.id, req.user!.name]);
      await c.query(`INSERT INTO lead_activities (lead_id, kind, summary, by_user, by_name) VALUES ($1, 'system', $2, $3, $4)`, [lead.id, `${b.customer_id ? 'Linked to' : 'Converted to customer'} ${customer.legal_name}`, userId(req), req.user!.name]);
      await auditReq(c, req, 'lead', lead.id, 'converted', { after: { customer_id: customer.id, customer: customer.legal_name } });
    });
    res.json({ customer_id: customer.id, customer_name: customer.legal_name });
  });

  // ---------- duplicates: merge, link, keep separate or escalate (never deleted) ----------
  r.get('/duplicates', requirePermission('crm.lead.assign'), async (_req, res) => {
    res.json(await many(pool, `
      SELECT d.*, l.number, l.name, l.company, l.mobile, l.email, l.source_code, l.owner_name, l.created_at AS lead_created_at
      FROM duplicate_candidates d JOIN leads l ON l.id = d.lead_id WHERE d.status IN ('open','escalated') ORDER BY d.created_at DESC LIMIT 300`));
  });

  r.post('/duplicates/:id/resolve', requirePermission('crm.lead.assign'), async (req, res) => {
    const b = parse(z.object({ action: z.enum(['merge', 'link', 'keep_separate', 'escalate']), note: optText(500) }), req.body);
    const out = await tx(pool, async (c) => {
      const d = await one<{ id: string; lead_id: string; match_type: string; match_id: string; match_label: string; status: string }>(c, 'SELECT * FROM duplicate_candidates WHERE id = $1 FOR UPDATE', [req.params.id]);
      if (!d) throw notFound('Duplicate');
      if (!['open', 'escalated'].includes(d.status)) throw conflict(`Already ${d.status.replace('_', ' ')}`);
      const lead = await leadOrThrow(c, d.lead_id, true);
      if (b.action === 'merge') {
        if (d.match_type !== 'lead') throw badRequest('Only two leads can be merged; link a customer instead');
        const target = await leadOrThrow(c, d.match_id, true);
        if (target.status === 'merged') throw conflict(`${target.number} was itself merged; resolve against the surviving lead`);
        // The newer lead folds into the surviving one: it stays readable, its activities show on the survivor.
        await c.query(`UPDATE leads SET status = 'merged', merged_into = $2, closed_at = now(), next_action_at = NULL, updated_at = now() WHERE id = $1`, [lead.id, target.id]);
        await c.query(`UPDATE leads SET message = concat_ws(E'\n---\n', message, $2::text), requirement_kg = coalesce(requirement_kg, $3), est_value = greatest(est_value, $4), updated_at = now() WHERE id = $1`,
          [target.id, lead.message ? `${lead.number}: ${lead.message}` : null, lead.requirement_kg, lead.est_value]);
        await c.query(`INSERT INTO lead_activities (lead_id, kind, summary, outcome, by_user, by_name) VALUES ($1, 'merge', $2, $3, $4, $5)`, [target.id, `${lead.number} (${lead.source_code}) merged into this lead`, b.note ?? null, userId(req), req.user!.name]);
        for (const k of ['followup_overdue', 'first_response_breach', 'unassigned_lead']) await resolveException(c, k, lead.id, `Merged into ${target.number}`);
      } else if (b.action === 'link') {
        if (d.match_type !== 'customer') throw badRequest('Link applies to a matching customer');
        await c.query('UPDATE leads SET customer_id = $2, customer_name = $3, updated_at = now() WHERE id = $1', [lead.id, d.match_id, d.match_label.replace(/^[A-Z]+-\d+ · /, '')]);
      } else if (b.action === 'escalate') {
        await notify(c, S, { audience_permission: 'crm.lead.read_all', kind: 'action', title: `Possible duplicate needs a decision: ${lead.number} ↔ ${d.match_label}`, body: b.note ?? null, link: `/crm/leads/${lead.id}` });
      }
      const status = { merge: 'merged', link: 'linked', keep_separate: 'kept_separate', escalate: 'escalated' }[b.action];
      await c.query(`UPDATE duplicate_candidates SET status = $2, decided_by_name = $3, decided_at = now(), note = $4 WHERE id = $1`, [d.id, status, req.user!.name, b.note ?? null]);
      const left = await one<{ n: number }>(c, `SELECT count(*)::int AS n FROM duplicate_candidates WHERE lead_id = $1 AND status IN ('open','escalated')`, [lead.id]);
      if (!left!.n) await c.query('UPDATE leads SET duplicate_flag = false WHERE id = $1', [lead.id]);
      await auditReq(c, req, 'lead', lead.id, `duplicate_${b.action}`, { after: { match: d.match_label }, reason: b.note });
      return { status };
    });
    res.json(out);
  });

  r.get('/exceptions', requirePermission('crm.read'), async (req, res) => {
    const params: unknown[] = [(req.query.status as string) ?? 'open'];
    let mine = '';
    if (!seesAll(req)) { params.push(req.user!.id); mine = ` AND (ref_type <> 'lead' OR ref_id IN (SELECT id FROM leads WHERE owner_id = $2))`; }
    res.json(await many(pool, `SELECT * FROM exceptions WHERE status = $1${mine} ORDER BY detected_at DESC LIMIT 300`, params));
  });
}

/** Public, unauthenticated webhook for integrations. */
export function publicLeadRoutes(r: Router, { pool }: ServiceContext) {
  r.post('/public/leads/:key', async (req, res) => {
    const src = await one<{ id: string; code: string; status: string; field_map: Record<string, string> }>(pool, 'SELECT * FROM lead_sources WHERE webhook_key = $1', [req.params.key]);
    if (!src || src.status !== 'active') throw notFound('Lead source');
    const body = (req.body ?? {}) as Record<string, unknown>;
    // Some platforms post a batch.
    const items = Array.isArray(body) ? body : Array.isArray(body.leads) ? (body.leads as Record<string, unknown>[]) : [body];
    const results = [];
    for (const raw of items.slice(0, 100)) {
      const mapped = Object.keys(src.field_map).length ? mapFields(raw, src.field_map) : raw;
      try {
        const input = parse(leadInput, { ...mapped, source_id: src.id, name: mapped.name ?? mapped.company ?? 'Unknown', source_ref: mapped.source_ref != null ? String(mapped.source_ref) : null });
        const o = await tx(pool, (c) => captureLead(c, input, { id: null, name: `${src.code} webhook`, canAssign: false, selfAssign: false }));
        results.push({ number: o.number, created: o.created });
      } catch (e) {
        await tx(pool, (c) => raiseException(c, { kind: 'webhook_rejected', severity: 'info', ref_type: 'source', ref_id: src.id, ref_label: src.code, message: `${src.code} lead rejected: ${(e as Error).message}`, notifyPermission: 'crm.config.manage' })).catch(() => {});
        results.push({ error: (e as Error).message });
      }
    }
    res.status(results.some((x) => 'created' in x) ? 201 : 422).json({ results });
  });
}
