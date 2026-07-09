# PostgreSQL / OSS 持久化接入说明

本文档说明当前电子相册 MVP 的 PostgreSQL 与 OSS 持久化接入状态、配置方式、测试命令和常见排查方法。

## 当前状态

已接入的核心链路：

- 项目主表：`ai_album_albums`
- 页面与 HTML：`ai_album_album_pages`，HTML 同时发布到 OSS
- 上传素材：`ai_album_assets`
- OSS 文件上传：当前实现支持阿里云 OSS
- AI 生成日志：`ai_album_ai_generation_logs`
- MP4 导出任务：`ai_album_export_jobs`
- MP4 导出产物：PostgreSQL 与 OSS 同时启用时上传 OSS，并在任务中记录访问地址

暂未接入或暂不处理：

- 内联 text/data 素材：当前仍沿用原本本地/Project settings 行为
- 页面与素材的精确 page_id 绑定：当前素材上传会绑定 `album_id`，暂未绑定到具体页面
- OSS 文件删除：业务接口先软删除，垃圾清理任务在保留期后删除 OSS 对象

## 配置文件

### PostgreSQL

真实配置文件路径：

```text
.html-video/database.toml
```

模板文件路径：

```text
.html-video/database.example.toml
```

配置结构：

```toml
[database]
enabled = true
host = "127.0.0.1"
port = 5432
name = "html_video"
user = "postgres"
password = "YOUR_PASSWORD"
pool_min_size = 2
pool_max_size = 10
pool_timeout = 30
connect_timeout = 10
```

行为说明：

- `enabled = true`：正式项目接口使用 PostgreSQL 持久化
- `enabled = false`：继续使用原本本地文件持久化
- 系统优先读取 `.html-video/database.toml`
- 如果找不到，再尝试读取项目根目录下的 `database.toml`
- 接口返回配置时会隐藏敏感字段，不会返回数据库密码

### OSS

真实配置文件路径：

```text
.html-video/oss.toml
```

模板文件路径：

```text
.html-video/oss.example.toml
```

配置结构：

```toml
[oss]
enabled = true
provider = "aliyun"
endpoint = "oss-cn-example.aliyuncs.com"
bucket = "your-bucket-name"
access_key_id = "YOUR_ACCESS_KEY_ID"
access_key_secret = "YOUR_ACCESS_KEY_SECRET"
public_base_url = "https://your-bucket-name.oss-cn-example.aliyuncs.com"
prefix = "html-video/dev"
```

行为说明：

- 当前 OSS 实现只支持阿里云 OSS
- `enabled = true` 且 `database.enabled = true` 时，正式文件上传会保存到 OSS，并写入 `ai_album_assets`
- `enabled = false` 或配置不存在时，正式上传继续走原本本地文件行为
- `public_base_url` 用于生成可在 HTML 中直接引用的素材 URL
- `prefix` 用于控制 OSS object key 前缀

## 已接入接口

### 项目主表

以下接口在 `database.enabled = true` 时使用 `ai_album_albums`：

```text
POST   /api/projects
GET    /api/projects
GET    /api/projects/:id
PATCH  /api/projects/:id
DELETE /api/projects/:id
```

说明：

- 当前仍保留 `Project.id` 形如 `proj_xxx`
- 数据库主键是 `ai_album_albums.id`
- `Project.id` 会写入 `ai_album_albums.source_project_id`

### 页面 / HTML

以下内容在 `database.enabled = true` 时使用 `ai_album_album_pages`：

```text
GET /api/projects/:id/raw-html
PUT /api/projects/:id/raw-html

GET /api/projects/:id/frames/:nodeId/raw-html
PUT /api/projects/:id/frames/:nodeId/raw-html
```

同时，content graph 的读写也通过 `ProjectPersistence` 接入 PostgreSQL：

- `content_graph` 元信息保存在 `ai_album_albums.settings.content_graph`
- graph node 保存在 `ai_album_album_pages.content.graph_node`
- 页面 HTML 保存在 `ai_album_album_pages.raw_html`
- PostgreSQL 与 OSS 同时启用时，preview/frame HTML 同步上传 OSS
- 页面行的 `html_oss_bucket`、`html_oss_key`、`html_url` 和
  `html_checksum_sha256` 保存发布位置和校验值
- 相册的 `last_preview_html_url` 保存最近预览页面 URL

### 素材上传

正式上传接口：

```text
POST /api/projects/:id/assets
```

行为：

