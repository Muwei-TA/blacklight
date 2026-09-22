-- Run after 20260922160000_postgresql_core.sql and
-- 20260922210000_membership_apply.sql with the service role.
-- The fixtures are isolated by IDs and the outer transaction is rolled back.
BEGIN;
DO $$
DECLARE
  applicant_id text := 'apply-int-applicant';
  second_applicant_id text := 'apply-int-second';
  rules_applicant_id text := 'apply-int-rules';
  expired_applicant_id text := 'apply-int-expired';
  member_id text := 'apply-int-member';
  invite_code text := 'APPLYINTVALID';
  rules_invite_code text := 'APPLYINTRULES';
  expired_invite_code text := 'APPLYINTEXPIRED';
  member_invite_code text := 'APPLYINTMEMBER';
  application_id text;
  result jsonb;
  item jsonb;
BEGIN
  INSERT INTO public.hg_users (id, doc) VALUES
    (applicant_id, jsonb_build_object('_id', applicant_id, 'status', 'active', 'displayName', '原始昵称')),
    (second_applicant_id, jsonb_build_object('_id', second_applicant_id, 'status', 'active', 'displayName', '第二申请人')),
    (rules_applicant_id, jsonb_build_object('_id', rules_applicant_id, 'status', 'active', 'displayName', '规则申请人')),
    (expired_applicant_id, jsonb_build_object('_id', expired_applicant_id, 'status', 'active', 'displayName', '过期申请人')),
    (member_id, jsonb_build_object('_id', member_id, 'status', 'active', 'displayName', '已有成员'));
  INSERT INTO public.hg_memberships (id, doc) VALUES (
    'membership:' || member_id,
    jsonb_build_object('_id', 'membership:' || member_id, 'userId', member_id, 'clubId', 'heiguang', 'status', 'active', 'role', 'member', 'version', 1)
  );

  INSERT INTO public.hg_club_config (id, doc)
  VALUES ('heiguang', jsonb_build_object('_id', 'heiguang', 'rulesVersion', 'v9.0'))
  ON CONFLICT (id) DO UPDATE
    SET doc = public.hg_club_config.doc || jsonb_build_object('rulesVersion', 'v9.0');

  INSERT INTO public.hg_invite_codes (id, doc) VALUES
    (invite_code, jsonb_build_object('_id', invite_code, 'clubId', 'heiguang', 'expiresAt', '2099-01-01T00:00:00.000Z', 'maxUses', 1, 'usedCount', 0, 'revokedAt', null)),
    (rules_invite_code, jsonb_build_object('_id', rules_invite_code, 'clubId', 'heiguang', 'expiresAt', '2099-01-01T00:00:00.000Z', 'maxUses', 1, 'usedCount', 0, 'revokedAt', null)),
    (expired_invite_code, jsonb_build_object('_id', expired_invite_code, 'clubId', 'heiguang', 'expiresAt', '2020-01-01T00:00:00.000Z', 'maxUses', 1, 'usedCount', 0, 'revokedAt', null)),
    (member_invite_code, jsonb_build_object('_id', member_invite_code, 'clubId', 'heiguang', 'expiresAt', '2099-01-01T00:00:00.000Z', 'maxUses', 1, 'usedCount', 0, 'revokedAt', null));

  -- The actor is taken from p_actor_id; a forged payload userId is ignored.
  result := public.hg_apply_membership(
    applicant_id,
    jsonb_build_object('displayName', '申请昵称', 'inviteCode', lower(invite_code), 'rulesVersion', 'v9.0', 'userId', 'forged-user')
  );
  IF result->>'state' <> 'pending' OR result->>'applicationId' IS NULL THEN
    RAISE EXCEPTION 'membership application failed: %', result;
  END IF;
  application_id := result->>'applicationId';
  SELECT doc INTO item FROM public.hg_membership_applications WHERE id = application_id;
  IF item->>'userId' <> applicant_id OR item->>'displayName' <> '申请昵称' OR item->>'version' <> '1' THEN
    RAISE EXCEPTION 'application actor/version binding failed';
  END IF;
  SELECT doc INTO item FROM public.hg_invite_codes WHERE id = invite_code;
  IF (item->>'usedCount')::integer <> 1 THEN RAISE EXCEPTION 'invite use was not consumed atomically'; END IF;

  -- A retry returns the original pending application and never consumes a
  -- second use, even if the retry carries a different/now-invalid code.
  result := public.hg_apply_membership(
    applicant_id,
    jsonb_build_object('displayName', '改名不应覆盖', 'inviteCode', 'NOT-A-REAL-CODE', 'rulesVersion', 'wrong')
  );
  IF result->>'applicationId' IS DISTINCT FROM application_id THEN
    RAISE EXCEPTION 'pending replay returned a different application';
  END IF;
  SELECT doc INTO item FROM public.hg_invite_codes WHERE id = invite_code;
  IF (item->>'usedCount')::integer <> 1 THEN RAISE EXCEPTION 'pending replay consumed invite use'; END IF;

  -- A second user cannot exceed the locked invite quota.
  BEGIN
    PERFORM public.hg_apply_membership(
      second_applicant_id,
      jsonb_build_object('displayName', '第二申请人', 'inviteCode', invite_code, 'rulesVersion', 'v9.0')
    );
    RAISE EXCEPTION 'exhausted invite was accepted';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'INVITE_INVALID' THEN RAISE; END IF;
  END;

  -- The current club rules version is server-side state, not a client claim.
  BEGIN
    PERFORM public.hg_apply_membership(
      rules_applicant_id,
      jsonb_build_object('displayName', '规则申请人', 'inviteCode', rules_invite_code, 'rulesVersion', 'v8.0')
    );
    RAISE EXCEPTION 'stale rules version was accepted';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'RULES_VERSION_INVALID' THEN RAISE; END IF;
  END;
  SELECT doc INTO item FROM public.hg_invite_codes WHERE id = rules_invite_code;
  IF (item->>'usedCount')::integer <> 0 THEN RAISE EXCEPTION 'rules failure consumed invite use'; END IF;

  BEGIN
    PERFORM public.hg_apply_membership(
      expired_applicant_id,
      jsonb_build_object('displayName', '过期申请人', 'inviteCode', expired_invite_code, 'rulesVersion', 'v9.0')
    );
    RAISE EXCEPTION 'expired invite was accepted';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'INVITE_INVALID' THEN RAISE; END IF;
  END;

  BEGIN
    PERFORM public.hg_apply_membership(
      member_id,
      jsonb_build_object('displayName', '已有成员', 'inviteCode', member_invite_code, 'rulesVersion', 'v9.0')
    );
    RAISE EXCEPTION 'active member submitted a new application';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'ALREADY_MEMBER' THEN RAISE; END IF;
  END;
  SELECT doc INTO item FROM public.hg_invite_codes WHERE id = member_invite_code;
  IF (item->>'usedCount')::integer <> 0 THEN RAISE EXCEPTION 'member rejection consumed invite use'; END IF;
END $$;
ROLLBACK;
SELECT 'PASS: locked invite quota, rules version, pending replay, actor binding, and rollback' AS result;
