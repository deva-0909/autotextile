INSERT INTO document_types (code, name, applies_to, retention_years, requires_expiry) VALUES
 ('SUPPLIER_INVOICE', 'Supplier tax invoice', '{supplier,manufacturer,mill,invoice_capture,purchase_order}', 8, false),
 ('QUOTATION', 'Supplier quotation', '{rfq,supplier,manufacturer}', 8, false),
 ('DISPATCH_DOC', 'Dispatch document (LR / e-way bill / challan)', '{purchase_order,job_work_order}', 8, false),
 ('MILL_CHALLAN', 'Job-work challan', '{job_work_order,mill}', 8, false),
 ('QC_PHOTO', 'QC photo / sample evidence', '{job_work_order,quality_claim,purchase_order}', 8, false)
ON CONFLICT (code) DO NOTHING;
