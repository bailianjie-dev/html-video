import { firstRow, type DbClient } from '../db/client.js';
import type { AlbumRow, AlbumStatus, CreateAlbumInput, JsonObject, UpdateAlbumPatch } from '../db/types.js';
import { buildUpdateSet } from './sql-utils.js';

const ALBUM_UPDATE_COLUMNS = [
  'title',
  'description',
  'status',
  'cover_asset_id',
  'last_preview_asset_id',
  'last_preview_html_url',
  'last_preview_poster_url',
  'canvas_width',
  'canvas_height',
  'fps',
  'duration_ms',
  'page_count',
  'settings',
  'updated_by',
  'updated_time',
] as const;

export class AlbumRepository {
  constructor(private readonly db: DbClient) {}

  async create(input: CreateAlbumInput): Promise<AlbumRow> {
    const result = await this.db.query<AlbumRow>(
      `INSERT INTO ai_album_albums (
        id, user_id, source_project_id, title, description, status, cover_asset_id,
        last_preview_asset_id, last_preview_html_url, last_preview_poster_url,
        canvas_width, canvas_height, fps, duration_ms, page_count, settings,
        created_by, updated_by
      ) VALUES (
        $1, $2, $3, $4, $5, COALESCE($6, 'draft'), $7,
        $8, $9, $10,
        COALESCE($11, 1080), COALESCE($12, 1920), COALESCE($13, 30),
        COALESCE($14, 0), COALESCE($15, 0), COALESCE($16, '{}'::jsonb),
        $17, $18
      ) RETURNING *`,
      [
        input.id,
        input.user_id,
        input.source_project_id ?? null,
        input.title,
        input.description ?? null,
        input.status ?? null,
        input.cover_asset_id ?? null,
        input.last_preview_asset_id ?? null,
        input.last_preview_html_url ?? null,
        input.last_preview_poster_url ?? null,
        input.canvas_width ?? null,
        input.canvas_height ?? null,
        input.fps ?? null,
        input.duration_ms ?? null,
        input.page_count ?? null,
        input.settings ?? {},
        input.created_by,
        input.updated_by,
      ],
    );
    return result.rows[0]!;
  }

  async findById(userId: string, id: string): Promise<AlbumRow | null> {
    return firstRow(await this.db.query<AlbumRow>(
      `SELECT * FROM ai_album_albums WHERE user_id = $1 AND id = $2`,
      [userId, id],
    ));
  }

  async findBySourceProjectId(userId: string, sourceProjectId: string): Promise<AlbumRow | null> {
    return firstRow(await this.db.query<AlbumRow>(
      `SELECT * FROM ai_album_albums WHERE user_id = $1 AND source_project_id = $2`,
      [userId, sourceProjectId],
    ));
  }

  async listByUser(userId: string, opts: { includeDeleted?: boolean; limit?: number; offset?: number } = {}): Promise<AlbumRow[]> {
    const includeDeleted = opts.includeDeleted ?? false;
    const limit = opts.limit ?? 100;
    const offset = opts.offset ?? 0;
    const result = await this.db.query<AlbumRow>(
      `SELECT * FROM ai_album_albums
       WHERE user_id = $1 AND ($2::boolean OR status <> 'deleted')
       ORDER BY updated_time DESC
       LIMIT $3 OFFSET $4`,
      [userId, includeDeleted, limit, offset],
    );
    return result.rows;
  }

  async update(userId: string, id: string, patch: UpdateAlbumPatch, updatedBy: string): Promise<AlbumRow | null> {
    const { assignments, values } = buildUpdateSet(patch, 3, {
      updated_by: updatedBy,
      updated_time: new Date(),
    }, ALBUM_UPDATE_COLUMNS);
    if (!assignments) return this.findById(userId, id);
    return firstRow(await this.db.query<AlbumRow>(
      `UPDATE ai_album_albums SET ${assignments} WHERE user_id = $1 AND id = $2 RETURNING *`,
      [userId, id, ...values],
    ));
  }

  async updateIfAlbumRevision(
    userId: string,
    id: string,
    expectedRevision: number,
    patch: UpdateAlbumPatch,
    updatedBy: string,
  ): Promise<AlbumRow | null> {
    const { assignments, values } = buildUpdateSet(patch, 4, {
      updated_by: updatedBy,
      updated_time: new Date(),
    }, ALBUM_UPDATE_COLUMNS);
    if (!assignments) return null;
    return firstRow(await this.db.query<AlbumRow>(
      `UPDATE ai_album_albums
       SET ${assignments}
       WHERE user_id = $1
         AND id = $2
         AND CASE
           WHEN COALESCE(settings->>'album_revision', '') ~ '^[0-9]+$'
             THEN (settings->>'album_revision')::bigint
           ELSE 0
         END = $3
       RETURNING *`,
      [userId, id, expectedRevision, ...values],
    ));
  }

  async updateSettings(userId: string, id: string, settings: JsonObject, updatedBy: string): Promise<AlbumRow | null> {
    return this.update(userId, id, { settings }, updatedBy);
  }

  async updateStatus(userId: string, id: string, status: AlbumStatus, updatedBy: string): Promise<AlbumRow | null> {
    return this.update(userId, id, { status }, updatedBy);
  }

  async softDelete(userId: string, id: string, updatedBy: string): Promise<AlbumRow | null> {
    return this.updateStatus(userId, id, 'deleted', updatedBy);
  }
}
