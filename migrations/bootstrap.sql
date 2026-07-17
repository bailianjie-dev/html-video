-- =============================================================================
-- bootstrap.sql — 空库 / 全新数据库一键初始化
-- bootstrap.sql — FOR EMPTY / GREENFIELD DATABASES ONLY
-- =============================================================================
--
-- 中文说明：
--   - 仅用于空库或全新（greenfield）数据库，不要对已有数据的库执行本文件。
--   - 等价于按顺序依次执行编号迁移 001..007。
--   - 已有数据库必须继续使用增量编号迁移文件（001、002、…），不要用本文件。
--   - 运行方式：
--       psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/bootstrap.sql
--     或：
--       psql -h HOST -U USER -d DBNAME -v ON_ERROR_STOP=1 -f migrations/bootstrap.sql
--   - 新增编号迁移时：请把对应 SQL 追加到本文件末尾（或重新生成本文件）。
--
-- English:
--   - FOR EMPTY / GREENFIELD DATABASES ONLY. Do not run against databases that
--     already have schema/data applied.
--   - Equivalent to applying numbered migrations 001..007 in order.
--   - Existing DBs must use incremental numbered files, NOT this file.
--   - How to run:
--       psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/bootstrap.sql
--   - When adding a new numbered migration, append it here too (or regenerate).
--
-- Source migrations (concatenation only; schema logic unchanged):
--   001_init_album_tables.sql
--   002_add_album_table_comments.sql
--   003_add_album_chat_tables.sql
--   004_add_oss_cleanup_indexes.sql
--   005_add_album_page_html_oss.sql
--   006_enable_multi_agent_sessions.sql
--   007_migrate_legacy_assets.sql
-- =============================================================================
-- =============================================================================
-- From: 001_init_album_tables.sql
-- =============================================================================

CREATE TABLE ai_album_albums (
  id uuid PRIMARY KEY,
  user_id varchar(64) NOT NULL,
  source_project_id varchar(64),
  title varchar(200) NOT NULL,
  description text,
  status varchar(32) NOT NULL DEFAULT 'draft',
  cover_asset_id uuid,
  last_preview_asset_id uuid,
  last_preview_html_url text,
  last_preview_poster_url text,
  canvas_width integer NOT NULL DEFAULT 1080,
  canvas_height integer NOT NULL DEFAULT 1920,
  fps integer NOT NULL DEFAULT 30,
  duration_ms integer NOT NULL DEFAULT 0,
  page_count integer NOT NULL DEFAULT 0,
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by varchar(64) NOT NULL,
  updated_by varchar(64) NOT NULL,
  created_time timestamptz NOT NULL DEFAULT now(),
  updated_time timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_albums_user_id_id UNIQUE (user_id, id),
  CONSTRAINT uq_albums_user_source_project_id UNIQUE (user_id, source_project_id),
  CONSTRAINT ck_albums_status CHECK (status IN ('draft', 'previewed', 'rendered', 'published', 'archived', 'deleted')),
  CONSTRAINT ck_albums_canvas_width CHECK (canvas_width > 0),
  CONSTRAINT ck_albums_canvas_height CHECK (canvas_height > 0),
  CONSTRAINT ck_albums_fps CHECK (fps > 0),
  CONSTRAINT ck_albums_duration_ms CHECK (duration_ms >= 0),
  CONSTRAINT ck_albums_page_count CHECK (page_count >= 0),
  CONSTRAINT ck_albums_settings_object CHECK (jsonb_typeof(settings) = 'object')
);

CREATE TABLE ai_album_album_pages (
  id uuid PRIMARY KEY,
  user_id varchar(64) NOT NULL,
  album_id uuid NOT NULL,
  node_id varchar(128),
  page_no integer NOT NULL,
  title varchar(200),
  status varchar(32) NOT NULL DEFAULT 'draft',
  template_key varchar(128),
  duration_ms integer NOT NULL DEFAULT 3000,
  raw_html text,
  preview_asset_id uuid,
  poster_asset_id uuid,
  content jsonb NOT NULL DEFAULT '{}'::jsonb,
  style jsonb NOT NULL DEFAULT '{}'::jsonb,
  transition jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by varchar(64) NOT NULL,
  updated_by varchar(64) NOT NULL,
  created_time timestamptz NOT NULL DEFAULT now(),
  updated_time timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_album_pages_user_id_id UNIQUE (user_id, id),
  CONSTRAINT uq_album_pages_user_album_id UNIQUE (user_id, album_id, id),
  CONSTRAINT uq_album_pages_album_id_page_no UNIQUE (album_id, page_no),
  CONSTRAINT uq_album_pages_album_id_node_id UNIQUE (album_id, node_id),
  CONSTRAINT fk_album_pages_album FOREIGN KEY (user_id, album_id) REFERENCES ai_album_albums (user_id, id) ON DELETE CASCADE,
  CONSTRAINT ck_album_pages_status CHECK (status IN ('draft', 'ready', 'disabled', 'deleted')),
  CONSTRAINT ck_album_pages_page_no CHECK (page_no > 0),
  CONSTRAINT ck_album_pages_duration_ms CHECK (duration_ms > 0),
  CONSTRAINT ck_album_pages_content_object CHECK (jsonb_typeof(content) = 'object'),
  CONSTRAINT ck_album_pages_style_object CHECK (jsonb_typeof(style) = 'object'),
  CONSTRAINT ck_album_pages_transition_object CHECK (jsonb_typeof(transition) = 'object')
);

