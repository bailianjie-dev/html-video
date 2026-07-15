# Codex 项目交接说明

> 最后核对日期：2026-07-09  
> 用途：新会话先阅读本文件，再按“建议的下一步”继续。实现前仍应通过代码确认现状。  
> 安全要求：不要读取或输出 `.html-video/*.toml` 中的真实密码、AccessKey 等敏感信息。

## 1. 当前目标

项目正在把电子相册从本地文件存储迁移到 PostgreSQL，并将上传文件保存到阿里云 OSS。当前数据库包含以下七张核心表：

- `ai_album_albums`：相册主表
- `ai_album_album_pages`：页面、HTML 和 ContentGraph 数据
- `ai_album_assets`：OSS 素材元数据
- `ai_album_ai_generation_logs`：每次真实 AI 调用日志
- `ai_album_export_jobs`：MP4 导出任务
- `ai_album_chat_sessions`：聊天会话
- `ai_album_chat_messages`：聊天消息

迁移期间仍保留 `FileProjectPersistence` 作为数据库关闭时的兼容方案。

## 2. 已完成功能

### 2.1 数据库结构和数据访问层

- 已提供完整建表脚本：`migrations/001_init_album_tables.sql`
- 所有业务表使用 `ai_album_` 前缀、UUID 主键、审计字段及 `varchar + check constraint`
- 已提供表和字段注释脚本：`migrations/002_add_album_table_comments.sql`
- 已提供聊天持久化迁移：`migrations/003_add_album_chat_tables.sql`
- 已提供 OSS 垃圾清理索引迁移：`migrations/004_add_oss_cleanup_indexes.sql`
- 已提供页面 HTML OSS 字段迁移：`migrations/005_add_album_page_html_oss.sql`
- 已为七张表实现 DB 类型和参数化 Repository：
  - `AlbumRepository`
  - `AlbumPageRepository`
  - `AssetRepository`
  - `AiGenerationLogRepository`
  - `ExportJobRepository`
  - `ChatSessionRepository`
  - `ChatMessageRepository`

### 2.2 项目和页面持久化

当 `database.enabled = true` 时：

- `POST /api/projects`
- `GET /api/projects`
- `GET /api/projects/:id`
- `PATCH /api/projects/:id`
- `DELETE /api/projects/:id`

使用 `PostgresProjectPersistence` 和 `ai_album_albums`。

以下页面数据使用 `ai_album_album_pages`：

- raw HTML
- frame raw HTML
- ContentGraph 元数据和节点

相关正式接口：

- `GET/PUT /api/projects/:id/raw-html`
- `GET/PUT /api/projects/:id/frames/:nodeId/raw-html`
- ContentGraph 通过现有编排流程内部读写

`PostgresProjectPersistence` 已移除固定的 `local-dev`，项目和页面的
`save/load/list/remove`、raw HTML、frame HTML、ContentGraph 均从
`RequestContextStorage` 获取当前请求用户。跨用户访问按资源不存在处理，返回 404。

### 2.3 OSS 素材

当 `database.enabled = true` 且 `oss.enabled = true` 时：

- `POST /api/projects/:id/assets` 把文件上传至阿里云 OSS
- 图片转相册和聊天框 multipart 附件复用同一 OSS/数据库素材链路
- 新素材 object key 使用 `users/<user>/projects/<project>/assets/...`，与 HTML 用户目录一致
- OSS key、URL、文件名、MIME、大小、SHA-256 等写入 `ai_album_assets`
- `DELETE /api/projects/:id/assets/:assetId` 软删除数据库记录
- 删除素材不会立即删除 OSS 对象；`html-video oss-gc` 在保留期后清理
- OSS 垃圾清理默认 dry-run，`--execute` 才会删除对象
- 生成和编辑的 preview/frame HTML 上传 OSS，页面行保存 bucket、key、URL 和 SHA-256
- HTML object key 包含用户、项目和页面标识，跨用户不会覆盖
- 清理覆盖软删除素材，以及已删除相册关联的 HTML/MP4 OSS 产物

数据库或 OSS 未启用时，上传继续走原有本地文件行为。

素材正式流程和查询已使用 request-scoped 用户，跨用户访问返回 404。

