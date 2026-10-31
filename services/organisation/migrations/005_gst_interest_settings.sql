INSERT INTO settings (key, category, label, description, value_type, options, value, requires_ca_validation) VALUES
 ('finance.gstr3b_due_day', 'Finance', 'GSTR-3B due day (of the following month)', 'Monthly filers: 20. Quarterly (QRMP) filers: 22 or 24 depending on the state. Interest on late payment runs from the day after.', 'number', NULL, '20', true),
 ('finance.gst_interest_rate_pct', 'Finance', 'Interest on late GST payment (% a year)', 'Section 50(1): 18% on tax paid in cash after the due date.', 'percent', NULL, '18', true)
ON CONFLICT (key) DO NOTHING;
