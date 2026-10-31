import type { Router } from 'express';
import { z } from 'zod';
import { type Client, type ServiceContext, badRequest, conflict, many, notFound, one, optText, parse, reqText, requirePermission, tx } from '@erp/platform';
import { auditReq, getParty, raiseAnomaly, round2 } from './common.ts';
import { account, post } from './ledger.ts';

interface Line { txn_date: string; description: string; ref: string | null; debit: number; credit: number; balance: number | null }

/** Parse a bank CSV: finds the date, narration, reference, debit/credit (or signed amount) and balance columns by header. */
export function parseStatement(csv: string): Line[] {
  const rows = csv.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map(splitCsv);
  const hi = rows.findIndex((r) => r.some((c) => /date/i.test(c)) && r.some((c) => /(debit|withdrawal|credit|deposit|amount)/i.test(c)));
  if (hi < 0) throw badRequest('Could not find a header row with Date and Debit/Credit columns');
  const h = rows[hi]!.map((c) => c.toLowerCase());
  const col = (...re: RegExp[]) => h.findIndex((c) => re.some((x) => x.test(c)));
  const iDate = col(/^(txn |transaction |value )?date/, /date/);
  const iDesc = col(/narration|description|particulars|remarks/);
  const iRef = col(/ref|utr|chq|cheque/);
  const iDr = col(/debit|withdrawal|dr\b/);
  const iCr = col(/credit|deposit|cr\b/);
  const iAmt = col(/^amount/);
  const iBal = col(/balance/);
  const num = (s: string | undefined) => { const n = Number(String(s ?? '').replace(/[₹,\s]/g, '').replace(/\((.*)\)/, '-$1')); return Number.isFinite(n) ? n : 0; };
  const out: Line[] = [];
  for (const r of rows.slice(hi + 1)) {
    const d = toDate(r[iDate] ?? '');
    if (!d) continue;
    let dr = iDr >= 0 ? Math.abs(num(r[iDr])) : 0, cr = iCr >= 0 ? Math.abs(num(r[iCr])) : 0;
    if (iDr < 0 && iCr < 0 && iAmt >= 0) { const a = num(r[iAmt]); if (a < 0) dr = -a; else cr = a; }
    if (!dr && !cr) continue;
    out.push({ txn_date: d, description: (r[iDesc] ?? '').slice(0, 300) || '—', ref: iRef >= 0 ? (r[iRef] || null) : extractRef(r[iDesc] ?? ''), debit: round2(dr), credit: round2(cr), balance: iBal >= 0 && r[iBal] ? num(r[iBal]) : null });
  }
  if (!out.length) throw badRequest('No transactions found under the header row');
  return out;
}
function splitCsv(line: string) {
  const out: string[] = []; let cur = '', q = false;
  for (const ch of line) { if (ch === '"') q = !q; else if (ch === ',' && !q) { out.push(cur.trim()); cur = ''; } else cur += ch; }
  out.push(cur.trim());
  return out;
}
const MON: Record<string, string> = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' };
function toDate(s: string) {
  s = s.trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/); if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/); if (m) return `${m[3]!.length === 2 ? `20${m[3]}` : m[3]}-${m[2]!.padStart(2, '0')}-${m[1]!.padStart(2, '0')}`;
  m = s.match(/^(\d{1,2})[ -]([A-Za-z]{3})[a-z]*[ -](\d{2,4})$/); if (m && MON[m[2]!.toLowerCase()]) return `${m[3]!.length === 2 ? `20${m[3]}` : m[3]}-${MON[m[2]!.toLowerCase()]}-${m[1]!.padStart(2, '0')}`;
  return null;
}
const extractRef = (d: string) => d.match(/\b(UTR[A-Z0-9]{6,}|[A-Z]{4}\d{10,}|\d{12})\b/i)?.[1] ?? null;

