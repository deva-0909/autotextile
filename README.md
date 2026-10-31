# Textile Trading ERP

ERP for a B2B knitted-fabric trading business: manufacturer → mill processing → warehouse → customer.
It is built phase by phase from the *Developer Brief & Functional Specification v1.0* and the
*Development & Figma Tracker*. This release delivers:

- **P1 — Core masters, security, organisation & platform foundation**
- **P2 — Procurement, supplier portal & AI invoice capture**
- **P3 — Mill job work, mill portal, rate engine, yield & deadlines**
- **P4 — Inventory: lots & roll barcodes, QC, price tags, immutable stock ledger, WMS, transfers, stock counts**
- **P5 — Sales & CRM: lead capture, allocation, pipeline, customer 360, quotations, pricing & credit approvals**
- **P6 — B2B commerce: trade portal, cart, token booking, payment gateway (sandbox), customer advance ledger**
- **P7 — Fulfilment: warehouse allocation engine, split approval, pick by scan, GST invoice, dispatch gates, transport, POD, returns**
- **P8 — Finance: double-entry books per GSTIN, automatic postings, AR/AP ageing, GST returns and 2B match, TDS, bank reconciliation, statements, period close, alerts**
- **P9 — Workflow and people: customer WhatsApp/SMS/email with consent and delivery tracking, rules and tasks (My Work), contracts, handover, HRMS and payroll**
- **P10 — Insights and AI: control tower, report builder, explainable intelligence, business assistant (Claude), exception centre, backups with restore tests**
- **P11 — Go-live: data migration with reconciliation and sign-off, UAT and defects, role-based training, cutover checklist, go/no-go, hypercare**

| | |
|---|---|
| **Architecture** | Domain microservices behind an API gateway, PostgreSQL (schema per service), Postgres-backed event bus |
| **Services in this release** | `identity` · `organisation` · `masters` · `governance` · `procurement` · `jobwork` · `inventory` · `crm` · `commerce` · `fulfilment` · `finance` · `workflow` · `hrms` · `insights` · `golive` · `gateway` |
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

## What’s in P4 — Inventory & warehouse

- **Every kilogram is a roll with a barcode.** Lots hold rolls; each roll has its own barcode (QR label printed from the browser) and a lot barcode for the batch.
- **Inward:** goods receipts and mill returns arrive automatically as inwards to weigh and scan, roll by roll, with GSM, width, dye lot and shade. Differences against the document are flagged.
- **Quality inspection:** grade each roll A / B / C / reject with measured GSM and width; out-of-spec measurements and rejects raise exceptions.
- **Price tagging:** selling price per kg on each lot. The first price is set directly; changes and any price below the minimum margin need a checker. Full price history.
- **Immutable stock ledger:** balances (physical, available, reserved, allocated, in transit, at mill, QC hold, damaged, rejected) are derived only from append-only movements; a built-in check proves the ledger and the roll positions agree.
- **Warehouse map & putaway:** zones, aisles, racks and bins with fill levels; directed putaway suggests the bin already holding the lot.
- **Reservations & picking:** whole rolls reserved (the last one cut to size), never double-booked; picking by scan, each roll exactly once.
- **Shade control:** dye lots don’t mix in one reservation without a reason; a shade a customer rejected is never reserved for them.
- **Transfers:** request → approval → scan onto the vehicle → dispatch with LR and e-way bill → scan in at the destination → close. Between different GSTINs a transfer is a taxable supply: it always needs approval and gets a tax invoice from the source GSTIN’s series with IGST or CGST+SGST.
- **Stock counts:** scan an area; missing, unexpected, mis-located and re-weighed rolls form a variance that a checker approves before the ledger is adjusted.
- **Issue to mill:** job-work orders that draw from a warehouse are scanned out; when the processed fabric returns, the grey rolls are consumed and a finished lot is created with its genealogy and a yield-adjusted cost.
- **Ageing:** configurable buckets (0–30 … >365 days), slow and dead stock with a clearance recommendation.
- **Scan station:** a phone-friendly page for handheld scanners to look up, put away, cut or mark rolls damaged.