### 2.4 AI 生成日志

正式 AI 生成流程已接入 `ai_album_ai_generation_logs`，覆盖：

- 主聊天
- 单页 HTML
- ContentGraph
- 多帧 HTML
- 旁白文案
- MiniMax TTS
- 音乐生成

每次真实模型调用单独记录。调用前写入 `running`，成功更新为 `succeeded`，失败更新为
`failed`。日志包含 `operation_id`、`attempt`、耗时、输出摘要或哈希及错误信息；日志写入失败不会中断原生成流程。

AI 日志已使用 request-scoped 用户；日志句柄保存发起用户身份，异步完成回写不会串用户。

### 2.5 MP4 导出任务

MP4 导出流程已接入 `ai_album_export_jobs`：

- 创建 queued/running 任务
- 更新进度
- 成功时记录本地输出路径、文件大小和 SHA-256
- PostgreSQL 与 OSS 同时启用时，渲染完成后上传 MP4 到 OSS，并记录
  `oss_bucket`、`oss_key` 和 `output_url`
- 失败时记录错误代码和错误信息

只读查询接口：

- `GET /api/projects/:projectId/export-jobs`
- `GET /api/export-jobs/:jobId`

导出任务记录和查询已使用 request-scoped 用户；任务句柄保存发起用户身份。OSS 未启用时继续保留本地导出行为；OSS 上传失败时任务标记为失败，同时保留已经生成的本地 MP4 路径、文件大小和 SHA-256。

### 2.6 聊天会话、消息和用户选择

PostgreSQL 模式已使用 `ai_album_chat_sessions` 和 `ai_album_chat_messages`
保存聊天历史。卡片选择、表单和确认操作保存在消息的 `payload`；消息还包含角色、
类型、会话顺序、请求关联 ID 和审计字段。文件模式继续使用 `messages.json`。

### 2.7 临时认证和请求上下文

临时账号固定为 `admin`，密码从 `.html-video/auth.toml` 读取，不使用数据库用户表。

接口：

- `GET /api/auth/me`
- `POST /api/auth/dev-login`
- `POST /api/auth/logout`

前端已有临时登录界面和退出入口。服务端已使用基于 `AsyncLocalStorage` 的
`RequestContextStorage`：

- 正式 `/api/*` 未登录返回 401
- `/api/auth/*` 和静态资源公开
- `x-user-id` 仅允许本机开发调试请求
- 不使用全局可变“当前用户”

## 3. 配置方式

真实配置文件均位于 `.html-video/`，不要提交真实密钥。

### PostgreSQL

- 模板：`.html-video/database.example.toml`
- 实际配置：`.html-video/database.toml`
- 开关：`[database].enabled`

`enabled = true` 使用 PostgreSQL；关闭或无有效配置时使用 `FileProjectPersistence`。

### OSS

- 模板：`.html-video/oss.example.toml`
- 实际配置：`.html-video/oss.toml`
- 开关：`[oss].enabled`

当前只支持阿里云 OSS。正式素材上传到 OSS 需要数据库和 OSS 两个开关同时启用。

### 临时登录

- 模板：`.html-video/auth.example.toml`
- 实际配置：`.html-video/auth.toml`
- 用户名：固定为 `admin`
- 密码：只写在实际配置文件中，不应写死在前端或提交到仓库

## 4. 关键文件

### 数据库和 Repository

- `packages/core/src/db/types.ts`
- `packages/core/src/repositories/album-repository.ts`
- `packages/core/src/repositories/album-page-repository.ts`
- `packages/core/src/repositories/asset-repository.ts`
- `packages/core/src/repositories/ai-generation-log-repository.ts`
- `packages/core/src/repositories/export-job-repository.ts`
- `packages/core/src/repositories/chat-session-repository.ts`
- `packages/core/src/repositories/chat-message-repository.ts`

### 项目、页面和用户上下文

- `packages/core/src/services/project-persistence.ts`
- `packages/core/src/services/file-project-persistence.ts`
- `packages/core/src/services/postgres-project-persistence.ts`
- `packages/core/src/services/project-mapper.ts`
- `packages/core/src/services/request-context.ts`
- `packages/core/src/services/user-context.ts`
- `packages/core/src/services/postgres-chat-persistence.ts`

