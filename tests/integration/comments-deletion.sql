BEGIN;
DO $$
DECLARE c jsonb; got jsonb; u text; before_count int;
BEGIN
  INSERT INTO hg_posts(id,doc) VALUES('test-atomic-comment-post','{"_id":"test-atomic-comment-post","status":"published","visibility":"club","commentsEnabled":true,"commentCount":0,"ownerId":"fixture-author"}');
  c:='{"_id":"test-atomic-comment","postId":"test-atomic-comment-post","ownerId":"fixture-author","status":"pending","version":1}';
  got:=hg_create_comment('test-atomic-comment-key','hash1',c);
  IF got->>'state'<>'pending' THEN RAISE EXCEPTION 'comment state wrong'; END IF;
  got:=hg_create_comment('test-atomic-comment-key','hash1',c||'{"_id":"duplicate"}');
  IF got->>'id'<>'test-atomic-comment' THEN RAISE EXCEPTION 'comment retry duplicated'; END IF;
  IF (SELECT count(*) FROM hg_review_tasks WHERE doc->>'targetId'='test-atomic-comment')<>1 THEN RAISE EXCEPTION 'comment outbox duplicate'; END IF;
  BEGIN
    PERFORM hg_create_comment('test-atomic-comment-key','hash2',c);
    RAISE EXCEPTION 'changed request accepted';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM<>'IDEMPOTENCY_CONFLICT' THEN RAISE; END IF;
  END;
  UPDATE hg_posts SET doc=doc||'{"status":"hidden"}' WHERE id='test-atomic-comment-post';
  BEGIN
    PERFORM hg_create_comment('test-comment-hidden-key','hash1',c||'{"_id":"test-hidden-comment"}');
    RAISE EXCEPTION 'comment to hidden post accepted';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM<>'COMMENT_TARGET_CHANGED' THEN RAISE; END IF;
  END;
  IF EXISTS(SELECT 1 FROM hg_idempotency WHERE id='test-comment-hidden-key') THEN RAISE EXCEPTION 'failed comment retained claim'; END IF;
  -- Two tombstones must not collide on the unique WeChat identity index.
  FOREACH u IN ARRAY ARRAY['test-delete-a','test-delete-b'] LOOP
    INSERT INTO hg_users(id,doc) VALUES(u,jsonb_build_object('_id',u,'wxOpenIdRef',u,'status','active','displayName','fixture'));
    INSERT INTO hg_posts(id,doc) VALUES(u||'-post',jsonb_build_object('_id',u||'-post','ownerId',u,'status','published','visibility','club','body','fixture body','version',1));
    INSERT INTO hg_assets(id,doc) VALUES(u||'-asset',jsonb_build_object('_id',u||'-asset','ownerId',u,'status','verified','fileId','fixture-file','postId',u||'-post'));
    PERFORM hg_request_account_deletion(u);
    IF (SELECT doc->>'status' FROM hg_posts WHERE id=u||'-post')<>'deleted' THEN RAISE EXCEPTION 'request did not stop display'; END IF;
    UPDATE hg_users SET doc=doc||'{"status":"deletion_processing","deletionLeaseId":"lease"}' WHERE id=u;
    BEGIN
      PERFORM hg_finish_account_deletion(u,'wrong-lease');
      RAISE EXCEPTION 'stale deletion lease accepted';
    EXCEPTION WHEN raise_exception THEN
      IF SQLERRM<>'DELETION_LEASE_LOST' THEN RAISE; END IF;
    END;
    BEGIN
      PERFORM hg_finish_account_deletion(u,'lease');
      RAISE EXCEPTION 'unconfirmed files silently deleted';
    EXCEPTION WHEN raise_exception THEN
      IF SQLERRM<>'DELETION_FILES_PENDING' THEN RAISE; END IF;
    END;
    IF EXISTS(SELECT 1 FROM hg_audit_logs WHERE id='account-deletion:'||u) THEN RAISE EXCEPTION 'early deletion completion audit'; END IF;
    UPDATE hg_assets SET doc=doc||'{"status":"purged"}' WHERE id=u||'-asset';
    PERFORM hg_finish_account_deletion(u,'lease');
    PERFORM hg_finish_account_deletion(u,'lease');
    IF (SELECT doc->>'wxOpenIdRef' FROM hg_users WHERE id=u) IS NOT NULL THEN RAISE EXCEPTION 'identity retained'; END IF;
    IF (SELECT doc->>'body' FROM hg_posts WHERE id=u||'-post')<>'' THEN RAISE EXCEPTION 'body retained'; END IF;
    IF (SELECT count(*) FROM hg_audit_logs WHERE id='account-deletion:'||u)<>1 THEN RAISE EXCEPTION 'completion audit duplicated'; END IF;
  END LOOP;
END $$;
ROLLBACK;
SELECT 'PASS: comment idempotency/outbox/rollback and deletion visibility/files/leases/tombstones' AS result;
