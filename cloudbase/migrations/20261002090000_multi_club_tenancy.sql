-- Multi-club tenancy. Existing records with no explicit club belonged to the
-- only supported club, heiguang; new writes always carry an explicit clubId.
ALTER TABLE public.hg_user_xp_accounts ADD COLUMN club_id text;
ALTER TABLE public.hg_user_xp_accounts DROP CONSTRAINT hg_user_xp_accounts_pkey;
UPDATE public.hg_user_xp_accounts SET club_id = 'heiguang' WHERE club_id IS NULL;
ALTER TABLE public.hg_user_xp_accounts ALTER COLUMN club_id SET NOT NULL;
ALTER TABLE public.hg_user_xp_accounts ADD PRIMARY KEY (user_id, club_id);

ALTER TABLE public.hg_user_xp_events ADD COLUMN club_id text;
UPDATE public.hg_user_xp_events SET club_id = 'heiguang' WHERE club_id IS NULL;
ALTER TABLE public.hg_user_xp_events ALTER COLUMN club_id SET NOT NULL;

DROP INDEX public.hg_user_xp_events_check_in_once_idx;
DROP INDEX public.hg_user_xp_events_reaction_once_idx;
DROP INDEX public.hg_user_xp_events_comment_once_idx;
DROP INDEX public.hg_user_xp_events_comment_post_day_idx;
CREATE UNIQUE INDEX hg_user_xp_events_check_in_once_idx
  ON public.hg_user_xp_events (club_id, user_id, business_date)
  WHERE event_type = 'check_in';
CREATE UNIQUE INDEX hg_user_xp_events_reaction_once_idx
  ON public.hg_user_xp_events (club_id, user_id, source_id)
  WHERE event_type = 'reaction';
CREATE UNIQUE INDEX hg_user_xp_events_comment_once_idx
  ON public.hg_user_xp_events (club_id, user_id, source_id)
  WHERE event_type = 'comment_approved';
CREATE UNIQUE INDEX hg_user_xp_events_comment_post_day_idx
  ON public.hg_user_xp_events (club_id, user_id, source_post_id, business_date)
  WHERE event_type = 'comment_approved';
CREATE INDEX hg_user_xp_events_club_user_day_idx
  ON public.hg_user_xp_events (club_id, user_id, business_date, event_type);

-- Backfill relation rows while preserving all existing IDs and business data.
UPDATE public.hg_club_config
SET doc = doc || jsonb_build_object(
  'status', COALESCE(doc->>'status', 'active'),
  'discoverable', COALESCE((doc->>'discoverable')::boolean, false),
  'name', COALESCE(NULLIF(doc->>'name', ''), CASE WHEN id='heiguang' THEN '黑光文学社' ELSE id END)
);
UPDATE public.hg_comments AS c SET doc = c.doc || jsonb_build_object('clubId', COALESCE(p.doc->>'clubId', 'heiguang'))
FROM public.hg_posts AS p WHERE p.id = c.doc->>'postId' AND NULLIF(c.doc->>'clubId', '') IS NULL;
UPDATE public.hg_reactions AS r SET doc = r.doc || jsonb_build_object('clubId', COALESCE(p.doc->>'clubId', 'heiguang'))
FROM public.hg_posts AS p WHERE p.id = r.doc->>'postId' AND NULLIF(r.doc->>'clubId', '') IS NULL;
UPDATE public.hg_bookmarks AS b SET doc = b.doc || jsonb_build_object('clubId', COALESCE(p.doc->>'clubId', 'heiguang'))
FROM public.hg_posts AS p WHERE p.id = b.doc->>'postId' AND NULLIF(b.doc->>'clubId', '') IS NULL;
UPDATE public.hg_topic_follows AS f SET doc = f.doc || jsonb_build_object('clubId', COALESCE(t.doc->>'clubId', 'heiguang'))
FROM public.hg_topics AS t WHERE t.id = f.doc->>'topicId' AND NULLIF(f.doc->>'clubId', '') IS NULL;
UPDATE public.hg_collection_entries AS e SET doc = e.doc || jsonb_build_object('clubId', COALESCE(c.doc->>'clubId', 'heiguang'))
FROM public.hg_collections AS c WHERE c.id = e.doc->>'collectionId' AND NULLIF(e.doc->>'clubId', '') IS NULL;
UPDATE public.hg_anonymous_identities AS a SET doc = a.doc || jsonb_build_object('clubId', COALESCE(p.doc->>'clubId', 'heiguang'))
FROM public.hg_posts AS p WHERE p.id = COALESCE(a.doc->>'threadId', a.doc->>'postId') AND NULLIF(a.doc->>'clubId', '') IS NULL;
UPDATE public.hg_anonymous_identities AS a SET doc = a.doc || jsonb_build_object('clubId', COALESCE(p.doc->>'clubId', 'heiguang'))
FROM public.hg_comments AS c JOIN public.hg_posts AS p ON p.id = c.doc->>'postId'
WHERE c.id = a.doc->>'commentId' AND NULLIF(a.doc->>'clubId', '') IS NULL;
UPDATE public.hg_reports SET doc = doc || jsonb_build_object('clubId', 'heiguang') WHERE NULLIF(doc->>'clubId', '') IS NULL;
UPDATE public.hg_notifications SET doc = doc || jsonb_build_object('clubId', 'heiguang') WHERE NULLIF(doc->>'clubId', '') IS NULL;
UPDATE public.hg_review_tasks SET doc = doc || jsonb_build_object('clubId', 'heiguang') WHERE NULLIF(doc->>'clubId', '') IS NULL;
UPDATE public.hg_audit_logs SET doc = doc || jsonb_build_object('clubId', 'heiguang') WHERE NULLIF(doc->>'clubId', '') IS NULL;
UPDATE public.hg_idempotency SET doc = doc || jsonb_build_object('clubId', 'heiguang') WHERE NULLIF(doc->>'clubId', '') IS NULL;
UPDATE public.hg_consents SET doc = doc || jsonb_build_object('clubId', 'heiguang') WHERE NULLIF(doc->>'clubId', '') IS NULL;
UPDATE public.hg_assets SET doc = doc || jsonb_build_object('clubId', 'heiguang') WHERE NULLIF(doc->>'clubId', '') IS NULL;
UPDATE public.hg_appeals SET doc = doc || jsonb_build_object('clubId', 'heiguang') WHERE NULLIF(doc->>'clubId', '') IS NULL;

CREATE INDEX hg_comments_club_post_created_idx ON public.hg_comments ((doc->>'clubId'), (doc->>'postId'), (doc->'createdAt'));
CREATE INDEX hg_reactions_club_user_post_idx ON public.hg_reactions ((doc->>'clubId'), (doc->>'userId'), (doc->>'postId'));
CREATE INDEX hg_bookmarks_club_user_post_idx ON public.hg_bookmarks ((doc->>'clubId'), (doc->>'userId'), (doc->>'postId'));
CREATE INDEX hg_notifications_club_recipient_created_idx ON public.hg_notifications ((doc->>'clubId'), (doc->>'recipientId'), (doc->'createdAt'));
CREATE INDEX hg_review_tasks_club_status_created_idx ON public.hg_review_tasks ((doc->>'clubId'), (doc->>'status'), (doc->'createdAt'));
CREATE INDEX hg_reports_club_status_created_idx ON public.hg_reports ((doc->>'clubId'), (doc->>'status'), (doc->'createdAt'));
CREATE INDEX hg_audit_logs_club_created_idx ON public.hg_audit_logs ((doc->>'clubId'), (doc->'createdAt'));
CREATE INDEX hg_appeals_club_status_created_idx ON public.hg_appeals ((doc->>'clubId'), (doc->>'status'), (doc->'createdAt'));

CREATE OR REPLACE FUNCTION public.hg_require_club_membership(
  p_actor_id text, p_club_id text, p_roles text[] DEFAULT NULL, p_lock text DEFAULT 'share'
) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE member jsonb;
  actor_user jsonb;
  club_doc jsonb;
BEGIN
  IF NULLIF(p_actor_id, '') IS NULL OR NULLIF(p_club_id, '') IS NULL THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
  SELECT doc INTO actor_user FROM public.hg_users WHERE id=p_actor_id FOR SHARE;
  IF actor_user IS NULL OR actor_user->>'status' IS DISTINCT FROM 'active' THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
  SELECT doc INTO club_doc FROM public.hg_club_config WHERE id=p_club_id FOR SHARE;
  IF club_doc IS NULL OR COALESCE(club_doc->>'status','active') IS DISTINCT FROM 'active' THEN RAISE EXCEPTION 'CLUB_PAUSED'; END IF;
  IF p_lock='update' THEN
    SELECT doc INTO member FROM public.hg_memberships
    WHERE doc->>'userId'=p_actor_id AND doc->>'clubId'=p_club_id FOR UPDATE;
  ELSE
    SELECT doc INTO member FROM public.hg_memberships
    WHERE doc->>'userId'=p_actor_id AND doc->>'clubId'=p_club_id FOR SHARE;
  END IF;
  IF member IS NULL OR member->>'status' IS DISTINCT FROM 'active'
     OR (p_roles IS NOT NULL AND NOT (member->>'role'=ANY(p_roles))) THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
  RETURN member;
