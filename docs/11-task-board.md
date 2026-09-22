# 11｜后端任务板

> 任务 ID 前缀 `T-B`（Backend），与前端仓库的 `T-xx` 区分。
> 每个任务的 DoD 都隐含三项：`npm test` 全绿、`npm run check` 全绿、
> 涉及权限的改动已在 `tests/policies.test.mjs` 补用例。

## 已完成（本次交付）

| ID | 内容 | 产出 |
|---|---|---|
| T-B00 | 技术决策与工程书 | `docs/00–11` |
| T-B01 | 权限策略层（唯一实现） | `shared/policies.js` + 37 个单测 |
| T-B02 | 错误/校验/DTO/匿名/数据访问 | `shared/{errors,validators,presenters,anonymity,db}.js` |
| T-B03 | 会话与成员资格解析 | `shared/session.js`、`shared/router.js` |
| T-B04 | 内容用例（纵向参考） | `cloudfunctions/api/domain/posts.js` |
| T-B05 | 话题/文集/通知/搜索/媒体/管理台 | `cloudfunctions/api/domain/*.js` |
| T-B06 | worker 任务与审核回调 | `cloudfunctions/worker/`、`review-callback/` |
| T-B13 | 初始化/部署/自检脚本 | `scripts/*.mjs` |

---

## 待领取任务

### T-B07｜媒体校验补齐（时长 + EXIF）
**优先级**：高（阻塞 `capabilities.video`）
**依赖**：无
**输入**：`06-media-pipeline.md` 6.2、6.9
**现状缺口**
- 视频**时长**只信客户端声明，服务端未复核
- 图片 **EXIF 未剥离**，拍摄地点与设备信息仍在文件中

**产出**：`worker/tasks/media.js` 增加元数据解析与 EXIF 剥离
**DoD**
- 服务端能读出视频真实时长，超 60s 判 `fatal` 失败
- 图片上传后 EXIF 的 GPS、设备、时间字段被清除
- 若需引入依赖（如轻量 EXIF 解析库），先评估冷启动影响并在本表登记
- 单测覆盖：声明 30s 实际 90s 的视频被拒

> 注意：CloudBase 默认运行时没有 ffmpeg/ffprobe。可选方案：
> (a) 用纯 JS 解析 MP4 box 读时长；(b) 接入云端转码服务顺带拿元数据。
> 选定后写入 `06` 并更新本表。

### T-B08｜媒体撤权窗口收紧
**优先级**：中
**依赖**：无
**输入**：`06` 6.5
**现状缺口**：限时链接在有效期内仍可访问，改权限不即时生效
**产出**：可校验 `permissionVersion` 的访问代理（云函数或边缘函数）
**DoD**
- 媒体访问经代理，代理校验 `post.permissionVersion` 与链接签发时的版本
- 版本不匹配即拒绝
- 视频分片同样走该代理
- **验收文档中写明实际失效延迟**，不承诺"即时撤权"
- 已下载文件无法收回，这一点必须保留在用户告知中

### T-B09｜用量护栏与告警
**优先级**：中
**依赖**：无
**输入**：`08-operations.md` 8.4
**产出**：`assets/intent` 的日配额检查；统计集合 + 定时汇总任务
**DoD**
- 单用户日上传量超阈值 → `rate_limited`
- 全社团日上传量超阈值 → 暂停上传，但**不影响读取**
- 审核调用量接近配额时写告警通知给管理员
- 阈值可通过 `hg_club_config` 调整，不硬编码

### T-B10｜申诉工单
**优先级**：中
**依赖**：无
**输入**：`07-governance.md` 7.3
**现状缺口**：通知文案提示"可以申诉"，但无提交接口
**产出**：`appeals/create`、`admin/appeal/decide`、`hg_appeals` 集合
**DoD**
- 作者可对 `hidden` / `rejected` 的内容提交一次申诉
- 申诉进入 report 队列的独立分类
- 复核结果通知作者，含理由
- 申诉不暴露举报人
- 同一内容限一次申诉（防滥用），但不得完全关闭通道

