-- Payment reminders already raised, so each overdue stage triggers communications once per bill.
CREATE TABLE reminders (
  bill_id uuid NOT NULL REFERENCES bills(id),
  stage int NOT NULL,
  sent_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (bill_id, stage)
);
