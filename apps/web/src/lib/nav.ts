import {
  ArrowRightLeft, BadgeIndianRupee, Handshake, ChartColumn, SlidersHorizontal, Wrench, CircleDollarSign, ClipboardPen, Contact, Inbox, Map as MapIcon, PackageCheck, PackageOpen, ScanLine, Shuffle, Tag, Target,
  AlarmClock, BookMarked, Boxes, Building2, ClipboardCheck, ClipboardList, Cog, Factory, FileSearch, FileStack, Gauge, History, KeyRound, Layers,
  LayoutDashboard, LineChart, Medal, Package, Receipt, Rocket, ScanText, ShieldAlert, ShieldCheck, ShoppingCart, Truck, UserCog, Users, Warehouse,
  Workflow, Wallet, Radar, FileBarChart, BrainCircuit, Bot, HeartPulse, TriangleAlert, ListTodo, UserCircle, MessagesSquare, FileSignature, ArrowRightLeft as Handover, CalendarCheck, CalendarDays, Briefcase, IndianRupee, Users2, ListChecks, BookOpen, FileSpreadsheet, Landmark, Percent, ScrollText, Scale, LockKeyhole, Siren, HandCoins, ArrowDownToLine, CreditCard, UserPlus, MessageSquareWarning, Undo2, Store, GraduationCap, LifeBuoy, Milestone, PanelsTopLeft, Send, type LucideIcon,
} from 'lucide-react';

export interface NavItem { to: string; label: string; icon: LucideIcon; perms?: string[]; phase?: string }
export interface NavGroup { label: string; icon?: LucideIcon; items: NavItem[] }

