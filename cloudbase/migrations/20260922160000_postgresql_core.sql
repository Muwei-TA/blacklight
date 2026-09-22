-- PostgreSQL application storage. No client table/RPC access: only cloud functions.
-- JSONB preserves the reviewed domain contract; primary/unique/expression indexes enforce invariants.
CREATE TABLE public.hg_users (id text PRIMARY KEY, doc jsonb NOT NULL CHECK (jsonb_typeof(doc) = 'object' AND doc->>'_id' = id));
ALTER TABLE public.hg_users ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.hg_users FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.hg_users TO service_role;
CREATE INDEX hg_users_created_idx ON public.hg_users ((doc->'createdAt'), id);
CREATE TABLE public.hg_memberships (id text PRIMARY KEY, doc jsonb NOT NULL CHECK (jsonb_typeof(doc) = 'object' AND doc->>'_id' = id));
ALTER TABLE public.hg_memberships ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.hg_memberships FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.hg_memberships TO service_role;
CREATE INDEX hg_memberships_created_idx ON public.hg_memberships ((doc->'createdAt'), id);
CREATE TABLE public.hg_posts (id text PRIMARY KEY, doc jsonb NOT NULL CHECK (jsonb_typeof(doc) = 'object' AND doc->>'_id' = id));
ALTER TABLE public.hg_posts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.hg_posts FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.hg_posts TO service_role;
CREATE INDEX hg_posts_created_idx ON public.hg_posts ((doc->'createdAt'), id);
CREATE TABLE public.hg_comments (id text PRIMARY KEY, doc jsonb NOT NULL CHECK (jsonb_typeof(doc) = 'object' AND doc->>'_id' = id));
ALTER TABLE public.hg_comments ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.hg_comments FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.hg_comments TO service_role;
CREATE INDEX hg_comments_created_idx ON public.hg_comments ((doc->'createdAt'), id);
CREATE TABLE public.hg_reactions (id text PRIMARY KEY, doc jsonb NOT NULL CHECK (jsonb_typeof(doc) = 'object' AND doc->>'_id' = id));
ALTER TABLE public.hg_reactions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.hg_reactions FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.hg_reactions TO service_role;
CREATE INDEX hg_reactions_created_idx ON public.hg_reactions ((doc->'createdAt'), id);
CREATE TABLE public.hg_bookmarks (id text PRIMARY KEY, doc jsonb NOT NULL CHECK (jsonb_typeof(doc) = 'object' AND doc->>'_id' = id));
ALTER TABLE public.hg_bookmarks ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.hg_bookmarks FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.hg_bookmarks TO service_role;
CREATE INDEX hg_bookmarks_created_idx ON public.hg_bookmarks ((doc->'createdAt'), id);
CREATE TABLE public.hg_topics (id text PRIMARY KEY, doc jsonb NOT NULL CHECK (jsonb_typeof(doc) = 'object' AND doc->>'_id' = id));
ALTER TABLE public.hg_topics ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.hg_topics FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.hg_topics TO service_role;
CREATE INDEX hg_topics_created_idx ON public.hg_topics ((doc->'createdAt'), id);
CREATE TABLE public.hg_topic_follows (id text PRIMARY KEY, doc jsonb NOT NULL CHECK (jsonb_typeof(doc) = 'object' AND doc->>'_id' = id));
ALTER TABLE public.hg_topic_follows ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.hg_topic_follows FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.hg_topic_follows TO service_role;
CREATE INDEX hg_topic_follows_created_idx ON public.hg_topic_follows ((doc->'createdAt'), id);
CREATE TABLE public.hg_collections (id text PRIMARY KEY, doc jsonb NOT NULL CHECK (jsonb_typeof(doc) = 'object' AND doc->>'_id' = id));
ALTER TABLE public.hg_collections ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.hg_collections FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.hg_collections TO service_role;
CREATE INDEX hg_collections_created_idx ON public.hg_collections ((doc->'createdAt'), id);
CREATE TABLE public.hg_collection_entries (id text PRIMARY KEY, doc jsonb NOT NULL CHECK (jsonb_typeof(doc) = 'object' AND doc->>'_id' = id));
ALTER TABLE public.hg_collection_entries ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.hg_collection_entries FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.hg_collection_entries TO service_role;
CREATE INDEX hg_collection_entries_created_idx ON public.hg_collection_entries ((doc->'createdAt'), id);
CREATE TABLE public.hg_consents (id text PRIMARY KEY, doc jsonb NOT NULL CHECK (jsonb_typeof(doc) = 'object' AND doc->>'_id' = id));
ALTER TABLE public.hg_consents ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.hg_consents FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.hg_consents TO service_role;
CREATE INDEX hg_consents_created_idx ON public.hg_consents ((doc->'createdAt'), id);
CREATE TABLE public.hg_assets (id text PRIMARY KEY, doc jsonb NOT NULL CHECK (jsonb_typeof(doc) = 'object' AND doc->>'_id' = id));
ALTER TABLE public.hg_assets ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.hg_assets FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.hg_assets TO service_role;
CREATE INDEX hg_assets_created_idx ON public.hg_assets ((doc->'createdAt'), id);
CREATE TABLE public.hg_notifications (id text PRIMARY KEY, doc jsonb NOT NULL CHECK (jsonb_typeof(doc) = 'object' AND doc->>'_id' = id));
ALTER TABLE public.hg_notifications ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.hg_notifications FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.hg_notifications TO service_role;
CREATE INDEX hg_notifications_created_idx ON public.hg_notifications ((doc->'createdAt'), id);
CREATE TABLE public.hg_reports (id text PRIMARY KEY, doc jsonb NOT NULL CHECK (jsonb_typeof(doc) = 'object' AND doc->>'_id' = id));
ALTER TABLE public.hg_reports ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.hg_reports FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.hg_reports TO service_role;
CREATE INDEX hg_reports_created_idx ON public.hg_reports ((doc->'createdAt'), id);
CREATE TABLE public.hg_review_tasks (id text PRIMARY KEY, doc jsonb NOT NULL CHECK (jsonb_typeof(doc) = 'object' AND doc->>'_id' = id));
ALTER TABLE public.hg_review_tasks ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.hg_review_tasks FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.hg_review_tasks TO service_role;
CREATE INDEX hg_review_tasks_created_idx ON public.hg_review_tasks ((doc->'createdAt'), id);
CREATE TABLE public.hg_audit_logs (id text PRIMARY KEY, doc jsonb NOT NULL CHECK (jsonb_typeof(doc) = 'object' AND doc->>'_id' = id));
ALTER TABLE public.hg_audit_logs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.hg_audit_logs FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.hg_audit_logs TO service_role;
CREATE INDEX hg_audit_logs_created_idx ON public.hg_audit_logs ((doc->'createdAt'), id);
CREATE TABLE public.hg_idempotency (id text PRIMARY KEY, doc jsonb NOT NULL CHECK (jsonb_typeof(doc) = 'object' AND doc->>'_id' = id));
ALTER TABLE public.hg_idempotency ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.hg_idempotency FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.hg_idempotency TO service_role;
CREATE INDEX hg_idempotency_created_idx ON public.hg_idempotency ((doc->'createdAt'), id);
CREATE TABLE public.hg_anonymous_identities (id text PRIMARY KEY, doc jsonb NOT NULL CHECK (jsonb_typeof(doc) = 'object' AND doc->>'_id' = id));
ALTER TABLE public.hg_anonymous_identities ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.hg_anonymous_identities FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.hg_anonymous_identities TO service_role;
CREATE INDEX hg_anonymous_identities_created_idx ON public.hg_anonymous_identities ((doc->'createdAt'), id);
CREATE TABLE public.hg_membership_applications (id text PRIMARY KEY, doc jsonb NOT NULL CHECK (jsonb_typeof(doc) = 'object' AND doc->>'_id' = id));
ALTER TABLE public.hg_membership_applications ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.hg_membership_applications FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.hg_membership_applications TO service_role;
CREATE INDEX hg_membership_applications_created_idx ON public.hg_membership_applications ((doc->'createdAt'), id);
CREATE TABLE public.hg_invite_codes (id text PRIMARY KEY, doc jsonb NOT NULL CHECK (jsonb_typeof(doc) = 'object' AND doc->>'_id' = id));
ALTER TABLE public.hg_invite_codes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.hg_invite_codes FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.hg_invite_codes TO service_role;
CREATE INDEX hg_invite_codes_created_idx ON public.hg_invite_codes ((doc->'createdAt'), id);
CREATE TABLE public.hg_club_config (id text PRIMARY KEY, doc jsonb NOT NULL CHECK (jsonb_typeof(doc) = 'object' AND doc->>'_id' = id));
ALTER TABLE public.hg_club_config ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.hg_club_config FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.hg_club_config TO service_role;
CREATE INDEX hg_club_config_created_idx ON public.hg_club_config ((doc->'createdAt'), id);
CREATE UNIQUE INDEX hg_users_openid_idx ON public.hg_users ((doc->>'wxOpenIdRef'));
CREATE UNIQUE INDEX hg_memberships_user_club_idx ON public.hg_memberships ((doc->>'userId'), (doc->>'clubId'));
CREATE UNIQUE INDEX hg_applications_pending_idx ON public.hg_membership_applications ((doc->>'userId'), (doc->>'clubId')) WHERE doc->>'status' = 'pending';
CREATE INDEX hg_posts_feed_idx ON public.hg_posts ((doc->>'clubId'), (doc->>'status'), (doc->>'visibility'), (doc->'createdAt'));
CREATE INDEX hg_posts_owner_idx ON public.hg_posts ((doc->>'ownerId'), (doc->>'status'));
CREATE INDEX hg_review_tasks_status_idx ON public.hg_review_tasks ((doc->>'status'), (doc->'createdAt'));
CREATE INDEX hg_assets_owner_idx ON public.hg_assets ((doc->>'ownerId'), (doc->>'postId'));

