-- Independent board domain. Topics remain unchanged and posts may carry both
-- topicId and boardId. Apply before deploying the API code that uses boards.

CREATE TABLE public.hg_boards (
  id text PRIMARY KEY,
  doc jsonb NOT NULL CHECK (
    jsonb_typeof(doc) = 'object'
    AND doc->>'_id' = id
    AND COALESCE(doc->>'status', '') IN ('pending', 'active', 'rejected')
  )
);
ALTER TABLE public.hg_boards ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.hg_boards FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.hg_boards TO service_role;
CREATE INDEX hg_boards_created_idx ON public.hg_boards ((doc->>'clubId'), (doc->'createdAt'), id);
CREATE UNIQUE INDEX hg_boards_live_title_idx
  ON public.hg_boards ((doc->>'clubId'), (lower(btrim(doc->>'title'))))
  WHERE doc->>'status' IN ('pending', 'active');
CREATE INDEX hg_posts_board_feed_idx
  ON public.hg_posts ((doc->>'boardId'), (doc->>'status'), (doc->>'visibility'), (doc->'createdAt'))
  WHERE COALESCE(doc->>'boardId', '') <> '';

-- hg_store is the only generic document access path. Extend its explicit
-- table allowlist without changing any existing table contract.
CREATE OR REPLACE FUNCTION public.hg_table(t text) RETURNS text
LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  IF NOT (t = ANY(ARRAY[
    'hg_users','hg_memberships','hg_posts','hg_comments','hg_reactions','hg_bookmarks',
    'hg_topics','hg_boards','hg_topic_follows','hg_collections','hg_collection_entries',
    'hg_consents','hg_assets','hg_notifications','hg_reports','hg_review_tasks',
    'hg_audit_logs','hg_idempotency','hg_anonymous_identities',
    'hg_membership_applications','hg_invite_codes','hg_club_config'
  ])) THEN RAISE EXCEPTION 'invalid table'; END IF;
  RETURN format('public.%I', t);
