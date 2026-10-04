-- Versioned website article drafts. Only the service role can access raw docs.
CREATE TABLE public.hg_article_drafts (
  id text PRIMARY KEY,
  doc jsonb NOT NULL
);
ALTER TABLE public.hg_article_drafts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.hg_article_drafts FROM PUBLIC,anon,authenticated;
GRANT ALL ON public.hg_article_drafts TO service_role;
CREATE POLICY rich_draft_service_only ON public.hg_article_drafts FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE INDEX hg_article_drafts_owner ON public.hg_article_drafts ((doc->>'clubId'),(doc->>'ownerId'),(doc->>'updatedAt'));

CREATE FUNCTION public.hg_article_draft(p_operation text,p_actor text,p_club_id text,p_input jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE d jsonb; a jsonb; p jsonb; cfg jsonb; member jsonb; aid text; ident text:=p_input->>'id';
  now_text text:=to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  result jsonb; post_id text; task_id text; v int; old_ids jsonb; new_ids jsonb;
BEGIN
  member:=public.hg_require_club_membership(p_actor,p_club_id,NULL,'share');
  IF p_operation='list' THEN
    RETURN COALESCE((SELECT jsonb_agg(doc ORDER BY doc->>'updatedAt' DESC,id DESC) FROM
      (SELECT id,doc FROM hg_article_drafts WHERE doc->>'clubId'=p_club_id AND doc->>'ownerId'=p_actor
      AND doc->>'status'='draft' ORDER BY doc->>'updatedAt' DESC,id DESC LIMIT 100) q),'[]'::jsonb);
  END IF;
  IF p_operation='save' AND ident IS NULL THEN
    ident:=gen_random_uuid()::text;
    d:=jsonb_build_object('_id',ident,'ownerId',p_actor,'clubId',p_club_id,'status','draft','version',0,'createdAt',now_text,'assetIds','[]'::jsonb);
  ELSE
    SELECT doc INTO d FROM hg_article_drafts WHERE id=ident AND doc->>'clubId'=p_club_id AND doc->>'ownerId'=p_actor FOR UPDATE;
    IF d IS NULL THEN RAISE EXCEPTION 'DRAFT_NOT_FOUND'; END IF;
  END IF;
  IF p_operation='get' THEN RETURN d; END IF;
  IF p_operation IN ('submit','resubmit') AND d->>'status'='submitted' THEN
    IF d->>'submitKey'=p_input->>'idempotencyKey' AND (p_operation='resubmit' OR d->>'submitVersion'=p_input->>'expectedVersion') AND (p_operation='submit' OR (d->'submitResult'->>'id'=p_input->>'postId' AND d->>'submitPostVersion'=p_input->>'postVersion')) THEN RETURN d->'submitResult'; END IF;
    RAISE EXCEPTION 'VERSION_CONFLICT';
  END IF;
  IF d->>'status'<>'draft' OR (d->>'version')::int<>COALESCE((p_input->>'expectedVersion')::int,0) THEN RAISE EXCEPTION 'VERSION_CONFLICT'; END IF;
  IF p_operation='delete' THEN
    UPDATE hg_assets SET doc=doc||jsonb_build_object('draftId','','updatedAt',now_text)
      WHERE doc->>'draftId'=ident AND doc->>'clubId'=p_club_id;
    DELETE FROM hg_article_drafts WHERE id=ident;
    RETURN jsonb_build_object('ok',true);
  END IF;
  IF p_operation='save' THEN
    IF p_input ? 'sourcePostId' THEN
      SELECT doc INTO p FROM hg_posts WHERE id=p_input->>'sourcePostId' AND doc->>'clubId'=p_club_id AND doc->>'ownerId'=p_actor FOR UPDATE;
      IF p IS NULL OR p->>'format' IS DISTINCT FROM 'richtext-v1' OR p->>'status'<>'rejected' OR p->>'version' IS DISTINCT FROM p_input->>'sourcePostVersion' OR (d ? 'sourcePostVersion' AND d->>'sourcePostVersion' IS DISTINCT FROM p->>'version') OR (d ? 'sourcePostId' AND d->>'sourcePostId' IS DISTINCT FROM p->>'_id') THEN RAISE EXCEPTION 'VERSION_CONFLICT'; END IF;
      d:=d||jsonb_build_object('sourcePostId',p->>'_id','sourcePostVersion',p->'version');
    END IF;
    new_ids:=p_input->'assetIds';
    FOR aid IN SELECT jsonb_array_elements_text(new_ids) ORDER BY 1 LOOP
      SELECT doc INTO a FROM hg_assets WHERE id=aid FOR UPDATE;
      IF a IS NULL OR a->>'clubId' IS DISTINCT FROM p_club_id OR a->>'ownerId' IS DISTINCT FROM p_actor
        OR (a->>'draftId'=ident OR (NULLIF(d->>'sourcePostId','') IS NOT NULL AND a->>'postId'=d->>'sourcePostId' AND COALESCE(a->>'draftId','')='')) IS NOT TRUE
        OR (COALESCE(a->>'postId','')<>'' AND a->>'postId' IS DISTINCT FROM d->>'sourcePostId')
        OR COALESCE(a->>'status','') NOT IN ('uploaded','verified') OR a->>'cleanupState'='running' THEN RAISE EXCEPTION 'ASSET_BINDING_CONFLICT'; END IF;
      UPDATE hg_assets SET doc=doc||jsonb_build_object('draftId',ident) WHERE id=aid;
    END LOOP;
    -- Only images previously referenced by the document are detached. An upload
    -- in flight is reserved by draftId and remains available for the next save.
    UPDATE hg_assets SET doc=doc||jsonb_build_object('draftId','','updatedAt',now_text)
      WHERE doc->>'draftId'=ident AND doc->>'clubId'=p_club_id
      AND id IN (SELECT jsonb_array_elements_text(COALESCE(d->'assetIds','[]'::jsonb)))
      AND NOT new_ids ? id;
    d:=d||(p_input-ARRAY['id','expectedVersion'])||jsonb_build_object('version',(d->>'version')::int+1,'updatedAt',now_text);
    INSERT INTO hg_article_drafts(id,doc) VALUES(ident,d) ON CONFLICT(id) DO UPDATE SET doc=EXCLUDED.doc;
    RETURN d;
  END IF;
  IF p_operation NOT IN ('submit','resubmit') THEN RAISE EXCEPTION 'INVALID'; END IF;
  SELECT doc INTO cfg FROM hg_club_config WHERE id=p_club_id;
  IF COALESCE((cfg->'capabilities'->>'publishing')::boolean,false) IS NOT TRUE
    OR NULLIF(member->>'mutedUntil','')::timestamptz>clock_timestamp() THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
  IF length(btrim(d->>'title'))=0 OR (length(btrim(d->>'body'))=0 AND jsonb_array_length(d->'assetIds')=0) THEN RAISE EXCEPTION 'INVALID'; END IF;
  IF jsonb_array_length(d->'assetIds')>0 AND COALESCE((cfg->'capabilities'->>'uploads')::boolean,false) IS NOT TRUE THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
  IF p_operation='submit' AND NULLIF(d->>'sourcePostId','') IS NOT NULL THEN RAISE EXCEPTION 'INVALID'; END IF;
  IF p_operation='resubmit' THEN
    post_id:=p_input->>'postId';
    SELECT doc INTO p FROM hg_posts WHERE id=post_id AND doc->>'clubId'=p_club_id FOR UPDATE;
    IF p IS NULL OR p->>'ownerId' IS DISTINCT FROM p_actor OR p->>'format' IS DISTINCT FROM 'richtext-v1' OR d->>'sourcePostId' IS DISTINCT FROM post_id THEN RAISE EXCEPTION 'DRAFT_NOT_FOUND'; END IF;
    IF p->>'status'<>'rejected' OR p->>'version' IS DISTINCT FROM p_input->>'postVersion' OR d->>'sourcePostVersion' IS DISTINCT FROM p->>'version' THEN RAISE EXCEPTION 'VERSION_CONFLICT'; END IF;
    old_ids:=p->'assetIds'; v:=(p->>'version')::int+1;
    -- Audience, identity, topic and board remain fixed on resubmission.
    p:=p||(d-ARRAY['_id','ownerId','clubId','settings','createdAt','status','version'])||jsonb_build_object('version',v,'status','pending','rejectReason','','updatedAt',now_text);
  ELSE
    post_id:=p_input->>'postId'; v:=1; old_ids:='[]'::jsonb;
    IF d->'settings'->>'visibility' NOT IN ('club','private') THEN RAISE EXCEPTION 'INVALID'; END IF;
    p:=(d-ARRAY['_id','settings','status','version'])||(d->'settings')||jsonb_build_object('_id',post_id,'kind','article','category','article','categoryText','文章',
      'version',v,'reactionCount',0,'commentCount',0,'hasVideo',false,'status',CASE WHEN d->'settings'->>'visibility'='private' THEN 'published' ELSE 'pending' END,'createdAt',now_text,'updatedAt',now_text);
  END IF;
  IF p->>'visibility'='private' AND (NULLIF(p->>'topicId','') IS NOT NULL OR NULLIF(p->>'boardId','') IS NOT NULL) THEN RAISE EXCEPTION 'INVALID'; END IF;
  IF NULLIF(p->>'topicId','') IS NOT NULL AND NOT EXISTS(SELECT 1 FROM hg_topics WHERE id=p->>'topicId' AND doc->>'clubId'=p_club_id AND doc->>'status'='active') THEN RAISE EXCEPTION 'TOPIC_NOT_AVAILABLE'; END IF;
  IF NULLIF(p->>'boardId','') IS NOT NULL AND (p->>'visibility'='private' OR NOT EXISTS(SELECT 1 FROM hg_boards WHERE id=p->>'boardId' AND doc->>'clubId'=p_club_id AND doc->>'status'='active')) THEN RAISE EXCEPTION 'BOARD_NOT_AVAILABLE'; END IF;
  FOR aid IN SELECT jsonb_array_elements_text(d->'assetIds') ORDER BY 1 LOOP
    SELECT doc INTO a FROM hg_assets WHERE id=aid FOR UPDATE;
    IF a IS NULL OR a->>'clubId' IS DISTINCT FROM p_club_id OR a->>'ownerId' IS DISTINCT FROM p_actor
      OR a->>'draftId' IS DISTINCT FROM ident OR (COALESCE(a->>'postId','')<>'' AND a->>'postId' IS DISTINCT FROM d->>'sourcePostId') OR COALESCE(a->>'status','') NOT IN ('uploaded','verified')
      OR a->>'cleanupState'='running' OR NULLIF(a->>'fileId','') IS NULL OR a->>'cleanedMimeType' IS DISTINCT FROM 'image/jpeg'
      THEN RAISE EXCEPTION 'ASSET_BINDING_CONFLICT'; END IF;
    UPDATE hg_assets SET doc=doc||jsonb_build_object('draftId','','postId',post_id,'postVersion',v,'updatedAt',now_text) WHERE id=aid;
  END LOOP;
  UPDATE hg_assets SET doc=doc||jsonb_build_object('postId','','postVersion',0,'updatedAt',now_text)
    WHERE id IN (SELECT jsonb_array_elements_text(old_ids)) AND NOT (d->'assetIds') ? id AND doc->>'clubId'=p_club_id AND doc->>'postId'=post_id;
  INSERT INTO hg_posts(id,doc) VALUES(post_id,p) ON CONFLICT(id) DO UPDATE SET doc=EXCLUDED.doc;
  IF p_operation='submit' AND p_input->'alias' IS NOT NULL AND p_input->'alias'<>'null'::jsonb THEN
    INSERT INTO hg_anonymous_identities(id,doc) VALUES(p_input->'alias'->>'_id',p_input->'alias');
  END IF;
  IF p->>'visibility'<>'private' THEN
    task_id:='review:'||post_id||':rich:'||v::text;
    INSERT INTO hg_review_tasks(id,doc) VALUES(task_id,jsonb_build_object('_id',task_id,'clubId',p_club_id,'targetType','post','targetId',post_id,'postVersion',v,
      'status','manual','reviewMode','rich-manual','attempts',0,'needsMedia',jsonb_array_length(d->'assetIds')>0,'createdAt',now_text));
  END IF;
  UPDATE hg_assets SET doc=doc||jsonb_build_object('draftId','','updatedAt',now_text) WHERE doc->>'draftId'=ident AND doc->>'clubId'=p_club_id;
  result:=jsonb_build_object('id',post_id,'version',v,'state',CASE WHEN p->>'visibility'='private' THEN 'private_saved' ELSE 'pending' END);
  UPDATE hg_article_drafts SET doc=doc||jsonb_build_object('status','submitted','submitKey',p_input->>'idempotencyKey','submitVersion',p_input->'expectedVersion','submitResult',result,'submitPostVersion',p_input->'postVersion','updatedAt',now_text) WHERE id=ident;
  RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.hg_article_draft(text,text,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.hg_article_draft(text,text,text,jsonb) TO service_role;

ALTER FUNCTION public.hg_image_intent(text,text,text,jsonb) RENAME TO hg_image_intent_pre_rich;
CREATE FUNCTION public.hg_image_intent(p_owner text,p_club_id text,p_key text,p_asset jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE d jsonb; result jsonb; a jsonb;
BEGIN
  IF NULLIF(p_asset->>'draftId','') IS NOT NULL THEN
    SELECT doc INTO d FROM hg_article_drafts WHERE id=p_asset->>'draftId' AND doc->>'ownerId'=p_owner AND doc->>'clubId'=p_club_id FOR UPDATE;
    IF d IS NULL OR d->>'status'<>'draft' THEN RAISE EXCEPTION 'IMAGE_CONFLICT'; END IF;
  END IF;
  result:=public.hg_image_intent_pre_rich(p_owner,p_club_id,p_key,p_asset);
  SELECT doc INTO a FROM hg_assets WHERE id=result->>'assetId';
  IF COALESCE(a->>'draftId','') IS DISTINCT FROM COALESCE(p_asset->>'draftId','') THEN RAISE EXCEPTION 'IMAGE_CONFLICT'; END IF;
  RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.hg_image_intent(text,text,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.hg_image_intent(text,text,text,jsonb) TO service_role;

ALTER FUNCTION public.hg_cleanup_asset(text,text,text,jsonb,jsonb) RENAME TO hg_cleanup_asset_pre_rich;
CREATE FUNCTION public.hg_cleanup_asset(p_club_id text,p_asset_id text,p_action text,p_expected jsonb,p_patch jsonb DEFAULT '{}'::jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE a jsonb;
BEGIN
  SELECT doc INTO a FROM hg_assets WHERE id=p_asset_id AND doc->>'clubId'=p_club_id FOR UPDATE;
  IF p_action IN ('claim','remove_orphan') AND a->>'status'<>'revoked' AND NULLIF(a->>'draftId','') IS NOT NULL
    AND EXISTS(SELECT 1 FROM hg_article_drafts WHERE id=a->>'draftId' AND doc->>'status'='draft' AND doc->>'clubId'=p_club_id AND doc->>'ownerId'=a->>'ownerId' AND (doc->'assetIds') ? p_asset_id) THEN
    RETURN jsonb_build_object('stats',jsonb_build_object('updated',0,'removed',0));
  END IF;
  IF p_action IN ('claim','remove_orphan') AND NULLIF(a->>'uploadLeaseUntil','')::timestamptz>clock_timestamp() THEN
    RETURN jsonb_build_object('stats',jsonb_build_object('updated',0,'removed',0));
  END IF;
  RETURN public.hg_cleanup_asset_pre_rich(p_club_id,p_asset_id,p_action,p_expected,p_patch);
END $$;
REVOKE ALL ON FUNCTION public.hg_cleanup_asset(text,text,text,jsonb,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.hg_cleanup_asset(text,text,text,jsonb,jsonb) TO service_role;

ALTER FUNCTION public.hg_moderate(text,text,jsonb,text) RENAME TO hg_moderate_pre_rich;
CREATE FUNCTION public.hg_moderate(p_action text,p_actor_id text,p_input jsonb,p_club_id text) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE p jsonb; a jsonb; aid text; task jsonb;
BEGIN
  IF p_action='content.decide' AND p_input->>'decision'='approve' THEN
    PERFORM public.hg_require_club_membership(p_actor_id,p_club_id,ARRAY['moderator','admin'],'update');
    SELECT doc INTO task FROM hg_review_tasks WHERE doc->>'clubId'=p_club_id AND doc->>'targetId'=p_input->>'id'
      AND doc->>'targetType'='post' AND doc->>'postVersion'=p_input->>'expectedVersion' AND doc->>'status'='manual'
      ORDER BY doc->>'createdAt' DESC,id DESC LIMIT 1 FOR UPDATE;
    SELECT doc INTO p FROM hg_posts WHERE id=p_input->>'id' AND doc->>'clubId'=p_club_id FOR UPDATE;
    IF p->>'format'='richtext-v1' THEN
      IF p->>'status'<>'pending' OR p->>'version' IS DISTINCT FROM p_input->>'expectedVersion' OR p->>'visibility'='private'
        OR task->>'reviewMode' IS DISTINCT FROM 'rich-manual' THEN RAISE EXCEPTION 'VERSION_CONFLICT'; END IF;
      FOR aid IN SELECT jsonb_array_elements_text(p->'assetIds') ORDER BY 1 LOOP
        SELECT doc INTO a FROM hg_assets WHERE id=aid FOR UPDATE;
        IF a IS NULL OR a->>'clubId' IS DISTINCT FROM p_club_id OR a->>'ownerId' IS DISTINCT FROM p->>'ownerId'
          OR a->>'postId' IS DISTINCT FROM p->>'_id' OR a->>'postVersion' IS DISTINCT FROM p->>'version'
          OR COALESCE(a->>'status','') NOT IN ('uploaded','verified') OR a->>'cleanupState'='running'
          OR NULLIF(a->>'fileId','') IS NULL OR a->>'cleanedMimeType' IS DISTINCT FROM 'image/jpeg' THEN RAISE EXCEPTION 'PENDING_MEDIA'; END IF;
        UPDATE hg_assets SET doc=doc||jsonb_build_object('status','verified','verifiedAt',clock_timestamp(),'verifiedBy',p_actor_id) WHERE id=aid;
      END LOOP;
    END IF;
  END IF;
  RETURN public.hg_moderate_pre_rich(p_action,p_actor_id,p_input,p_club_id);
END $$;
REVOKE ALL ON FUNCTION public.hg_moderate(text,text,jsonb,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.hg_moderate(text,text,jsonb,text) TO service_role;


-- Filter live references before LIMIT so long-lived drafts cannot starve orphan cleanup.
CREATE FUNCTION public.hg_orphan_asset_candidates(p_club_id text) RETURNS jsonb
LANGUAGE sql SECURITY INVOKER SET search_path=public,pg_temp AS $$
  SELECT COALESCE(jsonb_agg(q.doc),'[]'::jsonb) FROM (
    SELECT a.doc FROM hg_assets a WHERE a.doc->>'clubId'=p_club_id
      AND COALESCE(a.doc->>'postId','')=''
      AND a.doc->>'status' IN ('intent','uploaded','verifying','verified','rejected','failed')
      AND NULLIF(a.doc->>'createdAt','')::timestamptz<clock_timestamp()-interval '24 hours'
      AND (NULLIF(a.doc->>'uploadLeaseUntil','') IS NULL OR (a.doc->>'uploadLeaseUntil')::timestamptz<=clock_timestamp())
      AND NOT EXISTS(SELECT 1 FROM hg_article_drafts d WHERE d.id=a.doc->>'draftId'
        AND d.doc->>'clubId'=p_club_id AND d.doc->>'ownerId'=a.doc->>'ownerId'
        AND d.doc->>'status'='draft' AND (d.doc->'assetIds') ? a.id)
    ORDER BY a.doc->>'createdAt',a.id LIMIT 50
  ) q
$$;
REVOKE ALL ON FUNCTION public.hg_orphan_asset_candidates(text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.hg_orphan_asset_candidates(text) TO service_role;
