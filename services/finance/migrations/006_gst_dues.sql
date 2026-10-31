-- Interest, late fee, penalty and other GST amounts carried over from the legacy system: cash already held in those
-- minor heads of the electronic cash ledger, and amounts still owed (electronic liability register).
INSERT INTO accounts (code, name, type, group_name, section, system_key, control, is_bank, eliminate_on_consolidation, allow_manual) VALUES
 ('2220', 'GST interest, late fee and penalty payable', 'liability', 'Statutory dues', 'current_liabilities', 'gst_dues_payable', NULL, false, false, true)
ON CONFLICT (code) DO NOTHING;

CREATE TABLE gst_dues (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  book_id uuid NOT NULL REFERENCES books(id),
  kind text NOT NULL CHECK (kind IN ('cash_balance','outstanding')),
  minor_head text NOT NULL CHECK (minor_head IN ('interest','late_fee','penalty','others')),
  as_of date NOT NULL CHECK (extract(day FROM as_of) = 1),
  reference text NOT NULL,
  pay_in_month date CHECK (pay_in_month IS NULL OR extract(day FROM pay_in_month) = 1),
  igst numeric NOT NULL DEFAULT 0 CHECK (igst >= 0),
  cgst numeric NOT NULL DEFAULT 0 CHECK (cgst >= 0),
  sgst numeric NOT NULL DEFAULT 0 CHECK (sgst >= 0),
  status text NOT NULL CHECK (status IN ('balance','open','settled')),
  voucher_id uuid REFERENCES vouchers(id),
  settle_voucher_id uuid REFERENCES vouchers(id),
  settled_on date,
  from_cash_igst numeric NOT NULL DEFAULT 0, from_cash_cgst numeric NOT NULL DEFAULT 0, from_cash_sgst numeric NOT NULL DEFAULT 0,
  from_challan numeric NOT NULL DEFAULT 0, challan_ref text,
  migration_ref text,
  created_by_name text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (book_id, kind, minor_head, reference)
);
