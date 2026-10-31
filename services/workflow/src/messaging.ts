import crypto from 'node:crypto';
import type { Router } from 'express';
import { z } from 'zod';
import { type BusEvent, type Client, type Pool, type ServiceContext, badRequest, callService, conflict, many, notFound, one, optText, parse, reqText, requirePermission, tx } from '@erp/platform';
import { auditReq, companyName, fmtDay, fmtMoney, getParty, publicUrl, requestApproval } from './common.ts';

/** Variables each trigger provides to templates. Templates may only use these. */
export const EVENT_VARIABLES: Record<string, string[]> = {
  'crm.lead.created': ['contact_name', 'lead_no', 'company'],
  'crm.quotation.sent': ['customer_name', 'quotation_no', 'amount', 'valid_until', 'owner_name', 'company'],
  'crm.quotation.accepted': ['customer_name', 'quotation_no', 'amount', 'company'],
  'commerce.order.booked': ['customer_name', 'order_no', 'reserved_until', 'company'],
  'commerce.payment.link_created': ['customer_name', 'amount', 'reference', 'link', 'expires_at', 'company'],
  'fulfilment.invoiced': ['customer_name', 'invoice_no', 'amount', 'order_no', 'portal_link', 'company'],
  'commerce.payment.received': ['customer_name', 'amount', 'utr', 'company'],
  'fulfilment.dispatched': ['customer_name', 'order_no', 'warehouse', 'transporter', 'lr_number', 'eta', 'tracking_link', 'company'],
  'fulfilment.delivered': ['customer_name', 'order_no', 'condition', 'company'],
  'commerce.complaint.raised': ['customer_name', 'complaint_no', 'subject', 'company'],
  'finance.payment.reminder_due': ['customer_name', 'invoice_no', 'amount', 'due_date', 'days_overdue', 'company'],
  'hrms.leave.approved': ['employee_name', 'from', 'to', 'days', 'leave_type', 'company'],
  'hrms.employee.exiting': ['employee_name', 'last_working_day', 'reason', 'company'],
};

export interface Recipient { party_id: string | null; name: string; phone: string | null; email: string | null }
export interface EventContext { vars: Record<string, unknown>; recipients: Recipient[]; ref: { type: string; id: string; label: string; link: string | null } }

const partyRecipient = async (id: string | null | undefined): Promise<Recipient[]> => {
  if (!id) return [];
  const p = await getParty(id).catch(() => null);
  return p ? [{ party_id: p.id, name: p.legal_name, phone: p.phone, email: p.email }] : [];
};