### T-B11｜成员管理接口
**优先级**：中
**依赖**：无
**输入**：`07` 7.6、`08` 8.9
**现状缺口**：移除成员/禁言/角色调整只能在控制台改文档，**无审计日志**
**产出**：`admin/member/remove`、`admin/member/mute`、`admin/member/role`
**DoD**
- 每个操作写审计日志（控制台操作的最大问题就是没有留痕）
- 角色调整需 `moderator` 权限，且不能自我提权
- 移除成员后其 `viewer.isMember` 立即失效（已有机制，需加集成验证）
- 禁言需新增 `mutedUntil` 字段并在 `canCreatePost` / `canComment` 中校验
  → **这会改 policies.js，必须先加单测**

### T-B12｜计数对账任务
**优先级**：低
**依赖**：无
**输入**：`03-data-model.md` 3.4
**现状**：`reactionCount` / `commentCount` 用原子 inc，极端情况可能偏差
**产出**：`worker` 增加 `mode: 'reconcile'`，定期重算计数
**DoD**
- 按集合实际记录数重算并修正
- 修正量写日志（若持续出现大偏差说明有 bug）
- 低频执行（如每日一次），避免与正常写入冲突

### T-B14｜数据导出实现
**优先级**：低
**依赖**：`capabilities.export`
**输入**：`04-api-contract.md` 4.6
**现状**：`me/exports` 只创建任务与通知，不产出文件
**产出**：worker 生成导出文件并存私有桶，通知附下载入口
**DoD**
- 只导出**本人**的内容、收藏、关注话题
- **不含**他人的私密信息、举报人身份、匿名映射
- 导出文件限时可下载，过期自动清理
- 文件名不含身份信息

### T-B15｜订阅消息
**优先级**：低
**依赖**：模板 ID 申请（运营事项）
**输入**：前端 `docs/08` P08
**产出**：`worker` 在生成关键通知时发送订阅消息
**DoD**
- 仅在用户明确授权后发送
- 文案中性，**不含正文与身份**
- 发送失败不影响站内通知（站内是基础链路）
- 文案不承诺"必达"

### T-B16｜集成测试套件
**优先级**：高（G0 前必须有）
**依赖**：真实云环境
**输入**：`09-testing.md` 9.4–9.6
**产出**：可重复执行的集成测试脚本 + 测试账号准备说明
**DoD**
- `9.4` 的越权清单全部自动化（至少读取边界、搜索、匿名隔离三组）
- 能在部署后一键跑完并输出报告
- 测试数据可清理，不污染生产集合（建议用独立测试环境）

### T-B17｜内容安全接口实测
**优先级**：**最高**（G0-2）
**依赖**：接口开通
**输入**：`06` 6.3–6.7
**产出**：实测记录 + 必要的代码修正
**DoD**
- `msgSecCheck` / `imgSecCheck` / `mediaCheckAsync` 各至少一次成功调用
- 记录实际的 errCode、配额、响应时间
- 验证 `suggest: 'review'` 分支确实转 `manual`
- 验证接口异常时内容**不会**被误放行
- 确认后在 `01-decisions.md` 把 G0-2 标记为完成

---

## 共享文件登记表

修改以下文件前在此登记（提交信息带任务 ID）：

| 文件 | 当前持有 | 说明 |
|---|---|---|
| `shared/policies.js` | T-B11（禁言判断） | **改动必须先加单测**；被所有函数共享 |
| `shared/constants.js` | 空闲 | 新增枚举需同步前端 `docs/01` 术语表 |
| `shared/presenters.js` | 空闲 | 新增字段需同步前端 `docs/04` 的 DTO 示例 |
| `shared/db.js` | T-B12（对账） | 不得加入业务权限判断 |
| `cloudfunctions/api/index.js` | 各任务 | 只 append 自己的 action，不重排已有条目 |
| `worker/index.js` | T-B09、T-B12 | 新增 mode 时不改已有分支 |
| `docs/04-api-contract.md` | 各任务 | 新增 action 必须同步此文件 **与前端 docs/04** |

## 新任务收尾检查单

1. `npm test` 全绿；涉及权限的改动已加单测
2. `npm run check` 全绿
3. 新增 action 已写入 `04-api-contract.md` **和前端 `docs/04`**
4. 新增集合/索引已写入 `03-data-model.md` 与 `scripts/db-init.mjs`
5. 新增环境变量已写入 `.env.example` 与 `08-operations.md`
6. 涉及隐私的改动已过 `05-authorization.md` 5.8 的 Review 清单
7. 若实现了本表中的缺口，**从对应任务描述里删掉"现状缺口"段并更新 `docs/README.md` 的交付状态**