## What’s in P5 — Sales & CRM

- **Lead capture from every channel:** each source (IndiaMART, Meta lead ads, Justdial, website, WhatsApp, phone, email, referral, exhibition, trade platforms) has a private webhook URL and a field map; CSV import for lists. New sources are configuration, not code.
- **Duplicates:** matched on mobile, email and GSTIN against open leads and customers; merge, link, keep separate or escalate — nothing is deleted.
- **Allocation:** rules by state, city, source, fabric, language and deal value; round robin or least-loaded. Absent, on-leave, weekly-off, on-break, inactive and capped salespeople are skipped, and every lead records why it went where it did. Repeat enquiries go to the salesperson already handling the contact.
- **Pipeline:** new → assigned → contacted → qualified → quotation → negotiation → order confirmed → won / lost / nurture. No open lead without a next follow-up; lost and nurture need a reason; first-response time is measured and SLA breaches escalate.
- **Customer 360:** enquiries, quotations, prices, fabric preferences, credit, shade decisions, reservations and timeline on one page.
- **Quotations:** built from stock lots with live pricing — list price, requested price, discount, cost and margin per line. Lines beyond the salesperson’s discount authority or below the minimum margin go to a price approver. Revisions are new versions with the negotiation history and competitor prices kept.
- **Credit:** advance by default; credit limits, one-time overrides and blocks through a checker. Accepting a quotation runs the credit check and reserves the quoted lots.
- **Targets & performance:** leads, response time, qualified leads, quotes, kg, revenue, margin and new vs repeat customers against monthly targets, counting only verified outcomes; incentive eligibility.

## What’s in P6 — B2B commerce

- **Trade portal** for customer companies: fabric catalogue from QC-passed stock (by category, GSM, colour, SKU), lot detail with shade and grade, cart with MOQ and live availability checks.
- **Registration:** companies apply on `/register`; a checker approves, which creates the customer master and the company’s first login (temporary password shown once). Company admins add their own buyers and accounts users and can set an order value above which a second person in their company must approve.
- **Token booking:** advance customers pay a token before stock is held. The token is a percentage of the taxable value (GST excluded) or a fixed amount, with min/max, hold days and refund terms. The most specific rule wins — customer › product › category › campaign › company default — and every rule needs maker-checker approval.
- **Payments:** gateway adapter with a signed callback *and* a separate server-side status check before anything is marked paid; idempotent; rejected signatures are logged. `PAYMENT_GATEWAY=sandbox` simulates the bank; the ICICI adapter is wired but needs merchant credentials.
- **Reservation:** stock is reserved atomically when an order is allocated; unpaid orders expire and release it; extensions need approval.
- **Customer advance ledger:** append-only. Tokens and advances credit it; invoices consume it at dispatch; credit notes add to it; refunds come only out of unapplied money.
- **Internal screens:** sales orders (including phone orders), payments and gateway reconciliation, customer advances, token policies, registrations, complaints.

## What’s in P7 — Order orchestration & dispatch

- **Allocation engine:** Surat first by configured dispatch priority, then coverage, grade, distance band, freight estimate, ETA and workload; the comparison is shown with the reason for the choice.
- **Never auto-splits:** a split across warehouses goes to management approval. Overrides need a reason; recommended and chosen options are both kept.
- **Pick by scan** against the reservation (wrong roll, already-picked and weight tolerance are refused), pack, then a **GST tax invoice** from the warehouse’s own GSTIN series (CGST+SGST or IGST by place of supply).
- **Dispatch gates:** invoice required; advance customers must have paid (advance is applied automatically), credit customers within terms, otherwise an approved override. E-way bill number required above the threshold.
- **Transport:** freight rate cards and quotes, LR/vehicle, milestones, shareable tracking link (`/track/:token`), proof of delivery with shortage/damage that opens a transport claim.
- **Returns (RMA):** request from the portal or internally, authorise, receive by scan into a returns location, disposition, credit note credited to the customer’s advance.