/** Turn a business event into template variables, recipients and a reference. Lookups go to the owning services. */
export async function contextFor(type: string, p: Record<string, any>): Promise<EventContext> {
  const company = await companyName();
  const base = { company, ...p };
  switch (type) {
    case 'crm.lead.created': {
      const l = await callService<{ name: string; company: string | null; mobile: string | null; email: string | null; number: string }>('workflow', 'crm', 'GET', `/leads/${p.lead_id}`).catch(() => null);
      return { vars: { ...base, contact_name: l?.name ?? 'there', lead_no: p.number }, recipients: l ? [{ party_id: null, name: l.name, phone: l.mobile, email: l.email }] : [], ref: { type: 'lead', id: p.lead_id, label: String(p.number), link: `/crm/leads/${p.lead_id}` } };
    }
    case 'crm.quotation.sent': case 'crm.quotation.accepted': {
      const q = await callService<{ owner_id: string | null; owner_name: string | null; customer_name: string | null; prospect_name: string | null; customer_id: string | null; lead: { name: string } | null }>('workflow', 'crm', 'GET', `/quotations/${p.quotation_id}`).catch(() => null);
      const rec = await partyRecipient(p.customer_id ?? q?.customer_id);
      return { vars: { ...base, owner_id: p.owner_id ?? q?.owner_id, owner_name: p.owner_name ?? q?.owner_name ?? '', customer_name: q?.customer_name ?? q?.prospect_name ?? p.prospect_name ?? rec[0]?.name ?? '', quotation_no: p.number, amount: fmtMoney(p.total), total: Number(p.total), valid_until: fmtDay(p.valid_until) }, recipients: rec, ref: { type: 'quotation', id: p.quotation_id, label: String(p.number), link: `/crm/quotations/${p.quotation_id}` } };
    }
    case 'commerce.order.booked': {
      const rec = await partyRecipient(p.customer_id);
      return { vars: { ...base, customer_name: rec[0]?.name ?? '', order_no: p.number, reserved_until: fmtDay(p.reserve_until) }, recipients: rec, ref: { type: 'sales_order', id: p.order_id, label: String(p.number), link: `/commerce/orders/${p.order_id}` } };
    }
    case 'commerce.payment.link_created': {
      const rec = await partyRecipient(p.customer_id);
      return { vars: { ...base, customer_name: p.customer_name, amount: fmtMoney(p.amount), reference: p.ref_no ?? p.number, link: `${publicUrl()}/pay/${p.link_token}`, expires_at: new Date(p.expires_at).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) }, recipients: rec, ref: { type: 'payment', id: p.payment_id, label: String(p.number), link: '/commerce/payments' } };
    }
    case 'fulfilment.invoiced': {
      const rec = await partyRecipient(p.customer_id);
      const inv = await callService<{ order_no: string }>('workflow', 'fulfilment', 'GET', `/invoices/${p.fulfilment_id}`).catch(() => null);
      return { vars: { ...base, customer_name: p.customer_name ?? rec[0]?.name ?? '', invoice_no: p.invoice_no, amount: fmtMoney(p.total), order_no: inv?.order_no ?? '', portal_link: `${publicUrl()}/portal/invoices/${p.fulfilment_id}` }, recipients: rec, ref: { type: 'invoice', id: p.fulfilment_id, label: String(p.invoice_no), link: `/fulfilment/invoices/${p.fulfilment_id}` } };
    }
    case 'commerce.payment.received': {
      const rec = await partyRecipient(p.customer_id);
      return { vars: { ...base, customer_name: p.customer_name ?? rec[0]?.name ?? '', amount: fmtMoney(p.amount), utr: p.utr ?? '—' }, recipients: rec, ref: { type: 'payment', id: p.payment_id, label: String(p.number ?? ''), link: '/commerce/payments' } };
    }
    case 'fulfilment.dispatched': case 'fulfilment.delivered': {
      const s = await callService<{ customer_id: string; customer_name: string; order_no: string; warehouse_name: string; transporter_name: string; lr_number: string | null; eta_date: string | null; tracking_token: string; number: string }>('workflow', 'fulfilment', 'GET', `/shipments/${p.shipment_id}`).catch(() => null);
      const rec = await partyRecipient(s?.customer_id);
      return { vars: { ...base, customer_name: s?.customer_name ?? '', order_no: s?.order_no ?? '', warehouse: s?.warehouse_name ?? '', transporter: s?.transporter_name ?? '', lr_number: s?.lr_number ?? '—', eta: fmtDay(s?.eta_date), tracking_link: s ? `${publicUrl()}/track/${s.tracking_token}` : '', condition: p.condition ?? 'good' }, recipients: rec, ref: { type: 'shipment', id: p.shipment_id, label: s?.number ?? '', link: `/fulfilment/shipments/${p.shipment_id}` } };
    }
    case 'commerce.complaint.raised': {
      const rec = await partyRecipient(p.customer_id);
      return { vars: { ...base, customer_name: p.customer_name, complaint_no: p.number, subject: p.subject }, recipients: rec, ref: { type: 'complaint', id: p.complaint_id, label: String(p.number), link: '/commerce/complaints' } };
    }
    case 'finance.payment.reminder_due': {
      const rec = await partyRecipient(p.party_id);
      return { vars: { ...base, customer_name: p.party_name, invoice_no: p.doc_no, amount: fmtMoney(p.outstanding), due_date: fmtDay(p.due_date), days_overdue: Number(p.days_overdue) }, recipients: rec, ref: { type: 'invoice', id: String(p.bill_id), label: String(p.doc_no), link: `/finance/receivables/${p.party_id}` } };
    }
    case 'hrms.leave.approved': case 'hrms.employee.exiting':
      return { vars: { ...base, user_id: p.user_id, from: fmtDay(p.from), to: fmtDay(p.to), last_working_day: fmtDay(p.last_working_day), days: p.days }, recipients: [], ref: { type: 'employee', id: String(p.employee_id), label: String(p.employee_name), link: `/hr/employees/${p.employee_id}` } };
    default:
      return { vars: base, recipients: [], ref: { type: type.split('.')[1] ?? 'event', id: String(p.id ?? ''), label: type, link: null } };
  }
}

