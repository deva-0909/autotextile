CREATE TABLE counters (doc_type text PRIMARY KEY, next_number int NOT NULL DEFAULT 1);

-- One allocation plan per sales order: the engine's recommendation, what was chosen, and who decided.
CREATE TABLE plans (
  order_id uuid PRIMARY KEY,
  order_no text NOT NULL,
  customer_id uuid NOT NULL, customer_name text NOT NULL, customer_state_code text,
  status text NOT NULL CHECK (status IN ('reserved','needs_decision','pending_split_approval','cancelled')),
  lines jsonb NOT NULL,
  hold_until timestamptz,
  booked boolean NOT NULL DEFAULT false,
  recommendation jsonb,
  recommended_warehouse_id uuid,
  decision_mode text CHECK (decision_mode IN ('auto','override','split','existing')),
  selected jsonb,
  decision_reason text,
  decided_by_name text, decided_at timestamptz,
  approval_status text NOT NULL DEFAULT 'none' CHECK (approval_status IN ('none','pending','approved','rejected')),
  approved_by_name text, approved_at timestamptz, approval_comment text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);

-- One fulfilment per warehouse per order: its own reservation, pick list, GST invoice and shipment.
CREATE TABLE fulfilments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number text NOT NULL UNIQUE,
  order_id uuid NOT NULL REFERENCES plans(order_id), order_no text NOT NULL,
  customer_id uuid NOT NULL, customer_name text NOT NULL, customer_state_code text, customer_gstin text,
  warehouse_id uuid NOT NULL, warehouse_code text NOT NULL, warehouse_name text NOT NULL, warehouse_state_code text NOT NULL, gst_registration_id uuid NOT NULL, gstin text NOT NULL,
  reservation_id uuid, reservation_no text,
  status text NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved','released','picking','picked','packed','invoiced','dispatched','delivered','cancelled')),
  payment_terms text NOT NULL DEFAULT 'advance' CHECK (payment_terms IN ('advance','credit')),
  picked_kg numeric NOT NULL DEFAULT 0, picked_rolls int NOT NULL DEFAULT 0,
  packages int, gross_kg numeric,
  invoice_no text UNIQUE, invoice_date date,
  taxable numeric NOT NULL DEFAULT 0, cgst numeric NOT NULL DEFAULT 0, sgst numeric NOT NULL DEFAULT 0, igst numeric NOT NULL DEFAULT 0, invoice_total numeric NOT NULL DEFAULT 0,
  amount_settled numeric NOT NULL DEFAULT 0,
  gate_payment text NOT NULL DEFAULT 'pending' CHECK (gate_payment IN ('pending','paid','credit','override')),
  gate_override_status text NOT NULL DEFAULT 'none' CHECK (gate_override_status IN ('none','pending','approved','rejected')),
  gate_override_reason text, gate_override_by_name text,
  dispatched_at timestamptz, delivered_at timestamptz,
  cancelled_reason text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX fulfilments_order ON fulfilments (order_id);
CREATE INDEX fulfilments_status ON fulfilments (warehouse_id, status);

CREATE TABLE fulfilment_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fulfilment_id uuid NOT NULL REFERENCES fulfilments(id) ON DELETE CASCADE,
  order_line_id uuid NOT NULL,
  product_id uuid NOT NULL, sku text NOT NULL, product_name text NOT NULL, hsn_code text, gst_rate numeric NOT NULL,
  lot_id uuid,
  kg_planned numeric NOT NULL CHECK (kg_planned > 0),
  price_per_kg numeric NOT NULL
);

CREATE TABLE invoice_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fulfilment_id uuid NOT NULL REFERENCES fulfilments(id) ON DELETE CASCADE,
  line_no int NOT NULL,
  product_id uuid NOT NULL, sku text NOT NULL, product_name text NOT NULL, hsn_code text, gst_rate numeric NOT NULL,
  rolls int NOT NULL, kg numeric NOT NULL, price_per_kg numeric NOT NULL,
  taxable numeric NOT NULL, tax numeric NOT NULL,
  barcodes text[] NOT NULL
);

