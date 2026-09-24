-- Apply before deploying the API. Additive RPC; old clients keep the same actions.
-- Reaction relation + counter changes commit or roll back together. Lock the post
-- before the comment, and change the counter only for rows actually inserted/deleted.
CREATE OR REPLACE FUNCTION public.hg_toggle_reaction(
  p_actor_id text, p_post_id text, p_comment_id text, p_next boolean
) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $$
DECLARE
  post_doc jsonb;
  target_doc jsonb;
  relation_id text;
  relation_doc jsonb;
  changed integer;
  delta integer;
  counter integer;
  stamp text := to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
BEGIN
  IF p_actor_id IS NULL OR p_actor_id = '' OR p_next IS NULL THEN
    RAISE EXCEPTION 'REACTION_TARGET_CHANGED';
  END IF;
  SELECT doc INTO post_doc FROM hg_posts WHERE id = p_post_id FOR UPDATE;
  IF post_doc IS NULL OR post_doc->>'status' IS DISTINCT FROM 'published'
    OR coalesce(post_doc->>'visibility', '') NOT IN ('club', 'public')
    OR NOT EXISTS (
      SELECT 1 FROM hg_memberships WHERE doc->>'userId' = p_actor_id
        AND doc->>'clubId' = post_doc->>'clubId' AND doc->>'status' = 'active'
    ) THEN
    RAISE EXCEPTION 'REACTION_TARGET_CHANGED';
  END IF;

  IF p_comment_id IS NULL THEN
    target_doc := post_doc;
    relation_id := p_actor_id || ':' || p_post_id;
  ELSE
    SELECT doc INTO target_doc FROM hg_comments WHERE id = p_comment_id FOR UPDATE;
    IF target_doc IS NULL OR target_doc->>'status' IS DISTINCT FROM 'published'
      OR target_doc->>'postId' IS DISTINCT FROM p_post_id THEN
      RAISE EXCEPTION 'REACTION_TARGET_CHANGED';
    END IF;
    relation_id := p_actor_id || ':comment:' || p_comment_id;
  END IF;

  IF p_next THEN
    relation_doc := jsonb_build_object('_id', relation_id, 'userId', p_actor_id,
      'postId', p_post_id, 'type', 'resonance', 'createdAt', stamp);
    IF p_comment_id IS NOT NULL THEN
      relation_doc := relation_doc || jsonb_build_object('commentId', p_comment_id);
    END IF;
    INSERT INTO hg_reactions(id, doc) VALUES (relation_id, relation_doc) ON CONFLICT DO NOTHING;
    GET DIAGNOSTICS changed = ROW_COUNT;
    delta := changed;
  ELSE
    DELETE FROM hg_reactions WHERE id = relation_id;
    GET DIAGNOSTICS changed = ROW_COUNT;
    delta := -changed;
  END IF;

  counter := greatest(0, coalesce((target_doc->>'reactionCount')::integer, 0) + delta);
  IF changed > 0 THEN
    IF p_comment_id IS NULL THEN
      UPDATE hg_posts SET doc = doc || jsonb_build_object('reactionCount', counter) WHERE id = p_post_id;
    ELSE
      UPDATE hg_comments SET doc = doc || jsonb_build_object('reactionCount', counter) WHERE id = p_comment_id;
    END IF;
  END IF;
  RETURN jsonb_build_object('ok', true, 'reacted', p_next, 'count', counter);
END $$;
REVOKE ALL ON FUNCTION public.hg_toggle_reaction(text,text,text,boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.hg_toggle_reaction(text,text,text,boolean) TO service_role;
