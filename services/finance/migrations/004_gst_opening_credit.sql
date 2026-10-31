-- Electronic credit ledger balance carried over from the legacy system, one per GSTIN.
-- GSTR-3B brings it forward from as_of month onwards.
CREATE TABLE gst_opening_credit (
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
