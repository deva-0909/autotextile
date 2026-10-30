import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useAuth } from './lib/auth';
import { Layout } from './components/Layout';
import { EmptyState, PermissionDenied, Spinner } from './components/ui';
import { ChangePasswordRequired, ForgotPasswordPage, LoginPage, ResetPasswordPage } from './pages/Login';
import { DashboardPage } from './pages/Dashboard';
import { EntitiesPage } from './pages/Entities';
import { WarehouseDetailPage, WarehousesPage } from './pages/Warehouses';
import { ConfigurationPage } from './pages/Configuration';
import { PartnerDetailPage, PartnersPage } from './pages/Partners';
import { CataloguePage } from './pages/Catalogue';
import { ReferencePage } from './pages/Reference';
import { LoginActivityPage, RolesPage, UsersPage } from './pages/Security';
import { ApprovalsPage, AuditPage, DocumentsPage } from './pages/Governance';
import { AccountPage } from './pages/Account';
import { ProgrammePage, RoadmapPage } from './pages/Programme';
import { ProcurementOverview } from './pages/procurement/Overview';
import { RequisitionsPage } from './pages/procurement/Requisitions';
import { RfqDetailPage, RfqsPage } from './pages/procurement/Rfqs';
import { PurchaseOrderDetailPage, PurchaseOrdersPage } from './pages/procurement/PurchaseOrders';
import { CaptureReviewPage, InvoiceWorkbenchPage } from './pages/procurement/InvoiceWorkbench';
import { InvoiceDetailPage, InvoicesPage } from './pages/procurement/Invoices';
import { MatchPage } from './pages/procurement/Match';
import { SuppliersPage } from './pages/procurement/Suppliers';
import { JobworkCockpit } from './pages/jobwork/Cockpit';
import { JobOrderDetailPage, JobOrdersPage } from './pages/jobwork/Orders';
import { MillDetailPage, MillsPage } from './pages/jobwork/Mills';
import { ClaimsPage } from './pages/jobwork/Claims';
import { MillClaims, MillHome, MillJob, MillJobs, PortalLayout, SupplierHome, SupplierOrder } from './pages/portal/Portal';
import type { ReactNode } from 'react';

function Guard({ perms, children }: { perms?: string[]; children: ReactNode }) {
  const { can } = useAuth();
  if (perms && !can(...perms)) return <PermissionDenied />;
  return <>{children}</>;
}

