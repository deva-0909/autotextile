import type { Router } from 'express';
import { z } from 'zod';
import { type ServiceContext, badRequest, callService, many, notFound, one, parse, requirePermission, tx } from '@erp/platform';
import { S, auditReq, getParty, round2, today } from './common.ts';
import { openBills } from './ledger.ts';
import { recentBankChange } from './postings.ts';
import { paySupplierBill } from './vouchers.ts';
import { pendingByParty } from './deductions.ts';

/**
 * Supplier payment runs: choose the bills to pay (due and overdue first), pay them together through the same rules as
 * a single payment (approval limit, recent bank-detail change), and download the bank's bulk-upload file for the
 * payments released. Payments waiting for a checker stay out of the file until approved.
 */
interface Bank { account_name: string; account_number: string; ifsc: string; bank_name: string | null; status: string }
interface RunItem { party?: string; party_id?: string; invoice: string; amount?: number; voucher?: string; status: string; error?: string; bank?: { name: string; account_number: string; ifsc: string } }
const csvCell = (v: unknown) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

async function bankOf(partyId: string): Promise<Bank | null> {
  const p = await callService<{ bank_accounts?: Bank[] }>(S, 'masters', 'GET', `/parties/${partyId}`).catch(() => null);
  return p?.bank_accounts?.find((b) => b.status === 'active') ?? null;
}

