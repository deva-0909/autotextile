/** Lead management: scoring, call logging, objections, reviving lost leads, assignment overrides, bulk and rebalance,
 * shift hours from HR, response targets, samples and visits, daily call list, team and source reports, agents. */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { bootAll } from './harness.ts';
import { runCrmChecks } from '../services/crm/src/automation.ts';
import { scoreLead } from '../services/crm/src/score.ts';
import { outsideShift } from '../services/crm/src/allocation.ts';

let h: Awaited<ReturnType<typeof bootAll>>;
const t: Record<string, string> = {};
const ids: Record<string, string> = {};
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
const inHours = (n: number) => new Date(Date.now() + n * 3_600_000).toISOString();
const sql = (q: string, p: unknown[] = []) => h.svc('crm').ctx.pool.query(q, p);
let phone = 9700000000;
const nextPhone = () => String(++phone);

before(async () => {
  h = await bootAll('leads');
  for (const [k, email] of Object.entries({ admin: 'admin@textile.local', owner: 'owner@textile.local', mgr: 'salesmgr@textile.local', west: 'sales@textile.local', south: 'sales.south@textile.local', east: 'sales.east@textile.local', hr: 'hr@textile.local', accounts: 'accounts@textile.local', agent: 'agent@agarwaltrade.example' }))
    t[k] = await h.login(email);
  for (const m of await h.ok(t.mgr!, 'GET', '/crm/team')) ids[m.name] = m.user_id;
  for (const n of ['Selvi Raman', 'Arjun Mehta', 'Sourav Ghosh']) await h.ok(t.mgr!, 'PUT', '/crm/attendance', { user_id: ids[n], day: daysAgo(0), status: 'present' });
});
after(async () => h.close());

const newLead = (body: Record<string, unknown>) => h.ok(t.mgr!, 'POST', '/crm/leads', { source_code: 'PHONE', state_code: '33', mobile: nextPhone(), ...body });

describe('Lead settings', () => {
  test('the sales manager edits the response target and the no-progress limit; salespeople cannot', async () => {
    const s0 = await h.ok(t.west!, 'GET', '/crm/settings');
    assert.equal(s0.first_response_minutes, 15);
    assert.equal(s0.no_progress_attempts, 20);
    assert.equal((await h.call(t.west!, 'PUT', '/crm/settings', { first_response_minutes: 5 })).status, 403);
    assert.equal((await h.call(t.mgr!, 'PUT', '/crm/settings', { first_response_minutes: 30, sla_reassign_minutes: 20 })).status, 400, 'reassign must come after the target');
    const s1 = await h.ok(t.mgr!, 'PUT', '/crm/settings', { first_response_minutes: 20, sla_reassign_minutes: 45, no_progress_attempts: 3 });
    assert.equal(s1.first_response_minutes, 20);
    assert.equal(s1.no_progress_attempts, 3);
    assert.ok(s1.objections.includes('Price'));
  });
});

