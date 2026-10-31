-- Workflow (P9): customer communications (templates, consent, outbox with delivery status and retry),
-- event-driven rules, tasks and escalation, contract register, and employee handover.

CREATE TABLE templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL,
  version int NOT NULL DEFAULT 1,
  name text NOT NULL,
  event_type text NOT NULL,
  channel text NOT NULL CHECK (channel IN ('whatsapp','sms','email')),
  language text NOT NULL DEFAULT 'en',
  category text NOT NULL DEFAULT 'utility' CHECK (category IN ('utility','marketing','authentication')),
  subject text,
  body text NOT NULL,
  variables text[] NOT NULL DEFAULT '{}',
  -- WhatsApp: the template name and status as approved by Meta; messages go out only with an approved template.
  provider_template text, provider_status text NOT NULL DEFAULT 'not_required' CHECK (provider_status IN ('not_required','pending','approved','rejected')),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','pending_approval','active','inactive','rejected','superseded')),
  created_by_name text NOT NULL, approved_by_name text, approved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (code, version)
);
CREATE UNIQUE INDEX templates_one_active ON templates (code) WHERE status = 'active';

CREATE TABLE consents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  party_id uuid, party_name text,
  address text NOT NULL,
  channel text NOT NULL CHECK (channel IN ('whatsapp','sms','email')),
  status text NOT NULL CHECK (status IN ('opted_in','opted_out')),
  scope text NOT NULL DEFAULT 'transactional' CHECK (scope IN ('transactional','marketing')),
  source text NOT NULL,
  recorded_by_name text, at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (address, channel, scope)
);

CREATE TABLE messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id bigint, event_type text NOT NULL,
  template_id uuid REFERENCES templates(id), template_code text NOT NULL,
  channel text NOT NULL,
  party_id uuid, to_name text, to_address text NOT NULL,
  ref_type text, ref_id text, ref_label text,
  subject text, body text NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sent','delivered','read','failed','skipped')),
  skip_reason text,
  attempts int NOT NULL DEFAULT 0, next_attempt_at timestamptz NOT NULL DEFAULT now(),
  provider text, provider_message_id text, error text,
  created_at timestamptz NOT NULL DEFAULT now(), sent_at timestamptz, delivered_at timestamptz, read_at timestamptz
);
CREATE UNIQUE INDEX messages_once ON messages (event_id, template_code, to_address) WHERE event_id IS NOT NULL;
CREATE INDEX messages_due ON messages (next_attempt_at) WHERE status = 'queued';

CREATE TABLE message_events (
  id bigserial PRIMARY KEY,
  message_id uuid NOT NULL REFERENCES messages(id),
  kind text NOT NULL, detail jsonb, at timestamptz NOT NULL DEFAULT now()
);

-- Event-driven rules: when <event> and <conditions>, do <actions> (task, notification, message), optionally after a delay.
CREATE TABLE rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  event_type text NOT NULL,
  match text NOT NULL DEFAULT 'all' CHECK (match IN ('all','any')),
  conditions jsonb NOT NULL DEFAULT '[]',
  actions jsonb NOT NULL,
  active boolean NOT NULL DEFAULT true,
  runs int NOT NULL DEFAULT 0, last_run_at timestamptz,
  created_by_name text NOT NULL, updated_by_name text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE scheduled_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_id uuid REFERENCES rules(id),
  action jsonb NOT NULL, context jsonb NOT NULL,
  run_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','done','failed','cancelled')),
  error text, created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE rule_runs (
  id bigserial PRIMARY KEY,
  rule_id uuid NOT NULL REFERENCES rules(id),
  event_id bigint, event_type text NOT NULL,
  matched boolean NOT NULL, outcome text,
  at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX rule_runs_once ON rule_runs (rule_id, event_id) WHERE event_id IS NOT NULL;

CREATE TABLE tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number text NOT NULL UNIQUE,
  title text NOT NULL, description text,
  source_service text, source_type text, source_id text, link text,
  owner_id uuid, owner_name text,
  queue_permission text,
  priority text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high','urgent')),
  due_at timestamptz,
  escalate_after_hours numeric, escalate_to_permission text, escalated_at timestamptz,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','done','cancelled')),
  resolution text,
  rule_id uuid REFERENCES rules(id),
  created_by_name text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  completed_by_name text, completed_at timestamptz, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX tasks_owner ON tasks (owner_id, status);
CREATE TABLE task_events (
  id bigserial PRIMARY KEY,
  task_id uuid NOT NULL REFERENCES tasks(id),
  kind text NOT NULL, note text, by_name text NOT NULL, at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE contracts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number text NOT NULL UNIQUE,
  kind text NOT NULL CHECK (kind IN ('supply','job_work','customer','transport','rent','service','other')),
  title text NOT NULL,
  party_id uuid, party_name text NOT NULL, party_type text,
  start_date date NOT NULL, end_date date NOT NULL CHECK (end_date >= start_date),
  value numeric,
  rates jsonb NOT NULL DEFAULT '[]',
  payment_terms text, quality_terms text, delivery_terms text, penalties text,
  auto_renew boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('draft','active','expired','terminated','renewed')),
  owner_id uuid, owner_name text,
  document_ids uuid[] NOT NULL DEFAULT '{}',
  alerts_sent int[] NOT NULL DEFAULT '{}',
  renewed_from uuid REFERENCES contracts(id),
  search tsvector,
  created_by_name text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX contracts_search ON contracts USING gin (search);
CREATE TABLE contract_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id uuid NOT NULL REFERENCES contracts(id),
  kind text NOT NULL DEFAULT 'note' CHECK (kind IN ('note','email','call','meeting','letter','amendment')),
  body text NOT NULL,
  search tsvector,
  by_name text NOT NULL, at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX contract_notes_search ON contract_notes USING gin (search);

CREATE TABLE handovers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number text NOT NULL UNIQUE,
  from_user_id uuid NOT NULL, from_name text NOT NULL,
  to_user_id uuid NOT NULL, to_name text NOT NULL,
  reason text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('leave','exit','transfer','rebalance')),
  until date,
  summary jsonb NOT NULL DEFAULT '{}',
  created_by_name text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE handover_items (
  id bigserial PRIMARY KEY,
  handover_id uuid NOT NULL REFERENCES handovers(id),
  item_type text NOT NULL, item_id text NOT NULL, label text,
  outcome text NOT NULL CHECK (outcome IN ('moved','skipped')), note text
);

CREATE TABLE counters (doc_type text PRIMARY KEY, next_number int NOT NULL);
