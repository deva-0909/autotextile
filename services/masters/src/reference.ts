import type { Router } from 'express';
import { z, type ZodObject } from 'zod';
import { type ServiceContext, insertAudited, many, optText, parse, reqText, requirePermission, tx, updateAudited } from '@erp/platform';

const S = 'masters';
const status = z.enum(['active', 'inactive']).default('active');
const version = z.number().int().optional();

/** Simple reference tables share one CRUD shape. */
const TABLES: { path: string; table: string; entity: string; order: string; schema: ZodObject }[] = [
  { path: 'uoms', table: 'uoms', entity: 'uom', order: 'code', schema: z.object({ code: z.string().trim().toUpperCase().regex(/^[A-Z]{1,8}$/), name: reqText(40), category: z.enum(['weight', 'length', 'count', 'area']), decimals: z.number().int().min(0).max(6), status, version }) },
  { path: 'hsn-codes', table: 'hsn_codes', entity: 'hsn_code', order: 'code', schema: z.object({ code: z.string().trim().regex(/^[0-9]{4,8}$/, '4–8 digits'), description: reqText(300), kind: z.enum(['goods', 'service']), gst_rate: z.number().min(0).max(28), cess_rate: z.number().min(0).default(0), effective_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), ca_verified: z.boolean().default(false), status, version }) },
  { path: 'payment-terms', table: 'payment_terms', entity: 'payment_term', order: 'credit_days, name', schema: z.object({ code: z.string().trim().toUpperCase().regex(/^[A-Z0-9_-]{2,12}$/), name: reqText(80), credit_days: z.number().int().min(0).max(365), advance_percent: z.number().min(0).max(100), description: optText(300), status, version }) },
  { path: 'reason-codes', table: 'reason_codes', entity: 'reason_code', order: 'category, code', schema: z.object({ category: z.string().trim().regex(/^[a-z_]{3,40}$/), code: z.string().trim().toUpperCase().regex(/^[A-Z0-9_]{2,24}$/), description: reqText(200), status, version }) },
  { path: 'document-types', table: 'document_types', entity: 'document_type', order: 'name', schema: z.object({ code: z.string().trim().toUpperCase().regex(/^[A-Z0-9_]{2,24}$/), name: reqText(80), applies_to: z.array(z.string()).default([]), retention_years: z.number().int().min(0).max(30), requires_expiry: z.boolean().default(false), status, version }) },
];

export function referenceRoutes(r: Router, { pool }: ServiceContext) {
  for (const t of TABLES) {
    r.get(`/${t.path}`, requirePermission('masters.reference.read', 'masters.product.read', 'masters.party.read'), async (_req, res) => {
      res.json(await many(pool, `SELECT * FROM ${t.table} ORDER BY ${t.order}`));
    });
    r.post(`/${t.path}`, requirePermission('masters.reference.manage'), async (req, res) => {
      const { version: _v, ...data } = parse(t.schema, req.body) as Record<string, unknown>;
      res.status(201).json(await tx(pool, (c) => insertAudited(c, req, S, t.table, t.entity, data)));
    });
    r.patch(`/${t.path}/:id`, requirePermission('masters.reference.manage'), async (req, res) => {
      const { version, ...data } = parse(t.schema, req.body) as Record<string, unknown>;
      res.json(await tx(pool, (c) => updateAudited(c, req, S, t.table, t.entity, String(req.params.id), data, { version: version as number | undefined })));
    });
  }
}
