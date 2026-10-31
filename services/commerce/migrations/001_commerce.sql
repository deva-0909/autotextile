CREATE TABLE counters (doc_type text PRIMARY KEY, next_number int NOT NULL DEFAULT 1);

-- Token (booking advance) rules. The most specific active policy wins: customer > product > category > campaign > global.
-- Percent policies apply to the taxable value excluding GST (CA to validate the GST treatment of advances).
CREATE TABLE token_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  scope text NOT NULL CHECK (scope IN ('global','category','product','customer','campaign')),
  scope_ref uuid, scope_label text,
  basis text NOT NULL CHECK (basis IN ('percent','fixed')),
  value numeric NOT NULL CHECK (value >= 0),
  min_amount numeric, max_amount numeric,
  validity_days int NOT NULL DEFAULT 7 CHECK (validity_days > 0),
  refundable boolean NOT NULL DEFAULT true,
  cancellation_fee_pct numeric NOT NULL DEFAULT 0 CHECK (cancellation_fee_pct BETWEEN 0 AND 100),
  valid_from date, valid_to date,
  status text NOT NULL DEFAULT 'pending_approval' CHECK (status IN ('pending_approval','active','rejected','inactive')),
  reason text,
  requested_by uuid, requested_by_name text, decided_by_name text, decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (scope = 'global' OR scope = 'campaign' OR scope_ref IS NOT NULL),
  CHECK (basis <> 'percent' OR value <= 100)
);

CREATE TABLE customer_settings (
  customer_id uuid PRIMARY KEY,
  order_approval_limit numeric CHECK (order_approval_limit IS NULL OR order_approval_limit >= 0),
  default_ship_to text,
  updated_by_name text, updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE registrations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number text NOT NULL UNIQUE,
  company_name text NOT NULL, gstin text, state_code text, city text, address text,
  contact_name text NOT NULL, email text NOT NULL, phone text NOT NULL,
  message text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  customer_id uuid, user_id uuid,
  decided_by_name text, decided_at timestamptz, note text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE cart_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL, customer_id uuid NOT NULL,
  product_id uuid NOT NULL, lot_id uuid NOT NULL,
  kg numeric NOT NULL CHECK (kg > 0),
  added_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, lot_id)
);

CREATE TABLE orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number text NOT NULL UNIQUE,
  customer_id uuid NOT NULL, customer_name text NOT NULL, customer_gstin text, customer_state_code text,
  channel text NOT NULL CHECK (channel IN ('portal','crm_quotation','internal')),
  source_ref text, source_id uuid,
  placed_by uuid, placed_by_name text,
  status text NOT NULL CHECK (status IN ('pending_company_approval','awaiting_allocation','pending_payment','booked','in_fulfilment','partially_dispatched','dispatched','delivered','cancelled','expired')),
  payment_terms text NOT NULL CHECK (payment_terms IN ('advance','credit')),
  kg numeric NOT NULL DEFAULT 0, taxable numeric NOT NULL DEFAULT 0, tax_estimate numeric NOT NULL DEFAULT 0, total_estimate numeric NOT NULL DEFAULT 0,
  token_amount numeric NOT NULL DEFAULT 0, token_policy_text text, token_refundable boolean NOT NULL DEFAULT true, token_cancellation_fee_pct numeric NOT NULL DEFAULT 0,
  token_due_at timestamptz, token_paid_at timestamptz,
  reservation_expires_at timestamptz,
  company_approved_by_name text, company_approved_at timestamptz,
  ship_to text, notes text,
  cancelled_reason text, cancelled_by_name text, cancelled_at timestamptz,
  version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX orders_customer ON orders (customer_id, created_at DESC);
CREATE UNIQUE INDEX orders_source ON orders (channel, source_id) WHERE source_id IS NOT NULL;

CREATE TABLE order_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  line_no int NOT NULL,
  product_id uuid NOT NULL, sku text NOT NULL, product_name text NOT NULL, category text, hsn_code text, gst_rate numeric NOT NULL DEFAULT 5,
  lot_id uuid, lot_no text,
  kg numeric NOT NULL CHECK (kg > 0),
  price_per_kg numeric NOT NULL CHECK (price_per_kg > 0),
  taxable numeric NOT NULL
);

