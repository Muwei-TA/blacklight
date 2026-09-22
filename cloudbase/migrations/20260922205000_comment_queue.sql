CREATE FUNCTION public.hg_comment_queue(p_actor text,p_cursor jsonb DEFAULT NULL,p_limit int DEFAULT 20) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE result jsonb;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM hg_memberships WHERE doc->>'userId'=p_actor AND doc->>'clubId'='heiguang' AND doc->>'status'='active' AND doc->>'role' IN ('admin','moderator')) THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
  SELECT coalesce(jsonb_agg(row.doc ORDER BY row.doc->>'createdAt',row.id),'[]'::jsonb) INTO result FROM (
    SELECT c.id,c.doc FROM hg_comments c JOIN hg_posts p ON p.id=c.doc->>'postId'
    WHERE c.doc->>'status'='pending' AND p.doc->>'clubId'='heiguang' AND p.doc->>'status'='published' AND p.doc->>'visibility' IN ('club','public')
      AND (p_cursor IS NULL OR (c.doc->>'createdAt',c.id)>(p_cursor->>'createdAt',p_cursor->>'id'))
    ORDER BY c.doc->>'createdAt',c.id LIMIT greatest(1,least(p_limit,51))
  ) row;
  RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.hg_comment_queue(text,jsonb,int) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.hg_comment_queue(text,jsonb,int) TO service_role;