## What’s in P8 — Accounting, GST, TDS & financial control

- **Books per GSTIN:** one book for each GST registration of the legal entity; consolidated reports remove inter-GSTIN transfers and inter-unit balances.
- **Automatic postings** from the events other services publish: supplier and mill bills (purchase or job-work charges, input GST, AP net of TDS), GST tax invoices (sales, output GST, AR), credit notes, gateway receipts and refunds, cancellation fees, and inter-GSTIN stock transfers (a supply in the sending book and a purchase in the receiving one). Every posting is idempotent on its source document.
- **Ledger controls:** debits must equal credits; posted vouchers and lines cannot be changed in the database (triggers) — corrections are reversals; manual journals, payments and contra entries above the limit wait for a checker; locked months refuse entries, and late automatic postings move to the next open month; reopening needs approval.
- **AR/AP:** bill-wise ageing (not due, 1–30, 31–60, 61–90, 90+), settled first-in-first-out against the party balance; advances shown as liabilities (customers) or assets (suppliers).
- **GST:** GSTR-1 (B2B incl. branch transfers, B2C, credit notes, HSN summary) with JSON export, GSTR-3B with the statutory credit set-off order, GSTR-2B import and matching, e-invoice payloads in the IRP schema.
- **TDS:** sections with rates and single/annual thresholds (194C, 194Q on the excess, 194J, 194H, 194I), PAN and lower-deduction certificates per party, deduction at bill posting, challans, due dates and the quarterly 26Q summary.
- **Bank reconciliation:** CSV statement import with duplicate detection, auto-match by amount, date and UTR, creating missing entries from statement lines, and a reconciliation statement that must explain every rupee.
- **Statements:** trial balance, P&L, balance sheet, cash flow (direct), DSO/DPO/inventory days and working capital; closing stock valued at landed lot cost (weighted average or lot-wise) when a month is locked, with a provisional valuation between closes.
- **Alerts:** duplicate supplier bills and payments, payments soon after a bank-detail change, unusual discounts, large credit notes and refunds, manual journals on sensitive accounts, unusual expense movements, overdue TDS and receivables over 90 days.

## What’s in P9 — Communications, workflow, contracts & HRMS

- **Customer communications:** WhatsApp, SMS and email templates triggered by business events (enquiry, quotation, booking, payment link, invoice, receipt, dispatch with LR and tracking link, delivery feedback, complaint, overdue reminders). Templates are versioned, use only the variables their trigger provides, and go live after a checker approves; WhatsApp templates also carry Meta’s approval status. WhatsApp and SMS go only to numbers with a recorded opt-in; opt-outs stop messages immediately. Every message has a delivery log (queued, sent, delivered, read, failed, skipped with the reason), retries with backoff up to five attempts, manual retry, and signed delivery receipts. `MESSAGING_PROVIDER=sandbox` delivers inside the ERP; `live` sends WhatsApp through the Meta Cloud API once credentials are set.
- **Workflow rules:** when an event happens and conditions match, create a task (for the record owner or a team queue, with priority, due time and escalation), notify a team, or send a message — immediately or after a delay. Every evaluation is logged.
- **My Work:** one list of my tasks, my team’s unassigned queue, approvals I can decide and CRM follow-ups that are due; take, start, complete with a resolution note, reassign with a reason.
- **Contracts:** supplier, mill, customer, transport and lease agreements with rates, payment/quality/delivery terms and penalties; correspondence log; full-text search over terms and notes; renewal tasks at 30, 15 and 7 days; renewal creates a linked new version.
- **Handover:** move a person’s open tasks, CRM leads and contracts to a colleague in one recorded step (leave, exit, transfer).
- **HRMS:** employees with onboarding/probation/confirmation/transfer/promotion/resignation/exit and checklists; recruitment pipeline; shifts, daily attendance (lateness and overtime against the shift), phone check-in/out, holidays, leave types and balances (pro-rata), comp-off for work on off days; leave approval by a checker. Attendance and approved leave feed CRM lead allocation.
- **Payroll:** monthly run from attendance and salary structures — loss of pay, overtime at twice the hourly rate, PF on the ₹15,000 ceiling (EPF/EPS split), ESIC up to ₹21,000 gross, state professional tax slabs, salary TDS under the new regime with the 87A rebate; approval by a checker; payslips (self-service); bank upload file; salary cost and liabilities posted to accounts automatically.

