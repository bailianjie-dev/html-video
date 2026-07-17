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
