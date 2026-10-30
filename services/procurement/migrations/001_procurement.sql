-- Local fallback numbering when the organisation service has no series for a document type.
CREATE TABLE counters (doc_type text PRIMARY KEY, next_number int NOT NULL DEFAULT 1);

CREATE TABLE requisitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number text NOT NULL UNIQUE,
  title text NOT NULL,
  deliver_to_type text NOT NULL CHECK (deliver_to_type IN ('warehouse','mill')),
  deliver_to_id uuid NOT NULL,
  deliver_to_name text NOT NULL,
  required_by date NOT NULL,
  purpose text,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','submitted','approved','rejected','converted','cancelled')),
  requested_by uuid, requested_by_name text,
  decided_by uuid, decided_by_name text, decided_at timestamptz, decision_comment text,
  version int NOT NULL DEFAULT 1, created_by uuid, created_at timestamptz NOT NULL DEFAULT now(), updated_by uuid, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE requisition_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  requisition_id uuid NOT NULL REFERENCES requisitions(id) ON DELETE CASCADE,
  line_no int NOT NULL,
  product_id uuid NOT NULL, sku text NOT NULL, product_name text NOT NULL,
  qty_kg numeric NOT NULL CHECK (qty_kg > 0),
  target_rate numeric CHECK (target_rate IS NULL OR target_rate > 0),
  notes text
);

CREATE TABLE rfqs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number text NOT NULL UNIQUE,
  title text NOT NULL,
  requisition_id uuid REFERENCES requisitions(id),
  due_date date NOT NULL,
  deliver_to_type text NOT NULL CHECK (deliver_to_type IN ('warehouse','mill')),
  deliver_to_id uuid NOT NULL,
  deliver_to_name text NOT NULL,
  terms text,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','awarded','cancelled')),
  awarded_quote_id uuid,
  po_id uuid,
  version int NOT NULL DEFAULT 1, created_by uuid, created_at timestamptz NOT NULL DEFAULT now(), updated_by uuid, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE rfq_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rfq_id uuid NOT NULL REFERENCES rfqs(id) ON DELETE CASCADE,
  line_no int NOT NULL,
  product_id uuid NOT NULL, sku text NOT NULL, product_name text NOT NULL, hsn_code text NOT NULL, gst_rate numeric NOT NULL,
  qty_kg numeric NOT NULL CHECK (qty_kg > 0),
  notes text
);
CREATE TABLE rfq_suppliers (
  rfq_id uuid NOT NULL REFERENCES rfqs(id) ON DELETE CASCADE,
  supplier_id uuid NOT NULL, supplier_code text NOT NULL, supplier_name text NOT NULL,
  invited_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (rfq_id, supplier_id)
);
CREATE TABLE quotes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rfq_id uuid NOT NULL REFERENCES rfqs(id) ON DELETE CASCADE,
  supplier_id uuid NOT NULL, supplier_name text NOT NULL,
  received_via text NOT NULL DEFAULT 'manual' CHECK (received_via IN ('manual','portal')),
  quote_ref text, valid_until date,
  lead_time_days int CHECK (lead_time_days IS NULL OR lead_time_days >= 0),
  freight_per_kg numeric NOT NULL DEFAULT 0 CHECK (freight_per_kg >= 0),
  payment_terms text, quality_notes text,
  status text NOT NULL DEFAULT 'received' CHECK (status IN ('received','awarded','not_awarded')),
  created_by uuid, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (rfq_id, supplier_id)
);
CREATE TABLE quote_lines (
  quote_id uuid NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
  rfq_line_id uuid NOT NULL REFERENCES rfq_lines(id) ON DELETE CASCADE,
  rate_per_kg numeric NOT NULL CHECK (rate_per_kg > 0),
  remarks text,
  PRIMARY KEY (quote_id, rfq_line_id)
);