describe('Scoring and calls', () => {
  test('score has reasons; a referral with a big order beats a cold portal enquiry', async () => {
    const hot = await newLead({ source_code: 'REFERRAL', name: 'Hot Buyer', est_value: 1500000 });
    const cold = await newLead({ source_code: 'JUSTDIAL', name: 'Cold Buyer' });
    const a = await h.ok(t.mgr!, 'GET', `/crm/leads/${hot.id}`);
    const b = await h.ok(t.mgr!, 'GET', `/crm/leads/${cold.id}`);
    assert.ok(a.score > b.score, `${a.score} > ${b.score}`);
    assert.ok(a.score_reasons.some((r: { text: string }) => /Order value/.test(r.text)));
    assert.ok(b.score_reasons.some((r: { text: string }) => r.text === 'Order value not captured'));
    const base = { stage: 'assigned', status: 'open', source_code: 'META', est_value: null, requirement_kg: 100, customer_id: null, created_at: new Date(Date.now() - 30 * 86_400_000).toISOString(), first_response_at: null, last_contact_at: null, connected_calls: 0, no_progress: false, reenquiry_count: 0, agent_id: null, moq_kg: 500, outcomes: [] };
    const s = scoreLead(base);
    assert.ok(s.reasons.some((r) => /Below minimum order/.test(r.text)));
    assert.ok(s.reasons.some((r) => r.text === 'Never contacted'));
    assert.ok(scoreLead({ ...base, outcomes: ['very_interested'] }).score > s.score);
    ids.hot = hot.id; ids.cold = cold.id;
  });

  test('every call counts; past the limit the lead is flagged; progress clears the flag', async () => {
    const lead = await h.ok(t.mgr!, 'GET', `/crm/leads/${ids.hot}`);
    const tok = lead.owner_name === 'Selvi Raman' ? t.south! : lead.owner_name === 'Arjun Mehta' ? t.west! : t.east!;
    ids.hotTok = tok;
    assert.equal((await h.call(tok, 'POST', `/crm/leads/${ids.hot}/calls`, { outcome: 'no_answer' })).status, 400, 'next follow-up required');
    for (let i = 0; i < 2; i++) await h.ok(tok, 'POST', `/crm/leads/${ids.hot}/calls`, { outcome: 'no_answer', next_action_at: inHours(2) });
    let d = await h.ok(t.mgr!, 'GET', `/crm/leads/${ids.hot}`);
    assert.equal(d.call_attempts, 2);
    assert.equal(d.no_progress, false);
    assert.equal(d.stage, 'contacted');
    assert.ok(d.first_response_at, 'first attempt settles the response target');
    const r = await h.ok(tok, 'POST', `/crm/leads/${ids.hot}/calls`, { outcome: 'busy', next_action_at: inHours(3) });
    assert.equal(r.no_progress, true);
    const ex = await h.ok(t.mgr!, 'GET', '/crm/exceptions');
    assert.ok(ex.some((e: { kind: string; ref_id: string }) => e.kind === 'no_progress' && e.ref_id === ids.hot));
    assert.equal((await h.ok(t.mgr!, 'GET', '/crm/leads?f_view=no_progress')).items.some((l: { id: string }) => l.id === ids.hot), true);
    await h.ok(tok, 'POST', `/crm/leads/${ids.hot}/calls`, { outcome: 'connected', duration_sec: 240, notes: 'Wants 2 tonnes jersey', next_action_at: inHours(24), stage: 'qualified' });
    d = await h.ok(t.mgr!, 'GET', `/crm/leads/${ids.hot}`);
    assert.equal(d.stage, 'qualified');
    assert.equal(d.no_progress, false);
    assert.equal(d.connected_calls, 1);
    assert.ok(d.activities.some((a: { call_outcome: string; duration_sec: number }) => a.call_outcome === 'connected' && a.duration_sec === 240));
  });

  test('wrong number and not interested close the lead with an objection', async () => {
    const a = await newLead({ name: 'Wrong No' });
    const la = await h.ok(t.mgr!, 'GET', `/crm/leads/${a.id}`);
    const tok = la.owner_name === 'Selvi Raman' ? t.south! : t.west!;
    await h.ok(tok, 'POST', `/crm/leads/${a.id}/calls`, { outcome: 'wrong_number' });
    let d = await h.ok(t.mgr!, 'GET', `/crm/leads/${a.id}`);
    assert.equal(d.stage, 'lost');
    assert.equal(d.objection, 'Invalid contact');
    const b = await newLead({ name: 'Price Shopper', est_value: 200000, category: 'Single Jersey' });
    const lb = await h.ok(t.mgr!, 'GET', `/crm/leads/${b.id}`);
    const tb = lb.owner_name === 'Selvi Raman' ? t.south! : t.west!;
    assert.equal((await h.call(tb, 'POST', `/crm/leads/${b.id}/calls`, { outcome: 'not_interested' })).status, 400);
    assert.equal((await h.call(tb, 'POST', `/crm/leads/${b.id}/calls`, { outcome: 'not_interested', objection: 'Cheap' })).status, 400, 'objection from the list');
    await h.ok(tb, 'POST', `/crm/leads/${b.id}/calls`, { outcome: 'not_interested', objection: 'Price', notes: 'Wants ₹230/kg' });
    d = await h.ok(t.mgr!, 'GET', `/crm/leads/${b.id}`);
    assert.equal(d.stage, 'lost');
    assert.equal(d.objection, 'Price');
    assert.equal(d.score, null, 'closed leads carry no score');
    const c = await newLead({ name: 'Other Reason' });
    const lc = await h.ok(t.mgr!, 'GET', `/crm/leads/${c.id}`);
    const tc = lc.owner_name === 'Selvi Raman' ? t.south! : t.west!;
    await h.ok(tc, 'POST', `/crm/leads/${c.id}/stage`, { stage: 'lost', objection: 'Delivery time', lost_reason: 'Needs it in 3 days' });
    assert.equal((await h.ok(t.mgr!, 'GET', `/crm/leads/${c.id}`)).objection, 'Delivery time');
    const lost = await h.ok(t.mgr!, 'GET', `/crm/lost-analysis?from=${daysAgo(1)}`);
    assert.ok(lost.by_objection.some((x: { objection: string; n: number }) => x.objection === 'Price' && x.n >= 1));
    ids.lostPrice = b.id; ids.lostDelivery = c.id; ids.lostWrong = a.id;
  });

  test('lost leads are revived for calling again: selected, or every lead lost to one objection', async () => {
    assert.equal((await h.call(t.west!, 'POST', '/crm/leads/revive', { lead_ids: [ids.lostPrice], note: 'x' })).status, 403);
    const pv = await h.ok(t.mgr!, 'POST', '/crm/leads/revive/preview', { objection: 'Price' });
    assert.ok(pv.leads.some((l: { id: string }) => l.id === ids.lostPrice));
    const r1 = await h.ok(t.mgr!, 'POST', '/crm/leads/revive', { objection: 'Price', note: 'New lower price list from November', assign: 'previous' });
    assert.ok(r1.revived >= 1);
    let d = await h.ok(t.mgr!, 'GET', `/crm/leads/${ids.lostPrice}`);
    assert.equal(d.status, 'open');
    assert.equal(d.stage, 'contact_pending');
    assert.equal(d.revived_count, 1);
    assert.ok(d.activities.some((a: { kind: string }) => a.kind === 'revive'));
    assert.ok(d.next_action_at);
    const r2 = await h.ok(t.mgr!, 'POST', '/crm/leads/revive', { lead_ids: [ids.lostDelivery, ids.lostWrong], note: 'Second try', assign: 'user', user_id: ids['Arjun Mehta'] });
    assert.equal(r2.revived, 2);
    d = await h.ok(t.mgr!, 'GET', `/crm/leads/${ids.lostDelivery}`);
    assert.equal(d.owner_name, 'Arjun Mehta');
    assert.ok(d.assignments.some((a: { method: string }) => a.method === 'revive'));
  });
});