## What’s in P10 — BI, AI intelligence & continuity

- **Control tower and daily brief:** finance, stock, mills, sales, dispatch, procurement, people and work in one page, a six-month sales trend and the top exceptions. Every panel is read with the viewer’s own permissions and data scope, so people see only what their role allows.
- **Report builder:** any dataset you may see (sales and purchase registers, ageing, stock lots, leads, quotations, orders, shipments, POs, job work, tasks, employees) with AND/OR filters, two-level grouping by date (day/month/quarter/FY year) or field, totals, sort; export to Excel (CSV) or PDF; save, share, schedule (runs with the owner’s own access and notifies).
- **Explainable intelligence:** stock health with cover days, reorder and transfer suggestions; customer buying cycle, next expected order, churn risk with its factors and margin; quotation win rates by margin, follow-up priority, competitor price register and a negotiation simulator; supplier ranking; compatible fabric substitutes with GSM/width tolerances and a customer-acceptance flag; money tied up in stock, mills, unbilled orders and receivables, and margin per invoice.
- **Business assistant:** ask in plain words (or by voice). With `ANTHROPIC_API_KEY` set, Claude answers using read-only tools that run with the user’s own permissions; it suggests actions as links and never changes data. Without a key it answers common questions from built-in analyses and says so. Every question and answer is logged with feedback.
- **Exception centre:** every open alert from every module in one list, most severe first, with “explain”.
- **Continuity:** system health (services, event-bus lag, parked events with replay, database size), `pg_dump` backups with checksum and row counts, one-click restore tests into a scratch database, `npm run backup -- --verify` for the nightly schedule, offline put-away on the scan station, and a runbook ([docs/continuity.md](docs/continuity.md)). `npm run load-test` measures throughput and p95 latency.

## What’s in P11 — Migration, UAT, training & go-live

