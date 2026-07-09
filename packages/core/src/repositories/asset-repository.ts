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

  /**
   * System-maintenance query. User-facing reads must continue to use the
   * user-scoped methods above.
   */
  async listOssGarbageCandidates(deletedBefore: Date, limit = 100): Promise<AssetRow[]> {
    const result = await this.db.query<AssetRow>(
      `SELECT candidate.*
       FROM ai_album_assets candidate
       LEFT JOIN ai_album_albums candidate_album
         ON candidate_album.id = candidate.album_id
        AND candidate_album.user_id = candidate.user_id
       WHERE (
           (candidate.status = 'deleted' AND candidate.updated_time <= $1)
           OR
           (candidate_album.status = 'deleted' AND candidate_album.updated_time <= $1)
         )
         AND candidate.oss_bucket IS NOT NULL
         AND NOT EXISTS (
           SELECT 1
           FROM ai_album_assets active
           LEFT JOIN ai_album_albums active_album
             ON active_album.id = active.album_id
            AND active_album.user_id = active.user_id
           WHERE active.status <> 'deleted'
             AND (active_album.status IS NULL OR active_album.status <> 'deleted')
             AND active.oss_bucket = candidate.oss_bucket
             AND active.oss_key = candidate.oss_key
         )
       ORDER BY COALESCE(candidate_album.updated_time, candidate.updated_time) ASC, candidate.id ASC
       LIMIT $2`,
      [deletedBefore, limit],
    );
    return result.rows;
  }

  /**
   * Permanently removes a row only while it is still soft-deleted. Intended
   * for the OSS garbage collector after the corresponding object is gone.
   */
  async deleteGarbageCandidate(userId: string, id: string): Promise<AssetRow | null> {
    return firstRow(await this.db.query<AssetRow>(
      `DELETE FROM ai_album_assets candidate
       WHERE candidate.user_id = $1
         AND candidate.id = $2
         AND (
           candidate.status = 'deleted'
           OR EXISTS (
             SELECT 1
             FROM ai_album_albums album
             WHERE album.id = candidate.album_id
               AND album.user_id = candidate.user_id
               AND album.status = 'deleted'
           )
         )
       RETURNING candidate.*`,
      [userId, id],
    ));
  }
}
