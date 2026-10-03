-- Append-only business contract for invitation reservations and club governance.
-- All membership and manager state remains club-scoped and is rechecked in SQL.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE public.hg_management_terms (
  id text PRIMARY KEY,
  doc jsonb NOT NULL CHECK (jsonb_typeof(doc)='object' AND doc->>'_id'=id)
);
ALTER TABLE public.hg_management_terms ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.hg_management_terms FROM PUBLIC,anon,authenticated;
GRANT ALL ON public.hg_management_terms TO service_role;
DROP POLICY IF EXISTS hg_management_terms_service_role_all ON public.hg_management_terms;
CREATE POLICY hg_management_terms_service_role_all ON public.hg_management_terms
  FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE TABLE public.hg_management_requests (
  id text PRIMARY KEY,
  doc jsonb NOT NULL CHECK (jsonb_typeof(doc)='object' AND doc->>'_id'=id)
);
ALTER TABLE public.hg_management_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.hg_management_requests FROM PUBLIC,anon,authenticated;
GRANT ALL ON public.hg_management_requests TO service_role;
DROP POLICY IF EXISTS hg_management_requests_service_role_all ON public.hg_management_requests;
CREATE POLICY hg_management_requests_service_role_all ON public.hg_management_requests
  FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE UNIQUE INDEX hg_management_requests_one_pending_per_club_idx
  ON public.hg_management_requests ((doc->>'clubId'))
  WHERE doc->>'status' IN ('proposed','recovery_requested');
CREATE INDEX hg_management_requests_actor_idx
  ON public.hg_management_requests ((doc->>'creatorId'),(doc->>'targetUserId'),(doc->>'createdAt'));

CREATE TABLE public.hg_invitation_rate_limits (
  user_id text NOT NULL,
  club_id text NOT NULL,
  window_started_at timestamptz NOT NULL,
  attempts integer NOT NULL CHECK (attempts>=0),
  PRIMARY KEY (user_id,club_id)
);
ALTER TABLE public.hg_invitation_rate_limits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.hg_invitation_rate_limits FROM PUBLIC,anon,authenticated;
GRANT ALL ON public.hg_invitation_rate_limits TO service_role;
DROP POLICY IF EXISTS hg_invitation_rate_limits_service_role_all ON public.hg_invitation_rate_limits;
CREATE POLICY hg_invitation_rate_limits_service_role_all ON public.hg_invitation_rate_limits
  FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE UNIQUE INDEX hg_invite_codes_code_hash_unique_idx
  ON public.hg_invite_codes ((doc->>'codeHash'))
  WHERE doc ? 'codeHash';
CREATE INDEX hg_invite_codes_club_mode_idx
  ON public.hg_invite_codes ((doc->>'clubId'),(doc->>'mode'),id);
CREATE UNIQUE INDEX hg_membership_applications_idempotency_idx
  ON public.hg_membership_applications ((doc->>'userId'),(doc->>'clubId'),(doc->>'idempotencyKey'))
  WHERE COALESCE(doc->>'idempotencyKey','')<>'';
CREATE INDEX hg_membership_applications_invite_reservation_idx
  ON public.hg_membership_applications ((doc->>'inviteId'),(doc->>'reservationExpiresAt'))
  WHERE doc->>'reservationStatus'='reserved';
REVOKE ALL ON public.hg_invite_codes FROM PUBLIC,anon,authenticated;
GRANT ALL ON public.hg_invite_codes TO service_role;
DROP POLICY IF EXISTS hg_invite_codes_service_role_all ON public.hg_invite_codes;
CREATE POLICY hg_invite_codes_service_role_all ON public.hg_invite_codes
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Replace plaintext legacy invite row IDs in place.  The old ids are normalized
-- exactly like membership/apply normalized them (trimmed uppercase values).
-- Existing direct-use behavior was public application behavior, so every legacy
-- code now enters the application queue.  Unresolved plaintext is never retained.
CREATE FUNCTION public.hg_backfill_legacy_invites() RETURNS void
LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE legacy record; mapped_id text; mapped_hash text; pending_count integer; active_count integer;
  stamp text:=to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
