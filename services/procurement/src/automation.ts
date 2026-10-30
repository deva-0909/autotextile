import { type Pool, many, tx } from '@erp/platform';
import { raiseException, setting } from './common.ts';

/** Periodic checks from the automation register: PO not accepted, supplier invoice missing. */
export async function runProcurementChecks(pool: Pool) {
  const sla = Number(await setting('procurement.po_acceptance_sla_hours', 48));
  const invoiceDays = Number(await setting('procurement.invoice_due_days_after_receipt', 7));
  await tx(pool, async (c) => {
    const late = await many<{ id: string; number: string; supplier_name: string }>(c, `SELECT id, number, supplier_name FROM purchase_orders WHERE status = 'sent' AND sent_at < now() - ($1 || ' hours')::interval`, [sla]);
    for (const p of late)
      await raiseException(c, { kind: 'po_not_accepted', severity: 'warning', ref_type: 'purchase_order', ref_id: p.id, ref_label: `${p.number} · ${p.supplier_name}`, message: `${p.supplier_name} has not accepted ${p.number} within ${sla} hours`, notifyPermission: 'procurement.po.manage', link: `/procurement/purchase-orders/${p.id}` });
    const unbilled = await many<{ id: string; number: string; supplier_name: string; kg: number; days: number }>(c, `
      SELECT p.id, p.number, p.supplier_name, sum(l.received_kg - l.invoiced_kg) AS kg, current_date - min(r.receipt_date) AS days
      FROM purchase_orders p JOIN po_lines l ON l.po_id = p.id JOIN receipts r ON r.po_id = p.id
      WHERE p.status <> 'cancelled' AND l.received_kg - l.invoiced_kg > 0.001
        AND NOT EXISTS (SELECT 1 FROM supplier_invoices i WHERE i.po_id = p.id AND i.status IN ('draft','pending_approval'))
      GROUP BY p.id HAVING current_date - min(r.receipt_date) > $1`, [invoiceDays]);
    for (const u of unbilled)
      await raiseException(c, { kind: 'missing_invoice', severity: 'warning', ref_type: 'purchase_order', ref_id: u.id, ref_label: `${u.number} · ${u.supplier_name}`, message: `No invoice from ${u.supplier_name} for ${Math.round(u.kg)} kg received ${u.days} days ago on ${u.number}`, notifyPermission: 'procurement.exception.manage', link: `/procurement/purchase-orders/${u.id}` });
    // Close missing-invoice exceptions once everything received has been invoiced or an invoice is in review.
    await c.query(`
      UPDATE exceptions e SET status = 'resolved', resolved_at = now(), resolved_by_name = 'system', resolution = 'Invoice received'
      WHERE e.kind = 'missing_invoice' AND e.status = 'open' AND (
        NOT EXISTS (SELECT 1 FROM po_lines l WHERE l.po_id = e.ref_id AND l.received_kg - l.invoiced_kg > 0.001)
        OR EXISTS (SELECT 1 FROM supplier_invoices i WHERE i.po_id = e.ref_id AND i.status IN ('draft','pending_approval')))`);
  });
}

export function startProcurementAutomation(pool: Pool, everyMs = 5 * 60_000) {
  const run = () => runProcurementChecks(pool).catch((e) => console.error('[procurement-automation]', e.message));
  setTimeout(run, 10_000).unref();
  const t = setInterval(run, everyMs);
  t.unref();
  return () => clearInterval(t);
}
