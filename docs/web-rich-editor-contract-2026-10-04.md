# 网站文章富文本编辑契约（2026-10-04）

本工作从 `a4aae27` 的独立网站版本开始。目标是网站文章的完整图文编辑：沉浸写作、结构化富文本、正文内图片、服务端草稿、发布设置、全文人工审核和按正文顺序阅读。短笔与现有小程序契约保持兼容。参考机核文章编辑器的层级与流程，不复制其品牌、嵌入代码、视频、定时发布或商业功能。

## 编辑与持久化

- 富文格式 `richtext-v1`，使用 Tiptap/ProseMirror JSON：顶层 `{type:'doc',content:[...]}`。允许 `paragraph`、`heading`（只限 2/3 级）、`blockquote`、`bulletList`、`orderedList`、`listItem`、`horizontalRule`、`hardBreak`、`text`、自定义 `assetImage`；文字 mark 只允许 `bold`、`italic`、`strike`、`link`。`assetImage.attrs` 只持久化 `assetId`、`alt`、`caption`，图片为正文顺序中的块。
- 服务端统一规范化并验证 JSON，拒绝未知节点/mark/属性、任意 HTML/CSS、脚本协议、外链图片和过深/过大的树。链接仅 `http:`/`https:`。正文纯文本 `body`、`assetIds` 必须从规范化文档与 `coverAssetId` 在服务端推导，不能接受客户端伪造的投影。保留 `body` 供搜索、旧小程序及审核文本降级使用。
- 文章附加 `summary`（最多 300 字）、可选 `coverAssetId`（必须属于同一篇草稿的图片资产）。标题最多 60 字，正文纯文本最多 20,000 字，图片最多 9 张，JSON 另有限额；短笔仍使用原表单与 `posts/create`。
- 浏览器端富文本库从已锁定 npm 包构建成本地 bundle，生产页面不依赖 CDN；构建只从本仓打包到网站镜像。

## 网站接口

- 使用现有 `/v1/web/action` Cookie/CSRF 通道。新增 `drafts/list {}`→`{items:[DraftDTO],nextCursor:null}`、`drafts/get {id}`→`DraftDTO`、`drafts/save {id?,expectedVersion?,title,summary,richDoc,coverAssetId:'',settings}`→`DraftDTO`、`drafts/delete {id,expectedVersion}`→`{ok:true}`、`drafts/submit {id,expectedVersion,idempotencyKey}`→`{id:postId,version,state}`；均由服务端会话识别用户与所选 `clubId`。`save` 的新稿没有 `id`，返回服务端生成的 `id/version`；已有稿必须带 `id/expectedVersion`，版本冲突返回 409。`settings` 仅含现有 `visibility/identityMode/commentsEnabled/topicId/boardId`。`DraftDTO` 包含 `id/version/status/title/summary/richDoc/body/assetIds/coverAssetId/settings/updatedAt/assets:[{assetId,status,url,width,height}]`；其中 URL 是仅当前有权查看时可用的同源短时地址，不包含对象路径或凭据。
- `drafts/submit` 带 `id/expectedVersion/idempotencyKey`，一个事务内创建 `pending` 社内文章或作者私密文章、绑定资产、标记草稿已提交。重试返回同一个 post ID，失败保留草稿。服务端重验当前成员、社团、发布与可见范围能力。
- 原 `posts/create` 与纯文本短笔保留。对 `richtext-v1` 的退回稿，新增 `posts/resubmit-rich {id,expectedVersion,idempotencyKey,draftId}`，按版本和幂等键替换规范化富文及附件，保留已固定的作者/社团/可见范围/身份。重提编辑器先取 `posts/detail`，再用 `drafts/save` 的可选 `sourcePostId` 创建重提草稿；服务端仅允许本人的同社团 rejected 富文源稿，并原子借用该源稿已有图片，新增图片仍需此草稿上传。普通新稿不传 `sourcePostId`。旧纯文本重提对富文稿应明确拒绝，避免 `body` 与 `richDoc` 脱节。
- 新静态页 `/web/editor.html`、本地 bundle 和样式，通过现有网站同源静态服务显式白名单提供。`/#/write` 保留短笔入口并提供明确的“写文章”入口；网站的富文稿重提进入编辑页。

## 图片与人工审核

- 独立网站现在 `REVIEW_PROVIDER=manual`，服务端明确关闭 `assets/*`。本轮仅为已登录且有上传资格的网站成员开放 JPEG/PNG 资产上传，继续复用现有字节大小、解码、去元数据、转 JPEG、配额、租约和同社团校验；不把清洗成功当作审核通过。视频、外链图片、iframe 仍关闭。
- 草稿图片保存真实的 `draftId` 绑定。现有 24 小时孤儿清理必须识别仍有效的草稿引用；删稿或从草稿移除图片后才能进入孤儿清理。上传资产的 `status` 在人工审核前保持隔离，普通媒体下载路径继续拒绝。
- 作者预览只允许自己的草稿或帖子资产；审核员预览只允许当前社团、已投稿的当前待审版本。独立同源 `GET /v1/web/media/:assetId?clubId=...&draftId=...&version=...` 或同等 postId 参数的媒体路由每次检查 Cookie、身份、社团、草稿/帖子版本和资产归属，响应 `private, no-store`。URL 由授权 DTO 返回，前端不能自行拼接。不能因平台 developer 身份开放社团内容，不能向审核员开放未投稿草稿或仅自己可见的内容。
- 提交社内图文后，`post + assetIds + review task` 在同一事务中绑定。管理台新增 `admin/content/detail {id,expectedVersion}`，返回完整的富文、摘要、封面及授权 `assets` 列表，按正文顺序预览。审核批准时由一个 PG 事务锁定当前 post/任务/资产，核对版本与资产状态，再把该版图片设为 `verified` 并发布帖子；拒绝保留作者修改/重提路径。旧自动审核流程和纯文本人工审核保持原行为。
- 私密图文不进入审核员队列，隔离图片仅作者可读；未来若要扩大可见范围，必须重新投稿审核，不能直接把私密未审图片公开。

## 阅读与兼容

- 文章详情按经过验证的 `richDoc` 节点顺序安全渲染；文本始终 HTML 转义，链接重新校验并加 `rel="noopener noreferrer"`。图片 URL 只由同源、逐次鉴权路由生成，不能使用客户端文档中的地址。文章列表使用授权封面；不要在详情尾部重复附加正文已含的图片。
- `body`、既有摘要与 `media.images` DTO 仍给旧小程序降级阅读；不会在旧客户端显示排版顺序。旧小程序对富文稿的纯文本重提必须拒绝或由兼容层完整更新富文，不能静默破坏结构。新网站、管理台和媒体下载均按 `clubId` 隔离。

## 验收与部署

- 先在隔离 PostgreSQL 验证迁移、旧库升级、草稿 CAS、跨社团权限、图片超过 24 小时仍可恢复、上传/提交/审核并发与失败回滚。不得改写已应用的 28 条迁移；新增迁移后同步硬编码账本与备份检查。
- 浏览器验证：标题/摘要/格式/行内图片/封面 → 保存 → 刷新恢复 → 发布设置 → 提交 → 管理员全文预览 → 批准 → 另一成员按正确顺序阅读；另测拒绝重提、手机宽度、无图/失败/网络中断和切社团。
- 目标独立 NAS 网站的数据库和媒体先做备份恢复演练，再应用向后兼容迁移并同批切换 API/worker；最后开放网站图片入口。旧数据库卷和旧发布镜像保留，回退旧 worker 前须确认其不会清理新草稿图片。
