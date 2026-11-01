-- Commission paid to agents (dalals) who bring in buyers: posted from approved CRM payouts, TDS under 194H.
INSERT INTO accounts (code, name, type, group_name, section, system_key, control, is_bank, eliminate_on_consolidation, allow_manual)
VALUES ('5320', 'Commission and brokerage', 'expense', 'Selling and distribution', 'operating_expenses', 'commission', NULL, false, false, true)
ON CONFLICT DO NOTHING;
