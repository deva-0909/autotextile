-- Database roles for hosting on Supabase (or any Postgres behind a transaction pooler).
-- Run once as the project's `postgres` user, replacing __PASSWORD__ with a strong password (the same one goes into
-- Vercel as DB_PASSWORD, or into DATABASE_URL as erp_identity.<project-ref>:<password>@<pooler-host>:6543/postgres).
--
-- The whole backend logs in as one role, erp_identity, which acts as erp_owner (owner of every schema and table).
-- Each service sets its own schema search path per transaction (packages/platform/src/db.ts), so one login role is
-- enough. A login role per service would give the pooler one connection pool per role, which exhausts a small
-- database's connection slots; any per-service roles left from earlier versions are therefore switched off below.

DO $$
DECLARE
  r text;
  pwd text := '__PASSWORD__';
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_owner') THEN
    CREATE ROLE erp_owner NOLOGIN;
  END IF;
  EXECUTE format('GRANT CREATE, CONNECT, TEMPORARY ON DATABASE %I TO erp_owner', current_database());
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_identity') THEN
    EXECUTE format('CREATE ROLE erp_identity LOGIN PASSWORD %L', pwd);
  ELSE
    EXECUTE format('ALTER ROLE erp_identity LOGIN PASSWORD %L', pwd);
  END IF;
  GRANT erp_owner TO erp_identity;
  ALTER ROLE erp_identity SET search_path = identity, public;
  ALTER ROLE erp_identity SET role = erp_owner;
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname LIKE 'erp\_%' AND rolname NOT IN ('erp_identity', 'erp_owner') AND rolcanlogin LOOP
    EXECUTE format('ALTER ROLE %I NOLOGIN', r);
  END LOOP;
END $$;
