# Database over Supabase's web API

The hosted demo can run without any direct Postgres connection. The services talk to the database through one
function, `erp_run`, called over HTTPS on Supabase's REST endpoint (`/rest/v1/rpc/erp_run`) with the server-only
service role key, the same way `supabase-js` calls `.rpc()`. Nothing holds a connection, a lock or an open
transaction between requests, so a paused serverless instance can never block the database.

## How a transaction works

The services' code is unchanged: it still runs `BEGIN … COMMIT` with any number of statements in between.
`packages/platform/src/transport.ts` turns that into short, self-contained calls:

1. Each statement is tried in a **scratch run** together with the changes made so far, then rolled back. The code gets
   real results (including its own earlier changes) and nothing stays locked.
2. On `COMMIT`, every change is **replayed in one atomic call**. The replay checks that rows read `FOR UPDATE`, and rows
   returned by changes, are still what the code saw.
3. If someone else changed them in between, the call fails with SQLSTATE 40001 and the whole transaction is run again
   (unless it called another service, in which case the user gets "please try again").

Generated keys come out the same in the scratch runs and the replay: column defaults use `erp_uuid()` and
`erp_nextval()`, which hand back the values recorded earlier before generating new ones. Outside `erp_run` they behave
exactly like `gen_random_uuid()` and `nextval()`.

## Modes

| `DB_TRANSPORT` | Used for | How statements reach the database |
|---|---|---|
| `pg` (default) | local development, on-premise | a normal connection pool |
| `rpc` | CI | a local pool that only ever calls `erp_run` (the same function as production) |
| `http` | the hosted demo | HTTPS to `SUPABASE_URL/rest/v1/rpc/erp_run` with `SUPABASE_SERVICE_ROLE_KEY` |

CI runs the whole test suite in `pg` and `rpc` modes, and loads the full demo data in both.

## Supabase setup (done once)

`packages/platform/src/sql/erp_api.sql` installed as a migration, then:

- the functions and the `erp_locks` table owned by `erp_owner` (so `erp_run` runs with the app's rights);
- `erp_run` executable only by `service_role`, nothing callable by `anon` or `authenticated`;
- `SELECT erp_normalize_defaults('<schema>')` as `erp_owner` for every app schema (generated keys);
- `ALTER ROLE service_role SET statement_timeout = '120s'` (migrations and large reports exceed the 8 s default).

## Vercel environment

| Variable | Value |
|---|---|
| `DB_TRANSPORT` | `http` |
| `SUPABASE_URL` | `https://<project-ref>.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase → Project settings → API keys → `service_role` (secret; server-side only) |
| `DB_ROLE_PER_SERVICE` | `1` (schemas, not databases, are reset on a demo reload) |

`DATABASE_URL`, `DB_PASSWORD` and the `erp_identity` login are not needed in this mode.

## Reloading the demo

A full demo load is about 18,000 database calls. Over the web API that takes 10–12 minutes, longer than a Vercel
function may run (5 minutes on the current plan). So when `DATABASE_URL` (or `SUPABASE_PROJECT_REF` + `DB_PASSWORD`)
is also set, the load alone uses a temporary direct pool (about 1.5 minutes) that is closed when it finishes; every other
request stays on the web API. Without those settings, a reload needs a host that allows a longer run (Vercel Pro:
13 minutes) or the load split into resumable parts.

## What needs a direct connection

Manual backups and restore tests use `pg_dump`/`pg_restore`, so they are available only with `DB_TRANSPORT=pg`. On the
hosted demo, Supabase's own daily backups apply.
