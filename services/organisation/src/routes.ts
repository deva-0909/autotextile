import type { Request, Router } from 'express';
import { z } from 'zod';
import {
  type ServiceContext, GST_STATES, PAN_RE, audit, badRequest, conflict, contextOf, forbidden, gstinProblem, inScope, insertAudited,
  many, notFound, one, optText, panOfGstin, parse, publish, reqText, requirePermission, scopeClause, tx, updateAudited,
} from '@erp/platform';

const S = 'organisation';
const status = z.enum(['active', 'inactive']).default('active');
const version = z.number().int().optional();
const code = (max = 20) => z.string().trim().toUpperCase().regex(/^[A-Z0-9][A-Z0-9_-]*$/, 'Letters, digits, - and _ only').max(max);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');

const entityBody = z.object({
  code: code(),
  legal_name: reqText(200),
  trade_name: optText(200),
  constitution: z.enum(['private_limited', 'public_limited', 'llp', 'partnership', 'proprietorship', 'other']),
  pan: z.string().trim().toUpperCase().regex(PAN_RE, 'PAN format is AAAAA9999A'),
  cin: optText(30),
  registered_address: optText(500),
  state_code: z.string().refine((v) => !!GST_STATES[v], 'Choose a state').nullable().optional(),
  pincode: z.string().regex(/^\d{6}$/, '6-digit PIN code').nullable().optional().or(z.literal('').transform(() => null)),
  email: z.email().nullable().optional().or(z.literal('').transform(() => null)),
  phone: optText(20),
  status,
  version,
});

const gstBody = z.object({
  legal_entity_id: z.uuid(),
  gstin: z.string().trim().toUpperCase(),
  registration_type: z.enum(['regular', 'composition', 'sez_unit', 'sez_developer', 'isd', 'casual']).default('regular'),
  trade_name: optText(200),
  principal_address: optText(500),
  effective_from: isoDate,
  effective_to: isoDate.nullable().optional(),
  e_invoice_applicable: z.boolean().default(true),
  status,
  version,
  reason: optText(300),
});

const branchBody = z.object({
  gst_registration_id: z.uuid(),
  code: code(),
  name: reqText(120),
  is_principal_place: z.boolean().default(false),
  address: optText(500),
  city: optText(80),
  pincode: optText(6),
  status,
  version,
});

const warehouseBody = z.object({
  code: code(),
  name: reqText(120),
  branch_id: z.uuid(),
  gst_registration_id: z.uuid(),
  warehouse_type: z.enum(['receiving_hub', 'distribution', 'transit', 'returns']).default('distribution'),
  dispatch_priority: z.number().int().min(1).max(999),
  address: optText(500),
  city: reqText(80),
  pincode: optText(6),
  manager_name: optText(120),
  phone: optText(20),
  capacity_kg: z.number().nonnegative().nullable().optional(),
  status,
  version,
});

const locationBody = z.object({
  parent_id: z.uuid().nullable().optional(),
  kind: z.enum(['zone', 'aisle', 'rack', 'bin']),
  code: code(12),
  name: optText(80),
  purpose: z.enum(['storage', 'receiving', 'qc', 'staging', 'dispatch', 'damaged', 'returns']).default('storage'),
  capacity_kg: z.number().nonnegative().nullable().optional(),
  status,
  version,
});

const LOCATION_CHILD: Record<string, string> = { zone: 'aisle', aisle: 'rack', rack: 'bin' };

const strip = <T extends { version?: number; reason?: string | null }>(b: T) => {
  const { version: _v, reason: _r, ...rest } = b;
  return rest;
};

function assertGstScope(req: Request, gstId: string) {
  if (!inScope(req.user!, 'gstin', gstId)) throw forbidden('This GST registration is outside your data scope');
}