CREATE TABLE purchase_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number text NOT NULL UNIQUE,
  revision int NOT NULL DEFAULT 0,
  supplier_id uuid NOT NULL, supplier_code text NOT NULL, supplier_name text NOT NULL, supplier_gstin text, supplier_state text,
  bill_to_gst_registration_id uuid NOT NULL, bill_to_gstin text NOT NULL, bill_to_state text NOT NULL,
  deliver_to_type text NOT NULL CHECK (deliver_to_type IN ('warehouse','mill')),
  deliver_to_id uuid NOT NULL, deliver_to_name text NOT NULL,
  rfq_id uuid, requisition_id uuid,
  order_date date NOT NULL DEFAULT current_date,
  expected_date date NOT NULL,
  payment_term text, payment_days int NOT NULL DEFAULT 0,
  freight_terms text, notes text,
  tax_type text NOT NULL CHECK (tax_type IN ('intra','inter')),
  taxable_value numeric NOT NULL DEFAULT 0, tax_value numeric NOT NULL DEFAULT 0, total_value numeric NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','pending_approval','approved','sent','accepted','rejected_by_supplier','partially_received','received','closed','cancelled')),
  approved_by uuid, approved_by_name text, approved_at timestamptz,
  sent_at timestamptz,
  supplier_response_at timestamptz, supplier_promise_date date, supplier_remarks text,
  version int NOT NULL DEFAULT 1, created_by uuid, created_by_name text, created_at timestamptz NOT NULL DEFAULT now(), updated_by uuid, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX po_supplier ON purchase_orders (supplier_id);
CREATE TABLE po_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  po_id uuid NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  line_no int NOT NULL,
  product_id uuid NOT NULL, sku text NOT NULL, product_name text NOT NULL, hsn_code text NOT NULL,
  qty_kg numeric NOT NULL CHECK (qty_kg > 0),
  rate_per_kg numeric NOT NULL CHECK (rate_per_kg > 0),
  gst_rate numeric NOT NULL CHECK (gst_rate >= 0),
  taxable numeric NOT NULL, tax numeric NOT NULL,
  received_kg numeric NOT NULL DEFAULT 0,
  rejected_kg numeric NOT NULL DEFAULT 0,
  invoiced_kg numeric NOT NULL DEFAULT 0,
  notes text
);
CREATE TABLE po_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  po_id uuid NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  revision int NOT NULL,
  snapshot jsonb NOT NULL,
  reason text NOT NULL,
  created_by_name text, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE po_events (
  id bigserial PRIMARY KEY,
  po_id uuid NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  event text NOT NULL,
  detail text,
  actor_type text NOT NULL DEFAULT 'user' CHECK (actor_type IN ('user','supplier','mill','system')),
  actor_name text,
  at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE dispatches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  po_id uuid NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  dispatch_date date NOT NULL,
  kg numeric NOT NULL CHECK (kg > 0),
  rolls int,
  lr_number text, transporter_name text, vehicle_no text, eway_bill_no text,
  reported_via text NOT NULL CHECK (reported_via IN ('buyer','supplier_portal')),
  reported_by_name text,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number text NOT NULL UNIQUE,
  po_id uuid NOT NULL REFERENCES purchase_orders(id),
  receipt_type text NOT NULL CHECK (receipt_type IN ('warehouse','mill')),
  location_id uuid NOT NULL, location_name text NOT NULL,
  receipt_date date NOT NULL,
  challan_no text, lr_number text,
  source text NOT NULL DEFAULT 'internal' CHECK (source IN ('internal','mill_portal')),
  recorded_by_name text,
  notes text,
  created_by uuid, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE receipt_lines (
  receipt_id uuid NOT NULL REFERENCES receipts(id) ON DELETE CASCADE,
  po_line_id uuid NOT NULL REFERENCES po_lines(id),
  received_kg numeric NOT NULL CHECK (received_kg >= 0),
  rejected_kg numeric NOT NULL DEFAULT 0 CHECK (rejected_kg >= 0),
  rolls int,
  remarks text,
  PRIMARY KEY (receipt_id, po_line_id),
  CHECK (rejected_kg <= received_kg)
);

CREATE TABLE supplier_invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_id uuid NOT NULL, supplier_name text NOT NULL, supplier_gstin text,
  invoice_number text NOT NULL,
  invoice_date date NOT NULL,
  po_id uuid REFERENCES purchase_orders(id),
  capture_id uuid,
  document_id uuid,
  taxable_value numeric NOT NULL CHECK (taxable_value >= 0),
  cgst numeric NOT NULL DEFAULT 0, sgst numeric NOT NULL DEFAULT 0, igst numeric NOT NULL DEFAULT 0,
  total_value numeric NOT NULL CHECK (total_value >= 0),
  due_date date,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','pending_approval','posted','rejected')),
  match_status text NOT NULL DEFAULT 'not_run' CHECK (match_status IN ('not_run','matched','variance','no_po','no_receipt')),
  match_result jsonb NOT NULL DEFAULT '[]',
  hold_reason text,
  posted_by uuid, posted_by_name text, posted_at timestamptz,
  payment_status text NOT NULL DEFAULT 'unpaid' CHECK (payment_status IN ('unpaid','approved','paid')),
  payment_approved_by_name text, payment_approved_at timestamptz,
  version int NOT NULL DEFAULT 1, created_by uuid, created_by_name text, created_at timestamptz NOT NULL DEFAULT now(), updated_by uuid, updated_at timestamptz NOT NULL DEFAULT now()
);
-- Duplicate control: one invoice number per supplier (ignoring case and spaces).
CREATE UNIQUE INDEX supplier_invoice_unique ON supplier_invoices (supplier_id, upper(regexp_replace(invoice_number, '\s', '', 'g'))) WHERE status <> 'rejected';
CREATE TABLE invoice_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id uuid NOT NULL REFERENCES supplier_invoices(id) ON DELETE CASCADE,
  line_no int NOT NULL,
  po_line_id uuid REFERENCES po_lines(id),
  description text NOT NULL,
  hsn_code text,
  qty_kg numeric NOT NULL CHECK (qty_kg >= 0),
  rate numeric NOT NULL CHECK (rate >= 0),
  taxable numeric NOT NULL,
  gst_rate numeric NOT NULL DEFAULT 0
);

