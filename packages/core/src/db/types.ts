export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export type TimestampValue = string | Date;

export type AlbumStatus = 'draft' | 'previewed' | 'rendered' | 'published' | 'archived' | 'deleted';
export type AlbumPageStatus = 'draft' | 'ready' | 'disabled' | 'deleted';
export type DbAssetType = 'image' | 'video' | 'audio' | 'font' | 'text' | 'data' | 'reference_link' | 'other';
export type AssetUsageType = 'source' | 'cover' | 'background' | 'music' | 'thumbnail' | 'export' | 'other';
export type AssetSource = 'upload' | 'ai_generated' | 'system';
export type AssetStatus = 'uploading' | 'available' | 'failed' | 'deleted';
export type AiGenerationType =
  | 'album_outline'
  | 'page_copy'
  | 'page_html'
  | 'image'
  | 'audio'
  | 'video'
  | 'narration'
  | 'music'
  | 'frame_enhance'
  | 'other';
export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
export type ExportFormat = 'mp4';
export type ChatSessionStatus = 'active' | 'closed' | 'archived';
export type ChatMessageRole = 'user' | 'assistant' | 'system' | 'tool';
export type ChatMessageType =
  | 'text'
  | 'option_selection'
  | 'form_submission'
  | 'confirmation'
  | 'tool_result'
  | 'system_event';

export interface AuditColumns {
  created_by: string;
  updated_by: string;
  created_time: TimestampValue;
  updated_time: TimestampValue;
}

export interface AlbumRow extends AuditColumns {
  id: string;
  user_id: string;
  source_project_id: string | null;
  title: string;
  description: string | null;
  status: AlbumStatus;
  cover_asset_id: string | null;
  last_preview_asset_id: string | null;
  last_preview_html_url: string | null;
  last_preview_poster_url: string | null;
  canvas_width: number;
  canvas_height: number;
  fps: number;
  duration_ms: number;
  page_count: number;
  settings: JsonObject;
}

export type CreateAlbumInput = {
  id: string;
  user_id: string;
  created_by: string;
  updated_by: string;
  title: string;
  source_project_id?: string | null;
  description?: string | null;
  status?: AlbumStatus;
  cover_asset_id?: string | null;
  last_preview_asset_id?: string | null;
  last_preview_html_url?: string | null;
  last_preview_poster_url?: string | null;
  canvas_width?: number;
  canvas_height?: number;
  fps?: number;
  duration_ms?: number;
  page_count?: number;
  settings?: JsonObject;
};

export type UpdateAlbumPatch = Partial<{
  title: string;
  description: string | null;
  status: AlbumStatus;
  cover_asset_id: string | null;
  last_preview_asset_id: string | null;
  last_preview_html_url: string | null;
  last_preview_poster_url: string | null;
  canvas_width: number;
  canvas_height: number;
  fps: number;
  duration_ms: number;
  page_count: number;
  settings: JsonObject;
}>;

export interface AlbumPageRow extends AuditColumns {
  id: string;
  user_id: string;
  album_id: string;
  node_id: string | null;
  page_no: number;
  title: string | null;
  status: AlbumPageStatus;
  template_key: string | null;
  duration_ms: number;
  raw_html: string | null;
  html_oss_bucket: string | null;
  html_oss_key: string | null;
  html_url: string | null;
  html_checksum_sha256: string | null;
  preview_asset_id: string | null;
  poster_asset_id: string | null;
  content: JsonObject;
  style: JsonObject;
  transition: JsonObject;
}

export type CreateAlbumPageInput = {
  id: string;
  user_id: string;
  album_id: string;
  page_no: number;
  created_by: string;
  updated_by: string;
  node_id?: string | null;
  title?: string | null;
  status?: AlbumPageStatus;
  template_key?: string | null;
  duration_ms?: number;
  raw_html?: string | null;
  html_oss_bucket?: string | null;
  html_oss_key?: string | null;
  html_url?: string | null;
  html_checksum_sha256?: string | null;
  preview_asset_id?: string | null;
  poster_asset_id?: string | null;
  content?: JsonObject;
  style?: JsonObject;
  transition?: JsonObject;
};

