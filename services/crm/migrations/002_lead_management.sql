-- Lead management: scoring, structured call logging, objections, reviving lost leads, re-enquiries,
-- samples and showroom visits, shift-aware and performance-weighted assignment, response targets,
-- source spend and return, and commission agents.

-- Settings the sales manager edits (Sales & CRM → Lead settings). Values are JSON.
CREATE TABLE crm_settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_by_name text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO crm_settings (key, value) VALUES
 ('first_response_minutes', '15'),
 ('sla_reassign_minutes', '30'),
 ('no_progress_attempts', '20'),
 ('objections', '["Price","Quality / GSM","Shade / colour","Delivery time","Payment terms / credit","Minimum order quantity","Comparing other suppliers","Invalid contact","Other"]'),
 ('stage_probability', '{"new":0.03,"assigned":0.03,"contact_pending":0.04,"contacted":0.08,"qualified":0.2,"quotation":0.35,"negotiation":0.5,"order_confirmed":0.85,"nurture":0.02}'),
 ('performance_window_days', '90'),
 ('agent_protection_days', '90'),
 ('agent_commission_months', '12'),
 ('attribution_months', '12');

ALTER TABLE leads
  ADD COLUMN call_attempts int NOT NULL DEFAULT 0,
  ADD COLUMN connected_calls int NOT NULL DEFAULT 0,
  ADD COLUMN attempts_since_progress int NOT NULL DEFAULT 0,
  ADD COLUMN no_progress boolean NOT NULL DEFAULT false,
  ADD COLUMN first_connected_at timestamptz,
  ADD COLUMN last_contact_at timestamptz,
  ADD COLUMN objection text,
  ADD COLUMN score int,
  ADD COLUMN score_band text CHECK (score_band IS NULL OR score_band IN ('hot','warm','cold')),
  ADD COLUMN score_reasons jsonb,
  ADD COLUMN scored_at timestamptz,
  ADD COLUMN reenquiry_count int NOT NULL DEFAULT 0,
  ADD COLUMN last_reenquiry_at timestamptz,
  ADD COLUMN last_reenquiry_source text,
  ADD COLUMN previous_lead_id uuid REFERENCES leads(id),
  ADD COLUMN revived_count int NOT NULL DEFAULT 0,
  ADD COLUMN last_revived_at timestamptz,
  ADD COLUMN sla_reassigned boolean NOT NULL DEFAULT false,
  ADD COLUMN agent_id uuid,
  ADD COLUMN agent_name text,
  ADD COLUMN agent_protected_until date;
CREATE INDEX leads_score ON leads (score DESC) WHERE status = 'open';
CREATE INDEX leads_lost ON leads (objection, closed_at) WHERE stage = 'lost';

ALTER TABLE lead_activities DROP CONSTRAINT lead_activities_kind_check;
ALTER TABLE lead_activities ADD CONSTRAINT lead_activities_kind_check CHECK (kind IN ('note','call','whatsapp','email','meeting','visit','sample','stage','assignment','merge','quotation','system','revive','reenquiry'));
ALTER TABLE lead_activities ADD COLUMN call_outcome text, ADD COLUMN duration_sec int CHECK (duration_sec IS NULL OR duration_sec >= 0);

ALTER TABLE lead_assignments DROP CONSTRAINT lead_assignments_method_check;
ALTER TABLE lead_assignments ADD CONSTRAINT lead_assignments_method_check CHECK (method IN ('auto','sticky','manual','reassign','unassigned','override','bulk','rebalance','sla','revive','agent'));
ALTER TABLE lead_assignments ADD COLUMN suggested_name text;

ALTER TABLE allocation_rules DROP CONSTRAINT allocation_rules_strategy_check;
ALTER TABLE allocation_rules ADD CONSTRAINT allocation_rules_strategy_check CHECK (strategy IN ('round_robin','least_loaded','best_performer'));

