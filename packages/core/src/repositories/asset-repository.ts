import { firstRow, type DbClient } from '../db/client.js';
import type { AssetRow, AssetStatus, CreateAssetInput, UpdateAssetPatch } from '../db/types.js';
import { buildUpdateSet } from './sql-utils.js';

const ASSET_UPDATE_COLUMNS = [
  'album_id',
  'page_id',
  'asset_type',
  'usage_type',
  'source',
  'status',
  'oss_bucket',
  'oss_key',
  'url',
  'thumbnail_url',
  'file_name',
  'mime_type',
  'file_ext',
  'file_size_bytes',
  'width',
  'height',
  'duration_ms',
  'checksum_sha256',
  'metadata',
  'updated_by',
  'updated_time',
] as const;

export class AssetRepository {
  constructor(private readonly db: DbClient) {}

  async create(input: CreateAssetInput): Promise<AssetRow> {
    const result = await this.db.query<AssetRow>(
      `INSERT INTO ai_album_assets (
        id, user_id, album_id, page_id, asset_type, usage_type, source, status,
        oss_bucket, oss_key, url, thumbnail_url, file_name, mime_type, file_ext,
        file_size_bytes, width, height, duration_ms, checksum_sha256, metadata,
        created_by, updated_by
      ) VALUES (
        $1, $2, $3, $4, $5, COALESCE($6, 'source'), COALESCE($7, 'upload'), COALESCE($8, 'available'),
        $9, $10, $11, $12, $13, $14, $15,
        $16, $17, $18, $19, $20, COALESCE($21, '{}'::jsonb),
        $22, $23
      ) RETURNING *`,
      [
        input.id,
        input.user_id,
        input.album_id ?? null,
        input.page_id ?? null,
        input.asset_type,
        input.usage_type ?? null,
        input.source ?? null,
        input.status ?? null,
        input.oss_bucket ?? null,
        input.oss_key,
        input.url,
        input.thumbnail_url ?? null,
        input.file_name ?? null,
        input.mime_type ?? null,
        input.file_ext ?? null,
        input.file_size_bytes ?? null,
        input.width ?? null,
        input.height ?? null,
        input.duration_ms ?? null,
        input.checksum_sha256 ?? null,
        input.metadata ?? {},
        input.created_by,
        input.updated_by,
      ],
    );
    return result.rows[0]!;
  }

  async findById(userId: string, id: string): Promise<AssetRow | null> {
    return firstRow(await this.db.query<AssetRow>(
      `SELECT * FROM ai_album_assets WHERE user_id = $1 AND id = $2`,
      [userId, id],
    ));
  }

  async findByOssKey(userId: string, ossKey: string): Promise<AssetRow | null> {
    return firstRow(await this.db.query<AssetRow>(
      `SELECT * FROM ai_album_assets WHERE user_id = $1 AND oss_key = $2`,
      [userId, ossKey],
    ));
  }

  async listByAlbum(userId: string, albumId: string, opts: { includeDeleted?: boolean } = {}): Promise<AssetRow[]> {
    const result = await this.db.query<AssetRow>(
      `SELECT * FROM ai_album_assets
       WHERE user_id = $1 AND album_id = $2 AND ($3::boolean OR status <> 'deleted')
       ORDER BY created_time DESC`,
      [userId, albumId, opts.includeDeleted ?? false],
    );
    return result.rows;
  }

  async listByPage(userId: string, pageId: string, opts: { includeDeleted?: boolean } = {}): Promise<AssetRow[]> {
    const result = await this.db.query<AssetRow>(
      `SELECT * FROM ai_album_assets
       WHERE user_id = $1 AND page_id = $2 AND ($3::boolean OR status <> 'deleted')
       ORDER BY created_time DESC`,
      [userId, pageId, opts.includeDeleted ?? false],
    );
    return result.rows;
  }

  async update(userId: string, id: string, patch: UpdateAssetPatch, updatedBy: string): Promise<AssetRow | null> {
    const { assignments, values } = buildUpdateSet(patch, 3, {
      updated_by: updatedBy,
      updated_time: new Date(),
    }, ASSET_UPDATE_COLUMNS);
    if (!assignments) return this.findById(userId, id);
    return firstRow(await this.db.query<AssetRow>(
      `UPDATE ai_album_assets SET ${assignments} WHERE user_id = $1 AND id = $2 RETURNING *`,
      [userId, id, ...values],
    ));
  }

  async updateStatus(userId: string, id: string, status: AssetStatus, updatedBy: string): Promise<AssetRow | null> {
    return this.update(userId, id, { status }, updatedBy);
  }

  async softDelete(userId: string, id: string, updatedBy: string): Promise<AssetRow | null> {
    return this.updateStatus(userId, id, 'deleted', updatedBy);
  }
}