- **Data migration:** CSV templates for parties, opening receivables/payables (bill-wise), the opening trial balance, opening stock by lot and roll, open purchase orders (pending quantity, loaded as approved and accepted so receipts can be booked against them), open sales orders (undelivered balance at the agreed price; stock is reserved, no new token), open job work (fabric still at mills, on acknowledged job orders that keep the original challan date for the 365-day GST return clock) the GST credit and cash ledger balances per GSTIN (brought forward in GSTR-3B; cash pays tax left after credit, head by head), pending ITC reversals (reported in table 4(B) in their month; Rule 37 credit is reclaimed from the GST screen once the supplier is paid), and interest, late fee and penalty balances (cash held in those heads, and amounts still owed: interest and late fee go into a chosen month's table 5.1; each is settled from cash in the same head first, then by challan). Each upload is validated row by row (GSTIN check digit, PAN, ledger codes, warehouses, duplicates), loaded through the owning services’ own APIs with the uploader’s permissions, reconciled by reading the data back against the file’s control totals, and signed off by a business owner who did not load it.
- **UAT:** one scenario per tracker requirement plus cross-cutting tests (exceptions, permissions, concurrency, tax, barcodes, integrations, performance, security, backup/restore). A failed run raises a defect with severity; a retest re-opens the scenario. A phase is signed off only when every scenario passed or was waived and no S1/S2 defect is open.
- **Training:** 15 role modules with the screens they cover; assign, record completion and score.
- **Cutover and go/no-go:** a 19-step checklist (prepare, freeze, migrate, verify, go-live, stabilise) with owners; a readiness page that checks UAT, defects, migration sign-offs, training, cutover and a backup restore-tested in the last 24 hours; the decision is recorded with its rollback plan.
- **Hypercare:** anyone can report a problem; P1–P4 severities with response and resolution deadlines, notifications and breach flags.

Open items, parked for later, are listed in [docs/pending.md](docs/pending.md).
Hosting the demo on Vercel and Supabase, with the role switcher: [docs/deploy-vercel-supabase.md](docs/deploy-vercel-supabase.md).

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
including sample requisitions, RFQs, purchase orders, invoices, job-work orders, scanned stock, transfers, leads, quotations and credit.
`npm start` launches the fourteen services and the gateway in one window. Open **http://localhost:4000**.

> Upgrading from an earlier release? Run `npm install` and then `npm run setup -- --reset` once, to load the demo data for the new modules.

Demo users all share the password `Textile@2026`:

| Email | Role | Shows |
|---|---|---|
| `admin@textile.local` | Super Admin | everything |
| `owner@textile.local` | Owner / Director | approvals, read-only everywhere |
| `purchase@textile.local` | Purchase Manager | suppliers & mills, masked bank numbers, maker side of approvals |
| `surat.stores@textile.local` | Warehouse Manager | inventory screens, data scope limited to the Surat warehouse and GSTIN |
| `accounts@textile.local` | Accounts Manager | reference data, full bank numbers |
| `sales@textile.local` | Sales Executive (West & North) | own leads and quotations |
| `sales.south@textile.local` | Sales Executive (South) | own leads and quotations |
| `sales.east@textile.local` | Sales Executive (East) | own leads (on leave in the demo, so skipped by allocation) |
| `salesmgr@textile.local` | Sales Manager | whole team, allocation rules, attendance, targets, price approvals |
| `auditor@textile.local` | Auditor / CA | read-only, including the audit trail |
| `millops@textile.local` | Mill Operations Manager | job-work orders, mills, rate cards, claims |
| `dispatch@textile.local` | Dispatch Manager | allocation, pick/pack, invoices, dispatch, transport, returns |
| `hr@textile.local` | HR Manager | employees, attendance, leave, recruitment, payroll, handover |
| `buyer@srimurugan.example` | Customer portal — company admin (Sri Murugan Garments, credit) | shop, orders, invoices, company users |
| `purchase@kolkatahosiery.example` | Customer portal — buyer (Kolkata Hosiery Works, advance) | shop, orders, token payments |
| `supplier@ambica.example` | Supplier portal (Shree Ambica Knitters) | the supplier’s own POs, dispatches and invoices |
| `mill@suratprocess.example` | Mill portal (Surat Process House) | the mill’s incoming material, jobs, stages and claims |

A good first tour:

1. Sign in as **purchase**. Open *Procurement → RFQs* and look at the quote comparison, then *Purchase orders*.
2. Open *Invoice workbench* and *Three-way match*: one demo invoice has a rate variance waiting for approval.
3. Sign in as **millops** and open *Mill job work*: the cockpit shows overdue and statutory deadlines; one returned job has low yield and an open claim.
4. Sign in as **mill@suratprocess.example** to see the same work from the mill’s side, and as **supplier@ambica.example** for the supplier portal.
5. Sign in as **surat.stores** → *Inventory*: open the inward waiting to be scanned, the QC queue, a lot’s genealogy, the warehouse map, the transfer to Kolkata (tax invoice, IGST) and the stock count in progress. Try the *Scan station* on your phone.
6. Sign in as **salesmgr** → *Sales & CRM*: the lead inbox (one Kolkata lead is unassigned because Sourav is on leave — open it to see why), *Lead allocation*, the customer 360 for Sri Murugan Garments, and *Price approvals*.
7. Sign in as **sales.south** to see only your own leads, then build a quotation and watch the margin and approval flag change as you type a price.
8. Sign in as **purchase@kolkatahosiery.example**: open the order waiting for its token and pay it on the sandbox payment page; the order is booked and appears in dispatch.
9. Sign in as **dispatch** → *Fulfilment*: the Delhi order needs a decision (no single warehouse has 600 kg) — request a split; scan rolls on a released fulfilment, pack, invoice and dispatch; open the delivered shipment’s tracking and POD.
10. Sign in as **accounts** → *B2B commerce*: payments and their reconciliation, customer advances, token policies (one Kolkata rule waits for approval). Then *Finance*: the vouchers posted automatically from the invoices and receipts above, the bank reconciliation (three statement lines left to explain — try *Create entry* on the gateway settlement), GST returns with the 2B match, TDS, and the statements.
11. Sign in as **hr** → *HR & payroll*: last month’s payroll (posted in accounts), today’s attendance, the resignation with its exit checklist and handover task; then *My HR* as **sales.east** (on leave today, so CRM skips him). As **salesmgr**, open *Communications* for the WhatsApp/SMS/email log and *Workflow rules*; as **millops**, *Contracts* shows a rate contract due for renewal.
12. Sign in as **owner** → *Insights & AI*: the control tower and today’s brief, *Intelligence*, *Reports* (three shared reports), and ask the *Assistant* “Which fabrics should we reorder?”. As **admin**, *System health* → *Back up now* → *Test restore*.
13. Sign in as **owner** → *Go-live*: readiness shows what is still open; *UAT* has P1, P2 and P4 passed and one P7 defect; *Training* and *Cutover* are under way. As **admin**, download the parties template in *Data migration*, upload it, load and reconcile; then sign it off as **owner**.
14. Sign in as **admin** → *Approvals* to approve what is waiting, then look at the *Audit trail*.

### Payment gateway

`PAYMENT_GATEWAY=sandbox` (default) shows a stand-in bank page with *Pay* and *Simulate a declined payment*; the ERP still checks a signed callback and verifies the status separately. To go live with ICICI, set `PAYMENT_GATEWAY=icici` with the merchant credentials once the bank issues them; until then that adapter refuses requests rather than pretending.

### Customer messages

`MESSAGING_PROVIDER=sandbox` (default) records and “delivers” WhatsApp, SMS and email inside the ERP so the whole flow can be tested. Set `MESSAGING_PROVIDER=live` with `WHATSAPP_TOKEN` and `WHATSAPP_PHONE_NUMBER_ID` to send WhatsApp through Meta’s Cloud API; SMS and email providers are not connected yet (those messages fail and show in the log). `APP_PUBLIC_URL` is the address used in links sent to customers.

### GST payments and interest

On *Finance → GST*, record each month's GSTR-3B payment date. Paid after the due date (*Configuration*: `GSTR-3B due day`, 20 by default; 22 or 24 for quarterly filers), the ERP charges interest at 18% a year on the tax paid in cash and books it as interest owed; unpaid months past their due date raise an alert with the interest so far. Record GSTR-1 filings too: filed late, either return costs a late fee per day (₹50, or ₹20 for a nil return), capped by the previous year's turnover (set it in *Configuration*). Have the CA confirm these settings.

### Backups

Schedule `npm run backup -- --verify` nightly (Windows Task Scheduler) with the PostgreSQL `bin` folder on `PATH`, and copy `BACKUP_DIR` off the machine. See [docs/continuity.md](docs/continuity.md).

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
services/inventory    Lots, rolls, stock ledger, inward/QC, price tags, putaway, reservations, transfers, stock counts, ageing
services/crm          Lead sources and webhooks, duplicates, allocation, pipeline, quotations, credit, targets, customer 360
apps/web              React web app (design system, ERP screens, supplier and mill portals)
scripts               setup (DB + demo data, created through the APIs) and run (process launcher)
tests                 Unit and end-to-end integration tests
docs                  Architecture and requirement traceability
```