export const NAV: NavGroup[] = [
  {
    label: 'Overview',
    icon: LayoutDashboard,
    items: [
      { to: '/', label: 'Dashboard', icon: LayoutDashboard },
      { to: '/approvals', label: 'Approvals', icon: ClipboardCheck },
      { to: '/my-work', label: 'My work', icon: ListTodo },
      { to: '/me', label: 'My HR', icon: UserCircle },
    ],
  },
  {
    label: 'Insights & AI',
    icon: Radar,
    items: [
      { to: '/insights', label: 'Control tower', icon: Radar, perms: ['insights.read'] },
      { to: '/insights/assistant', label: 'Assistant', icon: Bot, perms: ['insights.ai.use'] },
      { to: '/insights/reports', label: 'Reports', icon: FileBarChart, perms: ['insights.read'] },
      { to: '/insights/intelligence', label: 'Intelligence', icon: BrainCircuit, perms: ['insights.read'] },
      { to: '/insights/exceptions', label: 'Exception centre', icon: TriangleAlert, perms: ['insights.read'] },
    ],
  },
  {
    label: 'Organisation',
    icon: Building2,
    items: [
      { to: '/organisation/entities', label: 'Entities & GST', icon: Building2, perms: ['org.entity.read'] },
      { to: '/organisation/warehouses', label: 'Warehouses', icon: Warehouse, perms: ['org.warehouse.read'] },
      { to: '/organisation/configuration', label: 'Configuration', icon: Cog, perms: ['org.config.read'] },
    ],
  },
  {
    label: 'Master data',
    icon: BookMarked,
    items: [
      { to: '/partners/customer', label: 'Business partners', icon: Users, perms: ['masters.party.read'] },
      { to: '/catalogue/products', label: 'Fabric catalogue', icon: Package, perms: ['masters.product.read'] },
      { to: '/reference', label: 'Reference data', icon: BookMarked, perms: ['masters.reference.read'] },
    ],
  },
  {
    label: 'Procurement',
    icon: ShoppingCart,
    items: [
      { to: '/procurement', label: 'Overview', icon: Gauge, perms: ['procurement.read', 'procurement.invoice.read'] },
      { to: '/procurement/requisitions', label: 'Requisitions', icon: ClipboardList, perms: ['procurement.read'] },
      { to: '/procurement/rfqs', label: 'RFQs & quotes', icon: FileSearch, perms: ['procurement.read'] },
      { to: '/procurement/purchase-orders', label: 'Purchase orders', icon: ShoppingCart, perms: ['procurement.read'] },
      { to: '/procurement/invoice-workbench', label: 'Invoice workbench', icon: ScanText, perms: ['procurement.invoice.read'] },
      { to: '/procurement/invoices', label: 'Supplier invoices & AP', icon: Receipt, perms: ['procurement.invoice.read'] },
      { to: '/procurement/match', label: 'Three-way match', icon: ShieldAlert, perms: ['procurement.invoice.read', 'procurement.read'] },
      { to: '/procurement/suppliers', label: 'Supplier scorecards', icon: Medal, perms: ['procurement.read'] },
    ],
  },
  {
    label: 'Mill job work',
    icon: Factory,
    items: [
      { to: '/jobwork', label: 'Deadline cockpit', icon: AlarmClock, perms: ['jobwork.read'] },
      { to: '/jobwork/orders', label: 'Job-work orders', icon: Factory, perms: ['jobwork.read'] },
      { to: '/jobwork/mills', label: 'Mills & rates', icon: Building2, perms: ['jobwork.read'] },
      { to: '/jobwork/claims', label: 'Quality claims', icon: ShieldAlert, perms: ['jobwork.read'] },
      { to: '/jobwork/losses', label: 'Mill losses', icon: TriangleAlert, perms: ['jobwork.read'] },
    ],
  },
  {
    label: 'Inventory & warehouse',
    icon: Warehouse,
    items: [
      { to: '/inventory', label: 'Overview', icon: Boxes, perms: ['inventory.read'] },
      { to: '/inventory/scan', label: 'Scan station', icon: ScanLine, perms: ['inventory.read'] },
      { to: '/inventory/inward', label: 'Inward', icon: PackageOpen, perms: ['inventory.read'] },
      { to: '/inventory/qc', label: 'Quality inspection', icon: ClipboardCheck, perms: ['inventory.read'] },
      { to: '/inventory/lots', label: 'Lots & rolls', icon: Package, perms: ['inventory.read'] },
      { to: '/inventory/pricing', label: 'Price tagging', icon: Tag, perms: ['inventory.read'] },
      { to: '/inventory/stock', label: 'Stock & ledger', icon: Layers, perms: ['inventory.read'] },
      { to: '/inventory/map', label: 'Warehouse map', icon: MapIcon, perms: ['inventory.read'] },
      { to: '/inventory/reservations', label: 'Reservations', icon: PackageCheck, perms: ['inventory.read'] },
      { to: '/inventory/transfers', label: 'Transfers', icon: ArrowRightLeft, perms: ['inventory.read'] },
      { to: '/inventory/mill-issues', label: 'Issue to mill', icon: Factory, perms: ['inventory.read'] },
      { to: '/inventory/stocktakes', label: 'Stock counts', icon: ClipboardPen, perms: ['inventory.read'] },
    ],
  },
  {
    label: 'Sales & CRM',
    icon: Target,
    items: [
      { to: '/crm', label: 'Sales overview', icon: LineChart, perms: ['crm.read'] },
      { to: '/crm/my-day', label: 'My day', icon: CalendarCheck, perms: ['crm.lead.manage'] },
      { to: '/crm/leads', label: 'Lead inbox', icon: Inbox, perms: ['crm.read'] },
      { to: '/crm/lead-tools', label: 'Lead tools', icon: Wrench, perms: ['crm.lead.assign'] },
      { to: '/crm/reports', label: 'Sales reports', icon: ChartColumn, perms: ['crm.read'] },
      { to: '/crm/customers', label: 'Customers', icon: Contact, perms: ['crm.read'] },
      { to: '/crm/quotations', label: 'Quotations', icon: FileStack, perms: ['crm.read'] },
      { to: '/crm/price-approvals', label: 'Price approvals', icon: BadgeIndianRupee, perms: ['crm.price.approve', 'crm.lead.read_all'] },
      { to: '/crm/credit', label: 'Customer credit', icon: CircleDollarSign, perms: ['crm.read'] },
      { to: '/crm/allocation', label: 'Lead allocation', icon: Shuffle, perms: ['crm.read'] },
      { to: '/crm/performance', label: 'Targets & performance', icon: Target, perms: ['crm.read'] },
      { to: '/crm/agents', label: 'Agents', icon: Handshake, perms: ['crm.read'] },
      { to: '/crm/settings', label: 'Lead settings', icon: SlidersHorizontal, perms: ['crm.config.manage'] },
    ],
  },
  {
    label: 'B2B commerce',
    icon: Store,
    items: [
      { to: '/commerce/orders', label: 'Sales orders', icon: Store, perms: ['commerce.read'] },
      { to: '/commerce/payments', label: 'Payments', icon: CreditCard, perms: ['commerce.read'] },
      { to: '/commerce/wallet', label: 'Customer advances', icon: Wallet, perms: ['commerce.read'] },
      { to: '/commerce/token-policies', label: 'Token policies', icon: BadgeIndianRupee, perms: ['commerce.read'] },
      { to: '/commerce/registrations', label: 'Registrations', icon: UserPlus, perms: ['commerce.registration.approve', 'commerce.read'] },
      { to: '/commerce/complaints', label: 'Complaints', icon: MessageSquareWarning, perms: ['commerce.read'] },
    ],
  },
  {
    label: 'Fulfilment',
    icon: Truck,
    items: [
      { to: '/fulfilment', label: 'Dispatch cockpit', icon: Gauge, perms: ['fulfilment.read'] },
      { to: '/fulfilment/allocation', label: 'Warehouse allocation', icon: Shuffle, perms: ['fulfilment.read'] },
      { to: '/fulfilment/shipments', label: 'Shipments & freight', icon: Truck, perms: ['fulfilment.read'] },
      { to: '/fulfilment/returns', label: 'Returns', icon: Undo2, perms: ['fulfilment.read'] },
    ],
  },
  {
    label: 'Finance',
    icon: Landmark,
    items: [
      { to: '/finance', label: 'Overview', icon: Gauge, perms: ['finance.read'] },
      { to: '/finance/vouchers', label: 'Vouchers', icon: ScrollText, perms: ['finance.read'] },
      { to: '/finance/invoices', label: 'Manual invoices', icon: Receipt, perms: ['finance.read'] },
      { to: '/finance/counter', label: 'Counter sales', icon: Store, perms: ['finance.read'] },
      { to: '/finance/cash-book', label: 'Cash book', icon: Wallet, perms: ['finance.read'] },
      { to: '/finance/accounts', label: 'Chart of accounts', icon: BookOpen, perms: ['finance.read'] },
      { to: '/finance/receivables', label: 'Receivables', icon: ArrowDownToLine, perms: ['finance.read'] },
      { to: '/finance/payables', label: 'Payables', icon: HandCoins, perms: ['finance.read'] },
      { to: '/finance/mill-deductions', label: 'Mill deductions', icon: HandCoins, perms: ['finance.read'] },
      { to: '/finance/payment-run', label: 'Payment run', icon: Send, perms: ['finance.voucher.post'] },
      { to: '/finance/bank', label: 'Bank reconciliation', icon: Landmark, perms: ['finance.read'] },
      { to: '/finance/gst', label: 'GST', icon: FileSpreadsheet, perms: ['finance.read'] },
      { to: '/finance/tds', label: 'TDS', icon: Percent, perms: ['finance.read'] },
      { to: '/finance/statements', label: 'Statements', icon: Scale, perms: ['finance.read'] },
      { to: '/finance/close', label: 'Period close', icon: LockKeyhole, perms: ['finance.read'] },
      { to: '/finance/anomalies', label: 'Alerts', icon: Siren, perms: ['finance.read'] },
    ],
  },
  {
    label: 'Workflow',
    icon: Workflow,
    items: [
      { to: '/workflow/communications', label: 'Communications', icon: MessagesSquare, perms: ['workflow.read'] },
      { to: '/workflow/rules', label: 'Workflow rules', icon: Workflow, perms: ['workflow.read'] },
      { to: '/workflow/tasks', label: 'All tasks', icon: ListChecks, perms: ['workflow.read'] },
      { to: '/contracts', label: 'Contracts', icon: FileSignature, perms: ['workflow.contract.read'] },
      { to: '/workflow/handover', label: 'Handover', icon: Handover, perms: ['workflow.handover.manage', 'workflow.read'] },
    ],
  },
  {
    label: 'HR & payroll',
    icon: Users2,
    items: [
      { to: '/hr', label: 'People', icon: Users2, perms: ['hrms.read'] },
      { to: '/hr/employees', label: 'Employees', icon: Briefcase, perms: ['hrms.read'] },
      { to: '/hr/salaries', label: 'Salary register', icon: BadgeIndianRupee, perms: ['hrms.payroll.manage', 'hrms.payroll.approve'] },
      { to: '/hr/attendance', label: 'Attendance', icon: CalendarCheck, perms: ['hrms.read'] },
      { to: '/hr/holidays', label: 'Holidays', icon: CalendarDays, perms: ['hrms.read'] },
      { to: '/hr/leave', label: 'Leave', icon: CalendarDays, perms: ['hrms.read'] },
      { to: '/hr/recruitment', label: 'Recruitment', icon: UserPlus, perms: ['hrms.read'] },
      { to: '/hr/payroll', label: 'Payroll', icon: IndianRupee, perms: ['hrms.payroll.manage', 'hrms.payroll.approve'] },
    ],
  },
  {
    label: 'Security & governance',
    icon: ShieldCheck,
    items: [
      { to: '/security/users', label: 'Users', icon: UserCog, perms: ['identity.user.read'] },
      { to: '/security/roles', label: 'Roles & permissions', icon: KeyRound, perms: ['identity.role.read'] },
      { to: '/security/menu-access', label: 'Menu access', icon: PanelsTopLeft, perms: ['identity.role.manage', 'identity.user.manage'] },
      { to: '/security/activity', label: 'Login activity', icon: ShieldCheck, perms: ['identity.session.read'] },
      { to: '/governance/audit', label: 'Audit trail', icon: History, perms: ['governance.audit.read'] },
      { to: '/governance/documents', label: 'Documents', icon: FileStack, perms: ['governance.document.read'] },
      { to: '/system', label: 'System health', icon: HeartPulse, perms: ['system.health.read'] },
    ],
  },
  {
    label: 'Go-live',
    icon: Rocket,
    items: [
      { to: '/golive', label: 'Readiness', icon: Rocket, perms: ['golive.read'] },
      { to: '/golive/migration', label: 'Data migration', icon: FileSpreadsheet, perms: ['golive.read'] },
      { to: '/golive/uat', label: 'UAT', icon: ListChecks, perms: ['golive.read'] },
      { to: '/golive/training', label: 'Training', icon: GraduationCap, perms: ['golive.read'] },
      { to: '/golive/cutover', label: 'Cutover', icon: ClipboardList, perms: ['golive.read'] },
      { to: '/golive/hypercare', label: 'Hypercare', icon: LifeBuoy },
      { to: '/programme', label: 'Programme tracker', icon: Milestone },
    ],
  },
];

export const ALL_ITEMS = NAV.flatMap((g) => g.items.map((i) => ({ ...i, group: g.label })));

/** The menu page a path belongs to (the longest matching page path), for hiding pages outside a person's menu. */
export function pageOf(pathname: string) {
  return ALL_ITEMS.filter((i) => i.to !== '/' && (pathname === i.to || pathname.startsWith(`${i.to}/`))).sort((a, b) => b.to.length - a.to.length)[0] ?? null;
}