-- Accounts payable sub-ledger. credit = amount owed to the supplier.
CREATE TABLE ap_ledger (
  id bigserial PRIMARY KEY,
  supplier_id uuid NOT NULL, supplier_name text NOT NULL,
  entry_date date NOT NULL,
  doc_type text NOT NULL CHECK (doc_type IN ('invoice','debit_note','payment','opening')),
  doc_id uuid, doc_number text,
  debit numeric NOT NULL DEFAULT 0, credit numeric NOT NULL DEFAULT 0,
  due_date date,
  narration text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ap_supplier ON ap_ledger (supplier_id, entry_date);
CREATE FUNCTION ap_ledger_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'ap_ledger is append-only; post a reversing entry instead'; END $$;
CREATE TRIGGER ap_ledger_no_change BEFORE UPDATE OR DELETE ON ap_ledger FOR EACH ROW EXECUTE FUNCTION ap_ledger_immutable();

CREATE TABLE capture_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  created_by uuid, created_by_name text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE invoice_captures (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id uuid NOT NULL REFERENCES capture_batches(id),
  document_id uuid NOT NULL,
  file_name text NOT NULL,
  mime_type text NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','extracting','needs_review','approved','rejected','failed')),
  extractor text,
  extraction jsonb,
  data jsonb,
  warnings jsonb NOT NULL DEFAULT '[]',
  confidence numeric,
  attempts int NOT NULL DEFAULT 0,
  error text,
  extraction_ms int,
  history jsonb NOT NULL DEFAULT '[]',
  invoice_id uuid REFERENCES supplier_invoices(id),
  reviewed_by uuid, reviewed_by_name text, reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX captures_queue ON invoice_captures (status, created_at);

CREATE TABLE exceptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL,
  severity text NOT NULL CHECK (severity IN ('info','warning','critical')),
  ref_type text NOT NULL, ref_id uuid NOT NULL, ref_label text,
  message text NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved','dismissed')),
  detected_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz, resolved_by_name text, resolution text
);
CREATE UNIQUE INDEX exceptions_open ON exceptions (kind, ref_id) WHERE status = 'open';
