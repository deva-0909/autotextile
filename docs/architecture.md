# Architecture

## Decision: domain microservices

The brief (section 12) recommends starting as a modular monolith. The product owner asked for
**microservices** instead, so the system is split by **business domain**. One service per screen would
be too fine to run on a single PC or operate with a small team.

Each service:

- owns its own PostgreSQL **schema** (`identity`, `organisation`, `masters`, `governance`, `procurement`, `jobwork`, `inventory`, `crm`) and connects with
  `search_path` set to that schema only. No service reads another service’s tables;
- runs its own migrations at start-up (`services/<name>/migrations/NNN_*.sql`);
- exposes a REST API and runs as its own Node process (separate port);
- publishes and consumes **events** for cross-service work.

All services share one PostgreSQL *instance* for local and small deployments. A service moves to its own
database server by changing its connection string; no code changes.

```
Browser ──► gateway :4000 ──► /api/identity/*      identity :4101      schema identity
                          ├─► /api/organisation/*  organisation :4102  schema organisation
                          ├─► /api/masters/*       masters :4103       schema masters
                          ├─► /api/governance/*    governance :4104    schema governance
                          ├─► /api/procurement/*   procurement :4105   schema procurement
                          ├─► /api/jobwork/*       jobwork :4106       schema jobwork
                          ├─► /api/inventory/*     inventory :4107     schema inventory
                          ├─► /api/crm/*           crm :4108           schema crm (+ public lead webhooks)
                          └─► / (web app, incl. supplier and mill portals)
                       services ⇄ bus.events / bus.offsets (PostgreSQL event bus)
```

## Planned services by phase

| Phase | Service(s) |
|---|---|
| P1 ✅ | identity, organisation, masters, governance (+ gateway) |
| P2 ✅ | procurement (requisition, RFQ, PO, receipts, supplier invoices, AI capture worker, three-way match, AP ledger, supplier portal) |
| P3 ✅ | jobwork (process templates, rate engine, mill stock, job-work orders/challans, stages, returns/yield, claims, mill portal) |
| P4 ✅ | inventory (lots, rolls, barcodes, immutable stock ledger, inward/QC, price tags, WMS, reservations, transfers, stock counts) |
| P5 ✅ | crm (lead sources/webhooks, duplicates, allocation, pipeline, quotations, pricing and credit approvals, targets) |
| P6 ✅ | commerce (catalogue, cart, registrations, token policies, orders, payment gateway adapter, customer advance ledger, complaints, customer portal) |
| P7 ✅ | fulfilment (allocation engine, split approval, pick/pack, GST invoice, dispatch gates, transport, tracking, POD, claims, returns) |
| P8 | accounting (double-entry GL, AP/AR, GST, TDS, bank reconciliation) |
| P9 | workflow (rules, tasks, escalation), notifications (WhatsApp/SMS/email), hrms |
| P10 | analytics/BI, intelligence (AI copilot) |

## Event bus

`packages/platform/src/bus.ts` implements a **transactional outbox** on PostgreSQL:

- A producer inserts into `bus.events` *inside the same transaction* as its business change. The change and the
  event commit or roll back together, so events are never lost and never phantom.
- An advisory lock during publish keeps event ids committing in order, so consumers never skip an id.
- Each consumer keeps an offset in `bus.offsets` and processes events in its own transaction together with the
  offset update. Each event therefore takes effect exactly once.
- `LISTEN/NOTIFY` wakes consumers immediately, with a 2-second poll as fallback.
- A handler that throws parks the event in `bus.dead_letters`, so one bad event cannot block the stream.

The interface (`publish`, `subscribe`) is small, so Redis/BullMQ or Kafka can replace it later without
touching the services.

Events in P1:

