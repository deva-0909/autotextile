CREATE TABLE party_counters (party_type text PRIMARY KEY, next_number int NOT NULL DEFAULT 1);

-- One table for every trading counterparty; type-specific data lives in `profile`.
CREATE TABLE parties (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  party_type text NOT NULL CHECK (party_type IN ('customer','supplier','manufacturer','mill','transporter')),
  code text NOT NULL UNIQUE,
  legal_name text NOT NULL,
  trade_name text,
  gst_treatment text NOT NULL CHECK (gst_treatment IN ('registered','composition','unregistered','sez','overseas')),
  gstin text,
  pan text,
  state_code text,
  email text,
  phone text,
  website text,
  payment_term_id uuid REFERENCES payment_terms(id),
  credit_limit numeric CHECK (credit_limit IS NULL OR credit_limit >= 0),
  segment text,
  rating int CHECK (rating BETWEEN 1 AND 5),
  tags text[] NOT NULL DEFAULT '{}',
  profile jsonb NOT NULL DEFAULT '{}',
  owner_user_id uuid,
  notes text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive','blocked')),
  version int NOT NULL DEFAULT 1, created_by uuid, created_at timestamptz NOT NULL DEFAULT now(), updated_by uuid, updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (gst_treatment NOT IN ('registered','composition','sez') OR gstin IS NOT NULL)
);
CREATE UNIQUE INDEX parties_type_gstin ON parties (party_type, gstin) WHERE gstin IS NOT NULL;
CREATE INDEX parties_search ON parties USING gin (to_tsvector('simple', legal_name || ' ' || coalesce(trade_name, '') || ' ' || code));

CREATE TABLE party_contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  party_id uuid NOT NULL REFERENCES parties(id) ON DELETE CASCADE,
  name text NOT NULL,
  designation text,
  email text,
  phone text,
  is_primary boolean NOT NULL DEFAULT false,
  version int NOT NULL DEFAULT 1, created_by uuid, created_at timestamptz NOT NULL DEFAULT now(), updated_by uuid, updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE party_addresses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  party_id uuid NOT NULL REFERENCES parties(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('billing','shipping','registered','factory','warehouse')),
  line1 text NOT NULL,
  line2 text,
  city text NOT NULL,
  state_code text NOT NULL,
  pincode text NOT NULL CHECK (pincode ~ '^[0-9]{6}$'),
  gstin text,
  is_default boolean NOT NULL DEFAULT false,
  version int NOT NULL DEFAULT 1, created_by uuid, created_at timestamptz NOT NULL DEFAULT now(), updated_by uuid, updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE party_bank_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  party_id uuid NOT NULL REFERENCES parties(id) ON DELETE CASCADE,
  account_name text NOT NULL,
  account_number text NOT NULL,
  ifsc text NOT NULL CHECK (ifsc ~ '^[A-Z]{4}0[A-Z0-9]{6}$'),
  bank_name text,
  branch text,
  status text NOT NULL DEFAULT 'pending_approval' CHECK (status IN ('pending_approval','active','rejected','inactive')),
  approved_by uuid,
  decided_at timestamptz,
  decision_comment text,
  version int NOT NULL DEFAULT 1, created_by uuid, created_at timestamptz NOT NULL DEFAULT now(), updated_by uuid, updated_at timestamptz NOT NULL DEFAULT now()
);

-- Sensitive field changes (GSTIN, credit limit) wait here for a checker.
CREATE TABLE pending_changes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  party_id uuid NOT NULL REFERENCES parties(id) ON DELETE CASCADE,
  changes jsonb NOT NULL,
  previous jsonb NOT NULL,
  reason text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  requested_by uuid NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  decided_by uuid,
  decided_at timestamptz,
  decision_comment text
);
CREATE UNIQUE INDEX pending_changes_one_open ON pending_changes (party_id) WHERE status = 'pending';
