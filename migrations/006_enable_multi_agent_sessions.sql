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
