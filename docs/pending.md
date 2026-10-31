# Pending work — parked for later

Everything known to be open after releases P1–P11 and the go-live migration and GST additions. The tracker
(*Textile_Trading_ERP_Development_and_Figma_Tracker.xlsx*) ends at P11; nothing below is a tracker phase of its own.
Each item says who has to act. Requirement IDs refer to [traceability.md](traceability.md).

Status at the time of parking: all 115 automated tests pass, the web app builds, and `main` holds everything.

## 1. Accounts and credentials you need to provide (blocks live use)

| Item | What it unlocks | Where it plugs in |
|---|---|---|
| ICICI payment gateway merchant credentials and API spec | Live customer payments (REQ-0053) | `PAYMENT_PROVIDER` / adapter in commerce; the stub refuses until configured |
| ICICI corporate banking (CIB) API | Direct bank feeds for reconciliation (REQ-0071), penny-drop bank verification (REQ-0013) | finance bank import; masters supplier onboarding |
| GST Suvidha Provider (GSP) account | E-invoice IRN, e-way bill generation (REQ-0022, 0034, 0035, 0060, 0064, 0069), GSTIN verification (REQ-0050) | today the IRN / e-way bill numbers are typed in |
| Meta WhatsApp Cloud API credentials | Live WhatsApp messages (REQ-0074); adapter is wired but untested without them | `MESSAGING_PROVIDER=live`, `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID` |
| SMS provider and email provider | SMS/email messages, password-reset emails, emailed scheduled reports (REQ-0074, 0082) | workflow messaging adapters (not connected) |
| `ANTHROPIC_API_KEY` | Business assistant answers with Claude and AI invoice extraction (REQ-0090, 0017); built-in fallback answers otherwise | `.env` |
| Lead platform push setups (Meta lead ads, IndiaMART CRM key, WhatsApp Business) | Automatic lead capture (REQ-0039) | configured on each platform, pointing at the CRM webhooks |

## 2. To be confirmed by the CA / payroll consultant

- GSTR-3B and GSTR-1 due days, interest rate, previous-year aggregate turnover (*Configuration → Finance*).
- Statutory return period for job work (REQ-0027, setting placeholder).
- Valuation basis and document type for transfers between GSTINs (REQ-0035).
- Payroll rules in `services/hrms/src/statutory.ts` and PT slabs (REQ-0080).
- Tax configuration sign-off before cutover (cutover checklist item).

## 3. GST compliance gaps

- **Rule 42/43 reversals are not computed**; the CA's figures are loaded as amounts.
- **24% interest on wrongly availed and used credit (Section 50(3))** is not calculated.
- **Payment in parts:** a month's 3B payment is one date; interest on partly paid tax is not split by date.
- **Due-date extensions and holidays** are not applied automatically; use the portal-figure override.
- **QRMP (quarterly) filers:** only the due day is configurable; quarterly returns, IFF and PMT-06 are not modelled.
- **3B set-off journal:** the return computes credit and cash set-off, but the journal that clears output GST against
  input GST / cash ledger is still entered by hand.
- **Other returns:** late fee and tracking cover GSTR-3B and GSTR-1 only (not GSTR-9/9C, ITC-04, etc.).
- **Cash ledger interest/fee heads:** cash is not moved between heads (PMT-09) from the ERP.
- Returns are filed on the portal; GSTR-1 JSON is exported, nothing is uploaded automatically.

## 4a. From the live demo audit (31 Oct 2026)

Every demo role was crawled on the hosted demo (17 roles, 688 screen visits, no errors) and the books reconciled
against the documents after a reload with richer history (14 checks, all pass). Open items from that audit:

- **Durable document storage on the hosted demo.** On Vercel, uploads live in `/tmp` and vanish when the instance
  recycles. Move document storage to Supabase Storage (or S3) before anyone uploads real files.
- **Supplier payment run.** Supplier invoices can now be paid one at a time (*Record payment*); add a batch run over
  approved bills with a bank bulk-upload file (NEFT bulk format) and a payment advice to each supplier.
- **Customer receipt matching.** Offline receipts are recorded by hand (*Record offline payment*); match bank-statement
  credits to open invoices and offer one-click recording.
- **Bill-wise receivables.** Receivables ageing allocates receipts to the oldest bills from the party balance; add
  explicit bill-wise knock-off (receipt against invoice) for customers who pay invoice by invoice.
