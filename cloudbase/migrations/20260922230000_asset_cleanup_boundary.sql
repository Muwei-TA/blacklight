CREATE OR REPLACE FUNCTION public.hg_create_post(p_key text, p_hash text, p_post jsonb, p_alias jsonb DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE existing jsonb; ident text:=p_post->>'_id'; owner_id text:=p_post->>'ownerId'; asset_id text; asset jsonb; result jsonb; inserted bigint;
BEGIN
  IF length(p_key)<8 OR length(p_key)>256 OR length(p_hash)<>64 THEN RAISE EXCEPTION 'invalid idempotency'; END IF;
  INSERT INTO hg_idempotency(id,doc) VALUES(p_key,jsonb_build_object('_id',p_key,'fingerprint',p_hash,'state','processing','createdAt',p_post->'createdAt')) ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS inserted=ROW_COUNT;
  IF inserted=0 THEN
    SELECT doc INTO existing FROM hg_idempotency WHERE id=p_key FOR UPDATE;
    IF existing->>'fingerprint' IS DISTINCT FROM p_hash THEN RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT'; END IF;
    IF existing->>'state'<>'succeeded' THEN RAISE EXCEPTION 'IDEMPOTENCY_PROCESSING'; END IF;
    RETURN existing->'result';
  END IF;
  FOR asset_id IN SELECT jsonb_array_elements_text(p_post->'assetIds') ORDER BY 1 LOOP
    SELECT doc INTO asset FROM hg_assets WHERE id=asset_id FOR UPDATE;
    IF asset IS NULL OR asset->>'ownerId' IS DISTINCT FROM owner_id OR asset->>'status'<>'verified' OR COALESCE(asset->>'postId','')<>'' OR asset->>'cleanupState'='running' THEN RAISE EXCEPTION 'ASSET_BINDING_CONFLICT'; END IF;
    UPDATE hg_assets SET doc=doc || jsonb_build_object('postId',ident,'postVersion',1,'updatedAt',p_post->'createdAt') WHERE id=asset_id;
  END LOOP;
  INSERT INTO hg_posts(id,doc) VALUES(ident,p_post);
  IF p_alias IS NOT NULL THEN INSERT INTO hg_anonymous_identities(id,doc) VALUES(p_alias->>'_id',p_alias); END IF;
  IF p_post->>'visibility'<>'private' THEN
    INSERT INTO hg_review_tasks(id,doc) VALUES('review:'||ident,jsonb_build_object('_id','review:'||ident,'targetType','post','targetId',ident,'postVersion',1,'status','queued','attempts',0,'needsMedia',jsonb_array_length(p_post->'assetIds')>0,'createdAt',p_post->'createdAt'));
  END IF;
  result:=jsonb_build_object('id',ident,'version',1,'state',CASE WHEN p_post->>'visibility'='private' THEN 'private_saved' ELSE 'pending' END);
  UPDATE hg_idempotency SET doc=doc || jsonb_build_object('state','succeeded','result',result,'completedAt',p_post->'createdAt') WHERE id=p_key;
  RETURN result;
END $$;

REVOKE ALL ON FUNCTION public.hg_runtime_role() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.hg_runtime_role() TO service_role;
ALTER FUNCTION public.hg_apply_membership(text,jsonb) SECURITY INVOKER;
