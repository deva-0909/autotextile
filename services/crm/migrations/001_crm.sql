CREATE TABLE counters (doc_type text PRIMARY KEY, next_number int NOT NULL DEFAULT 1);

-- Where leads come from. Integrations post to /api/crm/public/leads/<webhook_key>; field_map maps
-- their JSON (dot paths) or CSV columns onto lead fields, so a new source needs configuration, not code.
CREATE TABLE lead_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE CHECK (code ~ '^[A-Z0-9_]{2,24}$'),
  name text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('meta','indiamart','justdial','website','whatsapp','phone','email','referral','exhibition','trade_platform','manual','api','csv')),
  webhook_key text NOT NULL UNIQUE DEFAULT replace(gen_random_uuid()::text, '-', ''),
  field_map jsonb NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  leads_received int NOT NULL DEFAULT 0,
  last_received_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sales_team (
  user_id uuid PRIMARY KEY,
  name text NOT NULL,
  email text,
  cities text[] NOT NULL DEFAULT '{}',
  states text[] NOT NULL DEFAULT '{}',
  categories text[] NOT NULL DEFAULT '{}',
  sources text[] NOT NULL DEFAULT '{}',
  languages text[] NOT NULL DEFAULT '{}',
  specialisations text[] NOT NULL DEFAULT '{}',
  min_value numeric, max_value numeric,
  max_active_leads int CHECK (max_active_leads IS NULL OR max_active_leads > 0),
  max_discount_pct numeric CHECK (max_discount_pct IS NULL OR max_discount_pct BETWEEN 0 AND 100),
  weekly_off int[] NOT NULL DEFAULT '{0}',
  active boolean NOT NULL DEFAULT true,
  last_assigned_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);

-- Daily availability. HRMS (P9) will feed this; until then managers mark it here.
CREATE TABLE attendance (
  user_id uuid NOT NULL REFERENCES sales_team(user_id),
  day date NOT NULL,
  status text NOT NULL CHECK (status IN ('present','absent','leave','weekly_off','half_day')),
  on_break boolean NOT NULL DEFAULT false,
  note text,
  recorded_by_name text, recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, day)
);

CREATE TABLE allocation_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  priority int NOT NULL DEFAULT 100,
  conditions jsonb NOT NULL DEFAULT '{}',
  strategy text NOT NULL DEFAULT 'round_robin' CHECK (strategy IN ('round_robin','least_loaded')),
  member_ids uuid[] NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE leads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number text NOT NULL UNIQUE,
  source_id uuid NOT NULL REFERENCES lead_sources(id), source_code text NOT NULL, source_ref text,
  name text NOT NULL,
  company text,
  mobile text, email text, gstin text,
  city text, state_code text, language text,
  category text, product_id uuid, product_label text,
  requirement_kg numeric, est_value numeric,
  message text,
  stage text NOT NULL DEFAULT 'new' CHECK (stage IN ('new','assigned','contact_pending','contacted','qualified','quotation','negotiation','order_confirmed','won','lost','nurture')),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed','merged')),
  owner_id uuid, owner_name text, assigned_at timestamptz,
  first_response_at timestamptz,
  next_action_at timestamptz, next_action text,
  lost_reason text, competitor text, nurture_reason text,
  customer_id uuid, customer_name text,
  merged_into uuid REFERENCES leads(id),
  duplicate_flag boolean NOT NULL DEFAULT false,
  allocation_trace jsonb,
  created_by_name text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), closed_at timestamptz,
  version int NOT NULL DEFAULT 1,
  CHECK (stage <> 'lost' OR lost_reason IS NOT NULL),
  CHECK (stage <> 'nurture' OR nurture_reason IS NOT NULL)
);
CREATE UNIQUE INDEX leads_source_ref ON leads (source_id, source_ref) WHERE source_ref IS NOT NULL;
CREATE INDEX leads_owner ON leads (owner_id, status);
CREATE INDEX leads_mobile ON leads (mobile) WHERE mobile IS NOT NULL;
CREATE INDEX leads_email ON leads (email) WHERE email IS NOT NULL;

