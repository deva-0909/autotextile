INSERT INTO settings (key, category, label, description, value_type, options, value, requires_ca_validation) VALUES
 ('finance.gstr1_due_day', 'Finance', 'GSTR-1 due day (of the following month)', 'Monthly filers: 11. Quarterly (QRMP) filers file by the 13th after the quarter.', 'number', NULL, '11', true),
 ('finance.aggregate_turnover_prev_fy', 'Finance', 'Aggregate turnover of the previous financial year (₹, all GSTINs of the PAN)', 'Sets the late fee cap per return: up to ₹1.5 crore ₹2,000; up to ₹5 crore ₹5,000; above ₹10,000. Leave at 0 to work it out from sales in the ERP (incomplete for the year before go-live).', 'number', NULL, '0', true)
ON CONFLICT (key) DO NOTHING;
