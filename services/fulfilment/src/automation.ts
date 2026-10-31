import { type Pool, many, tx } from '@erp/platform';
import { raiseException } from './common.ts';

/** Shipments past their ETA and booked orders not picked within two days. Runs every 30 minutes. */
export async function runFulfilmentChecks(pool: Pool) {
  const late = await many<{ id: string; number: string; customer_name: string; eta_date: string }>(pool, `SELECT id, number, customer_name, eta_date FROM shipments WHERE status IN ('in_transit','out_for_delivery') AND eta_date < current_date`);
  const slow = await many<{ id: string; number: string; customer_name: string; warehouse_code: string }>(pool, `SELECT id, number, customer_name, warehouse_code FROM fulfilments WHERE status = 'released' AND updated_at < now() - interval '2 days'`);
  await tx(pool, async (c) => {
    for (const s of late) await raiseException(c, { kind: 'shipment_late', severity: 'warning', ref_type: 'shipment', ref_id: s.id, ref_label: `${s.number} · ${s.customer_name}`, message: `${s.number} to ${s.customer_name} is past its ETA (${s.eta_date})`, notifyPermission: 'fulfilment.dispatch', link: `/fulfilment/shipments/${s.id}` });
    for (const f of slow) await raiseException(c, { kind: 'pick_delayed', severity: 'warning', ref_type: 'fulfilment', ref_id: f.id, ref_label: `${f.number} · ${f.customer_name}`, message: `${f.number} has been waiting for picking at ${f.warehouse_code} for over 2 days`, notifyPermission: 'fulfilment.pick', link: `/fulfilment/${f.id}` });
  });
  return { late: late.length, slow: slow.length };
}

export function startFulfilmentAutomation(pool: Pool) {
  const run = () => runFulfilmentChecks(pool).catch((e) => console.error('[fulfilment] automation failed', (e as Error).message));
  setTimeout(run, 20_000);
  setInterval(run, 30 * 60_000).unref();
}
