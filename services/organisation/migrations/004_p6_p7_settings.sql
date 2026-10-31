INSERT INTO settings (key, category, label, description, value_type, options, value, requires_ca_validation) VALUES
 ('commerce.payment_window_minutes', 'Commerce', 'Pay the token within (minutes)', 'Unpaid orders are cancelled and their stock released after this.', 'number', NULL, '60', false),
 ('commerce.reservation_extension_max_days', 'Commerce', 'Longest reservation extension (days)', 'Extensions always need approval; this caps how long one can be.', 'number', NULL, '7', false),
 ('commerce.show_prices_in_catalogue', 'Commerce', 'Show prices in the customer catalogue', 'When off, customers see "price on request".', 'boolean', NULL, 'true', false),
 ('commerce.payment_link_hours', 'Commerce', 'Payment links expire after (hours)', NULL, 'number', NULL, '24', false),
 ('fulfilment.pick_weight_tolerance_kg', 'Fulfilment', 'Pick re-weigh tolerance per roll (kg)', 'Larger differences are booked as a weight adjustment.', 'number', NULL, '0.5', false),
 ('fulfilment.default_freight_per_kg', 'Fulfilment', 'Fallback freight estimate (₹/kg) by distance zone', 'Used when no transporter rate exists: same state, neighbouring zone, far zone.', 'list', NULL, '[1.5,3,5]', false),
 ('fulfilment.eway_bill_threshold', 'Fulfilment', 'E-way bill needed above (₹ invoice value)', NULL, 'number', NULL, '50000', true)
ON CONFLICT (key) DO NOTHING;

INSERT INTO number_series (doc_type, fiscal_year_id, prefix, padding)
SELECT d.doc_type, f.id, d.prefix, 5
FROM fiscal_years f, (VALUES ('sales_order', 'SO/2627/'), ('rma', 'RMA/2627/'), ('shipment', 'SHP/2627/')) AS d(doc_type, prefix)
WHERE f.is_current
ON CONFLICT DO NOTHING;