CREATE TABLE ai_album_assets (
  id uuid PRIMARY KEY,
  user_id varchar(64) NOT NULL,
  album_id uuid,
  page_id uuid,
  asset_type varchar(32) NOT NULL,
  usage_type varchar(32) NOT NULL DEFAULT 'source',
  source varchar(32) NOT NULL DEFAULT 'upload',
  status varchar(32) NOT NULL DEFAULT 'available',
  oss_bucket varchar(128),
  oss_key varchar(1024) NOT NULL,
  url text NOT NULL,
  thumbnail_url text,
  file_name varchar(255),
  mime_type varchar(128),
  file_ext varchar(32),
  file_size_bytes bigint,
  width integer,
  height integer,
  duration_ms integer,
  checksum_sha256 varchar(64),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by varchar(64) NOT NULL,
  updated_by varchar(64) NOT NULL,
  created_time timestamptz NOT NULL DEFAULT now(),
  updated_time timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_assets_user_id_id UNIQUE (user_id, id),
  CONSTRAINT uq_assets_user_id_oss_key UNIQUE (user_id, oss_key),
  CONSTRAINT fk_assets_album FOREIGN KEY (user_id, album_id) REFERENCES ai_album_albums (user_id, id) ON DELETE CASCADE,
  CONSTRAINT fk_assets_page FOREIGN KEY (page_id) REFERENCES ai_album_album_pages (id) ON DELETE SET NULL,
  CONSTRAINT ck_assets_asset_type CHECK (asset_type IN ('image', 'video', 'audio', 'font', 'text', 'data', 'reference_link', 'other')),
  CONSTRAINT ck_assets_usage_type CHECK (usage_type IN ('source', 'cover', 'background', 'music', 'thumbnail', 'export', 'other')),
  CONSTRAINT ck_assets_source CHECK (source IN ('upload', 'ai_generated', 'system')),
  CONSTRAINT ck_assets_status CHECK (status IN ('uploading', 'available', 'failed', 'deleted')),
  CONSTRAINT ck_assets_page_requires_album CHECK (page_id IS NULL OR album_id IS NOT NULL),
  CONSTRAINT ck_assets_file_size_bytes CHECK (file_size_bytes IS NULL OR file_size_bytes >= 0),
  CONSTRAINT ck_assets_width CHECK (width IS NULL OR width > 0),
  CONSTRAINT ck_assets_height CHECK (height IS NULL OR height > 0),
  CONSTRAINT ck_assets_duration_ms CHECK (duration_ms IS NULL OR duration_ms >= 0),
  CONSTRAINT ck_assets_checksum_sha256 CHECK (checksum_sha256 IS NULL OR checksum_sha256 ~ '^[0-9a-fA-F]{64}$'),
  CONSTRAINT ck_assets_metadata_object CHECK (jsonb_typeof(metadata) = 'object')
);

CREATE TABLE ai_album_ai_generation_logs (
  id uuid PRIMARY KEY,
  user_id varchar(64) NOT NULL,
  album_id uuid,
  page_id uuid,
  generated_asset_id uuid,
  generation_type varchar(32) NOT NULL,
  provider varchar(64) NOT NULL,
  model varchar(128) NOT NULL,
  status varchar(32) NOT NULL DEFAULT 'queued',
  prompt text,
  request_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  response_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  prompt_tokens integer,
  completion_tokens integer,
  total_tokens integer,
  cost_amount numeric(12, 6),
  error_code varchar(128),
  error_message text,
  started_time timestamptz,
  finished_time timestamptz,
  created_by varchar(64) NOT NULL,
  updated_by varchar(64) NOT NULL,
  created_time timestamptz NOT NULL DEFAULT now(),
  updated_time timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_ai_generation_logs_user_id_id UNIQUE (user_id, id),
  CONSTRAINT fk_ai_generation_logs_album FOREIGN KEY (album_id) REFERENCES ai_album_albums (id) ON DELETE SET NULL,
  CONSTRAINT fk_ai_generation_logs_page FOREIGN KEY (page_id) REFERENCES ai_album_album_pages (id) ON DELETE SET NULL,
  CONSTRAINT fk_ai_generation_logs_generated_asset FOREIGN KEY (generated_asset_id) REFERENCES ai_album_assets (id) ON DELETE SET NULL,
  CONSTRAINT ck_ai_generation_logs_generation_type CHECK (generation_type IN ('album_outline', 'page_copy', 'page_html', 'image', 'audio', 'video', 'narration', 'music', 'frame_enhance', 'other')),
  CONSTRAINT ck_ai_generation_logs_status CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  CONSTRAINT ck_ai_generation_logs_request_payload_object CHECK (jsonb_typeof(request_payload) = 'object'),
  CONSTRAINT ck_ai_generation_logs_response_payload_object CHECK (jsonb_typeof(response_payload) = 'object'),
  CONSTRAINT ck_ai_generation_logs_prompt_tokens CHECK (prompt_tokens IS NULL OR prompt_tokens >= 0),
  CONSTRAINT ck_ai_generation_logs_completion_tokens CHECK (completion_tokens IS NULL OR completion_tokens >= 0),
  CONSTRAINT ck_ai_generation_logs_total_tokens CHECK (total_tokens IS NULL OR total_tokens >= 0),
  CONSTRAINT ck_ai_generation_logs_cost_amount CHECK (cost_amount IS NULL OR cost_amount >= 0)
);

