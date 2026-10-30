CREATE TABLE audit_log (
  id bigserial PRIMARY KEY,
  event_id bigint NOT NULL UNIQUE,
  service text NOT NULL,
  entity text NOT NULL,
  entity_id text NOT NULL,
  action text NOT NULL,
  before jsonb,
  after jsonb,
  reason text,
  approved_by uuid,
  user_id text,
  user_name text,
  session_id uuid,
  ip text,
  user_agent text,
  at timestamptz NOT NULL
);
CREATE INDEX audit_entity ON audit_log (entity, entity_id, at DESC);
CREATE INDEX audit_at ON audit_log (at DESC);
CREATE INDEX audit_user ON audit_log (user_id, at DESC);

-- The audit trail is append-only: block UPDATE, DELETE and TRUNCATE at the database level.
CREATE FUNCTION audit_log_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only';
END $$;
CREATE TRIGGER audit_log_no_update BEFORE UPDATE OR DELETE ON audit_log FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit_log FOR EACH STATEMENT EXECUTE FUNCTION audit_log_immutable();

CREATE TABLE approval_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_service text NOT NULL,
  approval_type text NOT NULL,
  ref_id text NOT NULL,
  title text NOT NULL,
  summary text,
  payload jsonb NOT NULL DEFAULT '{}',
  required_permission text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  requested_by uuid NOT NULL,
  requested_by_name text,
  requested_at timestamptz NOT NULL DEFAULT now(),
  decided_by uuid,
  decided_by_name text,
  decided_at timestamptz,
  comment text,
  UNIQUE (source_service, approval_type, ref_id)
);
CREATE INDEX approvals_status ON approval_requests (status, requested_at DESC);

CREATE TABLE notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid,
  audience_permission text,
  kind text NOT NULL DEFAULT 'info' CHECK (kind IN ('info','success','warning','action')),
  title text NOT NULL,
  body text,
  link text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (user_id IS NOT NULL OR audience_permission IS NOT NULL)
);
CREATE TABLE notification_reads (
  notification_id uuid NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  read_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (notification_id, user_id)
);

CREATE TABLE documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_type text NOT NULL,
  title text NOT NULL,
  entity_type text NOT NULL,
  entity_id text NOT NULL,
  current_version int NOT NULL DEFAULT 1,
  expires_on date,
  tags text[] NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX documents_entity ON documents (entity_type, entity_id);

CREATE TABLE document_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL REFERENCES documents(id),
  version int NOT NULL,
  file_name text NOT NULL,
  mime_type text NOT NULL,
  size_bytes bigint NOT NULL,
  sha256 text NOT NULL,
  storage_key text NOT NULL,
  note text,
  uploaded_by uuid,
  uploaded_by_name text,
  uploaded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (document_id, version)
);