export function render(text: string, vars: Record<string, unknown>) {
  return text.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (_m, k: string) => (vars[k] === undefined || vars[k] === null ? '' : String(vars[k])));
}
const usedVars = (text: string) => [...new Set([...text.matchAll(/\{\{\s*([a-z_]+)\s*\}\}/g)].map((m) => m[1]!))];

interface Template { id: string; code: string; channel: 'whatsapp' | 'sms' | 'email'; category: string; subject: string | null; body: string; provider_template: string | null; provider_status: string }

/** Queue messages for every active template on this event, honouring consent and WhatsApp template approval. */
export async function enqueueForEvent(c: Client, ev: { id: number | null; type: string }, ctx: EventContext, only?: string) {
  const temps = await many<Template>(c, `SELECT * FROM templates WHERE status = 'active' AND event_type = $1 ${only ? 'AND code = $2' : ''}`, only ? [ev.type, only] : [ev.type]);
  let queued = 0;
  for (const t of temps) {
    for (const r of ctx.recipients) {
      const address = t.channel === 'email' ? r.email : r.phone;
      if (!address) continue;
      const scope = t.category === 'marketing' ? 'marketing' : 'transactional';
      const consent = await one<{ status: string }>(c, `SELECT status FROM consents WHERE address = $1 AND channel = $2 AND scope = $3`, [address, t.channel, scope]);
      let skip: string | null = null;
      // WhatsApp and SMS need an opt-in; email for a transaction already under way does not, unless the customer opted out.
      if (consent?.status === 'opted_out') skip = 'Recipient opted out';
      else if (t.channel !== 'email' && consent?.status !== 'opted_in') skip = 'No opt-in recorded for this number';
      else if (t.channel === 'email' && scope === 'marketing' && consent?.status !== 'opted_in') skip = 'No marketing consent';
      if (!skip && t.channel === 'whatsapp' && t.provider_status !== 'approved') skip = 'WhatsApp template not approved by Meta';
      const r1 = await c.query(`INSERT INTO messages (event_id, event_type, template_id, template_code, channel, party_id, to_name, to_address, ref_type, ref_id, ref_label, subject, body, status, skip_reason)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) ON CONFLICT (event_id, template_code, to_address) WHERE event_id IS NOT NULL DO NOTHING`,
      [ev.id, ev.type, t.id, t.code, t.channel, r.party_id, r.name, address, ctx.ref.type, ctx.ref.id, ctx.ref.label, t.subject ? render(t.subject, ctx.vars) : null, render(t.body, ctx.vars), skip ? 'skipped' : 'queued', skip]);
      if (r1.rowCount && !skip) queued++;
    }
  }
  return queued;
}

// ---------- providers ----------
export interface SendResult { ok: boolean; id?: string; error?: string; delivered?: boolean }
export function provider(): { name: string; send: (m: { channel: string; to: string; subject: string | null; body: string; template: string | null }) => Promise<SendResult> } {
  const mode = process.env.MESSAGING_PROVIDER ?? 'sandbox';
  if (mode === 'sandbox') {
    return {
      name: 'sandbox',
      // Stands in for WhatsApp, SMS and email until provider credentials exist. Addresses containing "invalid" fail.
      send: async (m) => (/invalid/i.test(m.to) || (m.channel !== 'email' && m.to.replace(/\D/g, '').length < 10) ? { ok: false, error: 'Recipient not reachable (sandbox)' } : { ok: true, id: `SBX-${crypto.randomBytes(6).toString('hex')}`, delivered: true }),
    };
  }
  return {
    name: 'live',
    send: async (m) => {
      if (m.channel === 'whatsapp') {
        const token = process.env.WHATSAPP_TOKEN, phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID;
        if (!token || !phoneId) return { ok: false, error: 'WhatsApp Cloud API credentials are not configured' };
        // Free-form text is shown for the template; production sends the approved template with parameters.
        const r = await fetch(`https://graph.facebook.com/v20.0/${phoneId}/messages`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ messaging_product: 'whatsapp', to: m.to.replace(/\D/g, ''), type: 'text', text: { body: m.body } }) }).catch((e) => ({ ok: false, json: async () => ({ error: { message: (e as Error).message } }) }));
        const j = (await r.json().catch(() => ({}))) as { messages?: { id: string }[]; error?: { message: string } };
        return r.ok && j.messages?.[0] ? { ok: true, id: j.messages[0].id } : { ok: false, error: j.error?.message ?? 'WhatsApp send failed' };
      }
      return { ok: false, error: `${m.channel.toUpperCase()} provider is not configured` };
    },
  };
}
const BACKOFF_MIN = [1, 5, 15, 60, 240];
export const MAX_ATTEMPTS = 5;

