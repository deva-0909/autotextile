-- Finance (P8): double-entry general ledger with GSTIN-wise books, AR/AP bills, GST and TDS registers,
-- bank reconciliation, inventory valuation snapshots, period control and anomaly alerts.

-- One book per GST registration. Consolidated reports combine books of a legal entity.
CREATE TABLE books (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  gst_registration_id uuid NOT NULL UNIQUE,
  gstin text NOT NULL UNIQUE,
  state_code text NOT NULL,
  legal_entity_id uuid NOT NULL,
  entity_name text NOT NULL,
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  is_primary boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  type text NOT NULL CHECK (type IN ('asset','liability','equity','income','expense')),
  group_name text NOT NULL,
  -- Statement placement: current/non-current for the balance sheet, direct/indirect for P&L.
  section text NOT NULL,
  system_key text UNIQUE,
  control text CHECK (control IN ('receivable','payable','inter_unit')),
  is_bank boolean NOT NULL DEFAULT false,
  eliminate_on_consolidation boolean NOT NULL DEFAULT false,
  allow_manual boolean NOT NULL DEFAULT true,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  created_by_name text, created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE periods (
  month date PRIMARY KEY CHECK (extract(day FROM month) = 1),
  fy text NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','locked')),
  locked_by_name text, locked_at timestamptz, note text
);

CREATE TABLE vouchers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number text NOT NULL UNIQUE,
  voucher_type text NOT NULL CHECK (voucher_type IN ('journal','sales','purchase','receipt','payment','contra','credit_note','debit_note','transfer','opening','closing','payroll')),
  book_id uuid NOT NULL REFERENCES books(id),
  voucher_date date NOT NULL,
  narration text NOT NULL,
  party_id uuid, party_name text,
  amount numeric NOT NULL CHECK (amount > 0),
  source_service text NOT NULL DEFAULT 'finance', source_type text, source_id text, source_ref text,
  status text NOT NULL CHECK (status IN ('pending_approval','posted','rejected','reversed')),
  reversal_of uuid REFERENCES vouchers(id), reversed_by uuid REFERENCES vouchers(id),
  manual boolean NOT NULL DEFAULT false,
  created_by_name text NOT NULL, approved_by_name text, posted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX vouchers_source ON vouchers (source_service, source_type, source_id) WHERE source_id IS NOT NULL AND status <> 'rejected';
CREATE INDEX vouchers_date ON vouchers (voucher_date);

CREATE TABLE voucher_lines (
  id bigserial PRIMARY KEY,
  voucher_id uuid NOT NULL REFERENCES vouchers(id),
  line_no int NOT NULL,
  account_id uuid NOT NULL REFERENCES accounts(id),
  party_id uuid, party_name text,
  debit numeric NOT NULL DEFAULT 0 CHECK (debit >= 0),
  credit numeric NOT NULL DEFAULT 0 CHECK (credit >= 0),
  bill_ref text,
  narration text,
  CHECK ((debit > 0) <> (credit > 0))
);
CREATE INDEX voucher_lines_account ON voucher_lines (account_id);
CREATE INDEX voucher_lines_party ON voucher_lines (party_id) WHERE party_id IS NOT NULL;

-- Posted entries are permanent; corrections are reversing vouchers.
CREATE FUNCTION fin_lines_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM vouchers WHERE id = OLD.voucher_id AND status IN ('posted','reversed')) THEN
    RAISE EXCEPTION 'posted voucher lines cannot be changed (% blocked)', TG_OP USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER voucher_lines_guard BEFORE UPDATE OR DELETE ON voucher_lines FOR EACH ROW EXECUTE FUNCTION fin_lines_guard();
CREATE FUNCTION fin_voucher_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'vouchers cannot be deleted' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF OLD.status IN ('posted','reversed') AND (NEW.amount <> OLD.amount OR NEW.voucher_date <> OLD.voucher_date OR NEW.book_id <> OLD.book_id OR NEW.number <> OLD.number
      OR NOT (OLD.status = 'posted' AND NEW.status IN ('posted','reversed'))) THEN
    RAISE EXCEPTION 'posted vouchers cannot be changed; post a reversal' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER vouchers_guard BEFORE UPDATE OR DELETE ON vouchers FOR EACH ROW EXECUTE FUNCTION fin_voucher_guard();

-- Receivable and payable documents with due dates. Settlement is first-in-first-out against the party balance.
CREATE TABLE bills (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('receivable','payable')),
  book_id uuid NOT NULL REFERENCES books(id),
  party_id uuid NOT NULL, party_name text NOT NULL,
  doc_no text NOT NULL, doc_date date NOT NULL, due_date date NOT NULL,
  amount numeric NOT NULL,
  voucher_id uuid NOT NULL REFERENCES vouchers(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (kind, party_id, doc_no)
);

