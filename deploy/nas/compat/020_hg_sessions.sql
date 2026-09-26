CREATE TABLE IF NOT EXISTS public.hg_sessions (
  token_hash text PRIMARY KEY,
  openid_ref text NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS hg_sessions_openid_ref_idx
  ON public.hg_sessions (openid_ref);
CREATE INDEX IF NOT EXISTS hg_sessions_expires_at_idx
  ON public.hg_sessions (expires_at);

ALTER TABLE public.hg_sessions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.hg_sessions FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.hg_sessions TO service_role;