-- All names and values are quoted; only this explicit list of tables is reachable.
CREATE FUNCTION public.hg_table(t text) RETURNS text LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  IF NOT (t = ANY(ARRAY['hg_users','hg_memberships','hg_posts','hg_comments','hg_reactions','hg_bookmarks','hg_topics','hg_topic_follows','hg_collections','hg_collection_entries','hg_consents','hg_assets','hg_notifications','hg_reports','hg_review_tasks','hg_audit_logs','hg_idempotency','hg_anonymous_identities','hg_membership_applications','hg_invite_codes','hg_club_config'])) THEN RAISE EXCEPTION 'invalid table'; END IF;
  RETURN format('public.%I', t);
END $$;
CREATE FUNCTION public.hg_field(k text) RETURNS text LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  IF k !~ '^[A-Za-z_][A-Za-z_0-9]*(\.[A-Za-z_][A-Za-z_0-9]*)*$' THEN RAISE EXCEPTION 'invalid field'; END IF;
  RETURN format('(doc #> %L::text[])', string_to_array(k, '.'));
END $$;
CREATE FUNCTION public.hg_filter(q jsonb) RETURNS text LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE k text; v jsonb; op text; rhs jsonb; f text; parts text[] := '{}'; subs text[]; item jsonb; atom text;
BEGIN
  IF q IS NULL OR q = '{}'::jsonb THEN RETURN 'TRUE'; END IF;
  IF jsonb_typeof(q) <> 'object' THEN RAISE EXCEPTION 'invalid filter'; END IF;
  FOR k,v IN SELECT * FROM jsonb_each(q) LOOP
    IF k IN ('$or', '$and') THEN
      subs := '{}';
      FOR item IN SELECT * FROM jsonb_array_elements(v) LOOP subs := array_append(subs, public.hg_filter(item)); END LOOP;
      atom := CASE WHEN cardinality(subs)=0 THEN CASE WHEN k='$and' THEN 'TRUE' ELSE 'FALSE' END ELSE '(' || array_to_string(subs, CASE WHEN k='$and' THEN ' AND ' ELSE ' OR ' END) || ')' END;
    ELSE
      f := public.hg_field(k);
      IF jsonb_typeof(v) = 'object' AND v ? '$op' THEN
        op := v->>'$op'; rhs := v->'value';
        IF op IN ('eq','neq','lt','lte','gt','gte') THEN
          atom := format('%s %s %L::jsonb', f, CASE op WHEN 'eq' THEN 'IS NOT DISTINCT FROM' WHEN 'neq' THEN 'IS DISTINCT FROM' WHEN 'lt' THEN '<' WHEN 'lte' THEN '<=' WHEN 'gt' THEN '>' ELSE '>=' END, rhs);
        ELSIF op IN ('in','nin') THEN
          atom := format('%s %s (SELECT value FROM jsonb_array_elements(%L::jsonb))', f, CASE op WHEN 'in' THEN 'IN' ELSE 'NOT IN' END, rhs);
          IF op='nin' THEN atom := '(' || f || ' IS NULL OR ' || atom || ')'; END IF;
        ELSIF op='exists' THEN atom := f || CASE WHEN rhs='true'::jsonb THEN ' IS NOT NULL' ELSE ' IS NULL' END;
        ELSIF op='regex' THEN atom := format('(%s #>> %L) %s %L', f, '{}', CASE WHEN v->>'options'='i' THEN '~*' ELSE '~' END, rhs #>> '{}');
        ELSE RAISE EXCEPTION 'unsupported filter operator'; END IF;
      ELSIF v='null'::jsonb THEN atom := '(' || f || ' IS NULL OR ' || f || ' = ''null''::jsonb)';
      ELSE atom := format('%s = %L::jsonb', f, v); END IF;
    END IF;
    parts := array_append(parts, atom);
  END LOOP;
  RETURN '(' || array_to_string(parts, ' AND ') || ')';
END $$;
CREATE FUNCTION public.hg_patch(original jsonb, patch jsonb) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE k text; v jsonb; p text[]; i int;
BEGIN
  FOR k,v IN SELECT * FROM jsonb_each(patch) LOOP
    IF k='_id' THEN RAISE EXCEPTION 'immutable id'; END IF;
    PERFORM public.hg_field(k); p := string_to_array(k,'.');
    FOR i IN 1..cardinality(p)-1 LOOP
      IF original #> p[1:i] IS NULL THEN original := jsonb_set(original,p[1:i],'{}'::jsonb,true); END IF;
    END LOOP;
    IF jsonb_typeof(v)='object' AND v->>'$op'='inc' THEN v := to_jsonb(COALESCE((original #>> p)::numeric,0)+(v->>'value')::numeric); END IF;
    original := jsonb_set(original,p,v,true);
  END LOOP;
  RETURN original;
END $$;
CREATE FUNCTION public.hg_store(p_table text, p_op text, p_query jsonb DEFAULT '{}', p_data jsonb DEFAULT '{}', p_order jsonb DEFAULT '[]', p_limit int DEFAULT 100) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE t text; w text; ordering text := ''; item jsonb; result jsonb; n bigint; ident text;
BEGIN
  t := public.hg_table(p_table); w := public.hg_filter(p_query);
  IF p_limit < 1 OR p_limit > 1000 THEN RAISE EXCEPTION 'invalid limit'; END IF;
  FOR item IN SELECT * FROM jsonb_array_elements(p_order) LOOP
    ordering := ordering || CASE WHEN ordering='' THEN ' ORDER BY ' ELSE ', ' END || public.hg_field(item->>0) || CASE WHEN item->>1='asc' THEN ' ASC' ELSE ' DESC' END;
  END LOOP;
  IF p_op='get' THEN
    EXECUTE format('SELECT COALESCE(jsonb_agg(doc), ''[]''::jsonb) FROM (SELECT doc FROM %s WHERE %s%s LIMIT %s) rows',t,w,ordering,p_limit) INTO result;
    RETURN jsonb_build_object('data',result);
  ELSIF p_op='count' THEN
    EXECUTE format('SELECT count(*) FROM %s WHERE %s',t,w) INTO n;
    RETURN jsonb_build_object('total',n);
  ELSIF p_op='add' THEN
    ident:= p_data->>'_id'; IF ident IS NULL OR length(ident)>256 THEN RAISE EXCEPTION 'invalid id'; END IF;
    EXECUTE format('INSERT INTO %s(id,doc) VALUES($1,$2)',t) USING ident,p_data;
    RETURN jsonb_build_object('_id',ident);
  ELSIF p_op='update' THEN
    IF p_query='{}'::jsonb THEN RAISE EXCEPTION 'unbounded update'; END IF;
    EXECUTE format('UPDATE %s SET doc=public.hg_patch(doc,$1) WHERE %s',t,w) USING p_data;
    GET DIAGNOSTICS n = ROW_COUNT; RETURN jsonb_build_object('stats',jsonb_build_object('updated',n));
  ELSIF p_op='remove' THEN
    IF p_query='{}'::jsonb THEN RAISE EXCEPTION 'unbounded delete'; END IF;
    EXECUTE format('DELETE FROM %s WHERE %s',t,w);
    GET DIAGNOSTICS n = ROW_COUNT; RETURN jsonb_build_object('stats',jsonb_build_object('removed',n));
  END IF;
  RAISE EXCEPTION 'unsupported operation';
END $$;

-- A committed idempotency row always has a result. Concurrent calls wait on the unique key;
-- process loss before commit rolls back the post, alias, asset bindings and review outbox together.
CREATE FUNCTION public.hg_create_post(p_key text, p_hash text, p_post jsonb, p_alias jsonb DEFAULT NULL) RETURNS jsonb
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
    IF asset IS NULL OR asset->>'ownerId' IS DISTINCT FROM owner_id OR asset->>'status'<>'verified' OR COALESCE(asset->>'postId','')<>'' THEN RAISE EXCEPTION 'ASSET_BINDING_CONFLICT'; END IF;
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
REVOKE ALL ON FUNCTION public.hg_table(text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.hg_table(text) TO service_role;
REVOKE ALL ON FUNCTION public.hg_field(text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.hg_field(text) TO service_role;
REVOKE ALL ON FUNCTION public.hg_filter(jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.hg_filter(jsonb) TO service_role;
REVOKE ALL ON FUNCTION public.hg_patch(jsonb,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.hg_patch(jsonb,jsonb) TO service_role;
REVOKE ALL ON FUNCTION public.hg_store(text,text,jsonb,jsonb,jsonb,int) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.hg_store(text,text,jsonb,jsonb,jsonb,int) TO service_role;
REVOKE ALL ON FUNCTION public.hg_create_post(text,text,jsonb,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.hg_create_post(text,text,jsonb,jsonb) TO service_role;
