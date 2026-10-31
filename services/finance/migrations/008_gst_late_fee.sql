-- Late fee for filing GSTR-3B and GSTR-1 late (Section 47; caps by turnover from Notifications 19 and 20/2021-CT).
INSERT INTO accounts (code, name, type, group_name, section, system_key, control, is_bank, eliminate_on_consolidation, allow_manual) VALUES
 ('5620', 'Late fee for GST returns', 'expense', 'Administrative expenses', 'operating_expenses', 'gst_late_fee', NULL, false, false, true)
ON CONFLICT (code) DO NOTHING;

ALTER TABLE gst_return_payments
  ADD COLUMN filed_on date,
  ADD COLUMN filing_days_late int NOT NULL DEFAULT 0,
  ADD COLUMN nil_return boolean NOT NULL DEFAULT false,
  ADD COLUMN late_fee_cgst numeric NOT NULL DEFAULT 0,
  ADD COLUMN late_fee_sgst numeric NOT NULL DEFAULT 0,
  ADD COLUMN late_fee_overridden boolean NOT NULL DEFAULT false,
  ADD COLUMN late_fee_reason text,
  ADD COLUMN late_fee_due_id uuid REFERENCES gst_dues(id);
UPDATE gst_return_payments SET filed_on = paid_on WHERE filed_on IS NULL;

CREATE TABLE gst_gstr1_filings (
  book_id uuid NOT NULL REFERENCES books(id),
  period date NOT NULL CHECK (extract(day FROM period) = 1),
  due_date date NOT NULL,
  filed_on date NOT NULL,
  arn text,
  days_late int NOT NULL DEFAULT 0,
  nil_return boolean NOT NULL DEFAULT false,
  late_fee_cgst numeric NOT NULL DEFAULT 0,
  late_fee_sgst numeric NOT NULL DEFAULT 0,
  late_fee_overridden boolean NOT NULL DEFAULT false,
  late_fee_reason text,
  due_id uuid REFERENCES gst_dues(id),
  created_by_name text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (book_id, period)
);
