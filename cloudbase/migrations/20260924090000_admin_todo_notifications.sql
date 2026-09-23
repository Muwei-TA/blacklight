-- Administrative reminders are generated in the source transaction. No client
-- RPC/table access, no private content, names, invite codes or reporter details.
-- One source version is one event even after worker retries or visibility toggles.
CREATE TABLE public.hg_admin_todo_events (
  queue text NOT NULL CHECK (queue IN ('content','comment','topic','member','report','collection','appeals')),
  source_id text NOT NULL,
  source_version text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (queue, source_id, source_version)
);
ALTER TABLE public.hg_admin_todo_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.hg_admin_todo_events FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.hg_admin_todo_events TO service_role;
CREATE INDEX hg_review_tasks_admin_target_idx ON public.hg_review_tasks
  ((doc->>'targetType'), (doc->>'targetId')) WHERE doc->>'status' IN ('manual','queued');
CREATE INDEX hg_comments_admin_parent_idx ON public.hg_comments
  ((doc->>'postId')) WHERE doc->>'status'='pending';

CREATE FUNCTION public.hg_emit_admin_todo(p_queue text, p_id text, p_notify boolean DEFAULT true)
RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE item jsonb; parent_post jsonb; actionable boolean := false; revision text;
  inserted int; label text; stamp text; recipient text; notification_id text;
