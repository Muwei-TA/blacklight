BEGIN;
DO $$
DECLARE a jsonb; got jsonb; i int; stamp text:=to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
BEGIN
  a:=jsonb_build_object('_id','test-image-1','ownerId','test-image-owner','mediaType','image','declaredSize',100,'quotaBytes',2097152,'mimeType','image/png','createdAt',stamp,'expiresAt',now()+interval '15 minutes','status','intent');
  got:=hg_image_intent('test-image-owner','intent-key-1',a);
  got:=hg_image_intent('test-image-owner','intent-key-1',a||'{"_id":"test-duplicate-image"}');
  IF got->>'assetId'<>'test-image-1' THEN RAISE EXCEPTION 'intent replay failed'; END IF;
  FOR i IN 2..3 LOOP
    PERFORM hg_image_intent('test-image-owner','intent-key-'||i,a||jsonb_build_object('_id','test-image-'||i));
  END LOOP;
  BEGIN
    PERFORM hg_image_intent('test-image-owner','intent-key-4',a||'{"_id":"test-image-4"}');
    RAISE EXCEPTION 'pending quota bypassed';
  EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'IMAGE_QUOTA' THEN RAISE; END IF; END;
  BEGIN
    PERFORM hg_claim_image('someone-else','test-image-1','upload-key','hash','lease');
    RAISE EXCEPTION 'foreign image claimed';
  EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'IMAGE_NOT_FOUND' THEN RAISE; END IF; END;
  PERFORM hg_claim_image('test-image-owner','test-image-1','upload-key','hash','lease');
  BEGIN
    PERFORM hg_claim_image('test-image-owner','test-image-1','upload-key','hash','second-lease');
    RAISE EXCEPTION 'active upload lease stolen';
  EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'IMAGE_PROCESSING' THEN RAISE; END IF; END;
  UPDATE hg_assets SET doc=doc||jsonb_build_object('uploadLeaseUntil',now()-interval '1 minute') WHERE id='test-image-1';
  PERFORM hg_claim_image('test-image-owner','test-image-1','upload-key','hash','second-lease');
  BEGIN
    PERFORM hg_claim_image('test-image-owner','test-image-1','upload-key','different-hash','third-lease');
    RAISE EXCEPTION 'image bytes changed on retry';
  EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'IMAGE_CONFLICT' THEN RAISE; END IF; END;
  UPDATE hg_assets SET doc=doc||'{"fileId":"test-file","status":"uploaded"}' WHERE id='test-image-1';
  PERFORM hg_confirm_image('test-image-owner','test-image-1');
  PERFORM hg_confirm_image('test-image-owner','test-image-1');
  IF (SELECT count(*) FROM hg_review_tasks WHERE id='asset-review:test-image-1')<>1 THEN RAISE EXCEPTION 'image outbox duplicate'; END IF;
END $$;
ROLLBACK;
SELECT 'PASS: image intent replay/quota, foreign-owner rejection, lease recovery, immutable bytes, atomic review outbox' AS result;
