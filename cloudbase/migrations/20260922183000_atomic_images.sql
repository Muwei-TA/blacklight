-- Image reservation, upload lease and review outbox are atomic server-only RPCs.
CREATE FUNCTION public.hg_image_intent(p_owner text,p_key text,p_asset jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE result jsonb; existing jsonb; pending int; bytes bigint; key_id text; cutoff text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('hg:image:'||p_owner));
  key_id:=p_owner||':imageIntent:'||p_key;
  SELECT doc INTO existing FROM hg_idempotency WHERE id=key_id;
  IF existing IS NOT NULL THEN
    IF existing->'declaredSize' IS DISTINCT FROM p_asset->'declaredSize' OR existing->'mimeType' IS DISTINCT FROM p_asset->'mimeType' THEN RAISE EXCEPTION 'IMAGE_CONFLICT'; END IF;
    RETURN existing->'result';
  END IF;
  cutoff:=to_char((now()-interval '24 hours') AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  SELECT count(*) FILTER (WHERE doc->>'status'='intent' AND (doc->>'expiresAt')::timestamptz>now()),coalesce(sum(coalesce(doc->>'quotaBytes',doc->>'declaredSize')::bigint) FILTER(WHERE doc->>'createdAt'>=cutoff),0)
  INTO pending,bytes FROM hg_assets WHERE doc->>'ownerId'=p_owner AND doc->>'mediaType'='image';
  IF pending>=3 OR bytes+(p_asset->>'quotaBytes')::bigint>20971520 THEN RAISE EXCEPTION 'IMAGE_QUOTA'; END IF;
  IF p_asset->>'ownerId' IS DISTINCT FROM p_owner OR coalesce(length(p_key),0)<8 THEN RAISE EXCEPTION 'IMAGE_INVALID'; END IF;
  INSERT INTO hg_assets(id,doc) VALUES(p_asset->>'_id',p_asset);
  result:=jsonb_build_object('assetId',p_asset->>'_id','expiresAt',p_asset->>'expiresAt','expiresInSeconds',900,'mediaType','image');
  INSERT INTO hg_idempotency(id,doc) VALUES(key_id,jsonb_build_object('_id',key_id,'state','succeeded','result',result,'declaredSize',p_asset->'declaredSize','mimeType',p_asset->'mimeType','createdAt',p_asset->'createdAt'));
  RETURN result;
END $$;
CREATE FUNCTION public.hg_claim_image(p_owner text,p_asset_id text,p_key text,p_hash text,p_claim text) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE asset jsonb;
BEGIN
  SELECT doc INTO asset FROM hg_assets WHERE id=p_asset_id FOR UPDATE;
  IF asset IS NULL OR asset->>'ownerId' IS DISTINCT FROM p_owner THEN RAISE EXCEPTION 'IMAGE_NOT_FOUND'; END IF;
  IF asset->>'uploadKey' IS NOT NULL AND (asset->>'uploadKey'<>p_key OR asset->>'contentHash'<>p_hash) THEN RAISE EXCEPTION 'IMAGE_CONFLICT'; END IF;
  IF asset->>'status' IN ('uploaded','verified') AND coalesce(asset->>'fileId','')<>'' THEN RETURN asset; END IF;
  IF asset->>'status'<>'intent' OR (asset->>'expiresAt')::timestamptz<=now() THEN RAISE EXCEPTION 'IMAGE_EXPIRED'; END IF;
  IF coalesce((asset->>'uploadLeaseUntil')::timestamptz,now()-interval '1 second')>now() THEN RAISE EXCEPTION 'IMAGE_PROCESSING'; END IF;
  asset:=asset||jsonb_build_object('uploadKey',p_key,'contentHash',p_hash,'uploadClaim',p_claim,'uploadStartedAt',now(),'uploadLeaseUntil',now()+interval '90 seconds');
  UPDATE hg_assets SET doc=asset WHERE id=p_asset_id;
  RETURN asset;
END $$;
CREATE FUNCTION public.hg_confirm_image(p_owner text,p_asset_id text) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE asset jsonb; task_id text; stamp text;
BEGIN
  SELECT doc INTO asset FROM hg_assets WHERE id=p_asset_id FOR UPDATE;
  IF asset IS NULL OR asset->>'ownerId' IS DISTINCT FROM p_owner THEN RAISE EXCEPTION 'IMAGE_NOT_FOUND'; END IF;
  IF asset->>'status' NOT IN ('uploaded','verified') OR coalesce(asset->>'fileId','')='' THEN RAISE EXCEPTION 'IMAGE_INVALID'; END IF;
  task_id:='asset-review:'||p_asset_id;
  stamp:=to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  INSERT INTO hg_review_tasks(id,doc) VALUES(task_id,jsonb_build_object('_id',task_id,'targetType','asset','targetId',p_asset_id,'mediaType','image','status','queued','attempts',0,'createdAt',stamp)) ON CONFLICT DO NOTHING;
  UPDATE hg_assets SET doc=doc||jsonb_build_object('reviewTaskId',task_id,'updatedAt',stamp) WHERE id=p_asset_id;
  RETURN jsonb_build_object('assetId',p_asset_id,'status',asset->>'status');
END $$;
REVOKE ALL ON FUNCTION public.hg_image_intent(text,text,jsonb),public.hg_claim_image(text,text,text,text,text),public.hg_confirm_image(text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.hg_image_intent(text,text,jsonb),public.hg_claim_image(text,text,text,text,text),public.hg_confirm_image(text,text) TO service_role;