CREATE TABLE ai_album_export_jobs (
  id uuid PRIMARY KEY,
  user_id varchar(64) NOT NULL,
  album_id uuid NOT NULL,
  status varchar(32) NOT NULL DEFAULT 'queued',
  export_format varchar(16) NOT NULL DEFAULT 'mp4',
  render_profile varchar(64) NOT NULL DEFAULT 'mp4_1080p',
  width integer NOT NULL DEFAULT 1080,
  height integer NOT NULL DEFAULT 1920,
  fps integer NOT NULL DEFAULT 30,
  duration_ms integer,
  progress_percent numeric(5, 2) NOT NULL DEFAULT 0,
  attempt_count integer NOT NULL DEFAULT 0,
  request_params jsonb NOT NULL DEFAULT '{}'::jsonb,
  local_output_path text,
  oss_bucket varchar(128),
  oss_key varchar(1024),
  output_url text,
  file_size_bytes bigint,
  checksum_sha256 varchar(64),
  error_code varchar(128),
  error_message text,
  queued_time timestamptz NOT NULL DEFAULT now(),
  started_time timestamptz,
  finished_time timestamptz,
  created_by varchar(64) NOT NULL,
  updated_by varchar(64) NOT NULL,
  created_time timestamptz NOT NULL DEFAULT now(),
  updated_time timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_export_jobs_user_id_id UNIQUE (user_id, id),
  CONSTRAINT fk_export_jobs_album FOREIGN KEY (user_id, album_id) REFERENCES ai_album_albums (user_id, id) ON DELETE CASCADE,
  CONSTRAINT ck_export_jobs_status CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  CONSTRAINT ck_export_jobs_export_format CHECK (export_format IN ('mp4')),
  CONSTRAINT ck_export_jobs_width CHECK (width > 0),
  CONSTRAINT ck_export_jobs_height CHECK (height > 0),
  CONSTRAINT ck_export_jobs_fps CHECK (fps > 0),
  CONSTRAINT ck_export_jobs_duration_ms CHECK (duration_ms IS NULL OR duration_ms >= 0),
  CONSTRAINT ck_export_jobs_progress_percent CHECK (progress_percent >= 0 AND progress_percent <= 100),
  CONSTRAINT ck_export_jobs_attempt_count CHECK (attempt_count >= 0),
  CONSTRAINT ck_export_jobs_request_params_object CHECK (jsonb_typeof(request_params) = 'object'),
  CONSTRAINT ck_export_jobs_file_size_bytes CHECK (file_size_bytes IS NULL OR file_size_bytes >= 0),
  CONSTRAINT ck_export_jobs_checksum_sha256 CHECK (checksum_sha256 IS NULL OR checksum_sha256 ~ '^[0-9a-fA-F]{64}$')
);

CREATE INDEX idx_albums_user_status_updated_time ON ai_album_albums (user_id, status, updated_time DESC);
CREATE INDEX idx_albums_user_created_time ON ai_album_albums (user_id, created_time DESC);
CREATE INDEX idx_albums_user_source_project_id ON ai_album_albums (user_id, source_project_id) WHERE source_project_id IS NOT NULL;

CREATE INDEX idx_album_pages_user_album_id ON ai_album_album_pages (user_id, album_id);
CREATE INDEX idx_album_pages_album_node_id ON ai_album_album_pages (album_id, node_id) WHERE node_id IS NOT NULL;
CREATE INDEX idx_album_pages_user_updated_time ON ai_album_album_pages (user_id, updated_time DESC);

CREATE INDEX idx_assets_user_album_created_time ON ai_album_assets (user_id, album_id, created_time DESC);
CREATE INDEX idx_assets_user_page_id ON ai_album_assets (user_id, page_id);
CREATE INDEX idx_assets_user_type_status ON ai_album_assets (user_id, asset_type, status);
CREATE INDEX idx_assets_checksum_sha256 ON ai_album_assets (checksum_sha256) WHERE checksum_sha256 IS NOT NULL;

CREATE INDEX idx_ai_generation_logs_user_album_created_time ON ai_album_ai_generation_logs (user_id, album_id, created_time DESC);
CREATE INDEX idx_ai_generation_logs_user_status_created_time ON ai_album_ai_generation_logs (user_id, status, created_time DESC);
CREATE INDEX idx_ai_generation_logs_user_generation_type_created_time ON ai_album_ai_generation_logs (user_id, generation_type, created_time DESC);

CREATE INDEX idx_export_jobs_user_album_created_time ON ai_album_export_jobs (user_id, album_id, created_time DESC);
CREATE INDEX idx_export_jobs_user_status_created_time ON ai_album_export_jobs (user_id, status, created_time DESC);
CREATE INDEX idx_export_jobs_active ON ai_album_export_jobs (status, queued_time) WHERE status IN ('queued', 'running');

-- =============================================================================
-- From: 002_add_album_table_comments.sql
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- ai_album_albums
-- ---------------------------------------------------------------------------

COMMENT ON TABLE ai_album_albums IS '电子相册主表：保存相册基本信息、画布参数、生命周期状态及兼容 Project 模型的扩展设置。';

COMMENT ON COLUMN ai_album_albums.id IS '相册主键，由应用生成的 UUID。';
COMMENT ON COLUMN ai_album_albums.user_id IS '相册所属用户 ID；当前兼容外部登录系统，长度不超过 64。';
COMMENT ON COLUMN ai_album_albums.source_project_id IS '原 Project 模型的项目 ID，用于迁移期兼容 proj_xxx 标识并定位相册。';
COMMENT ON COLUMN ai_album_albums.title IS '相册标题。';
COMMENT ON COLUMN ai_album_albums.description IS '相册描述、创作意图或内容简介。';
COMMENT ON COLUMN ai_album_albums.status IS '相册状态：draft 草稿、previewed 已预览、rendered 已渲染、published 已发布、archived 已归档、deleted 已软删除。';
COMMENT ON COLUMN ai_album_albums.cover_asset_id IS '相册封面素材 ID；对应 ai_album_assets.id，当前由应用层校验归属。';
COMMENT ON COLUMN ai_album_albums.last_preview_asset_id IS '最近一次预览产物的素材 ID；当前由应用层校验归属。';
COMMENT ON COLUMN ai_album_albums.last_preview_html_url IS '最近一次可访问的 HTML 预览地址。';
COMMENT ON COLUMN ai_album_albums.last_preview_poster_url IS '最近一次预览海报或缩略图地址。';
COMMENT ON COLUMN ai_album_albums.canvas_width IS '相册画布宽度，单位为像素。';
COMMENT ON COLUMN ai_album_albums.canvas_height IS '相册画布高度，单位为像素。';
COMMENT ON COLUMN ai_album_albums.fps IS '预览或视频导出的目标帧率，单位为帧每秒。';
COMMENT ON COLUMN ai_album_albums.duration_ms IS '相册目标总时长，单位为毫秒；0 表示尚未确定。';
COMMENT ON COLUMN ai_album_albums.page_count IS '相册页面数量，由应用在页面或内容图变更时同步维护。';
COMMENT ON COLUMN ai_album_albums.settings IS '相册扩展配置 JSON，包括 Project preferences、variables、soundtrack、Agent 配置及迁移期 legacy 数据。';
COMMENT ON COLUMN ai_album_albums.created_by IS '创建人标识，通常与创建时的 user_id 或操作人 ID 一致。';
COMMENT ON COLUMN ai_album_albums.updated_by IS '最后修改人标识。';
COMMENT ON COLUMN ai_album_albums.created_time IS '记录创建时间，带时区。';
COMMENT ON COLUMN ai_album_albums.updated_time IS '记录最后更新时间，带时区。';

