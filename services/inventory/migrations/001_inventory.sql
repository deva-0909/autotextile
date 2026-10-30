CREATE TABLE counters (doc_type text PRIMARY KEY, next_number int NOT NULL DEFAULT 1);

-- Material expected at a warehouse (from a goods receipt, a mill return or opening stock) that is
-- weighed and scanned roll by roll. Expected kg comes from the source document.
CREATE TABLE inwards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number text NOT NULL UNIQUE,
  source_type text NOT NULL CHECK (source_type IN ('po_receipt','job_return','opening')),
  source_id uuid,
  source_ref text NOT NULL,
  source_event_key text UNIQUE,
  party_name text,
  warehouse_id uuid NOT NULL, warehouse_name text NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','completed','cancelled')),
  expected_date date NOT NULL,
  notes text,
  completed_at timestamptz, completed_by_name text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX inwards_open ON inwards (warehouse_id, status);

CREATE TABLE inward_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  inward_id uuid NOT NULL REFERENCES inwards(id) ON DELETE CASCADE,
  line_no int NOT NULL,
  product_id uuid NOT NULL, sku text NOT NULL, product_name text NOT NULL, hsn_code text, gst_rate numeric,
  expected_kg numeric NOT NULL CHECK (expected_kg >= 0),
  expected_rolls int,
  cost_per_kg numeric,
  lot_ref text,
  parent_lot_ids uuid[] NOT NULL DEFAULT '{}',
  lot_id uuid
);

-- A lot is one batch of one SKU from one source: the unit for shade, grade, price and genealogy.
CREATE TABLE lots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lot_no text NOT NULL UNIQUE,
  product_id uuid NOT NULL, sku text NOT NULL, product_name text NOT NULL, hsn_code text, gst_rate numeric,
  source_type text NOT NULL CHECK (source_type IN ('po_receipt','job_return','opening')),
  source_id uuid, source_ref text NOT NULL, party_name text,
  inward_id uuid REFERENCES inwards(id),
  origin_warehouse_id uuid NOT NULL,
  parent_lot_ids uuid[] NOT NULL DEFAULT '{}',
  supplier_lot_ref text,
  shade_code text,
  dye_lot text,
  grade text CHECK (grade IN ('A','B','C','reject')),
  qc_status text NOT NULL DEFAULT 'pending' CHECK (qc_status IN ('pending','passed','partial','failed')),
  cost_per_kg numeric,
  price_per_kg numeric,
  received_date date NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX lots_product ON lots (product_id);

-- Current position of each roll. This is a projection of stock_movements, updated in the same transaction.
CREATE TABLE rolls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  barcode text NOT NULL UNIQUE,
  lot_id uuid NOT NULL REFERENCES lots(id),
  roll_no int NOT NULL,
  parent_roll_id uuid REFERENCES rolls(id),
  product_id uuid NOT NULL,
  weight_kg numeric NOT NULL CHECK (weight_kg >= 0),
  initial_kg numeric NOT NULL CHECK (initial_kg > 0),
  state text NOT NULL CHECK (state IN ('qc_hold','available','reserved','allocated','in_transit','at_mill','damaged','rejected','dispatched','consumed','written_off')),
  warehouse_id uuid,
  location_id uuid, location_path text,
  holder_ref text,
  grade text CHECK (grade IN ('A','B','C','reject')),
  gsm numeric, width_in numeric,
  shade_code text, dye_lot text,
  defects text[] NOT NULL DEFAULT '{}',
  reservation_id uuid,
  transfer_id uuid,
  last_out_at timestamptz,
  version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (lot_id, roll_no),
  CHECK (state IN ('in_transit','at_mill','dispatched','consumed','written_off') OR warehouse_id IS NOT NULL)
);
CREATE INDEX rolls_stock ON rolls (warehouse_id, product_id, state);
CREATE INDEX rolls_location ON rolls (location_id);

