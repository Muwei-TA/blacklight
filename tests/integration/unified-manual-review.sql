-- Run after 20260927150000_unified_manual_review.sql. All fixtures roll back.
BEGIN;
DO $$
DECLARE
  actor_id text := 'manual-int-moderator';
  post_id text := 'manual-int-article';
  comment_id text := 'manual-int-comment';
  parent_id text := 'manual-int-parent';
  appeal_a text := 'manual-int-appeal-a';
  appeal_b text := 'manual-int-appeal-b';
  rows jsonb;
  result jsonb;
  cursor jsonb;
  task_status text;
BEGIN
  INSERT INTO public.hg_memberships (id, doc) VALUES
    ('membership:' || actor_id, jsonb_build_object('_id', 'membership:' || actor_id,
      'userId', actor_id, 'clubId', 'heiguang', 'status', 'active', 'role', 'moderator'));
  INSERT INTO public.hg_posts (id, doc) VALUES
    (post_id, jsonb_build_object('_id', post_id, 'clubId', 'heiguang',
      'ownerId', 'manual-int-author', 'kind', 'article', 'visibility', 'club',
      'status', 'pending', 'version', 1, 'title', '长文', 'body', '正文',
      'assetIds', '[]'::jsonb, 'createdAt', '2026-09-27T01:00:00.000Z')),
    (parent_id, jsonb_build_object('_id', parent_id, 'clubId', 'heiguang',
      'ownerId', 'manual-int-author', 'kind', 'fragment', 'visibility', 'club',
      'status', 'published', 'version', 1, 'commentCount', 0,
      'assetIds', '[]'::jsonb, 'createdAt', '2026-09-27T01:00:00.000Z'));
  INSERT INTO public.hg_comments (id, doc) VALUES
    (comment_id, jsonb_build_object('_id', comment_id, 'postId', parent_id,
      'ownerId', 'manual-int-commenter', 'body', '回应', 'status', 'pending',
      'version', 1, 'createdAt', '2026-09-27T01:01:00.000Z'));
  INSERT INTO public.hg_review_tasks (id, doc) VALUES
    ('manual-int-post-task', jsonb_build_object('_id', 'manual-int-post-task',
      'targetType', 'post', 'targetId', post_id, 'postVersion', 1,
      'status', 'queued', 'createdAt', '2026-09-27T01:00:00.000Z')),
    ('manual-int-comment-task', jsonb_build_object('_id', 'manual-int-comment-task',
      'targetType', 'comment', 'targetId', comment_id, 'postVersion', 1,
      'status', 'queued', 'createdAt', '2026-09-27T01:01:00.000Z'));

  rows := public.hg_comment_queue(actor_id, NULL, 20);
  IF jsonb_array_length(rows) <> 0 THEN RAISE EXCEPTION 'queued comment leaked into human queue'; END IF;
  BEGIN
    PERFORM public.hg_moderate('content.decide', actor_id,
      jsonb_build_object('id', post_id, 'decision', 'approve', 'expectedVersion', 1));
    RAISE EXCEPTION 'unchecked article published';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'REVIEW_NOT_READY' THEN RAISE; END IF;
  END;
  BEGIN
    PERFORM public.hg_moderate('comment.decide', actor_id,
      jsonb_build_object('id', comment_id, 'decision', 'approve', 'expectedVersion', 1));
    RAISE EXCEPTION 'unchecked comment published';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'REVIEW_NOT_READY' THEN RAISE; END IF;
  END;

  UPDATE public.hg_review_tasks SET doc = doc || '{"status":"manual"}'
  WHERE id IN ('manual-int-post-task', 'manual-int-comment-task');
  rows := public.hg_comment_queue(actor_id, NULL, 20);
  IF jsonb_array_length(rows) <> 1 OR rows->0->>'_id' <> comment_id THEN
    RAISE EXCEPTION 'manual comment absent from queue';
  END IF;
  result := public.hg_moderate('content.decide', actor_id,
    jsonb_build_object('id', post_id, 'decision', 'approve', 'expectedVersion', 1));
  IF result->>'status' <> 'published' THEN RAISE EXCEPTION 'article decision failed'; END IF;
  SELECT doc->>'status' INTO task_status FROM public.hg_review_tasks WHERE id = 'manual-int-post-task';
  IF task_status <> 'passed' THEN RAISE EXCEPTION 'article task remained manual'; END IF;
  IF public.hg_moderate('content.decide', actor_id,
    jsonb_build_object('id', post_id, 'decision', 'approve', 'expectedVersion', 1)) IS DISTINCT FROM result THEN
    RAISE EXCEPTION 'repeated article decision lost idempotency';
  END IF;
  result := public.hg_moderate('comment.decide', actor_id,
    jsonb_build_object('id', comment_id, 'decision', 'approve', 'expectedVersion', 1));
  IF result->>'status' <> 'published' THEN RAISE EXCEPTION 'comment decision failed'; END IF;
  SELECT doc->>'status' INTO task_status FROM public.hg_review_tasks WHERE id = 'manual-int-comment-task';
  IF task_status <> 'passed' THEN RAISE EXCEPTION 'comment task remained manual'; END IF;

  INSERT INTO public.hg_appeals (id, doc) VALUES
    (appeal_a, jsonb_build_object('_id', appeal_a, 'status', 'submitted',
      'postId', post_id, 'ownerId', 'SECRET_OWNER_A', 'reason', '请求复核',
      'version', 1, 'createdAt', '2026-09-27T01:02:00.000Z')),
    (appeal_b, jsonb_build_object('_id', appeal_b, 'status', 'submitted',
      'postId', post_id, 'ownerId', 'SECRET_OWNER_B', 'reason', '请求复核',
      'version', 1, 'createdAt', '2026-09-27T01:03:00.000Z'));
  rows := public.hg_admin_appeals_queue(actor_id, NULL, 1);
  IF jsonb_array_length(rows) <> 1 OR rows->0->>'appealId' <> appeal_a
     OR rows::text LIKE '%SECRET_OWNER%' THEN
    RAISE EXCEPTION 'appeal projection or first page invalid';
  END IF;
  cursor := jsonb_build_object('createdAt', 1790470920000::bigint, 'id', appeal_a);
  rows := public.hg_admin_appeals_queue(actor_id, cursor, 1);
  IF jsonb_array_length(rows) <> 1 OR rows->0->>'appealId' <> appeal_b THEN
    RAISE EXCEPTION 'appeal cursor lost or duplicated an item';
  END IF;
  rows := public.hg_admin_appeals_queue(actor_id, cursor || '{"inclusiveId":true}'::jsonb, 1);
  IF jsonb_array_length(rows) <> 1 OR rows->0->>'appealId' <> appeal_a THEN
    RAISE EXCEPTION 'inclusive appeal boundary was lost';
  END IF;
  BEGIN
    PERFORM public.hg_admin_appeals_queue('manual-int-stranger', NULL, 20);
    RAISE EXCEPTION 'non-moderator read appeals';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'FORBIDDEN' THEN RAISE; END IF;
  END;
END $$;
ROLLBACK;
SELECT 'PASS: manual gate, task completion, comment queue and appeal cursor' AS result;
