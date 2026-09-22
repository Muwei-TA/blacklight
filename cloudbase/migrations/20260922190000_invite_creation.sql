-- T-B11/T-B12 operations UI support.
-- This migration is independent from 20260922170000_governance.sql.  It adds
-- read-only member projection and atomic invite creation without replacing the
-- already deployed hg_governance function.

CREATE OR REPLACE FUNCTION public.hg_governance_admin(
  p_action text,
  p_actor_id text,
  p_input jsonb DEFAULT '{}'::jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  actor jsonb;
  result jsonb;
  page_limit integer;
BEGIN
  IF p_actor_id IS NULL OR p_actor_id = '' THEN
    RAISE EXCEPTION 'FORBIDDEN';
  END IF;

  SELECT doc INTO actor
  FROM public.hg_memberships
  WHERE doc->>'userId' = p_actor_id
    AND doc->>'clubId' = 'heiguang'
  FOR UPDATE;

  -- Operations pages are intentionally moderator-only.  Admin membership is
  -- not silently broadened into access to the member roster or invite secret.
  IF actor IS NULL OR actor->>'status' <> 'active' OR actor->>'role' <> 'moderator' THEN
    RAISE EXCEPTION 'FORBIDDEN';
  END IF;

  IF p_action = 'members.list' THEN
    page_limit := COALESCE(NULLIF(p_input->>'limit', '')::integer, 50);
    IF page_limit < 1 OR page_limit > 100 THEN
      RAISE EXCEPTION 'INVALID';
    END IF;

    SELECT COALESCE(jsonb_agg(item ORDER BY item->>'displayName', item->>'targetUserId'), '[]'::jsonb)
    INTO result
    FROM (
      SELECT jsonb_build_object(
        'targetUserId', membership.doc->>'userId',
        'displayName', COALESCE(users.doc->>'displayName', ''),
        'role', membership.doc->>'role',
        'status', membership.doc->>'status',
        'mutedUntil', membership.doc->'mutedUntil',
        'version', COALESCE(NULLIF(membership.doc->>'version', '')::integer, 1)
      ) AS item
      FROM public.hg_memberships AS membership
      LEFT JOIN public.hg_users AS users ON users.id = membership.doc->>'userId'
      WHERE membership.doc->>'clubId' = 'heiguang'
      ORDER BY users.doc->>'displayName', membership.doc->>'userId'
      LIMIT page_limit
    ) rows;

    -- No wxOpenIdRef, private profile fields, or membership internals cross
    -- this projection boundary.
    RETURN jsonb_build_object('ok', true, 'items', result);
  END IF;

  RAISE EXCEPTION 'INVALID';
END;
$$;

CREATE OR REPLACE FUNCTION public.hg_create_invite(
  p_actor_id text,
  p_input jsonb DEFAULT '{}'::jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  actor jsonb;
  code text;
  now_text text := to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  expires_text text;
  max_uses integer;
  ttl_seconds integer;
  inserted integer;
  audit_id text;
BEGIN
  IF p_actor_id IS NULL OR p_actor_id = '' THEN
    RAISE EXCEPTION 'FORBIDDEN';
  END IF;

  SELECT doc INTO actor
  FROM public.hg_memberships
  WHERE doc->>'userId' = p_actor_id
    AND doc->>'clubId' = 'heiguang'
  FOR UPDATE;
  IF actor IS NULL OR actor->>'status' <> 'active' OR actor->>'role' <> 'moderator' THEN
    RAISE EXCEPTION 'FORBIDDEN';
  END IF;

  BEGIN
    max_uses := COALESCE(NULLIF(p_input->>'maxUses', '')::integer, 1);
    ttl_seconds := COALESCE(NULLIF(p_input->>'ttlSeconds', '')::integer, 604800);
  EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
    RAISE EXCEPTION 'INVALID';
  END;
  IF max_uses < 1 OR max_uses > 1000 OR ttl_seconds < 60 OR ttl_seconds > 7776000 THEN
    RAISE EXCEPTION 'INVALID';
  END IF;

  expires_text := to_char(
    (clock_timestamp() + make_interval(secs => ttl_seconds)) AT TIME ZONE 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
  );

  -- gen_random_uuid() is provided by current PostgreSQL versions.  The code
  -- is returned once to the moderator, stored as a restricted invite ID, and
  -- never included in audit data or server logs.
  LOOP
    code := substr(upper(replace(gen_random_uuid()::text, '-', '')), 1, 12);
    INSERT INTO public.hg_invite_codes (id, doc) VALUES (
      code,
      jsonb_build_object(
        '_id', code,
        'clubId', 'heiguang',
        'expiresAt', expires_text,
        'maxUses', max_uses,
        'usedCount', 0,
        'revokedAt', NULL,
        'createdBy', p_actor_id,
        'createdAt', now_text,
        'updatedAt', now_text
      )
    ) ON CONFLICT (id) DO NOTHING;
    GET DIAGNOSTICS inserted = ROW_COUNT;
    EXIT WHEN inserted = 1;
  END LOOP;

  audit_id := 'audit:' || md5('invite:' || code || ':' || p_actor_id);
  INSERT INTO public.hg_audit_logs (id, doc) VALUES (
    audit_id,
    jsonb_build_object(
      '_id', audit_id,
      'actorId', p_actor_id,
      'action', 'invite.create',
      'targetType', 'invite',
      'targetId', 'invite:' || md5(code),
      'decision', 'created',
      'reason', '',
      'extra', jsonb_build_object('maxUses', max_uses, 'expiresAt', expires_text),
      'createdAt', now_text
    )
  );

  RETURN jsonb_build_object(
    'ok', true,
    'code', code,
    'expiresAt', expires_text,
    'maxUses', max_uses,
    'usedCount', 0
  );
END;
$$;

REVOKE ALL ON FUNCTION public.hg_governance_admin(text, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.hg_governance_admin(text, text, jsonb) TO service_role;
REVOKE ALL ON FUNCTION public.hg_create_invite(text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.hg_create_invite(text, jsonb) TO service_role;