-- ---------------------------------------------------------------------------
-- ai_album_album_pages
-- ---------------------------------------------------------------------------

COMMENT ON TABLE ai_album_album_pages IS '电子相册页面表：保存相册页面顺序、ContentGraph 节点、页面 HTML、样式和转场配置。';

COMMENT ON COLUMN ai_album_album_pages.id IS '页面主键，由应用生成的 UUID。';
COMMENT ON COLUMN ai_album_album_pages.user_id IS '页面所属用户 ID，用于数据隔离并与相册组成组合外键。';
COMMENT ON COLUMN ai_album_album_pages.album_id IS '所属相册 ID，引用 ai_album_albums.id。';
COMMENT ON COLUMN ai_album_album_pages.node_id IS 'ContentGraph 节点 ID；同一相册内唯一，单页预览通常使用 preview。';
COMMENT ON COLUMN ai_album_album_pages.page_no IS '页面序号，从 1 开始；同一相册内不可重复。';
COMMENT ON COLUMN ai_album_album_pages.title IS '页面标题或从 ContentGraph 节点提取的显示文案。';
COMMENT ON COLUMN ai_album_album_pages.status IS '页面状态：draft 草稿、ready 可用、disabled 已禁用、deleted 已软删除。';
COMMENT ON COLUMN ai_album_album_pages.template_key IS '页面使用的模板标识；可保存原生 Remotion 模板等页面级模板。';
COMMENT ON COLUMN ai_album_album_pages.duration_ms IS '页面播放时长，单位为毫秒。';
COMMENT ON COLUMN ai_album_album_pages.raw_html IS '页面完整 HTML 源码；用于预览、编辑和后续 MP4 渲染。';
COMMENT ON COLUMN ai_album_album_pages.preview_asset_id IS '页面预览视频等素材 ID；当前由应用层校验素材归属。';
COMMENT ON COLUMN ai_album_album_pages.poster_asset_id IS '页面海报或缩略图素材 ID；当前由应用层校验素材归属。';
COMMENT ON COLUMN ai_album_album_pages.content IS '页面内容 JSON，包括 graph_node、FrameRecord.data 及本地兼容路径等结构化数据。';
COMMENT ON COLUMN ai_album_album_pages.style IS '页面样式 JSON，包括渲染引擎、原生模板 ID 及页面级视觉配置。';
COMMENT ON COLUMN ai_album_album_pages.transition IS '页面转场 JSON，保存进入、退出或页面间切换效果配置。';
COMMENT ON COLUMN ai_album_album_pages.created_by IS '创建人标识。';
COMMENT ON COLUMN ai_album_album_pages.updated_by IS '最后修改人标识。';
COMMENT ON COLUMN ai_album_album_pages.created_time IS '记录创建时间，带时区。';
COMMENT ON COLUMN ai_album_album_pages.updated_time IS '记录最后更新时间，带时区。';

-- ---------------------------------------------------------------------------
-- ai_album_assets
-- ---------------------------------------------------------------------------

COMMENT ON TABLE ai_album_assets IS '用户素材表：记录上传或 AI 生成文件的 OSS 定位信息、访问地址、文件元数据及使用状态；文件内容不存数据库。';

COMMENT ON COLUMN ai_album_assets.id IS '素材主键，由应用生成的 UUID。';
COMMENT ON COLUMN ai_album_assets.user_id IS '素材所属用户 ID。';
COMMENT ON COLUMN ai_album_assets.album_id IS '素材所属相册 ID；为空时表示尚未绑定具体相册。';
COMMENT ON COLUMN ai_album_assets.page_id IS '素材关联页面 ID；为空时表示相册级或用户级素材。';
COMMENT ON COLUMN ai_album_assets.asset_type IS '素材类型：image、video、audio、font、text、data、reference_link 或 other。';
COMMENT ON COLUMN ai_album_assets.usage_type IS '素材用途：source 原始素材、cover 封面、background 背景、music 音乐、thumbnail 缩略图、export 导出产物或 other。';
COMMENT ON COLUMN ai_album_assets.source IS '素材来源：upload 用户上传、ai_generated AI 生成、system 系统生成。';
COMMENT ON COLUMN ai_album_assets.status IS '素材状态：uploading 上传中、available 可用、failed 失败、deleted 已软删除。';
COMMENT ON COLUMN ai_album_assets.oss_bucket IS 'OSS Bucket 名称。';
COMMENT ON COLUMN ai_album_assets.oss_key IS 'OSS Object Key；用户范围内唯一，用于定位实际文件。';
COMMENT ON COLUMN ai_album_assets.url IS '素材访问 URL，可为 OSS 公网地址或 CDN 地址。';
COMMENT ON COLUMN ai_album_assets.thumbnail_url IS '素材缩略图 URL；图片、视频等素材可选。';
COMMENT ON COLUMN ai_album_assets.file_name IS '用户上传时的原始文件名或系统生成的文件名。';
COMMENT ON COLUMN ai_album_assets.mime_type IS '文件 MIME 类型，例如 image/png、video/mp4。';
COMMENT ON COLUMN ai_album_assets.file_ext IS '文件扩展名，通常包含前导点，例如 .png、.mp4。';
COMMENT ON COLUMN ai_album_assets.file_size_bytes IS '文件大小，单位为字节。';
COMMENT ON COLUMN ai_album_assets.width IS '图片或视频宽度，单位为像素。';
COMMENT ON COLUMN ai_album_assets.height IS '图片或视频高度，单位为像素。';
COMMENT ON COLUMN ai_album_assets.duration_ms IS '音频或视频时长，单位为毫秒。';
COMMENT ON COLUMN ai_album_assets.checksum_sha256 IS '文件内容的 SHA-256 校验值，64 位十六进制字符串。';
COMMENT ON COLUMN ai_album_assets.metadata IS '素材扩展元数据 JSON，包括用户标签、说明、上传来源、OSS ETag 及兼容字段。';
COMMENT ON COLUMN ai_album_assets.created_by IS '创建人标识。';
COMMENT ON COLUMN ai_album_assets.updated_by IS '最后修改人标识。';
COMMENT ON COLUMN ai_album_assets.created_time IS '记录创建时间，带时区。';
COMMENT ON COLUMN ai_album_assets.updated_time IS '记录最后更新时间，带时区。';