- `database.enabled = true` 且 `oss.enabled = true`
  - 文件上传到 OSS
  - 写入 `ai_album_assets`
  - `project.assets[]` 中的 `path` 使用 OSS URL
- 其他情况
  - 继续使用原本本地文件行为

### 素材删除

正式删除接口：

```text
DELETE /api/projects/:id/assets/:assetId
```

行为：

- 原本逻辑：从 `project.assets[]` 中移除素材
- PostgreSQL 模式：同步把 `ai_album_assets.status` 更新为 `deleted`
- 不删除 OSS 文件

## Dev 测试接口

### 主表持久化测试

```powershell
Invoke-RestMethod -Method Post http://127.0.0.1:3071/api/dev/persistence-test
```

验证：

- 是否能连接 PostgreSQL
- 是否能向 `ai_album_albums` 写入一条测试数据
- 是否能读回

### 页面持久化测试

```powershell
Invoke-RestMethod -Method Post http://127.0.0.1:3071/api/dev/page-persistence-test
```

验证：

- 是否能创建测试项目
- 是否能写入 raw HTML
- 是否能写入 content graph
- 是否能写入 frame raw HTML
- 是否能从 `ai_album_album_pages` 读回

### OSS 素材测试

空 POST 会上传一段默认测试文本：

```powershell
Invoke-RestMethod -Method Post http://127.0.0.1:3071/api/dev/oss-asset-test
```

也可以上传真实文件：

```powershell
$form = @{
  file = Get-Item "D:\path\to\test.png"
}
Invoke-RestMethod -Method Post -Form $form http://127.0.0.1:3071/api/dev/oss-asset-test
```

验证：

- OSS 中是否出现 `html-video/dev/asset-persistence-test/...`
- `ai_album_assets` 是否新增记录
- 返回 JSON 中 `created` 与 `loaded` 是否都有 `oss_key`、`url`、`checksum_sha256`

### 电子相册完整性检查

```powershell
Invoke-RestMethod -Method Get http://127.0.0.1:3071/api/dev/album-persistence-health/<projectId>
```

`projectId` 可以是：

- `Project.id`，例如 `proj_438c5435-231`
- `ai_album_albums.id` UUID

返回内容：

- 相册主表摘要
- 页面数量
- 是否存在 `raw_html`
- 是否存在 content graph
- 素材数量
- 素材状态分布

## 正式流程测试建议

### 1. 创建项目

```powershell
Invoke-RestMethod `
  -Method Post `
  -ContentType "application/json" `
  -Body '{"name":"album persistence test"}' `
  http://127.0.0.1:3071/api/projects
```

记录返回的：

```text
project.id
```

### 2. 上传素材

```powershell
$form = @{
  file = Get-Item "D:\path\to\test.png"
}
Invoke-RestMethod -Method Post -Form $form http://127.0.0.1:3071/api/projects/<projectId>/assets
```

检查：

- OSS 是否出现 `html-video/dev/projects/<projectId>/assets/...`
- `ai_album_assets.album_id` 是否有值
- `ai_album_assets.oss_key` 是否有值
- `ai_album_assets.url` 是否是 OSS URL
- 返回的 `project.assets[].path` 是否是 OSS URL

### 3. 检查完整性

```powershell
Invoke-RestMethod -Method Get http://127.0.0.1:3071/api/dev/album-persistence-health/<projectId>
```

重点看：

- `album.status`
- `pages.count`
- `pages.has_raw_html`
- `pages.has_content_graph`
- `assets.count`
- `assets.status_counts`

## 常见错误与排查

### relation "ai_album_albums" does not exist

原因：

- 当前连接的数据库里没有执行迁移
- 或者 `.html-video/database.toml` 中 `name` 指向了错误数据库

排查：

- 确认已执行 `migrations/001_init_album_tables.sql`
- 使用 OSS 垃圾清理任务前执行 `migrations/004_add_oss_cleanup_indexes.sql`
- 使用 HTML OSS 发布前执行 `migrations/005_add_album_page_html_oss.sql`
- 确认数据库客户端里看到的库名和 `database.toml` 的 `name` 一致
- 确认表在 `public` schema 下

### Database config not found or invalid

原因：

- 没有 `.html-video/database.toml`
- TOML 字段缺失
- `host`、`name`、`user`、`password` 至少一个为空

排查：

```powershell
Test-Path .html-video/database.toml
```

然后检查 `[database]` 配置块是否完整。

### database.enabled is false

原因：

- `.html-video/database.toml` 中设置了：

```toml
enabled = false
```

结果：

