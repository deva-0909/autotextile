import {
  Banknote, Boxes, Building2, ClipboardCheck, Cog, Factory, FileStack, History, KeyRound, Layers, LayoutDashboard, LineChart, Package,
  Rocket, ShieldCheck, ShoppingCart, Sparkles, Truck, UserCog, Users, Warehouse, Workflow, BookMarked, type LucideIcon,
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
      { to: '/roadmap/P2', label: 'Procurement', icon: ShoppingCart, phase: 'P2' },
      { to: '/roadmap/P3', label: 'Mill job work', icon: Factory, phase: 'P3' },
      { to: '/roadmap/P4', label: 'Inventory & WMS', icon: Boxes, phase: 'P4' },
      { to: '/roadmap/P5', label: 'CRM & sales', icon: LineChart, phase: 'P5' },
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
