import type { Request } from 'express';
import { type Pool, callService, many, tx } from '@erp/platform';
import { S, raiseException } from './common.ts';
import { cancelOrder } from './orders.ts';

const system = { user: { id: 'svc:commerce', name: 'system', permissions: ['*'] }, headers: {}, socket: {} } as unknown as Request;

/** Lapsed payment links and unpaid orders, and reservations about to run out. Runs every 5 minutes. */
export async function runCommerceChecks(pool: Pool) {
  const out = { expired_links: 0, unpaid_cancelled: 0, reservations_expiring: 0, reservations_expired: 0 };
  out.expired_links = (await pool.query(`UPDATE payments SET status = 'expired', updated_at = now() WHERE status = 'created' AND link_expires_at < now() - interval '5 minutes'`)).rowCount ?? 0;
  const unpaid = await many<{ id: string }>(pool, `SELECT id FROM orders WHERE status = 'pending_payment' AND token_due_at < now()`);
  for (const o of unpaid) {
    await tx(pool, async (c) => {
      await cancelOrder(c, system, o.id, 'Token not paid in time; stock released');
      await c.query(`UPDATE orders SET status = 'expired' WHERE id = $1`, [o.id]);
    });
    out.unpaid_cancelled++;
  }
  const soon = await many<{ id: string; number: string; customer_name: string; reservation_expires_at: string }>(pool, `SELECT id, number, customer_name, reservation_expires_at FROM orders WHERE status = 'booked' AND reservation_expires_at < now() + interval '1 day'`);
  for (const o of soon) {
    if (new Date(o.reservation_expires_at) < new Date()) {
      await tx(pool, async (c) => {
        await callService(S, 'fulfilment', 'POST', `/plans/${o.id}/cancel`, { reason: 'Reservation expired' }).catch(() => null);
        await c.query(`UPDATE orders SET status = 'expired', cancelled_reason = 'Reservation expired before dispatch', updated_at = now() WHERE id = $1`, [o.id]);
      });
      out.reservations_expired++;
    } else if (await tx(pool, (c) => raiseException(c, { kind: 'reservation_expiring', severity: 'warning', ref_type: 'order', ref_id: o.id, ref_label: `${o.number} · ${o.customer_name}`, message: `Stock held for ${o.number} is released ${new Date(o.reservation_expires_at).toLocaleString('en-IN')} unless dispatched or extended`, notifyPermission: 'commerce.order.manage', link: `/commerce/orders/${o.id}` }))) out.reservations_expiring++;
  }
  return out;
}

export function startCommerceAutomation(pool: Pool) {
  const run = () => runCommerceChecks(pool).catch((e) => console.error('[commerce] automation failed', (e as Error).message));
  setTimeout(run, 15_000);
  setInterval(run, 5 * 60_000).unref();
}