-- Immutable stock ledger. Every kg change is a movement from one (warehouse, state) to another;
-- balances are derived from it, never overwritten.
CREATE TABLE stock_movements (
  id bigserial PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now(),
  movement_type text NOT NULL CHECK (movement_type IN ('inward','qc','putaway','move','reserve','release','allocate','pick','transfer_out','transfer_in','issue_to_mill','consume_at_mill','split','adjust_in','adjust_out','weight_adjust','damage','write_off')),
  roll_id uuid NOT NULL REFERENCES rolls(id),
  lot_id uuid NOT NULL,
  product_id uuid NOT NULL,
  kg numeric NOT NULL CHECK (kg >= 0),
  -- false when only weight moves (split, partial consumption, weight correction), so roll counts stay right
  moves_roll boolean NOT NULL DEFAULT true,
  from_warehouse_id uuid, from_state text, from_location text,
  to_warehouse_id uuid, to_state text, to_location text,
  ref_type text, ref_id uuid, ref_no text,
  reason text,
  by_user uuid, by_name text
);
CREATE INDEX stock_movements_roll ON stock_movements (roll_id, id);
CREATE INDEX stock_movements_product ON stock_movements (product_id, at);
CREATE INDEX stock_movements_ref ON stock_movements (ref_id);

CREATE FUNCTION forbid_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'stock_movements is append-only (% blocked)', TG_OP USING ERRCODE = 'insufficient_privilege'; END $$;
CREATE TRIGGER stock_movements_no_update BEFORE UPDATE OR DELETE ON stock_movements FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER stock_movements_no_truncate BEFORE TRUNCATE ON stock_movements FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();

-- Balance per product, warehouse and state, derived only from movements.
CREATE VIEW stock_balances AS
SELECT product_id, warehouse_id, state, round(sum(kg), 3) AS kg, sum(rolls)::int AS rolls FROM (
  SELECT product_id, to_warehouse_id AS warehouse_id, to_state AS state, kg, CASE WHEN moves_roll THEN 1 ELSE 0 END AS rolls FROM stock_movements WHERE to_state IS NOT NULL
  UNION ALL
  SELECT product_id, from_warehouse_id, from_state, -kg, CASE WHEN moves_roll THEN -1 ELSE 0 END FROM stock_movements WHERE from_state IS NOT NULL
) m GROUP BY product_id, warehouse_id, state HAVING round(sum(kg), 3) <> 0 OR sum(rolls) <> 0;

-- Selling price per kg, by lot. Changes need a checker; history is kept.
CREATE TABLE price_tags (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lot_id uuid NOT NULL REFERENCES lots(id),
  price_per_kg numeric NOT NULL CHECK (price_per_kg > 0),
  previous_price numeric,
  cost_per_kg numeric,
  margin_pct numeric,
  status text NOT NULL CHECK (status IN ('pending','approved','rejected','superseded')),
  reason text,
  requested_by uuid, requested_by_name text, requested_at timestamptz NOT NULL DEFAULT now(),
  decided_by_name text, decided_at timestamptz, decision_comment text,
  effective_at timestamptz
);
CREATE UNIQUE INDEX price_tags_one_pending ON price_tags (lot_id) WHERE status = 'pending';

CREATE TABLE reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number text NOT NULL UNIQUE,
  ref_type text NOT NULL CHECK (ref_type IN ('manual','quotation','sales_order')),
  ref_id uuid, ref_no text,
  customer_id uuid, customer_name text,
  warehouse_id uuid NOT NULL, warehouse_name text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','picked','released','expired')),
  mixed_shade_reason text,
  expires_at timestamptz NOT NULL,
  created_by uuid, created_by_name text, created_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz, close_reason text
);

-- Customer decisions on a shade (dye lot) for a product.
CREATE TABLE shade_approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL, customer_name text NOT NULL,
  product_id uuid NOT NULL, sku text NOT NULL,
  shade_code text NOT NULL,
  decision text NOT NULL CHECK (decision IN ('accepted','rejected')),
  note text,
  recorded_by_name text, recorded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (customer_id, product_id, shade_code)
);

