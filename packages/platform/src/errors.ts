import type { ZodError } from 'zod';

export class AppError extends Error {
  status: number;
  code: string;
  details?: unknown;
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (message: string, details?: unknown) => new AppError(400, 'bad_request', message, details);
export const unauthorized = (message = 'Authentication required') => new AppError(401, 'unauthorized', message);
export const forbidden = (message = 'You do not have permission for this action') => new AppError(403, 'forbidden', message);
export const notFound = (what: string) => new AppError(404, 'not_found', `${what} not found`);
export const conflict = (message: string) => new AppError(409, 'conflict', message);

export function fromZod(err: ZodError) {
  const fields: Record<string, string> = {};
  for (const issue of err.issues) fields[issue.path.join('.') || '_'] ??= issue.message;
  return new AppError(422, 'validation_failed', 'Some fields need attention', { fields });
}

/** Maps Postgres constraint errors to user-facing messages. */
export function fromPg(err: { code?: string; constraint?: string; detail?: string }): AppError | null {
  if (err.code === '23505') return conflict(`Already exists${err.detail ? `: ${err.detail.replace(/^Key /, '')}` : ''}`);
  if (err.code === '23503') return conflict('This record is referenced by, or refers to, another record');
  if (err.code === '23514') return badRequest(`Value violates rule ${err.constraint ?? ''}`.trim());
  return null;
}
