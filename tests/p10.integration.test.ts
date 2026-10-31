/** End-to-end tests for P10: report builder, control tower, intelligence, assistant (built-in mode), continuity (backup, restore test, replay). */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { publish, tx } from '@erp/platform';
import { bootAll } from './harness.ts';
import { runScheduledReports } from '../services/insights/src/automation.ts';

let h: Awaited<ReturnType<typeof bootAll>>;
const t: Record<string, string> = {};
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
const sur = () => h.ok(t.accounts!, 'GET', '/finance/books').then((b: { state_code: string; gstin: string }[]) => b.find((x) => x.state_code === '24')!.gstin);

before(async () => {
  h = await bootAll('p10');
  for (const [k, email] of Object.entries({ admin: 'admin@textile.local', owner: 'owner@textile.local', accounts: 'accounts@textile.local', sales: 'sales@textile.local', stores: 'surat.stores@textile.local' })) t[k] = await h.login(email);
  const gstin = await sur();
  // Two customers, three invoices over time, one credit note.
  const inv = (id: string, no: string, cust: string, name: string, date: string, taxable: number) => tx(h.svc('fulfilment').ctx.pool, (c) => publish(c, 'fulfilment', 'fulfilment.invoiced', { fulfilment_id: id, invoice_no: no, invoice_date: date, gstin, customer_id: cust, customer_name: name, customer_gstin: null, place_of_supply: '24', payment_terms: 'credit', taxable, cgst: taxable * 0.025, sgst: taxable * 0.025, igst: 0, total: taxable * 1.05 }));
  await inv('00000000-0000-4000-8000-000000000101', 'SRTI/1', h.parties['Sri Murugan Garments']!, 'Sri Murugan Garments', daysAgo(120), 200000);
  await inv('00000000-0000-4000-8000-000000000102', 'SRTI/2', h.parties['Sri Murugan Garments']!, 'Sri Murugan Garments', daysAgo(90), 150000);
  await inv('00000000-0000-4000-8000-000000000103', 'SRTI/3', h.parties['Delhi Fashion Hub']!, 'Delhi Fashion Hub', daysAgo(10), 80000);
  await h.drain();
});
after(async () => h.close());

describe('P10 reports and dashboards', () => {
  test('report builder: group and total, AND/OR filters, date grain, CSV; data the user cannot see is refused', async () => {
    const byCust = await h.ok(t.accounts!, 'POST', '/insights/reports/run', { dataset: 'sales_register', group_by: ['party_name'], measures: [{ field: 'taxable', agg: 'sum' }, { field: 'doc_no', agg: 'count_distinct' }], sort: { field: 'sum_taxable', dir: 'desc' } });
    assert.deepEqual(byCust.rows.map((r: { party_name: string }) => r.party_name), ['Sri Murugan Garments', 'Delhi Fashion Hub']);
    assert.equal(byCust.rows[0].sum_taxable, 350000);
    assert.equal(byCust.totals.sum_taxable, 430000);
    const orf = await h.ok(t.accounts!, 'POST', '/insights/reports/run', { dataset: 'sales_register', filters: { logic: 'or', rules: [{ field: 'doc_no', op: 'eq', value: 'SRTI/1' }, { field: 'party_name', op: 'contains', value: 'delhi' }] }, columns: ['doc_no', 'party_name', 'taxable'] });
    assert.equal(orf.rows.length, 2);
    const andf = await h.ok(t.accounts!, 'POST', '/insights/reports/run', { dataset: 'sales_register', filters: { logic: 'and', rules: [{ field: 'party_name', op: 'contains', value: 'murugan' }, { field: 'taxable', op: 'gt', value: 160000 }] } });
    assert.equal(andf.rows.length, 1);
    const monthly = await h.ok(t.accounts!, 'POST', '/insights/reports/run', { dataset: 'sales_register', group_by: ['doc_date'], date_grain: 'month', measures: [{ field: 'taxable', agg: 'sum' }] });
    assert.ok(monthly.rows.every((r: { doc_date: string }) => /^\d{4}-\d{2}$/.test(r.doc_date)));
    assert.equal((await h.call(t.sales!, 'POST', '/insights/reports/run', { dataset: 'sales_register' })).status, 403, 'sales staff cannot read the sales register');
    const ds = await h.ok(t.sales!, 'GET', '/insights/datasets');
    assert.ok(!ds.some((d: { key: string }) => d.key === 'sales_register') && ds.some((d: { key: string }) => d.key === 'leads'));
  });

  test('saved report: share, snapshot now, scheduled run with the owner’s own access, recipients notified', async () => {
    const r = await h.ok(t.accounts!, 'POST', '/insights/reports', { name: 'Sales by customer', definition: { dataset: 'sales_register', group_by: ['party_name'], measures: [{ field: 'taxable', agg: 'sum' }] }, shared: true, schedule: 'daily' });
    await h.ok(t.accounts!, 'POST', `/insights/reports/${r.id}/snapshot`);
    await h.svc('insights').ctx.pool.query(`UPDATE insights.reports SET next_run_at = now() - interval '1 minute' WHERE id = $1`, [r.id]);
    assert.equal((await runScheduledReports(h.svc('insights').ctx.pool)).ran, 1);
    const d = await h.ok(t.owner!, 'GET', `/insights/reports/${r.id}`);
    assert.equal(d.snapshots.length, 2);
    const snap = await h.ok(t.owner!, 'GET', `/insights/reports/${r.id}/snapshots/${d.snapshots[0].id}`);
    assert.equal(snap.result.rows.length, 2);
    assert.equal((await h.call(t.sales!, 'PUT', `/insights/reports/${r.id}`, { name: 'x', definition: { dataset: 'leads' } })).status, 403);
  });

  test('control tower respects permissions: accounts sees finance, sales does not', async () => {
    const a = await h.ok(t.accounts!, 'GET', '/insights/control-tower');
    assert.ok(a.sections.finance);
    assert.equal(a.trend.length, 6);
    const s = await h.ok(t.sales!, 'GET', '/insights/control-tower');
    assert.equal(s.sections.finance, null);
    assert.ok(s.sections.sales);
  });
});

