# Demo hosting: Vercel (app and API) + Supabase (PostgreSQL)

The demo runs as one Vercel project: the web app is served as static files and the whole backend (gateway and all
15 services) runs in one Node function (`deploy/serverless.ts`, built by `npm run build:vercel`). Supabase provides
only the PostgreSQL database. Locally nothing changes: `npm run setup` and `npm start` work as before.

## How it differs from running locally

- **Database roles.** Vercel reaches Supabase through its connection pooler (IPv4) in transaction mode, which does not
  keep per-connection settings. The whole backend logs in as one role, `erp_identity` (acting as `erp_owner`, which owns
  the schemas), and each service sets its schema search path inside every transaction. One login role matters: the
  pooler keeps a separate pool per role, and fifteen roles exhausted the free plan's 60 connection slots.
- **No background processes.** The event bus is drained after every change and before reads; the services' periodic
  checks and the message dispatcher run in the background after requests (at most every 10 minutes) and from a daily
  Vercel Cron call to `/api/_cron`.
- **Setup is automatic**: the first request on an empty database migrates every schema and loads the demo data
  (about 10 seconds, once; concurrent cold starts wait for it). To reset the demo later, set `SETUP_SECRET` and call
  `POST /api/_setup?reset=1` with `Authorization: Bearer <SETUP_SECRET>`; without it that endpoint does not exist.
- **Uploaded documents are kept in the database** (`STORAGE_BACKEND=database`, set by the build): a Vercel instance has
  no lasting disk. Uploads are limited to 20 MB each; keep an eye on the free plan's 500 MB database limit, and move
  to S3-compatible storage (Supabase Storage) for real volumes.
- **Not available on Vercel:** backups and restore tests (`pg_dump` is not installed; use Supabase's own backups).

## One-time steps

1. **Supabase**: create a project (free plan, region `ap-south-1`) and run `deploy/supabase-roles.sql` in its SQL
   editor with `__PASSWORD__` replaced by a strong password.
2. **Vercel**: *Add New → Project → Import* `deva-0909/autotextile`. The settings come from `vercel.json`
   (install `npm ci`, build `npm run build:vercel`, region `bom1`). Add these environment variables (Production):

   | Variable | Value |
   |---|---|
   | `SUPABASE_PROJECT_REF` | the Supabase project reference (from its URL) |
   | `SUPABASE_REGION` | `ap-south-1` |
   | `DB_PASSWORD` | the password used in step 1 |
   | `JWT_SECRET` | a long random string |
   | `SETUP_SECRET` | optional: a long random string, to allow resetting the demo |
   | `CRON_SECRET` | a long random string |
   | `PAYMENT_WEBHOOK_SECRET` | a long random string |
   | `DEMO_MODE` | `1` (role switcher and password-free demo sign-in) |

   The function finds the right pooler host from the project reference and region. Alternatively set `DATABASE_URL`
   to `postgres://erp_identity.<ref>:<password>@<pooler-host>:6543/postgres`.
3. **Open the app.** The first visit loads the demo data. To reset it later:
   `curl -X POST "https://<your-app>.vercel.app/api/_setup?reset=1" -H "Authorization: Bearer <SETUP_SECRET>"`.

Every push to `main` redeploys automatically. Share the production address (`https://<project>.vercel.app`), not a
deployment-specific preview link: a preview keeps running the code it was built from.

To reload the demo data without SETUP_SECRET, delete the completion marker in the Supabase SQL editor
(`DELETE FROM identity.setup_state;`); the next request resets every schema and seeds again (about a minute).

## Demo mode

With `DEMO_MODE=1` the sign-in page lists every demo user as a one-click card, and a **Demo** button at the bottom
right of every screen (staff app and the customer, supplier and mill portals) switches to any other user without a
password. Each user still sees only what their role and data scope allow. Never set `DEMO_MODE` on a real system.
