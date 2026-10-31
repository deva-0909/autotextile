-- Supplier payment runs: a batch of bills paid together, with the bank's bulk-upload file for the payments released.
CREATE TABLE payment_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number text NOT NULL UNIQUE,
  run_date date NOT NULL,
  mode text NOT NULL CHECK (mode IN ('neft', 'rtgs')),
  total numeric NOT NULL DEFAULT 0,
  released numeric NOT NULL DEFAULT 0,
  items jsonb NOT NULL DEFAULT '[]',
  bank_file text,
  created_by_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
