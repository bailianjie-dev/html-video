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
