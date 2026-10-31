/**
 * Builds the Vercel deployment as a Build Output API v3 tree in .vercel/output:
 *   static/            the web app (apps/web/dist)
 *   functions/api.func one Node function: the gateway and every service, bundled with esbuild
 *   config.json        routes (/api/* to the function, everything else to the single-page app) and the daily cron
 * Vercel runs this as the project's build command (`npm run build:vercel`).
 */
import { build } from 'esbuild';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, '.vercel/output');
const fn = path.join(out, 'functions/api.func');

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(fn, { recursive: true });

// 1. Web app
if (!process.argv.includes('--skip-web')) execSync('npm run build -w apps/web', { cwd: root, stdio: 'inherit' });
fs.cpSync(path.join(root, 'apps/web/dist'), path.join(out, 'static'), { recursive: true });

// 2. API function
await build({
  entryPoints: [path.join(root, 'deploy/serverless.ts')],
  outfile: path.join(fn, 'index.mjs'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: 'linked',
  logLevel: 'info',
  // CommonJS dependencies (pg, express) call require(); give the ESM bundle one.
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  // Optional pg native bindings are never installed.
  external: ['pg-native'],
});
fs.writeFileSync(path.join(fn, 'package.json'), JSON.stringify({ type: 'module' }));
// Files read at run time, relative to APP_ROOT_DIR (the function's own directory).
const runtimeFiles = ['apps/web/src/lib/programme.json'];
for (const f of runtimeFiles) {
  fs.mkdirSync(path.dirname(path.join(fn, f)), { recursive: true });
  fs.copyFileSync(path.join(root, f), path.join(fn, f));
}
fs.writeFileSync(path.join(fn, '.vc-config.json'), JSON.stringify({
  runtime: 'nodejs22.x',
  handler: 'index.mjs',
  launcherType: 'Nodejs',
  shouldAddHelpers: false,
  supportsResponseStreaming: true,
  maxDuration: 60,
  memory: 1024,
  environment: { APP_ROOT_DIR: '/var/task', STORAGE_DIR: '/tmp/storage', NODE_OPTIONS: '--enable-source-maps' },
}, null, 2));

// 3. Routing and cron
fs.writeFileSync(path.join(out, 'config.json'), JSON.stringify({
  version: 3,
  routes: [
    { src: '^/assets/(.*)$', headers: { 'cache-control': 'public, max-age=31536000, immutable' }, continue: true },
    { handle: 'filesystem' },
    { src: '^/api/(.*)$', dest: '/api?__path=$1' },
    { src: '^/(.*)$', dest: '/index.html' },
  ],
  crons: [{ path: '/api/_cron', schedule: '30 2 * * *' }],
}, null, 2));

const size = (fs.statSync(path.join(fn, 'index.mjs')).size / 1024 / 1024).toFixed(1);
console.log(`\n✓ .vercel/output ready (function bundle ${size} MB)`);