/** Candidate ledger entries on the bank account for a statement line: same side and amount within ±5 days, not yet matched. */
async function candidates(c: Client | ServiceContext['pool'], ba: { account_id: string }, l: { txn_date: string; debit: number; credit: number; ref: string | null; description: string }) {
  const rows = await many<{ voucher_id: string; number: string; date: string; narration: string; source_ref: string | null; amount: number }>(c, `
    SELECT v.id AS voucher_id, v.number, v.voucher_date::text AS date, v.narration, v.source_ref, (l.debit + l.credit)::float AS amount
    FROM voucher_lines l JOIN vouchers v ON v.id = l.voucher_id
    WHERE l.account_id = $1 AND v.status = 'posted' AND v.reversal_of IS NULL AND ${Number(l.credit) > 0 ? 'l.debit' : 'l.credit'} = $2 AND abs(v.voucher_date - $3::date) <= 5
      AND NOT EXISTS (SELECT 1 FROM bank_lines b WHERE b.voucher_id = v.id) ORDER BY abs(v.voucher_date - $3::date) LIMIT 10`, [ba.account_id, Number(l.credit) > 0 ? l.credit : l.debit, l.txn_date]);
  const refHit = (r: { source_ref: string | null; narration: string }) => !!l.ref && ((r.source_ref ?? '').includes(l.ref) || r.narration.includes(l.ref) || l.description.includes(r.source_ref ?? '\u0000'));
  return rows.map((r) => ({ ...r, ref_match: refHit(r) })).sort((a, b) => Number(b.ref_match) - Number(a.ref_match));
}

