import { firstRow, type DbClient } from '../db/client.js';
import type { AlbumPageRow, CreateAlbumPageInput, UpdateAlbumPagePatch } from '../db/types.js';
import { buildUpdateSet } from './sql-utils.js';

const ALBUM_PAGE_UPDATE_COLUMNS = [
  'node_id',
  'page_no',
  'title',
  'status',
  'template_key',
  'duration_ms',
  'raw_html',
  'preview_asset_id',
  'poster_asset_id',
  'content',
  'style',
  'transition',
  'updated_by',
  'updated_time',
] as const;

export class AlbumPageRepository {
  constructor(private readonly db: DbClient) {}

  async create(input: CreateAlbumPageInput): Promise<AlbumPageRow> {
    const result = await this.db.query<AlbumPageRow>(
      `INSERT INTO ai_album_album_pages (
        id, user_id, album_id, node_id, page_no, title, status, template_key,
        duration_ms, raw_html, preview_asset_id, poster_asset_id,
        content, style, transition, created_by, updated_by
      ) VALUES (
        $1, $2, $3, $4, $5, $6, COALESCE($7, 'draft'), $8,
        COALESCE($9, 3000), $10, $11, $12,
        COALESCE($13, '{}'::jsonb), COALESCE($14, '{}'::jsonb), COALESCE($15, '{}'::jsonb),
        $16, $17
      ) RETURNING *`,
      [
        input.id,
        input.user_id,
        input.album_id,
        input.node_id ?? null,
        input.page_no,
        input.title ?? null,
        input.status ?? null,
        input.template_key ?? null,
        input.duration_ms ?? null,
        input.raw_html ?? null,
        input.preview_asset_id ?? null,
        input.poster_asset_id ?? null,
        input.content ?? {},
        input.style ?? {},
        input.transition ?? {},
        input.created_by,
        input.updated_by,
      ],
    );
    return result.rows[0]!;
  }

  async upsertByAlbumAndPageNo(input: CreateAlbumPageInput): Promise<AlbumPageRow> {
    const result = await this.db.query<AlbumPageRow>(
      `INSERT INTO ai_album_album_pages (
        id, user_id, album_id, node_id, page_no, title, status, template_key,
        duration_ms, raw_html, preview_asset_id, poster_asset_id,
        content, style, transition, created_by, updated_by
      ) VALUES (
        $1, $2, $3, $4, $5, $6, COALESCE($7, 'draft'), $8,
        COALESCE($9, 3000), $10, $11, $12,
        COALESCE($13, '{}'::jsonb), COALESCE($14, '{}'::jsonb), COALESCE($15, '{}'::jsonb),
        $16, $17
      )
      ON CONFLICT (album_id, page_no) DO UPDATE SET
        node_id = EXCLUDED.node_id,
        title = EXCLUDED.title,
        status = EXCLUDED.status,
        template_key = EXCLUDED.template_key,
        duration_ms = EXCLUDED.duration_ms,
        raw_html = EXCLUDED.raw_html,
        preview_asset_id = EXCLUDED.preview_asset_id,
        poster_asset_id = EXCLUDED.poster_asset_id,
        content = EXCLUDED.content,
        style = EXCLUDED.style,
        transition = EXCLUDED.transition,
        updated_by = EXCLUDED.updated_by,
        updated_time = now()
      RETURNING *`,
      [
        input.id,
        input.user_id,
        input.album_id,
        input.node_id ?? null,
        input.page_no,
        input.title ?? null,
        input.status ?? null,
        input.template_key ?? null,
        input.duration_ms ?? null,
        input.raw_html ?? null,
        input.preview_asset_id ?? null,
        input.poster_asset_id ?? null,
        input.content ?? {},
        input.style ?? {},
        input.transition ?? {},
        input.created_by,
        input.updated_by,
      ],
    );
    return result.rows[0]!;
  }

