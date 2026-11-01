-- Manual sales and purchase invoices (no order, dispatch or purchase order), counter cash sales, and the daily cash closing.
CREATE TABLE manual_invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  root_id uuid NOT NULL,
  version int NOT NULL DEFAULT 1,
  kind text NOT NULL CHECK (kind IN ('sales','purchase')),
  mode text NOT NULL DEFAULT 'manual' CHECK (mode IN ('manual','counter')),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','pending_approval','posted','rejected','cancelled','superseded')),
  number text,
  draft_no text NOT NULL,
  book_id uuid NOT NULL REFERENCES books(id),
  doc_date date NOT NULL,
  due_date date,
  party_id uuid, party_name text NOT NULL, party_gstin text, party_state text, party_mobile text, party_pan text,
  supplier_invoice_no text,
  lines jsonb NOT NULL,
  barcodes text[] NOT NULL DEFAULT '{}',
  taxable numeric NOT NULL DEFAULT 0, cgst numeric NOT NULL DEFAULT 0, sgst numeric NOT NULL DEFAULT 0, igst numeric NOT NULL DEFAULT 0,
  round_off numeric NOT NULL DEFAULT 0, total numeric NOT NULL DEFAULT 0,
  tds_section text, tds_amount numeric NOT NULL DEFAULT 0,
  payment_mode text CHECK (payment_mode IS NULL OR payment_mode IN ('cash','upi','card','bank')),
  amount_received numeric NOT NULL DEFAULT 0,
  notes text,
  voucher_id uuid, receipt_voucher_id uuid, reversal_voucher_id uuid,
  created_by uuid, created_by_name text, submitted_by_name text, approved_by_name text, approved_at timestamptz,
  cancel_reason text, cancelled_by_name text, cancelled_at timestamptz,
  revised_from uuid REFERENCES manual_invoices(id),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (root_id, version)
);
CREATE INDEX manual_invoices_status ON manual_invoices (kind, status, doc_date);

-- The party used for walk-in buyers at the counter, per book (GSTIN).
CREATE TABLE walkin_parties (book_id uuid PRIMARY KEY REFERENCES books(id), party_id uuid NOT NULL);

CREATE TABLE cash_closings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  book_id uuid NOT NULL REFERENCES books(id),
  day date NOT NULL,
  system_cash numeric NOT NULL,
  counted numeric NOT NULL,
  difference numeric NOT NULL,
  denominations jsonb,
  note text,
  closed_by_name text NOT NULL, closed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (book_id, day)
);
