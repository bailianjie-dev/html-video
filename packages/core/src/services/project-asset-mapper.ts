import { createHash, randomUUID } from 'node:crypto';
import { extname } from 'node:path';
import type {
  AssetRow,
  CreateAssetInput,
  DbAssetType,
  JsonObject,
  JsonValue,
  UpdateAssetPatch,
} from '../db/types.js';
import type { Asset, AssetType } from '../types/index.js';

const PROJECT_ASSET_ID = 'project_asset_id';

export function assetRowToProjectAsset(row: AssetRow): Asset {
  const metadata = row.metadata as Record<string, JsonValue | undefined>;
  const localPath = stringValue(metadata.local_path);
  const inlineContent = stringValue(metadata.inline_content);
  const userCaption = stringValue(metadata.user_caption);
  const userTags = Array.isArray(metadata.user_tags)
    ? metadata.user_tags.filter((value): value is string => typeof value === 'string')
    : [];
  return {
    id: stringValue(metadata[PROJECT_ASSET_ID]) ?? row.id,
    type: fromDbAssetType(row.asset_type),
    ...(localPath ? { path: localPath } : row.url ? { path: row.url } : {}),
    ...(inlineContent !== undefined ? { content: inlineContent } : {}),
    metadata: {
      ...(row.file_name ? { filename: row.file_name } : {}),
      ...(row.mime_type ? { mimeType: row.mime_type } : {}),
      ...(row.file_size_bytes !== null ? { sizeBytes: row.file_size_bytes } : {}),
      ...(row.width !== null ? { width: row.width } : {}),
      ...(row.height !== null ? { height: row.height } : {}),
      ...(row.duration_ms !== null ? { durationSec: row.duration_ms / 1000 } : {}),
      ...(userCaption !== undefined ? { userCaption } : {}),
    },
    userTags,
  };
}

export function projectAssetIdentity(row: AssetRow): string {
  const value = (row.metadata as Record<string, JsonValue | undefined>)[PROJECT_ASSET_ID];
  return stringValue(value) ?? row.id;
}

export function projectAssetToCreateInput(
  asset: Asset,
  albumId: string,
  userId: string,
  actorId: string,
): CreateAssetInput {
  const id = isUuid(asset.id) ? asset.id : randomUUID();
  const internalKey = internalAssetKey(albumId, asset.id);
  return {
    id,
    user_id: userId,
    album_id: albumId,
    asset_type: toDbAssetType(asset.type),
    usage_type: 'source',
    source: 'system',
    status: 'available',
    oss_key: internalKey,
    url: asset.path ?? `urn:html-video:${internalKey}`,
    file_name: asset.metadata.filename ?? null,
    mime_type: asset.metadata.mimeType ?? null,
    file_ext: asset.metadata.filename ? extname(asset.metadata.filename) || null : null,
    file_size_bytes: asset.metadata.sizeBytes ?? null,
    width: asset.metadata.width ?? null,
    height: asset.metadata.height ?? null,
    duration_ms: asset.metadata.durationSec === undefined
      ? null
      : Math.max(0, Math.round(asset.metadata.durationSec * 1000)),
    metadata: projectAssetMetadata(asset),
    created_by: actorId,
    updated_by: actorId,
  };
}

export function projectAssetToUpdatePatch(asset: Asset, existing: AssetRow): UpdateAssetPatch {
  const isExternalObject = existing.oss_bucket !== null;
  return {
    asset_type: toDbAssetType(asset.type),
    status: 'available',
    ...(!isExternalObject && {
      url: asset.path ?? existing.url,
      file_name: asset.metadata.filename ?? null,
      mime_type: asset.metadata.mimeType ?? null,
      file_ext: asset.metadata.filename ? extname(asset.metadata.filename) || null : null,
      file_size_bytes: asset.metadata.sizeBytes ?? null,
      width: asset.metadata.width ?? null,
      height: asset.metadata.height ?? null,
      duration_ms: asset.metadata.durationSec === undefined
        ? null
        : Math.max(0, Math.round(asset.metadata.durationSec * 1000)),
    }),
    metadata: {
      ...existing.metadata,
      ...projectAssetMetadata(asset),
    },
  };
}

function projectAssetMetadata(asset: Asset): JsonObject {
  return stripUndefined({
    [PROJECT_ASSET_ID]: asset.id,
    local_path: asset.path,
    inline_content: asset.content,
    user_tags: asset.userTags,
    user_caption: asset.metadata.userCaption,
  });
}

function internalAssetKey(albumId: string, assetId: string): string {
  const digest = createHash('sha256').update(assetId).digest('hex');
  return `internal/albums/${albumId}/assets/${digest}`;
}

function toDbAssetType(type: AssetType): DbAssetType {
  return type === 'reference-link' ? 'reference_link' : type;
}

function fromDbAssetType(type: DbAssetType): AssetType {
  if (type === 'reference_link' || type === 'font' || type === 'other') return 'reference-link';
  return type;
}

function stringValue(value: JsonValue | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function stripUndefined(value: Record<string, unknown>): JsonObject {
  const out: JsonObject = {};
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined) out[key] = item as JsonValue;
  }
  return out;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
