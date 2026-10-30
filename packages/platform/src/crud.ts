import type { Request } from 'express';
import type { Client } from './db.ts';
import { audit, contextOf, diff } from './audit.ts';
import { publish } from './bus.ts';
import { AppError, notFound } from './errors.ts';

type Row = Record<string, unknown>;

/** INSERT ... RETURNING *, plus audit + change event, inside the caller's transaction. */
export async function insertAudited(c: Client, req: Request, service: string, table: string, entity: string, data: Row): Promise<Row> {
  const cols = Object.keys(data);
  const r = await c.query(
    `INSERT INTO ${table} (${cols.join(', ')}, created_by) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}, $${cols.length + 1}) RETURNING *`,
    [...cols.map((k) => data[k]), req.user?.id ?? null],
  );
  const row = r.rows[0] as Row;
  await audit(c, service, contextOf(req), { entity, entityId: String(row.id), action: 'created', after: data });
  await publish(c, service, `${service}.${entity}.changed`, { id: row.id, action: 'created' });
  return row;
}

/** Optimistic-locked UPDATE: fails if `version` changed since the client loaded the record. */
export async function updateAudited(
  c: Client, req: Request, service: string, table: string, entity: string, id: string, data: Row,
  opts: { version?: number; reason?: string | null; action?: string } = {},
): Promise<Row> {
  const before = (await c.query(`SELECT * FROM ${table} WHERE id = $1 FOR UPDATE`, [id])).rows[0] as Row | undefined;
  if (!before) throw notFound(entity.replace(/_/g, ' ').replace(/^./, (s) => s.toUpperCase()));
  if (opts.version !== undefined && before.version !== opts.version) {
    throw new AppError(409, 'stale', 'Someone else changed this record. Reload to see the latest version.');
  }
  const cols = Object.keys(data);
  const r = await c.query(
    `UPDATE ${table} SET ${cols.map((k, i) => `${k} = $${i + 2}`).join(', ')}, version = version + 1, updated_at = now(), updated_by = $${cols.length + 2}
     WHERE id = $1 RETURNING *`,
    [id, ...cols.map((k) => data[k]), req.user?.id ?? null],
  );
  const after = r.rows[0] as Row;
  const d = diff(before, after);
  if (Object.keys(d.after).filter((k) => k !== 'updated_by').length) {
    await audit(c, service, contextOf(req), { entity, entityId: id, action: opts.action ?? 'updated', reason: opts.reason, ...d });
    await publish(c, service, `${service}.${entity}.changed`, { id, action: 'updated' });
  }
  return after;
}

/** Standard audit columns appended to every master table. */
export const AUDIT_COLUMNS = `
  version int NOT NULL DEFAULT 1,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now()`;
