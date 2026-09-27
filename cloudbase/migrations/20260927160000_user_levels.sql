-- User XP and level progression (2026-09-27).
--
-- XP is awarded only by server-side check-in RPCs and triggers observing
-- successful reaction inserts / comment state transitions. No pre-existing
-- reactions or published comments are backfilled by this migration.
-- All event rows are private and only readable by service_role.

CREATE TABLE public.hg_user_xp_accounts (
  user_id text PRIMARY KEY,
  total_xp integer NOT NULL DEFAULT 0 CHECK (total_xp >= 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE public.hg_user_xp_accounts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.hg_user_xp_accounts FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.hg_user_xp_accounts TO service_role;

CREATE TABLE public.hg_user_xp_events (
  event_id text PRIMARY KEY,
  user_id text NOT NULL,
  event_type text NOT NULL CHECK (event_type IN (
    'check_in', 'reaction', 'comment_approved', 'comment_revoked'
  )),
  source_id text,
  source_post_id text,
  business_date date NOT NULL,
  xp integer NOT NULL,
  rule_version smallint NOT NULL DEFAULT 1 CHECK (rule_version > 0),
  idempotency_key text NOT NULL UNIQUE,
  reversal_of text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (
    (event_type = 'check_in' AND xp = 5 AND source_id IS NULL AND source_post_id IS NULL AND reversal_of IS NULL)
    OR (event_type = 'reaction' AND xp = 1 AND source_id IS NOT NULL AND source_post_id IS NOT NULL AND reversal_of IS NULL)
    OR (event_type = 'comment_approved' AND xp = 3 AND source_id IS NOT NULL AND source_post_id IS NOT NULL AND reversal_of IS NULL)
    OR (event_type = 'comment_revoked' AND xp = -3 AND source_id IS NOT NULL AND source_post_id IS NOT NULL AND reversal_of IS NOT NULL)
  )
);
ALTER TABLE public.hg_user_xp_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.hg_user_xp_events FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.hg_user_xp_events TO service_role;

CREATE INDEX hg_user_xp_events_user_day_type_idx
  ON public.hg_user_xp_events (user_id, business_date, event_type)
  WHERE xp > 0;
CREATE UNIQUE INDEX hg_user_xp_events_check_in_once_idx
  ON public.hg_user_xp_events (user_id, business_date)
  WHERE event_type = 'check_in';
CREATE UNIQUE INDEX hg_user_xp_events_reaction_once_idx
  ON public.hg_user_xp_events (user_id, source_id)
  WHERE event_type = 'reaction';
CREATE UNIQUE INDEX hg_user_xp_events_comment_once_idx
  ON public.hg_user_xp_events (user_id, source_id)
  WHERE event_type = 'comment_approved';
CREATE UNIQUE INDEX hg_user_xp_events_comment_post_day_idx
  ON public.hg_user_xp_events (user_id, source_post_id, business_date)
  WHERE event_type = 'comment_approved';
CREATE UNIQUE INDEX hg_user_xp_events_reversal_once_idx
  ON public.hg_user_xp_events (reversal_of)
  WHERE reversal_of IS NOT NULL;

COMMENT ON TABLE public.hg_user_xp_accounts IS
  'Private XP total for the account; cleared when account deletion completes.';
COMMENT ON TABLE public.hg_user_xp_events IS
  'Private idempotent XP ledger. Comment/reaction source links are never returned by public APIs.';

-- Award one of the fixed XP events. The per-user transaction lock serializes
-- check-in, reaction, and comment rewards so daily caps cannot race.
CREATE FUNCTION public.hg_user_levels_award(
  p_user_id text,
  p_club_id text,
  p_event_type text,
  p_source_id text,
  p_source_post_id text,
  p_business_date date,
  p_xp integer,
  p_lock_nowait boolean DEFAULT false
) RETURNS integer
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $$
DECLARE
  expected_xp integer;
  positive_count integer;
  positive_total integer;
  event_key text;
  v_event_id text;
  inserted_event text;
BEGIN
  IF p_user_id IS NULL OR p_user_id = '' OR p_club_id IS NULL OR p_club_id = ''
     OR p_business_date IS NULL THEN
    RAISE EXCEPTION 'INVALID_XP_EVENT';
  END IF;
  expected_xp := CASE p_event_type
    WHEN 'check_in' THEN 5
    WHEN 'reaction' THEN 1
    WHEN 'comment_approved' THEN 3
    ELSE NULL
  END;
  IF expected_xp IS NULL OR p_xp IS DISTINCT FROM expected_xp
     OR (p_event_type = 'check_in' AND (p_source_id IS NOT NULL OR p_source_post_id IS NOT NULL))
     OR (p_event_type <> 'check_in' AND (p_source_id IS NULL OR p_source_id = '' OR p_source_post_id IS NULL OR p_source_post_id = '')) THEN
    RAISE EXCEPTION 'INVALID_XP_EVENT';
  END IF;

  -- Lock membership before the per-user XP lock. Moderation already holds the
  -- content row when its status trigger runs, and membership-first keeps that
  -- path compatible with check-in and concurrent membership removal.
  IF p_lock_nowait THEN
    BEGIN
      PERFORM 1 FROM public.hg_memberships
      WHERE doc->>'userId' = p_user_id
        AND doc->>'clubId' = p_club_id
        AND doc->>'status' = 'active'
      FOR SHARE NOWAIT;
    EXCEPTION WHEN lock_not_available THEN
      RAISE EXCEPTION 'XP_MEMBERSHIP_BUSY' USING ERRCODE = '55P03';
    END;
  ELSE
    PERFORM 1 FROM public.hg_memberships
    WHERE doc->>'userId' = p_user_id
      AND doc->>'clubId' = p_club_id
      AND doc->>'status' = 'active'
    FOR SHARE;
  END IF;
  IF NOT FOUND THEN RETURN 0; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('hg-user-levels:' || p_user_id, 0));

  IF p_event_type = 'check_in' THEN
    IF EXISTS (
      SELECT 1 FROM public.hg_user_xp_events
      WHERE user_id = p_user_id AND event_type = 'check_in' AND business_date = p_business_date
    ) THEN RETURN 0; END IF;
  ELSIF p_event_type = 'reaction' THEN
    IF EXISTS (
      SELECT 1 FROM public.hg_user_xp_events
      WHERE user_id = p_user_id AND event_type = 'reaction' AND source_id = p_source_id
    ) THEN RETURN 0; END IF;
    SELECT count(*)::integer INTO positive_count
    FROM public.hg_user_xp_events
    WHERE user_id = p_user_id AND event_type = 'reaction'
      AND business_date = p_business_date AND xp > 0;
    IF positive_count >= 5 THEN RETURN 0; END IF;
  ELSE
    IF EXISTS (
      SELECT 1 FROM public.hg_user_xp_events
      WHERE user_id = p_user_id AND event_type = 'comment_approved'
        AND (source_id = p_source_id OR (source_post_id = p_source_post_id AND business_date = p_business_date))
    ) THEN RETURN 0; END IF;
    SELECT count(*)::integer INTO positive_count
    FROM public.hg_user_xp_events
    WHERE user_id = p_user_id AND event_type = 'comment_approved'
      AND business_date = p_business_date AND xp > 0;
    IF positive_count >= 3 THEN RETURN 0; END IF;
  END IF;

  SELECT COALESCE(sum(xp), 0)::integer INTO positive_total
  FROM public.hg_user_xp_events
  WHERE user_id = p_user_id AND business_date = p_business_date AND xp > 0;
  IF positive_total + p_xp > 19 THEN RETURN 0; END IF;

  event_key := p_event_type || ':' || p_user_id || ':' ||
    COALESCE(p_source_id, p_business_date::text) || ':' || p_business_date::text;
  v_event_id := 'xp:' || md5(event_key);
  INSERT INTO public.hg_user_xp_events (
    event_id, user_id, event_type, source_id, source_post_id,
    business_date, xp, idempotency_key
  ) VALUES (
    v_event_id, p_user_id, p_event_type, p_source_id, p_source_post_id,
    p_business_date, p_xp, event_key
  ) ON CONFLICT DO NOTHING
  RETURNING event_id INTO inserted_event;
  IF inserted_event IS NULL THEN RETURN 0; END IF;

  INSERT INTO public.hg_user_xp_accounts (user_id, total_xp)
  VALUES (p_user_id, p_xp)
  ON CONFLICT (user_id) DO UPDATE SET
    total_xp = public.hg_user_xp_accounts.total_xp + EXCLUDED.total_xp,
    updated_at = clock_timestamp();
  RETURN p_xp;
END $$;

-- Current-member-only private snapshot. The event ledger itself is never
-- returned; only aggregate counts and XP needed by the member card are exposed.
CREATE FUNCTION public.hg_user_levels_snapshot(p_actor_id text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = public, pg_temp AS $$
DECLARE
  thresholds integer[] := ARRAY[0, 40, 120, 280, 520, 860, 1320, 2000];
  names text[] := ARRAY['微光', '新芽', '青枝', '向光', '成荫', '星枝', '林海', '长明'];
  active_member boolean;
  total integer;
  level integer := 1;
  current_threshold integer;
  next_threshold integer;
  day_key date := (transaction_timestamp() AT TIME ZONE 'Asia/Shanghai')::date;
  earned_today integer := 0;
  checked_in_today boolean := false;
  reactions_today integer := 0;
  comments_today integer := 0;
  i integer;
BEGIN
  IF p_actor_id IS NULL OR p_actor_id = '' THEN RAISE EXCEPTION 'MEMBERSHIP_REQUIRED'; END IF;
  SELECT true INTO active_member FROM public.hg_memberships
  WHERE doc->>'userId' = p_actor_id AND doc->>'clubId' = 'heiguang' AND doc->>'status' = 'active'
  LIMIT 1;
  IF NOT COALESCE(active_member, false) THEN RAISE EXCEPTION 'MEMBERSHIP_REQUIRED'; END IF;

  SELECT total_xp INTO total FROM public.hg_user_xp_accounts WHERE user_id = p_actor_id;
  total := COALESCE(total, 0);
  FOR i IN 2..array_length(thresholds, 1) LOOP
    IF total < thresholds[i] THEN
      level := i - 1;
      EXIT;
    END IF;
    level := i;
  END LOOP;
  current_threshold := thresholds[level];
  IF level < array_length(thresholds, 1) THEN next_threshold := thresholds[level + 1];
  ELSE next_threshold := NULL;
  END IF;

  SELECT
    COALESCE(sum(xp) FILTER (WHERE xp > 0), 0)::integer,
    COALESCE(bool_or(event_type = 'check_in' AND xp > 0), false),
    count(*) FILTER (WHERE event_type = 'reaction' AND xp > 0)::integer,
    count(*) FILTER (WHERE event_type = 'comment_approved' AND xp > 0)::integer
  INTO earned_today, checked_in_today, reactions_today, comments_today
  FROM public.hg_user_xp_events
  WHERE user_id = p_actor_id AND business_date = day_key;

  RETURN jsonb_build_object(
    'level', level,
    'title', names[level],
    'totalXp', total,
    'currentLevelXp', current_threshold,
    'nextLevelXp', next_threshold,
    'progressXp', greatest(0, total - current_threshold),
    'progressTargetXp', CASE WHEN next_threshold IS NULL THEN 0 ELSE next_threshold - current_threshold END,
    'today', jsonb_build_object(
      'earnedXp', earned_today,
      'maxXp', 19,
      'checkedIn', checked_in_today,
      'reactions', reactions_today,
      'maxReactions', 5,
      'comments', comments_today,
      'maxComments', 3
    )
  );
END $$;

-- One check-in per server-calculated Asia/Shanghai calendar day. Duplicate
-- requests return the same snapshot shape with awardedXp=0.
CREATE FUNCTION public.hg_user_levels_check_in(p_actor_id text) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $$
DECLARE
  day_key date := (transaction_timestamp() AT TIME ZONE 'Asia/Shanghai')::date;
  awarded integer;
  result jsonb;
BEGIN
  IF p_actor_id IS NULL OR p_actor_id = '' THEN RAISE EXCEPTION 'MEMBERSHIP_REQUIRED'; END IF;
  PERFORM 1 FROM public.hg_memberships
  WHERE doc->>'userId' = p_actor_id AND doc->>'clubId' = 'heiguang' AND doc->>'status' = 'active'
  FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'MEMBERSHIP_REQUIRED'; END IF;

  awarded := public.hg_user_levels_award(p_actor_id, 'heiguang', 'check_in', NULL, NULL, day_key, 5);
  result := public.hg_user_levels_snapshot(p_actor_id);
  RETURN result || jsonb_build_object('awardedXp', awarded);
END $$;

-- A real reaction row is the reward trigger. DELETE/cancel never reverses the
-- one-time reward, and self-reactions do not earn XP.
CREATE FUNCTION public.hg_user_levels_on_reaction_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $$
DECLARE
  reaction jsonb := NEW.doc;
  post jsonb;
  target jsonb;
  v_user_id text;
  club_id text;
  post_id text;
  target_comment_id text;
  target_owner_id text;
  day_key date;
BEGIN
  IF reaction->>'type' IS DISTINCT FROM 'resonance' THEN RETURN NEW; END IF;
  v_user_id := reaction->>'userId';
  post_id := reaction->>'postId';
  target_comment_id := NULLIF(reaction->>'commentId', '');
  IF v_user_id IS NULL OR v_user_id = '' OR post_id IS NULL OR post_id = '' THEN RETURN NEW; END IF;

  SELECT doc INTO post FROM public.hg_posts WHERE id = post_id;
  IF post IS NULL OR post->>'status' IS DISTINCT FROM 'published'
     OR post->>'visibility' NOT IN ('club', 'public') THEN RETURN NEW; END IF;
  club_id := COALESCE(NULLIF(post->>'clubId', ''), 'heiguang');
  IF target_comment_id IS NULL THEN
    target_owner_id := post->>'ownerId';
  ELSE
    SELECT doc INTO target FROM public.hg_comments WHERE id = target_comment_id;
    IF target IS NULL OR target->>'status' IS DISTINCT FROM 'published'
       OR target->>'postId' IS DISTINCT FROM post_id THEN RETURN NEW; END IF;
    target_owner_id := target->>'ownerId';
  END IF;
  IF target_owner_id IS NULL OR target_owner_id = '' OR target_owner_id = v_user_id THEN RETURN NEW; END IF;

  day_key := (transaction_timestamp() AT TIME ZONE 'Asia/Shanghai')::date;
  PERFORM public.hg_user_levels_award(
    v_user_id, club_id, 'reaction', NEW.id, post_id, day_key, 1, true
  );
  RETURN NEW;
END $$;
CREATE TRIGGER hg_user_levels_reaction_insert
  AFTER INSERT ON public.hg_reactions
  FOR EACH ROW EXECUTE FUNCTION public.hg_user_levels_on_reaction_insert();

-- Any approved comment transition, whether made by automatic review or an
-- administrator, awards at most once per comment and per user/post/day.
-- A later hidden/rejected transition appends one compensating ledger event.
CREATE FUNCTION public.hg_user_levels_on_comment_change() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $$
DECLARE
  comment_doc jsonb := NEW.doc;
  parent_post jsonb;
  v_user_id text;
  post_id text;
  club_id text;
  day_key date;
  award public.hg_user_xp_events%ROWTYPE;
  reversal_key text;
  reversal_id text;
  inserted_event text;
BEGIN
  IF OLD.doc->>'status' IS NOT DISTINCT FROM NEW.doc->>'status' THEN RETURN NEW; END IF;
  v_user_id := comment_doc->>'ownerId';
  post_id := comment_doc->>'postId';
  IF v_user_id IS NULL OR v_user_id = '' OR post_id IS NULL OR post_id = '' THEN RETURN NEW; END IF;

  IF NEW.doc->>'status' = 'published' THEN
    SELECT doc INTO parent_post FROM public.hg_posts WHERE id = post_id;
    IF parent_post IS NULL OR parent_post->>'status' IS DISTINCT FROM 'published'
       OR parent_post->>'visibility' NOT IN ('club', 'public') THEN RETURN NEW; END IF;
    club_id := COALESCE(NULLIF(parent_post->>'clubId', ''), 'heiguang');
    day_key := (transaction_timestamp() AT TIME ZONE 'Asia/Shanghai')::date;
    PERFORM public.hg_user_levels_award(
      v_user_id, club_id, 'comment_approved', NEW.id, post_id, day_key, 3, true
    );
    RETURN NEW;
  END IF;

  IF OLD.doc->>'status' = 'published' AND NEW.doc->>'status' IN ('hidden', 'rejected') THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('hg-user-levels:' || v_user_id, 0));
    SELECT event.* INTO award FROM public.hg_user_xp_events AS event
    WHERE event.user_id = v_user_id AND event.event_type = 'comment_approved' AND event.source_id = NEW.id
    FOR UPDATE;
    IF NOT FOUND OR EXISTS (
      SELECT 1 FROM public.hg_user_xp_events WHERE reversal_of = award.event_id
    ) THEN RETURN NEW; END IF;

    day_key := (transaction_timestamp() AT TIME ZONE 'Asia/Shanghai')::date;
    reversal_key := 'comment_revoked:' || award.event_id;
    reversal_id := 'xp:' || md5(reversal_key);
    INSERT INTO public.hg_user_xp_events (
      event_id, user_id, event_type, source_id, source_post_id,
      business_date, xp, idempotency_key, reversal_of
    ) VALUES (
      reversal_id, v_user_id, 'comment_revoked', NEW.id, award.source_post_id,
      day_key, -award.xp, reversal_key, award.event_id
    ) ON CONFLICT DO NOTHING
    RETURNING event_id INTO inserted_event;
    IF inserted_event IS NOT NULL THEN
      INSERT INTO public.hg_user_xp_accounts (user_id, total_xp)
      VALUES (v_user_id, 0)
      ON CONFLICT (user_id) DO NOTHING;
      UPDATE public.hg_user_xp_accounts AS account
      SET total_xp = greatest(0, account.total_xp + (-award.xp)), updated_at = clock_timestamp()
      WHERE account.user_id = v_user_id;
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER hg_user_levels_comment_change
  AFTER UPDATE OF doc ON public.hg_comments
  FOR EACH ROW EXECUTE FUNCTION public.hg_user_levels_on_comment_change();

-- The account deletion worker marks the user row deleted only after content
-- cleanup. Remove the private ledger at that terminal transition so anonymous
-- activity cannot remain linked to a deleted account.
CREATE FUNCTION public.hg_user_levels_clear_deleted_account() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $$
BEGIN
  IF OLD.doc->>'status' IS DISTINCT FROM 'deleted' AND NEW.doc->>'status' = 'deleted' THEN
    DELETE FROM public.hg_user_xp_events WHERE user_id = NEW.id;
    DELETE FROM public.hg_user_xp_accounts WHERE user_id = NEW.id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER hg_user_levels_account_deleted
  AFTER UPDATE OF doc ON public.hg_users
  FOR EACH ROW EXECUTE FUNCTION public.hg_user_levels_clear_deleted_account();

REVOKE ALL ON FUNCTION public.hg_user_levels_award(text,text,text,text,text,date,integer,boolean),
  public.hg_user_levels_snapshot(text), public.hg_user_levels_check_in(text),
  public.hg_user_levels_on_reaction_insert(), public.hg_user_levels_on_comment_change(),
  public.hg_user_levels_clear_deleted_account()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.hg_user_levels_award(text,text,text,text,text,date,integer,boolean),
  public.hg_user_levels_snapshot(text), public.hg_user_levels_check_in(text),
  public.hg_user_levels_on_reaction_insert(), public.hg_user_levels_on_comment_change(),
  public.hg_user_levels_clear_deleted_account()
  TO service_role;

COMMENT ON FUNCTION public.hg_user_levels_snapshot(text) IS
  'Returns the caller-specific level and privacy-safe daily aggregates; never returns XP source identifiers.';
COMMENT ON FUNCTION public.hg_user_levels_check_in(text) IS
  'Atomically awards at most 5 XP per Asia/Shanghai day and returns the current private-member snapshot.';
