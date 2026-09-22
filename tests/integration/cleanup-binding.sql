BEGIN;
DO $$
DECLARE asset jsonb; post jsonb;
BEGIN
  asset:='{"_id":"fixture-cleanup-asset","ownerId":"fixture-cleanup-owner","status":"verified","postId":"","cleanupState":"running"}';
  post:='{"_id":"fixture-cleanup-post","ownerId":"fixture-cleanup-owner","status":"pending","visibility":"club","assetIds":["fixture-cleanup-asset"]}';
  INSERT INTO hg_assets(id,doc) VALUES(asset->>'_id',asset);
  BEGIN
    PERFORM hg_create_post('fixture-cleanup-idempotency',repeat('a',64),post);
    RAISE EXCEPTION 'cleanup asset rebound while deletion in flight';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM<>'ASSET_BINDING_CONFLICT' THEN RAISE; END IF;
  END;
  IF EXISTS(SELECT 1 FROM hg_idempotency WHERE id='fixture-cleanup-idempotency') OR EXISTS(SELECT 1 FROM hg_posts WHERE id='fixture-cleanup-post') THEN RAISE EXCEPTION 'failed binding did not rollback'; END IF;
END $$;
ROLLBACK;
SELECT 'PASS: cleanup and post binding cannot own the same file concurrently' AS result;