-- GST register: one row per document and rate/HSN, feeding GSTR-1, GSTR-3B and 2B reconciliation.
CREATE TABLE tax_lines (
  id bigserial PRIMARY KEY,
  voucher_id uuid NOT NULL REFERENCES vouchers(id),
  book_id uuid NOT NULL REFERENCES books(id),
  direction text NOT NULL CHECK (direction IN ('outward','inward')),
  doc_type text NOT NULL CHECK (doc_type IN ('invoice','credit_note','debit_note','transfer')),
  doc_no text NOT NULL, doc_date date NOT NULL,
  party_id uuid, party_name text, party_gstin text,
  place_of_supply text,
  hsn text, rate numeric NOT NULL DEFAULT 0, sku text, qty_kg numeric,
  taxable numeric NOT NULL, cgst numeric NOT NULL DEFAULT 0, sgst numeric NOT NULL DEFAULT 0, igst numeric NOT NULL DEFAULT 0,
  reverse_charge boolean NOT NULL DEFAULT false,
  itc_eligible boolean NOT NULL DEFAULT true,
  irn text
);
CREATE INDEX tax_lines_period ON tax_lines (book_id, doc_date);

CREATE TABLE gstr2b_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  book_id uuid NOT NULL REFERENCES books(id),
  period date NOT NULL,
  supplier_gstin text NOT NULL, supplier_name text,
  invoice_no text NOT NULL, invoice_date date,
  taxable numeric NOT NULL, igst numeric NOT NULL DEFAULT 0, cgst numeric NOT NULL DEFAULT 0, sgst numeric NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'unmatched' CHECK (status IN ('matched','amount_mismatch','not_in_books','unmatched')),
  matched_doc_no text, difference numeric, imported_by_name text, imported_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (book_id, supplier_gstin, invoice_no)
);

CREATE TABLE tds_sections (
  code text PRIMARY KEY,
  description text NOT NULL,
  rate_company numeric NOT NULL, rate_individual numeric NOT NULL, rate_no_pan numeric NOT NULL DEFAULT 20,
  threshold_single numeric NOT NULL DEFAULT 0, threshold_annual numeric NOT NULL DEFAULT 0,
  -- 194Q: tax on the amount above the annual threshold; others: on the whole amount once a threshold is crossed.
  on_excess boolean NOT NULL DEFAULT false,
  effective_from date NOT NULL, effective_to date,
  updated_by_name text, updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE party_tax (
  party_id uuid PRIMARY KEY,
  party_name text NOT NULL,
  pan text,
  tds_section text REFERENCES tds_sections(code),
  lower_rate numeric, lower_cert_no text, lower_valid_to date,
  updated_by_name text, updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE tds_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  voucher_id uuid NOT NULL REFERENCES vouchers(id),
  book_id uuid NOT NULL REFERENCES books(id),
  party_id uuid NOT NULL, party_name text NOT NULL, pan text,
  section text NOT NULL, base_amount numeric NOT NULL, rate numeric NOT NULL, tds_amount numeric NOT NULL,
  deducted_on date NOT NULL,
  challan_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE tds_challans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  section text NOT NULL, month date NOT NULL,
  amount numeric NOT NULL CHECK (amount > 0),
  bsr_code text NOT NULL, challan_no text NOT NULL, paid_on date NOT NULL,
  voucher_id uuid REFERENCES vouchers(id),
  created_by_name text, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (bsr_code, challan_no, paid_on)
);

CREATE TABLE bank_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL UNIQUE REFERENCES accounts(id),
  book_id uuid NOT NULL REFERENCES books(id),
  bank_name text NOT NULL, account_no text NOT NULL, ifsc text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE bank_statements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bank_account_id uuid NOT NULL REFERENCES bank_accounts(id),
  file_name text, from_date date, to_date date,
  lines int NOT NULL DEFAULT 0, duplicates int NOT NULL DEFAULT 0, auto_matched int NOT NULL DEFAULT 0,
  imported_by_name text, created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE bank_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  statement_id uuid NOT NULL REFERENCES bank_statements(id),
  bank_account_id uuid NOT NULL REFERENCES bank_accounts(id),
  txn_date date NOT NULL, description text NOT NULL, ref text,
  debit numeric NOT NULL DEFAULT 0, credit numeric NOT NULL DEFAULT 0, balance numeric,
  fingerprint text NOT NULL,
  status text NOT NULL DEFAULT 'unmatched' CHECK (status IN ('unmatched','matched','duplicate','ignored')),
  voucher_id uuid REFERENCES vouchers(id),
  matched_by_name text, matched_at timestamptz, note text
);
CREATE UNIQUE INDEX bank_lines_once ON bank_lines (bank_account_id, fingerprint) WHERE status <> 'duplicate';
CREATE UNIQUE INDEX bank_lines_voucher ON bank_lines (voucher_id) WHERE voucher_id IS NOT NULL;

CREATE TABLE stock_valuations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  month date NOT NULL,
  book_id uuid NOT NULL REFERENCES books(id),
  method text NOT NULL,
  value numeric NOT NULL,
  kg numeric NOT NULL,
  detail jsonb NOT NULL,
  voucher_id uuid REFERENCES vouchers(id),
  created_by_name text, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (month, book_id)
);

CREATE TABLE anomalies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL,
  severity text NOT NULL CHECK (severity IN ('info','warning','critical')),
  ref_type text NOT NULL, ref_id text NOT NULL, ref_label text,
  message text NOT NULL,
  amount numeric,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved','dismissed')),
  resolution text, resolved_by_name text, resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX anomalies_once ON anomalies (kind, ref_id) WHERE status = 'open';

-- Parties whose bank details changed recently (from masters approvals), for the payment check.
CREATE TABLE bank_changes (
  party_id uuid NOT NULL, changed_at timestamptz NOT NULL DEFAULT now(), detail text
);

CREATE TABLE counters (doc_type text PRIMARY KEY, next_number int NOT NULL);
