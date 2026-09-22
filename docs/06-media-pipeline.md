# 06｜媒体链路

## 6.1 完整链路

```text
客户端                          api 云函数                 worker                  内容安全
────────────────────────────────────────────────────────────────────────────────────────
1. 选择文件
2. assets/intent      →  校验声明值（不可信）
                         创建 asset(status=intent)
                         返回 cloudPath
3. wx.cloud.uploadFile → 直传私有桶
4. assets/confirm     →  status=uploaded
                         创建 review_task
5. 轮询 assets/status                          →  复核真实文件属性
                                                  图片：imgSecCheck  →  同步结果
                                                  视频：mediaCheckAsync → 提交，等回调
                                                  status=verified / rejected / verifying
6. posts/create       →  校验所有 asset 必须
                         ownerId==viewer 且 verified
                         否则 pending_media / forbidden
```

## 6.2 客户端声明值不可信

`assets/intent` 收到的 `size` / `duration` 只做**初筛**，真正的校验在 worker：

```js
// worker/tasks/media.js verifyFileMetadata()
const downloaded = await cloud.downloadFile({ fileID: asset.fileId });
const actualSize = downloaded.fileContent.length;
if (actualSize > limit) throw Object.assign(new Error(...), { fatal: true });
```

`fatal` 标记让调度层直接判定失败，不浪费 5 次重试。

**已知不足**：视频**时长**目前只校验客户端声明值。
服务端复核时长需要解析容器元数据（如 ffprobe），CloudBase 云函数默认环境没有。
这是 `capabilities.video` 保持关闭的又一个原因，也是任务 T-B07 的内容。

## 6.3 图片：可完整闭环

```js
await cloud.openapi.security.imgSecCheck({ media: { contentType, value: buffer } });
// errCode 87014 → 含违规内容
```

同步返回，通过后立即 `getTempFileURL` 并置为 `verified`。

## 6.4 视频：不是"图片审核加一个播放按钮"

建议链路（前端工程书 `docs/10` 10.2 已明确）：

```text
创建上传意图 → 私有隔离区上传 → 服务端校验格式/大小/时长
→ 转码 → 生成封面 → 视频画面检查 + 音频内容检查
→ 必要人工复核 → 所有必需任务完成后才允许展示 → 带权限的视频访问
```

**本仓库的实现进度（诚实声明）**：

| 步骤 | 状态 |
|---|---|
| 上传意图与私有存储 | ✅ |
| 大小校验（服务端复核） | ✅ |
| 时长校验（服务端复核） | ❌ 仅信客户端声明 |
| 转码 | ❌ 未接入 |
| 封面生成 | ❌ 未接入 |
| `mediaCheckAsync` 提交 | ✅ 代码已写，**未实测** |
| 回调接收与状态流转 | ✅ `review-callback` |
| 人工复核入口 | ⚠️ 标记 `needsManualReview`，但管理台无对应界面 |

因此 `capabilities.video` 默认 `false`，`assets/intent` 对视频直接返回 `forbidden`。
**不把"文字＋封面审核"伪装成视频安全已完成。**

### 关键：封面过了不等于视频过了

```js
// worker/tasks/review.js reviewPost()
if (task.needsMedia) {
  const allVerified = assets.every(a => a.status === VERIFIED);
  if (!allVerified) return { status: QUEUED, note: 'waiting for assets' };
}
```

整条视频帖在附件全部 `verified` 前保持 `pending`，不会部分公开。

## 6.5 撤权窗口：限时链接的真实局限

`getTempFileURL` 生成的链接有有效期（默认约 2 小时）。这意味着：

> **改权限不会立即让已发出的链接失效。**

| 场景 | 实际行为 |
|---|---|
| 作者把公开帖改为社内 | 新请求拿不到链接；但**已发出的链接在有效期内仍可访问** |
| 作者删除内容 | 同上，且 worker 会物理删除文件（此后链接 404） |
| 成员被移除 | 新请求被拒；旧链接同样有残留窗口 |
| 已下载到本地的文件 | **无法收回**，任何方案都做不到 |

**本仓库的缓解措施**：

1. `permissionVersion` 在范围变更/隐藏时递增，可用于缓存键与后续的边缘鉴权方案
2. 删除内容时把 assets 标记 `revoked`，worker 物理删除文件
3. 只在 `verified` 时生成链接，未通过审核的内容根本没有可访问 URL

**必须写入验收文档的话**：限时链接只缩短泄露窗口，**不等于即时撤权**。
若要做到接近即时，需要引入可校验 `permissionVersion` 的鉴权代理或边缘函数，
视频分片同样适用。这属于 P1 增强（任务 T-B08），首版接受该残留风险并向用户告知。

## 6.6 回调处理的四条规则

`review-callback/index.js` 实现了全部四条：

| 规则 | 实现 |
|---|---|
| **验签** | 云消息推送场景检查 `MsgType`；HTTP 场景校验 `REVIEW_CALLBACK_SECRET` |
| **去重** | asset 已是 `verified`/`rejected` 终态则忽略（幂等） |
| **超时补偿** | asset 已不存在时静默确认，不报错 |
| **防旧覆盖新** | 比较 `event_time` 与 `asset.submittedAt`，早于提交时间的回调丢弃 |

```js
if (callbackAt && submittedAt && callbackAt < submittedAt) {
  return { code: 0, note: 'stale' };   // 较旧回调不覆盖较新结果
}
```

## 6.7 审核服务异常时的行为

**绝不允许"为了不影响用户体验先发出去"。**

```text
审核任务抛错
  → 调度层 catch，attempts + 1
  → attempts < 5：状态回 queued，下一轮重试
  → attempts >= 5：状态转 manual，等人工处理
  → 内容在整个过程中保持 pending（不可公开）
```

内容安全接口未开通时（G0-2 未完成），行为就是上述流程：
所有内容堆积在 `manual` 队列，**没有任何内容会被误放行**。
这是预期的 fail-closed，不是缺陷。

## 6.8 存储成本护栏

| 措施 | 实现 |
|---|---|
| 孤儿附件清理 | 24 小时未绑定内容即删除文件与记录（`cleanup.js`） |
| 已删除内容的媒体回收 | 标记 `revoked` → worker 物理删除 |
| 单文件大小限制 | 图片 10MB / 视频 30MB，服务端复核 |
| 单帖附件数 | 图片 ≤9 或视频 ×1，互斥 |

**尚未实现**：日上传量阈值与用量告警。前端工程书要求"高成本异常触发暂停上传，
但不暂停用户读取自己的文字"——这需要在 `assets/intent` 加日配额检查，
属任务 T-B09。

## 6.9 文件命名与元数据

```text
private/{mediaType}/{userId前8位}/{assetId}.{ext}
```

- **不使用原始文件名** —— 文件名本身可能含身份信息（如 "小明的照片.jpg"）
- 路径中的 userId 前缀只用于分区，且桶为私有不可枚举
- **EXIF 剥离尚未实现**：照片的拍摄地点、设备信息仍在文件中。
  这是隐私缺口，属任务 T-B07 的一部分。前端文案应提醒用户检查画面信息。
