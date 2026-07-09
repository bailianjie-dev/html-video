import { firstRow, type DbClient } from '../db/client.js';
import type { AiGenerationLogRow, CreateAiGenerationLogInput, JobStatus, UpdateAiGenerationLogPatch } from '../db/types.js';
import { buildUpdateSet } from './sql-utils.js';

const AI_GENERATION_LOG_UPDATE_COLUMNS = [
  'album_id',
  'page_id',
  'generated_asset_id',
  'generation_type',
  'provider',
  'model',
  'status',
  'prompt',
  'request_payload',
  'response_payload',
  'prompt_tokens',
  'completion_tokens',
  'total_tokens',
  'cost_amount',
  'error_code',
  'error_message',
  'started_time',
  'finished_time',
  'updated_by',
  'updated_time',
] as const;

export class AiGenerationLogRepository {
  constructor(private readonly db: DbClient) {}

  async create(input: CreateAiGenerationLogInput): Promise<AiGenerationLogRow> {
    const result = await this.db.query<AiGenerationLogRow>(
      `INSERT INTO ai_album_ai_generation_logs (
        id, user_id, album_id, page_id, generated_asset_id, generation_type,
        provider, model, status, prompt, request_payload, response_payload,
        prompt_tokens, completion_tokens, total_tokens, cost_amount,
        error_code, error_message, started_time, finished_time,
        created_by, updated_by
      ) VALUES (
        $1, $2, $3, $4, $5, $6,
        $7, $8, COALESCE($9, 'queued'), $10, COALESCE($11, '{}'::jsonb), COALESCE($12, '{}'::jsonb),
        $13, $14, $15, $16,
        $17, $18, $19, $20,
        $21, $22
      ) RETURNING *`,
      [
        input.id,
        input.user_id,
        input.album_id ?? null,
        input.page_id ?? null,
        input.generated_asset_id ?? null,
        input.generation_type,
        input.provider,
        input.model,
        input.status ?? null,
        input.prompt ?? null,
        input.request_payload ?? {},
        input.response_payload ?? {},
        input.prompt_tokens ?? null,
        input.completion_tokens ?? null,
        input.total_tokens ?? null,
        input.cost_amount ?? null,
        input.error_code ?? null,
        input.error_message ?? null,
        input.started_time ?? null,
        input.finished_time ?? null,
        input.created_by,
        input.updated_by,
      ],
    );
    return result.rows[0]!;
  }

  async findById(userId: string, id: string): Promise<AiGenerationLogRow | null> {
    return firstRow(await this.db.query<AiGenerationLogRow>(
      `SELECT * FROM ai_album_ai_generation_logs WHERE user_id = $1 AND id = $2`,
      [userId, id],
    ));
  }

  async listByAlbum(userId: string, albumId: string, opts: { limit?: number; offset?: number } = {}): Promise<AiGenerationLogRow[]> {
    const result = await this.db.query<AiGenerationLogRow>(
      `SELECT * FROM ai_album_ai_generation_logs
       WHERE user_id = $1 AND album_id = $2
       ORDER BY created_time DESC
       LIMIT $3 OFFSET $4`,
      [userId, albumId, opts.limit ?? 100, opts.offset ?? 0],
    );
    return result.rows;
  }

  async update(userId: string, id: string, patch: UpdateAiGenerationLogPatch, updatedBy: string): Promise<AiGenerationLogRow | null> {
    const { assignments, values } = buildUpdateSet(patch, 3, {
      updated_by: updatedBy,
      updated_time: new Date(),
    }, AI_GENERATION_LOG_UPDATE_COLUMNS);
    if (!assignments) return this.findById(userId, id);
    return firstRow(await this.db.query<AiGenerationLogRow>(
      `UPDATE ai_album_ai_generation_logs SET ${assignments} WHERE user_id = $1 AND id = $2 RETURNING *`,
      [userId, id, ...values],
    ));
  }

  async updateStatus(userId: string, id: string, status: JobStatus, updatedBy: string): Promise<AiGenerationLogRow | null> {
    return this.update(userId, id, { status }, updatedBy);
  }
}
