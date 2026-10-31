-- Open purchase orders carried over from the legacy system at go-live.
ALTER TABLE purchase_orders ADD COLUMN legacy_ref text, ADD COLUMN migration_ref text;
CREATE UNIQUE INDEX purchase_orders_legacy_ref ON purchase_orders (supplier_id, legacy_ref) WHERE legacy_ref IS NOT NULL;
