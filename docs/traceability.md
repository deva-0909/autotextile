# Requirement traceability — releases P1–P9

Source: *Textile_Trading_ERP_Development_and_Figma_Tracker.xlsx*, Requirements and Figma Screens sheets.
Statuses:
- **Built**: implemented and covered by tests.
- **Partial**: the foundation is in place; the remaining scope is listed with the phase that completes it.
- **Business**: a decision or sign-off owned by the client or CA.

## P0 — Discovery & foundation

| ID | Requirement | Status | Notes |
|---|---|---|---|
| REQ-0001 | Map purchase-to-cash and exceptions | Business | Workflow maps (brief §8) drive P2–P8 service design |
| REQ-0002 | Entity and GSTIN confirmation | Partial | Model supports any entity/GSTIN/warehouse mapping; demo values loaded pending DEC-001/002 |
| REQ-0003 | Accounting & valuation policies | Business | Valuation method is a setting flagged “CA validation” |
| REQ-0004 | Fabric attribute dictionary | Partial | Configurable dictionary built with a starter set; client to confirm the list |
| REQ-0005 | Approval & delegation matrix | Partial | Maker-checker engine built; thresholds and delegation per DEC-006 |
| REQ-0006 | Opening data & cutover | Business | Migration tooling in P11 |
| — | Solution architecture, data model, role-permission matrix | Built | `docs/architecture.md`, migrations, `permissions.ts` |

## P1 — Platform foundation

| ID | Requirement | Status | Implementation | Remaining (phase) |
|---|---|---|---|---|
| REQ-0007 | Legal entity / GST registration / branch / warehouse | **Built** | `organisation` service; GSTIN checksum + PAN match; immutable GSTIN; warehouse→GSTIN mapping; Zone→Aisle→Rack→Bin; priority order | — |
| REQ-0008 | Granular RBAC and data scope | **Built / partial** | Module/action permissions; entity/GSTIN/branch/warehouse scope enforced in SQL; maker-checker; field-level masking of bank numbers; per-permission value limit stored | Value thresholds are enforced by the actions that need them (pricing P5, payments P8); record-ownership filtering arrives with CRM (P5) |
| REQ-0009 | Immutable audit trail | **Built** | Append-only `audit_log` (DB triggers); actor, time, IP, device, session, before/after, reason, approver | — |
| REQ-0010 | Core master data | **Built / partial** | Customers, suppliers, manufacturers, mills, transporters, contacts, addresses, bank accounts, products, fabric specifications, UOM, HSN/tax, payment terms, reason codes, document types, price lists (API + list view) | Employee master with HR fields in HRMS (P9); price-list item editor screen in P5 |
| REQ-0011 | Configuration & workflow framework | **Built / partial** | Numbering per GSTIN and fiscal year, fiscal years, typed settings (token %, warehouse strategy, credit policy, dispatch gates, feature toggles) with audited changes; approval workflow for sensitive master changes | Configurable multi-step workflow engine, escalations and notification templates in P9 |
| REQ-0012 | Document management foundation | **Built / partial** | Secure upload, versioning, metadata, linking to any record, permission-based access, PDF/image preview, expiry dates, SHA-256 | Spreadsheet in-browser preview and automatic retention purge in P9 (retention years are already configured per type) |

## P2 — Procurement, supplier portal & invoice AI

