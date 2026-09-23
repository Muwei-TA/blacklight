-- One statement, with a rollback-only subtransaction: no fixture survives.
-- Apply 20260923000000_usage_quotas first. Run on the development environment.
DO $$
DECLARE
  club text := 'usage-regression-20260923';
  stamp text := to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  config jsonb := '{"userUploadDailyBytes":20971520,"clubUploadDailyBytes":4194304,"reviewDailyCalls":2,"warningRatio":0.5}';
  asset jsonb;
  got jsonb;
  first_result jsonb;
  n int;
BEGIN
  BEGIN
    INSERT INTO hg_club_config(id,doc) VALUES (club,jsonb_build_object('_id',club,'usageLimits',config));
    INSERT INTO hg_memberships(id,doc) VALUES
      (club||':mod',jsonb_build_object('_id',club||':mod','clubId',club,'userId',club||':mod','role','moderator','status','active')),
      (club||':member',jsonb_build_object('_id',club||':member','clubId',club,'userId',club||':member','role','member','status','active'));

    got := hg_usage_reserve_review_call(club,'text');
    IF got->>'allowed'<>'true' OR (got->>'calls')::int<>1 THEN RAISE EXCEPTION 'first review reservation failed'; END IF;
    got := hg_usage_reserve_review_call(club,'image');
    IF got->>'allowed'<>'true' OR (got->>'calls')::int<>2 THEN RAISE EXCEPTION 'second review reservation failed'; END IF;
    got := hg_usage_reserve_review_call(club,'text');
    IF got->>'allowed'<>'false' OR (got->>'calls')::int<>2 OR (got->>'nextAttemptAt')::timestamptz<=clock_timestamp() THEN
      RAISE EXCEPTION 'review quota did not retain next window';
    END IF;
    got := hg_usage_status(club);
    IF (got#>>'{review,textCalls}')::int<>1 OR (got#>>'{review,imageCalls}')::int<>1 THEN RAISE EXCEPTION 'review metering mismatch'; END IF;
    SELECT count(*) INTO n FROM hg_notifications WHERE doc->>'recipientId'=club||':mod';
    IF n<>1 THEN RAISE EXCEPTION 'review alert missing or duplicated'; END IF;
    IF EXISTS (SELECT 1 FROM hg_notifications WHERE doc->>'recipientId'=club||':member') THEN RAISE EXCEPTION 'usage alert leaked to member'; END IF;

    asset := jsonb_build_object('_id',club||':image1','ownerId',club||':owner1','clubId',club,
      'mediaType','image','declaredSize',100,'quotaBytes',2097152,'mimeType','image/png',
      'createdAt',stamp,'expiresAt',clock_timestamp()+interval '15 minutes','status','intent');
    first_result := hg_image_intent(club||':owner1',club,'usage-intent-key1',asset);
    got := hg_image_intent(club||':owner1',club,'usage-intent-key1',asset||jsonb_build_object('_id',club||':duplicate'));
    IF got IS DISTINCT FROM first_result THEN RAISE EXCEPTION 'intent replay changed result'; END IF;
    -- Old three-argument call must remain available during rolling deployment.
    got := hg_image_intent(club||':compat','usage-intent-compat',asset||jsonb_build_object('_id',club||':compat','ownerId',club||':compat'));
    IF got->>'assetId'<>club||':compat' THEN RAISE EXCEPTION 'legacy intent signature unavailable'; END IF;
    PERFORM hg_image_intent(club||':owner2',club,'usage-intent-key2',asset||jsonb_build_object('_id',club||':image2','ownerId',club||':owner2'));
    BEGIN
      PERFORM hg_image_intent(club||':owner3',club,'usage-intent-key3',asset||jsonb_build_object('_id',club||':image3','ownerId',club||':owner3'));
      RAISE EXCEPTION 'club quota bypassed';
    EXCEPTION WHEN raise_exception THEN
      IF SQLERRM<>'IMAGE_QUOTA' THEN RAISE; END IF;
    END;
    UPDATE hg_assets SET doc=doc||jsonb_build_object('expiresAt',clock_timestamp()-interval '1 minute','uploadLeaseUntil',clock_timestamp()+interval '1 minute') WHERE id=club||':image1';
    got := hg_usage_status(club);
    IF (got#>>'{upload,reservedBytes}')::bigint<>4194304 THEN RAISE EXCEPTION 'active uploading lease lost reservation'; END IF;
    UPDATE hg_assets SET doc=doc||jsonb_build_object('uploadLeaseUntil',NULL) WHERE id=club||':image1';
    PERFORM hg_image_intent(club||':owner3',club,'usage-intent-key3',asset||jsonb_build_object('_id',club||':image3','ownerId',club||':owner3'));
    UPDATE hg_assets SET doc=doc||jsonb_build_object('status','purged','quotaChargedAt',stamp,'fileId','','cleanedFileId','') WHERE id=club||':image2';
    got := hg_usage_status(club);
    IF (got#>>'{upload,usedBytes}')::bigint<>2097152 OR (got#>>'{upload,reservedBytes}')::bigint<>2097152 THEN
      RAISE EXCEPTION 'purging file reset daily charged bytes';
    END IF;

    UPDATE hg_club_config SET doc=jsonb_set(doc,'{usageLimits,reviewDailyCalls}','0') WHERE id=club;
    got := hg_usage_reserve_review_call(club,'text');
    IF got->>'allowed'<>'false' THEN RAISE EXCEPTION 'disabled review quota allowed call'; END IF;
    UPDATE hg_club_config SET doc=jsonb_set(doc,'{usageLimits,reviewDailyCalls}','"bad"') WHERE id=club;
    BEGIN
      PERFORM hg_usage_reserve_review_call(club,'text');
      RAISE EXCEPTION 'invalid config did not fail closed';
    EXCEPTION WHEN raise_exception THEN
      IF SQLERRM<>'USAGE_CONFIG' THEN RAISE; END IF;
    END;
    IF has_table_privilege('anon','public.hg_daily_usage','SELECT')
       OR has_table_privilege('authenticated','public.hg_daily_usage','UPDATE')
       OR has_function_privilege('anon','public.hg_usage_status(text)','EXECUTE')
       OR has_function_privilege('authenticated','public.hg_usage_reserve_review_call(text,text)','EXECUTE') THEN
      RAISE EXCEPTION 'client quota table or RPC privileges leaked';
    END IF;
    RAISE EXCEPTION USING ERRCODE='P0002',MESSAGE='usage-regression-rollback';
  EXCEPTION WHEN no_data_found THEN
    IF SQLERRM<>'usage-regression-rollback' THEN RAISE; END IF;
  END;
END $$;
