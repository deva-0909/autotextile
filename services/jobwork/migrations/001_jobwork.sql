CREATE TABLE counters (doc_type text PRIMARY KEY, next_number int NOT NULL DEFAULT 1);

-- Process route templates; stages are configurable per process.
CREATE TABLE process_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE CHECK (code ~ '^[A-Z0-9_]{2,24}$'),
  name text NOT NULL,
  description text,
  stages jsonb NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  version int NOT NULL DEFAULT 1, created_by uuid, created_at timestamptz NOT NULL DEFAULT now(), updated_by uuid, updated_at timestamptz NOT NULL DEFAULT now()
);

-- Rate cards are never edited: a new rate is a new row with its own effective date (rate history).
CREATE TABLE rate_cards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mill_id uuid NOT NULL, mill_name text NOT NULL,
  process_code text NOT NULL REFERENCES process_templates(code),
  product_id uuid, product_label text,
  category_id uuid, category_label text,
  basis text NOT NULL CHECK (basis IN ('per_kg','fixed','slab')),
  rate numeric CHECK (rate IS NULL OR rate >= 0),
  slabs jsonb,
  min_charge numeric NOT NULL DEFAULT 0 CHECK (min_charge >= 0),
  negotiated boolean NOT NULL DEFAULT false,
  effective_from date NOT NULL,
  effective_to date,
  notes text,
  created_by_name text, created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (basis = 'slab' OR rate IS NOT NULL),
  CHECK (basis <> 'slab' OR slabs IS NOT NULL),
  CHECK (effective_to IS NULL OR effective_to >= effective_from)
);
CREATE INDEX rate_cards_lookup ON rate_cards (mill_id, process_code, effective_from DESC);

-- Trader-owned grey fabric lying at a mill (from direct-to-mill purchases), separate from warehouse stock.
CREATE TABLE mill_stock (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mill_id uuid NOT NULL, mill_name text NOT NULL,
  source_type text NOT NULL CHECK (source_type IN ('po_receipt')),
  source_ref text NOT NULL,
  receipt_id uuid,
  po_id uuid, po_number text, supplier_name text,
  product_id uuid NOT NULL, sku text NOT NULL, product_name text NOT NULL,
  kg_in numeric NOT NULL CHECK (kg_in > 0),
  kg_allocated numeric NOT NULL DEFAULT 0 CHECK (kg_allocated >= 0),
  rolls int,
  received_date date NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (kg_allocated <= kg_in + 0.001)
);
CREATE UNIQUE INDEX mill_stock_receipt_line ON mill_stock (receipt_id, product_id);

CREATE TABLE job_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number text NOT NULL UNIQUE,
  mill_id uuid NOT NULL, mill_code text NOT NULL, mill_name text NOT NULL, mill_gstin text,
  process_code text NOT NULL, process_name text NOT NULL,
  stages jsonb NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','issued','acknowledged','in_process','ready','partially_returned','returned','closed','cancelled')),
  issue_date date,
  expected_return_date date NOT NULL,
  internal_due_date date,
  statutory_due_date date,
  instructions text,
  transporter_name text, lr_number text, vehicle_no text, eway_bill_no text,
  estimated_charge numeric NOT NULL DEFAULT 0,
  rate_summary text,
  ack_at timestamptz, ack_kg numeric, ack_discrepancy_kg numeric, ack_remarks text, ack_by_name text, ack_source text CHECK (ack_source IN ('mill_portal','internal')),
  current_stage text,
  ready_at timestamptz,
  kg_sent numeric NOT NULL DEFAULT 0,
  kg_good numeric NOT NULL DEFAULT 0, kg_rejected numeric NOT NULL DEFAULT 0, kg_damaged numeric NOT NULL DEFAULT 0, kg_process_loss numeric NOT NULL DEFAULT 0,
  processing_charge numeric NOT NULL DEFAULT 0,
  closed_at timestamptz, close_reason text,
  version int NOT NULL DEFAULT 1, created_by uuid, created_by_name text, created_at timestamptz NOT NULL DEFAULT now(), updated_by uuid, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX job_orders_mill ON job_orders (mill_id, status);

