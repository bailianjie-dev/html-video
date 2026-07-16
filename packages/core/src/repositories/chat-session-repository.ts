import { firstRow, type DbClient } from '../db/client.js';
import type { ChatSessionRow, CreateChatSessionInput } from '../db/types.js';

export class ChatSessionRepository {
  constructor(private readonly db: DbClient) {}

  async create(input: CreateChatSessionInput): Promise<ChatSessionRow> {
    const result = await this.db.query<ChatSessionRow>(
      `INSERT INTO ai_album_chat_sessions (
        id, user_id, album_id, status, title, last_message_seq, metadata,
        created_by, updated_by
      ) VALUES (
        $1, $2, $3, COALESCE($4, 'active'), $5, COALESCE($6, 0), COALESCE($7, '{}'::jsonb),
        $8, $9
      ) RETURNING *`,
      [
        input.id,
        input.user_id,
        input.album_id,
        input.status ?? null,
        input.title ?? null,
        input.last_message_seq ?? null,
        input.metadata ?? {},
        input.created_by,
        input.updated_by,
      ],
    );
    return result.rows[0]!;
  }

  async findActiveByAlbum(userId: string, albumId: string): Promise<ChatSessionRow | null> {
    return firstRow(await this.db.query<ChatSessionRow>(
      `SELECT * FROM ai_album_chat_sessions
       WHERE user_id = $1 AND album_id = $2 AND status = 'active'
       ORDER BY created_time DESC LIMIT 1`,
      [userId, albumId],
    ));
  }

  async mergeMetadata(
    userId: string,
    sessionId: string,
    metadata: Record<string, unknown>,
    updatedBy: string,
  ): Promise<ChatSessionRow | null> {
    return firstRow(await this.db.query<ChatSessionRow>(
      `UPDATE ai_album_chat_sessions
       SET metadata = metadata || $3::jsonb,
           updated_by = $4,
           updated_time = now()
       WHERE user_id = $1 AND id = $2
       RETURNING *`,
      [userId, sessionId, metadata, updatedBy],
    ));
  }

  async nextMessageSequence(
    userId: string,
    sessionId: string,
    updatedBy: string,
  ): Promise<number | null> {
    const row = firstRow(await this.db.query<Pick<ChatSessionRow, 'last_message_seq'>>(
      `UPDATE ai_album_chat_sessions
       SET last_message_seq = last_message_seq + 1,
           updated_by = $3,
           updated_time = now()
       WHERE user_id = $1 AND id = $2
       RETURNING last_message_seq`,
      [userId, sessionId, updatedBy],
    ));
    return row?.last_message_seq ?? null;
  }
}