  async upsertByAlbumAndNodeId(input: CreateAlbumPageInput & { node_id: string }): Promise<AlbumPageRow> {
    const result = await this.db.query<AlbumPageRow>(
      `INSERT INTO ai_album_album_pages (
        id, user_id, album_id, node_id, page_no, title, status, template_key,
        duration_ms, raw_html, preview_asset_id, poster_asset_id,
        content, style, transition, created_by, updated_by
      ) VALUES (
        $1, $2, $3, $4, $5, $6, COALESCE($7, 'draft'), $8,
        COALESCE($9, 3000), $10, $11, $12,
        COALESCE($13, '{}'::jsonb), COALESCE($14, '{}'::jsonb), COALESCE($15, '{}'::jsonb),
        $16, $17
      )
      ON CONFLICT (album_id, node_id) DO UPDATE SET
        page_no = EXCLUDED.page_no,
        title = EXCLUDED.title,
        status = EXCLUDED.status,
        template_key = EXCLUDED.template_key,
        duration_ms = EXCLUDED.duration_ms,
        raw_html = EXCLUDED.raw_html,
        preview_asset_id = EXCLUDED.preview_asset_id,
        poster_asset_id = EXCLUDED.poster_asset_id,
        content = EXCLUDED.content,
        style = EXCLUDED.style,
        transition = EXCLUDED.transition,
        updated_by = EXCLUDED.updated_by,
        updated_time = now()
      RETURNING *`,
      [
        input.id,
        input.user_id,
        input.album_id,
        input.node_id,
        input.page_no,
        input.title ?? null,
        input.status ?? null,
        input.template_key ?? null,
        input.duration_ms ?? null,
        input.raw_html ?? null,
        input.preview_asset_id ?? null,
        input.poster_asset_id ?? null,
        input.content ?? {},
        input.style ?? {},
        input.transition ?? {},
        input.created_by,
        input.updated_by,
      ],
    );
    return result.rows[0]!;
  }

  async findById(userId: string, id: string): Promise<AlbumPageRow | null> {
    return firstRow(await this.db.query<AlbumPageRow>(
      `SELECT * FROM ai_album_album_pages WHERE user_id = $1 AND id = $2`,
      [userId, id],
    ));
  }

  async findByNodeId(userId: string, albumId: string, nodeId: string): Promise<AlbumPageRow | null> {
    return firstRow(await this.db.query<AlbumPageRow>(
      `SELECT * FROM ai_album_album_pages WHERE user_id = $1 AND album_id = $2 AND node_id = $3`,
      [userId, albumId, nodeId],
    ));
  }

  async findByPageNo(userId: string, albumId: string, pageNo: number): Promise<AlbumPageRow | null> {
    return firstRow(await this.db.query<AlbumPageRow>(
      `SELECT * FROM ai_album_album_pages WHERE user_id = $1 AND album_id = $2 AND page_no = $3`,
      [userId, albumId, pageNo],
    ));
  }

  async listByAlbum(userId: string, albumId: string, opts: { includeDeleted?: boolean } = {}): Promise<AlbumPageRow[]> {
    const result = await this.db.query<AlbumPageRow>(
      `SELECT * FROM ai_album_album_pages
       WHERE user_id = $1 AND album_id = $2 AND ($3::boolean OR status <> 'deleted')
       ORDER BY page_no ASC`,
      [userId, albumId, opts.includeDeleted ?? false],
    );
    return result.rows;
  }

  async update(userId: string, id: string, patch: UpdateAlbumPagePatch, updatedBy: string): Promise<AlbumPageRow | null> {
    const { assignments, values } = buildUpdateSet(patch, 3, {
      updated_by: updatedBy,
      updated_time: new Date(),
    }, ALBUM_PAGE_UPDATE_COLUMNS);
    if (!assignments) return this.findById(userId, id);
    return firstRow(await this.db.query<AlbumPageRow>(
      `UPDATE ai_album_album_pages SET ${assignments} WHERE user_id = $1 AND id = $2 RETURNING *`,
      [userId, id, ...values],
    ));
  }

  async updateRawHtmlByNodeId(userId: string, albumId: string, nodeId: string, rawHtml: string, updatedBy: string): Promise<AlbumPageRow | null> {
    return firstRow(await this.db.query<AlbumPageRow>(
      `UPDATE ai_album_album_pages
       SET raw_html = $4, updated_by = $5, updated_time = now()
       WHERE user_id = $1 AND album_id = $2 AND node_id = $3
       RETURNING *`,
      [userId, albumId, nodeId, rawHtml, updatedBy],
    ));
  }

  async softDeleteByAlbum(userId: string, albumId: string, updatedBy: string): Promise<number> {
    const result = await this.db.query(
      `UPDATE ai_album_album_pages
       SET status = 'deleted', updated_by = $3, updated_time = now()
       WHERE user_id = $1 AND album_id = $2 AND status <> 'deleted'`,
      [userId, albumId, updatedBy],
    );
    return result.rowCount;
  }
}
