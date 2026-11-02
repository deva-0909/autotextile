/** End-to-end tests for P9: communications (templates, consent, delivery, retry), rules and tasks, contracts, handover, HRMS and payroll. */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { publish, tx } from '@erp/platform';
import { bootAll } from './harness.ts';
import { dispatchMessages, signWebhook } from '../services/workflow/src/messaging.ts';
import { runScheduled } from '../services/workflow/src/engine.ts';
import { runContractChecks } from '../services/workflow/src/contracts.ts';
import { annualTaxNewRegime, computePayslip } from '../services/hrms/src/statutory.ts';

let h: Awaited<ReturnType<typeof bootAll>>;
const t: Record<string, string> = {};
const ids: Record<string, string> = {};
const today = new Date().toISOString().slice(0, 10);
const addDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
async function emit(service: 'commerce' | 'fulfilment' | 'crm' | 'finance', type: string, payload: object) {
  await tx(h.svc(service).ctx.pool, (c) => publish(c, service, type, payload));
  await h.drain();
}
async function approve(refId: string, token = t.owner!) {
  await h.drain();
  const a = (await h.ok(token, 'GET', '/governance/approvals?f_status=pending&pageSize=100')).items.find((x: { ref_id: string }) => x.ref_id === refId);
  assert.ok(a, 'approval reached the inbox');
  await h.ok(token, 'POST', `/governance/approvals/${a.id}/decide`, { decision: 'approved', comment: 'ok' });
  await h.drain();
}
const wf = () => h.svc('workflow').ctx.pool;

before(async () => {
  h = await bootAll('p9');
  for (const [k, email] of Object.entries({ admin: 'admin@textile.local', owner: 'owner@textile.local', accounts: 'accounts@textile.local', sales: 'sales@textile.local', east: 'sales.east@textile.local', mgr: 'salesmgr@textile.local', dispatch: 'dispatch@textile.local', hr: 'hr@textile.local', purchase: 'purchase@textile.local' })) t[k] = await h.login(email);
  for (const u of await h.ok(t.admin!, 'GET', '/identity/directory')) ids[u.email] = u.id;
  const murugan = await h.ok(t.admin!, 'GET', `/masters/parties/${h.parties['Sri Murugan Garments']}`);
  ids.muruganPhone = murugan.phone;
});
after(async () => h.close());

