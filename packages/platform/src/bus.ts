import { type Client, type Pool, tx } from './db.ts';
import { transportMode } from './transport.ts';

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
  // A transaction-scoped lock: it cannot outlive its transaction, which matters behind a transaction pooler.
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query(`SELECT pg_advisory_xact_lock(hashtext('bus:init'))`);
    await c.query(`
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
    await c.query('COMMIT');
  } catch (err) {
    await c.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    c.release();
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
  /** Highest event id this consumer has already looked at. */
  seen(): number;
  /** Processes everything pending now; resolves when caught up. Used by tests and on startup. */
  drain(): Promise<void>;
}

/** `manual`: no polling timer and no LISTEN connection; events are processed only when `drain()` is called (serverless). */
export function subscribe(pool: Pool, consumer: string, handlers: Record<string, Handler>, opts: { pollMs?: number; manual?: boolean } = {}): Consumer {
  const types = Object.keys(handlers);
  let stopped = false;
  let running: Promise<void> | null = null;
  let listener: Client | null = null;

  /**
   * Handles what is pending, one event per transaction: the handler's changes and the consumer's new offset commit
   * together. The offset moves only from the value read, so two copies of the app never handle the same event
   * twice (the second one's guarded update finds the offset already moved, and its transaction is undone).
   * A failing event is parked in bus.dead_letters and the consumer moves on.
   */
  let seen = 0; // highest event id this consumer has looked at
  async function batch(): Promise<number> {
    // One call: the offset, what is pending after it, and whether replays were asked for.
    const read = () => pool.query(`SELECT o.last_id,
        (SELECT coalesce(json_agg(e ORDER BY e.id), '[]') FROM (SELECT id, type, source, payload, occurred_at FROM bus.events WHERE id > o.last_id ORDER BY id LIMIT 200) e) AS events,
        EXISTS (SELECT 1 FROM bus.dead_letters d WHERE d.consumer = o.consumer AND d.replay_requested_at IS NOT NULL AND d.replayed_at IS NULL) AS replays
      FROM bus.offsets o WHERE o.consumer = $1`, [consumer]);
    let r = await read();
    if (!r.rows.length) {
      await pool.query('INSERT INTO bus.offsets (consumer) VALUES ($1) ON CONFLICT DO NOTHING', [consumer]);
      r = await read();
    }
    const off = r.rows[0] as { last_id: number; events: BusEvent[]; replays: boolean };
    let last = Number(off.last_id);
    const rows = off.events;
    const advance = async (c: Client, to: number) => {
      const r = await c.query('/* erp:expect 1 */ UPDATE bus.offsets SET last_id = $3 WHERE consumer = $1 AND last_id = $2', [consumer, last, to]);
      if (!r.rowCount) throw Object.assign(new Error('another instance handled this event'), { taken: true });
    };
    let skipTo = 0;
    for (const ev of rows as BusEvent[]) {
      const id = Number(ev.id);
      if (!types.includes(ev.type)) { skipTo = id; continue; }
      try {
        await tx(pool, async (c) => {
          await advance(c, id);
          await handlers[ev.type](ev, c);
        });
        last = id; skipTo = 0;
      } catch (err) {
        if ((err as { taken?: boolean }).taken) return 0; // someone else is working through these
        // Park the event so one bad message cannot block the consumer; it can be replayed from bus.dead_letters.
        console.error(`[bus:${consumer}] event ${ev.id} (${ev.type}) failed: ${(err as Error).message}`);
        try {
          await tx(pool, async (c) => {
            await advance(c, id);
            await c.query('INSERT INTO bus.dead_letters (consumer, event_id, error) VALUES ($1, $2, $3)', [consumer, ev.id, (err as Error).message]);
          });
          last = id; skipTo = 0;
        } catch { return 0; }
      }
    }
    // Events this consumer does not handle: just move past them.
    if (skipTo) await tx(pool, async (c) => { await advance(c, skipTo); }).then(() => { last = skipTo; }, () => undefined);
    seen = Math.max(seen, last);
    // Parked events an operator asked to replay (after fixing the cause) run once more for this consumer only.
    const { rows: replays } = !off.replays ? { rows: [] } : await pool.query(
      `SELECT d.id AS dl_id, e.id, e.type, e.source, e.payload, e.occurred_at FROM bus.dead_letters d JOIN bus.events e ON e.id = d.event_id
       WHERE d.consumer = $1 AND d.replay_requested_at IS NOT NULL AND d.replayed_at IS NULL ORDER BY d.id LIMIT 50`, [consumer]);
    for (const r of replays as (BusEvent & { dl_id: number })[]) {
      try {
        await tx(pool, async (c) => {
          const claim = await c.query('UPDATE bus.dead_letters SET replayed_at = now(), replay_error = NULL WHERE id = $1 AND replayed_at IS NULL', [r.dl_id]);
          if (!claim.rowCount) return;
          if (types.includes(r.type)) await handlers[r.type](r, c);
        });
      } catch (err) {
        await pool.query('UPDATE bus.dead_letters SET replay_requested_at = NULL, replay_error = $2 WHERE id = $1', [r.dl_id, (err as Error).message]);
      }
    }
    return rows.length;
  }

  async function drain() {
    while (running) await running;
    if (stopped) return;
    // Track this run explicitly: clearing `running` inside the run itself could happen before the
    // assignment below when the run finishes synchronously, leaving a settled promise that stop() spins on.
    const run = (async () => {
      try {
        // A short page means caught up; events that handlers publish meanwhile are picked up by the next round.
        while (!stopped && (await batch()) >= 200) { /* keep going */ }
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
  if (!opts.manual && transportMode() === 'pg') void (async () => {
    try {
      listener = await pool.connect();
      listener.on('notification', () => void drain());
      await listener.query('LISTEN bus');
    } catch { /* polling still works */ }
  })();

  return {
    drain,
    seen: () => seen,
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

/**
 * Drains several consumers until none has work, asking the database once per round for the newest event instead of
 * every consumer checking on its own (over the web API each check is a call).
 */
export async function drainMany(pool: Pool, consumers: (Consumer | undefined)[], maxRounds = 6) {
  const list = consumers.filter(Boolean) as Consumer[];
  for (let round = 0; round < maxRounds; round++) {
    const { rows: [m] } = await pool.query('SELECT coalesce(max(id), 0)::bigint AS id FROM bus.events');
    const newest = Number(m.id);
    const behind = list.filter((c) => c.seen() < newest);
    if (!behind.length) return;
    for (const c of behind) await c.drain();
  }
}
