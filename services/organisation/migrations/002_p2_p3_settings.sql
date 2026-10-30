INSERT INTO settings (key, category, label, description, value_type, options, value, requires_ca_validation) VALUES
 ('procurement.po_approval_threshold', 'Procurement', 'PO approval above (₹, taxable value)', 'Purchase orders above this value need a checker before they can be sent. 0 = every PO.', 'number', NULL, '0', false),
 ('procurement.po_acceptance_sla_hours', 'Procurement', 'Supplier must accept PO within (hours)', 'After this, the PO is flagged and the buyer is notified.', 'number', NULL, '48', false),
 ('procurement.invoice_due_days_after_receipt', 'Procurement', 'Invoice expected within (days of receipt)', 'Receipts without an invoice after this are flagged as missing invoices.', 'number', NULL, '7', false),
 ('procurement.rate_tolerance_percent', 'Procurement', 'Invoice rate tolerance vs PO (%)', 'Rate variance above this blocks automatic matching.', 'percent', NULL, '1', false),
 ('jobwork.mill_ack_due_days', 'Job work', 'Mill must acknowledge receipt within (days)', 'Days after dispatch before an unacknowledged challan is flagged.', 'number', NULL, '2', false),
 ('jobwork.internal_buffer_days', 'Job work', 'Internal overdue buffer (days before expected return)', 'Operational due date = expected return − buffer.', 'number', NULL, '1', false),
 ('jobwork.statutory_alert_days', 'Job work', 'Statutory deadline reminders (days before)', NULL, 'list', NULL, '[30,15,7]', true)
ON CONFLICT (key) DO NOTHING;

-- Number series for documents introduced in P2/P3, for databases that already have a current fiscal year.
INSERT INTO number_series (doc_type, fiscal_year_id, prefix, padding)
SELECT d.doc_type, f.id, d.prefix, 5
FROM fiscal_years f, (VALUES ('purchase_requisition', 'PR/2627/'), ('rfq', 'RFQ/2627/'), ('goods_receipt', 'GRN/2627/'), ('quality_claim', 'QC/2627/')) AS d(doc_type, prefix)
WHERE f.is_current
ON CONFLICT DO NOTHING;
