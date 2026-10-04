# 黑光树洞网站：运行与迁移

实现位于 `codex/web-migration-20261004`，基于前端 `90e84df`、后端 `16ce74d`。网站源代码在后端仓库 `web/`；原小程序仓库用于业务对照，不需要复制或编译小程序代码。

## 已接通的功能

- 账号密码注册、登录、改密、退出；昵称设置、注销申请。
- 社团目录与切换、规则阅读、邀请码入社、申请取消。
- 树洞与权限内搜索、署名/匿名/仅自己/能力允许时公开发布、文章和短笔。
- 详情、共鸣、收藏、一级回应及对一级回应的回复、回应删除、举报、缩小范围、删除、退回重提和申诉。
- 话题/板块浏览、详情、创建和话题关注；文集目录、作品投稿与授权撤回。
- 个人作品状态列表、收藏、签到、站内消息、换届和管理员恢复确认。
- 原管理台的审核、成员、邀请码、设置、团队、换届、审计和平台治理，通过网站账号登录。

浏览器端仅保存选中社团标识这一项偏好；Cookie 为 HttpOnly，CSRF 令牌在内存。网站不会自动绑定同昵称的微信账号，不会把合成身份当成微信 openid。

产品经理模拟审阅后的体验优化包括：发布/重提的浏览器历史离开确认、私密保存反馈、登录/注册后继续原任务、注册时另页阅读隐私、从消息/收藏阅读后返回来源，以及取消回复对象时保留正文。审阅方法与验收见 [产品体验审阅记录](evidence/2026-10-04-product-review/README.md)。草稿只保留在当前页面；确认丢弃或刷新离开后不提供持久恢复。

## 本地运行

需要 Node >=20 与 PostgreSQL 16。首次安装：

```sh
npm ci
npm run sync
```

先执行数据库迁移（下一节），然后配置环境。开发配置示例用于独立测试数据库：

```sh
export NODE_ENV=development
export REVIEW_PROVIDER=manual
export DATABASE_URL='postgresql://blacklight_app:YOUR_URL_ENCODED_PASSWORD@127.0.0.1:5432/blacklight'
export PUBLIC_API_BASE_URL='http://127.0.0.1:3000'
export ANON_ALIAS_SECRET='YOUR_RANDOM_SECRET_AT_LEAST_32_BYTES'
export MEDIA_URL_SECRET='ANOTHER_RANDOM_SECRET_AT_LEAST_32_BYTES'
export NAS_MEDIA_DIR='/absolute/path/to/private-media'
npm run dev:start
```

另一个终端使用同一组配置执行 `npm run dev:worker`。成员端：`http://127.0.0.1:3000/`；管理台：`http://127.0.0.1:3000/admin/`。纯网站人工审核模式不需要小程序 AppID/AppSecret。生产配置要求 HTTPS。

## 新数据库：Docker Compose

```sh
cp deploy/web/.env.example deploy/web/.env
# 填入真实域名和随机 secret；数据库密码用随机字母数字以避免 URL 转义问题。
docker compose --env-file deploy/web/.env -f deploy/web/compose.yaml up -d --build
```

PostgreSQL 和 worker 只接内部网络；API 同时连接接入网络，默认绑定主机 `127.0.0.1:3000`。使用 Caddy/Nginx 将真实 HTTPS 域名同域反代至该端口。`deploy/web/Caddyfile.example` 是同主机 Caddy 示例；如果反代也在容器中，应加入 API 网络并将地址改成服务名。

`PUBLIC_API_BASE_URL` 必须与浏览器实际访问来源一致（scheme + host + port），不能填写后端内部地址。Cookie、CSRF、媒体链接依赖它。不要把 HTTPS 检查改成全局允许 HTTP；开发 HTTP 只允许 loopback，原 NAS 固定 LAN 模式单独保留。

数据库镜像仅包含迁移和初始化脚本，不挂载整份源码仓库；应用镜像明确设置代码读取权限，服务以普通用户运行。

同主机 Caddy 反代的来源由 `WEB_TRUSTED_PROXY_IPS` 精确匹配 Docker 网关地址，默认 `172.28.42.1`。仅对可信来源读取最右侧 `X-Forwarded-For`，其他来源忽略该请求头；账号和来源限频同时生效。如网段冲突，同步修改 `.env` 中 `WEB_NETWORK_SUBNET`、`WEB_PROXY_GATEWAY` 和 `WEB_TRUSTED_PROXY_IPS`。容器内反代需指定其固定 IP 为可信来源，不能配置通配信任。

