import fs from 'node:fs';
import path from 'node:path';
import type { Router } from 'express';
import { z } from 'zod';
import { type Pool, type ServiceContext, ROOT_DIR, audit, badRequest, callAsUser, callService, conflict, contextOf, hasPermission, many, notFound, notify, one, optText, parse, reqText, requirePermission, tx } from '@erp/platform';
import { localNumber } from './migration.ts';

const S = 'golive';

/** Cross-cutting UAT scenarios on top of one scenario per requirement. */
const EXTRA: [string, string, string, string, string][] = [
  ['exception', 'Duplicate supplier invoice', 'Capture the same supplier invoice number twice.', 'The second is refused; the first stays posted once.', 'Purchase'],
  ['exception', 'Payment gateway callback with a bad signature', 'POST a payment callback with a wrong x-signature.', 'Refused with 401, logged as rejected; the order stays unpaid.', 'Accounts'],
  ['permission', 'Warehouse scope', 'Sign in as surat.stores and open a Kolkata lot or inward.', 'Refused: outside the data scope.', 'Stores'],
  ['permission', 'Maker-checker', 'Raise a PO above the limit and try to approve it as the same user.', 'Refused; a second approver is required.', 'Purchase'],
  ['concurrency', 'Two people pick the same roll', 'Scan the same roll on two pick lists at the same moment.', 'Exactly one succeeds; the other is told the roll is taken.', 'Dispatch'],
  ['concurrency', 'Two orders for the last lot', 'Two portal customers check out the last kg of a lot together.', 'One is booked; the other is told the stock is gone. No over-reservation.', 'Sales'],
  ['tax', 'Intra- vs inter-state invoice', 'Invoice a Gujarat customer from Surat and a Tamil Nadu customer from Surat.', 'CGST+SGST on the first, IGST on the second; GSTR-1 shows both correctly.', 'Accounts'],
  ['tax', 'TDS 194Q on the excess', 'Post supplier bills that cross ₹50 lakh in the year.', 'TDS only on the amount above the threshold, at 0.1%.', 'Accounts'],
  ['barcode', 'Label print and scan', 'Print labels for an inward, scan each with a handheld scanner.', 'Every label scans to the right roll; a reprinted label still works.', 'Stores'],
  ['integration', 'Event flow end to end', 'Book a portal order, pay, pick, invoice, dispatch, deliver.', 'Messages sent, accounts posted, customer portal updated, no parked events.', 'Dispatch'],
  ['performance', 'Load test', 'Run npm run load-test -- --seconds 60 --concurrency 20 on the production server.', 'No errors; p95 under 1.5 s for every endpoint.', 'IT'],
  ['security', 'Session and password controls', 'Five wrong passwords; reuse an old password; open the app after the session expires.', 'Account locked; reuse refused; sign-in required again.', 'IT'],
  ['security', 'Customer portal isolation', 'As one customer, open another customer’s order or invoice URL.', 'Not found.', 'IT'],
  ['backup', 'Backup and restore', 'Run a backup and a restore test from System health; do a full restore drill on a spare machine.', 'Restore test passes; the drill meets the RTO.', 'IT'],
];

export async function seedScenarios(pool: Pool) {
  if ((await one<{ n: number }>(pool, 'SELECT count(*)::int AS n FROM uat_scenarios'))!.n) return;
  const file = path.join(ROOT_DIR, 'apps/web/src/lib/programme.json');
  const prog = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) as { requirements: { id: string; phase: string; module: string; feature: string; detail: string }[] } : { requirements: [] };
  for (const r of prog.requirements.filter((x) => x.phase !== 'P0' && x.phase !== 'P11'))
    await pool.query(`INSERT INTO uat_scenarios (code, phase, module, requirement_id, category, title, steps, expected) VALUES ($1,$2,$3,$4,'normal',$5,$6,$7) ON CONFLICT DO NOTHING`,
      [`UAT-${r.id.slice(4)}`, r.phase, r.module, r.id, r.feature, `Walk through the normal process for “${r.feature}” on the screens listed for ${r.id} in docs/traceability.md, using realistic data.`, r.detail]);
  for (const [i, [cat, title, steps, expected, role]] of EXTRA.entries())
    await pool.query(`INSERT INTO uat_scenarios (code, phase, module, category, title, steps, expected, role) VALUES ($1,'ALL','Cross-cutting',$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`, [`UAT-X${String(i + 1).padStart(2, '0')}`, cat, title, steps, expected, role]);
}

