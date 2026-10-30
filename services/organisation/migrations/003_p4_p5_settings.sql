INSERT INTO settings (key, category, label, description, value_type, options, value, requires_ca_validation) VALUES
 ('inventory.qc_required', 'Inventory', 'Rolls need QC grading before they can be sold', 'Inward rolls wait in QC hold until graded.', 'boolean', NULL, 'true', false),
 ('inventory.inward_weight_tolerance_percent', 'Inventory', 'Inward weight tolerance vs document (%)', 'A larger difference between weighed and document kg opens an exception.', 'percent', NULL, '1', false),
 ('inventory.price_change_requires_approval', 'Inventory', 'Selling-price changes need approval', 'The first price on a lot is set directly; later changes go to a checker.', 'boolean', NULL, 'true', false),
 ('inventory.intra_gstin_transfer_requires_approval', 'Inventory', 'Transfers within one GSTIN need approval', 'Transfers between different GSTINs always need approval.', 'boolean', NULL, 'false', false),
 ('inventory.inter_gstin_transfer_document', 'Inventory', 'Document for transfers between GSTINs', 'Distinct GST registrations are distinct persons; confirm treatment and valuation with the CA.', 'select', '["tax_invoice","delivery_challan"]', '"tax_invoice"', true),
 ('inventory.reservation_hold_days', 'Inventory', 'Reservation hold (days)', 'Reservations expire and release their rolls after this.', 'number', NULL, '3', false),
 ('inventory.block_shade_mixing', 'Inventory', 'Block mixing dye lots in one reservation', 'When off, mixing shows a warning only.', 'boolean', NULL, 'true', false),
 ('inventory.slow_moving_days', 'Inventory', 'Slow stock after (days without movement out)', NULL, 'number', NULL, '90', false),
 ('inventory.eway_bill_threshold', 'Inventory', 'E-way bill needed above (₹ consignment value)', 'Transfers above this value cannot be dispatched without an e-way bill number.', 'number', NULL, '50000', true),
 ('inventory.stocktake_weight_tolerance_kg', 'Inventory', 'Stocktake weight tolerance per roll (kg)', 'Smaller differences are ignored.', 'number', NULL, '0.5', false),
 ('crm.max_active_leads_default', 'Sales', 'Default maximum active leads per salesperson', 'Overridable per person in the sales team.', 'number', NULL, '40', false),
 ('crm.first_response_sla_minutes', 'Sales', 'First response SLA (minutes)', 'New leads not contacted within this are escalated.', 'number', NULL, '60', false),
 ('crm.followup_grace_hours', 'Sales', 'Follow-up overdue after (hours)', NULL, 'number', NULL, '4', false),
 ('crm.quotation_validity_days', 'Sales', 'Default quotation validity (days)', NULL, 'number', NULL, '7', false)
ON CONFLICT (key) DO NOTHING;

INSERT INTO number_series (doc_type, fiscal_year_id, prefix, padding)
SELECT d.doc_type, f.id, d.prefix, 5
FROM fiscal_years f, (VALUES ('stocktake', 'ST/2627/'), ('lead', 'LD/2627/'), ('credit_application', 'CR/2627/'), ('reservation', 'RS/2627/')) AS d(doc_type, prefix)
WHERE f.is_current
ON CONFLICT DO NOTHING;