`init-db.sh` 仅在新 PostgreSQL volume 首次创建时运行。复用现有数据卷时必须显式执行增量迁移，不能期待换镜像自动升级。

## 已有 NAS 数据库：增量升级

先备份数据库和私有媒体，再更新代码与同步 shared。新增迁移有：

- `cloudbase/migrations/20261004090000_web_accounts.sql` 新增网站账号、会话和限频表。
- `cloudbase/migrations/20261004100000_fix_platform_club_advisory_lock.sql` 修复平台创建社团时的 advisory lock 键表达式，不修改既有数据。

两项迁移均不改写既有用户、成员资格或作品。数据库登录角色必须有 `service_role` 权限，普通客户端角色没有新表权限。

现有 NAS 的 `scripts/local-apply-migrations.sh` 现验证 29 个迁移；最新文件为 `20261004110000_rich_article_drafts.sql`，`scripts/local-migration-lib.mjs` 的 inventory 为 37 个源表。建议使用现有部署的迁移命令和校验账本，在数据库容器中设置 `LOCAL_MIGRATIONS_DIR`、`LOCAL_COMPAT_DIR`、`NAS_APP_DATABASE_PASSWORD_FILE`、`POSTGRES_USER`、`POSTGRES_DB` 后执行脚本。它会跳过已有且 checksum 一致的迁移，并在事务中执行新迁移和登记账本。

只用 `psql -f` 执行新 SQL 不会自动更新 NAS 的 `nas_meta.schema_migrations`，NAS 健康检查仍会失败。不要编辑旧迁移绕过 checksum。网站 Compose 的初始化也复用同一迁移脚本与账本。

## 第一个管理员

1. 在网站注册自己的账号。
2. 登录后进入「我的」，复制用户标识（不使用昵称代替 ID）。
3. 运维人员在后端环境运行既有平台角色工具，指定准确 ID：

```sh
node scripts/local-platform-role.mjs --user-id USER_ID --role developer --expected-role none --reason '为网站初始化指定平台管理账号' --operator OPERATOR_NAME
```

4. 重新读取页面，在「我的」进入管理台，创建社团并指定负责人，或将账号加入已有社团的管理团队。现有平台管理界面和权限规则不变。创建后通过管理员开通发布等能力，默认关闭的能力不会自动开启。

账号注册接口忽略用户提交的角色，不能公开自授管理员。示例浏览器测试账号只存在于隔离测试数据库，不能用于生产初始化。

## 旧小程序账号绑定 / 密码遗忘

由运维核实真实用户身份后，用原用户 ID 配置网站账号；原来的作品、成员资格和匿名映射均保留。

```sh
# 准备仅当前运维用户可读的密码文件，避免密码出现在命令参数或 shell 历史。
export WEB_ACCOUNT_PASSWORD_FILE='/secure/path/to/temporary-password'
node scripts/local-web-account.mjs --user-id EXISTING_USER_ID --username reader_name
```

工具要求已经存在、仍为 active 且有内部身份引用的用户。一个用户只允许一个网站账号；重置必须使用原账号名称，不会抢占另一用户的账号。执行后撤销全部网站会话。密码文件不提交仓库，完成后由运维清理，并请用户改密。网站首版没有自助邮箱/短信找回功能。

## 审核和图片

`REVIEW_PROVIDER=manual` 时，文本立即进入原人工审核队列，待审内容不进入普通成员信息流。具有权限的审核员登录 `/admin/` 批准作品和回应。新网站身份不调用要求微信 openid 的文本检查，即便配置了微信服务也转人工。自动化服务故障不会自动放行。

人工模式网站关闭图片/视频上传入口和资产 API。已审核历史图片仍经原签名授权链路读取。如继续使用现有微信图片检查，配置 `REVIEW_PROVIDER=wechat`、有效的微信凭据和社团 uploads 能力，网页已有 JPEG/PNG 上传、清洗与检查流程；这条真实第三方审核链路未在本次调用验收。完全脱离微信的图片自动审核、人工图片审核和视频处理需要后续接入。不要在仅有人工文本审核时打开 uploads。

公开可见和导出能力仍由后端开关控制；现有“导出”尚未生成可下载文件，因此网站没有显示虚假的下载入口。上线前运营者应补齐隐私说明中的真实联系渠道，确认部署地区对应的网站备案要求。

## 备份与会话清理

同时备份 PostgreSQL 与私有媒体。包含网站凭据的数据库备份属于私密运维资料，不得放在公开下载目录。原 NAS 备份脚本的迁移数量也已更新为 29。网站 Compose 可停 API 和 worker 后，在 DB 容器运行 `pg_dump`，并保存 private-media volume；恢复到独立数据库后验证迁移账本和媒体清单。不要删除现有数据卷来“重跑初始化”。worker 每日清理过期/撤销的网站会话与旧限频桶。