| ID | Requirement | Status | Implementation | Remaining (phase) |
|---|---|---|---|---|
| REQ-0013 | Supplier onboarding and performance | **Built / partial** | Supplier master (P1) + scorecard (delivery 40 %, quality 30 %, invoice accuracy 20 %, open issues 10 %), KYC checklist, risk score, price history, disputes, recommendation | Automated bank verification (penny drop) needs a banking integration (P8) |
| REQ-0014 | RFQ and tender management | **Built / partial** | RFQ to several suppliers, quotes per supplier with lead time and terms, landed-cost comparison, award to draft PO | Quotes are entered by the buyer from the supplier’s reply or upload; suppliers cannot yet submit quotes in the portal |
| REQ-0015 | Purchase requisition and PO | **Built** | Requisition approval, PO with threshold approval, send, revise (history), cancel, close; supplier accept/reject, qty/date confirmation, dispatch and documents in the portal | — |
| REQ-0016 | Direct-to-mill purchase | **Built** | PO delivering to a mill; mill confirms receipt in its portal; event creates traceable mill stock linked to PO, dispatch and receipt | Lot/roll-level stock ledger in P4 |
| REQ-0017 | Bulk invoice OCR and extraction | **Built / partial** | Batch upload (PDF, images, multipage), Claude extraction of header, lines, HSN, taxes and totals; parallel worker queue | Throughput (100–150/hour) must be load-tested with real invoices and an API key |
| REQ-0018 | Duplicate and missing invoice detection | **Built** | Duplicate on supplier + normalised number (DB unique) and similar value; missing-invoice alert for receipts without invoices; qty/rate/tax mismatches; exceptions queue with escalation | — |
| REQ-0019 | AI exception workbench | **Built** | Split-screen review: document beside fields, per-field confidence, corrections, exception reasons, reviewer approval; never auto-posts | — |
| REQ-0020 | Supplier invoice and payment readiness | **Built / partial** | Posting to append-only supplier ledger, due dates from payment terms, payment approval, links to PO, GRN, job work and documents | Double-entry GL and bank payment files in P8 |

## P3 — Mill job work

| ID | Requirement | Status | Implementation | Remaining (phase) |
|---|---|---|---|---|
| REQ-0021 | Mill capability and commercial profile | **Built** | Mill master (P1) + processes, capacity, TAT, rate cards, performance (yield, on-time, claims), documents | — |
| REQ-0022 | Job-work order and challan | **Built / partial** | Source PO/mill stock or warehouse, product, lot reference, kg, process, rate basis, dates, transport (transporter, LR, vehicle, e-way bill no.), documents | Roll-level selection with barcodes in P4; e-way bill / e-invoice generation via GSP later |
| REQ-0023 | Mill receipt and process updates | **Built** | Mill portal: receipt acknowledgement with discrepancies, stage updates, ready for collection, invoice submission (into the AI workbench), claim responses | — |
| REQ-0024 | Configurable stage tracking | **Built** | Process templates with ordered stages, editable per process | — |
| REQ-0025 | Combination processing rate model | **Built** | Per-kg, fixed and slab rates; mill/process/product-specific; minimum charge; effective dates; rate history; rate quote | — |
| REQ-0026 | Material return, yield and loss | **Built** | Sent, received, good, rejected, damaged, balance, wastage, yield %, processing charge; low-yield exception | Stock valuation of losses in P4/P8 |
| REQ-0027 | Commercial, operational and statutory clocks | **Built / partial** | Three separate dates per order, cockpit, alerts before and escalation after | The statutory period is a setting with a placeholder value; the CA must confirm it |
| REQ-0028 | Mill QC and disputes | **Built / partial** | Defects, affected kg, photos, root cause, responsibility, debit/credit amount, mill response, closure | Debit/credit notes post to accounts in P8 |

## P4 — Inventory, barcode, warehouse management & transfers

