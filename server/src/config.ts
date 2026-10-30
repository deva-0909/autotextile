import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export const PORT = Number(process.env.PORT ?? 4000);
export const DB_FILE = process.env.DB_FILE ?? path.resolve(here, '../data/textile.db');
export const CLIENT_DIST = path.resolve(here, '../../client/dist');
/** How often the automation engine re-checks schedules, stock and due dates. */
export const AUTOMATION_INTERVAL_MS = Number(process.env.AUTOMATION_INTERVAL_MS ?? 15_000);
