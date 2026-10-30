# Textile Trading ERP

ERP for a B2B knitted-fabric trading business: manufacturer → mill processing → warehouse → customer.
It is built phase by phase from the *Developer Brief & Functional Specification v1.0* and the
*Development & Figma Tracker*. This release delivers:

- **P1 — Core masters, security, organisation & platform foundation**
- **P2 — Procurement, supplier portal & AI invoice capture**
- **P3 — Mill job work, mill portal, rate engine, yield & deadlines**

| | |
|---|---|
| **Architecture** | Domain microservices behind an API gateway, PostgreSQL (schema per service), Postgres-backed event bus |
| **Services in this release** | `identity` · `organisation` · `masters` · `governance` · `procurement` · `jobwork` · `gateway` |
| **Web app** | React 19 + TypeScript + Tailwind CSS, served by the gateway |
| **Runs on** | Windows, macOS or Linux — Node.js and PostgreSQL only, no Docker needed |

See [docs/architecture.md](docs/architecture.md) for the design and
[docs/traceability.md](docs/traceability.md) for requirement-by-requirement status.

## What’s in P1

- **Sign-in and security:** login, TOTP two-step verification (MFA), lockout after 5 failed attempts, password policy and reset, rotating refresh sessions, and login history.
- **Users and roles:** the 22 baseline roles from the brief and an editable permission matrix.
- **Data scope:** each user is limited by legal entity, GSTIN, branch and warehouse.
- **Organisation:** Legal entity → GST registration → branch → warehouse → zone/aisle/rack/bin.
  - GSTIN checksum and PAN validation.
  - Surat-first dispatch priority.
  - GSTIN-wise document numbering (16-character limit enforced).
  - Fiscal years.
  - Configurable business rules, with CA-validation flags.
- **Master data:**
  - Customers, suppliers, manufacturers, mills and transporters, with contacts, addresses and bank accounts.
  - Duplicate detection on GSTIN, phone and email.
  - A fabric catalogue whose attribute dictionary is configurable per category (product, lot and roll level).
  - HSN/GST codes, UOM, payment terms, reason codes, document types and price lists.
- **Governance:**
  - Maker-checker approvals for bank accounts, GSTIN, legal name and credit-limit changes.
  - An append-only audit trail (database-enforced) with before/after values, reason, approver, IP and session.
  - Notifications.
  - A document store with versions, SHA-256 fingerprints and content-type checks.
- **Programme tracker:** every phase, requirement and screen from the Excel tracker, with its status.

## What’s in P2 — Procurement

- **Supplier management:** scorecards (on-time delivery, quality, invoice accuracy), KYC checklist, risk score, price history, disputes and a recommended-supplier view.
- **Requisitions and RFQs:** requisitions with approval; RFQs to several suppliers; quotes recorded per supplier; landed-cost comparison (rate + freight, with lead time, terms and price history); award converts the winning quote into a draft PO.
- **Purchase orders:** approval above a configurable threshold (maker-checker), send, revise (with revision history), cancel, close. Supplier acceptance, dispatch details and goods receipt with quantity tolerance.
- **Direct-to-mill:** a PO can deliver straight to a mill. The mill confirms receipt in its portal, and the material becomes mill stock that a job-work order can draw from, with the source PO and supplier dispatch kept on the record.
- **AI invoice capture:** batch upload of PDFs and images. Claude reads each invoice (GSTIN, number, date, PO, lines, HSN, quantity, rate, taxes, totals) into a review queue. The reviewer sees the document beside the extracted fields with confidence flags. **Nothing posts without a human approving it.** Without an API key the workbench works in manual-entry mode.
- **Invoice control:** three-way match (PO ↔ receipt ↔ invoice) on quantity, rate (configurable tolerance) and tax type (IGST vs CGST/SGST from the GSTINs); duplicate detection on supplier + normalised invoice number; missing-invoice alerts for receipts with no invoice; exceptions queue.
- **Accounts payable:** matched invoices post to an append-only supplier ledger (variances go to approval first), with due dates from payment terms and a separate payment-approval step.
- **Supplier portal:** suppliers accept or reject POs, confirm quantity and date, record dispatches and submit invoices.

## What’s in P3 — Mill job work

- **Mill profile:** processes, capacity, TAT, rate cards, performance (yield, on-time, claims) and documents.
- **Process templates:** configurable stage lists per process (reactive dyeing, RFD, compacting, printing seeded).
- **Rate engine:** per-kg, fixed or slab rates; mill-, process- and product-specific; minimum charges; effective dates with full rate history; a rate quote before issuing.
- **Job-work orders and challans:** from mill stock (direct-to-mill purchases) or a warehouse; lot reference, kg, process, rate basis, transport (transporter, LR, vehicle, e-way bill number) and documents.
- **Three clocks per order:** the expected return date, an internal overdue date (expected minus a buffer) and the statutory job-work deadline (issue date + configured days, CA to validate). A cockpit shows what is due, overdue and near the statutory limit; automatic alerts escalate.
- **Mill portal:** the mill acknowledges receipt (with discrepancies), updates stages, marks ready for collection, submits its invoice (which lands in the procurement invoice workbench) and responds to claims.
- **Return and yield:** returns record good, rejected and damaged kg; reconciliation shows sent, received, balance, wastage and yield %; yield below the threshold raises an exception automatically.
- **Quality claims:** defects, affected quantity, photos, root cause, responsibility, debit/credit amount, the mill’s response and closure.

## Run it on Windows (no Docker)

### 1. Install the prerequisites (one time)

