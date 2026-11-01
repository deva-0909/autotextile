import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createPool, type Pool } from './db.ts';
import { migrate } from './migrate.ts';
import { ensureBus, subscribe, type Consumer, type Handler } from './bus.ts';
import { AppError, fromPg } from './errors.ts';
import { authenticate } from './auth.ts';
import { ROOT_DIR, type ServiceName } from './config.ts';

export interface ServiceContext {
  name: ServiceName;
  pool: Pool;
}

export interface ServiceDefinition {
  name: ServiceName;
  /** Directory holding NNN_name.sql migrations for this service's schema. */
  migrationsDir: string;
  /** Routes that do not need a token (login, health). */
  publicRoutes?: (router: express.Router, ctx: ServiceContext) => void;
  routes: (router: express.Router, ctx: ServiceContext) => void;
  /** Event handlers by event type, consumed from the bus. */
  consumers?: (ctx: ServiceContext) => Record<string, Handler>;
}

export interface RunningService {
  app: Express;
  ctx: ServiceContext;
  consumer?: Consumer;
  close(): Promise<void>;
}

/** Builds and initialises a service (schema migrations, event consumers). Call `listen` on `app` to serve. */
export async function bootService(def: ServiceDefinition, opts: { databaseUrl?: string; pollMs?: number; serverless?: boolean; manualBus?: boolean } = {}): Promise<RunningService> {
  const pool = createPool(def.name, opts.databaseUrl);
  // Serverless instances start often and sit behind a transaction pooler: the schema is migrated once by setup
  // (which uses session locks), and events are drained explicitly instead of by a timer and LISTEN.
  if (!opts.serverless) {
    await ensureBus(pool);
    // Bundled (APP_ROOT_DIR set), a module's own location no longer points at its migrations; they are shipped as
    // services/<name>/migrations under the root instead.
    await migrate(pool, def.name, process.env.APP_ROOT_DIR ? path.join(ROOT_DIR, 'services', def.name, 'migrations') : def.migrationsDir);
  }
  const ctx: ServiceContext = { name: def.name, pool };

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback');
  // Keep the raw bytes too: signed webhooks are verified against exactly what was sent.
  app.use(express.json({ limit: '2mb', verify: (req, _res, buf) => { (req as Request & { rawBody?: string }).rawBody = buf.toString('utf8'); } }));
  app.use((req, res, next) => {
    res.setHeader('x-request-id', (req.headers['x-request-id'] as string) ?? randomUUID());
    next();
  });
  app.get('/health', async (_req, res) => {
    await pool.query('SELECT 1');
    res.json({ service: def.name, status: 'ok' });
  });

  const pub = express.Router();
  def.publicRoutes?.(pub, ctx);
  app.use(pub);

  const priv = express.Router();
  priv.use(authenticate);
  def.routes(priv, ctx);
  app.use(priv);

  app.use((_req, res) => {
    res.status(404).json({ error: { code: 'not_found', message: 'Route not found' } });
  });
  app.use((err: Error & { type?: string }, _req: Request, res: Response, _next: NextFunction) => {
    const e = err instanceof AppError ? err : fromPg(err as never) ?? (err.type === 'entity.parse.failed' ? new AppError(400, 'bad_json', 'Malformed JSON body') : null);
    if (!e) console.error(`[${def.name}]`, err);
    const status = e?.status ?? 500;
    res.status(status).json({ error: { code: e?.code ?? 'internal', message: e?.message ?? 'Something went wrong', details: e?.details } });
  });

  const handlers = def.consumers?.(ctx);
  const consumer = handlers ? subscribe(pool, def.name, handlers, { pollMs: opts.pollMs, manual: opts.serverless || opts.manualBus }) : undefined;

  return {
    app,
    ctx,
    consumer,
    async close() {
      await consumer?.stop();
      await pool.end();
    },
  };
}

/** Entry point used by each service's main.ts. */
export async function runService(def: ServiceDefinition, port: number) {
  const svc = await bootService(def);
  const server = svc.app.listen(port, () => console.log(`[${def.name}] listening on :${port}`));
  const shutdown = () => server.close(() => void svc.close().then(() => process.exit(0)));
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

export const migrationsOf = (metaUrl: string) => path.resolve(path.dirname(fileURLToPath(metaUrl)), '../migrations');