CREATE TABLE freight_rates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transporter_id uuid NOT NULL, transporter_name text NOT NULL,
  mode text NOT NULL CHECK (mode IN ('FTL','PTL')),
  from_state text NOT NULL, to_state text NOT NULL,
  rate_per_kg numeric NOT NULL CHECK (rate_per_kg >= 0),
  min_charge numeric NOT NULL DEFAULT 0,
  eta_days int NOT NULL CHECK (eta_days > 0),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  created_by_name text, created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE shipments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number text NOT NULL UNIQUE,
  fulfilment_id uuid NOT NULL UNIQUE REFERENCES fulfilments(id),
  order_id uuid NOT NULL, customer_id uuid NOT NULL, customer_name text NOT NULL,
  transporter_id uuid, transporter_name text NOT NULL,
  mode text NOT NULL CHECK (mode IN ('FTL','PTL','own_vehicle','customer_pickup')),
  vehicle_no text, driver_name text, driver_phone text,
  lr_number text, eway_bill_no text,
  freight_amount numeric NOT NULL DEFAULT 0,
  kg numeric NOT NULL, rolls int NOT NULL, packages int,
  eta_date date,
  status text NOT NULL DEFAULT 'in_transit' CHECK (status IN ('in_transit','out_for_delivery','delivered','exception')),
  tracking_token text NOT NULL UNIQUE,
  dispatched_at timestamptz NOT NULL DEFAULT now(), delivered_at timestamptz,
  pod_received_by text, pod_kg numeric, pod_condition text CHECK (pod_condition IN ('ok','short','damaged')), pod_remarks text, pod_source text CHECK (pod_source IN ('customer_portal','internal')), pod_at timestamptz,
  created_by_name text
);

CREATE TABLE shipment_events (
  id bigserial PRIMARY KEY,
  shipment_id uuid NOT NULL REFERENCES shipments(id),
  milestone text NOT NULL CHECK (milestone IN ('dispatched','picked_up','in_transit','reached_hub','out_for_delivery','delivered','exception')),
  location text, note text,
  source text NOT NULL DEFAULT 'internal',
  by_name text, at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE transport_claims (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number text NOT NULL UNIQUE,
  shipment_id uuid NOT NULL REFERENCES shipments(id),
  transporter_name text NOT NULL,
  claim_type text NOT NULL CHECK (claim_type IN ('short','damage','delay')),
  kg numeric, amount numeric NOT NULL DEFAULT 0,
  description text NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','filed','settled','rejected','closed')),
  settlement_amount numeric, resolution text,
  created_by_name text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE returns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number text NOT NULL UNIQUE,
  order_id uuid NOT NULL, order_no text NOT NULL,
  fulfilment_id uuid NOT NULL REFERENCES fulfilments(id),
  customer_id uuid NOT NULL, customer_name text NOT NULL,
  reason text NOT NULL,
  status text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','authorized','rejected','received','inspected','closed')),
  resolution text CHECK (resolution IN ('credit_note','replacement')),
  source text NOT NULL CHECK (source IN ('customer_portal','internal')),
  requested_by_name text, authorized_by_name text, authorized_at timestamptz, decision_note text,
  warehouse_id uuid, received_at timestamptz,
  credit_note_no text, credit_taxable numeric, credit_tax numeric, credit_total numeric,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE return_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  return_id uuid NOT NULL REFERENCES returns(id) ON DELETE CASCADE,
  barcode text NOT NULL,
  sku text NOT NULL, kg numeric NOT NULL, price_per_kg numeric NOT NULL, gst_rate numeric NOT NULL,
  received boolean NOT NULL DEFAULT false,
  disposition text CHECK (disposition IN ('restock','hold','reject')),
  UNIQUE (return_id, barcode)
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
