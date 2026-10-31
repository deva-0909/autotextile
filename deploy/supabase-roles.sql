-- Database roles for hosting on Supabase (or any Postgres behind a transaction pooler).
-- Run once as the project's `postgres` user, replacing __PASSWORD__ with a strong password (the same one goes into
-- DATABASE_URL on Vercel as erp_owner.<project-ref>:<password>@<pooler-host>:6543/postgres, DB_ROLE_PER_SERVICE=1).
--
-- Each service logs in as erp_<service>. The role fixes its search_path to the service's schema (a transaction pooler
-- does not keep per-connection settings) and switches to erp_owner, which owns every schema and table, so setup and
-- cross-schema seeding work exactly as they do locally.

DO $$
DECLARE
  svc text;
  pwd text := '__PASSWORD__';
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_owner') THEN
    CREATE ROLE erp_owner NOLOGIN;
  END IF;
  EXECUTE format('GRANT CREATE, CONNECT, TEMPORARY ON DATABASE %I TO erp_owner', current_database());
  FOREACH svc IN ARRAY ARRAY['identity','organisation','masters','governance','procurement','jobwork','inventory','crm','commerce','fulfilment','finance','workflow','hrms','insights','golive'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_' || svc) THEN
      EXECUTE format('CREATE ROLE %I LOGIN PASSWORD %L', 'erp_' || svc, pwd);
    ELSE
      EXECUTE format('ALTER ROLE %I LOGIN PASSWORD %L', 'erp_' || svc, pwd);
    END IF;
    EXECUTE format('GRANT erp_owner TO %I', 'erp_' || svc);
    EXECUTE format('ALTER ROLE %I SET search_path = %I, public', 'erp_' || svc, svc);
    EXECUTE format('ALTER ROLE %I SET role = erp_owner', 'erp_' || svc);
  END LOOP;
END $$;