describe('Assignment', () => {
  test('a manager can override the engine, with a reason on record', async () => {
    const l = await newLead({ name: 'Override Me', state_code: '33' });
    const d0 = await h.ok(t.mgr!, 'GET', `/crm/leads/${l.id}`);
    const sug = await h.ok(t.mgr!, 'GET', `/crm/leads/${l.id}/suggestion`);
    assert.ok(sug.candidates.length);
    const other = d0.owner_name === 'Arjun Mehta' ? ids['Sourav Ghosh'] : ids['Arjun Mehta'];
    const r = await h.call(t.mgr!, 'POST', `/crm/leads/${l.id}/assign`, { user_id: other });
    assert.equal(r.status, 400, 'reason required');
    await h.ok(t.mgr!, 'POST', `/crm/leads/${l.id}/assign`, { user_id: other, reason: 'Speaks Tamil and knows this buyer' });
    const d = await h.ok(t.mgr!, 'GET', `/crm/leads/${l.id}`);
    assert.ok(d.assignments.some((a: { method: string; reason: string }) => ['override', 'reassign'].includes(a.method) && /Tamil/.test(a.reason)));
  });

  test('best-performer rules pick by contact and conversion rate', async () => {
    const rule = await h.ok(t.mgr!, 'POST', '/crm/rules', { name: 'Best performer, Gujarat', priority: 1, conditions: { states: ['24'] }, strategy: 'best_performer', member_ids: [ids['Arjun Mehta'], ids['Selvi Raman']] });
    const l = await newLead({ name: 'Gujarat Buyer', state_code: '24' });
    const d = await h.ok(t.mgr!, 'GET', `/crm/leads/${l.id}`);
    assert.match(d.allocation_trace.note, /best performer/);
    assert.ok(d.allocation_trace.candidates.every((c: { performance: number | null }) => c.performance !== undefined));
    await h.ok(t.mgr!, 'PATCH', `/crm/rules/${rule.id}`, { name: 'Best performer, Gujarat', priority: 1, conditions: { states: ['24'] }, strategy: 'best_performer', member_ids: [ids['Arjun Mehta'], ids['Selvi Raman']], status: 'inactive' });
  });

  test('bulk assignment and a rebalance that previews before it moves anything', async () => {
    const a = await newLead({ name: 'Bulk A' }), b = await newLead({ name: 'Bulk B' });
    const r = await h.ok(t.mgr!, 'POST', '/crm/leads/bulk-assign', { lead_ids: [a.id, b.id], user_id: ids['Sourav Ghosh'], reason: 'Exhibition follow-up' });
    assert.equal(r.assigned + r.unchanged, 2);
    assert.equal((await h.ok(t.mgr!, 'GET', `/crm/leads/${a.id}`)).owner_name, 'Sourav Ghosh');
    // Sourav goes on leave: his uncalled leads are shared out.
    await h.ok(t.mgr!, 'PUT', '/crm/attendance', { user_id: ids['Sourav Ghosh'], day: daysAgo(0), status: 'leave' });
    const pv = await h.ok(t.mgr!, 'POST', '/crm/leads/rebalance', { preview: true });
    assert.ok(pv.plan.some((p: { lead_id: string; to: string | null }) => p.lead_id === a.id && p.to));
    assert.equal((await h.ok(t.mgr!, 'GET', `/crm/leads/${a.id}`)).owner_name, 'Sourav Ghosh', 'preview changes nothing');
    const ap = await h.ok(t.mgr!, 'POST', '/crm/leads/rebalance', { preview: false, reason: 'Sourav on leave' });
    assert.ok(ap.moved >= 2);
    const d = await h.ok(t.mgr!, 'GET', `/crm/leads/${a.id}`);
    assert.notEqual(d.owner_name, 'Sourav Ghosh');
    assert.ok(d.assignments.some((x: { method: string }) => x.method === 'rebalance'));
    await h.ok(t.mgr!, 'PUT', '/crm/attendance', { user_id: ids['Sourav Ghosh'], day: daysAgo(0), status: 'present' });
  });

  test('HR sets working hours; leads skip people outside their shift', async () => {
    assert.equal(outsideShift({ shift_start: '09:30', shift_end: '18:30' }, new Date('2026-11-02T05:00:00Z')), null, '10:30 IST is inside');
    assert.match(outsideShift({ shift_start: '09:30', shift_end: '18:30' }, new Date('2026-11-02T14:00:00Z'))!, /Outside shift/);
    assert.equal(outsideShift({ shift_start: '22:00', shift_end: '06:00' }, new Date('2026-11-02T20:00:00Z')), null, 'night shift across midnight');
    const emps = await h.ok(t.hr!, 'POST', '/hrms/employees', { name: 'Sourav Ghosh', email: 'sales.east@textile.local', designation: 'Sales Executive', department: 'Sales', location: 'Kolkata', date_of_joining: '2024-01-10', user_id: ids['Sourav Ghosh'], shift_code: 'GEN', weekly_off: 0, pt_state: '19' });
    // Hours that do not include now (IST): starting 3 hours ago, ending 1 hour ago.
    const ist = new Date(Date.now() + 330 * 60_000);
    const hhmm = (d: Date) => d.toISOString().slice(11, 16);
    assert.equal((await h.call(t.mgr!, 'PUT', `/hrms/employees/${emps.id}/hours`, { work_start: '08:00', work_end: '10:00' })).status, 403, 'only HR');
    await h.ok(t.hr!, 'PUT', `/hrms/employees/${emps.id}/hours`, { work_start: hhmm(new Date(ist.getTime() - 3 * 3_600_000)), work_end: hhmm(new Date(ist.getTime() - 3_600_000)) });
    await h.drain();
    const team = await h.ok(t.mgr!, 'GET', '/crm/team');
    assert.match(team.find((m: { name: string }) => m.name === 'Sourav Ghosh').availability, /Outside shift/);
    const l = await newLead({ name: 'Kolkata Buyer', state_code: '19' });
    const d = await h.ok(t.mgr!, 'GET', `/crm/leads/${l.id}`);
    assert.notEqual(d.owner_name, 'Sourav Ghosh');
    // Round-the-clock hours so the rest of the tests do not depend on the time of day the suite runs.
    await h.ok(t.hr!, 'PUT', `/hrms/employees/${emps.id}/hours`, { work_start: '00:00', work_end: '23:59' });
    await h.drain();
    assert.doesNotMatch((await h.ok(t.mgr!, 'GET', '/crm/team')).find((m: { name: string }) => m.name === 'Sourav Ghosh').availability, /Outside shift/);
  });

  test('response target: breach alert, then one automatic reassignment', async () => {
    const l = await newLead({ name: 'Slow Lead', state_code: '33' });
    const d0 = await h.ok(t.mgr!, 'GET', `/crm/leads/${l.id}`);
    assert.ok(d0.sla_due_at);
    await sql(`UPDATE leads SET assigned_at = now() - interval '50 minutes', created_at = now() - interval '50 minutes' WHERE id = $1`, [l.id]);
    await runCrmChecks(h.svc('crm').ctx.pool);
    const d = await h.ok(t.mgr!, 'GET', `/crm/leads/${l.id}`);
    assert.notEqual(d.owner_name, d0.owner_name);
    assert.ok(d.assignments.some((a: { method: string; reason: string }) => a.method === 'sla' && /Not called within 45 minutes/.test(a.reason)));
    assert.ok((await h.ok(t.mgr!, 'GET', '/crm/exceptions')).some((e: { kind: string; ref_id: string }) => e.kind === 'first_response_breach' && e.ref_id === l.id));
    const owner2 = d.owner_name;
    await sql(`UPDATE leads SET assigned_at = now() - interval '50 minutes' WHERE id = $1`, [l.id]);
    await runCrmChecks(h.svc('crm').ctx.pool);
    assert.equal((await h.ok(t.mgr!, 'GET', `/crm/leads/${l.id}`)).owner_name, owner2, 'moved only once');
  });
});

