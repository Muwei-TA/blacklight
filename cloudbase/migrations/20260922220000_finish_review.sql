-- Atomic completion of an automatic post/comment review.
--
-- The worker must prove ownership of the current lease before the content
-- decision is applied.  The target CAS, review-task terminal state, counters,
-- notification, and audit row are committed together.  The task keeps a
-- result marker so a worker that retries the same lease cannot duplicate
-- side effects.

CREATE OR REPLACE FUNCTION public.hg_finish_review(
  p_task_id text,
  p_lease_id text,
  p_expected_version integer,
  p_decision text,
  p_reason text DEFAULT ''
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  task jsonb;
  post jsonb;
  comment jsonb;
  parent_post jsonb;
  topic jsonb;
  updated jsonb;
  updated_task jsonb;
  result jsonb;
  target_type text;
  target_id text;
  target_status text;
  target_version integer;
  task_version integer;
  reason text := COALESCE(NULLIF(btrim(p_reason), ''), '');
  lease_expires_at timestamptz;
  audit_id text;
  notification_id text;
  now_text text := to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
BEGIN
  IF p_task_id IS NULL OR p_task_id = '' OR p_lease_id IS NULL OR p_lease_id = ''
     OR p_expected_version IS NULL OR p_expected_version < 1
     OR p_decision IS NULL OR p_decision NOT IN ('approve', 'reject') THEN
    RAISE EXCEPTION 'INVALID';
  END IF;
  IF p_decision = 'reject' AND reason = '' THEN
    RAISE EXCEPTION 'REASON_REQUIRED';
  END IF;

  SELECT doc INTO task
  FROM public.hg_review_tasks
  WHERE public.hg_review_tasks.id = p_task_id
  FOR UPDATE;
  IF task IS NULL THEN RAISE EXCEPTION 'TASK_NOT_FOUND'; END IF;

  -- A terminal task with the same marker is a safe replay.  A different
  -- decision for that task is an idempotency conflict, even if the caller has
  -- a newer worker lease.
  IF task->>'status' IS DISTINCT FROM 'running' THEN
    IF task->>'reviewExpectedVersion' = p_expected_version::text
       AND task->>'reviewDecision' = p_decision
       AND task->'reviewResult' IS NOT NULL THEN
      RETURN task->'reviewResult';
    END IF;
    IF task->'reviewResult' IS NOT NULL THEN RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT'; END IF;
    RAISE EXCEPTION 'TASK_NOT_RUNNING';
  END IF;

  IF task->>'leaseId' IS DISTINCT FROM p_lease_id THEN
    RAISE EXCEPTION 'LEASE_CONFLICT';
  END IF;
  BEGIN
    lease_expires_at := NULLIF(task->>'leaseExpiresAt', '')::timestamptz;
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'LEASE_CONFLICT';
  END;
  IF lease_expires_at IS NULL OR lease_expires_at <= clock_timestamp() THEN
    RAISE EXCEPTION 'LEASE_EXPIRED';
  END IF;

  target_type := task->>'targetType';
  target_id := task->>'targetId';
  IF target_type IS NULL OR target_type NOT IN ('post', 'comment') OR target_id IS NULL OR target_id = '' THEN
    RAISE EXCEPTION 'INVALID';
  END IF;

  IF target_type = 'post' THEN
    SELECT doc INTO post
    FROM public.hg_posts
    WHERE public.hg_posts.id = target_id
    FOR UPDATE;
    IF post IS NULL THEN RAISE EXCEPTION 'POST_NOT_FOUND'; END IF;
    IF post->>'visibility' IS DISTINCT FROM 'public'
       AND post->>'visibility' IS DISTINCT FROM 'club' THEN
      RAISE EXCEPTION 'PRIVATE_CONTENT';
    END IF;

    target_version := COALESCE(NULLIF(post->>'version', '')::integer, 1);
    task_version := NULLIF(task->>'postVersion', '')::integer;
    IF task_version IS NOT NULL AND task_version <> p_expected_version THEN
      RAISE EXCEPTION 'VERSION_CONFLICT';
    END IF;
    IF p_expected_version <> target_version THEN
      IF target_version = p_expected_version + 1
         AND post->>'reviewExpectedVersion' = p_expected_version::text
         AND post->>'reviewDecision' = p_decision
         AND post->'reviewResult' IS NOT NULL THEN
        RETURN post->'reviewResult';
      END IF;
      RAISE EXCEPTION 'VERSION_CONFLICT';
    END IF;
    IF post->>'status' IS DISTINCT FROM 'pending' THEN
      IF post->>'reviewExpectedVersion' = p_expected_version::text
         AND post->>'reviewDecision' = p_decision
         AND post->'reviewResult' IS NOT NULL THEN
        RETURN post->'reviewResult';
      END IF;
      RAISE EXCEPTION 'VERSION_CONFLICT';
    END IF;

    IF p_decision = 'approve' AND EXISTS (
      SELECT 1
      FROM jsonb_array_elements_text(COALESCE(post->'assetIds', '[]'::jsonb)) AS asset_item(asset_id)
      LEFT JOIN public.hg_assets AS asset ON asset.id = asset_item.asset_id
      WHERE asset.id IS NULL
         OR asset.doc->>'status' IS DISTINCT FROM 'verified'
         OR asset.doc->>'postId' IS DISTINCT FROM target_id
         OR asset.doc->>'ownerId' IS DISTINCT FROM post->>'ownerId'
    ) THEN
      RAISE EXCEPTION 'PENDING_MEDIA';
    END IF;

    target_status := CASE p_decision WHEN 'approve' THEN 'published' ELSE 'rejected' END;
    updated := post || jsonb_build_object(
      'status', target_status,
      'rejectReason', CASE WHEN p_decision = 'reject' THEN reason ELSE COALESCE(post->>'rejectReason', '') END,
      'reviewedAt', now_text,
      'reviewedBy', 'system',
      'version', target_version + 1,
      'reviewExpectedVersion', p_expected_version,
      'reviewDecision', p_decision,
      'reviewResult', NULL,
      'reviewDecidedAt', now_text
    );
    result := jsonb_build_object(
      'ok', true,
      'taskId', p_task_id,
      'targetType', target_type,
      'targetId', target_id,
      'decision', p_decision,
      'status', CASE p_decision WHEN 'approve' THEN 'passed' ELSE 'failed' END,
      'targetStatus', target_status,
      'version', target_version + 1
    );
    updated := updated || jsonb_build_object('reviewResult', result);
    UPDATE public.hg_posts SET doc = updated WHERE public.hg_posts.id = target_id;

    IF p_decision = 'approve' AND NULLIF(post->>'topicId', '') IS NOT NULL THEN
      SELECT doc INTO topic
      FROM public.hg_topics
      WHERE public.hg_topics.id = post->>'topicId'
      FOR UPDATE;
      IF topic IS NOT NULL THEN
        UPDATE public.hg_topics
        SET doc = topic || jsonb_build_object(
          'postCount', COALESCE(NULLIF(topic->>'postCount', '')::integer, 0) + 1
        )
        WHERE public.hg_topics.id = post->>'topicId';
      END IF;
    END IF;

    audit_id := 'audit:' || md5(clock_timestamp()::text || random()::text);
    INSERT INTO public.hg_audit_logs (id, doc) VALUES (
      audit_id,
      jsonb_build_object(
        '_id', audit_id,
        'actorId', 'system',
        'action', 'review.post.' || p_decision,
        'targetType', 'post',
        'targetId', target_id,
        'decision', p_decision,
        'reason', reason,
        'createdAt', now_text
      )
    );
    notification_id := 'notification:' || md5(clock_timestamp()::text || random()::text);
    INSERT INTO public.hg_notifications (id, doc) VALUES (
      notification_id,
      jsonb_build_object(
        '_id', notification_id,
        'recipientId', post->>'ownerId',
        'eventType', 'system_review',
        'title', CASE p_decision WHEN 'approve' THEN '你的内容已通过审核' ELSE '一条内容需要修改' END,
        'summary', CASE p_decision WHEN 'approve' THEN '现在会在你设定的范围内展示。' ELSE reason || '。原文已保留，可以修改后重新提交。' END,
        'targetType', 'post',
        'targetId', target_id,
        'icon', CASE p_decision WHEN 'approve' THEN 'check-circle' ELSE 'error-circle' END,
        'createdAt', now_text
      )
    );
  ELSE
    SELECT doc INTO comment
    FROM public.hg_comments
    WHERE public.hg_comments.id = target_id
    FOR UPDATE;
    IF comment IS NULL THEN RAISE EXCEPTION 'COMMENT_NOT_FOUND'; END IF;

    target_version := COALESCE(NULLIF(comment->>'version', '')::integer, 1);
    IF p_expected_version <> target_version THEN
      IF target_version = p_expected_version + 1
         AND comment->>'reviewExpectedVersion' = p_expected_version::text
         AND comment->>'reviewDecision' = p_decision
         AND comment->'reviewResult' IS NOT NULL THEN
        RETURN comment->'reviewResult';
      END IF;
      RAISE EXCEPTION 'VERSION_CONFLICT';
    END IF;
    IF comment->>'status' IS DISTINCT FROM 'pending' THEN
      IF comment->>'reviewExpectedVersion' = p_expected_version::text
         AND comment->>'reviewDecision' = p_decision
         AND comment->'reviewResult' IS NOT NULL THEN
        RETURN comment->'reviewResult';
      END IF;
      RAISE EXCEPTION 'VERSION_CONFLICT';
    END IF;

    SELECT doc INTO parent_post
    FROM public.hg_posts
    WHERE public.hg_posts.id = comment->>'postId'
    FOR UPDATE;
    IF p_decision = 'approve' THEN
      IF parent_post IS NULL THEN RAISE EXCEPTION 'PARENT_NOT_FOUND'; END IF;
      IF parent_post->>'status' IS DISTINCT FROM 'published'
         OR (parent_post->>'visibility' IS DISTINCT FROM 'public'
             AND parent_post->>'visibility' IS DISTINCT FROM 'club') THEN
        RAISE EXCEPTION 'PARENT_NOT_PUBLISHED';
      END IF;
    END IF;

    target_status := CASE p_decision WHEN 'approve' THEN 'published' ELSE 'rejected' END;
    updated := comment || jsonb_build_object(
      'status', target_status,
      'rejectReason', CASE WHEN p_decision = 'reject' THEN reason ELSE COALESCE(comment->>'rejectReason', '') END,
      'reviewedAt', now_text,
      'reviewedBy', 'system',
      'version', target_version + 1,
      'reviewExpectedVersion', p_expected_version,
      'reviewDecision', p_decision,
      'reviewResult', NULL,
      'reviewDecidedAt', now_text
    );
    result := jsonb_build_object(
      'ok', true,
      'taskId', p_task_id,
      'targetType', target_type,
      'targetId', target_id,
      'decision', p_decision,
      'status', CASE p_decision WHEN 'approve' THEN 'passed' ELSE 'failed' END,
      'targetStatus', target_status,
      'version', target_version + 1
    );
    updated := updated || jsonb_build_object('reviewResult', result);
    UPDATE public.hg_comments SET doc = updated WHERE public.hg_comments.id = target_id;

    IF p_decision = 'approve' THEN
      UPDATE public.hg_posts
      SET doc = parent_post || jsonb_build_object(
        'commentCount', COALESCE(NULLIF(parent_post->>'commentCount', '')::integer, 0) + 1
      )
      WHERE public.hg_posts.id = comment->>'postId';
    END IF;

    audit_id := 'audit:' || md5(clock_timestamp()::text || random()::text);
    INSERT INTO public.hg_audit_logs (id, doc) VALUES (
      audit_id,
      jsonb_build_object(
        '_id', audit_id,
        'actorId', 'system',
        'action', 'review.comment.' || p_decision,
        'targetType', 'comment',
        'targetId', target_id,
        'decision', p_decision,
        'reason', reason,
        'createdAt', now_text
      )
    );
    IF p_decision = 'approve' AND parent_post->>'ownerId' IS DISTINCT FROM comment->>'ownerId' THEN
      notification_id := 'notification:' || md5(clock_timestamp()::text || random()::text);
      INSERT INTO public.hg_notifications (id, doc) VALUES (
        notification_id,
        jsonb_build_object(
          '_id', notification_id,
          'recipientId', parent_post->>'ownerId',
          'eventType', CASE WHEN comment->>'replyToId' IS NULL THEN 'comment' ELSE 'reply' END,
          'title', '有人回应了你的内容',
          'summary', '',
          'targetType', 'post',
          'targetId', comment->>'postId',
          'icon', 'chat-bubble-1',
          'createdAt', now_text
        )
      );
    ELSIF p_decision = 'reject' THEN
      notification_id := 'notification:' || md5(clock_timestamp()::text || random()::text);
      INSERT INTO public.hg_notifications (id, doc) VALUES (
        notification_id,
        jsonb_build_object(
          '_id', notification_id,
          'recipientId', comment->>'ownerId',
          'eventType', 'system_review',
          'title', '你的回应未通过审核',
          'summary', reason,
          'targetType', 'comment',
          'targetId', target_id,
          'icon', 'error-circle',
          'createdAt', now_text
        )
      );
    END IF;
  END IF;

  -- Mark the task terminal in the same transaction.  reviewPost/reviewComment
  -- update their local lease snapshot to this terminal shape so the existing
  -- worker conditional update remains a harmless metadata refresh.
  updated_task := task || jsonb_build_object(
    'status', CASE WHEN target_status = 'published' THEN 'passed' ELSE 'failed' END,
    'finishedAt', now_text,
    'waitingReason', '',
    'nextAttemptAt', NULL,
    'lastError', '',
    'leaseId', '',
    'claimedAt', NULL,
    'leaseExpiresAt', NULL,
    'version', COALESCE(NULLIF(task->>'version', '')::integer, 1) + 1,
    'reviewExpectedVersion', p_expected_version,
    'reviewDecision', p_decision,
    'reviewResult', result
  );
  UPDATE public.hg_review_tasks SET doc = updated_task WHERE public.hg_review_tasks.id = p_task_id;

  RETURN result;
END;
$$;

REVOKE ALL ON FUNCTION public.hg_finish_review(text, text, integer, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.hg_finish_review(text, text, integer, text, text) TO service_role;