export default function App() {
  const { user, ready, mustChangePassword } = useAuth();
  const loc = useLocation();

  if (!ready) return <div className="flex h-screen items-center justify-center"><Spinner className="size-6" /></div>;

  if (!user) {
    return (
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/forgot-password" element={<ForgotPasswordPage />} />
        <Route path="/reset-password" element={<ResetPasswordPage />} />
        <Route path="*" element={<Navigate to={`/login${loc.pathname !== '/' ? `?next=${encodeURIComponent(loc.pathname + loc.search)}` : ''}`} replace />} />
      </Routes>
    );
  }
  if (mustChangePassword) return <ChangePasswordRequired />;

  // Supplier and mill users act for one business partner and only see the partner portal.
  if (user.partyId) {
    const mill = user.permissions.includes('portal.mill.access');
    return (
      <PortalLayout>
        <Routes>
          <Route path="/portal" element={mill ? <MillHome /> : <SupplierHome />} />
          <Route path="/portal/orders/:id" element={<SupplierOrder />} />
          <Route path="/portal/jobs" element={<MillJobs />} />
          <Route path="/portal/jobs/:id" element={<MillJob />} />
          <Route path="/portal/claims" element={<MillClaims />} />
          <Route path="/portal/claims/:id" element={<MillClaims />} />
          <Route path="*" element={<Navigate to="/portal" replace />} />
        </Routes>
      </PortalLayout>
    );
  }

  return (
    <Layout>
      <Routes>
        <Route path="/" element={<DashboardPage />} />
        <Route path="/login" element={<Navigate to="/" replace />} />
        <Route path="/approvals" element={<ApprovalsPage />} />
        <Route path="/approvals/:id" element={<ApprovalsPage />} />
        <Route path="/organisation/entities" element={<Guard perms={['org.entity.read']}><EntitiesPage /></Guard>} />
        <Route path="/organisation/warehouses" element={<Guard perms={['org.warehouse.read']}><WarehousesPage /></Guard>} />
        <Route path="/organisation/warehouses/:id" element={<Guard perms={['org.warehouse.read']}><WarehouseDetailPage /></Guard>} />
        <Route path="/organisation/configuration" element={<Guard perms={['org.config.read']}><ConfigurationPage /></Guard>} />
        <Route path="/partners/:type" element={<Guard perms={['masters.party.read']}><PartnersPage /></Guard>} />
        <Route path="/partners/:type/:id" element={<Guard perms={['masters.party.read']}><PartnerDetailPage /></Guard>} />
        <Route path="/catalogue" element={<Navigate to="/catalogue/products" replace />} />
        <Route path="/catalogue/:tab" element={<Guard perms={['masters.product.read']}><CataloguePage /></Guard>} />
        <Route path="/reference" element={<Guard perms={['masters.reference.read']}><ReferencePage /></Guard>} />
        <Route path="/security/users" element={<Guard perms={['identity.user.read']}><UsersPage /></Guard>} />
        <Route path="/security/roles" element={<Guard perms={['identity.role.read']}><RolesPage /></Guard>} />
        <Route path="/security/activity" element={<Guard perms={['identity.session.read']}><LoginActivityPage /></Guard>} />
        <Route path="/governance/audit" element={<Guard perms={['governance.audit.read']}><AuditPage /></Guard>} />
        <Route path="/governance/documents" element={<Guard perms={['governance.document.read']}><DocumentsPage /></Guard>} />
        <Route path="/procurement" element={<Guard perms={['procurement.read', 'procurement.invoice.read']}><ProcurementOverview /></Guard>} />
        <Route path="/procurement/requisitions" element={<Guard perms={['procurement.read']}><RequisitionsPage /></Guard>} />
        <Route path="/procurement/rfqs" element={<Guard perms={['procurement.read']}><RfqsPage /></Guard>} />
        <Route path="/procurement/rfqs/:id" element={<Guard perms={['procurement.read']}><RfqDetailPage /></Guard>} />
        <Route path="/procurement/purchase-orders" element={<Guard perms={['procurement.read']}><PurchaseOrdersPage /></Guard>} />
        <Route path="/procurement/purchase-orders/:id" element={<Guard perms={['procurement.read']}><PurchaseOrderDetailPage /></Guard>} />
        <Route path="/procurement/invoice-workbench" element={<Guard perms={['procurement.invoice.read']}><InvoiceWorkbenchPage /></Guard>} />
        <Route path="/procurement/invoice-workbench/:id" element={<Guard perms={['procurement.invoice.read']}><CaptureReviewPage /></Guard>} />
        <Route path="/procurement/invoices" element={<Guard perms={['procurement.invoice.read']}><InvoicesPage /></Guard>} />
        <Route path="/procurement/invoices/:id" element={<Guard perms={['procurement.invoice.read']}><InvoiceDetailPage /></Guard>} />
        <Route path="/procurement/match" element={<Guard perms={['procurement.invoice.read', 'procurement.read']}><MatchPage /></Guard>} />
        <Route path="/procurement/suppliers" element={<Guard perms={['procurement.read']}><SuppliersPage /></Guard>} />
        <Route path="/jobwork" element={<Guard perms={['jobwork.read']}><JobworkCockpit /></Guard>} />
        <Route path="/jobwork/deadlines" element={<Navigate to="/jobwork" replace />} />
        <Route path="/jobwork/orders" element={<Guard perms={['jobwork.read']}><JobOrdersPage /></Guard>} />
        <Route path="/jobwork/orders/:id" element={<Guard perms={['jobwork.read']}><JobOrderDetailPage /></Guard>} />
        <Route path="/jobwork/mills" element={<Guard perms={['jobwork.read']}><MillsPage /></Guard>} />
        <Route path="/jobwork/mills/:id" element={<Guard perms={['jobwork.read']}><MillDetailPage /></Guard>} />
        <Route path="/jobwork/claims" element={<Guard perms={['jobwork.read']}><ClaimsPage /></Guard>} />
        <Route path="/jobwork/claims/:id" element={<Navigate to="/jobwork/claims" replace />} />
        <Route path="/account" element={<AccountPage />} />
        <Route path="/programme" element={<ProgrammePage />} />
        <Route path="/roadmap/:phase" element={<RoadmapPage />} />
        <Route path="*" element={<EmptyState title="Page not found" description="The page you’re looking for doesn’t exist." />} />
      </Routes>
    </Layout>
  );
}