-- ---------------------------------------------------------------------------
-- ai_album_ai_generation_logs
-- ---------------------------------------------------------------------------

COMMENT ON TABLE ai_album_ai_generation_logs IS 'AI 生成日志表：按每次真实模型调用记录请求类型、模型、状态、耗时、响应摘要、Token、费用及错误信息。';

COMMENT ON COLUMN ai_album_ai_generation_logs.id IS 'AI 生成日志主键，由应用生成的 UUID。';
COMMENT ON COLUMN ai_album_ai_generation_logs.user_id IS '发起生成操作的用户 ID。';
COMMENT ON COLUMN ai_album_ai_generation_logs.album_id IS '关联相册 ID；相册删除时置空以保留日志。';
COMMENT ON COLUMN ai_album_ai_generation_logs.page_id IS '关联页面 ID；相册级生成或生成前页面不存在时可为空。';
COMMENT ON COLUMN ai_album_ai_generation_logs.generated_asset_id IS '本次生成产生的素材 ID，例如 AI 音频或图片；未落素材表时为空。';
COMMENT ON COLUMN ai_album_ai_generation_logs.generation_type IS '生成类型：album_outline、page_copy、page_html、image、audio、video、narration、music、frame_enhance 或 other。';
COMMENT ON COLUMN ai_album_ai_generation_logs.provider IS 'AI Provider 或 Agent 标识，例如 minimax、claude、codex、amr。';
COMMENT ON COLUMN ai_album_ai_generation_logs.model IS '实际或用户选择的模型标识；无法确定时为 unknown。';
COMMENT ON COLUMN ai_album_ai_generation_logs.status IS '生成状态：queued 排队、running 执行中、succeeded 成功、failed 失败、cancelled 已取消。';
COMMENT ON COLUMN ai_album_ai_generation_logs.prompt IS '发送给模型的提示词；应用会限制长度并对常见敏感字段脱敏。';
COMMENT ON COLUMN ai_album_ai_generation_logs.request_payload IS '请求扩展 JSON，包括 operation_id、attempt、业务阶段、页面节点和附件摘要。';
COMMENT ON COLUMN ai_album_ai_generation_logs.response_payload IS '响应摘要 JSON，包括耗时、输出长度、SHA-256、截断摘要、退出码及生成结果元数据；不重复保存完整 HTML。';
COMMENT ON COLUMN ai_album_ai_generation_logs.prompt_tokens IS '提示词消耗 Token 数；Provider 未返回时为空，不做估算。';
COMMENT ON COLUMN ai_album_ai_generation_logs.completion_tokens IS '模型输出消耗 Token 数；Provider 未返回时为空。';
COMMENT ON COLUMN ai_album_ai_generation_logs.total_tokens IS '本次调用总 Token 数；Provider 未返回时为空。';
COMMENT ON COLUMN ai_album_ai_generation_logs.cost_amount IS '本次调用费用金额；币种由业务约定，Provider 未返回时为空。';
COMMENT ON COLUMN ai_album_ai_generation_logs.error_code IS '失败错误代码，例如 timeout、invalid_html、agent_exit_nonzero。';
COMMENT ON COLUMN ai_album_ai_generation_logs.error_message IS '失败错误详情；成功时为空。';
COMMENT ON COLUMN ai_album_ai_generation_logs.started_time IS '模型调用开始时间，带时区。';
COMMENT ON COLUMN ai_album_ai_generation_logs.finished_time IS '模型调用完成、失败或取消时间，带时区。';
COMMENT ON COLUMN ai_album_ai_generation_logs.created_by IS '创建人标识。';
COMMENT ON COLUMN ai_album_ai_generation_logs.updated_by IS '最后修改人标识。';
COMMENT ON COLUMN ai_album_ai_generation_logs.created_time IS '日志记录创建时间，带时区。';
COMMENT ON COLUMN ai_album_ai_generation_logs.updated_time IS '日志记录最后更新时间，带时区。';

-- ---------------------------------------------------------------------------
-- ai_album_export_jobs
-- ---------------------------------------------------------------------------

COMMENT ON TABLE ai_album_export_jobs IS 'MP4 导出任务表：记录导出参数、运行状态、进度、本地或 OSS 产物位置、文件校验信息及失败原因。';

