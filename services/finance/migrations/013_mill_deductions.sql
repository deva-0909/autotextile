-- Claims on mills and goods held in quarantine reach the mill's ledger the moment they are raised, so the amount is
-- held back from the mill's payments while it is decided. Confirmed amounts become a debit note against the purchase
-- or job-work charge; released ones are reversed. Every deduction stays listed until it is matched to a mill bill.
INSERT INTO accounts (code, name, type, group_name, section, system_key, control, is_bank, eliminate_on_consolidation, allow_manual)
VALUES ('2150', 'Mill claims and holds pending', 'liability', 'Trade payables', 'current_liabilities', 'mill_holds', NULL, false, false, false)
ON CONFLICT DO NOTHING;

CREATE TABLE mill_deductions (
  id uuid PRIMARY KEY,
  key text NOT NULL UNIQUE,
  mill_id uuid NOT NULL, mill_name text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('quality_claim', 'shortage_claim', 'quarantine')),
  source_id uuid NOT NULL, ref text NOT NULL, job_ref text,
  reason text,
  state text NOT NULL DEFAULT 'held' CHECK (state IN ('held', 'confirmed', 'released')),
  held_amount numeric NOT NULL DEFAULT 0,
  confirmed_amount numeric NOT NULL DEFAULT 0,
  expense_account text NOT NULL DEFAULT 'jobwork',
  applied_bill_ref text, applied_at timestamptz, applied_by_name text, applied_note text,
  history jsonb NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX mill_deductions_mill ON mill_deductions (mill_id, state);
