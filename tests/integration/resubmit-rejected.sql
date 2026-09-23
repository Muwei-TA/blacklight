DO $$
DECLARE
  first_result jsonb;
  retry_result jsonb;
  saved jsonb;
  n integer;
BEGIN
  -- An exception block is a subtransaction. The final marker intentionally
  -- rolls back all fixtures while keeping this test a single SQL statement.
  BEGIN
  IF has_function_privilege('authenticated',
    'public.hg_resubmit_rejected_post(text,text,text,text,integer,text,text)', 'EXECUTE')
  THEN RAISE EXCEPTION 'client resubmit privilege leaked'; END IF;

  INSERT INTO public.hg_memberships(id, doc) VALUES ('test-resubmit-member',
    '{"_id":"test-resubmit-member","userId":"test-resubmit-user","clubId":"heiguang","status":"active","role":"member"}'::jsonb);
  INSERT INTO public.hg_posts(id, doc) VALUES ('test-resubmit-post',
    '{"_id":"test-resubmit-post","clubId":"heiguang","ownerId":"test-resubmit-user","kind":"fragment","title":"","body":"old","assetIds":[],"visibility":"club","status":"rejected","version":2,"rejectReason":"revise"}'::jsonb);
  INSERT INTO public.hg_review_tasks(id, doc) VALUES ('review:test-resubmit-post',
    '{"_id":"review:test-resubmit-post","targetType":"post","targetId":"test-resubmit-post","postVersion":1,"status":"failed"}'::jsonb);

  first_result := public.hg_resubmit_rejected_post('test-resubmit-user:resubmitPost:key1',
    repeat('a', 64), 'test-resubmit-user', 'test-resubmit-post', 2, '', 'revised');
  retry_result := public.hg_resubmit_rejected_post('test-resubmit-user:resubmitPost:key1',
    repeat('a', 64), 'test-resubmit-user', 'test-resubmit-post', 2, '', 'revised');
  IF first_result IS DISTINCT FROM retry_result OR first_result->>'version' <> '3' THEN
    RAISE EXCEPTION 'idempotent replay failed'; END IF;
  SELECT doc INTO saved FROM public.hg_posts WHERE id = 'test-resubmit-post';
  IF saved->>'status' <> 'pending' OR saved->>'body' <> 'revised'
     OR saved->>'rejectReason' <> '' OR saved->>'version' <> '3' THEN
    RAISE EXCEPTION 'post version/state not advanced'; END IF;
  SELECT count(*) INTO n FROM public.hg_review_tasks WHERE doc->>'targetId' = 'test-resubmit-post';
  IF n <> 2 THEN RAISE EXCEPTION 'new review task missing or duplicate'; END IF;

  BEGIN
    PERFORM public.hg_resubmit_rejected_post('test-resubmit-user:resubmitPost:key1',
      repeat('b', 64), 'test-resubmit-user', 'test-resubmit-post', 2, '', 'changed');
    RAISE EXCEPTION 'expected idempotency conflict';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'IDEMPOTENCY_CONFLICT' THEN RAISE; END IF;
  END;
  BEGIN
    PERFORM public.hg_resubmit_rejected_post('test-resubmit-user:resubmitPost:key2',
      repeat('c', 64), 'test-resubmit-user', 'test-resubmit-post', 2, '', 'stale');
    RAISE EXCEPTION 'expected state conflict';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'POST_NOT_REJECTED' THEN RAISE; END IF;
  END;
  IF EXISTS (SELECT 1 FROM public.hg_idempotency WHERE id = 'test-resubmit-user:resubmitPost:key2') THEN
    RAISE EXCEPTION 'failed request retained idempotency claim'; END IF;
    RAISE EXCEPTION 'TEST_ROLLBACK';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'TEST_ROLLBACK' THEN RAISE; END IF;
    RAISE NOTICE 'PASS: resubmit privileges, replay, version/state, review outbox, rollback';
  END;
END $$;
