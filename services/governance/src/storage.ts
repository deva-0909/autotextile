import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { type Pool, badRequest, config, one } from '@erp/platform';

export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

const ALLOWED: Record<string, (b: Buffer) => boolean> = {
  'application/pdf': (b) => b.subarray(0, 5).toString() === '%PDF-',
  'image/png': (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'image/jpeg': (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/webp': (b) => b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP',
  'text/csv': () => true,
  // Office Open XML files are ZIP containers.
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': (b) => b[0] === 0x50 && b[1] === 0x4b,
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': (b) => b[0] === 0x50 && b[1] === 0x4b,
};

export function checkFile(mime: string, body: Buffer) {
  if (!body.length) throw badRequest('The file is empty');
  if (body.length > MAX_UPLOAD_BYTES) throw badRequest('Files must be 20 MB or smaller');
  const check = ALLOWED[mime];
  if (!check) throw badRequest('Allowed types: PDF, PNG, JPEG, WebP, CSV, XLSX, DOCX');
  if (!check(body)) throw badRequest('The file content does not match its type');
}

/** Where file contents live: on disk (default), or in the database (STORAGE_BACKEND=database, for hosts without a lasting disk). */
const inDatabase = () => process.env.STORAGE_BACKEND === 'database';

/** Stores the bytes under a random key (never the user's file name). S3-compatible storage can replace this. */
export async function store(body: Buffer, pool?: Pool) {
  const now = new Date();
  const key = path.posix.join(String(now.getFullYear()), String(now.getMonth() + 1).padStart(2, '0'), randomUUID());
  const sha256 = createHash('sha256').update(body).digest('hex');
  if (inDatabase() && pool) {
    await pool.query('INSERT INTO stored_files (key, body, size) VALUES ($1, $2, $3)', [key, body, body.length]);
    return { key, sha256 };
  }
  const full = path.join(config.storageDir(), key);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, body, { flag: 'wx' });
  return { key, sha256 };
}

export const fullPath = (key: string) => path.join(config.storageDir(), key);

/** The stored bytes for a key, from wherever they were saved (database first, then disk). */
export async function load(key: string, pool: Pool): Promise<Buffer | null> {
  const row = await one<{ body: Buffer }>(pool, 'SELECT body FROM stored_files WHERE key = $1', [key]).catch(() => null);
  if (row) return row.body;
  return fs.readFile(fullPath(key)).catch(() => null);
}
