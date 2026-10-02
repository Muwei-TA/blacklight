-- Account-wide platform administration is independent of club membership.
ALTER TABLE public.hg_users ADD CONSTRAINT hg_users_platform_role_check
  CHECK (NOT (doc ? 'platformRole') OR COALESCE(jsonb_typeof(doc->'platformRole')='string' AND doc->>'platformRole' IN ('none','developer'),false));

CREATE FUNCTION public.hg_require_developer(p_actor_id text) RETURNS void
LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
BEGIN
  PERFORM 1 FROM hg_users WHERE id=p_actor_id AND doc->>'status'='active'
    AND doc->>'platformRole'='developer' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
END $$;
REVOKE ALL ON FUNCTION public.hg_require_developer(text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.hg_require_developer(text) TO service_role;

CREATE FUNCTION public.hg_platform_clubs(p_actor_id text,p_action text,p_payload jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE
  club_id text:=p_payload->>'id'; before_doc jsonb; after_doc jsonb; changes jsonb;
  member_before jsonb;
  target_id text:=p_payload->>'moderatorUserId'; member jsonb; member_id text;
  reason text:=btrim(COALESCE(p_payload->>'reason','')); stamp text:=to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  audit_id text; result jsonb; current_version int;
BEGIN
  PERFORM hg_require_developer(p_actor_id);
  IF p_action='list' THEN
    SELECT COALESCE(jsonb_agg(jsonb_build_object('id',id,'name',doc->>'name','description',COALESCE(doc->>'description',doc->>'intro',''),
      'status',COALESCE(doc->>'status','active'),'discoverable',COALESCE((doc->>'discoverable')::boolean,false),
      'publishing',COALESCE((doc->'capabilities'->>'publishing')::boolean,false),'uploads',COALESCE((doc->'capabilities'->>'uploads')::boolean,false),
      'version',COALESCE((doc->>'platformVersion')::int,0)) ORDER BY id),'[]'::jsonb) INTO result FROM hg_club_config;
    RETURN jsonb_build_object('list',result);
  END IF;
  IF p_action IS NULL OR p_action NOT IN ('create','update','set-status','set-moderator') THEN RAISE EXCEPTION 'INVALID_INPUT'; END IF;
  IF club_id IS NULL OR club_id !~ '^[a-z0-9][a-z0-9_-]{2,63}$' OR length(reason)<10 OR length(reason)>500 THEN RAISE EXCEPTION 'INVALID_INPUT'; END IF;
  -- Lock accounts before clubs and memberships, matching membership/governance RPCs.
  IF p_action IN ('create','set-moderator') THEN
    IF target_id IS NULL OR length(target_id)=0 OR length(target_id)>256 THEN RAISE EXCEPTION 'INVALID_INPUT'; END IF;
    PERFORM 1 FROM hg_users WHERE id=target_id AND doc->>'status'='active' FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'TARGET_USER_INVALID'; END IF;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('hg-create-club:'||club_id,0));
  SELECT doc INTO before_doc FROM hg_club_config WHERE id=club_id FOR UPDATE;
  current_version:=COALESCE((before_doc->>'platformVersion')::int,0);
  IF p_action='create' THEN
    IF before_doc IS NOT NULL THEN RAISE EXCEPTION 'CLUB_EXISTS'; END IF;
    after_doc:=jsonb_build_object('_id',club_id,'clubId',club_id,'status','active','discoverable',false,
      'capabilities',jsonb_build_object('publishing',false,'uploads',false,'publicScope',false,'video',false,'anthology',false,'export',false),
      'usageLimits',jsonb_build_object('userUploadDailyBytes',20971520,'clubUploadDailyBytes',209715200,'reviewDailyCalls',1000,'warningRatio',0.8),
      'rulesVersion','v1.0','createdBy',p_actor_id,'createdAt',stamp);
  ELSE
    IF before_doc IS NULL THEN RAISE EXCEPTION 'CLUB_NOT_FOUND'; END IF;
    IF COALESCE(jsonb_typeof(p_payload->'expectedVersion'),'')<>'number' OR COALESCE(p_payload->>'expectedVersion','') !~ '^[0-9]{1,9}$' THEN RAISE EXCEPTION 'INVALID_INPUT'; END IF;
    IF (p_payload->>'expectedVersion')::int<>current_version THEN RAISE EXCEPTION 'VERSION_CONFLICT'; END IF;
    after_doc:=before_doc;
  END IF;
  IF p_action IN ('create','update') THEN
    changes:=p_payload->'config';
    IF changes IS NULL OR jsonb_typeof(changes)<>'object' OR changes='{}'::jsonb
      OR EXISTS(SELECT 1 FROM jsonb_object_keys(changes) k WHERE k NOT IN ('name','description','discoverable','publishing','uploads')) THEN RAISE EXCEPTION 'INVALID_INPUT'; END IF;
    IF (p_action='create' AND NOT(changes ? 'name')) OR (changes ? 'name' AND
      (jsonb_typeof(changes->'name')<>'string' OR length(btrim(changes->>'name')) NOT BETWEEN 1 AND 60)) THEN RAISE EXCEPTION 'INVALID_INPUT'; END IF;
    IF changes ? 'description' AND (jsonb_typeof(changes->'description')<>'string' OR length(changes->>'description')>300) THEN RAISE EXCEPTION 'INVALID_INPUT'; END IF;
    IF changes ? 'discoverable' AND jsonb_typeof(changes->'discoverable')<>'boolean' THEN RAISE EXCEPTION 'INVALID_INPUT'; END IF;
    IF EXISTS(SELECT 1 FROM jsonb_each(changes) e WHERE e.key IN ('publishing','uploads') AND jsonb_typeof(e.value)<>'boolean') THEN RAISE EXCEPTION 'INVALID_INPUT'; END IF;
    after_doc:=after_doc||(changes-'publishing'-'uploads');
    IF changes ? 'publishing' OR changes ? 'uploads' THEN
      after_doc:=after_doc||jsonb_build_object('capabilities',COALESCE(after_doc->'capabilities','{}'::jsonb)||
        (SELECT COALESCE(jsonb_object_agg(key,value),'{}'::jsonb) FROM jsonb_each(changes) WHERE key IN ('publishing','uploads')));
    END IF;
  ELSIF p_action='set-status' THEN
    IF p_payload->>'status' NOT IN ('active','paused') OR p_payload->>'status' IS NULL THEN RAISE EXCEPTION 'INVALID_INPUT'; END IF;
    after_doc:=after_doc||jsonb_build_object('status',p_payload->>'status');
  END IF;
  IF p_action IN ('create','set-moderator') THEN
    -- Explicitly designate a lead; existing moderators retain their membership role.
    SELECT id,doc INTO member_id,member FROM hg_memberships WHERE doc->>'userId'=target_id AND doc->>'clubId'=club_id FOR UPDATE;
    member_before:=member;
    IF member IS NOT NULL AND member->>'status' IS DISTINCT FROM 'active' THEN RAISE EXCEPTION 'TARGET_MEMBERSHIP_INACTIVE'; END IF;
    IF member IS NULL THEN
      member_id:=target_id||':'||club_id;
      member:=jsonb_build_object('_id',member_id,'userId',target_id,'clubId',club_id,'status','active','joinedAt',stamp,'version',0);
    END IF;
    member:=member||jsonb_build_object('role','moderator','version',COALESCE((member->>'version')::int,0)+1,'updatedAt',stamp);
    INSERT INTO hg_memberships(id,doc) VALUES(member_id,member) ON CONFLICT(id) DO UPDATE SET doc=EXCLUDED.doc;
    after_doc:=after_doc||jsonb_build_object('moderatorUserId',target_id);
  END IF;
  after_doc:=after_doc||jsonb_build_object('platformVersion',current_version+1,'updatedAt',stamp);
  INSERT INTO hg_club_config(id,doc) VALUES(club_id,after_doc) ON CONFLICT(id) DO UPDATE SET doc=EXCLUDED.doc;
  audit_id:='audit:platform:'||md5(clock_timestamp()::text||random()::text);
  INSERT INTO hg_audit_logs(id,doc) VALUES(audit_id,jsonb_build_object('_id',audit_id,'scope','platform','clubId',club_id,
    'actorId',p_actor_id,'action','platform.club.'||p_action,'targetType','club','targetId',club_id,'reason',reason,
    'before',jsonb_build_object('name',before_doc->'name','description',before_doc->'description','status',before_doc->'status',
      'discoverable',before_doc->'discoverable','moderatorUserId',before_doc->'moderatorUserId','capabilities',before_doc->'capabilities','version',current_version),
    'after',jsonb_build_object('name',after_doc->'name','description',after_doc->'description','status',after_doc->'status',
      'discoverable',after_doc->'discoverable','moderatorUserId',after_doc->'moderatorUserId','capabilities',after_doc->'capabilities','version',current_version+1),
    'membershipBefore',CASE WHEN p_action IN ('create','set-moderator') THEN jsonb_build_object('targetId',target_id,'role',member_before->'role','status',member_before->'status','version',member_before->'version') ELSE NULL END,'createdAt',stamp));
  RETURN jsonb_build_object('id',club_id,'version',current_version+1);
END $$;
REVOKE ALL ON FUNCTION public.hg_platform_clubs(text,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.hg_platform_clubs(text,text,jsonb) TO service_role;
