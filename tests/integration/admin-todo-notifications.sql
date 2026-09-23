-- Run after all migrations. Fixtures and all emitted notifications roll back.
BEGIN;
CREATE FUNCTION pg_temp.fixture(table_name text, ident text, fields jsonb) RETURNS void
LANGUAGE plpgsql AS $$ BEGIN
  EXECUTE format('INSERT INTO public.%I(id,doc) VALUES($1,$2)',table_name)
    USING ident,fields||jsonb_build_object('_id',ident);
END $$;
CREATE FUNCTION pg_temp.assert_count(expected int, description text) RETURNS void
LANGUAGE plpgsql AS $$ DECLARE actual int; BEGIN
  SELECT count(*) INTO actual FROM hg_notifications
    WHERE doc->>'recipientId' IN ('todo-test-admin','todo-test-moderator');
  IF actual<>expected THEN RAISE EXCEPTION '%: expected %, got %',description,expected,actual; END IF;
END $$;
DO $$
DECLARE who text; actor text; n int;
BEGIN
  FOREACH who IN ARRAY ARRAY['admin','moderator','member','removed','disabled','other-club'] LOOP
    actor:='todo-test-'||who;
    PERFORM pg_temp.fixture('hg_users',actor,jsonb_build_object('status',CASE who WHEN 'disabled' THEN 'deleted' ELSE 'active' END));
    PERFORM pg_temp.fixture('hg_memberships',actor,jsonb_build_object('userId',actor,
      'clubId',CASE who WHEN 'other-club' THEN 'elsewhere' ELSE 'heiguang' END,
      'role',CASE who WHEN 'member' THEN 'member' WHEN 'moderator' THEN 'moderator' ELSE 'admin' END,
      'status',CASE who WHEN 'removed' THEN 'removed' ELSE 'active' END));
  END LOOP;
  -- Successful direct joining is not an administrative todo.
  PERFORM pg_temp.fixture('hg_membership_applications','todo-test-application',
    '{"userId":"todo-test-applicant","clubId":"heiguang","status":"active","inviteCode":"SECRET-INVITE","displayName":"SECRET-NAME"}');
  PERFORM pg_temp.assert_count(0,'direct active membership excluded');
  PERFORM pg_temp.fixture('hg_topics','todo-test-topic','{"clubId":"heiguang","status":"pending","title":"SECRET-TOPIC"}');
  PERFORM pg_temp.assert_count(2,'topic fans out to both roles');
  UPDATE hg_topics SET doc=doc||'{"description":"changed"}' WHERE id='todo-test-topic';
  PERFORM pg_temp.assert_count(2,'same source revision retry');
  PERFORM pg_temp.fixture('hg_reports','todo-test-report','{"status":"received","reporterId":"SECRET-REPORTER","reason":"SECRET-REASON"}');
  PERFORM pg_temp.assert_count(4,'report event');
  PERFORM pg_temp.fixture('hg_appeals','todo-test-appeal','{"status":"submitted","postId":"todo-test-post","ownerId":"SECRET-OWNER","contentVersion":1,"reason":"SECRET-APPEAL"}');
  PERFORM pg_temp.assert_count(6,'appeal event');
  PERFORM pg_temp.fixture('hg_posts','todo-test-post','{"clubId":"heiguang","visibility":"club","status":"pending","version":1,"body":"SECRET-BODY"}');
  PERFORM pg_temp.fixture('hg_review_tasks','todo-test-review','{"targetType":"post","targetId":"todo-test-post","status":"queued","postVersion":1}');
  PERFORM pg_temp.assert_count(6,'automatic queue must not notify');
  UPDATE hg_review_tasks SET doc=doc||'{"status":"manual"}' WHERE id='todo-test-review';
  PERFORM pg_temp.assert_count(8,'manual post event');
  UPDATE hg_review_tasks SET doc=doc||'{"status":"running"}' WHERE id='todo-test-review';
  UPDATE hg_review_tasks SET doc=doc||'{"status":"manual"}' WHERE id='todo-test-review';
  PERFORM pg_temp.assert_count(8,'manual worker retry');
  UPDATE hg_posts SET doc=doc||'{"status":"rejected","version":2}' WHERE id='todo-test-post';
  UPDATE hg_posts SET doc=doc||'{"status":"pending","version":3}' WHERE id='todo-test-post';
  PERFORM pg_temp.assert_count(8,'old manual task cannot notify resubmitted version');
  PERFORM pg_temp.fixture('hg_review_tasks','todo-test-review-v3','{"targetType":"post","targetId":"todo-test-post","status":"manual","postVersion":3}');
  PERFORM pg_temp.assert_count(10,'new submitted version event');
  PERFORM pg_temp.fixture('hg_posts','todo-test-private','{"clubId":"heiguang","visibility":"private","status":"pending","version":1}');
  PERFORM pg_temp.fixture('hg_review_tasks','todo-test-private-review','{"targetType":"post","targetId":"todo-test-private","status":"manual","postVersion":1}');
  PERFORM pg_temp.assert_count(10,'private post excluded');
  PERFORM pg_temp.fixture('hg_comments','todo-test-comment','{"postId":"todo-test-post","status":"pending","version":1,"body":"SECRET-COMMENT"}');
  PERFORM pg_temp.fixture('hg_review_tasks','todo-test-comment-review','{"targetType":"comment","targetId":"todo-test-comment","status":"manual","postVersion":1}');
  PERFORM pg_temp.assert_count(10,'comment hidden until parent published');
  UPDATE hg_posts SET doc=doc||'{"status":"published","version":4}' WHERE id='todo-test-post';
  PERFORM pg_temp.assert_count(12,'parent publish reveals manual comment');
  UPDATE hg_posts SET doc=doc||'{"visibility":"private"}' WHERE id='todo-test-post';
  UPDATE hg_posts SET doc=doc||'{"visibility":"club"}' WHERE id='todo-test-post';
  PERFORM pg_temp.assert_count(12,'parent visibility toggle is not new submission');
  INSERT INTO hg_club_config(id,doc) VALUES('heiguang','{"_id":"heiguang","capabilities":{"anthology":false}}')
    ON CONFLICT(id) DO UPDATE SET doc=EXCLUDED.doc;
  PERFORM pg_temp.fixture('hg_review_tasks','todo-test-collection','{"targetType":"collection_submission","targetId":"todo-test-post","status":"queued"}');
  PERFORM pg_temp.assert_count(12,'disabled anthology has no actionable notification');
  UPDATE hg_club_config SET doc=doc||'{"capabilities":{"anthology":true}}' WHERE id='heiguang';
  PERFORM pg_temp.assert_count(14,'enable anthology reveals collection todo');
  PERFORM pg_temp.fixture('hg_review_tasks','todo-test-private-collection','{"targetType":"collection_submission","targetId":"todo-test-private","status":"queued"}');
  PERFORM pg_temp.assert_count(14,'private collection excluded');
  IF EXISTS(SELECT 1 FROM hg_notifications WHERE doc->>'recipientId' LIKE 'todo-test-%'
      AND doc->>'recipientId' NOT IN ('todo-test-admin','todo-test-moderator')) THEN
    RAISE EXCEPTION 'inactive, other club, deleted account or ordinary member received admin notification';
  END IF;
  IF EXISTS(SELECT 1 FROM hg_notifications WHERE doc->>'recipientId' LIKE 'todo-test-%'
      AND (doc::text LIKE '%SECRET-%' OR doc->>'targetId' NOT IN ('content','comment','topic','report','collection','appeals')
        OR NOT doc ? 'readAt')) THEN RAISE EXCEPTION 'notification contains private data or invalid routing/read contract'; END IF;
  -- Notification and event insert must be in the same rollback scope as source.
  BEGIN
    PERFORM pg_temp.fixture('hg_topics','todo-test-rollback','{"clubId":"heiguang","status":"pending"}');
    RAISE EXCEPTION 'intentional rollback';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM<>'intentional rollback' THEN RAISE; END IF;
  END;
  PERFORM pg_temp.assert_count(14,'rolled back business write left no notification');
  IF EXISTS(SELECT 1 FROM hg_admin_todo_events WHERE source_id='todo-test-rollback') THEN RAISE EXCEPTION 'event leaked rollback'; END IF;
  UPDATE hg_membership_applications SET doc=doc||'{"status":"pending"}' WHERE id='todo-test-application';
  PERFORM pg_temp.assert_count(16,'removed member reapplication requires administrator attention');
  UPDATE hg_memberships SET doc=doc||'{"role":"member"}' WHERE id='todo-test-admin';
  PERFORM pg_temp.fixture('hg_topics','todo-test-topic-after-revoke','{"clubId":"heiguang","status":"pending"}');
  PERFORM pg_temp.assert_count(17,'revoked admin receives no new event');
  IF has_table_privilege('anon','hg_admin_todo_events','SELECT')
    OR has_table_privilege('authenticated','hg_admin_todo_events','INSERT')
    OR has_function_privilege('authenticated','hg_emit_admin_todo(text,text,boolean)','EXECUTE')
    OR has_function_privilege('anon','hg_admin_todo_changed()','EXECUTE') THEN RAISE EXCEPTION 'client access widened'; END IF;
  SELECT count(*) INTO n FROM hg_admin_todo_events WHERE source_id LIKE 'todo-test-%';
  IF n<>9 THEN RAISE EXCEPTION 'event ledger count incorrect: %',n; END IF;
END $$;
ROLLBACK;
