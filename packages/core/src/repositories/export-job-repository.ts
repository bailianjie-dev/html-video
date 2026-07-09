import { firstRow, type DbClient } from '../db/client.js';
import type { CreateExportJobInput, ExportJobRow, JobStatus, UpdateExportJobPatch } from '../db/types.js';
import { buildUpdateSet } from './sql-utils.js';

const EXPORT_JOB_UPDATE_COLUMNS = [
  'status',
  'export_format',
  'render_profile',
  'width',
  'height',
  'fps',
  'duration_ms',
  'progress_percent',
  'attempt_count',
  'request_params',
  'local_output_path',
  'oss_bucket',
  'oss_key',
  'output_url',
  'file_size_bytes',
  'checksum_sha256',
  'error_code',
  'error_message',
  'queued_time',
  'started_time',
  'finished_time',
  'updated_by',
  'updated_time',
] as const;

export class ExportJobRepository {
  constructor(private readonly db: DbClient) {}

  async create(input: CreateExportJobInput): Promise<ExportJobRow> {
    const result = await this.db.query<ExportJobRow>(
      `INSERT INTO ai_album_export_jobs (
        id, user_id, album_id, status, export_format, render_profile,
        width, height, fps, duration_ms, progress_percent, attempt_count,
        request_params, local_output_path, oss_bucket, oss_key, output_url,
        file_size_bytes, checksum_sha256, error_code, error_message,
        queued_time, started_time, finished_time, created_by, updated_by
      ) VALUES (
        $1, $2, $3, COALESCE($4, 'queued'), COALESCE($5, 'mp4'), COALESCE($6, 'mp4_1080p'),
        COALESCE($7, 1080), COALESCE($8, 1920), COALESCE($9, 30), $10, COALESCE($11, 0), COALESCE($12, 0),
        COALESCE($13, '{}'::jsonb), $14, $15, $16, $17,
        $18, $19, $20, $21,
        COALESCE($22, now()), $23, $24, $25, $26
      ) RETURNING *`,
      [
        input.id,
        input.user_id,
        input.album_id,
        input.status ?? null,
        input.export_format ?? null,
        input.render_profile ?? null,
        input.width ?? null,
        input.height ?? null,
        input.fps ?? null,
        input.duration_ms ?? null,
        input.progress_percent ?? null,
        input.attempt_count ?? null,
        input.request_params ?? {},
        input.local_output_path ?? null,
        input.oss_bucket ?? null,
        input.oss_key ?? null,
        input.output_url ?? null,
        input.file_size_bytes ?? null,
        input.checksum_sha256 ?? null,
        input.error_code ?? null,
        input.error_message ?? null,
        input.queued_time ?? null,
        input.started_time ?? null,
        input.finished_time ?? null,
        input.created_by,
        input.updated_by,
      ],
    );
    return result.rows[0]!;
  }

  async findById(userId: string, id: string): Promise<ExportJobRow | null> {
    return firstRow(await this.db.query<ExportJobRow>(
      `SELECT * FROM ai_album_export_jobs WHERE user_id = $1 AND id = $2`,
      [userId, id],
    ));
  }

  async listByAlbum(userId: string, albumId: string, opts: { limit?: number; offset?: number } = {}): Promise<ExportJobRow[]> {
    const result = await this.db.query<ExportJobRow>(
      `SELECT * FROM ai_album_export_jobs
       WHERE user_id = $1 AND album_id = $2
       ORDER BY created_time DESC
       LIMIT $3 OFFSET $4`,
      [userId, albumId, opts.limit ?? 100, opts.offset ?? 0],
    );
    return result.rows;
  }

  async findActiveJobs(limit = 20): Promise<ExportJobRow[]> {
    const result = await this.db.query<ExportJobRow>(
      `SELECT * FROM ai_album_export_jobs
       WHERE status IN ('queued', 'running')
       ORDER BY queued_time ASC
       LIMIT $1`,
      [limit],
    );
    return result.rows;
  }

  async update(userId: string, id: string, patch: UpdateExportJobPatch, updatedBy: string): Promise<ExportJobRow | null> {
    const { assignments, values } = buildUpdateSet(patch, 3, {
      updated_by: updatedBy,
      updated_time: new Date(),
    }, EXPORT_JOB_UPDATE_COLUMNS);
    if (!assignments) return this.findById(userId, id);
    return firstRow(await this.db.query<ExportJobRow>(
      `UPDATE ai_album_export_jobs SET ${assignments} WHERE user_id = $1 AND id = $2 RETURNING *`,
      [userId, id, ...values],
    ));
  }

  async updateStatus(userId: string, id: string, status: JobStatus, updatedBy: string): Promise<ExportJobRow | null> {
    return this.update(userId, id, { status }, updatedBy);
  }
}
