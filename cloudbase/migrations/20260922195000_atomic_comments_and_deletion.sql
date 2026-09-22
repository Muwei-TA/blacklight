CREATE UNIQUE INDEX hg_alias_thread_user_idx ON hg_anonymous_identities ((doc->>'threadId'),(doc->>'userId'));
CREATE FUNCTION public.hg_create_comment(p_key text,p_hash text,p_comment jsonb,p_alias jsonb DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE existing jsonb; post jsonb; result jsonb; inserted int; ident text:=p_comment->>'_id';
BEGIN
  INSERT INTO hg_idempotency(id,doc) VALUES(p_key,jsonb_build_object('_id',p_key,'fingerprint',p_hash,'state','processing','createdAt',p_comment->'createdAt')) ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS inserted=ROW_COUNT;
  IF inserted=0 THEN
    SELECT doc INTO existing FROM hg_idempotency WHERE id=p_key FOR UPDATE;
    IF existing->>'fingerprint' IS DISTINCT FROM p_hash THEN RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT'; END IF;
    IF existing->>'state'<>'succeeded' THEN RAISE EXCEPTION 'IDEMPOTENCY_PROCESSING'; END IF;
    RETURN existing->'result';
  END IF;
  SELECT doc INTO post FROM hg_posts WHERE id=p_comment->>'postId' FOR UPDATE;
  IF post IS NULL OR post->>'status'<>'published' OR post->>'visibility'='private' OR post->'commentsEnabled'='false'::jsonb THEN RAISE EXCEPTION 'COMMENT_TARGET_CHANGED'; END IF;
  INSERT INTO hg_comments(id,doc) VALUES(ident,p_comment);
  IF p_alias IS NOT NULL THEN
    INSERT INTO hg_anonymous_identities(id,doc) VALUES(p_alias->>'_id',p_alias) ON CONFLICT DO NOTHING;
  END IF;
  INSERT INTO hg_review_tasks(id,doc) VALUES('comment-review:'||ident,jsonb_build_object('_id','comment-review:'||ident,'targetType','comment','targetId',ident,'postVersion',1,'status','queued','attempts',0,'needsMedia',false,'createdAt',p_comment->'createdAt'));
  result:=jsonb_build_object('id',ident,'state','pending');
  UPDATE hg_idempotency SET doc=doc||jsonb_build_object('state','succeeded','result',result,'completedAt',p_comment->'createdAt') WHERE id=p_key;
  RETURN result;
END $$;
CREATE FUNCTION public.hg_request_account_deletion(p_user text) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE usr jsonb; member jsonb; stamp text:=to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'); row record;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('hg-governance:heiguang:members'));
  SELECT doc INTO usr FROM hg_users WHERE id=p_user FOR UPDATE;
  IF usr IS NULL THEN RAISE EXCEPTION 'ACCOUNT_NOT_FOUND'; END IF;
  IF usr->>'status' IN ('deletion_requested','deletion_processing','deleted') THEN RETURN jsonb_build_object('state','pending'); END IF;
  SELECT doc INTO member FROM hg_memberships WHERE doc->>'userId'=p_user AND doc->>'clubId'='heiguang' FOR UPDATE;
  IF member->>'role'='moderator' AND member->>'status'='active' AND NOT EXISTS(SELECT 1 FROM hg_memberships WHERE doc->>'clubId'='heiguang' AND doc->>'userId'<>p_user AND doc->>'role'='moderator' AND doc->>'status'='active') THEN RAISE EXCEPTION 'LAST_MODERATOR'; END IF;
  UPDATE hg_users SET doc=doc||jsonb_build_object('status','deletion_requested','deletionRequestedAt',stamp) WHERE id=p_user;
  UPDATE hg_memberships SET doc=doc||jsonb_build_object('status','removed','removedAt',stamp,'version',coalesce((doc->>'version')::int,1)+1) WHERE doc->>'userId'=p_user;
  UPDATE hg_posts SET doc=doc||jsonb_build_object('status','deleted','deletedAt',stamp,'version',coalesce((doc->>'version')::int,1)+1) WHERE doc->>'ownerId'=p_user AND doc->>'status'<>'deleted';
  FOR row IN SELECT doc->>'postId' AS post_id,count(*) AS n FROM hg_comments WHERE doc->>'ownerId'=p_user AND doc->>'status'='published' GROUP BY doc->>'postId' LOOP
    UPDATE hg_posts SET doc=doc||jsonb_build_object('commentCount',greatest(0,coalesce((doc->>'commentCount')::int,0)-row.n)) WHERE id=row.post_id;
  END LOOP;
  UPDATE hg_comments SET doc=doc||jsonb_build_object('status','deleted','deletedAt',stamp,'version',coalesce((doc->>'version')::int,1)+1) WHERE doc->>'ownerId'=p_user;
  UPDATE hg_assets SET doc=doc||jsonb_build_object('status','revoked','tempFileURL','','revokedAt',stamp) WHERE doc->>'ownerId'=p_user AND doc->>'status'<>'purged';
  UPDATE hg_consents SET doc=doc||jsonb_build_object('revokedAt',stamp) WHERE doc->>'ownerId'=p_user OR doc->>'userId'=p_user;
  DELETE FROM hg_collection_entries WHERE doc->>'postId' IN (SELECT id FROM hg_posts WHERE doc->>'ownerId'=p_user);
  INSERT INTO hg_audit_logs(id,doc) VALUES('account-deletion-request:'||p_user,jsonb_build_object('_id','account-deletion-request:'||p_user,'actorId',p_user,'action','account.deletion_request','targetType','user','targetId',p_user,'createdAt',stamp)) ON CONFLICT DO NOTHING;
  RETURN jsonb_build_object('state','pending');
END $$;
REVOKE ALL ON FUNCTION public.hg_request_account_deletion(text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.hg_request_account_deletion(text) TO service_role;
CREATE FUNCTION public.hg_finish_account_deletion(p_user text,p_lease text) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE usr jsonb; row record; stamp text; audit_id text;
BEGIN
  SELECT doc INTO usr FROM hg_users WHERE id=p_user FOR UPDATE;
  IF usr->>'status'='deleted' THEN RETURN jsonb_build_object('done',true); END IF;
  IF usr IS NULL OR usr->>'status'<>'deletion_processing' OR usr->>'deletionLeaseId' IS DISTINCT FROM p_lease THEN RAISE EXCEPTION 'DELETION_LEASE_LOST'; END IF;
  IF EXISTS(SELECT 1 FROM hg_assets WHERE doc->>'ownerId'=p_user AND doc->>'status'<>'purged') THEN RAISE EXCEPTION 'DELETION_FILES_PENDING'; END IF;
  stamp:=to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  FOR row IN SELECT doc->>'postId' AS post_id,count(*) AS n FROM hg_comments WHERE doc->>'ownerId'=p_user AND doc->>'status'='published' GROUP BY doc->>'postId' LOOP
    UPDATE hg_posts SET doc=doc||jsonb_build_object('commentCount',greatest(0,coalesce((doc->>'commentCount')::int,0)-row.n)) WHERE id=row.post_id;
  END LOOP;
  UPDATE hg_posts SET doc=doc||jsonb_build_object('body','','title','','ownerId',NULL,'assetIds','[]'::jsonb,'status','deleted','deletedAt',stamp) WHERE doc->>'ownerId'=p_user;
  DELETE FROM hg_comments WHERE doc->>'ownerId'=p_user;
  DELETE FROM hg_assets WHERE doc->>'ownerId'=p_user;
  DELETE FROM hg_anonymous_identities WHERE doc->>'userId'=p_user;
  DELETE FROM hg_membership_applications WHERE doc->>'userId'=p_user;
  DELETE FROM hg_reactions WHERE doc->>'userId'=p_user;
  DELETE FROM hg_bookmarks WHERE doc->>'userId'=p_user;
  DELETE FROM hg_topic_follows WHERE doc->>'userId'=p_user;
  DELETE FROM hg_notifications WHERE doc->>'recipientId'=p_user;
  UPDATE hg_memberships SET doc=doc||jsonb_build_object('status','removed','mutedUntil',NULL,'removedAt',stamp) WHERE doc->>'userId'=p_user;
  UPDATE hg_reports SET doc=doc||jsonb_build_object('reporterId',NULL,'evidence','') WHERE doc->>'reporterId'=p_user;
  UPDATE hg_appeals SET doc=doc||jsonb_build_object('ownerId',NULL,'reason','') WHERE doc->>'ownerId'=p_user;
  UPDATE hg_users SET doc=jsonb_build_object('_id',p_user,'wxOpenIdRef',NULL,'displayName','已注销成员','status','deleted','deletedAt',stamp,'deletionCompletedAt',stamp) WHERE id=p_user;
  audit_id:='account-deletion:'||p_user;
  INSERT INTO hg_audit_logs(id,doc) VALUES(audit_id,jsonb_build_object('_id',audit_id,'actorId','system','action','account.deletion_executed','targetType','user','targetId',p_user,'createdAt',stamp)) ON CONFLICT DO NOTHING;
  RETURN jsonb_build_object('done',true);
END $$;
REVOKE ALL ON FUNCTION public.hg_create_comment(text,text,jsonb,jsonb),public.hg_finish_account_deletion(text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.hg_create_comment(text,text,jsonb,jsonb),public.hg_finish_account_deletion(text,text) TO service_role;
UPDATE hg_users SET doc=doc||'{"wxOpenIdRef":null}'::jsonb WHERE doc->>'wxOpenIdRef'='';
