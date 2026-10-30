-- Legal Entity -> GST Registration -> Branch / Place of Business -> Warehouse -> Zone/Aisle/Rack/Bin

CREATE TABLE legal_entities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  legal_name text NOT NULL,
  trade_name text,
  constitution text NOT NULL CHECK (constitution IN ('private_limited','public_limited','llp','partnership','proprietorship','other')),
  pan text NOT NULL UNIQUE CHECK (pan ~ '^[A-Z]{5}[0-9]{4}[A-Z]$'),
  cin text,
  registered_address text,
  state_code text,
  pincode text,
  email text,
  phone text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  version int NOT NULL DEFAULT 1, created_by uuid, created_at timestamptz NOT NULL DEFAULT now(), updated_by uuid, updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE gst_registrations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legal_entity_id uuid NOT NULL REFERENCES legal_entities(id),
  gstin text NOT NULL UNIQUE,
  state_code text NOT NULL,
  registration_type text NOT NULL DEFAULT 'regular' CHECK (registration_type IN ('regular','composition','sez_unit','sez_developer','isd','casual')),
  trade_name text,
  principal_address text,
  effective_from date NOT NULL,
  effective_to date,
  e_invoice_applicable boolean NOT NULL DEFAULT true,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  version int NOT NULL DEFAULT 1, created_by uuid, created_at timestamptz NOT NULL DEFAULT now(), updated_by uuid, updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (effective_to IS NULL OR effective_to >= effective_from)
);

CREATE TABLE branches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  gst_registration_id uuid NOT NULL REFERENCES gst_registrations(id),
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  is_principal_place boolean NOT NULL DEFAULT false,
  address text,
  city text,
  pincode text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  version int NOT NULL DEFAULT 1, created_by uuid, created_at timestamptz NOT NULL DEFAULT now(), updated_by uuid, updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE warehouses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  branch_id uuid NOT NULL REFERENCES branches(id),
  -- Mapping to the GST registration is explicit and configurable (normally the branch's registration).
  gst_registration_id uuid NOT NULL REFERENCES gst_registrations(id),
  warehouse_type text NOT NULL DEFAULT 'distribution' CHECK (warehouse_type IN ('receiving_hub','distribution','transit','returns')),
  dispatch_priority int NOT NULL DEFAULT 100,
  address text,
  city text NOT NULL,
  pincode text,
  manager_name text,
  phone text,
  capacity_kg numeric CHECK (capacity_kg IS NULL OR capacity_kg >= 0),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  version int NOT NULL DEFAULT 1, created_by uuid, created_at timestamptz NOT NULL DEFAULT now(), updated_by uuid, updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE warehouse_locations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  warehouse_id uuid NOT NULL REFERENCES warehouses(id),
  parent_id uuid REFERENCES warehouse_locations(id),
  kind text NOT NULL CHECK (kind IN ('zone','aisle','rack','bin')),
  code text NOT NULL,
  path text NOT NULL,
  name text,
  purpose text NOT NULL DEFAULT 'storage' CHECK (purpose IN ('storage','receiving','qc','staging','dispatch','damaged','returns')),
  capacity_kg numeric,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  version int NOT NULL DEFAULT 1, created_by uuid, created_at timestamptz NOT NULL DEFAULT now(), updated_by uuid, updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (warehouse_id, path)
);

CREATE TABLE fiscal_years (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  start_date date NOT NULL,
  end_date date NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  is_current boolean NOT NULL DEFAULT false,
  version int NOT NULL DEFAULT 1, created_by uuid, created_at timestamptz NOT NULL DEFAULT now(), updated_by uuid, updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (end_date > start_date)
);
CREATE UNIQUE INDEX fiscal_years_one_current ON fiscal_years (is_current) WHERE is_current;