CREATE TABLE transfers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number text NOT NULL UNIQUE,
  from_warehouse_id uuid NOT NULL, from_warehouse_name text NOT NULL, from_gst_registration_id uuid NOT NULL, from_gstin text NOT NULL,
  to_warehouse_id uuid NOT NULL, to_warehouse_name text NOT NULL, to_gst_registration_id uuid NOT NULL, to_gstin text NOT NULL,
  inter_gstin boolean NOT NULL,
  document_type text NOT NULL CHECK (document_type IN ('tax_invoice','delivery_challan')),
  document_no text,
  status text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','pending_approval','approved','rejected','in_transit','partially_received','received','closed','cancelled')),
  reason text,
  needed_by date,
  transporter_name text, lr_number text, vehicle_no text, eway_bill_no text,
  dispatched_kg numeric NOT NULL DEFAULT 0, received_kg numeric NOT NULL DEFAULT 0,
  taxable_value numeric NOT NULL DEFAULT 0, cgst numeric NOT NULL DEFAULT 0, sgst numeric NOT NULL DEFAULT 0, igst numeric NOT NULL DEFAULT 0,
  approved_by_name text, approved_at timestamptz,
  dispatched_at timestamptz, received_at timestamptz,
  closed_at timestamptz, close_reason text,
  created_by uuid, created_by_name text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (from_warehouse_id <> to_warehouse_id)
);

CREATE TABLE transfer_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transfer_id uuid NOT NULL REFERENCES transfers(id) ON DELETE CASCADE,
  line_no int NOT NULL,
  product_id uuid NOT NULL, sku text NOT NULL, product_name text NOT NULL, hsn_code text, gst_rate numeric,
  requested_kg numeric NOT NULL CHECK (requested_kg > 0),
  lot_id uuid
);

CREATE TABLE transfer_rolls (
  transfer_id uuid NOT NULL REFERENCES transfers(id) ON DELETE CASCADE,
  roll_id uuid NOT NULL REFERENCES rolls(id),
  dispatched_kg numeric NOT NULL,
  value numeric NOT NULL DEFAULT 0,
  received_kg numeric,
  status text NOT NULL DEFAULT 'dispatched' CHECK (status IN ('dispatched','received','missing')),
  received_at timestamptz,
  PRIMARY KEY (transfer_id, roll_id)
);

CREATE TABLE stocktakes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number text NOT NULL UNIQUE,
  warehouse_id uuid NOT NULL, warehouse_name text NOT NULL,
  location_prefix text,
  status text NOT NULL DEFAULT 'counting' CHECK (status IN ('counting','submitted','approved','rejected','cancelled')),
  reason text,
  started_by_name text, started_at timestamptz NOT NULL DEFAULT now(),
  submitted_by uuid, submitted_by_name text, submitted_at timestamptz,
  decided_by_name text, decided_at timestamptz, decision_comment text,
  variance_summary jsonb
);

-- Rolls the system expected in the counted area, frozen at the start of the count.
CREATE TABLE stocktake_expected (
  stocktake_id uuid NOT NULL REFERENCES stocktakes(id) ON DELETE CASCADE,
  roll_id uuid NOT NULL REFERENCES rolls(id),
  expected_kg numeric NOT NULL,
  location_path text,
  PRIMARY KEY (stocktake_id, roll_id)
);

CREATE TABLE stocktake_counts (
  stocktake_id uuid NOT NULL REFERENCES stocktakes(id) ON DELETE CASCADE,
  barcode text NOT NULL,
  roll_id uuid REFERENCES rolls(id),
  counted_kg numeric,
  location_id uuid, location_path text,
  counted_by_name text, counted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (stocktake_id, barcode)
);

-- Rolls to be issued from a warehouse to a mill on a job-work order (scanned out).
CREATE TABLE mill_issues (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_order_id uuid NOT NULL, job_order_no text NOT NULL, mill_name text NOT NULL,
  warehouse_id uuid NOT NULL, warehouse_name text NOT NULL,
  product_id uuid NOT NULL, sku text NOT NULL,
  requested_kg numeric NOT NULL, issued_kg numeric NOT NULL DEFAULT 0, consumed_kg numeric NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','issued','closed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (job_order_id, warehouse_id, product_id)
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
