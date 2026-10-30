import type { Request } from 'express';
import type { Client } from './db.ts';
import { publish } from './bus.ts';

export interface AuditEntry {
  entity: string;
  entityId: string;
  action: string;
  before?: unknown;
  after?: unknown;
  reason?: string | null;
  approvedBy?: string | null;
}

export interface RequestContext {
  userId: string | null;
  userName: string | null;
  sessionId: string | null;
  ip: string | null;
  userAgent: string | null;
}

export function contextOf(req: Request): RequestContext {
  return {
    userId: req.user?.id ?? null,
    userName: req.user?.name ?? null,
    sessionId: req.user?.sessionId ?? null,
    ip: (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0].trim() ?? req.socket.remoteAddress ?? null,
    userAgent: req.headers['user-agent'] ?? null,
  };
}

/** Records an audit event in the same transaction as the change. Governance stores it immutably. */
export async function audit(c: Client, service: string, ctx: RequestContext, entry: AuditEntry) {
  await publish(c, service, 'audit.recorded', { ...entry, service, ...ctx, at: new Date().toISOString() });
}

/** Keeps only the fields that changed, for compact before/after records. */
export function diff(before: Record<string, unknown>, after: Record<string, unknown>) {
  const b: Record<string, unknown> = {};
  const a: Record<string, unknown> = {};
  for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (['updated_at', 'created_at', 'version'].includes(k)) continue;
    if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) {
      b[k] = before[k];
      a[k] = after[k];
    }
  }
  return { before: b, after: a };
}
