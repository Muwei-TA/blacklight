# R04/R05 图片链路集成说明

本分支把图片上传收口在 api 云函数中。当前只接受 JPEG/PNG，服务端解码后统一重编码为 JPEG，去除 EXIF 与其他源文件元数据；视频能力继续关闭。

## 主 Agent 必须接入的路由

本分支按任务约束没有修改 cloudfunctions/api/index.js。主 Agent 集成时加入：

~~~
'assets/upload': assets.uploadImage,
~~~

调用入口仍是 wx.cloud.callFunction({ name: 'api', data: { action, payload } })。现有 assets/intent、assets/confirm、assets/status 路由保持不变。

## action DTO

### assets/intent

~~~
{
  "mediaType": "image",
  "size": 123456,
  "mimeType": "image/jpeg",
  "idempotencyKey": "draft-image-intent-key"
}
~~~

size 是初筛值，必须大于 0 且不超过 2 MiB；mimeType 只能是 image/jpeg 或 image/png。返回：

~~~
{
  "assetId": "...",
  "mediaType": "image",
  "expiresAt": "...",
  "expiresInSeconds": 900
}
~~~

接口不返回 cloudPath。ctx.capabilities.uploads 仍为 false 时会拒绝请求，主 Agent 在真实 CloudBase 环境验收前不要打开开关。

### assets/upload

~~~
{
  "assetId": "...",
  "contentBase64": "data:image/jpeg;base64,...",
  "idempotencyKey": "draft-image-upload-key"
}
~~~

云函数验证实际 magic bytes、JPEG/PNG 头部尺寸、解码后像素上限和解码字节数（2 MiB），然后通过 wx-server-sdk 的 cloud.uploadFile 写到随机路径 private/image/<48 hex>.jpg。响应只包含：

~~~
{
  "assetId": "...",
  "status": "uploaded",
  "width": 1200,
  "height": 800,
  "actualSize": 123456,
  "cleanedSize": 45678
}
~~~

响应和资产 DTO 都不把 fileId、cloudPath 交给客户端。上传意图只能成功绑定一次；重试必须复用同一个 idempotencyKey，不能换 key 覆盖已有对象。

### assets/confirm

~~~
{
  "assetId": "...",
  "idempotencyKey": "draft-image-confirm-key"
}
~~~

只确认服务端已经绑定的 uploaded 资产，并创建 asset-review:<assetId> 审核任务。任何非空 fileId 都返回 invalid_input，所以旧版“客户端直传后提交 fileId”的调用必须移除。

### assets/status

~~~
{ "assetId": "..." }
~~~

每次请求重新判断权限并按需签发临时 URL。资产未 verified 时 url 始终为空；绑定到帖子的资产要求当前 viewer 通过 policies.canReadPost，管理员角色不能绕过私密帖权限。尚未绑定私密资产的 owner 可以查看自己的处理状态。

## worker 审核边界

worker/tasks/media.js 下载服务端绑定的 fileId 后再次验证真实 JPEG、尺寸和无 EXIF，再用 imgSecCheck({ media: { contentType: 'image/jpeg', value } }) 检查。87014 会拒绝资产；安全服务的其他错误直接抛出，让调度器重试或转人工，绝不置为 verified。图片审核通过后才写入 tempFileURL 与 verified 状态；assets/status 仍然每次签发新 URL。

视频 intent 在 API 层返回 forbidden，历史视频任务在 worker 中也保持 fail-closed 并标记拒绝。

## 弱网重试与错误恢复

客户端应为 intent、upload、confirm 各生成一个持久化幂等键，并在同一逻辑操作的网络重试中保持不变。assets/upload 成功但响应丢失时，服务端会依据已绑定资产返回相同 DTO；内容校验失败或意图过期后应重新申请 intent，不要复用失败键覆盖状态。

## 数据库与运行边界

cloudbase/migrations/20260922180000_image_intents.sql 为 hg_assets 增加 owner/status/expiry 查询索引，并对非空 fileId 建唯一索引，防止同一个对象被重复绑定。该分支未部署、未推送，也没有修改共享鉴权、DB、presenter、session 或 api/index.js。