-- Gateway payments. Status changes only after the signed callback AND a server-side status check agree.
CREATE TABLE payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number text NOT NULL UNIQUE,
  customer_id uuid NOT NULL, customer_name text NOT NULL,
  order_id uuid REFERENCES orders(id),
  purpose text NOT NULL CHECK (purpose IN ('token','invoice','advance')),
  ref_no text,
  amount numeric NOT NULL CHECK (amount > 0),
  status text NOT NULL DEFAULT 'created' CHECK (status IN ('created','success','failed','expired','refunded','partially_refunded')),
  gateway text NOT NULL,
  gateway_order_id text NOT NULL UNIQUE,
  gateway_txn_id text UNIQUE,
  utr text,
  link_token text NOT NULL UNIQUE,
  link_expires_at timestamptz NOT NULL,
  verified_at timestamptz,
  failure_reason text,
  refunded_amount numeric NOT NULL DEFAULT 0,
  created_by_name text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX payments_order ON payments (order_id);

CREATE TABLE payment_events (
  id bigserial PRIMARY KEY,
  payment_id uuid REFERENCES payments(id),
  kind text NOT NULL CHECK (kind IN ('created','webhook','verified','refund','expired','rejected')),
  signature_ok boolean,
  detail jsonb,
  at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE refunds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id uuid NOT NULL REFERENCES payments(id),
  amount numeric NOT NULL CHECK (amount > 0),
  reason text NOT NULL,
  status text NOT NULL CHECK (status IN ('success','failed')),
  gateway_refund_id text,
  created_by_name text, created_at timestamptz NOT NULL DEFAULT now()
);

-- Stand-in for the bank's own records in sandbox mode, so verification is a real second check.
CREATE TABLE gateway_sandbox (
  gateway_order_id text PRIMARY KEY,
  amount numeric NOT NULL,
  status text NOT NULL DEFAULT 'created',
  txn_id text, utr text, paid_at timestamptz, refunded numeric NOT NULL DEFAULT 0
);

-- Customer advance (wallet). Money received is a liability until applied to an invoice; it is never revenue here.
CREATE TABLE wallet_ledger (
  id bigserial PRIMARY KEY,
  customer_id uuid NOT NULL, customer_name text NOT NULL,
  entry_type text NOT NULL CHECK (entry_type IN ('token_received','advance_received','invoice_payment_received','applied_to_invoice','cancellation_fee','refund','credit_note','reversal')),
  amount numeric NOT NULL CHECK (amount <> 0),
  order_id uuid, ref_type text, ref_no text,
  narration text,
  by_name text, at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX wallet_customer ON wallet_ledger (customer_id, id);
CREATE FUNCTION forbid_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'wallet_ledger is append-only (% blocked)', TG_OP USING ERRCODE = 'insufficient_privilege'; END $$;
CREATE TRIGGER wallet_no_update BEFORE UPDATE OR DELETE ON wallet_ledger FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER wallet_no_truncate BEFORE TRUNCATE ON wallet_ledger FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();

CREATE TABLE reservation_extensions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES orders(id),
  current_until timestamptz, requested_until timestamptz NOT NULL,
  reason text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  requested_by_name text, decided_by_name text, decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE complaints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number text NOT NULL UNIQUE,
  customer_id uuid NOT NULL, customer_name text NOT NULL,
  order_id uuid REFERENCES orders(id),
  category text NOT NULL CHECK (category IN ('quality','delivery','billing','payment','other')),
  subject text NOT NULL, description text NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','resolved','closed')),
  resolution text,
  raised_by_name text, assigned_to_name text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);

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

-- Default company-wide token: 10% of taxable value (mirrors the commerce.token_percent setting at install).
INSERT INTO token_policies (name, scope, basis, value, validity_days, refundable, cancellation_fee_pct, status, reason, decided_by_name, decided_at)
VALUES ('Company default token', 'global', 'percent', 10, 7, true, 2, 'active', 'Installed default (DEC: token % of taxable value excluding GST)', 'system', now());