export function bankRoutes(r: Router, { pool }: ServiceContext) {
  r.get('/bank-accounts', requirePermission('finance.read'), async (_req, res) => {
    res.json(await many(pool, `
      SELECT ba.*, a.code, a.name AS account_name, b.code AS book,
        (SELECT coalesce(sum(l.debit - l.credit), 0)::float FROM voucher_lines l JOIN vouchers v ON v.id = l.voucher_id WHERE l.account_id = ba.account_id AND v.status IN ('posted','reversed')) AS book_balance,
        (SELECT balance::float FROM bank_lines x WHERE x.bank_account_id = ba.id AND balance IS NOT NULL ORDER BY txn_date DESC, id DESC LIMIT 1) AS statement_balance,
        (SELECT max(txn_date)::text FROM bank_lines x WHERE x.bank_account_id = ba.id) AS statement_to,
        (SELECT count(*)::int FROM bank_lines x WHERE x.bank_account_id = ba.id AND x.status = 'unmatched') AS unmatched
      FROM bank_accounts ba JOIN accounts a ON a.id = ba.account_id JOIN books b ON b.id = ba.book_id ORDER BY a.code`));
  });
  r.post('/bank-accounts', requirePermission('finance.config.manage'), async (req, res) => {
    const b = parse(z.object({ account_id: z.string(), book_id: z.uuid(), bank_name: reqText(80), account_no: z.string().trim().regex(/^\d{6,20}$/), ifsc: z.string().trim().toUpperCase().regex(/^[A-Z]{4}0[A-Z0-9]{6}$/).nullable().optional() }), req.body);
    const out = await tx(pool, async (c) => {
      const a = await account(c, b.account_id);
      if (!a.is_bank) throw badRequest('Choose a bank-type ledger account');
      const row = await one<{ id: string }>(c, 'INSERT INTO bank_accounts (account_id, book_id, bank_name, account_no, ifsc) VALUES ($1,$2,$3,$4,$5) RETURNING id', [a.id, b.book_id, b.bank_name, b.account_no, b.ifsc ?? null]);
      await auditReq(c, req, 'bank_account', row!.id, 'created', { after: { ...b, account_no: `••••${b.account_no.slice(-4)}` } });
      return row;
    });
    res.status(201).json(out);
  });

  /** Import a statement. Lines already imported (same date, amount, reference and narration) are kept as duplicates, not double counted. */
  r.post('/bank-accounts/:id/statements', requirePermission('finance.bank.reconcile'), async (req, res) => {
    const b = parse(z.object({ file_name: optText(200), csv: z.string().min(10).max(2_000_000) }), req.body);
    const ba = await one<{ id: string; account_id: string }>(pool, 'SELECT * FROM bank_accounts WHERE id = $1', [req.params.id]);
    if (!ba) throw notFound('Bank account');
    const lines = parseStatement(b.csv);
    const out = await tx(pool, async (c) => {
      const st = await one<{ id: string }>(c, `INSERT INTO bank_statements (bank_account_id, file_name, from_date, to_date, lines, imported_by_name) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [ba.id, b.file_name ?? null, lines.map((l) => l.txn_date).sort()[0], lines.map((l) => l.txn_date).sort().at(-1), lines.length, req.user!.name]);
      let dup = 0, auto = 0;
      for (const l of lines) {
        const fp = `${l.txn_date}|${l.debit}|${l.credit}|${l.ref ?? ''}|${l.description.replace(/\s+/g, ' ').toLowerCase()}`;
        const seen = await one(c, `SELECT 1 FROM bank_lines WHERE bank_account_id = $1 AND fingerprint = $2 AND status <> 'duplicate'`, [ba.id, fp]);
        const ins = await one<{ id: string }>(c, `INSERT INTO bank_lines (statement_id, bank_account_id, txn_date, description, ref, debit, credit, balance, fingerprint, status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
          [st!.id, ba.id, l.txn_date, l.description, l.ref, l.debit, l.credit, l.balance, fp, seen ? 'duplicate' : 'unmatched']);
        if (seen) { dup++; continue; }
        const cand = await candidates(c, ba, l);
        // Match automatically only when there is one obvious entry (a reference match, or the only amount match).
        const pick = cand.filter((x) => x.ref_match).length === 1 ? cand.find((x) => x.ref_match) : cand.length === 1 ? cand[0] : null;
        if (pick) { await c.query(`UPDATE bank_lines SET status = 'matched', voucher_id = $2, matched_by_name = 'auto', matched_at = now() WHERE id = $1`, [ins!.id, pick.voucher_id]); auto++; }
      }
      await c.query('UPDATE bank_statements SET duplicates = $2, auto_matched = $3 WHERE id = $1', [st!.id, dup, auto]);
      await auditReq(c, req, 'bank_statement', st!.id, 'imported', { after: { lines: lines.length, duplicates: dup, auto_matched: auto } });
      return { id: st!.id, lines: lines.length, duplicates: dup, auto_matched: auto };
    });
    res.status(201).json(out);
  });

  r.get('/bank-accounts/:id/reconciliation', requirePermission('finance.read'), async (req, res) => {
    const ba = await one<{ id: string; account_id: string; bank_name: string; account_no: string }>(pool, `SELECT ba.*, a.name AS account_name FROM bank_accounts ba JOIN accounts a ON a.id = ba.account_id WHERE ba.id = $1`, [req.params.id]);
    if (!ba) throw notFound('Bank account');
    const status = (req.query.status as string) || 'unmatched';
    const lines = await many<{ txn_date: string; debit: number; credit: number; ref: string | null; description: string }>(pool, `SELECT b.*, b.txn_date::text, b.debit::float, b.credit::float, b.balance::float, v.number AS voucher_no FROM bank_lines b LEFT JOIN vouchers v ON v.id = b.voucher_id
      WHERE b.bank_account_id = $1 AND ($2 = 'all' OR b.status = $2) ORDER BY b.txn_date DESC, b.id LIMIT 500`, [ba.id, status]);
    const withCand = status === 'unmatched' ? await Promise.all(lines.map(async (l) => ({ ...l, candidates: await candidates(pool, ba, l) }))) : lines;
    // Entries in the books not yet seen on the statement (cheques not presented, deposits in transit).
    const unpresented = await many<{ debit: number; credit: number }>(pool, `SELECT v.id AS voucher_id, v.number, v.voucher_date::text AS date, v.narration, l.debit::float, l.credit::float FROM voucher_lines l JOIN vouchers v ON v.id = l.voucher_id
      WHERE l.account_id = $1 AND v.status IN ('posted','reversed') AND v.voucher_type <> 'opening' AND NOT EXISTS (SELECT 1 FROM bank_lines b WHERE b.voucher_id = v.id) AND NOT ((v.status = 'reversed' AND NOT EXISTS (SELECT 1 FROM bank_lines b0 WHERE b0.voucher_id = v.id)) OR (v.reversal_of IS NOT NULL AND NOT EXISTS (SELECT 1 FROM bank_lines b0 WHERE b0.voucher_id = v.reversal_of))) ORDER BY v.voucher_date DESC LIMIT 200`, [ba.account_id]);
    const bal = await one<{ book: number; stmt: number | null }>(pool, `SELECT (SELECT coalesce(sum(l.debit - l.credit), 0)::float FROM voucher_lines l JOIN vouchers v ON v.id = l.voucher_id WHERE l.account_id = $1 AND v.status IN ('posted','reversed')) AS book,
      (SELECT balance::float FROM bank_lines x WHERE x.bank_account_id = $2 AND balance IS NOT NULL ORDER BY txn_date DESC, id DESC LIMIT 1) AS stmt`, [ba.account_id, ba.id]);
    const unmatchedStmt = await one<{ cr: number; dr: number }>(pool, `SELECT coalesce(sum(credit), 0)::float AS cr, coalesce(sum(debit), 0)::float AS dr FROM bank_lines WHERE bank_account_id = $1 AND status = 'unmatched'`, [ba.id]);
    const notInBank = { dr: round2(unpresented.reduce((s, x) => s + Number(x.debit), 0)), cr: round2(unpresented.reduce((s, x) => s + Number(x.credit), 0)) };
    // Book balance + bank-only receipts − bank-only payments − book-only receipts + book-only payments = bank balance.
    const derived = round2(bal!.book + unmatchedStmt!.cr - unmatchedStmt!.dr - notInBank.dr + notInBank.cr);
    res.json({ account: ba, lines: withCand, unpresented, summary: { book_balance: bal!.book, statement_balance: bal!.stmt, bank_only_receipts: unmatchedStmt!.cr, bank_only_payments: unmatchedStmt!.dr, book_only_receipts: notInBank.dr, book_only_payments: notInBank.cr, derived_bank_balance: derived, difference: bal!.stmt == null ? null : round2(bal!.stmt - derived) } });
  });

  r.post('/bank-lines/:id/match', requirePermission('finance.bank.reconcile'), async (req, res) => {
    const { voucher_id } = parse(z.object({ voucher_id: z.uuid() }), req.body);
    await tx(pool, async (c) => {
      const l = await one<{ status: string; bank_account_id: string; debit: number; credit: number }>(c, 'SELECT * FROM bank_lines WHERE id = $1 FOR UPDATE', [req.params.id]);
      if (!l || l.status !== 'unmatched') throw conflict('This line is not waiting to be matched');
      const ba = await one<{ account_id: string }>(c, 'SELECT account_id FROM bank_accounts WHERE id = $1', [l.bank_account_id]);
      const hit = await one(c, `SELECT 1 FROM voucher_lines vl JOIN vouchers v ON v.id = vl.voucher_id WHERE vl.voucher_id = $1 AND vl.account_id = $2 AND v.status = 'posted' AND ${Number(l.credit) > 0 ? 'vl.debit' : 'vl.credit'} = $3`, [voucher_id, ba!.account_id, Number(l.credit) > 0 ? l.credit : l.debit]);
      if (!hit) throw badRequest('That voucher does not move this bank account by the same amount');
      if (await one(c, 'SELECT 1 FROM bank_lines WHERE voucher_id = $1', [voucher_id])) throw conflict('That voucher is already matched to another statement line');
      await c.query(`UPDATE bank_lines SET status = 'matched', voucher_id = $2, matched_by_name = $3, matched_at = now() WHERE id = $1`, [req.params.id, voucher_id, req.user!.name]);
      await auditReq(c, req, 'bank_line', String(req.params.id), 'matched', { after: { voucher_id } });
    });
    res.json({ ok: true });
  });

  /** Create the missing voucher from a statement line (bank charges, a customer's direct transfer, a gateway settlement, a supplier payment). */
  r.post('/bank-lines/:id/create', requirePermission('finance.bank.reconcile'), async (req, res) => {
    const b = parse(z.object({ kind: z.enum(['customer_receipt', 'supplier_payment', 'gateway_settlement', 'bank_charges', 'other']), party_id: z.uuid().nullable().optional(), account_id: z.string().optional(), narration: optText(300) }), req.body);
    const party = b.party_id ? await getParty(b.party_id) : null;
    const out = await tx(pool, async (c) => {
      const l = await one<{ id: string; status: string; bank_account_id: string; txn_date: string; description: string; ref: string | null; debit: number; credit: number }>(c, 'SELECT *, txn_date::text FROM bank_lines WHERE id = $1 FOR UPDATE', [req.params.id]);
      if (!l || l.status !== 'unmatched') throw conflict('This line is not waiting to be matched');
      const ba = (await one<{ account_id: string; book_id: string }>(c, 'SELECT * FROM bank_accounts WHERE id = $1', [l.bank_account_id]))!;
      const amt = Number(l.credit) > 0 ? Number(l.credit) : Number(l.debit);
      const inflow = Number(l.credit) > 0;
      let other: { account: string; party_id?: string | null; party_name?: string | null };
      if (b.kind === 'customer_receipt' || b.kind === 'supplier_payment') {
        if (!party) throw badRequest('Choose the customer or supplier');
        if (b.kind === 'customer_receipt' && !inflow || b.kind === 'supplier_payment' && inflow) throw badRequest('The direction of this line does not fit that choice');
        other = { account: b.kind === 'customer_receipt' ? 'receivables' : 'payables', party_id: party.id, party_name: party.legal_name };
      } else if (b.kind === 'gateway_settlement') other = { account: 'gateway_clearing' };
      else if (b.kind === 'bank_charges') other = { account: 'bank_charges' };
      else { if (!b.account_id) throw badRequest('Choose the ledger account'); other = { account: b.account_id }; }
      const type = b.kind === 'gateway_settlement' ? 'contra' : inflow ? 'receipt' : 'payment';
      const v = await post(c, { type, book_id: ba.book_id, date: l.txn_date, narration: b.narration ?? `${l.description}${l.ref ? ` · ${l.ref}` : ''}`, party_id: other.party_id ?? null, party_name: other.party_name ?? null, by: req.user!.name, approved_by: req.user!.name,
        source: { service: 'finance', type: 'bank_line', id: l.id, ref: l.ref },
        lines: inflow ? [{ account: ba.account_id, debit: amt }, { ...other, credit: amt }] : [{ ...other, debit: amt }, { account: ba.account_id, credit: amt }] });
      await c.query(`UPDATE bank_lines SET status = 'matched', voucher_id = $2, matched_by_name = $3, matched_at = now() WHERE id = $1`, [l.id, v.id, req.user!.name]);
      if (b.kind === 'supplier_payment' && party) {
        const dup = await one<{ number: string }>(c, `SELECT v.number FROM vouchers v JOIN voucher_lines x ON x.voucher_id = v.id WHERE v.voucher_type = 'payment' AND v.status = 'posted' AND v.id <> $1 AND x.party_id = $2 AND x.debit = $3 AND abs(v.voucher_date - $4::date) <= 30 LIMIT 1`, [v.id, party.id, amt, l.txn_date]);
        if (dup) await raiseAnomaly(c, { kind: 'duplicate_payment', severity: 'critical', ref_type: 'voucher', ref_id: v.id, ref_label: `${v.number} · ${party.legal_name}`, message: `Bank shows a second payment of ₹${amt.toLocaleString('en-IN')} to ${party.legal_name} within 30 days (${dup.number})`, amount: amt });
      }
      await auditReq(c, req, 'bank_line', l.id, 'voucher_created', { after: { voucher: v.number, kind: b.kind } });
      return v;
    });
    res.status(201).json(out);
  });

  r.post('/bank-lines/:id/ignore', requirePermission('finance.bank.reconcile'), async (req, res) => {
    const { note } = parse(z.object({ note: reqText(300) }), req.body);
    await tx(pool, async (c) => {
      const r1 = await c.query(`UPDATE bank_lines SET status = 'ignored', note = $2, matched_by_name = $3, matched_at = now() WHERE id = $1 AND status IN ('unmatched','duplicate')`, [req.params.id, note, req.user!.name]);
      if (!r1.rowCount) throw conflict('Only unmatched or duplicate lines can be set aside');
      await auditReq(c, req, 'bank_line', String(req.params.id), 'ignored', { reason: note });
    });
    res.json({ ok: true });
  });
  r.post('/bank-lines/:id/unmatch', requirePermission('finance.bank.reconcile'), async (req, res) => {
    await tx(pool, async (c) => {
      const r1 = await c.query(`UPDATE bank_lines SET status = 'unmatched', voucher_id = NULL, matched_by_name = NULL, matched_at = NULL WHERE id = $1 AND status = 'matched' AND NOT EXISTS (SELECT 1 FROM vouchers v WHERE v.id = bank_lines.voucher_id AND v.source_type = 'bank_line')`, [req.params.id]);
      if (!r1.rowCount) throw conflict('Only lines matched to an existing voucher can be unmatched; reverse a voucher created from the line instead');
      await auditReq(c, req, 'bank_line', String(req.params.id), 'unmatched');
    });
    res.json({ ok: true });
  });
}
