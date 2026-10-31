-- Payments received outside the gateway (bank transfer, cheque, cash) are recorded with their own history event.
ALTER TABLE payment_events DROP CONSTRAINT IF EXISTS payment_events_kind_check;
ALTER TABLE payment_events ADD CONSTRAINT payment_events_kind_check CHECK (kind IN ('created','webhook','verified','refund','expired','rejected','offline_recorded'));
