# 电子相册 MVP 数据库设计

本文档描述第一版电子相册 MVP 的 PostgreSQL 持久化模型。范围覆盖电子相册、页面、OSS 素材、聊天会话与消息、大模型生成记录和 MP4 导出任务，不包含复杂会员、支付、模板市场和分享链接。

对应迁移文件：

- [../migrations/001_init_album_tables.sql](../migrations/001_init_album_tables.sql)
- [../migrations/002_add_album_table_comments.sql](../migrations/002_add_album_table_comments.sql)
- [../migrations/003_add_album_chat_tables.sql](../migrations/003_add_album_chat_tables.sql)

## 通用约定

- 所有表都包含 `user_id`、`created_by`、`updated_by`、`created_time`、`updated_time`。
- `user_id` 使用 `varchar(64)`，以兼容外部登录 API 未来可能返回字符串或数字字符串的情况。
- 字段统一使用 `snake_case`。
- 表名统一使用 `ai_album_` 前缀。
- 主键使用 `id uuid PRIMARY KEY`，由应用层生成 UUID 后写入数据库。
- 当前迁移不需要 `pgcrypto`，因为没有使用 `gen_random_uuid()` 作为数据库默认值。如果后续改为数据库自动生成 UUID，再考虑启用 `pgcrypto` 或使用 PostgreSQL 版本内置的 UUID 生成函数。
- `status` 使用 `varchar` 加 `check constraint`，不使用 PostgreSQL enum，便于后续增加状态时通过迁移调整约束。
- JSON 扩展字段使用 `jsonb`，并用 check constraint 约束为 object，避免写入数组或标量导致应用解析分叉。

## 当前 Project 模型映射

当前代码里的持久化模型是 `Project`。文件模式仍使用 `.html-video/projects/<project_id>/`；PostgreSQL 模式的本地工作文件使用 `.html-video/projects/<safe_user_id>/<safe_project_id>/`。对外继续保持现有 `/api/projects...` 接口契约，对内把结构化数据映射到 `ai_album_*` 表。

| 当前模型 | 数据库表 |
| --- | --- |
| `Project` | `ai_album_albums` |
| `Project.frames[]` / `content-graph.json.nodes[]` | `ai_album_album_pages` |
| `Project.assets[]` | `ai_album_assets` |
| 聊天历史 / `messages.json` | `ai_album_chat_sessions`、`ai_album_chat_messages` |
| 选项卡、表单和确认操作 | `ai_album_chat_messages.payload` |
| Agent / AI / 音频生成过程 | `ai_album_ai_generation_logs` |
| `Project.exports[]` / `lastOutputMp4Path` | `ai_album_export_jobs` |

## 表设计

### ai_album_albums

电子相册主表，一条记录对应一个用户创建的相册项目。

关键字段：

- `id`：数据库 UUID 主键。
- `source_project_id`：迁移期兼容当前 `proj_xxx` 字符串项目 ID。后续如果接口完全切到 UUID，可以废弃该字段。
- `title`、`description`：相册标题和描述，分别映射当前 `Project.name` 和 `Project.intent`。
- `status`：`draft`、`previewed`、`rendered`、`published`、`archived`、`deleted`。其中 `previewed`、`rendered` 用于兼容当前 `ProjectStatus`。
- `cover_asset_id`：封面素材 ID。当前不加外键，避免与 `ai_album_assets.album_id` 形成循环依赖；应用层校验该素材属于同一用户和相册。
- `last_preview_asset_id`、`last_preview_html_url`、`last_preview_poster_url`：迁移当前 `lastPreviewHtmlPath`、`lastPreviewPosterPath` 相关信息。线上建议保存 OSS 产物引用或 URL，不依赖本地路径。
- `canvas_width`、`canvas_height`、`fps`、`duration_ms`：渲染基础参数，映射 `Project.preferences.resolution/fps`。
- `page_count`：页面数量冗余字段，方便列表页展示；以应用层或后续触发器维护。
- `settings`：保存 `preferences`、`variables`、`agentId`、`agentModel`、`soundtrack` 等相册级扩展配置。

主要索引：

- `(user_id, status, updated_time desc)`：用户相册列表按状态筛选和更新时间排序。
- `(user_id, created_time desc)`：用户相册创建时间倒序列表。
- `(user_id, source_project_id)` partial index：迁移期按旧项目 ID 查询。

### ai_album_album_pages

电子相册页面表，一条记录对应相册中的一页，也对应当前多帧项目中的一个 frame。

关键字段：

