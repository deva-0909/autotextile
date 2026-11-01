# Lead management

Built on the CRM service (`services/crm`), with working hours from HRMS and agent payouts posted by finance.

| Feature | Where | Notes |
|---|---|---|
| Lead score 0–100 with reasons | Lead inbox, lead page, My day | `score.ts`. Order value, minimum order, source, repeat buyer, stage, sample or visit feedback, re-enquiries, contact recency, no-progress flag. Hot 65+, warm 40–64, cold below 40. Recomputed on every change and every ten minutes. |
| My day (daily call list) | Sales & CRM → My day | Call now (never contacted, with the response timer), overdue, due today, this week; samples and visits waiting for feedback. Managers can view anyone's day. |
| Call logging | Lead page → Log a call | Outcome, minutes, notes, next follow-up. Wrong number closes the lead as an invalid contact; not interested asks for an objection. Every call counts towards the no-progress limit. |
| Many calls, no progress | Lead settings | Default 20 calls since the last real progress (a stage forward, or a positive sample or visit). The lead is flagged, its score drops, the owner and the sales manager are alerted. |
| Objections | Lead settings | Editable list; "Other" needs a note. Report: Sales reports → Why we lose. |
| Revive lost leads | Lead tools → Revive, or a lost lead's page | Selected leads, or every lead lost to one objection / date range / salesperson / source. Reopens as contact pending with a follow-up in an hour; the response timer restarts; history records why. |
| Best-performer assignment | Lead allocation → Rules | Contact rate (60%) and conversion (40%) over the window in Lead settings. |
| Manual override | Lead page → Assign | The engine's suggestion is shown; choosing someone else needs a reason and is recorded as an override. |
| Working hours | HR → employee → Working hours | Set by HR per employee (shift, or own hours). Sent to CRM (`hrms.shift.changed`); leads skip people outside their hours (IST). |
| Bulk assign and rebalance | Lead tools | Hot leads first. Rebalance previews before it moves anything; it takes unassigned leads, leads of inactive staff, and uncalled or due-today leads of people absent or on leave. |
| Response target | Lead settings (sales manager) | Default 15 minutes, counted from assignment to the first call attempt. A second limit (default 30 minutes, 0 = off) moves the lead once to the next available person. |
| Leaderboard | Sales reports → Team leaderboard | Assigned, never contacted, overdue, no progress, contact rate, average first-call time, calls, samples, visits, quotes, wins, losses, revenue against target. |
| Forecast | Sales reports → Forecast | Stage likelihood (Lead settings) × score × value (the lead's, or the category's average accepted quotation), in 30/60/90-day windows. |
| Re-enquiry | Automatic | The same mobile or email with an open lead: no new lead; the lead is marked, the message added, the owner told, the score raised. A webhook resending the same enquiry is counted once. |
| Samples and showroom visits | Lead page → Sample or visit | Courier and tracking, or date and host; customer feedback feeds the score; not interested can close the lead with an objection. |
| Source performance and ROI | Sales reports → Sources & ROI | Spend = cost per lead × leads + monthly fee × months + spend entered per month. Revenue = invoiced sales (before GST) to customers whose first lead came from the source, for the attribution period (Lead settings). |
| Commission agents | Sales & CRM → Agents; agent portal | Agents register buyers on their portal; a registered buyer is protected for the set days whichever way they come in. Commission accrues on a converted customer's invoices and is earned once the invoice is paid. A payout goes for approval (`crm.commission.approve`: owner, accounts manager); finance then posts commission expense and a payable to the agent with TDS 194H, paid in the normal payment run. |

Permissions added: `crm.commission.approve`, `portal.agent.access`; role `commission_agent`.
Tests: `tests/leads.integration.test.ts`.