COMMENT ON COLUMN ai_album_export_jobs.id IS '导出任务主键，由应用生成的 UUID，同时作为接口返回的 job_id。';
COMMENT ON COLUMN ai_album_export_jobs.user_id IS '发起导出任务的用户 ID。';
COMMENT ON COLUMN ai_album_export_jobs.album_id IS '待导出的相册 ID，引用 ai_album_albums.id。';
COMMENT ON COLUMN ai_album_export_jobs.status IS '任务状态：queued 排队、running 执行中、succeeded 成功、failed 失败、cancelled 已取消。';
COMMENT ON COLUMN ai_album_export_jobs.export_format IS '导出格式；当前仅支持 mp4。';
COMMENT ON COLUMN ai_album_export_jobs.render_profile IS '渲染规格标识，例如 mp4_1920x1080。';
COMMENT ON COLUMN ai_album_export_jobs.width IS '导出视频宽度，单位为像素。';
COMMENT ON COLUMN ai_album_export_jobs.height IS '导出视频高度，单位为像素。';
COMMENT ON COLUMN ai_album_export_jobs.fps IS '导出视频帧率，单位为帧每秒。';
COMMENT ON COLUMN ai_album_export_jobs.duration_ms IS '预计或实际视频总时长，单位为毫秒；无法确定时为空。';
COMMENT ON COLUMN ai_album_export_jobs.progress_percent IS '任务进度百分比，范围为 0 至 100。';
COMMENT ON COLUMN ai_album_export_jobs.attempt_count IS '任务执行尝试次数；首次运行记为 1。';
COMMENT ON COLUMN ai_album_export_jobs.request_params IS '导出请求参数 JSON，包括项目 ID、帧数、模板、音轨标记和当前进度阶段。';
COMMENT ON COLUMN ai_album_export_jobs.local_output_path IS '导出成功后的本地 MP4 绝对路径。';
COMMENT ON COLUMN ai_album_export_jobs.oss_bucket IS '导出产物上传后的 OSS Bucket；尚未上传 OSS 时为空。';
COMMENT ON COLUMN ai_album_export_jobs.oss_key IS '导出产物上传后的 OSS Object Key；尚未上传时为空。';
COMMENT ON COLUMN ai_album_export_jobs.output_url IS '导出产物可访问 URL；仅本地保存时为空。';
COMMENT ON COLUMN ai_album_export_jobs.file_size_bytes IS '导出文件大小，单位为字节。';
COMMENT ON COLUMN ai_album_export_jobs.checksum_sha256 IS '导出文件内容的 SHA-256 校验值，64 位十六进制字符串。';
COMMENT ON COLUMN ai_album_export_jobs.error_code IS '任务失败或取消的错误代码；成功时为空。';
COMMENT ON COLUMN ai_album_export_jobs.error_message IS '任务失败或取消的错误详情；成功时为空。';
COMMENT ON COLUMN ai_album_export_jobs.queued_time IS '任务进入队列的时间，带时区。';
COMMENT ON COLUMN ai_album_export_jobs.started_time IS '任务开始执行的时间，带时区。';
COMMENT ON COLUMN ai_album_export_jobs.finished_time IS '任务成功、失败或取消的完成时间，带时区。';
COMMENT ON COLUMN ai_album_export_jobs.created_by IS '创建人标识。';
COMMENT ON COLUMN ai_album_export_jobs.updated_by IS '最后修改人标识。';
COMMENT ON COLUMN ai_album_export_jobs.created_time IS '任务记录创建时间，带时区。';
COMMENT ON COLUMN ai_album_export_jobs.updated_time IS '任务记录最后更新时间，带时区。';

COMMIT;

-- =============================================================================
-- From: 003_add_album_chat_tables.sql
-- =============================================================================

BEGIN;

CREATE TABLE ai_album_chat_sessions (
  id uuid PRIMARY KEY,
  user_id varchar(64) NOT NULL,
  album_id uuid NOT NULL,
  status varchar(32) NOT NULL DEFAULT 'active',
  title varchar(200),
  last_message_seq integer NOT NULL DEFAULT 0,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by varchar(64) NOT NULL,
  updated_by varchar(64) NOT NULL,
  created_time timestamptz NOT NULL DEFAULT now(),
  updated_time timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_chat_sessions_user_id_id UNIQUE (user_id, id),
  CONSTRAINT fk_chat_sessions_album FOREIGN KEY (user_id, album_id)
    REFERENCES ai_album_albums (user_id, id) ON DELETE CASCADE,
  CONSTRAINT ck_chat_sessions_status CHECK (status IN ('active', 'closed', 'archived')),
  CONSTRAINT ck_chat_sessions_last_message_seq CHECK (last_message_seq >= 0),
  CONSTRAINT ck_chat_sessions_metadata_object CHECK (jsonb_typeof(metadata) = 'object')
);

CREATE UNIQUE INDEX uq_chat_sessions_active_album
  ON ai_album_chat_sessions (user_id, album_id)
  WHERE status = 'active';

CREATE TABLE ai_album_chat_messages (
  id uuid PRIMARY KEY,
  user_id varchar(64) NOT NULL,
  album_id uuid NOT NULL,
  session_id uuid NOT NULL,
  role varchar(32) NOT NULL,
  message_type varchar(32) NOT NULL DEFAULT 'text',
  sequence_no integer NOT NULL,
  request_id varchar(128),
  content text NOT NULL,
  agent varchar(128),
  tool varchar(128),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_time timestamptz NOT NULL DEFAULT now(),
  created_by varchar(64) NOT NULL,
  updated_by varchar(64) NOT NULL,
  created_time timestamptz NOT NULL DEFAULT now(),
  updated_time timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_chat_messages_user_id_id UNIQUE (user_id, id),
  CONSTRAINT uq_chat_messages_session_sequence UNIQUE (session_id, sequence_no),
  CONSTRAINT fk_chat_messages_session FOREIGN KEY (user_id, session_id)
    REFERENCES ai_album_chat_sessions (user_id, id) ON DELETE CASCADE,
  CONSTRAINT fk_chat_messages_album FOREIGN KEY (user_id, album_id)
    REFERENCES ai_album_albums (user_id, id) ON DELETE CASCADE,
  CONSTRAINT ck_chat_messages_role CHECK (role IN ('user', 'assistant', 'system', 'tool')),
  CONSTRAINT ck_chat_messages_type CHECK (
    message_type IN ('text', 'option_selection', 'form_submission', 'confirmation', 'tool_result', 'system_event')
  ),
  CONSTRAINT ck_chat_messages_sequence_no CHECK (sequence_no > 0),
  CONSTRAINT ck_chat_messages_payload_object CHECK (jsonb_typeof(payload) = 'object')
);

CREATE INDEX idx_chat_sessions_user_album_updated
  ON ai_album_chat_sessions (user_id, album_id, updated_time DESC);
CREATE INDEX idx_chat_messages_user_album_sequence
  ON ai_album_chat_messages (user_id, album_id, sequence_no);
CREATE INDEX idx_chat_messages_user_request
  ON ai_album_chat_messages (user_id, request_id)
  WHERE request_id IS NOT NULL;
