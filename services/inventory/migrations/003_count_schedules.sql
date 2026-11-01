-- Stock counts on a schedule: fast-moving or high-value fabric often, the rest less often, the whole warehouse yearly.
CREATE TABLE count_schedules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  warehouse_id uuid NOT NULL, warehouse_name text NOT NULL,
  scope text NOT NULL CHECK (scope IN ('fast_moving','high_value','location','full')),
  location_prefix text,
  top_n int NOT NULL DEFAULT 5 CHECK (top_n BETWEEN 1 AND 50),
  frequency text NOT NULL CHECK (frequency IN ('weekly','monthly','quarterly','yearly')),
  next_due date NOT NULL,
  blind boolean NOT NULL DEFAULT true,
  active boolean NOT NULL DEFAULT true,
  last_stocktake_id uuid,
  created_by_name text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE stocktakes ADD COLUMN schedule_id uuid REFERENCES count_schedules(id), ADD COLUMN blind boolean NOT NULL DEFAULT false,
  ADD COLUMN due_date date, ADD COLUMN product_ids uuid[] NOT NULL DEFAULT '{}', ADD COLUMN scope_label text,
  ADD COLUMN value_diff numeric, ADD COLUMN needs_owner boolean NOT NULL DEFAULT false;

-- Why each difference happened, recorded by the counter or supervisor before submitting.
CREATE TABLE stocktake_reasons (
  stocktake_id uuid NOT NULL REFERENCES stocktakes(id) ON DELETE CASCADE,
  barcode text NOT NULL,
  reason_code text NOT NULL CHECK (reason_code IN ('not_found','damaged_unrecorded','dispatch_not_recorded','wrong_label','weight_moisture','mislocated','found_unrecorded','other')),
  note text,
  by_name text, at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (stocktake_id, barcode)
);
