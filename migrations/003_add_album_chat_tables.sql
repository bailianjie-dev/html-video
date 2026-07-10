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
