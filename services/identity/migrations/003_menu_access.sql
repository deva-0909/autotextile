-- Menu access: which pages each role (and, optionally, each user) sees in the menu. It sits on top of permissions:
-- a page shows only when the person also holds the permission for it. A role with no row sees every page its
-- permissions allow (Owner, Super Admin, Management Approver and Auditor by default). A user row narrows what that
-- user's roles allow. The Overview pages (dashboard, approvals, my work, my HR) are always shown.
CREATE TABLE menu_access (
  scope text NOT NULL CHECK (scope IN ('role', 'user')),
  ref text NOT NULL,            -- role code, or user id
  items text[] NOT NULL,        -- visible page paths
  updated_by_name text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scope, ref)
);

-- A sub-user works under another user (an assistant in the same role, usually with a narrower menu).
ALTER TABLE users ADD COLUMN parent_user_id uuid REFERENCES users(id);

-- Defaults: each operational role sees the modules of its own job.
INSERT INTO menu_access (scope, ref, items, updated_by_name) VALUES
  ('role', 'purchase_manager', ARRAY['/insights','/insights/reports','/insights/intelligence','/partners/customer','/catalogue/products','/reference','/procurement','/procurement/requisitions','/procurement/rfqs','/procurement/purchase-orders','/procurement/invoice-workbench','/procurement/invoices','/procurement/match','/procurement/suppliers','/jobwork','/jobwork/orders','/jobwork/mills','/jobwork/claims','/inventory','/inventory/lots','/inventory/stock','/inventory/pricing','/contracts','/workflow/tasks'], 'System default'),
  ('role', 'purchase_executive', ARRAY['/partners/customer','/catalogue/products','/procurement','/procurement/requisitions','/procurement/rfqs','/procurement/purchase-orders','/procurement/invoice-workbench','/procurement/invoices','/procurement/suppliers','/inventory/lots','/inventory/stock','/workflow/tasks'], 'System default'),
  ('role', 'warehouse_manager', ARRAY['/catalogue/products','/inventory','/inventory/scan','/inventory/inward','/inventory/qc','/inventory/lots','/inventory/pricing','/inventory/stock','/inventory/map','/inventory/reservations','/inventory/transfers','/inventory/mill-issues','/inventory/stocktakes','/fulfilment','/fulfilment/shipments','/fulfilment/returns','/workflow/tasks','/workflow/handover'], 'System default'),
  ('role', 'warehouse_operator', ARRAY['/inventory/scan','/inventory/inward','/inventory/qc','/inventory/stock','/inventory/map','/inventory/mill-issues','/inventory/stocktakes','/fulfilment'], 'System default'),
  ('role', 'mill_ops_manager', ARRAY['/partners/customer','/catalogue/products','/procurement/purchase-orders','/jobwork','/jobwork/orders','/jobwork/mills','/jobwork/claims','/inventory/lots','/inventory/stock','/inventory/mill-issues','/contracts','/workflow/tasks'], 'System default'),
  ('role', 'sales_manager', ARRAY['/insights','/insights/assistant','/insights/reports','/insights/intelligence','/partners/customer','/catalogue/products','/inventory/stock','/inventory/pricing','/crm','/crm/leads','/crm/customers','/crm/quotations','/crm/price-approvals','/crm/credit','/crm/allocation','/crm/performance','/commerce/orders','/commerce/payments','/commerce/wallet','/commerce/token-policies','/commerce/registrations','/commerce/complaints','/fulfilment','/fulfilment/shipments','/workflow/tasks'], 'System default'),
  ('role', 'sales_executive', ARRAY['/catalogue/products','/inventory/stock','/crm','/crm/leads','/crm/customers','/crm/quotations','/crm/performance','/commerce/orders','/commerce/complaints','/fulfilment/shipments','/workflow/tasks'], 'System default'),
  ('role', 'accounts_manager', ARRAY['/insights','/insights/reports','/insights/exceptions','/partners/customer','/procurement/invoice-workbench','/procurement/invoices','/procurement/match','/commerce/payments','/commerce/wallet','/fulfilment','/finance','/finance/vouchers','/finance/accounts','/finance/receivables','/finance/payables','/finance/bank','/finance/gst','/finance/tds','/finance/statements','/finance/close','/finance/anomalies','/hr/payroll','/contracts','/workflow/tasks','/governance/documents'], 'System default'),
  ('role', 'accounts_executive', ARRAY['/procurement/invoice-workbench','/procurement/invoices','/commerce/payments','/finance','/finance/vouchers','/finance/receivables','/finance/payables','/finance/bank','/finance/gst','/finance/tds','/workflow/tasks'], 'System default'),
  ('role', 'dispatch_manager', ARRAY['/partners/customer','/inventory/scan','/inventory/stock','/inventory/reservations','/inventory/transfers','/commerce/orders','/fulfilment','/fulfilment/allocation','/fulfilment/shipments','/fulfilment/returns','/workflow/tasks'], 'System default'),
  ('role', 'customer_care', ARRAY['/crm/customers','/inventory/stock','/commerce/orders','/commerce/complaints','/commerce/registrations','/fulfilment/shipments','/fulfilment/returns','/workflow/tasks'], 'System default'),
  ('role', 'hr_manager', ARRAY['/hr','/hr/employees','/hr/attendance','/hr/leave','/hr/recruitment','/hr/payroll','/contracts','/workflow/tasks'], 'System default');
