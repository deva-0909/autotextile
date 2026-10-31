-- When each month's GSTR-3B tax was paid, and the interest charged for paying it late (Section 50(1), Rule 88B).
INSERT INTO accounts (code, name, type, group_name, section, system_key, control, is_bank, eliminate_on_consolidation, allow_manual) VALUES
 ('5610', 'Interest on late GST payment', 'expense', 'Finance costs', 'finance_costs', 'gst_interest', NULL, false, false, true)
ON CONFLICT (code) DO NOTHING;

CREATE TABLE gst_return_payments (
  book_id uuid NOT NULL REFERENCES books(id),
  period date NOT NULL CHECK (extract(day FROM period) = 1),
  due_date date NOT NULL,
  paid_on date NOT NULL,
  arn text,
  days_late int NOT NULL DEFAULT 0,
  base_igst numeric NOT NULL DEFAULT 0, base_cgst numeric NOT NULL DEFAULT 0, base_sgst numeric NOT NULL DEFAULT 0,
  interest_igst numeric NOT NULL DEFAULT 0, interest_cgst numeric NOT NULL DEFAULT 0, interest_sgst numeric NOT NULL DEFAULT 0,
  interest_overridden boolean NOT NULL DEFAULT false, override_reason text,
  interest_with_return boolean NOT NULL DEFAULT false,
  due_id uuid REFERENCES gst_dues(id),
  created_by_name text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (book_id, period)
);