COMMENT ON TABLE ai_album_chat_sessions IS '相册聊天会话表：保存每个用户相册的活动会话及消息顺序游标。';
COMMENT ON COLUMN ai_album_chat_sessions.id IS '聊天会话主键，由应用生成的 UUID。';
COMMENT ON COLUMN ai_album_chat_sessions.user_id IS '会话所属用户 ID，用于数据隔离。';
COMMENT ON COLUMN ai_album_chat_sessions.album_id IS '会话所属相册 ID，与 user_id 共同引用相册主表。';
COMMENT ON COLUMN ai_album_chat_sessions.status IS '会话状态：active 进行中、closed 已结束、archived 已归档。';
COMMENT ON COLUMN ai_album_chat_sessions.title IS '会话标题；默认可使用创建会话时的相册标题。';
COMMENT ON COLUMN ai_album_chat_sessions.last_message_seq IS '会话内最后分配的消息序号，通过原子递增为新消息分配顺序。';
COMMENT ON COLUMN ai_album_chat_sessions.metadata IS '会话扩展元数据 JSON，例如会话来源和后续模型配置。';
COMMENT ON COLUMN ai_album_chat_sessions.created_by IS '会话创建人标识。';
COMMENT ON COLUMN ai_album_chat_sessions.updated_by IS '会话最后修改人标识。';
COMMENT ON COLUMN ai_album_chat_sessions.created_time IS '会话记录创建时间，带时区。';
COMMENT ON COLUMN ai_album_chat_sessions.updated_time IS '会话记录最后更新时间，带时区。';

COMMENT ON TABLE ai_album_chat_messages IS '相册聊天消息表：保存角色、消息类型、顺序、请求关联 ID、内容及扩展载荷。';
COMMENT ON COLUMN ai_album_chat_messages.id IS '聊天消息主键，由应用生成的 UUID。';
COMMENT ON COLUMN ai_album_chat_messages.user_id IS '消息所属用户 ID，用于数据隔离。';
COMMENT ON COLUMN ai_album_chat_messages.album_id IS '消息所属相册 ID，与 user_id 共同引用相册主表。';
COMMENT ON COLUMN ai_album_chat_messages.session_id IS '消息所属聊天会话 ID，与 user_id 共同引用聊天会话表。';
COMMENT ON COLUMN ai_album_chat_messages.role IS '消息角色：user 用户、assistant 助手、system 系统或 tool 工具。';
COMMENT ON COLUMN ai_album_chat_messages.message_type IS '消息类型：text、option_selection、form_submission、confirmation、tool_result 或 system_event。';
COMMENT ON COLUMN ai_album_chat_messages.request_id IS '产生消息的 HTTP 请求或后台操作关联 ID。';
COMMENT ON COLUMN ai_album_chat_messages.sequence_no IS '消息在会话内的严格递增序号。';
COMMENT ON COLUMN ai_album_chat_messages.content IS '消息正文；保留用户输入或向界面展示的助手回复。';
COMMENT ON COLUMN ai_album_chat_messages.agent IS '生成助手消息的 Agent 标识；非助手消息通常为空。';
COMMENT ON COLUMN ai_album_chat_messages.tool IS '生成工具消息的工具标识；非工具消息通常为空。';
COMMENT ON COLUMN ai_album_chat_messages.payload IS '消息扩展载荷 JSON，例如工具输出，或选项、表单、确认、聚焦帧等结构化用户选择。';
COMMENT ON COLUMN ai_album_chat_messages.occurred_time IS '消息实际发生时间；可早于数据库记录创建时间。';
COMMENT ON COLUMN ai_album_chat_messages.created_by IS '消息创建人标识。';
COMMENT ON COLUMN ai_album_chat_messages.updated_by IS '消息最后修改人标识。';
COMMENT ON COLUMN ai_album_chat_messages.created_time IS '消息记录创建时间，带时区。';
COMMENT ON COLUMN ai_album_chat_messages.updated_time IS '消息记录最后更新时间，带时区。';

COMMIT;

-- =============================================================================
-- From: 004_add_oss_cleanup_indexes.sql
-- =============================================================================

-- Indexes used by the bounded OSS garbage-collection task.

CREATE INDEX IF NOT EXISTS idx_assets_deleted_oss_updated_time
  ON ai_album_assets (updated_time, id)
  WHERE status = 'deleted' AND oss_bucket IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_assets_album_oss
  ON ai_album_assets (album_id, id)
  WHERE oss_bucket IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_albums_deleted_updated_time
  ON ai_album_albums (updated_time, id)
  WHERE status = 'deleted';

CREATE INDEX IF NOT EXISTS idx_export_jobs_album_oss
  ON ai_album_export_jobs (album_id, id)
  WHERE oss_bucket IS NOT NULL AND oss_key IS NOT NULL;

COMMENT ON INDEX idx_assets_deleted_oss_updated_time IS
  'Speeds up retention-based OSS cleanup for soft-deleted assets.';
COMMENT ON INDEX idx_assets_album_oss IS
  'Finds OSS assets owned by a soft-deleted album.';
COMMENT ON INDEX idx_albums_deleted_updated_time IS
  'Finds albums whose OSS artifacts are past the cleanup retention window.';
COMMENT ON INDEX idx_export_jobs_album_oss IS
  'Finds exported OSS artifacts associated with deleted albums.';

-- =============================================================================
-- From: 005_add_album_page_html_oss.sql
-- =============================================================================

ALTER TABLE ai_album_album_pages
  ADD COLUMN IF NOT EXISTS html_oss_bucket varchar(128),
  ADD COLUMN IF NOT EXISTS html_oss_key varchar(1024),
  ADD COLUMN IF NOT EXISTS html_url text,
  ADD COLUMN IF NOT EXISTS html_checksum_sha256 varchar(64);

CREATE INDEX IF NOT EXISTS idx_album_pages_album_html_oss
  ON ai_album_album_pages (album_id, id)
  WHERE html_oss_bucket IS NOT NULL AND html_oss_key IS NOT NULL;

COMMENT ON COLUMN ai_album_album_pages.html_oss_bucket IS
  'Bucket containing the published standalone HTML document.';
