# Textile Trading ERP

ERP for a B2B knitted-fabric trading business: manufacturer → mill processing → warehouse → customer.
It is built phase by phase from the *Developer Brief & Functional Specification v1.0* and the
*Development & Figma Tracker*. This release delivers **P1 — Core masters, security, organisation &
platform foundation**, the base every later module builds on.

| | |
|---|---|
| **Architecture** | Domain microservices behind an API gateway, PostgreSQL (schema per service), Postgres-backed event bus |
| **Services in this release** | `identity` · `organisation` · `masters` · `governance` · `gateway` |
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

`npm run setup` creates the `textile_erp` database, runs every service’s migrations and loads demo data.
`npm start` launches the four services and the gateway in one window. Open **http://localhost:4000**.

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

A good first tour: sign in as **purchase**, open a supplier → *Bank accounts* → request a new account.
Sign out, sign in as **admin** → *Approvals* → approve it, then look at the *Audit trail*.

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
apps/web              React web app (design system + P1 screens)
scripts               setup (DB + demo data) and run (process launcher)
tests                 Unit and end-to-end integration tests
docs                  Architecture and requirement traceability
```
