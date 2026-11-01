-- Approved stock-count differences are shown on their own line, out of the cost of goods sold.
INSERT INTO accounts (code, name, type, group_name, section, system_key, control, is_bank, eliminate_on_consolidation, allow_manual)
VALUES ('5060', 'Stock shortage and count differences', 'expense', 'Cost of materials', 'cost_of_sales', 'stock_loss', NULL, false, false, true)
ON CONFLICT DO NOTHING;