/** Send queued messages that are due. Failures retry with backoff; after five attempts the message is failed and visible in the log. */
export async function dispatchMessages(pool: Pool) {
  const pv = provider();
  let sent = 0, failed = 0;
  for (let batch = 0; batch < 10; batch++) {
    const done = await tx(pool, async (c) => {
      const due = await many<{ id: string; channel: string; to_address: string; subject: string | null; body: string; attempts: number; template_id: string }>(c,
        `SELECT m.* FROM messages m WHERE status = 'queued' AND next_attempt_at <= now() ORDER BY next_attempt_at LIMIT 25 FOR UPDATE SKIP LOCKED`);
      for (const m of due) {
        const t = await one<{ provider_template: string | null }>(c, 'SELECT provider_template FROM templates WHERE id = $1', [m.template_id]);
        const r = await pv.send({ channel: m.channel, to: m.to_address, subject: m.subject, body: m.body, template: t?.provider_template ?? null });
        const attempts = m.attempts + 1;
        if (r.ok) {
          sent++;
          await c.query(`UPDATE messages SET status = $2, attempts = $3, provider = $4, provider_message_id = $5, sent_at = now(), delivered_at = CASE WHEN $6 THEN now() END, error = NULL WHERE id = $1`, [m.id, r.delivered ? 'delivered' : 'sent', attempts, pv.name, r.id, !!r.delivered]);
          await c.query(`INSERT INTO message_events (message_id, kind, detail) VALUES ($1, $2, $3)`, [m.id, r.delivered ? 'delivered' : 'sent', JSON.stringify({ provider: pv.name, id: r.id })]);
        } else {
          failed++;
          const final = attempts >= MAX_ATTEMPTS;
          await c.query(`UPDATE messages SET status = $2, attempts = $3, provider = $4, error = $5, next_attempt_at = now() + make_interval(mins => $6) WHERE id = $1`, [m.id, final ? 'failed' : 'queued', attempts, pv.name, r.error, BACKOFF_MIN[Math.min(attempts - 1, BACKOFF_MIN.length - 1)]]);
          await c.query(`INSERT INTO message_events (message_id, kind, detail) VALUES ($1, $2, $3)`, [m.id, final ? 'failed' : 'retry_scheduled', JSON.stringify({ error: r.error, attempt: attempts })]);
        }
      }
      return due.length;
    });
    if (done < 25) break;
  }
  return { sent, failed };
}

export const webhookSecret = () => process.env.MESSAGING_WEBHOOK_SECRET ?? 'dev-messaging-webhook-secret';
export const signWebhook = (raw: string) => crypto.createHmac('sha256', webhookSecret()).update(raw).digest('hex');

