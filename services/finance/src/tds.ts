import type { Router } from 'express';
import { z } from 'zod';
import { type ServiceContext, badRequest, conflict, many, one, optText, parse, reqText, requirePermission, tx } from '@erp/platform';
import { auditReq, fyOf, fyStart, getParty, monthEnd, primaryBook, round2 } from './common.ts';
import { post } from './ledger.ts';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
/** TDS is due by the 7th of the next month (30 April for March). */
export function tdsDueDate(month: string) {
  const d = new Date(`${month.slice(0, 7)}-01T00:00:00Z`);
  if (d.getUTCMonth() === 2) return `${d.getUTCFullYear()}-04-30`;
  d.setUTCMonth(d.getUTCMonth() + 1); d.setUTCDate(7);
  return d.toISOString().slice(0, 10);
}
const quarterOf = (d: string) => { const m = Number(d.slice(5, 7)); return m >= 4 && m <= 6 ? 'Q1' : m <= 9 && m >= 7 ? 'Q2' : m >= 10 ? 'Q3' : 'Q4'; };

export function tdsRoutes(r: Router, { pool }: ServiceContext) {
  r.get('/tds/sections', requirePermission('finance.read'), async (_req, res) => { res.json(await many(pool, 'SELECT *, rate_company::float, rate_individual::float, rate_no_pan::float, threshold_single::float, threshold_annual::float FROM tds_sections ORDER BY code')); });
  r.put('/tds/sections/:code', requirePermission('finance.tds.manage'), async (req, res) => {
    const b = parse(z.object({ description: reqText(200), rate_company: z.number().min(0).max(50), rate_individual: z.number().min(0).max(50), rate_no_pan: z.number().min(0).max(50), threshold_single: z.number().min(0), threshold_annual: z.number().min(0), on_excess: z.boolean(), effective_from: date }), req.body);
    await tx(pool, async (c) => {
      const before = await one(c, 'SELECT * FROM tds_sections WHERE code = $1', [req.params.code]);
      await c.query(`INSERT INTO tds_sections (code, description, rate_company, rate_individual, rate_no_pan, threshold_single, threshold_annual, on_excess, effective_from, updated_by_name) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        ON CONFLICT (code) DO UPDATE SET description = EXCLUDED.description, rate_company = EXCLUDED.rate_company, rate_individual = EXCLUDED.rate_individual, rate_no_pan = EXCLUDED.rate_no_pan, threshold_single = EXCLUDED.threshold_single,
        threshold_annual = EXCLUDED.threshold_annual, on_excess = EXCLUDED.on_excess, effective_from = EXCLUDED.effective_from, updated_by_name = EXCLUDED.updated_by_name, updated_at = now()`,
      [String(req.params.code).toUpperCase(), b.description, b.rate_company, b.rate_individual, b.rate_no_pan, b.threshold_single, b.threshold_annual, b.on_excess, b.effective_from, req.user!.name]);
      await auditReq(c, req, 'tds_section', String(req.params.code), before ? 'updated' : 'created', { before, after: b });
    });
    res.json({ ok: true });
  });

  r.get('/tds/parties', requirePermission('finance.read'), async (_req, res) => { res.json(await many(pool, 'SELECT *, lower_rate::float FROM party_tax ORDER BY party_name')); });
  r.put('/tds/parties/:partyId', requirePermission('finance.tds.manage'), async (req, res) => {
    const b = parse(z.object({ pan: z.string().trim().toUpperCase().regex(/^[A-Z]{5}[0-9]{4}[A-Z]$/, 'Enter a valid PAN').nullable().optional(), tds_section: z.string().nullable(), lower_rate: z.number().min(0).max(50).nullable().optional(), lower_cert_no: optText(40), lower_valid_to: date.nullable().optional() }), req.body);
    const p = await getParty(String(req.params.partyId));
    await tx(pool, async (c) => {
      if (b.tds_section && !(await one(c, 'SELECT 1 FROM tds_sections WHERE code = $1', [b.tds_section]))) throw badRequest('Unknown section');
      const before = await one(c, 'SELECT * FROM party_tax WHERE party_id = $1', [p.id]);
      await c.query(`INSERT INTO party_tax (party_id, party_name, pan, tds_section, lower_rate, lower_cert_no, lower_valid_to, updated_by_name) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
        ON CONFLICT (party_id) DO UPDATE SET party_name = EXCLUDED.party_name, pan = EXCLUDED.pan, tds_section = EXCLUDED.tds_section, lower_rate = EXCLUDED.lower_rate, lower_cert_no = EXCLUDED.lower_cert_no, lower_valid_to = EXCLUDED.lower_valid_to, updated_by_name = EXCLUDED.updated_by_name, updated_at = now()`,
      [p.id, p.legal_name, b.pan ?? p.pan, b.tds_section, b.lower_rate ?? null, b.lower_cert_no ?? null, b.lower_valid_to ?? null, req.user!.name]);
      await auditReq(c, req, 'party_tax', p.id, 'updated', { before, after: b });
    });
    res.json({ ok: true });
  });

  /** Deductions by month and section against challans deposited, with the due date for each. */
  r.get('/tds/register', requirePermission('finance.read'), async (req, res) => {
    const fy = (req.query.fy as string) || fyOf(new Date().toISOString());
    const from = fyStart(fy), to = `20${fy.slice(2)}-03-31`;
    const entries = await many<{ deducted_on: string; section: string; tds_amount: number; challan_id: string | null }>(pool, `SELECT e.*, e.deducted_on::text, e.base_amount::float, e.rate::float, e.tds_amount::float, v.number AS voucher_no, c.challan_no
      FROM tds_entries e JOIN vouchers v ON v.id = e.voucher_id LEFT JOIN tds_challans c ON c.id = e.challan_id WHERE e.deducted_on BETWEEN $1 AND $2 ORDER BY e.deducted_on DESC`, [from, to]);
    const challans = await many(pool, `SELECT t.*, t.month::text, t.paid_on::text, t.amount::float FROM tds_challans t WHERE t.month BETWEEN $1 AND $2 ORDER BY t.month DESC, t.section`, [from, to]);
    const months = new Map<string, { month: string; section: string; deducted: number; deposited: number; due_date: string; entries: number }>();
    for (const e of entries) {
      const k = `${e.deducted_on.slice(0, 7)}|${e.section}`;
      const m = months.get(k) ?? { month: `${e.deducted_on.slice(0, 7)}-01`, section: e.section, deducted: 0, deposited: 0, due_date: tdsDueDate(e.deducted_on), entries: 0 };
      m.deducted = round2(m.deducted + Number(e.tds_amount)); m.entries++;
      if (e.challan_id) m.deposited = round2(m.deposited + Number(e.tds_amount));
      months.set(k, m);
    }
    const today = new Date().toISOString().slice(0, 10);
    const summary = [...months.values()].map((m) => ({ ...m, pending: round2(m.deducted - m.deposited), overdue: m.deducted - m.deposited > 0.5 && m.due_date < today })).sort((a, b) => b.month.localeCompare(a.month));
    // Salary TDS (section 192) is returned in Form 24Q; other resident deductions in 26Q.
    const formOf = (section: string) => (section === '192' ? '24Q' : '26Q');
    const forms = [...new Set(entries.map((e) => formOf(e.section)))].sort().reverse();
    const quarters = (forms.length ? forms : ['26Q']).flatMap((form) => ['Q1', 'Q2', 'Q3', 'Q4'].map((q) => {
      const es = entries.filter((e) => quarterOf(e.deducted_on) === q && formOf(e.section) === form);
      return { quarter: q, form, deductees: new Set(es.map((e) => (e as unknown as { party_id: string }).party_id)).size, entries: es.length, tds: round2(es.reduce((s, e) => s + Number(e.tds_amount), 0)), deposited: round2(es.filter((e) => e.challan_id).reduce((s, e) => s + Number(e.tds_amount), 0)) };
    }));
    res.json({ fy, entries, challans, summary, quarters });
  });

  /** Record a challan: links the month's undeposited deductions for that section and posts the payment from the bank. */
  r.post('/tds/challans', requirePermission('finance.tds.manage'), async (req, res) => {
    const b = parse(z.object({ section: z.string(), month: z.string().regex(/^\d{4}-\d{2}/).transform((m) => `${m.slice(0, 7)}-01`), bsr_code: z.string().regex(/^\d{7}$/, 'BSR code has 7 digits'), challan_no: z.string().regex(/^\d{1,6}$/), paid_on: date, bank_account_id: z.string().optional() }), req.body);
    const out = await tx(pool, async (c) => {
      const due = await many<{ id: string; tds_amount: number }>(c, `SELECT id, tds_amount::float FROM tds_entries WHERE section = $1 AND deducted_on BETWEEN $2 AND $3 AND challan_id IS NULL FOR UPDATE`, [b.section, b.month, monthEnd(b.month)]);
      if (!due.length) throw conflict('Nothing is waiting to be deposited for that section and month');
      const amount = round2(due.reduce((s, e) => s + e.tds_amount, 0));
      const book = await primaryBook(c);
      const v = await post(c, { type: 'payment', book_id: book.id, date: b.paid_on, narration: `TDS ${b.section} for ${b.month.slice(0, 7)} — challan ${b.bsr_code}/${b.challan_no}`, by: req.user!.name, approved_by: req.user!.name, manual: false,
        lines: [{ account: 'tds_payable', debit: amount }, { account: b.bank_account_id ?? 'bank_main', credit: amount }] });
      const ch = await one<{ id: string }>(c, `INSERT INTO tds_challans (section, month, amount, bsr_code, challan_no, paid_on, voucher_id, created_by_name) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`, [b.section, b.month, amount, b.bsr_code, b.challan_no, b.paid_on, v.id, req.user!.name]);
      await c.query('UPDATE tds_entries SET challan_id = $1 WHERE id = ANY($2)', [ch!.id, due.map((e) => e.id)]);
      // The deposit settles that month's overdue alert, if one was raised.
      await c.query(`UPDATE anomalies SET status = 'resolved', resolution = $2, resolved_by_name = $3, resolved_at = now() WHERE kind = 'tds_overdue' AND ref_id = $1 AND status = 'open'`,
        [`${b.month}:${b.section}`, `Deposited ${b.paid_on} — challan ${b.bsr_code}/${b.challan_no}`, req.user!.name]);
      await auditReq(c, req, 'tds_challan', ch!.id, 'recorded', { after: { ...b, amount, voucher: v.number } });
      return { id: ch!.id, amount, voucher: v.number, entries: due.length };
    });
    res.status(201).json(out);
  });
}
