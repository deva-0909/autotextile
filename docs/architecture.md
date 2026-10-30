# Architecture

## Decision: domain microservices

The brief (section 12) recommends starting as a modular monolith. The product owner asked for
**microservices** instead, so the system is split by **business domain**. One service per screen would
be too fine to run on a single PC or operate with a small team.

Each service:

- owns its own PostgreSQL **schema** (`identity`, `organisation`, `masters`, `governance`) and connects with
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
                          └─► / (web app)
                       services ⇄ bus.events / bus.offsets (PostgreSQL event bus)
```

## Planned services by phase

| Phase | Service(s) |
|---|---|
| P1 | identity, organisation, masters, governance (+ gateway) |
| P2 | procurement (requisition, RFQ, PO, supplier invoices, three-way match), document-ai worker |
| P3 | jobwork (mill orders/challans, stages, rate engine, yield) |
| P4 | inventory (lots, rolls, barcodes, immutable stock ledger, transfers, WMS) |
| P5 | crm (leads, allocation, quotations, pricing approvals) |
| P6 | commerce (catalogue, cart, token booking, ICICI gateway, customer portal) |
| P7 | fulfilment (allocation engine, pick/pack, dispatch, transport, POD) |
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
| `<service>.<entity>.changed` | all | (future read-model caches) |

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
