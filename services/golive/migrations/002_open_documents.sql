-- Open purchase orders and open sales orders carried over from the legacy system.
ALTER TABLE migration_batches DROP CONSTRAINT migration_batches_object_type_check;
ALTER TABLE migration_batches ADD CONSTRAINT migration_batches_object_type_check CHECK (object_type IN ('parties','opening_balances','opening_gl','opening_stock','open_pos','open_orders'));
