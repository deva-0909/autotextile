/**
 * Nightly backup for Windows Task Scheduler or cron:  npm run backup
 * Takes a pg_dump of the whole database, records its checksum and row counts (visible on System health),
 * optionally runs a restore test (--verify), and deletes dump files older than BACKUP_KEEP_DAYS (default 30).
 */
import fs from 'node:fs';
import path from 'node:path';
import { createPool } from '@erp/platform';
import { backupDir, restoreTest, runBackup } from '../services/insights/src/system.ts';

const pool = createPool('insights');
const b = await runBackup(pool, 'scheduled backup') as { id: string; status: string; file_name: string; error: string | null };
console.log(b.status === 'completed' ? `✔ Backup ${b.file_name}` : `✖ Backup failed: ${b.error}`);
if (b.status === 'completed' && process.argv.includes('--verify')) {
  const r = await restoreTest(pool, b.id) as { restore_status: string; restore_detail: unknown };
  console.log(r.restore_status === 'passed' ? '✔ Restore test passed' : `✖ Restore test failed: ${JSON.stringify(r.restore_detail)}`);
}
const keep = Number(process.env.BACKUP_KEEP_DAYS ?? 30);
for (const f of fs.readdirSync(backupDir()).filter((x) => x.endsWith('.dump'))) {
  const full = path.join(backupDir(), f);
  if (Date.now() - fs.statSync(full).mtimeMs > keep * 86_400_000) { fs.unlinkSync(full); console.log(`  removed old ${f}`); }
}
await pool.end();
process.exit(b.status === 'completed' ? 0 : 1);