export function routes(r: Router, { pool }: ServiceContext) {
  // ---------- structure (tree used by scope pickers and the org chart) ----------
  r.get('/structure', async (req, res) => {
    const u = req.user!;
    const p1: unknown[] = [], p2: unknown[] = [], p3: unknown[] = [], p4: unknown[] = [];
    const w = (clause: string) => (clause ? `WHERE ${clause}` : '');
    const [entities, gsts, branches, warehouses] = await Promise.all([
      many(pool, `SELECT id, code, legal_name, trade_name, pan, status FROM legal_entities ${w(scopeClause(u, 'entity', 'id', p1))} ORDER BY legal_name`, p1),
      many<{ state_code: string }>(pool, `SELECT id, legal_entity_id, gstin, state_code, status FROM gst_registrations ${w(scopeClause(u, 'gstin', 'id', p2))} ORDER BY gstin`, p2),
      many(pool, `SELECT id, gst_registration_id, code, name, city, status FROM branches ${w(scopeClause(u, 'branch', 'id', p3))} ORDER BY name`, p3),
      many(pool, `SELECT id, branch_id, gst_registration_id, code, name, city, dispatch_priority, status FROM warehouses ${w(scopeClause(u, 'warehouse', 'id', p4))} ORDER BY dispatch_priority, name`, p4),
    ]);
    res.json({ entities, gstRegistrations: gsts.map((g) => ({ ...g, state_name: GST_STATES[g.state_code] })), branches, warehouses });
  });

  r.get('/states', (_req, res) => {
    res.json(Object.entries(GST_STATES).map(([code, name]) => ({ code, name })));
  });

  // ---------- legal entities ----------
  r.get('/entities', requirePermission('org.entity.read'), async (req, res) => {
    const params: unknown[] = [];
    const sc = scopeClause(req.user!, 'entity', 'e.id', params);
    res.json(await many(pool, `
      SELECT e.*, (SELECT count(*)::int FROM gst_registrations g WHERE g.legal_entity_id = e.id) AS gst_count
      FROM legal_entities e ${sc ? `WHERE ${sc}` : ''} ORDER BY e.legal_name`, params));
  });

  r.get('/entities/:id', requirePermission('org.entity.read'), async (req, res) => {
    if (!inScope(req.user!, 'entity', String(req.params.id))) throw forbidden('Outside your data scope');
    const e = await one(pool, 'SELECT * FROM legal_entities WHERE id = $1', [req.params.id]);
    if (!e) throw notFound('Legal entity');
    res.json(e);
  });

  r.post('/entities', requirePermission('org.entity.manage'), async (req, res) => {
    const body = parse(entityBody, req.body);
    res.status(201).json(await tx(pool, (c) => insertAudited(c, req, S, 'legal_entities', 'legal_entity', strip(body))));
  });

  r.patch('/entities/:id', requirePermission('org.entity.manage'), async (req, res) => {
    const body = parse(entityBody, req.body);
    res.json(await tx(pool, async (c) => {
      const cur = await one<{ pan: string }>(c, 'SELECT pan FROM legal_entities WHERE id = $1', [req.params.id]);
      if (cur && cur.pan !== body.pan) {
        const linked = await one(c, 'SELECT 1 FROM gst_registrations WHERE legal_entity_id = $1', [req.params.id]);
        if (linked) throw conflict('PAN cannot change while GST registrations are linked to this entity');
      }
      return updateAudited(c, req, S, 'legal_entities', 'legal_entity', String(req.params.id), strip(body), { version: body.version });
    }));
  });

  // ---------- GST registrations ----------
  r.get('/gst-registrations', requirePermission('org.entity.read'), async (req, res) => {
    const params: unknown[] = [];
    const sc = scopeClause(req.user!, 'gstin', 'g.id', params);
    const rows = await many<{ state_code: string }>(pool, `
      SELECT g.*, e.legal_name, e.code AS entity_code,
        (SELECT count(*)::int FROM branches b WHERE b.gst_registration_id = g.id) AS branch_count,
        (SELECT count(*)::int FROM warehouses w WHERE w.gst_registration_id = g.id) AS warehouse_count
      FROM gst_registrations g JOIN legal_entities e ON e.id = g.legal_entity_id
      ${sc ? `WHERE ${sc}` : ''} ORDER BY e.legal_name, g.gstin`, params);
    res.json(rows.map((g) => ({ ...g, state_name: GST_STATES[g.state_code] })));
  });

  r.post('/gst-registrations', requirePermission('org.entity.manage'), async (req, res) => {
    const body = parse(gstBody, req.body);
    const problem = gstinProblem(body.gstin);
    if (problem) throw badRequest(problem, { fields: { gstin: problem } });
    res.status(201).json(await tx(pool, async (c) => {
      const entity = await one<{ pan: string }>(c, 'SELECT pan FROM legal_entities WHERE id = $1', [body.legal_entity_id]);
      if (!entity) throw notFound('Legal entity');
      if (panOfGstin(body.gstin) !== entity.pan)
        throw badRequest('GSTIN does not belong to this legal entity (PAN mismatch)', { fields: { gstin: `PAN in GSTIN must be ${entity.pan}` } });
      return insertAudited(c, req, S, 'gst_registrations', 'gst_registration', { ...strip(body), state_code: body.gstin.slice(0, 2) });
    }));
  });

  r.patch('/gst-registrations/:id', requirePermission('org.entity.manage'), async (req, res) => {
    const body = parse(gstBody, req.body);
    assertGstScope(req, String(req.params.id));
    res.json(await tx(pool, async (c) => {
      const cur = await one<{ gstin: string; legal_entity_id: string }>(c, 'SELECT gstin, legal_entity_id FROM gst_registrations WHERE id = $1', [req.params.id]);
      if (!cur) throw notFound('GST registration');
      // GSTIN and owning entity are identity fields; a new registration must be created instead.
      if (cur.gstin !== body.gstin || cur.legal_entity_id !== body.legal_entity_id)
        throw conflict('GSTIN and legal entity cannot be changed. Deactivate this registration and add a new one.');
      return updateAudited(c, req, S, 'gst_registrations', 'gst_registration', String(req.params.id), strip(body), { version: body.version, reason: body.reason });
    }));
  });

  // ---------- branches ----------
  r.get('/branches', requirePermission('org.entity.read', 'org.warehouse.read'), async (req, res) => {
    const params: unknown[] = [];
    const sc = scopeClause(req.user!, 'branch', 'b.id', params);
    res.json(await many(pool, `
      SELECT b.*, g.gstin, g.state_code, (SELECT count(*)::int FROM warehouses w WHERE w.branch_id = b.id) AS warehouse_count
      FROM branches b JOIN gst_registrations g ON g.id = b.gst_registration_id
      ${sc ? `WHERE ${sc}` : ''} ORDER BY b.name`, params));
  });

  r.post('/branches', requirePermission('org.entity.manage'), async (req, res) => {
    const body = parse(branchBody, req.body);
    assertGstScope(req, body.gst_registration_id);
    res.status(201).json(await tx(pool, (c) => insertAudited(c, req, S, 'branches', 'branch', strip(body))));
  });

  r.patch('/branches/:id', requirePermission('org.entity.manage'), async (req, res) => {
    const body = parse(branchBody, req.body);
    assertGstScope(req, body.gst_registration_id);
    res.json(await tx(pool, (c) => updateAudited(c, req, S, 'branches', 'branch', String(req.params.id), strip(body), { version: body.version })));
  });

  // ---------- warehouses ----------
  r.get('/warehouses', requirePermission('org.warehouse.read'), async (req, res) => {
    const params: unknown[] = [];
    const sc = scopeClause(req.user!, 'warehouse', 'w.id', params);
    res.json(await many(pool, `
      SELECT w.*, b.name AS branch_name, g.gstin, g.state_code,
        (SELECT count(*)::int FROM warehouse_locations l WHERE l.warehouse_id = w.id AND l.kind = 'bin') AS bin_count,
        (SELECT count(*)::int FROM warehouse_locations l WHERE l.warehouse_id = w.id) AS location_count
      FROM warehouses w JOIN branches b ON b.id = w.branch_id JOIN gst_registrations g ON g.id = w.gst_registration_id
      ${sc ? `WHERE ${sc}` : ''} ORDER BY w.dispatch_priority, w.name`, params));
  });

  r.get('/warehouses/:id', requirePermission('org.warehouse.read'), async (req, res) => {
    if (!inScope(req.user!, 'warehouse', String(req.params.id))) throw forbidden('This warehouse is outside your data scope');
    const w = await one<Record<string, unknown>>(pool, `
      SELECT w.*, b.name AS branch_name, g.gstin, g.state_code, e.legal_name
      FROM warehouses w JOIN branches b ON b.id = w.branch_id JOIN gst_registrations g ON g.id = w.gst_registration_id
      JOIN legal_entities e ON e.id = g.legal_entity_id WHERE w.id = $1`, [req.params.id]);
    if (!w) throw notFound('Warehouse');
    const locations = await many(pool, 'SELECT * FROM warehouse_locations WHERE warehouse_id = $1 ORDER BY path', [req.params.id]);
    res.json({ ...w, locations });
  });

  async function checkWarehouseLinks(c: Parameters<Parameters<typeof tx>[1]>[0], body: z.infer<typeof warehouseBody>) {
    const b = await one<{ gst_registration_id: string }>(c, 'SELECT gst_registration_id FROM branches WHERE id = $1', [body.branch_id]);
    if (!b) throw badRequest('Branch not found', { fields: { branch_id: 'Choose a branch' } });
    const g = await one(c, `SELECT 1 FROM gst_registrations WHERE id = $1 AND status = 'active'`, [body.gst_registration_id]);
    if (!g) throw badRequest('GST registration not found or inactive', { fields: { gst_registration_id: 'Choose an active registration' } });
  }

  r.post('/warehouses', requirePermission('org.warehouse.manage'), async (req, res) => {
    const body = parse(warehouseBody, req.body);
    res.status(201).json(await tx(pool, async (c) => {
      await checkWarehouseLinks(c, body);
      return insertAudited(c, req, S, 'warehouses', 'warehouse', strip(body));
    }));
  });

  r.patch('/warehouses/:id', requirePermission('org.warehouse.manage'), async (req, res) => {
    const body = parse(warehouseBody, req.body);
    if (!inScope(req.user!, 'warehouse', String(req.params.id))) throw forbidden('This warehouse is outside your data scope');
    res.json(await tx(pool, async (c) => {
      await checkWarehouseLinks(c, body);
      return updateAudited(c, req, S, 'warehouses', 'warehouse', String(req.params.id), strip(body), { version: body.version });
    }));
  });

  r.put('/warehouses-priority', requirePermission('org.warehouse.manage'), async (req, res) => {
    const { order } = parse(z.object({ order: z.array(z.uuid()).min(1) }), req.body);
    await tx(pool, async (c) => {
      const before = await many<{ id: string; code: string; dispatch_priority: number }>(c, 'SELECT id, code, dispatch_priority FROM warehouses ORDER BY dispatch_priority FOR UPDATE');
      for (const [i, id] of order.entries()) await c.query('UPDATE warehouses SET dispatch_priority = $2, version = version + 1, updated_at = now() WHERE id = $1', [id, (i + 1) * 10]);
      const after = await many<{ code: string; dispatch_priority: number }>(c, 'SELECT code, dispatch_priority FROM warehouses ORDER BY dispatch_priority');
      await audit(c, S, contextOf(req), {
        entity: 'warehouse', entityId: 'priority', action: 'priority_changed',
        before: before.map((w) => w.code), after: after.map((w) => w.code),
      });
      await publish(c, S, 'organisation.warehouse.changed', { action: 'priority_changed' });
    });
    res.json({ ok: true });
  });

  // ---------- locations (zone > aisle > rack > bin) ----------
  r.post('/warehouses/:id/locations', requirePermission('org.warehouse.manage'), async (req, res) => {
    const body = parse(locationBody, req.body);
    const warehouseId = String(req.params.id);
    if (!inScope(req.user!, 'warehouse', warehouseId)) throw forbidden('This warehouse is outside your data scope');
    res.status(201).json(await tx(pool, async (c) => {
      let path = body.code;
      if (body.parent_id) {
        const parent = await one<{ kind: string; path: string; warehouse_id: string }>(c, 'SELECT kind, path, warehouse_id FROM warehouse_locations WHERE id = $1', [body.parent_id]);
        if (!parent || parent.warehouse_id !== warehouseId) throw badRequest('Parent location not found in this warehouse');
        if (LOCATION_CHILD[parent.kind] !== body.kind) throw badRequest(`A ${parent.kind} can only contain ${LOCATION_CHILD[parent.kind] ?? 'nothing'}s`);
        path = `${parent.path}-${body.code}`;
      } else if (body.kind !== 'zone') throw badRequest('Top-level locations must be zones');
      return insertAudited(c, req, S, 'warehouse_locations', 'warehouse_location', { ...strip(body), warehouse_id: warehouseId, path, parent_id: body.parent_id ?? null });
    }));
  });

  r.patch('/locations/:id', requirePermission('org.warehouse.manage'), async (req, res) => {
    const body = parse(locationBody.pick({ name: true, purpose: true, capacity_kg: true, status: true, version: true }), req.body);
    res.json(await tx(pool, async (c) => {
      const loc = await one<{ warehouse_id: string }>(c, 'SELECT warehouse_id FROM warehouse_locations WHERE id = $1', [req.params.id]);
      if (!loc) throw notFound('Location');
      if (!inScope(req.user!, 'warehouse', loc.warehouse_id)) throw forbidden('This warehouse is outside your data scope');
      return updateAudited(c, req, S, 'warehouse_locations', 'warehouse_location', String(req.params.id), strip(body), { version: body.version });
    }));
  });

  // ---------- fiscal years & numbering ----------
  r.get('/fiscal-years', requirePermission('org.config.read'), async (_req, res) => {
    res.json(await many(pool, 'SELECT * FROM fiscal_years ORDER BY start_date DESC'));
  });

  r.post('/fiscal-years', requirePermission('org.config.manage'), async (req, res) => {
    const body = parse(z.object({ code: reqText(20), start_date: isoDate, end_date: isoDate }), req.body);
    res.status(201).json(await tx(pool, async (c) => {
      const overlap = await one(c, 'SELECT 1 FROM fiscal_years WHERE daterange(start_date, end_date, \'[]\') && daterange($1::date, $2::date, \'[]\')', [body.start_date, body.end_date]);
      if (overlap) throw conflict('Fiscal years cannot overlap');
      return insertAudited(c, req, S, 'fiscal_years', 'fiscal_year', body);
    }));
  });

  r.post('/fiscal-years/:id/set-current', requirePermission('org.config.manage'), async (req, res) => {
    await tx(pool, async (c) => {
      await c.query('UPDATE fiscal_years SET is_current = false WHERE is_current');
      const r1 = await c.query(`UPDATE fiscal_years SET is_current = true WHERE id = $1 AND status = 'open'`, [req.params.id]);
      if (!r1.rowCount) throw badRequest('Only an open fiscal year can be made current');
      await audit(c, S, contextOf(req), { entity: 'fiscal_year', entityId: String(req.params.id), action: 'set_current' });
    });
    res.json({ ok: true });
  });

  r.get('/number-series', requirePermission('org.config.read'), async (_req, res) => {
    res.json(await many(pool, `
      SELECT n.*, g.gstin, f.code AS fiscal_year
      FROM number_series n LEFT JOIN gst_registrations g ON g.id = n.gst_registration_id JOIN fiscal_years f ON f.id = n.fiscal_year_id
      ORDER BY f.start_date DESC, n.doc_type, g.gstin NULLS FIRST`));
  });

  const seriesBody = z.object({
    doc_type: z.string().trim().regex(/^[a-z_]+$/, 'lowercase_with_underscores'),
    gst_registration_id: z.uuid().nullable().optional(),
    fiscal_year_id: z.uuid(),
    prefix: z.string().trim().max(12).regex(/^[A-Z0-9/-]*$/, 'Use A–Z, 0–9, / and -'),
    padding: z.number().int().min(1).max(10),
    next_number: z.number().int().positive(),
    status,
    version,
  });

  r.post('/number-series', requirePermission('org.config.manage'), async (req, res) => {
    const body = parse(seriesBody, req.body);
    res.status(201).json(await tx(pool, (c) => insertAudited(c, req, S, 'number_series', 'number_series', { ...strip(body), gst_registration_id: body.gst_registration_id ?? null })));
  });

  r.patch('/number-series/:id', requirePermission('org.config.manage'), async (req, res) => {
    const body = parse(seriesBody.pick({ prefix: true, padding: true, next_number: true, status: true, version: true }), req.body);
    res.json(await tx(pool, async (c) => {
      const cur = await one<{ next_number: number }>(c, 'SELECT next_number FROM number_series WHERE id = $1', [req.params.id]);
      if (cur && body.next_number < cur.next_number) throw badRequest('The next number cannot be moved backwards (it would create duplicate document numbers)');
      return updateAudited(c, req, S, 'number_series', 'number_series', String(req.params.id), strip(body), { version: body.version });
    }));
  });

  /** Allocates the next document number atomically. Used by transaction services in later phases. */
  r.post('/number-series/next', async (req, res) => {
    const { doc_type, gst_registration_id } = parse(z.object({ doc_type: z.string(), gst_registration_id: z.uuid().nullable().optional() }), req.body);
    const row = await one<{ prefix: string; padding: number; n: number }>(pool, `
      UPDATE number_series n SET next_number = next_number + 1, updated_at = now()
      FROM fiscal_years f
      WHERE f.id = n.fiscal_year_id AND f.is_current AND n.status = 'active' AND n.doc_type = $1
        AND n.gst_registration_id IS NOT DISTINCT FROM $2
      RETURNING n.prefix, n.padding, n.next_number - 1 AS n`, [doc_type, gst_registration_id ?? null]);
    if (!row) throw notFound(`Active number series for ${doc_type} in the current fiscal year`);
    res.json({ number: `${row.prefix}${String(row.n).padStart(row.padding, '0')}` });
  });

  // ---------- settings ----------
  r.get('/settings', requirePermission('org.config.read'), async (_req, res) => {
    res.json(await many(pool, 'SELECT * FROM settings ORDER BY category, label'));
  });

  r.put('/settings/:key', requirePermission('org.config.manage'), async (req, res) => {
    const { value, reason } = parse(z.object({ value: z.unknown(), reason: reqText(300) }), req.body);
    res.json(await tx(pool, async (c) => {
      const s = await one<{ value_type: string; options: string[] | null; value: unknown }>(c, 'SELECT * FROM settings WHERE key = $1 FOR UPDATE', [req.params.key]);
      if (!s) throw notFound('Setting');
      const ok =
        (['number', 'percent'].includes(s.value_type) && typeof value === 'number' && value >= 0 && (s.value_type !== 'percent' || value <= 100)) ||
        (s.value_type === 'boolean' && typeof value === 'boolean') ||
        (s.value_type === 'text' && typeof value === 'string') ||
        (s.value_type === 'select' && s.options?.includes(value as string)) ||
        (s.value_type === 'list' && Array.isArray(value) && value.every((v) => typeof v === 'number'));
      if (!ok) throw badRequest('Value is not valid for this setting');
      const after = await one(c, 'UPDATE settings SET value = $2, updated_by = $3, updated_at = now() WHERE key = $1 RETURNING *', [req.params.key, JSON.stringify(value), req.user!.id]);
      await audit(c, S, contextOf(req), { entity: 'setting', entityId: String(req.params.key), action: 'updated', reason, before: { value: s.value }, after: { value } });
      await publish(c, S, 'organisation.setting.changed', { key: req.params.key, value });
      return after;
    }));
  });
}