export function paymentRunRoutes(r: Router, { pool }: ServiceContext) {
  /** Bills still owed to suppliers, oldest due first, with the payee's approved bank account. */
  r.get('/payment-run/candidates', requirePermission('finance.read'), async (_req, res) => {
    const { bills } = await openBills(pool, 'payable');
    const open = bills.filter((b) => b.outstanding > 0.005).sort((a, b) => a.due_date.localeCompare(b.due_date));
    const banks = new Map<string, Bank | null>();
    for (const id of new Set(open.map((b) => b.party_id))) banks.set(id, await bankOf(id));
    const pending = await many<{ party_id: string; bill_ref: string }>(pool, `SELECT l.party_id, l.bill_ref FROM voucher_lines l JOIN vouchers v ON v.id = l.voucher_id
      WHERE v.status = 'pending_approval' AND v.source_type = 'supplier_payment' AND l.bill_ref IS NOT NULL`);
    const t = today();
    const held = new Map((await pendingByParty(pool)).map((d) => [d.party_id, d]));
    res.json(await Promise.all(open.map(async (b) => {
      const bank = banks.get(b.party_id) ?? null;
      return {
        party_id: b.party_id, party_name: b.party_name, doc_no: b.doc_no, doc_date: b.doc_date, due_date: b.due_date, outstanding: b.outstanding,
        days_overdue: Math.max(0, Math.round((Date.parse(t) - Date.parse(b.due_date)) / 86_400_000)),
        bank: bank ? { name: bank.account_name, account: `••••${bank.account_number.slice(-4)}`, ifsc: bank.ifsc, bank_name: bank.bank_name } : null,
        bank_changed_recently: !!(await recentBankChange(pool as never, b.party_id)),
        awaiting_approval: pending.some((p) => p.party_id === b.party_id && p.bill_ref === b.doc_no),
        // Claims and quarantine holds already reduce the mill's balance; shown so they are applied to this bill.
        deductions_pending: held.has(b.party_id) ? round2(held.get(b.party_id)!.held + held.get(b.party_id)!.confirmed) : 0,
        deductions_count: held.get(b.party_id)?.count ?? 0,
      };
    })));
  });

  r.get('/payment-runs', requirePermission('finance.read'), async (_req, res) => {
    const runs = await many<{ id: string; items: RunItem[] }>(pool, `SELECT id, number, run_date::text, mode, total::float, items, jsonb_array_length(items) AS count, created_by_name, created_at FROM payment_runs ORDER BY created_at DESC LIMIT 50`);
    const posted = await postedNumbers(runs.flatMap((x) => x.items));
    res.json(runs.map(({ items, ...x }) => ({ ...x, released: round2(items.filter((i) => i.voucher && posted.has(i.voucher)).reduce((t, i) => t + (i.amount ?? 0), 0)),
      waiting: items.filter((i) => i.voucher && !posted.has(i.voucher) && i.status !== 'failed').length })));
  });
  // The bank file carries full account numbers: only people who can release payments may open it.
  r.get('/payment-runs/:id', requirePermission('finance.voucher.post'), async (req, res) => {
    const run = await one<{ id: string; number: string; run_date: string; mode: string; items: RunItem[] }>(pool, `SELECT *, run_date::text, total::float FROM payment_runs WHERE id = $1`, [req.params.id]);
    if (!run) throw notFound('Payment run');
    res.json({ ...run, ...(await bankFile(run)) });
  });

  /** Vouchers among these that are posted (approved payments included; ones still waiting for a checker are not). */
  async function postedNumbers(items: RunItem[]) {
    const nums = [...new Set(items.map((i) => i.voucher).filter(Boolean))] as string[];
    if (!nums.length) return new Set<string>();
    return new Set((await many<{ number: string }>(pool, `SELECT number FROM vouchers WHERE number = ANY($1) AND status = 'posted'`, [nums])).map((x) => x.number));
  }
  /** The bank's bulk-upload file for the run's payments that are posted now, with each item's current state. */
  async function bankFile(run: { number: string; run_date: string; mode: string; items: RunItem[] }) {
    const posted = await postedNumbers(run.items);
    const debit = await one<{ account_no: string }>(pool, `SELECT account_no FROM bank_accounts ORDER BY created_at LIMIT 1`).catch(() => null);
    const rows = [['Payment Mode', 'Debit Account No', 'Beneficiary Name', 'Beneficiary Account No', 'IFSC', 'Amount', 'Value Date', 'Remarks'].join(',')];
    const items = run.items.map((i) => ({ ...i, status: i.voucher ? (posted.has(i.voucher) ? 'posted' : 'pending_approval') : i.status }));
    for (const [n, i] of items.entries()) if (i.status === 'posted' && i.bank)
      rows.push([run.mode.toUpperCase(), debit?.account_no ?? '', i.bank.name, i.bank.account_number, i.bank.ifsc, Number(i.amount).toFixed(2), run.run_date.split('-').reverse().join('/'), `${i.invoice} ${run.number}/${n + 1}`].map(csvCell).join(','));
    const released = round2(items.filter((i) => i.status === 'posted').reduce((t, i) => t + (i.amount ?? 0), 0));
    return { items, released, bank_file: rows.length > 1 ? rows.join('\n') : null };
  }

  r.post('/payment-runs', requirePermission('finance.voucher.post'), async (req, res) => {
    const b = parse(z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), mode: z.enum(['neft', 'rtgs']).default('neft'),
      items: z.array(z.object({ party_id: z.uuid(), invoice_number: z.string().min(1).max(60), amount: z.number().positive().optional() })).min(1).max(200) }), req.body);
    if (b.date > today()) throw badRequest('A payment run cannot be dated in the future');
    const number = await tx(pool, async (c) => {
      await c.query(`SELECT pg_advisory_xact_lock(hashtext('payment_run_number'))`);
      const n = (await one<{ n: number }>(c, 'SELECT count(*)::int + 1 AS n FROM payment_runs'))!.n;
      return `PR/${b.date.slice(2, 4)}${String(Number(b.date.slice(2, 4)) + 1).padStart(2, '0')}/${String(n).padStart(4, '0')}`;
    });
    const items: RunItem[] = [];
    let total = 0;
    for (const [i, it] of b.items.entries()) {
      const reference = `${number}/${i + 1}`;
      try {
        const party = await getParty(it.party_id);
        const bank = await bankOf(party.id);
        if (!bank) throw badRequest(`${party.legal_name} has no approved bank account`);
        const out = await tx(pool, (c) => paySupplierBill(c, req, party, { invoice_number: it.invoice_number, amount: it.amount, date: b.date, mode: b.mode, reference }));
        total = round2(total + out.amount);
        items.push({ party: party.legal_name, party_id: party.id, invoice: it.invoice_number, amount: out.amount, voucher: out.number, status: out.status, bank: { name: bank.account_name, account_number: bank.account_number, ifsc: bank.ifsc } });
      } catch (e) {
        items.push({ party_id: it.party_id, invoice: it.invoice_number, status: 'failed', error: (e as Error).message });
      }
    }
    const file = await bankFile({ number, run_date: b.date, mode: b.mode, items });
    const run = await tx(pool, async (c) => {
      const x = await one<{ id: string }>(c, `INSERT INTO payment_runs (number, run_date, mode, total, released, items, created_by_name) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [number, b.date, b.mode, total, file.released, JSON.stringify(items), req.user!.name]);
      await auditReq(c, req, 'payment_run', x!.id, 'created', { after: { number, total, released: file.released, items: items.length } });
      return x!;
    });
    res.status(201).json({ id: run.id, number, total, ...file });
  });
}