| ID | Requirement | Status | Implementation | Remaining (phase) |
|---|---|---|---|---|
| REQ-0029 | Lot and roll barcode hierarchy | **Built / partial** | Lot → rolls, each with a barcode; partial quantities are cut into child rolls so nothing is deducted twice; labels with QR codes printed from the browser | Labels carry a QR code only; Code 128 (1-D) labels for 1-D-only scanners still to add |
| REQ-0030 | Warehouse inward and QC | **Built / partial** | Inwards from goods receipts, mill returns and opening stock; weigh and scan per roll; GSM, width, shade, dye lot; grade A/B/C/reject; out-of-spec flags; putaway from the receiving bay | Weighing-scale integration (weights are typed or come from a keyboard-wedge scale) |
| REQ-0031 | Selling price tagging | **Built / partial** | Price per kg per lot; first price direct, changes and below-margin prices approved by a checker; full history | Roll-level price overrides |
| REQ-0032 | Immutable movement-based inventory | **Built / partial** | Append-only ledger; balances derived only from movements; physical, available, reserved, allocated, in transit, at mill, QC hold, damaged, rejected; ledger ↔ roll reconciliation check | Allocation to sales orders and customer returns arrive with fulfilment (P7) |
| REQ-0033 | Warehouse locations and operations | **Built / partial** | Zones/aisles/racks/bins with receiving, QC, staging and damaged areas; directed putaway; warehouse map; cycle counts by area; pick by scan against a reservation | Optimised pick paths, batch and zone picking (P7) |
| REQ-0034 | Inter-warehouse transfer | **Built** | Request, approval, scan dispatch, LR/transporter/vehicle/e-way bill number, in transit, destination scan receipt with re-weigh, shortages written off with an exception, closure | E-way bill is entered, not generated (GSP integration later) |
| REQ-0035 | Distinct GST registration transfer | **Built / partial** | Inter-GSTIN transfers always need approval and go on a tax invoice from the source GSTIN series with IGST or CGST+SGST; event for accounting | Valuation basis and document type must be confirmed by the CA (configurable); accounting entries in P8; e-invoice IRN not generated |
| REQ-0036 | Physical verification and adjustment | **Built** | Barcode count per warehouse or area; missing, found, mis-located and weight variances; reason; maker-checker approval; ledger adjustments referenced to the count | — |
| REQ-0037 | Shade and fabric compatibility | **Built / partial** | Shade and dye-lot groups; mixing blocked without a reason (configurable to warn); customer shade acceptance/rejection enforced on reservations | Customer shade claims arrive with customer care (P7); mill shade claims are in P3 |
| REQ-0038 | Inventory ageing and slow stock | **Built** | Configurable buckets (0–30 … >365), slow and dead stock, value at cost, clearance recommendation | — |

## P5 — CRM, sales team, quotation & commercial controls

| ID | Requirement | Status | Implementation | Remaining (phase) |
|---|---|---|---|---|
| REQ-0039 | Dynamic lead source integration | **Built / partial** | Configurable sources with private webhook URLs and JSON field maps (IndiaMART, Meta, Justdial, website, WhatsApp seeded), CSV import with column mapping, manual entry | Each platform’s own push setup (Meta app/connector, WhatsApp Business API, IndiaMART CRM key) is configured on their side |
| REQ-0040 | Duplicate detection and merge | **Built** | Mobile, email and GSTIN against open leads and customers; merge, link, keep separate, escalate; merged leads stay readable; audited | — |
| REQ-0041 | Round robin and rule-based allocation | **Built / partial** | Rules by city, state, source, fabric category, language and value; round robin or least-loaded; manual assignment and reassignment history; sticky owner for repeat contacts | “Specialisation” is stored on the profile but not yet a matching criterion |
| REQ-0042 | Attendance-aware allocation | **Built / partial** | Skips absent, leave, weekly off, break, inactive and capped people; trace per lead; waiting leads retried automatically | Attendance is marked in CRM until HRMS (P9) feeds it |
| REQ-0043 | Lead pipeline and next action | **Built** | Stages as specified; no open lead without a next follow-up; lost/nurture need a reason; first-response SLA and overdue follow-up alerts | — |
| REQ-0044 | Unified customer timeline | **Built / partial** | Enquiries, quotations, prices, preferences, credit, salesperson, value, shade decisions, reservations, activity timeline | Orders, dispatch, payments/outstanding and complaints arrive with P7/P8 |
| REQ-0045 | Quotation versioning and follow-up | **Built** | Versions with validity, lot, kg, price, taxes, freight, terms, negotiation history, competitor price and lost reason; expiry automation | PDF quotation document and sending by email/WhatsApp (P9 notifications) |
| REQ-0046 | Negotiated pricing and margin approval | **Built** | List, requested, discount, cost, margin, approver and reason kept per line; per-salesperson discount authority; below-minimum margin blocked without approval | Customer-specific price lists |
| REQ-0047 | Advance and credit by approval | **Built / partial** | Advance by default; credit limit and days, one-time overrides and blocks by a checker; exposure check on order acceptance | Outstanding, ageing and the overdue hold use accounts receivable (P8) |
| REQ-0048 | Targets and incentives | **Built / partial** | Monthly targets; leads, response time, qualified, quotes, kg, revenue, margin, new/repeat customers from verified outcomes; incentive eligibility | Collections (P8); incentive slabs and payout calculation |