export function messagingPublicRoutes(r: Router, { pool }: ServiceContext) {
  /** Provider delivery receipts (delivered, read, failed). Signed with HMAC-SHA256 of the raw body. */
  r.post('/public/messages/status', async (req, res) => {
    const raw = (req as unknown as { rawBody?: Buffer }).rawBody?.toString('utf8') ?? JSON.stringify(req.body);
    const sig = String(req.headers['x-signature'] ?? '');
    const expected = signWebhook(raw);
    if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) { res.status(401).json({ error: { code: 'bad_signature', message: 'Signature check failed' } }); return; }
    const b = parse(z.object({ provider_message_id: z.string(), status: z.enum(['delivered', 'read', 'failed']), error: z.string().optional() }), req.body);
    await tx(pool, async (c) => {
      const m = await one<{ id: string; status: string }>(c, 'SELECT id, status FROM messages WHERE provider_message_id = $1 FOR UPDATE', [b.provider_message_id]);
      if (!m) return;
      const order = ['queued', 'sent', 'delivered', 'read'];
      if (b.status === 'failed') await c.query(`UPDATE messages SET status = 'failed', error = $2 WHERE id = $1`, [m.id, b.error ?? 'Failed at provider']);
      else if (order.indexOf(b.status) > order.indexOf(m.status)) await c.query(`UPDATE messages SET status = $2, delivered_at = coalesce(delivered_at, now()), read_at = CASE WHEN $2 = 'read' THEN now() END WHERE id = $1`, [m.id, b.status]);
      await c.query(`INSERT INTO message_events (message_id, kind, detail) VALUES ($1, $2, $3)`, [m.id, b.status, JSON.stringify(b)]);
    });
    res.json({ ok: true });
  });
}

const tplBody = z.object({ code: z.string().regex(/^[a-z0-9_]{3,60}$/), name: reqText(120), event_type: z.string(), channel: z.enum(['whatsapp', 'sms', 'email']), language: z.string().max(10).default('en'),
  category: z.enum(['utility', 'marketing', 'authentication']).default('utility'), subject: optText(200), body: z.string().trim().min(5).max(4000), provider_template: optText(80) });

