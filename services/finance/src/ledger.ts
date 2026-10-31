import { type Client, type Pool, badRequest, conflict, many, one } from '@erp/platform';
import { addDays, fyOf, monthOf, round2 } from './common.ts';

export type VoucherType = 'journal' | 'sales' | 'purchase' | 'receipt' | 'payment' | 'contra' | 'credit_note' | 'debit_note' | 'transfer' | 'opening' | 'closing' | 'payroll';
const PREFIX: Record<VoucherType, string> = { journal: 'JV', sales: 'SV', purchase: 'PV', receipt: 'RV', payment: 'PY', contra: 'CV', credit_note: 'CN', debit_note: 'DN', transfer: 'TV', opening: 'OB', closing: 'CL', payroll: 'PR' };

export interface Account { id: string; code: string; name: string; type: 'asset' | 'liability' | 'equity' | 'income' | 'expense'; group_name: string; section: string; system_key: string | null; control: string | null; is_bank: boolean; eliminate_on_consolidation: boolean; allow_manual: boolean; status: string }

let accountCache: { at: number; rows: Account[] } | null = null;
export async function accounts(c: Client | Pool, fresh = false): Promise<Account[]> {
  if (!fresh && accountCache && Date.now() - accountCache.at < 10_000) return accountCache.rows;
  const { rows } = await c.query<Account>('SELECT * FROM accounts ORDER BY code');
  accountCache = { at: Date.now(), rows };
  return rows;
}
export const forgetAccounts = () => { accountCache = null; };
/** Resolve a system key ("receivables"), code ("1300") or id. */
export async function account(c: Client | Pool, ref: string): Promise<Account> {
  const all = await accounts(c);
  const a = all.find((x) => x.system_key === ref || x.code === ref || x.id === ref);
  if (!a) throw badRequest(`Unknown account ${ref}`);
  return a;
}

export interface PostLine { account: string; debit?: number; credit?: number; party_id?: string | null; party_name?: string | null; bill_ref?: string | null; narration?: string | null }
export interface TaxLine { direction: 'outward' | 'inward'; doc_type: 'invoice' | 'credit_note' | 'debit_note' | 'transfer'; doc_no: string; doc_date: string; party_id?: string | null; party_name?: string | null; party_gstin?: string | null; place_of_supply?: string | null; hsn?: string | null; rate: number; taxable: number; cgst: number; sgst: number; igst: number; reverse_charge?: boolean; itc_eligible?: boolean; sku?: string | null; qty_kg?: number | null }
export interface PostInput {
  type: VoucherType; book_id: string; date: string; narration: string;
  party_id?: string | null; party_name?: string | null;
  source?: { service: string; type: string; id: string; ref?: string | null };
  lines: PostLine[];
  by: string; approved_by?: string | null; manual?: boolean;
  /** pending_approval vouchers are stored but do not affect balances until approved. */
  status?: 'posted' | 'pending_approval';
  /** Automatic postings into a locked month move to the next open month instead of failing. */
  auto?: boolean;
  tax?: TaxLine[];
  bill?: { kind: 'receivable' | 'payable'; party_id: string; party_name: string; doc_no: string; doc_date: string; due_date: string; amount: number };
  reversal_of?: string | null;
}

export async function periodOpen(c: Client | Pool, date: string) {
  const p = await one<{ status: string }>(c, 'SELECT status FROM periods WHERE month = $1', [monthOf(date)]);
  return !p || p.status === 'open';
}
async function postingDate(c: Client, date: string, auto: boolean) {
  if (await periodOpen(c, date)) return { date, moved: false };
  if (!auto) throw conflict(`${date.slice(0, 7)} is locked. Choose a date in an open period or ask for the period to be reopened.`);
  let d = date;
  for (let i = 0; i < 24; i++) {
    const next = new Date(`${monthOf(d)}T00:00:00Z`); next.setUTCMonth(next.getUTCMonth() + 1);
    d = next.toISOString().slice(0, 10);
    if (await periodOpen(c, d)) return { date: d, moved: true };
  }
  throw conflict('No open period to post into');
}

/**
 * The only way entries reach the ledger. Debits must equal credits; automatic postings absorb a rounding
 * difference of up to ₹1. Idempotent on (source service, type, id): a replayed event returns the existing voucher.
 */
