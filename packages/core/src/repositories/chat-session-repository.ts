import { type DbClient, firstRow } from '../db/client.js';
import type { ChatSessionRow, ChatSessionStatus, CreateChatSessionInput } from '../db/types.js';

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
    const created = result.rows[0];
    if (!created) throw new Error(`Failed to create chat session ${input.id}`);
    return created;
  }

  async createForAlbum(input: CreateChatSessionInput): Promise<ChatSessionRow> {
    return this.create(input);
  }

  async findById(
    userId: string,
    albumId: string,
    sessionId: string,
  ): Promise<ChatSessionRow | null> {
    return firstRow(
      await this.db.query<ChatSessionRow>(
        `SELECT * FROM ai_album_chat_sessions
       WHERE user_id = $1 AND album_id = $2 AND id = $3`,
        [userId, albumId, sessionId],
      ),
    );
  }

  async listByAlbum(
    userId: string,
    albumId: string,
    status?: ChatSessionStatus,
  ): Promise<ChatSessionRow[]> {
    const result = status
      ? await this.db.query<ChatSessionRow>(
          `SELECT * FROM ai_album_chat_sessions
           WHERE user_id = $1 AND album_id = $2 AND status = $3
           ORDER BY updated_time DESC, created_time DESC, id DESC`,
          [userId, albumId, status],
        )
      : await this.db.query<ChatSessionRow>(
          `SELECT * FROM ai_album_chat_sessions
           WHERE user_id = $1 AND album_id = $2
           ORDER BY updated_time DESC, created_time DESC, id DESC`,
          [userId, albumId],
        );
    return result.rows;
  }

  async findActiveByAlbum(userId: string, albumId: string): Promise<ChatSessionRow | null> {
    return firstRow(
      await this.db.query<ChatSessionRow>(
        `SELECT * FROM ai_album_chat_sessions
       WHERE user_id = $1 AND album_id = $2 AND status = 'active'
       ORDER BY created_time ASC, id ASC LIMIT 1`,
        [userId, albumId],
      ),
    );
  }

  async mergeMetadata(
    userId: string,
    sessionId: string,
    metadata: Record<string, unknown>,
    updatedBy: string,
  ): Promise<ChatSessionRow | null> {
    return firstRow(
      await this.db.query<ChatSessionRow>(
        `UPDATE ai_album_chat_sessions
       SET metadata = metadata || $3::jsonb,
           updated_by = $4,
           updated_time = now()
       WHERE user_id = $1 AND id = $2
       RETURNING *`,
        [userId, sessionId, metadata, updatedBy],
      ),
    );
  }

  async updateTitle(
    userId: string,
    albumId: string,
    sessionId: string,
    title: string | null,
    updatedBy: string,
  ): Promise<ChatSessionRow | null> {
    return firstRow(
      await this.db.query<ChatSessionRow>(
        `UPDATE ai_album_chat_sessions
       SET title = $4,
           updated_by = $5,
           updated_time = now()
       WHERE user_id = $1 AND album_id = $2 AND id = $3
       RETURNING *`,
        [userId, albumId, sessionId, title, updatedBy],
      ),
    );
  }

  async updateStatus(
    userId: string,
    albumId: string,
    sessionId: string,
    status: ChatSessionStatus,
    updatedBy: string,
  ): Promise<ChatSessionRow | null> {
    return firstRow(
      await this.db.query<ChatSessionRow>(
        `UPDATE ai_album_chat_sessions
       SET status = $4,
           updated_by = $5,
           updated_time = now()
       WHERE user_id = $1 AND album_id = $2 AND id = $3
       RETURNING *`,
        [userId, albumId, sessionId, status, updatedBy],
      ),
    );
  }

  async nextMessageSequence(
    userId: string,
    sessionId: string,
    updatedBy: string,
  ): Promise<number | null> {
    const row = firstRow(
      await this.db.query<Pick<ChatSessionRow, 'last_message_seq'>>(
        `UPDATE ai_album_chat_sessions
       SET last_message_seq = last_message_seq + 1,
           updated_by = $3,
           updated_time = now()
       WHERE user_id = $1 AND id = $2
       RETURNING last_message_seq`,
        [userId, sessionId, updatedBy],
      ),
    );
    return row?.last_message_seq ?? null;
  }
}
