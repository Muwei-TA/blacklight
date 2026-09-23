-- T-B09: configurable daily upload/review limits, atomic accounting and alerts.
-- All counters are server-only. Upload bytes include active intent reservations so
-- concurrent intents cannot over-commit the club's daily capacity.

CREATE TABLE public.hg_daily_usage (
  club_id text NOT NULL,
  usage_date date NOT NULL,
  upload_bytes bigint NOT NULL DEFAULT 0 CHECK (upload_bytes >= 0),
  upload_reserved_bytes bigint NOT NULL DEFAULT 0 CHECK (upload_reserved_bytes >= 0),
  review_calls bigint NOT NULL DEFAULT 0 CHECK (review_calls >= 0),
  text_review_calls bigint NOT NULL DEFAULT 0 CHECK (text_review_calls >= 0),
  image_review_calls bigint NOT NULL DEFAULT 0 CHECK (image_review_calls >= 0),
  upload_daily_limit_bytes bigint NOT NULL DEFAULT 0 CHECK (upload_daily_limit_bytes >= 0),
  review_daily_limit_calls bigint NOT NULL DEFAULT 0 CHECK (review_daily_limit_calls >= 0),
  warning_ratio numeric NOT NULL DEFAULT 0 CHECK (warning_ratio >= 0 AND warning_ratio <= 1),
  upload_alert_state text NOT NULL DEFAULT 'ok'
    CHECK (upload_alert_state IN ('ok', 'near_limit', 'limit_reached', 'disabled')),
  review_alert_state text NOT NULL DEFAULT 'ok'
    CHECK (review_alert_state IN ('ok', 'near_limit', 'limit_reached', 'disabled')),
  upload_alerted_at timestamptz,
  review_alerted_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (club_id, usage_date)
);
ALTER TABLE public.hg_daily_usage ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.hg_daily_usage FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.hg_daily_usage TO service_role;

-- Preserve existing operator values; fill only missing values with conservative
-- development defaults. Production operators must set the limits for their club.
INSERT INTO public.hg_club_config (id, doc)
VALUES (
  'heiguang',
  jsonb_build_object(
    '_id', 'heiguang',
    'usageLimits', jsonb_build_object(
      'userUploadDailyBytes', 20971520,
      'clubUploadDailyBytes', 209715200,
      'reviewDailyCalls', 1000,
      'warningRatio', 0.8
    )
  )
)
ON CONFLICT (id) DO UPDATE SET doc = public.hg_club_config.doc || jsonb_build_object(
  'usageLimits', COALESCE(public.hg_club_config.doc->'usageLimits', '{}'::jsonb) || jsonb_build_object(
    'userUploadDailyBytes', COALESCE(public.hg_club_config.doc->'usageLimits'->'userUploadDailyBytes', to_jsonb(20971520::bigint)),
    'clubUploadDailyBytes', COALESCE(public.hg_club_config.doc->'usageLimits'->'clubUploadDailyBytes', to_jsonb(209715200::bigint)),
    'reviewDailyCalls', COALESCE(public.hg_club_config.doc->'usageLimits'->'reviewDailyCalls', to_jsonb(1000::bigint)),
    'warningRatio', COALESCE(public.hg_club_config.doc->'usageLimits'->'warningRatio', to_jsonb(0.8::numeric))
  )
);

CREATE INDEX IF NOT EXISTS hg_assets_club_created_idx
  ON public.hg_assets ((COALESCE(doc->>'clubId', 'heiguang')), (doc->>'createdAt'))
  WHERE doc->>'mediaType' = 'image';
UPDATE public.hg_assets
SET doc = doc || jsonb_build_object(
  'quotaChargedAt', COALESCE(NULLIF(doc->>'quotaChargedAt', ''), doc->>'createdAt')
)
WHERE doc->>'mediaType' = 'image'
  AND doc->>'status' <> 'intent'
  AND (COALESCE(doc->>'fileId', '') <> ''
    OR COALESCE(NULLIF(doc->>'actualSize', '')::bigint, 0) > 0
    OR COALESCE(NULLIF(doc->>'cleanedSize', '')::bigint, 0) > 0)
  AND NULLIF(doc->>'quotaChargedAt', '') IS NULL;

