\getenv nas_app_database_password NAS_APP_DATABASE_PASSWORD

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'CREATE ROLE anon NOLOGIN';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'CREATE ROLE authenticated NOLOGIN';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    EXECUTE 'CREATE ROLE service_role NOLOGIN BYPASSRLS';
  END IF;
END
$$;

-- Create the login only on first bootstrap. The password is supplied through a
-- mounted secret and expanded by psql as a quoted SQL literal.
SELECT format('CREATE ROLE blacklight_app LOGIN BYPASSRLS PASSWORD %L', :'nas_app_database_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'blacklight_app')
\gexec
ALTER ROLE blacklight_app LOGIN BYPASSRLS PASSWORD :'nas_app_database_password';
GRANT service_role TO blacklight_app;

CREATE SCHEMA IF NOT EXISTS auth;
CREATE OR REPLACE FUNCTION auth.role() RETURNS text
LANGUAGE sql STABLE PARALLEL SAFE
AS $$ SELECT current_user::text $$;
GRANT USAGE ON SCHEMA auth TO PUBLIC;
GRANT EXECUTE ON FUNCTION auth.role() TO PUBLIC;
COMMENT ON FUNCTION auth.role() IS 'NAS compatibility shim for the CloudBase runtime diagnostic migration; not an authentication mechanism.';

CREATE SCHEMA IF NOT EXISTS nas_meta;
REVOKE ALL ON SCHEMA nas_meta FROM PUBLIC, anon, authenticated, service_role;
CREATE TABLE IF NOT EXISTS nas_meta.schema_migrations (
  migration_name text PRIMARY KEY,
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  applied_at timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON TABLE nas_meta.schema_migrations FROM PUBLIC, anon, authenticated, service_role;