export type UpdateAlbumPagePatch = Partial<{
  node_id: string | null;
  page_no: number;
  title: string | null;
  status: AlbumPageStatus;
  template_key: string | null;
  duration_ms: number;
  raw_html: string | null;
  html_oss_bucket: string | null;
  html_oss_key: string | null;
  html_url: string | null;
  html_checksum_sha256: string | null;
  preview_asset_id: string | null;
  poster_asset_id: string | null;
  content: JsonObject;
  style: JsonObject;
  transition: JsonObject;
}>;

export interface AssetRow extends AuditColumns {
  id: string;
  user_id: string;
  album_id: string | null;
  page_id: string | null;
  asset_type: DbAssetType;
  usage_type: AssetUsageType;
  source: AssetSource;
  status: AssetStatus;
  oss_bucket: string | null;
  oss_key: string;
  url: string;
  thumbnail_url: string | null;
  file_name: string | null;
  mime_type: string | null;
  file_ext: string | null;
  file_size_bytes: number | null;
  width: number | null;
  height: number | null;
  duration_ms: number | null;
  checksum_sha256: string | null;
  metadata: JsonObject;
}

export type CreateAssetInput = {
  id: string;
  user_id: string;
  created_by: string;
  updated_by: string;
  asset_type: DbAssetType;
  oss_key: string;
  url: string;
  album_id?: string | null;
  page_id?: string | null;
  usage_type?: AssetUsageType;
  source?: AssetSource;
  status?: AssetStatus;
  oss_bucket?: string | null;
  thumbnail_url?: string | null;
  file_name?: string | null;
  mime_type?: string | null;
  file_ext?: string | null;
  file_size_bytes?: number | null;
  width?: number | null;
  height?: number | null;
  duration_ms?: number | null;
  checksum_sha256?: string | null;
  metadata?: JsonObject;
};

export type UpdateAssetPatch = Partial<{
  album_id: string | null;
  page_id: string | null;
  asset_type: DbAssetType;
  usage_type: AssetUsageType;
  source: AssetSource;
  status: AssetStatus;
  oss_bucket: string | null;
  oss_key: string;
  url: string;
  thumbnail_url: string | null;
  file_name: string | null;
  mime_type: string | null;
  file_ext: string | null;
  file_size_bytes: number | null;
  width: number | null;
  height: number | null;
  duration_ms: number | null;
  checksum_sha256: string | null;
  metadata: JsonObject;
}>;

export interface ChatSessionRow extends AuditColumns {
  id: string;
  user_id: string;
  album_id: string;
  status: ChatSessionStatus;
  title: string | null;
  last_message_seq: number;
  metadata: JsonObject;
}

export type CreateChatSessionInput = {
  id: string;
  user_id: string;
  album_id: string;
  created_by: string;
  updated_by: string;
  status?: ChatSessionStatus;
  title?: string | null;
  last_message_seq?: number;
  metadata?: JsonObject;
};

export interface ChatMessageRow extends AuditColumns {
  id: string;
  user_id: string;
  album_id: string;
  session_id: string;
  role: ChatMessageRole;
  message_type: ChatMessageType;
  sequence_no: number;
  request_id: string | null;
  content: string;
  agent: string | null;
  tool: string | null;
  payload: JsonObject;
  occurred_time: TimestampValue;
}

export type CreateChatMessageInput = {
  id: string;
  user_id: string;
  album_id: string;
  session_id: string;
  role: ChatMessageRole;
  message_type: ChatMessageType;
  sequence_no: number;
  content: string;
  created_by: string;
  updated_by: string;
  request_id?: string | null;
  agent?: string | null;
  tool?: string | null;
  payload?: JsonObject;
  occurred_time?: TimestampValue;
};

