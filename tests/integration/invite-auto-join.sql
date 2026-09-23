-- Run after all migrations through 20260924080000. Fixtures roll back.
BEGIN;
DO $$
DECLARE
  result jsonb;
  item jsonb;
  bad_invite jsonb;
  i integer := 0;
BEGIN
  IF (SELECT prosecdef FROM pg_proc WHERE oid = 'public.hg_apply_membership(text,jsonb)'::regprocedure) THEN
    RAISE EXCEPTION 'admission must be SECURITY INVOKER';
  END IF;
  IF has_function_privilege('anon', 'public.hg_apply_membership(text,jsonb)', 'execute')
     OR has_function_privilege('authenticated', 'public.hg_apply_membership(text,jsonb)', 'execute') THEN
    RAISE EXCEPTION 'clients can execute trusted-actor RPC';
  END IF;
  INSERT INTO hg_club_config(id,doc) VALUES('heiguang','{"_id":"heiguang","rulesVersion":"v1.0"}')
    ON CONFLICT(id) DO UPDATE SET doc=hg_club_config.doc||'{"rulesVersion":"v1.0"}';
  INSERT INTO hg_users(id,doc)
    SELECT u,jsonb_build_object('_id',u,'status','active','displayName','old')
    FROM unnest(ARRAY['auto-legacy','auto-replace','auto-removed','auto-invalid','auto-blocked','auto-rollback','auto-moderator']) u;
  UPDATE hg_users SET doc=doc||'{"status":"deletion_requested"}' WHERE id='auto-blocked';
  INSERT INTO hg_memberships(id,doc) VALUES
    ('auto-removed:heiguang','{"_id":"auto-removed:heiguang","userId":"auto-removed","clubId":"heiguang","role":"moderator","status":"removed","version":7}'),
    ('auto-moderator:heiguang','{"_id":"auto-moderator:heiguang","userId":"auto-moderator","clubId":"heiguang","role":"moderator","status":"active","version":1}');
  INSERT INTO hg_invite_codes(id,doc) VALUES
    ('AUTOPAID','{"_id":"AUTOPAID","clubId":"heiguang","maxUses":1,"usedCount":1}'),
    ('AUTONEW','{"_id":"AUTONEW","clubId":"heiguang","maxUses":1,"usedCount":0}'),
    ('AUTORESTORE','{"_id":"AUTORESTORE","clubId":"heiguang","maxUses":1,"usedCount":0}'),
    ('AUTOBLOCKED','{"_id":"AUTOBLOCKED","clubId":"heiguang","maxUses":1,"usedCount":0}');
  INSERT INTO hg_membership_applications(id,doc) VALUES
    ('auto-legacy-app','{"_id":"auto-legacy-app","userId":"auto-legacy","clubId":"heiguang","inviteCode":"AUTOPAID","displayName":"old","rulesVersion":"v0.9","status":"pending","version":1,"createdAt":"2026-01-01T00:00:00Z"}');
  result:=hg_apply_membership('auto-legacy','{"inviteCode":"AUTOPAID","displayName":"legacy","rulesVersion":"v1.0"}');
  IF result->>'state'<>'active' OR result->>'applicationId'<>'auto-legacy-app' THEN RAISE EXCEPTION 'legacy admission failed'; END IF;
  SELECT doc INTO item FROM hg_invite_codes WHERE id='AUTOPAID';
  IF (item->>'usedCount')::integer<>1 THEN RAISE EXCEPTION 'legacy charged twice'; END IF;
  SELECT doc INTO item FROM hg_membership_applications WHERE id='auto-legacy-app';
  IF item->>'version'<>'2' OR item->>'rulesVersion'<>'v1.0' THEN RAISE EXCEPTION 'legacy consent/version lost'; END IF;
  -- A stale moderator screen must not decide an application admitted already.
  BEGIN
    PERFORM hg_moderate('membership.decide','auto-moderator',jsonb_build_object('id','auto-legacy-app','expectedVersion',1,'decision','approve'));
    RAISE EXCEPTION 'legacy moderator approval succeeded';
  EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'VERSION_CONFLICT' THEN RAISE; END IF; END;

  INSERT INTO hg_membership_applications(id,doc) VALUES
    ('auto-replace-app','{"_id":"auto-replace-app","userId":"auto-replace","clubId":"heiguang","inviteCode":"AUTOEXPIRED","displayName":"old","rulesVersion":"v0.9","status":"pending","version":1,"createdAt":"2026-01-01T00:00:00Z"}');
  result:=hg_apply_membership('auto-replace','{"inviteCode":"AUTONEW","displayName":"replace","rulesVersion":"v1.0"}');
  IF result->>'state'<>'active' OR result->>'applicationId'<>'auto-replace-app' THEN RAISE EXCEPTION 'replacement admission failed'; END IF;
  SELECT doc INTO item FROM hg_invite_codes WHERE id='AUTONEW';
  IF item->>'usedCount'<>'1' THEN RAISE EXCEPTION 'replacement code not charged'; END IF;

  result:=hg_apply_membership('auto-removed','{"inviteCode":"AUTORESTORE","displayName":"restore","rulesVersion":"v1.0","status":"active","role":"moderator"}');
  IF result->>'state'<>'pending' THEN RAISE EXCEPTION 'removed user auto-admitted'; END IF;
  SELECT doc INTO item FROM hg_memberships WHERE id='auto-removed:heiguang';
  IF item->>'status'<>'removed' OR item->>'version'<>'7' THEN RAISE EXCEPTION 'removed membership altered'; END IF;
  IF hg_apply_membership('auto-removed','{}') IS DISTINCT FROM result THEN RAISE EXCEPTION 'restore replay changed result'; END IF;
  SELECT doc INTO item FROM hg_invite_codes WHERE id='AUTORESTORE';
  IF item->>'usedCount'<>'1' THEN RAISE EXCEPTION 'restore quota not idempotent'; END IF;
  PERFORM hg_moderate('membership.decide','auto-moderator',jsonb_build_object('id',result->>'applicationId','expectedVersion',1,'decision','approve'));
  SELECT doc INTO item FROM hg_memberships WHERE id='auto-removed:heiguang';
  IF item->>'status'<>'active' OR item->>'role'<>'member' THEN RAISE EXCEPTION 'manual restoration failed or privileges restored'; END IF;

  BEGIN
    PERFORM hg_apply_membership('auto-blocked','{"inviteCode":"AUTOBLOCKED","displayName":"blocked","rulesVersion":"v1.0"}');
    RAISE EXCEPTION 'deleted account admitted';
  EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'FORBIDDEN' THEN RAISE; END IF; END;

  FOR bad_invite IN SELECT value FROM jsonb_array_elements('[
    {"clubId":"other"}, {"revokedAt":"2026-01-01"}, {"expiresAt":"not-a-date"},
    {"expiresAt":"2020-01-01"}, {"maxUses":-1}, {"usedCount":-1}, {"maxUses":"oops"}
  ]'::jsonb) LOOP
    i:=i+1;
    INSERT INTO hg_invite_codes(id,doc) VALUES('AUTOFAIL'||i,jsonb_build_object('_id','AUTOFAIL'||i,'clubId','heiguang','maxUses',1,'usedCount',0)||bad_invite);
    BEGIN
      PERFORM hg_apply_membership('auto-invalid',jsonb_build_object('inviteCode','AUTOFAIL'||i,'displayName','invalid','rulesVersion','v1.0'));
      RAISE EXCEPTION 'invalid invite admitted';
    EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'INVITE_INVALID' THEN RAISE; END IF; END;
  END LOOP;
  IF EXISTS(SELECT 1 FROM hg_memberships WHERE doc->>'userId' IN ('auto-invalid','auto-blocked')) THEN RAISE EXCEPTION 'failed calls created membership'; END IF;

  -- Force a unique-key conflict after application insertion. The whole RPC
  -- must roll back, including profile, application and invitation usage.
  INSERT INTO hg_memberships(id,doc) VALUES('auto-rollback:heiguang','{"_id":"auto-rollback:heiguang","userId":"different-user","clubId":"heiguang","status":"active","role":"member"}');
  BEGIN
    PERFORM hg_apply_membership('auto-rollback','{"inviteCode":"AUTOBLOCKED","displayName":"changed","rulesVersion":"v1.0"}');
    RAISE EXCEPTION 'conflicting identity admitted';
  EXCEPTION WHEN unique_violation THEN NULL; END;
  IF EXISTS(SELECT 1 FROM hg_membership_applications WHERE doc->>'userId'='auto-rollback') THEN RAISE EXCEPTION 'partial application committed'; END IF;
  SELECT doc INTO item FROM hg_invite_codes WHERE id='AUTOBLOCKED';
  IF item->>'usedCount'<>'0' THEN RAISE EXCEPTION 'failed RPC consumed quota'; END IF;
  SELECT doc INTO item FROM hg_users WHERE id='auto-rollback';
  IF item->>'displayName'<>'old' THEN RAISE EXCEPTION 'failed RPC updated profile'; END IF;
END $$;
ROLLBACK;
SELECT 'PASS: legacy pending, removed restoration, role boundaries, malformed invites, atomic rollback' AS result;