describe('P9 communications', () => {
  test('templates use only the variables their trigger provides, and go live after a checker approves', async () => {
    const bad = await h.call(t.admin!, 'POST', '/workflow/templates', { code: 'payment_link_whatsapp', name: 'Pay', event_type: 'commerce.payment.link_created', channel: 'whatsapp', body: 'Pay {{amount}} for {{lr_number}}' });
    assert.equal(bad.status, 400);
    const v2 = await h.ok(t.admin!, 'POST', '/workflow/templates', { code: 'payment_link_whatsapp', name: 'Payment link', event_type: 'commerce.payment.link_created', channel: 'whatsapp', body: 'Dear {{customer_name}}, please pay ₹{{amount}} for {{reference}}: {{link}}', provider_template: 'payment_link_v3' });
    assert.equal(v2.status, 'pending_approval');
    await approve(v2.id);
    const list = await h.ok(t.admin!, 'GET', '/workflow/templates');
    const active = list.filter((x: { code: string; status: string }) => x.code === 'payment_link_whatsapp' && x.status === 'active');
    assert.equal(active.length, 1);
    assert.equal(active[0].version, 2);
    // A new WhatsApp version waits for Meta's approval of the template too.
    assert.equal(active[0].provider_status, 'pending');
    await h.ok(t.admin!, 'POST', `/workflow/templates/${active[0].id}/status`, { provider_status: 'approved', reason: 'Approved in WhatsApp Manager' });
  });

  test('a payment link reaches an opted-in customer; without opt-in it is skipped with the reason', async () => {
    await emit('commerce', 'commerce.payment.link_created', { payment_id: '00000000-0000-4000-8000-0000000000a1', number: 'PAY-00099', customer_id: h.parties['Sri Murugan Garments'], customer_name: 'Sri Murugan Garments', purpose: 'token', ref_no: 'SO/2627/00099', amount: 5000, link_token: 'tok1', expires_at: new Date(Date.now() + 3600_000).toISOString() });
    let log = await h.ok(t.admin!, 'GET', '/workflow/messages');
    const wa = log.rows.find((m: { channel: string; ref_label: string }) => m.channel === 'whatsapp' && m.ref_label === 'PAY-00099');
    assert.equal(wa.status, 'skipped');
    assert.match(wa.skip_reason, /opt-in/);
    await h.ok(t.admin!, 'POST', '/workflow/consents', { party_id: h.parties['Sri Murugan Garments'], address: ids.muruganPhone, channel: 'whatsapp', status: 'opted_in', source: 'Customer form' });
    await emit('commerce', 'commerce.payment.link_created', { payment_id: '00000000-0000-4000-8000-0000000000a2', number: 'PAY-00100', customer_id: h.parties['Sri Murugan Garments'], customer_name: 'Sri Murugan Garments', purpose: 'token', ref_no: 'SO/2627/00100', amount: 6000, link_token: 'tok2', expires_at: new Date(Date.now() + 3600_000).toISOString() });
    await dispatchMessages(wf());
    log = await h.ok(t.admin!, 'GET', '/workflow/messages');
    const sent = log.rows.find((m: { channel: string; ref_label: string }) => m.channel === 'whatsapp' && m.ref_label === 'PAY-00100');
    assert.equal(sent.status, 'delivered');
    assert.match(sent.body, /₹6,000 for SO\/2627\/00100/);
    assert.match(sent.body, /\/pay\/tok2/);
  });

  test('failed sends retry with backoff, end as failed after five attempts, and can be retried by hand', async () => {
    await h.ok(t.admin!, 'POST', '/workflow/consents', { address: '98INVALID', channel: 'sms', status: 'opted_in', source: 'test' });
    await wf().query(`INSERT INTO workflow.messages (event_type, template_code, channel, to_name, to_address, body) VALUES ('test', 'payment_link_sms', 'sms', 'X', '98INVALID', 'hello')`);
    for (let i = 0; i < 5; i++) { await dispatchMessages(wf()); await wf().query(`UPDATE workflow.messages SET next_attempt_at = now() WHERE to_address = '98INVALID' AND status = 'queued'`); }
    const m = (await h.ok(t.admin!, 'GET', '/workflow/messages?status=failed')).rows.find((x: { to_address: string }) => x.to_address === '98INVALID');
    assert.equal(m.attempts, 5);
    const d = await h.ok(t.admin!, 'GET', `/workflow/messages/${m.id}`);
    assert.equal(d.events.filter((e: { kind: string }) => e.kind === 'retry_scheduled').length, 4);
    const r = await h.ok(t.admin!, 'POST', `/workflow/messages/${m.id}/retry`);
    assert.equal(r.status, 'queued');
  });

  test('delivery receipts must be signed; a valid one marks the message read', async () => {
    const m = (await h.ok(t.admin!, 'GET', '/workflow/messages?status=delivered')).rows[0];
    const pm = (await wf().query('SELECT provider_message_id FROM workflow.messages WHERE id = $1', [m.id])).rows[0].provider_message_id;
    const body = JSON.stringify({ provider_message_id: pm, status: 'read' });
    assert.equal((await h.call(null, 'POST', '/workflow/public/messages/status', Buffer.from(body), { 'content-type': 'application/json', 'x-signature': 'bad' })).status, 401);
    await h.ok(null as unknown as string, 'POST', '/workflow/public/messages/status', Buffer.from(body), { 'content-type': 'application/json', 'x-signature': signWebhook(body) });
    assert.equal((await h.ok(t.admin!, 'GET', `/workflow/messages/${m.id}`)).status, 'read');
  });
});