export async function post(c: Client, v: PostInput): Promise<{ id: string; number: string; existing?: boolean; date: string }> {
  if (v.source) {
    const ex = await one<{ id: string; number: string; voucher_date: string }>(c, `SELECT id, number, voucher_date::text FROM vouchers WHERE source_service = $1 AND source_type = $2 AND source_id = $3 AND status <> 'rejected'`, [v.source.service, v.source.type, v.source.id]);
    if (ex) return { id: ex.id, number: ex.number, existing: true, date: ex.voucher_date };
  }
  const lines = v.lines.map((l) => ({ ...l, debit: round2(l.debit ?? 0), credit: round2(l.credit ?? 0) })).filter((l) => l.debit > 0 || l.credit > 0);
  if (lines.length < 2) throw badRequest('A voucher needs at least two lines');
  for (const l of lines) if (l.debit > 0 && l.credit > 0) throw badRequest('A line is either a debit or a credit');
  const dr = round2(lines.reduce((s, l) => s + l.debit, 0));
  const cr = round2(lines.reduce((s, l) => s + l.credit, 0));
  const diff = round2(dr - cr);
  if (diff !== 0) {
    if (v.manual || Math.abs(diff) > 1) throw badRequest(`Debits (₹${dr.toLocaleString('en-IN')}) and credits (₹${cr.toLocaleString('en-IN')}) do not match`);
    lines.push({ account: 'rounding', debit: diff < 0 ? -diff : 0, credit: diff > 0 ? diff : 0, narration: 'Rounding' });
  }
  const resolved = [];
  for (const l of lines) {
    const a = await account(c, l.account);
    if (a.status !== 'active') throw badRequest(`${a.code} ${a.name} is inactive`);
    if (v.manual && !a.allow_manual && !(v.type === 'opening' && a.system_key === 'inventory')) throw badRequest(`${a.code} ${a.name} is posted only by the system (from invoices, receipts and stock)`);
    if (a.control && a.control !== 'inter_unit' && !l.party_id) throw badRequest(`${a.name} needs a customer or supplier on the line`);
    resolved.push({ ...l, a });
  }
  const { date, moved } = await postingDate(c, v.date, !!v.auto);
  const amount = Math.max(dr, cr);
  const fy = fyOf(date);
  const { rows: [n] } = await c.query(`INSERT INTO counters (doc_type, next_number) VALUES ($1, 2) ON CONFLICT (doc_type) DO UPDATE SET next_number = counters.next_number + 1 RETURNING next_number - 1 AS n`, [`${v.type}:${fy}`]);
  const number = `${PREFIX[v.type]}/${fy}/${String(n.n).padStart(5, '0')}`;
  const status = v.status ?? 'posted';
  const voucher = await one<{ id: string }>(c, `
    INSERT INTO vouchers (number, voucher_type, book_id, voucher_date, narration, party_id, party_name, amount, source_service, source_type, source_id, source_ref, status, manual, created_by_name, approved_by_name, posted_at, reversal_of)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING id`,
  [number, v.type, v.book_id, date, moved ? `${v.narration} (dated ${v.date}; that period is locked)` : v.narration, v.party_id ?? null, v.party_name ?? null, amount,
    v.source?.service ?? 'finance', v.source?.type ?? null, v.source?.id ?? null, v.source?.ref ?? null, status, !!v.manual, v.by, v.approved_by ?? null, status === 'posted' ? new Date() : null, v.reversal_of ?? null]);
  let i = 0;
  for (const l of resolved) {
    await c.query(`INSERT INTO voucher_lines (voucher_id, line_no, account_id, party_id, party_name, debit, credit, bill_ref, narration) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [voucher!.id, ++i, l.a.id, l.party_id ?? null, l.party_name ?? null, l.debit, l.credit, l.bill_ref ?? null, l.narration ?? null]);
  }
  for (const t of v.tax ?? []) {
    await c.query(`INSERT INTO tax_lines (voucher_id, book_id, direction, doc_type, doc_no, doc_date, party_id, party_name, party_gstin, place_of_supply, hsn, rate, taxable, cgst, sgst, igst, reverse_charge, itc_eligible, sku, qty_kg)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
    [voucher!.id, v.book_id, t.direction, t.doc_type, t.doc_no, t.doc_date, t.party_id ?? null, t.party_name ?? null, t.party_gstin ?? null, t.place_of_supply ?? null, t.hsn ?? null, t.rate,
      round2(t.taxable), round2(t.cgst), round2(t.sgst), round2(t.igst), !!t.reverse_charge, t.itc_eligible ?? true, t.sku ?? null, t.qty_kg ?? null]);
  }
  if (v.bill) {
    await c.query(`INSERT INTO bills (kind, book_id, party_id, party_name, doc_no, doc_date, due_date, amount, voucher_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      ON CONFLICT (kind, party_id, doc_no) DO NOTHING`, [v.bill.kind, v.book_id, v.bill.party_id, v.bill.party_name, v.bill.doc_no, v.bill.doc_date, v.bill.due_date, round2(v.bill.amount), voucher!.id]);
  }
  return { id: voucher!.id, number, date };
}

