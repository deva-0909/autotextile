import type { Router } from 'express';
import { z } from 'zod';
import {
  type Client, type ServiceContext, audit, badRequest, contextOf, insertAudited, listQuery, many, notFound, one, optText, orderLimit, page, parse, reqText,
  requirePermission, tx, updateAudited,
} from '@erp/platform';

const S = 'masters';
const status = z.enum(['active', 'inactive']).default('active');
const version = z.number().int().optional();

interface AttrDef {
  key: string; label: string; data_type: string; options: string[] | null; min_value: number | null; max_value: number | null; required: boolean; level: string;
}

/** Product-level attribute definitions that apply to a category (global ones plus the category's own). */
export async function definitionsFor(c: Client | ServiceContext['pool'], categoryId: string) {
  return many<AttrDef>(c, `
    SELECT * FROM attribute_definitions
    WHERE status = 'active' AND level = 'product' AND (category_id IS NULL OR category_id = $1)
    ORDER BY sort_order, label`, [categoryId]);
}

/** Validates attribute values against the dictionary; returns cleaned values or field errors. */
export function validateAttributes(defs: AttrDef[], input: Record<string, unknown>) {
  const errors: Record<string, string> = {};
  const out: Record<string, unknown> = {};
  for (const d of defs) {
    const v = input[d.key];
    const empty = v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);
    if (empty) {
      if (d.required) errors[`attributes.${d.key}`] = `${d.label} is required`;
      continue;
    }
    if (d.data_type === 'number') {
      const n = Number(v);
      if (!Number.isFinite(n)) errors[`attributes.${d.key}`] = `${d.label} must be a number`;
      else if (d.min_value !== null && n < d.min_value) errors[`attributes.${d.key}`] = `${d.label} must be at least ${d.min_value}`;
      else if (d.max_value !== null && n > d.max_value) errors[`attributes.${d.key}`] = `${d.label} must be at most ${d.max_value}`;
      else out[d.key] = n;
    } else if (d.data_type === 'select') {
      if (!d.options?.includes(String(v))) errors[`attributes.${d.key}`] = `Choose a valid ${d.label.toLowerCase()}`;
      else out[d.key] = String(v);
    } else if (d.data_type === 'multiselect') {
      const arr = Array.isArray(v) ? v.map(String) : [String(v)];
      if (arr.some((x) => !d.options?.includes(x))) errors[`attributes.${d.key}`] = `Choose valid ${d.label.toLowerCase()} options`;
      else out[d.key] = arr;
    } else if (d.data_type === 'boolean') out[d.key] = Boolean(v);
    else out[d.key] = String(v).trim();
  }
  const unknown = Object.keys(input).filter((k) => !defs.some((d) => d.key === k));
  for (const k of unknown) errors[`attributes.${k}`] = `Attribute ${k} is not defined for this category`;
  return { values: out, errors };
}

const categoryBody = z.object({ code: z.string().trim().toUpperCase().regex(/^[A-Z0-9-]{2,12}$/), name: reqText(80), hsn_code: optText(8), description: optText(500), status, version });

const definitionBody = z.object({
  category_id: z.uuid().nullable().optional(),
  key: z.string().trim().regex(/^[a-z][a-z0-9_]{1,40}$/, 'lowercase_with_underscores'),
  label: reqText(80),
  data_type: z.enum(['text', 'number', 'select', 'multiselect', 'boolean']),
  unit: optText(20),
  options: z.array(z.string().trim().min(1)).nullable().optional(),
  min_value: z.number().nullable().optional(),
  max_value: z.number().nullable().optional(),
  required: z.boolean().default(false),
  level: z.enum(['product', 'lot', 'roll']).default('product'),
  group_name: z.string().trim().min(1).max(40).default('Specification'),
  sort_order: z.number().int().default(100),
  status,
  version,
});

const productBody = z.object({
  sku: z.string().trim().toUpperCase().regex(/^[A-Z0-9][A-Z0-9-]{2,40}$/, 'Letters, digits and -'),
  name: reqText(160),
  category_id: z.uuid(),
  hsn_code: z.string().trim(),
  uom_code: z.string().default('KG'),
  attributes: z.record(z.string(), z.unknown()).default({}),
  min_order_qty: z.number().positive().nullable().optional(),
  description: optText(2000),
  status: z.enum(['active', 'inactive', 'discontinued']).default('active'),
  version,
});