| Event | Producer | Consumer |
|---|---|---|
| `audit.recorded` | every service | governance → `audit_log` |
| `approval.requested` | masters | governance → approval request + notification |
| `approval.decided` | governance | masters → activates bank account / applies held change |
| `notification.requested` | procurement, jobwork | governance → notification for the named users |
| `procurement.receipt.recorded` | procurement | jobwork → mill stock (direct-to-mill receipts); inventory → an inward to weigh and scan (warehouse receipts) |
| `jobwork.order.issued` | jobwork | inventory → rolls to issue to the mill (warehouse-sourced lines) |
| `jobwork.return.recorded` | jobwork | inventory → consumes the grey rolls at the mill and opens an inward for the finished lot |
| `inventory.price.changed` | inventory | (catalogue cache) |
| `crm.quotation.accepted` | crm | commerce → sales order from the quotation |
| `commerce.order.booked` / `.extended` / `.cancelled` | commerce | fulfilment → allocation plan, hold extension, release |
| `fulfilment.plan.reserved` | fulfilment | commerce → order awaits token or is booked on credit |
| `commerce.payment.received` | commerce | fulfilment → re-checks the payment gate |
| `fulfilment.started` / `.dispatched` / `.delivered` | fulfilment | commerce → order status |
| `fulfilment.invoiced`, `fulfilment.credit_note.issued` | fulfilment | (accounting P8) |
| `inventory.transfer.dispatched` | inventory | (accounting P8: inter-GSTIN supply) |
| `inventory.reservation.picked` | inventory | (fulfilment P7) |
| `crm.lead.created` | crm | (analytics P10) |
| `procurement.invoice.posted` | procurement | (accounting GL in P8) |
| `jobwork.claim.accepted` | jobwork | (accounting P8) |
| `<service>.<entity>.changed` | all | (future read-model caches) |

## Synchronous service-to-service calls

Where a service needs a *current* answer from another (a supplier’s GSTIN, a warehouse, the next document
number, a setting), it calls that service’s REST API through `callService` (`packages/platform/src/client.ts`)
with a short-lived service token (`svc:<name>`). It never reads the other service’s tables. Examples:
procurement asks organisation for the next PO number and masters for party details; the mill portal sends a
mill’s invoice to procurement’s `/captures/inbound`; uploaded files go to governance’s document store.

**Ordering rule inside a transaction.** `publish` holds a database advisory lock until commit so event ids
commit in order. A transaction that has already published (directly, or through `audit`/`notify`) must not then
make a synchronous call to a service that also publishes, or that service waits on the lock held by the caller.
Make synchronous calls first, then audit and publish.

## P6/P7 design notes

- **Payments.** `services/commerce/src/gateway.ts` is the only code that knows a bank. A payment becomes `success`
  only when the HMAC-signed callback (checked against the raw request body) and a server-side status query agree.
  Callbacks are idempotent; bad signatures are recorded in their own transaction and refused.
- **Customer advance** is a separate append-only ledger (`wallet_ledger`, triggers block UPDATE/DELETE/TRUNCATE).
  Application to an invoice is idempotent per invoice number under an advisory lock.
- **Allocation** reads availability from inventory (counting the order’s own reservations when re-deciding),
  ranks warehouses, and reserves in inventory. A split is never automatic: it becomes an approval.
- **Dispatch gates** are computed from facts (picked, packed, invoiced, settled/credit/approved override) and
  re-checked at dispatch time inside the transaction.

## P2/P3 design notes

- **AI invoice capture.** Uploaded files are stored in governance; a capture row is queued. A worker in the
  procurement service claims rows with `FOR UPDATE SKIP LOCKED` (`EXTRACTION_CONCURRENCY` in parallel) and sends the
  PDF or image to Claude (`claude-opus-5-5`, structured output validated by a Zod schema, server-side fallback
  enabled). The output is validated (GSTIN checksum, arithmetic, PO lookup, duplicate check) and waits in the
  review queue with per-field confidence. A person approves every invoice; nothing posts automatically. Without
  `ANTHROPIC_API_KEY` the capture goes to manual entry.
- **Three-way match.** Quantity against received kg, rate against the PO within `rate_tolerance_percent`, tax type
  from the supplier and buyer GSTIN state codes, and totals arithmetic. A clean match can be posted by a different
  user holding `procurement.invoice.approve`; a variance needs a maker-checker approval first.
- **AP ledger.** `procurement.ap_ledger` is append-only (triggers), like the audit log. Payment approval is a
  separate permission. Double-entry GL posting arrives with the accounting service (P8).
- **Direct-to-mill.** A PO can deliver to a mill. The mill’s receipt in its portal records a GRN at the mill and
  publishes `procurement.receipt.recorded`; jobwork turns it into `mill_stock` (unique per receipt and product, so a
  replayed event cannot double it), and job-work orders draw from that stock.
- **Clocks.** Each job-work order stores the expected return date, an internal due date (expected − `internal_buffer_days`)
  and a statutory deadline (issue + `statutory_return_days`). An hourly automation raises alerts
  `statutory_alert_days` before the deadline and escalates when it passes.