/** Reverse a posted voucher with an equal and opposite one; the original stays visible. */
export async function reverse(c: Client, id: string, by: string, reason: string, date: string) {
  const v = await one<{ id: string; number: string; voucher_type: VoucherType; book_id: string; status: string; party_id: string | null; party_name: string | null }>(c, 'SELECT * FROM vouchers WHERE id = $1 FOR UPDATE', [id]);
  if (!v) throw badRequest('Voucher not found');
  if (v.status !== 'posted') throw conflict(`Only posted vouchers can be reversed (this one is ${v.status.replace('_', ' ')})`);
  const lines = await many<{ account_id: string; party_id: string | null; party_name: string | null; debit: number; credit: number; bill_ref: string | null }>(c, 'SELECT * FROM voucher_lines WHERE voucher_id = $1 ORDER BY line_no', [id]);
  const r = await post(c, { type: v.voucher_type === 'journal' ? 'journal' : v.voucher_type, book_id: v.book_id, date, narration: `Reversal of ${v.number}: ${reason}`, party_id: v.party_id, party_name: v.party_name, by, approved_by: by, reversal_of: v.id,
    lines: lines.map((l) => ({ account: l.account_id, debit: Number(l.credit), credit: Number(l.debit), party_id: l.party_id, party_name: l.party_name, bill_ref: l.bill_ref })) });
  await c.query(`UPDATE vouchers SET status = 'reversed', reversed_by = $2 WHERE id = $1`, [id, r.id]);
  // A reversed bill no longer counts as outstanding.
  await c.query(`DELETE FROM bills WHERE voucher_id = $1`, [id]);
  await c.query(`DELETE FROM tax_lines WHERE voucher_id = $1`, [id]).catch(() => undefined);
  return r;
}

/** Bills still open for a party, settled first-in-first-out against the party's balance on the control account. */
export async function openBills(c: Client | Pool, kind: 'receivable' | 'payable', partyId?: string | null, asOf?: string) {
  const ctl = kind === 'receivable' ? 'receivables' : 'payables';
  const params: unknown[] = [ctl, asOf ?? '9999-12-31'];
  let pf = '';
  if (partyId) { params.push(partyId); pf = `AND l.party_id = $${params.length}`; }
  const balances = await many<{ party_id: string; party_name: string; balance: number }>(c, `
    SELECT l.party_id, max(l.party_name) AS party_name, round(sum(${kind === 'receivable' ? 'l.debit - l.credit' : 'l.credit - l.debit'}), 2)::float AS balance
    FROM voucher_lines l JOIN vouchers v ON v.id = l.voucher_id JOIN accounts a ON a.id = l.account_id
    WHERE a.system_key = $1 AND v.status IN ('posted','reversed') AND v.voucher_date <= $2 ${pf} GROUP BY l.party_id`, params);
  const bp: unknown[] = [kind, asOf ?? '9999-12-31'];
  let bpf = '';
  if (partyId) { bp.push(partyId); bpf = `AND party_id = $${bp.length}`; }
  const bills = await many<{ id: string; party_id: string; party_name: string; doc_no: string; doc_date: string; due_date: string; amount: number; book_id: string }>(c,
    `SELECT id, party_id, party_name, doc_no, doc_date::text, due_date::text, amount::float, book_id FROM bills WHERE kind = $1 AND doc_date <= $2 ${bpf} ORDER BY doc_date DESC, created_at DESC`, bp);
  const out: { id: string; party_id: string; party_name: string; doc_no: string; doc_date: string; due_date: string; amount: number; outstanding: number; book_id: string }[] = [];
  const parties: { party_id: string; party_name: string; balance: number; billed_outstanding: number; on_account: number }[] = [];
  for (const p of balances) {
    let left = Number(p.balance);
    let billed = 0;
    // The newest bills are the ones still unpaid.
    for (const b of bills.filter((x) => x.party_id === p.party_id)) {
      if (left <= 0.005) break;
      const o = round2(Math.min(left, b.amount));
      out.push({ ...b, outstanding: o });
      billed += o; left = round2(left - o);
    }
    parties.push({ party_id: p.party_id, party_name: p.party_name, balance: Number(p.balance), billed_outstanding: round2(billed), on_account: round2(Number(p.balance) - billed) });
  }
  return { bills: out.sort((a, b) => a.due_date.localeCompare(b.due_date)), parties };
}

/** Days overdue → ageing bucket label. */
export function bucketOf(dueDate: string, asOf: string) {
  const days = Math.floor((new Date(`${asOf}T00:00:00Z`).getTime() - new Date(`${dueDate}T00:00:00Z`).getTime()) / 86_400_000);
  if (days <= 0) return 'not_due';
  if (days <= 30) return 'd1_30';
  if (days <= 60) return 'd31_60';
  if (days <= 90) return 'd61_90';
  return 'd90_plus';
}
export const dueIn = (date: string, days: number) => addDays(date, days);
