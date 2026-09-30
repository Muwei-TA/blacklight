-- Only a completed safety review may enter a human content decision.  Keep
-- the existing moderation transaction intact and close its safety task in
-- the same transaction as the human decision.
ALTER FUNCTION public.hg_moderate(text, text, jsonb) RENAME TO hg_moderate_legacy;
REVOKE ALL ON FUNCTION public.hg_moderate_legacy(text, text, jsonb) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.hg_moderate(
  p_action text,
  p_actor_id text,
  p_input jsonb DEFAULT '{}'::jsonb
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  task_id text;
  task_doc jsonb;
  result jsonb;
  target_type text;
  expected_version text;
  target_doc jsonb;
  now_text text := to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
BEGIN
  IF p_action IN ('content.decide', 'comment.decide') THEN
    target_type := CASE p_action WHEN 'content.decide' THEN 'post' ELSE 'comment' END;
    expected_version := p_input->>'expectedVersion';
    IF NULLIF(p_input->>'id', '') IS NULL OR expected_version IS NULL
       OR expected_version !~ '^[1-9][0-9]*$' THEN
      RAISE EXCEPTION 'INVALID';
    END IF;

    -- A queued/running task has not passed the platform safety check.  Lock
    -- the same task first as hg_finish_review so worker and moderator cannot
    -- race each other into publishing an unchecked target.
    SELECT task.id, task.doc INTO task_id, task_doc
    FROM public.hg_review_tasks AS task
    WHERE task.doc->>'targetType' = target_type
      AND task.doc->>'targetId' = p_input->>'id'
      AND task.doc->>'status' = 'manual'
      AND task.doc->>'postVersion' = expected_version
    ORDER BY task.doc->>'createdAt' DESC, task.id DESC
    LIMIT 1 FOR UPDATE;
    IF task_id IS NULL THEN
      IF target_type = 'post' THEN
        SELECT doc INTO target_doc FROM public.hg_posts WHERE id = p_input->>'id';
      ELSE
        SELECT doc INTO target_doc FROM public.hg_comments WHERE id = p_input->>'id';
      END IF;
      -- Preserve the old idempotent response and specific private-content /
      -- missing-target errors, but never allow a pending public item to skip
      -- its safety task.
      IF target_doc IS NULL OR target_doc->>'status' IS DISTINCT FROM 'pending'
         OR (target_type = 'post' AND target_doc->>'visibility' = 'private') THEN
        RETURN public.hg_moderate_legacy(p_action, p_actor_id, p_input);
      END IF;
      RAISE EXCEPTION 'REVIEW_NOT_READY';
    END IF;
  END IF;

  -- The legacy function still verifies moderator membership, target state,
  -- expectedVersion, decision, reason, media binding and audit effects.
  result := public.hg_moderate_legacy(p_action, p_actor_id, p_input);

  IF task_id IS NOT NULL THEN
    UPDATE public.hg_review_tasks AS task
    SET doc = task_doc || jsonb_build_object(
      'status', CASE WHEN p_input->>'decision' = 'approve' THEN 'passed' ELSE 'failed' END,
      'finishedAt', now_text,
      'waitingReason', '',
      'nextAttemptAt', NULL,
      'lastError', '',
      'leaseId', '',
      'claimedAt', NULL,
      'leaseExpiresAt', NULL,
      'reviewedBy', p_actor_id,
      'reviewDecision', p_input->>'decision',
      'version', COALESCE(NULLIF(task_doc->>'version', '')::integer, 1) + 1
    )
    WHERE task.id = task_id;
  END IF;
  RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.hg_moderate(text, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.hg_moderate(text, text, jsonb) TO service_role;

-- Only a comment that the safety worker explicitly escalated is a human
-- moderation item.  The cursor uses the same epoch-millisecond pair as the
-- API's other queue cursors.
CREATE OR REPLACE FUNCTION public.hg_comment_queue(
  p_actor text,
  p_cursor jsonb DEFAULT NULL,
  p_limit integer DEFAULT 20
) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $$
DECLARE result jsonb;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.hg_memberships
    WHERE doc->>'userId' = p_actor AND doc->>'clubId' = 'heiguang'
      AND doc->>'status' = 'active' AND doc->>'role' IN ('admin', 'moderator')
  ) THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;

  SELECT COALESCE(jsonb_agg(row.doc ORDER BY row.doc->>'createdAt', row.id), '[]'::jsonb)
  INTO result FROM (
    SELECT comment.id, comment.doc
    FROM public.hg_comments AS comment
    JOIN public.hg_posts AS post ON post.id = comment.doc->>'postId'
    WHERE comment.doc->>'status' = 'pending'
      AND post.doc->>'clubId' = 'heiguang'
      AND post.doc->>'status' = 'published'
      AND post.doc->>'visibility' IN ('club', 'public')
      AND EXISTS (
        SELECT 1 FROM public.hg_review_tasks AS task
        WHERE task.doc->>'targetType' = 'comment'
          AND task.doc->>'targetId' = comment.id
          AND task.doc->>'status' = 'manual'
          AND task.doc->>'postVersion' = COALESCE(comment.doc->>'version', '1')
      )
      AND (p_cursor IS NULL OR
        ((comment.doc->>'createdAt')::timestamptz, comment.id) >
        (to_timestamp((p_cursor->>'createdAt')::numeric / 1000), p_cursor->>'id')
        OR (p_cursor->>'inclusiveId' = 'true' AND
          ((comment.doc->>'createdAt')::timestamptz, comment.id) =
          (to_timestamp((p_cursor->>'createdAt')::numeric / 1000), p_cursor->>'id')))
    ORDER BY comment.doc->>'createdAt', comment.id
    LIMIT GREATEST(1, LEAST(p_limit, 51))
  ) AS row;
  RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.hg_comment_queue(text, jsonb, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.hg_comment_queue(text, jsonb, integer) TO service_role;

-- Appeals join the unified queue without exposing the post body, author ID,
-- anonymous identity mapping, or any unrelated governance records.
CREATE FUNCTION public.hg_admin_appeals_queue(
  p_actor text,
  p_cursor jsonb DEFAULT NULL,
  p_limit integer DEFAULT 20
) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $$
DECLARE result jsonb;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.hg_memberships
    WHERE doc->>'userId' = p_actor AND doc->>'clubId' = 'heiguang'
      AND doc->>'status' = 'active' AND doc->>'role' IN ('admin', 'moderator')
  ) THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;

  SELECT COALESCE(jsonb_agg(row.dto ORDER BY row.created_at, row.id), '[]'::jsonb)
  INTO result FROM (
    SELECT appeal.id, appeal.doc->>'createdAt' AS created_at,
      jsonb_build_object(
        'appealId', appeal.id,
        'postId', appeal.doc->>'postId',
        'contentVersion', appeal.doc->>'contentVersion',
        'status', appeal.doc->>'status',
        'reason', appeal.doc->>'reason',
        'version', COALESCE(NULLIF(appeal.doc->>'version', '')::integer, 1),
        'createdAt', appeal.doc->>'createdAt',
        'updatedAt', appeal.doc->>'updatedAt'
      ) AS dto
    FROM public.hg_appeals AS appeal
    WHERE appeal.doc->>'status' = 'submitted'
      AND (p_cursor IS NULL OR
        ((appeal.doc->>'createdAt')::timestamptz, appeal.id) >
        (to_timestamp((p_cursor->>'createdAt')::numeric / 1000), p_cursor->>'id')
        OR (p_cursor->>'inclusiveId' = 'true' AND
          ((appeal.doc->>'createdAt')::timestamptz, appeal.id) =
          (to_timestamp((p_cursor->>'createdAt')::numeric / 1000), p_cursor->>'id')))
    ORDER BY appeal.doc->>'createdAt', appeal.id
    LIMIT GREATEST(1, LEAST(p_limit, 51))
  ) AS row;
  RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.hg_admin_appeals_queue(text, jsonb, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.hg_admin_appeals_queue(text, jsonb, integer) TO service_role;