CREATE OR REPLACE FUNCTION public.hg_usage_limits(p_club_id text) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE club jsonb; limits jsonb; user_bytes numeric; club_bytes numeric; review_calls numeric; warning numeric;
BEGIN
  IF NULLIF(p_club_id, '') IS NULL THEN RAISE EXCEPTION 'USAGE_CONFIG'; END IF;
  SELECT doc INTO club FROM public.hg_club_config WHERE id = p_club_id;
  limits := club->'usageLimits';
  IF jsonb_typeof(limits) IS DISTINCT FROM 'object'
     OR jsonb_typeof(limits->'userUploadDailyBytes') IS DISTINCT FROM 'number'
     OR jsonb_typeof(limits->'clubUploadDailyBytes') IS DISTINCT FROM 'number'
     OR jsonb_typeof(limits->'reviewDailyCalls') IS DISTINCT FROM 'number'
     OR jsonb_typeof(limits->'warningRatio') IS DISTINCT FROM 'number' THEN
    RAISE EXCEPTION 'USAGE_CONFIG';
  END IF;
  user_bytes := (limits->>'userUploadDailyBytes')::numeric;
  club_bytes := (limits->>'clubUploadDailyBytes')::numeric;
  review_calls := (limits->>'reviewDailyCalls')::numeric;
  warning := (limits->>'warningRatio')::numeric;
  IF user_bytes < 0 OR user_bytes > 9223372036854775807 OR user_bytes <> trunc(user_bytes)
     OR club_bytes < 0 OR club_bytes > 9223372036854775807 OR club_bytes <> trunc(club_bytes)
     OR review_calls < 0 OR review_calls > 9223372036854775807 OR review_calls <> trunc(review_calls)
     OR warning < 0 OR warning > 1 THEN
    RAISE EXCEPTION 'USAGE_CONFIG';
  END IF;
  RETURN jsonb_build_object(
    'userUploadDailyBytes', user_bytes::bigint,
    'clubUploadDailyBytes', club_bytes::bigint,
    'reviewDailyCalls', review_calls::bigint,
    'warningRatio', warning
  );
EXCEPTION WHEN OTHERS THEN
  RAISE EXCEPTION 'USAGE_CONFIG';
END $$;

CREATE OR REPLACE FUNCTION public.hg_refresh_daily_usage(p_club_id text, p_usage_date date) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE limits jsonb; club_limit bigint; review_limit bigint; warning numeric;
  day_start timestamptz; day_end timestamptz; uploaded bigint; reserved bigint;
  review_total bigint := 0; text_total bigint := 0; image_total bigint := 0;
  upload_state text; review_state text; result jsonb;
