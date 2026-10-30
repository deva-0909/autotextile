import fs from 'node:fs';
import path from 'node:path';
import { openDb } from './db.ts';
import { createApp } from './app.ts';
import { runChecks } from './automation.ts';
import { seed } from './seed.ts';
import { AUTOMATION_INTERVAL_MS, CLIENT_DIST, DB_FILE, PORT } from './config.ts';

fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
const db = openDb(DB_FILE);
const { n } = db.prepare('SELECT COUNT(*) AS n FROM machines').get() as { n: number };
if (n === 0) {
  console.log('Empty database — loading demo data');
  seed(db);
}

setInterval(() => {
  try {
    runChecks(db);
  } catch (err) {
    console.error('Automation check failed', err);
  }
}, AUTOMATION_INTERVAL_MS).unref();

createApp(db, { staticDir: CLIENT_DIST }).listen(PORT, () => {
  console.log(`Textile automation API on http://localhost:${PORT}  (db: ${DB_FILE})`);
});