- **Stock ledger (P4).** `inventory.stock_movements` is append-only (triggers block UPDATE, DELETE and TRUNCATE).
  Every change is a movement from one (warehouse, state) to another; `stock_balances` is a view that sums them.
  The `rolls` table holds each roll's current position as a projection updated in the same transaction, and
  `GET /inventory/ledger/verify` proves the two agree (the tests run it after every scenario). Weight-only changes
  (splits, re-weighing) are flagged `moves_roll = false` so roll counts stay right.
- **No double deduction.** Reservations, picks, transfers and issues lock the roll row (`FOR UPDATE`) and check its
  state, so the same roll cannot be reserved, picked or loaded twice. Partial quantities are cut into a child roll
  with its own barcode.
- **Inter-GSTIN transfers.** Warehouses map to GST registrations. A transfer between different registrations
  always needs approval and is dispatched on a document from the source GSTIN's number series (tax invoice by
  default, configurable with the CA), with IGST or CGST+SGST from the state codes. Valuation is at lot cost.
- **Lead allocation (P5).** `decide()` returns the owner plus a trace of every candidate and why they were skipped
  (absent, leave, weekly off, break, inactive, at cap). Order: sticky owner of the same contact, then the first
  matching rule's pool, else profile match. Round robin uses `last_assigned_at`; least-loaded uses open leads.
- **Record ownership.** Salespeople see only leads and quotations they own (`owner_id` filter in SQL) unless
  they hold `crm.lead.read_all`.
- **Public webhooks.** `POST /api/crm/public/leads/<key>` is the only unauthenticated business endpoint. The key
  identifies one source, can be rotated, and the source can be switched off.
- **Portals.** Portal users are ordinary identity users with a `party_id` and a `portal.*` permission. Every portal
  query filters by that party id in SQL, so a supplier or mill can see only its own documents.

## Security model

- **Authentication** (identity):
  - Passwords are hashed with scrypt.
  - 5 failed attempts lock the account for 15 minutes.
  - TOTP MFA (RFC 6238).
  - 15-minute HS256 access tokens.
  - 7-day refresh tokens in an `HttpOnly; SameSite=Strict` cookie, rotated on every use and revocable per session.
  - Login history records every attempt.
- **Authorisation:**
  - Every service verifies the token itself; the gateway is not trusted blindly.
  - Permissions are codes such as `masters.supplier.manage`, granted to roles. Code never checks role names.
  - The permission catalog lives in `packages/platform/src/permissions.ts`; later phases append to it, and
    Super Admin automatically receives new codes.
- **Data scope:**
  - Users hold scope lists for entity, GSTIN, branch and warehouse (`*` = all, including future ones).
  - Queries add `scopeClause(...)`, so scope is enforced in SQL, not in the UI.
- **Field level:** bank account numbers are masked unless the user has `masters.party.bank.view`.
- **Maker-checker:**
  - New bank accounts and changes to GSTIN, GST treatment, legal name or credit limit are held for approval.
  - Approval needs `governance.approval.decide`, and the requester can never approve their own request.
- **Audit:**
  - `governance.audit_log` is append-only. Triggers block `UPDATE`, `DELETE` and `TRUNCATE`.
  - Each row stores actor, time, IP, device, session, before/after values, reason and approver.
- **Gateway:** login rate limit, `X-Frame-Options: DENY`, `nosniff`, `same-origin` referrer policy.
- **Documents:**
  - Stored under random keys, never under user file names, with a SHA-256 fingerprint.
  - The declared content type must match the file’s magic bytes.
  - Allowed types: PDF, PNG, JPEG, WebP, CSV, XLSX, DOCX. Maximum 20 MB.
  - Downloads require a token.

## Data integrity patterns used throughout

- Optimistic locking: every master row has `version`; stale edits get HTTP 409.
- Constraints in the database (CHECK, UNIQUE, FK), not only in forms.
- GST invoice number length (≤ 16) enforced by a constraint on number series.
- Document numbers are allocated with a single atomic `UPDATE … RETURNING`, so they stay unique under concurrency (tested with 25 parallel requests).
- Nothing about warehouses, GSTINs, attributes, percentages or thresholds is hard-coded. All of it is data
  (`organisation.settings`, masters tables), seeded with clearly marked placeholder values.

## Web app

- React 19 + TypeScript + Tailwind CSS v4 + TanStack Query.
- An in-house design system (`apps/web/src/components`) with tokens, buttons, fields, badges, tabs, drawers, modals, toasts and a server-side data table. The table supports search, sort, filters, pagination, a column chooser, CSV export and saved views.
- Every screen has loading, empty, error, permission-denied and validation states.
- The access token is kept in memory only (never `localStorage`); the refresh cookie is not readable from script.
