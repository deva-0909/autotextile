import {
  ArrowRightLeft, BadgeIndianRupee, CircleDollarSign, ClipboardPen, Contact, Inbox, Map as MapIcon, PackageCheck, PackageOpen, ScanLine, Shuffle, Tag, Target,
  AlarmClock, Banknote, BookMarked, Boxes, Building2, ClipboardCheck, ClipboardList, Cog, Factory, FileSearch, FileStack, Gauge, History, KeyRound, Layers,
  LayoutDashboard, LineChart, Medal, Package, Receipt, Rocket, ScanText, ShieldAlert, ShieldCheck, ShoppingCart, Sparkles, Truck, UserCog, Users, Warehouse,
  Workflow, type LucideIcon,
} from 'lucide-react';

export interface NavItem { to: string; label: string; icon: LucideIcon; perms?: string[]; phase?: string }
export interface NavGroup { label: string; items: NavItem[] }

export const NAV: NavGroup[] = [
  {
    label: 'Overview',
    items: [
      { to: '/', label: 'Dashboard', icon: LayoutDashboard },
      { to: '/approvals', label: 'Approvals', icon: ClipboardCheck },
    ],
  },
  {
    label: 'Organisation',
    items: [
      { to: '/organisation/entities', label: 'Entities & GST', icon: Building2, perms: ['org.entity.read'] },
      { to: '/organisation/warehouses', label: 'Warehouses', icon: Warehouse, perms: ['org.warehouse.read'] },
      { to: '/organisation/configuration', label: 'Configuration', icon: Cog, perms: ['org.config.read'] },
    ],
  },
  {
    label: 'Master data',
    items: [
      { to: '/partners/customer', label: 'Business partners', icon: Users, perms: ['masters.party.read'] },
      { to: '/catalogue/products', label: 'Fabric catalogue', icon: Package, perms: ['masters.product.read'] },
      { to: '/reference', label: 'Reference data', icon: BookMarked, perms: ['masters.reference.read'] },
    ],
  },
  {
    label: 'Procurement',
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
    items: [
      { to: '/jobwork', label: 'Deadline cockpit', icon: AlarmClock, perms: ['jobwork.read'] },
      { to: '/jobwork/orders', label: 'Job-work orders', icon: Factory, perms: ['jobwork.read'] },
      { to: '/jobwork/mills', label: 'Mills & rates', icon: Building2, perms: ['jobwork.read'] },
      { to: '/jobwork/claims', label: 'Quality claims', icon: ShieldAlert, perms: ['jobwork.read'] },
    ],
  },
  {
    label: 'Inventory & warehouse',
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
    items: [
      { to: '/crm', label: 'Sales overview', icon: LineChart, perms: ['crm.read'] },
      { to: '/crm/leads', label: 'Lead inbox', icon: Inbox, perms: ['crm.read'] },
      { to: '/crm/customers', label: 'Customers', icon: Contact, perms: ['crm.read'] },
      { to: '/crm/quotations', label: 'Quotations', icon: FileStack, perms: ['crm.read'] },
      { to: '/crm/price-approvals', label: 'Price approvals', icon: BadgeIndianRupee, perms: ['crm.price.approve', 'crm.lead.read_all'] },
      { to: '/crm/credit', label: 'Customer credit', icon: CircleDollarSign, perms: ['crm.read'] },
      { to: '/crm/allocation', label: 'Lead allocation', icon: Shuffle, perms: ['crm.read'] },
      { to: '/crm/performance', label: 'Targets & performance', icon: Target, perms: ['crm.read'] },
    ],
  },
  {
    label: 'Security & governance',
    items: [
      { to: '/security/users', label: 'Users', icon: UserCog, perms: ['identity.user.read'] },
      { to: '/security/roles', label: 'Roles & permissions', icon: KeyRound, perms: ['identity.role.read'] },
      { to: '/security/activity', label: 'Login activity', icon: ShieldCheck, perms: ['identity.session.read'] },
      { to: '/governance/audit', label: 'Audit trail', icon: History, perms: ['governance.audit.read'] },
      { to: '/governance/documents', label: 'Documents', icon: FileStack, perms: ['governance.document.read'] },
    ],
  },
  {
    label: 'Coming next',
    items: [
      { to: '/roadmap/P6', label: 'B2B commerce', icon: Layers, phase: 'P6' },
      { to: '/roadmap/P7', label: 'Dispatch & transport', icon: Truck, phase: 'P7' },
      { to: '/roadmap/P8', label: 'Accounting & GST', icon: Banknote, phase: 'P8' },
      { to: '/roadmap/P9', label: 'Workflow & HRMS', icon: Workflow, phase: 'P9' },
      { to: '/roadmap/P10', label: 'BI & AI', icon: Sparkles, phase: 'P10' },
      { to: '/programme', label: 'Programme tracker', icon: Rocket },
    ],
  },
];

export const ALL_ITEMS = NAV.flatMap((g) => g.items.map((i) => ({ ...i, group: g.label })));
