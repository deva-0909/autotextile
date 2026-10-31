import type { Router } from 'express';
import { z } from 'zod';
import { type Client, type ServiceContext, badRequest, conflict, many, notFound, one, optText, parse, reqText, requirePermission, tx } from '@erp/platform';
import { auditReq, books, getParty, raiseAnomaly, requestApproval, round2, setting, syncBooks, today } from './common.ts';
import { account, accounts, forgetAccounts, periodOpen, post, reverse } from './ledger.ts';
import { recentBankChange } from './postings.ts';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** Balance per account for a set of books and a date range (posted and reversed vouchers both count; reversals offset). */
export async function accountBalances(c: ServiceContext['pool'] | Client, opts: { bookIds?: string[] | null; from?: string | null; to?: string | null }) {
  return many<{ account_id: string; opening: number; debit: number; credit: number }>(c, `
    SELECT l.account_id,
      coalesce(sum(l.debit - l.credit) FILTER (WHERE v.voucher_date < coalesce($2::date, '0001-01-01')), 0)::float AS opening,
      coalesce(sum(l.debit) FILTER (WHERE v.voucher_date >= coalesce($2::date, '0001-01-01')), 0)::float AS debit,
      coalesce(sum(l.credit) FILTER (WHERE v.voucher_date >= coalesce($2::date, '0001-01-01')), 0)::float AS credit
    FROM voucher_lines l JOIN vouchers v ON v.id = l.voucher_id
    WHERE v.status IN ('posted','reversed') AND v.voucher_date <= coalesce($3::date, '9999-12-31') AND ($1::uuid[] IS NULL OR v.book_id = ANY($1))
    GROUP BY l.account_id`, [opts.bookIds ?? null, opts.from ?? null, opts.to ?? null]);
}
export const bookFilter = (q: unknown) => (q && q !== 'all' ? String(q).split(',') : null);