### CLI、API 和外部存储

- `packages/cli/src/context.ts`
- `packages/cli/src/studio-server.ts`
- `packages/cli/src/database-config.ts`
- `packages/cli/src/oss-config.ts`
- `packages/cli/src/auth-config.ts`
- `packages/cli/src/ai-generation-logger.ts`
- `packages/cli/src/export-job-tracker.ts`

### 文档和迁移

- `migrations/001_init_album_tables.sql`
- `migrations/002_add_album_table_comments.sql`
- `migrations/003_add_album_chat_tables.sql`
- `migrations/004_add_oss_cleanup_indexes.sql`
- `migrations/005_add_album_page_html_oss.sql`
- `docs/db-design.md`
- `docs/persistence-guide.md`

`docs/persistence-guide.md` 中关于“AI 日志和导出任务尚未接入”的描述已经过期，后续应更新。

## 5. Dev 检查接口

- `POST /api/dev/persistence-test`
- `POST /api/dev/page-persistence-test`
- `POST /api/dev/oss-asset-test`
- `GET /api/dev/album-persistence-health/:projectId`

这些接口用于验证数据库、页面和 OSS，不应视为正式业务 API。所有 Dev 检查接口均使用
`RequestContextStorage` 中的当前请求用户，不再硬编码 `local-dev`。

## 6. 测试状态

最近一次验证结果：

- Core 测试：14/14 通过
- CLI 测试：19/19 通过
- Core TypeScript 类型检查通过
- CLI TypeScript 类型检查通过

其中包含：

- `packages/core/test/request-context.test.mjs`
  - 并发请求上下文隔离
  - 嵌套上下文恢复
  - 请求外访问报错
- `packages/core/test/postgres-project-persistence-user-isolation.test.mjs`
  - Alice/Bob 并发项目和页面数据隔离
  - 跨用户 load/read/write/remove 返回 `project-not-found`

常用验证命令：

```powershell
pnpm --filter @html-video/core build
pnpm --filter @html-video/core test
pnpm --filter @html-video/core typecheck
pnpm --filter @html-video/cli test
pnpm --filter @html-video/cli typecheck
```

上述自动化测试不替代真实 PostgreSQL、OSS、Pi Agent API 和浏览器端到端测试。

## 7. 遗留问题

### P0：完成多用户数据隔离

正式项目、页面、素材、AI 日志、导出任务和聊天流程均已使用 request-scoped 用户。
剩余 `local-dev` 仅位于未认证状态的兼容默认身份；正式 API 和 Dev 检查接口均使用请求级用户。

PostgreSQL 模式本地工作目录已改为
`.html-video/tmp/work/<safe-user-id>/<safe-project-id>/`。PostgreSQL 模式下读取以数据库里的 `raw_html`、`content.graph_node` 等结构化字段为准，不再从旧 `.html-video/projects` 本地路径 fallback。

### P1：素材读取尚未完全以 `ai_album_assets` 为唯一来源

文件上传已入库，但部分 inline text/data 和兼容字段仍保存在 `ai_album_albums.settings`
中的 `legacy_assets`。项目加载时也尚未完全从素材表重建 `project.assets[]`。

### P2：文档更新

`docs/persistence-guide.md` 存在编码显示异常和过时状态，应在功能稳定后按本交接文档重新整理。

## 8. 建议的下一步

多用户持久化改造第 1–5 项已完成。下一步执行页面端完整流程测试：

1. 登录并创建相册
2. 生成页面并验证聊天历史重载
3. 上传和查询素材
4. 执行 AI 生成与 MP4 导出
5. 使用第二个用户验证项目、素材、聊天和导出任务均返回 404 或不可见

下一次新会话推荐指令：

```text
请先阅读 docs/codex-handoff.md，并核对其中与当前代码有关的部分。
继续执行“建议的下一步”的页面端完整流程测试。先确认 PostgreSQL、OSS、认证和
Pi Agent（lingya/qwen3.7-plus）配置，再验证登录、创建相册、生成页面、聊天历史重载、上传素材、AI 生成、
MP4 导出和第二用户跨用户访问。不要输出任何真实密码或 AccessKey。
```
