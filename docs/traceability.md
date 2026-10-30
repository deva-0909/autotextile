# Requirement traceability — release P1

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

### Known P1 gaps

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
| extra | Approvals inbox, document library, configuration, programme tracker | `/approvals`, `/governance/documents`, `/organisation/configuration`, `/programme` |

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
