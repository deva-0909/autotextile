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
];

export const ALL_PERMISSION_CODES = PERMISSIONS.map((p) => p.code);

const READS = ALL_PERMISSION_CODES.filter((c) => c.endsWith('.read'));

/** Baseline roles from the developer brief (section 7) with their P1 permissions. Editable in the app. */
export const BASELINE_ROLES: { code: string; name: string; description: string; permissions: string[] }[] = [
  { code: 'super_admin', name: 'Super Admin', description: 'All configuration and platform access', permissions: ALL_PERMISSION_CODES },
  { code: 'owner', name: 'Owner / Director', description: 'Executive visibility and strategic approvals', permissions: [...READS, 'governance.approval.decide', 'masters.party.bank.view'] },
  { code: 'management_approver', name: 'Management Approver', description: 'Assigned approval authority', permissions: [...READS, 'governance.approval.decide'] },
  { code: 'purchase_manager', name: 'Purchase Manager', description: 'Procurement and supplier management', permissions: ['masters.party.read', 'masters.supplier.manage', 'masters.mill.manage', 'masters.party.bank.request', 'masters.product.read', 'masters.reference.read', 'org.entity.read', 'org.warehouse.read', 'governance.document.read', 'governance.document.upload', 'governance.approval.read'] },
  { code: 'purchase_executive', name: 'Purchase Executive', description: 'Purchase operations', permissions: ['masters.party.read', 'masters.product.read', 'masters.reference.read', 'org.warehouse.read', 'governance.document.read', 'governance.document.upload'] },
  { code: 'warehouse_manager', name: 'Stores / Warehouse Manager', description: 'Warehouse operations', permissions: ['org.warehouse.read', 'org.warehouse.manage', 'masters.product.read', 'masters.party.read', 'masters.reference.read', 'governance.document.read', 'governance.document.upload'] },
  { code: 'warehouse_operator', name: 'Warehouse Operator', description: 'Scanning and physical operations', permissions: ['org.warehouse.read', 'masters.product.read'] },
  { code: 'mill_ops_manager', name: 'Mill Operations Manager', description: 'Job-work operations', permissions: ['masters.party.read', 'masters.mill.manage', 'masters.product.read', 'org.warehouse.read', 'governance.document.read', 'governance.document.upload'] },
  { code: 'mill_user', name: 'Mill User', description: 'Mill portal actions', permissions: [] },
  { code: 'sales_manager', name: 'Sales Manager / TSM', description: 'Sales team and pipeline', permissions: ['masters.party.read', 'masters.customer.manage', 'masters.product.read', 'masters.reference.read', 'org.warehouse.read', 'governance.document.read', 'governance.document.upload', 'governance.approval.read'] },
  { code: 'sales_executive', name: 'Sales Executive / TSE', description: 'Assigned leads and customers', permissions: ['masters.party.read', 'masters.customer.manage', 'masters.product.read', 'governance.document.read', 'governance.document.upload'] },
  { code: 'accounts_manager', name: 'Accounts Manager', description: 'Accounting and statutory controls', permissions: [...READS, 'masters.party.bank.view', 'masters.party.bank.request', 'masters.reference.manage', 'governance.document.upload'] },
  { code: 'accounts_executive', name: 'Accounts Executive', description: 'Day-to-day accounting', permissions: ['masters.party.read', 'masters.reference.read', 'org.entity.read', 'governance.document.read', 'governance.document.upload'] },
  { code: 'dispatch_manager', name: 'Dispatch Manager', description: 'Dispatch and transport', permissions: ['masters.party.read', 'masters.transporter.manage', 'org.warehouse.read', 'masters.product.read', 'governance.document.read', 'governance.document.upload'] },
  { code: 'customer_care', name: 'Customer Care', description: 'Customer service and complaints', permissions: ['masters.party.read', 'masters.product.read', 'governance.document.read'] },
  { code: 'hr_manager', name: 'HR Manager', description: 'HRMS and payroll', permissions: ['identity.user.read', 'org.entity.read', 'governance.document.read', 'governance.document.upload'] },
  { code: 'customer_company_admin', name: 'Customer Company Admin', description: 'Customer portal administration', permissions: [] },
  { code: 'customer_buyer', name: 'Customer Buyer', description: 'Customer purchasing', permissions: [] },
  { code: 'customer_accounts', name: 'Customer Accounts User', description: 'Customer financial view', permissions: [] },
  { code: 'supplier_portal', name: 'Supplier Portal User', description: 'Supplier collaboration', permissions: [] },
  { code: 'transporter_portal', name: 'Transporter Portal User', description: 'Shipment updates', permissions: [] },
  { code: 'auditor', name: 'Auditor / CA', description: 'Read-only audit and compliance', permissions: [...READS, 'masters.party.bank.view'] },
];
