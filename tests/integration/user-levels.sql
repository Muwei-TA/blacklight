-- Run after all migrations on the isolated blacklight_test database.
-- Fixtures are scoped to this transaction and rolled back at the end.
BEGIN;
SET LOCAL ROLE service_role;
DO $$
DECLARE
  actor_id text := 'user-levels-int-actor';
  other_id text := 'user-levels-int-other';
  blocked_id text := 'user-levels-int-removed';
  auto_author_id text := 'user-levels-int-auto-author';
  manual_author_id text := 'user-levels-int-manual-author';
  self_post_id text := 'user-levels-int-self-post';
  preexisting_comment_id text := 'user-levels-int-preexisting-comment';
  reaction_comment_id text := 'user-levels-int-reaction-comment';
  post_id text;
  comment_id text;
  answer jsonb;
  snapshot jsonb;
  total integer;
  positive_reaction_count integer;
  reversal_count integer;
  thresholds integer[] := ARRAY[0, 40, 120, 280, 520, 860, 1320, 2000];
  i integer;
BEGIN
  IF NOT has_table_privilege('anon', 'public.hg_user_xp_events', 'SELECT') = false
     OR NOT has_table_privilege('authenticated', 'public.hg_user_xp_events', 'SELECT') = false THEN
    RAISE EXCEPTION 'XP ledger must remain private to service_role';
  END IF;

  INSERT INTO public.hg_users (id, doc) VALUES
    (actor_id, jsonb_build_object('_id', actor_id, 'status', 'active')),
    (other_id, jsonb_build_object('_id', other_id, 'status', 'active')),
    (blocked_id, jsonb_build_object('_id', blocked_id, 'status', 'active')),
    (auto_author_id, jsonb_build_object('_id', auto_author_id, 'status', 'active')),
    (manual_author_id, jsonb_build_object('_id', manual_author_id, 'status', 'active'));

  INSERT INTO public.hg_memberships (id, doc) VALUES
    (actor_id || ':heiguang', jsonb_build_object('_id', actor_id || ':heiguang', 'userId', actor_id, 'clubId', 'heiguang', 'role', 'member', 'status', 'active')),
    (other_id || ':heiguang', jsonb_build_object('_id', other_id || ':heiguang', 'userId', other_id, 'clubId', 'heiguang', 'role', 'member', 'status', 'active')),
    (blocked_id || ':heiguang', jsonb_build_object('_id', blocked_id || ':heiguang', 'userId', blocked_id, 'clubId', 'heiguang', 'role', 'member', 'status', 'removed')),
    (auto_author_id || ':heiguang', jsonb_build_object('_id', auto_author_id || ':heiguang', 'userId', auto_author_id, 'clubId', 'heiguang', 'role', 'member', 'status', 'active')),
    (manual_author_id || ':heiguang', jsonb_build_object('_id', manual_author_id || ':heiguang', 'userId', manual_author_id, 'clubId', 'heiguang', 'role', 'member', 'status', 'active'));

  INSERT INTO public.hg_posts (id, doc) VALUES
    (self_post_id, jsonb_build_object('_id', self_post_id, 'ownerId', actor_id, 'clubId', 'heiguang', 'visibility', 'club', 'status', 'published', 'reactionCount', 0, 'commentCount', 0)),
    ('user-levels-int-post-1', jsonb_build_object('_id', 'user-levels-int-post-1', 'ownerId', other_id, 'clubId', 'heiguang', 'visibility', 'club', 'status', 'published', 'reactionCount', 0, 'commentCount', 0)),
    ('user-levels-int-post-2', jsonb_build_object('_id', 'user-levels-int-post-2', 'ownerId', other_id, 'clubId', 'heiguang', 'visibility', 'club', 'status', 'published', 'reactionCount', 0, 'commentCount', 0)),
    ('user-levels-int-post-3', jsonb_build_object('_id', 'user-levels-int-post-3', 'ownerId', other_id, 'clubId', 'heiguang', 'visibility', 'club', 'status', 'published', 'reactionCount', 0, 'commentCount', 0)),
    ('user-levels-int-post-4', jsonb_build_object('_id', 'user-levels-int-post-4', 'ownerId', other_id, 'clubId', 'heiguang', 'visibility', 'club', 'status', 'published', 'reactionCount', 0, 'commentCount', 0)),
    ('user-levels-int-post-5', jsonb_build_object('_id', 'user-levels-int-post-5', 'ownerId', other_id, 'clubId', 'heiguang', 'visibility', 'club', 'status', 'published', 'reactionCount', 0, 'commentCount', 0));

  -- Existing published records and non-status edits are not retroactively rewarded.
  INSERT INTO public.hg_comments (id, doc) VALUES
    (preexisting_comment_id, jsonb_build_object('_id', preexisting_comment_id, 'clubId', 'heiguang', 'postId', 'user-levels-int-post-1', 'ownerId', actor_id, 'status', 'published', 'identityMode', 'anonymous')),
    (reaction_comment_id, jsonb_build_object('_id', reaction_comment_id, 'clubId', 'heiguang', 'postId', 'user-levels-int-post-1', 'ownerId', other_id, 'status', 'published', 'identityMode', 'anonymous'));
  UPDATE public.hg_comments SET doc = doc || jsonb_build_object('reactionCount', 0)
  WHERE id = preexisting_comment_id;
  IF EXISTS (SELECT 1 FROM public.hg_user_xp_events WHERE user_id = actor_id) THEN
    RAISE EXCEPTION 'published comment update created a retroactive reward';
  END IF;

  answer := public.hg_user_levels_check_in(actor_id);
  IF answer->>'awardedXp' <> '5' OR answer->>'totalXp' <> '5'
     OR answer->'today'->>'checkedIn' <> 'true' OR answer->'today'->>'earnedXp' <> '5'
     OR answer->>'title' <> '微光' THEN
    RAISE EXCEPTION 'first check-in did not return the updated snapshot: %', answer;
  END IF;
  IF (SELECT business_date FROM public.hg_user_xp_events WHERE user_id = actor_id AND event_type = 'check_in')
     <> (transaction_timestamp() AT TIME ZONE 'Asia/Shanghai')::date THEN
    RAISE EXCEPTION 'check-in business date did not use server Asia/Shanghai time';
  END IF;
  IF (SELECT rule_version FROM public.hg_user_xp_events WHERE user_id = actor_id AND event_type = 'check_in') <> 1 THEN
    RAISE EXCEPTION 'initial XP event did not retain its rules version';
  END IF;
  answer := public.hg_user_levels_check_in(actor_id);
  IF answer->>'awardedXp' <> '0' OR answer->>'totalXp' <> '5' THEN
    RAISE EXCEPTION 'repeat check-in was not idempotent: %', answer;
  END IF;
  IF (('2026-09-26 15:59:59+00'::timestamptz AT TIME ZONE 'Asia/Shanghai')::date <> DATE '2026-09-26'
      OR ('2026-09-26 16:00:00+00'::timestamptz AT TIME ZONE 'Asia/Shanghai')::date <> DATE '2026-09-27') THEN
    RAISE EXCEPTION 'Asia/Shanghai midnight boundary calculation failed';
  END IF;

  -- A second comment on post 1 is not rewarded; among later distinct posts,
  -- only the first three fit the daily comment cap.
  FOR i IN 1..6 LOOP
    post_id := 'user-levels-int-post-' || CASE WHEN i <= 2 THEN 1 ELSE i - 1 END;
    comment_id := 'user-levels-int-comment-' || i;
    INSERT INTO public.hg_comments (id, doc)
    VALUES (comment_id, jsonb_build_object('_id', comment_id, 'clubId', 'heiguang', 'postId', post_id, 'ownerId', actor_id, 'status', 'pending', 'identityMode', 'anonymous'));
    UPDATE public.hg_comments
    SET doc = doc || jsonb_build_object('status', 'published')
    WHERE id = comment_id;
  END LOOP;
  SELECT count(*)::integer INTO total FROM public.hg_user_xp_events
  WHERE user_id = actor_id AND event_type = 'comment_approved' AND xp > 0;
  IF total <> 3 THEN RAISE EXCEPTION 'comment daily distinct-post cap failed: %', total; END IF;
  IF (SELECT count(*) FROM public.hg_user_xp_events
      WHERE user_id = actor_id AND event_type = 'comment_approved'
        AND source_post_id = 'user-levels-int-post-1' AND xp > 0) <> 1 THEN
    RAISE EXCEPTION 'same-post second comment was incorrectly rewarded';
  END IF;
  UPDATE public.hg_comments SET doc = doc || jsonb_build_object('status', 'hidden')
  WHERE id = 'user-levels-int-comment-1';
  UPDATE public.hg_comments SET doc = doc || jsonb_build_object('status', 'rejected')
  WHERE id = 'user-levels-int-comment-1';
  SELECT count(*)::integer INTO reversal_count FROM public.hg_user_xp_events
  WHERE user_id = actor_id AND event_type = 'comment_revoked';
  IF reversal_count <> 1 THEN RAISE EXCEPTION 'comment revocation was not idempotent: %', reversal_count; END IF;

  -- Four post targets plus one distinct published comment target earn XP.
  -- Cancel/re-add of the same relation does not pay twice, and self-reaction
  -- neither earns XP nor consumes the daily target quota.
  FOR i IN 1..4 LOOP
    post_id := 'user-levels-int-post-' || i;
    PERFORM public.hg_toggle_reaction(actor_id, post_id, NULL, true);
    IF i = 1 THEN
      PERFORM public.hg_toggle_reaction(actor_id, post_id, NULL, false);
      PERFORM public.hg_toggle_reaction(actor_id, post_id, NULL, true);
    END IF;
  END LOOP;
  PERFORM public.hg_toggle_reaction(actor_id, 'user-levels-int-post-1', reaction_comment_id, true);
  PERFORM public.hg_toggle_reaction(actor_id, 'user-levels-int-post-5', NULL, true);
  PERFORM public.hg_toggle_reaction(actor_id, self_post_id, NULL, true);

  SELECT count(*)::integer INTO positive_reaction_count FROM public.hg_user_xp_events
  WHERE user_id = actor_id AND event_type = 'reaction' AND xp > 0;
  IF positive_reaction_count <> 5 THEN RAISE EXCEPTION 'reaction cap or distinct target rule failed: %', positive_reaction_count; END IF;

  snapshot := public.hg_user_levels_snapshot(actor_id);
  IF snapshot->>'totalXp' <> '16' OR snapshot->'today'->>'earnedXp' <> '19'
     OR snapshot->'today'->>'reactions' <> '5' OR snapshot->'today'->>'comments' <> '3'
     OR snapshot->'today'->>'checkedIn' <> 'true' THEN
    RAISE EXCEPTION 'private snapshot totals/counters were incorrect: %', snapshot;
  END IF;

  -- Every exact threshold advances to the matching level. L8 stops progress
  -- while continuing to report XP accumulated above its threshold.
  FOR i IN 1..array_length(thresholds, 1) LOOP
    UPDATE public.hg_user_xp_accounts SET total_xp = thresholds[i] WHERE user_id = actor_id;
    snapshot := public.hg_user_levels_snapshot(actor_id);
    IF (snapshot->>'level')::integer <> i OR (snapshot->>'currentLevelXp')::integer <> thresholds[i] THEN
      RAISE EXCEPTION 'level threshold % mapped incorrectly: %', thresholds[i], snapshot;
    END IF;
  END LOOP;
  IF snapshot->>'title' <> '长明' OR snapshot->'nextLevelXp' IS DISTINCT FROM 'null'::jsonb
     OR snapshot->>'progressTargetXp' <> '0' OR snapshot->>'progressXp' <> '0' THEN
    RAISE EXCEPTION 'maximum level progress contract is incorrect: %', snapshot;
  END IF;
  UPDATE public.hg_user_xp_accounts SET total_xp = 2050 WHERE user_id = actor_id;
  snapshot := public.hg_user_levels_snapshot(actor_id);
  IF snapshot->>'progressXp' <> '50' OR snapshot->>'progressTargetXp' <> '0' THEN
    RAISE EXCEPTION 'maximum level excess XP was not reported: %', snapshot;
  END IF;
  UPDATE public.hg_user_xp_accounts SET total_xp = 16 WHERE user_id = actor_id;

  -- The automatic review RPC and the current human moderation RPC both reach
  -- the same published-state trigger and receive XP in their own transaction.
  UPDATE public.hg_memberships
  SET doc = doc || jsonb_build_object('role', 'moderator')
  WHERE id = other_id || ':heiguang';
  INSERT INTO public.hg_posts (id, doc) VALUES
    ('user-levels-int-auto-post', jsonb_build_object('_id', 'user-levels-int-auto-post', 'ownerId', other_id, 'clubId', 'heiguang', 'visibility', 'club', 'status', 'published', 'commentCount', 0)),
    ('user-levels-int-manual-post', jsonb_build_object('_id', 'user-levels-int-manual-post', 'ownerId', other_id, 'clubId', 'heiguang', 'visibility', 'club', 'status', 'published', 'commentCount', 0));
  INSERT INTO public.hg_comments (id, doc) VALUES
    ('user-levels-int-auto-comment', jsonb_build_object('_id', 'user-levels-int-auto-comment', 'clubId', 'heiguang', 'postId', 'user-levels-int-auto-post', 'ownerId', auto_author_id, 'status', 'pending', 'version', 1)),
    ('user-levels-int-manual-comment', jsonb_build_object('_id', 'user-levels-int-manual-comment', 'clubId', 'heiguang', 'postId', 'user-levels-int-manual-post', 'ownerId', manual_author_id, 'status', 'pending', 'version', 1));
  INSERT INTO public.hg_review_tasks (id, doc) VALUES (
    'user-levels-int-auto-review', jsonb_build_object(
      '_id', 'user-levels-int-auto-review', 'clubId', 'heiguang', 'targetType', 'comment',
      'targetId', 'user-levels-int-auto-comment', 'postVersion', 1,
      'status', 'running', 'attempts', 0, 'leaseId', 'user-levels-int-lease',
      'leaseExpiresAt', (transaction_timestamp() + interval '5 minutes')::text,
      'createdAt', transaction_timestamp()::text
    )
  );
  answer := public.hg_finish_review('user-levels-int-auto-review', 'user-levels-int-lease', 1, 'approve', '', 'heiguang');
  IF answer->>'targetStatus' <> 'published'
     OR (SELECT total_xp FROM public.hg_user_xp_accounts WHERE user_id = auto_author_id) <> 3 THEN
    RAISE EXCEPTION 'automatic review approval did not award XP atomically: %', answer;
  END IF;

  IF to_regprocedure('public.hg_moderate_legacy(text,text,jsonb)') IS NOT NULL THEN
    INSERT INTO public.hg_review_tasks (id, doc) VALUES (
      'user-levels-int-manual-review', jsonb_build_object(
        '_id', 'user-levels-int-manual-review', 'clubId', 'heiguang', 'targetType', 'comment',
        'targetId', 'user-levels-int-manual-comment', 'postVersion', '1',
        'status', 'manual', 'attempts', 0, 'createdAt', transaction_timestamp()::text
      )
    );
  END IF;

  answer := public.hg_moderate('comment.decide', other_id, jsonb_build_object(
    'id', 'user-levels-int-manual-comment', 'decision', 'approve', 'expectedVersion', 1, 'reason', ''
  ));
  IF answer->>'status' <> 'published'
     OR (SELECT total_xp FROM public.hg_user_xp_accounts WHERE user_id = manual_author_id) <> 3 THEN
    RAISE EXCEPTION 'manual review approval did not award XP atomically: %', answer;
  END IF;
  IF to_regprocedure('public.hg_moderate_legacy(text,text,jsonb)') IS NOT NULL
     AND (SELECT doc->>'status' FROM public.hg_review_tasks WHERE id = 'user-levels-int-manual-review') <> 'passed' THEN
    RAISE EXCEPTION 'unified manual-review wrapper did not close its task';
  END IF;

  -- Removed members cannot earn XP through a status transition.
  INSERT INTO public.hg_comments (id, doc)
  VALUES ('user-levels-int-removed-comment', jsonb_build_object('_id', 'user-levels-int-removed-comment', 'clubId', 'heiguang', 'postId', 'user-levels-int-post-1', 'ownerId', blocked_id, 'status', 'pending'));
  UPDATE public.hg_comments SET doc = doc || jsonb_build_object('status', 'published')
  WHERE id = 'user-levels-int-removed-comment';
  IF EXISTS (SELECT 1 FROM public.hg_user_xp_events WHERE user_id = blocked_id) THEN
    RAISE EXCEPTION 'removed member received XP';
  END IF;

  -- Terminal account deletion erases both aggregate and anonymous-linked events.
  UPDATE public.hg_users SET doc = doc || jsonb_build_object('status', 'deleted') WHERE id = actor_id;
  IF EXISTS (SELECT 1 FROM public.hg_user_xp_events WHERE user_id = actor_id)
     OR EXISTS (SELECT 1 FROM public.hg_user_xp_accounts WHERE user_id = actor_id) THEN
    RAISE EXCEPTION 'account deletion did not clear private XP data';
  END IF;
END $$;
ROLLBACK;