- **Remaining long screens.** Most screens fit 1440×900 without scrolling; the longest left are reference lists
  (programme tracker, training, communications, system status, GST returns, audit trail). Add tabs or filters.
- **Mobile warehouse screens.** Phone-first inward weighing, picking and counts with camera barcode scanning.
- **Supabase plan.** The free plan has 60 connections, pauses after a week idle and keeps no point-in-time
  backups: upgrade before production. Keep one login role (`deploy/supabase-roles.sql`).

## 4. Features partly built (code work)

**Security and platform**
- MFA enforcement: the *Require MFA for privileged users* setting exists, but login does not force enrolment.
- Password-reset links show on screen outside production until an email provider is connected.

**Procurement and job work**
- Suppliers cannot submit RFQ quotes in the portal; the buyer enters them (REQ-0014).
- Invoice OCR throughput (100–150/hour) must be load-tested with real invoices and an API key (REQ-0017).

**Inventory and warehouse**
- Code 128 (1-D) barcode labels for 1-D-only scanners; labels carry a QR code today (REQ-0029).
- Weighing-scale integration beyond keyboard-wedge scales (REQ-0030).
- Roll-level price overrides (REQ-0031).
- Optimised pick paths, batch and zone picking (REQ-0033).
- Offline capture beyond put-away on the scan station (REQ-0091).

**Sales, commerce and fulfilment**
- Lead "specialisation" is stored but not used as an allocation criterion (REQ-0041).
- Customer-specific price lists (REQ-0046).
- Incentive slabs and payout calculation (REQ-0048).
- Product photos/swatches upload; price visibility per customer group (REQ-0049).
- Road distance (not state-zone bands) in the allocation engine (REQ-0057).
- Live GPS from transporters (REQ-0062).
- Replacement orders from returns are created manually (REQ-0064).

**Finance**
- Manual bill-wise allocation screen; supplier debit notes are entered as journals (REQ-0066).
- Several legal entities and intercompany beyond branch transfers are not exercised (REQ-0067).
- Back-dated (historical) stock valuation (REQ-0068).
- Form 26Q in the NSDL FVU format (REQ-0070).
- Schedule III formatting and comparatives for the statutory audit (REQ-0072).

**Workflow, HR and payroll**
- Inbound WhatsApp replies / feedback scores (REQ-0074).
- Approval as a workflow-rule action (REQ-0076).
- Biometric attendance import and geofencing (REQ-0079).
- Old tax regime, employee declarations, PF ECR / ESIC challan files, Form 16/24Q, arrears (REQ-0080).
- Handing over open quotations and other customer commitments when an employee leaves (REQ-0081).

**Insights**
- Native .xlsx export (CSV and PDF today) (REQ-0082).
- Saved dashboard layouts per role; productivity measures beyond task counts (REQ-0083).
- Supplier capacity and risk inputs (REQ-0084); shade ΔE comparison from lab readings (REQ-0085).
- Netting open POs from reorder suggestions; reservation priority suggestions (REQ-0086).
- Price elasticity by SKU (needs history) (REQ-0088).
- Commission ledger and processing cost per order (REQ-0089).
- Automated off-site backup copy (REQ-0091).

## 5. Business work (not code)

- Run the UAT scenarios and sign off each phase (REQ-0093).
- Prepare training material and hold the sessions (REQ-0094).
- Data cleansing and the actual migration files from the legacy system.
- Go/no-go decision, rollback plan and support ownership (REQ-0095).

## 6. Housekeeping

- Some "Remaining" notes in [traceability.md](traceability.md) for P1–P5 point at later phases that have since
  delivered them (for example employee master in P9, workflow engine in P9, lot ledger in P4, GL postings in P8,
  attendance-aware allocation fed by HRMS). Review and tidy those rows.
- The web bundle is over Vite's 500 kB chunk warning; split routes with dynamic imports.
- The built web app (`apps/web/dist`) is committed so the app runs with plain Node; rebuild before each commit
  that changes the UI, or move to building on install.
- Integration tests must run one file at a time (`npm test` does this); they share one test database per file.

## Picking this up again

1. `git pull origin main`, then `npm install` and `npm run setup -- --reset`.
2. `npm test` should report 115 passing tests.
3. Start from the section above that matters most, and update this file as items close.