export function catalogRoutes(r: Router, { pool }: ServiceContext) {
  r.get('/fabric-categories', requirePermission('masters.product.read'), async (_req, res) => {
    res.json(await many(pool, `
      SELECT c.*, (SELECT count(*)::int FROM products p WHERE p.category_id = c.id) AS product_count
      FROM fabric_categories c ORDER BY c.name`));
  });
  r.post('/fabric-categories', requirePermission('masters.product.manage'), async (req, res) => {
    const { version: _v, ...data } = parse(categoryBody, req.body);
    res.status(201).json(await tx(pool, (c) => insertAudited(c, req, S, 'fabric_categories', 'fabric_category', data)));
  });
  r.patch('/fabric-categories/:id', requirePermission('masters.product.manage'), async (req, res) => {
    const { version, ...data } = parse(categoryBody, req.body);
    res.json(await tx(pool, (c) => updateAudited(c, req, S, 'fabric_categories', 'fabric_category', String(req.params.id), data, { version })));
  });

  r.get('/attribute-definitions', requirePermission('masters.product.read'), async (req, res) => {
    const params: unknown[] = [];
    let where = '';
    if (req.query.categoryId) {
      params.push(req.query.categoryId);
      where = `WHERE (d.category_id IS NULL OR d.category_id = $1)`;
    }
    res.json(await many(pool, `
      SELECT d.*, c.name AS category_name FROM attribute_definitions d LEFT JOIN fabric_categories c ON c.id = d.category_id
      ${where} ORDER BY d.level, d.sort_order, d.label`, params));
  });

  function checkDefinition(body: z.infer<typeof definitionBody>) {
    if (['select', 'multiselect'].includes(body.data_type) && !body.options?.length) throw badRequest('Add at least one option', { fields: { options: 'Required for select attributes' } });
    if (body.min_value != null && body.max_value != null && body.min_value > body.max_value) throw badRequest('Minimum is greater than maximum', { fields: { max_value: 'Must be ≥ minimum' } });
  }

  r.post('/attribute-definitions', requirePermission('masters.product.manage'), async (req, res) => {
    const body = parse(definitionBody, req.body);
    checkDefinition(body);
    const { version: _v, ...data } = body;
    res.status(201).json(await tx(pool, (c) => insertAudited(c, req, S, 'attribute_definitions', 'attribute_definition', { ...data, category_id: data.category_id ?? null, options: data.options ? JSON.stringify(data.options) : null })));
  });
  r.patch('/attribute-definitions/:id', requirePermission('masters.product.manage'), async (req, res) => {
    const body = parse(definitionBody, req.body);
    checkDefinition(body);
    const { version, key: _k, category_id: _c, ...data } = body;
    res.json(await tx(pool, (c) => updateAudited(c, req, S, 'attribute_definitions', 'attribute_definition', String(req.params.id), { ...data, options: data.options ? JSON.stringify(data.options) : null }, { version })));
  });

  r.get('/products', requirePermission('masters.product.read'), async (req, res) => {
    const lq = listQuery(req, ['sku', 'name', 'status', 'updated_at'], 'sku');
    const params: unknown[] = [];
    const where: string[] = [];
    if (lq.q) { params.push(`%${lq.q}%`); where.push(`(p.sku ILIKE $${params.length} OR p.name ILIKE $${params.length} OR p.attributes::text ILIKE $${params.length})`); }
    if (lq.filters.category) { params.push(lq.filters.category); where.push(`p.category_id = $${params.length}`); }
    if (lq.filters.status) { params.push(lq.filters.status); where.push(`p.status = $${params.length}`); }
    const rows = await many<{ total_count: number }>(pool, `
      SELECT p.*, c.name AS category_name, h.gst_rate, count(*) OVER ()::int AS total_count
      FROM products p JOIN fabric_categories c ON c.id = p.category_id JOIN hsn_codes h ON h.code = p.hsn_code
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ${orderLimit(lq, params).replace('ORDER BY ', 'ORDER BY p.')}`, params);
    res.json(page(rows, lq));
  });

  r.get('/products/:id', requirePermission('masters.product.read'), async (req, res) => {
    const p = await one<{ category_id: string }>(pool, `
      SELECT p.*, c.name AS category_name, h.gst_rate, h.description AS hsn_description
      FROM products p JOIN fabric_categories c ON c.id = p.category_id JOIN hsn_codes h ON h.code = p.hsn_code WHERE p.id = $1`, [req.params.id]);
    if (!p) throw notFound('Product');
    res.json({ ...p, definitions: await definitionsFor(pool, p.category_id) });
  });

  async function saveProduct(c: Client, body: z.infer<typeof productBody>) {
    const hsn = await one(c, `SELECT 1 FROM hsn_codes WHERE code = $1 AND status = 'active'`, [body.hsn_code]);
    if (!hsn) throw badRequest('Unknown HSN code', { fields: { hsn_code: 'Choose an active HSN code' } });
    const { values, errors } = validateAttributes(await definitionsFor(c, body.category_id), body.attributes);
    if (Object.keys(errors).length) throw badRequest('Some specification values need attention', { fields: errors });
    const { version: _v, ...data } = body;
    return { ...data, attributes: JSON.stringify(values) };
  }

  r.post('/products', requirePermission('masters.product.manage'), async (req, res) => {
    const body = parse(productBody, req.body);
    res.status(201).json(await tx(pool, async (c) => insertAudited(c, req, S, 'products', 'product', await saveProduct(c, body))));
  });
  r.patch('/products/:id', requirePermission('masters.product.manage'), async (req, res) => {
    const body = parse(productBody, req.body);
    res.json(await tx(pool, async (c) => updateAudited(c, req, S, 'products', 'product', String(req.params.id), await saveProduct(c, body), { version: body.version })));
  });

  // ---------- price lists ----------
  r.get('/price-lists', requirePermission('masters.product.read'), async (_req, res) => {
    res.json(await many(pool, `SELECT pl.*, (SELECT count(*)::int FROM price_list_items i WHERE i.price_list_id = pl.id) AS item_count FROM price_lists pl ORDER BY valid_from DESC`));
  });
  r.get('/price-lists/:id', requirePermission('masters.product.read'), async (req, res) => {
    const pl = await one<Record<string, unknown>>(pool, 'SELECT * FROM price_lists WHERE id = $1', [req.params.id]);
    if (!pl) throw notFound('Price list');
    const items = await many(pool, `SELECT i.*, p.sku, p.name FROM price_list_items i JOIN products p ON p.id = i.product_id WHERE i.price_list_id = $1 ORDER BY p.sku, i.min_qty`, [req.params.id]);
    res.json({ ...pl, items });
  });
  const priceListBody = z.object({
    code: z.string().trim().toUpperCase().regex(/^[A-Z0-9-]{2,20}$/), name: reqText(80),
    valid_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), valid_to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(), status, version,
  });
  r.post('/price-lists', requirePermission('masters.product.manage'), async (req, res) => {
    const { version: _v, ...data } = parse(priceListBody, req.body);
    res.status(201).json(await tx(pool, (c) => insertAudited(c, req, S, 'price_lists', 'price_list', data)));
  });
  r.put('/price-lists/:id/items', requirePermission('masters.product.manage'), async (req, res) => {
    const { items } = parse(z.object({ items: z.array(z.object({ product_id: z.uuid(), rate_per_uom: z.number().positive(), min_qty: z.number().nonnegative().default(0) })) }), req.body);
    await tx(pool, async (c) => {
      const before = await many(c, 'SELECT product_id, rate_per_uom, min_qty FROM price_list_items WHERE price_list_id = $1', [req.params.id]);
      await c.query('DELETE FROM price_list_items WHERE price_list_id = $1', [req.params.id]);
      for (const i of items) await c.query('INSERT INTO price_list_items (price_list_id, product_id, rate_per_uom, min_qty) VALUES ($1, $2, $3, $4)', [req.params.id, i.product_id, i.rate_per_uom, i.min_qty]);
      await audit(c, S, contextOf(req), { entity: 'price_list', entityId: String(req.params.id), action: 'items_replaced', before: { items: before }, after: { items } });
    });
    res.json({ ok: true });
  });
}
