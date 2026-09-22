-- Atomic membership application.
--
-- The API supplies only the actor resolved from the WeChat session.  The
-- function serializes that user's application attempts, locks the invite
-- before checking and consuming its quota, and commits the application and
-- usedCount update together.  A pending application is an idempotent replay
-- and does not consume another invite use.

CREATE OR REPLACE FUNCTION public.hg_apply_membership(
  p_actor_id text,
  p_input jsonb DEFAULT '{}'::jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  user_doc jsonb;
  active_membership jsonb;
  pending_application jsonb;
  club_config jsonb;
  invite jsonb;
  application jsonb;
  application_id text;
  display_name text;
  invite_code text;
  rules_version text;
  current_rules_version text;
  max_uses integer;
  used_count integer;
  now_text text := to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
BEGIN
  IF p_actor_id IS NULL OR p_actor_id = '' THEN
    RAISE EXCEPTION 'FORBIDDEN';
  END IF;

  -- The user row is the serialization point for same-user retries and
  -- concurrent attempts with different invite codes.
  SELECT doc INTO user_doc
  FROM public.hg_users
  WHERE public.hg_users.id = p_actor_id
  FOR UPDATE;
  IF user_doc IS NULL OR user_doc->>'status' IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION 'FORBIDDEN';
  END IF;

  SELECT doc INTO active_membership
  FROM public.hg_memberships
  WHERE doc->>'userId' = p_actor_id
    AND doc->>'clubId' = 'heiguang'
    AND doc->>'status' = 'active'
  FOR UPDATE;
  IF active_membership IS NOT NULL THEN
    RAISE EXCEPTION 'ALREADY_MEMBER';
  END IF;

  -- Replay an existing pending request before touching a new invite.  This
  -- keeps retries idempotent even after the original invite expires or is
  -- exhausted, while returning only the caller's own application id.
  SELECT doc INTO pending_application
  FROM public.hg_membership_applications
  WHERE doc->>'userId' = p_actor_id
    AND doc->>'clubId' = 'heiguang'
    AND doc->>'status' = 'pending'
  ORDER BY doc->'createdAt' DESC, public.hg_membership_applications.id DESC
  LIMIT 1
  FOR UPDATE;
  IF pending_application IS NOT NULL THEN
    RETURN jsonb_build_object(
      'state', 'pending',
      'applicationId', pending_application->>'_id'
    );
  END IF;

  display_name := btrim(p_input->>'displayName');
  invite_code := upper(btrim(p_input->>'inviteCode'));
  rules_version := btrim(p_input->>'rulesVersion');
  IF display_name IS NULL OR display_name = '' OR char_length(display_name) > 20
     OR invite_code IS NULL OR invite_code = '' OR char_length(invite_code) > 32
     OR rules_version IS NULL OR rules_version = '' OR char_length(rules_version) > 20 THEN
    RAISE EXCEPTION 'INVALID';
  END IF;

  -- Hold the rules row while validating the submitted consent version.  A
  -- missing config preserves the documented v1.0 default, but a present
  -- config with another version cannot be bypassed by the client.
  SELECT doc INTO club_config
  FROM public.hg_club_config
  WHERE public.hg_club_config.id = 'heiguang'
  FOR SHARE;
  current_rules_version := COALESCE(NULLIF(club_config->>'rulesVersion', ''), 'v1.0');
  IF rules_version IS DISTINCT FROM current_rules_version THEN
    RAISE EXCEPTION 'RULES_VERSION_INVALID';
  END IF;

  -- The quota check and increment must use the same locked invite row.
  SELECT doc INTO invite
  FROM public.hg_invite_codes
  WHERE public.hg_invite_codes.id = invite_code
  FOR UPDATE;
  IF invite IS NULL THEN
    RAISE EXCEPTION 'INVITE_INVALID';
  END IF;
  IF invite->>'clubId' IS NOT NULL AND invite->>'clubId' <> 'heiguang' THEN
    RAISE EXCEPTION 'INVITE_INVALID';
  END IF;
  IF NULLIF(invite->>'revokedAt', '') IS NOT NULL THEN
    RAISE EXCEPTION 'INVITE_INVALID';
  END IF;

  BEGIN
    max_uses := NULLIF(invite->>'maxUses', '')::integer;
    used_count := COALESCE(NULLIF(invite->>'usedCount', '')::integer, 0);
    IF max_uses IS NOT NULL AND max_uses < 0 THEN
      RAISE EXCEPTION 'INVITE_INVALID';
    END IF;
    IF used_count < 0 OR (max_uses IS NOT NULL AND max_uses > 0 AND used_count >= max_uses) THEN
      RAISE EXCEPTION 'INVITE_INVALID';
    END IF;
    IF NULLIF(invite->>'expiresAt', '') IS NOT NULL
       AND NULLIF(invite->>'expiresAt', '')::timestamptz <= clock_timestamp() THEN
      RAISE EXCEPTION 'INVITE_INVALID';
    END IF;
  EXCEPTION
    WHEN invalid_text_representation OR numeric_value_out_of_range THEN
      RAISE EXCEPTION 'INVITE_INVALID';
  END;

  application_id := 'application:' || gen_random_uuid()::text;
  application := jsonb_build_object(
    '_id', application_id,
    'userId', p_actor_id,
    'clubId', 'heiguang',
    'displayName', display_name,
    'inviteCode', invite_code,
    'rulesVersion', rules_version,
    'status', 'pending',
    'version', 1,
    'createdAt', now_text,
    'updatedAt', now_text
  );

  INSERT INTO public.hg_membership_applications (id, doc)
  VALUES (application_id, application);

  UPDATE public.hg_invite_codes
  SET doc = invite || jsonb_build_object(
    'usedCount', used_count + 1,
    'updatedAt', now_text
  )
  WHERE public.hg_invite_codes.id = invite_code;

  RETURN jsonb_build_object(
    'state', 'pending',
    'applicationId', application_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.hg_apply_membership(text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.hg_apply_membership(text, jsonb) TO service_role;
