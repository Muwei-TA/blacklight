BEGIN;
DO $$
DECLARE asset jsonb; post jsonb;
BEGIN
  INSERT INTO hg_users(id,doc) VALUES('fixture-cleanup-owner','{"_id":"fixture-cleanup-owner","status":"active"}');
  INSERT INTO hg_memberships(id,doc) VALUES('fixture-cleanup-owner:heiguang',
    '{"_id":"fixture-cleanup-owner:heiguang","userId":"fixture-cleanup-owner","clubId":"heiguang","status":"active","role":"member"}');
  asset:='{"_id":"fixture-cleanup-asset","clubId":"heiguang","ownerId":"fixture-cleanup-owner","status":"verified","postId":"","cleanupState":"running"}';
  post:='{"_id":"fixture-cleanup-post","clubId":"heiguang","ownerId":"fixture-cleanup-owner","status":"pending","visibility":"club","assetIds":["fixture-cleanup-asset"]}';
  INSERT INTO hg_assets(id,doc) VALUES(asset->>'_id',asset);
  BEGIN
    PERFORM hg_create_post('fixture-cleanup-owner:createPost:cleanup-key',repeat('a',64),post);
    RAISE EXCEPTION 'cleanup asset rebound while deletion in flight';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM<>'ASSET_BINDING_CONFLICT' THEN RAISE; END IF;
  END;
  IF EXISTS(SELECT 1 FROM hg_idempotency WHERE id='fixture-cleanup-owner:createPost:cleanup-key') OR EXISTS(SELECT 1 FROM hg_posts WHERE id='fixture-cleanup-post') THEN RAISE EXCEPTION 'failed binding did not rollback'; END IF;
END $$;
ROLLBACK;
SELECT 'PASS: cleanup and post binding cannot own the same file concurrently' AS result;