## P6 — B2B customer website, booking, payment & customer portal

| ID | Requirement | Status | Implementation | Remaining (phase) |
|---|---|---|---|---|
| REQ-0049 | B2B catalogue and fabric search | **Built / partial** | Catalogue from QC-passed, priced, available lots; filters by category and free text over SKU, GSM, colour; lot detail with grade, dye lot, shade and location | Product photos/swatches (no image upload yet); price visibility per customer group |
| REQ-0050 | Customer onboarding | **Built** | Public registration, checker approval creating or linking the customer master and first portal admin; company users and roles (admin, buyer, accounts) | GSTIN verification against the GST portal is manual |
| REQ-0051 | Ordering | **Built** | Cart with MOQ and availability checks, company-side approval above a limit, repeat order, cancellation with policy fee, phone orders by staff | — |
| REQ-0052 | Token policy | **Built** | Percent of taxable value excluding GST or fixed, min/max, hold days, refundability and fee; customer › product › category › campaign › default; maker-checker | — |
| REQ-0053 | Payments | **Built / partial** | Gateway adapter, signed callback + server-side verification, idempotency, sandbox bank, refunds, reconciliation report | ICICI live integration needs merchant credentials and the bank’s API spec (adapter stub refuses until configured) |
| REQ-0054 | Reservation | **Built** | Atomic reservation on allocation, expiry of unpaid orders, approved extensions, duplicate booking prevented by inventory locks | — |
| REQ-0055 | Customer portal | **Built** | Orders, token/invoice payment, invoices, tracking, POD, returns, complaints, account and company pages | Email/WhatsApp copies of updates arrive with P9 |
| REQ-0056 | Wallet / advance | **Built / partial** | Append-only advance ledger; tokens, advances, application to invoices, credit notes, cancellation fees, refunds | Ledger postings to the GL arrive with P8; refund of a credit note balance is a manual payment-link reversal |

## P7 — Order orchestration, allocation, dispatch & transport

| ID | Requirement | Status | Implementation | Remaining (phase) |
|---|---|---|---|---|
| REQ-0057 | Allocation engine | **Built** | Dispatch priority (Surat first), coverage, grade, distance band, freight, ETA, workload; comparison with reasons | Distance uses state-zone bands, not road distance |
| REQ-0058 | Manual override | **Built** | Override needs a reason; recommended and chosen options both stored and audited | — |
| REQ-0059 | Split fulfilment | **Built** | Never automatic; split request goes to management approval; one fulfilment and invoice per warehouse GSTIN | — |
| REQ-0060 | Dispatch gates | **Built** | Invoice, payment (advance applied, credit terms, approved override), e-way bill above threshold | E-way bill number is entered, not generated through the NIC API |
| REQ-0061 | Picking | **Built** | Pick list by bin, scan with weight tolerance, wrong/duplicate roll refused, unpick, pack | — |
| REQ-0062 | Transport | **Built / partial** | Freight rate cards and quotes, transporter, LR, vehicle, milestones, shareable tracking link | Live GPS from transporters |
| REQ-0063 | Delivery | **Built** | POD with received kg, condition and receiver; shortage/damage opens a transport claim | — |
| REQ-0064 | Returns | **Built / partial** | RMA request, authorisation, scan receipt, disposition, credit note credited to the customer advance | Replacement orders are created manually; e-invoice IRN for invoices/credit notes not generated (GSP integration) |