COMMENT ON COLUMN ai_album_album_pages.html_oss_key IS
  'OSS object key for the published standalone HTML document.';
COMMENT ON COLUMN ai_album_album_pages.html_url IS
  'Public or CDN URL of the published standalone HTML document.';
COMMENT ON COLUMN ai_album_album_pages.html_checksum_sha256 IS
  'SHA-256 checksum of the uploaded HTML bytes.';
COMMENT ON INDEX idx_album_pages_album_html_oss IS
  'Finds published HTML objects associated with deleted albums.';

-- =============================================================================
-- From: 006_enable_multi_agent_sessions.sql
-- =============================================================================

BEGIN;

LOCK TABLE public.ai_album_chat_sessions IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.ai_album_chat_messages IN SHARE ROW EXCLUSIVE MODE;

DROP INDEX IF EXISTS public.uq_chat_sessions_active_album;

CREATE INDEX IF NOT EXISTS idx_chat_sessions_user_album_status_updated
  ON public.ai_album_chat_sessions (
    user_id,
    album_id,
    status,
    updated_time DESC
  );

CREATE INDEX IF NOT EXISTS idx_chat_messages_user_session_sequence
  ON public.ai_album_chat_messages (
    user_id,
    session_id,
    sequence_no
  );

COMMENT ON TABLE public.ai_album_chat_sessions IS
  '相册 Agent 会话表：同一用户相册可包含多个独立活动会话。';

COMMENT ON COLUMN public.ai_album_chat_sessions.metadata IS
  'Session 扩展状态，包括模型、prompt/toolset 版本、view state、待确认操作和工具幂等结果。';

COMMIT;

-- =============================================================================
-- From: 007_migrate_legacy_assets.sql
-- =============================================================================

BEGIN;

-- Move historical Project.assets[] snapshots out of album settings. The
-- original project-level id is retained in metadata because older local assets
-- commonly use a SHA-1 id while ai_album_assets uses UUID primary keys.
WITH legacy AS (
  SELECT
    album.id AS album_id,
    album.user_id,
    album.created_by,
    album.updated_by,
    asset.value AS asset,
    asset.ordinality
  FROM ai_album_albums album
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE
      WHEN jsonb_typeof(album.settings->'legacy_assets') = 'array'
        THEN album.settings->'legacy_assets'
      ELSE '[]'::jsonb
    END
  ) WITH ORDINALITY AS asset(value, ordinality)
), normalized AS (
  SELECT
    (
      substr(md5(user_id || ':' || album_id::text || ':' || COALESCE(asset->>'id', ordinality::text)), 1, 8)
      || '-' || substr(md5(user_id || ':' || album_id::text || ':' || COALESCE(asset->>'id', ordinality::text)), 9, 4)
      || '-4' || substr(md5(user_id || ':' || album_id::text || ':' || COALESCE(asset->>'id', ordinality::text)), 14, 3)
      || '-8' || substr(md5(user_id || ':' || album_id::text || ':' || COALESCE(asset->>'id', ordinality::text)), 18, 3)
      || '-' || substr(md5(user_id || ':' || album_id::text || ':' || COALESCE(asset->>'id', ordinality::text)), 21, 12)
    )::uuid AS id,
    album_id,
    user_id,
    created_by,
    updated_by,
    asset,
    COALESCE(asset->>'id', ordinality::text) AS project_asset_id
  FROM legacy
  WHERE jsonb_typeof(asset) = 'object'
)
INSERT INTO ai_album_assets (
  id, user_id, album_id, asset_type, usage_type, source, status,
  oss_key, url, file_name, mime_type, file_ext, file_size_bytes,
  width, height, duration_ms, metadata, created_by, updated_by
)
SELECT
  item.id,
  item.user_id,
  item.album_id,
  CASE item.asset->>'type'
    WHEN 'image' THEN 'image'
    WHEN 'video' THEN 'video'
    WHEN 'audio' THEN 'audio'
    WHEN 'text' THEN 'text'
    WHEN 'data' THEN 'data'
    WHEN 'reference-link' THEN 'reference_link'
    ELSE 'other'
  END,
  'source',
  'system',
  'available',
  'internal/albums/' || item.album_id::text || '/assets/' || md5(item.project_asset_id),
  COALESCE(item.asset->>'path', 'urn:html-video:legacy-asset:' || item.project_asset_id),
  item.asset#>>'{metadata,filename}',
  item.asset#>>'{metadata,mimeType}',
  CASE
    WHEN item.asset#>>'{metadata,filename}' LIKE '%.%'
      THEN substring(item.asset#>>'{metadata,filename}' FROM '\.[^.]+$')
    ELSE NULL
  END,
  NULLIF(item.asset#>>'{metadata,sizeBytes}', '')::bigint,
  NULLIF(item.asset#>>'{metadata,width}', '')::integer,
  NULLIF(item.asset#>>'{metadata,height}', '')::integer,
  CASE
    WHEN NULLIF(item.asset#>>'{metadata,durationSec}', '') IS NULL THEN NULL
    ELSE round((item.asset#>>'{metadata,durationSec}')::numeric * 1000)::integer
  END,
  jsonb_strip_nulls(jsonb_build_object(
    'project_asset_id', item.project_asset_id,
    'local_path', item.asset->>'path',
    'inline_content', item.asset->>'content',
    'user_tags', COALESCE(item.asset->'userTags', '[]'::jsonb),
    'user_caption', item.asset#>>'{metadata,userCaption}',
    'migrated_from', 'ai_album_albums.settings.legacy_assets'
  )),
  item.created_by,
  item.updated_by
FROM normalized item
WHERE NOT EXISTS (
  SELECT 1
  FROM ai_album_assets current
  WHERE current.user_id = item.user_id
    AND current.album_id = item.album_id
    AND (
      current.id::text = item.project_asset_id
      OR current.metadata->>'project_asset_id' = item.project_asset_id
    )
)
ON CONFLICT DO NOTHING;

UPDATE ai_album_albums
SET settings = settings - 'legacy_assets',
    updated_time = now()
WHERE settings ? 'legacy_assets';

COMMIT;