-- Working hours come from HRMS (set by HR for each employee).
ALTER TABLE sales_team ADD COLUMN shift_start time, ADD COLUMN shift_end time, ADD COLUMN shift_name text;

-- Samples sent and showroom visits, with the customer's response.
CREATE TABLE lead_engagements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number text NOT NULL UNIQUE,
  lead_id uuid NOT NULL REFERENCES leads(id),
  kind text NOT NULL CHECK (kind IN ('sample','visit')),
  items text NOT NULL,
  qty_kg numeric CHECK (qty_kg IS NULL OR qty_kg >= 0),
  courier text, tracking_no text,
  scheduled_at timestamptz, host_name text,
  status text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','dispatched','delivered','scheduled','held','cancelled','no_show')),
  outcome text CHECK (outcome IS NULL OR outcome IN ('very_interested','interested','needs_changes','not_interested')),
  outcome_note text, outcome_at timestamptz,
  owner_id uuid, owner_name text,
  created_by_name text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX lead_engagements_lead ON lead_engagements (lead_id);

-- What each source costs: a fixed cost per lead, a monthly fee (subscriptions), and spend entered month by month.
ALTER TABLE lead_sources ADD COLUMN cost_per_lead numeric NOT NULL DEFAULT 0 CHECK (cost_per_lead >= 0),
  ADD COLUMN monthly_fee numeric NOT NULL DEFAULT 0 CHECK (monthly_fee >= 0);
CREATE TABLE lead_source_spend (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id uuid NOT NULL REFERENCES lead_sources(id),
  month date NOT NULL CHECK (extract(day FROM month) = 1),
  amount numeric NOT NULL CHECK (amount >= 0),
  note text,
  by_name text, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX lead_source_spend_src ON lead_source_spend (source_id, month);

-- Commission agents (dalals). Each is also a supplier-type party in masters so payouts go through payables.
CREATE TABLE agents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  name text NOT NULL, firm text,
  mobile text, email text, city text, state_code text, pan text,
  party_id uuid,
  user_id uuid,
  basis text NOT NULL DEFAULT 'pct' CHECK (basis IN ('pct','per_kg')),
  rate numeric NOT NULL CHECK (rate >= 0),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  created_by_name text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);

-- A customer won through an agent earns the agent commission on its invoices for a set period.
CREATE TABLE agent_accounts (
  customer_id uuid PRIMARY KEY,
  customer_name text NOT NULL,
  agent_id uuid NOT NULL REFERENCES agents(id),
  lead_id uuid REFERENCES leads(id),
  from_date date NOT NULL,
  until_date date NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE agent_payouts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number text NOT NULL UNIQUE,
  agent_id uuid NOT NULL REFERENCES agents(id),
  amount numeric NOT NULL CHECK (amount > 0),
  status text NOT NULL DEFAULT 'pending_approval' CHECK (status IN ('pending_approval','approved','rejected','paid')),
  requested_by_name text, decided_by_name text, decided_at timestamptz, comment text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE agent_commissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL REFERENCES agents(id),
  customer_id uuid NOT NULL, customer_name text NOT NULL,
  invoice_no text NOT NULL,
  invoice_date date NOT NULL,
  taxable numeric NOT NULL, kg numeric,
  basis text NOT NULL, rate numeric NOT NULL,
  amount numeric NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','earned','in_payout','paid','cancelled')),
  earned_at timestamptz,
  payout_id uuid REFERENCES agent_payouts(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agent_id, invoice_no)
);

INSERT INTO lead_sources (code, name, kind, field_map) VALUES ('AGENT', 'Commission agent', 'referral', '{}');

-- A webhook re-sending the same enquiry must not count as a second re-enquiry.
ALTER TABLE lead_activities ADD COLUMN source_id uuid, ADD COLUMN source_ref text;
CREATE UNIQUE INDEX lead_activities_source_ref ON lead_activities (source_id, source_ref) WHERE source_ref IS NOT NULL;