BEGIN
  IF NULLIF(p_club_id, '') IS NULL OR p_usage_date IS NULL THEN RAISE EXCEPTION 'USAGE_CONFIG'; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('hg:usage:' || p_club_id || ':' || p_usage_date::text));
  limits := public.hg_usage_limits(p_club_id);
  club_limit := (limits->>'clubUploadDailyBytes')::bigint;
  review_limit := (limits->>'reviewDailyCalls')::bigint;
  warning := (limits->>'warningRatio')::numeric;
  day_start := p_usage_date::timestamp AT TIME ZONE 'UTC';
  day_end := (p_usage_date + 1)::timestamp AT TIME ZONE 'UTC';

  SELECT
    COALESCE(sum(COALESCE(NULLIF(doc->>'quotaBytes', '')::bigint, NULLIF(doc->>'declaredSize', '')::bigint, 0))
      FILTER (WHERE NULLIF(doc->>'quotaChargedAt', '') IS NOT NULL), 0)::bigint,
    COALESCE(sum(COALESCE(NULLIF(doc->>'quotaBytes', '')::bigint, NULLIF(doc->>'declaredSize', '')::bigint, 0))
      FILTER (WHERE doc->>'status' = 'intent' AND (
        NULLIF(doc->>'expiresAt', '')::timestamptz > clock_timestamp()
        OR NULLIF(doc->>'uploadLeaseUntil', '')::timestamptz > clock_timestamp()
        OR COALESCE(doc->>'reservedFileId', '') <> ''
      )), 0)::bigint
  INTO uploaded, reserved
  FROM public.hg_assets
  WHERE doc->>'mediaType' = 'image'
    AND COALESCE(doc->>'clubId', 'heiguang') = p_club_id
    AND NULLIF(doc->>'createdAt', '')::timestamptz >= day_start
    AND NULLIF(doc->>'createdAt', '')::timestamptz < day_end;

  SELECT review_calls, text_review_calls, image_review_calls
    INTO review_total, text_total, image_total
  FROM public.hg_daily_usage
  WHERE club_id = p_club_id AND usage_date = p_usage_date;
  review_total := COALESCE(review_total, 0);
  text_total := COALESCE(text_total, 0);
  image_total := COALESCE(image_total, 0);

  upload_state := CASE
    WHEN club_limit = 0 THEN 'disabled'
    WHEN uploaded + reserved >= club_limit THEN 'limit_reached'
    WHEN warning > 0 AND uploaded + reserved >= ceil(club_limit * warning) THEN 'near_limit'
    ELSE 'ok'
  END;
  review_state := CASE
    WHEN review_limit = 0 THEN 'disabled'
    WHEN review_total >= review_limit THEN 'limit_reached'
    WHEN warning > 0 AND review_total >= ceil(review_limit * warning) THEN 'near_limit'
    ELSE 'ok'
  END;

  INSERT INTO public.hg_daily_usage AS existing_usage (
    club_id, usage_date, upload_bytes, upload_reserved_bytes, review_calls,
    text_review_calls, image_review_calls, upload_daily_limit_bytes,
    review_daily_limit_calls, warning_ratio, upload_alert_state,
    review_alert_state, upload_alerted_at, updated_at
  ) VALUES (
    p_club_id, p_usage_date, uploaded, reserved, review_total,
    text_total, image_total, club_limit, review_limit, warning,
    upload_state, review_state,
    CASE WHEN upload_state IN ('near_limit', 'limit_reached') THEN clock_timestamp() ELSE NULL END,
    clock_timestamp()
  )
  ON CONFLICT (club_id, usage_date) DO UPDATE SET
    upload_bytes = EXCLUDED.upload_bytes,
    upload_reserved_bytes = EXCLUDED.upload_reserved_bytes,
    upload_daily_limit_bytes = EXCLUDED.upload_daily_limit_bytes,
    review_daily_limit_calls = EXCLUDED.review_daily_limit_calls,
    warning_ratio = EXCLUDED.warning_ratio,
    upload_alert_state = EXCLUDED.upload_alert_state,
    review_alert_state = EXCLUDED.review_alert_state,
    upload_alerted_at = CASE
      WHEN EXCLUDED.upload_alert_state IN ('near_limit', 'limit_reached')
        THEN COALESCE(existing_usage.upload_alerted_at, clock_timestamp())
      ELSE existing_usage.upload_alerted_at
    END,
    updated_at = clock_timestamp();

  SELECT jsonb_build_object(
    'date', p_usage_date::text,
    'uploadBytes', uploaded,
    'uploadReservedBytes', reserved,
    'uploadDailyLimitBytes', club_limit,
    'uploadAlertState', upload_state,
    'reviewCalls', review_total,
    'textReviewCalls', text_total,
    'imageReviewCalls', image_total,
    'reviewDailyLimitCalls', review_limit,
    'reviewAlertState', review_state,
    'warningRatio', warning,
    'updatedAt', clock_timestamp()
  ) INTO result;
  RETURN result;
END $$;

CREATE OR REPLACE FUNCTION public.hg_notify_review_usage_alert(
  p_club_id text, p_usage_date date, p_calls bigint, p_limit bigint
) RETURNS void
LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE membership jsonb; recipient_id text; notification_id text; notification_title text;
  notification_summary text; stamp text; target_id text;
BEGIN
  stamp := to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  target_id := p_club_id || ':' || p_usage_date::text || ':review';
  notification_title := CASE WHEN p_calls >= p_limit THEN '审核调用配额已用尽' ELSE '审核调用配额预警' END;
  notification_summary := format('今日审核调用 %s / %s，已达到配置阈值。', p_calls, p_limit);
  FOR membership IN
    SELECT doc FROM public.hg_memberships
    WHERE doc->>'clubId' = p_club_id AND doc->>'status' = 'active'
      AND doc->>'role' IN ('admin', 'moderator')
  LOOP
    recipient_id := membership->>'userId';
    IF NULLIF(recipient_id, '') IS NULL THEN CONTINUE; END IF;
    notification_id := 'usage-alert:' || md5(p_club_id || ':' || p_usage_date::text || ':review:' || recipient_id);
    INSERT INTO public.hg_notifications (id, doc) VALUES (
      notification_id,
      jsonb_build_object(
        '_id', notification_id, 'recipientId', recipient_id,
        'eventType', 'system_notice', 'title', notification_title,
        'summary', notification_summary, 'targetType', 'usage',
        'targetId', target_id, 'icon', 'warning', 'createdAt', stamp
      )
    ) ON CONFLICT (id) DO NOTHING;
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION public.hg_maybe_alert_review_usage(
  p_club_id text, p_usage_date date, p_calls bigint, p_limit bigint, p_warning_ratio numeric
) RETURNS void
LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE threshold bigint; already_alerted timestamptz;
BEGIN
  IF p_limit <= 0 THEN RETURN; END IF;
  threshold := CASE WHEN p_warning_ratio > 0 THEN ceil(p_limit * p_warning_ratio)::bigint ELSE p_limit END;
  IF p_calls < threshold THEN RETURN; END IF;
  SELECT review_alerted_at INTO already_alerted
  FROM public.hg_daily_usage
  WHERE club_id = p_club_id AND usage_date = p_usage_date
  FOR UPDATE;
  IF already_alerted IS NOT NULL THEN RETURN; END IF;
  UPDATE public.hg_daily_usage
  SET review_alerted_at = clock_timestamp(),
      review_alert_state = CASE WHEN p_calls >= p_limit THEN 'limit_reached' ELSE 'near_limit' END,
      updated_at = clock_timestamp()
  WHERE club_id = p_club_id AND usage_date = p_usage_date;
  PERFORM public.hg_notify_review_usage_alert(p_club_id, p_usage_date, p_calls, p_limit);
