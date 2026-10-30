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
        <Route path="/account" element={<AccountPage />} />
        <Route path="/programme" element={<ProgrammePage />} />
        <Route path="/roadmap/:phase" element={<RoadmapPage />} />
        <Route path="*" element={<EmptyState title="Page not found" description="The page you’re looking for doesn’t exist." />} />
      </Routes>
    </Layout>
  );
}
