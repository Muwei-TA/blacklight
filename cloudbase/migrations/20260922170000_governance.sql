-- T-B10/T-B11: member governance and appeal workflow.
--
-- The API cloud function calls hg_governance once per mutation.  The RPC
-- re-checks the actor from hg_memberships and performs the business update,
-- audit record, and author notification in one PostgreSQL transaction.
-- The client roles have no table or function privileges; deployment must run
-- this migration after 20260922160000_postgresql_core.sql.

CREATE TABLE public.hg_appeals (
  id text PRIMARY KEY,
  doc jsonb NOT NULL CHECK (jsonb_typeof(doc) = 'object' AND doc->>'_id' = id)
);
ALTER TABLE public.hg_appeals ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.hg_appeals FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.hg_appeals TO service_role;
CREATE INDEX hg_appeals_status_idx ON public.hg_appeals ((doc->>'status'), (doc->'createdAt'));
CREATE UNIQUE INDEX hg_appeals_post_version_owner_idx
  ON public.hg_appeals ((doc->>'postId'), (doc->>'contentVersion'), (doc->>'ownerId'));

CREATE OR REPLACE FUNCTION public.hg_governance(
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
  target jsonb;
  post jsonb;
  appeal jsonb;
  updated jsonb;
  target_row_id text;
  target_user_id text;
  post_id text;
  appeal_id text;
  owner_id text;
  reason text;
  new_role text;
  decision text;
  muted_until text;
  expected_version integer;
  actual_version integer;
  post_version integer;
  content_version integer;
  moderator_count integer;
  now_text text := to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  audit_id text;
  notification_id text;
BEGIN
  IF p_actor_id IS NULL OR p_actor_id = '' THEN
    RAISE EXCEPTION 'FORBIDDEN';
  END IF;

  SELECT doc INTO actor
  FROM public.hg_memberships
  WHERE doc->>'userId' = p_actor_id
    AND doc->>'clubId' = 'heiguang'
  FOR UPDATE;

  IF actor IS NULL OR actor->>'status' <> 'active' THEN
    RAISE EXCEPTION 'FORBIDDEN';
  END IF;
  IF p_action LIKE 'member.%' AND actor->>'role' <> 'moderator' THEN
    RAISE EXCEPTION 'FORBIDDEN';
  END IF;
  IF p_action = 'appeal.decide' AND actor->>'role' NOT IN ('moderator', 'admin') THEN
    RAISE EXCEPTION 'FORBIDDEN';
  END IF;

  IF p_action IN ('member.remove', 'member.mute', 'member.role') THEN
    target_user_id := p_input->>'targetUserId';
    expected_version := NULLIF(p_input->>'expectedVersion', '')::integer;
    reason := NULLIF(btrim(p_input->>'reason'), '');
    IF target_user_id IS NULL OR target_user_id = '' OR target_user_id = p_actor_id THEN
      RAISE EXCEPTION 'SELF_TARGET';
    END IF;
    IF expected_version IS NULL OR reason IS NULL THEN
      RAISE EXCEPTION 'INVALID';
    END IF;

    SELECT id, doc INTO target_row_id, target
    FROM public.hg_memberships
    WHERE doc->>'userId' = target_user_id
      AND doc->>'clubId' = 'heiguang'
    FOR UPDATE;
    IF target IS NULL OR target->>'status' <> 'active' THEN
      RAISE EXCEPTION 'NOT_FOUND';
    END IF;
    actual_version := COALESCE(NULLIF(target->>'version', '')::integer, 1);
    IF expected_version <> actual_version THEN
      RAISE EXCEPTION 'VERSION_CONFLICT';
    END IF;

    IF p_action = 'member.role' THEN
      new_role := p_input->>'role';
      IF new_role NOT IN ('member', 'moderator', 'admin') THEN
        RAISE EXCEPTION 'ROLE_INVALID';
      END IF;
    END IF;

    IF p_action = 'member.remove'
       OR (p_action = 'member.role' AND target->>'role' = 'moderator' AND new_role <> 'moderator') THEN
      SELECT count(*) INTO moderator_count
      FROM public.hg_memberships
      WHERE doc->>'clubId' = 'heiguang'
        AND doc->>'status' = 'active'
        AND doc->>'role' = 'moderator';
      IF moderator_count <= 1 THEN
        RAISE EXCEPTION 'LAST_MODERATOR';
      END IF;
    END IF;

    updated := target || jsonb_build_object(
      'version', actual_version + 1,
      'updatedAt', now_text
    );
    IF p_action = 'member.remove' THEN
      updated := updated || jsonb_build_object(
        'status', 'removed',
        'removedAt', now_text,
        'removalReason', reason,
        'removedBy', p_actor_id
      );
    ELSIF p_action = 'member.mute' THEN
      muted_until := p_input->>'mutedUntil';
      IF muted_until IS NOT NULL AND muted_until <> '' THEN
        BEGIN
          PERFORM muted_until::timestamptz;
        EXCEPTION WHEN others THEN
          RAISE EXCEPTION 'INVALID';
        END;
      END IF;
      updated := updated || jsonb_build_object('mutedUntil', to_jsonb(NULLIF(muted_until, '')));
    ELSE
      updated := updated || jsonb_build_object('role', new_role);
    END IF;

    UPDATE public.hg_memberships
    SET doc = updated
    WHERE id = target_row_id;

    audit_id := 'audit:' || md5(clock_timestamp()::text || random()::text);
    INSERT INTO public.hg_audit_logs (id, doc) VALUES (
      audit_id,
      jsonb_build_object(
        '_id', audit_id,
        'actorId', p_actor_id,
        'action', p_action,
        'targetType', 'membership',
        'targetId', target_user_id,
        'decision', CASE p_action WHEN 'member.remove' THEN 'remove' WHEN 'member.mute' THEN 'mute' ELSE 'role' END,
        'reason', reason,
        'extra', jsonb_build_object('role', COALESCE(new_role, target->>'role'), 'mutedUntil', p_input->>'mutedUntil'),
        'createdAt', now_text
      )
    );

    notification_id := 'notification:' || md5(clock_timestamp()::text || random()::text);
    INSERT INTO public.hg_notifications (id, doc) VALUES (
      notification_id,
      jsonb_build_object(
        '_id', notification_id,
        'recipientId', target_user_id,
        'eventType', 'system_membership',
        'title', CASE p_action WHEN 'member.remove' THEN '成员资格已变更' WHEN 'member.mute' THEN '发言权限已变更' ELSE '成员角色已变更' END,
        'summary', reason,
        'targetType', 'system',
        'targetId', 'membership',
        'icon', 'usergroup',
        'createdAt', now_text
      )
    );

    RETURN jsonb_build_object(
      'ok', true,
      'targetUserId', target_user_id,
      'version', actual_version + 1,
      'status', updated->>'status',
      'role', updated->>'role',
      'mutedUntil', updated->'mutedUntil'
    );
  END IF;

  IF p_action = 'appeal.create' THEN
    post_id := p_input->>'postId';
    owner_id := p_input->>'ownerId';
    reason := NULLIF(btrim(p_input->>'reason'), '');
    content_version := NULLIF(p_input->>'contentVersion', '')::integer;
    IF post_id IS NULL OR owner_id IS NULL OR reason IS NULL OR content_version IS NULL THEN
      RAISE EXCEPTION 'INVALID';
    END IF;

    SELECT doc INTO post FROM public.hg_posts WHERE id = post_id FOR UPDATE;
    IF post IS NULL THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
    IF post->>'ownerId' <> owner_id THEN RAISE EXCEPTION 'NOT_OWNER'; END IF;
    IF post->>'status' NOT IN ('hidden', 'rejected') THEN RAISE EXCEPTION 'POST_NOT_APPEALABLE'; END IF;
    IF COALESCE(NULLIF(post->>'version', '')::integer, 1) <> content_version THEN
      RAISE EXCEPTION 'VERSION_CONFLICT';
    END IF;
    IF EXISTS (
      SELECT 1 FROM public.hg_appeals
      WHERE doc->>'postId' = post_id
        AND doc->>'ownerId' = owner_id
        AND doc->>'contentVersion' = content_version::text
    ) THEN
      RAISE EXCEPTION 'APPEAL_EXISTS';
    END IF;

    appeal_id := 'appeal:' || md5(clock_timestamp()::text || random()::text);
    INSERT INTO public.hg_appeals (id, doc) VALUES (
      appeal_id,
      jsonb_build_object(
        '_id', appeal_id,
        'postId', post_id,
        'ownerId', owner_id,
        'contentVersion', content_version,
        'status', 'submitted',
        'reason', reason,
        'version', 1,
        'createdAt', now_text,
        'updatedAt', now_text
      )
    );

    audit_id := 'audit:' || md5(clock_timestamp()::text || random()::text);
    INSERT INTO public.hg_audit_logs (id, doc) VALUES (
      audit_id,
      jsonb_build_object('_id', audit_id, 'actorId', owner_id, 'action', 'appeal.create', 'targetType', 'post', 'targetId', post_id, 'decision', 'submitted', 'reason', reason, 'createdAt', now_text)
    );
    RETURN jsonb_build_object('ok', true, 'appealId', appeal_id, 'state', 'submitted', 'version', 1);
  END IF;

  IF p_action = 'appeal.decide' THEN
    appeal_id := p_input->>'appealId';
    expected_version := NULLIF(p_input->>'expectedVersion', '')::integer;
    decision := p_input->>'decision';
    reason := NULLIF(btrim(p_input->>'reason'), '');
    IF appeal_id IS NULL OR expected_version IS NULL OR reason IS NULL OR decision NOT IN ('approve', 'reject') THEN
      RAISE EXCEPTION 'INVALID';
    END IF;

    SELECT doc INTO appeal FROM public.hg_appeals WHERE id = appeal_id FOR UPDATE;
    IF appeal IS NULL THEN RAISE EXCEPTION 'APPEAL_NOT_FOUND'; END IF;
    IF appeal->>'status' <> 'submitted' THEN RAISE EXCEPTION 'VERSION_CONFLICT'; END IF;
    actual_version := COALESCE(NULLIF(appeal->>'version', '')::integer, 1);
    IF expected_version <> actual_version THEN RAISE EXCEPTION 'VERSION_CONFLICT'; END IF;
    post_id := appeal->>'postId';
    owner_id := appeal->>'ownerId';

    SELECT doc INTO post FROM public.hg_posts WHERE id = post_id FOR UPDATE;
    IF post IS NULL THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
    post_version := COALESCE(NULLIF(post->>'version', '')::integer, 1);
    content_version := COALESCE(NULLIF(appeal->>'contentVersion', '')::integer, 1);
    IF post_version <> content_version OR post->>'status' NOT IN ('hidden', 'rejected') THEN
      RAISE EXCEPTION 'VERSION_CONFLICT';
    END IF;

    IF decision = 'approve' THEN
      updated := post || jsonb_build_object('status', 'published', 'reviewedAt', now_text, 'reviewedBy', p_actor_id, 'updatedAt', now_text, 'version', post_version + 1);
      UPDATE public.hg_posts SET doc = updated WHERE id = post_id;
    END IF;

    updated := appeal || jsonb_build_object(
      'status', CASE decision WHEN 'approve' THEN 'approved' ELSE 'rejected' END,
      'decision', decision,
      'decisionReason', reason,
      'decidedBy', p_actor_id,
      'decidedAt', now_text,
      'updatedAt', now_text,
      'version', actual_version + 1
    );
    UPDATE public.hg_appeals SET doc = updated WHERE id = appeal_id;

    audit_id := 'audit:' || md5(clock_timestamp()::text || random()::text);
    INSERT INTO public.hg_audit_logs (id, doc) VALUES (
      audit_id,
      jsonb_build_object('_id', audit_id, 'actorId', p_actor_id, 'action', 'appeal.' || decision, 'targetType', 'post', 'targetId', post_id, 'decision', decision, 'reason', reason, 'createdAt', now_text)
    );
    notification_id := 'notification:' || md5(clock_timestamp()::text || random()::text);
    INSERT INTO public.hg_notifications (id, doc) VALUES (
      notification_id,
      jsonb_build_object('_id', notification_id, 'recipientId', owner_id, 'eventType', 'system_review', 'title', CASE decision WHEN 'approve' THEN '你的申诉已通过' ELSE '你的申诉未通过' END, 'summary', reason, 'targetType', 'post', 'targetId', post_id, 'icon', CASE decision WHEN 'approve' THEN 'check-circle' ELSE 'error-circle' END, 'createdAt', now_text)
    );
    RETURN jsonb_build_object('ok', true, 'appealId', appeal_id, 'status', updated->>'status', 'postStatus', CASE decision WHEN 'approve' THEN 'published' ELSE post->>'status' END, 'version', actual_version + 1);
  END IF;

  RAISE EXCEPTION 'INVALID';
END;
$$;

REVOKE ALL ON FUNCTION public.hg_governance(text, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.hg_governance(text, text, jsonb) TO service_role;
