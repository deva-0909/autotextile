import { randomUUID } from 'node:crypto';
import type { Router } from 'express';
import { z } from 'zod';
import { type BusEvent, type Client, type ServiceContext, badRequest, conflict, many, notFound, notify, one, optText, parse, reqText, requirePermission, tx } from '@erp/platform';
import { S, auditReq, getParty, primaryBook, round2, today } from './common.ts';
import { openBills } from './ledger.ts';
import { post } from './ledger.ts';

/**
 * Deductions from a mill: quality and shortage claims, and the full value of wrong goods held in quarantine.
 *
 * The moment one is raised it is posted to the mill's ledger (Dr the mill, Cr "Mill claims and holds pending"), so the
 * mill's balance, and so what can be paid to it, drops by that much while the matter is decided. Nothing depends on an
 * accountant remembering it. When the claim is accepted the hold becomes a debit note against the purchase or job-work
 * charge (at the accepted amount); when it is rejected, or the goods are accepted or replaced, the hold is reversed.
 * Every deduction stays on the "pending to apply" list until someone matches it to the mill's bill.
 */
export interface DeductionEvent {
  key: string; mill_id: string; mill_name?: string; kind: 'quality_claim' | 'shortage_claim' | 'quarantine';
  source_id: string; ref: string; job_ref?: string | null; reason?: string | null; date?: string;
  state: 'held' | 'confirmed' | 'released'; amount: number; expense_account?: 'purchases' | 'jobwork'; by?: string | null;
}
interface Row { id: string; key: string; state: string; held_amount: number; confirmed_amount: number; expense_account: string; mill_id: string; mill_name: string; ref: string; kind: string }

const label = (k: string) => (k === 'quarantine' ? 'Quarantine hold' : k === 'shortage_claim' ? 'Shortage claim' : 'Quality claim');

