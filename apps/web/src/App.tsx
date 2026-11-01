import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useAuth } from './lib/auth';
import { Layout } from './components/Layout';
import { EmptyState, PermissionDenied, Spinner } from './components/ui';
import { ChangePasswordRequired, ForgotPasswordPage, LoginPage, ResetPasswordPage } from './pages/Login';
import { DashboardPage } from './pages/Dashboard';
import { EntitiesPage } from './pages/Entities';
import { WarehouseDetailPage, WarehousesPage } from './pages/Warehouses';
import { ConfigurationPage } from './pages/Configuration';
import { MenuAccessPage } from './pages/MenuAccess';
import { PaymentRunPage } from './pages/finance/PaymentRun';
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
import { InventoryOverview } from './pages/inventory/Overview';
import { InwardDetailPage, InwardsPage } from './pages/inventory/Inward';
import { QcPage, ScanStationPage } from './pages/inventory/Qc';
import { LotDetailPage, LotsPage, PricingPage, WarehouseMapPage } from './pages/inventory/Lots';
import { StockPage } from './pages/inventory/Stock';
import { TransferDetailPage, TransfersPage } from './pages/inventory/Transfers';
import { MillIssuesPage, ReservationsPage, StocktakeDetailPage, StocktakesPage } from './pages/inventory/Operations';
import { LeadDetailPage, LeadsPage } from './pages/crm/Leads';
import { AllocationPage } from './pages/crm/Allocation';
import { PriceApprovalsPage, QuotationBuilderPage, QuotationDetailPage, QuotationsPage } from './pages/crm/Quotations';
import { CreditDetailPage, CreditPage, Customer360Page, CustomersPage, CrmDashboard, PerformancePage } from './pages/crm/Customers';
import { MillClaims, MillHome, MillJob, MillJobs, PortalLayout, SupplierHome, SupplierOrder } from './pages/portal/Portal';
import { PayPage, RegisterPage, TrackPage } from './pages/commerce/Public';
import { CartPage, CustomerAccountPage, CustomerCompanyPage, CustomerOrderPage, CustomerOrdersPage, CustomerPortalLayout, CustomerSupportPage, ProductPage, ShopPage } from './pages/commerce/CustomerPortal';
import { CommerceOrderDetailPage, CommerceOrdersPage, ComplaintsPage, PaymentsPage, RegistrationsPage, TokenPoliciesPage, WalletPage } from './pages/commerce/Admin';
import { AllocationListPage, DispatchCockpit, FulfilmentDetailPage, OrderAllocationPage, ReturnDetailPage, ReturnsPage, ShipmentDetailPage, ShipmentsPage } from './pages/fulfilment/Fulfilment';
import { InvoicePage } from './pages/fulfilment/Invoice';
import { AgeingPage, ChartOfAccountsPage, FinanceOverview, LedgerPage, NewVoucherPage, PartyLedgerPage, VoucherDetailPage, VouchersPage } from './pages/finance/Ledger';
import { AnomaliesPage, BankPage, ClosePage, GstPage, StatementsPage, TdsPage } from './pages/finance/Compliance';
import { AllTasksPage, CommunicationsPage, ContractDetailPage, ContractsPage, HandoverPage, MyWorkPage, RuleEditorPage, RulesPage } from './pages/workflow/Workflow';
import { AttendancePage, EmployeeDetailPage, EmployeesPage, HolidaysPage, HrOverview, LeavePage, MyHrPage, PayrollPage, PayrollRunPage, PayslipPage, RecruitmentPage, SalaryRegisterPage } from './pages/hr/Hr';
import { AssistantPage, ControlTowerPage, ExceptionsPage, IntelligencePage, ReportBuilderPage, ReportsPage, SystemHealthPage } from './pages/insights/Insights';
import { CutoverPage, GoLivePage, HypercarePage, MigrationPage, TrainingPage, UatPage } from './pages/golive/GoLive';
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
        <Route path="/register" element={<RegisterPage />} />
        <Route path="/pay/:token" element={<PayPage />} />
        <Route path="/track/:token" element={<TrackPage />} />
        <Route path="*" element={<Navigate to={`/login${loc.pathname !== '/' ? `?next=${encodeURIComponent(loc.pathname + loc.search)}` : ''}`} replace />} />
      </Routes>
    );
  }
  if (mustChangePassword) return <ChangePasswordRequired />;

  // Pages opened from a shared link look the same whoever opens them.
  if (/^\/(pay|track)\//.test(loc.pathname)) {
    return (
      <Routes>
        <Route path="/pay/:token" element={<PayPage />} />
        <Route path="/track/:token" element={<TrackPage />} />
      </Routes>
    );
  }

  // Customer buyers get the B2B shop and their account.
  if (user.partyId && user.permissions.some((p) => p.startsWith('portal.customer.'))) {
    return (
      <CustomerPortalLayout>
        <Routes>
          <Route path="/shop" element={<ShopPage />} />
          <Route path="/shop/:id" element={<ProductPage />} />
          <Route path="/cart" element={<CartPage />} />
          <Route path="/portal/orders" element={<CustomerOrdersPage />} />
          <Route path="/portal/orders/:id" element={<CustomerOrderPage />} />
          <Route path="/portal/invoices/:id" element={<InvoicePage back="/portal/orders" />} />
          <Route path="/portal/account" element={<CustomerAccountPage />} />
          <Route path="/portal/support" element={<CustomerSupportPage />} />
          <Route path="/portal/company" element={<CustomerCompanyPage />} />
          <Route path="*" element={<Navigate to="/shop" replace />} />
        </Routes>
      </CustomerPortalLayout>
    );
  }

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
        <Route path="/security/menu-access" element={<Guard perms={['identity.role.manage', 'identity.user.manage']}><MenuAccessPage /></Guard>} />
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
        <Route path="/inventory" element={<Guard perms={['inventory.read']}><InventoryOverview /></Guard>} />
        <Route path="/inventory/scan" element={<Guard perms={['inventory.read']}><ScanStationPage /></Guard>} />
        <Route path="/inventory/inward" element={<Guard perms={['inventory.read']}><InwardsPage /></Guard>} />
        <Route path="/inventory/inward/:id" element={<Guard perms={['inventory.read']}><InwardDetailPage /></Guard>} />
        <Route path="/inventory/qc" element={<Guard perms={['inventory.read']}><QcPage /></Guard>} />
        <Route path="/inventory/lots" element={<Guard perms={['inventory.read']}><LotsPage /></Guard>} />
        <Route path="/inventory/lots/:id" element={<Guard perms={['inventory.read']}><LotDetailPage /></Guard>} />
        <Route path="/inventory/pricing" element={<Guard perms={['inventory.read']}><PricingPage /></Guard>} />
        <Route path="/inventory/map" element={<Guard perms={['inventory.read']}><WarehouseMapPage /></Guard>} />
        <Route path="/inventory/stock" element={<Guard perms={['inventory.read']}><StockPage /></Guard>} />
        <Route path="/inventory/transfers" element={<Guard perms={['inventory.read']}><TransfersPage /></Guard>} />
        <Route path="/inventory/transfers/:id" element={<Guard perms={['inventory.read']}><TransferDetailPage /></Guard>} />
        <Route path="/inventory/stocktakes" element={<Guard perms={['inventory.read']}><StocktakesPage /></Guard>} />
        <Route path="/inventory/stocktakes/:id" element={<Guard perms={['inventory.read']}><StocktakeDetailPage /></Guard>} />
        <Route path="/inventory/reservations" element={<Guard perms={['inventory.read']}><ReservationsPage /></Guard>} />
        <Route path="/inventory/mill-issues" element={<Guard perms={['inventory.read']}><MillIssuesPage /></Guard>} />
        <Route path="/crm" element={<Guard perms={['crm.read']}><CrmDashboard /></Guard>} />
        <Route path="/crm/leads" element={<Guard perms={['crm.read']}><LeadsPage /></Guard>} />
        <Route path="/crm/leads/:id" element={<Guard perms={['crm.read']}><LeadDetailPage /></Guard>} />
        <Route path="/crm/allocation" element={<Guard perms={['crm.read']}><AllocationPage /></Guard>} />
        <Route path="/crm/customers" element={<Guard perms={['crm.read']}><CustomersPage /></Guard>} />
        <Route path="/crm/customers/:id" element={<Guard perms={['crm.read']}><Customer360Page /></Guard>} />
        <Route path="/crm/quotations" element={<Guard perms={['crm.read']}><QuotationsPage /></Guard>} />
        <Route path="/crm/quotations/new" element={<Guard perms={['crm.quote.manage']}><QuotationBuilderPage /></Guard>} />
        <Route path="/crm/quotations/:id" element={<Guard perms={['crm.read']}><QuotationDetailPage /></Guard>} />
        <Route path="/crm/quotations/:id/edit" element={<Guard perms={['crm.quote.manage']}><QuotationBuilderPage /></Guard>} />
        <Route path="/crm/price-approvals" element={<Guard perms={['crm.read']}><PriceApprovalsPage /></Guard>} />
        <Route path="/crm/credit" element={<Guard perms={['crm.read']}><CreditPage /></Guard>} />
        <Route path="/crm/credit/:id" element={<Guard perms={['crm.read']}><CreditDetailPage /></Guard>} />
        <Route path="/crm/performance" element={<Guard perms={['crm.read']}><PerformancePage /></Guard>} />
        <Route path="/commerce/orders" element={<Guard perms={['commerce.read']}><CommerceOrdersPage /></Guard>} />
        <Route path="/commerce/orders/:id" element={<Guard perms={['commerce.read']}><CommerceOrderDetailPage /></Guard>} />
        <Route path="/commerce/token-policies" element={<Guard perms={['commerce.read']}><TokenPoliciesPage /></Guard>} />
        <Route path="/commerce/wallet" element={<Guard perms={['commerce.read']}><WalletPage /></Guard>} />
        <Route path="/commerce/payments" element={<Guard perms={['commerce.read']}><PaymentsPage /></Guard>} />
        <Route path="/commerce/registrations" element={<Guard perms={['commerce.registration.approve', 'commerce.read']}><RegistrationsPage /></Guard>} />
        <Route path="/commerce/complaints" element={<Guard perms={['commerce.read']}><ComplaintsPage /></Guard>} />
        <Route path="/fulfilment" element={<Guard perms={['fulfilment.read']}><DispatchCockpit /></Guard>} />
        <Route path="/fulfilment/allocation" element={<Guard perms={['fulfilment.read']}><AllocationListPage /></Guard>} />
        <Route path="/fulfilment/orders/:orderId" element={<Guard perms={['fulfilment.read']}><OrderAllocationPage /></Guard>} />
        <Route path="/fulfilment/invoices/:id" element={<Guard perms={['fulfilment.read']}><InvoicePage /></Guard>} />
        <Route path="/fulfilment/shipments" element={<Guard perms={['fulfilment.read']}><ShipmentsPage /></Guard>} />
        <Route path="/fulfilment/shipments/:id" element={<Guard perms={['fulfilment.read']}><ShipmentDetailPage /></Guard>} />
        <Route path="/fulfilment/returns" element={<Guard perms={['fulfilment.read']}><ReturnsPage /></Guard>} />
        <Route path="/fulfilment/returns/:id" element={<Guard perms={['fulfilment.read']}><ReturnDetailPage /></Guard>} />
        <Route path="/fulfilment/:id" element={<Guard perms={['fulfilment.read']}><FulfilmentDetailPage /></Guard>} />
        <Route path="/finance" element={<Guard perms={['finance.read']}><FinanceOverview /></Guard>} />
        <Route path="/finance/accounts" element={<Guard perms={['finance.read']}><ChartOfAccountsPage /></Guard>} />
        <Route path="/finance/ledger/:id" element={<Guard perms={['finance.read']}><LedgerPage /></Guard>} />
        <Route path="/finance/vouchers" element={<Guard perms={['finance.read']}><VouchersPage /></Guard>} />
        <Route path="/finance/vouchers/new" element={<Guard perms={['finance.voucher.post']}><NewVoucherPage /></Guard>} />
        <Route path="/finance/vouchers/:id" element={<Guard perms={['finance.read']}><VoucherDetailPage /></Guard>} />
        <Route path="/finance/receivables" element={<Guard perms={['finance.read']}><AgeingPage kind="receivables" /></Guard>} />
        <Route path="/finance/receivables/:id" element={<Guard perms={['finance.read']}><PartyLedgerPage kind="receivables" /></Guard>} />
        <Route path="/finance/payables" element={<Guard perms={['finance.read']}><AgeingPage kind="payables" /></Guard>} />
        <Route path="/finance/payment-run" element={<Guard perms={['finance.read']}><PaymentRunPage /></Guard>} />
        <Route path="/finance/payables/:id" element={<Guard perms={['finance.read']}><PartyLedgerPage kind="payables" /></Guard>} />
        <Route path="/finance/bank" element={<Guard perms={['finance.read']}><BankPage /></Guard>} />
        <Route path="/finance/gst" element={<Guard perms={['finance.read']}><GstPage /></Guard>} />
        <Route path="/finance/tds" element={<Guard perms={['finance.read']}><TdsPage /></Guard>} />
        <Route path="/finance/statements" element={<Guard perms={['finance.read']}><StatementsPage /></Guard>} />
        <Route path="/finance/close" element={<Guard perms={['finance.read']}><ClosePage /></Guard>} />
        <Route path="/finance/anomalies" element={<Guard perms={['finance.read']}><AnomaliesPage /></Guard>} />
        <Route path="/my-work" element={<MyWorkPage />} />
        <Route path="/me" element={<MyHrPage />} />
        <Route path="/workflow/communications" element={<Guard perms={['workflow.read']}><CommunicationsPage /></Guard>} />
        <Route path="/workflow/rules" element={<Guard perms={['workflow.read']}><RulesPage /></Guard>} />
        <Route path="/workflow/rules/:id" element={<Guard perms={['workflow.read']}><RuleEditorPage /></Guard>} />
        <Route path="/workflow/tasks" element={<Guard perms={['workflow.read']}><AllTasksPage /></Guard>} />
        <Route path="/workflow/handover" element={<Guard perms={['workflow.handover.manage', 'workflow.read']}><HandoverPage /></Guard>} />
        <Route path="/contracts" element={<Guard perms={['workflow.contract.read']}><ContractsPage /></Guard>} />
        <Route path="/contracts/:id" element={<Guard perms={['workflow.contract.read']}><ContractDetailPage /></Guard>} />
        <Route path="/hr" element={<Guard perms={['hrms.read']}><HrOverview /></Guard>} />
        <Route path="/hr/employees" element={<Guard perms={['hrms.read']}><EmployeesPage /></Guard>} />
        <Route path="/hr/employees/:id" element={<EmployeeDetailPage />} />
        <Route path="/hr/salaries" element={<Guard perms={['hrms.payroll.manage', 'hrms.payroll.approve']}><SalaryRegisterPage /></Guard>} />
        <Route path="/hr/holidays" element={<Guard perms={['hrms.read']}><HolidaysPage /></Guard>} />
        <Route path="/hr/attendance" element={<Guard perms={['hrms.read']}><AttendancePage /></Guard>} />
        <Route path="/hr/leave" element={<Guard perms={['hrms.read']}><LeavePage /></Guard>} />
        <Route path="/hr/recruitment" element={<Guard perms={['hrms.read']}><RecruitmentPage /></Guard>} />
        <Route path="/hr/payroll" element={<Guard perms={['hrms.payroll.manage', 'hrms.payroll.approve']}><PayrollPage /></Guard>} />
        <Route path="/hr/payroll/:month" element={<Guard perms={['hrms.payroll.manage', 'hrms.payroll.approve']}><PayrollRunPage /></Guard>} />
        <Route path="/hr/payslips/:id" element={<PayslipPage />} />
        <Route path="/insights" element={<Guard perms={['insights.read']}><ControlTowerPage /></Guard>} />
        <Route path="/insights/reports" element={<Guard perms={['insights.read']}><ReportsPage /></Guard>} />
        <Route path="/insights/reports/:id" element={<Guard perms={['insights.read']}><ReportBuilderPage /></Guard>} />
        <Route path="/insights/intelligence" element={<Guard perms={['insights.read']}><IntelligencePage /></Guard>} />
        <Route path="/insights/exceptions" element={<Guard perms={['insights.read']}><ExceptionsPage /></Guard>} />
        <Route path="/insights/assistant" element={<Guard perms={['insights.ai.use']}><AssistantPage /></Guard>} />
        <Route path="/golive" element={<Guard perms={['golive.read']}><GoLivePage /></Guard>} />
        <Route path="/golive/migration" element={<Guard perms={['golive.read']}><MigrationPage /></Guard>} />
        <Route path="/golive/uat" element={<Guard perms={['golive.read']}><UatPage /></Guard>} />
        <Route path="/golive/training" element={<Guard perms={['golive.read']}><TrainingPage /></Guard>} />
        <Route path="/golive/cutover" element={<Guard perms={['golive.read']}><CutoverPage /></Guard>} />
        <Route path="/golive/hypercare" element={<HypercarePage />} />
        <Route path="/system" element={<Guard perms={['system.health.read']}><SystemHealthPage /></Guard>} />
        <Route path="/account" element={<AccountPage />} />
        <Route path="/programme" element={<ProgrammePage />} />
        <Route path="/roadmap/:phase" element={<RoadmapPage />} />
        <Route path="*" element={<EmptyState title="Page not found" description="The page you’re looking for doesn’t exist." />} />
      </Routes>
    </Layout>
  );
}
