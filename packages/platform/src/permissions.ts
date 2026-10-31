/**
 * Permission catalog. Codes are `<service>.<resource>.<action>`.
 * Later phases append their own entries; roles reference codes, never hard-coded checks on role names.
 */
export interface PermissionDef {
  code: string;
  module: string;
  label: string;
  /** Sensitive actions are highlighted in the permission matrix and always audited. */
  sensitive?: boolean;
  /** Release that introduced the permission; baseline roles receive new ones once on upgrade. */
  since?: 'P1' | 'P2' | 'P3' | 'P4' | 'P5' | 'P6' | 'P7' | 'P8' | 'P9' | 'P10' | 'P11';
}

export const PERMISSIONS: PermissionDef[] = [
  { code: 'identity.user.read', module: 'Security', label: 'View users' },
  { code: 'identity.user.manage', module: 'Security', label: 'Create, edit and deactivate users', sensitive: true },
  { code: 'identity.role.read', module: 'Security', label: 'View roles and permissions' },
  { code: 'identity.role.manage', module: 'Security', label: 'Edit roles and permission matrix', sensitive: true },
  { code: 'identity.session.read', module: 'Security', label: 'View login history and sessions' },

  { code: 'org.entity.read', module: 'Organisation', label: 'View legal entities, GST registrations and branches' },
  { code: 'org.entity.manage', module: 'Organisation', label: 'Maintain legal entities, GST registrations and branches', sensitive: true },
  { code: 'org.warehouse.read', module: 'Organisation', label: 'View warehouses and locations' },
  { code: 'org.warehouse.manage', module: 'Organisation', label: 'Maintain warehouses and locations' },
  { code: 'org.config.read', module: 'Organisation', label: 'View configuration, numbering and fiscal years' },
  { code: 'org.config.manage', module: 'Organisation', label: 'Change configuration, numbering and fiscal years', sensitive: true },

  { code: 'masters.party.read', module: 'Master data', label: 'View customers, suppliers, mills, manufacturers and transporters' },
  { code: 'masters.customer.manage', module: 'Master data', label: 'Maintain customers' },
  { code: 'masters.supplier.manage', module: 'Master data', label: 'Maintain suppliers and manufacturers' },
  { code: 'masters.mill.manage', module: 'Master data', label: 'Maintain mills' },
  { code: 'masters.transporter.manage', module: 'Master data', label: 'Maintain transporters' },
  { code: 'masters.party.bank.view', module: 'Master data', label: 'See full bank account numbers (field-level)', sensitive: true },
  { code: 'masters.party.bank.request', module: 'Master data', label: 'Request bank account changes (maker)', sensitive: true },
  { code: 'masters.product.read', module: 'Master data', label: 'View fabric categories, attributes and SKUs' },
  { code: 'masters.product.manage', module: 'Master data', label: 'Maintain fabric categories, attributes and SKUs' },
  { code: 'masters.reference.read', module: 'Master data', label: 'View HSN, UOM, payment terms, reason codes, document types' },
  { code: 'masters.reference.manage', module: 'Master data', label: 'Maintain HSN, UOM, payment terms, reason codes, document types' },

  { code: 'governance.audit.read', module: 'Governance', label: 'View audit trail' },
  { code: 'governance.approval.read', module: 'Governance', label: 'View approval requests' },
  { code: 'governance.approval.decide', module: 'Governance', label: 'Approve or reject requests (checker)', sensitive: true },
  { code: 'governance.document.read', module: 'Governance', label: 'View and download documents' },
  { code: 'governance.document.upload', module: 'Governance', label: 'Upload documents and new versions' },
  { code: 'governance.document.delete', module: 'Governance', label: 'Archive documents', sensitive: true },

  { code: 'procurement.read', module: 'Procurement', label: 'View requisitions, RFQs, purchase orders, receipts and supplier scorecards', since: 'P2' },
  { code: 'procurement.requisition.create', module: 'Procurement', label: 'Raise purchase requisitions', since: 'P2' },
  { code: 'procurement.requisition.approve', module: 'Procurement', label: 'Approve purchase requisitions', sensitive: true, since: 'P2' },
  { code: 'procurement.rfq.manage', module: 'Procurement', label: 'Create RFQs, record quotes and award', since: 'P2' },
  { code: 'procurement.po.manage', module: 'Procurement', label: 'Create, revise, send and cancel purchase orders', since: 'P2' },
  { code: 'procurement.po.approve', module: 'Procurement', label: 'Approve purchase orders (checker)', sensitive: true, since: 'P2' },
  { code: 'procurement.receipt.record', module: 'Procurement', label: 'Record goods and mill receipts against POs', since: 'P2' },
  { code: 'procurement.invoice.read', module: 'Procurement', label: 'View supplier invoices, matching and AP ledger', since: 'P2' },
  { code: 'procurement.invoice.capture', module: 'Procurement', label: 'Upload and review supplier invoices (AI workbench)', since: 'P2' },
  { code: 'procurement.invoice.approve', module: 'Procurement', label: 'Approve invoice posting, including variances (checker)', sensitive: true, since: 'P2' },
  { code: 'procurement.payment.approve', module: 'Procurement', label: 'Approve supplier invoices for payment', sensitive: true, since: 'P2' },
  { code: 'procurement.exception.manage', module: 'Procurement', label: 'Resolve procurement exceptions', since: 'P2' },
  { code: 'portal.supplier.access', module: 'Partner portals', label: 'Supplier portal: own POs, dispatch and invoices', since: 'P2' },

  { code: 'jobwork.read', module: 'Job work', label: 'View job-work orders, mill stock, rates and claims', since: 'P3' },
  { code: 'jobwork.order.manage', module: 'Job work', label: 'Create and issue job-work orders and challans', since: 'P3' },
  { code: 'jobwork.rate.manage', module: 'Job work', label: 'Maintain process templates and mill rate cards', sensitive: true, since: 'P3' },
  { code: 'jobwork.return.record', module: 'Job work', label: 'Record return inward and yield', since: 'P3' },
  { code: 'jobwork.claim.manage', module: 'Job work', label: 'Raise and settle mill quality claims', since: 'P3' },
  { code: 'portal.mill.access', module: 'Partner portals', label: 'Mill portal: acknowledge receipts, update stages, raise invoices', since: 'P3' },

  { code: 'inventory.read', module: 'Inventory', label: 'View lots, rolls, stock ledger, availability and ageing', since: 'P4' },
  { code: 'inventory.inward.record', module: 'Inventory', label: 'Scan and weigh rolls at inward', since: 'P4' },
  { code: 'inventory.qc.record', module: 'Inventory', label: 'Inspect and grade rolls', since: 'P4' },
  { code: 'inventory.move', module: 'Inventory', label: 'Putaway, move, split and issue rolls', since: 'P4' },
  { code: 'inventory.reserve', module: 'Inventory', label: 'Reserve and release rolls; pick against reservations', since: 'P4' },
  { code: 'inventory.price.tag', module: 'Inventory', label: 'Propose selling prices for lots', since: 'P4' },
  { code: 'inventory.price.approve', module: 'Inventory', label: 'Approve selling-price changes (checker)', sensitive: true, since: 'P4' },
  { code: 'inventory.transfer.request', module: 'Inventory', label: 'Request inter-warehouse transfers', since: 'P4' },
  { code: 'inventory.transfer.approve', module: 'Inventory', label: 'Approve inter-warehouse transfers (checker)', sensitive: true, since: 'P4' },
  { code: 'inventory.transfer.execute', module: 'Inventory', label: 'Dispatch and receive transfers by scanning', since: 'P4' },
  { code: 'inventory.stocktake.count', module: 'Inventory', label: 'Run stock counts', since: 'P4' },
  { code: 'inventory.stocktake.approve', module: 'Inventory', label: 'Approve stock adjustments (checker)', sensitive: true, since: 'P4' },

  { code: 'crm.read', module: 'Sales & CRM', label: 'View CRM dashboards, customer 360 and own leads', since: 'P5' },
  { code: 'crm.lead.read_all', module: 'Sales & CRM', label: 'See every salesperson’s leads (not only your own)', since: 'P5' },
  { code: 'crm.lead.manage', module: 'Sales & CRM', label: 'Capture leads, log activities and move them through the pipeline', since: 'P5' },
  { code: 'crm.lead.assign', module: 'Sales & CRM', label: 'Assign and reassign leads; resolve duplicates', since: 'P5' },
  { code: 'crm.config.manage', module: 'Sales & CRM', label: 'Lead sources, allocation rules, sales team and attendance', since: 'P5' },
  { code: 'crm.quote.manage', module: 'Sales & CRM', label: 'Build, revise and send quotations', since: 'P5' },
  { code: 'crm.price.approve', module: 'Sales & CRM', label: 'Approve prices below margin or discount limits (checker)', sensitive: true, since: 'P5' },
  { code: 'crm.credit.request', module: 'Sales & CRM', label: 'Apply for customer credit limits', since: 'P5' },
  { code: 'crm.credit.approve', module: 'Sales & CRM', label: 'Approve credit limits, blocks and overrides (checker)', sensitive: true, since: 'P5' },
  { code: 'crm.target.manage', module: 'Sales & CRM', label: 'Set sales targets and view team performance', since: 'P5' },

  { code: 'commerce.read', module: 'B2B commerce', label: 'View sales orders, payments, wallets and token policies', since: 'P6' },
  { code: 'commerce.order.manage', module: 'B2B commerce', label: 'Place and cancel orders for customers; request reservation extensions', since: 'P6' },
  { code: 'commerce.policy.manage', module: 'B2B commerce', label: 'Propose token policies and catalogue rules', sensitive: true, since: 'P6' },
  { code: 'commerce.policy.approve', module: 'B2B commerce', label: 'Approve token policies and reservation extensions (checker)', sensitive: true, since: 'P6' },
  { code: 'commerce.payment.manage', module: 'B2B commerce', label: 'Payment links, refunds and reconciliation', sensitive: true, since: 'P6' },
  { code: 'commerce.registration.approve', module: 'B2B commerce', label: 'Approve customer registrations and portal access', since: 'P6' },
  { code: 'portal.customer.order', module: 'Partner portals', label: 'Customer portal: catalogue, cart, orders and payments', since: 'P6' },
  { code: 'portal.customer.approve', module: 'Partner portals', label: 'Customer portal: approve the company’s orders', since: 'P6' },
  { code: 'portal.customer.accounts', module: 'Partner portals', label: 'Customer portal: invoices, payments and advance balance', since: 'P6' },
  { code: 'portal.customer.admin', module: 'Partner portals', label: 'Customer portal: manage company users and settings', since: 'P6' },

  { code: 'fulfilment.read', module: 'Fulfilment', label: 'View allocation, fulfilment, dispatch, shipments and returns', since: 'P7' },
  { code: 'fulfilment.allocate', module: 'Fulfilment', label: 'Confirm or override warehouse allocation; request split fulfilment', since: 'P7' },
  { code: 'fulfilment.split.approve', module: 'Fulfilment', label: 'Approve multi-warehouse fulfilment (management)', sensitive: true, since: 'P7' },
  { code: 'fulfilment.pick', module: 'Fulfilment', label: 'Pick and pack by scanning', since: 'P7' },
  { code: 'fulfilment.invoice', module: 'Fulfilment', label: 'Generate GST invoices for fulfilments', sensitive: true, since: 'P7' },
  { code: 'fulfilment.dispatch', module: 'Fulfilment', label: 'Book transport, dispatch and update shipments', since: 'P7' },
  { code: 'fulfilment.gate.approve', module: 'Fulfilment', label: 'Approve dispatch without invoice or payment (checker)', sensitive: true, since: 'P7' },
  { code: 'fulfilment.transport.manage', module: 'Fulfilment', label: 'Maintain freight rates', since: 'P7' },
  { code: 'fulfilment.returns.manage', module: 'Fulfilment', label: 'Authorise returns, record disposition, raise transport claims', since: 'P7' },

  { code: 'finance.read', module: 'Finance', label: 'View ledgers, vouchers, statements, GST and TDS registers', since: 'P8' },
  { code: 'finance.voucher.post', module: 'Finance', label: 'Enter journals, receipts, payments and contra vouchers (maker)', sensitive: true, since: 'P8' },
  { code: 'finance.voucher.approve', module: 'Finance', label: 'Approve vouchers above the limit and reversals (checker)', sensitive: true, since: 'P8' },
  { code: 'finance.bank.reconcile', module: 'Finance', label: 'Import bank statements and reconcile', since: 'P8' },
  { code: 'finance.gst.manage', module: 'Finance', label: 'Prepare GST returns, import GSTR-2B, export e-invoice data', sensitive: true, since: 'P8' },
  { code: 'finance.tds.manage', module: 'Finance', label: 'Maintain TDS sections and party PAN, record challans', sensitive: true, since: 'P8' },
  { code: 'finance.period.manage', module: 'Finance', label: 'Lock periods, value inventory, close the year', sensitive: true, since: 'P8' },
  { code: 'finance.period.approve', module: 'Finance', label: 'Approve reopening a locked period (checker)', sensitive: true, since: 'P8' },
  { code: 'finance.config.manage', module: 'Finance', label: 'Maintain the chart of accounts and bank accounts', sensitive: true, since: 'P8' },
  { code: 'finance.anomaly.manage', module: 'Finance', label: 'Review and close financial anomaly alerts', since: 'P8' },

  { code: 'workflow.read', module: 'Workflow', label: 'View message templates, delivery log, rules and all tasks', since: 'P9' },
  { code: 'workflow.template.manage', module: 'Workflow', label: 'Draft message templates, record consent, retry failed messages', since: 'P9' },
  { code: 'workflow.template.approve', module: 'Workflow', label: 'Approve message templates before they go live (checker)', sensitive: true, since: 'P9' },
  { code: 'workflow.rule.manage', module: 'Workflow', label: 'Build and change workflow rules', sensitive: true, since: 'P9' },
  { code: 'workflow.task.manage', module: 'Workflow', label: 'Assign and reassign other people’s tasks (team lead)', since: 'P9' },
  { code: 'workflow.contract.read', module: 'Workflow', label: 'View the contract register', since: 'P9' },
  { code: 'workflow.contract.manage', module: 'Workflow', label: 'Create, amend, renew and terminate contracts', sensitive: true, since: 'P9' },
  { code: 'workflow.handover.manage', module: 'Workflow', label: 'Hand over a person’s open work to a colleague', sensitive: true, since: 'P9' },
  { code: 'hrms.read', module: 'HR & payroll', label: 'View employees, attendance and leave', since: 'P9' },
  { code: 'hrms.employee.manage', module: 'HR & payroll', label: 'Hire, onboard, confirm, transfer and exit employees', sensitive: true, since: 'P9' },
  { code: 'hrms.attendance.manage', module: 'HR & payroll', label: 'Mark and correct attendance, shifts and overtime', since: 'P9' },
  { code: 'hrms.leave.approve', module: 'HR & payroll', label: 'Approve leave and comp-off (checker)', since: 'P9' },
  { code: 'hrms.payroll.manage', module: 'HR & payroll', label: 'Set salary structures and prepare payroll', sensitive: true, since: 'P9' },
  { code: 'hrms.payroll.approve', module: 'HR & payroll', label: 'Approve and release payroll (checker)', sensitive: true, since: 'P9' },

  { code: 'insights.read', module: 'Insights & AI', label: 'Dashboards, reports and intelligence (within your own data access)', since: 'P10' },
  { code: 'insights.report.manage', module: 'Insights & AI', label: 'Save, share and schedule reports', since: 'P10' },
  { code: 'insights.ai.use', module: 'Insights & AI', label: 'Use the business assistant (read-only)', since: 'P10' },
  { code: 'system.health.read', module: 'Continuity', label: 'View system health, event bus and backups', since: 'P10' },
  { code: 'system.backup.manage', module: 'Continuity', label: 'Run backups, restore tests and event replays', sensitive: true, since: 'P10' },

  { code: 'golive.read', module: 'Go-live', label: 'View migration, UAT, training and cutover status', since: 'P11' },
  { code: 'golive.migration.manage', module: 'Go-live', label: 'Upload, validate and load migration batches', sensitive: true, since: 'P11' },
  { code: 'golive.migration.signoff', module: 'Go-live', label: 'Sign off reconciled migration batches (business owner)', sensitive: true, since: 'P11' },
  { code: 'golive.uat.execute', module: 'Go-live', label: 'Run UAT scenarios and log defects', since: 'P11' },
  { code: 'golive.uat.signoff', module: 'Go-live', label: 'Sign off UAT, waive scenarios and take the go/no-go decision', sensitive: true, since: 'P11' },
  { code: 'golive.cutover.manage', module: 'Go-live', label: 'Run the cutover checklist and hypercare incidents', since: 'P11' },
];

