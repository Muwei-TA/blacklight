-- Additive browser credentials: no user/content rewrite, no client grants.
CREATE TABLE IF NOT EXISTS public.hg_web_accounts (
  username text PRIMARY KEY CHECK (username ~ '^[a-z0-9][a-z0-9_]{2,31}$'),
  user_id text UNIQUE NOT NULL REFERENCES public.hg_users(id) ON DELETE CASCADE,
  password_hash text NOT NULL CHECK (password_hash ~ '^scrypt:[0-9a-f]{32}:[0-9a-f]{128}$'),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.hg_web_sessions (
  token_hash text PRIMARY KEY CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  user_id text NOT NULL REFERENCES public.hg_web_accounts(user_id) ON DELETE CASCADE,
  credential_version integer NOT NULL,
  origin text NOT NULL,
  expires_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);
CREATE INDEX IF NOT EXISTS hg_web_sessions_user_idx ON public.hg_web_sessions(user_id);
CREATE INDEX IF NOT EXISTS hg_web_sessions_expiry_idx ON public.hg_web_sessions(expires_at);
CREATE TABLE IF NOT EXISTS public.hg_web_auth_limits (
  bucket_hash text PRIMARY KEY CHECK (bucket_hash ~ '^[0-9a-f]{64}$'),
  window_started_at timestamptz NOT NULL,
  attempts integer NOT NULL CHECK (attempts > 0)
);
DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['hg_web_accounts', 'hg_web_sessions', 'hg_web_auth_limits'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, anon, authenticated', table_name);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO service_role', table_name);
    EXECUTE format('DROP POLICY IF EXISTS web_service_only ON public.%I', table_name);
    EXECUTE format('CREATE POLICY web_service_only ON public.%I FOR ALL TO service_role USING (true) WITH CHECK (true)', table_name);
  END LOOP;
END $$;
