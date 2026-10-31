import type { Client, Pool } from './db.ts';

/**
 * Event bus backed by PostgreSQL (transactional outbox + consumer offsets).
 * Publishing happens in the producer's own transaction, so a business change and its event
 * commit atomically. Consumers process events in their own transaction together with the
 * offset update, giving effectively-once handling. Swap for Redis/Kafka behind this interface later.
 */
export interface BusEvent<T = Record<string, unknown>> {
  id: number;
  type: string;
  source: string;
  payload: T;
  occurred_at: string;
}

export async function ensureBus(pool: Pool) {
  await pool.query(`SELECT pg_advisory_lock(hashtext('bus:init'))`);
  try {
    await pool.query(`
      CREATE SCHEMA IF NOT EXISTS bus;
      CREATE TABLE IF NOT EXISTS bus.events (
        id bigserial PRIMARY KEY,
        type text NOT NULL,
        source text NOT NULL,
        payload jsonb NOT NULL,
        occurred_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS events_type_id ON bus.events (type, id);
      CREATE TABLE IF NOT EXISTS bus.offsets (consumer text PRIMARY KEY, last_id bigint NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS bus.dead_letters (
        id bigserial PRIMARY KEY,
        consumer text NOT NULL,
        event_id bigint NOT NULL,
        error text NOT NULL,
        failed_at timestamptz NOT NULL DEFAULT now()
      );
      ALTER TABLE bus.dead_letters ADD COLUMN IF NOT EXISTS replay_requested_at timestamptz;
      ALTER TABLE bus.dead_letters ADD COLUMN IF NOT EXISTS replayed_at timestamptz;
      ALTER TABLE bus.dead_letters ADD COLUMN IF NOT EXISTS replay_error text;
    `);
  } finally {
    await pool.query(`SELECT pg_advisory_unlock(hashtext('bus:init'))`);
  }
}

/** Publishes inside the caller's transaction. The lock keeps ids committing in order so consumers never skip one. */
export async function publish(c: Client, source: string, type: string, payload: object) {
  await c.query(`SELECT pg_advisory_xact_lock(hashtext('bus:publish'))`);
  await c.query('INSERT INTO bus.events (type, source, payload) VALUES ($1, $2, $3)', [type, source, JSON.stringify(payload)]);
  await c.query(`SELECT pg_notify('bus', $1)`, [type]);
}

export type Handler = (event: BusEvent, c: Client) => Promise<void>;

export interface Consumer {
  stop(): Promise<void>;
  /** Processes everything pending now; resolves when caught up. Used by tests and on startup. */
  drain(): Promise<void>;
}

/** `manual`: no polling timer and no LISTEN connection; events are processed only when `drain()` is called (serverless). */
export function subscribe(pool: Pool, consumer: string, handlers: Record<string, Handler>, opts: { pollMs?: number; manual?: boolean } = {}): Consumer {
  const types = Object.keys(handlers);
  let stopped = false;
  let running: Promise<void> | null = null;
  let listener: Client | null = null;

  async function batch(): Promise<number> {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('INSERT INTO bus.offsets (consumer) VALUES ($1) ON CONFLICT DO NOTHING', [consumer]);
      const { rows: [off] } = await c.query('SELECT last_id FROM bus.offsets WHERE consumer = $1 FOR UPDATE', [consumer]);
      const { rows } = await c.query(
        `SELECT id, type, source, payload, occurred_at FROM bus.events WHERE id > $1 ORDER BY id LIMIT 200`,
        [off.last_id],
      );
      for (const ev of rows as BusEvent[]) {
        if (types.includes(ev.type)) {
          await c.query('SAVEPOINT ev');
          try {
            await handlers[ev.type](ev, c);
            await c.query('RELEASE SAVEPOINT ev');
          } catch (err) {
            // Park the event so one bad message cannot block the consumer; it can be replayed from bus.dead_letters.
            await c.query('ROLLBACK TO SAVEPOINT ev');
            await c.query('INSERT INTO bus.dead_letters (consumer, event_id, error) VALUES ($1, $2, $3)', [consumer, ev.id, (err as Error).message]);
            console.error(`[bus:${consumer}] event ${ev.id} (${ev.type}) failed: ${(err as Error).message}`);
          }
        }
      }
      if (rows.length) await c.query('UPDATE bus.offsets SET last_id = $2 WHERE consumer = $1', [consumer, rows[rows.length - 1].id]);
      // Parked events an operator asked to replay (after fixing the cause) run once more for this consumer only.
      const { rows: replays } = await c.query(
        `SELECT d.id AS dl_id, e.id, e.type, e.source, e.payload, e.occurred_at FROM bus.dead_letters d JOIN bus.events e ON e.id = d.event_id
         WHERE d.consumer = $1 AND d.replay_requested_at IS NOT NULL AND d.replayed_at IS NULL ORDER BY d.id LIMIT 50`, [consumer]);
      for (const r of replays as (BusEvent & { dl_id: number })[]) {
        await c.query('SAVEPOINT rp');
        try {
          if (types.includes(r.type)) await handlers[r.type](r, c);
          await c.query('RELEASE SAVEPOINT rp');
          await c.query('UPDATE bus.dead_letters SET replayed_at = now(), replay_error = NULL WHERE id = $1', [r.dl_id]);
        } catch (err) {
          await c.query('ROLLBACK TO SAVEPOINT rp');
          await c.query('UPDATE bus.dead_letters SET replay_requested_at = NULL, replay_error = $2 WHERE id = $1', [r.dl_id, (err as Error).message]);
        }
      }
      await c.query('COMMIT');
      return rows.length;
    } catch (err) {
      await c.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      c.release();
    }
  }

  async function drain() {
    while (running) await running;
    if (stopped) return;
    // Track this run explicitly: clearing `running` inside the run itself could happen before the
    // assignment below when the run finishes synchronously, leaving a settled promise that stop() spins on.
    const run = (async () => {
      try {
        while (!stopped && (await batch()) > 0) { /* keep going */ }
        await batch();
      } catch (err) {
        console.error(`[bus:${consumer}] handler failed, will retry`, (err as Error).message);
      }
    })();
    running = run;
    try {
      await run;
    } finally {
      if (running === run) running = null;
    }
  }

  const timer = opts.manual ? null : setInterval(() => void drain(), opts.pollMs ?? 2000);
  timer?.unref();
  if (!opts.manual) void (async () => {
    try {
      listener = await pool.connect();
      listener.on('notification', () => void drain());
      await listener.query('LISTEN bus');
    } catch { /* polling still works */ }
  })();

  return {
    drain,
    async stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      while (running) await running;
      if (listener) {
        await listener.query('UNLISTEN bus').catch(() => {});
        listener.release();
      }
    },
  };
}

/** Queues a notification for governance to deliver (same transaction as the triggering change). */
export async function notify(c: Client, source: string, n: { user_id?: string | null; audience_permission?: string | null; kind?: string; title: string; body?: string | null; link?: string | null }) {
  await publish(c, source, 'notification.requested', n);
}