export const ALL_PERMISSION_CODES = PERMISSIONS.map((p) => p.code);

const READS = ALL_PERMISSION_CODES.filter((c) => c.endsWith('.read'));

const P2_BUY = ['procurement.read', 'procurement.requisition.create', 'procurement.rfq.manage', 'procurement.po.manage', 'procurement.receipt.record', 'procurement.invoice.read', 'procurement.invoice.capture', 'procurement.exception.manage'];
const P3_MILL = ['jobwork.read', 'jobwork.order.manage', 'jobwork.return.record', 'jobwork.claim.manage'];
const P4_STORES = ['inventory.read', 'inventory.inward.record', 'inventory.qc.record', 'inventory.move', 'inventory.reserve', 'inventory.transfer.request', 'inventory.transfer.execute', 'inventory.stocktake.count'];
const P7_DISPATCH = ['fulfilment.read', 'fulfilment.pick', 'fulfilment.dispatch', 'fulfilment.transport.manage', 'fulfilment.returns.manage', 'commerce.read'];
const P8_FIN = ['finance.read', 'finance.voucher.post', 'finance.bank.reconcile', 'finance.gst.manage', 'finance.tds.manage', 'finance.period.manage', 'finance.config.manage', 'finance.anomaly.manage'];
const P9_HR = ['hrms.read', 'hrms.employee.manage', 'hrms.attendance.manage', 'hrms.leave.approve', 'hrms.payroll.manage', 'workflow.handover.manage', 'workflow.read'];
const P10_BI = ['insights.read', 'insights.report.manage', 'insights.ai.use'];
const P5_SALES = ['crm.read', 'crm.lead.manage', 'crm.quote.manage', 'crm.credit.request', 'inventory.read', 'inventory.reserve', 'org.warehouse.read'];

