import { randomUUID } from 'node:crypto';
import type {
  AlbumRow,
  ChatMessageRole,
  ChatMessageRow,
  ChatMessageType,
  JsonObject,
} from '../db/types.js';
import { HtmlVideoError } from '../errors.js';
import { AlbumRepository } from '../repositories/album-repository.js';
import { ChatMessageRepository } from '../repositories/chat-message-repository.js';
import { ChatSessionRepository } from '../repositories/chat-session-repository.js';
import type { UserContext } from './user-context.js';

type AlbumAccess = Pick<AlbumRepository, 'findById' | 'findBySourceProjectId'>;
type SessionAccess = Pick<
  ChatSessionRepository,
  'create' | 'findActiveByAlbum' | 'nextMessageSequence'
>;
type MessageAccess = Pick<ChatMessageRepository, 'create' | 'listBySession'>;

export interface PersistedChatMessageInput {
  role: ChatMessageRole;
  content: string;
  messageType?: ChatMessageType;
  agent?: string;
  tool?: string;
  payload?: JsonObject;
  occurredAt?: Date;
}

export interface PostgresChatPersistenceOptions {
  getUserContext: () => Readonly<UserContext>;
  getRequestId?: () => string | undefined;
  albums: AlbumAccess;
  sessions: SessionAccess;
  messages: MessageAccess;
}

export class PostgresChatPersistence {
  constructor(private readonly opts: PostgresChatPersistenceOptions) {}

  async listForProject(projectId: string): Promise<ChatMessageRow[]> {
    const user = this.opts.getUserContext();
    const album = await this.requireAlbum(projectId, user);
    const session = await this.opts.sessions.findActiveByAlbum(user.userId, album.id);
    if (!session) return [];
    return this.opts.messages.listBySession(user.userId, session.id);
  }

  async appendForProject(
    projectId: string,
    input: PersistedChatMessageInput,
  ): Promise<ChatMessageRow> {
    const user = this.opts.getUserContext();
    const album = await this.requireAlbum(projectId, user);
    const session = await this.getOrCreateSession(album, user);
    const sequence = await this.opts.sessions.nextMessageSequence(
      user.userId,
      session.id,
      user.actorId,
    );
    if (sequence === null) {
      throw new Error(`Chat session ${session.id} is unavailable`);
    }
    const requestId = this.opts.getRequestId?.() ?? null;
    const message = await this.opts.messages.create({
      id: randomUUID(),
      user_id: user.userId,
      album_id: album.id,
      session_id: session.id,
      role: input.role,
      message_type: input.messageType ?? defaultMessageType(input.role),
      sequence_no: sequence,
      request_id: requestId,
      content: input.content,
      agent: input.agent ?? null,
      tool: input.tool ?? null,
      payload: input.payload ?? {},
      occurred_time: input.occurredAt ?? new Date(),
      created_by: user.actorId,
      updated_by: user.actorId,
    });
    return message;
  }

  private async getOrCreateSession(
    album: AlbumRow,
    user: Readonly<UserContext>,
  ) {
    const existing = await this.opts.sessions.findActiveByAlbum(user.userId, album.id);
    if (existing) return existing;
    try {
      return await this.opts.sessions.create({
        id: randomUUID(),
        user_id: user.userId,
        album_id: album.id,
        status: 'active',
        title: album.title,
        metadata: { source: 'studio' },
        created_by: user.actorId,
        updated_by: user.actorId,
      });
    } catch (error) {
      const raced = await this.opts.sessions.findActiveByAlbum(user.userId, album.id);
      if (raced) return raced;
      throw error;
    }
  }

  private async requireAlbum(
    projectId: string,
    user: Readonly<UserContext>,
  ): Promise<AlbumRow> {
    const bySourceId = await this.opts.albums.findBySourceProjectId(user.userId, projectId);
    const album = bySourceId
      ?? (isUuid(projectId)
        ? await this.opts.albums.findById(user.userId, projectId)
        : null);
    if (!album || album.status === 'deleted') {
      throw new HtmlVideoError('project-not-found', `Project ${projectId} not found`);
    }
    return album;
  }
}

function defaultMessageType(role: ChatMessageRole): ChatMessageType {
  if (role === 'tool') return 'tool_result';
  if (role === 'system') return 'system_event';
  return 'text';
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