export function voucherRoutes(r: Router, { pool }: ServiceContext) {
  r.get('/books', requirePermission('finance.read'), async (_req, res) => { res.json(await syncBooks(pool)); });

  // ----- chart of accounts -----
  r.get('/accounts', requirePermission('finance.read'), async (req, res) => {
    const bal = await accountBalances(pool, { bookIds: bookFilter(req.query.book), to: (req.query.as_of as string) || null });
    const all = await accounts(pool, true);
    res.json(all.map((a) => { const b = bal.find((x) => x.account_id === a.id); const net = b ? round2(b.opening + b.debit - b.credit) : 0; return { ...a, balance: net }; }));
  });
  const accBody = z.object({ code: z.string().regex(/^\d{4,6}$/), name: z.string().trim().min(2).max(120), type: z.enum(['asset', 'liability', 'equity', 'income', 'expense']), group_name: reqText(80),
    section: z.enum(['current_assets', 'non_current_assets', 'current_liabilities', 'non_current_liabilities', 'equity', 'revenue', 'other_income', 'cost_of_sales', 'operating_expenses', 'finance_costs']), is_bank: z.boolean().default(false) });
  r.post('/accounts', requirePermission('finance.config.manage'), async (req, res) => {
    const b = parse(accBody, req.body);
    const out = await tx(pool, async (c) => {
      if (await one(c, 'SELECT 1 FROM accounts WHERE code = $1', [b.code])) throw conflict(`Account code ${b.code} is in use`);
      const a = await one<{ id: string }>(c, `INSERT INTO accounts (code, name, type, group_name, section, is_bank, created_by_name) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`, [b.code, b.name, b.type, b.group_name, b.section, b.is_bank, req.user!.name]);
      await auditReq(c, req, 'gl_account', a!.id, 'created', { after: b });
      return a;
    });
    forgetAccounts();
    res.status(201).json(out);
  });
  r.patch('/accounts/:id', requirePermission('finance.config.manage'), async (req, res) => {
    const b = parse(z.object({ name: z.string().trim().min(2).max(120), group_name: reqText(80), status: z.enum(['active', 'inactive']) }), req.body);
    await tx(pool, async (c) => {
      const a = await one<{ system_key: string | null; name: string; status: string }>(c, 'SELECT * FROM accounts WHERE id = $1 FOR UPDATE', [req.params.id]);
      if (!a) throw notFound('Account');
      if (a.system_key && b.status === 'inactive') throw conflict('This account is used by automatic postings and cannot be deactivated');
      await c.query('UPDATE accounts SET name = $2, group_name = $3, status = $4 WHERE id = $1', [req.params.id, b.name, b.group_name, b.status]);
      await auditReq(c, req, 'gl_account', String(req.params.id), 'updated', { before: a, after: b });
    });
    forgetAccounts();
    res.json({ ok: true });
  });

  /** Ledger for one account (optionally one party) with opening balance and running balance. */
  r.get('/ledger/:accountId', requirePermission('finance.read'), async (req, res) => {
    const a = await account(pool, String(req.params.accountId));
    const from = (req.query.from as string) || '0001-01-01', to = (req.query.to as string) || '9999-12-31';
    const bk = bookFilter(req.query.book);
    const party = (req.query.party as string) || null;
    const open = await one<{ b: number }>(pool, `SELECT coalesce(sum(l.debit - l.credit), 0)::float AS b FROM voucher_lines l JOIN vouchers v ON v.id = l.voucher_id
      WHERE l.account_id = $1 AND v.status IN ('posted','reversed') AND v.voucher_date < $2 AND ($3::uuid[] IS NULL OR v.book_id = ANY($3)) AND ($4::uuid IS NULL OR l.party_id = $4)`, [a.id, from, bk, party]);
    const rows = await many<{ debit: number; credit: number }>(pool, `
      SELECT v.id AS voucher_id, v.number, v.voucher_type, v.voucher_date::text AS date, v.narration, v.status, b.code AS book, l.party_id, l.party_name, l.bill_ref, l.debit::float, l.credit::float,
        (SELECT string_agg(DISTINCT a2.name, ', ') FROM voucher_lines l2 JOIN accounts a2 ON a2.id = l2.account_id WHERE l2.voucher_id = v.id AND l2.account_id <> l.account_id) AS against
      FROM voucher_lines l JOIN vouchers v ON v.id = l.voucher_id JOIN books b ON b.id = v.book_id
      WHERE l.account_id = $1 AND v.status IN ('posted','reversed') AND v.voucher_date BETWEEN $2 AND $3 AND ($4::uuid[] IS NULL OR v.book_id = ANY($4)) AND ($5::uuid IS NULL OR l.party_id = $5)
      ORDER BY v.voucher_date, v.created_at, l.id LIMIT 2000`, [a.id, from, to, bk, party]);
    let run = Number(open!.b);
    const sign = ['asset', 'expense'].includes(a.type) ? 1 : -1;
    res.json({ account: a, opening: round2(run * sign), entries: rows.map((x) => { run += Number(x.debit) - Number(x.credit); return { ...x, balance: round2(run * sign) }; }), closing: round2(run * sign) });
  });

  // ----- vouchers -----
  r.get('/vouchers', requirePermission('finance.read'), async (req, res) => {
    const params: unknown[] = [];
    const where: string[] = [];
    const add = (sql: string, v: unknown) => { params.push(v); where.push(sql.replace('?', `$${params.length}`)); };
    if (req.query.type) add('v.voucher_type = ANY(?)', String(req.query.type).split(','));
    if (req.query.status) add('v.status = ANY(?)', String(req.query.status).split(','));
    if (req.query.book && req.query.book !== 'all') add('v.book_id = ?', req.query.book);
    if (req.query.from) add('v.voucher_date >= ?', req.query.from);
    if (req.query.to) add('v.voucher_date <= ?', req.query.to);
    if (req.query.party) add('v.party_id = ?', req.query.party);
    if (req.query.source) add('v.source_service = ?', req.query.source);
    if (req.query.q) { params.push(`%${req.query.q}%`); const i = `$${params.length}`; where.push(`(v.number ILIKE ${i} OR v.narration ILIKE ${i} OR v.party_name ILIKE ${i} OR v.source_ref ILIKE ${i})`); }
    res.json(await many(pool, `SELECT v.id, v.number, v.voucher_type, v.voucher_date::text AS date, v.narration, v.party_name, v.amount::float, v.status, v.source_service, v.source_ref, v.manual, v.created_by_name, v.approved_by_name, b.code AS book
      FROM vouchers v JOIN books b ON b.id = v.book_id ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY v.voucher_date DESC, v.created_at DESC LIMIT 500`, params));
  });

  r.get('/vouchers/:id', requirePermission('finance.read'), async (req, res) => {
    const v = await one<{ id: string; reversal_of: string | null; reversed_by: string | null }>(pool, `SELECT v.*, v.voucher_date::text AS date, b.code AS book, b.gstin, b.name AS book_name FROM vouchers v JOIN books b ON b.id = v.book_id WHERE v.id::text = $1 OR v.number = $1`, [req.params.id]);
    if (!v) throw notFound('Voucher');
    const [lines, tax, tds, bill, related] = await Promise.all([
      many(pool, `SELECT l.*, l.debit::float, l.credit::float, a.code, a.name AS account_name FROM voucher_lines l JOIN accounts a ON a.id = l.account_id WHERE l.voucher_id = $1 ORDER BY l.line_no`, [v.id]),
      many(pool, 'SELECT * FROM tax_lines WHERE voucher_id = $1 ORDER BY id', [v.id]),
      many(pool, 'SELECT * FROM tds_entries WHERE voucher_id = $1', [v.id]),
      one(pool, 'SELECT * FROM bills WHERE voucher_id = $1', [v.id]),
      many(pool, `SELECT id, number, status FROM vouchers WHERE id = ANY($1::uuid[])`, [[v.reversal_of, v.reversed_by].filter(Boolean)]),
    ]);
    res.json({ ...v, lines, tax, tds, bill, related, bank_line: await one(pool, 'SELECT id, txn_date, description, ref FROM bank_lines WHERE voucher_id = $1', [v.id]) });
  });

  const lineSchema = z.object({ account_id: z.string().min(1), debit: z.number().min(0).default(0), credit: z.number().min(0).default(0), party_id: z.uuid().nullable().optional(), narration: optText(200), bill_ref: optText(60) });
  /** Manual vouchers. Journals and payments above the limit wait for a checker; receipts post directly. */
  r.post('/vouchers', requirePermission('finance.voucher.post'), async (req, res) => {
    const b = parse(z.object({ voucher_type: z.enum(['journal', 'receipt', 'payment', 'contra', 'opening']), book_id: z.uuid(), date, narration: reqText(500), reference: optText(80), lines: z.array(lineSchema).min(2).max(50) }), req.body);
    if (b.date > today()) throw badRequest('Vouchers cannot be dated in the future');
    const partyIds = [...new Set(b.lines.map((l) => l.party_id).filter(Boolean))] as string[];
    const parties = new Map((await Promise.all(partyIds.map((id) => getParty(id).catch(() => null)))).filter(Boolean).map((p) => [p!.id, p!]));
    const limit = Number(await setting('finance.voucher_approval_limit', 100000));
    const out = await tx(pool, async (c) => {
      const lines = [];
      const touched: Awaited<ReturnType<typeof account>>[] = [];
      for (const l of b.lines) {
        const a = await account(c, l.account_id);
        touched.push(a);
        const p = l.party_id ? parties.get(l.party_id) : null;
        if (l.party_id && !p) throw badRequest('Unknown customer or supplier on a line');
        lines.push({ account: a.id, debit: l.debit, credit: l.credit, party_id: p?.id ?? null, party_name: p?.legal_name ?? null, narration: l.narration ?? null, bill_ref: l.bill_ref ?? null });
      }
      if (b.voucher_type === 'contra' && !touched.every((a) => a.is_bank || a.system_key === 'gateway_clearing')) throw badRequest('A contra moves money between cash, bank and clearing accounts only');
      if (['receipt', 'payment'].includes(b.voucher_type) && !touched.some((a) => a.is_bank || a.system_key === 'gateway_clearing')) throw badRequest(`A ${b.voucher_type} must have a bank or cash line`);
      const amount = round2(lines.reduce((s, l) => s + l.debit, 0));
      const payee = b.voucher_type === 'payment' ? lines.find((l) => l.party_id && l.debit > 0) : null;
      const bankChanged = payee ? await recentBankChange(c, payee.party_id!) : null;
      const needsApproval = (['journal', 'payment', 'contra', 'opening'].includes(b.voucher_type) && amount > limit) || !!bankChanged;
      const mainParty = lines.find((l) => l.party_id);
      const v = await post(c, { type: b.voucher_type, book_id: b.book_id, date: b.date, narration: b.narration, party_id: mainParty?.party_id ?? null, party_name: mainParty?.party_name ?? null, lines, by: req.user!.name, manual: true,
        status: needsApproval ? 'pending_approval' : 'posted', approved_by: needsApproval ? null : req.user!.name });
      if (b.reference) await c.query('UPDATE vouchers SET source_ref = $2 WHERE id = $1', [v.id, b.reference]);
      // Anomaly checks on manual entries.
      if (b.voucher_type === 'journal' && touched.some((a) => a.control || a.is_bank || a.group_name.startsWith('GST')))
        await raiseAnomaly(c, { kind: 'manual_journal_sensitive', severity: 'warning', ref_type: 'voucher', ref_id: v.id, ref_label: `${v.number} · ${req.user!.name}`, message: `Manual journal ${v.number} touches ${touched.filter((a) => a.control || a.is_bank || a.group_name.startsWith('GST')).map((a) => a.name).join(', ')}`, amount });
      const dow = new Date(`${b.date}T00:00:00Z`).getUTCDay();
      if (b.voucher_type === 'journal' && (dow === 0 || amount >= 100000 && amount % 100000 === 0))
        await raiseAnomaly(c, { kind: 'journal_pattern', severity: 'info', ref_type: 'voucher', ref_id: v.id, ref_label: v.number, message: `Journal ${v.number} ${dow === 0 ? 'dated on a Sunday' : `for a round ₹${amount.toLocaleString('en-IN')}`}`, amount });
      if (payee) {
        const dup = await one<{ number: string }>(c, `SELECT v.number FROM vouchers v JOIN voucher_lines l ON l.voucher_id = v.id WHERE v.voucher_type = 'payment' AND v.status IN ('posted','pending_approval') AND v.id <> $1
          AND l.party_id = $2 AND l.debit = $3 AND abs(v.voucher_date - $4::date) <= 30 LIMIT 1`, [v.id, payee.party_id, payee.debit, b.date]);
        if (dup) await raiseAnomaly(c, { kind: 'duplicate_payment', severity: 'critical', ref_type: 'voucher', ref_id: v.id, ref_label: `${v.number} · ${payee.party_name}`, message: `Payment ${v.number} to ${payee.party_name} repeats ${dup.number} (same amount within 30 days)`, amount: payee.debit });
        if (bankChanged) await raiseAnomaly(c, { kind: 'payment_after_bank_change', severity: 'critical', ref_type: 'voucher', ref_id: v.id, ref_label: `${v.number} · ${payee.party_name}`, message: `${payee.party_name}'s bank details changed recently; payment ${v.number} needs a second check`, amount: payee.debit });
      }
      if (needsApproval) await requestApproval(c, req, { type: 'finance_voucher', refId: v.id, permission: 'finance.voucher.approve', title: `${b.voucher_type === 'journal' ? 'Journal' : b.voucher_type === 'payment' ? 'Payment' : 'Voucher'} ${v.number} · ₹${amount.toLocaleString('en-IN')}`,
        summary: `${b.narration}${bankChanged ? ' — payee bank details changed in the last 30 days' : ''}`, payload: { number: v.number, date: b.date, amount, lines: lines.map((l) => ({ account: touched.find((a) => a.id === l.account)?.name, party: l.party_name, debit: l.debit || null, credit: l.credit || null })) } });
      await auditReq(c, req, 'voucher', v.id, needsApproval ? 'submitted' : 'posted', { after: { number: v.number, type: b.voucher_type, amount, date: b.date } });
      return { ...v, status: needsApproval ? 'pending_approval' : 'posted' };
    });
    res.status(201).json(out);
  });

  /** Opening customer and supplier bills from the previous system (migration): each becomes an opening voucher and a bill, so ageing continues. */
  r.post('/opening-bills', requirePermission('finance.voucher.post'), async (req, res) => {
    const b = parse(z.object({ kind: z.enum(['receivable', 'payable']), party_id: z.uuid(), doc_no: reqText(60), doc_date: date, due_date: date, amount: z.number().positive(), book_id: z.uuid().optional(), reference: optText(80) }), req.body);
    const party = await getParty(b.party_id);
    const out = await tx(pool, async (c) => {
      const book = b.book_id ?? (await books(c)).find((x) => x.is_primary)!.id;
      const ctl = b.kind === 'receivable' ? 'receivables' : 'payables';
      const v = await post(c, { type: 'opening', book_id: book, date: b.doc_date, narration: `Opening ${b.kind} ${b.doc_no} — ${party.legal_name}${b.reference ? ` (${b.reference})` : ''}`, party_id: party.id, party_name: party.legal_name, by: req.user!.name, approved_by: 'migration sign-off',
        source: { service: 'finance', type: 'opening_bill', id: `${b.kind}:${party.id}:${b.doc_no}`, ref: b.reference ?? null },
        lines: b.kind === 'receivable' ? [{ account: ctl, debit: b.amount, party_id: party.id, party_name: party.legal_name, bill_ref: b.doc_no }, { account: 'opening_difference', credit: b.amount }]
          : [{ account: 'opening_difference', debit: b.amount }, { account: ctl, credit: b.amount, party_id: party.id, party_name: party.legal_name, bill_ref: b.doc_no }],
        bill: { kind: b.kind, party_id: party.id, party_name: party.legal_name, doc_no: b.doc_no, doc_date: b.doc_date, due_date: b.due_date, amount: b.amount } });
      if (!v.existing) await auditReq(c, req, 'opening_bill', v.id, 'imported', { after: b });
      return v;
    });
    res.status(201).json(out);
  });

  r.post('/vouchers/:id/reverse', requirePermission('finance.voucher.approve'), async (req, res) => {
    const b = parse(z.object({ reason: reqText(300), date: date.optional() }), req.body);
    const out = await tx(pool, async (c) => {
      const r1 = await reverse(c, String(req.params.id), req.user!.name, b.reason, b.date ?? today());
      await auditReq(c, req, 'voucher', String(req.params.id), 'reversed', { reason: b.reason, after: { reversal: r1.number } });
      return r1;
    });
    res.json(out);
  });

  r.get('/books/:id/summary', requirePermission('finance.read'), async (req, res) => {
    const all = await books(pool);
    if (!all.find((b) => b.id === req.params.id)) throw notFound('Book');
    res.json(await one(pool, `SELECT count(*)::int AS vouchers, max(voucher_date) AS last FROM vouchers WHERE book_id = $1`, [req.params.id]));
  });
}

