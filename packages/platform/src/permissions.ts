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
  since?: 'P1' | 'P2' | 'P3' | 'P4' | 'P5';
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
];

export const ALL_PERMISSION_CODES = PERMISSIONS.map((p) => p.code);

const READS = ALL_PERMISSION_CODES.filter((c) => c.endsWith('.read'));

const P2_BUY = ['procurement.read', 'procurement.requisition.create', 'procurement.rfq.manage', 'procurement.po.manage', 'procurement.receipt.record', 'procurement.invoice.read', 'procurement.invoice.capture', 'procurement.exception.manage'];
const P3_MILL = ['jobwork.read', 'jobwork.order.manage', 'jobwork.return.record', 'jobwork.claim.manage'];
const P4_STORES = ['inventory.read', 'inventory.inward.record', 'inventory.qc.record', 'inventory.move', 'inventory.reserve', 'inventory.transfer.request', 'inventory.transfer.execute', 'inventory.stocktake.count'];
const P5_SALES = ['crm.read', 'crm.lead.manage', 'crm.quote.manage', 'crm.credit.request', 'inventory.read', 'inventory.reserve', 'org.warehouse.read'];

/** Baseline roles from the developer brief (section 7). Editable in the app. */
export const BASELINE_ROLES: { code: string; name: string; description: string; permissions: string[] }[] = [
  { code: 'super_admin', name: 'Super Admin', description: 'All configuration and platform access', permissions: ALL_PERMISSION_CODES.filter((c) => !c.startsWith('portal.')) },
  { code: 'owner', name: 'Owner / Director', description: 'Executive visibility and strategic approvals', permissions: [...READS, 'governance.approval.decide', 'masters.party.bank.view', 'procurement.po.approve', 'procurement.invoice.approve', 'procurement.payment.approve', 'procurement.invoice.read', 'inventory.price.approve', 'inventory.transfer.approve', 'inventory.stocktake.approve', 'crm.lead.read_all', 'crm.price.approve', 'crm.credit.approve', 'crm.target.manage'] },
  { code: 'management_approver', name: 'Management Approver', description: 'Assigned approval authority', permissions: [...READS, 'governance.approval.decide', 'procurement.po.approve', 'procurement.invoice.approve', 'procurement.requisition.approve', 'procurement.invoice.read', 'inventory.price.approve', 'inventory.transfer.approve', 'inventory.stocktake.approve', 'crm.lead.read_all', 'crm.price.approve', 'crm.credit.approve'] },
  { code: 'purchase_manager', name: 'Purchase Manager', description: 'Procurement and supplier management', permissions: ['masters.party.read', 'masters.supplier.manage', 'masters.mill.manage', 'masters.party.bank.request', 'masters.product.read', 'masters.reference.read', 'org.entity.read', 'org.warehouse.read', 'governance.document.read', 'governance.document.upload', 'governance.approval.read', ...P2_BUY, 'procurement.requisition.approve', 'jobwork.read', 'inventory.read', 'inventory.price.tag'] },
  { code: 'purchase_executive', name: 'Purchase Executive', description: 'Purchase operations', permissions: ['masters.party.read', 'masters.product.read', 'masters.reference.read', 'org.warehouse.read', 'governance.document.read', 'governance.document.upload', 'procurement.read', 'procurement.requisition.create', 'procurement.rfq.manage', 'procurement.po.manage', 'procurement.invoice.read', 'procurement.invoice.capture'] },
  { code: 'warehouse_manager', name: 'Stores / Warehouse Manager', description: 'Warehouse operations', permissions: ['org.warehouse.read', 'org.warehouse.manage', 'masters.product.read', 'masters.party.read', 'masters.reference.read', 'governance.document.read', 'governance.document.upload', 'procurement.read', 'procurement.requisition.create', 'procurement.receipt.record', 'jobwork.read', 'jobwork.return.record', ...P4_STORES] },
  { code: 'warehouse_operator', name: 'Warehouse Operator', description: 'Scanning and physical operations', permissions: ['org.warehouse.read', 'masters.product.read', 'procurement.receipt.record', 'inventory.read', 'inventory.inward.record', 'inventory.qc.record', 'inventory.move', 'inventory.transfer.execute', 'inventory.stocktake.count'] },
  { code: 'mill_ops_manager', name: 'Mill Operations Manager', description: 'Job-work operations', permissions: ['masters.party.read', 'masters.mill.manage', 'masters.product.read', 'org.warehouse.read', 'governance.document.read', 'governance.document.upload', 'procurement.read', 'procurement.receipt.record', ...P3_MILL, 'jobwork.rate.manage', 'inventory.read', 'inventory.move'] },
  { code: 'mill_user', name: 'Mill User', description: 'Mill portal actions', permissions: ['portal.mill.access'] },
  { code: 'sales_manager', name: 'Sales Manager / TSM', description: 'Sales team and pipeline', permissions: ['masters.party.read', 'masters.customer.manage', 'masters.product.read', 'masters.reference.read', 'org.warehouse.read', 'governance.document.read', 'governance.document.upload', 'governance.approval.read', ...P5_SALES, 'crm.lead.read_all', 'crm.lead.assign', 'crm.config.manage', 'crm.target.manage', 'crm.price.approve', 'inventory.price.tag'] },
  { code: 'sales_executive', name: 'Sales Executive / TSE', description: 'Assigned leads and customers', permissions: ['masters.party.read', 'masters.customer.manage', 'masters.product.read', 'governance.document.read', 'governance.document.upload', ...P5_SALES] },
  { code: 'accounts_manager', name: 'Accounts Manager', description: 'Accounting and statutory controls', permissions: [...READS, 'masters.party.bank.view', 'masters.party.bank.request', 'masters.reference.manage', 'governance.document.upload', 'procurement.invoice.read', 'procurement.invoice.capture', 'procurement.payment.approve', 'procurement.exception.manage', 'crm.credit.approve', 'inventory.stocktake.approve'] },
  { code: 'accounts_executive', name: 'Accounts Executive', description: 'Day-to-day accounting', permissions: ['masters.party.read', 'masters.reference.read', 'org.entity.read', 'governance.document.read', 'governance.document.upload', 'procurement.read', 'procurement.invoice.read', 'procurement.invoice.capture', 'crm.read'] },
  { code: 'dispatch_manager', name: 'Dispatch Manager', description: 'Dispatch and transport', permissions: ['masters.party.read', 'masters.transporter.manage', 'org.warehouse.read', 'masters.product.read', 'governance.document.read', 'governance.document.upload', 'inventory.read', 'inventory.move', 'inventory.reserve', 'inventory.transfer.execute'] },
  { code: 'customer_care', name: 'Customer Care', description: 'Customer service and complaints', permissions: ['masters.party.read', 'masters.product.read', 'governance.document.read', 'crm.read', 'crm.lead.manage', 'inventory.read'] },
  { code: 'hr_manager', name: 'HR Manager', description: 'HRMS and payroll', permissions: ['identity.user.read', 'org.entity.read', 'governance.document.read', 'governance.document.upload'] },
  { code: 'customer_company_admin', name: 'Customer Company Admin', description: 'Customer portal administration', permissions: [] },
  { code: 'customer_buyer', name: 'Customer Buyer', description: 'Customer purchasing', permissions: [] },
  { code: 'customer_accounts', name: 'Customer Accounts User', description: 'Customer financial view', permissions: [] },
  { code: 'supplier_portal', name: 'Supplier Portal User', description: 'Supplier collaboration', permissions: ['portal.supplier.access'] },
  { code: 'transporter_portal', name: 'Transporter Portal User', description: 'Shipment updates', permissions: [] },
  { code: 'auditor', name: 'Auditor / CA', description: 'Read-only audit and compliance', permissions: [...READS, 'masters.party.bank.view', 'procurement.invoice.read', 'crm.lead.read_all'] },
];
