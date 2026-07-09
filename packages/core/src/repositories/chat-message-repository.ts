import type { DbClient } from '../db/client.js';
import type { ChatMessageRow, CreateChatMessageInput } from '../db/types.js';

export class ChatMessageRepository {
  constructor(private readonly db: DbClient) {}

  async create(input: CreateChatMessageInput): Promise<ChatMessageRow> {
    const result = await this.db.query<ChatMessageRow>(
      `INSERT INTO ai_album_chat_messages (
        id, user_id, album_id, session_id, role, message_type, sequence_no,
        request_id, content, agent, tool, payload, occurred_time,
        created_by, updated_by
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7,
        $8, $9, $10, $11, COALESCE($12, '{}'::jsonb), COALESCE($13, now()),
        $14, $15
      ) RETURNING *`,
      [
        input.id,
        input.user_id,
        input.album_id,
        input.session_id,
        input.role,
        input.message_type,
        input.sequence_no,
        input.request_id ?? null,
        input.content,
        input.agent ?? null,
        input.tool ?? null,
        input.payload ?? {},
        input.occurred_time ?? null,
        input.created_by,
        input.updated_by,
      ],
    );
    return result.rows[0]!;
  }

  async listBySession(userId: string, sessionId: string): Promise<ChatMessageRow[]> {
    const result = await this.db.query<ChatMessageRow>(
      `SELECT * FROM ai_album_chat_messages
       WHERE user_id = $1 AND session_id = $2
       ORDER BY sequence_no ASC`,
      [userId, sessionId],
    );
    return result.rows;
  }
}