/** Checker decisions on vouchers and period reopening. */
export async function applyFinanceDecision(c: Client, p: { approval_type: string; ref_id: string; decision: string; decided_by_name: string; comment: string | null }) {
  if (p.approval_type === 'finance_voucher') {
    const v = await one<{ status: string; voucher_date: string }>(c, `SELECT status, voucher_date::text FROM vouchers WHERE id = $1 FOR UPDATE`, [p.ref_id]);
    if (!v || v.status !== 'pending_approval') return;
    if (p.decision === 'approved' && !(await periodOpen(c, v.voucher_date))) {
      await c.query(`UPDATE vouchers SET status = 'rejected', approved_by_name = $2, narration = narration || ' — not posted: period locked before approval' WHERE id = $1`, [p.ref_id, p.decided_by_name]);
      return;
    }
    await c.query(`UPDATE vouchers SET status = $2, approved_by_name = $3, posted_at = CASE WHEN $2 = 'posted' THEN now() END WHERE id = $1`, [p.ref_id, p.decision === 'approved' ? 'posted' : 'rejected', p.decided_by_name]);
  }
  if (p.approval_type === 'period_reopen' && p.decision === 'approved') {
    await c.query(`UPDATE periods SET status = 'open', note = coalesce(note, '') || $2 WHERE month = $1`, [p.ref_id, ` Reopened (approved by ${p.decided_by_name}).`]);
  }
}