BEGIN
  FOR legacy IN SELECT id,doc FROM public.hg_invite_codes WHERE NOT (doc ? 'codeHash') LOOP
    mapped_id:='invite:'||gen_random_uuid()::text;
    mapped_hash:=encode(digest(convert_to(upper(btrim(legacy.id)),'UTF8'),'sha256'),'hex');
    SELECT count(*) FILTER (WHERE doc->>'status'='pending'),
           count(*) FILTER (WHERE doc->>'status'='active')
      INTO pending_count,active_count
      FROM public.hg_membership_applications
      WHERE doc->>'clubId'=COALESCE(legacy.doc->>'clubId','heiguang')
        AND upper(btrim(COALESCE(doc->>'inviteCode',''))) = upper(btrim(legacy.id));
    UPDATE public.hg_membership_applications
      SET doc=(doc-'inviteCode')||jsonb_build_object(
        'inviteId',mapped_id,
        'inviteVersion',COALESCE(NULLIF(legacy.doc->>'version','')::int,1),
        'reservationStatus',CASE WHEN doc->>'status'='pending' THEN 'reserved'
          WHEN doc->>'status'='active' THEN 'consumed' ELSE 'released' END
      )||CASE WHEN doc->>'status'='pending' THEN jsonb_build_object(
        'reservationExpiresAt',to_char((clock_timestamp()+interval '72 hours') AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
        ELSE '{}'::jsonb END
      WHERE doc->>'clubId'=COALESCE(legacy.doc->>'clubId','heiguang')
        AND upper(btrim(COALESCE(doc->>'inviteCode',''))) = upper(btrim(legacy.id));
    UPDATE public.hg_invite_codes
      SET id=mapped_id,
          doc=(doc-'inviteCode'-'code')||jsonb_build_object('_id',mapped_id,
            'clubId',COALESCE(legacy.doc->>'clubId','heiguang'),'codeHash',mapped_hash,
            'mode','application','targetUserId',NULL,
            'usedCount',GREATEST(active_count,COALESCE(NULLIF(legacy.doc->>'usedCount','')::int,0)-pending_count,0),
            'reservedCount',pending_count,'version',GREATEST(COALESCE(NULLIF(legacy.doc->>'version','')::int,1),1),
            'rulesVersion',COALESCE(NULLIF(legacy.doc->>'rulesVersion',''),
              (SELECT COALESCE(NULLIF(c.doc->>'rulesVersion',''),'v1.0') FROM public.hg_club_config c
                WHERE c.id=COALESCE(legacy.doc->>'clubId','heiguang')),'v1.0'),
            'issuedManagementTermId',COALESCE(NULLIF(legacy.doc->>'issuedManagementTermId',''),
              (SELECT COALESCE(NULLIF(c.doc->>'managementTermId',''),'term:initial:'||c.id) FROM public.hg_club_config c
                WHERE c.id=COALESCE(legacy.doc->>'clubId','heiguang'))),
            'status','active','migratedAt',stamp,'updatedAt',stamp)
      WHERE id=legacy.id;
  END LOOP;
  -- Remove orphaned historical codes even when their invitation row was already
  -- deleted.  They cannot be used for an approval after this migration.
  UPDATE public.hg_membership_applications SET doc=doc-'inviteCode'
    WHERE doc ? 'inviteCode';
END $$;
REVOKE ALL ON FUNCTION public.hg_backfill_legacy_invites() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.hg_backfill_legacy_invites() TO service_role;
SELECT public.hg_backfill_legacy_invites();

-- Preserve the existing management and account-deletion routines while adding
-- the shared term lock and protecting the explicitly selected primary.
DO $patch_governance$
DECLARE definition text; needle text; replacement text;
BEGIN
  definition:=pg_get_functiondef('public.hg_governance(text,text,jsonb,text)'::regprocedure);
  needle:=$needle$    updated:=target||jsonb_build_object('version',actual_version+1,'updatedAt',now_text);$needle$;
  replacement:=$replacement$
    IF p_action IN ('member.remove','member.role')
      AND (p_action='member.remove' OR new_role<>'moderator')
      AND EXISTS(SELECT 1 FROM public.hg_club_config c JOIN public.hg_management_terms t
        ON t.id=c.doc->>'managementTermId' WHERE c.id=p_club_id AND t.doc->>'primaryUserId'=target_user_id) THEN
      RAISE EXCEPTION 'PRIMARY_HANDOVER_REQUIRED';
    END IF;
    $replacement$||needle;
  IF position(needle IN definition)=0 THEN RAISE EXCEPTION 'GOVERNANCE_PATCH_POINT_MISSING'; END IF;
  EXECUTE replace(definition,needle,replacement);

  definition:=pg_get_functiondef('public.hg_platform_clubs(text,text,jsonb)'::regprocedure);
  needle:=$needle$  PERFORM hg_require_developer(p_actor_id);$needle$;
  replacement:=$replacement$  PERFORM hg_require_developer(p_actor_id);
  IF p_action IN ('create','set-moderator') AND NULLIF(p_payload->>'id','') IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('hg-governance:'||p_payload->>'id'||':members',0));
  END IF;$replacement$;
  IF position(needle IN definition)=0 THEN RAISE EXCEPTION 'PLATFORM_PATCH_POINT_MISSING'; END IF;
  EXECUTE replace(definition,needle,replacement);

  definition:=pg_get_functiondef('public.hg_platform_clubs(text,text,jsonb)'::regprocedure);
  needle:=$needle$'version',COALESCE((doc->>'platformVersion')::int,0)) ORDER BY id)$needle$;
  replacement:=$replacement$'version',COALESCE((doc->>'platformVersion')::int,0),
      'primaryUserId',(SELECT t.doc->>'primaryUserId' FROM public.hg_management_terms t
        WHERE t.id=hg_club_config.doc->>'managementTermId'),
      'managementTermVersion',(SELECT COALESCE(NULLIF(t.doc->>'version','')::int,1)
        FROM public.hg_management_terms t WHERE t.id=hg_club_config.doc->>'managementTermId')) ORDER BY id)$replacement$;
  IF position(needle IN definition)=0 THEN RAISE EXCEPTION 'PLATFORM_LIST_PATCH_POINT_MISSING'; END IF;
  EXECUTE replace(definition,needle,replacement);

  definition:=pg_get_functiondef('public.hg_request_account_deletion(text)'::regprocedure);
  needle:=$needle$  UPDATE hg_memberships SET doc=doc||jsonb_build_object('status','removed','removedAt',stamp,$needle$;
  replacement:=$replacement$
  WITH cleared AS (
    UPDATE hg_management_terms SET doc=doc||jsonb_build_object('primaryUserId',NULL,
      'members',(SELECT COALESCE(jsonb_agg(person),'[]'::jsonb) FROM jsonb_array_elements(COALESCE(doc->'members','[]'::jsonb)) person
        WHERE person->>'targetUserId'<>p_user),
      'primaryClearedAt',stamp,'version',COALESCE(NULLIF(doc->>'version','')::int,1)+1)
      WHERE doc->>'primaryUserId'=p_user
      RETURNING doc->>'clubId' AS club_id,id AS term_id
  ), audit_rows AS (
    SELECT 'audit:'||gen_random_uuid()::text AS audit_id,club_id,term_id FROM cleared
  )
  INSERT INTO hg_audit_logs(id,doc)
    SELECT audit_id,jsonb_build_object('_id',audit_id,'scope','club_management','clubId',club_id,
      'actorId',p_user,'action','management.primary.cleared.account_deletion','targetType','membership',
      'targetId',p_user,'extra',jsonb_build_object('termId',term_id),
      'createdAt',to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    FROM audit_rows;
  UPDATE hg_club_config SET doc=doc-'moderatorUserId' WHERE doc->>'moderatorUserId'=p_user;
  $replacement$||needle;
  IF position(needle IN definition)=0 THEN RAISE EXCEPTION 'ACCOUNT_DELETION_PATCH_POINT_MISSING'; END IF;
  EXECUTE replace(definition,needle,replacement);
END $patch_governance$;

CREATE FUNCTION public.hg_admin_invite_status(p_doc jsonb) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE maximum integer; used integer; reserved integer;
BEGIN
  IF NULLIF(p_doc->>'revokedAt','') IS NOT NULL THEN RETURN 'revoked'; END IF;
  IF NULLIF(p_doc->>'expiresAt','') IS NOT NULL AND (p_doc->>'expiresAt')::timestamptz<=clock_timestamp() THEN RETURN 'expired'; END IF;
  maximum:=NULLIF(p_doc->>'maxUses','')::integer;
  used:=COALESCE(NULLIF(p_doc->>'usedCount','')::integer,0);
  reserved:=COALESCE(NULLIF(p_doc->>'reservedCount','')::integer,0);
  IF maximum IS NOT NULL AND maximum>0 AND used+reserved>=maximum THEN RETURN 'exhausted'; END IF;
  RETURN 'active';
END $$;
REVOKE ALL ON FUNCTION public.hg_admin_invite_status(jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.hg_admin_invite_status(jsonb) TO service_role;

CREATE FUNCTION public.hg_sync_membership_management_term() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE term_id text; club_id text:=NEW.doc->>'clubId';
BEGIN
  IF COALESCE(NEW.doc->>'status','')='active' AND NEW.doc->>'role' IN ('admin','moderator') THEN
    SELECT doc->>'managementTermId' INTO term_id FROM public.hg_club_config WHERE id=club_id;
    IF NULLIF(term_id,'') IS NOT NULL THEN
      NEW.doc:=NEW.doc||jsonb_build_object('managementTermId',term_id);
    END IF;
  ELSE
    NEW.doc:=NEW.doc-'managementTermId';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.hg_sync_membership_management_term() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.hg_sync_membership_management_term() TO service_role;
CREATE TRIGGER hg_membership_management_term_sync
  BEFORE INSERT OR UPDATE OF doc ON public.hg_memberships
  FOR EACH ROW EXECUTE FUNCTION public.hg_sync_membership_management_term();

CREATE FUNCTION public.hg_sync_club_management_term() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE term_id text; primary_id text; term_doc jsonb; managers jsonb; membership jsonb; stamp text;
BEGIN
  term_id:=NULLIF(NEW.doc->>'managementTermId','');
  primary_id:=NULLIF(NEW.doc->>'moderatorUserId','');
  IF term_id IS NULL THEN
    term_id:='term:'||gen_random_uuid()::text;
    IF primary_id IS NOT NULL AND NOT EXISTS(
      SELECT 1 FROM public.hg_memberships m WHERE m.doc->>'clubId'=NEW.id
        AND m.doc->>'userId'=primary_id AND m.doc->>'status'='active' AND m.doc->>'role'='moderator') THEN
      RAISE EXCEPTION 'TARGET_MEMBERSHIP_INACTIVE';
    END IF;
    SELECT COALESCE(jsonb_agg(jsonb_build_object('targetUserId',m.doc->>'userId','role',m.doc->>'role',
      'version',COALESCE(NULLIF(m.doc->>'version','')::int,1)) ORDER BY m.doc->>'userId'),'[]'::jsonb)
      INTO managers FROM public.hg_memberships m WHERE m.doc->>'clubId'=NEW.id
        AND m.doc->>'status'='active' AND m.doc->>'role' IN ('admin','moderator');
    stamp:=COALESCE(NULLIF(NEW.doc->>'createdAt',''),to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
    term_doc:=jsonb_build_object('_id',term_id,'clubId',NEW.id,'version',1,'primaryUserId',primary_id,
      'members',managers,'status','active','startAt',stamp,'endAt',NEW.doc->'termEndAt','createdAt',stamp);
    INSERT INTO public.hg_management_terms(id,doc) VALUES(term_id,term_doc);
    UPDATE public.hg_club_config SET doc=NEW.doc||jsonb_build_object('managementTermId',term_id,
      'managementVersion',COALESCE(NULLIF(NEW.doc->>'managementVersion','')::int,1),
      'settingsVersion',COALESCE(NULLIF(NEW.doc->>'settingsVersion','')::int,1),
      'admissionMode',COALESCE(NULLIF(NEW.doc->>'admissionMode',''),'invite_required'),
      'rulesVersion',COALESCE(NULLIF(NEW.doc->>'rulesVersion',''),'v1.0')) WHERE id=NEW.id;
    UPDATE public.hg_memberships SET doc=doc||jsonb_build_object('managementTermId',term_id)
      WHERE doc->>'clubId'=NEW.id AND doc->>'status'='active' AND doc->>'role' IN ('admin','moderator');
    RETURN NEW;
  END IF;
  SELECT doc INTO term_doc FROM public.hg_management_terms WHERE id=term_id FOR UPDATE;
  IF term_doc IS NULL OR term_doc->>'clubId' IS DISTINCT FROM NEW.id THEN RAISE EXCEPTION 'MANAGEMENT_TERM_NOT_FOUND'; END IF;
  IF NULLIF(term_doc->>'primaryUserId','') IS DISTINCT FROM primary_id THEN
    IF NULLIF(term_doc->>'primaryUserId','') IS NULL AND primary_id IS NOT NULL THEN
      SELECT doc INTO membership FROM public.hg_memberships WHERE doc->>'clubId'=NEW.id
        AND doc->>'userId'=primary_id AND doc->>'status'='active' AND doc->>'role'='moderator' FOR UPDATE;
      IF membership IS NULL THEN RAISE EXCEPTION 'TARGET_MEMBERSHIP_INACTIVE'; END IF;
      SELECT COALESCE(jsonb_agg(jsonb_build_object('targetUserId',m.doc->>'userId','role',m.doc->>'role',
        'version',COALESCE(NULLIF(m.doc->>'version','')::int,1)) ORDER BY m.doc->>'userId'),'[]'::jsonb)
        INTO managers FROM public.hg_memberships m WHERE m.doc->>'clubId'=NEW.id
          AND m.doc->>'status'='active' AND m.doc->>'role' IN ('admin','moderator');
      UPDATE public.hg_management_terms SET doc=term_doc||jsonb_build_object('primaryUserId',primary_id,
        'members',managers,'version',COALESCE(NULLIF(term_doc->>'version','')::int,1)+1,
        'primarySetAt',to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) WHERE id=term_id;
    ELSE
      RAISE EXCEPTION 'PRIMARY_HANDOVER_REQUIRED';
    END IF;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.hg_sync_club_management_term() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.hg_sync_club_management_term() TO service_role;
CREATE TRIGGER hg_club_config_management_term_sync
  AFTER INSERT OR UPDATE OF doc ON public.hg_club_config
  FOR EACH ROW EXECUTE FUNCTION public.hg_sync_club_management_term();

-- The legacy queue's membership branch delegates to the new reserved decision
-- contract.  A trigger also rejects terminal pending-app updates through an
-- internal legacy alias, so the former implementation cannot bypass reserves.
CREATE FUNCTION public.hg_guard_membership_application_decision() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
BEGIN
  IF OLD.doc->>'status'='pending' AND NEW.doc->>'status' IN ('active','rejected')
    AND current_setting('heiguang.membership_decision',true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'MEMBERSHIP_DECISION_REQUIRED';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.hg_guard_membership_application_decision() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.hg_guard_membership_application_decision() TO service_role;
CREATE TRIGGER hg_membership_application_decision_guard
  BEFORE UPDATE OF doc ON public.hg_membership_applications
  FOR EACH ROW EXECUTE FUNCTION public.hg_guard_membership_application_decision();

CREATE FUNCTION public.hg_apply_invitation(p_actor_id text,p_input jsonb,p_club_id text) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE actor_doc jsonb; member jsonb; invite jsonb; club jsonb; pending jsonb; replay jsonb; application jsonb;
  invite_id text; application_id text; code_hash text; mode text; admission_state text; admission_method text;
  display_name text; rules_version text; idempotency_key text; current_rules text; target_user text;
  maximum integer; used integer; reserved integer; attempt_count integer; actual_version integer;
  expired_application record;
  now_at timestamptz:=clock_timestamp(); now_text text:=to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  window_start timestamptz:=to_timestamp(floor(extract(epoch FROM clock_timestamp())/600)*600);
BEGIN
  IF NULLIF(p_actor_id,'') IS NULL OR NULLIF(p_club_id,'') IS NULL THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('hg-governance:'||p_club_id||':members',0));
  SELECT doc INTO actor_doc FROM public.hg_users WHERE id=p_actor_id FOR UPDATE;
  IF actor_doc IS NULL OR actor_doc->>'status' IS DISTINCT FROM 'active' THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
  INSERT INTO public.hg_invitation_rate_limits(user_id,club_id,window_started_at,attempts)
    VALUES(p_actor_id,p_club_id,window_start,1)
    ON CONFLICT(user_id,club_id) DO UPDATE SET
      window_started_at=CASE WHEN public.hg_invitation_rate_limits.window_started_at<window_start THEN window_start
        ELSE public.hg_invitation_rate_limits.window_started_at END,
      attempts=CASE WHEN public.hg_invitation_rate_limits.window_started_at<window_start THEN 1
        ELSE public.hg_invitation_rate_limits.attempts+1 END
    RETURNING public.hg_invitation_rate_limits.attempts INTO attempt_count;
  IF attempt_count>5 THEN RETURN jsonb_build_object('state','rejected','applicationId',NULL,'error','INVITE_RATE_LIMITED'); END IF;
  IF jsonb_typeof(p_input)<>'object' OR p_input IS NULL THEN RAISE EXCEPTION 'INVALID'; END IF;
  code_hash:=lower(COALESCE(p_input->>'codeHash',''));
  display_name:=btrim(COALESCE(p_input->>'displayName',''));
  rules_version:=btrim(COALESCE(p_input->>'rulesVersion',''));
  idempotency_key:=btrim(COALESCE(p_input->>'idempotencyKey',''));
  IF code_hash !~ '^[0-9a-f]{64}$' OR display_name='' OR char_length(display_name)>20
     OR rules_version='' OR char_length(rules_version)>20 OR idempotency_key='' OR char_length(idempotency_key)>128 THEN
    RETURN jsonb_build_object('state','rejected','applicationId',NULL,'error','INVITE_INVALID');
  END IF;
  SELECT doc INTO club FROM public.hg_club_config WHERE id=p_club_id FOR SHARE;
  IF club IS NULL THEN RAISE EXCEPTION 'CLUB_NOT_FOUND'; END IF;
  IF COALESCE(club->>'status','active')<>'active' OR COALESCE(club->>'admissionMode','invite_required')='closed' THEN
    RETURN jsonb_build_object('state','rejected','applicationId',NULL,'error','INVITE_INVALID');
  END IF;
  current_rules:=COALESCE(NULLIF(club->>'rulesVersion',''),'v1.0');
  IF rules_version IS DISTINCT FROM current_rules THEN RAISE EXCEPTION 'RULES_VERSION_INVALID'; END IF;
  SELECT id,doc INTO invite_id,invite FROM public.hg_invite_codes
    WHERE doc->>'codeHash'=code_hash FOR UPDATE;
  IF invite IS NULL OR invite->>'clubId' IS DISTINCT FROM p_club_id THEN
    RETURN jsonb_build_object('state','rejected','applicationId',NULL,'error','INVITE_INVALID');
  END IF;
  FOR expired_application IN SELECT a.id,a.doc FROM public.hg_membership_applications a
    WHERE a.doc->>'clubId'=p_club_id AND a.doc->>'status'='pending' AND a.doc->>'reservationStatus'='reserved'
      AND NULLIF(a.doc->>'reservationExpiresAt','')::timestamptz<=now_at
      AND (a.doc->>'inviteId'=invite_id OR a.doc->>'userId'=p_actor_id)
    ORDER BY a.id FOR UPDATE OF a LOOP
    UPDATE public.hg_membership_applications SET doc=expired_application.doc||jsonb_build_object(
      'status','expired','reservationStatus','released','expiredAt',now_text,
      'version',COALESCE(NULLIF(expired_application.doc->>'version','')::int,1)+1,'updatedAt',now_text)
      WHERE id=expired_application.id;
    UPDATE public.hg_invite_codes i SET doc=i.doc||jsonb_build_object(
      'reservedCount',greatest(0,COALESCE(NULLIF(i.doc->>'reservedCount','')::int,0)-1),'updatedAt',now_text)
      WHERE i.id=expired_application.doc->>'inviteId' AND i.doc->>'clubId'=p_club_id;
  END LOOP;
  SELECT doc INTO invite FROM public.hg_invite_codes WHERE id=invite_id AND doc->>'clubId'=p_club_id FOR UPDATE;
  SELECT doc INTO replay FROM public.hg_membership_applications WHERE doc->>'userId'=p_actor_id
    AND doc->>'clubId'=p_club_id AND doc->>'idempotencyKey'=idempotency_key FOR UPDATE;
  IF replay IS NOT NULL THEN
    IF replay->>'inviteId' IS DISTINCT FROM invite_id THEN RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT'; END IF;
    RETURN jsonb_build_object('state',replay->>'status','applicationId',replay->>'_id');
  END IF;
  IF public.hg_admin_invite_status(invite)<>'active'
     OR invite->>'rulesVersion' IS DISTINCT FROM current_rules THEN
    RETURN jsonb_build_object('state','rejected','applicationId',NULL,'error','INVITE_INVALID');
  END IF;
  mode:=COALESCE(invite->>'mode','application');
  target_user:=NULLIF(invite->>'targetUserId','');
  IF mode='direct' AND target_user IS DISTINCT FROM p_actor_id THEN
    RETURN jsonb_build_object('state','rejected','applicationId',NULL,'error','INVITE_INVALID');
  END IF;
  IF mode NOT IN ('application','direct') THEN RETURN jsonb_build_object('state','rejected','applicationId',NULL,'error','INVITE_INVALID'); END IF;
  SELECT doc INTO member FROM public.hg_memberships WHERE doc->>'userId'=p_actor_id AND doc->>'clubId'=p_club_id FOR UPDATE;
  IF member IS NOT NULL AND member->>'status'='active' THEN
    SELECT id,doc INTO application_id,replay FROM public.hg_membership_applications
      WHERE id=member->>'applicationId' AND doc->>'userId'=p_actor_id AND doc->>'clubId'=p_club_id;
    RETURN jsonb_build_object('state','active','applicationId',replay->>'_id');
  END IF;
  IF member IS NOT NULL AND member->>'status' IS DISTINCT FROM 'removed' THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
  IF mode='direct' THEN
    PERFORM 1 FROM public.hg_users WHERE id=p_actor_id AND doc->>'status'='active' FOR SHARE;
    IF NOT FOUND THEN RETURN jsonb_build_object('state','rejected','applicationId',NULL,'error','INVITE_INVALID'); END IF;
  END IF;
  SELECT id,doc INTO application_id,pending FROM public.hg_membership_applications
    WHERE doc->>'userId'=p_actor_id AND doc->>'clubId'=p_club_id AND doc->>'status'='pending'
    ORDER BY doc->>'createdAt' DESC,id DESC LIMIT 1 FOR UPDATE;
  IF pending IS NOT NULL THEN RETURN jsonb_build_object('state','pending','applicationId',pending->>'_id'); END IF;
  maximum:=NULLIF(invite->>'maxUses','')::int;
  used:=COALESCE(NULLIF(invite->>'usedCount','')::int,0);
  reserved:=COALESCE(NULLIF(invite->>'reservedCount','')::int,0);
  IF maximum IS NOT NULL AND maximum>0 AND used+reserved>=maximum THEN
    RETURN jsonb_build_object('state','rejected','applicationId',NULL,'error','INVITE_INVALID');
  END IF;
  admission_state:=CASE WHEN mode='application' OR member->>'status'='removed' THEN 'pending' ELSE 'active' END;
  admission_method:=CASE WHEN member->>'status'='removed' THEN 'manual_restore'
    WHEN admission_state='pending' THEN 'manual_join' ELSE 'invite' END;
  application_id:='application:'||gen_random_uuid()::text;
  application:=jsonb_build_object('_id',application_id,'userId',p_actor_id,'clubId',p_club_id,
    'displayName',display_name,'inviteId',invite_id,'inviteVersion',COALESCE(NULLIF(invite->>'version','')::int,1),
    'rulesVersion',rules_version,'status',admission_state,'admissionMethod',admission_method,
    'reservationStatus',CASE WHEN admission_state='pending' THEN 'reserved' ELSE 'consumed' END,
    'idempotencyKey',idempotency_key,'version',1,'createdAt',now_text,'updatedAt',now_text);
  IF admission_state='pending' THEN
    application:=application||jsonb_build_object('reservationExpiresAt',to_char((now_at+interval '72 hours') AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
    INSERT INTO public.hg_membership_applications(id,doc) VALUES(application_id,application);
    invite:=invite||jsonb_build_object('reservedCount',reserved+1,'updatedAt',now_text);
    UPDATE public.hg_invite_codes SET doc=invite WHERE id=invite_id;
  ELSE
    INSERT INTO public.hg_membership_applications(id,doc) VALUES(application_id,application||jsonb_build_object('decidedAt',now_text));
    IF member IS NULL THEN
      application_id:=p_actor_id||':'||p_club_id;
      INSERT INTO public.hg_memberships(id,doc) VALUES(application_id,jsonb_build_object('_id',application_id,
        'userId',p_actor_id,'clubId',p_club_id,'status','active','role','member','applicationId',application->>'_id',
        'rulesVersion',rules_version,'version',1,'joinedAt',now_text,'updatedAt',now_text));
    ELSE
      UPDATE public.hg_memberships SET doc=(doc-'managementTermId')||jsonb_build_object('status','active','role','member',
        'applicationId',application->>'_id','rulesVersion',rules_version,'version',COALESCE(NULLIF(doc->>'version','')::int,1)+1,
        'joinedAt',now_text,'updatedAt',now_text) WHERE id=p_actor_id||':'||p_club_id;
    END IF;
    UPDATE public.hg_users SET doc=doc||jsonb_build_object('displayName',display_name,'updatedAt',now_text) WHERE id=p_actor_id;
    invite:=invite||jsonb_build_object('usedCount',used+1,'updatedAt',now_text);
    UPDATE public.hg_invite_codes SET doc=invite WHERE id=invite_id;
  END IF;
  RETURN jsonb_build_object('state',admission_state,'applicationId',application->>'_id');
END $$;
REVOKE ALL ON FUNCTION public.hg_apply_invitation(text,jsonb,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.hg_apply_invitation(text,jsonb,text) TO service_role;

CREATE FUNCTION public.hg_decide_membership_application(p_actor_id text,p_input jsonb,p_club_id text) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE actor jsonb; application jsonb; member jsonb; invite jsonb; user_doc jsonb; updated jsonb; result jsonb;
  application_id text:=p_input->>'id'; member_id text; invite_id text; decision text:=p_input->>'decision';
  reason text:=COALESCE(NULLIF(btrim(p_input->>'reason'),''),''); expected integer; actual integer;
  used integer; reserved integer; version integer; status text; audit_id text; notification_id text;
  now_text text:=to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
BEGIN
  IF NULLIF(p_actor_id,'') IS NULL OR NULLIF(p_club_id,'') IS NULL THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('hg-governance:'||p_club_id||':members',0));
  actor:=public.hg_require_club_membership(p_actor_id,p_club_id,ARRAY['admin','moderator'],'update');
  IF application_id IS NULL OR decision NOT IN ('approve','reject') THEN RAISE EXCEPTION 'INVALID'; END IF;
  IF decision='reject' AND reason='' THEN RAISE EXCEPTION 'REASON_REQUIRED'; END IF;
  expected:=NULLIF(p_input->>'expectedVersion','')::int;
  IF expected IS NULL OR expected<1 THEN RAISE EXCEPTION 'INVALID'; END IF;
  SELECT id,doc INTO application_id,application FROM public.hg_membership_applications
    WHERE id=application_id AND doc->>'clubId'=p_club_id FOR UPDATE;
  IF application IS NULL THEN RAISE EXCEPTION 'APPLICATION_NOT_FOUND'; END IF;
  actual:=COALESCE(NULLIF(application->>'version','')::int,1);
  IF actual=expected+1 AND application->>'moderationExpectedVersion'=expected::text
    AND application->>'moderationDecision'=decision AND application->'moderationResult' IS NOT NULL THEN
    RETURN application->'moderationResult';
  END IF;
  IF actual<>expected OR application->>'status'<>'pending' THEN RAISE EXCEPTION 'VERSION_CONFLICT'; END IF;
  IF application->>'admissionMethod' NOT IN ('manual_join','manual_restore') THEN RAISE EXCEPTION 'APPLICATION_NOT_FOUND'; END IF;
  PERFORM set_config('heiguang.membership_decision','on',true);
  SELECT doc INTO user_doc FROM public.hg_users WHERE id=application->>'userId' FOR UPDATE;
  IF user_doc IS NULL OR user_doc->>'status' IS DISTINCT FROM 'active' THEN RAISE EXCEPTION 'MEMBER_NOT_FOUND'; END IF;
  member_id:=(application->>'userId')||':'||p_club_id;
  SELECT doc INTO member FROM public.hg_memberships WHERE id=member_id FOR UPDATE;
  IF member IS NOT NULL AND member->>'status'='active' THEN RAISE EXCEPTION 'MEMBERSHIP_EXISTS'; END IF;
  IF application->>'admissionMethod'='manual_restore' AND (member IS NULL OR member->>'status' IS DISTINCT FROM 'removed') THEN
    RAISE EXCEPTION 'MEMBERSHIP_NOT_RESTORABLE';
  END IF;
  IF application->>'admissionMethod'='manual_join' AND member IS NOT NULL THEN RAISE EXCEPTION 'MEMBERSHIP_EXISTS'; END IF;
  invite_id:=application->>'inviteId';
  IF NULLIF(invite_id,'') IS NULL OR application->>'reservationStatus'<>'reserved' THEN RAISE EXCEPTION 'RESERVATION_MISSING'; END IF;
  SELECT doc INTO invite FROM public.hg_invite_codes WHERE id=invite_id FOR UPDATE;
  IF invite IS NULL OR invite->>'clubId' IS DISTINCT FROM p_club_id THEN RAISE EXCEPTION 'INVITE_RECORD_MISSING'; END IF;
  reserved:=COALESCE(NULLIF(invite->>'reservedCount','')::int,0);
  used:=COALESCE(NULLIF(invite->>'usedCount','')::int,0);
  IF reserved<1 THEN RAISE EXCEPTION 'RESERVATION_MISSING'; END IF;
  IF NULLIF(application->>'reservationExpiresAt','') IS NULL
    OR (application->>'reservationExpiresAt')::timestamptz<=clock_timestamp() THEN
    UPDATE public.hg_invite_codes SET doc=invite||jsonb_build_object('reservedCount',reserved-1,'updatedAt',now_text)
      WHERE id=invite_id;
    updated:=application||jsonb_build_object('status','expired','reservationStatus','released','expiredAt',now_text,
      'version',actual+1,'moderationExpectedVersion',expected,'moderationDecision','expire',
      'moderationDecisionBy',p_actor_id,'moderationDecidedAt',now_text);
    result:=jsonb_build_object('error','RESERVATION_EXPIRED','id',application_id,'status','expired','version',actual+1);
    updated:=updated||jsonb_build_object('moderationResult',result);
    UPDATE public.hg_membership_applications SET doc=updated WHERE id=application_id;
    audit_id:='audit:'||md5(clock_timestamp()::text||random()::text);
    INSERT INTO public.hg_audit_logs(id,doc) VALUES(audit_id,
      jsonb_build_object('_id',audit_id,'clubId',p_club_id,
        'actorId',p_actor_id,'action','membership.expired','targetType','membership_application','targetId',application_id,
        'decision','expire','createdAt',now_text));
    RETURN result;
  END IF;
  IF decision='reject' THEN
    UPDATE public.hg_invite_codes SET doc=invite||jsonb_build_object('reservedCount',reserved-1,'updatedAt',now_text)
      WHERE id=invite_id;
    status:='rejected';
  ELSE
    IF member IS NULL THEN
      INSERT INTO public.hg_memberships(id,doc) VALUES(member_id,jsonb_build_object('_id',member_id,
        'userId',application->>'userId','clubId',p_club_id,'role','member','status','active',
        'applicationId',application_id,'rulesVersion',application->>'rulesVersion','version',1,
        'joinedAt',now_text,'updatedAt',now_text));
    ELSE
      UPDATE public.hg_memberships SET doc=(doc-'managementTermId')||jsonb_build_object('role','member','status','active',
        'applicationId',application_id,'rulesVersion',application->>'rulesVersion',
        'version',COALESCE(NULLIF(doc->>'version','')::int,1)+1,'joinedAt',now_text,'updatedAt',now_text)
        WHERE id=member_id;
    END IF;
    UPDATE public.hg_users SET doc=doc||jsonb_build_object('displayName',application->>'displayName','updatedAt',now_text)
      WHERE id=application->>'userId';
    UPDATE public.hg_invite_codes SET doc=invite||jsonb_build_object('reservedCount',reserved-1,
      'usedCount',used+1,'updatedAt',now_text) WHERE id=invite_id;
    status:='active';
  END IF;
  updated:=application||jsonb_build_object('status',status,'reservationStatus',CASE WHEN decision='approve' THEN 'consumed' ELSE 'released' END,
    'decisionReason',reason,'decidedBy',p_actor_id,'decidedAt',now_text,'version',actual+1,
    'moderationExpectedVersion',expected,'moderationDecision',decision,'moderationDecisionBy',p_actor_id,
    'moderationDecidedAt',now_text);
  result:=jsonb_build_object('ok',true,'id',application_id,'status',status,'version',actual+1);
  updated:=updated||jsonb_build_object('moderationResult',result);
  UPDATE public.hg_membership_applications SET doc=updated WHERE id=application_id AND doc->>'clubId'=p_club_id;
  audit_id:='audit:'||md5(clock_timestamp()::text||random()::text);
  INSERT INTO public.hg_audit_logs(id,doc) VALUES(audit_id,
    jsonb_build_object('_id',audit_id,'clubId',p_club_id,
      'actorId',p_actor_id,'action','membership.'||decision,'targetType','membership_application','targetId',application_id,
      'decision',decision,'reason',reason,'createdAt',now_text));
  notification_id:='notification:'||md5(clock_timestamp()::text||random()::text);
  INSERT INTO public.hg_notifications(id,doc) VALUES(notification_id,
    jsonb_build_object('_id',notification_id,'clubId',p_club_id,
      'recipientId',application->>'userId','eventType','system_membership',
      'title',CASE WHEN decision='approve' THEN '欢迎加入社团' ELSE '入社申请未通过' END,
      'summary',CASE WHEN decision='approve' THEN '现在可以在社内写下第一笔了。' ELSE reason END,
      'targetType','system','targetId','membership','icon','usergroup','createdAt',now_text));
  RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.hg_decide_membership_application(text,jsonb,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.hg_decide_membership_application(text,jsonb,text) TO service_role;

ALTER FUNCTION public.hg_moderate(text,text,jsonb,text) RENAME TO hg_moderate_pre_governance;
REVOKE ALL ON FUNCTION public.hg_moderate_pre_governance(text,text,jsonb,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.hg_moderate_pre_governance(text,text,jsonb,text) TO service_role;
CREATE FUNCTION public.hg_moderate(p_action text,p_actor_id text,p_input jsonb,p_club_id text) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
BEGIN
  IF p_action='membership.decide' THEN
    RETURN public.hg_decide_membership_application(p_actor_id,p_input,p_club_id);
  END IF;
  RETURN public.hg_moderate_pre_governance(p_action,p_actor_id,p_input,p_club_id);
END $$;
REVOKE ALL ON FUNCTION public.hg_moderate(text,text,jsonb,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.hg_moderate(text,text,jsonb,text) TO service_role;
REVOKE ALL ON FUNCTION public.hg_moderate(text,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.hg_moderate(text,text,jsonb) TO service_role;

ALTER FUNCTION public.hg_apply_membership(text,jsonb,text) RENAME TO hg_apply_membership_pre_governance;
REVOKE ALL ON FUNCTION public.hg_apply_membership_pre_governance(text,jsonb,text) FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.hg_apply_membership(p_actor_id text,p_input jsonb,p_club_id text) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE invite_code text; code_hash text; input jsonb;
BEGIN
  invite_code:=upper(btrim(COALESCE(p_input->>'inviteCode','')));
  code_hash:=encode(digest(convert_to(invite_code,'UTF8'),'sha256'),'hex');
  input:=(COALESCE(p_input,'{}'::jsonb)-'inviteCode')||jsonb_build_object('codeHash',code_hash);
  RETURN public.hg_apply_invitation(p_actor_id,input,p_club_id);
END $$;
REVOKE ALL ON FUNCTION public.hg_apply_membership(text,jsonb,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.hg_apply_membership(text,jsonb,text) TO service_role;
REVOKE ALL ON FUNCTION public.hg_apply_membership(text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.hg_apply_membership(text,jsonb) TO service_role;

CREATE FUNCTION public.hg_admin_audit(p_club_id text,p_actor_id text,p_action text,p_target_type text,
  p_target_id text,p_reason text DEFAULT '',p_extra jsonb DEFAULT '{}'::jsonb) RETURNS text
LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE audit_id text:='audit:'||gen_random_uuid()::text;
BEGIN
  INSERT INTO public.hg_audit_logs(id,doc) VALUES(audit_id,jsonb_build_object('_id',audit_id,
    'scope','club_management','clubId',p_club_id,'actorId',p_actor_id,'action',p_action,
    'targetType',p_target_type,'targetId',p_target_id,'reason',COALESCE(p_reason,''),
    'extra',COALESCE(p_extra,'{}'::jsonb),
    'createdAt',to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')));
  RETURN audit_id;
END $$;
REVOKE ALL ON FUNCTION public.hg_admin_audit(text,text,text,text,text,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.hg_admin_audit(text,text,text,text,text,text,jsonb) TO service_role;

CREATE FUNCTION public.hg_apply_management_transition(p_actor_id text,p_request_id text,p_club_id text,p_recovery boolean)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE request jsonb; club jsonb; term jsonb; old_term_id text; new_term_id text; primary_id text;
  base_team jsonb; new_team jsonb; team_member jsonb; member jsonb; member_id text; user_doc jsonb;
  old_manager record; actual_version integer; expected_version integer; team_count integer; stale boolean:=false;
  invite record; retain_ids jsonb; members_snapshot jsonb:='[]'::jsonb; version integer; reason text;
  action_name text; result jsonb; stamp text;
  now_text text:=to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('hg-governance:'||p_club_id||':members',0));
  SELECT doc INTO club FROM public.hg_club_config WHERE id=p_club_id FOR UPDATE;
  IF club IS NULL THEN RAISE EXCEPTION 'CLUB_NOT_FOUND'; END IF;
  IF NOT p_recovery AND COALESCE(club->>'status','active')<>'active' THEN RAISE EXCEPTION 'CLUB_PAUSED'; END IF;
  SELECT doc INTO request FROM public.hg_management_requests WHERE id=p_request_id AND doc->>'clubId'=p_club_id FOR UPDATE;
  IF request IS NULL THEN RAISE EXCEPTION 'HANDOVER_NOT_FOUND'; END IF;
  IF p_recovery THEN
    PERFORM public.hg_require_developer(p_actor_id);
    IF request->>'type'<>'recovery' OR request->>'status'<>'recovery_requested' THEN RAISE EXCEPTION 'VERSION_CONFLICT'; END IF;
    IF NULLIF(request->>'expiresAt','') IS NULL OR (request->>'expiresAt')::timestamptz<=clock_timestamp() THEN
      UPDATE public.hg_management_requests SET doc=request||jsonb_build_object('status','expired','expiredAt',now_text,
        'version',COALESCE(NULLIF(request->>'version','')::int,1)+1) WHERE id=p_request_id;
      PERFORM public.hg_admin_platform_audit(p_club_id,p_actor_id,'platform.recovery.expired',p_request_id,
        COALESCE(request->>'reason',''),jsonb_build_object('status','expired'));
      RETURN jsonb_build_object('error','RECOVERY_EXPIRED','id',p_request_id,'status','expired',
        'version',COALESCE(NULLIF(request->>'version','')::int,1)+1);
    END IF;
    IF NULLIF(request->>'targetAcceptedAt','') IS NULL THEN RAISE EXCEPTION 'TARGET_ACCEPTANCE_REQUIRED'; END IF;
  ELSE
    IF request->>'targetUserId' IS DISTINCT FROM p_actor_id THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
    IF request->>'type'<>'handover' OR request->>'status'<>'proposed' THEN RAISE EXCEPTION 'VERSION_CONFLICT'; END IF;
    IF (request->>'expiresAt')::timestamptz<=clock_timestamp() THEN
      UPDATE public.hg_management_requests SET doc=request||jsonb_build_object('status','expired','expiredAt',now_text,
        'version',COALESCE(NULLIF(request->>'version','')::int,1)+1) WHERE id=p_request_id;
      RETURN jsonb_build_object('error','HANDOVER_EXPIRED','id',p_request_id,'status','expired');
    END IF;
  END IF;
  old_term_id:=request->>'baseTermId';
  SELECT doc INTO term FROM public.hg_management_terms WHERE id=old_term_id AND doc->>'clubId'=p_club_id FOR UPDATE;
  IF term IS NULL OR club->>'managementTermId' IS DISTINCT FROM old_term_id
    OR COALESCE(NULLIF(term->>'version','')::int,1)<>COALESCE(NULLIF(request->>'baseTermVersion','')::int,0) THEN
    stale:=true;
  END IF;
  base_team:=COALESCE(request->'baseTeam','[]'::jsonb);
  new_team:=COALESCE(request->'team','[]'::jsonb);
  primary_id:=request->>'primaryUserId';
  IF jsonb_typeof(new_team)<>'array' OR jsonb_array_length(new_team)<1
    OR (SELECT count(DISTINCT item->>'targetUserId') FROM jsonb_array_elements(new_team) item)<>jsonb_array_length(new_team)
    OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(new_team) item WHERE item->>'targetUserId'=primary_id AND item->>'role'='moderator') THEN
    RAISE EXCEPTION 'TEAM_INVALID';
  END IF;
  IF (SELECT count(*) FROM jsonb_array_elements(new_team) item
      WHERE item->>'role' NOT IN ('admin','moderator') OR NULLIF(item->>'targetUserId','') IS NULL)<>0 THEN
    RAISE EXCEPTION 'TEAM_INVALID';
  END IF;
  FOR team_member IN SELECT value FROM jsonb_array_elements(new_team) LOOP
    SELECT doc INTO user_doc FROM public.hg_users WHERE id=team_member->>'targetUserId' FOR UPDATE;
    member_id:=(team_member->>'targetUserId')||':'||p_club_id;
    SELECT doc INTO member FROM public.hg_memberships WHERE id=member_id FOR UPDATE;
    expected_version:=NULLIF(team_member->>'expectedVersion','')::int;
    actual_version:=COALESCE(NULLIF(member->>'version','')::int,1);
    IF user_doc IS NULL OR user_doc->>'status' IS DISTINCT FROM 'active' OR member IS NULL
      OR member->>'status' IS DISTINCT FROM 'active' OR expected_version IS NULL
      OR expected_version<>actual_version THEN stale:=true; END IF;
  END LOOP;
  FOR team_member IN SELECT value FROM jsonb_array_elements(base_team) LOOP
    member_id:=(team_member->>'targetUserId')||':'||p_club_id;
    SELECT doc INTO member FROM public.hg_memberships WHERE id=member_id;
    IF member IS NULL OR member->>'status' IS DISTINCT FROM 'active'
      OR member->>'role' IS DISTINCT FROM team_member->>'role'
      OR COALESCE(NULLIF(member->>'version','')::int,1)<>COALESCE(NULLIF(team_member->>'version','')::int,0) THEN
      stale:=true;
    END IF;
  END LOOP;
  IF EXISTS(SELECT 1 FROM public.hg_memberships m WHERE m.doc->>'clubId'=p_club_id
    AND m.doc->>'status'='active' AND m.doc->>'role' IN ('admin','moderator')
    AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(base_team) old
      WHERE old->>'targetUserId'=m.doc->>'userId')) THEN stale:=true; END IF;
  IF stale THEN
    action_name:=CASE WHEN p_recovery THEN 'management.recovery.stale' ELSE 'management.handover.stale' END;
    UPDATE public.hg_management_requests SET doc=request||jsonb_build_object('status','stale','staleAt',now_text,
      'version',COALESCE(NULLIF(request->>'version','')::int,1)+1) WHERE id=p_request_id;
    PERFORM public.hg_admin_audit(p_club_id,p_actor_id,action_name,'management_request',p_request_id,
      COALESCE(request->>'reason',''),jsonb_build_object('status','stale'));
    RETURN jsonb_build_object('error',CASE WHEN p_recovery THEN 'RECOVERY_STALE' ELSE 'HANDOVER_STALE' END,
      'id',p_request_id,'status','stale','version',COALESCE(NULLIF(request->>'version','')::int,1)+1);
  END IF;
  new_term_id:='term:'||gen_random_uuid()::text;
  -- Demote managers omitted from the complete successor list before promoting
  -- the new list.  No content, post, comment or media row is moved or deleted.
  FOR old_manager IN SELECT id,doc FROM public.hg_memberships m WHERE m.doc->>'clubId'=p_club_id
    AND m.doc->>'status'='active' AND m.doc->>'role' IN ('admin','moderator') ORDER BY id FOR UPDATE LOOP
    IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(new_team) item WHERE item->>'targetUserId'=old_manager.doc->>'userId') THEN
      UPDATE public.hg_memberships SET doc=(old_manager.doc-'managementTermId')||jsonb_build_object('role','member',
        'version',COALESCE(NULLIF(old_manager.doc->>'version','')::int,1)+1,'updatedAt',now_text)
        WHERE id=old_manager.id;
    END IF;
  END LOOP;
  FOR team_member IN SELECT value FROM jsonb_array_elements(new_team) LOOP
    expected_version:=NULLIF(team_member->>'expectedVersion','')::int;
    version:=expected_version+1;
    members_snapshot:=members_snapshot||jsonb_build_array(jsonb_build_object('targetUserId',team_member->>'targetUserId',
      'role',team_member->>'role','version',version));
  END LOOP;
  stamp:=now_text;
  INSERT INTO public.hg_management_terms(id,doc) VALUES(new_term_id,jsonb_build_object('_id',new_term_id,
    'clubId',p_club_id,'version',1,'primaryUserId',primary_id,'members',members_snapshot,'status','active',
    'startAt',stamp,'endAt',request->'termEndAt','createdBy',p_actor_id,'createdAt',stamp));
  UPDATE public.hg_club_config SET doc=doc||jsonb_build_object('managementTermId',new_term_id,
    'moderatorUserId',primary_id,'managementVersion',COALESCE(NULLIF(doc->>'managementVersion','')::int,1)+1,
    'termEndAt',request->'termEndAt','updatedAt',stamp) WHERE id=p_club_id;
  FOR team_member IN SELECT value FROM jsonb_array_elements(new_team) LOOP
    member_id:=(team_member->>'targetUserId')||':'||p_club_id;
    expected_version:=NULLIF(team_member->>'expectedVersion','')::int;
    SELECT doc INTO member FROM public.hg_memberships WHERE id=member_id FOR UPDATE;
    UPDATE public.hg_memberships SET doc=member||jsonb_build_object('role',team_member->>'role',
      'managementTermId',new_term_id,'version',expected_version+1,'updatedAt',stamp) WHERE id=member_id;
  END LOOP;
  UPDATE public.hg_management_terms SET doc=doc||jsonb_build_object('status','ended','endedAt',stamp,
    'successorTermId',new_term_id,'version',COALESCE(NULLIF(doc->>'version','')::int,1)+1) WHERE id=old_term_id;
  retain_ids:=COALESCE(request->'retainInviteIds','[]'::jsonb);
  FOR invite IN SELECT id,doc FROM public.hg_invite_codes WHERE doc->>'clubId'=p_club_id
    AND doc->>'issuedManagementTermId'=old_term_id AND NULLIF(doc->>'revokedAt','') IS NULL FOR UPDATE LOOP
    IF invite.doc->>'mode'='direct' THEN
      UPDATE public.hg_invite_codes SET doc=invite.doc||jsonb_build_object('revokedAt',stamp,'revokeReason',
        CASE WHEN p_recovery THEN 'management recovery' ELSE 'management handover' END,
        'version',COALESCE(NULLIF(invite.doc->>'version','')::int,1)+1,'updatedAt',stamp) WHERE id=invite.id;
    ELSIF invite.doc->>'mode'='application' AND NOT EXISTS(
        SELECT 1 FROM jsonb_array_elements_text(retain_ids) kept WHERE kept=invite.id) THEN
      UPDATE public.hg_invite_codes SET doc=invite.doc||jsonb_build_object('revokedAt',stamp,'revokeReason',
        CASE WHEN p_recovery THEN 'management recovery' ELSE 'management handover' END,
        'version',COALESCE(NULLIF(invite.doc->>'version','')::int,1)+1,'updatedAt',stamp) WHERE id=invite.id;
    ELSIF invite.doc->>'mode'='application' THEN
      UPDATE public.hg_invite_codes SET doc=invite.doc||jsonb_build_object('issuedManagementTermId',new_term_id,
        'version',COALESCE(NULLIF(invite.doc->>'version','')::int,1)+1,'updatedAt',stamp) WHERE id=invite.id;
    END IF;
  END LOOP;
  UPDATE public.hg_management_requests SET doc=request||jsonb_build_object('status','completed','completedAt',stamp,
    'acceptedBy',CASE WHEN p_recovery THEN request->>'targetUserId' ELSE p_actor_id END,
    'approvedBy',CASE WHEN p_recovery THEN p_actor_id ELSE NULL END,'newTermId',new_term_id,
    'version',COALESCE(NULLIF(request->>'version','')::int,1)+1) WHERE id=p_request_id;
  action_name:=CASE WHEN p_recovery THEN 'management.recovery.completed' ELSE 'management.handover.completed' END;
  PERFORM public.hg_admin_audit(p_club_id,p_actor_id,action_name,'management_request',p_request_id,
    COALESCE(request->>'reason',''),jsonb_build_object('oldTermId',old_term_id,'newTermId',new_term_id,'primaryUserId',primary_id));
  RETURN jsonb_build_object('ok',true,'id',p_request_id,'status','completed','term',
    jsonb_build_object('id',new_term_id,'version',1,'primaryUserId',primary_id,'startAt',stamp,'endAt',request->'termEndAt'));
END $$;
REVOKE ALL ON FUNCTION public.hg_apply_management_transition(text,text,text,boolean) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.hg_apply_management_transition(text,text,text,boolean) TO service_role;

CREATE FUNCTION public.hg_admin_request_dto(p_doc jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE team jsonb; club_name text;
BEGIN
  SELECT COALESCE(jsonb_agg(jsonb_build_object('targetUserId',person->>'targetUserId',
      'displayName',COALESCE(u.doc->>'displayName',''),'role',person->>'role',
      'version',COALESCE(NULLIF(person->>'expectedVersion','')::int,NULLIF(person->>'version','')::int,1))
      ORDER BY person->>'targetUserId'),'[]'::jsonb)
    INTO team FROM jsonb_array_elements(COALESCE(p_doc->'team','[]'::jsonb)) person
    LEFT JOIN public.hg_users u ON u.id=person->>'targetUserId';
  SELECT COALESCE(doc->>'name','') INTO club_name FROM public.hg_club_config WHERE id=p_doc->>'clubId';
  RETURN jsonb_build_object('id',p_doc->>'_id','clubId',p_doc->>'clubId','clubName',COALESCE(club_name,''),
    'type',p_doc->>'type','status',p_doc->>'status','creatorId',p_doc->>'creatorId',
    'requesterId',p_doc->>'creatorId','targetUserId',p_doc->>'targetUserId',
    'primaryUserId',p_doc->>'primaryUserId','proposedTeam',team,'reason',p_doc->>'reason',
    'expiresAt',p_doc->>'expiresAt','createdAt',p_doc->>'createdAt','acceptedAt',p_doc->>'targetAcceptedAt',
    'approvedAt',p_doc->>'approvedAt','version',COALESCE(NULLIF(p_doc->>'version','')::int,1));
END $$;
REVOKE ALL ON FUNCTION public.hg_admin_request_dto(jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.hg_admin_request_dto(jsonb) TO service_role;

CREATE FUNCTION public.hg_admin_platform_audit(p_club_id text,p_actor_id text,p_action text,
  p_target_id text,p_reason text,p_extra jsonb DEFAULT '{}'::jsonb) RETURNS text
LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE audit_id text:='audit:platform:'||gen_random_uuid()::text;
BEGIN
  INSERT INTO public.hg_audit_logs(id,doc) VALUES(audit_id,jsonb_build_object('_id',audit_id,
    'scope','platform','clubId',p_club_id,'actorId',p_actor_id,'action',p_action,
    'targetType','management_recovery','targetId',p_target_id,'reason',COALESCE(p_reason,''),
    'extra',COALESCE(p_extra,'{}'::jsonb),
    'createdAt',to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')));
  RETURN audit_id;
END $$;
REVOKE ALL ON FUNCTION public.hg_admin_platform_audit(text,text,text,text,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.hg_admin_platform_audit(text,text,text,text,text,jsonb) TO service_role;

CREATE FUNCTION public.hg_admin_management(p_actor_id text,p_action text,p_input jsonb,p_club_id text) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE actor jsonb; club jsonb; term jsonb; app jsonb; invite jsonb; request jsonb; member jsonb; user_doc jsonb;
  application_row record; target_id text; request_id text; invite_id text; new_id text; current_term_id text;
  reason text; decision text; mode text; code_hash text; name text; description text; charter text;
  admission_mode text; current_rules text; next_rules text; changes jsonb; team jsonb; base_team jsonb;
  primary_id text; expected integer; actual integer; member_version integer; manager_count integer;
  max_uses integer; ttl_seconds integer; expires_at text; term_member_count integer; pending_management integer;
  notification_summary text;
  now_text text:=to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  page_limit integer; status_filter text; cursor_value text; cursor_time text; cursor_id text; decoded_cursor text;
  dto_item jsonb; items jsonb; result jsonb; next_cursor text; has_more boolean; more_count integer; dev_count integer;
  term_doc jsonb; audit_id text; notification_id text; target_status text; team_member jsonb; pending_id text;
BEGIN
  IF p_action IN ('handovers.mine','recovery.mine','recovery.info') THEN
    IF NULLIF(p_actor_id,'') IS NULL THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
    IF p_action='handovers.mine' THEN
      cursor_value:=COALESCE(p_input->>'cursor','');
      page_limit:=COALESCE(NULLIF(p_input->>'limit','')::int,50);
      IF page_limit<1 OR page_limit>100 OR length(cursor_value)>512 THEN RAISE EXCEPTION 'INVALID'; END IF;
      IF cursor_value<>'' THEN
        BEGIN
          decoded_cursor:=convert_from(decode(cursor_value,'hex'),'UTF8');
          cursor_time:=split_part(decoded_cursor,E'\n',1);
          cursor_id:=substr(decoded_cursor,length(cursor_time)+2);
          IF cursor_time='' OR cursor_id='' THEN RAISE EXCEPTION 'INVALID'; END IF;
        EXCEPTION WHEN others THEN RAISE EXCEPTION 'INVALID'; END;
      END IF;
      WITH rows AS (
        SELECT id,doc,row_number() OVER(ORDER BY doc->>'createdAt' DESC,id DESC) AS rn
        FROM public.hg_management_requests
        WHERE doc->>'type'='handover' AND doc->>'status'='proposed'
          AND (doc->>'targetUserId'=p_actor_id OR doc->>'creatorId'=p_actor_id)
          AND (NULLIF(p_club_id,'') IS NULL OR doc->>'clubId'=p_club_id)
          AND NULLIF(doc->>'expiresAt','')::timestamptz>clock_timestamp()
          AND (cursor_value='' OR doc->>'createdAt'<cursor_time OR (doc->>'createdAt'=cursor_time AND id<cursor_id))
      ), page AS (SELECT * FROM rows WHERE rn<=page_limit+1)
      SELECT COALESCE(jsonb_agg(public.hg_admin_request_dto(doc) ORDER BY doc->>'createdAt' DESC,id DESC)
          FILTER(WHERE rn<=page_limit),'[]'::jsonb),
        (SELECT encode(convert_to(last.doc->>'createdAt'||E'\n'||last.id,'UTF8'),'hex')
          FROM page last WHERE last.rn=page_limit),
        count(*)>page_limit INTO items,next_cursor,has_more FROM page;
    RETURN jsonb_build_object('items',COALESCE(items,'[]'::jsonb),
        'nextCursor',CASE WHEN has_more THEN next_cursor ELSE NULL END);
    ELSIF p_action='recovery.mine' THEN
      cursor_value:=COALESCE(p_input->>'cursor','');
      page_limit:=COALESCE(NULLIF(p_input->>'limit','')::int,50);
      IF page_limit<1 OR page_limit>100 OR length(cursor_value)>512 THEN RAISE EXCEPTION 'INVALID'; END IF;
      IF cursor_value<>'' THEN
        BEGIN
          decoded_cursor:=convert_from(decode(cursor_value,'hex'),'UTF8');
          cursor_time:=split_part(decoded_cursor,E'\n',1);
          cursor_id:=substr(decoded_cursor,length(cursor_time)+2);
          IF cursor_time='' OR cursor_id='' THEN RAISE EXCEPTION 'INVALID'; END IF;
        EXCEPTION WHEN others THEN RAISE EXCEPTION 'INVALID'; END;
      END IF;
      WITH rows AS (
        SELECT id,doc,row_number() OVER(ORDER BY doc->>'createdAt' DESC,id DESC) AS rn
        FROM public.hg_management_requests
        WHERE doc->>'type'='recovery' AND doc->>'status'='recovery_requested' AND doc->>'targetUserId'=p_actor_id
          AND NULLIF(doc->>'expiresAt','')::timestamptz>clock_timestamp()
          AND (NULLIF(p_club_id,'') IS NULL OR doc->>'clubId'=p_club_id)
          AND (cursor_value='' OR doc->>'createdAt'<cursor_time OR (doc->>'createdAt'=cursor_time AND id<cursor_id))
      ), page AS (SELECT * FROM rows WHERE rn<=page_limit+1)
      SELECT COALESCE(jsonb_agg(public.hg_admin_request_dto(doc) ORDER BY doc->>'createdAt' DESC,id DESC)
          FILTER(WHERE rn<=page_limit),'[]'::jsonb),
        (SELECT encode(convert_to(last.doc->>'createdAt'||E'\n'||last.id,'UTF8'),'hex')
          FROM page last WHERE last.rn=page_limit),
        count(*)>page_limit INTO items,next_cursor,has_more FROM page;
      RETURN jsonb_build_object('items',COALESCE(items,'[]'::jsonb),
        'nextCursor',CASE WHEN has_more THEN next_cursor ELSE NULL END);
    END IF;
    request_id:=COALESCE(NULLIF(p_input->>'recoveryId',''),p_input->>'id');
    SELECT doc INTO request FROM public.hg_management_requests WHERE id=request_id AND doc->>'type'='recovery'
      AND doc->>'targetUserId'=p_actor_id;
    IF request IS NULL THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
    RETURN public.hg_admin_request_dto(request);
  END IF;
  IF NULLIF(p_actor_id,'') IS NULL OR NULLIF(p_club_id,'') IS NULL OR jsonb_typeof(COALESCE(p_input,'{}'::jsonb))<>'object' THEN
    RAISE EXCEPTION 'FORBIDDEN';
  END IF;
  reason:=COALESCE(NULLIF(btrim(p_input->>'reason'),''),'');
  request_id:=COALESCE(NULLIF(p_input->>'id',''),p_input->>'recoveryId');
  IF p_action='applications.cancel' THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('hg-governance:'||p_club_id||':members',0));
    expected:=NULLIF(p_input->>'expectedVersion','')::int;
    SELECT id,doc INTO application_row FROM public.hg_membership_applications
      WHERE id=p_input->>'id' AND doc->>'clubId'=p_club_id AND doc->>'userId'=p_actor_id FOR UPDATE;
    app:=application_row.doc;
    IF app IS NULL THEN RAISE EXCEPTION 'APPLICATION_NOT_FOUND'; END IF;
    IF expected IS NULL OR COALESCE(NULLIF(app->>'version','')::int,1)<>expected OR app->>'status'<>'pending'
      THEN RAISE EXCEPTION 'VERSION_CONFLICT'; END IF;
    PERFORM 1 FROM public.hg_users WHERE id=p_actor_id AND doc->>'status'='active' FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
    invite_id:=app->>'inviteId';
    IF app->>'reservationStatus'<>'reserved' OR NULLIF(invite_id,'') IS NULL THEN RAISE EXCEPTION 'RESERVATION_MISSING'; END IF;
    SELECT doc INTO invite FROM public.hg_invite_codes WHERE id=invite_id AND doc->>'clubId'=p_club_id FOR UPDATE;
    IF invite IS NULL THEN RAISE EXCEPTION 'INVITE_RECORD_MISSING'; END IF;
    actual:=COALESCE(NULLIF(invite->>'reservedCount','')::int,0);
    IF actual<1 THEN RAISE EXCEPTION 'RESERVATION_MISSING'; END IF;
    target_status:=CASE WHEN NULLIF(app->>'reservationExpiresAt','')::timestamptz<=clock_timestamp() THEN 'expired' ELSE 'cancelled' END;
    UPDATE public.hg_invite_codes SET doc=invite||jsonb_build_object('reservedCount',actual-1,'updatedAt',now_text) WHERE id=invite_id;
    app:=app||jsonb_build_object('status',target_status,'reservationStatus','released','cancelledAt',now_text,
      'cancelledBy',p_actor_id,'cancelReason',reason,'version',expected+1,'updatedAt',now_text);
    UPDATE public.hg_membership_applications SET doc=app WHERE id=p_input->>'id' AND doc->>'clubId'=p_club_id;
    PERFORM public.hg_admin_audit(p_club_id,p_actor_id,'membership.'||target_status,'membership_application',p_input->>'id',
      reason,jsonb_build_object('version',expected+1));
    IF target_status='expired' THEN RETURN jsonb_build_object('error','RESERVATION_EXPIRED','id',p_input->>'id','status',target_status,'version',expected+1); END IF;
    RETURN jsonb_build_object('ok',true,'id',p_input->>'id','status',target_status,'version',expected+1);
  END IF;
  IF p_action IN ('invites.create','invites.revoke','settings.update','team.primary','handovers.create','recovery.request') THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('hg-governance:'||p_club_id||':members',0));
  END IF;
  IF p_action IN ('handovers.accept','recovery.accept','recovery.decline','recovery.approve') THEN
    expected:=NULLIF(p_input->>'expectedVersion','')::int;
    IF expected IS NULL OR expected<1 THEN RAISE EXCEPTION 'INVALID'; END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended('hg-governance:'||p_club_id||':members',0));
    SELECT doc INTO request FROM public.hg_management_requests WHERE id=request_id AND doc->>'clubId'=p_club_id FOR UPDATE;
    IF request IS NULL THEN RAISE EXCEPTION 'HANDOVER_NOT_FOUND'; END IF;
    actual:=COALESCE(NULLIF(request->>'version','')::int,1);
    IF actual<>expected THEN RAISE EXCEPTION 'VERSION_CONFLICT'; END IF;
    IF p_action='handovers.accept' THEN
      IF request->>'type'<>'handover' OR request->>'targetUserId' IS DISTINCT FROM p_actor_id THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
      PERFORM 1 FROM public.hg_users WHERE id=p_actor_id AND doc->>'status'='active' FOR UPDATE;
      IF NOT FOUND THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
      RETURN public.hg_apply_management_transition(p_actor_id,request_id,p_club_id,false);
    ELSIF p_action IN ('recovery.accept','recovery.decline') THEN
      IF request->>'type'<>'recovery' OR request->>'targetUserId' IS DISTINCT FROM p_actor_id
        OR request->>'status'<>'recovery_requested' THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
      PERFORM 1 FROM public.hg_users WHERE id=p_actor_id AND doc->>'status'='active' FOR UPDATE;
      IF NOT FOUND THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
      PERFORM 1 FROM public.hg_memberships WHERE doc->>'userId'=p_actor_id AND doc->>'clubId'=p_club_id
        AND doc->>'status'='active' FOR SHARE;
      IF NOT FOUND THEN RAISE EXCEPTION 'TARGET_MEMBERSHIP_INACTIVE'; END IF;
      IF NULLIF(request->>'expiresAt','') IS NULL OR (request->>'expiresAt')::timestamptz<=clock_timestamp() THEN
        request:=request||jsonb_build_object('status','expired','expiredAt',now_text,'version',actual+1,'updatedAt',now_text);
        UPDATE public.hg_management_requests SET doc=request WHERE id=request_id;
        PERFORM public.hg_admin_platform_audit(p_club_id,p_actor_id,'platform.recovery.expired',request_id,
          COALESCE(request->>'reason',''),jsonb_build_object('status','expired'));
        RETURN jsonb_build_object('error','RECOVERY_EXPIRED','id',request_id,'status','expired','version',actual+1);
      END IF;
      IF p_action='recovery.accept' THEN
        IF NULLIF(request->>'targetAcceptedAt','') IS NOT NULL THEN
          RETURN jsonb_build_object('ok',true,'id',request_id,'status','recovery_requested','version',actual);
        END IF;
        request:=request||jsonb_build_object('targetAcceptedAt',now_text,'version',actual+1,'updatedAt',now_text);
        UPDATE public.hg_management_requests SET doc=request WHERE id=request_id;
        PERFORM public.hg_admin_platform_audit(p_club_id,p_actor_id,'platform.recovery.accepted',request_id,
          COALESCE(request->>'reason',''),'{}'::jsonb);
        RETURN jsonb_build_object('ok',true,'id',request_id,'status','recovery_requested','version',actual+1,'acceptedAt',now_text);
      END IF;
      request:=request||jsonb_build_object('status','recovery_rejected','declinedAt',now_text,
        'declinedBy',p_actor_id,'declineReason',reason,'version',actual+1,'updatedAt',now_text);
      UPDATE public.hg_management_requests SET doc=request WHERE id=request_id;
      PERFORM public.hg_admin_platform_audit(p_club_id,p_actor_id,'platform.recovery.rejected',request_id,
        reason,jsonb_build_object('status','recovery_rejected'));
      RETURN jsonb_build_object('ok',true,'id',request_id,'status','recovery_rejected','version',actual+1);
    END IF;
    PERFORM public.hg_require_developer(p_actor_id);
    IF request->>'type'<>'recovery' OR request->>'status'<>'recovery_requested' THEN RAISE EXCEPTION 'VERSION_CONFLICT'; END IF;
    IF NULLIF(request->>'expiresAt','') IS NULL OR (request->>'expiresAt')::timestamptz<=clock_timestamp() THEN
      request:=request||jsonb_build_object('status','expired','expiredAt',now_text,'version',actual+1,'updatedAt',now_text);
      UPDATE public.hg_management_requests SET doc=request WHERE id=request_id;
      PERFORM public.hg_admin_platform_audit(p_club_id,p_actor_id,'platform.recovery.expired',request_id,
        COALESCE(request->>'reason',''),jsonb_build_object('status','expired'));
      RETURN jsonb_build_object('error','RECOVERY_EXPIRED','id',request_id,'status','expired','version',actual+1);
    END IF;
    decision:=COALESCE(NULLIF(p_input->>'decision',''),'approve');
    IF decision NOT IN ('approve','reject') THEN RAISE EXCEPTION 'INVALID'; END IF;
    IF char_length(reason)<10 OR char_length(reason)>500 THEN RAISE EXCEPTION 'REASON_REQUIRED'; END IF;
    IF decision='reject' THEN
      request:=request||jsonb_build_object('status','recovery_rejected','rejectedAt',now_text,
        'rejectedBy',p_actor_id,'rejectReason',reason,'version',actual+1,'updatedAt',now_text);
      UPDATE public.hg_management_requests SET doc=request WHERE id=request_id;
      PERFORM public.hg_admin_platform_audit(p_club_id,p_actor_id,'platform.recovery.rejected',request_id,
        reason,jsonb_build_object('status','recovery_rejected'));
      RETURN jsonb_build_object('ok',true,'id',request_id,'status','recovery_rejected','version',actual+1);
    END IF;
    IF NULLIF(request->>'targetAcceptedAt','') IS NULL THEN RAISE EXCEPTION 'TARGET_ACCEPTANCE_REQUIRED'; END IF;
    SELECT count(*) INTO dev_count FROM public.hg_users WHERE doc->>'status'='active' AND doc->>'platformRole'='developer';
    IF dev_count>=2 THEN
      IF request->>'creatorId'=p_actor_id THEN RETURN jsonb_build_object('error','RECOVERY_SECOND_APPROVAL_REQUIRED','id',request_id,'status','recovery_requested','version',actual); END IF;
    ELSE
      IF (request->>'createdAt')::timestamptz>clock_timestamp()-interval '24 hours' THEN
        RETURN jsonb_build_object('error','RECOVERY_COOLDOWN','id',request_id,'status','recovery_requested','version',actual);
      END IF;
    END IF;
    RETURN public.hg_apply_management_transition(p_actor_id,request_id,p_club_id,true);
  END IF;
  IF p_action IN ('recovery.list','recovery.request') THEN
    PERFORM public.hg_require_developer(p_actor_id);
    IF p_action='recovery.list' THEN
      status_filter:=COALESCE(NULLIF(p_input->>'status',''),'all');
      cursor_value:=COALESCE(p_input->>'cursor','');
      page_limit:=COALESCE(NULLIF(p_input->>'limit','')::int,50);
      IF status_filter NOT IN ('all','recovery_requested','completed','recovery_rejected','expired','stale')
        OR page_limit<1 OR page_limit>100 OR length(cursor_value)>512 THEN RAISE EXCEPTION 'INVALID'; END IF;
      IF cursor_value<>'' THEN
        BEGIN
          decoded_cursor:=convert_from(decode(cursor_value,'hex'),'UTF8');
          cursor_time:=split_part(decoded_cursor,E'\n',1);
          cursor_id:=substr(decoded_cursor,length(cursor_time)+2);
          IF cursor_time='' OR cursor_id='' THEN RAISE EXCEPTION 'INVALID'; END IF;
        EXCEPTION WHEN others THEN RAISE EXCEPTION 'INVALID'; END;
      END IF;
      WITH rows AS (
        SELECT id,doc,row_number() OVER(ORDER BY doc->>'createdAt' DESC,id DESC) AS rn
        FROM public.hg_management_requests
        WHERE doc->>'type'='recovery' AND doc->>'clubId'=p_club_id
          AND (cursor_value='' OR doc->>'createdAt'<cursor_time OR (doc->>'createdAt'=cursor_time AND id<cursor_id))
          AND (status_filter='all' OR doc->>'status'=status_filter)
      ), page AS (SELECT * FROM rows WHERE rn<=page_limit+1)
      SELECT COALESCE(jsonb_agg(public.hg_admin_request_dto(doc) ORDER BY doc->>'createdAt' DESC,id DESC)
          FILTER(WHERE rn<=page_limit),'[]'::jsonb),
        (SELECT encode(convert_to(last.doc->>'createdAt'||E'\n'||last.id,'UTF8'),'hex')
          FROM page last WHERE last.rn=page_limit),
        count(*)>page_limit INTO items,next_cursor,has_more FROM page;
      RETURN jsonb_build_object('items',COALESCE(items,'[]'::jsonb),
        'nextCursor',CASE WHEN has_more THEN next_cursor ELSE NULL END);
    END IF;
    IF char_length(reason)<10 OR char_length(reason)>500 THEN RAISE EXCEPTION 'REASON_REQUIRED'; END IF;
    target_id:=p_input->>'targetUserId';
    expected:=NULLIF(p_input->>'expectedVersion','')::int;
    IF NULLIF(target_id,'') IS NULL OR expected IS NULL THEN RAISE EXCEPTION 'INVALID'; END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended('hg-governance:'||p_club_id||':members',0));
    SELECT doc INTO club FROM public.hg_club_config WHERE id=p_club_id FOR UPDATE;
    IF club IS NULL THEN RAISE EXCEPTION 'CLUB_NOT_FOUND'; END IF;
    current_term_id:=club->>'managementTermId';
    SELECT doc INTO term FROM public.hg_management_terms WHERE id=current_term_id AND doc->>'clubId'=p_club_id FOR UPDATE;
    IF term IS NULL THEN RAISE EXCEPTION 'MANAGEMENT_TERM_NOT_FOUND'; END IF;
    IF expected<>COALESCE(NULLIF(term->>'version','')::int,1) THEN RAISE EXCEPTION 'VERSION_CONFLICT'; END IF;
    IF term->>'primaryUserId' IS NOT NULL AND term->>'primaryUserId'=target_id THEN RAISE EXCEPTION 'TARGET_ALREADY_PRIMARY'; END IF;
    team:=p_input->'team';
    IF team IS NULL OR team='null'::jsonb THEN
      SELECT doc INTO member FROM public.hg_memberships WHERE doc->>'userId'=target_id AND doc->>'clubId'=p_club_id
        AND doc->>'status'='active' FOR UPDATE;
      IF member IS NULL THEN RAISE EXCEPTION 'TARGET_MEMBERSHIP_INACTIVE'; END IF;
      team:=jsonb_build_array(jsonb_build_object('targetUserId',target_id,'role','moderator',
        'expectedVersion',COALESCE(NULLIF(member->>'version','')::int,1)));
    END IF;
    IF jsonb_typeof(team)<>'array' OR jsonb_array_length(team)<1 OR NOT EXISTS(
      SELECT 1 FROM jsonb_array_elements(team) candidate WHERE candidate->>'targetUserId'=target_id AND candidate->>'role'='moderator') THEN
      RAISE EXCEPTION 'TEAM_INVALID';
    END IF;
    IF EXISTS(SELECT 1 FROM jsonb_array_elements(team) candidate WHERE candidate->>'role' NOT IN ('admin','moderator')
      OR NULLIF(candidate->>'targetUserId','') IS NULL) OR
      (SELECT count(*) FROM jsonb_array_elements(team))<>(SELECT count(DISTINCT candidate->>'targetUserId') FROM jsonb_array_elements(team) candidate) THEN
      RAISE EXCEPTION 'TEAM_INVALID';
    END IF;
    PERFORM 1 FROM public.hg_memberships WHERE doc->>'userId'=target_id AND doc->>'clubId'=p_club_id
      AND doc->>'status'='active' FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'TARGET_MEMBERSHIP_INACTIVE'; END IF;
    FOR team_member IN SELECT value FROM jsonb_array_elements(team) LOOP
      SELECT doc INTO member FROM public.hg_memberships WHERE doc->>'userId'=team_member->>'targetUserId'
        AND doc->>'clubId'=p_club_id FOR UPDATE;
      IF member IS NULL OR member->>'status'<>'active' OR NULLIF(team_member->>'expectedVersion','') IS NULL
        OR NULLIF(team_member->>'expectedVersion','')::int IS DISTINCT FROM COALESCE(NULLIF(member->>'version','')::int,1) THEN
        RAISE EXCEPTION 'VERSION_CONFLICT'; END IF;
    END LOOP;
    IF jsonb_typeof(COALESCE(p_input->'retainInviteIds','[]'::jsonb))<>'array' OR EXISTS(
      SELECT 1 FROM jsonb_array_elements_text(COALESCE(p_input->'retainInviteIds','[]'::jsonb)) retained
      WHERE NOT EXISTS(SELECT 1 FROM public.hg_invite_codes i WHERE i.id=retained AND i.doc->>'clubId'=p_club_id
        AND i.doc->>'issuedManagementTermId'=current_term_id AND i.doc->>'mode'='application'
        AND public.hg_admin_invite_status(i.doc)='active')) THEN RAISE EXCEPTION 'INVITE_NOT_FOUND'; END IF;
    SELECT COALESCE(jsonb_agg(jsonb_build_object('targetUserId',m.doc->>'userId','role',m.doc->>'role',
      'version',COALESCE(NULLIF(m.doc->>'version','')::int,1)) ORDER BY m.doc->>'userId'),'[]'::jsonb) INTO base_team
      FROM public.hg_memberships m WHERE m.doc->>'clubId'=p_club_id AND m.doc->>'status'='active'
        AND m.doc->>'role' IN ('admin','moderator');
    SELECT count(*) INTO dev_count FROM public.hg_users WHERE doc->>'status'='active' AND doc->>'platformRole'='developer';
    notification_summary:='平台发起了社团管理恢复申请。理由：'||reason||'。'
      ||CASE WHEN dev_count>=2 THEN '目标账号确认后，还需另一名平台开发者复核。'
        ELSE '目标账号确认后，还需经过24小时冷却期，再由平台开发者复核。' END
      ||'此通知仅供知情，不含确认操作。';
    new_id:='recovery:'||gen_random_uuid()::text;
    UPDATE public.hg_management_requests SET doc=doc||jsonb_build_object('status','expired','expiredAt',now_text,
      'version',COALESCE(NULLIF(doc->>'version','')::int,1)+1)
      WHERE doc->>'clubId'=p_club_id AND doc->>'status' IN ('proposed','recovery_requested')
        AND NULLIF(doc->>'expiresAt','')::timestamptz<=clock_timestamp();
    IF EXISTS(SELECT 1 FROM public.hg_management_requests WHERE doc->>'clubId'=p_club_id
      AND doc->>'status' IN ('proposed','recovery_requested')) THEN RAISE EXCEPTION 'HANDOVER_PENDING'; END IF;
    reason:=btrim(reason);
    request:=jsonb_build_object('_id',new_id,'clubId',p_club_id,'type','recovery','status','recovery_requested',
      'creatorId',p_actor_id,'targetUserId',target_id,'primaryUserId',target_id,'team',team,'baseTeam',base_team,
      'baseTermId',current_term_id,'baseTermVersion',expected,'reason',reason,'version',1,
      'createdAt',now_text,'expiresAt',to_char((clock_timestamp()+interval '7 days') AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'retainInviteIds',COALESCE(p_input->'retainInviteIds','[]'::jsonb),
      'termEndAt',p_input->'termEndAt');
    INSERT INTO public.hg_management_requests(id,doc) VALUES(new_id,request);
    PERFORM public.hg_admin_platform_audit(p_club_id,p_actor_id,'platform.recovery.requested',new_id,reason,
      jsonb_build_object('targetUserId',target_id,'baseTermId',current_term_id));
    FOR team_member IN SELECT value FROM jsonb_array_elements(base_team) LOOP
      IF team_member->>'targetUserId' IS DISTINCT FROM target_id THEN
        notification_id:='notification:management-recovery-notice:'
          ||md5(new_id||':'||(team_member->>'targetUserId'));
        INSERT INTO public.hg_notifications(id,doc) VALUES(notification_id,jsonb_build_object('_id',notification_id,
          'clubId',p_club_id,'recipientId',team_member->>'targetUserId','eventType','management_recovery_notice',
          'title','社团管理恢复知情通知','summary',notification_summary,
          'targetType','system','targetId',NULL,'createdAt',now_text)) ON CONFLICT(id) DO NOTHING;
      END IF;
    END LOOP;
    notification_id:='notification:'||gen_random_uuid()::text;
    INSERT INTO public.hg_notifications(id,doc) VALUES(notification_id,jsonb_build_object('_id',notification_id,
      'clubId',p_club_id,'recipientId',target_id,'eventType','management_recovery','title','社团管理恢复请求',
      'summary','平台开发者邀请你确认新的社团管理团队。','targetType','management_recovery','targetId',new_id,'createdAt',now_text));
    RETURN jsonb_build_object('id',new_id,'status','recovery_requested','version',1,
      'expiresAt',request->>'expiresAt','targetUserId',target_id);
  END IF;
  IF p_action IN ('handovers.cancel','handovers.decline') THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('hg-governance:'||p_club_id||':members',0));
    SELECT doc INTO request FROM public.hg_management_requests WHERE id=request_id AND doc->>'clubId'=p_club_id
      AND doc->>'type'='handover' FOR UPDATE;
    IF request IS NULL OR request->>'status'<>'proposed' THEN RAISE EXCEPTION 'HANDOVER_NOT_FOUND'; END IF;
    expected:=NULLIF(p_input->>'expectedVersion','')::int;
    actual:=COALESCE(NULLIF(request->>'version','')::int,1);
    IF expected IS NULL OR actual<>expected THEN RAISE EXCEPTION 'VERSION_CONFLICT'; END IF;
    IF p_action='handovers.cancel' AND request->>'creatorId' IS DISTINCT FROM p_actor_id THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
    IF p_action='handovers.decline' AND request->>'targetUserId' IS DISTINCT FROM p_actor_id THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
    target_status:=CASE WHEN p_action='handovers.cancel' THEN 'cancelled' ELSE 'declined' END;
    request:=request||jsonb_build_object('status',target_status,'closedAt',now_text,'closedBy',p_actor_id,
      'closeReason',reason,'version',actual+1);
    UPDATE public.hg_management_requests SET doc=request WHERE id=request_id;
    PERFORM public.hg_admin_audit(p_club_id,p_actor_id,'management.handover.'||target_status,'management_request',request_id,
      reason,jsonb_build_object('status',target_status));
    RETURN jsonb_build_object('ok',true,'id',request_id,'status',target_status,'version',actual+1);
  END IF;
  IF p_action IN ('recovery.list','recovery.request') THEN
    PERFORM public.hg_require_developer(p_actor_id);
  ELSIF p_action IN ('handovers.list','handovers.create','team.get','team.primary','settings.get','settings.update',
      'invites.list','invites.create','invites.revoke','members.list','audit.list') THEN
    actor:=public.hg_require_club_membership(p_actor_id,p_club_id,ARRAY['moderator'],'update');
  ELSIF p_action='overview' THEN
    actor:=public.hg_require_club_membership(p_actor_id,p_club_id,ARRAY['admin','moderator'],'share');
  ELSE
    RAISE EXCEPTION 'INVALID';
  END IF;
  SELECT doc INTO club FROM public.hg_club_config WHERE id=p_club_id FOR SHARE;
  IF club IS NULL THEN RAISE EXCEPTION 'CLUB_NOT_FOUND'; END IF;
  current_term_id:=club->>'managementTermId';
  SELECT doc INTO term FROM public.hg_management_terms WHERE id=current_term_id AND doc->>'clubId'=p_club_id;
  IF p_action='overview' THEN
    SELECT jsonb_build_object('memberships',count(*) FILTER (WHERE doc->>'status'='pending'),
      'manualJoin',count(*) FILTER (WHERE doc->>'status'='pending' AND doc->>'admissionMethod'='manual_join'),
      'manualRestore',count(*) FILTER (WHERE doc->>'status'='pending' AND doc->>'admissionMethod'='manual_restore'))
      INTO result FROM public.hg_membership_applications WHERE doc->>'clubId'=p_club_id;
    SELECT public.hg_admin_request_dto(doc) INTO dto_item FROM public.hg_management_requests
      WHERE doc->>'clubId'=p_club_id AND doc->>'type'='handover' AND doc->>'status'='proposed'
      ORDER BY doc->>'createdAt' DESC,id DESC LIMIT 1;
    SELECT count(*) INTO pending_management FROM public.hg_management_requests
      WHERE doc->>'clubId'=p_club_id AND doc->>'type' IN ('handover','recovery')
        AND doc->>'status' IN ('proposed','recovery_requested')
        AND NULLIF(doc->>'expiresAt','')::timestamptz>clock_timestamp();
    SELECT COALESCE(name.doc->>'name','') INTO name FROM public.hg_club_config name WHERE name.id=p_club_id;
    SELECT count(*) FILTER(WHERE doc->>'status'='active'),
      count(*) FILTER(WHERE doc->>'status'='active' AND doc->>'role' IN ('admin','moderator'))
      INTO manager_count,term_member_count FROM public.hg_memberships WHERE doc->>'clubId'=p_club_id;
    RETURN jsonb_build_object('club',jsonb_build_object('id',p_club_id,'name',COALESCE(name,''),
      'status',COALESCE(club->>'status','active'),'version',COALESCE(NULLIF(club->>'managementVersion','')::int,1),
      'rulesVersion',COALESCE(club->>'rulesVersion','v1.0')),
      'pending',(COALESCE(result,'{"memberships":0,"manualJoin":0,"manualRestore":0}'::jsonb)
        ||jsonb_build_object('handovers',pending_management)),
      'activeMembers',manager_count,'term',jsonb_build_object('id',current_term_id,
        'version',COALESCE(NULLIF(term->>'version','')::int,1),'primaryUserId',term->>'primaryUserId',
        'startAt',term->>'startAt','endAt',term->>'endAt','memberCount',term_member_count),
      'pendingHandover',dto_item);
  END IF;
  IF p_action='members.list' THEN
    status_filter:=COALESCE(NULLIF(p_input->>'status',''),'all');
    cursor_value:=COALESCE(p_input->>'cursor','');
    page_limit:=COALESCE(NULLIF(p_input->>'limit','')::int,50);
    IF status_filter NOT IN ('all','active','removed','pending') OR page_limit<1 OR page_limit>100
      OR length(cursor_value)>512 THEN RAISE EXCEPTION 'INVALID'; END IF;
    WITH roster AS (
      SELECT m.doc->>'userId' AS user_id,
        COALESCE(p.doc->>'displayName',u.doc->>'displayName','') AS display_name,
        CASE WHEN p.doc IS NOT NULL THEN NULL ELSE m.doc->>'role' END AS role,
        CASE WHEN p.doc IS NOT NULL THEN 'pending' ELSE m.doc->>'status' END AS status,
        m.doc->'mutedUntil' AS muted_until,
        COALESCE(NULLIF(p.doc->>'version','')::int,NULLIF(m.doc->>'version','')::int,1) AS version,
        CASE WHEN p.doc IS NOT NULL THEN NULL ELSE m.doc->>'managementTermId' END AS management_term_id
      FROM public.hg_memberships m
      LEFT JOIN public.hg_users u ON u.id=m.doc->>'userId'
      LEFT JOIN LATERAL(SELECT a.doc FROM public.hg_membership_applications a
        WHERE a.doc->>'userId'=m.doc->>'userId' AND a.doc->>'clubId'=p_club_id AND a.doc->>'status'='pending'
        ORDER BY a.doc->>'createdAt' DESC,a.id DESC LIMIT 1) p ON true
      WHERE m.doc->>'clubId'=p_club_id
      UNION ALL
      SELECT a.doc->>'userId',COALESCE(a.doc->>'displayName',u.doc->>'displayName',''),NULL,'pending',NULL,
        COALESCE(NULLIF(a.doc->>'version','')::int,1),NULL
      FROM public.hg_membership_applications a LEFT JOIN public.hg_users u ON u.id=a.doc->>'userId'
      WHERE a.doc->>'clubId'=p_club_id AND a.doc->>'status'='pending'
        AND NOT EXISTS(SELECT 1 FROM public.hg_memberships m WHERE m.doc->>'userId'=a.doc->>'userId'
          AND m.doc->>'clubId'=p_club_id)
    ), numbered AS (
      SELECT *,row_number() OVER(ORDER BY user_id) AS rn FROM roster
      WHERE user_id>cursor_value AND (status_filter='all' OR status=status_filter)
    ), page AS (SELECT * FROM numbered WHERE rn<=page_limit+1)
    SELECT COALESCE(jsonb_agg(jsonb_build_object('targetUserId',user_id,'displayName',display_name,'role',role,
        'status',status,'mutedUntil',muted_until,'version',version,'managementTermId',management_term_id)
        ORDER BY user_id) FILTER(WHERE rn<=page_limit),'[]'::jsonb),
      max(user_id) FILTER(WHERE rn=page_limit),count(*)>page_limit
      INTO items,next_cursor,has_more FROM page;
    RETURN jsonb_build_object('items',items,'nextCursor',CASE WHEN has_more THEN next_cursor ELSE NULL END);
  END IF;
  IF p_action='invites.list' THEN
    status_filter:=COALESCE(NULLIF(p_input->>'status',''),'all'); cursor_value:=COALESCE(p_input->>'cursor','');
    page_limit:=COALESCE(NULLIF(p_input->>'limit','')::int,50);
    IF status_filter NOT IN ('all','active','exhausted','expired','revoked') OR page_limit<1 OR page_limit>100 THEN RAISE EXCEPTION 'INVALID'; END IF;
    WITH rows AS (
      SELECT i.id,i.doc,public.hg_admin_invite_status(i.doc) AS status,
        row_number() OVER(ORDER BY i.id) AS rn FROM public.hg_invite_codes i
      WHERE i.doc->>'clubId'=p_club_id AND i.id>cursor_value
        AND (status_filter='all' OR public.hg_admin_invite_status(i.doc)=status_filter)
    ), page AS (SELECT * FROM rows WHERE rn<=page_limit+1)
    SELECT COALESCE(jsonb_agg(jsonb_build_object('inviteId',id,'mode',doc->>'mode','status',status,
        'maxUses',NULLIF(doc->>'maxUses','')::int,'usedCount',COALESCE(NULLIF(doc->>'usedCount','')::int,0),
        'reservedCount',COALESCE(NULLIF(doc->>'reservedCount','')::int,0),'expiresAt',doc->>'expiresAt',
        'version',COALESCE(NULLIF(doc->>'version','')::int,1),'createdAt',doc->>'createdAt','revokedAt',doc->>'revokedAt',
        'targetUserId',doc->>'targetUserId') ORDER BY id) FILTER(WHERE rn<=page_limit),'[]'::jsonb),
      max(id) FILTER(WHERE rn=page_limit),count(*)>page_limit INTO items,next_cursor,has_more FROM page;
    RETURN jsonb_build_object('items',items,'nextCursor',CASE WHEN has_more THEN next_cursor ELSE NULL END);
  END IF;
  IF p_action='invites.create' THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('hg-governance:'||p_club_id||':members',0));
    SELECT doc INTO club FROM public.hg_club_config WHERE id=p_club_id FOR UPDATE;
    IF club IS NULL THEN RAISE EXCEPTION 'CLUB_NOT_FOUND'; END IF;
    IF COALESCE(club->>'status','active')<>'active' THEN RAISE EXCEPTION 'CLUB_PAUSED'; END IF;
    mode:=p_input->>'mode'; code_hash:=lower(COALESCE(p_input->>'codeHash',''));
    max_uses:=NULLIF(p_input->>'maxUses','')::int; ttl_seconds:=NULLIF(p_input->>'ttlSeconds','')::int;
    target_id:=NULLIF(p_input->>'targetUserId','');
    IF char_length(reason)<10 OR char_length(reason)>500 OR code_hash !~ '^[0-9a-f]{64}$'
      OR mode NOT IN ('application','direct') OR max_uses IS NULL OR max_uses<1 OR max_uses>10000
      OR ttl_seconds IS NULL OR ttl_seconds<60 OR ttl_seconds>7776000 THEN RAISE EXCEPTION 'INVALID'; END IF;
    IF mode='direct' AND (max_uses<>1 OR target_id IS NULL) THEN RAISE EXCEPTION 'INVALID'; END IF;
    IF mode='application' AND target_id IS NOT NULL THEN RAISE EXCEPTION 'INVALID'; END IF;
    IF target_id IS NOT NULL THEN
      PERFORM 1 FROM public.hg_users WHERE id=target_id AND doc->>'status'='active' FOR SHARE;
      IF NOT FOUND THEN RAISE EXCEPTION 'TARGET_USER_INVALID'; END IF;
    END IF;
    new_id:='invite:'||gen_random_uuid()::text;
    expires_at:=to_char((clock_timestamp()+make_interval(secs=>ttl_seconds)) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
    invite:=jsonb_build_object('_id',new_id,'clubId',p_club_id,'codeHash',code_hash,'mode',mode,
      'targetUserId',target_id,'rulesVersion',COALESCE(NULLIF(club->>'rulesVersion',''),'v1.0'),
      'issuedManagementTermId',current_term_id,'maxUses',max_uses,'usedCount',0,'reservedCount',0,
      'expiresAt',expires_at,'version',1,'createdBy',p_actor_id,'reason',reason,'createdAt',now_text,'updatedAt',now_text);
    INSERT INTO public.hg_invite_codes(id,doc) VALUES(new_id,invite);
    PERFORM public.hg_admin_audit(p_club_id,p_actor_id,'invite.create','invite',new_id,reason,
      jsonb_build_object('mode',mode,'maxUses',max_uses,'expiresAt',expires_at));
    RETURN jsonb_build_object('inviteId',new_id,'mode',mode,'status','active','maxUses',max_uses,
      'usedCount',0,'reservedCount',0,'expiresAt',expires_at,'version',1,'createdAt',now_text,'targetUserId',target_id);
  END IF;
  IF p_action='invites.revoke' THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('hg-governance:'||p_club_id||':members',0));
    expected:=NULLIF(p_input->>'expectedVersion','')::int;
    SELECT doc INTO invite FROM public.hg_invite_codes WHERE id=p_input->>'id' AND doc->>'clubId'=p_club_id FOR UPDATE;
    IF invite IS NULL THEN RAISE EXCEPTION 'INVITE_NOT_FOUND'; END IF;
    IF expected IS NULL OR expected<>COALESCE(NULLIF(invite->>'version','')::int,1)
      OR NULLIF(invite->>'revokedAt','') IS NOT NULL THEN RAISE EXCEPTION 'VERSION_CONFLICT'; END IF;
    IF char_length(reason)<10 OR char_length(reason)>500 THEN RAISE EXCEPTION 'REASON_REQUIRED'; END IF;
    invite:=invite||jsonb_build_object('revokedAt',now_text,'revokeReason',reason,
      'revokedBy',p_actor_id,'version',expected+1,'updatedAt',now_text);
    UPDATE public.hg_invite_codes SET doc=invite WHERE id=p_input->>'id';
    PERFORM public.hg_admin_audit(p_club_id,p_actor_id,'invite.revoke','invite',p_input->>'id',reason,
      jsonb_build_object('version',expected+1));
    RETURN jsonb_build_object('inviteId',p_input->>'id','status','revoked','version',expected+1,'revokedAt',now_text);
  END IF;
  IF p_action='settings.get' THEN
    RETURN jsonb_build_object('clubId',p_club_id,'description',COALESCE(club->>'description',''),
      'charter',COALESCE(club->>'charter',''),'admissionMode',COALESCE(club->>'admissionMode','invite_required'),
      'rulesVersion',COALESCE(club->>'rulesVersion','v1.0'),'version',COALESCE(NULLIF(club->>'settingsVersion','')::int,1));
  END IF;
  IF p_action='settings.update' THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('hg-governance:'||p_club_id||':members',0));
    SELECT doc INTO club FROM public.hg_club_config WHERE id=p_club_id FOR UPDATE;
    IF club IS NULL THEN RAISE EXCEPTION 'CLUB_NOT_FOUND'; END IF;
    expected:=NULLIF(p_input->>'expectedVersion','')::int;
    actual:=COALESCE(NULLIF(club->>'settingsVersion','')::int,1);
    IF expected IS NULL OR expected<>actual THEN RAISE EXCEPTION 'VERSION_CONFLICT'; END IF;
    changes:=p_input-'expectedVersion'-'reason';
    IF jsonb_typeof(changes)<>'object' OR changes='{}'::jsonb OR EXISTS(
      SELECT 1 FROM jsonb_object_keys(changes) key WHERE key NOT IN ('description','charter','admissionMode')) THEN RAISE EXCEPTION 'INVALID'; END IF;
    IF char_length(reason)<10 OR char_length(reason)>500 THEN RAISE EXCEPTION 'REASON_REQUIRED'; END IF;
    IF changes ? 'description' AND (jsonb_typeof(changes->'description')<>'string'
      OR char_length(changes->>'description')>300) THEN RAISE EXCEPTION 'INVALID'; END IF;
    IF changes ? 'charter' AND (jsonb_typeof(changes->'charter')<>'string'
      OR char_length(changes->>'charter')>5000) THEN RAISE EXCEPTION 'INVALID'; END IF;
    IF changes ? 'admissionMode' AND changes->>'admissionMode' NOT IN ('invite_required','closed') THEN RAISE EXCEPTION 'INVALID'; END IF;
    current_rules:=COALESCE(NULLIF(club->>'rulesVersion',''),'v1.0');
    next_rules:=current_rules;
    IF (changes ? 'charter' AND changes->>'charter' IS DISTINCT FROM COALESCE(club->>'charter',''))
      OR (changes ? 'admissionMode' AND changes->>'admissionMode' IS DISTINCT FROM COALESCE(club->>'admissionMode','invite_required')) THEN
      IF current_rules ~ '^v[0-9]+\.[0-9]+$' THEN
        next_rules:='v'||split_part(substr(current_rules,2),'.',1)||'.'||(split_part(current_rules,'.',2)::int+1)::text;
      ELSE next_rules:='v1.1'; END IF;
    END IF;
    club:=club||changes||jsonb_build_object('settingsVersion',actual+1,'rulesVersion',next_rules,'updatedAt',now_text);
    UPDATE public.hg_club_config SET doc=club WHERE id=p_club_id;
    PERFORM public.hg_admin_audit(p_club_id,p_actor_id,'settings.update','club',p_club_id,reason,
      jsonb_build_object('changedFields',to_jsonb(ARRAY(SELECT jsonb_object_keys(changes))),'rulesVersion',next_rules));
    RETURN jsonb_build_object('clubId',p_club_id,'description',COALESCE(club->>'description',''),
      'charter',COALESCE(club->>'charter',''),'admissionMode',COALESCE(club->>'admissionMode','invite_required'),
      'rulesVersion',next_rules,'version',actual+1);
  END IF;
  IF p_action='team.get' THEN
    SELECT COALESCE(jsonb_agg(jsonb_build_object('targetUserId',m.doc->>'userId','displayName',COALESCE(u.doc->>'displayName',''),
        'role',m.doc->>'role','status',m.doc->>'status','version',COALESCE(NULLIF(m.doc->>'version','')::int,1))
        ORDER BY m.doc->>'userId'),'[]'::jsonb) INTO items
      FROM public.hg_memberships m LEFT JOIN public.hg_users u ON u.id=m.doc->>'userId'
      WHERE m.doc->>'clubId'=p_club_id AND m.doc->>'status'='active' AND m.doc->>'role' IN ('admin','moderator');
    SELECT public.hg_admin_request_dto(doc) INTO dto_item FROM public.hg_management_requests
      WHERE doc->>'clubId'=p_club_id AND doc->>'type'='handover' AND doc->>'status'='proposed'
      ORDER BY doc->>'createdAt' DESC,id DESC LIMIT 1;
    RETURN jsonb_build_object('term',jsonb_build_object('id',current_term_id,'version',COALESCE(NULLIF(term->>'version','')::int,1),
      'primaryUserId',term->>'primaryUserId','startAt',term->>'startAt','endAt',term->>'endAt'),
      'members',items,'pendingHandover',dto_item);
  END IF;
  IF p_action='team.primary' THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('hg-governance:'||p_club_id||':members',0));
    SELECT doc INTO club FROM public.hg_club_config WHERE id=p_club_id FOR UPDATE;
    current_term_id:=club->>'managementTermId';
    SELECT doc INTO term FROM public.hg_management_terms WHERE id=current_term_id FOR UPDATE;
    IF term IS NULL THEN RAISE EXCEPTION 'MANAGEMENT_TERM_NOT_FOUND'; END IF;
    IF NULLIF(term->>'primaryUserId','') IS NOT NULL THEN RAISE EXCEPTION 'PRIMARY_ALREADY_SET'; END IF;
    expected:=NULLIF(p_input->>'expectedVersion','')::int;
    IF expected IS NULL OR expected<>COALESCE(NULLIF(term->>'version','')::int,1) THEN RAISE EXCEPTION 'VERSION_CONFLICT'; END IF;
    target_id:=p_input->>'targetUserId'; member_version:=NULLIF(p_input->>'expectedMembershipVersion','')::int;
    SELECT doc INTO member FROM public.hg_memberships WHERE doc->>'userId'=target_id AND doc->>'clubId'=p_club_id
      AND doc->>'status'='active' AND doc->>'role'='moderator' FOR UPDATE;
    IF member IS NULL THEN RAISE EXCEPTION 'TARGET_MEMBERSHIP_INACTIVE'; END IF;
    IF member_version IS NULL OR member_version<>COALESCE(NULLIF(member->>'version','')::int,1) THEN RAISE EXCEPTION 'VERSION_CONFLICT'; END IF;
    reason:=COALESCE(NULLIF(reason,''),'显式初始化本届负责人');
    term:=term||jsonb_build_object('primaryUserId',target_id,'version',expected+1,'primarySetAt',now_text,'primarySetBy',p_actor_id);
    UPDATE public.hg_management_terms SET doc=term WHERE id=current_term_id;
    club:=club||jsonb_build_object('moderatorUserId',target_id,'managementVersion',COALESCE(NULLIF(club->>'managementVersion','')::int,1)+1);
    UPDATE public.hg_club_config SET doc=club WHERE id=p_club_id;
    PERFORM public.hg_admin_audit(p_club_id,p_actor_id,'management.primary.bootstrap','membership',target_id,reason,
      jsonb_build_object('termId',current_term_id,'version',expected+1));
    RETURN jsonb_build_object('ok',true,'primaryUserId',target_id,'termId',current_term_id,'version',expected+1);
  END IF;
  IF p_action='handovers.list' THEN
    status_filter:=COALESCE(NULLIF(p_input->>'status',''),'all');
    cursor_value:=COALESCE(p_input->>'cursor','');
    page_limit:=COALESCE(NULLIF(p_input->>'limit','')::int,50);
    IF status_filter NOT IN ('all','proposed','completed','cancelled','declined','expired','stale')
      OR page_limit<1 OR page_limit>100 OR length(cursor_value)>512 THEN RAISE EXCEPTION 'INVALID'; END IF;
    IF cursor_value<>'' THEN
      BEGIN
        decoded_cursor:=convert_from(decode(cursor_value,'hex'),'UTF8');
        cursor_time:=split_part(decoded_cursor,E'\n',1);
        cursor_id:=substr(decoded_cursor,length(cursor_time)+2);
        IF cursor_time='' OR cursor_id='' THEN RAISE EXCEPTION 'INVALID'; END IF;
      EXCEPTION WHEN others THEN RAISE EXCEPTION 'INVALID'; END;
    END IF;
    WITH rows AS (
      SELECT id,doc,row_number() OVER(ORDER BY doc->>'createdAt' DESC,id DESC) AS rn
      FROM public.hg_management_requests
      WHERE doc->>'clubId'=p_club_id AND doc->>'type'='handover'
        AND (status_filter='all' OR doc->>'status'=status_filter)
        AND (cursor_value='' OR doc->>'createdAt'<cursor_time OR (doc->>'createdAt'=cursor_time AND id<cursor_id))
    ), page AS (SELECT * FROM rows WHERE rn<=page_limit+1)
    SELECT COALESCE(jsonb_agg(public.hg_admin_request_dto(doc) ORDER BY doc->>'createdAt' DESC,id DESC)
        FILTER(WHERE rn<=page_limit),'[]'::jsonb),
      (SELECT encode(convert_to(last.doc->>'createdAt'||E'\n'||last.id,'UTF8'),'hex')
        FROM page last WHERE last.rn=page_limit),
      count(*)>page_limit INTO items,next_cursor,has_more FROM page;
    RETURN jsonb_build_object('items',COALESCE(items,'[]'::jsonb),
      'nextCursor',CASE WHEN has_more THEN next_cursor ELSE NULL END);
  END IF;
  IF p_action='handovers.create' THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('hg-governance:'||p_club_id||':members',0));
    SELECT doc INTO club FROM public.hg_club_config WHERE id=p_club_id FOR UPDATE;
    IF club IS NULL THEN RAISE EXCEPTION 'CLUB_NOT_FOUND'; END IF;
    IF COALESCE(club->>'status','active')<>'active' THEN RAISE EXCEPTION 'CLUB_PAUSED'; END IF;
    current_term_id:=club->>'managementTermId';
    SELECT doc INTO term FROM public.hg_management_terms WHERE id=current_term_id FOR UPDATE;
    IF term IS NULL THEN RAISE EXCEPTION 'MANAGEMENT_TERM_NOT_FOUND'; END IF;
    IF NULLIF(term->>'primaryUserId','') IS NULL THEN RAISE EXCEPTION 'PRIMARY_REQUIRED'; END IF;
    IF term->>'primaryUserId' IS DISTINCT FROM p_actor_id THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
    expected:=NULLIF(p_input->>'expectedVersion','')::int;
    IF expected IS NULL OR expected<>COALESCE(NULLIF(term->>'version','')::int,1) THEN RAISE EXCEPTION 'VERSION_CONFLICT'; END IF;
    target_id:=p_input->>'targetUserId'; team:=p_input->'team'; reason:=btrim(COALESCE(p_input->>'reason',''));
    IF char_length(reason)<10 OR char_length(reason)>500 OR jsonb_typeof(team)<>'array' OR jsonb_array_length(team)<1
      OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(team) person WHERE person->>'targetUserId'=target_id AND person->>'role'='moderator')
      OR EXISTS(SELECT 1 FROM jsonb_array_elements(team) person WHERE person->>'role' NOT IN ('admin','moderator')
        OR NULLIF(person->>'targetUserId','') IS NULL)
      OR (SELECT count(*) FROM jsonb_array_elements(team))<>(SELECT count(DISTINCT person->>'targetUserId') FROM jsonb_array_elements(team) person)
      THEN RAISE EXCEPTION 'TEAM_INVALID'; END IF;
    IF EXISTS(SELECT 1 FROM public.hg_management_requests WHERE doc->>'clubId'=p_club_id
      AND doc->>'status' IN ('proposed','recovery_requested') AND NULLIF(doc->>'expiresAt','')::timestamptz>clock_timestamp()) THEN
      RAISE EXCEPTION 'HANDOVER_PENDING'; END IF;
    UPDATE public.hg_management_requests SET doc=doc||jsonb_build_object('status','expired','expiredAt',now_text,
      'version',COALESCE(NULLIF(doc->>'version','')::int,1)+1)
      WHERE doc->>'clubId'=p_club_id AND doc->>'status' IN ('proposed','recovery_requested')
        AND NULLIF(doc->>'expiresAt','')::timestamptz<=clock_timestamp();
    FOR team_member IN SELECT value FROM jsonb_array_elements(team) LOOP
      SELECT doc INTO member FROM public.hg_memberships WHERE doc->>'userId'=team_member->>'targetUserId'
        AND doc->>'clubId'=p_club_id FOR UPDATE;
      IF member IS NULL OR member->>'status'<>'active' OR NULLIF(team_member->>'expectedVersion','') IS NULL
        OR NULLIF(team_member->>'expectedVersion','')::int IS DISTINCT FROM COALESCE(NULLIF(member->>'version','')::int,1) THEN
        RAISE EXCEPTION 'VERSION_CONFLICT'; END IF;
    END LOOP;
    SELECT COALESCE(jsonb_agg(jsonb_build_object('targetUserId',m.doc->>'userId','role',m.doc->>'role',
      'version',COALESCE(NULLIF(m.doc->>'version','')::int,1)) ORDER BY m.doc->>'userId'),'[]'::jsonb) INTO base_team
      FROM public.hg_memberships m WHERE m.doc->>'clubId'=p_club_id AND m.doc->>'status'='active'
        AND m.doc->>'role' IN ('admin','moderator');
    target_id:=p_input->>'targetUserId';
    IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(team) person WHERE person->>'targetUserId'=target_id AND person->>'role'='moderator')
      THEN RAISE EXCEPTION 'TEAM_INVALID'; END IF;
    new_id:='handover:'||gen_random_uuid()::text;
    team:=COALESCE(team,'[]'::jsonb);
    IF COALESCE(p_input->'retainInviteIds','[]'::jsonb) IS NULL OR jsonb_typeof(COALESCE(p_input->'retainInviteIds','[]'::jsonb))<>'array' THEN RAISE EXCEPTION 'INVALID'; END IF;
    IF EXISTS(SELECT 1 FROM jsonb_array_elements_text(COALESCE(p_input->'retainInviteIds','[]'::jsonb)) retained
      WHERE NOT EXISTS(SELECT 1 FROM public.hg_invite_codes i WHERE i.id=retained AND i.doc->>'clubId'=p_club_id
        AND i.doc->>'issuedManagementTermId'=current_term_id AND i.doc->>'mode'='application'
        AND public.hg_admin_invite_status(i.doc)='active')) THEN RAISE EXCEPTION 'INVITE_NOT_FOUND'; END IF;
    expires_at:=to_char((clock_timestamp()+interval '7 days') AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
    request:=jsonb_build_object('_id',new_id,'clubId',p_club_id,'type','handover','status','proposed',
      'creatorId',p_actor_id,'targetUserId',target_id,'primaryUserId',target_id,'team',team,'baseTeam',base_team,
      'baseTermId',current_term_id,'baseTermVersion',expected,'reason',reason,'version',1,
      'createdAt',now_text,'expiresAt',expires_at,'retainInviteIds',COALESCE(p_input->'retainInviteIds','[]'::jsonb),
      'termEndAt',p_input->'termEndAt');
    INSERT INTO public.hg_management_requests(id,doc) VALUES(new_id,request);
    PERFORM public.hg_admin_audit(p_club_id,p_actor_id,'management.handover.proposed','management_request',new_id,reason,
      jsonb_build_object('targetUserId',target_id,'baseTermId',current_term_id));
    notification_id:='notification:'||gen_random_uuid()::text;
    INSERT INTO public.hg_notifications(id,doc) VALUES(notification_id,jsonb_build_object('_id',notification_id,
      'clubId',p_club_id,'recipientId',target_id,'eventType','management_handover','title','新一届负责人交接请求',
      'summary','现任负责人邀请你确认新的社团管理团队。','targetType','handover','targetId',new_id,'createdAt',now_text));
    RETURN jsonb_build_object('id',new_id,'status','proposed','version',1,'expiresAt',expires_at,'targetUserId',target_id);
  END IF;
  IF p_action='audit.list' THEN
    page_limit:=COALESCE(NULLIF(p_input->>'limit','')::int,50);
    cursor_value:=COALESCE(p_input->>'cursor','');
    IF page_limit<1 OR page_limit>100 OR length(cursor_value)>512 THEN RAISE EXCEPTION 'INVALID'; END IF;
    IF cursor_value<>'' THEN
      BEGIN
        decoded_cursor:=convert_from(decode(cursor_value,'hex'),'UTF8');
        cursor_time:=split_part(decoded_cursor,E'\n',1);
        cursor_id:=substr(decoded_cursor,length(cursor_time)+2);
        IF cursor_time='' OR cursor_id='' THEN RAISE EXCEPTION 'INVALID'; END IF;
      EXCEPTION WHEN others THEN RAISE EXCEPTION 'INVALID'; END;
    END IF;
    WITH rows AS (
      SELECT id,doc,row_number() OVER(ORDER BY doc->>'createdAt' DESC,id DESC) AS rn
      FROM public.hg_audit_logs WHERE doc->>'clubId'=p_club_id
        AND (doc->>'scope'='club_management' OR doc->>'action' IN (
          'member.role','member.remove','member.mute','membership.approve','membership.reject','membership.expired'))
        AND (cursor_value='' OR doc->>'createdAt'<cursor_time OR (doc->>'createdAt'=cursor_time AND id<cursor_id))
    ), page AS (SELECT * FROM rows WHERE rn<=page_limit+1)
    SELECT COALESCE(jsonb_agg(jsonb_build_object('id',id,'actorId',doc->>'actorId','action',doc->>'action',
        'targetType',doc->>'targetType','targetId',doc->>'targetId','decision',doc->>'decision',
        'reason',doc->>'reason','extra',doc->'extra','createdAt',doc->>'createdAt') ORDER BY doc->>'createdAt' DESC,id DESC)
        FILTER(WHERE rn<=page_limit),'[]'::jsonb),
      (SELECT encode(convert_to(last.doc->>'createdAt'||E'\n'||last.id,'UTF8'),'hex') FROM page last WHERE last.rn=page_limit),
      count(*)>page_limit INTO items,next_cursor,has_more FROM page;
    RETURN jsonb_build_object('items',items,'nextCursor',CASE WHEN has_more THEN next_cursor ELSE NULL END);
  END IF;
  IF p_action='recovery.decline' THEN RAISE EXCEPTION 'INVALID'; END IF;
  RAISE EXCEPTION 'INVALID';
END $$;
REVOKE ALL ON FUNCTION public.hg_admin_management(text,text,jsonb,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.hg_admin_management(text,text,jsonb,text) TO service_role;

-- One initial term per club.  Only a moderatorUserId that already points at an
-- active moderator is treated as an explicit prior primary; otherwise primary is
-- NULL and the moderator must bootstrap it explicitly.
DO $$
DECLARE club record; term_id text; primary_id text; managers jsonb; stamp text;
BEGIN
  FOR club IN SELECT id,doc FROM public.hg_club_config LOOP
    term_id:=COALESCE(NULLIF(club.doc->>'managementTermId',''),'term:initial:'||club.id);
    primary_id:=NULLIF(club.doc->>'moderatorUserId','');
    IF primary_id IS NOT NULL AND NOT EXISTS(
      SELECT 1 FROM public.hg_memberships m WHERE m.doc->>'clubId'=club.id
        AND m.doc->>'userId'=primary_id AND m.doc->>'status'='active' AND m.doc->>'role'='moderator') THEN
      primary_id:=NULL;
    END IF;
    SELECT COALESCE(jsonb_agg(jsonb_build_object('targetUserId',m.doc->>'userId','role',m.doc->>'role',
      'status',m.doc->>'status','version',COALESCE(NULLIF(m.doc->>'version','')::int,1))
      ORDER BY m.doc->>'userId'),'[]'::jsonb) INTO managers
      FROM public.hg_memberships m WHERE m.doc->>'clubId'=club.id
        AND m.doc->>'status'='active' AND m.doc->>'role' IN ('admin','moderator');
    stamp:=COALESCE(NULLIF(club.doc->>'createdAt',''),to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
    INSERT INTO public.hg_management_terms(id,doc) VALUES(term_id,jsonb_build_object(
      '_id',term_id,'clubId',club.id,'version',1,'primaryUserId',primary_id,'members',managers,
      'status','active','startAt',stamp,'endAt',club.doc->'termEndAt','createdAt',stamp))
      ON CONFLICT(id) DO NOTHING;
    UPDATE public.hg_memberships SET doc=doc||jsonb_build_object('managementTermId',term_id)
      WHERE doc->>'clubId'=club.id AND doc->>'status'='active' AND doc->>'role' IN ('admin','moderator');
    UPDATE public.hg_club_config SET doc=(doc||jsonb_build_object(
      'managementTermId',term_id,'managementVersion',COALESCE(NULLIF(doc->>'managementVersion','')::int,1),
      'settingsVersion',COALESCE(NULLIF(doc->>'settingsVersion','')::int,1),
      'admissionMode',COALESCE(NULLIF(doc->>'admissionMode',''),'invite_required'),
      'rulesVersion',COALESCE(NULLIF(doc->>'rulesVersion',''),'v1.0')))
      -CASE WHEN primary_id IS NULL THEN 'moderatorUserId' ELSE '' END WHERE id=club.id;
  END LOOP;
END $$;

CREATE FUNCTION public.hg_management_term_reminders(p_now timestamptz DEFAULT clock_timestamp()) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE club_row record; term_row record; recipient record; threshold integer; marker text; remaining interval;
  notification_id text; summary text; inserted_count integer; sent_30 integer:=0; sent_7 integer:=0;
BEGIN
  IF p_now IS NULL THEN RAISE EXCEPTION 'INVALID'; END IF;
  FOR club_row IN SELECT DISTINCT c.id FROM public.hg_club_config c
    JOIN public.hg_management_terms t ON t.doc->>'clubId'=c.id
    WHERE COALESCE(c.doc->>'status','active')='active' AND t.doc->>'status'='active'
      AND NULLIF(t.doc->>'endAt','') IS NOT NULL AND (t.doc->>'endAt')::timestamptz>p_now
      AND (t.doc->>'endAt')::timestamptz<=p_now+interval '30 days' ORDER BY c.id LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended('hg-governance:'||club_row.id||':members',0));
    FOR term_row IN SELECT id,doc FROM public.hg_management_terms
      WHERE doc->>'clubId'=club_row.id AND doc->>'status'='active'
        AND NULLIF(doc->>'endAt','') IS NOT NULL ORDER BY id FOR UPDATE LOOP
      remaining:=(term_row.doc->>'endAt')::timestamptz-p_now;
      IF remaining<=interval '0' OR remaining>interval '30 days' THEN CONTINUE; END IF;
      FOREACH threshold IN ARRAY ARRAY[30,7] LOOP
        marker:='reminder'||threshold||'SentAt';
        IF remaining<=make_interval(days=>threshold) AND NULLIF(term_row.doc->>marker,'') IS NULL THEN
          FOR recipient IN SELECT m.doc->>'userId' AS user_id FROM public.hg_memberships m
            WHERE m.doc->>'clubId'=club_row.id AND m.doc->>'managementTermId'=term_row.id
              AND m.doc->>'status'='active' AND m.doc->>'role' IN ('admin','moderator')
            ORDER BY m.doc->>'userId' LOOP
            notification_id:='notification:term-reminder:'||md5(term_row.id||':'||threshold::text||':'||recipient.user_id);
            summary:=CASE WHEN threshold=30 THEN '本届管理任期将在30天后结束，请查看交接安排。'
              ELSE '本届管理任期将在7天后结束，请查看交接安排。' END;
            INSERT INTO public.hg_notifications(id,doc) VALUES(notification_id,jsonb_build_object('_id',notification_id,
              'clubId',club_row.id,'recipientId',recipient.user_id,'eventType','management_term_reminder',
              'title',CASE WHEN threshold=30 THEN '本届管理任期还有30天' ELSE '本届管理任期还有7天' END,
              'summary',summary,'targetType','management_term','targetId',term_row.id,
              'createdAt',to_char(p_now AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))) ON CONFLICT(id) DO NOTHING;
            GET DIAGNOSTICS inserted_count=ROW_COUNT;
            IF inserted_count>0 AND threshold=30 THEN sent_30:=sent_30+1; END IF;
            IF inserted_count>0 AND threshold=7 THEN sent_7:=sent_7+1; END IF;
          END LOOP;
          UPDATE public.hg_management_terms SET doc=doc||jsonb_build_object(marker,
            to_char(p_now AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) WHERE id=term_row.id;
          term_row.doc:=term_row.doc||jsonb_build_object(marker,to_char(p_now AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
        END IF;
      END LOOP;
    END LOOP;
  END LOOP;
  RETURN jsonb_build_object('sent30Day',sent_30,'sent7Day',sent_7);
END $$;
REVOKE ALL ON FUNCTION public.hg_management_term_reminders(timestamptz) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.hg_management_term_reminders(timestamptz) TO service_role;
