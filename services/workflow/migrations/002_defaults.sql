-- Default customer communications. WhatsApp templates must also be approved by Meta (provider_template / provider_status).
INSERT INTO templates (code, name, event_type, channel, category, subject, body, variables, provider_template, provider_status, status, created_by_name, approved_by_name, approved_at) VALUES
 ('enquiry_ack_whatsapp', 'Enquiry received', 'crm.lead.created', 'whatsapp', 'utility', NULL,
  'Hello {{contact_name}}, thank you for your enquiry ({{lead_no}}) with {{company}}. Our team will call you shortly with prices and availability.', '{contact_name,lead_no,company}', 'enquiry_ack_v1', 'approved', 'active', 'system', 'system', now()),
 ('quotation_sent_email', 'Quotation', 'crm.quotation.sent', 'email', 'utility', 'Quotation {{quotation_no}} from {{company}}',
  'Dear {{customer_name}},\n\nPlease find our quotation {{quotation_no}} for ₹{{amount}}, valid until {{valid_until}}. Reply to this email or call {{owner_name}} to confirm.\n\nRegards,\n{{company}}', '{customer_name,quotation_no,amount,valid_until,owner_name,company}', NULL, 'not_required', 'active', 'system', 'system', now()),
 ('booking_confirmed_whatsapp', 'Order booked', 'commerce.order.booked', 'whatsapp', 'utility', NULL,
  'Order {{order_no}} is confirmed and the fabric is reserved for you until {{reserved_until}}. We will share dispatch details soon. — {{company}}', '{order_no,reserved_until,company}', 'order_booked_v1', 'approved', 'active', 'system', 'system', now()),
 ('payment_link_whatsapp', 'Payment link', 'commerce.payment.link_created', 'whatsapp', 'utility', NULL,
  'Payment of ₹{{amount}} for {{reference}} is due. Pay securely here: {{link}} (valid until {{expires_at}}). — {{company}}', '{amount,reference,link,expires_at,company}', 'payment_link_v2', 'approved', 'active', 'system', 'system', now()),
 ('payment_link_sms', 'Payment link (SMS)', 'commerce.payment.link_created', 'sms', 'utility', NULL,
  'Pay Rs {{amount}} for {{reference}}: {{link}} -{{company}}', '{amount,reference,link,company}', NULL, 'not_required', 'active', 'system', 'system', now()),
 ('invoice_issued_email', 'Tax invoice', 'fulfilment.invoiced', 'email', 'utility', 'Tax invoice {{invoice_no}}',
  'Dear {{customer_name}},\n\nTax invoice {{invoice_no}} for ₹{{amount}} has been issued for order {{order_no}}. You can view and download it from your account: {{portal_link}}\n\nRegards,\n{{company}}', '{customer_name,invoice_no,amount,order_no,portal_link,company}', NULL, 'not_required', 'active', 'system', 'system', now()),
 ('payment_receipt_whatsapp', 'Payment received', 'commerce.payment.received', 'whatsapp', 'utility', NULL,
  'We have received ₹{{amount}} (UTR {{utr}}). Thank you! — {{company}}', '{amount,utr,company}', 'payment_receipt_v1', 'approved', 'active', 'system', 'system', now()),
 ('dispatch_whatsapp', 'Dispatched with LR', 'fulfilment.dispatched', 'whatsapp', 'utility', NULL,
  'Your order {{order_no}} has left our {{warehouse}} warehouse with {{transporter}}, LR {{lr_number}}. Expected by {{eta}}. Track: {{tracking_link}} — {{company}}', '{order_no,warehouse,transporter,lr_number,eta,tracking_link,company}', 'dispatch_lr_v1', 'approved', 'active', 'system', 'system', now()),
 ('dispatch_sms', 'Dispatched (SMS)', 'fulfilment.dispatched', 'sms', 'utility', NULL,
  'Order {{order_no}} dispatched, {{transporter}} LR {{lr_number}}. Track {{tracking_link}} -{{company}}', '{order_no,transporter,lr_number,tracking_link,company}', NULL, 'not_required', 'active', 'system', 'system', now()),
 ('delivered_feedback_whatsapp', 'Delivered — feedback', 'fulfilment.delivered', 'whatsapp', 'utility', NULL,
  'Order {{order_no}} was delivered. How was the fabric and the delivery? Reply 1–5, or tell us about any problem. — {{company}}', '{order_no,company}', 'delivery_feedback_v1', 'approved', 'active', 'system', 'system', now()),
 ('complaint_ack_email', 'Complaint received', 'commerce.complaint.raised', 'email', 'utility', 'We have your complaint {{complaint_no}}',
  'Dear {{customer_name}},\n\nWe have registered your complaint {{complaint_no}} ("{{subject}}"). Our team will respond within one working day.\n\nRegards,\n{{company}}', '{customer_name,complaint_no,subject,company}', NULL, 'not_required', 'active', 'system', 'system', now()),
 ('payment_reminder_whatsapp', 'Payment reminder', 'finance.payment.reminder_due', 'whatsapp', 'utility', NULL,
  'Reminder: invoice {{invoice_no}} for ₹{{amount}} was due on {{due_date}} ({{days_overdue}} days ago). Please arrange payment or reply if already paid. — {{company}}', '{invoice_no,amount,due_date,days_overdue,company}', 'payment_reminder_v1', 'approved', 'active', 'system', 'system', now());

