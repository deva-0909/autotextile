/**
 * Load test for UAT (performance): signs in as several demo users and hammers the busiest read screens
 * concurrently through the gateway, then reports throughput and p50/p95/p99 latency per endpoint.
 *   npm run load-test -- --seconds 30 --concurrency 20
 */
const BASE = process.env.LOAD_BASE_URL ?? 'http://localhost:4000/api';
const arg = (k: string, d: number) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? Number(process.argv[i + 1]) : d; };
const seconds = arg('seconds', 20), concurrency = arg('concurrency', 10);
const ENDPOINTS: [string, string][] = [
  ['accounts@textile.local', '/finance/dashboard'], ['accounts@textile.local', '/finance/vouchers'], ['surat.stores@textile.local', '/inventory/lots?pageSize=50'],
  ['surat.stores@textile.local', '/inventory/dashboard'], ['salesmgr@textile.local', '/crm/leads?pageSize=50'], ['salesmgr@textile.local', '/crm/dashboard'],
  ['dispatch@textile.local', '/fulfilment/dashboard'], ['buyer@srimurugan.example', '/commerce/catalogue'], ['owner@textile.local', '/insights/control-tower'],
];
const tokens = new Map<string, string>();
for (const email of new Set(ENDPOINTS.map((e) => e[0]))) {
  const r = await fetch(`${BASE}/identity/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: process.env.LOAD_PASSWORD ?? 'Textile@2026' }) });
  if (!r.ok) throw new Error(`Login failed for ${email}: ${r.status}`);
  tokens.set(email, ((await r.json()) as { accessToken: string }).accessToken);
}
const lat = new Map<string, number[]>();
let errors = 0;
const until = Date.now() + seconds * 1000;
await Promise.all(Array.from({ length: concurrency }, async (_, w) => {
  let i = w;
  while (Date.now() < until) {
    const [email, path] = ENDPOINTS[i++ % ENDPOINTS.length]!;
    const t0 = performance.now();
    const r = await fetch(`${BASE}${path}`, { headers: { authorization: `Bearer ${tokens.get(email)}` } }).catch(() => null);
    await r?.arrayBuffer();
    if (!r || !r.ok) errors++;
    (lat.get(path) ?? lat.set(path, []).get(path)!).push(performance.now() - t0);
  }
}));
const pct = (a: number[], p: number) => a.sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor((p / 100) * a.length))]!.toFixed(0);
const total = [...lat.values()].reduce((s, a) => s + a.length, 0);
console.log(`\n${total} requests in ${seconds}s with ${concurrency} concurrent users → ${(total / seconds).toFixed(1)} req/s, ${errors} errors\n`);
console.table([...lat.entries()].map(([path, a]) => ({ endpoint: path, requests: a.length, p50_ms: pct(a, 50), p95_ms: pct(a, 95), p99_ms: pct(a, 99) })));
process.exit(errors ? 1 : 0);
