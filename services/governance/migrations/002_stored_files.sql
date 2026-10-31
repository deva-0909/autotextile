-- File contents kept in the database where the server has no lasting disk (hosted demo on Vercel). Locally files stay
-- on disk under STORAGE_DIR and this table stays empty.
CREATE TABLE stored_files (
  key text PRIMARY KEY,
  body bytea NOT NULL,
  size int NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
