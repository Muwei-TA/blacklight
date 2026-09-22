-- Run after 20260922160000_postgresql_core.sql and
-- 20260922190000_invite_creation.sql with the service role.
BEGIN;
DO $$
DECLARE
  moderator_id text := 'ops-int-moderator';
  member_id text := 'ops-int-member';
  result jsonb;
  item jsonb;
  code text;
  n integer;
BEGIN
  INSERT INTO public.hg_users (id, doc) VALUES
    (moderator_id, jsonb_build_object(
      '_id', moderator_id, 'displayName', '运营测试 moderator',
      'wxOpenIdRef', 'openid-must-not-leak')),
    (member_id, jsonb_build_object(
      '_id', member_id, 'displayName', '普通成员',
      'wxOpenIdRef', 'openid-member-must-not-leak'));
  INSERT INTO public.hg_memberships (id, doc) VALUES
    ('membership:' || moderator_id, jsonb_build_object(
      '_id', 'membership:' || moderator_id, 'userId', moderator_id,
      'clubId', 'heiguang', 'status', 'active', 'role', 'moderator', 'version', 1)),
    ('membership:' || member_id, jsonb_build_object(
      '_id', 'membership:' || member_id, 'userId', member_id,
      'clubId', 'heiguang', 'status', 'active', 'role', 'member', 'version', 1));

  result := public.hg_governance_admin('members.list', moderator_id, '{"limit":100}'::jsonb);
  SELECT entry INTO item
  FROM jsonb_array_elements(result->'items') AS rows(entry)
  WHERE entry->>'targetUserId' = member_id;
  IF item IS NULL THEN RAISE EXCEPTION 'member list missing fixture'; END IF;
  IF item ? 'wxOpenIdRef' OR item ? 'userId' THEN RAISE EXCEPTION 'member list leaked identity'; END IF;
  IF item->>'displayName' <> '普通成员' THEN RAISE EXCEPTION 'member display name mismatch'; END IF;

  result := public.hg_create_invite(
    moderator_id,
    jsonb_build_object('maxUses', 2, 'ttlSeconds', 3600)
  );
  code := result->>'code';
  IF code IS NULL OR length(code) <> 12 OR code <> upper(code) THEN
    RAISE EXCEPTION 'invite code is not a secure server-generated token';
  END IF;
  SELECT doc INTO item FROM public.hg_invite_codes WHERE id = code;
  IF item IS NULL OR (item->>'maxUses')::integer <> 2 OR (item->>'usedCount')::integer <> 0 THEN
    RAISE EXCEPTION 'invite quota fields mismatch';
  END IF;
  SELECT count(*) INTO n
  FROM public.hg_audit_logs
  WHERE doc->>'action' = 'invite.create'
    AND doc->>'targetId' = 'invite:' || md5(code);
  IF n <> 1 THEN RAISE EXCEPTION 'invite audit missing'; END IF;
  IF EXISTS (
    SELECT 1 FROM public.hg_audit_logs
    WHERE doc->>'action' = 'invite.create' AND doc::text LIKE '%' || code || '%'
  ) THEN
    RAISE EXCEPTION 'invite code was written to audit data';
  END IF;

  BEGIN
    PERFORM public.hg_create_invite(member_id, '{"maxUses":1,"ttlSeconds":3600}'::jsonb);
    RAISE EXCEPTION 'ordinary member created invite';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'FORBIDDEN' THEN RAISE; END IF;
  END;
END $$;
ROLLBACK;
SELECT 'PASS: moderator roster DTO and atomic bounded invite creation' AS result;
