-- Personnel file: the documents HR keeps for each employee (filed from the employee's Documents tab, seen only by HR).
INSERT INTO document_types (code, name, applies_to, retention_years, requires_expiry) VALUES
 ('OFFER_LETTER', 'Offer / appointment letter', '{employee}', 8, false),
 ('ID_PROOF', 'Identity proof (Aadhaar / passport / voter ID)', '{employee}', 8, false),
 ('ADDRESS_PROOF', 'Address proof', '{employee}', 8, false),
 ('EDUCATION_CERT', 'Education certificate', '{employee}', 8, false),
 ('EXPERIENCE_LETTER', 'Previous experience / relieving letter', '{employee}', 8, false),
 ('NOMINATION_FORM', 'PF / ESIC nomination form', '{employee}', 8, false),
 ('POLICY_ACK', 'Policy acknowledgement (code of conduct, POSH)', '{employee}', 8, false),
 ('APPRAISAL', 'Appraisal / increment letter', '{employee}', 8, false),
 ('EXIT_DOC', 'Resignation, full-and-final and relieving letter', '{employee}', 8, false)
ON CONFLICT (code) DO NOTHING;
UPDATE document_types SET applies_to = array_append(applies_to, 'employee')
WHERE code IN ('PAN_CARD', 'CANCELLED_CHEQUE', 'OTHER') AND NOT ('employee' = ANY(applies_to));