END $$;

CREATE OR REPLACE FUNCTION public.hg_usage_status(p_club_id text) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE v_usage_date date; limits jsonb; summary jsonb; row_usage public.hg_daily_usage%ROWTYPE;
  club_limit bigint; review_limit bigint; user_limit bigint; warning numeric;
BEGIN
  IF NULLIF(p_club_id, '') IS NULL THEN RAISE EXCEPTION 'USAGE_CONFIG'; END IF;
  v_usage_date := (clock_timestamp() AT TIME ZONE 'UTC')::date;
  PERFORM pg_advisory_xact_lock(hashtext('hg:usage:' || p_club_id || ':' || v_usage_date::text));
  limits := public.hg_usage_limits(p_club_id);
  summary := public.hg_refresh_daily_usage(p_club_id, v_usage_date);
  club_limit := (limits->>'clubUploadDailyBytes')::bigint;
  review_limit := (limits->>'reviewDailyCalls')::bigint;
  user_limit := (limits->>'userUploadDailyBytes')::bigint;
  warning := (limits->>'warningRatio')::numeric;
  SELECT * INTO row_usage FROM public.hg_daily_usage
  WHERE club_id = p_club_id AND public.hg_daily_usage.usage_date = v_usage_date
  FOR UPDATE;
  PERFORM public.hg_maybe_alert_review_usage(p_club_id, v_usage_date, row_usage.review_calls, review_limit, warning);
  SELECT * INTO row_usage FROM public.hg_daily_usage
  WHERE club_id = p_club_id AND public.hg_daily_usage.usage_date = v_usage_date;
  RETURN jsonb_build_object(
    'date', v_usage_date::text,
    'timezone', 'UTC',
    'upload', jsonb_build_object(
      'usedBytes', row_usage.upload_bytes,
      'reservedBytes', row_usage.upload_reserved_bytes,
      'dailyLimitBytes', club_limit,
      'userDailyLimitBytes', user_limit,
      'remainingBytes', greatest(club_limit - row_usage.upload_bytes - row_usage.upload_reserved_bytes, 0),
      'warningRatio', warning,
      'alertState', row_usage.upload_alert_state,
      'alertedAt', row_usage.upload_alerted_at
    ),
    'review', jsonb_build_object(
      'calls', row_usage.review_calls,
      'textCalls', row_usage.text_review_calls,
      'imageCalls', row_usage.image_review_calls,
      'dailyLimitCalls', review_limit,
      'remainingCalls', greatest(review_limit - row_usage.review_calls, 0),
      'warningRatio', warning,
      'alertState', row_usage.review_alert_state,
      'alertedAt', row_usage.review_alerted_at
    ),
    'updatedAt', row_usage.updated_at
  );
END $$;

CREATE OR REPLACE FUNCTION public.hg_usage_reserve_review_call(p_club_id text, p_kind text) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE v_usage_date date; limits jsonb; review_limit bigint; warning numeric; current_calls bigint;
  next_window timestamptz; alert_state text;