- `album_id`：所属相册，按 `(user_id, album_id)` 组合外键引用 `ai_album_albums`，防止跨用户引用。
- `node_id`：迁移当前 `FrameRecord.graphNodeId` / content graph node id，例如 `intro`、`frame_1`。
- `page_no`：页码，从 1 开始，映射 `FrameRecord.order + 1`。
- `status`：`draft`、`ready`、`disabled`、`deleted`。
- `template_key`：页面使用的模板标识，可映射 `Project.templateId` 或 `FrameRecord.nativeTemplateId`。
- `duration_ms`：该页面在视频中的持续时长，映射 `FrameRecord.durationSec * 1000`。
- `raw_html`：保留完整 HTML 源码，供编辑和渲染读取。
- `html_oss_bucket`、`html_oss_key`、`html_url`、`html_checksum_sha256`：
  记录同步发布到 OSS 的 standalone HTML 位置和校验值；object key 包含用户、项目和页面标识。
- `preview_asset_id`、`poster_asset_id`：页面级预览 MP4、缩略图或海报素材 ID。当前不强加外键，避免与 `ai_album_assets.page_id` 形成循环关系；应用层校验归属。
- `content`：保存 content graph node、页面文案、结构化数据、`FrameRecord.data` 等内容。
- `style`：保存页面样式、引擎、增强状态等信息。
- `transition`：保存页面转场配置。

约束：

- `UNIQUE (album_id, page_no)` 保证同一个 `album_id` 下 `page_no` 不能重复。
- `UNIQUE (album_id, node_id)` 保证同一个相册内 content graph node id 不重复。PostgreSQL 允许多个 `NULL`，因此单帧项目可以不填。

主要索引：

- `(user_id, album_id)`：读取某个相册的全部页面。
- `(album_id, node_id)` partial index：按 frame/node id 查找页面。
- `(user_id, updated_time desc)`：用户维度最近编辑页面查询。

### ai_album_assets

用户上传素材表。文件实际保存在 OSS，数据库只保存 OSS key、URL 和文件元数据。

关键字段：

- `album_id`、`page_id`：素材可归属于相册，也可进一步归属于某一页。`page_id` 非空时要求 `album_id` 非空。
- `asset_type`：`image`、`video`、`audio`、`font`、`text`、`data`、`reference_link`、`other`，兼容当前 `AssetType`。
- `usage_type`：`source`、`cover`、`background`、`music`、`thumbnail`、`export`、`other`。
- `source`：`upload`、`ai_generated`、`system`。
- `status`：`uploading`、`available`、`failed`、`deleted`。
- `oss_bucket`、`oss_key`、`url`、`thumbnail_url`：OSS 与访问地址信息，替代当前本地 `path`。
- `file_name`、`mime_type`、`file_ext`、`file_size_bytes`、`width`、`height`、`duration_ms`、`checksum_sha256`：文件元数据。
- `metadata`：保存 `userTags`、`userCaption`、迁移期 `local_legacy_path`、EXIF、裁剪参数、转码结果等扩展信息。

约束：

- `UNIQUE (user_id, oss_key)` 避免同一用户重复登记同一个 OSS 对象。
- `checksum_sha256` 限制为 64 位十六进制字符串。

主要索引：

- `(user_id, album_id, created_time desc)`：读取相册素材库。
- `(user_id, page_id)`：读取页面关联素材。
- `(user_id, asset_type, status)`：按类型和状态筛选素材。
- `checksum_sha256` partial index：非空时支持去重或秒传判断。

### ai_album_chat_sessions / ai_album_chat_messages

聊天数据拆为会话和消息两层。每个用户相册同一时间最多有一个 `active` 会话；文件模式继续使用 `messages.json`。

关键字段：

- 会话的 `last_message_seq` 通过原子更新分配消息序号，避免同一会话并发请求产生重复顺序。
- 消息保存 `role`、`message_type`、`sequence_no`、`request_id`、`content`、Agent/工具标识和 `payload`。
- `message_type` 包括普通文本、选项选择、表单提交、确认、工具结果和系统事件。
- 选项卡、表单、确认和聚焦帧等结构化交互保存在对应消息的 `payload` 中，包括 `selection_type`、`phase`、`selection_key` 和 `value`。
- 会话和消息均通过 `(user_id, ...)` 组合外键约束到同一用户的相册或上级记录。

主要索引：

- `(user_id, album_id)` 上的活动会话唯一 partial index。
- `(user_id, album_id, sequence_no)`：按顺序加载相册聊天历史。
- `(user_id, request_id)` partial index：按请求关联 ID 排查一次交互产生的消息。

### ai_album_ai_generation_logs

大模型生成记录表，用于审计和排查生成过程。

关键字段：