## P8 — Accounting, GST, TDS & financial control

| ID | Requirement | Status | Implementation | Remaining (phase) |
|---|---|---|---|---|
| REQ-0065 | Double-entry general ledger | **Built** | Chart of accounts, vouchers (journal, receipt, payment, contra, sales, purchase, credit note, transfer, opening, closing), trial balance, period locks with approved reopening, year-end close, audit, immutable postings | — |
| REQ-0066 | AP, AR, customer and supplier ledgers | **Built / partial** | Automatic postings from supplier/mill bills, tax invoices, credit notes, gateway receipts, refunds, cancellation fees, transfers; bill-wise FIFO ageing; party ledgers | Payroll postings arrive with P9; manual bill-wise allocation; debit notes to suppliers are entered as journals |
| REQ-0067 | GSTIN / entity-wise accounting | **Built / partial** | One book per GST registration, GSTIN-wise invoice series and tax registers, consolidated reports with inter-unit and branch-transfer elimination | Several legal entities and intercompany (other than branch transfers) not exercised in the demo |
| REQ-0068 | Landed cost and valuation | **Built / partial** | Closing stock at lot landed cost (weighted average per SKU or lot-wise), stock at mills and in transit included, posted at period close; provisional valuation in reports | Historical (back-dated) valuation; lot profitability report (P10) |
| REQ-0069 | GST tax engine and returns | **Built / partial** | CGST/SGST vs IGST by place of supply, HSN, RCM flag, ITC; GSTR-1 (B2B, B2C, CDNR, HSN) with JSON export, GSTR-3B with set-off order, GSTR-2B import and match; e-invoice payloads | IRN generation and e-way bill API need a GSP; returns are filed on the portal |
| REQ-0070 | TDS engine | **Built** | Sections, rates, single/annual thresholds, 194Q on excess, PAN/no-PAN, lower-deduction certificates, effective dates, deduction at bill, challans, due dates, 26Q quarterly summary, overdue alert | Form 26Q file in the NSDL FVU format |
| REQ-0071 | Bank statement import and reconciliation | **Built** | CSV import with header detection, duplicates, auto-match by amount/date/UTR, manual match, create entry from a line, set aside with reason, reconciliation statement | Direct bank feeds (ICICI CIB API) |
| REQ-0072 | Management and statutory reports | **Built / partial** | Trial balance, P&L, balance sheet, cash flow, customer/supplier ageing, cash and bank, working capital, DSO/DPO, inventory days, year-end close | Schedule III formatting and comparatives for the statutory audit |
| REQ-0073 | Financial anomaly detection | **Built** | Duplicate bills and payments, payments after bank changes, unusual discounts, large credit notes and refunds, sensitive manual journals, weekend/round journals, unusual ledger movement, overdue TDS, 90-day receivables | Thresholds are settings; machine-learned scoring is P10 |

## P9 — Communications, workflow automation, DMS & HRMS