/** Baseline roles from the developer brief (section 7). Editable in the app. */
export const BASELINE_ROLES: { code: string; name: string; description: string; permissions: string[] }[] = [
  { code: 'super_admin', name: 'Super Admin', description: 'All configuration and platform access', permissions: ALL_PERMISSION_CODES.filter((c) => !c.startsWith('portal.')) },
  { code: 'owner', name: 'Owner / Director', description: 'Executive visibility and strategic approvals', permissions: [...READS, 'governance.approval.decide', 'masters.party.bank.view', 'procurement.po.approve', 'procurement.invoice.approve', 'procurement.payment.approve', 'procurement.invoice.read', 'inventory.price.approve', 'inventory.transfer.approve', 'inventory.stocktake.approve', 'crm.lead.read_all', 'crm.price.approve', 'crm.credit.approve', 'crm.target.manage', 'fulfilment.split.approve', 'fulfilment.gate.approve', 'commerce.policy.approve', 'finance.voucher.approve', 'finance.period.approve', 'workflow.template.approve', 'hrms.payroll.approve', 'hrms.leave.approve', ...P10_BI, 'golive.read', 'golive.migration.signoff', 'golive.uat.signoff', 'golive.cutover.manage', 'golive.uat.execute'] },
  { code: 'management_approver', name: 'Management Approver', description: 'Assigned approval authority', permissions: [...READS, 'governance.approval.decide', 'procurement.po.approve', 'procurement.invoice.approve', 'procurement.requisition.approve', 'procurement.invoice.read', 'inventory.price.approve', 'inventory.transfer.approve', 'inventory.stocktake.approve', 'crm.lead.read_all', 'crm.price.approve', 'crm.credit.approve', 'fulfilment.split.approve', 'fulfilment.gate.approve', 'commerce.policy.approve', ...P10_BI, 'golive.read', 'golive.migration.signoff', 'golive.uat.execute'] },
  { code: 'purchase_manager', name: 'Purchase Manager', description: 'Procurement and supplier management', permissions: ['masters.party.read', 'masters.supplier.manage', 'masters.mill.manage', 'masters.party.bank.request', 'masters.product.read', 'masters.reference.read', 'org.entity.read', 'org.warehouse.read', 'governance.document.read', 'governance.document.upload', 'governance.approval.read', ...P2_BUY, 'procurement.requisition.approve', 'jobwork.read', 'inventory.read', 'inventory.price.tag', 'workflow.contract.read', 'workflow.contract.manage', ...P10_BI, 'golive.read', 'golive.uat.execute'] },
  { code: 'purchase_executive', name: 'Purchase Executive', description: 'Purchase operations', permissions: ['masters.party.read', 'masters.product.read', 'masters.reference.read', 'org.warehouse.read', 'governance.document.read', 'governance.document.upload', 'procurement.read', 'procurement.requisition.create', 'procurement.rfq.manage', 'procurement.po.manage', 'procurement.invoice.read', 'procurement.invoice.capture', 'insights.read', 'insights.ai.use', 'golive.read', 'golive.uat.execute'] },
  { code: 'warehouse_manager', name: 'Stores / Warehouse Manager', description: 'Warehouse operations', permissions: ['org.warehouse.read', 'org.warehouse.manage', 'masters.product.read', 'masters.party.read', 'masters.reference.read', 'governance.document.read', 'governance.document.upload', 'procurement.read', 'procurement.requisition.create', 'procurement.receipt.record', 'jobwork.read', 'jobwork.return.record', ...P4_STORES, 'fulfilment.read', 'fulfilment.pick', 'fulfilment.dispatch', 'fulfilment.returns.manage', ...P10_BI, 'golive.read', 'golive.uat.execute'] },
  { code: 'warehouse_operator', name: 'Warehouse Operator', description: 'Scanning and physical operations', permissions: ['org.warehouse.read', 'masters.product.read', 'procurement.receipt.record', 'inventory.read', 'inventory.inward.record', 'inventory.qc.record', 'inventory.move', 'inventory.transfer.execute', 'inventory.stocktake.count', 'fulfilment.read', 'fulfilment.pick'] },
  { code: 'mill_ops_manager', name: 'Mill Operations Manager', description: 'Job-work operations', permissions: ['masters.party.read', 'masters.mill.manage', 'masters.product.read', 'org.warehouse.read', 'governance.document.read', 'governance.document.upload', 'procurement.read', 'procurement.receipt.record', ...P3_MILL, 'jobwork.rate.manage', 'inventory.read', 'inventory.move', 'workflow.contract.read', 'workflow.contract.manage', ...P10_BI, 'golive.read', 'golive.uat.execute'] },
  { code: 'mill_user', name: 'Mill User', description: 'Mill portal actions', permissions: ['portal.mill.access'] },
  { code: 'sales_manager', name: 'Sales Manager / TSM', description: 'Sales team and pipeline', permissions: ['masters.party.read', 'masters.customer.manage', 'masters.product.read', 'masters.reference.read', 'org.warehouse.read', 'governance.document.read', 'governance.document.upload', 'governance.approval.read', ...P5_SALES, 'crm.lead.read_all', 'crm.lead.assign', 'crm.config.manage', 'crm.target.manage', 'crm.price.approve', 'inventory.price.tag', 'commerce.read', 'commerce.order.manage', 'commerce.policy.manage', 'commerce.registration.approve', 'fulfilment.read', 'fulfilment.allocate', 'workflow.read', 'workflow.task.manage', 'workflow.template.manage', 'workflow.contract.read', ...P10_BI, 'golive.read', 'golive.uat.execute'] },
  { code: 'sales_executive', name: 'Sales Executive / TSE', description: 'Assigned leads and customers', permissions: ['masters.party.read', 'masters.customer.manage', 'masters.product.read', 'governance.document.read', 'governance.document.upload', ...P5_SALES, 'commerce.read', 'fulfilment.read', 'insights.read', 'insights.ai.use', 'golive.read', 'golive.uat.execute'] },
  { code: 'accounts_manager', name: 'Accounts Manager', description: 'Accounting and statutory controls', permissions: [...READS, 'masters.party.bank.view', 'masters.party.bank.request', 'masters.reference.manage', 'governance.document.upload', 'procurement.invoice.read', 'procurement.invoice.capture', 'procurement.payment.approve', 'procurement.exception.manage', 'crm.credit.approve', 'inventory.stocktake.approve', 'commerce.payment.manage', 'fulfilment.invoice', ...P8_FIN, 'finance.voucher.approve', 'workflow.contract.read', 'hrms.read', ...P10_BI, 'golive.read', 'golive.migration.manage', 'golive.uat.execute'] },
  { code: 'accounts_executive', name: 'Accounts Executive', description: 'Day-to-day accounting', permissions: ['masters.party.read', 'masters.reference.read', 'org.entity.read', 'governance.document.read', 'governance.document.upload', 'procurement.read', 'procurement.invoice.read', 'procurement.invoice.capture', 'crm.read', 'commerce.read', 'fulfilment.read', 'finance.read', 'finance.voucher.post', 'finance.bank.reconcile', 'insights.read', 'insights.ai.use', 'golive.read', 'golive.uat.execute'] },
  { code: 'dispatch_manager', name: 'Dispatch Manager', description: 'Dispatch and transport', permissions: ['masters.party.read', 'masters.transporter.manage', 'org.warehouse.read', 'masters.product.read', 'governance.document.read', 'governance.document.upload', 'inventory.read', 'inventory.move', 'inventory.reserve', 'inventory.transfer.execute', ...P7_DISPATCH, 'fulfilment.allocate', 'fulfilment.invoice', 'workflow.contract.read', ...P10_BI, 'golive.read', 'golive.uat.execute'] },
  { code: 'customer_care', name: 'Customer Care', description: 'Customer service and complaints', permissions: ['masters.party.read', 'masters.product.read', 'governance.document.read', 'crm.read', 'crm.lead.manage', 'inventory.read', 'commerce.read', 'fulfilment.read', 'fulfilment.returns.manage', 'workflow.read', 'workflow.template.manage', 'insights.read', 'insights.ai.use', 'golive.read', 'golive.uat.execute'] },
  { code: 'hr_manager', name: 'HR Manager', description: 'HRMS and payroll', permissions: ['identity.user.read', 'org.entity.read', 'org.warehouse.read', 'governance.document.read', 'governance.document.upload', ...P9_HR, ...P10_BI, 'golive.read', 'golive.uat.execute'] },
  { code: 'customer_company_admin', name: 'Customer Company Admin', description: 'Customer portal administration', permissions: ['portal.customer.order', 'portal.customer.approve', 'portal.customer.accounts', 'portal.customer.admin'] },
  { code: 'customer_buyer', name: 'Customer Buyer', description: 'Customer purchasing', permissions: ['portal.customer.order'] },
  { code: 'customer_accounts', name: 'Customer Accounts User', description: 'Customer financial view', permissions: ['portal.customer.accounts'] },
  { code: 'supplier_portal', name: 'Supplier Portal User', description: 'Supplier collaboration', permissions: ['portal.supplier.access'] },
  { code: 'transporter_portal', name: 'Transporter Portal User', description: 'Shipment updates', permissions: [] },
  { code: 'auditor', name: 'Auditor / CA', description: 'Read-only audit and compliance', permissions: [...READS, 'masters.party.bank.view', 'procurement.invoice.read', 'crm.lead.read_all', 'insights.read', 'system.health.read', 'golive.read'] },
];
