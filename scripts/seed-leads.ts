/**
 * Demo data for lead management: seven months of enquiries from every source with calls, samples, visits, wins and
 * losses (with objections), source costs, re-enquiries, a revived lead, a stuck lead, and a commission agent whose
 * buyer became a customer. Created through the APIs (so scoring, assignment and audit run as in real use), then dated
 * back with SQL so the reports have history.
 */
import type { Pool } from '@erp/platform';

type Call = <T = any>(svc: 'crm' | 'hrms' | 'identity' | 'governance', token: string | null, method: string, path: string, body?: unknown) => Promise<T>;

export async function seedLeadDesk(o: { call: Call; login: (email: string) => Promise<string>; crm: Pool; party: (name: string) => string; drain: () => Promise<unknown> }) {
  const { call, crm } = o;
  const mgr = await o.login('salesmgr@textile.local');
  const hr = await o.login('hr@textile.local');
  const west = await o.login('sales@textile.local');
  const south = await o.login('sales.south@textile.local');
  const east = await o.login('sales.east@textile.local');
  const agentTok = await o.login('agent@agarwaltrade.example');
  const tok: Record<string, string> = { 'Arjun Mehta': west, 'Selvi Raman': south, 'Sourav Ghosh': east, 'Neha Kapoor': mgr };
  const DAY = 86_400_000;
  const ago = (d: number, h = 11) => new Date(Date.now() - d * DAY + (h - 11) * 3_600_000).toISOString();
  const soon = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();

  // HR: sales staff work 9 am to 9 pm (leads reach them only in those hours).
  const emps = await call<{ id: string; name: string; department: string }[]>('hrms', hr, 'GET', '/employees');
  for (const e of emps.filter((x) => x.department === 'Sales')) await call('hrms', hr, 'PUT', `/employees/${e.id}/hours`, { shift_code: 'GEN', work_start: '09:00', work_end: '21:00' });
  await o.drain();
  for (const m of await call<{ user_id: string; name: string }[]>('crm', mgr, 'GET', '/team')) if (m.name !== 'Sourav Ghosh') await call('crm', mgr, 'PUT', '/attendance', { user_id: m.user_id, day: new Date().toISOString().slice(0, 10), status: 'present', note: 'Working today' });

  // What the sources cost.
  const sources = await call<{ id: string; code: string }[]>('crm', mgr, 'GET', '/sources');
  const src = (c: string) => sources.find((s) => s.code === c)!.id;
  const costs: Record<string, [number, number]> = { INDIAMART: [0, 4500], JUSTDIAL: [60, 0], TRADE: [40, 0], WEBSITE: [0, 2000], META: [0, 0], EXHIBITION: [0, 0] };
  for (const [c, [cpl, fee]] of Object.entries(costs)) await call('crm', mgr, 'PUT', `/sources/${src(c)}/costs`, { cost_per_lead: cpl, monthly_fee: fee });
  for (let m = 6; m >= 0; m--) {
    const d = new Date(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - m);
    const month = d.toISOString().slice(0, 7);
    await call('crm', mgr, 'POST', `/sources/${src('META')}/spend`, { month, amount: [18000, 22000, 15000, 25000, 20000, 24000, 12000][m]!, note: 'Facebook and Instagram lead ads' });
  }
  const knitShow = new Date(Date.now() - 120 * DAY).toISOString().slice(0, 7);
  await call('crm', mgr, 'POST', `/sources/${src('EXHIBITION')}/spend`, { month: knitShow, amount: 120000, note: 'Stall at the Knit Show, Tiruppur' });

  // Moves every timestamp of a lead back by `days`, and spaces the first call realistically.
  async function backdate(id: string, days: number, firstCallMin: number | null) {
    const iv = `${days} days`;
    await crm.query(`UPDATE leads SET created_at = created_at - $2::interval, updated_at = updated_at - $2::interval, assigned_at = assigned_at - $2::interval,
        first_response_at = CASE WHEN first_response_at IS NULL THEN NULL WHEN $3::int IS NULL THEN first_response_at - $2::interval ELSE created_at - $2::interval + make_interval(mins => $3::int) END,
        first_connected_at = first_connected_at - $2::interval, last_contact_at = last_contact_at - $2::interval, closed_at = closed_at - $2::interval,
        last_reenquiry_at = last_reenquiry_at - $2::interval, last_revived_at = last_revived_at - $2::interval,
        next_action_at = CASE WHEN status = 'open' THEN next_action_at ELSE NULL END WHERE id = $1`, [id, iv, firstCallMin]);
    await crm.query(`UPDATE lead_activities SET at = at - $2::interval WHERE lead_id = $1`, [id, iv]);
    await crm.query(`UPDATE lead_assignments SET at = at - $2::interval WHERE lead_id = $1`, [id, iv]);
    await crm.query(`UPDATE lead_engagements SET created_at = created_at - $2::interval, outcome_at = outcome_at - $2::interval, scheduled_at = scheduled_at - $2::interval WHERE lead_id = $1`, [id, iv]);
    await crm.query(`UPDATE quotations SET created_at = created_at - $2::interval, sent_at = sent_at - $2::interval, decided_at = decided_at - $2::interval WHERE lead_id = $1`, [id, iv]);
  }
  const team = await call<{ user_id: string; name: string }[]>('crm', mgr, 'GET', '/team');
  let rr = 0;
  // The owner the engine chose; if nobody was available (someone on leave, or loaded outside working hours), the manager assigns one.
  const owner = async (id: string) => {
    const name = (await call<{ owner_name: string | null }>('crm', mgr, 'GET', `/leads/${id}`)).owner_name;
    if (name) return name;
    const m = team.filter((x) => x.name !== 'Sourav Ghosh')[rr++ % 2]!;
    await call('crm', mgr, 'POST', `/leads/${id}/assign`, { user_id: m.user_id, reason: 'Assigned by the sales manager' });
    return m.name;
  };
  const speed: Record<string, number> = { 'Arjun Mehta': 9, 'Selvi Raman': 14, 'Sourav Ghosh': 38, 'Neha Kapoor': 20 };
  let mob = 9_870_200_000;
  const cities = [['Surat', '24'], ['Ahmedabad', '24'], ['Mumbai', '27'], ['Bhiwandi', '27'], ['Delhi', '07'], ['Ludhiana', '03'], ['Jaipur', '08'], ['Tiruppur', '33'], ['Coimbatore', '33'], ['Bengaluru', '29'], ['Kolkata', '19'], ['Howrah', '19']] as const;
  const cats = ['Single Jersey', 'Rib', 'Interlock', 'Pique', 'Fleece', 'Single Jersey Lycra'];
  const people = ['Rakesh Jain', 'Sunil Agarwal', 'Mohan Lal', 'Kavita Shah', 'Imran Qureshi', 'Prakash Rao', 'Anita Desai', 'Gurpreet Kaur', 'Vinod Bansal', 'Ramesh Iyer', 'Sanjay Ghosh', 'Deepak Mittal', 'Farhan Ali', 'Lata Menon', 'Ajay Goyal', 'Nitin Shah', 'Bhavesh Patel', 'Sneha Kulkarni', 'Arif Khan', 'Ravi Teja', 'Pooja Bhatt', 'Manoj Tiwari', 'Suresh Babu', 'Hemant Joshi'];
  const firms = ['Knit Point', 'Fashion House', 'Hosiery Mart', 'Garments', 'Apparels', 'Tex Traders', 'Kids Wear', 'Exports', 'Clothing Co', 'Sportswear'];
  const sourceMix = ['INDIAMART', 'INDIAMART', 'INDIAMART', 'JUSTDIAL', 'JUSTDIAL', 'META', 'META', 'WEBSITE', 'WEBSITE', 'PHONE', 'TRADE', 'REFERRAL', 'EXHIBITION'];
  const objections: [string, string][] = [['Price', 'Wants ₹10–15/kg below our rate'], ['Price', 'Local knitter quoted lower'], ['Price', 'Rate too high for the export order'], ['Delivery time', 'Needed in 4 days'], ['Quality / GSM', 'Wanted 180 GSM, we had 160'],
    ['Minimum order quantity', 'Only 150 kg'], ['Comparing other suppliers', 'Went with a Tiruppur mill'], ['Payment terms / credit', 'Wants 60 days credit'], ['Shade / colour', 'Shade not matching their swatch'], ['Price', 'Price-only buyer'], ['Delivery time', 'Mill delay in season']];

  // ---------- history: about 80 enquiries over seven months ----------
  for (let i = 0; i < 80; i++) {
    const days = 205 - Math.floor(i * 2.5) - (i % 3);
    const [city, st] = cities[i % cities.length]!;
    const code = sourceMix[(i * 7) % sourceMix.length]!;
    const cat = cats[i % cats.length]!;
    const kg = [300, 500, 800, 1200, 2000, 150, 600, 1000][i % 8]!;
    const value = code === 'JUSTDIAL' && i % 2 ? null : kg * (260 + (i % 5) * 15);
    const l = await call<{ id: string }>('crm', mgr, 'POST', '/leads', { source_code: code, name: people[i % people.length], company: `${city} ${firms[i % firms.length]}`, mobile: String(++mob), city, state_code: st, category: cat, requirement_kg: kg, est_value: value, message: `${cat}, about ${kg} kg` });
    const who = await owner(l.id);
    const t = tok[who] ?? mgr;
    const fate = i % 10; // 0-1 won-ish (quote accepted), 2-6 lost, 7 nurture, 8-9 still open
    const calls = 1 + (i % 4);
    for (let k = 0; k < calls; k++) await call('crm', t, 'POST', `/leads/${l.id}/calls`, { outcome: k === calls - 1 ? 'connected' : ['no_answer', 'busy', 'switched_off'][k % 3], duration_sec: k === calls - 1 ? 120 + (i % 5) * 60 : null, notes: k === calls - 1 ? `Discussed ${cat.toLowerCase()} requirement` : null, next_action_at: soon(24 + k), stage: k === calls - 1 && fate !== 3 ? 'qualified' : undefined });
    if (i % 4 === 1) {
      const s = await call<{ id: string }>('crm', t, 'POST', `/leads/${l.id}/engagements`, { kind: 'sample', items: `${cat} swatch, 2 m`, courier: 'DTDC', tracking_no: `D${7000 + i}` });
      await call('crm', t, 'POST', `/engagements/${s.id}/outcome`, { outcome: fate <= 1 ? 'very_interested' : fate <= 4 ? 'needs_changes' : 'interested', note: fate <= 1 ? 'Shade approved' : 'Wants a heavier GSM' });
    }
    if (fate >= 2 && fate <= 6) {
      const [obj, note] = objections[i % objections.length]!;
      await call('crm', t, 'POST', `/leads/${l.id}/stage`, { stage: 'lost', objection: obj, lost_reason: note, competitor: obj === 'Comparing other suppliers' || obj === 'Price' ? (i % 2 ? 'Local knitter' : 'Tiruppur mill') : null });
    } else if (fate === 7) await call('crm', t, 'POST', `/leads/${l.id}/stage`, { stage: 'nurture', nurture_reason: 'Next season', next_action_at: soon(24 * 30) });
    else if (fate <= 1) await call('crm', t, 'POST', `/leads/${l.id}/stage`, { stage: 'negotiation', next_action_at: soon(48) });
    await backdate(l.id, Math.max(1, days), (speed[who] ?? 15) + ((i * 13) % 25));
  }

  // ---------- customers first won from a source (their invoices count as that source's revenue) ----------
  const won: [string, string, string, number][] = [['Kolkata Hosiery Works', 'INDIAMART', 'Kolkata', 214], ['Rupa Apparel House', 'EXHIBITION', 'Mumbai', 212], ['Ludhiana Knit Exports', 'META', 'Ludhiana', 210], ['Delhi Fashion Hub', 'WEBSITE', 'Delhi', 209]];
  for (const [cust, code, city, days] of won) {
    const l = await call<{ id: string }>('crm', mgr, 'POST', '/leads', { source_code: code, name: `Purchase desk, ${cust}`, company: cust, mobile: String(++mob), city, category: 'Single Jersey', requirement_kg: 2000, est_value: 600000, message: 'Regular monthly requirement' });
    const who = await owner(l.id);
    const t = tok[who] ?? mgr;
    await call('crm', t, 'POST', `/leads/${l.id}/calls`, { outcome: 'connected', duration_sec: 420, notes: 'Monthly programme; wants a trial lot', next_action_at: soon(24), stage: 'qualified' });
    await call('crm', mgr, 'POST', `/leads/${l.id}/convert`, { customer_id: o.party(cust) });
    await call('crm', t, 'POST', `/leads/${l.id}/stage`, { stage: 'won', note: 'First order placed' });
    await backdate(l.id, days, speed[who] ?? 15);
  }

  // ---------- today's desk: new, overdue, stuck, re-enquired, revived ----------
  const fresh = [['Vipul Shah', 'Shah Knitwear', 'Surat', 'INDIAMART', 'Single Jersey', 900], ['Karan Malhotra', 'KM Sports', 'Ludhiana', 'META', 'Fleece', 1500], ['Lakshmi Prasad', 'LP Garments', 'Tiruppur', 'WEBSITE', 'Pique', 700], ['Abdul Rahman', 'AR Kidswear', 'Kolkata', 'JUSTDIAL', 'Interlock', 400], ['Meena Joshi', 'Joshi Fashions', 'Jaipur', 'TRADE', 'Rib', 300]] as const;
  for (const [name, company, city, code, cat, kg] of fresh)
    await call('crm', mgr, 'POST', '/leads', { source_code: code, name, company, mobile: String(++mob), city, category: cat, requirement_kg: kg, est_value: kg * 285, message: `${cat}, ${kg} kg, rate and delivery?` });
  // Overdue follow-ups.
  for (const [i, [name, city]] of [['Dinesh Kothari', 'Ahmedabad'], ['Shalini Verma', 'Delhi'], ['Muthu Kumar', 'Coimbatore']].entries()) {
    const l = await call<{ id: string }>('crm', mgr, 'POST', '/leads', { source_code: 'INDIAMART', name, company: `${city} Hosiery`, mobile: String(++mob), city, category: 'Single Jersey', requirement_kg: 600, est_value: 170000 });
    const t = tok[await owner(l.id)] ?? mgr;
    await call('crm', t, 'POST', `/leads/${l.id}/calls`, { outcome: 'call_back', notes: 'Asked to call after the weekend', next_action_at: soon(1) });
    await backdate(l.id, 3 + i, 12);
    await crm.query(`UPDATE leads SET next_action_at = now() - make_interval(days => $2) WHERE id = $1`, [l.id, 1 + i]);
  }
  // Stuck: 21 calls without progress.
  {
    const l = await call<{ id: string }>('crm', mgr, 'POST', '/leads', { source_code: 'JUSTDIAL', name: 'Pankaj Gupta', company: 'Gupta Traders', mobile: String(++mob), city: 'Surat', category: 'Rib', requirement_kg: 200 });
    const t = tok[await owner(l.id)] ?? mgr;
    await call('crm', t, 'POST', `/leads/${l.id}/calls`, { outcome: 'no_answer', next_action_at: soon(3) });
    await crm.query(`UPDATE leads SET call_attempts = 21, attempts_since_progress = 21 WHERE id = $1`, [l.id]);
    await call('crm', t, 'POST', `/leads/${l.id}/calls`, { outcome: 'busy', notes: 'Never picks up after the first call', next_action_at: soon(5) });
    await backdate(l.id, 24, 30);
  }
  // A buyer enquiring again from another platform.
  {
    const m = String(++mob);
    const l = await call<{ id: string }>('crm', mgr, 'POST', '/leads', { source_code: 'WEBSITE', name: 'Harish Bhatia', company: 'Bhatia Exports', mobile: m, city: 'Delhi', category: 'Interlock', requirement_kg: 1200, est_value: 380000, message: 'Interlock 220 GSM white' });
    const t = tok[await owner(l.id)] ?? mgr;
    await call('crm', t, 'POST', `/leads/${l.id}/calls`, { outcome: 'connected', duration_sec: 300, notes: 'Comparing three suppliers', next_action_at: soon(20) });
    await backdate(l.id, 6, 10);
    await call('crm', mgr, 'POST', '/leads', { source_code: 'INDIAMART', name: 'Harish B', mobile: m, message: 'Need interlock 220 white 1.5 tonnes urgently' });
  }
  // A showroom visit booked for tomorrow, and a sample out for feedback.
  {
    const l = await call<{ id: string }>('crm', mgr, 'POST', '/leads', { source_code: 'REFERRAL', name: 'Sudhir Agarwal', company: 'Agarwal Hosiery Mills', mobile: String(++mob), city: 'Kolkata', category: 'Fleece', requirement_kg: 3000, est_value: 1050000, message: 'Winter programme, fleece 320' });
    const t = tok[await owner(l.id)] ?? mgr;
    await call('crm', t, 'POST', `/leads/${l.id}/calls`, { outcome: 'connected', duration_sec: 540, notes: 'Wants to see the fleece range in person', next_action_at: soon(26), stage: 'qualified' });
    await call('crm', t, 'POST', `/leads/${l.id}/engagements`, { kind: 'visit', items: 'See the fleece and brushed range', scheduled_at: soon(24), host_name: 'Neha Kapoor' });
    await call('crm', t, 'POST', `/leads/${l.id}/engagements`, { kind: 'sample', items: 'Fleece 320 charcoal, 3 m', courier: 'Blue Dart', tracking_no: 'BD55102' });
  }
  // Lost on price last month, revived after the new price list.
  {
    const lostPrice = await call<{ leads: { id: string }[] }>('crm', mgr, 'POST', '/leads/revive/preview', { objection: 'Price' });
    const pick = lostPrice.leads.slice(0, 2).map((x) => x.id);
    if (pick.length) await call('crm', mgr, 'POST', '/leads/revive', { lead_ids: pick, assign: 'previous', note: 'New price list from November: jersey ₹8/kg lower' });
  }

  // ---------- a commission agent ----------
  const agent = await call<{ id: string }>('crm', mgr, 'POST', '/agents', { name: 'Ramesh Agarwal', firm: 'Agarwal Trade Links', mobile: '9825011122', email: 'agent@agarwaltrade.example', city: 'Surat', state_code: '24', pan: 'ABJPA4321K', basis: 'pct', rate: 1.5, party_id: o.party('Agarwal Trade Links') });
  // He introduced Rupa Apparel House in the spring: commission on Rupa's invoices since then.
  await crm.query(`INSERT INTO agent_accounts (customer_id, customer_name, agent_id, from_date, until_date) VALUES ($1, 'Rupa Apparel House', $2, current_date - 150, current_date + 215) ON CONFLICT DO NOTHING`, [o.party('Rupa Apparel House'), agent.id]);
  for (const [name, company, city, kg] of [['Bharat Shah', 'Shah Knit Wear', 'Surat', 800], ['Jignesh Modi', 'Modi Garments', 'Ahmedabad', 1200], ['Paresh Doshi', 'Doshi Kids', 'Surat', 400]] as const)
    await call('crm', agentTok, 'POST', '/portal/agent/leads', { name, company, mobile: String(++mob), city, state_code: '24', category: 'Single Jersey', requirement_kg: kg, est_value: kg * 280, message: 'Introduced by Agarwal Trade Links' });
  await call('crm', mgr, 'POST', `/agents/${agent.id}/sync`, {});
  const earned = await crm.query(`SELECT count(*)::int AS n FROM agent_commissions WHERE agent_id = $1 AND status = 'earned'`, [agent.id]);
  if (earned.rows[0].n) await call('crm', mgr, 'POST', `/agents/${agent.id}/payouts`, { note: 'Commission on Rupa Apparel House, paid invoices' });
}