INSERT INTO rules (name, event_type, match, conditions, actions, created_by_name) VALUES
 ('Feedback call after delivery', 'fulfilment.delivered', 'all', '[]',
  '[{"type":"create_task","title":"Call {{customer_name}} for feedback on {{order_no}}","queue_permission":"commerce.order.manage","priority":"normal","due_in_hours":24,"delay_minutes":0}]', 'system'),
 ('Damaged or short delivery', 'fulfilment.delivered', 'all', '[{"field":"condition","op":"neq","value":"good"}]',
  '[{"type":"create_task","title":"Delivery problem on {{order_no}} ({{condition}}): contact {{customer_name}} and the transporter","queue_permission":"fulfilment.returns.manage","priority":"high","due_in_hours":4,"escalate_after_hours":8,"escalate_to_permission":"fulfilment.split.approve"}]', 'system'),
 ('Complaint triage', 'commerce.complaint.raised', 'all', '[]',
  '[{"type":"create_task","title":"Complaint {{complaint_no}} from {{customer_name}}: {{subject}}","queue_permission":"fulfilment.returns.manage","priority":"high","due_in_hours":4,"escalate_after_hours":24,"escalate_to_permission":"governance.approval.decide"}]', 'system'),
 ('Large order confirmed', 'crm.quotation.accepted', 'all', '[{"field":"total","op":"gte","value":500000}]',
  '[{"type":"notify","permission":"crm.price.approve","title":"Large order: {{quotation_no}} for ₹{{amount}} accepted"},{"type":"create_task","title":"Confirm delivery date and credit for {{quotation_no}}","owner_field":"owner_id","priority":"high","due_in_hours":8}]', 'system'),
 ('Overdue payment follow-up', 'finance.payment.reminder_due', 'all', '[{"field":"days_overdue","op":"gte","value":15}]',
  '[{"type":"create_task","title":"Call {{customer_name}} about {{invoice_no}} (₹{{amount}}, {{days_overdue}} days overdue)","queue_permission":"finance.voucher.post","priority":"high","due_in_hours":24}]', 'system'),
 ('Quotation follow-up after two days', 'crm.quotation.sent', 'all', '[]',
  '[{"type":"create_task","title":"Follow up quotation {{quotation_no}} with {{customer_name}}","owner_field":"owner_id","priority":"normal","due_in_hours":4,"delay_minutes":2880}]', 'system');

INSERT INTO rules (name, event_type, match, conditions, actions, created_by_name) VALUES
 ('Handover before an exit', 'hrms.employee.exiting', 'all', '[]',
  '[{"type":"create_task","title":"Hand over {{employee_name}}''s leads, tasks and contracts before {{last_working_day}}","queue_permission":"workflow.handover.manage","priority":"high","due_in_hours":72}]', 'system'),
 ('Cover for long leave', 'hrms.leave.approved', 'all', '[{"field":"days","op":"gte","value":3}]',
  '[{"type":"create_task","title":"Arrange cover for {{employee_name}} ({{from}} – {{to}}, {{days}} days)","queue_permission":"workflow.handover.manage","priority":"normal","due_in_hours":24}]', 'system');
