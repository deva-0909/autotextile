# Tests

`npm test` runs the unit tests and the integration tests (`tests/*.integration.test.ts`). Each integration file boots
the gateway and all 15 services in-process against its own throwaway database (created and dropped by the test), so
it needs a Postgres login that may create databases.

## On GitHub (every push and pull request)

The **Tests** workflow (`.github/workflows/tests.yml`) runs the typecheck and `npm test` against a throwaway Postgres
inside the run. Nothing to set up.

## Against Supabase

To run the same suite against Supabase (Actions → Tests → Run workflow → database: `supabase`):

1. In the Supabase SQL editor of the project, create a login used only by the tests, with a password of your own:

   ```sql
   CREATE ROLE erp_test LOGIN CREATEDB PASSWORD 'choose-a-long-random-password';
   ```

   It can create its own test databases and nothing else; it has no access to the demo's data.
2. In the GitHub repository: Settings → Secrets and variables → Actions → New repository secret
   `TEST_DATABASE_URL` =
   `postgres://erp_test.<project-ref>:<password>@<pooler-host>:6543/postgres?sslmode=no-verify`
   (the pooler host is shown under Connect → Transaction pooler in the Supabase dashboard; for this project it is
   `aws-0-ap-south-1.pooler.supabase.com`. If the other cluster is given, the workflow finds the right one itself).

The tests use the transaction pooler like the hosted app (one login, the schema set per transaction, three connections
per service), so they share the project's connection limit with whatever else runs there. Each test file builds its own database
over the network, which takes several minutes from GitHub's runners to Mumbai, so a full run takes about an hour and a half.
Files run one at a time: each test database gets its own pooler pool, and running several at once uses up the
connections the live demo needs.
The run drops its test databases at the end (and any left by an earlier run); 
`DROP ROLE erp_test` once you no longer need it.

## Locally

With Postgres running locally (`DATABASE_URL` defaults to `postgres://postgres:postgres@localhost:5432/textile_erp`):

```bash
npm test
```