1. **Node.js 22.18 or newer** (Node 24 LTS recommended): https://nodejs.org. Check it with:
   ```bash
   node -v
   ```
2. **PostgreSQL 16 or 17**: https://www.postgresql.org/download/windows/ (the EDB installer).
   During setup, keep port **5432** and choose a password for the `postgres` user. Remember it.
   The installer adds a Windows service that starts PostgreSQL automatically. You don’t need Stack Builder.
3. **Git**: https://git-scm.com/download/win

### 2. Get the code and configure it

```bash
git clone https://github.com/deva-0909/autotextile.git
```

```bash
cd autotextile
```

```bash
copy .env.example .env
```

Open `.env` in Notepad and put your PostgreSQL password into `DATABASE_URL`:

```
DATABASE_URL=postgres://postgres:YOUR_PASSWORD@localhost:5432/textile_erp
```

(If the password contains `@`, `:` or `/`, write it URL-encoded, e.g. `@` → `%40`.)

### 3. Install, set up the database, start

```bash
npm install
```

```bash
npm run setup
```

```bash
npm start
```

`npm run setup` creates the `textile_erp` database, runs every service’s migrations and loads demo data,
including sample requisitions, RFQs, purchase orders, invoices and job-work orders.
`npm start` launches the six services and the gateway in one window. Open **http://localhost:4000**.

> Upgrading from the P1 release? Run `npm install` and then `npm run setup -- --reset` once, to load the P2/P3 demo data.

Demo users all share the password `Textile@2026`:

| Email | Role | Shows |
|---|---|---|
| `admin@textile.local` | Super Admin | everything |
| `owner@textile.local` | Owner / Director | approvals, read-only everywhere |
| `purchase@textile.local` | Purchase Manager | suppliers & mills, masked bank numbers, maker side of approvals |
| `surat.stores@textile.local` | Warehouse Manager | data scope limited to the Surat warehouse and GSTIN |
| `accounts@textile.local` | Accounts Manager | reference data, full bank numbers |
| `sales@textile.local` | Sales Executive | customers only |
| `auditor@textile.local` | Auditor / CA | read-only, including the audit trail |
| `millops@textile.local` | Mill Operations Manager | job-work orders, mills, rate cards, claims |
| `supplier@ambica.example` | Supplier portal (Shree Ambica Knitters) | the supplier’s own POs, dispatches and invoices |
| `mill@suratprocess.example` | Mill portal (Surat Process House) | the mill’s incoming material, jobs, stages and claims |

A good first tour:

1. Sign in as **purchase**. Open *Procurement → RFQs* and look at the quote comparison, then *Purchase orders*.
2. Open *Invoice workbench* and *Three-way match*: one demo invoice has a rate variance waiting for approval.
3. Sign in as **millops** and open *Mill job work*: the cockpit shows overdue and statutory deadlines; one returned job has low yield and an open claim.
4. Sign in as **mill@suratprocess.example** to see the same work from the mill’s side, and as **supplier@ambica.example** for the supplier portal.
5. Sign in as **admin** → *Approvals* to approve what is waiting, then look at the *Audit trail*.

### Optional: AI invoice extraction

Invoice capture uses Claude when an Anthropic API key is set. Add it to `.env` and restart:

```
ANTHROPIC_API_KEY=sk-ant-...
```

Without a key, uploaded invoices go straight to manual entry in the same review screen.
`EXTRACTION_CONCURRENCY` (default 4) sets how many invoices are read in parallel.

### Everyday commands

| Command | What it does |
|---|---|
| `npm start` | Start everything (Ctrl+C stops it) |
| `npm run dev` | Same, restarting a service when its code changes |
| `npm run setup -- --reset` | Drop the database and reload fresh demo data |
| `npm test` | Unit + end-to-end tests (uses a separate `textile_erp_test` database) |
| `npm run typecheck` | Type-check every service and the web app |
| `npm run dev:web` | Web app with hot reload on http://localhost:5173 (needs `npm start` running) |
| `npm run build` | Rebuild the web app into `apps/web/dist` |

The built web app is committed, so `npm start` works without running the Vite build tool.
That matters on low-memory PCs where Vite’s esbuild can crash.

### Troubleshooting

- **`Cannot connect to PostgreSQL … ECONNREFUSED`.** PostgreSQL isn’t running. Open *Services*, find `postgresql-x64-16` (or 17) and start it.
- **`Wrong password`.** Fix `DATABASE_URL` in `.env`.
- **`The identity service is not reachable`** in the browser. One service failed to start; scroll up in the terminal for the error.
- **Port already in use.** Change `GATEWAY_PORT` (or a service port) in `.env`.

## Repository layout

```
packages/platform     Shared service kit: config, DB, migrations, auth/RBAC/scope, event bus, audit, validation
services/gateway      Single entry point: routes /api/<service>/*, login rate limit, security headers, serves the web app
services/identity     Users, roles, permission matrix, data scope, sessions, MFA, login history
services/organisation Legal entities, GST registrations, branches, warehouses, locations, numbering, fiscal years, settings
services/masters      Business partners, contacts, addresses, bank accounts, fabric catalogue, reference data
services/governance   Audit trail, approvals, notifications, documents
services/procurement  Requisitions, RFQs, POs, receipts, supplier invoices, AI capture, three-way match, AP ledger, supplier portal
services/jobwork      Process templates, rate cards, mill stock, job-work orders, stages, returns/yield, claims, mill portal
apps/web              React web app (design system, ERP screens, supplier and mill portals)
scripts               setup (DB + demo data, created through the APIs) and run (process launcher)
tests                 Unit and end-to-end integration tests
docs                  Architecture and requirement traceability
```
