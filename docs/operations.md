# Operations: mills, counter sales, stock counts, manual invoices, versions

## Mill losses and wrong goods

- **Shortage.** When a job order is closed, the system works out what the mill owes. That is the kg not returned, plus process loss above the allowance (`jobwork.allowed_loss_percent`, 3%). It is priced at the grey cost, or at `jobwork.shortage_rate_per_kg` when the cost is not known. The order cannot close until a shortage claim has been raised.
- **Wrong goods.** These are another party's fabric, or the wrong shade, GSM or quality. The return records them as quarantine, so they never enter sellable stock. The **whole value** (kg × grey rate) is held from the mill's payments at once. There are three ways to deal with the goods:
  - **Accept into stock.** The goods become good stock and the hold is released.
  - **Send back to mill / for rework.** A return challan is raised. The hold stays until one of these:
    - **Right goods received.** The hold is released.
    - **Charge the mill.** A debit note is raised for the value, or for an agreed amount.
- **Claims reach the books when raised, not when accepted.** Every quality or shortage claim with an amount is posted straight away (Dr mill, Cr *2150 Mill claims and holds pending*). The same applies to every quarantine hold. As a result:
  - the mill's ledger shows the entry;
  - the mill's balance, and so what the payment run offers to pay, is reduced at once.
  - The claim then ends in one of three ways:
    - **Accepted:** a debit note against purchases or job-work at the accepted amount. Any difference from the held amount goes back to the mill.
    - **Rejected or closed:** the hold is reversed.
    - **Amount changed while open:** the difference is posted.
- **Pending to apply** (Accounts → Mill deductions):
  - Every hold and debit note stays listed until someone records which mill bill it was adjusted in.
  - Totals are shown by mill. Items older than 30 days are flagged.
  - Finance users are notified when a new one is raised.
  - The payment run shows a "Mill deductions ₹…" badge against that mill's bills.
- Loss % by mill and process: Job work → Mill losses.

## Counter (cash) sales

- Scan rolls, preview the GST invoice and collect the full amount. The rolls leave stock and the invoice is posted with a receipt.
- **Buyer name and a 10-digit mobile are compulsory.** For a sale above ₹49,999 (`finance.counter_pan_above`) to a buyer without a GSTIN, **PAN is compulsory**.
- **Cash limit per buyer per financial year:**
  - The limit is ₹2,00,000 (`finance.cash_receipt_limit`).
  - The buyer is matched by mobile, PAN or GSTIN.
  - Cash beyond the limit is refused; the sale must be paid by UPI, card or bank.
  - The preview shows how much cash this buyer has paid so far this year.
- **Daily cash closing.** Count by denomination. A difference needs a note and raises an alert.

## Stock counts

- **Schedules.** Counts run on a schedule by warehouse, product or category (for example, monthly ABC).
- **Blind counts.** The counter does not see the expected quantity.
- **Reasons and costing.** Every difference needs a reason. The difference is valued at cost.
- **Approvals.** Differences above `inventory.stocktake_owner_limit` (₹25,000) need the owner.
- **Posting.** Approved differences post to *5060 Stock shortage and count differences*. The shrinkage trend is shown by warehouse.

## Manual invoices, previews and versions

- **Manual invoices.**
  - Sales and purchase invoices can be entered by hand.
  - Each one is approved by a second person.
  - Sales invoices are numbered from the GSTIN's series.
  - Posting includes GST and, on purchases, TDS.
- **Previews.** Quotations, purchase orders and invoices show a DRAFT-watermarked preview before confirming, and print the numbered document after.
- **Version history.** Every saved version is kept read-only. Only the latest version can be edited. Each version records what changed, who changed it and why.

## Moving stock in from iFAS (Saisun Group): proposal for discussion

| Question | Proposal |
| --- | --- |
| Rolls or lots? | iFAS holds rolls and kg, so bring stock in **roll by roll**. Each roll gets a barcode on import, carrying its kg, product, lot and warehouse. Stock held only as lot totals comes in as one "lot roll" per lot. It is split into rolls when it is next handled. |
| Shade / dye lot | Bring them in where iFAS has them. Where it does not, leave them blank and mark the roll "shade not recorded"; it is filled in at the physical count. |
| Cut-off date | Use a month end, ideally the end of a quarter (for example 31 March or 30 June), so the GST returns and books split cleanly. Freeze iFAS entries from the cut-off evening. |
| Physical count before go-live | Recommended. Do a blind count by warehouse in the last week before cut-off, then reconcile it with the iFAS closing. Only agreed figures are imported; differences are written off in iFAS before the cut-off. |
| Valuation | **Weighted average cost per product (and per lot for dyed fabric)**, for three reasons: it matches how textile traders usually value stock; it is accepted for tax (AS-2 and ICDS-II allow weighted average); and it avoids the record-keeping that FIFO needs per roll. Opening rolls take the iFAS closing rate. Fabric at mills comes in at grey cost, plus the job-work charge already booked. |
| Sign-off | To be agreed. Suggested: the stores head signs the counted quantities, the accounts head signs the values, and the owner approves the opening stock voucher. The import is kept read-only after sign-off. |