END $$;
REVOKE ALL ON FUNCTION public.hg_require_club_membership(text,text,text[],text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.hg_require_club_membership(text,text,text[],text) TO service_role;

-- p_club_id is mandatory for every club-owned collection. The global account
-- table and the public club directory are the only unscoped read paths.
CREATE OR REPLACE FUNCTION public.hg_store(
  p_table text, p_op text, p_query jsonb, p_data jsonb, p_order jsonb, p_limit int, p_club_id text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE t text; w text; ordering text := ''; item jsonb; result jsonb; n bigint; ident text; row_doc jsonb; club_status text;
BEGIN
  t := public.hg_table(p_table);
  IF p_limit < 1 OR p_limit > 1000 THEN RAISE EXCEPTION 'invalid limit'; END IF;
  IF p_table='hg_users' THEN
    w := public.hg_filter(p_query);
  ELSIF p_table='hg_club_config' AND p_club_id IS NULL THEN
    IF p_op NOT IN ('get','count') THEN RAISE EXCEPTION 'CLUB_REQUIRED'; END IF;
    w := '('||public.hg_filter(p_query)||') AND doc->>'||quote_literal('status')||'='||quote_literal('active')
      ||' AND doc->>'||quote_literal('discoverable')||'='||quote_literal('true');
  ELSE
    IF NULLIF(p_club_id,'') IS NULL OR length(p_club_id)>64 THEN RAISE EXCEPTION 'CLUB_REQUIRED'; END IF;
    SELECT COALESCE(doc->>'status','active') INTO club_status FROM public.hg_club_config WHERE id=p_club_id;
    IF club_status IS NULL THEN RAISE EXCEPTION 'CLUB_NOT_FOUND'; END IF;
    IF p_table<>'hg_club_config' AND p_op IN ('add','update','remove') AND club_status<>'active' THEN RAISE EXCEPTION 'CLUB_PAUSED'; END IF;
    w := public.hg_filter(p_query);
    IF p_table='hg_club_config' THEN
      w := format('(%s) AND id = %L',w,p_club_id);
    ELSE
      w := format('(%s) AND COALESCE(doc->>''clubId'',''heiguang'') = %L',w,p_club_id);
    END IF;
  END IF;
  FOR item IN SELECT * FROM jsonb_array_elements(p_order) LOOP
    ordering := ordering || CASE WHEN ordering='' THEN ' ORDER BY ' ELSE ', ' END || public.hg_field(item->>0)
      || CASE WHEN item->>1='asc' THEN ' ASC' ELSE ' DESC' END;
  END LOOP;
  IF p_op='get' THEN
    EXECUTE format('SELECT COALESCE(jsonb_agg(doc), ''[]''::jsonb) FROM (SELECT doc FROM %s WHERE %s%s LIMIT %s) rows',t,w,ordering,p_limit) INTO result;
    RETURN jsonb_build_object('data',result);
  ELSIF p_op='count' THEN
    EXECUTE format('SELECT count(*) FROM %s WHERE %s',t,w) INTO n;
    RETURN jsonb_build_object('total',n);
  ELSIF p_op='add' THEN
    ident:=p_data->>'_id';
    IF ident IS NULL OR length(ident)>256 THEN RAISE EXCEPTION 'invalid id'; END IF;
    row_doc := p_data;
    IF p_table NOT IN ('hg_users') THEN
      IF p_table='hg_club_config' AND p_club_id IS NULL THEN RAISE EXCEPTION 'CLUB_REQUIRED'; END IF;
      IF p_table<>'hg_club_config' AND p_data ? 'clubId' AND p_data->>'clubId' IS DISTINCT FROM p_club_id THEN RAISE EXCEPTION 'CLUB_MISMATCH'; END IF;
      IF p_table<>'hg_club_config' THEN row_doc := p_data||jsonb_build_object('clubId',p_club_id); END IF;
    END IF;
    EXECUTE format('INSERT INTO %s(id,doc) VALUES($1,$2)',t) USING ident,row_doc;
    RETURN jsonb_build_object('_id',ident);
  ELSIF p_op='update' THEN
    IF p_query='{}'::jsonb THEN RAISE EXCEPTION 'unbounded update'; END IF;
    IF p_table NOT IN ('hg_users','hg_club_config') AND p_data ? 'clubId'
       AND p_data->>'clubId' IS DISTINCT FROM p_club_id THEN RAISE EXCEPTION 'CLUB_MISMATCH'; END IF;
    EXECUTE format('UPDATE %s SET doc=public.hg_patch(doc,$1) WHERE %s',t,w) USING p_data;
    GET DIAGNOSTICS n = ROW_COUNT; RETURN jsonb_build_object('stats',jsonb_build_object('updated',n));
  ELSIF p_op='remove' THEN
    IF p_query='{}'::jsonb THEN RAISE EXCEPTION 'unbounded delete'; END IF;
    EXECUTE format('DELETE FROM %s WHERE %s',t,w);
    GET DIAGNOSTICS n = ROW_COUNT; RETURN jsonb_build_object('stats',jsonb_build_object('removed',n));
  END IF;
  RAISE EXCEPTION 'unsupported operation';
END $$;
REVOKE ALL ON FUNCTION public.hg_store(text,text,jsonb,jsonb,jsonb,int,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.hg_store(text,text,jsonb,jsonb,jsonb,int,text) TO service_role;
CREATE OR REPLACE FUNCTION public.hg_store(
  p_table text, p_op text, p_query jsonb DEFAULT '{}', p_data jsonb DEFAULT '{}',
  p_order jsonb DEFAULT '[]', p_limit int DEFAULT 100
) RETURNS jsonb LANGUAGE sql SECURITY INVOKER SET search_path=public,pg_temp AS $$
  SELECT public.hg_store(p_table,p_op,p_query,p_data,p_order,p_limit,'heiguang')
$$;
REVOKE ALL ON FUNCTION public.hg_store(text,text,jsonb,jsonb,jsonb,int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.hg_store(text,text,jsonb,jsonb,jsonb,int) TO service_role;

-- Cleanup is the only write path allowed to touch revoked or old, unbound
-- assets in a paused club. Its action and patch allowlists keep ownership and
-- post associations immutable while the worker performs conditional retries.
CREATE FUNCTION public.hg_cleanup_asset(
  p_club_id text,p_asset_id text,p_action text,p_expected jsonb,p_patch jsonb DEFAULT '{}'::jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE asset jsonb; expected_key text; expected_value jsonb; matches boolean:=true; row_count int;
  asset_created_at timestamptz; cleanup_status text; allowed_patch text[]; next_attempt timestamptz; claimed_at timestamptz;
BEGIN
  IF NULLIF(p_club_id,'') IS NULL OR NULLIF(p_asset_id,'') IS NULL
     OR p_action NOT IN ('claim','retry','remove_orphan','purge')
     OR jsonb_typeof(p_expected) IS DISTINCT FROM 'object' OR jsonb_typeof(p_patch) IS DISTINCT FROM 'object'
     OR p_expected='{}'::jsonb
     OR p_expected-ARRAY['status','postId','cleanupState','cleanupClaimedAt','cleanupNextAttemptAt','createdAt',
       'ownerId','fileId','cleanedFileId','reservedFileId']<>'{}'::jsonb THEN
    RAISE EXCEPTION 'CLEANUP_INVALID';
  END IF;
  IF EXISTS(SELECT 1 FROM jsonb_each(p_expected) e
    WHERE (jsonb_typeof(e.value)='object' AND e.value<>'{"$missing":true}'::jsonb)
       OR jsonb_typeof(e.value) NOT IN ('string','number','boolean','null','object')) THEN
    RAISE EXCEPTION 'CLEANUP_INVALID';
  END IF;
  IF NOT (p_expected ? 'status' AND p_expected ? 'postId' AND p_expected ? 'cleanupState'
      AND p_expected ? 'cleanupClaimedAt' AND p_expected ? 'cleanupNextAttemptAt'
      AND p_expected ? 'createdAt' AND p_expected ? 'ownerId' AND p_expected ? 'fileId'
      AND p_expected ? 'cleanedFileId' AND p_expected ? 'reservedFileId') THEN
    RAISE EXCEPTION 'CLEANUP_INVALID';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM hg_club_config WHERE id=p_club_id) THEN RAISE EXCEPTION 'CLUB_NOT_FOUND'; END IF;
  SELECT doc INTO asset FROM hg_assets WHERE id=p_asset_id AND doc->>'clubId'=p_club_id FOR UPDATE;
  IF asset IS NULL THEN
    RETURN jsonb_build_object('stats',jsonb_build_object(CASE WHEN p_action='remove_orphan' THEN 'removed' ELSE 'updated' END,0));
  END IF;
  FOR expected_key IN SELECT jsonb_object_keys(p_expected) LOOP
    expected_value:=p_expected->expected_key;
    IF expected_value='{"$missing":true}'::jsonb THEN
      IF asset ? expected_key THEN matches:=false; EXIT; END IF;
    ELSIF asset->expected_key IS DISTINCT FROM expected_value THEN
      matches:=false; EXIT;
    END IF;
  END LOOP;
  IF NOT matches THEN
    RETURN jsonb_build_object('stats',jsonb_build_object(CASE WHEN p_action='remove_orphan' THEN 'removed' ELSE 'updated' END,0));
  END IF;

  IF p_action='remove_orphan' THEN
    IF p_patch<>'{}'::jsonb OR NOT (p_expected ? 'createdAt')
       OR COALESCE(asset->>'postId','')<>''
       OR asset->>'cleanupState'<>'running'
       OR asset->>'status' NOT IN ('intent','uploaded','verifying','verified','rejected','failed') THEN
      RETURN jsonb_build_object('stats',jsonb_build_object('removed',0));
    END IF;
    BEGIN asset_created_at:=NULLIF(asset->>'createdAt','')::timestamptz;
    EXCEPTION WHEN invalid_text_representation OR datetime_field_overflow THEN asset_created_at:=NULL; END;
    IF asset_created_at IS NULL OR asset_created_at>clock_timestamp()-interval '24 hours' THEN
      RETURN jsonb_build_object('stats',jsonb_build_object('removed',0));
    END IF;
    DELETE FROM hg_assets WHERE id=p_asset_id AND doc->>'clubId'=p_club_id;
    GET DIAGNOSTICS row_count=ROW_COUNT;
    RETURN jsonb_build_object('stats',jsonb_build_object('removed',row_count));
  END IF;

  cleanup_status:=asset->>'status';
  IF cleanup_status<>'revoked' THEN
    IF COALESCE(asset->>'postId','')<>'' OR cleanup_status NOT IN ('intent','uploaded','verifying','verified','rejected','failed') THEN
      RETURN jsonb_build_object('stats',jsonb_build_object('updated',0));
    END IF;
    BEGIN asset_created_at:=NULLIF(asset->>'createdAt','')::timestamptz;
    EXCEPTION WHEN invalid_text_representation OR datetime_field_overflow THEN asset_created_at:=NULL; END;
    IF asset_created_at IS NULL OR asset_created_at>clock_timestamp()-interval '24 hours' THEN
      RETURN jsonb_build_object('stats',jsonb_build_object('updated',0));
    END IF;
  END IF;

  IF p_action='claim' THEN
    IF NULLIF(asset->>'cleanupNextAttemptAt','') IS NOT NULL THEN
      BEGIN next_attempt:=(asset->>'cleanupNextAttemptAt')::timestamptz;
      EXCEPTION WHEN invalid_text_representation OR datetime_field_overflow THEN
        RETURN jsonb_build_object('stats',jsonb_build_object('updated',0)); END;
      IF next_attempt>clock_timestamp() THEN RETURN jsonb_build_object('stats',jsonb_build_object('updated',0)); END IF;
    END IF;
    IF asset->>'cleanupState'='running' AND NULLIF(asset->>'cleanupClaimedAt','') IS NOT NULL THEN
      BEGIN claimed_at:=(asset->>'cleanupClaimedAt')::timestamptz;
      EXCEPTION WHEN invalid_text_representation OR datetime_field_overflow THEN
        RETURN jsonb_build_object('stats',jsonb_build_object('updated',0)); END;
      IF claimed_at>clock_timestamp()-interval '5 minutes' THEN
        RETURN jsonb_build_object('stats',jsonb_build_object('updated',0));
      END IF;
    END IF;
    allowed_patch:=ARRAY['cleanupState','cleanupClaimedAt','cleanupLastError','updatedAt'];
    IF NOT (p_patch ?& ARRAY['cleanupState','cleanupClaimedAt','cleanupLastError','updatedAt'])
       OR p_patch-allowed_patch<>'{}'::jsonb OR p_patch->'cleanupState' IS DISTINCT FROM '"running"'::jsonb
       OR p_patch->'cleanupLastError' IS DISTINCT FROM '""'::jsonb
       OR jsonb_typeof(p_patch->'cleanupClaimedAt') IS DISTINCT FROM 'string'
       OR jsonb_typeof(p_patch->'updatedAt') IS DISTINCT FROM 'string' THEN
      RAISE EXCEPTION 'CLEANUP_INVALID';
    END IF;
  ELSIF p_action='retry' THEN
    allowed_patch:=ARRAY['cleanupState','cleanupAttempts','cleanupLastError','cleanupNextAttemptAt','cleanupClaimedAt','updatedAt'];
    IF asset->>'cleanupState'<>'running'
       OR NOT (p_patch ?& ARRAY['cleanupState','cleanupAttempts','cleanupLastError','cleanupNextAttemptAt','cleanupClaimedAt','updatedAt'])
       OR p_patch-allowed_patch<>'{}'::jsonb OR p_patch->'cleanupState' IS DISTINCT FROM '"retryable"'::jsonb
       OR jsonb_typeof(p_patch->'cleanupAttempts') IS DISTINCT FROM 'number'
       OR (p_patch->>'cleanupAttempts')::numeric<1 OR trunc((p_patch->>'cleanupAttempts')::numeric)<>(p_patch->>'cleanupAttempts')::numeric
       OR p_patch->'cleanupClaimedAt' IS DISTINCT FROM 'null'::jsonb
       OR jsonb_typeof(p_patch->'cleanupLastError') IS DISTINCT FROM 'string'
       OR length(p_patch->>'cleanupLastError')>300
       OR jsonb_typeof(p_patch->'cleanupNextAttemptAt') NOT IN ('string','null')
       OR jsonb_typeof(p_patch->'updatedAt') IS DISTINCT FROM 'string' THEN RAISE EXCEPTION 'CLEANUP_INVALID'; END IF;
  ELSE
    allowed_patch:=ARRAY['fileId','cleanedFileId','reservedFileId','cloudPath','tempFileURL','status','cleanupState',
      'cleanupLastError','cleanupNextAttemptAt','cleanupClaimedAt','purgedAt','updatedAt'];
    IF cleanup_status<>'revoked' OR asset->>'cleanupState'<>'running'
       OR NOT (p_patch ?& ARRAY['fileId','cleanedFileId','reservedFileId','cloudPath','tempFileURL','status','cleanupState',
         'cleanupLastError','cleanupNextAttemptAt','cleanupClaimedAt','purgedAt','updatedAt'])
       OR p_patch-allowed_patch<>'{}'::jsonb OR p_patch->'status' IS DISTINCT FROM '"purged"'::jsonb
       OR p_patch->'cleanupState' IS DISTINCT FROM '"done"'::jsonb OR p_patch->'cleanupLastError' IS DISTINCT FROM '""'::jsonb
       OR p_patch->'cleanupNextAttemptAt' IS DISTINCT FROM 'null'::jsonb OR p_patch->'cleanupClaimedAt' IS DISTINCT FROM 'null'::jsonb
       OR p_patch->'fileId' IS DISTINCT FROM '""'::jsonb OR p_patch->'cleanedFileId' IS DISTINCT FROM '""'::jsonb
       OR p_patch->'reservedFileId' IS DISTINCT FROM '""'::jsonb OR p_patch->'cloudPath' IS DISTINCT FROM '""'::jsonb
       OR p_patch->'tempFileURL' IS DISTINCT FROM '""'::jsonb OR jsonb_typeof(p_patch->'purgedAt') IS DISTINCT FROM 'string'
       OR jsonb_typeof(p_patch->'updatedAt') IS DISTINCT FROM 'string' THEN
      RAISE EXCEPTION 'CLEANUP_INVALID';
    END IF;
  END IF;

  UPDATE hg_assets SET doc=doc||p_patch WHERE id=p_asset_id AND doc->>'clubId'=p_club_id;
  GET DIAGNOSTICS row_count=ROW_COUNT;
  RETURN jsonb_build_object('stats',jsonb_build_object('updated',row_count));
END $$;
REVOKE ALL ON FUNCTION public.hg_cleanup_asset(text,text,text,jsonb,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.hg_cleanup_asset(text,text,text,jsonb,jsonb) TO service_role;

CREATE FUNCTION public.hg_user_clubs(p_actor_id text) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE items jsonb;
BEGIN
  IF NULLIF(p_actor_id,'') IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.hg_users WHERE id=p_actor_id AND doc->>'status'='active'
  ) THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
  SELECT COALESCE(jsonb_agg(item ORDER BY item->>'name',item->>'clubId'),'[]'::jsonb) INTO items FROM (
    SELECT jsonb_build_object('clubId',m.doc->>'clubId','name',COALESCE(c.doc->>'name',m.doc->>'clubId'),
      'description',COALESCE(c.doc->>'description',''),'status',COALESCE(c.doc->>'status','active'),
      'discoverable',COALESCE((c.doc->>'discoverable')::boolean,false),'role',m.doc->>'role','memberStatus','active') AS item
    FROM public.hg_memberships m JOIN public.hg_club_config c ON c.id=m.doc->>'clubId'
    WHERE m.doc->>'userId'=p_actor_id AND m.doc->>'status'='active'
    UNION ALL
    SELECT jsonb_build_object('clubId',a.doc->>'clubId','name',COALESCE(c.doc->>'name',a.doc->>'clubId'),
      'description',COALESCE(c.doc->>'description',''),'status',COALESCE(c.doc->>'status','active'),
      'discoverable',COALESCE((c.doc->>'discoverable')::boolean,false),'role',NULL,'memberStatus','pending')
    FROM public.hg_membership_applications a JOIN public.hg_club_config c ON c.id=a.doc->>'clubId'
    WHERE a.doc->>'userId'=p_actor_id AND a.doc->>'status'='pending' AND NOT EXISTS(
      SELECT 1 FROM public.hg_memberships m WHERE m.doc->>'userId'=p_actor_id AND m.doc->>'clubId'=a.doc->>'clubId' AND m.doc->>'status'='active')
    UNION ALL
    SELECT jsonb_build_object('clubId',m.doc->>'clubId','name',COALESCE(c.doc->>'name',m.doc->>'clubId'),
      'status',COALESCE(c.doc->>'status','active'),'role',NULL,'memberStatus','removed')
    FROM public.hg_memberships m JOIN public.hg_club_config c ON c.id=m.doc->>'clubId'
    WHERE m.doc->>'userId'=p_actor_id AND m.doc->>'status'='removed'
      AND NOT EXISTS(SELECT 1 FROM public.hg_memberships active
        WHERE active.doc->>'userId'=p_actor_id AND active.doc->>'clubId'=m.doc->>'clubId' AND active.doc->>'status'='active')
      AND NOT EXISTS(SELECT 1 FROM public.hg_membership_applications pending
        WHERE pending.doc->>'userId'=p_actor_id AND pending.doc->>'clubId'=m.doc->>'clubId' AND pending.doc->>'status'='pending')
    UNION ALL
    SELECT jsonb_build_object('clubId',a.doc->>'clubId','name',COALESCE(c.doc->>'name',a.doc->>'clubId'),
      'status',COALESCE(c.doc->>'status','active'),'role',NULL,'memberStatus','rejected')
    FROM public.hg_membership_applications a JOIN public.hg_club_config c ON c.id=a.doc->>'clubId'
    WHERE a.doc->>'userId'=p_actor_id AND a.doc->>'status'='rejected'
      AND NOT EXISTS(SELECT 1 FROM public.hg_memberships m
        WHERE m.doc->>'userId'=p_actor_id AND m.doc->>'clubId'=a.doc->>'clubId' AND m.doc->>'status'='active')
      AND NOT EXISTS(SELECT 1 FROM public.hg_memberships removed
        WHERE removed.doc->>'userId'=p_actor_id AND removed.doc->>'clubId'=a.doc->>'clubId' AND removed.doc->>'status'='removed')
      AND NOT EXISTS(SELECT 1 FROM public.hg_membership_applications pending
        WHERE pending.doc->>'userId'=p_actor_id AND pending.doc->>'clubId'=a.doc->>'clubId' AND pending.doc->>'status'='pending')
  ) clubs;
  RETURN jsonb_build_object('items',items);
END $$;
REVOKE ALL ON FUNCTION public.hg_user_clubs(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.hg_user_clubs(text) TO service_role;

CREATE FUNCTION public.hg_all_club_ids() RETURNS jsonb
LANGUAGE sql SECURITY INVOKER SET search_path=public,pg_temp AS $$
  SELECT jsonb_build_object('items',COALESCE(jsonb_agg(jsonb_build_object('clubId',id,'status',doc->>'status') ORDER BY id),'[]'::jsonb))
  FROM public.hg_club_config
$$;
REVOKE ALL ON FUNCTION public.hg_all_club_ids() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.hg_all_club_ids() TO service_role;

CREATE FUNCTION public.hg_create_post(
  p_key text, p_hash text, p_post jsonb, p_alias jsonb, p_club_id text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE existing jsonb; ident text:=p_post->>'_id'; owner_id text:=p_post->>'ownerId';
  asset_id text; asset jsonb; board_id text:=NULLIF(p_post->>'boardId',''); board jsonb;
  result jsonb; inserted int; idem_key text;
BEGIN
  IF NULLIF(p_club_id,'') IS NULL OR p_post->>'clubId' IS DISTINCT FROM p_club_id
     OR NULLIF(ident,'') IS NULL OR NULLIF(owner_id,'') IS NULL
     OR p_key IS NULL OR length(p_key)<8 OR length(p_key)>256 OR p_hash IS NULL OR length(p_hash)<>64
     OR split_part(p_key,':',1) IS DISTINCT FROM owner_id THEN RAISE EXCEPTION 'INVALID'; END IF;
  PERFORM public.hg_require_club_membership(owner_id,p_club_id,NULL,'share');
  idem_key:=CASE WHEN p_club_id='heiguang' THEN p_key ELSE 'club:'||p_club_id||':'||md5(p_key) END;
  INSERT INTO hg_idempotency(id,doc) VALUES(idem_key,jsonb_build_object(
    '_id',idem_key,'clubId',p_club_id,'actorId',owner_id,'fingerprint',p_hash,'state','processing','createdAt',p_post->'createdAt'))
    ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS inserted=ROW_COUNT;
  IF inserted=0 THEN
    SELECT doc INTO existing FROM hg_idempotency WHERE id=idem_key FOR UPDATE;
    IF existing IS NULL AND p_club_id='heiguang' THEN
      SELECT doc INTO existing FROM hg_idempotency WHERE id=p_key AND COALESCE(doc->>'clubId','heiguang')='heiguang' FOR UPDATE;
      IF existing IS NOT NULL THEN idem_key:=p_key; END IF;
    END IF;
    IF existing->>'fingerprint' IS DISTINCT FROM p_hash OR COALESCE(existing->>'actorId',split_part(p_key,':',1)) IS DISTINCT FROM owner_id
       OR COALESCE(existing->>'clubId','heiguang') IS DISTINCT FROM p_club_id THEN RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT'; END IF;
    IF existing->>'state'<>'succeeded' THEN RAISE EXCEPTION 'IDEMPOTENCY_PROCESSING'; END IF;
    RETURN existing->'result';
  END IF;
  IF board_id IS NOT NULL THEN
    IF p_post->>'visibility'='private' THEN RAISE EXCEPTION 'PRIVATE_BOARD'; END IF;
    SELECT doc INTO board FROM hg_boards WHERE id=board_id FOR UPDATE;
    IF board IS NULL OR board->>'clubId' IS DISTINCT FROM p_club_id OR board->>'status'<>'active' THEN
      RAISE EXCEPTION 'BOARD_NOT_AVAILABLE';
    END IF;
  END IF;
  IF NULLIF(p_post->>'topicId','') IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM hg_topics WHERE id=p_post->>'topicId' AND doc->>'clubId'=p_club_id AND doc->>'status'='active'
  ) THEN RAISE EXCEPTION 'TOPIC_NOT_AVAILABLE'; END IF;
  FOR asset_id IN SELECT jsonb_array_elements_text(COALESCE(p_post->'assetIds','[]'::jsonb)) ORDER BY 1 LOOP
    SELECT doc INTO asset FROM hg_assets WHERE id=asset_id FOR UPDATE;
    IF asset IS NULL OR asset->>'clubId' IS DISTINCT FROM p_club_id
       OR asset->>'ownerId' IS DISTINCT FROM owner_id OR asset->>'status'<>'verified'
       OR COALESCE(asset->>'postId','')<>'' OR asset->>'cleanupState'='running' THEN
      RAISE EXCEPTION 'ASSET_BINDING_CONFLICT';
    END IF;
    UPDATE hg_assets SET doc=asset||jsonb_build_object('postId',ident,'postVersion',1,'updatedAt',p_post->'createdAt') WHERE id=asset_id;
  END LOOP;
  INSERT INTO hg_posts(id,doc) VALUES(ident,p_post);
  IF p_alias IS NOT NULL THEN
    INSERT INTO hg_anonymous_identities(id,doc) VALUES(p_alias->>'_id',p_alias||jsonb_build_object('clubId',p_club_id));
  END IF;
  IF p_post->>'visibility'<>'private' THEN
    INSERT INTO hg_review_tasks(id,doc) VALUES('review:'||ident,jsonb_build_object(
      '_id','review:'||ident,'clubId',p_club_id,'targetType','post','targetId',ident,'postVersion',1,
      'status','queued','attempts',0,'needsMedia',jsonb_array_length(COALESCE(p_post->'assetIds','[]'::jsonb))>0,
      'createdAt',p_post->'createdAt'));
  END IF;
  result:=jsonb_build_object('id',ident,'version',1,'state',CASE WHEN p_post->>'visibility'='private' THEN 'private_saved' ELSE 'pending' END);
  UPDATE hg_idempotency SET doc=doc||jsonb_build_object('state','succeeded','result',result,'completedAt',p_post->'createdAt') WHERE id=idem_key;
  RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.hg_create_post(text,text,jsonb,jsonb,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.hg_create_post(text,text,jsonb,jsonb,text) TO service_role;
CREATE OR REPLACE FUNCTION public.hg_create_post(p_key text,p_hash text,p_post jsonb,p_alias jsonb DEFAULT NULL) RETURNS jsonb
LANGUAGE sql SECURITY INVOKER SET search_path=public,pg_temp AS $$
  SELECT public.hg_create_post(p_key,p_hash,p_post||jsonb_build_object('clubId','heiguang'),p_alias,'heiguang')
$$;

CREATE FUNCTION public.hg_create_comment(
  p_key text,p_hash text,p_comment jsonb,p_alias jsonb,p_club_id text
) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE existing jsonb; post jsonb; parent jsonb; result jsonb; inserted int; ident text:=p_comment->>'_id'; idem_key text; comment_doc jsonb;
BEGIN
  IF NULLIF(p_club_id,'') IS NULL OR NULLIF(ident,'') IS NULL OR p_key IS NULL
     OR (p_comment ? 'clubId' AND p_comment->>'clubId' IS DISTINCT FROM p_club_id)
     OR length(p_key)<8 OR length(p_hash)<>64 OR split_part(p_key,':',1) IS DISTINCT FROM p_comment->>'ownerId' THEN RAISE EXCEPTION 'INVALID'; END IF;
  PERFORM public.hg_require_club_membership(p_comment->>'ownerId',p_club_id,NULL,'share');
  idem_key:=CASE WHEN p_club_id='heiguang' THEN p_key ELSE 'club:'||p_club_id||':'||md5(p_key) END;
  INSERT INTO hg_idempotency(id,doc) VALUES(idem_key,jsonb_build_object(
    '_id',idem_key,'clubId',p_club_id,'actorId',p_comment->>'ownerId','fingerprint',p_hash,'state','processing','createdAt',p_comment->'createdAt')) ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS inserted=ROW_COUNT;
  IF inserted=0 THEN
    SELECT doc INTO existing FROM hg_idempotency WHERE id=idem_key FOR UPDATE;
    IF existing IS NULL AND p_club_id='heiguang' THEN
      SELECT doc INTO existing FROM hg_idempotency WHERE id=p_key AND COALESCE(doc->>'clubId','heiguang')='heiguang' FOR UPDATE;
      IF existing IS NOT NULL THEN idem_key:=p_key; END IF;
    END IF;
    IF existing->>'fingerprint' IS DISTINCT FROM p_hash OR COALESCE(existing->>'actorId',split_part(p_key,':',1)) IS DISTINCT FROM p_comment->>'ownerId'
       OR COALESCE(existing->>'clubId','heiguang') IS DISTINCT FROM p_club_id THEN RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT'; END IF;
    IF existing->>'state'<>'succeeded' THEN RAISE EXCEPTION 'IDEMPOTENCY_PROCESSING'; END IF;
    RETURN existing->'result';
  END IF;
  SELECT doc INTO post FROM hg_posts WHERE id=p_comment->>'postId' FOR UPDATE;
  IF post IS NULL OR post->>'clubId' IS DISTINCT FROM p_club_id OR post->>'status'<>'published'
     OR post->>'visibility'='private' OR post->'commentsEnabled'='false'::jsonb THEN RAISE EXCEPTION 'COMMENT_TARGET_CHANGED'; END IF;
  IF NULLIF(p_comment->>'replyToId','') IS NOT NULL THEN
    SELECT doc INTO parent FROM hg_comments WHERE id=p_comment->>'replyToId' FOR UPDATE;
    IF parent IS NULL OR parent->>'clubId' IS DISTINCT FROM p_club_id
       OR parent->>'postId' IS DISTINCT FROM p_comment->>'postId' OR parent->>'status'<>'published' THEN
      RAISE EXCEPTION 'COMMENT_TARGET_CHANGED';
    END IF;
  END IF;
  comment_doc:=p_comment||jsonb_build_object('clubId',p_club_id);
  INSERT INTO hg_comments(id,doc) VALUES(ident,comment_doc);
  IF p_alias IS NOT NULL THEN
    INSERT INTO hg_anonymous_identities(id,doc) VALUES(p_alias->>'_id',p_alias||jsonb_build_object('clubId',p_club_id)) ON CONFLICT DO NOTHING;
  END IF;
  INSERT INTO hg_review_tasks(id,doc) VALUES('comment-review:'||ident,jsonb_build_object(
    '_id','comment-review:'||ident,'clubId',p_club_id,'targetType','comment','targetId',ident,
    'postVersion',1,'status','queued','attempts',0,'needsMedia',false,'createdAt',p_comment->'createdAt'));
  result:=jsonb_build_object('id',ident,'state','pending');
  UPDATE hg_idempotency SET doc=doc||jsonb_build_object('state','succeeded','result',result,'completedAt',p_comment->'createdAt') WHERE id=idem_key;
  RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.hg_create_comment(text,text,jsonb,jsonb,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.hg_create_comment(text,text,jsonb,jsonb,text) TO service_role;
CREATE OR REPLACE FUNCTION public.hg_create_comment(p_key text,p_hash text,p_comment jsonb,p_alias jsonb DEFAULT NULL) RETURNS jsonb
LANGUAGE sql SECURITY INVOKER SET search_path=public,pg_temp AS $$
  SELECT public.hg_create_comment(p_key,p_hash,p_comment||jsonb_build_object('clubId','heiguang'),p_alias,'heiguang')
$$;

CREATE FUNCTION public.hg_toggle_reaction(
  p_actor_id text,p_post_id text,p_comment_id text,p_next boolean,p_club_id text
) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE post_doc jsonb; target_doc jsonb; relation_id text; relation_doc jsonb; changed int; delta int; counter int;
  stamp text:=to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
BEGIN
  IF NULLIF(p_actor_id,'') IS NULL OR NULLIF(p_club_id,'') IS NULL OR p_next IS NULL THEN RAISE EXCEPTION 'REACTION_TARGET_CHANGED'; END IF;
  PERFORM public.hg_require_club_membership(p_actor_id,p_club_id,NULL,'share');
  SELECT doc INTO post_doc FROM hg_posts WHERE id=p_post_id FOR UPDATE;
  IF post_doc IS NULL OR post_doc->>'clubId' IS DISTINCT FROM p_club_id OR post_doc->>'status'<>'published'
     OR COALESCE(post_doc->>'visibility','') NOT IN ('club','public') THEN RAISE EXCEPTION 'REACTION_TARGET_CHANGED'; END IF;
  IF p_comment_id IS NULL THEN target_doc:=post_doc;
  ELSE
    SELECT doc INTO target_doc FROM hg_comments WHERE id=p_comment_id FOR UPDATE;
    IF target_doc IS NULL OR target_doc->>'clubId' IS DISTINCT FROM p_club_id
       OR target_doc->>'status'<>'published' OR target_doc->>'postId' IS DISTINCT FROM p_post_id THEN
      RAISE EXCEPTION 'REACTION_TARGET_CHANGED';
    END IF;
  END IF;
  relation_id:=CASE WHEN p_comment_id IS NULL THEN p_actor_id||':'||p_post_id ELSE p_actor_id||':comment:'||p_comment_id END;
  IF p_next THEN
    relation_doc:=jsonb_build_object('_id',relation_id,'clubId',p_club_id,'userId',p_actor_id,'postId',p_post_id,'type','resonance','createdAt',stamp);
    IF p_comment_id IS NOT NULL THEN relation_doc:=relation_doc||jsonb_build_object('commentId',p_comment_id); END IF;
    INSERT INTO hg_reactions(id,doc) VALUES(relation_id,relation_doc) ON CONFLICT DO NOTHING;
    GET DIAGNOSTICS changed=ROW_COUNT; delta:=changed;
  ELSE
    DELETE FROM hg_reactions WHERE id=relation_id AND COALESCE(doc->>'clubId','heiguang')=p_club_id;
    GET DIAGNOSTICS changed=ROW_COUNT; delta:=-changed;
  END IF;
  counter:=greatest(0,coalesce((target_doc->>'reactionCount')::integer,0)+delta);
  IF changed>0 THEN
    IF p_comment_id IS NULL THEN UPDATE hg_posts SET doc=doc||jsonb_build_object('reactionCount',counter) WHERE id=p_post_id AND doc->>'clubId'=p_club_id;
    ELSE UPDATE hg_comments SET doc=doc||jsonb_build_object('reactionCount',counter) WHERE id=p_comment_id AND doc->>'clubId'=p_club_id; END IF;
  END IF;
  RETURN jsonb_build_object('ok',true,'reacted',p_next,'count',counter);
END $$;
REVOKE ALL ON FUNCTION public.hg_toggle_reaction(text,text,text,boolean,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.hg_toggle_reaction(text,text,text,boolean,text) TO service_role;
CREATE OR REPLACE FUNCTION public.hg_toggle_reaction(p_actor_id text,p_post_id text,p_comment_id text,p_next boolean) RETURNS jsonb
LANGUAGE sql SECURITY INVOKER SET search_path=public,pg_temp AS $$
  SELECT public.hg_toggle_reaction(p_actor_id,p_post_id,p_comment_id,p_next,'heiguang')
$$;

CREATE FUNCTION public.hg_apply_membership(p_actor_id text,p_input jsonb,p_club_id text) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE user_doc jsonb; existing_membership jsonb; membership_id text; admission_state text;
  replay_application jsonb; pending_application jsonb; club_config jsonb; invite jsonb; application jsonb;
  application_id text; display_name text; invite_code text; rules_version text; current_rules_version text;
  max_uses int; used_count int; now_text text:=to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
BEGIN
  IF NULLIF(p_actor_id,'') IS NULL OR NULLIF(p_club_id,'') IS NULL THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('hg-governance:'||p_club_id||':members',0));
  SELECT doc INTO user_doc FROM hg_users WHERE id=p_actor_id FOR UPDATE;
  IF user_doc IS NULL OR user_doc->>'status' IS DISTINCT FROM 'active' THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
  SELECT doc INTO existing_membership FROM hg_memberships
    WHERE doc->>'userId'=p_actor_id AND doc->>'clubId'=p_club_id FOR UPDATE;
  IF existing_membership->>'status'='active' THEN
    SELECT doc INTO replay_application FROM hg_membership_applications
      WHERE id=existing_membership->>'applicationId' AND doc->>'userId'=p_actor_id
        AND doc->>'clubId'=p_club_id AND doc->>'status'='active' AND doc->>'admissionMethod'='invite';
    IF replay_application IS NOT NULL THEN RETURN jsonb_build_object('state','active','applicationId',replay_application->>'_id'); END IF;
    RAISE EXCEPTION 'ALREADY_MEMBER';
  END IF;
  IF existing_membership IS NOT NULL AND existing_membership->>'status' IS DISTINCT FROM 'removed' THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
  admission_state:=CASE WHEN existing_membership IS NULL THEN 'active' ELSE 'pending' END;
  SELECT doc INTO pending_application FROM hg_membership_applications
    WHERE doc->>'userId'=p_actor_id AND doc->>'clubId'=p_club_id AND doc->>'status'='pending'
    ORDER BY doc->'createdAt' DESC,id DESC LIMIT 1 FOR UPDATE;
  IF pending_application IS NOT NULL AND admission_state='pending' THEN
    RETURN jsonb_build_object('state','pending','applicationId',pending_application->>'_id');
  END IF;
  display_name:=btrim(p_input->>'displayName'); invite_code:=upper(btrim(p_input->>'inviteCode'));
  rules_version:=btrim(p_input->>'rulesVersion');
  IF display_name IS NULL OR display_name='' OR char_length(display_name)>20
     OR invite_code IS NULL OR invite_code='' OR char_length(invite_code)>32
     OR rules_version IS NULL OR rules_version='' OR char_length(rules_version)>20 THEN RAISE EXCEPTION 'INVALID'; END IF;
  SELECT doc INTO club_config FROM hg_club_config WHERE id=p_club_id FOR SHARE;
  IF club_config IS NULL THEN RAISE EXCEPTION 'CLUB_NOT_FOUND'; END IF;
  IF COALESCE(club_config->>'status','active')<>'active' THEN RAISE EXCEPTION 'CLUB_PAUSED'; END IF;
  current_rules_version:=COALESCE(NULLIF(club_config->>'rulesVersion',''),'v1.0');
  IF rules_version IS DISTINCT FROM current_rules_version THEN RAISE EXCEPTION 'RULES_VERSION_INVALID'; END IF;
  SELECT doc INTO invite FROM hg_invite_codes WHERE id=invite_code FOR UPDATE;
  IF invite IS NULL OR invite->>'clubId' IS DISTINCT FROM p_club_id OR NULLIF(invite->>'revokedAt','') IS NOT NULL THEN RAISE EXCEPTION 'INVITE_INVALID'; END IF;
  BEGIN
    max_uses:=NULLIF(invite->>'maxUses','')::int; used_count:=COALESCE(NULLIF(invite->>'usedCount','')::int,0);
    IF max_uses IS NOT NULL AND max_uses<0 THEN RAISE EXCEPTION 'INVITE_INVALID'; END IF;
    IF used_count<0 OR (max_uses IS NOT NULL AND max_uses>0 AND used_count>=max_uses) THEN RAISE EXCEPTION 'INVITE_INVALID'; END IF;
    IF NULLIF(invite->>'expiresAt','') IS NOT NULL AND (invite->>'expiresAt')::timestamptz<=clock_timestamp() THEN RAISE EXCEPTION 'INVITE_INVALID'; END IF;
  EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range OR invalid_datetime_format OR datetime_field_overflow THEN
    RAISE EXCEPTION 'INVITE_INVALID';
  END;
  application_id:=COALESCE(pending_application->>'_id','application:'||gen_random_uuid()::text);
  application:=jsonb_build_object('_id',application_id,'userId',p_actor_id,'clubId',p_club_id,
    'displayName',display_name,'inviteCode',invite_code,'rulesVersion',rules_version,'status',admission_state,
    'admissionMethod',CASE WHEN admission_state='active' THEN 'invite' ELSE 'manual_restore' END,
    'decidedAt',CASE WHEN admission_state='active' THEN now_text ELSE NULL END,
    'version',COALESCE((pending_application->>'version')::int,0)+1,
    'createdAt',COALESCE(pending_application->>'createdAt',now_text),'updatedAt',now_text);
  IF pending_application IS NULL THEN INSERT INTO hg_membership_applications(id,doc) VALUES(application_id,application);
  ELSE UPDATE hg_membership_applications SET doc=application WHERE id=application_id; END IF;
  IF admission_state='active' THEN
    membership_id:=p_actor_id||':'||p_club_id;
    INSERT INTO hg_memberships(id,doc) VALUES(membership_id,jsonb_build_object(
      '_id',membership_id,'userId',p_actor_id,'clubId',p_club_id,'status','active','role','member',
      'applicationId',application_id,'rulesVersion',rules_version,'version',1,'joinedAt',now_text,'updatedAt',now_text));
    UPDATE hg_users SET doc=user_doc||jsonb_build_object('displayName',display_name,'updatedAt',now_text) WHERE id=p_actor_id;
  END IF;
  UPDATE hg_invite_codes SET doc=invite||jsonb_build_object('usedCount',used_count+1,'updatedAt',now_text) WHERE id=invite_code;
  RETURN jsonb_build_object('state',admission_state,'applicationId',application_id);
END $$;
REVOKE ALL ON FUNCTION public.hg_apply_membership(text,jsonb,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.hg_apply_membership(text,jsonb,text) TO service_role;
CREATE OR REPLACE FUNCTION public.hg_apply_membership(p_actor_id text,p_input jsonb DEFAULT '{}'::jsonb) RETURNS jsonb
LANGUAGE sql SECURITY INVOKER SET search_path=public,pg_temp AS $$
  SELECT public.hg_apply_membership(p_actor_id,p_input,'heiguang')
$$;

CREATE FUNCTION public.hg_governance_admin(p_action text,p_actor_id text,p_input jsonb,p_club_id text) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE actor jsonb; result jsonb; page_limit int;
BEGIN
  IF NULLIF(p_club_id,'') IS NULL THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
  actor:=public.hg_require_club_membership(p_actor_id,p_club_id,ARRAY['moderator'],'update');
  IF p_action='members.list' THEN
    page_limit:=COALESCE(NULLIF(p_input->>'limit','')::int,50);
    IF page_limit<1 OR page_limit>100 THEN RAISE EXCEPTION 'INVALID'; END IF;
    SELECT COALESCE(jsonb_agg(item ORDER BY item->>'displayName',item->>'targetUserId'),'[]'::jsonb) INTO result
    FROM (SELECT jsonb_build_object('targetUserId',m.doc->>'userId','displayName',COALESCE(u.doc->>'displayName',''),
      'role',m.doc->>'role','status',m.doc->>'status','mutedUntil',m.doc->'mutedUntil',
      'version',COALESCE(NULLIF(m.doc->>'version','')::int,1)) AS item
      FROM hg_memberships m LEFT JOIN hg_users u ON u.id=m.doc->>'userId'
      WHERE m.doc->>'clubId'=p_club_id ORDER BY u.doc->>'displayName',m.doc->>'userId' LIMIT page_limit) rows;
    RETURN jsonb_build_object('ok',true,'items',result);
  END IF;
  RAISE EXCEPTION 'INVALID';
END $$;
REVOKE ALL ON FUNCTION public.hg_governance_admin(text,text,jsonb,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.hg_governance_admin(text,text,jsonb,text) TO service_role;
CREATE OR REPLACE FUNCTION public.hg_governance_admin(p_action text,p_actor_id text,p_input jsonb DEFAULT '{}'::jsonb) RETURNS jsonb
LANGUAGE sql SECURITY INVOKER SET search_path=public,pg_temp AS $$
  SELECT public.hg_governance_admin(p_action,p_actor_id,p_input,'heiguang')
$$;

CREATE FUNCTION public.hg_create_invite(p_actor_id text,p_input jsonb,p_club_id text) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE code text; max_uses int; ttl_seconds int; expires_text text; now_text text;
  inserted int; audit_id text; club jsonb;
BEGIN
  PERFORM public.hg_require_club_membership(p_actor_id,p_club_id,ARRAY['moderator'],'update');
  SELECT doc INTO club FROM hg_club_config WHERE id=p_club_id FOR SHARE;
  IF club IS NULL THEN RAISE EXCEPTION 'CLUB_NOT_FOUND'; END IF;
  IF COALESCE(club->>'status','active')<>'active' THEN RAISE EXCEPTION 'CLUB_PAUSED'; END IF;
  now_text:=to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  BEGIN max_uses:=COALESCE(NULLIF(p_input->>'maxUses','')::int,1); ttl_seconds:=COALESCE(NULLIF(p_input->>'ttlSeconds','')::int,604800);
  EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN RAISE EXCEPTION 'INVALID'; END;
  IF max_uses<1 OR max_uses>1000 OR ttl_seconds<60 OR ttl_seconds>7776000 THEN RAISE EXCEPTION 'INVALID'; END IF;
  expires_text:=to_char((clock_timestamp()+make_interval(secs=>ttl_seconds)) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  LOOP
    code:=substr(upper(replace(gen_random_uuid()::text,'-','')),1,12);
    INSERT INTO hg_invite_codes(id,doc) VALUES(code,jsonb_build_object('_id',code,'clubId',p_club_id,
      'expiresAt',expires_text,'maxUses',max_uses,'usedCount',0,'revokedAt',NULL,'createdBy',p_actor_id,
      'createdAt',now_text,'updatedAt',now_text)) ON CONFLICT(id) DO NOTHING;
    GET DIAGNOSTICS inserted=ROW_COUNT; EXIT WHEN inserted=1;
  END LOOP;
  audit_id:='audit:'||md5('invite:'||code||':'||p_actor_id||':'||p_club_id);
  INSERT INTO hg_audit_logs(id,doc) VALUES(audit_id,jsonb_build_object('_id',audit_id,'clubId',p_club_id,
    'actorId',p_actor_id,'action','invite.create','targetType','invite','targetId','invite:'||md5(code),
    'decision','created','reason','','extra',jsonb_build_object('maxUses',max_uses,'expiresAt',expires_text),'createdAt',now_text));
  RETURN jsonb_build_object('ok',true,'code',code,'expiresAt',expires_text,'maxUses',max_uses,'usedCount',0);
END $$;
REVOKE ALL ON FUNCTION public.hg_create_invite(text,jsonb,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.hg_create_invite(text,jsonb,text) TO service_role;
CREATE OR REPLACE FUNCTION public.hg_create_invite(p_actor_id text,p_input jsonb DEFAULT '{}'::jsonb) RETURNS jsonb
LANGUAGE sql SECURITY INVOKER SET search_path=public,pg_temp AS $$
  SELECT public.hg_create_invite(p_actor_id,p_input,'heiguang')
$$;

CREATE OR REPLACE FUNCTION public.hg_image_intent(p_owner text,p_club_id text,p_key text,p_asset jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE result jsonb; existing jsonb; pending int; user_bytes bigint; key_id text; asset_doc jsonb;
  limits jsonb; user_limit bigint; club_limit bigint; usage jsonb; usage_date date;
  reserved_bytes bigint; club_used bigint; club_reserved bigint; cutoff timestamptz;
BEGIN
  IF NULLIF(p_owner,'') IS NULL OR NULLIF(p_club_id,'') IS NULL OR NULLIF(p_key,'') IS NULL
     OR p_asset->>'ownerId' IS DISTINCT FROM p_owner OR p_asset->>'clubId' IS DISTINCT FROM p_club_id
     OR length(p_key)<8 OR NULLIF(p_asset->>'_id','') IS NULL THEN RAISE EXCEPTION 'IMAGE_INVALID'; END IF;
  PERFORM public.hg_require_club_membership(p_owner,p_club_id,NULL,'share');
  usage_date:=(clock_timestamp() AT TIME ZONE 'UTC')::date;
  PERFORM pg_advisory_xact_lock(hashtext('hg:usage:'||p_club_id||':'||usage_date::text));
  PERFORM pg_advisory_xact_lock(hashtext('hg:image:'||p_owner));
  key_id:=CASE WHEN p_club_id='heiguang' THEN p_owner||':imageIntent:'||p_key
    ELSE p_owner||':'||p_club_id||':imageIntent:'||p_key END;
  SELECT doc INTO existing FROM hg_idempotency WHERE id=key_id FOR UPDATE;
  IF existing IS NOT NULL THEN
    IF COALESCE(existing->>'clubId','heiguang') IS DISTINCT FROM p_club_id
       OR COALESCE(existing->>'actorId',p_owner) IS DISTINCT FROM p_owner
       OR existing->'declaredSize' IS DISTINCT FROM p_asset->'declaredSize'
       OR existing->'mimeType' IS DISTINCT FROM p_asset->'mimeType' THEN RAISE EXCEPTION 'IMAGE_CONFLICT'; END IF;
    RETURN existing->'result';
  END IF;
  BEGIN reserved_bytes:=COALESCE(NULLIF(p_asset->>'quotaBytes','')::bigint,0);
  EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN RAISE EXCEPTION 'IMAGE_INVALID'; END;
  IF reserved_bytes<=0 THEN RAISE EXCEPTION 'IMAGE_INVALID'; END IF;
  limits:=public.hg_usage_limits(p_club_id);
  user_limit:=(limits->>'userUploadDailyBytes')::bigint;
  club_limit:=(limits->>'clubUploadDailyBytes')::bigint;
  cutoff:=clock_timestamp()-interval '24 hours';
  SELECT count(*) FILTER (WHERE doc->>'status'='intent' AND NULLIF(doc->>'expiresAt','')::timestamptz>clock_timestamp()),
    COALESCE(sum(COALESCE(NULLIF(doc->>'quotaBytes','')::bigint,NULLIF(doc->>'declaredSize','')::bigint,0))
      FILTER (WHERE NULLIF(doc->>'createdAt','')::timestamptz>=cutoff),0)::bigint
    INTO pending,user_bytes FROM hg_assets WHERE doc->>'ownerId'=p_owner AND doc->>'mediaType'='image';
  IF user_limit=0 OR pending>=3 OR user_bytes+reserved_bytes>user_limit THEN RAISE EXCEPTION 'IMAGE_QUOTA'; END IF;
  usage:=public.hg_refresh_daily_usage(p_club_id,usage_date);
  club_used:=(usage->>'uploadBytes')::bigint;
  club_reserved:=(usage->>'uploadReservedBytes')::bigint;
  IF club_limit=0 OR club_used+club_reserved+reserved_bytes>club_limit THEN RAISE EXCEPTION 'IMAGE_QUOTA'; END IF;
  asset_doc:=p_asset;
  INSERT INTO hg_assets(id,doc) VALUES(asset_doc->>'_id',asset_doc);
  result:=jsonb_build_object('assetId',asset_doc->>'_id','expiresAt',asset_doc->>'expiresAt','expiresInSeconds',900,'mediaType','image');
  INSERT INTO hg_idempotency(id,doc) VALUES(key_id,jsonb_build_object('_id',key_id,'clubId',p_club_id,'actorId',p_owner,'state','succeeded',
    'result',result,'declaredSize',asset_doc->'declaredSize','mimeType',asset_doc->'mimeType','createdAt',asset_doc->'createdAt'));
  PERFORM public.hg_refresh_daily_usage(p_club_id,usage_date);
  RETURN result;
END $$;

CREATE FUNCTION public.hg_claim_image(p_owner text,p_asset_id text,p_key text,p_hash text,p_claim text,p_club_id text) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE asset jsonb;
BEGIN
  PERFORM public.hg_require_club_membership(p_owner,p_club_id,NULL,'share');
  SELECT doc INTO asset FROM hg_assets WHERE id=p_asset_id FOR UPDATE;
  IF asset IS NULL OR asset->>'clubId' IS DISTINCT FROM p_club_id OR asset->>'ownerId' IS DISTINCT FROM p_owner THEN RAISE EXCEPTION 'IMAGE_NOT_FOUND'; END IF;
  IF asset->>'uploadKey' IS NOT NULL AND (asset->>'uploadKey'<>p_key OR asset->>'contentHash'<>p_hash) THEN RAISE EXCEPTION 'IMAGE_CONFLICT'; END IF;
  IF asset->>'status' IN ('uploaded','verified') AND COALESCE(asset->>'fileId','')<>'' THEN RETURN asset; END IF;
  IF asset->>'status'<>'intent' OR (asset->>'expiresAt')::timestamptz<=now() THEN RAISE EXCEPTION 'IMAGE_EXPIRED'; END IF;
  IF COALESCE((asset->>'uploadLeaseUntil')::timestamptz,now()-interval '1 second')>now() THEN RAISE EXCEPTION 'IMAGE_PROCESSING'; END IF;
  asset:=asset||jsonb_build_object('uploadKey',p_key,'contentHash',p_hash,'uploadClaim',p_claim,
    'uploadStartedAt',now(),'uploadLeaseUntil',now()+interval '90 seconds');
  UPDATE hg_assets SET doc=asset WHERE id=p_asset_id AND doc->>'clubId'=p_club_id;
  RETURN asset;
END $$;
REVOKE ALL ON FUNCTION public.hg_claim_image(text,text,text,text,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.hg_claim_image(text,text,text,text,text,text) TO service_role;
CREATE OR REPLACE FUNCTION public.hg_claim_image(p_owner text,p_asset_id text,p_key text,p_hash text,p_claim text) RETURNS jsonb
LANGUAGE sql SECURITY INVOKER SET search_path=public,pg_temp AS $$
  SELECT public.hg_claim_image(p_owner,p_asset_id,p_key,p_hash,p_claim,'heiguang')
$$;

CREATE FUNCTION public.hg_confirm_image(p_owner text,p_asset_id text,p_club_id text) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE asset jsonb; task_id text; stamp text;
BEGIN
  PERFORM public.hg_require_club_membership(p_owner,p_club_id,NULL,'share');
  SELECT doc INTO asset FROM hg_assets WHERE id=p_asset_id FOR UPDATE;
  IF asset IS NULL OR asset->>'clubId' IS DISTINCT FROM p_club_id OR asset->>'ownerId' IS DISTINCT FROM p_owner THEN RAISE EXCEPTION 'IMAGE_NOT_FOUND'; END IF;
  IF asset->>'status' NOT IN ('uploaded','verified') OR COALESCE(asset->>'fileId','')='' THEN RAISE EXCEPTION 'IMAGE_INVALID'; END IF;
  task_id:='asset-review:'||p_asset_id;
  stamp:=to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  INSERT INTO hg_review_tasks(id,doc) VALUES(task_id,jsonb_build_object('_id',task_id,'clubId',p_club_id,
    'targetType','asset','targetId',p_asset_id,'mediaType','image','status','queued','attempts',0,'createdAt',stamp)) ON CONFLICT DO NOTHING;
  UPDATE hg_assets SET doc=doc||jsonb_build_object('reviewTaskId',task_id,'updatedAt',stamp) WHERE id=p_asset_id AND doc->>'clubId'=p_club_id;
  RETURN jsonb_build_object('assetId',p_asset_id,'status',asset->>'status');
END $$;
REVOKE ALL ON FUNCTION public.hg_confirm_image(text,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.hg_confirm_image(text,text,text) TO service_role;
CREATE OR REPLACE FUNCTION public.hg_confirm_image(p_owner text,p_asset_id text) RETURNS jsonb
LANGUAGE sql SECURITY INVOKER SET search_path=public,pg_temp AS $$
  SELECT public.hg_confirm_image(p_owner,p_asset_id,'heiguang')
$$;

CREATE FUNCTION public.hg_create_board(p_actor_id text,p_board jsonb,p_club_id text) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE membership jsonb; existing jsonb; normalized_title text; status text; new_doc jsonb; audit_id text;
BEGIN
  IF NULLIF(p_club_id,'') IS NULL OR p_board IS NULL OR jsonb_typeof(p_board)<>'object' THEN RAISE EXCEPTION 'INVALID'; END IF;
  normalized_title:=lower(btrim(COALESCE(p_board->>'title','')));
  IF normalized_title='' OR char_length(btrim(COALESCE(p_board->>'title','')))>40 OR char_length(COALESCE(p_board->>'description',''))>200 THEN RAISE EXCEPTION 'INVALID'; END IF;
  membership:=public.hg_require_club_membership(p_actor_id,p_club_id,NULL,'share');
  status:=CASE WHEN membership->>'role' IN ('admin','moderator') THEN 'active' ELSE 'pending' END;
  PERFORM pg_advisory_xact_lock(hashtext('hg_boards:'||p_club_id),hashtext(normalized_title));
  SELECT doc INTO existing FROM hg_boards WHERE doc->>'clubId'=p_club_id AND lower(btrim(doc->>'title'))=normalized_title
    AND doc->>'status' IN ('pending','active') ORDER BY CASE WHEN doc->>'status'='active' THEN 0 WHEN doc->>'ownerId'=p_actor_id THEN 1 ELSE 2 END,id LIMIT 1 FOR UPDATE;
  IF existing IS NOT NULL THEN
    IF existing->>'status'='active' OR existing->>'ownerId'=p_actor_id THEN RETURN jsonb_build_object('duplicated',true,'id',existing->>'_id','status',existing->>'status'); END IF;
    RAISE EXCEPTION 'BOARD_NAME_CONFLICT';
  END IF;
  new_doc:=jsonb_build_object('_id',p_board->>'_id','clubId',p_club_id,'ownerId',p_actor_id,
    'title',btrim(p_board->>'title'),'description',btrim(COALESCE(p_board->>'description','')),'status',status,
    'createdAt',COALESCE(p_board->'createdAt',to_jsonb(to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))),
    'updatedAt',COALESCE(p_board->'updatedAt',to_jsonb(to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))),'version',1);
  IF NULLIF(new_doc->>'_id','') IS NULL THEN RAISE EXCEPTION 'INVALID'; END IF;
  INSERT INTO hg_boards(id,doc) VALUES(new_doc->>'_id',new_doc);
  IF status='active' THEN
    audit_id:='audit:board:create:'||md5(clock_timestamp()::text||random()::text);
    INSERT INTO hg_audit_logs(id,doc) VALUES(audit_id,jsonb_build_object('_id',audit_id,'clubId',p_club_id,
      'actorId',p_actor_id,'action','board.create','targetType','board','targetId',new_doc->>'_id','decision','create','reason','',
      'toVersion',1,'createdAt',new_doc->'createdAt'));
  END IF;
  RETURN jsonb_build_object('duplicated',false,'id',new_doc->>'_id','status',status);
END $$;
REVOKE ALL ON FUNCTION public.hg_create_board(text,jsonb,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.hg_create_board(text,jsonb,text) TO service_role;
CREATE OR REPLACE FUNCTION public.hg_create_board(p_actor_id text,p_board jsonb) RETURNS jsonb
LANGUAGE sql SECURITY INVOKER SET search_path=public,pg_temp AS $$
  SELECT public.hg_create_board(p_actor_id,p_board,'heiguang')
$$;

CREATE FUNCTION public.hg_decide_board(p_actor_id text,p_input jsonb,p_club_id text) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE board jsonb; updated jsonb; result jsonb; board_id text:=p_input->>'id'; decision text:=p_input->>'decision';
  reason text:=COALESCE(NULLIF(btrim(p_input->>'reason'),''),''); expected_version int:=NULLIF(p_input->>'expectedVersion','')::int;
  actual_version int; next_status text; audit_id text; now_text text:=to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
BEGIN
  PERFORM public.hg_require_club_membership(p_actor_id,p_club_id,ARRAY['admin','moderator'],'update');
  IF NULLIF(board_id,'') IS NULL OR expected_version IS NULL OR expected_version<1 OR decision NOT IN ('approve','reject') THEN RAISE EXCEPTION 'INVALID'; END IF;
  IF decision='reject' AND reason='' THEN RAISE EXCEPTION 'REASON_REQUIRED'; END IF;
  SELECT doc INTO board FROM hg_boards WHERE id=board_id FOR UPDATE;
  IF board IS NULL OR board->>'clubId' IS DISTINCT FROM p_club_id THEN RAISE EXCEPTION 'BOARD_NOT_FOUND'; END IF;
  actual_version:=COALESCE(NULLIF(board->>'version','')::int,1);
  IF actual_version<>expected_version THEN
    IF actual_version=expected_version+1 AND board->>'boardDecisionExpectedVersion'=expected_version::text
      AND board->>'boardDecision'=decision AND board->'boardDecisionResult' IS NOT NULL THEN RETURN board->'boardDecisionResult'; END IF;
    RAISE EXCEPTION 'VERSION_CONFLICT';
  END IF;
  IF board->>'status'<>'pending' THEN RAISE EXCEPTION 'BOARD_ALREADY_DECIDED'; END IF;
  next_status:=CASE decision WHEN 'approve' THEN 'active' ELSE 'rejected' END;
  result:=jsonb_build_object('ok',true,'status',next_status,'version',actual_version+1);
  updated:=board||jsonb_build_object('status',next_status,'version',actual_version+1,'updatedAt',now_text,
    'boardDecisionExpectedVersion',expected_version,'boardDecision',decision,'boardDecisionReason',reason,
    'boardDecisionResult',result,'decidedBy',p_actor_id,'decidedAt',now_text,'rejectReason',CASE WHEN decision='reject' THEN reason ELSE '' END);
  UPDATE hg_boards SET doc=updated WHERE id=board_id AND doc->>'clubId'=p_club_id;
  audit_id:='audit:board:'||md5(clock_timestamp()::text||random()::text);
  INSERT INTO hg_audit_logs(id,doc) VALUES(audit_id,jsonb_build_object('_id',audit_id,'clubId',p_club_id,
    'actorId',p_actor_id,'action','board.decide','targetType','board','targetId',board_id,'decision',decision,'reason',reason,
    'fromVersion',actual_version,'toVersion',actual_version+1,'createdAt',now_text));
  RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.hg_decide_board(text,jsonb,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.hg_decide_board(text,jsonb,text) TO service_role;
CREATE OR REPLACE FUNCTION public.hg_decide_board(p_actor_id text,p_input jsonb) RETURNS jsonb
LANGUAGE sql SECURITY INVOKER SET search_path=public,pg_temp AS $$
  SELECT public.hg_decide_board(p_actor_id,p_input,'heiguang')
$$;

CREATE OR REPLACE FUNCTION public.hg_user_levels_award(
  p_user_id text,p_club_id text,p_event_type text,p_source_id text,p_source_post_id text,
  p_business_date date,p_xp integer,p_lock_nowait boolean DEFAULT false
) RETURNS integer LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE expected_xp int; positive_count int; positive_total int; event_key text; v_event_id text; inserted_event text;
  club_status text; user_status text;
BEGIN
  IF NULLIF(p_user_id,'') IS NULL OR NULLIF(p_club_id,'') IS NULL OR p_business_date IS NULL THEN RAISE EXCEPTION 'INVALID_XP_EVENT'; END IF;
  expected_xp:=CASE p_event_type WHEN 'check_in' THEN 5 WHEN 'reaction' THEN 1 WHEN 'comment_approved' THEN 3 ELSE NULL END;
  IF expected_xp IS NULL OR p_xp IS DISTINCT FROM expected_xp
     OR (p_event_type='check_in' AND (p_source_id IS NOT NULL OR p_source_post_id IS NOT NULL))
     OR (p_event_type<>'check_in' AND (NULLIF(p_source_id,'') IS NULL OR NULLIF(p_source_post_id,'') IS NULL)) THEN RAISE EXCEPTION 'INVALID_XP_EVENT'; END IF;
  IF p_lock_nowait THEN
    BEGIN
      PERFORM 1 FROM hg_memberships WHERE doc->>'userId'=p_user_id AND doc->>'clubId'=p_club_id AND doc->>'status'='active' FOR SHARE NOWAIT;
    EXCEPTION WHEN lock_not_available THEN RAISE EXCEPTION 'XP_MEMBERSHIP_BUSY' USING ERRCODE='55P03'; END;
  ELSE
    PERFORM 1 FROM hg_memberships WHERE doc->>'userId'=p_user_id AND doc->>'clubId'=p_club_id AND doc->>'status'='active' FOR SHARE;
  END IF;
  IF NOT FOUND THEN RETURN 0; END IF;
  SELECT doc->>'status' INTO user_status FROM hg_users WHERE id=p_user_id;
  SELECT COALESCE(doc->>'status','active') INTO club_status FROM hg_club_config WHERE id=p_club_id;
  IF user_status IS DISTINCT FROM 'active' OR club_status IS DISTINCT FROM 'active' THEN RETURN 0; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('hg-user-levels:'||p_club_id||':'||p_user_id,0));
  IF p_event_type='check_in' THEN
    IF EXISTS(SELECT 1 FROM hg_user_xp_events WHERE user_id=p_user_id AND club_id=p_club_id AND event_type='check_in' AND business_date=p_business_date) THEN RETURN 0; END IF;
  ELSIF p_event_type='reaction' THEN
    IF EXISTS(SELECT 1 FROM hg_user_xp_events WHERE user_id=p_user_id AND club_id=p_club_id AND event_type='reaction' AND source_id=p_source_id) THEN RETURN 0; END IF;
    SELECT count(*)::int INTO positive_count FROM hg_user_xp_events
      WHERE user_id=p_user_id AND club_id=p_club_id AND event_type='reaction' AND business_date=p_business_date AND xp>0;
    IF positive_count>=5 THEN RETURN 0; END IF;
  ELSE
    IF EXISTS(SELECT 1 FROM hg_user_xp_events WHERE user_id=p_user_id AND club_id=p_club_id AND event_type='comment_approved'
      AND (source_id=p_source_id OR (source_post_id=p_source_post_id AND business_date=p_business_date))) THEN RETURN 0; END IF;
    SELECT count(*)::int INTO positive_count FROM hg_user_xp_events
      WHERE user_id=p_user_id AND club_id=p_club_id AND event_type='comment_approved' AND business_date=p_business_date AND xp>0;
    IF positive_count>=3 THEN RETURN 0; END IF;
  END IF;
  SELECT COALESCE(sum(xp),0)::int INTO positive_total FROM hg_user_xp_events
    WHERE user_id=p_user_id AND club_id=p_club_id AND business_date=p_business_date AND xp>0;
  IF positive_total+p_xp>19 THEN RETURN 0; END IF;
  event_key:=p_club_id||':'||p_event_type||':'||p_user_id||':'||COALESCE(p_source_id,p_business_date::text)||':'||p_business_date::text;
  v_event_id:='xp:'||md5(event_key);
  INSERT INTO hg_user_xp_events(event_id,club_id,user_id,event_type,source_id,source_post_id,business_date,xp,idempotency_key)
    VALUES(v_event_id,p_club_id,p_user_id,p_event_type,p_source_id,p_source_post_id,p_business_date,p_xp,event_key)
    ON CONFLICT DO NOTHING RETURNING event_id INTO inserted_event;
  IF inserted_event IS NULL THEN RETURN 0; END IF;
  INSERT INTO hg_user_xp_accounts(user_id,club_id,total_xp) VALUES(p_user_id,p_club_id,p_xp)
    ON CONFLICT(user_id,club_id) DO UPDATE SET total_xp=hg_user_xp_accounts.total_xp+EXCLUDED.total_xp,updated_at=clock_timestamp();
  RETURN p_xp;
END $$;
REVOKE ALL ON FUNCTION public.hg_user_levels_award(text,text,text,text,text,date,integer,boolean) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.hg_user_levels_award(text,text,text,text,text,date,integer,boolean) TO service_role;
CREATE FUNCTION public.hg_user_levels_snapshot(p_actor_id text,p_club_id text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE thresholds int[]:=ARRAY[0,40,120,280,520,860,1320,2000];
  names text[]:=ARRAY['微光','新芽','青枝','向光','成荫','星枝','林海','长明'];
  total int; level int:=1; current_threshold int; next_threshold int; day_key date:=(transaction_timestamp() AT TIME ZONE 'Asia/Shanghai')::date;
  earned_today int:=0; checked_in_today boolean:=false; reactions_today int:=0; comments_today int:=0; i int;
BEGIN
  PERFORM public.hg_require_club_membership(p_actor_id,p_club_id,NULL,'share');
  SELECT total_xp INTO total FROM hg_user_xp_accounts WHERE user_id=p_actor_id AND club_id=p_club_id;
  total:=COALESCE(total,0);
  FOR i IN 2..array_length(thresholds,1) LOOP
    IF total<thresholds[i] THEN level:=i-1; EXIT; END IF; level:=i;
  END LOOP;
  current_threshold:=thresholds[level];
  IF level<array_length(thresholds,1) THEN next_threshold:=thresholds[level+1]; ELSE next_threshold:=NULL; END IF;
  SELECT COALESCE(sum(xp) FILTER(WHERE xp>0),0)::int,
    COALESCE(bool_or(event_type='check_in' AND xp>0),false),
    count(*) FILTER(WHERE event_type='reaction' AND xp>0)::int,
    count(*) FILTER(WHERE event_type='comment_approved' AND xp>0)::int
    INTO earned_today,checked_in_today,reactions_today,comments_today
    FROM hg_user_xp_events WHERE user_id=p_actor_id AND club_id=p_club_id AND business_date=day_key;
  RETURN jsonb_build_object('level',level,'title',names[level],'totalXp',total,'currentLevelXp',current_threshold,
    'nextLevelXp',next_threshold,'progressXp',greatest(0,total-current_threshold),
    'progressTargetXp',CASE WHEN next_threshold IS NULL THEN 0 ELSE next_threshold-current_threshold END,
    'today',jsonb_build_object('earnedXp',earned_today,'maxXp',19,'checkedIn',checked_in_today,
      'reactions',reactions_today,'maxReactions',5,'comments',comments_today,'maxComments',3));
END $$;
REVOKE ALL ON FUNCTION public.hg_user_levels_snapshot(text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.hg_user_levels_snapshot(text,text) TO service_role;
CREATE OR REPLACE FUNCTION public.hg_user_levels_snapshot(p_actor_id text) RETURNS jsonb
LANGUAGE sql SECURITY INVOKER SET search_path=public,pg_temp AS $$ SELECT public.hg_user_levels_snapshot(p_actor_id,'heiguang') $$;

CREATE FUNCTION public.hg_user_levels_check_in(p_actor_id text,p_club_id text) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE day_key date:=(transaction_timestamp() AT TIME ZONE 'Asia/Shanghai')::date; awarded int; result jsonb;
BEGIN
  PERFORM public.hg_require_club_membership(p_actor_id,p_club_id,NULL,'share');
  awarded:=public.hg_user_levels_award(p_actor_id,p_club_id,'check_in',NULL,NULL,day_key,5,false);
  result:=public.hg_user_levels_snapshot(p_actor_id,p_club_id);
  RETURN result||jsonb_build_object('awardedXp',awarded);
END $$;
REVOKE ALL ON FUNCTION public.hg_user_levels_check_in(text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.hg_user_levels_check_in(text,text) TO service_role;
CREATE OR REPLACE FUNCTION public.hg_user_levels_check_in(p_actor_id text) RETURNS jsonb
LANGUAGE sql SECURITY INVOKER SET search_path=public,pg_temp AS $$ SELECT public.hg_user_levels_check_in(p_actor_id,'heiguang') $$;

CREATE OR REPLACE FUNCTION public.hg_user_levels_on_reaction_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE reaction jsonb:=NEW.doc; post jsonb; target jsonb; v_user_id text; club_id text; post_id text;
  target_comment_id text; target_owner_id text; day_key date;
BEGIN
  IF reaction->>'type' IS DISTINCT FROM 'resonance' THEN RETURN NEW; END IF;
  v_user_id:=reaction->>'userId'; post_id:=reaction->>'postId'; target_comment_id:=NULLIF(reaction->>'commentId','');
  IF NULLIF(v_user_id,'') IS NULL OR NULLIF(post_id,'') IS NULL THEN RETURN NEW; END IF;
  SELECT doc INTO post FROM hg_posts WHERE id=post_id;
  IF post IS NULL OR post->>'status'<>'published' OR post->>'visibility' NOT IN ('club','public') THEN RETURN NEW; END IF;
  club_id:=COALESCE(NULLIF(post->>'clubId',''),'heiguang');
  IF reaction->>'clubId' IS DISTINCT FROM club_id THEN RETURN NEW; END IF;
  IF target_comment_id IS NULL THEN target_owner_id:=post->>'ownerId';
  ELSE
    SELECT doc INTO target FROM hg_comments WHERE id=target_comment_id;
    IF target IS NULL OR target->>'clubId' IS DISTINCT FROM club_id OR target->>'status'<>'published'
      OR target->>'postId' IS DISTINCT FROM post_id THEN RETURN NEW; END IF;
    target_owner_id:=target->>'ownerId';
  END IF;
  IF target_owner_id IS NULL OR target_owner_id='' OR target_owner_id=v_user_id THEN RETURN NEW; END IF;
  day_key:=(transaction_timestamp() AT TIME ZONE 'Asia/Shanghai')::date;
  PERFORM public.hg_user_levels_award(v_user_id,club_id,'reaction',NEW.id,post_id,day_key,1,true);
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.hg_user_levels_on_comment_change() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE comment_doc jsonb:=NEW.doc; parent_post jsonb; v_user_id text; post_id text; v_club_id text; day_key date;
  award public.hg_user_xp_events%ROWTYPE; reversal_key text; reversal_id text; inserted_event text;
BEGIN
  IF OLD.doc->>'status' IS NOT DISTINCT FROM NEW.doc->>'status' THEN RETURN NEW; END IF;
  v_user_id:=comment_doc->>'ownerId'; post_id:=comment_doc->>'postId';
  IF NULLIF(v_user_id,'') IS NULL OR NULLIF(post_id,'') IS NULL THEN RETURN NEW; END IF;
  SELECT doc INTO parent_post FROM hg_posts WHERE id=post_id;
  IF parent_post IS NULL THEN RETURN NEW; END IF;
  v_club_id:=COALESCE(NULLIF(parent_post->>'clubId',''),'heiguang');
  IF comment_doc->>'clubId' IS DISTINCT FROM v_club_id THEN RETURN NEW; END IF;
  IF NEW.doc->>'status'='published' THEN
    IF parent_post->>'status'<>'published' OR parent_post->>'visibility' NOT IN ('club','public') THEN RETURN NEW; END IF;
    day_key:=(transaction_timestamp() AT TIME ZONE 'Asia/Shanghai')::date;
    PERFORM public.hg_user_levels_award(v_user_id,v_club_id,'comment_approved',NEW.id,post_id,day_key,3,true);
    RETURN NEW;
  END IF;
  IF OLD.doc->>'status'='published' AND NEW.doc->>'status' IN ('hidden','rejected') THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('hg-user-levels:'||v_club_id||':'||v_user_id,0));
    SELECT event.* INTO award FROM hg_user_xp_events event
      WHERE event.user_id=v_user_id AND event.club_id=v_club_id AND event.event_type='comment_approved' AND event.source_id=NEW.id FOR UPDATE;
    IF NOT FOUND OR EXISTS(SELECT 1 FROM hg_user_xp_events WHERE club_id=award.club_id AND reversal_of=award.event_id) THEN RETURN NEW; END IF;
    day_key:=(transaction_timestamp() AT TIME ZONE 'Asia/Shanghai')::date;
    reversal_key:=v_club_id||':comment_revoked:'||award.event_id;
    reversal_id:='xp:'||md5(reversal_key);
    INSERT INTO hg_user_xp_events(event_id,club_id,user_id,event_type,source_id,source_post_id,business_date,xp,idempotency_key,reversal_of)
      VALUES(reversal_id,v_club_id,v_user_id,'comment_revoked',NEW.id,award.source_post_id,day_key,-award.xp,reversal_key,award.event_id)
      ON CONFLICT DO NOTHING RETURNING event_id INTO inserted_event;
    IF inserted_event IS NOT NULL THEN
      INSERT INTO hg_user_xp_accounts(user_id,club_id,total_xp) VALUES(v_user_id,v_club_id,0) ON CONFLICT(user_id,club_id) DO NOTHING;
      UPDATE hg_user_xp_accounts SET total_xp=greatest(0,total_xp-award.xp),updated_at=clock_timestamp()
        WHERE user_id=v_user_id AND club_id=v_club_id;
    END IF;
  END IF;
  RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION public.hg_user_levels_on_reaction_insert(),public.hg_user_levels_on_comment_change() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.hg_user_levels_on_reaction_insert(),public.hg_user_levels_on_comment_change() TO service_role;

CREATE FUNCTION public.hg_comment_queue(p_actor text,p_cursor jsonb,p_limit integer,p_club_id text) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE result jsonb;
BEGIN
  PERFORM public.hg_require_club_membership(p_actor,p_club_id,ARRAY['admin','moderator'],'share');
  SELECT COALESCE(jsonb_agg(row.doc ORDER BY row.doc->>'createdAt',row.id),'[]'::jsonb) INTO result FROM (
    SELECT c.id,c.doc FROM hg_comments c JOIN hg_posts p ON p.id=c.doc->>'postId'
    WHERE c.doc->>'clubId'=p_club_id AND c.doc->>'status'='pending'
      AND p.doc->>'clubId'=p_club_id AND p.doc->>'status'='published' AND p.doc->>'visibility' IN ('club','public')
      AND EXISTS(SELECT 1 FROM hg_review_tasks t WHERE t.doc->>'clubId'=p_club_id AND t.doc->>'targetType'='comment'
        AND t.doc->>'targetId'=c.id AND t.doc->>'status'='manual' AND t.doc->>'postVersion'=COALESCE(c.doc->>'version','1'))
      AND (p_cursor IS NULL OR ((c.doc->>'createdAt')::timestamptz,c.id)>
        (to_timestamp((p_cursor->>'createdAt')::numeric/1000),p_cursor->>'id')
        OR (p_cursor->>'inclusiveId'='true' AND ((c.doc->>'createdAt')::timestamptz,c.id)=
        (to_timestamp((p_cursor->>'createdAt')::numeric/1000),p_cursor->>'id')))
    ORDER BY c.doc->>'createdAt',c.id LIMIT GREATEST(1,LEAST(p_limit,51))
  ) row;
  RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.hg_comment_queue(text,jsonb,integer,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.hg_comment_queue(text,jsonb,integer,text) TO service_role;
CREATE OR REPLACE FUNCTION public.hg_comment_queue(p_actor text,p_cursor jsonb DEFAULT NULL,p_limit integer DEFAULT 20) RETURNS jsonb
LANGUAGE sql SECURITY INVOKER SET search_path=public,pg_temp AS $$
  SELECT public.hg_comment_queue(p_actor,p_cursor,p_limit,'heiguang')
$$;

CREATE FUNCTION public.hg_admin_appeals_queue(p_actor text,p_cursor jsonb,p_limit integer,p_club_id text) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE result jsonb;
BEGIN
  PERFORM public.hg_require_club_membership(p_actor,p_club_id,ARRAY['admin','moderator'],'share');
  SELECT COALESCE(jsonb_agg(row.dto ORDER BY row.created_at,row.id),'[]'::jsonb) INTO result FROM (
    SELECT appeal.id,appeal.doc->>'createdAt' AS created_at,
      jsonb_build_object('appealId',appeal.id,'postId',appeal.doc->>'postId',
        'contentVersion',appeal.doc->>'contentVersion','status',appeal.doc->>'status','reason',appeal.doc->>'reason',
        'version',COALESCE(NULLIF(appeal.doc->>'version','')::int,1),'createdAt',appeal.doc->>'createdAt','updatedAt',appeal.doc->>'updatedAt') AS dto
    FROM hg_appeals appeal WHERE appeal.doc->>'clubId'=p_club_id AND appeal.doc->>'status'='submitted'
      AND (p_cursor IS NULL OR ((appeal.doc->>'createdAt')::timestamptz,appeal.id)>
        (to_timestamp((p_cursor->>'createdAt')::numeric/1000),p_cursor->>'id')
        OR (p_cursor->>'inclusiveId'='true' AND ((appeal.doc->>'createdAt')::timestamptz,appeal.id)=
        (to_timestamp((p_cursor->>'createdAt')::numeric/1000),p_cursor->>'id')))
    ORDER BY appeal.doc->>'createdAt',appeal.id LIMIT GREATEST(1,LEAST(p_limit,51))
  ) row;
  RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.hg_admin_appeals_queue(text,jsonb,integer,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.hg_admin_appeals_queue(text,jsonb,integer,text) TO service_role;
CREATE OR REPLACE FUNCTION public.hg_admin_appeals_queue(p_actor text,p_cursor jsonb DEFAULT NULL,p_limit integer DEFAULT 20) RETURNS jsonb
LANGUAGE sql SECURITY INVOKER SET search_path=public,pg_temp AS $$
  SELECT public.hg_admin_appeals_queue(p_actor,p_cursor,p_limit,'heiguang')
$$;

CREATE FUNCTION public.hg_governance(p_action text,p_actor_id text,p_input jsonb,p_club_id text) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE actor jsonb; target jsonb; post jsonb; appeal jsonb; updated jsonb; target_row_id text;
  target_user_id text; post_id text; appeal_id text; owner_id text; reason text; new_role text; decision text;
  muted_until text; expected_version int; actual_version int; post_version int; content_version int;
  manager_count int; page_limit int; review_task_id text; result jsonb; now_text text;
  audit_id text; notification_id text;
BEGIN
  now_text:=to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  IF p_action LIKE 'member.%' THEN PERFORM pg_advisory_xact_lock(hashtextextended('hg-governance:'||p_club_id||':members',0)); END IF;
  IF p_action LIKE 'member.%' OR p_action IN ('appeal.decide','admin.appeals.list') THEN
    actor:=public.hg_require_club_membership(p_actor_id,p_club_id,ARRAY['admin','moderator'],'update');
  ELSE
    actor:=public.hg_require_club_membership(p_actor_id,p_club_id,NULL,'share');
  END IF;
  IF p_action LIKE 'member.%' THEN
    IF actor->>'role'<>'moderator' THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
    target_user_id:=p_input->>'targetUserId'; expected_version:=NULLIF(p_input->>'expectedVersion','')::int;
    reason:=NULLIF(btrim(p_input->>'reason'),'');
    IF NULLIF(target_user_id,'') IS NULL OR target_user_id=p_actor_id THEN RAISE EXCEPTION 'SELF_TARGET'; END IF;
    IF expected_version IS NULL OR reason IS NULL THEN RAISE EXCEPTION 'INVALID'; END IF;
    SELECT id,doc INTO target_row_id,target FROM hg_memberships
      WHERE doc->>'userId'=target_user_id AND doc->>'clubId'=p_club_id FOR UPDATE;
    IF target IS NULL OR target->>'status'<>'active' THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
    actual_version:=COALESCE(NULLIF(target->>'version','')::int,1);
    IF expected_version<>actual_version THEN RAISE EXCEPTION 'VERSION_CONFLICT'; END IF;
    IF p_action='member.role' THEN
      new_role:=p_input->>'role'; IF new_role NOT IN ('member','moderator','admin') THEN RAISE EXCEPTION 'ROLE_INVALID'; END IF;
    END IF;
    IF (p_action='member.remove' AND target->>'role'='moderator') OR
       (p_action='member.role' AND target->>'role'='moderator' AND new_role<>'moderator') THEN
      SELECT count(*) INTO manager_count FROM hg_memberships WHERE doc->>'clubId'=p_club_id
        AND doc->>'status'='active' AND doc->>'role'='moderator';
      IF manager_count<=1 THEN RAISE EXCEPTION 'LAST_MODERATOR'; END IF;
    END IF;
    updated:=target||jsonb_build_object('version',actual_version+1,'updatedAt',now_text);
    IF p_action='member.remove' THEN
      updated:=updated||jsonb_build_object('status','removed','removedAt',now_text,'removalReason',reason,'removedBy',p_actor_id);
    ELSIF p_action='member.mute' THEN
      muted_until:=p_input->>'mutedUntil';
      IF NULLIF(muted_until,'') IS NOT NULL THEN BEGIN PERFORM muted_until::timestamptz; EXCEPTION WHEN others THEN RAISE EXCEPTION 'INVALID'; END; END IF;
      updated:=updated||jsonb_build_object('mutedUntil',to_jsonb(NULLIF(muted_until,'')));
    ELSE updated:=updated||jsonb_build_object('role',new_role); END IF;
    UPDATE hg_memberships SET doc=updated WHERE id=target_row_id AND doc->>'clubId'=p_club_id;
    audit_id:='audit:'||md5(clock_timestamp()::text||random()::text);
    INSERT INTO hg_audit_logs(id,doc) VALUES(audit_id,jsonb_build_object('_id',audit_id,'clubId',p_club_id,
      'actorId',p_actor_id,'action',p_action,'targetType','membership','targetId',target_user_id,
      'decision',CASE p_action WHEN 'member.remove' THEN 'remove' WHEN 'member.mute' THEN 'mute' ELSE 'role' END,
      'reason',reason,'extra',jsonb_build_object('role',COALESCE(new_role,target->>'role'),'mutedUntil',p_input->>'mutedUntil'),'createdAt',now_text));
    notification_id:='notification:'||md5(clock_timestamp()::text||random()::text);
    INSERT INTO hg_notifications(id,doc) VALUES(notification_id,jsonb_build_object('_id',notification_id,'clubId',p_club_id,
      'recipientId',target_user_id,'eventType','system_membership','title',CASE p_action WHEN 'member.remove' THEN '成员资格已变更' WHEN 'member.mute' THEN '发言权限已变更' ELSE '成员角色已变更' END,
      'summary',reason,'targetType','system','targetId','membership','icon','usergroup','createdAt',now_text));
    RETURN jsonb_build_object('ok',true,'targetUserId',target_user_id,'version',actual_version+1,
      'status',updated->>'status','role',updated->>'role','mutedUntil',updated->'mutedUntil');
  END IF;
  IF p_action='appeal.create' THEN
    post_id:=p_input->>'postId'; owner_id:=p_input->>'ownerId'; reason:=NULLIF(btrim(p_input->>'reason'),'');
    content_version:=NULLIF(p_input->>'contentVersion','')::int;
    IF post_id IS NULL OR owner_id IS NULL OR reason IS NULL OR content_version IS NULL THEN RAISE EXCEPTION 'INVALID'; END IF;
    IF owner_id IS DISTINCT FROM p_actor_id THEN RAISE EXCEPTION 'NOT_OWNER'; END IF;
    SELECT doc INTO post FROM hg_posts WHERE id=post_id FOR UPDATE;
    IF post IS NULL OR post->>'clubId' IS DISTINCT FROM p_club_id THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
    IF post->>'ownerId' IS DISTINCT FROM owner_id THEN RAISE EXCEPTION 'NOT_OWNER'; END IF;
    IF post->>'status' NOT IN ('hidden','rejected') THEN RAISE EXCEPTION 'POST_NOT_APPEALABLE'; END IF;
    IF COALESCE(NULLIF(post->>'version','')::int,1)<>content_version THEN RAISE EXCEPTION 'VERSION_CONFLICT'; END IF;
    IF EXISTS(SELECT 1 FROM hg_appeals WHERE doc->>'clubId'=p_club_id AND doc->>'postId'=post_id
      AND doc->>'ownerId'=owner_id AND doc->>'contentVersion'=content_version::text) THEN RAISE EXCEPTION 'APPEAL_EXISTS'; END IF;
    appeal_id:='appeal:'||md5(clock_timestamp()::text||random()::text);
    INSERT INTO hg_appeals(id,doc) VALUES(appeal_id,jsonb_build_object('_id',appeal_id,'clubId',p_club_id,
      'postId',post_id,'ownerId',owner_id,'contentVersion',content_version,'status','submitted','reason',reason,
      'version',1,'createdAt',now_text,'updatedAt',now_text));
    audit_id:='audit:'||md5(clock_timestamp()::text||random()::text);
    INSERT INTO hg_audit_logs(id,doc) VALUES(audit_id,jsonb_build_object('_id',audit_id,'clubId',p_club_id,
      'actorId',owner_id,'action','appeal.create','targetType','post','targetId',post_id,'decision','submitted','reason',reason,'createdAt',now_text));
    RETURN jsonb_build_object('ok',true,'appealId',appeal_id,'state','submitted','version',1);
  END IF;
  IF p_action='appeal.decide' THEN
    appeal_id:=p_input->>'appealId'; expected_version:=NULLIF(p_input->>'expectedVersion','')::int;
    decision:=p_input->>'decision'; reason:=NULLIF(btrim(p_input->>'reason'),'');
    IF appeal_id IS NULL OR expected_version IS NULL OR reason IS NULL OR decision NOT IN ('approve','reject') THEN RAISE EXCEPTION 'INVALID'; END IF;
    SELECT doc INTO appeal FROM hg_appeals WHERE id=appeal_id FOR UPDATE;
    IF appeal IS NULL OR appeal->>'clubId' IS DISTINCT FROM p_club_id THEN RAISE EXCEPTION 'APPEAL_NOT_FOUND'; END IF;
    IF appeal->>'status'<>'submitted' OR COALESCE(NULLIF(appeal->>'version','')::int,1)<>expected_version THEN RAISE EXCEPTION 'VERSION_CONFLICT'; END IF;
    post_id:=appeal->>'postId'; owner_id:=appeal->>'ownerId';
    SELECT doc INTO post FROM hg_posts WHERE id=post_id FOR UPDATE;
    IF post IS NULL OR post->>'clubId' IS DISTINCT FROM p_club_id THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
    post_version:=COALESCE(NULLIF(post->>'version','')::int,1); content_version:=COALESCE(NULLIF(appeal->>'contentVersion','')::int,1);
    IF post_version<>content_version OR post->>'status' NOT IN ('hidden','rejected') THEN RAISE EXCEPTION 'VERSION_CONFLICT'; END IF;
    IF decision='approve' THEN
      updated:=post||jsonb_build_object('status','pending','reviewedAt',NULL,'reviewedBy',NULL,'rejectReason',NULL,
        'reviewRequestedAt',now_text,'reviewRequestedBy',p_actor_id,'updatedAt',now_text,'version',post_version+1);
      UPDATE hg_posts SET doc=updated WHERE id=post_id AND doc->>'clubId'=p_club_id;
      review_task_id:='review:appeal:'||md5(clock_timestamp()::text||random()::text);
      INSERT INTO hg_review_tasks(id,doc) VALUES(review_task_id,jsonb_build_object('_id',review_task_id,'clubId',p_club_id,
        'targetType','post','targetId',post_id,'postVersion',post_version+1,'status','queued','attempts',0,
        'needsMedia',CASE WHEN jsonb_typeof(updated->'assetIds')='array' THEN jsonb_array_length(updated->'assetIds')>0 ELSE false END,
        'reason','appeal_recheck','createdAt',now_text,'nextAttemptAt',now_text));
    END IF;
    updated:=appeal||jsonb_build_object('status',CASE decision WHEN 'approve' THEN 'approved' ELSE 'rejected' END,
      'decision',decision,'decisionReason',reason,'decidedBy',p_actor_id,'decidedAt',now_text,'updatedAt',now_text,
      'version',expected_version+1);
    UPDATE hg_appeals SET doc=updated WHERE id=appeal_id AND doc->>'clubId'=p_club_id;
    audit_id:='audit:'||md5(clock_timestamp()::text||random()::text);
    INSERT INTO hg_audit_logs(id,doc) VALUES(audit_id,jsonb_build_object('_id',audit_id,'clubId',p_club_id,
      'actorId',p_actor_id,'action','appeal.'||decision,'targetType','post','targetId',post_id,'decision',decision,'reason',reason,'createdAt',now_text));
    notification_id:='notification:'||md5(clock_timestamp()::text||random()::text);
    INSERT INTO hg_notifications(id,doc) VALUES(notification_id,jsonb_build_object('_id',notification_id,'clubId',p_club_id,
      'recipientId',owner_id,'eventType','system_review','title',CASE decision WHEN 'approve' THEN '你的申诉已通过，内容进入再次审核' ELSE '你的申诉未通过' END,
      'summary',reason,'targetType','post','targetId',post_id,'icon',CASE decision WHEN 'approve' THEN 'check-circle' ELSE 'error-circle' END,'createdAt',now_text));
    RETURN jsonb_build_object('ok',true,'appealId',appeal_id,'status',updated->>'status',
      'postStatus',CASE decision WHEN 'approve' THEN 'pending' ELSE post->>'status' END,
      'reviewTaskId',CASE decision WHEN 'approve' THEN review_task_id ELSE NULL END,'version',expected_version+1);
  END IF;
  IF p_action IN ('appeals.mine','admin.appeals.list') THEN
    page_limit:=COALESCE(NULLIF(p_input->>'limit','')::int,20);
    IF page_limit<1 OR page_limit>50 THEN RAISE EXCEPTION 'INVALID'; END IF;
    SELECT COALESCE(jsonb_agg(item ORDER BY item->>'createdAt' DESC),'[]'::jsonb) INTO result FROM (
      SELECT jsonb_build_object('appealId',id,'postId',doc->>'postId','contentVersion',NULLIF(doc->>'contentVersion','')::int,
        'status',doc->>'status','reason',doc->>'reason','decision',doc->>'decision','decisionReason',doc->>'decisionReason',
        'version',COALESCE(NULLIF(doc->>'version','')::int,1),'createdAt',doc->>'createdAt','updatedAt',doc->>'updatedAt') AS item
      FROM hg_appeals WHERE doc->>'clubId'=p_club_id AND (p_action='appeals.mine' AND doc->>'ownerId'=p_actor_id OR p_action='admin.appeals.list')
      ORDER BY doc->>'createdAt' DESC LIMIT page_limit) rows;
    RETURN jsonb_build_object('ok',true,'items',result);
  END IF;
  RAISE EXCEPTION 'INVALID';
END $$;
REVOKE ALL ON FUNCTION public.hg_governance(text,text,jsonb,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.hg_governance(text,text,jsonb,text) TO service_role;
CREATE OR REPLACE FUNCTION public.hg_governance(p_action text,p_actor_id text,p_input jsonb DEFAULT '{}'::jsonb) RETURNS jsonb
LANGUAGE sql SECURITY INVOKER SET search_path=public,pg_temp AS $$ SELECT public.hg_governance(p_action,p_actor_id,p_input,'heiguang') $$;

CREATE FUNCTION public.hg_moderate(p_action text,p_actor_id text,p_input jsonb,p_club_id text) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE actor jsonb; post jsonb; comment jsonb; application jsonb; report jsonb; topic jsonb; task jsonb;
  collection jsonb; consent jsonb; existing jsonb; member_id text; updated jsonb; result jsonb;
  target_key text; decision text; reason text; expected_version int; actual_version int; target_version int;
  audit_id text; notification_id text; now_text text:=to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  task_id text; target_type text; target_id text; owner_id text; collection_id text; post_id text;
  anthology_enabled boolean; entry_count int; inserted int;
BEGIN
  IF p_action='membership.decide' THEN PERFORM pg_advisory_xact_lock(hashtextextended('hg-governance:'||p_club_id||':members',0)); END IF;
  actor:=public.hg_require_club_membership(p_actor_id,p_club_id,ARRAY['moderator','admin'],'update');
  IF p_action='content.decide' THEN
    target_key:=p_input->>'id'; decision:=p_input->>'decision'; reason:=COALESCE(NULLIF(btrim(p_input->>'reason'),''),'');
    expected_version:=NULLIF(p_input->>'expectedVersion','')::int;
    IF NULLIF(target_key,'') IS NULL OR expected_version IS NULL OR decision NOT IN ('approve','reject','hide') THEN RAISE EXCEPTION 'INVALID'; END IF;
    IF decision<>'approve' AND reason='' THEN RAISE EXCEPTION 'REASON_REQUIRED'; END IF;
    SELECT id,doc INTO task_id,task FROM hg_review_tasks WHERE doc->>'clubId'=p_club_id
      AND doc->>'targetType'='post' AND doc->>'targetId'=target_key AND doc->>'status'='manual'
      AND doc->>'postVersion'=expected_version::text ORDER BY doc->>'createdAt' DESC,id DESC LIMIT 1 FOR UPDATE;
    IF task_id IS NULL THEN RAISE EXCEPTION 'REVIEW_NOT_READY'; END IF;
    SELECT doc INTO post FROM hg_posts WHERE id=target_key FOR UPDATE;
    IF post IS NULL OR post->>'clubId' IS DISTINCT FROM p_club_id THEN RAISE EXCEPTION 'POST_NOT_FOUND'; END IF;
    IF post->>'visibility'='private' THEN RAISE EXCEPTION 'PRIVATE_CONTENT'; END IF;
    actual_version:=COALESCE(NULLIF(post->>'version','')::int,1);
    IF actual_version<>expected_version THEN
      IF actual_version=expected_version+1 AND post->>'moderationExpectedVersion'=expected_version::text
        AND post->>'moderationDecision'=decision AND post->'moderationResult' IS NOT NULL THEN RETURN post->'moderationResult'; END IF;
      RAISE EXCEPTION 'VERSION_CONFLICT';
    END IF;
    IF post->>'status'<>'pending' THEN RAISE EXCEPTION 'VERSION_CONFLICT'; END IF;
    IF decision='approve' AND EXISTS(SELECT 1 FROM jsonb_array_elements_text(COALESCE(post->'assetIds','[]'::jsonb)) aid
      LEFT JOIN hg_assets a ON a.id=aid WHERE a.id IS NULL OR a.doc->>'clubId' IS DISTINCT FROM p_club_id
      OR a.doc->>'status'<>'verified' OR a.doc->>'postId'<>target_key OR a.doc->>'ownerId'<>post->>'ownerId') THEN RAISE EXCEPTION 'PENDING_MEDIA'; END IF;
    updated:=post||jsonb_build_object('status',CASE decision WHEN 'approve' THEN 'published' WHEN 'reject' THEN 'rejected' ELSE 'hidden' END,
      'rejectReason',CASE decision WHEN 'reject' THEN reason ELSE '' END,
      'hiddenReason',CASE WHEN decision='hide' THEN reason ELSE COALESCE(post->>'hiddenReason','') END,
      'reviewedAt',now_text,'reviewedBy',p_actor_id,
      'permissionVersion',CASE WHEN decision='hide' THEN COALESCE(NULLIF(post->>'permissionVersion','')::int,0)+1 ELSE COALESCE(NULLIF(post->>'permissionVersion','')::int,0) END,
      'version',actual_version+1,'moderationExpectedVersion',expected_version,'moderationDecision',decision,
      'moderationDecisionReason',reason,'moderationDecisionBy',p_actor_id,'moderationDecidedAt',now_text);
    result:=jsonb_build_object('ok',true,'id',target_key,'status',updated->>'status','version',actual_version+1);
    updated:=updated||jsonb_build_object('moderationResult',result);
    UPDATE hg_posts SET doc=updated WHERE id=target_key AND doc->>'clubId'=p_club_id;
    IF decision='approve' AND NULLIF(post->>'topicId','') IS NOT NULL THEN
      UPDATE hg_topics SET doc=doc||jsonb_build_object('postCount',COALESCE(NULLIF(doc->>'postCount','')::int,0)+1)
        WHERE id=post->>'topicId' AND doc->>'clubId'=p_club_id;
    END IF;
    UPDATE hg_review_tasks SET doc=task||jsonb_build_object('status',CASE WHEN decision='approve' THEN 'passed' ELSE 'failed' END,
      'finishedAt',now_text,'waitingReason','','nextAttemptAt',NULL,'lastError','','leaseId','','claimedAt',NULL,
      'leaseExpiresAt',NULL,'reviewedBy',p_actor_id,'reviewDecision',decision,'version',COALESCE(NULLIF(task->>'version','')::int,1)+1)
      WHERE id=task_id AND doc->>'clubId'=p_club_id;
    audit_id:='audit:'||md5(clock_timestamp()::text||random()::text);
    INSERT INTO hg_audit_logs(id,doc) VALUES(audit_id,jsonb_build_object('_id',audit_id,'clubId',p_club_id,
      'actorId',p_actor_id,'action','content.'||decision,'targetType','post','targetId',target_key,'decision',decision,'reason',reason,'createdAt',now_text));
    notification_id:='notification:'||md5(clock_timestamp()::text||random()::text);
    INSERT INTO hg_notifications(id,doc) VALUES(notification_id,jsonb_build_object('_id',notification_id,'clubId',p_club_id,
      'recipientId',post->>'ownerId','eventType','system_review','title',CASE decision WHEN 'approve' THEN '你的内容已通过审核' WHEN 'reject' THEN '一条内容需要修改' ELSE '一条内容已被暂时隐藏' END,
      'summary',CASE decision WHEN 'approve' THEN '现在会在你设定的范围内展示。' ELSE reason END,
      'targetType','post','targetId',target_key,'icon',CASE decision WHEN 'approve' THEN 'check-circle' ELSE 'error-circle' END,'createdAt',now_text));
    RETURN result;
  END IF;
  IF p_action='comment.decide' THEN
    target_key:=p_input->>'id'; decision:=p_input->>'decision'; reason:=COALESCE(NULLIF(btrim(p_input->>'reason'),''),'');
    expected_version:=NULLIF(p_input->>'expectedVersion','')::int;
    IF NULLIF(target_key,'') IS NULL OR expected_version IS NULL OR decision NOT IN ('approve','reject','hide') THEN RAISE EXCEPTION 'INVALID'; END IF;
    IF decision<>'approve' AND reason='' THEN RAISE EXCEPTION 'REASON_REQUIRED'; END IF;
    SELECT id,doc INTO task_id,task FROM hg_review_tasks WHERE doc->>'clubId'=p_club_id AND doc->>'targetType'='comment'
      AND doc->>'targetId'=target_key AND doc->>'status'='manual' AND doc->>'postVersion'=expected_version::text
      ORDER BY doc->>'createdAt' DESC,id DESC LIMIT 1 FOR UPDATE;
    IF task_id IS NULL THEN RAISE EXCEPTION 'REVIEW_NOT_READY'; END IF;
    SELECT doc INTO comment FROM hg_comments WHERE id=target_key FOR UPDATE;
    IF comment IS NULL OR comment->>'clubId' IS DISTINCT FROM p_club_id THEN RAISE EXCEPTION 'COMMENT_NOT_FOUND'; END IF;
    SELECT doc INTO post FROM hg_posts WHERE id=comment->>'postId' FOR UPDATE;
    IF post IS NULL OR post->>'clubId' IS DISTINCT FROM p_club_id THEN RAISE EXCEPTION 'POST_NOT_FOUND'; END IF;
    IF post->>'visibility'='private' THEN RAISE EXCEPTION 'PRIVATE_CONTENT'; END IF;
    actual_version:=COALESCE(NULLIF(comment->>'version','')::int,1);
    IF actual_version<>expected_version THEN
      IF actual_version=expected_version+1 AND comment->>'moderationExpectedVersion'=expected_version::text
        AND comment->>'moderationDecision'=decision AND comment->'moderationResult' IS NOT NULL THEN RETURN comment->'moderationResult'; END IF;
      RAISE EXCEPTION 'VERSION_CONFLICT';
    END IF;
    IF comment->>'status'<>'pending' THEN RAISE EXCEPTION 'VERSION_CONFLICT'; END IF;
    updated:=comment||jsonb_build_object('status',CASE decision WHEN 'approve' THEN 'published' WHEN 'reject' THEN 'rejected' ELSE 'hidden' END,
      'rejectReason',CASE WHEN decision='reject' THEN reason ELSE '' END,'reviewedAt',now_text,'reviewedBy',p_actor_id,
      'version',actual_version+1,'moderationExpectedVersion',expected_version,'moderationDecision',decision,
      'moderationDecisionReason',reason,'moderationDecisionBy',p_actor_id,'moderationDecidedAt',now_text);
    result:=jsonb_build_object('ok',true,'id',target_key,'status',updated->>'status','version',actual_version+1);
    updated:=updated||jsonb_build_object('moderationResult',result);
    UPDATE hg_comments SET doc=updated WHERE id=target_key AND doc->>'clubId'=p_club_id;
    IF decision='approve' THEN UPDATE hg_posts SET doc=doc||jsonb_build_object('commentCount',COALESCE(NULLIF(doc->>'commentCount','')::int,0)+1)
      WHERE id=comment->>'postId' AND doc->>'clubId'=p_club_id; END IF;
    UPDATE hg_review_tasks SET doc=task||jsonb_build_object('status',CASE WHEN decision='approve' THEN 'passed' ELSE 'failed' END,
      'finishedAt',now_text,'waitingReason','','nextAttemptAt',NULL,'lastError','','leaseId','','claimedAt',NULL,
      'leaseExpiresAt',NULL,'reviewedBy',p_actor_id,'reviewDecision',decision,'version',COALESCE(NULLIF(task->>'version','')::int,1)+1)
      WHERE id=task_id AND doc->>'clubId'=p_club_id;
    audit_id:='audit:'||md5(clock_timestamp()::text||random()::text);
    INSERT INTO hg_audit_logs(id,doc) VALUES(audit_id,jsonb_build_object('_id',audit_id,'clubId',p_club_id,
      'actorId',p_actor_id,'action','comment.'||decision,'targetType','comment','targetId',target_key,'decision',decision,'reason',reason,'createdAt',now_text));
    notification_id:='notification:'||md5(clock_timestamp()::text||random()::text);
    INSERT INTO hg_notifications(id,doc) VALUES(notification_id,jsonb_build_object('_id',notification_id,'clubId',p_club_id,
      'recipientId',comment->>'ownerId','eventType','system_review','title',CASE decision WHEN 'approve' THEN '你的回应已通过审核' ELSE '你的回应未通过审核' END,
      'summary',CASE decision WHEN 'approve' THEN '你的回应现在会显示在内容下方。' ELSE reason END,
      'targetType','post','targetId',comment->>'postId','icon',CASE decision WHEN 'approve' THEN 'check-circle' ELSE 'error-circle' END,'createdAt',now_text));
    RETURN result;
  END IF;
  IF p_action='membership.decide' THEN
    target_key:=p_input->>'id'; decision:=p_input->>'decision'; reason:=COALESCE(NULLIF(btrim(p_input->>'reason'),''),'');
    expected_version:=NULLIF(p_input->>'expectedVersion','')::int;
    IF NULLIF(target_key,'') IS NULL OR expected_version IS NULL OR decision NOT IN ('approve','reject') THEN RAISE EXCEPTION 'INVALID'; END IF;
    IF decision='reject' AND reason='' THEN RAISE EXCEPTION 'REASON_REQUIRED'; END IF;
    SELECT doc INTO application FROM hg_membership_applications WHERE id=target_key FOR UPDATE;
    IF application IS NULL OR application->>'clubId' IS DISTINCT FROM p_club_id THEN RAISE EXCEPTION 'APPLICATION_NOT_FOUND'; END IF;
    actual_version:=COALESCE(NULLIF(application->>'version','')::int,1);
    IF actual_version<>expected_version THEN RAISE EXCEPTION 'VERSION_CONFLICT'; END IF;
    IF application->>'status'<>'pending' THEN RAISE EXCEPTION 'VERSION_CONFLICT'; END IF;
    IF decision='approve' THEN
      PERFORM 1 FROM hg_users WHERE id=application->>'userId' AND doc->>'status'='active' FOR UPDATE;
      IF NOT FOUND THEN RAISE EXCEPTION 'MEMBER_NOT_FOUND'; END IF;
      SELECT id,doc INTO member_id,existing FROM hg_memberships WHERE doc->>'userId'=application->>'userId'
        AND doc->>'clubId'=p_club_id FOR UPDATE;
      IF existing IS NOT NULL AND existing->>'status'='active' THEN RAISE EXCEPTION 'MEMBERSHIP_EXISTS'; END IF;
      IF existing IS NULL THEN
        member_id:=application->>'userId'||':'||p_club_id;
        INSERT INTO hg_memberships(id,doc) VALUES(member_id,jsonb_build_object('_id',member_id,'userId',application->>'userId',
          'clubId',p_club_id,'role','member','status','active','joinedAt',now_text,'rulesVersion',application->>'rulesVersion','version',1));
      ELSE UPDATE hg_memberships SET doc=existing||jsonb_build_object('role','member','status','active','joinedAt',now_text,
          'rulesVersion',application->>'rulesVersion','version',COALESCE(NULLIF(existing->>'version','')::int,1)+1,'updatedAt',now_text)
        WHERE id=member_id AND doc->>'clubId'=p_club_id; END IF;
      UPDATE hg_users SET doc=doc||jsonb_build_object('displayName',application->>'displayName','updatedAt',now_text) WHERE id=application->>'userId';
    END IF;
    updated:=application||jsonb_build_object('status',CASE decision WHEN 'approve' THEN 'active' ELSE 'rejected' END,
      'decisionReason',reason,'decidedBy',p_actor_id,'decidedAt',now_text,'version',actual_version+1,
      'moderationExpectedVersion',expected_version,'moderationDecision',decision,'moderationDecisionBy',p_actor_id,'moderationDecidedAt',now_text);
    result:=jsonb_build_object('ok',true,'id',target_key,'status',updated->>'status','version',actual_version+1);
    updated:=updated||jsonb_build_object('moderationResult',result);
    UPDATE hg_membership_applications SET doc=updated WHERE id=target_key AND doc->>'clubId'=p_club_id;
    audit_id:='audit:'||md5(clock_timestamp()::text||random()::text);
    INSERT INTO hg_audit_logs(id,doc) VALUES(audit_id,jsonb_build_object('_id',audit_id,'clubId',p_club_id,'actorId',p_actor_id,
      'action','membership.'||decision,'targetType','membership_application','targetId',target_key,'decision',decision,'reason',reason,'createdAt',now_text));
    notification_id:='notification:'||md5(clock_timestamp()::text||random()::text);
    INSERT INTO hg_notifications(id,doc) VALUES(notification_id,jsonb_build_object('_id',notification_id,'clubId',p_club_id,
      'recipientId',application->>'userId','eventType','system_membership','title',CASE decision WHEN 'approve' THEN '欢迎加入社团' ELSE '入社申请未通过' END,
      'summary',CASE decision WHEN 'approve' THEN '现在可以在社内写下第一笔了。' ELSE reason END,'targetType','system','targetId','membership','icon','usergroup','createdAt',now_text));
    RETURN result;
  END IF;
  IF p_action='topic.decide' THEN
    target_key:=p_input->>'id'; decision:=p_input->>'decision'; reason:=COALESCE(NULLIF(btrim(p_input->>'reason'),''),'');
    expected_version:=NULLIF(p_input->>'expectedVersion','')::int;
    IF NULLIF(target_key,'') IS NULL OR expected_version IS NULL OR decision NOT IN ('approve','archive','reject') THEN RAISE EXCEPTION 'INVALID'; END IF;
    IF decision<>'approve' AND reason='' THEN RAISE EXCEPTION 'REASON_REQUIRED'; END IF;
    SELECT doc INTO topic FROM hg_topics WHERE id=target_key FOR UPDATE;
    IF topic IS NULL OR topic->>'clubId' IS DISTINCT FROM p_club_id THEN RAISE EXCEPTION 'TOPIC_NOT_FOUND'; END IF;
    actual_version:=COALESCE(NULLIF(topic->>'version','')::int,1);
    IF actual_version<>expected_version THEN RAISE EXCEPTION 'VERSION_CONFLICT'; END IF;
    IF topic->>'status'<>'pending' THEN RAISE EXCEPTION 'VERSION_CONFLICT'; END IF;
    updated:=topic||jsonb_build_object('status',CASE decision WHEN 'approve' THEN 'active' ELSE 'archived' END,
      'decisionReason',reason,'decidedBy',p_actor_id,'decidedAt',now_text,'version',actual_version+1,
      'moderationExpectedVersion',expected_version,'moderationDecision',decision,'moderationDecisionBy',p_actor_id,'moderationDecidedAt',now_text);
    result:=jsonb_build_object('ok',true,'id',target_key,'status',updated->>'status','version',actual_version+1);
    updated:=updated||jsonb_build_object('moderationResult',result);
    UPDATE hg_topics SET doc=updated WHERE id=target_key AND doc->>'clubId'=p_club_id;
    audit_id:='audit:'||md5(clock_timestamp()::text||random()::text);
    INSERT INTO hg_audit_logs(id,doc) VALUES(audit_id,jsonb_build_object('_id',audit_id,'clubId',p_club_id,'actorId',p_actor_id,
      'action','topic.'||decision,'targetType','topic','targetId',target_key,'decision',decision,'reason',reason,'createdAt',now_text));
    notification_id:='notification:'||md5(clock_timestamp()::text||random()::text);
    INSERT INTO hg_notifications(id,doc) VALUES(notification_id,jsonb_build_object('_id',notification_id,'clubId',p_club_id,
      'recipientId',topic->>'ownerId','eventType','system_notice','title',CASE decision WHEN 'approve' THEN '你的话题已通过' ELSE '你的话题状态已更新' END,
      'summary',CASE decision WHEN 'approve' THEN '现在可以在话题广场参与讨论。' ELSE reason END,'targetType','topic','targetId',target_key,'icon','chat-bubble-1','createdAt',now_text));
    RETURN result;
  END IF;
  IF p_action='report.decide' THEN
    target_key:=p_input->>'id'; decision:=p_input->>'decision'; reason:=NULLIF(btrim(p_input->>'reason'),'');
    expected_version:=NULLIF(p_input->>'expectedVersion','')::int;
    IF NULLIF(target_key,'') IS NULL OR expected_version IS NULL OR reason IS NULL OR decision NOT IN ('keep','hide','escalate') THEN RAISE EXCEPTION 'INVALID'; END IF;
    SELECT doc INTO report FROM hg_reports WHERE id=target_key FOR UPDATE;
    IF report IS NULL OR report->>'clubId' IS DISTINCT FROM p_club_id THEN RAISE EXCEPTION 'REPORT_NOT_FOUND'; END IF;
    actual_version:=COALESCE(NULLIF(report->>'version','')::int,1);
    IF actual_version<>expected_version OR report->>'status'<>'received' THEN RAISE EXCEPTION 'VERSION_CONFLICT'; END IF;
    target_type:=report->>'targetType'; target_id:=report->>'targetId'; owner_id:=NULL;
    IF target_type='post' THEN
      SELECT doc INTO post FROM hg_posts WHERE id=target_id FOR UPDATE;
      IF post IS NOT NULL THEN
        IF post->>'clubId' IS DISTINCT FROM p_club_id THEN RAISE EXCEPTION 'POST_NOT_FOUND'; END IF;
        IF post->>'visibility'='private' THEN RAISE EXCEPTION 'PRIVATE_CONTENT'; END IF;
        IF decision='hide' THEN target_version:=COALESCE(NULLIF(post->>'version','')::int,1);
          UPDATE hg_posts SET doc=post||jsonb_build_object('status','hidden','hiddenReason',reason,
            'permissionVersion',COALESCE(NULLIF(post->>'permissionVersion','')::int,0)+1,'version',target_version+1)
            WHERE id=target_id AND doc->>'clubId'=p_club_id; owner_id:=post->>'ownerId'; END IF;
      ELSIF decision='hide' THEN RAISE EXCEPTION 'POST_NOT_FOUND'; END IF;
    ELSIF target_type='comment' THEN
      SELECT doc INTO comment FROM hg_comments WHERE id=target_id FOR UPDATE;
      IF comment IS NOT NULL THEN
        IF comment->>'clubId' IS DISTINCT FROM p_club_id THEN RAISE EXCEPTION 'COMMENT_NOT_FOUND'; END IF;
        SELECT doc INTO post FROM hg_posts WHERE id=comment->>'postId' FOR UPDATE;
        IF post IS NULL OR post->>'clubId' IS DISTINCT FROM p_club_id THEN RAISE EXCEPTION 'POST_NOT_FOUND'; END IF;
        IF post->>'visibility'='private' THEN RAISE EXCEPTION 'PRIVATE_CONTENT'; END IF;
        IF decision='hide' THEN target_version:=COALESCE(NULLIF(comment->>'version','')::int,1);
          UPDATE hg_comments SET doc=comment||jsonb_build_object('status','hidden','rejectReason',reason,'version',target_version+1)
            WHERE id=target_id AND doc->>'clubId'=p_club_id; owner_id:=comment->>'ownerId'; END IF;
      ELSIF decision='hide' THEN RAISE EXCEPTION 'COMMENT_NOT_FOUND'; END IF;
    END IF;
    updated:=report||jsonb_build_object('status',CASE decision WHEN 'escalate' THEN 'escalated' ELSE 'closed' END,
      'decision',decision,'decisionReason',reason,'decidedBy',p_actor_id,'decidedAt',now_text,'version',actual_version+1,
      'moderationExpectedVersion',expected_version,'moderationDecision',decision,'moderationDecisionBy',p_actor_id,'moderationDecidedAt',now_text);
    result:=jsonb_build_object('ok',true,'id',target_key,'status',updated->>'status','version',actual_version+1);
    updated:=updated||jsonb_build_object('moderationResult',result);
    UPDATE hg_reports SET doc=updated WHERE id=target_key AND doc->>'clubId'=p_club_id;
    audit_id:='audit:'||md5(clock_timestamp()::text||random()::text);
    INSERT INTO hg_audit_logs(id,doc) VALUES(audit_id,jsonb_build_object('_id',audit_id,'clubId',p_club_id,'actorId',p_actor_id,
      'action','report.'||decision,'targetType',target_type,'targetId',target_id,'decision',decision,'reason',reason,'createdAt',now_text));
    IF decision='hide' AND owner_id IS NOT NULL THEN
      notification_id:='notification:'||md5(clock_timestamp()::text||random()::text);
      INSERT INTO hg_notifications(id,doc) VALUES(notification_id,jsonb_build_object('_id',notification_id,'clubId',p_club_id,
        'recipientId',owner_id,'eventType','system_report','title','一条内容已被暂时隐藏','summary',reason||'。如果你认为这是误判，可以申诉。',
        'targetType',target_type,'targetId',target_id,'icon','flag','createdAt',now_text));
    END IF;
    RETURN result;
  END IF;
  IF p_action='collection.decide' THEN
    target_key:=p_input->>'id'; decision:=p_input->>'decision'; reason:=COALESCE(NULLIF(btrim(p_input->>'reason'),''),'');
    expected_version:=NULLIF(p_input->>'expectedVersion','')::int;
    IF NULLIF(target_key,'') IS NULL OR expected_version IS NULL OR decision NOT IN ('include','skip') THEN RAISE EXCEPTION 'INVALID'; END IF;
    IF decision='skip' AND reason='' THEN RAISE EXCEPTION 'REASON_REQUIRED'; END IF;
    SELECT doc INTO task FROM hg_review_tasks WHERE id=target_key FOR UPDATE;
    IF task IS NULL OR task->>'clubId' IS DISTINCT FROM p_club_id OR task->>'targetType'<>'collection_submission' THEN RAISE EXCEPTION 'TASK_NOT_FOUND'; END IF;
    actual_version:=COALESCE(NULLIF(task->>'version','')::int,1);
    IF actual_version<>expected_version OR task->>'status'<>'queued' THEN RAISE EXCEPTION 'VERSION_CONFLICT'; END IF;
    collection_id:=task->>'collectionId'; post_id:=task->>'targetId';
    SELECT doc INTO post FROM hg_posts WHERE id=post_id FOR UPDATE;
    IF post IS NULL OR post->>'clubId' IS DISTINCT FROM p_club_id THEN RAISE EXCEPTION 'POST_NOT_FOUND'; END IF;
    SELECT doc INTO collection FROM hg_collections WHERE id=collection_id FOR UPDATE;
    IF collection IS NULL OR collection->>'clubId' IS DISTINCT FROM p_club_id THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
    owner_id:=post->>'ownerId';
    SELECT COALESCE((doc->'capabilities'->>'anthology')::boolean,false) INTO anthology_enabled FROM hg_club_config WHERE id=p_club_id;
    IF decision='include' AND NOT COALESCE(anthology_enabled,false) THEN RAISE EXCEPTION 'CAPABILITY_DISABLED'; END IF;
    IF decision='include' THEN
      IF post->>'status'<>'published' OR post->>'visibility'='private' THEN RAISE EXCEPTION 'PRIVATE_CONTENT'; END IF;
      SELECT doc INTO consent FROM hg_consents WHERE id=post_id||':collection:'||collection_id FOR UPDATE;
      IF consent IS NULL OR consent->>'clubId' IS DISTINCT FROM p_club_id OR consent->>'postId' IS DISTINCT FROM post_id
        OR NULLIF(consent->>'revokedAt','') IS NOT NULL THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
      IF collection->>'visibility'='public' AND post->>'visibility'<>'public' THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
      PERFORM pg_advisory_xact_lock(hashtextextended('hg-moderate:collection:'||p_club_id||':'||collection_id,0));
      SELECT count(*) INTO entry_count FROM hg_collection_entries WHERE doc->>'clubId'=p_club_id AND doc->>'collectionId'=collection_id;
      INSERT INTO hg_collection_entries(id,doc) VALUES('entry:'||post_id||':'||collection_id,jsonb_build_object(
        '_id','entry:'||post_id||':'||collection_id,'clubId',p_club_id,'collectionId',collection_id,'postId',post_id,
        'consentId',consent->>'_id','order',entry_count+1,'createdAt',now_text)) ON CONFLICT(id) DO NOTHING;
      GET DIAGNOSTICS inserted=ROW_COUNT; IF inserted<>1 THEN RAISE EXCEPTION 'CONFLICT'; END IF;
      UPDATE hg_collections SET doc=collection||jsonb_build_object('entryCount',COALESCE(NULLIF(collection->>'entryCount','')::int,0)+1)
        WHERE id=collection_id AND doc->>'clubId'=p_club_id;
    END IF;
    updated:=task||jsonb_build_object('status',CASE decision WHEN 'include' THEN 'passed' ELSE 'skipped' END,
      'decisionReason',reason,'decidedBy',p_actor_id,'decidedAt',now_text,'version',actual_version+1,
      'moderationExpectedVersion',expected_version,'moderationDecision',decision,'moderationDecisionBy',p_actor_id,'moderationDecidedAt',now_text);
    result:=jsonb_build_object('ok',true,'id',target_key,'status',updated->>'status','version',actual_version+1);
    updated:=updated||jsonb_build_object('moderationResult',result);
    UPDATE hg_review_tasks SET doc=updated WHERE id=target_key AND doc->>'clubId'=p_club_id;
    audit_id:='audit:'||md5(clock_timestamp()::text||random()::text);
    INSERT INTO hg_audit_logs(id,doc) VALUES(audit_id,jsonb_build_object('_id',audit_id,'clubId',p_club_id,'actorId',p_actor_id,
      'action','collection.'||decision,'targetType','post','targetId',post_id,'decision',decision,'reason',reason,'createdAt',now_text));
    notification_id:='notification:'||md5(clock_timestamp()::text||random()::text);
    INSERT INTO hg_notifications(id,doc) VALUES(notification_id,jsonb_build_object('_id',notification_id,'clubId',p_club_id,
      'recipientId',owner_id,'eventType','system_collection','title',CASE decision WHEN 'include' THEN '你的文章被收录了' ELSE '这一期暂时没有收录' END,
      'summary',CASE decision WHEN 'include' THEN '已加入文集目录。' ELSE reason||'。这不代表作品有问题。' END,
      'targetType','post','targetId',post_id,'icon','book-open','createdAt',now_text));
    RETURN result;
  END IF;
  RAISE EXCEPTION 'INVALID';
END $$;
REVOKE ALL ON FUNCTION public.hg_moderate(text,text,jsonb,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.hg_moderate(text,text,jsonb,text) TO service_role;
CREATE OR REPLACE FUNCTION public.hg_moderate(p_action text,p_actor_id text,p_input jsonb DEFAULT '{}'::jsonb) RETURNS jsonb
LANGUAGE sql SECURITY INVOKER SET search_path=public,pg_temp AS $$
  SELECT public.hg_moderate(p_action,p_actor_id,p_input,'heiguang')
$$;

CREATE OR REPLACE FUNCTION public.hg_request_account_deletion(p_user text) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE usr jsonb; member jsonb; club_row record; club_id text; other_count int;
  stamp text:=to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'); row record;
BEGIN
  IF NULLIF(p_user,'') IS NULL THEN RAISE EXCEPTION 'ACCOUNT_NOT_FOUND'; END IF;
  -- Account removal spans every community. Locks follow the same club then
  -- account then membership order as apply/moderation and are acquired sorted.
  FOR club_row IN SELECT id FROM hg_club_config ORDER BY id LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended('hg-governance:'||club_row.id||':members',0));
  END LOOP;
  SELECT doc INTO usr FROM hg_users WHERE id=p_user FOR UPDATE;
  IF usr IS NULL THEN RAISE EXCEPTION 'ACCOUNT_NOT_FOUND'; END IF;
  IF usr->>'status' IN ('deletion_requested','deletion_processing','deleted') THEN RETURN jsonb_build_object('state','pending'); END IF;
  FOR club_id IN SELECT DISTINCT doc->>'clubId' FROM hg_memberships
    WHERE doc->>'userId'=p_user AND doc->>'status'='active' AND doc->>'role'='moderator' ORDER BY 1 LOOP
    SELECT count(*) INTO other_count FROM hg_memberships WHERE doc->>'clubId'=club_id
      AND doc->>'userId'<>p_user AND doc->>'status'='active' AND doc->>'role'='moderator';
    IF other_count=0 THEN RAISE EXCEPTION 'LAST_MODERATOR'; END IF;
  END LOOP;
  UPDATE hg_users SET doc=doc||jsonb_build_object('status','deletion_requested','deletionRequestedAt',stamp) WHERE id=p_user;
  UPDATE hg_memberships SET doc=doc||jsonb_build_object('status','removed','removedAt',stamp,
    'version',COALESCE(NULLIF(doc->>'version','')::int,1)+1) WHERE doc->>'userId'=p_user;
  UPDATE hg_posts SET doc=doc||jsonb_build_object('status','deleted','deletedAt',stamp,
    'version',COALESCE(NULLIF(doc->>'version','')::int,1)+1) WHERE doc->>'ownerId'=p_user AND doc->>'status'<>'deleted';
  FOR row IN SELECT doc->>'postId' AS post_id,count(*) AS n FROM hg_comments WHERE doc->>'ownerId'=p_user AND doc->>'status'='published' GROUP BY doc->>'postId' LOOP
    UPDATE hg_posts SET doc=doc||jsonb_build_object('commentCount',greatest(0,COALESCE(NULLIF(doc->>'commentCount','')::int,0)-row.n)) WHERE id=row.post_id;
  END LOOP;
  UPDATE hg_comments SET doc=doc||jsonb_build_object('status','deleted','deletedAt',stamp,
    'version',COALESCE(NULLIF(doc->>'version','')::int,1)+1) WHERE doc->>'ownerId'=p_user;
  UPDATE hg_assets SET doc=doc||jsonb_build_object('status','revoked','tempFileURL','','revokedAt',stamp)
    WHERE doc->>'ownerId'=p_user AND doc->>'status'<>'purged';
  UPDATE hg_consents SET doc=doc||jsonb_build_object('revokedAt',stamp) WHERE doc->>'ownerId'=p_user OR doc->>'userId'=p_user;
  DELETE FROM hg_collection_entries WHERE doc->>'postId' IN (SELECT id FROM hg_posts WHERE doc->>'ownerId'=p_user);
  INSERT INTO hg_audit_logs(id,doc) VALUES('account-deletion-request:'||p_user,jsonb_build_object(
    '_id','account-deletion-request:'||p_user,'actorId',p_user,'action','account.deletion_request','targetType','user','targetId',p_user,'createdAt',stamp)) ON CONFLICT DO NOTHING;
  RETURN jsonb_build_object('state','pending');
END $$;

CREATE FUNCTION public.hg_resubmit_rejected_post(
  p_key text,p_hash text,p_actor_id text,p_post_id text,p_expected_version integer,p_title text,p_body text,p_club_id text
) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE existing jsonb; post jsonb; asset jsonb; asset_id text; result jsonb; next_version int;
  inserted int; task_id text; audit_id text; idem_key text;
  now_text text:=to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
BEGIN
  IF p_key IS NULL OR length(p_key)<8 OR length(p_key)>256 OR p_hash IS NULL OR length(p_hash)<>64
     OR NULLIF(p_actor_id,'') IS NULL OR NULLIF(p_post_id,'') IS NULL OR NULLIF(p_club_id,'') IS NULL
     OR split_part(p_key,':',1) IS DISTINCT FROM p_actor_id OR p_expected_version IS NULL OR p_expected_version<1 THEN RAISE EXCEPTION 'INVALID'; END IF;
  PERFORM public.hg_require_club_membership(p_actor_id,p_club_id,NULL,'share');
  idem_key:=CASE WHEN p_club_id='heiguang' THEN p_key ELSE 'club:'||p_club_id||':'||md5(p_key) END;
  INSERT INTO hg_idempotency(id,doc) VALUES(idem_key,jsonb_build_object('_id',idem_key,'clubId',p_club_id,
    'actorId',p_actor_id,'fingerprint',p_hash,'state','processing','createdAt',now_text)) ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS inserted=ROW_COUNT;
  IF inserted=0 THEN
    SELECT doc INTO existing FROM hg_idempotency WHERE id=idem_key FOR UPDATE;
    IF existing IS NULL AND p_club_id='heiguang' THEN
      SELECT doc INTO existing FROM hg_idempotency WHERE id=p_key AND COALESCE(doc->>'clubId','heiguang')='heiguang' FOR UPDATE;
      IF existing IS NOT NULL THEN idem_key:=p_key; END IF;
    END IF;
    IF existing->>'fingerprint' IS DISTINCT FROM p_hash
       OR COALESCE(existing->>'actorId',split_part(p_key,':',1)) IS DISTINCT FROM p_actor_id
       OR COALESCE(existing->>'clubId','heiguang') IS DISTINCT FROM p_club_id THEN RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT'; END IF;
    IF existing->>'state'<>'succeeded' THEN RAISE EXCEPTION 'IDEMPOTENCY_PROCESSING'; END IF;
    RETURN existing->'result';
  END IF;
  SELECT doc INTO post FROM hg_posts WHERE id=p_post_id FOR UPDATE;
  IF post IS NULL OR post->>'clubId' IS DISTINCT FROM p_club_id OR post->>'ownerId' IS DISTINCT FROM p_actor_id THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
  IF post->>'status'<>'rejected' OR post->>'visibility' NOT IN ('club','public') THEN RAISE EXCEPTION 'POST_NOT_REJECTED'; END IF;
  IF COALESCE(NULLIF(post->>'version','')::int,1)<>p_expected_version THEN RAISE EXCEPTION 'VERSION_CONFLICT'; END IF;
  IF p_title IS NULL OR p_body IS NULL OR length(p_title)>60
     OR length(p_body)>(CASE WHEN post->>'kind'='article' THEN 20000 ELSE 2000 END)
     OR (post->>'kind'='article' AND btrim(p_title)='')
     OR (btrim(p_body)='' AND jsonb_array_length(COALESCE(post->'assetIds','[]'::jsonb))=0) THEN RAISE EXCEPTION 'INVALID'; END IF;
  next_version:=p_expected_version+1;
  FOR asset_id IN SELECT jsonb_array_elements_text(COALESCE(post->'assetIds','[]'::jsonb)) ORDER BY 1 LOOP
    SELECT doc INTO asset FROM hg_assets WHERE id=asset_id FOR UPDATE;
    IF asset IS NULL OR asset->>'clubId' IS DISTINCT FROM p_club_id OR asset->>'ownerId' IS DISTINCT FROM p_actor_id
       OR asset->>'postId' IS DISTINCT FROM p_post_id OR asset->>'status'<>'verified' THEN RAISE EXCEPTION 'ASSET_BINDING_CONFLICT'; END IF;
    UPDATE hg_assets SET doc=asset||jsonb_build_object('postVersion',next_version,'updatedAt',now_text)
      WHERE id=asset_id AND doc->>'clubId'=p_club_id;
  END LOOP;
  UPDATE hg_posts SET doc=(post-'reviewExpectedVersion'-'reviewDecision'-'reviewResult'-'reviewDecidedAt'
      -'moderationExpectedVersion'-'moderationDecision'-'moderationResult'-'moderationDecidedAt'-'reviewedAt'-'reviewedBy')
    ||jsonb_build_object('title',p_title,'body',p_body,'status','pending','rejectReason','','version',next_version,
      'updatedAt',now_text,'permissionVersion',COALESCE(NULLIF(post->>'permissionVersion','')::int,0)+1,
      'resubmittedFromVersion',p_expected_version) WHERE id=p_post_id AND doc->>'clubId'=p_club_id;
  task_id:='review:'||p_post_id||':'||next_version;
  INSERT INTO hg_review_tasks(id,doc) VALUES(task_id,jsonb_build_object('_id',task_id,'clubId',p_club_id,
    'targetType','post','targetId',p_post_id,'postVersion',next_version,'status','queued','attempts',0,
    'needsMedia',jsonb_array_length(COALESCE(post->'assetIds','[]'::jsonb))>0,'createdAt',now_text));
  audit_id:='audit:'||md5(clock_timestamp()::text||random()::text);
  INSERT INTO hg_audit_logs(id,doc) VALUES(audit_id,jsonb_build_object('_id',audit_id,'clubId',p_club_id,
    'actorId',p_actor_id,'action','post.resubmit','targetType','post','targetId',p_post_id,
    'fromVersion',p_expected_version,'toVersion',next_version,'createdAt',now_text));
  result:=jsonb_build_object('id',p_post_id,'state','pending','version',next_version);
  UPDATE hg_idempotency SET doc=doc||jsonb_build_object('state','succeeded','result',result,'completedAt',now_text) WHERE id=idem_key;
  RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.hg_resubmit_rejected_post(text,text,text,text,integer,text,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.hg_resubmit_rejected_post(text,text,text,text,integer,text,text,text) TO service_role;
CREATE OR REPLACE FUNCTION public.hg_resubmit_rejected_post(p_key text,p_hash text,p_actor_id text,p_post_id text,
  p_expected_version integer,p_title text,p_body text) RETURNS jsonb
LANGUAGE sql SECURITY INVOKER SET search_path=public,pg_temp AS $$
  SELECT public.hg_resubmit_rejected_post(p_key,p_hash,p_actor_id,p_post_id,p_expected_version,p_title,p_body,'heiguang')
$$;

CREATE FUNCTION public.hg_finish_review(
  p_task_id text,p_lease_id text,p_expected_version integer,p_decision text,p_reason text,p_club_id text
) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE task jsonb; post jsonb; comment jsonb; parent_post jsonb; topic jsonb; updated jsonb; updated_task jsonb;
  result jsonb; target_type text; target_id text; target_status text; target_version int; task_version int;
  reason text:=COALESCE(NULLIF(btrim(p_reason),''),''); lease_expires_at timestamptz; audit_id text; notification_id text;
  now_text text:=to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
BEGIN
  IF NULLIF(p_task_id,'') IS NULL OR NULLIF(p_lease_id,'') IS NULL OR p_expected_version IS NULL OR p_expected_version<1
     OR p_decision IS NULL OR p_decision NOT IN ('approve','reject') OR NULLIF(p_club_id,'') IS NULL THEN RAISE EXCEPTION 'INVALID'; END IF;
  IF p_decision='reject' AND reason='' THEN RAISE EXCEPTION 'REASON_REQUIRED'; END IF;
  SELECT doc INTO task FROM hg_review_tasks WHERE id=p_task_id FOR UPDATE;
  IF task IS NULL OR COALESCE(task->>'clubId','heiguang') IS DISTINCT FROM p_club_id THEN RAISE EXCEPTION 'TASK_NOT_FOUND'; END IF;
  IF task->>'status'<>'running' THEN
    IF task->>'reviewExpectedVersion'=p_expected_version::text AND task->>'reviewDecision'=p_decision AND task->'reviewResult' IS NOT NULL THEN RETURN task->'reviewResult'; END IF;
    IF task->'reviewResult' IS NOT NULL THEN RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT'; END IF;
    RAISE EXCEPTION 'TASK_NOT_RUNNING';
  END IF;
  IF task->>'leaseId' IS DISTINCT FROM p_lease_id THEN RAISE EXCEPTION 'LEASE_CONFLICT'; END IF;
  BEGIN lease_expires_at:=NULLIF(task->>'leaseExpiresAt','')::timestamptz; EXCEPTION WHEN invalid_text_representation THEN RAISE EXCEPTION 'LEASE_CONFLICT'; END;
  IF lease_expires_at IS NULL OR lease_expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'LEASE_EXPIRED'; END IF;
  target_type:=task->>'targetType'; target_id:=task->>'targetId';
  IF target_type NOT IN ('post','comment') OR NULLIF(target_id,'') IS NULL THEN RAISE EXCEPTION 'INVALID'; END IF;
  task_version:=NULLIF(task->>'postVersion','')::int;
  IF task_version IS NOT NULL AND task_version<>p_expected_version THEN RAISE EXCEPTION 'VERSION_CONFLICT'; END IF;
  IF target_type='post' THEN
    SELECT doc INTO post FROM hg_posts WHERE id=target_id FOR UPDATE;
    IF post IS NULL OR post->>'clubId' IS DISTINCT FROM p_club_id THEN RAISE EXCEPTION 'POST_NOT_FOUND'; END IF;
    IF post->>'visibility' NOT IN ('public','club') THEN RAISE EXCEPTION 'PRIVATE_CONTENT'; END IF;
    target_version:=COALESCE(NULLIF(post->>'version','')::int,1);
    IF target_version<>p_expected_version THEN
      IF target_version=p_expected_version+1 AND post->>'reviewExpectedVersion'=p_expected_version::text
        AND post->>'reviewDecision'=p_decision AND post->'reviewResult' IS NOT NULL THEN RETURN post->'reviewResult'; END IF;
      RAISE EXCEPTION 'VERSION_CONFLICT';
    END IF;
    IF post->>'status'<>'pending' THEN RAISE EXCEPTION 'VERSION_CONFLICT'; END IF;
    IF p_decision='approve' AND EXISTS(SELECT 1 FROM jsonb_array_elements_text(COALESCE(post->'assetIds','[]'::jsonb)) a
      LEFT JOIN hg_assets asset ON asset.id=a WHERE asset.id IS NULL OR asset.doc->>'clubId' IS DISTINCT FROM p_club_id
      OR asset.doc->>'status'<>'verified' OR asset.doc->>'postId' IS DISTINCT FROM target_id
      OR asset.doc->>'ownerId' IS DISTINCT FROM post->>'ownerId') THEN RAISE EXCEPTION 'PENDING_MEDIA'; END IF;
    target_status:=CASE p_decision WHEN 'approve' THEN 'published' ELSE 'rejected' END;
    updated:=post||jsonb_build_object('status',target_status,
      'rejectReason',CASE WHEN p_decision='reject' THEN reason ELSE COALESCE(post->>'rejectReason','') END,
      'reviewedAt',now_text,'reviewedBy','system','version',target_version+1,
      'reviewExpectedVersion',p_expected_version,'reviewDecision',p_decision,'reviewResult',NULL,'reviewDecidedAt',now_text);
    result:=jsonb_build_object('ok',true,'taskId',p_task_id,'targetType',target_type,'targetId',target_id,'decision',p_decision,
      'status',CASE p_decision WHEN 'approve' THEN 'passed' ELSE 'failed' END,'targetStatus',target_status,'version',target_version+1);
    updated:=updated||jsonb_build_object('reviewResult',result);
    UPDATE hg_posts SET doc=updated WHERE id=target_id AND doc->>'clubId'=p_club_id;
    IF p_decision='approve' AND NULLIF(post->>'topicId','') IS NOT NULL THEN
      UPDATE hg_topics SET doc=doc||jsonb_build_object('postCount',COALESCE(NULLIF(doc->>'postCount','')::int,0)+1)
        WHERE id=post->>'topicId' AND doc->>'clubId'=p_club_id;
    END IF;
    audit_id:='audit:'||md5(clock_timestamp()::text||random()::text);
    INSERT INTO hg_audit_logs(id,doc) VALUES(audit_id,jsonb_build_object('_id',audit_id,'clubId',p_club_id,'actorId','system',
      'action','review.post.'||p_decision,'targetType','post','targetId',target_id,'decision',p_decision,'reason',reason,'createdAt',now_text));
    notification_id:='notification:'||md5(clock_timestamp()::text||random()::text);
    INSERT INTO hg_notifications(id,doc) VALUES(notification_id,jsonb_build_object('_id',notification_id,'clubId',p_club_id,
      'recipientId',post->>'ownerId','eventType','system_review','title',CASE p_decision WHEN 'approve' THEN '你的内容已通过审核' ELSE '一条内容需要修改' END,
      'summary',CASE p_decision WHEN 'approve' THEN '现在会在你设定的范围内展示。' ELSE reason||'。原文已保留，可以修改后重新提交。' END,
      'targetType','post','targetId',target_id,'icon',CASE p_decision WHEN 'approve' THEN 'check-circle' ELSE 'error-circle' END,'createdAt',now_text));
  ELSE
    SELECT doc INTO comment FROM hg_comments WHERE id=target_id FOR UPDATE;
    IF comment IS NULL OR comment->>'clubId' IS DISTINCT FROM p_club_id THEN RAISE EXCEPTION 'COMMENT_NOT_FOUND'; END IF;
    target_version:=COALESCE(NULLIF(comment->>'version','')::int,1);
    IF target_version<>p_expected_version THEN
      IF target_version=p_expected_version+1 AND comment->>'reviewExpectedVersion'=p_expected_version::text
        AND comment->>'reviewDecision'=p_decision AND comment->'reviewResult' IS NOT NULL THEN RETURN comment->'reviewResult'; END IF;
      RAISE EXCEPTION 'VERSION_CONFLICT';
    END IF;
    IF comment->>'status'<>'pending' THEN RAISE EXCEPTION 'VERSION_CONFLICT'; END IF;
    SELECT doc INTO parent_post FROM hg_posts WHERE id=comment->>'postId' FOR UPDATE;
    IF parent_post IS NULL OR parent_post->>'clubId' IS DISTINCT FROM p_club_id THEN RAISE EXCEPTION 'PARENT_NOT_FOUND'; END IF;
    IF NULLIF(comment->>'replyToId','') IS NOT NULL AND NOT EXISTS(SELECT 1 FROM hg_comments parent
      WHERE parent.id=comment->>'replyToId' AND parent.doc->>'clubId'=p_club_id AND parent.doc->>'postId'=comment->>'postId') THEN
      RAISE EXCEPTION 'PARENT_NOT_FOUND';
    END IF;
    IF p_decision='approve' AND (parent_post->>'status'<>'published' OR parent_post->>'visibility' NOT IN ('public','club')) THEN RAISE EXCEPTION 'PARENT_NOT_PUBLISHED'; END IF;
    target_status:=CASE p_decision WHEN 'approve' THEN 'published' ELSE 'rejected' END;
    updated:=comment||jsonb_build_object('status',target_status,
      'rejectReason',CASE WHEN p_decision='reject' THEN reason ELSE COALESCE(comment->>'rejectReason','') END,
      'reviewedAt',now_text,'reviewedBy','system','version',target_version+1,
      'reviewExpectedVersion',p_expected_version,'reviewDecision',p_decision,'reviewResult',NULL,'reviewDecidedAt',now_text);
    result:=jsonb_build_object('ok',true,'taskId',p_task_id,'targetType',target_type,'targetId',target_id,'decision',p_decision,
      'status',CASE p_decision WHEN 'approve' THEN 'passed' ELSE 'failed' END,'targetStatus',target_status,'version',target_version+1);
    updated:=updated||jsonb_build_object('reviewResult',result);
    UPDATE hg_comments SET doc=updated WHERE id=target_id AND doc->>'clubId'=p_club_id;
    IF p_decision='approve' THEN UPDATE hg_posts SET doc=parent_post||jsonb_build_object(
      'commentCount',COALESCE(NULLIF(parent_post->>'commentCount','')::int,0)+1) WHERE id=comment->>'postId' AND doc->>'clubId'=p_club_id; END IF;
    audit_id:='audit:'||md5(clock_timestamp()::text||random()::text);
    INSERT INTO hg_audit_logs(id,doc) VALUES(audit_id,jsonb_build_object('_id',audit_id,'clubId',p_club_id,'actorId','system',
      'action','review.comment.'||p_decision,'targetType','comment','targetId',target_id,'decision',p_decision,'reason',reason,'createdAt',now_text));
    IF p_decision='approve' AND parent_post->>'ownerId' IS DISTINCT FROM comment->>'ownerId' THEN
      notification_id:='notification:'||md5(clock_timestamp()::text||random()::text);
      INSERT INTO hg_notifications(id,doc) VALUES(notification_id,jsonb_build_object('_id',notification_id,'clubId',p_club_id,
        'recipientId',parent_post->>'ownerId','eventType',CASE WHEN comment->>'replyToId' IS NULL THEN 'comment' ELSE 'reply' END,
        'title','有人回应了你的内容','summary','','targetType','post','targetId',comment->>'postId','icon','chat-bubble-1','createdAt',now_text));
    ELSIF p_decision='reject' THEN
      notification_id:='notification:'||md5(clock_timestamp()::text||random()::text);
      INSERT INTO hg_notifications(id,doc) VALUES(notification_id,jsonb_build_object('_id',notification_id,'clubId',p_club_id,
        'recipientId',comment->>'ownerId','eventType','system_review','title','你的回应未通过审核','summary',reason,
        'targetType','comment','targetId',target_id,'icon','error-circle','createdAt',now_text));
    END IF;
  END IF;
  updated_task:=task||jsonb_build_object('status',CASE WHEN target_status='published' THEN 'passed' ELSE 'failed' END,
    'finishedAt',now_text,'waitingReason','','nextAttemptAt',NULL,'lastError','','leaseId','','claimedAt',NULL,
    'leaseExpiresAt',NULL,'version',COALESCE(NULLIF(task->>'version','')::int,1)+1,
    'reviewExpectedVersion',p_expected_version,'reviewDecision',p_decision,'reviewResult',result);
  UPDATE hg_review_tasks SET doc=updated_task WHERE id=p_task_id AND COALESCE(doc->>'clubId','heiguang')=p_club_id;
  RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.hg_finish_review(text,text,integer,text,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.hg_finish_review(text,text,integer,text,text,text) TO service_role;
CREATE OR REPLACE FUNCTION public.hg_finish_review(p_task_id text,p_lease_id text,p_expected_version integer,p_decision text,p_reason text DEFAULT '') RETURNS jsonb
LANGUAGE sql SECURITY INVOKER SET search_path=public,pg_temp AS $$
  SELECT public.hg_finish_review(p_task_id,p_lease_id,p_expected_version,p_decision,p_reason,'heiguang')
$$;

ALTER TABLE public.hg_admin_todo_events ADD COLUMN club_id text;
UPDATE public.hg_admin_todo_events SET club_id='heiguang' WHERE club_id IS NULL;
ALTER TABLE public.hg_admin_todo_events ALTER COLUMN club_id SET NOT NULL;
ALTER TABLE public.hg_admin_todo_events DROP CONSTRAINT hg_admin_todo_events_pkey;
ALTER TABLE public.hg_admin_todo_events ADD PRIMARY KEY (club_id,queue,source_id,source_version);

CREATE OR REPLACE FUNCTION public.hg_emit_admin_todo(p_queue text,p_id text,p_notify boolean DEFAULT true)
RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE item jsonb; parent_post jsonb; actionable boolean:=false; revision text; inserted int;
  label text; stamp text; recipient text; notification_id text; club_id text;
BEGIN
  IF p_id IS NULL THEN RETURN; END IF;
  CASE p_queue
    WHEN 'content' THEN
      SELECT doc INTO item FROM hg_posts WHERE id=p_id;
      club_id:=COALESCE(NULLIF(item->>'clubId',''),'heiguang');
      actionable:=item->>'status'='pending' AND item->>'visibility' IN ('public','club') AND EXISTS(
        SELECT 1 FROM hg_review_tasks WHERE doc->>'clubId'=club_id AND doc->>'targetType'='post'
          AND doc->>'targetId'=p_id AND doc->>'status'='manual' AND COALESCE(doc->>'postVersion','1')=COALESCE(item->>'version','1'));
      label:='内容人工审核';
    WHEN 'comment' THEN
      SELECT doc INTO item FROM hg_comments WHERE id=p_id;
      SELECT doc INTO parent_post FROM hg_posts WHERE id=item->>'postId';
      club_id:=COALESCE(NULLIF(parent_post->>'clubId',''),NULLIF(item->>'clubId',''),'heiguang');
      actionable:=item->>'status'='pending' AND COALESCE(item->>'clubId',club_id)=club_id
        AND parent_post->>'status'='published' AND parent_post->>'visibility' IN ('public','club') AND EXISTS(
          SELECT 1 FROM hg_review_tasks WHERE doc->>'clubId'=club_id AND doc->>'targetType'='comment'
            AND doc->>'targetId'=p_id AND doc->>'status'='manual' AND COALESCE(doc->>'postVersion','1')=COALESCE(item->>'version','1'));
      label:='回应人工审核';
    WHEN 'topic' THEN
      SELECT doc INTO item FROM hg_topics WHERE id=p_id; club_id:=COALESCE(NULLIF(item->>'clubId',''),'heiguang');
      actionable:=item->>'status'='pending'; label:='话题申请';
    WHEN 'member' THEN
      SELECT doc INTO item FROM hg_membership_applications WHERE id=p_id; club_id:=COALESCE(NULLIF(item->>'clubId',''),'heiguang');
      actionable:=item->>'status'='pending'; label:='入社申请';
    WHEN 'report' THEN
      SELECT doc INTO item FROM hg_reports WHERE id=p_id; club_id:=COALESCE(NULLIF(item->>'clubId',''),'heiguang');
      actionable:=item->>'status'='received'; label:='举报待核查';
    WHEN 'collection' THEN
      SELECT doc INTO item FROM hg_review_tasks WHERE id=p_id;
      SELECT doc INTO parent_post FROM hg_posts WHERE id=item->>'targetId';
      club_id:=COALESCE(NULLIF(item->>'clubId',''),NULLIF(parent_post->>'clubId',''),'heiguang');
      actionable:=item->>'targetType'='collection_submission' AND item->>'status'='queued'
        AND parent_post->>'clubId'=club_id AND parent_post->>'visibility' IN ('public','club')
        AND EXISTS(SELECT 1 FROM hg_club_config WHERE id=club_id AND doc#>>'{capabilities,anthology}'='true');
      label:='文集收录申请';
    WHEN 'appeals' THEN
      SELECT doc INTO item FROM hg_appeals WHERE id=p_id; club_id:=COALESCE(NULLIF(item->>'clubId',''),'heiguang');
      actionable:=item->>'status'='submitted'; label:='内容申诉';
    ELSE RAISE EXCEPTION 'INVALID_ADMIN_QUEUE';
  END CASE;
  IF NOT COALESCE(actionable,false) OR club_id IS NULL THEN RETURN; END IF;
  revision:=COALESCE(NULLIF(item->>'version',''),'1');
  INSERT INTO hg_admin_todo_events(club_id,queue,source_id,source_version) VALUES(club_id,p_queue,p_id,revision) ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS inserted=ROW_COUNT;
  IF inserted=0 OR NOT p_notify THEN RETURN; END IF;
  stamp:=to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  FOR recipient IN SELECT DISTINCT m.doc->>'userId' FROM hg_memberships m
    JOIN hg_users u ON u.id=m.doc->>'userId' AND u.doc->>'status'='active'
    WHERE m.doc->>'clubId'=club_id AND m.doc->>'status'='active' AND m.doc->>'role' IN ('admin','moderator') LOOP
    notification_id:='admin-todo:'||md5(jsonb_build_array(club_id,p_queue,p_id,revision,recipient)::text);
    INSERT INTO hg_notifications(id,doc) VALUES(notification_id,jsonb_build_object('_id',notification_id,'clubId',club_id,
      'recipientId',recipient,'eventType','system_notice','title','管理员待办提醒','summary','有新的'||label||'，请前往管理台处理。',
      'targetType',CASE WHEN p_queue='appeals' THEN 'admin_appeals' ELSE 'admin_queue' END,'targetId',p_queue,
      'icon','notification','readAt',NULL,'createdAt',stamp)) ON CONFLICT(id) DO NOTHING;
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION public.hg_admin_todo_changed() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE row_id text; related record;
BEGIN
  row_id:=NEW.id;
  CASE TG_TABLE_NAME
    WHEN 'hg_posts' THEN
      PERFORM hg_emit_admin_todo('content',row_id);
      FOR related IN SELECT id FROM hg_comments WHERE doc->>'postId'=row_id AND doc->>'status'='pending' ORDER BY id LOOP
        PERFORM hg_emit_admin_todo('comment',related.id);
      END LOOP;
      FOR related IN SELECT id FROM hg_review_tasks WHERE doc->>'targetType'='collection_submission'
        AND doc->>'targetId'=row_id AND doc->>'status'='queued' ORDER BY id LOOP PERFORM hg_emit_admin_todo('collection',related.id); END LOOP;
    WHEN 'hg_comments' THEN PERFORM hg_emit_admin_todo('comment',row_id);
    WHEN 'hg_topics' THEN PERFORM hg_emit_admin_todo('topic',row_id);
    WHEN 'hg_membership_applications' THEN PERFORM hg_emit_admin_todo('member',row_id);
    WHEN 'hg_reports' THEN PERFORM hg_emit_admin_todo('report',row_id);
    WHEN 'hg_appeals' THEN PERFORM hg_emit_admin_todo('appeals',row_id);
    WHEN 'hg_review_tasks' THEN CASE NEW.doc->>'targetType'
      WHEN 'post' THEN PERFORM hg_emit_admin_todo('content',NEW.doc->>'targetId');
      WHEN 'comment' THEN PERFORM hg_emit_admin_todo('comment',NEW.doc->>'targetId');
      WHEN 'collection_submission' THEN PERFORM hg_emit_admin_todo('collection',row_id);
      ELSE NULL; END CASE;
    WHEN 'hg_club_config' THEN
      IF NEW.doc#>>'{capabilities,anthology}'='true' THEN
        FOR related IN SELECT id FROM hg_review_tasks WHERE doc->>'clubId'=row_id
          AND doc->>'targetType'='collection_submission' AND doc->>'status'='queued' ORDER BY id LOOP
          PERFORM hg_emit_admin_todo('collection',related.id);
        END LOOP;
      END IF;
    ELSE NULL;
  END CASE;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.hg_emit_admin_todo(text,text,boolean),public.hg_admin_todo_changed() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.hg_emit_admin_todo(text,text,boolean),public.hg_admin_todo_changed() TO service_role;