BEGIN
  IF p_kind IS NULL OR p_kind NOT IN ('text', 'image') THEN RAISE EXCEPTION 'USAGE_CONFIG'; END IF;
  IF NULLIF(p_club_id, '') IS NULL THEN RAISE EXCEPTION 'USAGE_CONFIG'; END IF;
  v_usage_date := (clock_timestamp() AT TIME ZONE 'UTC')::date;
  next_window := (v_usage_date + 1)::timestamp AT TIME ZONE 'UTC';
  PERFORM pg_advisory_xact_lock(hashtext('hg:usage:' || p_club_id || ':' || v_usage_date::text));
  limits := public.hg_usage_limits(p_club_id);
  review_limit := (limits->>'reviewDailyCalls')::bigint;
  warning := (limits->>'warningRatio')::numeric;
  INSERT INTO public.hg_daily_usage (
    club_id, usage_date, review_calls, text_review_calls, image_review_calls,
    review_daily_limit_calls, warning_ratio, review_alert_state, updated_at
  ) VALUES (
    p_club_id, v_usage_date, 0, 0, 0, review_limit, warning,
    CASE WHEN review_limit = 0 THEN 'disabled' ELSE 'ok' END, clock_timestamp()
  ) ON CONFLICT (club_id, usage_date) DO NOTHING;
  SELECT review_calls INTO current_calls FROM public.hg_daily_usage
  WHERE club_id = p_club_id AND public.hg_daily_usage.usage_date = v_usage_date
  FOR UPDATE;
  current_calls := COALESCE(current_calls, 0);

  IF review_limit = 0 OR current_calls >= review_limit THEN
    alert_state := CASE WHEN review_limit = 0 THEN 'disabled' ELSE 'limit_reached' END;
    UPDATE public.hg_daily_usage SET
      review_daily_limit_calls = review_limit,
      warning_ratio = warning,
      review_alert_state = alert_state,
      updated_at = clock_timestamp()
    WHERE club_id = p_club_id AND public.hg_daily_usage.usage_date = v_usage_date;
    PERFORM public.hg_maybe_alert_review_usage(p_club_id, v_usage_date, current_calls, review_limit, warning);
    RETURN jsonb_build_object(
      'allowed', false, 'calls', current_calls, 'dailyLimitCalls', review_limit,
      'alertState', alert_state, 'nextAttemptAt', next_window
    );
  END IF;

  current_calls := current_calls + 1;
  alert_state := CASE
    WHEN current_calls >= review_limit THEN 'limit_reached'
    WHEN warning > 0 AND current_calls >= ceil(review_limit * warning) THEN 'near_limit'
    ELSE 'ok'
  END;
  UPDATE public.hg_daily_usage SET
    review_calls = current_calls,
    text_review_calls = text_review_calls + CASE WHEN p_kind = 'text' THEN 1 ELSE 0 END,
    image_review_calls = image_review_calls + CASE WHEN p_kind = 'image' THEN 1 ELSE 0 END,
    review_daily_limit_calls = review_limit,
    warning_ratio = warning,
    review_alert_state = alert_state,
    updated_at = clock_timestamp()
  WHERE club_id = p_club_id AND public.hg_daily_usage.usage_date = v_usage_date;
  PERFORM public.hg_maybe_alert_review_usage(p_club_id, v_usage_date, current_calls, review_limit, warning);
  RETURN jsonb_build_object(
    'allowed', true, 'calls', current_calls, 'dailyLimitCalls', review_limit,
    'alertState', alert_state, 'nextAttemptAt', NULL
  );
END $$;