describe('P9 rules, tasks, contracts and handover', () => {
  test('a rule with a condition creates a task only when it matches; delayed actions run later', async () => {
    const r = await h.ok(t.admin!, 'POST', '/workflow/rules', { name: 'Big refund check', event_type: 'commerce.payment.received', conditions: [{ field: 'amount', op: 'gte', value: '100000' }], actions: [{ type: 'create_task', title: 'Check large receipt from {{customer_name}}', queue_permission: 'finance.voucher.post', priority: 'high', due_in_hours: 2 }, { type: 'create_task', title: 'Thank {{customer_name}}', owner_field: 'none', queue_permission: 'commerce.order.manage', delay_minutes: 60 }] });
    // amount is formatted text in templates; conditions see the raw payload value.
    await emit('commerce', 'commerce.payment.received', { payment_id: '00000000-0000-4000-8000-0000000000b1', number: 'PAY-1', customer_id: h.parties['Sri Murugan Garments'], customer_name: 'Sri Murugan Garments', purpose: 'advance', amount: 5000 });
    let tasks = await h.ok(t.admin!, 'GET', '/workflow/tasks');
    assert.equal(tasks.filter((x: { title: string }) => x.title.startsWith('Check large receipt')).length, 0, 'small receipt: no task');
    const rule = await h.ok(t.admin!, 'GET', `/workflow/rules/${r.id}`);
    assert.equal(rule.runs_log[0].matched, false);
    await h.ok(t.admin!, 'PUT', `/workflow/rules/${r.id}`, { name: 'Big receipt check', event_type: 'commerce.payment.received', conditions: [{ field: 'amount', op: 'gte', value: '1000' }], actions: rule.actions });
    await emit('commerce', 'commerce.payment.received', { payment_id: '00000000-0000-4000-8000-0000000000b2', number: 'PAY-2', customer_id: h.parties['Sri Murugan Garments'], customer_name: 'Sri Murugan Garments', purpose: 'advance', amount: 150000 });
    tasks = await h.ok(t.admin!, 'GET', '/workflow/tasks');
    assert.equal(tasks.filter((x: { title: string }) => x.title === 'Check large receipt from Sri Murugan Garments').length, 1);
    assert.equal(tasks.filter((x: { title: string }) => x.title.startsWith('Thank')).length, 0, 'delayed');
    await wf().query(`UPDATE workflow.scheduled_actions SET run_at = now() - interval '1 minute' WHERE status = 'pending'`);
    await runScheduled(wf());
    tasks = await h.ok(t.admin!, 'GET', '/workflow/tasks');
    assert.equal(tasks.filter((x: { title: string }) => x.title === 'Thank Sri Murugan Garments').length, 1);
  });

  test('My Work: queue tasks are visible to the team, claimed, completed with a note; escalation when overdue', async () => {
    const task = await h.ok(t.mgr!, 'POST', '/workflow/tasks', { title: 'Call Delhi Fashion Hub', queue_permission: 'fulfilment.dispatch', priority: 'normal', due_at: new Date(Date.now() - 3600_000).toISOString() });
    await wf().query(`UPDATE workflow.tasks SET escalate_after_hours = 0.5, escalate_to_permission = 'fulfilment.split.approve' WHERE id = $1`, [task.id]);
    assert.ok((await h.ok(t.dispatch!, 'GET', '/workflow/my-work')).tasks.some((x: { id: string }) => x.id === task.id));
    assert.ok(!(await h.ok(t.sales!, 'GET', '/workflow/my-work')).tasks.some((x: { id: string }) => x.id === task.id), 'not in sales queue');
    assert.equal((await h.call(t.sales!, 'POST', `/workflow/tasks/${task.id}/action`, { action: 'claim' })).status, 403);
    await runScheduled(wf());
    assert.ok((await h.ok(t.dispatch!, 'GET', `/workflow/tasks/${task.id}`)).escalated_at);
    await h.ok(t.dispatch!, 'POST', `/workflow/tasks/${task.id}/action`, { action: 'claim' });
    assert.equal((await h.call(t.dispatch!, 'POST', `/workflow/tasks/${task.id}/action`, { action: 'complete' })).status, 400, 'needs a note');
    await h.ok(t.dispatch!, 'POST', `/workflow/tasks/${task.id}/action`, { action: 'complete', note: 'Slot booked with VRL for Thursday' });
    const d = await h.ok(t.dispatch!, 'GET', `/workflow/tasks/${task.id}`);
    assert.equal(d.status, 'done');
    assert.deepEqual(d.events.map((e: { kind: string }) => e.kind), ['created', 'escalated', 'claimed', 'completed']);
  });

  test('contracts: full-text search over terms and correspondence; renewal alert inside 30 days; renew links versions', async () => {
    const k = await h.ok(t.purchase!, 'POST', '/workflow/contracts', { kind: 'supply', title: 'Grey supply', party_id: h.parties['Shree Ambica Knitters'], start_date: addDays(-340), end_date: addDays(20), rates: [{ item: 'SJ-160 grey', rate: 246, uom: 'kg' }], quality_terms: 'GSM tolerance three percent; shade bands per dye lot', penalties: 'Late delivery penalty 0.5% per day' });
    await h.ok(t.purchase!, 'POST', `/workflow/contracts/${k.id}/notes`, { kind: 'email', body: 'Supplier asked to revise the lycra surcharge from November.' });
    assert.ok((await h.ok(t.purchase!, 'GET', '/workflow/contracts?q=penalty')).some((x: { id: string }) => x.id === k.id), 'terms');
    assert.ok((await h.ok(t.purchase!, 'GET', '/workflow/contracts?q=surcharge')).some((x: { id: string }) => x.id === k.id), 'correspondence');
    assert.equal((await h.ok(t.purchase!, 'GET', '/workflow/contracts?q=gsm tolerance')).length >= 1, true);
    await runContractChecks(wf());
    await runContractChecks(wf());
    const tasks = (await h.ok(t.purchase!, 'GET', '/workflow/my-work')).tasks.filter((x: { source_id: string }) => x.source_id === k.id);
    assert.equal(tasks.length, 1, 'one renewal task, not repeated');
    const n = await h.ok(t.purchase!, 'POST', `/workflow/contracts/${k.id}/renew`, { start_date: addDays(21), end_date: addDays(385) });
    const d = await h.ok(t.purchase!, 'GET', `/workflow/contracts/${n.id}`);
    assert.equal(d.history[0].status, 'renewed');
    assert.equal((await h.ok(t.purchase!, 'GET', `/workflow/tasks/${tasks[0].id}`)).status, 'done');
  });

  test('handover moves open tasks and contracts to a colleague and records each item', async () => {
    await h.ok(t.admin!, 'POST', '/workflow/tasks', { title: 'Visit Tiruppur buyers', owner_id: ids['sales@textile.local'] });
    const prev = await h.ok(t.admin!, 'GET', `/workflow/handovers/preview/${ids['sales@textile.local']}`);
    assert.equal(prev.tasks.length, 1);
    const ho = await h.ok(t.admin!, 'POST', '/workflow/handovers', { from_user_id: ids['sales@textile.local'], to_user_id: ids['sales.south@textile.local'], kind: 'leave', reason: 'Two weeks of leave', include: { tasks: true, leads: true, contracts: true } });
    assert.equal(ho.summary.task, 1);
    const tasks = await h.ok(t.admin!, 'GET', `/workflow/tasks?owner=${ids['sales.south@textile.local']}`);
    assert.ok(tasks.some((x: { title: string }) => x.title === 'Visit Tiruppur buyers'));
    const d = await h.ok(t.admin!, 'GET', `/workflow/handovers/${ho.id}`);
    assert.ok(d.items.length >= 1);
  });
});