export interface AiGenerationLogRow extends AuditColumns {
  id: string;
  user_id: string;
  album_id: string | null;
  page_id: string | null;
  generated_asset_id: string | null;
  generation_type: AiGenerationType;
  provider: string;
  model: string;
  status: JobStatus;
  prompt: string | null;
  request_payload: JsonObject;
  response_payload: JsonObject;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  total_tokens: number | null;
  cost_amount: string | number | null;
  error_code: string | null;
  error_message: string | null;
  started_time: TimestampValue | null;
  finished_time: TimestampValue | null;
}

export type CreateAiGenerationLogInput = {
  id: string;
  user_id: string;
  created_by: string;
  updated_by: string;
  generation_type: AiGenerationType;
  provider: string;
  model: string;
  album_id?: string | null;
  page_id?: string | null;
  generated_asset_id?: string | null;
  status?: JobStatus;
  prompt?: string | null;
  request_payload?: JsonObject;
  response_payload?: JsonObject;
  prompt_tokens?: number | null;
  completion_tokens?: number | null;
  total_tokens?: number | null;
  cost_amount?: string | number | null;
  error_code?: string | null;
  error_message?: string | null;
  started_time?: TimestampValue | null;
  finished_time?: TimestampValue | null;
};

export type UpdateAiGenerationLogPatch = Partial<{
  album_id: string | null;
  page_id: string | null;
  generated_asset_id: string | null;
  generation_type: AiGenerationType;
  provider: string;
  model: string;
  status: JobStatus;
  prompt: string | null;
  request_payload: JsonObject;
  response_payload: JsonObject;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  total_tokens: number | null;
  cost_amount: string | number | null;
  error_code: string | null;
  error_message: string | null;
  started_time: TimestampValue | null;
  finished_time: TimestampValue | null;
}>;

export interface ExportJobRow extends AuditColumns {
  id: string;
  user_id: string;
  album_id: string;
  status: JobStatus;
  export_format: ExportFormat;
  render_profile: string;
  width: number;
  height: number;
  fps: number;
  duration_ms: number | null;
  progress_percent: string | number;
  attempt_count: number;
  request_params: JsonObject;
  local_output_path: string | null;
  oss_bucket: string | null;
  oss_key: string | null;
  output_url: string | null;
  file_size_bytes: number | null;
  checksum_sha256: string | null;
  error_code: string | null;
  error_message: string | null;
  queued_time: TimestampValue;
  started_time: TimestampValue | null;
  finished_time: TimestampValue | null;
}

export type CreateExportJobInput = {
  id: string;
  user_id: string;
  album_id: string;
  created_by: string;
  updated_by: string;
  status?: JobStatus;
  export_format?: ExportFormat;
  render_profile?: string;
  width?: number;
  height?: number;
  fps?: number;
  duration_ms?: number | null;
  progress_percent?: number;
  attempt_count?: number;
  request_params?: JsonObject;
  local_output_path?: string | null;
  oss_bucket?: string | null;
  oss_key?: string | null;
  output_url?: string | null;
  file_size_bytes?: number | null;
  checksum_sha256?: string | null;
  error_code?: string | null;
  error_message?: string | null;
  queued_time?: TimestampValue;
  started_time?: TimestampValue | null;
  finished_time?: TimestampValue | null;
};

export type UpdateExportJobPatch = Partial<{
  status: JobStatus;
  export_format: ExportFormat;
  render_profile: string;
  width: number;
  height: number;
  fps: number;
  duration_ms: number | null;
  progress_percent: number;
  attempt_count: number;
  request_params: JsonObject;
  local_output_path: string | null;
  oss_bucket: string | null;
  oss_key: string | null;
  output_url: string | null;
  file_size_bytes: number | null;
  checksum_sha256: string | null;
  error_code: string | null;
  error_message: string | null;
  queued_time: TimestampValue;
  started_time: TimestampValue | null;
  finished_time: TimestampValue | null;
}>;
