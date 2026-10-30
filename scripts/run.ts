/** Starts every service and the gateway with prefixed, coloured logs. `--watch` restarts a service when its code changes. */
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT_DIR, config } from '@erp/platform';

const watch = process.argv.includes('--watch');
const PROCS: [string, string, number][] = [
  ['identity', 'services/identity/src/main.ts', 36],
  ['organisation', 'services/organisation/src/main.ts', 32],
  ['masters', 'services/masters/src/main.ts', 35],
  ['governance', 'services/governance/src/main.ts', 33],
  ['procurement', 'services/procurement/src/main.ts', 92],
  ['jobwork', 'services/jobwork/src/main.ts', 95],
  ['inventory', 'services/inventory/src/main.ts', 96],
  ['crm', 'services/crm/src/main.ts', 91],
  ['gateway', 'services/gateway/src/main.ts', 34],
];

if (!fs.existsSync(path.join(ROOT_DIR, '.env'))) {
  console.log('No .env file found — using defaults. Copy .env.example to .env to configure your database password.');
}
if (!fs.existsSync(path.join(ROOT_DIR, 'apps/web/dist/index.html'))) {
  console.log('The web app is not built yet. Run `npm run build` (or use `npm run dev:web`).');
}

const children: ChildProcess[] = [];
let stopping = false;
const width = Math.max(...PROCS.map(([n]) => n.length));

for (const [name, entry, colour] of PROCS) {
  const args = [...(watch ? ['--watch'] : []), '--no-warnings=ExperimentalWarning', entry];
  const child = spawn(process.execPath, args, { cwd: ROOT_DIR, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  const tag = `\x1b[${colour}m${name.padEnd(width)}\x1b[0m │ `;
  const pipe = (stream: NodeJS.ReadableStream, out: NodeJS.WriteStream) => {
    let buf = '';
    stream.on('data', (d) => {
      buf += d;
      const lines = buf.split('\n');
      buf = lines.pop()!;
      for (const l of lines) out.write(tag + l + '\n');
    });
  };
  pipe(child.stdout!, process.stdout);
  pipe(child.stderr!, process.stderr);
  child.on('exit', (code) => {
    if (!stopping) console.log(`${tag}\x1b[31mexited with code ${code}\x1b[0m`);
  });
  children.push(child);
}

console.log(`\nStarting ${PROCS.length} processes. Open http://localhost:${config.port('gateway')} when the gateway is listening. Ctrl+C stops everything.\n`);

const stop = () => {
  stopping = true;
  for (const c of children) c.kill();
  setTimeout(() => process.exit(0), 500);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
