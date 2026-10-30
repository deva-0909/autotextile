-- Supplier / mill portal users act for one business partner (masters.parties id).
ALTER TABLE users ADD COLUMN party_id uuid;
CREATE INDEX users_party ON users (party_id) WHERE party_id IS NOT NULL;

-- Baseline permissions already granted to system roles, so upgrades add new
-- permissions once and never re-add ones an administrator removed.
CREATE TABLE baseline_grants (
  role_code text NOT NULL,
  permission text NOT NULL,
  granted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (role_code, permission)
);
