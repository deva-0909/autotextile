-- Sales and purchase history from the previous system (invoices and bills before go-live).
ALTER TABLE migration_batches DROP CONSTRAINT migration_batches_object_type_check;
ALTER TABLE migration_batches ADD CONSTRAINT migration_batches_object_type_check CHECK (object_type IN ('parties','opening_balances','opening_gl','opening_stock','open_pos','open_orders','open_job_work','gst_credit','gst_cash','itc_reversals','gst_dues','sales_history','purchase_history'));