| ID | Requirement | Status | Implementation | Remaining (phase) |
|---|---|---|---|---|
| REQ-0074 | WhatsApp/SMS/email integration | **Built / partial** | Templates and triggers for enquiry, quotation, booking, payment link, invoice, receipt, dispatch + LR + tracking, delivery/feedback, complaint and overdue reminders; outbox, provider adapter, sandbox | Live WhatsApp needs Meta Cloud API credentials (adapter wired, untested without them); SMS and email providers not connected; inbound WhatsApp replies (feedback scores) |
| REQ-0075 | Template manager and consent | **Built** | Language, variables checked against the trigger, versioning with maker-checker, active status, Meta template status, consent/opt-out per number and scope, delivery/read/failure status, retry with backoff, signed delivery receipts | — |
| REQ-0076 | Event-driven task engine | **Built** | Trigger, conditions (all/any), actions (task, notification, message), delay, reminders, escalation, completion with resolution; tasks carry source, owner/queue, priority, due date | Approval as a rule action (approvals come from the owning services today) |
| REQ-0077 | My Work | **Built** | Tasks, team queue, approvals, CRM follow-ups, due/overdue, take/complete/reassign, handover | — |
| REQ-0078 | Agreement and document lifecycle | **Built / partial** | Contracts with rates, validity, payment/quality/delivery terms, penalties, renewal alerts 30/15/7 days, renewals as linked versions, correspondence, full-text search, linked documents | Semantic (AI) search arrives with P10; document upload from the contract screen uses the document library |
| REQ-0079 | Employee lifecycle and attendance | **Built / partial** | Recruitment pipeline, onboarding, probation, confirmation, transfer, promotion, resignation, exit with checklists; shifts, attendance with lateness/overtime, mobile check-in with optional location, holidays, leave, weekly off, overtime and comp-off | Biometric device import; geofencing |
| REQ-0080 | Payroll and statutory components | **Built / partial** | Salary components, LOP, overtime, PF (ceiling, EPF/EPS), ESIC, PT by state, salary TDS (new regime, 87A), payslips, approval, bank file, accounting posting | Old tax regime and employee declarations; PF ECR / ESIC challan files; Form 16/24Q; arrears; to be validated by the payroll consultant/CA |
| REQ-0081 | Employee handover | **Built** | Open tasks, CRM leads and contracts moved with a reason; every item recorded; exit raises a handover task | Customer commitments other than leads/contracts (open quotations stay with the original owner) |

### Known gaps

- **MFA is optional per user.** The setting *Require MFA for privileged users* exists, but the login does not force enrolment yet.
- **Password-reset emails.** These need the notification service (P9). Until then the reset link appears on screen outside production.

## Screens

