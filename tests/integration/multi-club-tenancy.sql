-- Two-community PostgreSQL contract and cross-tenant attack coverage.
BEGIN;
SET LOCAL ROLE service_role;
DO $$
DECLARE
  club_b text := 'club-b';
  club_c text := 'club-c';
  paused_club text := 'club-paused-cleanup';
  member text := 'multi-member';
  admin_a text := 'admin-a';
  admin_b text := 'admin-b';
  member_b text := 'member-b';
  new_user text := 'new-user';
  pending_user text := 'pending-user';
  removed_user text := 'removed-user';
  rejected_user text := 'rejected-user';
  moderator_a text := 'moderator-a';
  second_moderator_a text := 'second-moderator-a';
  owner_a text := 'owner-a';
  owner_b text := 'owner-b';
  post_a text := 'multi-post-a';
  post_b text := 'multi-post-b';
  admin_review_post text := 'admin-review-post';
  admin_review_task text := 'admin-review-task';
  cross_asset text := 'multi-asset-b';
  invite_code text;
  answer jsonb;
  a_level jsonb;
  b_level jsonb;
  clubs jsonb;
  a_posts jsonb;
  b_posts jsonb;
  event_count integer;
  total integer;
  i integer;
  post_id text;
  same_key text := 'multi-member:createPost:shared-client-key';
  same_hash text := repeat('d',64);
  stamp text := to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  cleanup_expected jsonb;
  cleanup_patch jsonb;
  post_doc jsonb;
  legacy_key text := 'legacy-member:createPost:old-client-key';
