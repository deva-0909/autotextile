# Continuity runbook

Targets (configurable in `.env`): **RPO 24 hours** (`RPO_HOURS`) — at most one day of data may be lost;
**RTO 4 hours** (`RTO_HOURS`) — the ERP is usable again within four hours of a failure.

## What protects the data

| Layer | How |
|---|---|
| Nightly backup | `npm run backup -- --verify` from Windows Task Scheduler (or cron) at 01:00. It writes a `pg_dump` custom-format file to `BACKUP_DIR`, records its SHA-256 and the row counts of key tables, restores it into a scratch database and compares the counts. Files older than `BACKUP_KEEP_DAYS` (30) are removed. |
| Off-site copy | Copy `BACKUP_DIR` to a second location every night (OneDrive/SharePoint sync folder, a NAS in another building, or cloud storage). A backup on the same disk as the database is not a backup. |
| On-demand | *Administration → System health → Back up now*, then *Test restore*. Do this before every upgrade. |
| Event bus | Business events are stored in the database (`bus.events`) with each module’s position; a module that was down catches up by itself. Events a module could not process are parked and can be replayed from *System health* after the cause is fixed. Postings are idempotent, so a replay never doubles a voucher or a stock movement. |
| Audit trail | Every change is in `governance.audit_log`, inside the same backup. |

Windows Task Scheduler action (run whether the user is logged on or not):

```
Program:   C:\Program Files\nodejs\npm.cmd
Arguments: run backup -- --verify
Start in:  C:\textile-erp
```

`pg_dump` and `pg_restore` must be on `PATH` (add `C:\Program Files\PostgreSQL\17\bin`).

## Restoring after a failure

1. Stop the ERP (`Ctrl+C` in the `npm start` window, or stop the service).
2. Pick the latest backup whose restore test passed (*System health* lists them, or `BACKUP_DIR`).
3. Recreate the database and restore:
   ```
   dropdb -U postgres textile_erp
   createdb -U postgres textile_erp
   pg_restore -U postgres --no-owner -d textile_erp C:\textile-erp\backups\textile_erp-YYYY-MM-DDTHH-MM-SS.dump
   ```
4. Start the ERP (`npm start`) and check *System health*: all services up, no consumer far behind.
5. Re-enter the work done since the backup (the gap is at most the RPO). Check bank, stock and invoices for that window.
6. Record the incident: time of failure, backup used, time back in service (the measured RTO).

## Offline working

The warehouse scan station keeps put-away moves made without a network on the device and sends them, in order,
when the connection returns; the server checks each one as if it had been made live. Anything that releases goods
or money — dispatch, invoices, payments, approvals — needs the server and is never done offline.

## Restore drills

Run a full restore drill every quarter on a spare machine using the steps above, time it, and keep the record with the
UAT sign-off. The *Test restore* button proves a file is complete; the drill proves the people and the machine can do it.
