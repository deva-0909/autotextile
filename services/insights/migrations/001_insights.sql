-- Insights (P10): saved and scheduled reports, assistant log, backups and restore tests.
CREATE TABLE reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL, description text,
  definition jsonb NOT NULL,
  owner_id uuid NOT NULL, owner_name text NOT NULL,
  shared boolean NOT NULL DEFAULT false,
  schedule text NOT NULL DEFAULT 'none' CHECK (schedule IN ('none','daily','weekly','monthly')),
  recipients uuid[] NOT NULL DEFAULT '{}',
  last_run_at timestamptz, next_run_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE report_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  report_id uuid NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  result jsonb NOT NULL, row_count int NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE assistant_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL, user_name text NOT NULL,
  question text NOT NULL, answer text,
  tools_used text[] NOT NULL DEFAULT '{}',
  mode text NOT NULL CHECK (mode IN ('ai','built_in')),
  model text, input_tokens int, output_tokens int,
  feedback text CHECK (feedback IN ('helpful','not_helpful')),
  error text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE briefs (
  user_id uuid NOT NULL, day date NOT NULL, body jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, day)
);

CREATE TABLE backups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  file_name text NOT NULL, size_bytes bigint, sha256 text,
  status text NOT NULL CHECK (status IN ('running','completed','failed')),
  table_counts jsonb, error text, duration_ms int,
  started_by_name text NOT NULL, started_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz,
  restore_status text CHECK (restore_status IN ('passed','failed')), restore_detail jsonb, restore_ms int, restored_at timestamptz
);