export function millDeductionConsumer() {
  return async (ev: BusEvent, c: Client) => {
    const p = ev.payload as unknown as DeductionEvent;
    const party = await getParty(p.mill_id);
    const book = await primaryBook(c);
    const date = (p.date ?? today()).slice(0, 10);
    const target = round2(Math.max(0, Number(p.amount) || 0));
    let row = await one<Row>(c, 'SELECT *, held_amount::float, confirmed_amount::float FROM mill_deductions WHERE key = $1 FOR UPDATE', [p.key]);
    if (!row) {
      if (p.state !== 'held' && p.state !== 'confirmed') return;
      if (target <= 0) return;
      row = await one<Row>(c, `INSERT INTO mill_deductions (id, key, mill_id, mill_name, kind, source_id, ref, job_ref, reason, expense_account) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        RETURNING *, held_amount::float, confirmed_amount::float`, [randomUUID(), p.key, party.id, party.legal_name, p.kind, p.source_id, p.ref, p.job_ref ?? null, p.reason ?? null, p.expense_account ?? (p.kind === 'shortage_claim' ? 'purchases' : 'jobwork')]);
    }
    if (row!.state !== 'held') return; // confirmed and released are final
    const held = Number(row!.held_amount);
    const expense = p.expense_account ?? row!.expense_account;
    const what = `${label(row!.kind)} ${p.ref} on ${party.legal_name}${p.reason ? ` — ${p.reason}` : ''}`;
    const src = { service: 'jobwork', type: 'mill_deduction', id: `${p.key}:${ev.id}`, ref: p.ref };
    const mill = (debit: number, credit: number) => ({ account: 'payables', debit, credit, party_id: party.id, party_name: party.legal_name, bill_ref: p.ref });
    let voucher: { number: string } | null = null;
    let next = { state: 'held', held, confirmed: 0 };

    if (p.state === 'held') {
      const diff = round2(target - held);
      if (Math.abs(diff) < 0.005) return;
      voucher = await post(c, {
        type: diff > 0 ? 'debit_note' : 'journal', book_id: book.id, date, auto: true, by: p.by ?? 'system', approved_by: 'held from mill payments',
        narration: diff > 0 ? `${what}: ₹${diff.toLocaleString('en-IN')} held from payments until decided` : `${what}: hold reduced by ₹${(-diff).toLocaleString('en-IN')}`,
        party_id: party.id, party_name: party.legal_name, source: src,
        lines: diff > 0 ? [mill(diff, 0), { account: 'mill_holds', credit: diff }] : [{ account: 'mill_holds', debit: -diff }, mill(0, -diff)],
      });
      next = { state: 'held', held: target, confirmed: 0 };
    } else if (p.state === 'confirmed') {
      const extra = round2(target - held);
      const lines = [] as { account: string; debit?: number; credit?: number; party_id?: string; party_name?: string; bill_ref?: string }[];
      if (held > 0) lines.push({ account: 'mill_holds', debit: held });
      if (extra > 0) lines.push(mill(extra, 0)); else if (extra < 0) lines.push(mill(0, -extra));
      if (target > 0) lines.push({ account: expense, credit: target });
      if (lines.length >= 2) voucher = await post(c, {
        type: 'debit_note', book_id: book.id, date, auto: true, by: p.by ?? 'system', approved_by: 'claim accepted',
        narration: `${what}: confirmed at ₹${target.toLocaleString('en-IN')}${held && extra ? ` (₹${held.toLocaleString('en-IN')} was held)` : ''}`,
        party_id: party.id, party_name: party.legal_name, source: src, lines,
      });
      next = { state: target > 0 ? 'confirmed' : 'released', held: 0, confirmed: target };
    } else {
      if (held > 0) voucher = await post(c, {
        type: 'journal', book_id: book.id, date, auto: true, by: p.by ?? 'system', approved_by: 'hold released',
        narration: `${what}: hold of ₹${held.toLocaleString('en-IN')} released`, party_id: party.id, party_name: party.legal_name, source: src,
        lines: [{ account: 'mill_holds', debit: held }, mill(0, held)],
      });
      next = { state: 'released', held: 0, confirmed: 0 };
    }
    await c.query(`UPDATE mill_deductions SET state = $2, held_amount = $3, confirmed_amount = $4, reason = coalesce($5, reason), updated_at = now(),
      history = history || jsonb_build_array(jsonb_build_object('at', now(), 'state', $2::text, 'amount', $6::numeric, 'voucher', $7::text, 'note', $5::text)) WHERE id = $1`,
    [row!.id, next.state, next.held, next.confirmed, p.reason ?? null, target, voucher?.number ?? null]);
    if (p.state === 'held' && held === 0)
      await notify(c, S, { audience_permission: 'finance.voucher.post', kind: 'action', title: `${label(row!.kind)} ${p.ref}: ₹${target.toLocaleString('en-IN')} held from ${party.legal_name}`, body: 'Posted to the mill’s ledger. Apply it to the mill’s next bill.', link: '/finance/mill-deductions' });
  };
}

