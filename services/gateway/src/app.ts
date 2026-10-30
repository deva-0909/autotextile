import express, { type Request, type Response } from 'express';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { config, ROOT_DIR, SERVICES, type ServiceName } from '@erp/platform';

const WEB_DIST = path.join(ROOT_DIR, 'apps/web/dist');

/** Simple fixed-window limiter for credential endpoints (per IP). */
function rateLimit(limit: number, windowMs: number) {
  const hits = new Map<string, { n: number; reset: number }>();
  return (req: Request, res: Response, next: () => void) => {
    const key = req.ip ?? 'unknown';
    const now = Date.now();
    const h = hits.get(key);
    if (!h || h.reset < now) hits.set(key, { n: 1, reset: now + windowMs });
    else if (++h.n > limit) {
      res.setHeader('Retry-After', Math.ceil((h.reset - now) / 1000));
      return void res.status(429).json({ error: { code: 'rate_limited', message: 'Too many attempts. Try again shortly.' } });
    }
    next();
  };
}

function proxy(service: ServiceName, port: number) {
  return (req: Request, res: Response) => {
    const upstream = http.request(
      {
        host: '127.0.0.1',
        port,
        method: req.method,
        path: req.url, // already stripped of /api/<service>
        headers: { ...req.headers, host: `127.0.0.1:${port}`, 'x-forwarded-for': req.ip ?? '' },
      },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      },
    );
    upstream.on('error', () => {
      if (!res.headersSent)
        res.status(503).json({ error: { code: 'service_unavailable', message: `The ${service} service is not reachable. Is it running?` } });
    });
    req.pipe(upstream);
  };
}

export function createGateway(
  ports: Record<ServiceName, number> = Object.fromEntries(SERVICES.map((s) => [s, config.port(s)])) as Record<ServiceName, number>,
  opts: { loginAttemptsPerMinute?: number } = {},
) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback');
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin');
    next();
  });

  app.get('/api/health', async (_req, res) => {
    const checks = await Promise.all(
      SERVICES.map(async (s) => {
        try {
          const r = await fetch(`http://127.0.0.1:${ports[s]}/health`, { signal: AbortSignal.timeout(2000) });
          return [s, r.ok ? 'ok' : 'down'] as const;
        } catch {
          return [s, 'down'] as const;
        }
      }),
    );
    const services = Object.fromEntries(checks);
    res.status(checks.every(([, v]) => v === 'ok') ? 200 : 503).json({ gateway: 'ok', services });
  });

  app.use(['/api/identity/auth/login', '/api/identity/auth/mfa', '/api/identity/auth/password-reset'], rateLimit(opts.loginAttemptsPerMinute ?? Number(process.env.LOGIN_RATE_LIMIT ?? 20), 60_000));
  for (const s of SERVICES) app.use(`/api/${s}`, proxy(s, ports[s]));
  app.use('/api', (_req, res) => {
    res.status(404).json({ error: { code: 'not_found', message: 'Unknown API route' } });
  });

  if (fs.existsSync(WEB_DIST)) {
    app.use(express.static(WEB_DIST, { index: false, maxAge: '1h' }));
    app.get(/.*/, (_req, res) => res.sendFile(path.join(WEB_DIST, 'index.html')));
  }
  return app;
}