- `album_id`、`page_id`、`generated_asset_id`：关联生成所属相册、页面和产出的素材。
- `generation_type`：`album_outline`、`page_copy`、`page_html`、`image`、`audio`、`video`、`narration`、`music`、`frame_enhance`、`other`。
- `provider`、`model`：模型服务商、Agent 或模型名称。
- `status`：`queued`、`running`、`succeeded`、`failed`、`cancelled`。
- `prompt`、`request_payload`、`response_payload`：提示词、请求和响应快照。
- `prompt_tokens`、`completion_tokens`、`total_tokens`、`cost_amount`：用量和成本统计。
- `error_code`、`error_message`：失败原因。
- `started_time`、`finished_time`：任务执行时间。

主要索引：

- `(user_id, album_id, created_time desc)`：查看某个相册的生成历史。
- `(user_id, status, created_time desc)`：按状态排查生成任务。
- `(user_id, generation_type, created_time desc)`：按生成类型查询。

### ai_album_export_jobs

MP4 导出任务表。

关键字段：

- `album_id`：导出的相册。
- `status`：`queued`、`running`、`succeeded`、`failed`、`cancelled`。
- `export_format`：第一版固定为 `mp4`。
- `render_profile`、`width`、`height`、`fps`、`duration_ms`：导出参数。
- `progress_percent`、`attempt_count`：进度和重试次数。
- `request_params`：导出请求快照。
- `local_output_path`：迁移期或本地开发使用，映射当前 `output-*.mp4` 本地路径；生产环境应以 OSS 字段为准。
- `oss_bucket`、`oss_key`、`output_url`：导出产物的 OSS 信息。
- `file_size_bytes`、`checksum_sha256`：产物元数据。
- `error_code`、`error_message`：失败原因。
- `queued_time`、`started_time`、`finished_time`：任务生命周期时间。

主要索引：

- `(user_id, album_id, created_time desc)`：查看相册导出历史。
- `(user_id, status, created_time desc)`：用户维度按状态筛选导出任务。
- `idx_export_jobs_active` partial index：加速后台 worker 拉取 `queued` 和 `running` 任务。

## 外键和用户隔离

核心强归属关系使用组合外键，例如 `ai_album_album_pages (user_id, album_id)` 引用 `ai_album_albums (user_id, id)`。这样即使 UUID 被误传，也能在数据库层阻止跨用户引用。

对于需要 `ON DELETE SET NULL` 的可选关系，例如 `ai_album_assets.page_id`、`ai_album_ai_generation_logs.album_id`、`ai_album_ai_generation_logs.page_id` 和 `ai_album_ai_generation_logs.generated_asset_id`，迁移使用单列外键。原因是 PostgreSQL 的组合外键在 `ON DELETE SET NULL` 时会默认尝试把引用列全部置空；如果组合里包含 `user_id`，会和 `user_id NOT NULL` 冲突。这些可选关系的用户一致性建议在应用层写入时校验。

`ai_album_albums.cover_asset_id`、`ai_album_albums.last_preview_asset_id`、`ai_album_album_pages.preview_asset_id`、`ai_album_album_pages.poster_asset_id` 当前保留为普通 UUID 字段，不设置外键。原因是 `ai_album_assets` 已经引用相册和页面，如果再反向强引用素材，会增加循环依赖和删除顺序复杂度。MVP 阶段建议在应用层校验这些素材归属；后续如果确实需要数据库强约束，可以改为独立关系表或后置 `ALTER TABLE` 加可选外键。

## 字段放置原则

适合放 JSONB：

- `Project.preferences` -> `ai_album_albums.settings.preferences`
- `Project.variables` -> `ai_album_albums.settings.variables`
- `Project.soundtrack` -> `ai_album_albums.settings.soundtrack`
- `agentId`、`agentModel` -> `ai_album_albums.settings.agent_id` / `settings.agent_model`
- `ContentGraph node` -> `ai_album_album_pages.content.graph_node`
- `FrameRecord.data` -> `ai_album_album_pages.content.data`
- `Asset.userTags`、`metadata.userCaption` -> `ai_album_assets.metadata`
- 模型请求上下文 -> `ai_album_ai_generation_logs.request_payload`

不适合放 JSONB：

- 高频筛选字段，例如 `status`、`album_id`、`page_no`、`asset_type`、`created_time`。
- 二进制文件，例如图片、音频、视频，应保存到 OSS。
- 大段 HTML 长期来看更适合 OSS 或 `raw_html text`，不建议塞进 JSONB。

## 后续可选扩展

- 增加 `ai_album_page_assets` 表，精确记录同一素材在多个页面中的使用关系。
- 增加触发器自动维护 `updated_time`。
- 增加软删除统一规范，例如所有业务查询默认排除 `status = 'deleted'`。
- 增加导出产物到 `ai_album_assets` 的同步策略，让 `ai_album_export_jobs` 成功后生成一条 `usage_type = 'export'` 的素材记录。