export function millDeductionRoutes(r: Router, { pool }: ServiceContext) {
  /** Everything held or deducted from mills; "pending" = not yet matched to a mill bill. */
  r.get('/mill-deductions', requirePermission('finance.read'), async (req, res) => {
    const f = String(req.query.filter ?? 'pending');
    const where = f === 'pending' ? `state <> 'released' AND applied_bill_ref IS NULL` : f === 'applied' ? 'applied_bill_ref IS NOT NULL' : f === 'released' ? `state = 'released'` : 'true';
    const params: unknown[] = [];
    let mill = '';
    if (/^[0-9a-f-]{36}$/i.test(String(req.query.mill_id ?? ''))) { params.push(req.query.mill_id); mill = ` AND mill_id = $${params.length}`; }
    const rows = await many(pool, `SELECT id, mill_id, mill_name, kind, ref, job_ref, reason, state, held_amount::float, confirmed_amount::float, (held_amount + confirmed_amount)::float AS amount,
      applied_bill_ref, applied_at, applied_by_name, applied_note, history, created_at, updated_at,
      (current_date - created_at::date) AS age_days FROM mill_deductions WHERE ${where}${mill} ORDER BY created_at DESC LIMIT 500`, params);
    const byMill = await many(pool, `SELECT mill_id, mill_name, count(*)::int AS count, sum(held_amount)::float AS held, sum(confirmed_amount)::float AS confirmed
      FROM mill_deductions WHERE state <> 'released' AND applied_bill_ref IS NULL GROUP BY mill_id, mill_name ORDER BY sum(held_amount + confirmed_amount) DESC`);
    res.json({ rows, by_mill: byMill });
  });

  /** Amount held or deducted per mill and not yet matched to a bill: shown wherever the mill is paid. */
  r.get('/mill-deductions/pending-by-party', requirePermission('finance.read'), async (_req, res) => {
    res.json(await pendingByParty(pool));
  });

  /** Match a deduction to the mill bill it was adjusted in. */
  r.post('/mill-deductions/:id/apply', requirePermission('finance.voucher.post'), async (req, res) => {
    const b = parse(z.object({ bill_ref: reqText(60), note: optText(300) }), req.body);
    res.json(await tx(pool, async (c) => {
      const d = await one<Row & { applied_bill_ref: string | null }>(c, 'SELECT * FROM mill_deductions WHERE id = $1 FOR UPDATE', [req.params.id]);
      if (!d) throw notFound('Mill deduction');
      if (d.state === 'released') throw conflict('This hold was released; there is nothing to apply');
      if (d.applied_bill_ref) throw conflict(`Already applied to ${d.applied_bill_ref}`);
      const bill = await one(c, `SELECT 1 FROM bills WHERE kind = 'payable' AND party_id = $1 AND doc_no = $2`, [d.mill_id, b.bill_ref]);
      if (!bill) throw badRequest(`${b.bill_ref} is not a bill from ${d.mill_name}`, { fields: { bill_ref: 'Choose one of the mill’s bills' } });
      await c.query(`UPDATE mill_deductions SET applied_bill_ref = $2, applied_note = $3, applied_at = now(), applied_by_name = $4, updated_at = now() WHERE id = $1`, [d.id, b.bill_ref, b.note ?? null, req.user!.name]);
      await auditReq(c, req, 'mill_deduction', d.id, 'applied', { after: { bill_ref: b.bill_ref }, reason: b.note ?? null });
      return { applied: true, bill_ref: b.bill_ref };
    }));
  });

  /** The mill's bills, to choose from when applying. */
  r.get('/mill-deductions/:id/bills', requirePermission('finance.read'), async (req, res) => {
    const d = await one<{ mill_id: string }>(pool, 'SELECT mill_id FROM mill_deductions WHERE id = $1', [req.params.id]);
    if (!d) throw notFound('Mill deduction');
    const { bills } = await openBills(pool, 'payable');
    const open = bills.filter((x) => x.party_id === d.mill_id);
    const recent = await many(pool, `SELECT doc_no, doc_date::text, amount::float FROM bills WHERE kind = 'payable' AND party_id = $1 ORDER BY doc_date DESC LIMIT 20`, [d.mill_id]);
    res.json({ open: open.map((x) => ({ doc_no: x.doc_no, doc_date: x.doc_date, outstanding: x.outstanding })), recent });
  });
}

export async function pendingByParty(c: ServiceContext['pool'] | Client) {
  return many<{ party_id: string; held: number; confirmed: number; count: number }>(c, `SELECT mill_id AS party_id, sum(held_amount)::float AS held, sum(confirmed_amount)::float AS confirmed, count(*)::int AS count
    FROM mill_deductions WHERE state <> 'released' AND applied_bill_ref IS NULL GROUP BY mill_id`);
}