| ID | Screen | Route |
|---|---|---|
| FIG-001 | Login, MFA, password reset | `/login`, `/forgot-password`, `/reset-password`, `/account` |
| FIG-002 | Role-based home dashboard | `/` |
| FIG-003 | Legal entity & GST registration setup | `/organisation/entities` |
| FIG-004 | Warehouse & location setup | `/organisation/warehouses`, `/organisation/warehouses/:id` |
| FIG-005 | Users, roles & permission matrix | `/security/users`, `/security/roles`, `/security/activity` |
| FIG-006 | Audit log viewer | `/governance/audit` |
| FIG-007 | Customer / supplier / mill / product masters | `/partners/:type`, `/partners/:type/:id`, `/catalogue/*`, `/reference` |
| FIG-008 | Supplier onboarding and profile | `/procurement/suppliers`, `/partners/supplier/:id` |
| FIG-009 | RFQ creation and supplier invitation | `/procurement/rfqs` |
| FIG-010 | Quote comparison | `/procurement/rfqs/:id` |
| FIG-011 | Purchase requisition and PO | `/procurement/requisitions`, `/procurement/purchase-orders/:id` |
| FIG-012 | Supplier PO response and dispatch update | `/portal`, `/portal/orders/:id` (supplier user) |
| FIG-013 | Invoice batch upload and queue | `/procurement/invoice-workbench` |
| FIG-014 | Invoice split-screen review | `/procurement/invoice-workbench/:id` |
| FIG-015 | Missing invoice and three-way match dashboard | `/procurement/match`, `/procurement/invoices` |
| FIG-016 | Mill master and capability profile | `/jobwork/mills`, `/jobwork/mills/:id` |
| FIG-017 | Job-work order and challan | `/jobwork/orders`, `/jobwork/orders/:id` |
| FIG-018 | Mill receipt confirmation | `/portal`, `/portal/jobs/:id` (mill user) |
| FIG-019 | Process stage update | `/portal/jobs/:id` (mill user) |
| FIG-020 | Return inward and yield reconciliation | `/jobwork/orders/:id` |
| FIG-021 | Overdue and statutory deadline cockpit | `/jobwork` |
| FIG-022 | Barcode scan and inward (warehouse app) | `/inventory/scan`, `/inventory/inward/:id` |
| FIG-023 | Lot and roll genealogy | `/inventory/lots/:id` |
| FIG-024 | Quality inspection and grade | `/inventory/qc` |
| FIG-025 | Price tagging and approval | `/inventory/pricing` |
| FIG-026 | Warehouse map and putaway | `/inventory/map`, `/inventory/scan` |
| FIG-027 | Stock ledger and availability | `/inventory/stock` |
| FIG-028 | Transfer request and approval | `/inventory/transfers` |
| FIG-029 | Transfer dispatch and destination receipt | `/inventory/transfers/:id` |
| FIG-030 | Stocktake and variance approval | `/inventory/stocktakes/:id` |
| FIG-031 | Lead inbox and source integration | `/crm/leads`, `/crm/allocation?tab=sources` |
| FIG-032 | Lead profile and activity timeline | `/crm/leads/:id` |
| FIG-033 | Lead allocation rules and attendance view | `/crm/allocation` |
| FIG-034 | Customer 360 profile | `/crm/customers/:id` |
| FIG-035 | Quotation builder and version history | `/crm/quotations/new`, `/crm/quotations/:id` |
| FIG-036 | Price negotiation and approval | `/crm/price-approvals` |
| FIG-037 | Customer credit application and limit | `/crm/credit`, `/crm/credit/:id` |
| FIG-038 | Catalogue and fabric detail | `/shop`, `/shop/:id` (customer user) |
| FIG-039 | Customer registration and company users | `/register`, `/portal/company`, `/commerce/registrations` |
| FIG-040 | Cart and checkout | `/cart` |
| FIG-041 | Payment and status | `/pay/:token`, `/commerce/payments` |
| FIG-042 | Customer order tracking | `/portal/orders`, `/portal/orders/:id`, `/commerce/orders/:id` |
| FIG-043 | Token policy configuration | `/commerce/token-policies` |
| FIG-044 | Customer advance / wallet ledger | `/commerce/wallet`, `/portal/account` |
| FIG-045 | Warehouse recommendation and comparison | `/fulfilment/allocation`, `/fulfilment/orders/:orderId` |
| FIG-046 | Split fulfilment approval | `/fulfilment/orders/:orderId`, `/approvals` |
| FIG-047 | Dispatch readiness cockpit | `/fulfilment` |
| FIG-048 | Pick list and barcode scan | `/fulfilment/:id` |
| FIG-049 | Transporter, LR and tracking | `/fulfilment/shipments`, `/fulfilment/shipments/:id`, `/track/:token` |
| FIG-050 | Delivery tracking and POD | `/portal/orders/:id`, `/fulfilment/shipments/:id` |
| FIG-051 | Return / RMA and claims | `/fulfilment/returns`, `/fulfilment/returns/:id`, `/fulfilment/shipments?tab=claims` |
| FIG-052 | Chart of accounts and ledger | `/finance/accounts`, `/finance/ledger/:id` |
| FIG-053 | Voucher and journal entry | `/finance/vouchers`, `/finance/vouchers/new`, `/finance/vouchers/:id` |
| FIG-054 | Customer and supplier ledgers | `/finance/receivables`, `/finance/payables`, `/finance/{receivables,payables}/:id` |
| FIG-055 | Bank reconciliation | `/finance/bank` |
| FIG-056 | GST compliance cockpit | `/finance/gst` |
| FIG-057 | TDS configuration and returns | `/finance/tds` |
| FIG-058 | Financial statements and period close | `/finance/statements`, `/finance/close`, `/finance/anomalies` |
| FIG-059 | Template manager and delivery log | `/workflow/communications` |
| FIG-060 | Workflow builder | `/workflow/rules`, `/workflow/rules/:id` |
| FIG-061 | My Work and approvals | `/my-work`, `/workflow/tasks` |
| FIG-062 | Document and contract register | `/contracts`, `/contracts/:id` |
| FIG-063 | Employee profile and attendance | `/hr/employees`, `/hr/employees/:id`, `/hr/attendance`, `/hr/leave`, `/me` |
| FIG-064 | Payroll run and payslip | `/hr/payroll`, `/hr/payroll/:month`, `/hr/payslips/:id` |
| extra | Approvals inbox, document library, configuration, programme tracker, claims, reservations, issue to mill, sales dashboard, targets | `/approvals`, `/governance/documents`, `/organisation/configuration`, `/programme`, `/jobwork/claims`, `/inventory/reservations`, `/inventory/mill-issues`, `/crm`, `/crm/performance` |

