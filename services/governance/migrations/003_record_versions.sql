-- Every version of a business document (quotation, purchase order, manual invoice, …) as it stood, kept read-only.
-- Only the latest version of a document can be edited, in its own service; older ones are only viewed here.
CREATE TABLE record_versions (
  id bigserial PRIMARY KEY,
  event_id uuid UNIQUE,
  service text NOT NULL,
  doc_type text NOT NULL,
  doc_id uuid NOT NULL,
  number text,
  version int NOT NULL,
  status text,
  data jsonb NOT NULL,
  change_note text,
  by_name text,
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX record_versions_doc ON record_versions (doc_type, doc_id, version DESC);
CREATE OR REPLACE FUNCTION record_versions_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'document versions cannot be changed'; END $$;
CREATE TRIGGER record_versions_no_change BEFORE UPDATE OR DELETE ON record_versions FOR EACH ROW EXECUTE FUNCTION record_versions_immutable();