export function messagingRoutes(r: Router, { pool }: ServiceContext) {
  r.get('/events', requirePermission('workflow.read'), (_req, res) => { res.json(Object.entries(EVENT_VARIABLES).map(([type, variables]) => ({ type, variables }))); });

  r.get('/templates', requirePermission('workflow.read'), async (_req, res) => {
    res.json(await many(pool, `SELECT t.*, (SELECT count(*)::int FROM messages m WHERE m.template_code = t.code AND m.created_at > now() - interval '30 days') AS sent_30d,
      (SELECT count(*)::int FROM messages m WHERE m.template_code = t.code AND m.status = 'failed' AND m.created_at > now() - interval '30 days') AS failed_30d
      FROM templates t WHERE t.status <> 'superseded' ORDER BY t.event_type, t.channel, t.code`));
  });

  /** New template or a new version of an existing one. It goes live only after a checker approves it. */
  r.post('/templates', requirePermission('workflow.template.manage'), async (req, res) => {
    const b = parse(tplBody, req.body);
    const allowed = EVENT_VARIABLES[b.event_type];
    if (!allowed) throw badRequest('Unknown trigger event');
    const bad = usedVars(`${b.subject ?? ''} ${b.body}`).filter((v) => !allowed.includes(v));
    if (bad.length) throw badRequest(`This trigger does not provide: ${bad.join(', ')}`, { fields: { body: `Available: ${allowed.join(', ')}` } });
    if (b.channel === 'email' && !b.subject) throw badRequest('Emails need a subject', { fields: { subject: 'Required' } });
    if (b.channel === 'sms' && b.body.length > 300) throw badRequest('Keep SMS under 300 characters');
    const out = await tx(pool, async (c) => {
      if (await one(c, `SELECT 1 FROM templates WHERE code = $1 AND status = 'pending_approval'`, [b.code])) throw conflict('A change to this template is already waiting for approval');
      const v = Number((await one<{ v: number }>(c, 'SELECT coalesce(max(version), 0)::int AS v FROM templates WHERE code = $1', [b.code]))!.v) + 1;
      const t = await one<{ id: string }>(c, `INSERT INTO templates (code, version, name, event_type, channel, language, category, subject, body, variables, provider_template, provider_status, status, created_by_name)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'pending_approval',$13) RETURNING id`,
      [b.code, v, b.name, b.event_type, b.channel, b.language, b.category, b.subject ?? null, b.body, usedVars(`${b.subject ?? ''} ${b.body}`), b.provider_template ?? null, b.channel === 'whatsapp' ? 'pending' : 'not_required', req.user!.name]);
      await requestApproval(c, req, { type: 'message_template', refId: t!.id, permission: 'workflow.template.approve', title: `Message template ${b.code} v${v} (${b.channel})`, summary: b.body.slice(0, 300), payload: { code: b.code, version: v, channel: b.channel, trigger: b.event_type, subject: b.subject ?? null, body: b.body } });
      await auditReq(c, req, 'message_template', t!.id, 'submitted', { after: b });
      return { id: t!.id, version: v, status: 'pending_approval' };
    });
    res.status(201).json(out);
  });

  r.post('/templates/:id/status', requirePermission('workflow.template.manage'), async (req, res) => {
    const b = parse(z.object({ status: z.enum(['active', 'inactive']).optional(), provider_status: z.enum(['pending', 'approved', 'rejected']).optional(), reason: reqText(300) }), req.body);
    await tx(pool, async (c) => {
      const t = await one<{ status: string; channel: string }>(c, 'SELECT status, channel FROM templates WHERE id = $1 FOR UPDATE', [req.params.id]);
      if (!t) throw notFound('Template');
      if (b.status === 'active' && t.status !== 'inactive') throw conflict('Only a switched-off template can be switched back on; edits go through approval');
      if (b.status) await c.query('UPDATE templates SET status = $2 WHERE id = $1', [req.params.id, b.status]);
      if (b.provider_status && t.channel === 'whatsapp') await c.query('UPDATE templates SET provider_status = $2 WHERE id = $1', [req.params.id, b.provider_status]);
      await auditReq(c, req, 'message_template', String(req.params.id), b.status ?? `provider_${b.provider_status}`, { reason: b.reason });
    });
    res.json({ ok: true });
  });

  r.post('/templates/:id/preview', requirePermission('workflow.read'), async (req, res) => {
    const t = await one<{ event_type: string; subject: string | null; body: string; variables: string[] }>(pool, 'SELECT * FROM templates WHERE id = $1', [req.params.id]);
    if (!t) throw notFound('Template');
    const sample: Record<string, string> = { company: await companyName(), customer_name: 'Sri Murugan Garments', contact_name: 'Murali', lead_no: 'LEAD-00042', quotation_no: 'QT/2627/00012', order_no: 'SO/2627/00007', invoice_no: 'SRTI/2627/00031', amount: '1,24,950', valid_until: '15 Nov 2026', owner_name: 'Neha Kapoor', reserved_until: '7 Nov 2026', reference: 'SO/2627/00007', link: `${publicUrl()}/pay/…`, expires_at: '1 Nov, 10:30 am', portal_link: `${publicUrl()}/portal/invoices/…`, utr: 'UTR4417002211', warehouse: 'Surat', transporter: 'VRL Logistics', lr_number: 'VRL-771950', eta: '3 Nov 2026', tracking_link: `${publicUrl()}/track/…`, condition: 'good', complaint_no: 'CMP-00003', subject: 'Shade variation', due_date: '15 Oct 2026', days_overdue: '16', employee_name: 'Arjun', from: '3 Nov', to: '5 Nov', days: '3' };
    res.json({ subject: t.subject ? render(t.subject, sample) : null, body: render(t.body, sample) });
  });

  r.get('/messages', requirePermission('workflow.read'), async (req, res) => {
    const params: unknown[] = [];
    const where: string[] = [];
    if (req.query.status) { params.push(String(req.query.status).split(',')); where.push(`status = ANY($${params.length})`); }
    if (req.query.channel) { params.push(req.query.channel); where.push(`channel = $${params.length}`); }
    if (req.query.party) { params.push(req.query.party); where.push(`party_id = $${params.length}`); }
    if (req.query.q) { params.push(`%${req.query.q}%`); where.push(`(to_name ILIKE $${params.length} OR to_address ILIKE $${params.length} OR ref_label ILIKE $${params.length} OR template_code ILIKE $${params.length})`); }
    const rows = await many(pool, `SELECT id, event_type, template_code, channel, to_name, to_address, ref_type, ref_id, ref_label, subject, body, status, skip_reason, attempts, next_attempt_at, error, provider, created_at, sent_at, delivered_at, read_at
      FROM messages ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT 300`, params);
    const stats = await one(pool, `SELECT count(*)::int AS total, count(*) FILTER (WHERE status IN ('delivered','read'))::int AS delivered, count(*) FILTER (WHERE status = 'read')::int AS read, count(*) FILTER (WHERE status = 'failed')::int AS failed,
      count(*) FILTER (WHERE status = 'queued')::int AS queued, count(*) FILTER (WHERE status = 'skipped')::int AS skipped FROM messages WHERE created_at > now() - interval '30 days'`);
    res.json({ rows, stats });
  });
  r.get('/messages/:id', requirePermission('workflow.read'), async (req, res) => {
    const m = await one(pool, 'SELECT * FROM messages WHERE id = $1', [req.params.id]);
    if (!m) throw notFound('Message');
    res.json({ ...m, events: await many(pool, 'SELECT * FROM message_events WHERE message_id = $1 ORDER BY id', [req.params.id]) });
  });
  r.post('/messages/:id/retry', requirePermission('workflow.template.manage'), async (req, res) => {
    await tx(pool, async (c) => {
      const r1 = await c.query(`UPDATE messages SET status = 'queued', next_attempt_at = now(), attempts = 0 WHERE id = $1 AND status = 'failed'`, [req.params.id]);
      if (!r1.rowCount) throw conflict('Only failed messages can be retried');
      await c.query(`INSERT INTO message_events (message_id, kind, detail) VALUES ($1, 'manual_retry', $2)`, [req.params.id, JSON.stringify({ by: req.user!.name })]);
    });
    await dispatchMessages(pool);
    res.json(await one(pool, 'SELECT id, status, error, attempts FROM messages WHERE id = $1', [req.params.id]));
  });

  // ----- consent -----
  r.get('/consents', requirePermission('workflow.read'), async (req, res) => {
    res.json(await many(pool, `SELECT * FROM consents WHERE ($1::uuid IS NULL OR party_id = $1) ORDER BY at DESC LIMIT 500`, [req.query.party ?? null]));
  });
  r.post('/consents', requirePermission('workflow.template.manage', 'commerce.order.manage'), async (req, res) => {
    const b = parse(z.object({ party_id: z.uuid().nullable().optional(), address: z.string().trim().min(5).max(200), channel: z.enum(['whatsapp', 'sms', 'email']), status: z.enum(['opted_in', 'opted_out']), scope: z.enum(['transactional', 'marketing']).default('transactional'), source: reqText(120) }), req.body);
    const p = b.party_id ? await getParty(b.party_id) : null;
    await tx(pool, async (c) => {
      await c.query(`INSERT INTO consents (party_id, party_name, address, channel, status, scope, source, recorded_by_name) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
        ON CONFLICT (address, channel, scope) DO UPDATE SET status = EXCLUDED.status, source = EXCLUDED.source, recorded_by_name = EXCLUDED.recorded_by_name, at = now(), party_id = coalesce(EXCLUDED.party_id, consents.party_id), party_name = coalesce(EXCLUDED.party_name, consents.party_name)`,
      [p?.id ?? null, p?.legal_name ?? null, b.address, b.channel, b.status, b.scope, b.source, req.user!.name]);
      await auditReq(c, req, 'consent', b.address, b.status, { after: b });
    });
    res.json({ ok: true });
  });
}

/** Checker decision on a template: activate it (superseding the previous version) or reject it. */
export async function applyTemplateDecision(c: Client, p: { ref_id: string; decision: string; decided_by_name: string }) {
  const t = await one<{ id: string; code: string; status: string; channel: string }>(c, 'SELECT * FROM templates WHERE id = $1 FOR UPDATE', [p.ref_id]);
  if (!t || t.status !== 'pending_approval') return;
  if (p.decision !== 'approved') { await c.query(`UPDATE templates SET status = 'rejected', approved_by_name = $2, approved_at = now() WHERE id = $1`, [t.id, p.decided_by_name]); return; }
  await c.query(`UPDATE templates SET status = 'superseded' WHERE code = $1 AND status = 'active'`, [t.code]);
  await c.query(`UPDATE templates SET status = 'active', approved_by_name = $2, approved_at = now() WHERE id = $1`, [t.id, p.decided_by_name]);
}

export type { BusEvent };