- dev 测试接口会返回 mock/skipped
- 正式项目接口继续使用本地文件行为

### OSS config not found or invalid

原因：

- 没有 `.html-video/oss.toml`
- TOML 字段缺失
- `endpoint`、`bucket`、`access_key_id`、`access_key_secret` 至少一个为空

排查：

```powershell
Test-Path .html-video/oss.toml
```

然后检查 `[oss]` 配置块是否完整。

### oss.enabled is false

原因：

```toml
enabled = false
```

结果：

- OSS dev 测试接口会跳过上传
- 正式文件上传继续使用本地文件行为

### OSS upload failed

常见原因：

- `endpoint` 填错
- `bucket` 填错
- AccessKey 没有 `PutObject` 权限
- bucket region 与 endpoint 不匹配
- 服务器无法访问 OSS endpoint

排查：

- 确认 endpoint 形如 `oss-cn-hangzhou.aliyuncs.com`
- 确认 bucket 属于该 region
- 确认 AccessKey 有写入权限
- 看接口返回中的 OSS HTTP 状态码和错误 XML

### 上传成功但页面图片不显示

常见原因：

- `public_base_url` 不可公开访问
- bucket 或 CDN 没有开放读取
- OSS CORS 或防盗链配置阻止浏览器访问

排查：

- 复制返回的 `url` 到浏览器直接打开
- 如果浏览器打不开，先修 OSS 公开访问/CDN/签名 URL 策略
- 如果浏览器能打开，再检查生成 HTML 中是否使用了该 URL

### 删除素材后 OSS 文件还在

这是保留期内的设计行为。

删除接口只做：

- 从 `project.assets[]` 移除
- `ai_album_assets.status = 'deleted'`

不会立即删除 OSS 对象。这样可以提供恢复窗口，并避免业务请求同步删除外部对象。

垃圾清理命令默认只预览候选项：

```powershell
node packages/cli/dist/bin.js --cwd . oss-gc
```

确认候选数量后显式执行：

```powershell
node packages/cli/dist/bin.js --cwd . oss-gc --execute
```

可用 `--retention-days <n>` 和 `--limit <n>` 临时覆盖配置。默认值可写入
`.html-video/oss.toml`：

```toml
[oss]
garbage_retention_days = 7
garbage_batch_size = 100
```

清理规则：

- 只处理超过保留期的 `status = 'deleted'` 素材或已删除相册所属素材
- 活跃素材仍引用同一 bucket/key 时不会列为候选
- 已删除相册关联的 HTML 和 MP4 OSS 产物也会清理
- OSS 删除成功或对象已不存在后，才硬删除素材行或清空页面/导出任务 OSS 字段
- 删除失败和 bucket 不匹配会保留数据库记录，供下次任务重试

生产环境可用 Windows 任务计划、cron 或 CI 定时调用。建议始终先运行 dry-run。

## 当前实现边界

### 数据库仍保留部分 legacy settings

当前 `Project` 兼容层仍会把部分旧结构保存在 `ai_album_albums.settings` 中，例如：

- `legacy_assets`
- `legacy_frames`
- `legacy_exports`
- `content_graph_path`
- 本地开发路径

这是迁移期设计，用于保持现有前端和业务代码稳定。

### `ai_album_assets` 不是唯一资产来源

当前正式文件上传已经写入 `ai_album_assets`，但内联 text/data 仍可能只存在于 Project settings 或本地文件中。

后续如果要进一步收敛，可以把 text/data 也写入 `ai_album_assets`，并让项目加载时从 `ai_album_assets` 重建 `project.assets[]`。

### AI 生成日志

正式 AI 生成流程已写入 `ai_album_ai_generation_logs`。每次真实模型调用先记录
`running`，完成后更新为 `succeeded` 或 `failed`；日志写入失败不会中断生成流程。

日志使用请求级用户上下文，异步完成回写时保留发起用户身份。

### MP4 导出任务与 OSS 产物

MP4 导出已接入 `ai_album_export_jobs`，记录 queued/running/succeeded/failed 状态、
进度、本地输出路径、文件大小和 SHA-256。

当 PostgreSQL 与 OSS 同时启用时，渲染完成的 MP4 会上传到：

```text
<prefix>/projects/<projectId>/exports/<jobId>/output.mp4
```

任务成功后写入 `oss_bucket`、`oss_key` 和 `output_url`。OSS 未启用时保留本地导出；
OSS 上传失败时任务标记为失败，但仍记录已生成的本地 MP4 路径、文件大小和 SHA-256。
