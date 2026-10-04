import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
const require = createRequire(import.meta.url);
const connectionString = process.env.PG_TEST_URL;
const enabled = Boolean(connectionString);
if (enabled) {
  const url = new URL(connectionString);
  assert.ok(['127.0.0.1','localhost'].includes(url.hostname) && url.pathname === '/blacklight_test' && process.env.HG_TEST_DATABASE_RESET === 'yes', 'isolated loopback test database required');
}
test('rich articles: CAS, sanitized upload, protected drafts, joint review, private media, and resubmit', { skip: !enabled }, async (t) => {
  process.env.DATABASE_URL = connectionString;
  process.env.RUNTIME_KIND = 'nas';
  process.env.REVIEW_PROVIDER = 'manual';
  process.env.NODE_ENV = 'test';
  process.env.ANON_ALIAS_SECRET = 'isolated-rich-article-fixture-secret';
  process.env.NAS_MEDIA_DIR = '/tmp/blacklight-rich-editor-pgtest-20261004/media';
  const pg = require('../../shared/pg-store');
  await pg.query('DELETE FROM hg_web_auth_limits');
  const apiPg = require('../../cloudfunctions/api/shared/pg-store');
  const { createServer } = require('../../server/index');
  const server = createServer();
  await new Promise((r) => server.listen(0,'127.0.0.1',r));
  const base = `http://127.0.0.1:${server.address().port}`;
  process.env.PUBLIC_API_BASE_URL = base;
  const tag = crypto.randomBytes(4).toString('hex');
  const clubId = `rich-${tag}`;
  const secondClub = `rich-other-${tag}`;
  const userIds = [];
  t.after(async () => {
    await new Promise((r) => server.close(r));
    await pg.query("DELETE FROM hg_sessions WHERE openid_ref IN (SELECT doc->>'wxOpenIdRef' FROM hg_users WHERE id=ANY($1))",[userIds]);
    for (const { table_name: name } of (await pg.query("SELECT table_name FROM information_schema.columns WHERE table_schema='public' AND column_name='doc' AND table_name LIKE 'hg_%'")).rows) {
      await pg.query(`DELETE FROM public.${name} WHERE doc->>'clubId'=ANY($1) OR id=ANY($1)`,[[clubId,secondClub]]);
    }
    await pg.query('DELETE FROM hg_users WHERE id=ANY($1)',[userIds]);
    await pg.close(); await apiPg.close(); await require('../../cloudfunctions/worker/shared/pg-store').close();
  });
  function client() {
    let cookie = '', csrf = '';
    return {
      async call(path, body) {
        const res = await fetch(base+path,{ method:body?'POST':'GET', headers:{ ...(body?{'Content-Type':'application/json',Origin:base,'X-CSRF-Token':csrf}:{}),Cookie:cookie },...(body?{body:JSON.stringify(body)}:{}) });
        if (res.headers.get('set-cookie')) cookie=res.headers.get('set-cookie').split(';')[0];
        const json=await res.json(); if(json.data?.csrfToken) csrf=json.data.csrfToken;
        return { status:res.status,...json };
      },
      action(action,payload={},club=clubId){return this.call('/v1/web/action',{action,payload,clubId:club});},
      image(url){return fetch(base+url,{headers:{Cookie:cookie}});},
    };
  }
  const author=client(), reviewer=client(), reader=client(), outsider=client();
  const now=new Date().toISOString();
  for(const id of [clubId,secondClub]) await pg.query('INSERT INTO hg_club_config(id,doc) VALUES($1,$2)',[id,{_id:id,clubId:id,name:'图文测试',status:'active',usageLimits:{userUploadDailyBytes:20971520,clubUploadDailyBytes:209715200,reviewDailyCalls:1000,warningRatio:0.8},capabilities:{publishing:true,uploads:true,publicScope:false},createdAt:now}]);
  for (const [index, person] of [author,reviewer,reader,outsider].entries()) {
    const result=await person.call('/v1/web/auth/register',{username:`rich_${tag}_${index}`,password:'isolated test password 123',displayName:`fixture-${index}`});
    assert.equal(result.code,0,JSON.stringify(result));
    const me=await person.call('/v1/web/session'); const id=me.data.user.id; userIds.push(id);
    const c=index===3?secondClub:clubId;
    await pg.query('INSERT INTO hg_memberships(id,doc) VALUES($1,$2)',[`${id}:${c}`,{_id:`${id}:${c}`,clubId:c,userId:id,status:'active',role:index===1?'moderator':'member',version:1}]);
  }
  const doc=(assetId)=>({type:'doc',content:[{type:'heading',attrs:{level:2},content:[{type:'text',text:'开篇'}]},{type:'paragraph',content:[{type:'text',text:'第一段'}]},...(assetId?[{type:'assetImage',attrs:{assetId,alt:'图',caption:'题注'}}]:[]),{type:'paragraph',content:[{type:'text',text:'结尾'}]}]});
  const saved=await author.action('drafts/save',{title:'测试文章',summary:'完整摘要',richDoc:doc(),settings:{visibility:'club',identityMode:'named'}});
  assert.equal(saved.code,0,JSON.stringify(saved)); let draft=saved.data;
  const authorIdentity=(await pg.query("SELECT doc->>'wxOpenIdRef' AS openid FROM hg_users WHERE id=$1",[userIds[0]])).rows[0].openid;
  const moderatorIdentity=(await pg.query("SELECT doc->>'wxOpenIdRef' AS openid FROM hg_users WHERE id=$1",[userIds[1]])).rows[0].openid;
  const bearer=await require('../../server/auth').issueSession(authorIdentity);
  const moderatorBearer=await require('../../server/auth').issueSession(moderatorIdentity);
  async function bearerCall(action,payload={},token=bearer.token) {
    const response=await fetch(base+'/v1/action',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`},body:JSON.stringify({action,clubId,payload:{...payload,channel:'web'},channel:'web',webIdentity:{openid:authorIdentity,channel:'web'}})});
    return response.json();
  }
  assert.equal((await bearerCall('session/me')).data.memberStatus,'active');
  for(const action of ['drafts/list','drafts/get','drafts/save','drafts/delete','drafts/submit','posts/resubmit-rich']) {
    const denied=await bearerCall(action,{...draft,id:draft.id,draftId:draft.id,expectedVersion:draft.version,idempotencyKey:crypto.randomUUID()});
    assert.equal(denied.code,'forbidden',action);
  }
  assert.equal((await bearerCall('admin/content/detail',{id:'no-post',expectedVersion:1},moderatorBearer.token)).code,'forbidden');
  assert.equal((await bearerCall('assets/intent',{draftId:draft.id,mediaType:'image',size:4,mimeType:'image/jpeg',idempotencyKey:crypto.randomUUID()})).code,'forbidden');
  assert.equal((await reader.action('drafts/get',{id:draft.id})).status,404);
  assert.equal((await author.action('drafts/get',{id:draft.id},secondClub)).status,403);
  const edits=await Promise.all([1,2].map(()=>author.action('drafts/save',{...draft,expectedVersion:draft.version})));
  assert.deepEqual(edits.map(x=>x.status).sort(),[200,409]); draft=edits.find(x=>x.code===0).data;
  const jpeg=require('jpeg-js').encode({data:Buffer.from([255,0,0,255,0,255,0,255,0,0,255,255,255,255,255,255]),width:2,height:2},80).data;
  const intent=await author.action('assets/intent',{draftId:draft.id,mediaType:'image',size:jpeg.length,mimeType:'image/jpeg',idempotencyKey:crypto.randomUUID()});
  assert.equal(intent.code,0,JSON.stringify(intent)); const assetId=intent.data.assetId;
  assert.equal((await bearerCall('assets/upload',{assetId,contentBase64:jpeg.toString('base64'),idempotencyKey:crypto.randomUUID()})).code,'forbidden');
  assert.equal((await bearerCall('assets/confirm',{assetId})).code,'forbidden');
  const upload=await author.action('assets/upload',{assetId,contentBase64:jpeg.toString('base64'),idempotencyKey:crypto.randomUUID()});
  assert.equal(upload.code,0,JSON.stringify(upload)); assert.equal(upload.data.status,'uploaded');
  assert.equal((await author.action('assets/confirm',{assetId})).data.status,'uploaded');
  draft=(await author.action('drafts/save',{...draft,expectedVersion:draft.version,richDoc:doc(assetId),coverAssetId:assetId,body:'forged',assetIds:[]})).data;
  assert.equal(draft.body.includes('forged'),false); assert.deepEqual(draft.assetIds,[assetId]);
  const stolen = await author.action('drafts/save',{title:'其他草稿盗用资产',richDoc:doc(assetId),settings:{visibility:'club'}});
  assert.equal(stolen.status,409);
  assert.equal((await author.action('drafts/get',{id:draft.id})).data.version,draft.version);
  const preview=draft.assets[0].url;
  assert.equal((await author.image(preview)).status,200);
  assert.equal((await reviewer.image(preview)).status,404);
  assert.equal((await outsider.image(preview)).status,404);
  await pg.query("UPDATE hg_assets SET doc=doc||jsonb_build_object('createdAt','2020-01-01T00:00:00Z') WHERE id=$1",[assetId]);
  const abandonedIntent=await author.action('assets/intent',{draftId:draft.id,mediaType:'image',size:jpeg.length,mimeType:'image/jpeg',idempotencyKey:crypto.randomUUID()});
  const abandonedId=abandonedIntent.data.assetId;
  assert.equal((await author.action('assets/upload',{assetId:abandonedId,contentBase64:jpeg.toString('base64'),idempotencyKey:crypto.randomUUID()})).code,0);
  const leasedIntent=await author.action('assets/intent',{draftId:draft.id,mediaType:'image',size:jpeg.length,mimeType:'image/jpeg',idempotencyKey:crypto.randomUUID()});
  await pg.query("UPDATE hg_assets SET doc=doc||jsonb_build_object('createdAt','2020-01-01T00:00:00Z') WHERE id=$1",[abandonedId]);
  await pg.query("UPDATE hg_assets SET doc=doc||jsonb_build_object('createdAt','2020-01-01T00:00:00Z','uploadLeaseUntil',(clock_timestamp()+interval '5 minutes')::text) WHERE id=$1",[leasedIntent.data.assetId]);
  const cleanup=require('../../cloudfunctions/worker/tasks/cleanup');
  const cleaned=await cleanup.cleanupOrphanAssets(clubId);
  assert.equal(cleaned.removed,1);
  assert.equal((await pg.query('SELECT id FROM hg_assets WHERE id=$1',[abandonedId])).rows.length,0);
  assert.equal((await pg.query('SELECT id FROM hg_assets WHERE id=$1',[leasedIntent.data.assetId])).rows.length,1);
  assert.equal((await author.image(preview)).status,200);
  const blockedKey=crypto.randomUUID();
  await pg.query("UPDATE hg_assets SET doc=doc||jsonb_build_object('status','rejected') WHERE id=$1",[assetId]);
  const blockedSubmit=await author.action('drafts/submit',{id:draft.id,expectedVersion:draft.version,idempotencyKey:blockedKey});
  assert.equal(blockedSubmit.status,409);
  assert.equal((await author.action('drafts/get',{id:draft.id})).data.status,'draft');
  assert.equal((await pg.query("SELECT count(*)::int AS n FROM hg_posts WHERE doc->>'clubId'=$1",[clubId])).rows[0].n,0);
  await pg.query("UPDATE hg_assets SET doc=doc||jsonb_build_object('status','uploaded') WHERE id=$1",[assetId]);
  const key=crypto.randomUUID();
  const submission={id:draft.id,expectedVersion:draft.version,idempotencyKey:key};
  const results=await Promise.all([author.action('drafts/submit',submission),author.action('drafts/submit',submission)]);
  assert.ok(results.every(x=>x.code===0),JSON.stringify(results)); assert.equal(results[0].data.id,results[1].data.id);
  let post=results[0].data;
  const adminDetail=await reviewer.action('admin/content/detail',{id:post.id,expectedVersion:post.version});
  assert.equal(adminDetail.code,0,JSON.stringify(adminDetail)); assert.deepEqual(adminDetail.data.richDoc,doc(assetId));
  assert.equal((await reviewer.image(adminDetail.data.assets[0].url)).status,200);
  assert.equal((await reader.image(adminDetail.data.assets[0].url)).status,404);
  const rejected=await reviewer.action('admin/content/decide',{id:post.id,expectedVersion:post.version,decision:'reject',reason:'请完善正文'});
  assert.equal(rejected.code,0,JSON.stringify(rejected)); post={...post,version:rejected.data.version};
  assert.equal((await author.action('posts/resubmit',{id:post.id,expectedVersion:post.version,title:'plain',body:'bad',idempotencyKey:crypto.randomUUID()})).code,'invalid_input');
  const revision=await author.action('drafts/save',{title:'修订文章',summary:'摘要',richDoc:doc(assetId),coverAssetId:assetId,sourcePostId:post.id,sourcePostVersion:post.version,settings:{visibility:'club',identityMode:'named'}});
  assert.equal(revision.code,0,JSON.stringify(revision));
  await pg.query("UPDATE hg_posts SET doc=doc||jsonb_build_object('version',$2::int) WHERE id=$1",[post.id,post.version+2]);
  const staleDraftAttempt=await author.action('posts/resubmit-rich',{id:post.id,expectedVersion:post.version+2,draftId:revision.data.id,idempotencyKey:crypto.randomUUID()});
  assert.equal(staleDraftAttempt.status,409);
  await pg.query("UPDATE hg_posts SET doc=doc||jsonb_build_object('version',$2::int) WHERE id=$1",[post.id,post.version]);
  const extraIntent=await author.action('assets/intent',{draftId:revision.data.id,mediaType:'image',size:jpeg.length,mimeType:'image/jpeg',idempotencyKey:crypto.randomUUID()});
  const extraId=extraIntent.data.assetId;
  assert.equal((await author.action('assets/upload',{assetId:extraId,contentBase64:jpeg.toString('base64'),idempotencyKey:crypto.randomUUID()})).code,0);
  const withExtra=doc(assetId); withExtra.content.push({type:'assetImage',attrs:{assetId:extraId,alt:'第二张',caption:''}});
  assert.equal((await author.action('drafts/save',{...revision.data,richDoc:withExtra,expectedVersion:revision.data.version})).code,0);
  const resubmit={id:post.id,expectedVersion:post.version,draftId:revision.data.id,idempotencyKey:crypto.randomUUID()};
  const resubmitted=await author.action('posts/resubmit-rich',resubmit);
  assert.equal(resubmitted.code,0,JSON.stringify(resubmitted)); post=resubmitted.data;
  assert.equal((await author.action('posts/resubmit-rich',resubmit)).data.id,post.id);
  const brokenId=[assetId,extraId].sort().at(-1);
  await pg.query("UPDATE hg_assets SET doc=doc||jsonb_build_object('postVersion',999) WHERE id=$1",[brokenId]);
  const failedApprove=await reviewer.action('admin/content/decide',{id:post.id,expectedVersion:post.version,decision:'approve'});
  assert.notEqual(failedApprove.code,0);
  const afterFailure=await pg.query("SELECT doc->>'status' AS status FROM hg_assets WHERE id=ANY($1)",[[assetId,extraId]]);
  assert.deepEqual(afterFailure.rows.map((r)=>r.status),['uploaded','uploaded']);
  assert.equal((await author.action('posts/detail',{id:post.id})).data.status,'pending');
  await pg.query("UPDATE hg_assets SET doc=doc||jsonb_build_object('postVersion',$2::int) WHERE id=$1",[brokenId,post.version]);
  const approved=await reviewer.action('admin/content/decide',{id:post.id,expectedVersion:post.version,decision:'approve'});
  assert.equal(approved.code,0,JSON.stringify(approved));
  const read=await reader.action('posts/detail',{id:post.id});
  assert.equal(read.code,0,JSON.stringify(read)); assert.equal(read.data.status,'published'); assert.equal(read.data.assets[0].status,'verified');
  const media=await reader.image(read.data.assets[0].url); assert.equal(media.status,200); assert.equal(media.headers.get('cache-control'),'private, no-store');
  assert.equal((await outsider.image(read.data.assets[0].url)).status,404);
  await pg.query("UPDATE hg_posts SET doc=doc||jsonb_build_object('visibility','public') WHERE id=$1",[post.id]);
  assert.equal((await fetch(base+read.data.assets[0].url)).status,200);
  await pg.query("UPDATE hg_posts SET doc=doc||jsonb_build_object('visibility','club') WHERE id=$1",[post.id]);
  assert.equal((await fetch(base+read.data.assets[0].url)).status,404);
  // A private draft never appears in the queue and its quarantined image is author-only.
  const invalidPrivate=await author.action('drafts/save',{title:'非法私密关联',richDoc:doc(),settings:{visibility:'private',topicId:'some-topic'}});
  assert.equal(invalidPrivate.code,'invalid_input');
  const privateDraft=(await author.action('drafts/save',{title:'私密图文',richDoc:doc(),settings:{visibility:'private'}})).data;
  const privateIntent=await author.action('assets/intent',{draftId:privateDraft.id,mediaType:'image',size:jpeg.length,mimeType:'image/jpeg',idempotencyKey:crypto.randomUUID()});
  const privateAsset=privateIntent.data.assetId;
  assert.equal((await author.action('assets/upload',{assetId:privateAsset,contentBase64:jpeg.toString('base64'),idempotencyKey:crypto.randomUUID()})).code,0);
  const privateSaved=(await author.action('drafts/save',{...privateDraft,expectedVersion:privateDraft.version,richDoc:doc(privateAsset)})).data;
  const privatePost=await author.action('drafts/submit',{id:privateSaved.id,expectedVersion:privateSaved.version,idempotencyKey:crypto.randomUUID()});
  assert.equal(privatePost.code,0,JSON.stringify(privatePost)); assert.equal(privatePost.data.state,'private_saved');
  const privateDetail=(await author.action('posts/detail',{id:privatePost.data.id})).data;
  assert.equal((await author.image(privateDetail.assets[0].url)).status,200);
  assert.equal((await reviewer.image(privateDetail.assets[0].url)).status,404);
  assert.equal((await reviewer.action('admin/content/detail',{id:privatePost.data.id,expectedVersion:1})).status,404);
  assert.equal((await author.action('posts/visibility',{id:privatePost.data.id,expectedVersion:1,visibility:'club'})).status,403);
});
