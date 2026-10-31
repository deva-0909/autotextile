-- Go-live (P11): data migration with validation and reconciliation, UAT scenarios and defects, sign-offs,
-- role-based training, cutover checklist, go/no-go and hypercare incidents.

CREATE TABLE migration_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number text NOT NULL UNIQUE,
  object_type text NOT NULL CHECK (object_type IN ('parties','opening_balances','opening_gl','opening_stock')),
  file_name text,
  status text NOT NULL DEFAULT 'validated' CHECK (status IN ('validated','importing','imported','reconciled','signed_off','abandoned')),
  rows int NOT NULL DEFAULT 0, valid int NOT NULL DEFAULT 0, invalid int NOT NULL DEFAULT 0, imported int NOT NULL DEFAULT 0, failed int NOT NULL DEFAULT 0,
  control_label text, source_total numeric, erp_total numeric, difference numeric, reconciliation jsonb,
  signed_off_by_name text, signed_off_at timestamptz, notes text,
  created_by_name text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE migration_rows (
  id bigserial PRIMARY KEY,
  batch_id uuid NOT NULL REFERENCES migration_batches(id) ON DELETE CASCADE,
  row_no int NOT NULL,
  data jsonb NOT NULL,
  errors text[] NOT NULL DEFAULT '{}',
  status text NOT NULL CHECK (status IN ('valid','invalid','imported','failed','skipped')),
  result_ref text, error text
);

CREATE TABLE uat_scenarios (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  phase text NOT NULL, module text NOT NULL, requirement_id text,
  category text NOT NULL CHECK (category IN ('normal','exception','permission','concurrency','tax','barcode','integration','performance','security','backup')),
  title text NOT NULL, steps text NOT NULL, expected text NOT NULL, role text,
  status text NOT NULL DEFAULT 'not_run' CHECK (status IN ('not_run','passed','failed','blocked','waived')),
  executed_by_name text, executed_at timestamptz, evidence text, waiver_reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE uat_runs (
  id bigserial PRIMARY KEY,
  scenario_id uuid NOT NULL REFERENCES uat_scenarios(id),
  result text NOT NULL, evidence text, by_name text NOT NULL, at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE defects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number text NOT NULL UNIQUE,
  scenario_id uuid REFERENCES uat_scenarios(id),
  title text NOT NULL, description text NOT NULL,
  severity text NOT NULL CHECK (severity IN ('S1','S2','S3','S4')),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','fixed','retest','closed','rejected')),
  module text, assigned_to_name text, raised_by_name text NOT NULL, resolution text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), closed_at timestamptz
);
CREATE TABLE signoffs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope text NOT NULL,
  decision text NOT NULL CHECK (decision IN ('approved','rejected')),
  conditions text, criteria jsonb NOT NULL,
  signed_by_name text NOT NULL, signed_role text, at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE training_modules (
  code text PRIMARY KEY,
  role text NOT NULL, title text NOT NULL, outline text NOT NULL, duration_min int NOT NULL, screens text[] NOT NULL DEFAULT '{}'
);
CREATE TABLE training_records (
  user_id uuid NOT NULL, user_name text NOT NULL, module_code text NOT NULL REFERENCES training_modules(code),
  status text NOT NULL DEFAULT 'assigned' CHECK (status IN ('assigned','completed')),
  score int, trainer_name text, completed_at timestamptz,
  PRIMARY KEY (user_id, module_code)
);

CREATE TABLE cutover_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seq int NOT NULL, stage text NOT NULL CHECK (stage IN ('prepare','freeze','migrate','verify','go_live','hypercare')),
  title text NOT NULL, owner_role text NOT NULL,
  status text NOT NULL DEFAULT 'todo' CHECK (status IN ('todo','done','blocked','not_applicable')),
  notes text, done_by_name text, done_at timestamptz
);
CREATE TABLE go_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  decision text NOT NULL CHECK (decision IN ('go','no_go')),
  criteria jsonb NOT NULL, rollback_plan text NOT NULL, notes text,
  decided_by_name text NOT NULL, at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE incidents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number text NOT NULL UNIQUE,
  title text NOT NULL, description text NOT NULL, module text,
  severity text NOT NULL CHECK (severity IN ('P1','P2','P3','P4')),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','investigating','resolved','closed')),
  reported_by_name text NOT NULL, assigned_to_name text,
  respond_by timestamptz NOT NULL, resolve_by timestamptz NOT NULL,
  resolution text, resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE counters (doc_type text PRIMARY KEY, next_number int NOT NULL);