describe('Samples, call list and reports', () => {
  test('a sample with good feedback lifts the score and shows on the call list', async () => {
    const tok = ids.hotTok!;
    const before = (await h.ok(t.mgr!, 'GET', `/crm/leads/${ids.hot}`)).score;
    const s = await h.ok(tok, 'POST', `/crm/leads/${ids.hot}/engagements`, { kind: 'sample', items: 'Navy SJ 160 swatch, 2 m', courier: 'DTDC', tracking_no: 'D1234' });
    let day = await h.ok(tok, 'GET', '/crm/my-day');
    assert.ok(day.engagements.some((e: { id: string }) => e.id === s.id));
    assert.ok(['call_now', 'overdue', 'due_today', 'upcoming'].every((k) => Array.isArray(day[k])));
    await h.ok(tok, 'POST', `/crm/engagements/${s.id}/outcome`, { outcome: 'very_interested', note: 'Approved shade' });
    const after = await h.ok(t.mgr!, 'GET', `/crm/leads/${ids.hot}`);
    assert.ok(after.score > before, `${after.score} > ${before}`);
    assert.ok(after.score_reasons.some((r: { text: string }) => /Very interested/.test(r.text)));
    assert.equal((await h.call(tok, 'POST', `/crm/leads/${ids.hot}/engagements`, { kind: 'visit', items: 'Showroom' })).status, 400, 'visit needs a time');
    await h.ok(tok, 'POST', `/crm/leads/${ids.hot}/engagements`, { kind: 'visit', items: 'Showroom visit with buyer', scheduled_at: inHours(20), host_name: 'Neha Kapoor' });
    day = await h.ok(tok, 'GET', '/crm/my-day');
    assert.ok(day.engagements.some((e: { kind: string }) => e.kind === 'visit'));
    const fresh = await newLead({ name: 'Call Me Now', state_code: '33' });
    const owner = (await h.ok(t.mgr!, 'GET', `/crm/leads/${fresh.id}`)).owner_name;
    const md = await h.ok(t.mgr!, 'GET', `/crm/my-day?user=${ids[owner]}`);
    assert.ok(md.call_now.some((l: { id: string; sla_due_at: string }) => l.id === fresh.id && l.sla_due_at));
  });

  test('leaderboard, forecast and source return', async () => {
    const lb = await h.ok(t.mgr!, 'GET', `/crm/leaderboard?from=${daysAgo(7)}`);
    const row = lb.rows.find((r: { name: string }) => r.name === 'Selvi Raman');
    assert.ok(row.assigned >= 1);
    assert.ok('avg_first_response_min' in row && 'samples' in row && 'contact_rate' in row);
    const own = await h.ok(t.south!, 'GET', '/crm/leaderboard');
    assert.equal(own.rows.length, 1, 'a salesperson sees only their own row');
    const fc = await h.ok(t.mgr!, 'GET', '/crm/forecast');
    assert.ok(fc.open > 0);
    assert.equal(fc.windows.length, 3);
    assert.ok(fc.windows[2].expected_value >= fc.windows[0].expected_value);
    const src = (await h.ok(t.mgr!, 'GET', '/crm/sources')).find((s: { code: string }) => s.code === 'PHONE');
    await h.ok(t.mgr!, 'PUT', `/crm/sources/${src.id}/costs`, { cost_per_lead: 100, monthly_fee: 0 });
    await h.ok(t.mgr!, 'POST', `/crm/sources/${src.id}/spend`, { month: daysAgo(0).slice(0, 7), amount: 5000, note: 'Tele-calling vendor' });
    const sp = await h.ok(t.mgr!, 'GET', `/crm/source-performance?from=${daysAgo(7)}`);
    const ph = sp.rows.find((r: { code: string }) => r.code === 'PHONE');
    assert.ok(ph.leads > 3);
    assert.equal(ph.spend, ph.leads * 100 + 5000);
    assert.equal(ph.cost_per_lead_actual, Math.round((ph.spend / ph.leads) * 100) / 100);
    assert.equal((await h.call(t.west!, 'POST', `/crm/sources/${src.id}/spend`, { month: '2026-10', amount: 10 })).status, 403);
  });
});

