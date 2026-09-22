-- Run after 20260922160000_postgresql_core.sql and
-- 20260922220000_finish_review.sql with the service role.
-- Fixtures are unique and the outer transaction is rolled back.
BEGIN;
DO $$
DECLARE
  author_id text := 'review-int-author';
  commenter_id text := 'review-int-commenter';
  topic_id text := 'review-int-topic';
  post_id text := 'review-int-post';
  reject_post_id text := 'review-int-reject-post';
  comment_id text := 'review-int-comment';
  pending_parent_id text := 'review-int-pending-parent';
  bad_asset_post_id text := 'review-int-bad-asset-post';
  task_id text := 'review:int-post';
  stale_task_id text := 'review:int-stale';
  reject_task_id text := 'review:int-reject';
  comment_task_id text := 'review:int-comment';
  pending_parent_task_id text := 'review:int-pending-parent';
  bad_asset_task_id text := 'review:int-bad-asset';
  asset_id text := 'asset:review-int';
  lease_id text := 'lease:review-int';
  result jsonb;
  repeat_result jsonb;
  item jsonb;
  n integer;
BEGIN
  INSERT INTO public.hg_topics (id, doc) VALUES (
    topic_id,
    jsonb_build_object('_id', topic_id, 'clubId', 'heiguang', 'ownerId', author_id, 'status', 'active', 'postCount', 0)
  );
  INSERT INTO public.hg_posts (id, doc) VALUES
    (post_id, jsonb_build_object('_id', post_id, 'ownerId', author_id, 'clubId', 'heiguang', 'topicId', topic_id, 'status', 'pending', 'visibility', 'public', 'version', 1, 'commentCount', 0, 'assetIds', '[]'::jsonb, 'body', 'review post')),
    (reject_post_id, jsonb_build_object('_id', reject_post_id, 'ownerId', author_id, 'clubId', 'heiguang', 'status', 'pending', 'visibility', 'public', 'version', 1, 'assetIds', '[]'::jsonb, 'body', 'reject post')),
    (pending_parent_id, jsonb_build_object('_id', pending_parent_id, 'ownerId', author_id, 'clubId', 'heiguang', 'status', 'pending', 'visibility', 'public', 'version', 1, 'assetIds', '[]'::jsonb, 'body', 'pending parent')),
    (bad_asset_post_id, jsonb_build_object('_id', bad_asset_post_id, 'ownerId', author_id, 'clubId', 'heiguang', 'status', 'pending', 'visibility', 'public', 'version', 1, 'assetIds', jsonb_build_array(asset_id), 'body', 'bad asset post'));
  INSERT INTO public.hg_comments (id, doc) VALUES (
    comment_id,
    jsonb_build_object('_id', comment_id, 'ownerId', commenter_id, 'postId', post_id, 'status', 'pending', 'version', 2, 'body', 'review comment')
  );
  INSERT INTO public.hg_comments (id, doc) VALUES (
    'comment:review-int-pending-parent',
    jsonb_build_object('_id', 'comment:review-int-pending-parent', 'ownerId', commenter_id, 'postId', pending_parent_id, 'status', 'pending', 'version', 1, 'body', 'pending parent comment')
  );
  INSERT INTO public.hg_assets (id, doc) VALUES (
    asset_id,
    jsonb_build_object('_id', asset_id, 'ownerId', 'wrong-owner', 'postId', bad_asset_post_id, 'status', 'verified')
  );
  INSERT INTO public.hg_review_tasks (id, doc) VALUES
    (task_id, jsonb_build_object('_id', task_id, 'targetType', 'post', 'targetId', post_id, 'postVersion', 1, 'status', 'running', 'leaseId', lease_id, 'leaseExpiresAt', '2099-01-01T00:00:00.000Z', 'version', 1)),
    (stale_task_id, jsonb_build_object('_id', stale_task_id, 'targetType', 'post', 'targetId', reject_post_id, 'postVersion', 1, 'status', 'running', 'leaseId', 'lease:stale', 'leaseExpiresAt', '2020-01-01T00:00:00.000Z', 'version', 1)),
    (reject_task_id, jsonb_build_object('_id', reject_task_id, 'targetType', 'post', 'targetId', reject_post_id, 'postVersion', 1, 'status', 'running', 'leaseId', 'lease:reject', 'leaseExpiresAt', '2099-01-01T00:00:00.000Z', 'version', 1)),
    (comment_task_id, jsonb_build_object('_id', comment_task_id, 'targetType', 'comment', 'targetId', comment_id, 'status', 'running', 'leaseId', 'lease:comment', 'leaseExpiresAt', '2099-01-01T00:00:00.000Z', 'version', 1)),
    (pending_parent_task_id, jsonb_build_object('_id', pending_parent_task_id, 'targetType', 'comment', 'targetId', 'comment:review-int-pending-parent', 'status', 'running', 'leaseId', 'lease:pending-parent', 'leaseExpiresAt', '2099-01-01T00:00:00.000Z', 'version', 1)),
    (bad_asset_task_id, jsonb_build_object('_id', bad_asset_task_id, 'targetType', 'post', 'targetId', bad_asset_post_id, 'postVersion', 1, 'status', 'running', 'leaseId', 'lease:bad-asset', 'leaseExpiresAt', '2099-01-01T00:00:00.000Z', 'version', 1));

  result := public.hg_finish_review(task_id, lease_id, 1, 'approve', '');
  IF result->>'status' <> 'passed' OR result->>'targetStatus' <> 'published' THEN
    RAISE EXCEPTION 'post review completion failed: %', result;
  END IF;
  SELECT doc INTO item FROM public.hg_posts WHERE id = post_id;
  IF item->>'status' <> 'published' OR (item->>'version')::integer <> 2 THEN
    RAISE EXCEPTION 'post CAS/status failed';
  END IF;
  SELECT doc INTO item FROM public.hg_review_tasks WHERE id = task_id;
  IF item->>'status' <> 'passed' OR item->>'leaseId' <> '' THEN
    RAISE EXCEPTION 'review task terminal lease state failed';
  END IF;
  SELECT (doc->>'postCount')::integer INTO n FROM public.hg_topics WHERE id = topic_id;
  IF COALESCE(n, 0) <> 1 THEN RAISE EXCEPTION 'topic count was not atomic'; END IF;
  SELECT count(*) INTO n FROM public.hg_audit_logs
  WHERE doc->>'action' = 'review.post.approve' AND doc->>'targetId' = post_id;
  IF n <> 1 THEN RAISE EXCEPTION 'post audit missing or duplicated'; END IF;
  SELECT count(*) INTO n FROM public.hg_notifications
  WHERE doc->>'eventType' = 'system_review' AND doc->>'targetId' = post_id;
  IF n <> 1 THEN RAISE EXCEPTION 'post notification missing or duplicated'; END IF;

  BEGIN
    PERFORM public.hg_finish_review(stale_task_id, 'lease:stale', 1, 'approve', '');
    RAISE EXCEPTION 'expired lease was accepted';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'LEASE_EXPIRED' THEN RAISE; END IF;
  END;
  SELECT doc INTO item FROM public.hg_posts WHERE id = reject_post_id;
  IF item->>'status' <> 'pending' THEN RAISE EXCEPTION 'expired lease changed content'; END IF;

  repeat_result := public.hg_finish_review(task_id, lease_id, 1, 'approve', '');
  IF repeat_result IS DISTINCT FROM result THEN RAISE EXCEPTION 'review replay was not idempotent'; END IF;
  BEGIN
    PERFORM public.hg_finish_review(task_id, lease_id, 1, 'reject', '不同决定');
    RAISE EXCEPTION 'different review decision was accepted';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'IDEMPOTENCY_CONFLICT' THEN RAISE; END IF;
  END;

  result := public.hg_finish_review(reject_task_id, 'lease:reject', 1, 'reject', '未通过安全检查');
  IF result->>'status' <> 'failed' OR result->>'targetStatus' <> 'rejected' THEN RAISE EXCEPTION 'post rejection failed'; END IF;
  SELECT count(*) INTO n FROM public.hg_notifications
  WHERE doc->>'eventType' = 'system_review' AND doc->>'targetId' = reject_post_id;
  IF n <> 1 THEN RAISE EXCEPTION 'rejection notification missing'; END IF;

  result := public.hg_finish_review(comment_task_id, 'lease:comment', 2, 'approve', '');
  IF result->>'status' <> 'passed' THEN RAISE EXCEPTION 'comment review completion failed'; END IF;
  SELECT doc INTO item FROM public.hg_comments WHERE id = comment_id;
  IF item->>'status' <> 'published' OR (item->>'version')::integer <> 3 THEN RAISE EXCEPTION 'comment CAS/status failed'; END IF;
  SELECT (doc->>'commentCount')::integer INTO n FROM public.hg_posts WHERE id = post_id;
  IF COALESCE(n, 0) <> 1 THEN RAISE EXCEPTION 'comment count was not atomic'; END IF;
  SELECT count(*) INTO n FROM public.hg_audit_logs
  WHERE doc->>'action' = 'review.comment.approve' AND doc->>'targetId' = comment_id;
  IF n <> 1 THEN RAISE EXCEPTION 'comment audit missing'; END IF;
  SELECT count(*) INTO n FROM public.hg_notifications
  WHERE doc->>'recipientId' = commenter_id AND doc->>'targetId' = comment_id;
  IF n <> 0 THEN RAISE EXCEPTION 'approval unexpectedly notified the comment author'; END IF;
  SELECT count(*) INTO n FROM public.hg_notifications
  WHERE doc->>'recipientId' = author_id AND doc->>'targetId' = post_id AND doc->>'eventType' = 'comment';
  IF n <> 1 THEN RAISE EXCEPTION 'comment parent notification missing'; END IF;

  BEGIN
    PERFORM public.hg_finish_review(pending_parent_task_id, 'lease:pending-parent', 1, 'approve', '');
    RAISE EXCEPTION 'comment under pending parent was approved';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'PARENT_NOT_PUBLISHED' THEN RAISE; END IF;
  END;
  SELECT doc INTO item FROM public.hg_comments WHERE id = 'comment:review-int-pending-parent';
  IF item->>'status' <> 'pending' THEN RAISE EXCEPTION 'parent gate changed comment'; END IF;

  BEGIN
    PERFORM public.hg_finish_review(bad_asset_task_id, 'lease:bad-asset', 1, 'approve', '');
    RAISE EXCEPTION 'unbound asset post was published';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'PENDING_MEDIA' THEN RAISE; END IF;
  END;
  SELECT doc INTO item FROM public.hg_posts WHERE id = bad_asset_post_id;
  IF item->>'status' <> 'pending' THEN RAISE EXCEPTION 'asset gate changed post'; END IF;
END $$;
ROLLBACK;
SELECT 'PASS: leased review CAS, asset/parent gates, idempotency, counters, audit, notifications, and rollback' AS result;
