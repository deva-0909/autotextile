-- GST electronic cash ledger balance and pending ITC reversals carried over from the legacy system.
INSERT INTO accounts (code, name, type, group_name, section, system_key, control, is_bank, eliminate_on_consolidation, allow_manual) VALUES
 ('1520', 'GST electronic cash ledger', 'asset', 'GST input credit', 'current_assets', 'gst_cash_ledger', NULL, false, false, true),
 ('1530', 'ITC reversed — reclaimable on payment', 'asset', 'GST input credit', 'current_assets', 'itc_reclaimable', NULL, false, false, true),
 ('5700', 'ITC reversed — not reclaimable', 'expense', 'Administrative expenses', 'operating_expenses', 'itc_reversed', NULL, false, false, true)
ON CONFLICT (code) DO NOTHING;

CREATE TABLE gst_opening_cash (
  book_id uuid PRIMARY KEY REFERENCES books(id),
  as_of date NOT NULL CHECK (extract(day FROM as_of) = 1),
  igst numeric NOT NULL DEFAULT 0 CHECK (igst >= 0),
  cgst numeric NOT NULL DEFAULT 0 CHECK (cgst >= 0),
  sgst numeric NOT NULL DEFAULT 0 CHECK (sgst >= 0),
  voucher_id uuid REFERENCES vouchers(id),
  reference text,
  created_by_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- A reversal reported in GSTR-3B table 4(B) in its period; Rule 37 reversals are reclaimed when the supplier is paid.
CREATE TABLE gst_itc_reversals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  book_id uuid NOT NULL REFERENCES books(id),
  supplier_name text NOT NULL,
  doc_no text NOT NULL,
  doc_date date NOT NULL,
  reason text NOT NULL CHECK (reason IN ('rule_37','rule_42_43','other')),
  period date NOT NULL CHECK (extract(day FROM period) = 1),
  igst numeric NOT NULL DEFAULT 0 CHECK (igst >= 0),
  cgst numeric NOT NULL DEFAULT 0 CHECK (cgst >= 0),
  sgst numeric NOT NULL DEFAULT 0 CHECK (sgst >= 0),
  status text NOT NULL DEFAULT 'reversed' CHECK (status IN ('reversed','reclaimed')),
  reclaim_period date CHECK (reclaim_period IS NULL OR extract(day FROM reclaim_period) = 1),
  voucher_id uuid REFERENCES vouchers(id), reclaim_voucher_id uuid REFERENCES vouchers(id),
  reference text, note text,
  created_by_name text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (book_id, supplier_name, doc_no, reason)
);