BEGIN
  IF p_id IS NULL THEN RETURN; END IF;
  CASE p_queue
    WHEN 'content' THEN
      SELECT doc INTO item FROM hg_posts WHERE id=p_id;
      actionable := item->>'clubId'='heiguang' AND item->>'status'='pending'
        AND item->>'visibility' IN ('public','club') AND EXISTS (
          SELECT 1 FROM hg_review_tasks WHERE doc->>'targetType'='post' AND doc->>'targetId'=p_id
            AND doc->>'status'='manual'
            AND COALESCE(doc->>'postVersion','1')=COALESCE(item->>'version','1'));
      label := '内容人工审核';
    WHEN 'comment' THEN
      SELECT doc INTO item FROM hg_comments WHERE id=p_id;
      SELECT doc INTO parent_post FROM hg_posts WHERE id=item->>'postId';
      actionable := item->>'status'='pending' AND parent_post->>'clubId'='heiguang'
        AND parent_post->>'status'='published' AND parent_post->>'visibility' IN ('public','club')
        AND EXISTS (SELECT 1 FROM hg_review_tasks WHERE doc->>'targetType'='comment'
          AND doc->>'targetId'=p_id AND doc->>'status'='manual'
          AND COALESCE(doc->>'postVersion','1')=COALESCE(item->>'version','1'));
      label := '回应人工审核';
    WHEN 'topic' THEN
      SELECT doc INTO item FROM hg_topics WHERE id=p_id;
      actionable := item->>'clubId'='heiguang' AND item->>'status'='pending';
      label := '话题申请';
    WHEN 'member' THEN
      SELECT doc INTO item FROM hg_membership_applications WHERE id=p_id;
      actionable := item->>'clubId'='heiguang' AND item->>'status'='pending';
      label := '入社申请';
    WHEN 'report' THEN
      SELECT doc INTO item FROM hg_reports WHERE id=p_id;
      actionable := item->>'status'='received';
      label := '举报待核查';
    WHEN 'collection' THEN
      SELECT doc INTO item FROM hg_review_tasks WHERE id=p_id;
      SELECT doc INTO parent_post FROM hg_posts WHERE id=item->>'targetId';
      actionable := item->>'targetType'='collection_submission' AND item->>'status'='queued'
        AND parent_post->>'visibility' IN ('public','club')
        AND EXISTS (SELECT 1 FROM hg_club_config WHERE id='heiguang'
          AND doc#>>'{capabilities,anthology}'='true');
      label := '文集收录申请';
    WHEN 'appeals' THEN
      SELECT doc INTO item FROM hg_appeals WHERE id=p_id;
      actionable := item->>'status'='submitted';
      label := '内容申诉';
    ELSE RAISE EXCEPTION 'INVALID_ADMIN_QUEUE';
  END CASE;
  IF NOT COALESCE(actionable,false) THEN RETURN; END IF;
  revision := COALESCE(NULLIF(item->>'version',''),'1');
  INSERT INTO hg_admin_todo_events(queue,source_id,source_version)
    VALUES(p_queue,p_id,revision) ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS inserted=ROW_COUNT;
  IF inserted=0 OR NOT p_notify THEN RETURN; END IF;
  stamp := to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  FOR recipient IN
    SELECT DISTINCT m.doc->>'userId' FROM hg_memberships m
    JOIN hg_users u ON u.id=m.doc->>'userId' AND u.doc->>'status'='active'
    WHERE m.doc->>'clubId'='heiguang' AND m.doc->>'status'='active'
      AND m.doc->>'role' IN ('admin','moderator')
  LOOP
    notification_id := 'admin-todo:' || md5(jsonb_build_array(p_queue,p_id,revision,recipient)::text);
    INSERT INTO hg_notifications(id,doc) VALUES(notification_id,jsonb_build_object(
      '_id',notification_id,'recipientId',recipient,'eventType','system_notice',
      'title','管理员待办提醒','summary','有新的' || label || '，请前往管理台处理。',
      'targetType',CASE WHEN p_queue='appeals' THEN 'admin_appeals' ELSE 'admin_queue' END,
      'targetId',p_queue,'icon','notification','readAt',NULL,'createdAt',stamp
    )) ON CONFLICT(id) DO NOTHING;
  END LOOP;
END $$;
REVOKE ALL ON FUNCTION public.hg_emit_admin_todo(text,text,boolean) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.hg_emit_admin_todo(text,text,boolean) TO service_role;

CREATE FUNCTION public.hg_admin_todo_changed() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE row_id text; related record;
BEGIN
  row_id := NEW.id;
  CASE TG_TABLE_NAME
    WHEN 'hg_posts' THEN
      PERFORM hg_emit_admin_todo('content',row_id);
      FOR related IN SELECT id FROM hg_comments WHERE doc->>'postId'=row_id AND doc->>'status'='pending' ORDER BY id LOOP
        PERFORM hg_emit_admin_todo('comment',related.id);
      END LOOP;
      FOR related IN SELECT id FROM hg_review_tasks WHERE doc->>'targetType'='collection_submission'
        AND doc->>'targetId'=row_id AND doc->>'status'='queued' ORDER BY id LOOP
        PERFORM hg_emit_admin_todo('collection',related.id);
      END LOOP;
    WHEN 'hg_comments' THEN PERFORM hg_emit_admin_todo('comment',row_id);
    WHEN 'hg_topics' THEN PERFORM hg_emit_admin_todo('topic',row_id);
    WHEN 'hg_membership_applications' THEN PERFORM hg_emit_admin_todo('member',row_id);
    WHEN 'hg_reports' THEN PERFORM hg_emit_admin_todo('report',row_id);
    WHEN 'hg_appeals' THEN PERFORM hg_emit_admin_todo('appeals',row_id);
    WHEN 'hg_review_tasks' THEN
      CASE NEW.doc->>'targetType'
        WHEN 'post' THEN PERFORM hg_emit_admin_todo('content',NEW.doc->>'targetId');
        WHEN 'comment' THEN PERFORM hg_emit_admin_todo('comment',NEW.doc->>'targetId');
        WHEN 'collection_submission' THEN PERFORM hg_emit_admin_todo('collection',row_id);
        ELSE NULL;
      END CASE;
    WHEN 'hg_club_config' THEN
      IF row_id='heiguang' AND NEW.doc#>>'{capabilities,anthology}'='true' THEN
        FOR related IN SELECT id FROM hg_review_tasks WHERE doc->>'targetType'='collection_submission'
          AND doc->>'status'='queued' ORDER BY id LOOP
          PERFORM hg_emit_admin_todo('collection',related.id);
        END LOOP;
      END IF;
    ELSE NULL;
  END CASE;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.hg_admin_todo_changed() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.hg_admin_todo_changed() TO service_role;

-- Baseline existing actionable work without a retrospective notification burst.
-- Table locks make this baseline and trigger installation atomic with writers.
LOCK TABLE hg_posts,hg_comments,hg_topics,hg_membership_applications,hg_reports,
  hg_appeals,hg_review_tasks,hg_club_config IN SHARE ROW EXCLUSIVE MODE;
DO $$
DECLARE spec record; row_id text;
BEGIN
  FOR spec IN SELECT * FROM (VALUES ('content','hg_posts'),('comment','hg_comments'),
    ('topic','hg_topics'),('member','hg_membership_applications'),('report','hg_reports'),
    ('appeals','hg_appeals'),('collection','hg_review_tasks')) AS s(queue,table_name)
  LOOP
    FOR row_id IN EXECUTE format('SELECT id FROM public.%I ORDER BY id',spec.table_name) LOOP
      PERFORM hg_emit_admin_todo(spec.queue,row_id,false);
    END LOOP;
  END LOOP;
  FOR spec IN SELECT unnest(ARRAY['hg_posts','hg_comments','hg_topics','hg_membership_applications',
    'hg_reports','hg_appeals','hg_review_tasks','hg_club_config']) AS table_name LOOP
    EXECUTE format('CREATE TRIGGER admin_todo_changed AFTER INSERT OR UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.hg_admin_todo_changed()',spec.table_name);
  END LOOP;
END $$;