END $$;
REVOKE ALL ON FUNCTION public.hg_table(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.hg_table(text) TO service_role;

-- Reinstall the latest create-post transaction with a board lock and a second
-- server-side check. Topic validation remains independent in its own path.
CREATE OR REPLACE FUNCTION public.hg_create_post(
  p_key text,
  p_hash text,
  p_post jsonb,
  p_alias jsonb DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE
  existing jsonb;
  ident text := p_post->>'_id';
  owner_id text := p_post->>'ownerId';
  asset_id text;
  asset jsonb;
  board_id text := NULLIF(p_post->>'boardId', '');
  board jsonb;
  result jsonb;
  inserted bigint;
BEGIN
  IF length(p_key)<8 OR length(p_key)>256 OR length(p_hash)<>64 THEN
    RAISE EXCEPTION 'invalid idempotency';
  END IF;
  INSERT INTO hg_idempotency(id,doc)
    VALUES(p_key,jsonb_build_object('_id',p_key,'fingerprint',p_hash,'state','processing','createdAt',p_post->'createdAt'))
    ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS inserted=ROW_COUNT;
  IF inserted=0 THEN
    SELECT doc INTO existing FROM hg_idempotency WHERE id=p_key FOR UPDATE;
    IF existing->>'fingerprint' IS DISTINCT FROM p_hash THEN RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT'; END IF;
    IF existing->>'state'<>'succeeded' THEN RAISE EXCEPTION 'IDEMPOTENCY_PROCESSING'; END IF;
    RETURN existing->'result';
  END IF;

  IF board_id IS NOT NULL THEN
    IF p_post->>'visibility'='private' THEN RAISE EXCEPTION 'PRIVATE_BOARD'; END IF;
    SELECT doc INTO board FROM hg_boards WHERE id=board_id FOR UPDATE;
    IF board IS NULL OR board->>'clubId' IS DISTINCT FROM p_post->>'clubId'
       OR board->>'status' IS DISTINCT FROM 'active'
       OR NOT EXISTS (
         SELECT 1 FROM hg_memberships
         WHERE doc->>'userId'=owner_id AND doc->>'clubId'=p_post->>'clubId'
           AND doc->>'status'='active'
       ) THEN
      RAISE EXCEPTION 'BOARD_NOT_AVAILABLE';
    END IF;
  END IF;

  FOR asset_id IN SELECT jsonb_array_elements_text(p_post->'assetIds') ORDER BY 1 LOOP
    SELECT doc INTO asset FROM hg_assets WHERE id=asset_id FOR UPDATE;
    IF asset IS NULL OR asset->>'ownerId' IS DISTINCT FROM owner_id OR asset->>'status'<>'verified'
       OR COALESCE(asset->>'postId','')<>'' OR asset->>'cleanupState'='running' THEN
      RAISE EXCEPTION 'ASSET_BINDING_CONFLICT';
    END IF;
    UPDATE hg_assets SET doc=doc || jsonb_build_object('postId',ident,'postVersion',1,'updatedAt',p_post->'createdAt')
      WHERE id=asset_id;
  END LOOP;
  INSERT INTO hg_posts(id,doc) VALUES(ident,p_post);
  IF p_alias IS NOT NULL THEN INSERT INTO hg_anonymous_identities(id,doc) VALUES(p_alias->>'_id',p_alias); END IF;
  IF p_post->>'visibility'<>'private' THEN
    INSERT INTO hg_review_tasks(id,doc) VALUES('review:'||ident,jsonb_build_object(
      '_id','review:'||ident,'targetType','post','targetId',ident,'postVersion',1,
      'status','queued','attempts',0,'needsMedia',jsonb_array_length(p_post->'assetIds')>0,
      'createdAt',p_post->'createdAt'));
  END IF;
  result:=jsonb_build_object('id',ident,'version',1,
    'state',CASE WHEN p_post->>'visibility'='private' THEN 'private_saved' ELSE 'pending' END);
  UPDATE hg_idempotency SET doc=doc || jsonb_build_object(
    'state','succeeded','result',result,'completedAt',p_post->'createdAt') WHERE id=p_key;
  RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.hg_create_post(text,text,jsonb,jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.hg_create_post(text,text,jsonb,jsonb) TO service_role;

-- Create boards atomically. The normalized-title advisory lock serializes
-- same-name requests; hidden pending board identifiers never leave this RPC.
CREATE FUNCTION public.hg_create_board(p_actor_id text, p_board jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE
  membership jsonb;
  existing jsonb;
  normalized_title text;
  club_id text := 'heiguang';
  status text;
  new_doc jsonb;
  audit_id text;
BEGIN
  IF p_actor_id IS NULL OR p_actor_id='' OR p_board IS NULL
     OR jsonb_typeof(p_board)<>'object' THEN RAISE EXCEPTION 'INVALID'; END IF;
  normalized_title := lower(btrim(COALESCE(p_board->>'title','')));
  IF normalized_title='' OR char_length(btrim(COALESCE(p_board->>'title','')))>40
     OR char_length(COALESCE(p_board->>'description',''))>200 THEN RAISE EXCEPTION 'INVALID'; END IF;

  SELECT doc INTO membership FROM hg_memberships
    WHERE doc->>'userId'=p_actor_id AND doc->>'clubId'=club_id FOR UPDATE;
  IF membership IS NULL OR membership->>'status' IS DISTINCT FROM 'active' THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
  status := CASE WHEN membership->>'role' IN ('admin','moderator') THEN 'active' ELSE 'pending' END;

  PERFORM pg_advisory_xact_lock(hashtext('hg_boards:'||club_id), hashtext(normalized_title));
  SELECT doc INTO existing FROM hg_boards
    WHERE doc->>'clubId'=club_id
      AND lower(btrim(doc->>'title'))=normalized_title
      AND doc->>'status' IN ('pending','active')
    ORDER BY CASE WHEN doc->>'status'='active' THEN 0
      WHEN doc->>'ownerId'=p_actor_id THEN 1 ELSE 2 END, id
    LIMIT 1 FOR UPDATE;
  IF existing IS NOT NULL THEN
    IF existing->>'status'='active' OR existing->>'ownerId'=p_actor_id THEN
      RETURN jsonb_build_object('duplicated',true,'id',existing->>'_id','status',existing->>'status');
    END IF;
    RAISE EXCEPTION 'BOARD_NAME_CONFLICT';
  END IF;

  new_doc := jsonb_build_object(
    '_id',p_board->>'_id','clubId',club_id,'ownerId',p_actor_id,
    'title',btrim(p_board->>'title'),'description',btrim(COALESCE(p_board->>'description','')),
    'status',status,
    'createdAt',COALESCE(p_board->'createdAt',to_jsonb(to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))),
    'updatedAt',COALESCE(p_board->'updatedAt',to_jsonb(to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))),
    'version',1);
  IF COALESCE(new_doc->>'_id','')='' THEN RAISE EXCEPTION 'INVALID'; END IF;
  INSERT INTO hg_boards(id,doc) VALUES(new_doc->>'_id',new_doc);
  IF status='active' THEN
    audit_id := 'audit:board:create:'||md5(clock_timestamp()::text||random()::text);
    INSERT INTO hg_audit_logs(id,doc) VALUES(audit_id,jsonb_build_object(
      '_id',audit_id,'actorId',p_actor_id,'action','board.create','targetType','board',
      'targetId',new_doc->>'_id','decision','create','reason','',
      'toVersion',1,'createdAt',new_doc->'createdAt'));
  END IF;
  RETURN jsonb_build_object('duplicated',false,'id',new_doc->>'_id','status',status);
END $$;
REVOKE ALL ON FUNCTION public.hg_create_board(text,jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.hg_create_board(text,jsonb) TO service_role;

-- Board decisions lock the pending record, enforce role/version, and write
-- status + audit in one transaction. The RPC is distinct from topic review.
CREATE FUNCTION public.hg_decide_board(p_actor_id text, p_input jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE
  membership jsonb;
  board jsonb;
  updated jsonb;
  result jsonb;
  board_id text := p_input->>'id';
  decision text := p_input->>'decision';
  reason text := COALESCE(NULLIF(btrim(p_input->>'reason'),''),'');
  expected_version integer := NULLIF(p_input->>'expectedVersion','')::integer;
  actual_version integer;
  next_status text;
  audit_id text;
  now_text text := to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
BEGIN
  IF p_actor_id IS NULL OR p_actor_id='' OR board_id IS NULL OR board_id=''
     OR expected_version IS NULL OR expected_version<1
     OR decision IS NULL OR decision NOT IN ('approve','reject') THEN RAISE EXCEPTION 'INVALID'; END IF;
  IF decision='reject' AND reason='' THEN RAISE EXCEPTION 'REASON_REQUIRED'; END IF;

  SELECT doc INTO membership FROM hg_memberships
    WHERE doc->>'userId'=p_actor_id AND doc->>'clubId'='heiguang' FOR UPDATE;
  IF membership IS NULL OR membership->>'status' IS DISTINCT FROM 'active'
     OR COALESCE(membership->>'role','') NOT IN ('admin','moderator') THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;

  SELECT doc INTO board FROM hg_boards WHERE id=board_id FOR UPDATE;
  IF board IS NULL OR board->>'clubId' IS DISTINCT FROM 'heiguang' THEN RAISE EXCEPTION 'BOARD_NOT_FOUND'; END IF;
  actual_version := COALESCE(NULLIF(board->>'version','')::integer,1);
  IF actual_version<>expected_version THEN
    IF actual_version=expected_version+1
       AND board->>'boardDecisionExpectedVersion'=expected_version::text
       AND board->>'boardDecision'=decision
       AND board->'boardDecisionResult' IS NOT NULL THEN
      RETURN board->'boardDecisionResult';
    END IF;
    RAISE EXCEPTION 'VERSION_CONFLICT';
  END IF;
  IF board->>'status' IS DISTINCT FROM 'pending' THEN RAISE EXCEPTION 'BOARD_ALREADY_DECIDED'; END IF;

  next_status := CASE decision WHEN 'approve' THEN 'active' ELSE 'rejected' END;
  result := jsonb_build_object('ok',true,'status',next_status,'version',actual_version+1);
  updated := board || jsonb_build_object(
    'status',next_status,'version',actual_version+1,'updatedAt',now_text,
    'boardDecisionExpectedVersion',expected_version,'boardDecision',decision,
    'boardDecisionReason',reason,'boardDecisionResult',result,
    'decidedBy',p_actor_id,'decidedAt',now_text,
    'rejectReason',CASE WHEN decision='reject' THEN reason ELSE '' END);
  UPDATE hg_boards SET doc=updated WHERE id=board_id;

  audit_id := 'audit:board:'||md5(clock_timestamp()::text||random()::text);
  INSERT INTO hg_audit_logs(id,doc) VALUES(audit_id,jsonb_build_object(
    '_id',audit_id,'actorId',p_actor_id,'action','board.decide','targetType','board',
    'targetId',board_id,'decision',decision,'reason',reason,
    'fromVersion',actual_version,'toVersion',actual_version+1,'createdAt',now_text));
  RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.hg_decide_board(text,jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.hg_decide_board(text,jsonb) TO service_role;
