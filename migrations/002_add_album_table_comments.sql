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
