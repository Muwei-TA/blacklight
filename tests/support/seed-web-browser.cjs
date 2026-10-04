// TEST FIXTURES ONLY: deterministic users and sample content for browser tests.
const { Pool } = require('pg');
const { createWebAuth } = require('../../server/web-auth');
const crypto = require('node:crypto');
if (!process.env.PG_WEB_TEST_URL) throw new Error('Set PG_WEB_TEST_URL to an isolated disposable database; this script writes fixtures.');
const pool = new Pool({connectionString:process.env.PG_WEB_TEST_URL});
(async()=>{
 const now=new Date().toISOString();
 await pool.query('DELETE FROM hg_web_auth_limits');
 for(const [id,name,role] of [['browser-editor','时雨','moderator'],['browser-reader','木白','member']]){
  await pool.query('INSERT INTO hg_users(id,doc) VALUES($1,$2) ON CONFLICT(id) DO UPDATE SET doc=EXCLUDED.doc',[id,{_id:id,wxOpenIdRef:`web:${id}`,displayName:name,status:'active',avatar:'',createdAt:now}]);
  await createWebAuth({database:pool,origin:'http://127.0.0.1:3000'}).provisionAccount({userId:id,username:id.replace('-','_'),password:'local browser password'});
 }
 const club='browser-heiguang';
 await pool.query('INSERT INTO hg_club_config(id,doc) VALUES($1,$2) ON CONFLICT(id) DO UPDATE SET doc=EXCLUDED.doc',[club,{_id:club,clubId:club,name:'黑光文学社',slogan:'文字不必完美，表达值得被看见。',intro:'在日常的缝隙里，为心事和灵感留一个角落。一起读，一起写，也一起照顾每一种表达。',description:'留一盏灯，给每一种表达。',status:'active',discoverable:true,rulesVersion:'v1.0',rules:'尊重每一种表达，不泄露他人隐私。回应请友善。',admissionMode:'invite_required',version:1,managementVersion:1,capabilities:{publishing:true,uploads:false,anthology:true,publicScope:false,video:false},createdAt:now}]);
 for(const [user,role] of [['browser-editor','moderator'],['browser-reader','member']]) await pool.query('INSERT INTO hg_memberships(id,doc) VALUES($1,$2) ON CONFLICT(id) DO UPDATE SET doc=EXCLUDED.doc',[`${user}:${club}`,{_id:`${user}:${club}`,userId:user,clubId:club,status:'active',role,version:1,joinedAt:now}]);
 for(const [id,title,description,category] of [['browser-topic','最近读到的一句话','有些句子，会在心里停留很久。分享你最近读到的那一句。','reading'],['browser-topic2','收集生活的小确幸','在普通的一天里，也会遇见小小的光。','life']]) await pool.query('INSERT INTO hg_topics(id,doc) VALUES($1,$2) ON CONFLICT(id) DO UPDATE SET doc=EXCLUDED.doc',[id,{_id:id,clubId:club,title,description,category,categoryText:category==='reading'?'阅读':'生活',status:'active',createdAt:now}]);
 await pool.query('INSERT INTO hg_boards(id,doc) VALUES($1,$2) ON CONFLICT(id) DO UPDATE SET doc=EXCLUDED.doc',['browser-board',{_id:'browser-board',clubId:club,title:'日常拾光',description:'把平凡的日子，写成自己的故事。',status:'active',createdAt:now}]);
 await pool.query('INSERT INTO hg_collections(id,doc) VALUES($1,$2) ON CONFLICT(id) DO UPDATE SET doc=EXCLUDED.doc',['browser-collection',{_id:'browser-collection',clubId:club,title:'在秋天写一封信',subtitle:'2026 · 秋日文集',intro:'写给一个人，或写给此刻的自己。',visibility:'club',entryCount:0,createdAt:now}]);
 const texts=[['browser-post1','fragment','', '今天傍晚走过图书馆，窗边的光刚好落在一本摊开的书上。\n\n那一刻突然觉得，日子虽然很忙，但总有一些细小的事，值得慢下来。','named','browser-topic2'],['browser-post2','article','在平凡的日子里，寻找一点光','我们总在等一个特别的时刻，却忘了大多数故事都从平凡开始。\n\n给今天留一页纸，写下路过的风、偶然听见的歌，和那些还没说出口的话。','named','browser-topic'],['browser-post3','fragment','','最近总想写点什么，却不知道从哪里开始。\n也许这两句话本身，就是一个开始。','anonymous','']];
 let index=0;
 for(const [id,kind,title,body,identityMode,topicId] of texts){const createdAt=new Date(Date.now()-(++index)*3600000).toISOString();await pool.query('INSERT INTO hg_posts(id,doc) VALUES($1,$2) ON CONFLICT(id) DO UPDATE SET doc=EXCLUDED.doc',[id,{_id:id,clubId:club,ownerId:'browser-editor',kind,title,body,identityMode,visibility:'club',status:'published',version:1,commentsEnabled:true,assetIds:[],topicId,boardId:'browser-board',reactionCount:0,commentCount:0,createdAt,updatedAt:createdAt}]);}
 console.log('Isolated browser fixtures ready; two local test accounts and three sample posts.');
 await pool.end();
})().catch(e=>{console.error(e.code||e.message);process.exit(1)});