describe('P10 intelligence and assistant', () => {
  test('customer intelligence explains churn risk; financial intelligence lists money tied up', async () => {
    const c = await h.ok(t.owner!, 'GET', '/insights/intel/customers');
    const m = c.customers.find((x: { customer: string }) => x.customer === 'Sri Murugan Garments');
    assert.equal(m.cycle_days, 30);
    assert.ok(m.churn_risk > 0, 'no order for ~90 days against a 30-day cycle');
    assert.ok(m.factors.some((f: string) => /usual 30-day cycle/.test(f)));
    assert.equal(m.repeat_due, true);
    const f = await h.ok(t.owner!, 'GET', '/insights/intel/finance');
    assert.ok(f.blocked.some((b: { item: string }) => b.item === 'Receivables'));
    assert.equal(f.order_profitability.length, 3);
  });

  test('fabric substitutes apply GSM/width tolerance and flag customer acceptance', async () => {
    const p = (await h.ok(t.owner!, 'GET', '/masters/products?pageSize=50')).items.find((x: { sku: string }) => x.sku === 'SJ-160-NVY');
    const s = await h.ok(t.owner!, 'GET', `/insights/intel/substitutes/${p.id}`);
    assert.ok(s.substitutes.length >= 1);
    const blk = s.substitutes.find((x: { sku: string }) => x.sku === 'SJ-180-BLK');
    if (blk) { assert.equal(blk.within_tolerance, false); assert.equal(blk.needs_customer_acceptance, true); }
  });

  test('exception centre gathers alerts from every module the user can see', async () => {
    await tx(h.svc('finance').ctx.pool, (c) => c.query(`INSERT INTO finance.anomalies (kind, severity, ref_type, ref_id, ref_label, message) VALUES ('test', 'critical', 'x', 'x1', 'X', 'Test critical alert')`));
    const e = await h.ok(t.owner!, 'GET', '/insights/exceptions');
    assert.equal(e[0].severity, 'critical');
    assert.equal(e[0].source, 'Finance');
    const s = await h.ok(t.sales!, 'GET', '/insights/exceptions');
    assert.ok(!s.some((x: { source: string }) => x.source === 'Finance'), 'finance alerts hidden from sales');
  });

  test('assistant without an API key answers from built-in analyses, logs the question, and says so', async () => {
    const st = await h.ok(t.owner!, 'GET', '/insights/assistant/status');
    assert.equal(st.ai, !!process.env.ANTHROPIC_API_KEY);
    if (st.ai) return;
    const a = await h.ok(t.owner!, 'POST', '/insights/assistant/ask', { question: 'Who owes us money and how much is overdue?' });
    assert.equal(a.mode, 'built_in');
    assert.match(a.answer, /Customers owe ₹/);
    assert.equal(a.actions[0].path, '/finance/receivables');
    await h.ok(t.owner!, 'POST', `/insights/assistant/${a.id}/feedback`, { feedback: 'helpful' });
    assert.equal((await h.ok(t.owner!, 'GET', '/insights/assistant/history'))[0].feedback, 'helpful');
    const b = await h.ok(t.owner!, 'GET', '/insights/brief');
    assert.ok(b.points.length >= 3);
  });
});

describe('P10 continuity', () => {
  test('system health shows every service, bus lag and database size', async () => {
    const s = await h.ok(t.admin!, 'GET', '/insights/system/health');
    assert.ok(s.services.length >= 14);
    assert.ok(s.bus.consumers.length > 5);
    assert.equal((await h.call(t.sales!, 'GET', '/insights/system/health')).status, 403);
  });

  test('backup with checksum and row counts; restore test into a scratch database matches', async () => {
    const b = await h.ok(t.admin!, 'POST', '/insights/system/backups');
    assert.equal(b.status, 'completed', b.error ?? '');
    assert.equal(b.sha256.length, 64);
    const r = await h.ok(t.admin!, 'POST', `/insights/system/backups/${b.id}/restore-test`);
    assert.equal(r.restore_status, 'passed', JSON.stringify(r.restore_detail));
    assert.equal(r.restore_detail.checksum_ok, true);
  });

  test('a parked event can be replayed for the consumer that failed', async () => {
    const pool = h.svc('finance').ctx.pool;
    // Park a real event for the finance consumer, as if its handler had failed.
    const ev = await pool.query(`SELECT id FROM bus.events WHERE type = 'fulfilment.invoiced' ORDER BY id LIMIT 1`);
    const dl = await pool.query(`INSERT INTO bus.dead_letters (consumer, event_id, error) VALUES ('finance', $1, 'simulated') RETURNING id`, [ev.rows[0].id]);
    await h.ok(t.admin!, 'POST', `/insights/system/dead-letters/${dl.rows[0].id}/replay`);
    await h.drain();
    const row = await pool.query('SELECT replayed_at, replay_error FROM bus.dead_letters WHERE id = $1', [dl.rows[0].id]);
    assert.ok(row.rows[0].replayed_at, row.rows[0].replay_error ?? 'replayed');
    assert.equal((await h.ok(t.accounts!, 'GET', '/finance/vouchers?type=sales')).length, 3, 'idempotent posting: no duplicate voucher');
  });
});
