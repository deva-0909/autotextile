import type { Router } from 'express';
import { type Pool, type ServiceContext, callService, many, one, requirePermission } from '@erp/platform';
import { S, getParty, round2 } from './common.ts';

interface Perf { supplier_id: string; pos: number; po_value: number; delivered: number; on_time: number; avg_lead_days: number | null; ordered_kg: number; received_kg: number; rejected_kg: number; invoices: number; invoices_first_time_match: number; open_exceptions: number }

async function performance(pool: Pool, supplierIds: string[] | null): Promise<Perf[]> {
  return many<Perf>(pool, `
    WITH po AS (
      SELECT p.id, p.supplier_id, p.order_date, p.expected_date, p.status, p.total_value,
        (SELECT min(r.receipt_date) FROM receipts r WHERE r.po_id = p.id) AS first_receipt,
        (SELECT max(r.receipt_date) FROM receipts r WHERE r.po_id = p.id) AS last_receipt
      FROM purchase_orders p WHERE p.status NOT IN ('draft','pending_approval','cancelled') ${supplierIds ? 'AND p.supplier_id = ANY($1)' : ''}
    )
    SELECT po.supplier_id, count(*)::int AS pos, round(sum(po.total_value), 2) AS po_value,
      count(*) FILTER (WHERE po.status IN ('received','closed'))::int AS delivered,
      count(*) FILTER (WHERE po.status IN ('received','closed') AND po.last_receipt <= po.expected_date)::int AS on_time,
      round(avg(po.first_receipt - po.order_date) FILTER (WHERE po.first_receipt IS NOT NULL), 1) AS avg_lead_days,
      coalesce((SELECT sum(l.qty_kg) FROM po_lines l JOIN po p2 ON p2.id = l.po_id WHERE p2.supplier_id = po.supplier_id), 0) AS ordered_kg,
      coalesce((SELECT sum(l.received_kg) FROM po_lines l JOIN po p2 ON p2.id = l.po_id WHERE p2.supplier_id = po.supplier_id), 0) AS received_kg,
      coalesce((SELECT sum(l.rejected_kg) FROM po_lines l JOIN po p2 ON p2.id = l.po_id WHERE p2.supplier_id = po.supplier_id), 0) AS rejected_kg,
      (SELECT count(*)::int FROM supplier_invoices i WHERE i.supplier_id = po.supplier_id AND i.status <> 'rejected') AS invoices,
      (SELECT count(*)::int FROM supplier_invoices i WHERE i.supplier_id = po.supplier_id AND i.status = 'posted' AND i.hold_reason IS NULL) AS invoices_first_time_match,
      (SELECT count(*)::int FROM exceptions e JOIN purchase_orders p3 ON p3.id = e.ref_id WHERE p3.supplier_id = po.supplier_id AND e.status = 'open') AS open_exceptions
    FROM po GROUP BY po.supplier_id`, supplierIds ? [supplierIds] : []);
}

/** 0–100 score: delivery 40%, quality 30%, invoice accuracy 20%, open issues 10%. Needs history to be meaningful. */
function score(p: Perf | undefined) {
  if (!p || p.pos === 0) return { score: null, on_time_pct: null, rejection_pct: null, fill_rate_pct: null, invoice_accuracy_pct: null };
  const onTime = p.delivered ? p.on_time / p.delivered : null;
  const rejection = p.received_kg + p.rejected_kg > 0 ? p.rejected_kg / (p.received_kg + p.rejected_kg) : null;
  const accuracy = p.invoices ? p.invoices_first_time_match / p.invoices : null;
  const parts: [number | null, number][] = [[onTime, 40], [rejection === null ? null : 1 - Math.min(1, rejection * 10), 30], [accuracy, 20], [p.open_exceptions ? Math.max(0, 1 - p.open_exceptions * 0.25) : 1, 10]];
  const used = parts.filter(([v]) => v !== null) as [number, number][];
  const weight = used.reduce((s, [, w]) => s + w, 0);
  return {
    score: weight ? Math.round(used.reduce((s, [v, w]) => s + v * w, 0) / weight * 100) : null,
    on_time_pct: onTime === null ? null : Math.round(onTime * 100),
    rejection_pct: rejection === null ? null : round2(rejection * 100),
    fill_rate_pct: p.ordered_kg ? Math.round((p.received_kg / p.ordered_kg) * 100) : null,
    invoice_accuracy_pct: accuracy === null ? null : Math.round(accuracy * 100),
  };
}

const KYC_DOCS = [['GST_CERT', 'GST certificate'], ['PAN_CARD', 'PAN card'], ['CANCELLED_CHEQUE', 'Cancelled cheque']] as const;