## 自动验证

```sh
npm test
npm run check
npm run lint
# 显式使用可丢弃的、已迁移的测试数据库；该用例清理测试表中的限频记录。
PG_WEB_TEST_URL='postgresql://...' node --test tests/integration/web-migration-pg.test.mjs
```

浏览器用例在 `tests/browser/web-smoke.mjs`，要求显式 loopback URL 和 Playwright 路径。可用 `tests/support/seed-web-browser.cjs` 在可丢弃数据库生成测试夹具，之后运行网站服务；脚本拒绝公共网站地址。

```sh
PG_WEB_TEST_URL='postgresql://...' node tests/support/seed-web-browser.cjs
WEB_BROWSER_BASE=http://127.0.0.1:3000 PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node tests/browser/web-smoke.mjs
```

结果和截图在 `docs/evidence/2026-10-04-web/`。这些是本地开发验收证据，不代表已有生产数据库迁移或公网部署。

产品体验回归脚本 `tests/browser/product-experience.mjs` 另需本轮截图夹具（收藏、消息、一级回应与非成员账号），在同一隔离测试环境显式运行：

```sh
WEB_BROWSER_BASE=http://127.0.0.1:3000 PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs WEB_BROWSER_EVIDENCE=/tmp/blacklight-product-review node tests/browser/product-experience.mjs
```

它验证 8 个场景，并自行删除本轮新建的私密验收文章；截图账号只在隔离库使用。复现初审缺陷的脚本与修复后的验收脚本作用不同，不能将初审的“观察到缺陷”当作修复通过。


## 图文文章升级（第 29 项迁移）

`20261004110000_rich_article_drafts.sql` 在原 28 项校验和保持不变的基础上增加 `hg_article_drafts` 与服务角色 RPC，并包装图片意图、孤儿清理和人工审核事务。旧帖子、纯文本创建、自动审核和旧客户端读取继续使用原数据结构；新文章补充 `format: richtext-v1`、`richDoc`、`summary`、`coverAssetId`，并保留服务端派生的 `body`、`paragraphs`、`media.images`。

迁移前同时备份数据库和私有媒体并在隔离库恢复验证，暂停 API 写入及 worker 后执行现有增量迁移脚本。它只追加第 29 项并核对前 28 项校验和。新 API 与 worker 必须同批切换；worker 的草稿引用保护是此功能的必要部分。回退旧 worker 前必须验证它仍调用新迁移的 `hg_cleanup_asset` 包装保护；否则其孤儿扫描会包含超过 24 小时的草稿图片。回退需先停 worker 并关闭新编辑入口，保留新数据库表、媒体卷和原镜像，不删除草稿。

网站 `REVIEW_PROVIDER=manual` 下普通短笔仍不开放图片，`session/me.capabilities.uploads=false`；独立文章编辑器使用 `richUploads`，其值来自社团实际上传能力。JPEG/PNG 经过限额、解码和清洗后保持 `uploaded`，不因清洗直接公开。文章人工批准在单个数据库事务内检查当前版本、任务与所有图片，再将图片标记 `verified` 并发布；失败整笔回滚。私密文章不进入审核队列，图片只允许作者读取。

草稿动作走既有 Cookie/CSRF 通道，服务端注入的网站渠道标记阻止普通 Bearer 或微信云函数直接进入富文写作链路；`drafts/save` 使用版本 CAS，`drafts/submit` 带幂等键。退回文章通过带 `sourcePostId/sourcePostVersion` 的草稿保留原图，再调用 `posts/resubmit-rich`，保持原作者、社团、可见范围、身份、话题和板块。旧 `posts/resubmit` 对富文返回明确错误。媒体 `/v1/web/media/:assetId` 每次检查当前社团资格、草稿或帖子版本及资产归属，并返回 `private, no-store`；审核员只能预览已投稿的当前待审版本，平台 developer 身份不提供社团内容例外。

隔离验证可用 `PG_TEST_URL=postgresql://muwei@127.0.0.1:55432/blacklight_test HG_TEST_DATABASE_RESET=yes node --test tests/integration/rich-articles-pg.test.mjs`。该测试只允许 loopback 的 disposable `blacklight_test` 数据库，并通过本机 HTTP Cookie/CSRF 执行合成账号、草稿 CAS、图片上传、24 小时保护、联合人工审核、拒绝重提与私密读取；不代表真实 NAS、浏览器页面或真机验收。