INSERT INTO training_modules (code, role, title, outline, duration_min, screens) VALUES
 ('ADM-1', 'Administrator', 'Users, roles, data scope and configuration', 'Create users; assign roles and warehouse/GSTIN scope; MFA; number series; settings; audit trail; system health and backups.', 90, '{/security/users,/security/roles,/organisation/configuration,/governance/audit,/system}'),
 ('PUR-1', 'Purchase', 'Requisition to purchase order', 'Requisitions, RFQs and quote comparison, POs with approval, supplier portal, receipts.', 120, '{/procurement/requisitions,/procurement/rfqs,/procurement/purchase-orders}'),
 ('PUR-2', 'Purchase', 'Supplier invoices and three-way match', 'Invoice capture (AI), review, match exceptions, payment approval, supplier scorecards.', 90, '{/procurement/invoice-workbench,/procurement/match,/procurement/suppliers}'),
 ('STO-1', 'Stores', 'Inward, QC, put-away and the scan station', 'Weigh and scan rolls, print labels, QC grades, put-away by scan (also offline), stock counts.', 120, '{/inventory/inward,/inventory/qc,/inventory/scan,/inventory/stocktakes}'),
 ('STO-2', 'Stores', 'Transfers, reservations and issue to mill', 'Inter-warehouse transfers and documents, reservations, issue to mill.', 60, '{/inventory/transfers,/inventory/reservations,/inventory/mill-issues}'),
 ('MIL-1', 'Mill operations', 'Job-work orders, stages, returns and claims', 'Challans, mill portal, stage tracking, return and yield, claims, deadlines.', 90, '{/jobwork,/jobwork/orders,/jobwork/claims}'),
 ('SAL-1', 'Sales', 'Leads, follow-ups and quotations', 'Lead inbox, pipeline rules, quotation builder, price approvals, credit, My Work follow-ups.', 120, '{/crm/leads,/crm/quotations,/my-work}'),
 ('SAL-2', 'Sales', 'Orders, portal customers and payments', 'Phone orders, token policies, payment links, customer portal support.', 60, '{/commerce/orders,/commerce/payments,/commerce/token-policies}'),
 ('ACC-1', 'Accounts', 'Daily accounting', 'Vouchers and approvals, receivables and payables, bank reconciliation, customer advances.', 120, '{/finance/vouchers,/finance/receivables,/finance/bank}'),
 ('ACC-2', 'Accounts', 'GST, TDS and period close', 'GSTR-1/3B, 2B matching, e-invoice data, TDS challans, period lock, statements.', 120, '{/finance/gst,/finance/tds,/finance/close,/finance/statements}'),
 ('DSP-1', 'Dispatch', 'Allocation to proof of delivery', 'Warehouse decision and splits, pick by scan, pack, invoice, dispatch gates, transport, POD, returns.', 120, '{/fulfilment,/fulfilment/allocation,/fulfilment/shipments,/fulfilment/returns}'),
 ('HR-1', 'HR', 'People, attendance, leave and payroll', 'Employees and lifecycle, daily attendance, leave approvals, payroll run and payslips, handover.', 120, '{/hr,/hr/attendance,/hr/payroll,/workflow/handover}'),
 ('MGT-1', 'Management', 'Approvals, control tower and assistant', 'Approvals inbox, control tower, reports, intelligence, exception centre, the assistant.', 60, '{/approvals,/insights,/insights/assistant}'),
 ('CUS-1', 'Customer portal', 'Ordering and paying on the trade portal', 'Catalogue, cart, token payment, order tracking, invoices, returns, company users.', 30, '{/shop,/portal/orders}'),
 ('PAR-1', 'Partner portals', 'Supplier and mill portals', 'PO acceptance and dispatch, invoices; mill receipt, stages and returns.', 30, '{/portal}');

INSERT INTO cutover_tasks (seq, stage, title, owner_role) VALUES
 (10, 'prepare', 'Production server ready: Windows service for npm start, PostgreSQL 17, firewall, TLS certificate, APP_PUBLIC_URL set', 'IT'),
 (20, 'prepare', 'Nightly backup scheduled (npm run backup -- --verify) and off-site copy configured; first restore drill done', 'IT'),
 (30, 'prepare', 'All users created with roles and data scope; MFA on for administrators and approvers', 'IT'),
 (40, 'prepare', 'Tax configuration (GST rates, HSN, TDS sections, PT slabs, payroll rules) signed off by the CA', 'Accounts'),
 (50, 'prepare', 'Every role trained (training tracker 100% for go-live users)', 'HR'),
 (60, 'prepare', 'UAT signed off by business owners; no open S1/S2 defects', 'Management'),
 (70, 'freeze', 'Freeze the legacy system: no new entries after the cut-off time; final legacy reports printed', 'Accounts'),
 (80, 'freeze', 'Physical stock count of every warehouse and mill at cut-off', 'Stores'),
 (90, 'migrate', 'Load customers and suppliers; reconcile counts', 'IT'),
 (100, 'migrate', 'Load opening stock by lot and roll; reconcile kg and value to the count', 'Stores'),
 (110, 'migrate', 'Load opening receivables, payables and advances; reconcile to legacy ageing', 'Accounts'),
 (120, 'migrate', 'Load the opening trial balance; reconcile totals; checker approves the opening voucher', 'Accounts'),
 (130, 'verify', 'Business owners sign off each migration batch', 'Management'),
 (140, 'verify', 'Smoke test: one PO, one receipt, one sale with payment, one dispatch, one voucher in production', 'IT'),
 (150, 'go_live', 'Go/no-go meeting recorded; rollback plan confirmed', 'Management'),
 (160, 'go_live', 'Announce go-live to staff, customers (portal), suppliers and mills (portals)', 'Management'),
 (170, 'hypercare', 'Daily hypercare call for two weeks; incidents logged with severity and owner', 'IT'),
 (180, 'hypercare', 'First month-end close in the ERP completed and reconciled', 'Accounts'),
 (190, 'hypercare', 'Stabilisation sign-off: no open P1/P2 incidents for five working days', 'Management');
