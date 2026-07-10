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