BEGIN
  INSERT INTO public.hg_club_config(id,doc) VALUES
    (club_b,jsonb_build_object('_id',club_b,'name','Private B','description','B test','status','active','discoverable',false,'rulesVersion','v1.0')),
    (club_c,jsonb_build_object('_id',club_c,'name','Private C','description','Pending C','status','active','discoverable',false,'rulesVersion','v1.0')),
    (paused_club,jsonb_build_object('_id',paused_club,'name','Paused cleanup','status','paused','discoverable',false));
  INSERT INTO public.hg_users(id,doc) VALUES
    (member,jsonb_build_object('_id',member,'status','active')),
    (admin_a,jsonb_build_object('_id',admin_a,'status','active')),
    (admin_b,jsonb_build_object('_id',admin_b,'status','active')),
    (member_b,jsonb_build_object('_id',member_b,'status','active')),
    (new_user,jsonb_build_object('_id',new_user,'status','active')),
    (pending_user,jsonb_build_object('_id',pending_user,'status','active')),
    (removed_user,jsonb_build_object('_id',removed_user,'status','active')),
    (rejected_user,jsonb_build_object('_id',rejected_user,'status','active')),
    (moderator_a,jsonb_build_object('_id',moderator_a,'status','active')),
    (second_moderator_a,jsonb_build_object('_id',second_moderator_a,'status','active')),
    (owner_a,jsonb_build_object('_id',owner_a,'status','active')),
    (owner_b,jsonb_build_object('_id',owner_b,'status','active')),
    ('legacy-member',jsonb_build_object('_id','legacy-member','status','active'));
  INSERT INTO public.hg_memberships(id,doc) VALUES
    (member||':heiguang',jsonb_build_object('_id',member||':heiguang','userId',member,'clubId','heiguang','role','member','status','active')),
    (member||':'||club_b,jsonb_build_object('_id',member||':'||club_b,'userId',member,'clubId',club_b,'role','member','status','active')),
    (admin_a||':heiguang',jsonb_build_object('_id',admin_a||':heiguang','userId',admin_a,'clubId','heiguang','role','admin','status','active')),
    (admin_a||':'||club_b,jsonb_build_object('_id',admin_a||':'||club_b,'userId',admin_a,'clubId',club_b,'role','member','status','active')),
    (moderator_a||':heiguang',jsonb_build_object('_id',moderator_a||':heiguang','userId',moderator_a,'clubId','heiguang','role','moderator','status','active')),
    (second_moderator_a||':heiguang',jsonb_build_object('_id',second_moderator_a||':heiguang','userId',second_moderator_a,'clubId','heiguang','role','moderator','status','active')),
    (removed_user||':heiguang',jsonb_build_object('_id',removed_user||':heiguang','userId',removed_user,'clubId','heiguang','role','member','status','active')),
    (removed_user||':'||club_b,jsonb_build_object('_id',removed_user||':'||club_b,'userId',removed_user,'clubId',club_b,'role','moderator','status','removed')),
    (admin_b||':'||club_b,jsonb_build_object('_id',admin_b||':'||club_b,'userId',admin_b,'clubId',club_b,'role','moderator','status','active')),
    (member_b||':'||club_b,jsonb_build_object('_id',member_b||':'||club_b,'userId',member_b,'clubId',club_b,'role','member','status','active')),
    ('legacy-member:heiguang',jsonb_build_object('_id','legacy-member:heiguang','userId','legacy-member','clubId','heiguang','role','member','status','active'));
  INSERT INTO public.hg_posts(id,doc) VALUES
    (post_a,jsonb_build_object('_id',post_a,'clubId','heiguang','ownerId',owner_a,'status','published','visibility','club','reactionCount',0,'commentCount',0)),
    (post_b,jsonb_build_object('_id',post_b,'clubId',club_b,'ownerId',owner_b,'status','published','visibility','club','reactionCount',0,'commentCount',0));
  INSERT INTO public.hg_topics(id,doc) VALUES
    ('multi-topic-b',jsonb_build_object('_id','multi-topic-b','clubId',club_b,'ownerId',owner_b,'status','active','postCount',0));
  INSERT INTO public.hg_boards(id,doc) VALUES
    ('multi-board-b',jsonb_build_object('_id','multi-board-b','clubId',club_b,'ownerId',owner_b,'status','pending','version',1,'title','B board'));
  INSERT INTO public.hg_assets(id,doc) VALUES
    (cross_asset,jsonb_build_object('_id',cross_asset,'clubId',club_b,'ownerId',member,'status','verified','postId',''));
  INSERT INTO public.hg_membership_applications(id,doc) VALUES
    ('pending-user:club-c',jsonb_build_object('_id','pending-user:club-c','userId',pending_user,'clubId',club_c,'status','pending','version',1)),
    ('rejected-user:club-c',jsonb_build_object('_id','rejected-user:club-c','userId',rejected_user,'clubId',club_c,'status','rejected','version',2));

  -- The generic adapter scopes list/get/update/remove by the SQL club argument.
  a_posts:=public.hg_store('hg_posts','get','{}'::jsonb,'{}'::jsonb,'[]'::jsonb,100,'heiguang');
  b_posts:=public.hg_store('hg_posts','get','{}'::jsonb,'{}'::jsonb,'[]'::jsonb,100,club_b);
  IF jsonb_array_length(a_posts->'data')<>1 OR a_posts#>>'{data,0,_id}'<>post_a THEN RAISE EXCEPTION 'heiguang store scope leaked'; END IF;
  IF jsonb_array_length(b_posts->'data')<>1 OR b_posts#>>'{data,0,_id}'<>post_b THEN RAISE EXCEPTION 'B store scope leaked'; END IF;
  answer:=public.hg_store('hg_posts','get',jsonb_build_object('_id',post_b),'{}'::jsonb,'[]'::jsonb,1,'heiguang');
  IF jsonb_array_length(answer->'data')<>0 THEN RAISE EXCEPTION 'cross-club by-ID read was not scoped'; END IF;
  answer:=public.hg_store('hg_posts','update',jsonb_build_object('_id',post_b),jsonb_build_object('body','tampered'),'[]'::jsonb,1,'heiguang');
  IF answer#>>'{stats,updated}'<>'0' OR (SELECT doc->>'body' FROM hg_posts WHERE id=post_b) IS NOT NULL THEN
    RAISE EXCEPTION 'cross-club update changed B data';
  END IF;
  BEGIN
    PERFORM public.hg_store('hg_posts','update',jsonb_build_object('_id',post_a),jsonb_build_object('clubId',club_b),'[]'::jsonb,1,'heiguang');
    RAISE EXCEPTION 'clubId patch was accepted';
  EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'CLUB_MISMATCH' THEN RAISE; END IF; END;
  answer:=public.hg_store('hg_club_config','get','{}'::jsonb,'{}'::jsonb,'[]'::jsonb,100,NULL);
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(answer->'data') item WHERE item->>'_id'=club_b) THEN
    RAISE EXCEPTION 'non-discoverable private club appeared in directory';
  END IF;
  clubs:=public.hg_user_clubs(member);
  IF (SELECT count(*) FROM jsonb_array_elements(clubs->'items') item WHERE item->>'clubId' IN ('heiguang',club_b))<>2 THEN
    RAISE EXCEPTION 'member did not receive its active club list';
  END IF;
  clubs:=public.hg_user_clubs(pending_user);
  IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(clubs->'items') item WHERE item->>'clubId'=club_c AND item->>'memberStatus'='pending') THEN
    RAISE EXCEPTION 'pending private club application was hidden from its applicant';
  END IF;
  clubs:=public.hg_user_clubs(removed_user);
  IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(clubs->'items') item WHERE item->>'clubId'=club_b
      AND item->>'memberStatus'='removed' AND item->'role'='null'::jsonb
      AND NOT (item ? 'description') AND NOT (item ? 'discoverable')) THEN
    RAISE EXCEPTION 'removed membership history did not expose only a minimal club card';
  END IF;
  clubs:=public.hg_user_clubs(rejected_user);
  IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(clubs->'items') item WHERE item->>'clubId'=club_c
      AND item->>'memberStatus'='rejected' AND item->'role'='null'::jsonb
      AND NOT (item ? 'description') AND NOT (item ? 'discoverable')) THEN
    RAISE EXCEPTION 'rejected application history did not expose only a minimal club card';
  END IF;

  -- A trusted cleanup RPC can claim and remove only a 24h unbound orphan even
  -- when its club is paused. It compares the complete ownership/file snapshot.
  INSERT INTO hg_assets(id,doc) VALUES('paused-orphan-asset',jsonb_build_object('_id','paused-orphan-asset',
    'clubId',paused_club,'ownerId',owner_b,'postId','','status','verified','createdAt',clock_timestamp()-interval '25 hours',
    'fileId','paused-orphan-file'));
  cleanup_expected:=jsonb_build_object('status','verified','postId','','cleanupState',jsonb_build_object('$missing',true),
    'cleanupClaimedAt',jsonb_build_object('$missing',true),'cleanupNextAttemptAt',jsonb_build_object('$missing',true),
    'createdAt',(SELECT doc->'createdAt' FROM hg_assets WHERE id='paused-orphan-asset'),'ownerId',owner_b,
    'fileId','paused-orphan-file','cleanedFileId',jsonb_build_object('$missing',true),
    'reservedFileId',jsonb_build_object('$missing',true));
  cleanup_patch:=jsonb_build_object('cleanupState','running','cleanupClaimedAt',stamp,'cleanupLastError','','updatedAt',stamp);
  BEGIN
    PERFORM public.hg_cleanup_asset(paused_club,'paused-orphan-asset','claim',cleanup_expected,
      cleanup_patch||jsonb_build_object('ownerId',member));
    RAISE EXCEPTION 'cleanup patch changed asset ownership';
  EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'CLEANUP_INVALID' THEN RAISE; END IF; END;
  answer:=public.hg_cleanup_asset('heiguang','paused-orphan-asset','claim',cleanup_expected,cleanup_patch);
  IF answer#>>'{stats,updated}'<>'0' THEN RAISE EXCEPTION 'cleanup RPC crossed club ownership'; END IF;
  answer:=public.hg_cleanup_asset(paused_club,'paused-orphan-asset','claim',cleanup_expected,cleanup_patch);
  IF answer#>>'{stats,updated}'<>'1' THEN RAISE EXCEPTION 'paused orphan cleanup claim failed'; END IF;
  cleanup_expected:=cleanup_expected||jsonb_build_object('cleanupState','running','cleanupClaimedAt',stamp);
  answer:=public.hg_cleanup_asset(paused_club,'paused-orphan-asset','claim',cleanup_expected,cleanup_patch);
  IF answer#>>'{stats,updated}'<>'0' THEN RAISE EXCEPTION 'active cleanup lease was claimed twice'; END IF;
  answer:=public.hg_cleanup_asset(paused_club,'paused-orphan-asset','remove_orphan',cleanup_expected,'{}'::jsonb);
  IF answer#>>'{stats,removed}'<>'1' OR EXISTS(SELECT 1 FROM hg_assets WHERE id='paused-orphan-asset') THEN
    RAISE EXCEPTION 'paused orphan cleanup could not remove an expired record';
  END IF;

  INSERT INTO hg_assets(id,doc) VALUES('paused-revoked-asset',jsonb_build_object('_id','paused-revoked-asset',
    'clubId',paused_club,'ownerId',owner_b,'postId','paused-deleted-post','status','revoked',
    'createdAt',clock_timestamp(),'fileId','revoked-file','cleanedFileId','cleaned-file','reservedFileId','reserved-file'));
  cleanup_expected:=jsonb_build_object('status','revoked','postId','paused-deleted-post',
    'cleanupState',jsonb_build_object('$missing',true),'cleanupClaimedAt',jsonb_build_object('$missing',true),
    'cleanupNextAttemptAt',jsonb_build_object('$missing',true),'createdAt',(SELECT doc->'createdAt' FROM hg_assets WHERE id='paused-revoked-asset'),
    'ownerId',owner_b,'fileId','revoked-file','cleanedFileId','cleaned-file','reservedFileId','reserved-file');
  answer:=public.hg_cleanup_asset(paused_club,'paused-revoked-asset','claim',cleanup_expected,cleanup_patch);
  IF answer#>>'{stats,updated}'<>'1' THEN RAISE EXCEPTION 'paused revoked asset cleanup claim failed'; END IF;
  cleanup_expected:=cleanup_expected||jsonb_build_object('cleanupState','running','cleanupClaimedAt',stamp);
  cleanup_patch:=jsonb_build_object('fileId','','cleanedFileId','','reservedFileId','','cloudPath','','tempFileURL','',
    'status','purged','cleanupState','done','cleanupLastError','','cleanupNextAttemptAt',NULL,
    'cleanupClaimedAt',NULL,'purgedAt',stamp,'updatedAt',stamp);
  answer:=public.hg_cleanup_asset(paused_club,'paused-revoked-asset','purge',cleanup_expected,cleanup_patch);
  IF answer#>>'{stats,updated}'<>'1' OR (SELECT doc->>'status' FROM hg_assets WHERE id='paused-revoked-asset')<>'purged' THEN
    RAISE EXCEPTION 'paused revoked asset cleanup could not purge a deleted file';
  END IF;

  -- Club roles do not travel with the account. Admin A is only a member in B.
  BEGIN
    PERFORM public.hg_governance_admin('members.list',admin_a,'{}'::jsonb,club_b);
    RAISE EXCEPTION 'A administrator read B roster';
  EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'FORBIDDEN' THEN RAISE; END IF; END;
  BEGIN
    PERFORM public.hg_governance_admin('members.list',admin_a,'{}'::jsonb,'heiguang');
    RAISE EXCEPTION 'administrator bypassed moderator-only member roster';
  EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'FORBIDDEN' THEN RAISE; END IF; END;
  BEGIN
    PERFORM public.hg_governance('member.role',admin_a,jsonb_build_object('targetUserId',member,'expectedVersion',1,'role','moderator','reason','role gate'),'heiguang');
    RAISE EXCEPTION 'administrator bypassed moderator-only member management';
  EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'FORBIDDEN' THEN RAISE; END IF; END;
  INSERT INTO public.hg_posts(id,doc) VALUES(admin_review_post,jsonb_build_object(
    '_id',admin_review_post,'clubId','heiguang','ownerId',admin_a,'status','pending','visibility','club',
    'version',1,'assetIds','[]'::jsonb,'reactionCount',0,'commentCount',0));
  INSERT INTO public.hg_review_tasks(id,doc) VALUES(admin_review_task,jsonb_build_object(
    '_id',admin_review_task,'clubId','heiguang','targetType','post','targetId',admin_review_post,
    'postVersion',1,'status','manual','createdAt',clock_timestamp()::text));
  answer:=public.hg_moderate('content.decide',admin_a,jsonb_build_object(
    'id',admin_review_post,'decision','approve','expectedVersion',1),'heiguang');
  IF answer->>'status'<>'published' OR (SELECT doc->>'status' FROM hg_posts WHERE id=admin_review_post)<>'published' THEN
    RAISE EXCEPTION 'administrator lost its existing content-moderation permission';
  END IF;
  BEGIN
    PERFORM public.hg_governance('member.role',admin_a,jsonb_build_object('targetUserId',member_b,'expectedVersion',1,'role','admin','reason','cross'),'heiguang');
    RAISE EXCEPTION 'A administrator changed B member role';
  EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'FORBIDDEN' THEN RAISE; END IF; END;
  IF (SELECT doc->>'role' FROM hg_memberships WHERE id=member_b||':'||club_b)<>'member' THEN RAISE EXCEPTION 'B role changed'; END IF;
  BEGIN
    PERFORM public.hg_moderate('content.decide',admin_a,jsonb_build_object('id',post_b,'decision','hide','reason','cross','expectedVersion',1),club_b);
    RAISE EXCEPTION 'A administrator moderated B content';
  EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'FORBIDDEN' THEN RAISE; END IF; END;
  BEGIN
    PERFORM public.hg_decide_board(admin_a,jsonb_build_object('id','multi-board-b','decision','approve','expectedVersion',1), 'heiguang');
    RAISE EXCEPTION 'A administrator decided B board';
  EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'BOARD_NOT_FOUND' THEN RAISE; END IF; END;
  BEGIN
    PERFORM public.hg_create_post(same_key,repeat('a',64),jsonb_build_object('_id','cross-topic-post','clubId','heiguang','ownerId',member,
      'topicId','multi-topic-b','visibility','club','status','pending','assetIds','[]'::jsonb,'createdAt',clock_timestamp()::text),NULL,'heiguang');
    RAISE EXCEPTION 'cross-club topic association was accepted';
  EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'TOPIC_NOT_AVAILABLE' THEN RAISE; END IF; END;
  BEGIN
    PERFORM public.hg_create_post(same_key,repeat('b',64),jsonb_build_object('_id','cross-asset-post','clubId','heiguang','ownerId',member,
      'visibility','club','status','pending','assetIds',jsonb_build_array(cross_asset),'createdAt',clock_timestamp()::text),NULL,'heiguang');
    RAISE EXCEPTION 'cross-club image association was accepted';
  EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'ASSET_BINDING_CONFLICT' THEN RAISE; END IF; END;
  BEGIN
    PERFORM public.hg_create_comment(member||':createComment:cross',repeat('c',64),jsonb_build_object('_id','cross-comment',
      'clubId','heiguang','postId',post_b,'ownerId',member,'body','cross','createdAt',clock_timestamp()::text),NULL,'heiguang');
    RAISE EXCEPTION 'cross-club comment association was accepted';
  EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'COMMENT_TARGET_CHANGED' THEN RAISE; END IF; END;
  BEGIN
    PERFORM public.hg_toggle_reaction(member,post_b,NULL,true,'heiguang');
    RAISE EXCEPTION 'cross-club reaction was accepted';
  EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'REACTION_TARGET_CHANGED' THEN RAISE; END IF; END;
  BEGIN
    PERFORM public.hg_image_intent(member,'heiguang','image-cross-key',jsonb_build_object('_id','cross-image','clubId',club_b,'ownerId',member));
    RAISE EXCEPTION 'cross-club image intent was accepted';
  EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'IMAGE_INVALID' THEN RAISE; END IF; END;
  BEGIN
    PERFORM public.hg_create_invite(admin_a,'{"maxUses":1,"ttlSeconds":3600}'::jsonb,'heiguang');
    RAISE EXCEPTION 'administrator bypassed moderator-only invite creation';
  EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'FORBIDDEN' THEN RAISE; END IF; END;
  invite_code:=(public.hg_create_invite(moderator_a,'{"maxUses":1,"ttlSeconds":3600}'::jsonb,'heiguang'))->>'code';
  answer:=public.hg_apply_membership(new_user,jsonb_build_object('inviteCode',invite_code,'displayName','new','rulesVersion','v1.0'),club_b);
  IF answer->>'state' IS DISTINCT FROM 'rejected' OR answer->>'error' IS DISTINCT FROM 'INVITE_INVALID' THEN
    RAISE EXCEPTION 'foreign invite was not rejected: %',answer;
  END IF;
  IF EXISTS(SELECT 1 FROM hg_memberships WHERE doc->>'userId'=new_user AND doc->>'clubId'=club_b) THEN RAISE EXCEPTION 'failed join left B membership'; END IF;

  answer:=public.hg_governance('member.role',moderator_a,jsonb_build_object(
    'targetUserId',second_moderator_a,'expectedVersion',1,'role','member','reason','test last moderator gate'),'heiguang');
  IF answer->>'role'<>'member' THEN RAISE EXCEPTION 'moderator role change failed'; END IF;
  BEGIN
    PERFORM public.hg_request_account_deletion(moderator_a);
    RAISE EXCEPTION 'account deletion ignored the sole moderator because an admin exists';
  EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'LAST_MODERATOR' THEN RAISE; END IF; END;

  -- Identical client idempotency keys produce independent transactions per club.
  post_doc:=jsonb_build_object('_id','idem-post-a','clubId','heiguang','ownerId',member,'body','A','title','',
    'visibility','club','status','pending','assetIds','[]'::jsonb,'createdAt',clock_timestamp()::text);
  answer:=public.hg_create_post(same_key,same_hash,post_doc,NULL,'heiguang');
  IF answer->>'id'<>'idem-post-a' THEN RAISE EXCEPTION 'heiguang create result mismatch'; END IF;
  answer:=public.hg_create_post(same_key,same_hash,post_doc||jsonb_build_object('_id','idem-post-a-retry'),NULL,'heiguang');
  IF answer->>'id'<>'idem-post-a' OR EXISTS(SELECT 1 FROM hg_posts WHERE id='idem-post-a-retry') THEN RAISE EXCEPTION 'heiguang idempotency failed'; END IF;
  post_doc:=jsonb_build_object('_id','idem-post-b','clubId',club_b,'ownerId',member,'body','B','title','',
    'visibility','club','status','pending','assetIds','[]'::jsonb,'createdAt',clock_timestamp()::text);
  answer:=public.hg_create_post(same_key,same_hash,post_doc,NULL,club_b);
  IF answer->>'id'<>'idem-post-b' THEN RAISE EXCEPTION 'B idempotency collided with heiguang'; END IF;
  answer:=public.hg_create_post(same_key,same_hash,post_doc||jsonb_build_object('_id','idem-post-b-retry'),NULL,club_b);
  IF answer->>'id'<>'idem-post-b' OR EXISTS(SELECT 1 FROM hg_posts WHERE id='idem-post-b-retry') THEN RAISE EXCEPTION 'B idempotency replay failed'; END IF;
  INSERT INTO hg_posts(id,doc) VALUES('legacy-idem-post',jsonb_build_object('_id','legacy-idem-post','clubId','heiguang','ownerId','legacy-member','status','pending','visibility','club'));
  INSERT INTO hg_idempotency(id,doc) VALUES(legacy_key,jsonb_build_object('_id',legacy_key,'fingerprint',repeat('e',64),'state','succeeded',
    'result',jsonb_build_object('id','legacy-idem-post','version',1,'state','pending')));
  answer:=public.hg_create_post(legacy_key,repeat('e',64),jsonb_build_object('_id','legacy-idem-new','clubId','heiguang','ownerId','legacy-member',
    'visibility','club','status','pending','assetIds','[]'::jsonb),NULL,'heiguang');
  IF answer->>'id'<>'legacy-idem-post' OR EXISTS(SELECT 1 FROM hg_posts WHERE id='legacy-idem-new') THEN RAISE EXCEPTION 'old heiguang idempotency replay failed'; END IF;

  -- XP accounts, daily check-in and reward caps are separate for the same user.
  a_level:=public.hg_user_levels_check_in(member,'heiguang');
  b_level:=public.hg_user_levels_check_in(member,club_b);
  IF a_level->>'awardedXp'<>'5' OR b_level->>'awardedXp'<>'5' THEN RAISE EXCEPTION 'club check-in was not independent'; END IF;
  IF public.hg_user_levels_check_in(member,'heiguang')->>'awardedXp'<>'0'
     OR public.hg_user_levels_check_in(member,club_b)->>'awardedXp'<>'0' THEN RAISE EXCEPTION 'club check-in replay failed'; END IF;
  FOR i IN 1..6 LOOP
    post_id:='xp-a-'||i;
    INSERT INTO hg_posts(id,doc) VALUES(post_id,jsonb_build_object('_id',post_id,'clubId','heiguang','ownerId',owner_a,
      'status','published','visibility','club','reactionCount',0));
    PERFORM public.hg_toggle_reaction(member,post_id,NULL,true,'heiguang');
    post_id:='xp-b-'||i;
    INSERT INTO hg_posts(id,doc) VALUES(post_id,jsonb_build_object('_id',post_id,'clubId',club_b,'ownerId',owner_b,
      'status','published','visibility','club','reactionCount',0));
    PERFORM public.hg_toggle_reaction(member,post_id,NULL,true,club_b);
  END LOOP;
  FOR post_id, total IN SELECT club_id,count(*)::int FROM hg_user_xp_events
    WHERE user_id=member AND event_type='reaction' AND xp>0 GROUP BY club_id ORDER BY club_id LOOP
    IF total<>5 THEN RAISE EXCEPTION 'per-club reaction cap failed for %: %',post_id,total; END IF;
  END LOOP;
  IF (SELECT count(*) FROM hg_user_xp_accounts WHERE user_id=member)<>2
     OR (SELECT count(*) FROM hg_user_xp_accounts WHERE user_id=member AND total_xp=10)<>2 THEN RAISE EXCEPTION 'XP account totals crossed clubs'; END IF;
  IF (SELECT count(*) FROM hg_user_xp_events WHERE user_id=member AND event_type='check_in')<>2 THEN RAISE EXCEPTION 'check-in ledger not club scoped'; END IF;
END $$;
ROLLBACK;
SELECT 'PASS: tenant store, actor/role isolation, linked-object checks, idempotency, club directory, XP partitions' AS result;