describe('Commission agents', () => {
  test('agent registers a buyer, gets protection, and commission is paid through payables after approval', async () => {
    const agentParty = h.parties['Agarwal Trade Links']!;
    const ag = await h.ok(t.mgr!, 'POST', '/crm/agents', { name: 'Ramesh Agarwal', firm: 'Agarwal Trade Links', mobile: '9825011122', city: 'Surat', pan: 'ABJPA4321K', basis: 'pct', rate: 1.5, party_id: agentParty });
    const reg = await h.ok(t.agent!, 'POST', '/crm/portal/agent/leads', { name: 'Bharat Shah', company: 'Shah Knit Wear', mobile: '9824099001', city: 'Surat', state_code: '24', est_value: 400000 });
    assert.ok(reg.protected_until);
    assert.equal((await h.call(t.agent!, 'POST', '/crm/portal/agent/leads', { name: 'Bharat', mobile: '9824099001' })).status, 409, 'already registered');
    // The same buyer phoning in directly stays the agent's lead (re-enquiry, not a new lead).
    const again = await h.ok(t.mgr!, 'POST', '/crm/leads', { source_code: 'PHONE', name: 'Bharat Shah', mobile: '9824099001', state_code: '24' });
    assert.equal(again.id, reg.id);
    const d = await h.ok(t.mgr!, 'GET', `/crm/leads/${reg.id}`);
    assert.equal(d.agent_id, ag.id);
    assert.equal(d.source_code, 'AGENT');
    const portal = await h.ok(t.agent!, 'GET', '/crm/portal/agent');
    assert.equal(portal.leads.length, 1);
    assert.equal(portal.leads[0].number, d.number);
    assert.equal(portal.leads[0].notes, undefined);
    assert.equal((await h.call(t.agent!, 'GET', '/crm/leads')).status, 403, 'agents never see the lead inbox');
    // Converted: the customer is tied to the agent for the commission period.
    const conv = await h.ok(t.mgr!, 'POST', `/crm/leads/${reg.id}/convert`, { legal_name: 'Shah Knit Wear', state_code: '24' });
    const acc = (await sql('SELECT * FROM agent_accounts WHERE customer_id = $1', [conv.customer_id])).rows[0];
    assert.equal(acc.agent_id, ag.id);
    // A paid invoice's commission (as the ten-minute check would record it).
    await sql(`INSERT INTO agent_commissions (agent_id, customer_id, customer_name, invoice_no, invoice_date, taxable, kg, basis, rate, amount, status, earned_at) VALUES ($1, $2, 'Shah Knit Wear', 'SRT/26-27/0999', current_date, 100000, 400, 'pct', 1.5, 1500, 'earned', now())`, [ag.id, conv.customer_id]);
    const po = await h.ok(t.mgr!, 'POST', `/crm/agents/${ag.id}/payouts`, { note: 'October' });
    assert.equal(po.amount, 1500);
    await h.drain();
    const appr = (await h.ok(t.owner!, 'GET', '/governance/approvals?f_status=pending&pageSize=100')).items.find((x: { ref_id: string }) => x.ref_id === po.id);
    assert.ok(appr, 'payout waits for approval');
    await h.ok(t.owner!, 'POST', `/governance/approvals/${appr.id}/decide`, { decision: 'approved', comment: 'ok' });
    await h.drain();
    const det = await h.ok(t.mgr!, 'GET', `/crm/agents/${ag.id}`);
    assert.equal(det.payouts[0].status, 'approved');
    assert.equal(det.totals.paid, 1500);
    const pay = await h.ok(t.accounts!, 'GET', `/finance/parties/payables/${agentParty}`);
    assert.ok(pay.open_bills.some((b: { doc_no: string }) => b.doc_no === po.number), 'payable to the agent, ready for a payment run');
  });
});
