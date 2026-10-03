CREATE OR REPLACE FUNCTION public.hg_admin_web_authorization_hash(p_user_id text)
RETURNS text
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
AS $$
  SELECT encode(digest(convert_to(
    concat_ws('|',
      u.id,
      COALESCE(u.doc->>'platformRole', 'none'),
      COALESCE((
        SELECT jsonb_agg(jsonb_build_array(
          m.doc->>'clubId',
          m.doc->>'role',
          m.doc->>'version',
          m.doc->>'managementTermId',
          c.doc->>'status',
          c.doc->>'managementVersion',
          c.doc->>'managementTermId',
          t.doc->>'version'
        ) ORDER BY m.doc->>'clubId')::text
          FROM public.hg_memberships AS m
          JOIN public.hg_club_config AS c ON c.id = m.doc->>'clubId'
          LEFT JOIN public.hg_management_terms AS t ON t.id = c.doc->>'managementTermId'
         WHERE m.doc->>'userId' = u.id
           AND m.doc->>'status' = 'active'
           AND m.doc->>'role' IN ('admin', 'moderator')
      ), '[]')
    ), 'UTF8'), 'sha256'), 'hex')
    FROM public.hg_users AS u
   WHERE u.id = p_user_id
     AND u.doc->>'status' = 'active'
     AND (
       u.doc->>'platformRole' = 'developer'
       OR EXISTS (
         SELECT 1 FROM public.hg_memberships AS m
          WHERE m.doc->>'userId' = u.id
            AND m.doc->>'status' = 'active'
            AND m.doc->>'role' IN ('admin', 'moderator')
       )
     )
$$;
REVOKE ALL ON FUNCTION public.hg_admin_web_authorization_hash(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.hg_admin_web_authorization_hash(text) TO service_role;

CREATE TABLE IF NOT EXISTS public.hg_admin_web_pairings (
  id text PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9_-]{24}$'),
  poll_key_hash text NOT NULL CHECK (poll_key_hash ~ '^[0-9a-f]{64}$'),
  origin text NOT NULL CHECK (length(origin) BETWEEN 8 AND 512),
  requester_hash text NOT NULL CHECK (requester_hash ~ '^[0-9a-f]{64}$'),
  status text NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'exchanged')),
  approved_user_id text,
  approved_authorization_hash text CHECK (approved_authorization_hash IS NULL OR approved_authorization_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  approved_at timestamptz,
  rejected_at timestamptz,
  exchanged_at timestamptz,
  CHECK ((status IN ('approved', 'exchanged')) = (approved_user_id IS NOT NULL)),
  CHECK ((status IN ('approved', 'exchanged')) = (approved_authorization_hash IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS hg_admin_web_pairings_requester_created_idx
  ON public.hg_admin_web_pairings (requester_hash, created_at DESC);
CREATE INDEX IF NOT EXISTS hg_admin_web_pairings_pending_expiry_idx
  ON public.hg_admin_web_pairings (expires_at)
  WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS public.hg_admin_web_pairing_limits (
  requester_hash text PRIMARY KEY CHECK (requester_hash ~ '^[0-9a-f]{64}$'),
  window_started_at timestamptz NOT NULL,
  attempts integer NOT NULL CHECK (attempts BETWEEN 1 AND 8)
);

CREATE TABLE IF NOT EXISTS public.hg_admin_web_sessions (
  token_hash text PRIMARY KEY CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  user_id text NOT NULL,
  openid_ref text NOT NULL,
  authorization_hash text NOT NULL CHECK (authorization_hash ~ '^[0-9a-f]{64}$'),
  origin text NOT NULL CHECK (length(origin) BETWEEN 8 AND 512),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  absolute_expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);

CREATE INDEX IF NOT EXISTS hg_admin_web_sessions_user_active_idx
  ON public.hg_admin_web_sessions (user_id, absolute_expires_at)
  WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS hg_admin_web_sessions_expiry_idx
  ON public.hg_admin_web_sessions (absolute_expires_at)
  WHERE revoked_at IS NULL;

ALTER TABLE public.hg_admin_web_pairings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hg_admin_web_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hg_admin_web_pairing_limits ENABLE ROW LEVEL SECURITY;
CREATE POLICY hg_admin_web_pairings_service_role ON public.hg_admin_web_pairings
  FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY hg_admin_web_sessions_service_role ON public.hg_admin_web_sessions
  FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY hg_admin_web_pairing_limits_service_role ON public.hg_admin_web_pairing_limits
  FOR ALL TO service_role USING (true) WITH CHECK (true);
REVOKE ALL ON public.hg_admin_web_pairings, public.hg_admin_web_sessions, public.hg_admin_web_pairing_limits FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.hg_admin_web_pairings, public.hg_admin_web_sessions, public.hg_admin_web_pairing_limits TO service_role;

COMMENT ON TABLE public.hg_admin_web_pairings IS 'Two-minute browser QR pairing state; only poll-key hashes are stored.';
COMMENT ON TABLE public.hg_admin_web_sessions IS 'Short-lived same-origin admin sessions; only the cookie-token hash is stored.';
COMMENT ON TABLE public.hg_admin_web_pairing_limits IS 'Atomic per-source limit for short-lived admin QR pairing requests.';
