-- Goods lost at the mill and wrong goods sent back.
-- Wrong goods (another party's fabric, wrong shade, GSM or quality) are held in quarantine: counted as returned
-- but never added to sellable stock until resolved (sent back to the mill, sent for rework, or accepted).
ALTER TABLE job_orders ADD COLUMN kg_quarantine numeric NOT NULL DEFAULT 0;
ALTER TABLE job_returns ADD COLUMN kg_quarantine numeric NOT NULL DEFAULT 0 CHECK (kg_quarantine >= 0);

CREATE TABLE quarantine_holds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number text NOT NULL UNIQUE,
  job_order_id uuid NOT NULL REFERENCES job_orders(id),
  return_id uuid REFERENCES job_returns(id),
  mill_id uuid NOT NULL, mill_name text NOT NULL,
  warehouse_id uuid, warehouse_name text,
  kg numeric NOT NULL CHECK (kg > 0),
  rolls int,
  reason_type text NOT NULL CHECK (reason_type IN ('other_party','wrong_shade','wrong_gsm','wrong_quality','other')),
  description text NOT NULL,
  status text NOT NULL DEFAULT 'held' CHECK (status IN ('held','returned_to_mill','rework','accepted')),
  resolution text, challan_no text,
  resolved_by_name text, resolved_at timestamptz,
  created_by_name text, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX quarantine_holds_order ON quarantine_holds (job_order_id);

ALTER TABLE quality_claims DROP CONSTRAINT quality_claims_claim_type_check;
ALTER TABLE quality_claims ADD CONSTRAINT quality_claims_claim_type_check CHECK (claim_type IN ('debit_note','rework','replacement','none','shortage'));
ALTER TABLE quality_claims ADD COLUMN rate_per_kg numeric, ADD COLUMN auto_raised boolean NOT NULL DEFAULT false, ADD COLUMN posted_at timestamptz;
