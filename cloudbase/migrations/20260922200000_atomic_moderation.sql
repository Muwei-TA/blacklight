-- Atomic moderation decisions for all management queues.
--
-- The API passes only the action payload and the trusted actor id from the
-- server session.  This SECURITY DEFINER function re-checks the actor, locks
-- every target, applies the expected-version CAS, writes the audit/notification
-- side effects, and commits them together.  A retry with the same target
-- version and decision returns the stored result; a different decision is a
-- conflict.

CREATE OR REPLACE FUNCTION public.hg_moderate(
  p_action text,
  p_actor_id text,
  p_input jsonb DEFAULT '{}'::jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  actor jsonb;
  post jsonb;
  comment jsonb;
  application jsonb;
  report jsonb;
  topic jsonb;
  task jsonb;
  collection jsonb;
  consent jsonb;
  existing jsonb;
  existing_membership_id text;
  updated jsonb;
  result jsonb;
  target_key text;
  decision text;
  reason text;
  expected_version integer;
  actual_version integer;
  target_version integer;
  audit_id text;
  notification_id text;
  now_text text := to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  target_type text;
  target_id text;
  owner_id text;
  collection_id text;
  post_id text;
  anthology_enabled boolean;
  entry_count integer;
  inserted integer;
BEGIN
  IF p_actor_id IS NULL OR p_actor_id = '' THEN
    RAISE EXCEPTION 'FORBIDDEN';
  END IF;

  SELECT doc INTO actor
  FROM public.hg_memberships
  WHERE doc->>'userId' = p_actor_id
    AND doc->>'clubId' = 'heiguang'
  FOR UPDATE;
  IF actor IS NULL OR actor->>'status' <> 'active' OR actor->>'role' NOT IN ('moderator', 'admin') THEN
    RAISE EXCEPTION 'FORBIDDEN';
  END IF;

  IF p_action = 'content.decide' THEN
    target_key := p_input->>'id';
    decision := p_input->>'decision';
    reason := COALESCE(NULLIF(btrim(p_input->>'reason'), ''), '');
    expected_version := NULLIF(p_input->>'expectedVersion', '')::integer;
    IF target_key IS NULL OR expected_version IS NULL OR decision NOT IN ('approve', 'reject', 'hide') THEN
      RAISE EXCEPTION 'INVALID';
    END IF;
    IF decision <> 'approve' AND reason = '' THEN RAISE EXCEPTION 'REASON_REQUIRED'; END IF;

    SELECT doc INTO post FROM public.hg_posts WHERE public.hg_posts.id = target_key FOR UPDATE;
    IF post IS NULL THEN RAISE EXCEPTION 'POST_NOT_FOUND'; END IF;
    IF post->>'visibility' = 'private' THEN RAISE EXCEPTION 'PRIVATE_CONTENT'; END IF;
    actual_version := COALESCE(NULLIF(post->>'version', '')::integer, 1);
    IF expected_version <> actual_version THEN
      IF actual_version = expected_version + 1
         AND post->>'moderationExpectedVersion' = expected_version::text
         AND post->>'moderationDecision' = decision
         AND post->'moderationResult' IS NOT NULL THEN
        RETURN post->'moderationResult';
      END IF;
      RAISE EXCEPTION 'VERSION_CONFLICT';
    END IF;
    IF post->>'status' <> 'pending' THEN RAISE EXCEPTION 'VERSION_CONFLICT'; END IF;

    updated := post || jsonb_build_object(
      'status', CASE decision WHEN 'approve' THEN 'published' WHEN 'reject' THEN 'rejected' ELSE 'hidden' END,
      'rejectReason', CASE decision WHEN 'reject' THEN reason ELSE '' END,
      'hiddenReason', CASE decision WHEN 'hide' THEN reason ELSE COALESCE(post->>'hiddenReason', '') END,
      'reviewedAt', now_text,
      'reviewedBy', p_actor_id,
      'permissionVersion', CASE WHEN decision = 'hide' THEN COALESCE(NULLIF(post->>'permissionVersion', '')::integer, 0) + 1 ELSE COALESCE(NULLIF(post->>'permissionVersion', '')::integer, 0) END,
      'version', actual_version + 1,
      'moderationExpectedVersion', expected_version,
      'moderationDecision', decision,
      'moderationDecisionReason', reason,
      'moderationDecisionBy', p_actor_id,
      'moderationDecidedAt', now_text
    );
    result := jsonb_build_object('ok', true, 'id', target_key, 'status', updated->>'status', 'version', actual_version + 1);
    updated := updated || jsonb_build_object('moderationResult', result);
    UPDATE public.hg_posts SET doc = updated WHERE public.hg_posts.id = target_key;

    IF decision = 'approve' AND NULLIF(post->>'topicId', '') IS NOT NULL THEN
      SELECT doc INTO topic FROM public.hg_topics WHERE id = post->>'topicId' FOR UPDATE;
      IF topic IS NOT NULL THEN
        UPDATE public.hg_topics
        SET doc = topic || jsonb_build_object('postCount', COALESCE(NULLIF(topic->>'postCount', '')::integer, 0) + 1)
        WHERE public.hg_topics.id = post->>'topicId';
      END IF;
    END IF;

    audit_id := 'audit:' || md5(clock_timestamp()::text || random()::text);
    INSERT INTO public.hg_audit_logs (id, doc) VALUES (
      audit_id,
      jsonb_build_object('_id', audit_id, 'actorId', p_actor_id, 'action', 'content.' || decision, 'targetType', 'post', 'targetId', target_key, 'decision', decision, 'reason', reason, 'createdAt', now_text)
    );
    notification_id := 'notification:' || md5(clock_timestamp()::text || random()::text);
    INSERT INTO public.hg_notifications (id, doc) VALUES (
      notification_id,
      jsonb_build_object('_id', notification_id, 'recipientId', post->>'ownerId', 'eventType', 'system_review', 'title', CASE decision WHEN 'approve' THEN '你的内容已通过审核' WHEN 'reject' THEN '一条内容需要修改' ELSE '一条内容已被暂时隐藏' END, 'summary', CASE decision WHEN 'approve' THEN '现在会在你设定的范围内展示。' ELSE reason END, 'targetType', 'post', 'targetId', target_key, 'icon', CASE decision WHEN 'approve' THEN 'check-circle' ELSE 'error-circle' END, 'createdAt', now_text)
    );
    RETURN result;
  END IF;

  IF p_action = 'comment.decide' THEN
    target_key := p_input->>'id';
    decision := p_input->>'decision';
    reason := COALESCE(NULLIF(btrim(p_input->>'reason'), ''), '');
    expected_version := NULLIF(p_input->>'expectedVersion', '')::integer;
    IF target_key IS NULL OR expected_version IS NULL OR decision NOT IN ('approve', 'reject', 'hide') THEN
      RAISE EXCEPTION 'INVALID';
    END IF;
    IF decision <> 'approve' AND reason = '' THEN RAISE EXCEPTION 'REASON_REQUIRED'; END IF;

    SELECT doc INTO comment FROM public.hg_comments WHERE public.hg_comments.id = target_key FOR UPDATE;
    IF comment IS NULL THEN RAISE EXCEPTION 'COMMENT_NOT_FOUND'; END IF;
    SELECT doc INTO post FROM public.hg_posts WHERE id = comment->>'postId' FOR UPDATE;
    IF post IS NULL THEN RAISE EXCEPTION 'POST_NOT_FOUND'; END IF;
    IF post->>'visibility' = 'private' THEN RAISE EXCEPTION 'PRIVATE_CONTENT'; END IF;
    actual_version := COALESCE(NULLIF(comment->>'version', '')::integer, 1);
    IF expected_version <> actual_version THEN
      IF actual_version = expected_version + 1
         AND comment->>'moderationExpectedVersion' = expected_version::text
         AND comment->>'moderationDecision' = decision
         AND comment->'moderationResult' IS NOT NULL THEN
        RETURN comment->'moderationResult';
      END IF;
      RAISE EXCEPTION 'VERSION_CONFLICT';
    END IF;
    IF comment->>'status' <> 'pending' THEN RAISE EXCEPTION 'VERSION_CONFLICT'; END IF;

    updated := comment || jsonb_build_object(
      'status', CASE decision WHEN 'approve' THEN 'published' WHEN 'reject' THEN 'rejected' ELSE 'hidden' END,
      'rejectReason', CASE decision WHEN 'reject' THEN reason ELSE '' END,
      'reviewedAt', now_text,
      'reviewedBy', p_actor_id,
      'version', actual_version + 1,
      'moderationExpectedVersion', expected_version,
      'moderationDecision', decision,
      'moderationDecisionReason', reason,
      'moderationDecisionBy', p_actor_id,
      'moderationDecidedAt', now_text
    );
    result := jsonb_build_object('ok', true, 'id', target_key, 'status', updated->>'status', 'version', actual_version + 1);
    updated := updated || jsonb_build_object('moderationResult', result);
    UPDATE public.hg_comments SET doc = updated WHERE public.hg_comments.id = target_key;
    IF decision = 'approve' THEN
      UPDATE public.hg_posts
      SET doc = post || jsonb_build_object('commentCount', COALESCE(NULLIF(post->>'commentCount', '')::integer, 0) + 1)
      WHERE id = comment->>'postId';
    END IF;

    audit_id := 'audit:' || md5(clock_timestamp()::text || random()::text);
    INSERT INTO public.hg_audit_logs (id, doc) VALUES (
      audit_id,
      jsonb_build_object('_id', audit_id, 'actorId', p_actor_id, 'action', 'comment.' || decision, 'targetType', 'comment', 'targetId', target_key, 'decision', decision, 'reason', reason, 'createdAt', now_text)
    );
    notification_id := 'notification:' || md5(clock_timestamp()::text || random()::text);
    INSERT INTO public.hg_notifications (id, doc) VALUES (
      notification_id,
      jsonb_build_object('_id', notification_id, 'recipientId', comment->>'ownerId', 'eventType', 'system_review', 'title', CASE decision WHEN 'approve' THEN '你的回应已通过审核' ELSE '你的回应未通过审核' END, 'summary', CASE decision WHEN 'approve' THEN '你的回应现在会显示在内容下方。' ELSE reason END, 'targetType', 'post', 'targetId', comment->>'postId', 'icon', CASE decision WHEN 'approve' THEN 'check-circle' ELSE 'error-circle' END, 'createdAt', now_text)
    );
    RETURN result;
  END IF;

  IF p_action = 'membership.decide' THEN
    target_key := p_input->>'id';
    decision := p_input->>'decision';
    reason := COALESCE(NULLIF(btrim(p_input->>'reason'), ''), '');
    expected_version := NULLIF(p_input->>'expectedVersion', '')::integer;
    IF target_key IS NULL OR expected_version IS NULL OR decision NOT IN ('approve', 'reject') THEN RAISE EXCEPTION 'INVALID'; END IF;
    IF decision = 'reject' AND reason = '' THEN RAISE EXCEPTION 'REASON_REQUIRED'; END IF;

    SELECT doc INTO application FROM public.hg_membership_applications WHERE public.hg_membership_applications.id = target_key FOR UPDATE;
    IF application IS NULL THEN RAISE EXCEPTION 'APPLICATION_NOT_FOUND'; END IF;
    actual_version := COALESCE(NULLIF(application->>'version', '')::integer, 1);
    IF expected_version <> actual_version THEN
      IF actual_version = expected_version + 1
         AND application->>'moderationExpectedVersion' = expected_version::text
         AND application->>'moderationDecision' = decision
         AND application->'moderationResult' IS NOT NULL THEN
        RETURN application->'moderationResult';
      END IF;
      RAISE EXCEPTION 'VERSION_CONFLICT';
    END IF;
    IF application->>'status' <> 'pending' THEN RAISE EXCEPTION 'VERSION_CONFLICT'; END IF;

    IF decision = 'approve' THEN
      SELECT id, doc INTO existing_membership_id, existing FROM public.hg_memberships
      WHERE doc->>'userId' = application->>'userId' AND doc->>'clubId' = application->>'clubId'
      FOR UPDATE;
      IF existing IS NOT NULL AND existing->>'status' = 'active' THEN RAISE EXCEPTION 'MEMBERSHIP_EXISTS'; END IF;
      IF existing IS NULL THEN
        INSERT INTO public.hg_memberships (id, doc) VALUES (
          (application->>'userId') || ':' || (application->>'clubId'),
          jsonb_build_object('_id', (application->>'userId') || ':' || (application->>'clubId'), 'userId', application->>'userId', 'clubId', application->>'clubId', 'role', 'member', 'status', 'active', 'joinedAt', now_text, 'rulesVersion', application->>'rulesVersion', 'version', 1)
        );
      ELSE
        UPDATE public.hg_memberships
        SET doc = existing || jsonb_build_object('role', 'member', 'status', 'active', 'joinedAt', now_text, 'rulesVersion', application->>'rulesVersion', 'version', COALESCE(NULLIF(existing->>'version', '')::integer, 1) + 1, 'updatedAt', now_text)
        WHERE public.hg_memberships.id = existing_membership_id;
      END IF;
      UPDATE public.hg_users
      SET doc = doc || jsonb_build_object('displayName', application->>'displayName', 'updatedAt', now_text)
      WHERE id = application->>'userId';
    END IF;

    updated := application || jsonb_build_object(
      'status', CASE decision WHEN 'approve' THEN 'active' ELSE 'rejected' END,
      'decisionReason', reason,
      'decidedBy', p_actor_id,
      'decidedAt', now_text,
      'version', actual_version + 1,
      'moderationExpectedVersion', expected_version,
      'moderationDecision', decision,
      'moderationDecisionBy', p_actor_id,
      'moderationDecidedAt', now_text
    );
    result := jsonb_build_object('ok', true, 'id', target_key, 'status', updated->>'status', 'version', actual_version + 1);
    updated := updated || jsonb_build_object('moderationResult', result);
    UPDATE public.hg_membership_applications SET doc = updated WHERE public.hg_membership_applications.id = target_key;

    audit_id := 'audit:' || md5(clock_timestamp()::text || random()::text);
    INSERT INTO public.hg_audit_logs (id, doc) VALUES (
      audit_id,
      jsonb_build_object('_id', audit_id, 'actorId', p_actor_id, 'action', 'membership.' || decision, 'targetType', 'membership_application', 'targetId', target_key, 'decision', decision, 'reason', reason, 'createdAt', now_text)
    );
    notification_id := 'notification:' || md5(clock_timestamp()::text || random()::text);
    INSERT INTO public.hg_notifications (id, doc) VALUES (
      notification_id,
      jsonb_build_object('_id', notification_id, 'recipientId', application->>'userId', 'eventType', 'system_membership', 'title', CASE decision WHEN 'approve' THEN '欢迎加入黑光文学社' ELSE '入社申请未通过' END, 'summary', CASE decision WHEN 'approve' THEN '现在可以在社内写下第一笔了。' ELSE reason END, 'targetType', 'system', 'targetId', 'membership', 'icon', 'usergroup', 'createdAt', now_text)
    );
    RETURN result;
  END IF;

  IF p_action = 'topic.decide' THEN
    target_key := p_input->>'id';
    decision := p_input->>'decision';
    reason := COALESCE(NULLIF(btrim(p_input->>'reason'), ''), '');
    expected_version := NULLIF(p_input->>'expectedVersion', '')::integer;
    IF target_key IS NULL OR expected_version IS NULL OR decision NOT IN ('approve', 'archive', 'reject') THEN RAISE EXCEPTION 'INVALID'; END IF;
    IF decision <> 'approve' AND reason = '' THEN RAISE EXCEPTION 'REASON_REQUIRED'; END IF;

    SELECT doc INTO topic FROM public.hg_topics WHERE public.hg_topics.id = target_key FOR UPDATE;
    IF topic IS NULL THEN RAISE EXCEPTION 'TOPIC_NOT_FOUND'; END IF;
    actual_version := COALESCE(NULLIF(topic->>'version', '')::integer, 1);
    IF expected_version <> actual_version THEN
      IF actual_version = expected_version + 1
         AND topic->>'moderationExpectedVersion' = expected_version::text
         AND topic->>'moderationDecision' = decision
         AND topic->'moderationResult' IS NOT NULL THEN
        RETURN topic->'moderationResult';
      END IF;
      RAISE EXCEPTION 'VERSION_CONFLICT';
    END IF;
    IF topic->>'status' <> 'pending' THEN RAISE EXCEPTION 'VERSION_CONFLICT'; END IF;

    updated := topic || jsonb_build_object(
      'status', CASE decision WHEN 'approve' THEN 'active' ELSE 'archived' END,
      'decisionReason', reason,
      'decidedBy', p_actor_id,
      'decidedAt', now_text,
      'version', actual_version + 1,
      'moderationExpectedVersion', expected_version,
      'moderationDecision', decision,
      'moderationDecisionBy', p_actor_id,
      'moderationDecidedAt', now_text
    );
    result := jsonb_build_object('ok', true, 'id', target_key, 'status', updated->>'status', 'version', actual_version + 1);
    updated := updated || jsonb_build_object('moderationResult', result);
    UPDATE public.hg_topics SET doc = updated WHERE public.hg_topics.id = target_key;

    audit_id := 'audit:' || md5(clock_timestamp()::text || random()::text);
    INSERT INTO public.hg_audit_logs (id, doc) VALUES (
      audit_id,
      jsonb_build_object('_id', audit_id, 'actorId', p_actor_id, 'action', 'topic.' || decision, 'targetType', 'topic', 'targetId', target_key, 'decision', decision, 'reason', reason, 'createdAt', now_text)
    );
    notification_id := 'notification:' || md5(clock_timestamp()::text || random()::text);
    INSERT INTO public.hg_notifications (id, doc) VALUES (
      notification_id,
      jsonb_build_object('_id', notification_id, 'recipientId', topic->>'ownerId', 'eventType', 'system_notice', 'title', CASE decision WHEN 'approve' THEN '你的话题已通过' ELSE '你的话题状态已更新' END, 'summary', CASE decision WHEN 'approve' THEN '现在可以在话题广场参与讨论。' ELSE reason END, 'targetType', 'topic', 'targetId', target_key, 'icon', 'chat-bubble-1', 'createdAt', now_text)
    );
    RETURN result;
  END IF;

  IF p_action = 'report.decide' THEN
    target_key := p_input->>'id';
    decision := p_input->>'decision';
    reason := NULLIF(btrim(p_input->>'reason'), '');
    expected_version := NULLIF(p_input->>'expectedVersion', '')::integer;
    IF target_key IS NULL OR expected_version IS NULL OR reason IS NULL OR decision NOT IN ('keep', 'hide', 'escalate') THEN RAISE EXCEPTION 'INVALID'; END IF;

    SELECT doc INTO report FROM public.hg_reports WHERE public.hg_reports.id = target_key FOR UPDATE;
    IF report IS NULL THEN RAISE EXCEPTION 'REPORT_NOT_FOUND'; END IF;
    actual_version := COALESCE(NULLIF(report->>'version', '')::integer, 1);
    IF expected_version <> actual_version THEN
      IF actual_version = expected_version + 1
         AND report->>'moderationExpectedVersion' = expected_version::text
         AND report->>'moderationDecision' = decision
         AND report->'moderationResult' IS NOT NULL THEN
        RETURN report->'moderationResult';
      END IF;
      RAISE EXCEPTION 'VERSION_CONFLICT';
    END IF;
    IF report->>'status' <> 'received' THEN RAISE EXCEPTION 'VERSION_CONFLICT'; END IF;

    target_type := report->>'targetType';
    target_id := report->>'targetId';
    owner_id := NULL;
    IF target_type = 'post' THEN
      SELECT doc INTO post FROM public.hg_posts WHERE id = target_id FOR UPDATE;
      IF post IS NOT NULL THEN
        -- Even a keep/escalate decision must not let the report queue become
        -- a side door for private-note discovery or mutation.
        IF post->>'visibility' = 'private' THEN RAISE EXCEPTION 'PRIVATE_CONTENT'; END IF;
        IF decision = 'hide' THEN
          target_version := COALESCE(NULLIF(post->>'version', '')::integer, 1);
          updated := post || jsonb_build_object('status', 'hidden', 'hiddenReason', reason, 'permissionVersion', COALESCE(NULLIF(post->>'permissionVersion', '')::integer, 0) + 1, 'version', target_version + 1);
          UPDATE public.hg_posts SET doc = updated WHERE id = target_id;
          owner_id := post->>'ownerId';
        END IF;
      ELSIF decision = 'hide' THEN
        RAISE EXCEPTION 'POST_NOT_FOUND';
      END IF;
    ELSIF target_type = 'comment' THEN
      SELECT doc INTO comment FROM public.hg_comments WHERE id = target_id FOR UPDATE;
      IF comment IS NOT NULL THEN
        SELECT doc INTO post FROM public.hg_posts WHERE id = comment->>'postId' FOR UPDATE;
        IF post IS NOT NULL AND post->>'visibility' = 'private' THEN RAISE EXCEPTION 'PRIVATE_CONTENT'; END IF;
        IF decision = 'hide' THEN
          IF post IS NULL THEN RAISE EXCEPTION 'POST_NOT_FOUND'; END IF;
          target_version := COALESCE(NULLIF(comment->>'version', '')::integer, 1);
          updated := comment || jsonb_build_object('status', 'hidden', 'rejectReason', reason, 'version', target_version + 1);
          UPDATE public.hg_comments SET doc = updated WHERE id = target_id;
          owner_id := comment->>'ownerId';
        END IF;
      ELSIF decision = 'hide' THEN
        RAISE EXCEPTION 'COMMENT_NOT_FOUND';
      END IF;
    END IF;

    updated := report || jsonb_build_object(
      'status', CASE decision WHEN 'escalate' THEN 'escalated' ELSE 'closed' END,
      'decision', decision,
      'decisionReason', reason,
      'decidedBy', p_actor_id,
      'decidedAt', now_text,
      'version', actual_version + 1,
      'moderationExpectedVersion', expected_version,
      'moderationDecision', decision,
      'moderationDecisionBy', p_actor_id,
      'moderationDecidedAt', now_text
    );
    result := jsonb_build_object('ok', true, 'id', target_key, 'status', updated->>'status', 'version', actual_version + 1);
    updated := updated || jsonb_build_object('moderationResult', result);
    UPDATE public.hg_reports SET doc = updated WHERE public.hg_reports.id = target_key;

    audit_id := 'audit:' || md5(clock_timestamp()::text || random()::text);
    INSERT INTO public.hg_audit_logs (id, doc) VALUES (
      audit_id,
      jsonb_build_object('_id', audit_id, 'actorId', p_actor_id, 'action', 'report.' || decision, 'targetType', target_type, 'targetId', target_id, 'decision', decision, 'reason', reason, 'createdAt', now_text)
    );
    IF decision = 'hide' AND owner_id IS NOT NULL THEN
      notification_id := 'notification:' || md5(clock_timestamp()::text || random()::text);
      INSERT INTO public.hg_notifications (id, doc) VALUES (
        notification_id,
        jsonb_build_object('_id', notification_id, 'recipientId', owner_id, 'eventType', 'system_report', 'title', '一条内容已被暂时隐藏', 'summary', reason || '。如果你认为这是误判，可以申诉。', 'targetType', target_type, 'targetId', target_id, 'icon', 'flag', 'createdAt', now_text)
      );
    END IF;
    RETURN result;
  END IF;

  IF p_action = 'collection.decide' THEN
    target_key := p_input->>'id';
    decision := p_input->>'decision';
    reason := COALESCE(NULLIF(btrim(p_input->>'reason'), ''), '');
    expected_version := NULLIF(p_input->>'expectedVersion', '')::integer;
    IF target_key IS NULL OR expected_version IS NULL OR decision NOT IN ('include', 'skip') THEN RAISE EXCEPTION 'INVALID'; END IF;
    IF decision = 'skip' AND reason = '' THEN RAISE EXCEPTION 'REASON_REQUIRED'; END IF;

    SELECT doc INTO task FROM public.hg_review_tasks WHERE public.hg_review_tasks.id = target_key FOR UPDATE;
    IF task IS NULL THEN RAISE EXCEPTION 'TASK_NOT_FOUND'; END IF;
    actual_version := COALESCE(NULLIF(task->>'version', '')::integer, 1);
    IF expected_version <> actual_version THEN
      IF actual_version = expected_version + 1
         AND task->>'moderationExpectedVersion' = expected_version::text
         AND task->>'moderationDecision' = decision
         AND task->'moderationResult' IS NOT NULL THEN
        RETURN task->'moderationResult';
      END IF;
      RAISE EXCEPTION 'VERSION_CONFLICT';
    END IF;
    IF task->>'status' <> 'queued' THEN RAISE EXCEPTION 'VERSION_CONFLICT'; END IF;

    collection_id := task->>'collectionId';
    post_id := task->>'targetId';
    SELECT doc INTO post FROM public.hg_posts WHERE id = post_id FOR UPDATE;
    IF post IS NULL THEN RAISE EXCEPTION 'POST_NOT_FOUND'; END IF;
    SELECT doc INTO collection FROM public.hg_collections WHERE id = collection_id FOR UPDATE;
    IF collection IS NULL THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
    owner_id := post->>'ownerId';

    SELECT COALESCE((doc->'capabilities'->>'anthology')::boolean, false) INTO anthology_enabled
    FROM public.hg_club_config WHERE id = 'heiguang';
    IF decision = 'include' AND NOT COALESCE(anthology_enabled, false) THEN
      RAISE EXCEPTION 'CAPABILITY_DISABLED';
    END IF;

    IF decision = 'include' THEN
      IF post->>'status' <> 'published' OR post->>'visibility' = 'private' THEN RAISE EXCEPTION 'PRIVATE_CONTENT'; END IF;
      SELECT doc INTO consent FROM public.hg_consents WHERE id = post_id || ':collection:' || collection_id FOR UPDATE;
      IF consent IS NULL OR NULLIF(consent->>'revokedAt', '') IS NOT NULL THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
      IF collection->>'visibility' = 'public' AND post->>'visibility' <> 'public' THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
      PERFORM pg_advisory_xact_lock(hashtext('hg-moderate:collection:' || collection_id));
      SELECT count(*) INTO entry_count FROM public.hg_collection_entries WHERE doc->>'collectionId' = collection_id;
      INSERT INTO public.hg_collection_entries (id, doc) VALUES (
        'entry:' || post_id || ':' || collection_id,
        jsonb_build_object('_id', 'entry:' || post_id || ':' || collection_id, 'collectionId', collection_id, 'postId', post_id, 'consentId', consent->>'_id', 'order', entry_count + 1, 'createdAt', now_text)
      ) ON CONFLICT (id) DO NOTHING;
      GET DIAGNOSTICS inserted = ROW_COUNT;
      IF inserted <> 1 THEN RAISE EXCEPTION 'CONFLICT'; END IF;
      UPDATE public.hg_collections SET doc = collection || jsonb_build_object('entryCount', COALESCE(NULLIF(collection->>'entryCount', '')::integer, 0) + 1) WHERE id = collection_id;
    END IF;

    updated := task || jsonb_build_object(
      'status', CASE decision WHEN 'include' THEN 'passed' ELSE 'skipped' END,
      'decisionReason', reason,
      'decidedBy', p_actor_id,
      'decidedAt', now_text,
      'version', actual_version + 1,
      'moderationExpectedVersion', expected_version,
      'moderationDecision', decision,
      'moderationDecisionBy', p_actor_id,
      'moderationDecidedAt', now_text
    );
    result := jsonb_build_object('ok', true, 'id', target_key, 'status', updated->>'status', 'version', actual_version + 1);
    updated := updated || jsonb_build_object('moderationResult', result);
    UPDATE public.hg_review_tasks SET doc = updated WHERE public.hg_review_tasks.id = target_key;

    audit_id := 'audit:' || md5(clock_timestamp()::text || random()::text);
    INSERT INTO public.hg_audit_logs (id, doc) VALUES (
      audit_id,
      jsonb_build_object('_id', audit_id, 'actorId', p_actor_id, 'action', 'collection.' || decision, 'targetType', 'post', 'targetId', post_id, 'decision', decision, 'reason', reason, 'createdAt', now_text)
    );
    notification_id := 'notification:' || md5(clock_timestamp()::text || random()::text);
    INSERT INTO public.hg_notifications (id, doc) VALUES (
      notification_id,
      jsonb_build_object('_id', notification_id, 'recipientId', owner_id, 'eventType', 'system_collection', 'title', CASE decision WHEN 'include' THEN '你的文章被收录了' ELSE '这一期暂时没有收录' END, 'summary', CASE decision WHEN 'include' THEN '已加入文集目录。' ELSE reason || '。这不代表作品有问题。' END, 'targetType', 'post', 'targetId', post_id, 'icon', 'book-open', 'createdAt', now_text)
    );
    RETURN result;
  END IF;

  RAISE EXCEPTION 'INVALID';
END;
$$;

REVOKE ALL ON FUNCTION public.hg_moderate(text, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.hg_moderate(text, text, jsonb) TO service_role;