## Acceptance tests (tracker sheet) touched by P1

| ID | Statement (abridged) | P1 status | Evidence |
|---|---|---|---|
| AT-001 | Records carry entity/GSTIN/warehouse scope, creator and timestamps | Partial | Master records carry creator, timestamps and version; scope columns arrive on transactions (P2+) |
| AT-007 | Surat is the default dispatch priority; split dispatch needs approval | Partial | Configurable priority order (Surat first) and split-approval rule; the allocation engine itself is P7 |
| AT-011 | Price, credit, bank changes… follow maker-checker | Partial | Bank account, credit limit, GSTIN and legal-name changes are maker-checker controlled and tested; price, write-off, journal and refund follow in P4–P8 |
| AT-012 | Reports enforce the same row-level permissions | Partial | Every P1 list API applies permission and data-scope checks in SQL; the report builder is P10 |

The P1 end-to-end tests (`tests/p1.integration.test.ts`) also cover:
- audit immutability;
- GSTIN/PAN validation;
- concurrent document numbering;
- optimistic locking;
- account lockout;
- MFA;
- refresh-token rotation;
- document content validation.

The P2/P3 end-to-end tests (`tests/p2p3.integration.test.ts`) cover:
- requisition approval by a different person;
- RFQ landed-cost comparison, and a mandatory reason for not awarding the cheapest quote;
- the PO lifecycle: approval, supplier acceptance in the portal, receipt tolerance;
- three-way match (billing beyond receipt), duplicate invoice numbers (normalised), variance maker-checker and payment approval;
- the rule that the person who entered an invoice can never post it;
- the capture workbench: upload, corrections, approval into a draft invoice;
- automation for unaccepted POs and receipts without invoices;
- direct-to-mill receipt in the mill portal becoming mill stock;
- the rate engine: history, product-specific override, slabs and minimum charges;
- the job-work cycle: allocation, mill acknowledgement, stages, return, yield and claims;
- deadline clocks and overdue automation;
- portal and role isolation (a portal user or a sales user gets 403 outside their remit).

The P4/P5 end-to-end tests (`tests/p4p5.integration.test.ts`) cover:
- goods receipt → inward → weighing and scanning rolls with labels; QC grading with spec flags; directed putaway;
- price tagging with approval and history;
- reservations that cut rolls to size, refuse double-booking and duplicate picks;
- shade mixing and customer shade rejections;
- an inter-GSTIN transfer (approval, tax invoice number, IGST, scan dispatch and receipt, re-weigh) and warehouse data scope;
- a stock count with missing and re-weighed rolls, approval, and ledger adjustments;
- issue to mill by scan and the processed return creating a finished lot with genealogy and yield-adjusted cost;
- the append-only ledger and the ledger ↔ roll reconciliation after every scenario;
- allocation by rule, attendance and cap, with the trace; record ownership for salespeople;
- webhook capture (field map, idempotency, duplicates, merge) and CSV import;
- the pipeline rules; quotation pricing, approval and versioning; credit limit, override, block and acceptance with stock reservation;
- customer 360 and performance from verified outcomes.

### Known P4/P5 gaps (also listed in the tables above)

- The inventory dashboard totals are company-wide; lists and actions respect warehouse data scope.
- Barcode labels are QR codes; add Code 128 labels if the stores use 1-D-only scanners.