describe('P9 HRMS and payroll', () => {
  test('statutory rules: new-regime tax with rebate and marginal relief; PF ceiling, ESIC limit, PT', () => {
    assert.equal(annualTaxNewRegime(1275000), 0, 'taxable ₹12L after standard deduction: rebate');
    assert.equal(annualTaxNewRegime(1500000), 97500, '₹14.25L taxable');
    assert.equal(annualTaxNewRegime(1285000), 10400, 'marginal relief just above ₹12L');
    const pt = [{ min_gross: 0, max_gross: 11999, amount: 0, feb_amount: null }, { min_gross: 12000, max_gross: null, amount: 200, feb_amount: null }];
    const hi = computePayslip({ basic: 30000, hra: 12000, conveyance: 1600, special: 7500, other: 0, pf_applicable: true, pf_on_capped_wage: true }, { daysInMonth: 30, paidDays: 30, overtimeHours: 0, overtimeEligible: false, month: 10, ptSlabs: pt, shiftHours: 8 });
    assert.equal(hi.deductions.pf, 1800, 'PF on the ₹15,000 ceiling');
    assert.equal(hi.employer.eps, 1250);
    assert.equal(hi.deductions.esic, 0, 'gross above ₹21,000: no ESIC');
    assert.equal(hi.deductions.professional_tax, 200);
    const lo = computePayslip({ basic: 9500, hra: 3800, conveyance: 1600, special: 2375, other: 0, pf_applicable: true, pf_on_capped_wage: true }, { daysInMonth: 30, paidDays: 28, overtimeHours: 4, overtimeEligible: true, month: 10, ptSlabs: pt, shiftHours: 8 });
    assert.equal(lo.earnings.basic, 8867, 'two days loss of pay');
    assert.ok(lo.earnings.overtime! > 0);
    assert.equal(lo.deductions.esic, Math.ceil(lo.gross * 0.0075));
    assert.equal(lo.net, lo.gross - lo.total_deductions);
  });

  test('employee lifecycle, attendance with comp-off, leave through approval feeding CRM, payroll posted to accounts', async () => {
    const e = await h.ok(t.hr!, 'POST', '/hrms/employees', { name: 'Sourav Ghosh', email: 'sales.east@textile.local', designation: 'Sales Executive', department: 'Sales', location: 'Kolkata', date_of_joining: '2024-06-01', user_id: ids['sales.east@textile.local'], pan: 'ABCPG1234K', bank_account: '50100012345', ifsc: 'HDFC0001234', pt_state: '19', weekly_off: 0 });
    await h.ok(t.hr!, 'POST', `/hrms/employees/${e.id}/salary`, { effective_from: '2024-06-01', basic: 12000, hra: 4800, conveyance: 1600, special: 2000 });
    await h.ok(t.hr!, 'POST', `/hrms/employees/${e.id}/lifecycle`, { action: 'start_probation', effective_date: '2024-06-01' });
    await h.ok(t.hr!, 'POST', `/hrms/employees/${e.id}/lifecycle`, { action: 'confirm', effective_date: '2024-12-01' });
    assert.equal((await h.call(t.sales!, 'GET', `/hrms/employees/${e.id}`)).status, 403, 'colleagues cannot read HR records');
    assert.equal((await h.call(t.east!, 'GET', `/hrms/employees/${e.id}`)).status, 200, 'self-service');
    // Last month: one absence, and work on a Sunday earns a comp-off.
    const m = new Date(); m.setUTCDate(1); m.setUTCMonth(m.getUTCMonth() - 1);
    const month = m.toISOString().slice(0, 7);
    const sunday = [...Array(28).keys()].map((i) => `${month}-${String(i + 1).padStart(2, '0')}`).find((d) => new Date(`${d}T00:00:00Z`).getUTCDay() === 0)!;
    await h.ok(t.hr!, 'PUT', '/hrms/attendance', { day: `${month}-03`, entries: [{ employee_id: e.id, status: 'absent' }] });
    await h.ok(t.hr!, 'PUT', '/hrms/attendance', { day: sunday, entries: [{ employee_id: e.id, status: 'present', in_time: '10:00', out_time: '15:00' }] });
    assert.equal((await h.ok(t.east!, 'GET', '/hrms/me')).comp_off.available, 1);
    // Leave: applied by the employee, approved by a checker; CRM sees the person on leave. Leave on a weekly off (Sunday)
    // is refused, so on a Sunday the leave is for Monday.
    const leaveDay = new Date().getUTCDay() === 0 ? addDays(1) : today;
    const lv = await h.ok(t.east!, 'POST', '/hrms/leave', { leave_type: 'CL', from_date: leaveDay, to_date: leaveDay, reason: 'Doctor visit' });
    await approve(lv.id);
    const me = await h.ok(t.east!, 'GET', '/hrms/me');
    assert.equal(me.balances.find((b: { leave_type: string }) => b.leave_type === 'CL').used, 1);
    {
      const crmAtt = await h.ok(t.mgr!, 'GET', `/crm/attendance?day=${leaveDay}`);
      assert.equal(crmAtt.find((x: { user_id: string }) => x.user_id === ids['sales.east@textile.local'])?.status, 'leave');
    }
    assert.equal((await h.call(t.east!, 'POST', '/hrms/leave', { leave_type: 'CL', from_date: leaveDay, to_date: leaveDay, reason: 'again' })).status, 409, 'overlap refused');
    // Payroll for last month: one day's loss of pay, statutory deductions, approval, then accounts.
    const prep = await h.ok(t.hr!, 'POST', `/hrms/payroll/${month}/prepare`);
    assert.equal(prep.employees, 1);
    const run = await h.ok(t.hr!, 'GET', `/hrms/payroll/${month}`);
    const slip = run.payslips[0];
    assert.equal(slip.lop_days, 1);
    assert.equal(slip.deductions.esic, Math.ceil(slip.gross * 0.0075), 'gross ₹20,400: ESIC applies');
    assert.equal(slip.deductions.professional_tax, 130, 'West Bengal slab');
    await h.ok(t.hr!, 'POST', `/hrms/payroll/${month}/submit`);
    assert.equal((await h.call(t.hr!, 'POST', `/hrms/payroll/${month}/pay`, { paid_on: today })).status, 409, 'not before approval');
    await approve(run.id);
    const paid = await h.ok(t.hr!, 'POST', `/hrms/payroll/${month}/pay`, { paid_on: today });
    assert.match(paid.bank_file, /Sourav Ghosh,50100012345,HDFC0001234/);
    await h.drain();
    const vs = (await h.ok(t.hr!, 'GET', `/hrms/payroll/${month}`)).vouchers;
    assert.equal(vs.length, 2, 'salary booked and paid in accounts');
    const tb = await h.ok(t.accounts!, 'GET', '/finance/reports/trial-balance?from=2020-04-01');
    assert.ok(tb.balanced);
    assert.equal(tb.rows.find((r: { code: string }) => r.code === '2300')?.closing_credit ?? 0, 0, 'salaries payable cleared by the payment');
    // Salary TDS (section 192): one register line per employee taxed, equal to the payslip deduction; returned in 24Q.
    const fyY = Number(month.slice(5, 7)) >= 4 ? Number(month.slice(0, 4)) : Number(month.slice(0, 4)) - 1;
    const reg = await h.ok(t.accounts!, 'GET', `/finance/tds/register?fy=${String(fyY).slice(2)}${String(fyY + 1).slice(2)}`);
    const salaryTds = reg.entries.filter((e: { section: string; party_name: string }) => e.section === '192' && e.party_name === slip.employee_name).reduce((a: number, e: { tds_amount: number }) => a + e.tds_amount, 0);
    assert.equal(salaryTds, Number(slip.deductions.income_tax ?? 0), 'salary TDS in the register matches the payslip');
    // Payslip: the employee sees their own, colleagues do not.
    assert.equal((await h.call(t.east!, 'GET', `/hrms/payslips/${slip.id}`)).status, 200);
    assert.equal((await h.call(t.sales!, 'GET', `/hrms/payslips/${slip.id}`)).status, 404);
  });

  test('holidays follow the office state; salary register; personnel files only for HR; transfer moves the state', async () => {
    const emp = (await h.ok(t.hr!, 'GET', '/hrms/employees')).find((x: { name: string }) => x.name === 'Sourav Ghosh');
    // Two working days well ahead (not Sunday, the weekly off): one a Gujarat-only holiday, one national.
    const listed = new Set<string>();
    for (const y of new Set([addDays(60).slice(0, 4), addDays(90).slice(0, 4)])) for (const x of (await h.ok(t.hr!, 'GET', `/hrms/holidays?year=${y}`)).holidays) listed.add(x.day);
    const ahead = [...Array(30).keys()].map((i) => addDays(60 + i)).filter((d) => new Date(`${d}T00:00:00Z`).getUTCDay() !== 0 && !listed.has(d));
    const [gujDay, natDay] = [ahead[0]!, ahead[2]!];
    await h.ok(t.hr!, 'POST', '/hrms/holidays', { day: gujDay, name: 'Test Gujarat holiday', state_code: '24' });
    await h.ok(t.hr!, 'POST', '/hrms/holidays', { day: natDay, name: 'Test national holiday', state_code: null });
    assert.equal((await h.call(t.hr!, 'POST', '/hrms/holidays', { day: natDay, name: 'Test national holiday' })).status, 409, 'no duplicates');
    assert.equal((await h.call(t.east!, 'POST', '/hrms/holidays', { day: natDay, name: 'Mine' })).status, 403, 'only HR edits the calendar');
    const cal = await h.ok(t.east!, 'GET', `/hrms/holidays?year=${gujDay.slice(0, 4)}`);
    assert.deepEqual(cal.holidays.find((x: { name: string }) => x.name === 'Test Gujarat holiday').offices, ['Surat']);
    assert.equal(cal.holidays.find((x: { name: string }) => x.name === 'Test Gujarat holiday').state, 'Gujarat');
    // Kolkata works on the Gujarat holiday: leave that day counts; the national holiday is not a working day anywhere.
    const lv = await h.ok(t.east!, 'POST', '/hrms/leave', { leave_type: 'CL', from_date: gujDay, to_date: gujDay, reason: 'Family function' });
    assert.equal(lv.days, 1);
    await h.ok(t.east!, 'POST', `/hrms/leave/${lv.id}/cancel`, { reason: 'Plans changed' });
    assert.equal((await h.call(t.east!, 'POST', '/hrms/leave', { leave_type: 'CL', from_date: natDay, to_date: natDay, reason: 'x' })).status, 400);
    const muster = await h.ok(t.hr!, 'GET', `/hrms/attendance?day=${gujDay}`);
    assert.equal(muster.rows.find((r: { employee_id: string }) => r.employee_id === emp.id).holiday, null, 'not a holiday in Kolkata');
    assert.match(muster.holiday.name, /Gujarat/);
    await h.ok(t.hr!, 'POST', '/hrms/holidays/remove', { day: natDay, name: 'Test national holiday', reason: 'Entered by mistake' });
    assert.equal((await h.call(t.hr!, 'POST', '/hrms/holidays/remove', { day: natDay, name: 'Test national holiday', reason: 'again' })).status, 404);
    // Salary register: current structure, a full-month estimate, and the latest payroll actually paid.
    const reg = await h.ok(t.hr!, 'GET', '/hrms/salary-register');
    const row = reg.find((r: { id: string }) => r.id === emp.id);
    assert.equal(row.gross, 20400);
    assert.ok(row.estimate.net < row.gross && row.estimate.annual_ctc > row.gross * 12, 'take-home below gross, CTC above it');
    assert.ok(row.last_net > 0 && row.last_payslip_id, 'latest payslip linked');
    assert.equal((await h.call(t.sales!, 'GET', '/hrms/salary-register')).status, 403);
    // Personnel file: HR files and reads it; others who can see documents do not.
    assert.ok((await h.ok(t.hr!, 'GET', '/masters/document-types')).some((x: { code: string; applies_to: string[] }) => x.code === 'OFFER_LETTER' && x.applies_to.includes('employee')), 'HR can choose a document type');
    const pdf = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF');
    const q = new URLSearchParams({ title: 'Offer letter', document_type: 'OFFER_LETTER', entity_type: 'employee', entity_id: emp.id });
    const doc = await h.ok(t.hr!, 'POST', `/governance/documents?${q}`, pdf, { 'content-type': 'application/pdf', 'x-file-name': 'offer.pdf' });
    assert.equal((await h.ok(t.hr!, 'GET', `/governance/documents?f_entityType=employee&f_entityId=${emp.id}`)).total, 1);
    assert.equal((await h.ok(t.sales!, 'GET', `/governance/documents?f_entityType=employee&f_entityId=${emp.id}`)).total, 0, 'hidden from sales');
    assert.equal((await h.call(t.sales!, 'GET', `/governance/documents/${doc.id}/versions/1/content`)).status, 404);
    assert.equal((await h.call(t.sales!, 'POST', `/governance/documents?${q}`, pdf, { 'content-type': 'application/pdf', 'x-file-name': 'x.pdf' })).status, 403);
    await h.ok(t.hr!, 'POST', `/governance/documents/${doc.id}/archive`, { reason: 'Replaced by signed copy' });
    // Transfer to Surat: the Gujarat holiday and Gujarat professional tax now apply.
    await h.ok(t.hr!, 'POST', `/hrms/employees/${emp.id}/lifecycle`, { action: 'transfer', effective_date: today, location: 'Surat' });
    assert.equal((await h.ok(t.hr!, 'GET', `/hrms/employees/${emp.id}`)).pt_state, '24');
    assert.equal((await h.call(t.east!, 'POST', '/hrms/leave', { leave_type: 'CL', from_date: gujDay, to_date: gujDay, reason: 'x' })).status, 400, 'now a holiday for them');
  });

  test('exit: resignation opens the checklist and a handover task; exit needs the checklist done and closes the login', async () => {
    const e = await h.ok(t.hr!, 'POST', '/hrms/employees', { name: 'Temp Picker', designation: 'Picker', department: 'Warehouse', location: 'Surat', date_of_joining: '2025-01-01', user_id: ids['dispatch@textile.local'] });
    await h.ok(t.hr!, 'POST', `/hrms/employees/${e.id}/lifecycle`, { action: 'resign', effective_date: today, last_working_day: addDays(10), reason: 'Higher studies' });
    await h.drain();
    assert.ok((await h.ok(t.admin!, 'GET', '/workflow/tasks')).some((x: { title: string }) => x.title.startsWith('Hand over Temp Picker')));
    assert.equal((await h.call(t.hr!, 'POST', `/hrms/employees/${e.id}/lifecycle`, { action: 'complete_exit', effective_date: addDays(10) })).status, 409);
    const d = await h.ok(t.hr!, 'GET', `/hrms/employees/${e.id}`);
    for (const c of d.checklist.filter((x: { stage: string }) => x.stage === 'exit')) await h.ok(t.hr!, 'POST', `/hrms/checklist/${c.id}`, { done: true });
    await h.ok(t.hr!, 'POST', `/hrms/employees/${e.id}/lifecycle`, { action: 'complete_exit', effective_date: addDays(10) });
    assert.equal((await h.call(null, 'POST', '/identity/auth/login', { email: 'dispatch@textile.local', password: 'Textile@2026' })).status, 401, 'login closed');
  });
});
