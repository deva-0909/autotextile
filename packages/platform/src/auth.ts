import type { NextFunction, Request, Response } from 'express';
import { SignJWT, jwtVerify } from 'jose';
import { config } from './config.ts';
import { forbidden, unauthorized } from './errors.ts';

/** '*' means unrestricted; otherwise the list of ids the user may see. */
export type ScopeList = '*' | string[];
export interface DataScope {
  entity: ScopeList;
  gstin: ScopeList;
  branch: ScopeList;
  warehouse: ScopeList;
}

export interface AuthUser {
  id: string;
  name: string;
  email: string;
  roles: string[];
  permissions: string[];
  scope: DataScope;
  sessionId?: string;
  /** Set for supplier/mill portal users: the business partner they act for. */
  partyId?: string | null;
}

export const FULL_SCOPE: DataScope = { entity: '*', gstin: '*', branch: '*', warehouse: '*' };

declare module 'express-serve-static-core' {
  interface Request {
    user?: AuthUser;
  }
}

const secret = () => new TextEncoder().encode(config.jwtSecret());
const ISSUER = 'textile-erp';

export async function signAccessToken(user: AuthUser, ttl = '15m'): Promise<string> {
  return new SignJWT({ name: user.name, email: user.email, roles: user.roles, perms: user.permissions, scp: user.scope, sid: user.sessionId, pid: user.partyId ?? null })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(user.id)
    .setIssuer(ISSUER)
    .setIssuedAt()
    .setExpirationTime(ttl)
    .sign(secret());
}

export async function verifyAccessToken(token: string): Promise<AuthUser> {
  const { payload } = await jwtVerify(token, secret(), { issuer: ISSUER });
  return {
    id: String(payload.sub),
    name: String(payload.name ?? ''),
    email: String(payload.email ?? ''),
    roles: (payload.roles as string[]) ?? [],
    permissions: (payload.perms as string[]) ?? [],
    scope: (payload.scp as DataScope) ?? { entity: [], gstin: [], branch: [], warehouse: [] },
    sessionId: payload.sid as string | undefined,
    partyId: (payload.pid as string | null | undefined) ?? null,
  };
}

/** Token used for service-to-service calls. */
export function serviceUser(service: string): AuthUser {
  return { id: `svc:${service}`, name: service, email: '', roles: ['service'], permissions: ['*'], scope: FULL_SCOPE };
}

export function hasPermission(user: AuthUser | undefined, code: string): boolean {
  return !!user && (user.permissions.includes('*') || user.permissions.includes(code));
}

/** Express middleware: requires a valid bearer token. */
export async function authenticate(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return next(unauthorized());
  try {
    req.user = await verifyAccessToken(header.slice(7));
    next();
  } catch {
    next(unauthorized('Session expired or invalid'));
  }
}

/** Express middleware: requires at least one of the permission codes. */
export function requirePermission(...codes: string[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (codes.some((c) => hasPermission(req.user, c))) next();
    else next(forbidden());
  };
}

export function assertPermission(user: AuthUser | undefined, code: string) {
  if (!hasPermission(user, code)) throw forbidden();
}

/** True when the user's scope of `kind` includes `id` (or is unrestricted). */
export function inScope(user: AuthUser, kind: keyof DataScope, id: string | null | undefined): boolean {
  const s = user.scope[kind];
  return s === '*' || (!!id && s.includes(id));
}

/**
 * SQL fragment restricting `column` to the user's scope.
 * Returns '' for unrestricted users and pushes the id list onto params otherwise.
 */
export function scopeClause(user: AuthUser, kind: keyof DataScope, column: string, params: unknown[]): string {
  const s = user.scope[kind];
  if (s === '*') return '';
  params.push(s);
  return `${column} = ANY($${params.length}::uuid[])`;
}