-- GSTIN-wise document numbering. gst_registration_id NULL = company-wide series.
CREATE TABLE number_series (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  doc_type text NOT NULL,
  gst_registration_id uuid REFERENCES gst_registrations(id),
  fiscal_year_id uuid NOT NULL REFERENCES fiscal_years(id),
  prefix text NOT NULL,
  padding int NOT NULL DEFAULT 5 CHECK (padding BETWEEN 1 AND 10),
  next_number bigint NOT NULL DEFAULT 1 CHECK (next_number > 0),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  version int NOT NULL DEFAULT 1, created_by uuid, created_at timestamptz NOT NULL DEFAULT now(), updated_by uuid, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX number_series_key ON number_series (doc_type, COALESCE(gst_registration_id, '00000000-0000-0000-0000-000000000000'), fiscal_year_id);
-- GST invoice numbers must be at most 16 characters (CGST Rule 46).
ALTER TABLE number_series ADD CONSTRAINT number_series_len CHECK (length(prefix) + padding <= 16);

CREATE TABLE settings (
  key text PRIMARY KEY,
  category text NOT NULL,
  label text NOT NULL,
  description text,
  value_type text NOT NULL CHECK (value_type IN ('number','percent','boolean','text','select','list')),
  options jsonb,
  value jsonb NOT NULL,
  requires_ca_validation boolean NOT NULL DEFAULT false,
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Configuration defaults. Values are placeholders until confirmed (see Decisions & Risks register).
INSERT INTO settings (key, category, label, description, value_type, options, value, requires_ca_validation) VALUES
 ('commerce.token_percent', 'Commerce', 'Booking token (% of taxable value)', 'Token charged at booking, calculated on taxable bill value excluding GST.', 'percent', NULL, '10', true),
 ('commerce.token_validity_days', 'Commerce', 'Token booking validity (days)', 'Days a token booking reserves stock before expiry.', 'number', NULL, '7', false),
 ('commerce.min_order_kg', 'Commerce', 'Minimum order quantity (KG)', 'Default MOQ unless the product overrides it.', 'number', NULL, '50', false),
 ('fulfilment.default_warehouse_strategy', 'Fulfilment', 'Default allocation strategy', 'How the allocation engine ranks warehouses.', 'select', '["priority_then_distance","priority_only","nearest_first"]', '"priority_then_distance"', false),
 ('fulfilment.split_requires_approval', 'Fulfilment', 'Multi-warehouse dispatch needs management approval', 'Confirmed business rule.', 'boolean', NULL, 'true', false),
 ('fulfilment.dispatch_requires_invoice', 'Fulfilment', 'Dispatch gate: GST invoice generated', NULL, 'boolean', NULL, 'true', false),
 ('fulfilment.dispatch_requires_payment', 'Fulfilment', 'Dispatch gate: payment verified or approved credit', NULL, 'boolean', NULL, 'true', false),
 ('sales.min_margin_percent', 'Sales', 'Minimum margin before approval (%)', 'Quotes below this margin need approval.', 'percent', NULL, '8', false),
 ('sales.max_discount_without_approval', 'Sales', 'Max discount without approval (%)', NULL, 'percent', NULL, '3', false),
 ('credit.default_terms_days', 'Credit', 'Default credit period (days)', NULL, 'number', NULL, '30', false),
 ('credit.overdue_hold', 'Credit', 'Hold new orders when invoices are overdue', NULL, 'boolean', NULL, 'true', false),
 ('inventory.valuation_method', 'Inventory', 'Inventory valuation method', 'Must be selected with the CA (DEC-004).', 'select', '["fifo","weighted_average"]', '"weighted_average"', true),
 ('inventory.ageing_buckets', 'Inventory', 'Ageing buckets (days)', NULL, 'list', NULL, '[30,60,90,180,365]', false),
 ('procurement.three_way_tolerance_percent', 'Procurement', 'Three-way match tolerance (%)', 'Quantity/rate variance allowed before an exception.', 'percent', NULL, '2', false),
 ('jobwork.min_yield_percent', 'Job work', 'Mill yield alert threshold (%)', NULL, 'percent', NULL, '92', false),
 ('jobwork.statutory_return_days', 'Job work', 'Statutory job-work return deadline (days)', 'Validate with CA before use.', 'number', NULL, '365', true),
 ('security.mfa_required_for_admins', 'Security', 'Require MFA for privileged users', NULL, 'boolean', NULL, 'true', false),
 ('security.session_idle_minutes', 'Security', 'Idle session timeout (minutes)', NULL, 'number', NULL, '30', false),
 ('features.customer_portal', 'Feature toggles', 'Customer portal', 'Enabled in P6.', 'boolean', NULL, 'false', false),
 ('features.ai_invoice_capture', 'Feature toggles', 'AI invoice capture', 'Enabled in P2.', 'boolean', NULL, 'false', false);
