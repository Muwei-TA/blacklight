-- Run after 20260922160000_postgresql_core.sql and
-- 20260922170000_governance.sql with the service role.
-- Every fixture is rolled back; this file is safe for a dedicated shared test
-- database and does not leave governance records behind.
BEGIN;
DO $$
DECLARE
  actor_id text := 'gov-int-moderator';
  target_id text := 'gov-int-target';
  other_mod_id text := 'gov-int-other-moderator';
  attacker_id text := 'gov-int-attacker';
  owner_id text := 'gov-int-owner';
  post_id text := 'gov-int-hidden-post';
  appeal_id text;
  result jsonb;
  post jsonb;
  task jsonb;
  n integer;
  audit_before integer;
  moderator_before integer;
BEGIN
  SELECT count(*) INTO moderator_before
  FROM public.hg_memberships
  WHERE doc->>'clubId' = 'heiguang'
    AND doc->>'status' = 'active'
    AND doc->>'role' = 'moderator';

  INSERT INTO public.hg_memberships (id, doc) VALUES
    ('membership:' || actor_id, jsonb_build_object(
      '_id', 'membership:' || actor_id, 'userId', actor_id, 'clubId', 'heiguang',
      'status', 'active', 'role', 'moderator', 'version', 1)),
    ('membership:' || target_id, jsonb_build_object(
      '_id', 'membership:' || target_id, 'userId', target_id, 'clubId', 'heiguang',
      'status', 'active', 'role', 'member', 'version', 1));

  -- With one moderator, removing an ordinary member must still work.  The
  -- last-moderator check applies only when the target is a moderator.
  result := public.hg_governance(
    'member.remove', actor_id,
    jsonb_build_object('targetUserId', target_id, 'expectedVersion', 1, 'reason', 'test removal')
  );
  IF result->>'status' <> 'removed' THEN
    RAISE EXCEPTION 'ordinary member removal failed: %', result;
  END IF;
  SELECT count(*) INTO n
  FROM public.hg_audit_logs
  WHERE doc->>'action' = 'member.remove' AND doc->>'targetId' = target_id;
  IF n <> 1 THEN RAISE EXCEPTION 'member mutation audit is not atomic'; END IF;
  SELECT count(*) INTO n
  FROM public.hg_notifications
  WHERE doc->>'recipientId' = target_id AND doc->>'eventType' = 'system_membership';
  IF n <> 1 THEN RAISE EXCEPTION 'member mutation notification is not atomic'; END IF;

  -- Since member actions require an active moderator and self-targeting is
  -- forbidden, the sole moderator can never be removed or downgraded through
  -- a valid actor.  This is the last-moderator guard at its only reachable
  -- boundary for a one-moderator club.
  BEGIN
    PERFORM public.hg_governance(
      'member.role', actor_id,
      jsonb_build_object('targetUserId', actor_id, 'expectedVersion', 1, 'role', 'member', 'reason', 'self demotion')
    );
    RAISE EXCEPTION 'sole moderator self demotion was accepted';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'SELF_TARGET' THEN RAISE; END IF;
  END;

  -- With a second moderator, demoting that target leaves the actor as the
  -- final moderator.  This exercises the target-role branch without allowing
  -- an ordinary member to be blocked by the count check.
  INSERT INTO public.hg_memberships (id, doc) VALUES (
    'membership:' || other_mod_id,
    jsonb_build_object(
      '_id', 'membership:' || other_mod_id, 'userId', other_mod_id, 'clubId', 'heiguang',
      'status', 'active', 'role', 'moderator', 'version', 1
    )
  );
  result := public.hg_governance(
    'member.role', actor_id,
    jsonb_build_object('targetUserId', other_mod_id, 'expectedVersion', 1, 'role', 'member', 'reason', 'keep coverage')
  );
  IF result->>'role' <> 'member' THEN RAISE EXCEPTION 'moderator downgrade failed'; END IF;
  SELECT count(*) INTO n
  FROM public.hg_memberships
  WHERE doc->>'clubId' = 'heiguang' AND doc->>'status' = 'active' AND doc->>'role' = 'moderator';
  IF n <> moderator_before + 1 THEN RAISE EXCEPTION 'moderator count invariant broken'; END IF;

  owner_id := 'gov-int-owner';
  attacker_id := 'gov-int-attacker';
  INSERT INTO public.hg_memberships (id, doc) VALUES
    ('membership:' || owner_id, jsonb_build_object(
      '_id', 'membership:' || owner_id, 'userId', owner_id, 'clubId', 'heiguang',
      'status', 'active', 'role', 'member', 'version', 1)),
    ('membership:' || attacker_id, jsonb_build_object(
      '_id', 'membership:' || attacker_id, 'userId', attacker_id, 'clubId', 'heiguang',
      'status', 'active', 'role', 'member', 'version', 1));
  post := jsonb_build_object(
    '_id', post_id, 'ownerId', owner_id, 'clubId', 'heiguang', 'status', 'hidden',
    'version', 2, 'visibility', 'club', 'body', 'private integration body',
    'assetIds', '[]'::jsonb, 'createdAt', '2026-09-23T00:00:00.000Z'
  );
  INSERT INTO public.hg_posts (id, doc) VALUES (post_id, post);

  -- A forged ownerId must fail before an appeal row or audit row is created.
  SELECT count(*) INTO audit_before FROM public.hg_audit_logs;
  BEGIN
    PERFORM public.hg_governance(
      'appeal.create', attacker_id,
      jsonb_build_object('postId', post_id, 'ownerId', owner_id, 'contentVersion', 2, 'reason', 'forged author')
    );
    RAISE EXCEPTION 'forged appeal author was accepted';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'NOT_OWNER' THEN RAISE; END IF;
  END;
  IF EXISTS (SELECT 1 FROM public.hg_appeals WHERE doc->>'postId' = post_id) THEN
    RAISE EXCEPTION 'forged appeal left a row';
  END IF;
  SELECT count(*) INTO n FROM public.hg_audit_logs;
  IF n <> audit_before THEN RAISE EXCEPTION 'forged appeal left an audit row'; END IF;

  result := public.hg_governance(
    'appeal.create', owner_id,
    jsonb_build_object('postId', post_id, 'ownerId', owner_id, 'contentVersion', 2, 'reason', '请重新审核')
  );
  appeal_id := result->>'appealId';
  IF appeal_id IS NULL OR result->>'state' <> 'submitted' THEN
    RAISE EXCEPTION 'appeal create failed: %', result;
  END IF;

  -- Both read actions return a projection with no private post body/title.
  result := public.hg_governance('appeals.mine', owner_id, '{"limit":20}'::jsonb);
  IF result->'items' @> '[{"body":"private integration body"}]'::jsonb
     OR result->'items' @> '[{"ownerId":"gov-int-owner"}]'::jsonb THEN
    RAISE EXCEPTION 'appeals.mine leaked private fields';
  END IF;
  result := public.hg_governance('admin.appeals.list', actor_id, '{"limit":20}'::jsonb);
  IF result->'items' @> '[{"body":"private integration body"}]'::jsonb
     OR result->'items' @> '[{"ownerId":"gov-int-owner"}]'::jsonb THEN
    RAISE EXCEPTION 'admin appeal list leaked private fields';
  END IF;

  SELECT count(*) INTO audit_before FROM public.hg_audit_logs;
  result := public.hg_governance(
    'appeal.decide', actor_id,
    jsonb_build_object('appealId', appeal_id, 'expectedVersion', 1, 'decision', 'approve', 'reason', '同意再次审核')
  );
  IF result->>'postStatus' <> 'pending' THEN
    RAISE EXCEPTION 'appeal approval published content: %', result;
  END IF;
  SELECT doc INTO post FROM public.hg_posts WHERE id = post_id;
  IF post->>'status' <> 'pending' OR (post->>'version')::integer <> 3 THEN
    RAISE EXCEPTION 'appeal approval did not create a new pending post version';
  END IF;
  SELECT doc INTO task
  FROM public.hg_review_tasks
  WHERE doc->>'targetId' = post_id AND (doc->>'postVersion')::integer = 3;
  IF task IS NULL OR task->>'status' <> 'queued' THEN
    RAISE EXCEPTION 'appeal approval did not enqueue a review task';
  END IF;
  SELECT count(*) INTO n FROM public.hg_audit_logs;
  IF n <> audit_before + 1 THEN RAISE EXCEPTION 'appeal decision audit missing'; END IF;
  SELECT count(*) INTO n
  FROM public.hg_notifications
  WHERE doc->>'recipientId' = owner_id AND doc->>'eventType' = 'system_review';
  IF n <> 1 THEN RAISE EXCEPTION 'appeal decision notification missing'; END IF;
END $$;
ROLLBACK;
SELECT 'PASS: governance locks, moderator invariant, forged authors, pending re-review, DTO privacy, and atomic audit/notification' AS result;