CREATE TABLE lead_activities (
  id bigserial PRIMARY KEY,
  lead_id uuid NOT NULL REFERENCES leads(id),
  kind text NOT NULL CHECK (kind IN ('note','call','whatsapp','email','meeting','visit','sample','stage','assignment','merge','quotation','system')),
  summary text NOT NULL,
  outcome text,
  by_user uuid, by_name text,
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX lead_activities_lead ON lead_activities (lead_id, at);

CREATE TABLE lead_assignments (
  id bigserial PRIMARY KEY,
  lead_id uuid NOT NULL REFERENCES leads(id),
  from_user uuid, from_name text,
  to_user uuid, to_name text,
  method text NOT NULL CHECK (method IN ('auto','sticky','manual','reassign','unassigned')),
  rule_name text,
  reason text,
  by_name text,
  at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE duplicate_candidates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id uuid NOT NULL REFERENCES leads(id),
  match_type text NOT NULL CHECK (match_type IN ('lead','customer')),
  match_id uuid NOT NULL,
  match_label text NOT NULL,
  match_on text[] NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','merged','linked','kept_separate','escalated')),
  decided_by_name text, decided_at timestamptz, note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (lead_id, match_type, match_id)
);

-- Quotations are versioned: a revision is a new row with the same root and number; earlier versions are superseded.
CREATE TABLE quotations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number text NOT NULL,
  version int NOT NULL DEFAULT 1,
  root_id uuid NOT NULL,
  lead_id uuid REFERENCES leads(id),
  customer_id uuid, customer_name text, prospect_name text,
  owner_id uuid, owner_name text,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','pending_approval','approved','rejected_internal','sent','accepted','rejected','expired','superseded','lost')),
  valid_until date NOT NULL,
  warehouse_id uuid, warehouse_name text,
  freight_amount numeric NOT NULL DEFAULT 0 CHECK (freight_amount >= 0),
  payment_terms text, delivery_terms text, notes text,
  competitor_name text, competitor_price numeric,
  revision_reason text,
  lost_reason text,
  kg numeric NOT NULL DEFAULT 0, taxable numeric NOT NULL DEFAULT 0, tax numeric NOT NULL DEFAULT 0, total numeric NOT NULL DEFAULT 0,
  margin_pct numeric,
  needs_approval boolean NOT NULL DEFAULT false,
  approval_note text,
  approved_by_name text, approved_at timestamptz,
  sent_at timestamptz, decided_at timestamptz,
  reservation_id uuid, reservation_no text,
  created_by uuid, created_by_name text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (root_id, version)
);
CREATE INDEX quotations_customer ON quotations (customer_id);
CREATE INDEX quotations_lead ON quotations (lead_id);

CREATE TABLE quotation_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quotation_id uuid NOT NULL REFERENCES quotations(id) ON DELETE CASCADE,
  line_no int NOT NULL,
  product_id uuid NOT NULL, sku text NOT NULL, product_name text NOT NULL, category text,
  lot_id uuid, lot_no text,
  kg numeric NOT NULL CHECK (kg > 0),
  list_price numeric,
  requested_price numeric NOT NULL CHECK (requested_price > 0),
  discount_pct numeric,
  cost_per_kg numeric,
  margin_pct numeric,
  gst_rate numeric NOT NULL DEFAULT 5,
  taxable numeric NOT NULL,
  needs_approval boolean NOT NULL DEFAULT false,
  approval_reason text
);

CREATE TABLE credit_accounts (
  customer_id uuid PRIMARY KEY,
  customer_name text NOT NULL,
  mode text NOT NULL DEFAULT 'advance' CHECK (mode IN ('advance','credit')),
  credit_limit numeric NOT NULL DEFAULT 0 CHECK (credit_limit >= 0),
  credit_days int NOT NULL DEFAULT 0 CHECK (credit_days >= 0),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','blocked')),
  block_reason text,
  approved_by_name text, approved_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE credit_applications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number text NOT NULL UNIQUE,
  kind text NOT NULL DEFAULT 'limit' CHECK (kind IN ('limit','override')),
  customer_id uuid NOT NULL, customer_name text NOT NULL,
  requested_mode text CHECK (requested_mode IN ('advance','credit')),
  requested_limit numeric, requested_days int,
  override_amount numeric, quotation_id uuid,
  current_limit numeric, current_mode text,
  exposure_at_request numeric,
  justification text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','used','expired')),
  valid_until date,
  requested_by uuid, requested_by_name text,
  decided_by_name text, decided_at timestamptz, comment text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE targets (
  user_id uuid NOT NULL REFERENCES sales_team(user_id),
  period text NOT NULL CHECK (period ~ '^\d{4}-\d{2}$'),
  leads int, qualified int, quotes int,
  kg numeric, revenue numeric, margin_pct numeric,
  new_customers int, collections numeric,
  updated_by_name text, updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, period)
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

INSERT INTO lead_sources (code, name, kind, field_map) VALUES
 ('META', 'Meta lead ads (Facebook / Instagram)', 'meta', '{"name":"full_name","mobile":"phone_number","email":"email","city":"city","company":"company_name","message":"message","source_ref":"leadgen_id"}'),
 ('INDIAMART', 'IndiaMART', 'indiamart', '{"name":"SENDER_NAME","mobile":"SENDER_MOBILE","email":"SENDER_EMAIL","company":"SENDER_COMPANY","city":"SENDER_CITY","message":"QUERY_MESSAGE","product_label":"QUERY_PRODUCT_NAME","source_ref":"UNIQUE_QUERY_ID"}'),
 ('JUSTDIAL', 'Justdial', 'justdial', '{"name":"name","mobile":"mobile","email":"email","city":"city","message":"category","source_ref":"leadid"}'),
 ('WEBSITE', 'Website enquiry form', 'website', '{"name":"name","mobile":"phone","email":"email","company":"company","city":"city","message":"message","requirement_kg":"quantity_kg","source_ref":"id"}'),
 ('WHATSAPP', 'WhatsApp Business', 'whatsapp', '{"name":"profile.name","mobile":"from","message":"text.body","source_ref":"id"}'),
 ('PHONE', 'Phone call', 'phone', '{}'),
 ('EMAIL', 'Email enquiry', 'email', '{}'),
 ('REFERRAL', 'Customer / agent referral', 'referral', '{}'),
 ('EXHIBITION', 'Trade exhibition', 'exhibition', '{}'),
 ('TRADE', 'Trade platform', 'trade_platform', '{}'),
 ('MANUAL', 'Manual entry', 'manual', '{}');
