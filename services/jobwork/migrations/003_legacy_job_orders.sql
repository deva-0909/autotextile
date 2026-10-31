-- Open job work carried over from the legacy system: fabric already at the mill on a legacy challan.
ALTER TABLE mill_stock DROP CONSTRAINT mill_stock_source_type_check;
ALTER TABLE mill_stock ADD CONSTRAINT mill_stock_source_type_check CHECK (source_type IN ('po_receipt','opening'));
ALTER TABLE job_orders ADD COLUMN legacy_ref text, ADD COLUMN migration_ref text;
CREATE UNIQUE INDEX job_orders_legacy_ref ON job_orders (mill_id, legacy_ref) WHERE legacy_ref IS NOT NULL;