CREATE TABLE job_order_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_order_id uuid NOT NULL REFERENCES job_orders(id) ON DELETE CASCADE,
  line_no int NOT NULL,
  source text NOT NULL CHECK (source IN ('mill_stock','warehouse')),
  mill_stock_id uuid REFERENCES mill_stock(id),
  warehouse_id uuid, warehouse_name text,
  product_id uuid NOT NULL, sku text NOT NULL, product_name text NOT NULL, category_id uuid,
  lot_ref text,
  rolls int,
  kg_sent numeric NOT NULL CHECK (kg_sent > 0),
  rate_card_id uuid REFERENCES rate_cards(id),
  estimated_charge numeric NOT NULL DEFAULT 0,
  CHECK ((source = 'mill_stock') = (mill_stock_id IS NOT NULL))
);

CREATE TABLE stage_updates (
  id bigserial PRIMARY KEY,
  job_order_id uuid NOT NULL REFERENCES job_orders(id) ON DELETE CASCADE,
  stage_code text NOT NULL, stage_name text NOT NULL,
  status text NOT NULL CHECK (status IN ('started','completed','qc_passed','qc_failed','on_hold')),
  kg numeric,
  note text,
  source text NOT NULL CHECK (source IN ('mill_portal','internal')),
  by_name text,
  at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE job_returns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_order_id uuid NOT NULL REFERENCES job_orders(id),
  return_date date NOT NULL,
  warehouse_id uuid NOT NULL, warehouse_name text NOT NULL,
  mill_challan_no text, lr_number text,
  kg_good numeric NOT NULL DEFAULT 0 CHECK (kg_good >= 0),
  kg_rejected numeric NOT NULL DEFAULT 0 CHECK (kg_rejected >= 0),
  kg_damaged numeric NOT NULL DEFAULT 0 CHECK (kg_damaged >= 0),
  kg_process_loss numeric NOT NULL DEFAULT 0 CHECK (kg_process_loss >= 0),
  rolls int,
  lot_ref text,
  loss_reason text,
  charge numeric NOT NULL DEFAULT 0,
  created_by_name text, created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE quality_claims (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number text NOT NULL UNIQUE,
  job_order_id uuid NOT NULL REFERENCES job_orders(id),
  mill_id uuid NOT NULL, mill_name text NOT NULL,
  defect_types text[] NOT NULL DEFAULT '{}',
  description text NOT NULL,
  kg_affected numeric NOT NULL CHECK (kg_affected > 0),
  samples text,
  root_cause text,
  responsibility text NOT NULL DEFAULT 'undetermined' CHECK (responsibility IN ('mill','supplier','internal','undetermined')),
  claim_type text NOT NULL DEFAULT 'debit_note' CHECK (claim_type IN ('debit_note','rework','replacement','none')),
  amount numeric NOT NULL DEFAULT 0 CHECK (amount >= 0),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','under_review','accepted','rejected','closed')),
  mill_response text, mill_response_at timestamptz,
  resolution text,
  raised_by_name text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), closed_at timestamptz
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

INSERT INTO process_templates (code, name, description, stages) VALUES
 ('REACTIVE_DYE', 'Reactive dyeing', 'Cotton reactive dyeing with finishing', '[{"code":"INSPECTION","name":"Grey inspection"},{"code":"PRETREATMENT","name":"Pretreatment (scouring / bleaching)"},{"code":"DYEING","name":"Dyeing"},{"code":"WASHING","name":"Soaping & washing"},{"code":"FINISHING","name":"Finishing"},{"code":"COMPACTING","name":"Compacting"},{"code":"FINAL_QC","name":"Final QC"},{"code":"PACKING","name":"Packing"}]'),
 ('RFD', 'RFD (ready for dyeing)', 'Scouring and bleaching only', '[{"code":"INSPECTION","name":"Grey inspection"},{"code":"PRETREATMENT","name":"Scouring & bleaching"},{"code":"FINAL_QC","name":"Final QC"},{"code":"PACKING","name":"Packing"}]'),
 ('COMPACT_ONLY', 'Compacting only', 'Open-width or tubular compacting', '[{"code":"INSPECTION","name":"Inspection"},{"code":"COMPACTING","name":"Compacting"},{"code":"FINAL_QC","name":"Final QC"},{"code":"PACKING","name":"Packing"}]'),
 ('PRINTING', 'Printing', 'Rotary / table printing on RFD fabric', '[{"code":"INSPECTION","name":"Inspection"},{"code":"PRINTING","name":"Printing"},{"code":"CURING","name":"Curing / steaming"},{"code":"WASHING","name":"Washing"},{"code":"FINISHING","name":"Finishing"},{"code":"FINAL_QC","name":"Final QC"},{"code":"PACKING","name":"Packing"}]');
