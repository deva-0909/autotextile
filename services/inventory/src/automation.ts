import { type Pool, many, tx } from '@erp/platform';
import { raiseException } from './common.ts';
import { releaseReservation } from './reservations.ts';

/** Expires lapsed reservations and flags transfers stuck in transit. Runs every 15 minutes. */
export async function runInventoryChecks(pool: Pool) {
  const actor = { id: null, name: 'system' };
  const lapsed = await many<{ id: string }>(pool, `SELECT id FROM reservations WHERE status = 'active' AND expires_at < now()`);
  for (const r of lapsed) await tx(pool, (c) => releaseReservation(c, r.id, 'expired', 'Reservation hold expired', actor));
  const stuck = await many<{ id: string; number: string; to_warehouse_name: string; days: number }>(pool, `
    SELECT id, number, to_warehouse_name, (current_date - dispatched_at::date) AS days FROM transfers WHERE status IN ('in_transit','partially_received') AND dispatched_at < now() - interval '5 days'`);
  for (const t of stuck)
    await tx(pool, (c) => raiseException(c, { kind: 'transfer_delayed', severity: 'warning', ref_type: 'transfer', ref_id: t.id, ref_label: t.number, message: `${t.number} has been in transit to ${t.to_warehouse_name} for ${t.days} days`, notifyPermission: 'inventory.transfer.execute', link: `/inventory/transfers/${t.id}` }));
  return { expired_reservations: lapsed.length, delayed_transfers: stuck.length };
}

export function startInventoryAutomation(pool: Pool) {
  const run = () => runInventoryChecks(pool).catch((e) => console.error('[inventory] automation failed', (e as Error).message));
  setTimeout(run, 10_000);
  setInterval(run, 15 * 60_000).unref();
}
