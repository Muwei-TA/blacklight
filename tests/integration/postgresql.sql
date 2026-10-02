BEGIN;
DO $$
DECLARE result jsonb; second jsonb; post jsonb; n int;
BEGIN
  IF has_table_privilege('authenticated','public.hg_posts','SELECT') THEN RAISE EXCEPTION 'client read privilege leaked'; END IF;
  IF has_function_privilege('anon','public.hg_store(text,text,jsonb,jsonb,jsonb,integer)','EXECUTE') THEN RAISE EXCEPTION 'client RPC privilege leaked'; END IF;
  INSERT INTO public.hg_users(id,doc) VALUES ('test-pg-user','{"_id":"test-pg-user","status":"active"}'::jsonb);
  INSERT INTO public.hg_memberships(id,doc) VALUES ('test-pg-user:heiguang',
    '{"_id":"test-pg-user:heiguang","userId":"test-pg-user","clubId":"heiguang","status":"active","role":"member"}'::jsonb);
  post := jsonb_build_object('_id','test-pg-atomic-post','ownerId','test-pg-user','clubId','heiguang','body','integration test','visibility','club','status','pending','version',1,'assetIds','[]'::jsonb,'createdAt','2026-09-22T16:00:00.000Z');
  result := public.hg_create_post('test-pg-user:createPost:atomic-key',repeat('a',64),post,NULL);
  second := public.hg_create_post('test-pg-user:createPost:atomic-key',repeat('a',64),post || '{"_id":"test-pg-second-post"}',NULL);
  IF result IS DISTINCT FROM second THEN RAISE EXCEPTION 'idempotent result mismatch'; END IF;
  SELECT count(*) INTO n FROM hg_posts WHERE id IN ('test-pg-atomic-post','test-pg-second-post');
  IF n<>1 THEN RAISE EXCEPTION 'duplicate post'; END IF;
  SELECT count(*) INTO n FROM hg_review_tasks WHERE doc->>'targetId'='test-pg-atomic-post';
  IF n<>1 THEN RAISE EXCEPTION 'missing or duplicate review outbox'; END IF;
  BEGIN
    PERFORM public.hg_create_post('test-pg-user:createPost:atomic-key',repeat('b',64),post,NULL);
    RAISE EXCEPTION 'expected conflict was not raised';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'IDEMPOTENCY_CONFLICT' THEN RAISE; END IF;
  END;
  BEGIN
    PERFORM public.hg_create_post('test-pg-user:createPost:rollback-key',repeat('c',64),post || '{"_id":"test-pg-rollback-post","assetIds":["missing-asset"]}',NULL);
    RAISE EXCEPTION 'expected asset failure was not raised';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'ASSET_BINDING_CONFLICT' THEN RAISE; END IF;
  END;
  IF EXISTS(SELECT 1 FROM hg_idempotency WHERE id='test-pg-user:createPost:rollback-key') THEN RAISE EXCEPTION 'failed transaction retained claim'; END IF;
  IF EXISTS(SELECT 1 FROM hg_posts WHERE id='test-pg-rollback-post') THEN RAISE EXCEPTION 'failed transaction retained post'; END IF;
  result:=public.hg_store('hg_posts','get','{"status":"pending","visibility":{"$op":"in","value":["club"]},"_id":"test-pg-atomic-post"}');
  IF jsonb_array_length(result->'data')<>1 THEN RAISE EXCEPTION 'predicate mismatch'; END IF;
  PERFORM public.hg_store('hg_posts','update','{"_id":"test-pg-atomic-post","version":1}','{"version":{"$op":"inc","value":1},"nested.count":{"$op":"inc","value":2}}');
  result:=public.hg_store('hg_posts','get','{"_id":"test-pg-atomic-post","version":2}');
  IF (result #>> '{data,0,nested,count}')::int<>2 THEN RAISE EXCEPTION 'atomic nested update mismatch'; END IF;
END $$;
ROLLBACK;
SELECT 'PASS: privileges, idempotent replay, changed payload rejection, transactional outbox, rollback recovery, predicates, conditional increment' AS result;