-- The new image-intent RPC serializes the club/day check and preserves the
-- existing owner lock and idempotency behavior.
CREATE FUNCTION public.hg_image_intent(p_owner text, p_club_id text, p_key text, p_asset jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE result jsonb; existing jsonb; pending int; user_bytes bigint; key_id text;
  limits jsonb; user_limit bigint; club_limit bigint; usage jsonb;
  v_usage_date date; reserved_bytes bigint; club_used bigint; club_reserved bigint; cutoff timestamptz;
BEGIN
  IF p_asset->>'ownerId' IS DISTINCT FROM p_owner
     OR p_asset->>'clubId' IS DISTINCT FROM p_club_id
     OR NULLIF(p_owner, '') IS NULL OR NULLIF(p_key, '') IS NULL OR length(p_key) < 8 THEN
    RAISE EXCEPTION 'IMAGE_INVALID';
  END IF;
  v_usage_date := (clock_timestamp() AT TIME ZONE 'UTC')::date;
  PERFORM pg_advisory_xact_lock(hashtext('hg:usage:' || p_club_id || ':' || v_usage_date::text));
  PERFORM pg_advisory_xact_lock(hashtext('hg:image:' || p_owner));
  key_id := p_owner || ':imageIntent:' || p_key;
  SELECT doc INTO existing FROM public.hg_idempotency WHERE id = key_id;
  IF existing IS NOT NULL THEN
    IF existing->'declaredSize' IS DISTINCT FROM p_asset->'declaredSize'
       OR existing->'mimeType' IS DISTINCT FROM p_asset->'mimeType' THEN RAISE EXCEPTION 'IMAGE_CONFLICT'; END IF;
    RETURN existing->'result';
  END IF;

  limits := public.hg_usage_limits(p_club_id);
  user_limit := (limits->>'userUploadDailyBytes')::bigint;
  club_limit := (limits->>'clubUploadDailyBytes')::bigint;
  reserved_bytes := COALESCE(NULLIF(p_asset->>'quotaBytes', '')::bigint, 0);
  IF reserved_bytes <= 0 THEN RAISE EXCEPTION 'IMAGE_INVALID'; END IF;

  cutoff := clock_timestamp() - interval '24 hours';
  SELECT count(*) FILTER (WHERE doc->>'status' = 'intent' AND NULLIF(doc->>'expiresAt', '')::timestamptz > clock_timestamp()),
         COALESCE(sum(COALESCE(NULLIF(doc->>'quotaBytes', '')::bigint, NULLIF(doc->>'declaredSize', '')::bigint, 0))
           FILTER (WHERE NULLIF(doc->>'createdAt', '')::timestamptz >= cutoff), 0)::bigint
    INTO pending, user_bytes
  FROM public.hg_assets
  WHERE doc->>'ownerId' = p_owner AND doc->>'mediaType' = 'image';
  IF user_limit = 0 OR pending >= 3 OR user_bytes + reserved_bytes > user_limit THEN
    RAISE EXCEPTION 'IMAGE_QUOTA';
  END IF;

  usage := public.hg_refresh_daily_usage(p_club_id, v_usage_date);
  club_used := (usage->>'uploadBytes')::bigint;
  club_reserved := (usage->>'uploadReservedBytes')::bigint;
  IF club_limit = 0 OR club_used + club_reserved + reserved_bytes > club_limit THEN
    RAISE EXCEPTION 'IMAGE_QUOTA';
  END IF;

  INSERT INTO public.hg_assets (id, doc) VALUES (p_asset->>'_id', p_asset);
  result := jsonb_build_object('assetId', p_asset->>'_id', 'expiresAt', p_asset->>'expiresAt', 'expiresInSeconds', 900, 'mediaType', 'image');
  INSERT INTO public.hg_idempotency (id, doc) VALUES (
    key_id,
    jsonb_build_object('_id', key_id, 'state', 'succeeded', 'result', result,
      'declaredSize', p_asset->'declaredSize', 'mimeType', p_asset->'mimeType', 'createdAt', p_asset->'createdAt')
  );
  PERFORM public.hg_refresh_daily_usage(p_club_id, v_usage_date);
  RETURN result;
END $$;

-- Keep the old signature callable during a staged API deployment. Existing API
-- code omitted clubId from the server-created asset and uses the default club.
CREATE OR REPLACE FUNCTION public.hg_image_intent(p_owner text, p_key text, p_asset jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE compatible_asset jsonb;
BEGIN
  compatible_asset := p_asset || jsonb_build_object('clubId', 'heiguang');
  RETURN public.hg_image_intent(p_owner, 'heiguang', p_key, compatible_asset);
END $$;

REVOKE ALL ON FUNCTION public.hg_usage_limits(text),
  public.hg_refresh_daily_usage(text, date),
  public.hg_notify_review_usage_alert(text, date, bigint, bigint),
  public.hg_maybe_alert_review_usage(text, date, bigint, bigint, numeric),
  public.hg_usage_status(text),
  public.hg_usage_reserve_review_call(text, text),
  public.hg_image_intent(text, text, jsonb),
  public.hg_image_intent(text, text, text, jsonb)
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.hg_usage_status(text),
  public.hg_usage_reserve_review_call(text, text),
  public.hg_image_intent(text, text, text, jsonb)
TO service_role;
GRANT EXECUTE ON FUNCTION public.hg_usage_limits(text),
  public.hg_refresh_daily_usage(text, date),
  public.hg_notify_review_usage_alert(text, date, bigint, bigint),
  public.hg_maybe_alert_review_usage(text, date, bigint, bigint, numeric)
TO service_role;
GRANT EXECUTE ON FUNCTION public.hg_image_intent(text, text, jsonb)
TO service_role;
