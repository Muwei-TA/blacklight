-- Reopen an author's rejected post as a new review version. The original post
-- and media remain bound; only title/body may change. The idempotency claim,
-- version CAS, new review outbox entry, and audit marker commit together.
CREATE FUNCTION public.hg_resubmit_rejected_post(
  p_key text,
  p_hash text,
  p_actor_id text,
  p_post_id text,
  p_expected_version integer,
  p_title text,
  p_body text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $$
DECLARE
  existing jsonb;
  post jsonb;
  asset jsonb;
  asset_id text;
  result jsonb;
  next_version integer;
  inserted integer;
  task_id text;
  audit_id text;
  now_text text := to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
BEGIN
  IF p_key IS NULL OR length(p_key) < 8 OR length(p_key) > 256
     OR p_hash IS NULL OR length(p_hash) <> 64
     OR p_actor_id IS NULL OR p_actor_id = '' OR p_post_id IS NULL OR p_post_id = ''
     OR p_expected_version IS NULL OR p_expected_version < 1 THEN RAISE EXCEPTION 'INVALID'; END IF;

  INSERT INTO public.hg_idempotency(id, doc)
  VALUES (p_key, jsonb_build_object('_id', p_key, 'fingerprint', p_hash,
    'state', 'processing', 'createdAt', now_text)) ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS inserted = ROW_COUNT;
  IF inserted = 0 THEN
    SELECT doc INTO existing FROM public.hg_idempotency WHERE id = p_key FOR UPDATE;
    IF existing->>'fingerprint' IS DISTINCT FROM p_hash THEN RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT'; END IF;
    IF existing->>'state' <> 'succeeded' THEN RAISE EXCEPTION 'IDEMPOTENCY_PROCESSING'; END IF;
    RETURN existing->'result';
  END IF;

  SELECT doc INTO post FROM public.hg_posts WHERE id = p_post_id FOR UPDATE;
  IF post IS NULL OR post->>'ownerId' IS DISTINCT FROM p_actor_id THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.hg_memberships
    WHERE doc->>'userId' = p_actor_id AND doc->>'clubId' = post->>'clubId' AND doc->>'status' = 'active'
  ) THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
  IF post->>'status' <> 'rejected' OR post->>'visibility' NOT IN ('club', 'public') THEN
    RAISE EXCEPTION 'POST_NOT_REJECTED';
  END IF;
  IF COALESCE(NULLIF(post->>'version', '')::integer, 1) <> p_expected_version THEN
    RAISE EXCEPTION 'VERSION_CONFLICT';
  END IF;
  IF p_title IS NULL OR p_body IS NULL OR length(p_title) > 60
     OR length(p_body) > (CASE WHEN post->>'kind' = 'article' THEN 20000 ELSE 2000 END)
     OR (post->>'kind' = 'article' AND btrim(p_title) = '')
     OR (btrim(p_body) = '' AND jsonb_array_length(COALESCE(post->'assetIds', '[]'::jsonb)) = 0)
  THEN RAISE EXCEPTION 'INVALID'; END IF;

  next_version := p_expected_version + 1;
  FOR asset_id IN SELECT jsonb_array_elements_text(COALESCE(post->'assetIds', '[]'::jsonb)) ORDER BY 1 LOOP
    SELECT doc INTO asset FROM public.hg_assets WHERE id = asset_id FOR UPDATE;
    IF asset IS NULL OR asset->>'ownerId' IS DISTINCT FROM p_actor_id
       OR asset->>'postId' IS DISTINCT FROM p_post_id OR asset->>'status' <> 'verified'
    THEN RAISE EXCEPTION 'ASSET_BINDING_CONFLICT'; END IF;
    UPDATE public.hg_assets SET doc = asset || jsonb_build_object('postVersion', next_version, 'updatedAt', now_text)
    WHERE id = asset_id;
  END LOOP;

  UPDATE public.hg_posts SET doc =
    (post - 'reviewExpectedVersion' - 'reviewDecision' - 'reviewResult' - 'reviewDecidedAt'
      - 'moderationExpectedVersion' - 'moderationDecision' - 'moderationResult'
      - 'moderationDecidedAt' - 'reviewedAt' - 'reviewedBy')
    || jsonb_build_object('title', p_title, 'body', p_body, 'status', 'pending',
      'rejectReason', '', 'version', next_version, 'updatedAt', now_text,
      'permissionVersion', COALESCE(NULLIF(post->>'permissionVersion', '')::integer, 0) + 1,
      'resubmittedFromVersion', p_expected_version)
  WHERE id = p_post_id;

  task_id := 'review:' || p_post_id || ':' || next_version;
  INSERT INTO public.hg_review_tasks(id, doc) VALUES (task_id,
    jsonb_build_object('_id', task_id, 'targetType', 'post', 'targetId', p_post_id,
      'postVersion', next_version, 'status', 'queued', 'attempts', 0,
      'needsMedia', jsonb_array_length(COALESCE(post->'assetIds', '[]'::jsonb)) > 0,
      'createdAt', now_text));
  audit_id := 'audit:' || md5(clock_timestamp()::text || random()::text);
  INSERT INTO public.hg_audit_logs(id, doc) VALUES (audit_id,
    jsonb_build_object('_id', audit_id, 'actorId', p_actor_id, 'action', 'post.resubmit',
      'targetType', 'post', 'targetId', p_post_id, 'fromVersion', p_expected_version,
      'toVersion', next_version, 'createdAt', now_text));

  result := jsonb_build_object('id', p_post_id, 'state', 'pending', 'version', next_version);
  UPDATE public.hg_idempotency SET doc = doc || jsonb_build_object('state', 'succeeded',
    'result', result, 'completedAt', now_text) WHERE id = p_key;
  RETURN result;
END $$;

REVOKE ALL ON FUNCTION public.hg_resubmit_rejected_post(text,text,text,text,integer,text,text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.hg_resubmit_rejected_post(text,text,text,text,integer,text,text)
  TO service_role;