export function supplierRoutes(r: Router, { pool }: ServiceContext) {
  r.get('/suppliers/scorecards', requirePermission('procurement.read'), async (_req, res) => {
    const list = await callService<{ items: { id: string; code: string; legal_name: string; party_type: string; gstin: string | null; state_code: string | null; status: string; rating: number | null }[] }>(
      S, 'masters', 'GET', '/parties?f_type=supplier,manufacturer&pageSize=200&sort=legal_name');
    const perf = await performance(pool, null);
    res.json(list.items.map((s) => {
      const p = perf.find((x) => x.supplier_id === s.id);
      return { ...s, pos: p?.pos ?? 0, po_value: p?.po_value ?? 0, avg_lead_days: p?.avg_lead_days ?? null, open_exceptions: p?.open_exceptions ?? 0, ...score(p) };
    }));
  });

  r.get('/suppliers/:id/scorecard', requirePermission('procurement.read'), async (req, res) => {
    const id = String(req.params.id);
    const party = await callService<{ id: string; gstin: string | null; status: string; bank_accounts: { status: string }[] }>(S, 'masters', 'GET', `/parties/${id}`);
    const [perf] = await performance(pool, [id]);
    const docs = await callService<{ items: { document_type: string; expires_on: string | null }[] }>(S, 'governance', 'GET', `/documents?f_entityType=supplier&f_entityId=${id}&pageSize=100`).catch(() => ({ items: [] }));
    const docsMfr = await callService<{ items: { document_type: string; expires_on: string | null }[] }>(S, 'governance', 'GET', `/documents?f_entityType=manufacturer&f_entityId=${id}&pageSize=100`).catch(() => ({ items: [] }));
    const allDocs = [...docs.items, ...docsMfr.items];
    const kyc = [
      { item: 'GSTIN verified (checksum)', ok: !!party.gstin },
      { item: 'Approved bank account', ok: party.bank_accounts.some((b) => b.status === 'active') },
      ...KYC_DOCS.map(([code, label]) => ({ item: label, ok: allDocs.some((d) => d.document_type === code && (!d.expires_on || new Date(d.expires_on) >= new Date())) })),
    ];
    const priceHistory = await many(pool, `
      SELECT l.sku, l.product_name, p.order_date, l.rate_per_kg, l.qty_kg, p.number
      FROM po_lines l JOIN purchase_orders p ON p.id = l.po_id WHERE p.supplier_id = $1 AND p.status NOT IN ('draft','cancelled') ORDER BY l.sku, p.order_date`, [id]);
    const recent = await many(pool, `SELECT id, number, order_date, expected_date, status, total_value, deliver_to_name FROM purchase_orders WHERE supplier_id = $1 ORDER BY order_date DESC LIMIT 10`, [id]);
    const disputes = await many(pool, `SELECT e.* FROM exceptions e WHERE e.ref_id IN (SELECT id FROM purchase_orders WHERE supplier_id = $1 UNION SELECT id FROM supplier_invoices WHERE supplier_id = $1) ORDER BY e.detected_at DESC LIMIT 20`, [id]);
    const s = score(perf);
    const kycScore = kyc.filter((k) => k.ok).length / kyc.length;
    // Risk is higher with incomplete KYC, poor delivery or open issues.
    const risk = Math.round((1 - kycScore) * 40 + (s.on_time_pct === null ? 15 : (100 - s.on_time_pct) * 0.3) + Math.min(30, (perf?.open_exceptions ?? 0) * 10));
    res.json({ performance: perf ?? null, ...s, kyc, kyc_complete: kycScore === 1, risk_score: Math.min(100, risk), risk_level: risk >= 50 ? 'high' : risk >= 25 ? 'medium' : 'low', price_history: priceHistory, recent_orders: recent, disputes });
  });

  /** Suggests suppliers for a product from price, delivery and quality history. Never creates a PO. */
  r.get('/suppliers/recommend', requirePermission('procurement.read'), async (req, res) => {
    const productId = String(req.query.productId ?? '');
    const rows = await many<{ supplier_id: string; supplier_name: string; last_rate: number; avg_rate: number; orders: number; last_order: string }>(pool, `
      SELECT p.supplier_id, max(p.supplier_name) AS supplier_name,
        (array_agg(l.rate_per_kg ORDER BY p.order_date DESC))[1] AS last_rate, round(avg(l.rate_per_kg), 2) AS avg_rate,
        count(*)::int AS orders, max(p.order_date) AS last_order
      FROM po_lines l JOIN purchase_orders p ON p.id = l.po_id
      WHERE l.product_id = $1 AND p.status NOT IN ('draft','cancelled','pending_approval') GROUP BY p.supplier_id`, [productId]);
    const perf = await performance(pool, rows.map((r) => r.supplier_id));
    const minRate = Math.min(...rows.map((r) => Number(r.last_rate)));
    res.json(rows.map((r) => {
      const s = score(perf.find((p) => p.supplier_id === r.supplier_id));
      const priceScore = minRate / Number(r.last_rate);
      const combined = Math.round(priceScore * 50 + (s.score ?? 50) * 0.5);
      return { ...r, ...s, recommendation_score: combined, why: `Last ₹${r.last_rate}/kg (${Math.round((priceScore) * 100)}% of best), ${s.on_time_pct ?? '—'}% on time, ${s.rejection_pct ?? '—'}% rejected over ${r.orders} orders` };
    }).sort((a, b) => b.recommendation_score - a.recommendation_score));
  });

  r.get('/suppliers/:id/kyc-party', requirePermission('procurement.read'), async (req, res) => {
    res.json(await getParty(String(req.params.id)));
  });

  r.get('/dashboard', requirePermission('procurement.read'), async (_req, res) => {
    res.json(await one(pool, `SELECT
      (SELECT count(*)::int FROM requisitions WHERE status = 'submitted') AS requisitions_to_approve,
      (SELECT count(*)::int FROM rfqs WHERE status = 'open') AS open_rfqs,
      (SELECT count(*)::int FROM purchase_orders WHERE status IN ('sent','accepted','partially_received')) AS open_pos,
      (SELECT round(coalesce(sum(total_value), 0), 2) FROM purchase_orders WHERE status IN ('sent','accepted','partially_received')) AS open_po_value,
      (SELECT count(*)::int FROM purchase_orders WHERE status = 'pending_approval') AS pos_pending_approval,
      (SELECT count(*)::int FROM purchase_orders WHERE status IN ('sent','accepted','partially_received') AND expected_date < current_date) AS overdue_pos,
      (SELECT count(*)::int FROM invoice_captures WHERE status = 'needs_review') AS captures_to_review,
      (SELECT count(*)::int FROM exceptions WHERE status = 'open') AS open_exceptions`));
  });
}
