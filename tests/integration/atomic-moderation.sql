-- Run after 20260922160000_postgresql_core.sql and
-- 20260922200000_atomic_moderation.sql with the service role.
-- Fixtures use unique prefixes and the outer transaction is rolled back.
BEGIN;
DO $$
DECLARE
  actor_id text := 'atomic-int-moderator';
  author_id text := 'atomic-int-author';
  applicant_id text := 'atomic-int-applicant';
  post_id text := 'atomic-int-pending-post';
  private_post_id text := 'atomic-int-private-post';
  report_post_id text := 'atomic-int-report-post';
  comment_id text := 'atomic-int-comment';
  application_id text := 'application:atomic-int';
  topic_id text := 'topic:atomic-int';
  report_id text := 'report:atomic-int';
  collection_id text := 'collection:atomic-int';
  collection_post_id text := 'atomic-int-collection-post';
  task_id text := 'task:atomic-int';
  disabled_task_id text := 'task:atomic-int-disabled';
  result jsonb;
  repeat_result jsonb;
  item jsonb;
  n integer;
BEGIN
  INSERT INTO public.hg_memberships (id, doc) VALUES
    ('membership:' || actor_id, jsonb_build_object('_id', 'membership:' || actor_id, 'userId', actor_id, 'clubId', 'heiguang', 'status', 'active', 'role', 'moderator', 'version', 1)),
    ('membership:' || author_id, jsonb_build_object('_id', 'membership:' || author_id, 'userId', author_id, 'clubId', 'heiguang', 'status', 'active', 'role', 'member', 'version', 1));

  INSERT INTO public.hg_posts (id, doc) VALUES
    (post_id, jsonb_build_object('_id', post_id, 'ownerId', author_id, 'clubId', 'heiguang', 'topicId', topic_id, 'visibility', 'public', 'status', 'pending', 'version', 1, 'commentCount', 0, 'body', 'atomic moderation post', 'assetIds', '[]'::jsonb, 'createdAt', '2026-09-23T00:00:00.000Z')),
    (private_post_id, jsonb_build_object('_id', private_post_id, 'ownerId', author_id, 'clubId', 'heiguang', 'visibility', 'private', 'status', 'pending', 'version', 1, 'body', 'private post', 'assetIds', '[]'::jsonb, 'createdAt', '2026-09-23T00:00:00.000Z')),
    (report_post_id, jsonb_build_object('_id', report_post_id, 'ownerId', author_id, 'clubId', 'heiguang', 'visibility', 'public', 'status', 'published', 'version', 1, 'body', 'reported post', 'assetIds', '[]'::jsonb, 'createdAt', '2026-09-23T00:00:00.000Z')),
    (collection_post_id, jsonb_build_object('_id', collection_post_id, 'ownerId', author_id, 'clubId', 'heiguang', 'visibility', 'public', 'status', 'published', 'version', 1, 'body', 'collection post', 'assetIds', '[]'::jsonb, 'createdAt', '2026-09-23T00:00:00.000Z'));
  INSERT INTO public.hg_comments (id, doc) VALUES (
    comment_id,
    jsonb_build_object('_id', comment_id, 'postId', post_id, 'ownerId', author_id, 'body', 'pending comment', 'status', 'pending', 'version', 1, 'identityMode', 'named', 'createdAt', '2026-09-23T00:00:00.000Z')
  );
  INSERT INTO public.hg_membership_applications (id, doc) VALUES (
    application_id,
    jsonb_build_object('_id', application_id, 'userId', applicant_id, 'clubId', 'heiguang', 'displayName', '申请人', 'rulesVersion', 'v1.1', 'status', 'pending', 'createdAt', '2026-09-23T00:00:00.000Z')
  );
  INSERT INTO public.hg_topics (id, doc) VALUES (
    topic_id,
    jsonb_build_object('_id', topic_id, 'ownerId', author_id, 'clubId', 'heiguang', 'title', '原子话题', 'status', 'pending', 'version', 1, 'postCount', 0, 'createdAt', '2026-09-23T00:00:00.000Z')
  );
  INSERT INTO public.hg_reports (id, doc) VALUES (
    report_id,
    jsonb_build_object('_id', report_id, 'targetType', 'post', 'targetId', report_post_id, 'reporterId', 'atomic-int-reporter', 'reason', '核查', 'status', 'received', 'createdAt', '2026-09-23T00:00:00.000Z')
  );
  INSERT INTO public.hg_collections (id, doc) VALUES (
    collection_id,
    jsonb_build_object('_id', collection_id, 'clubId', 'heiguang', 'visibility', 'public', 'entryCount', 0, 'createdAt', '2026-09-23T00:00:00.000Z')
  );
  INSERT INTO public.hg_consents (id, doc) VALUES (
    collection_post_id || ':collection:' || collection_id,
    jsonb_build_object('_id', collection_post_id || ':collection:' || collection_id, 'postId', collection_post_id, 'collectionId', collection_id, 'ownerId', author_id, 'purpose', 'collection_display', 'revokedAt', null, 'createdAt', '2026-09-23T00:00:00.000Z')
  );
  INSERT INTO public.hg_review_tasks (id, doc) VALUES
    (task_id, jsonb_build_object('_id', task_id, 'targetType', 'collection_submission', 'targetId', collection_post_id, 'collectionId', collection_id, 'status', 'queued', 'version', 1, 'createdAt', '2026-09-23T00:00:00.000Z')),
    (disabled_task_id, jsonb_build_object('_id', disabled_task_id, 'targetType', 'collection_submission', 'targetId', collection_post_id, 'collectionId', collection_id, 'status', 'queued', 'version', 1, 'createdAt', '2026-09-23T00:00:00.000Z')),
    ('review:' || post_id, jsonb_build_object('_id', 'review:' || post_id, 'targetType', 'post', 'targetId', post_id, 'postVersion', 1, 'status', 'manual', 'version', 1, 'createdAt', '2026-09-23T00:00:00.000Z')),
    ('comment-review:' || comment_id, jsonb_build_object('_id', 'comment-review:' || comment_id, 'targetType', 'comment', 'targetId', comment_id, 'postVersion', 1, 'status', 'manual', 'version', 1, 'createdAt', '2026-09-23T00:00:00.000Z'));

  -- Keep the fixture self-contained while restoring the real row on ROLLBACK.
  INSERT INTO public.hg_club_config (id, doc)
  VALUES ('heiguang', jsonb_build_object('_id', 'heiguang', 'capabilities', jsonb_build_object('anthology', true)))
  ON CONFLICT (id) DO UPDATE SET doc = public.hg_club_config.doc || jsonb_build_object('capabilities', COALESCE(public.hg_club_config.doc->'capabilities', '{}'::jsonb) || jsonb_build_object('anthology', true));

  result := public.hg_moderate('content.decide', actor_id, jsonb_build_object('id', post_id, 'decision', 'approve', 'reason', '', 'expectedVersion', 1));
  IF result->>'status' <> 'published' OR (result->>'version')::integer <> 2 THEN RAISE EXCEPTION 'content decision failed'; END IF;
  repeat_result := public.hg_moderate('content.decide', actor_id, jsonb_build_object('id', post_id, 'decision', 'approve', 'reason', '', 'expectedVersion', 1));
  IF repeat_result IS DISTINCT FROM result THEN RAISE EXCEPTION 'same content decision was not idempotent'; END IF;
  SELECT count(*) INTO n FROM public.hg_audit_logs
  WHERE doc->>'action' = 'content.approve' AND doc->>'targetId' = post_id;
  IF n <> 1 THEN RAISE EXCEPTION 'content audit was duplicated or missing'; END IF;
  SELECT count(*) INTO n FROM public.hg_notifications
  WHERE doc->>'eventType' = 'system_review' AND doc->>'targetId' = post_id;
  IF n <> 1 THEN RAISE EXCEPTION 'content notification was duplicated or missing'; END IF;
  SELECT (doc->>'postCount')::integer INTO n FROM public.hg_topics WHERE id = topic_id;
  IF COALESCE(n, 0) <> 1 THEN RAISE EXCEPTION 'topic postCount was not atomic'; END IF;
  BEGIN
    PERFORM public.hg_moderate('content.decide', actor_id, jsonb_build_object('id', post_id, 'decision', 'reject', 'reason', 'different', 'expectedVersion', 1));
    RAISE EXCEPTION 'different content decision was accepted';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'VERSION_CONFLICT' THEN RAISE; END IF;
  END;

  BEGIN
    PERFORM public.hg_moderate('content.decide', actor_id, jsonb_build_object('id', private_post_id, 'decision', 'hide', 'reason', 'private', 'expectedVersion', 1));
    RAISE EXCEPTION 'private content entered moderation';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'PRIVATE_CONTENT' THEN RAISE; END IF;
  END;

  result := public.hg_moderate('comment.decide', actor_id, jsonb_build_object('id', comment_id, 'decision', 'approve', 'reason', '', 'expectedVersion', 1));
  IF result->>'status' <> 'published' THEN RAISE EXCEPTION 'comment decision failed'; END IF;
  SELECT (doc->>'commentCount')::integer INTO n FROM public.hg_posts WHERE id = post_id;
  IF COALESCE(n, 0) <> 1 THEN RAISE EXCEPTION 'commentCount was not atomic'; END IF;
  SELECT count(*) INTO n FROM public.hg_audit_logs
  WHERE doc->>'action' = 'comment.approve' AND doc->>'targetId' = comment_id;
  IF n <> 1 THEN RAISE EXCEPTION 'comment audit missing'; END IF;
  SELECT count(*) INTO n FROM public.hg_notifications
  WHERE doc->>'eventType' = 'system_review' AND doc->>'targetId' = post_id AND doc->>'recipientId' = author_id;
  IF n <> 2 THEN RAISE EXCEPTION 'comment notification missing'; END IF;

  result := public.hg_moderate('membership.decide', actor_id, jsonb_build_object('id', application_id, 'decision', 'approve', 'reason', '', 'expectedVersion', 1));
  IF result->>'status' <> 'active' THEN RAISE EXCEPTION 'membership decision failed'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.hg_memberships WHERE doc->>'userId' = applicant_id AND doc->>'status' = 'active') THEN
    RAISE EXCEPTION 'membership mutation was not atomic';
  END IF;
  SELECT count(*) INTO n FROM public.hg_audit_logs
  WHERE doc->>'action' = 'membership.approve' AND doc->>'targetId' = application_id;
  IF n <> 1 THEN RAISE EXCEPTION 'membership audit missing'; END IF;
  SELECT count(*) INTO n FROM public.hg_notifications
  WHERE doc->>'eventType' = 'system_membership' AND doc->>'recipientId' = applicant_id;
  IF n <> 1 THEN RAISE EXCEPTION 'membership notification missing'; END IF;

  result := public.hg_moderate('topic.decide', actor_id, jsonb_build_object('id', topic_id, 'decision', 'approve', 'reason', '', 'expectedVersion', 1));
  IF result->>'status' <> 'active' THEN RAISE EXCEPTION 'topic decision failed'; END IF;
  SELECT count(*) INTO n FROM public.hg_audit_logs
  WHERE doc->>'action' = 'topic.approve' AND doc->>'targetId' = topic_id;
  IF n <> 1 THEN RAISE EXCEPTION 'topic audit missing'; END IF;

  result := public.hg_moderate('report.decide', actor_id, jsonb_build_object('id', report_id, 'decision', 'hide', 'reason', '暂时隐藏核查', 'expectedVersion', 1));
  IF result->>'status' <> 'closed' THEN RAISE EXCEPTION 'report decision failed'; END IF;
  SELECT doc INTO item FROM public.hg_posts WHERE id = report_post_id;
  IF item->>'status' <> 'hidden' OR (item->>'version')::integer <> 2 THEN RAISE EXCEPTION 'report target was not hidden atomically'; END IF;
  SELECT count(*) INTO n FROM public.hg_audit_logs
  WHERE doc->>'action' = 'report.hide' AND doc->>'targetId' = report_post_id;
  IF n <> 1 THEN RAISE EXCEPTION 'report audit missing'; END IF;
  SELECT count(*) INTO n FROM public.hg_notifications
  WHERE doc->>'eventType' = 'system_report' AND doc->>'targetId' = report_post_id;
  IF n <> 1 THEN RAISE EXCEPTION 'report notification missing'; END IF;

  result := public.hg_moderate('collection.decide', actor_id, jsonb_build_object('id', task_id, 'decision', 'include', 'reason', '', 'expectedVersion', 1));
  IF result->>'status' <> 'passed' THEN RAISE EXCEPTION 'collection decision failed'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.hg_collection_entries WHERE id = 'entry:' || collection_post_id || ':' || collection_id) THEN
    RAISE EXCEPTION 'collection entry missing';
  END IF;
  SELECT (doc->>'entryCount')::integer INTO n FROM public.hg_collections WHERE id = collection_id;
  IF COALESCE(n, 0) <> 1 THEN RAISE EXCEPTION 'collection entryCount was not atomic'; END IF;
  SELECT count(*) INTO n FROM public.hg_audit_logs
  WHERE doc->>'action' = 'collection.include' AND doc->>'targetId' = collection_post_id;
  IF n <> 1 THEN RAISE EXCEPTION 'collection audit missing'; END IF;

  UPDATE public.hg_club_config SET doc = doc || jsonb_build_object('capabilities', jsonb_build_object('anthology', false)) WHERE id = 'heiguang';
  BEGIN
    PERFORM public.hg_moderate('collection.decide', actor_id, jsonb_build_object('id', disabled_task_id, 'decision', 'include', 'reason', '', 'expectedVersion', 1));
    RAISE EXCEPTION 'anthology capability bypassed';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'CAPABILITY_DISABLED' THEN RAISE; END IF;
  END;
END $$;
ROLLBACK;
SELECT 'PASS: atomic moderation CAS/idempotency, private rejection, actor checks, notifications, counters and capability gate' AS result;
