-- Every version of a business document (quotation, purchase order, manual invoice, …) as it stood, kept read-only.
-- Only the latest version of a document can be edited, in its own service; older ones are only viewed here.
CREATE TABLE document_versions (
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
CREATE INDEX document_versions_doc ON document_versions (doc_type, doc_id, version DESC);
CREATE OR REPLACE FUNCTION document_versions_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'document versions cannot be changed'; END $$;
CREATE TRIGGER document_versions_no_change BEFORE UPDATE OR DELETE ON document_versions FOR EACH ROW EXECUTE FUNCTION document_versions_immutable();