const SLA: Record<string, [number, number]> = { P1: [0.5, 4], P2: [2, 24], P3: [8, 72], P4: [24, 240] };

export function readinessRoutes(r: Router, { pool }: ServiceContext) {
  // ----- UAT -----
  r.get('/uat/scenarios', requirePermission('golive.read'), async (req, res) => {
    await seedScenarios(pool);
    res.json(await many(pool, `SELECT s.*, (SELECT count(*)::int FROM defects d WHERE d.scenario_id = s.id AND d.status NOT IN ('closed','rejected')) AS open_defects FROM uat_scenarios s
      WHERE ($1::text IS NULL OR s.phase = $1) AND ($2::text IS NULL OR s.status = ANY(string_to_array($2, ','))) ORDER BY s.phase, s.code`, [req.query.phase ?? null, req.query.status ?? null]));
  });
  r.get('/uat/scenarios/:id', requirePermission('golive.read'), async (req, res) => {
    const s = await one(pool, 'SELECT * FROM uat_scenarios WHERE id = $1', [req.params.id]);
    if (!s) throw notFound('Scenario');
    res.json({ ...s, runs: await many(pool, 'SELECT * FROM uat_runs WHERE scenario_id = $1 ORDER BY at DESC', [req.params.id]), defects: await many(pool, 'SELECT * FROM defects WHERE scenario_id = $1 ORDER BY created_at DESC', [req.params.id]) });
  });
  r.post('/uat/scenarios/:id/result', requirePermission('golive.uat.execute'), async (req, res) => {
    const b = parse(z.object({ result: z.enum(['passed', 'failed', 'blocked']), evidence: reqText(2000), defect: z.object({ title: reqText(200), severity: z.enum(['S1', 'S2', 'S3', 'S4']), description: optText(2000) }).optional() }), req.body);
    if (b.result === 'failed' && !b.defect) throw badRequest('A failed scenario needs a defect');
    const out = await tx(pool, async (c) => {
      const s = await one<{ id: string; code: string; module: string; title: string }>(c, 'SELECT * FROM uat_scenarios WHERE id = $1 FOR UPDATE', [req.params.id]);
      if (!s) throw notFound('Scenario');
      await c.query(`UPDATE uat_scenarios SET status = $2, executed_by_name = $3, executed_at = now(), evidence = $4, waiver_reason = NULL WHERE id = $1`, [s.id, b.result, req.user!.name, b.evidence]);
      await c.query(`INSERT INTO uat_runs (scenario_id, result, evidence, by_name) VALUES ($1,$2,$3,$4)`, [s.id, b.result, b.evidence, req.user!.name]);
      let defect = null;
      if (b.defect) {
        const number = await localNumber(c, 'defect', 'DEF-');
        defect = (await one<{ id: string }>(c, `INSERT INTO defects (number, scenario_id, title, description, severity, module, raised_by_name) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`, [number, s.id, b.defect.title, b.defect.description ?? b.evidence, b.defect.severity, s.module, req.user!.name]))!.id;
        if (['S1', 'S2'].includes(b.defect.severity)) await notify(c, S, { audience_permission: 'golive.uat.signoff', kind: 'warning', title: `${b.defect.severity} defect ${number}: ${b.defect.title}`, body: `${s.code} ${s.title}`, link: '/golive/uat' });
      }
      await audit(c, S, contextOf(req), { entity: 'uat_scenario', entityId: s.id, action: b.result, reason: b.evidence });
      return { status: b.result, defect };
    });
    res.json(out);
  });
  r.post('/uat/scenarios/:id/waive', requirePermission('golive.uat.signoff'), async (req, res) => {
    const { reason } = parse(z.object({ reason: reqText(500) }), req.body);
    await tx(pool, async (c) => {
      const r1 = await c.query(`UPDATE uat_scenarios SET status = 'waived', waiver_reason = $2, executed_by_name = $3, executed_at = now() WHERE id = $1`, [req.params.id, reason, req.user!.name]);
      if (!r1.rowCount) throw notFound('Scenario');
      await audit(c, S, contextOf(req), { entity: 'uat_scenario', entityId: String(req.params.id), action: 'waived', reason });
    });
    res.json({ ok: true });
  });
  r.get('/uat/defects', requirePermission('golive.read'), async (req, res) => {
    res.json(await many(pool, `SELECT d.*, s.code AS scenario_code, s.title AS scenario_title FROM defects d LEFT JOIN uat_scenarios s ON s.id = d.scenario_id WHERE ($1::text IS NULL OR d.status = ANY(string_to_array($1, ','))) ORDER BY d.severity, d.created_at DESC`, [req.query.status ?? null]));
  });
  r.patch('/uat/defects/:id', requirePermission('golive.uat.execute'), async (req, res) => {
    const b = parse(z.object({ status: z.enum(['open', 'in_progress', 'fixed', 'retest', 'closed', 'rejected']), assigned_to_name: optText(120), resolution: optText(2000) }), req.body);
    await tx(pool, async (c) => {
      const r1 = await c.query(`UPDATE defects SET status = $2, assigned_to_name = coalesce($3, assigned_to_name), resolution = coalesce($4, resolution), updated_at = now(), closed_at = CASE WHEN $2 IN ('closed','rejected') THEN now() END WHERE id = $1`, [req.params.id, b.status, b.assigned_to_name ?? null, b.resolution ?? null]);
      if (!r1.rowCount) throw notFound('Defect');
      // A fixed defect sends its scenario back for retest.
      if (b.status === 'retest') await c.query(`UPDATE uat_scenarios SET status = 'not_run' WHERE id = (SELECT scenario_id FROM defects WHERE id = $1)`, [req.params.id]);
      await audit(c, S, contextOf(req), { entity: 'defect', entityId: String(req.params.id), action: b.status, reason: b.resolution ?? null });
    });
    res.json({ ok: true });
  });

  /** Business sign-off for a phase ('ALL' is the cross-cutting set; null is every scenario): every scenario run or waived, none failed, no open S1/S2. */
  async function phaseCriteria(scope: string | null) {
    const w = scope === null ? '' : `WHERE phase = $1`;
    const p = scope === null ? [] : [scope];
    const s = await one<{ total: number; passed: number; failed: number; blocked: number; not_run: number; waived: number }>(pool, `SELECT count(*)::int AS total, count(*) FILTER (WHERE status = 'passed')::int AS passed, count(*) FILTER (WHERE status = 'failed')::int AS failed, count(*) FILTER (WHERE status = 'blocked')::int AS blocked, count(*) FILTER (WHERE status = 'not_run')::int AS not_run, count(*) FILTER (WHERE status = 'waived')::int AS waived FROM uat_scenarios ${w}`, p);
    const d = await one<{ s1: number; s2: number; other: number }>(pool, `SELECT count(*) FILTER (WHERE d.severity = 'S1')::int AS s1, count(*) FILTER (WHERE d.severity = 'S2')::int AS s2, count(*) FILTER (WHERE d.severity IN ('S3','S4'))::int AS other FROM defects d LEFT JOIN uat_scenarios s ON s.id = d.scenario_id WHERE d.status NOT IN ('closed','rejected') ${scope === null ? '' : 'AND s.phase = $1'}`, p);
    const ok = !!s && s.total > 0 && s.not_run === 0 && s.failed === 0 && s.blocked === 0 && d!.s1 === 0 && d!.s2 === 0;
    return { scenarios: s, open_defects: d, ready: ok };
  }
  r.get('/uat/summary', requirePermission('golive.read'), async (_req, res) => {
    await seedScenarios(pool);
    const phases = await many<{ phase: string }>(pool, `SELECT phase FROM uat_scenarios GROUP BY phase ORDER BY phase = 'ALL', nullif(regexp_replace(phase, '\\D', '', 'g'), '')::int NULLS LAST, phase`);
    const out = [];
    for (const p of phases) out.push({ phase: p.phase, ...(await phaseCriteria(p.phase)), signoff: await one(pool, `SELECT * FROM signoffs WHERE scope = $1 ORDER BY at DESC LIMIT 1`, [p.phase]) });
    res.json({ phases: out, overall: await phaseCriteria(null) });
  });
  r.post('/uat/signoff', requirePermission('golive.uat.signoff'), async (req, res) => {
    const b = parse(z.object({ scope: z.string().min(1).max(10), decision: z.enum(['approved', 'rejected']), conditions: optText(1000), role: optText(80) }), req.body);
    const crit = await phaseCriteria(b.scope);
    if (b.decision === 'approved' && !crit.ready && !b.conditions) throw conflict('Criteria are not met (scenarios not run or failed, or open S1/S2 defects). Record the conditions to approve anyway.');
    await tx(pool, async (c) => {
      await c.query(`INSERT INTO signoffs (scope, decision, conditions, criteria, signed_by_name, signed_role) VALUES ($1,$2,$3,$4,$5,$6)`, [b.scope, b.decision, b.conditions ?? null, JSON.stringify(crit), req.user!.name, b.role ?? null]);
      await audit(c, S, contextOf(req), { entity: 'uat_signoff', entityId: b.scope, action: b.decision, reason: b.conditions ?? null, after: crit });
    });
    res.json({ ok: true, criteria: crit });
  });

  // ----- training -----
  r.get('/training', requirePermission('golive.read'), async (_req, res) => {
    const [mods, recs, dir] = await Promise.all([many(pool, 'SELECT * FROM training_modules ORDER BY role, code'), many(pool, 'SELECT *, completed_at::text FROM training_records ORDER BY user_name'), callService<{ id: string; name: string; email: string; status: string; party_id: string | null }[]>(S, 'identity', 'GET', '/directory').catch(() => [])]);
    const staff = dir.filter((u) => !u.party_id && u.status === 'active');
    res.json({ modules: mods, records: recs, staff, completion: { assigned: recs.length, completed: recs.filter((x) => (x as { status: string }).status === 'completed').length, staff_trained: staff.filter((u) => recs.some((x) => (x as { user_id: string }).user_id === u.id) && recs.filter((x) => (x as { user_id: string }).user_id === u.id).every((x) => (x as { status: string }).status === 'completed')).length, staff: staff.length } });
  });
  r.post('/training/assign', requirePermission('golive.uat.signoff', 'golive.migration.manage'), async (req, res) => {
    const b = parse(z.object({ user_ids: z.array(z.uuid()).min(1).max(200), module_codes: z.array(z.string()).min(1).max(30) }), req.body);
    const dir = await callService<{ id: string; name: string }[]>(S, 'identity', 'GET', '/directory');
    await tx(pool, async (c) => { for (const u of b.user_ids) for (const m of b.module_codes) await c.query(`INSERT INTO training_records (user_id, user_name, module_code) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [u, dir.find((x) => x.id === u)?.name ?? 'Unknown', m]); });
    res.json({ ok: true });
  });
  r.post('/training/complete', requirePermission('golive.uat.signoff', 'golive.migration.manage'), async (req, res) => {
    const b = parse(z.object({ user_id: z.uuid(), module_code: z.string(), score: z.number().int().min(0).max(100).nullable().optional() }), req.body);
    const r1 = await pool.query(`UPDATE training_records SET status = 'completed', score = $3, trainer_name = $4, completed_at = now() WHERE user_id = $1 AND module_code = $2`, [b.user_id, b.module_code, b.score ?? null, req.user!.name]);
    if (!r1.rowCount) throw notFound('Assignment');
    res.json({ ok: true });
  });

  // ----- cutover, go/no-go, hypercare -----
  r.get('/cutover', requirePermission('golive.read'), async (_req, res) => {
    res.json({ tasks: await many(pool, 'SELECT * FROM cutover_tasks ORDER BY seq'), decisions: await many(pool, 'SELECT * FROM go_decisions ORDER BY at DESC') });
  });
  r.patch('/cutover/:id', requirePermission('golive.cutover.manage'), async (req, res) => {
    const b = parse(z.object({ status: z.enum(['todo', 'done', 'blocked', 'not_applicable']), notes: optText(1000) }), req.body);
    const r1 = await pool.query(`UPDATE cutover_tasks SET status = $2, notes = coalesce($3, notes), done_by_name = CASE WHEN $2 IN ('done','not_applicable') THEN $4 END, done_at = CASE WHEN $2 IN ('done','not_applicable') THEN now() END WHERE id = $1`, [req.params.id, b.status, b.notes ?? null, req.user!.name]);
    if (!r1.rowCount) throw notFound('Task');
    res.json({ ok: true });
  });
  r.get('/readiness', requirePermission('golive.read'), async (req, res) => { res.json(await readiness(req, pool)); });
  r.post('/go-decision', requirePermission('golive.uat.signoff'), async (req, res) => {
    const b = parse(z.object({ decision: z.enum(['go', 'no_go']), rollback_plan: reqText(2000), notes: optText(2000) }), req.body);
    const crit = await readiness(req, pool);
    if (b.decision === 'go' && !crit.ready && !b.notes) throw conflict('Not every go-live criterion is met; record why you are going ahead in the notes.');
    await tx(pool, async (c) => {
      await c.query(`INSERT INTO go_decisions (decision, criteria, rollback_plan, notes, decided_by_name) VALUES ($1,$2,$3,$4,$5)`, [b.decision, JSON.stringify(crit), b.rollback_plan, b.notes ?? null, req.user!.name]);
      await audit(c, S, contextOf(req), { entity: 'go_decision', entityId: b.decision, action: b.decision, reason: b.notes ?? null, after: crit.criteria });
    });
    res.json({ ok: true });
  });

  r.get('/incidents', async (req, res) => {
    // Anyone may report a problem; without golive.read they see only what they reported.
    const all = hasPermission(req.user, 'golive.read');
    res.json(await many(pool, `SELECT *, (status IN ('open','investigating') AND resolve_by < now()) AS breached FROM incidents ${all ? '' : 'WHERE reported_by_name = $1'} ORDER BY (status IN ('open','investigating')) DESC, severity, created_at DESC`, all ? [] : [req.user!.name]));
  });
  r.post('/incidents', async (req, res) => {
    const b = parse(z.object({ title: reqText(200), description: reqText(4000), module: optText(60), severity: z.enum(['P1', 'P2', 'P3', 'P4']) }), req.body);
    const [respond, resolve] = SLA[b.severity]!;
    const out = await tx(pool, async (c) => {
      const number = await localNumber(c, 'incident', 'INC-');
      const i = await one<{ id: string }>(c, `INSERT INTO incidents (number, title, description, module, severity, reported_by_name, respond_by, resolve_by) VALUES ($1,$2,$3,$4,$5,$6, now() + make_interval(mins => $7), now() + make_interval(mins => $8)) RETURNING id`,
        [number, b.title, b.description, b.module ?? null, b.severity, req.user!.name, Math.round(respond * 60), Math.round(resolve * 60)]);
      await notify(c, S, { audience_permission: 'golive.cutover.manage', kind: b.severity === 'P1' || b.severity === 'P2' ? 'warning' : 'action', title: `${b.severity} incident ${number}: ${b.title}`, body: `Respond within ${respond < 1 ? `${respond * 60} minutes` : `${respond} hours`}`, link: '/golive/hypercare' });
      return { id: i!.id, number };
    });
    res.status(201).json(out);
  });
  r.patch('/incidents/:id', requirePermission('golive.cutover.manage'), async (req, res) => {
    const b = parse(z.object({ status: z.enum(['open', 'investigating', 'resolved', 'closed']), assigned_to_name: optText(120), resolution: optText(4000) }), req.body);
    if (['resolved', 'closed'].includes(b.status) && !b.resolution) throw badRequest('Record the resolution');
    const r1 = await pool.query(`UPDATE incidents SET status = $2, assigned_to_name = coalesce($3, assigned_to_name), resolution = coalesce($4, resolution), resolved_at = CASE WHEN $2 IN ('resolved','closed') THEN coalesce(resolved_at, now()) END, updated_at = now() WHERE id = $1`, [req.params.id, b.status, b.assigned_to_name ?? null, b.resolution ?? null]);
    if (!r1.rowCount) throw notFound('Incident');
    res.json({ ok: true });
  });
}

/** Go-live criteria evaluated from live data: UAT, defects, training, migration, cutover, backups. */
async function readiness(req: Parameters<Parameters<Router['get']>[1]>[0], pool: Pool) {
  await seedScenarios(pool);
  const uat = await one<{ total: number; done: number; failed: number }>(pool, `SELECT count(*)::int AS total, count(*) FILTER (WHERE status IN ('passed','waived'))::int AS done, count(*) FILTER (WHERE status IN ('failed','blocked'))::int AS failed FROM uat_scenarios`);
  const def = await one<{ s12: number; open: number }>(pool, `SELECT count(*) FILTER (WHERE severity IN ('S1','S2'))::int AS s12, count(*)::int AS open FROM defects WHERE status NOT IN ('closed','rejected')`);
  const mig = await many<{ object_type: string; status: string }>(pool, `SELECT DISTINCT ON (object_type) object_type, status FROM migration_batches WHERE status <> 'abandoned' ORDER BY object_type, created_at DESC`);
  const tr = await one<{ assigned: number; done: number }>(pool, `SELECT count(*)::int AS assigned, count(*) FILTER (WHERE status = 'completed')::int AS done FROM training_records`);
  const cut = await one<{ total: number; done: number; blocked: number }>(pool, `SELECT count(*) FILTER (WHERE stage IN ('prepare','freeze','migrate','verify'))::int AS total, count(*) FILTER (WHERE stage IN ('prepare','freeze','migrate','verify') AND status IN ('done','not_applicable'))::int AS done, count(*) FILTER (WHERE status = 'blocked')::int AS blocked FROM cutover_tasks`);
  const sys = await callAsUser<{ backups: { status: string; restore_status: string | null; finished_at: string | null }[] }>(String(req.headers.authorization ?? ''), 'insights', 'GET', '/system/health').catch(() => null);
  const lastBackup = sys?.backups.find((b) => b.status === 'completed');
  // Open POs and orders are optional (a business may have none at cutover), but once started they must be signed off.
  const migObjects = ['parties', 'opening_balances', 'opening_gl', 'opening_stock', ...['open_pos', 'open_orders', 'open_job_work', 'gst_credit', 'gst_cash', 'itc_reversals'].filter((t) => mig.some((m) => m.object_type === t))];
  const criteria = [
    { key: 'uat', label: 'Every UAT scenario passed or waived', ok: !!uat && uat.total > 0 && uat.done === uat.total, detail: `${uat?.done ?? 0} of ${uat?.total ?? 0}; ${uat?.failed ?? 0} failed or blocked` },
    { key: 'defects', label: 'No open S1 or S2 defects', ok: def!.s12 === 0, detail: `${def!.s12} open S1/S2, ${def!.open} open in all` },
    { key: 'migration', label: 'Every migration object loaded and signed off', ok: migObjects.every((t) => mig.some((m) => m.object_type === t && m.status === 'signed_off')), detail: migObjects.map((t) => `${t.replace('_', ' ')}: ${mig.find((m) => m.object_type === t)?.status.replace('_', ' ') ?? 'not loaded'}`).join(' · ') },
    { key: 'training', label: 'All assigned training completed', ok: tr!.assigned > 0 && tr!.done === tr!.assigned, detail: `${tr!.done} of ${tr!.assigned} modules` },
    { key: 'cutover', label: 'Preparation, freeze, migration and verification tasks done', ok: cut!.total > 0 && cut!.done === cut!.total, detail: `${cut!.done} of ${cut!.total}${cut!.blocked ? `, ${cut!.blocked} blocked` : ''}` },
    { key: 'backup', label: 'A backup taken in the last 24 hours passed its restore test', ok: !!lastBackup && lastBackup.restore_status === 'passed' && Date.now() - new Date(lastBackup.finished_at!).getTime() < 86_400_000, detail: sys ? (lastBackup ? `last backup ${lastBackup.finished_at?.slice(0, 16).replace('T', ' ')}, restore ${lastBackup.restore_status ?? 'not tested'}` : 'no backup yet') : 'needs System health access' },
  ];
  return { ready: criteria.every((c) => c.ok), criteria };
}
