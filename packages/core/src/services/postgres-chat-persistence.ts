import { randomUUID } from 'node:crypto';
import type {
  AlbumRow,
  ChatMessageRole,
  ChatMessageRow,
  ChatMessageType,
  ChatSessionRow,
  ChatSessionStatus,
  JsonObject,
} from '../db/types.js';
import { HtmlVideoError } from '../errors.js';
import type { AlbumRepository } from '../repositories/album-repository.js';
import type { ChatMessageRepository } from '../repositories/chat-message-repository.js';
import type { ChatSessionRepository } from '../repositories/chat-session-repository.js';
import type { UserContext } from './user-context.js';

type AlbumAccess = Pick<AlbumRepository, 'findById' | 'findBySourceProjectId'>;
type SessionAccess = Pick<
  ChatSessionRepository,
  | 'create'
  | 'createForAlbum'
  | 'findActiveByAlbum'
  | 'findById'
  | 'listByAlbum'
  | 'mergeMetadata'
  | 'nextMessageSequence'
  | 'updateStatus'
  | 'updateTitle'
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

export interface CreateProjectChatSessionInput {
  title?: string | null;
  metadata?: JsonObject;
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

  async createSessionForProject(
    projectId: string,
    input: CreateProjectChatSessionInput = {},
  ): Promise<ChatSessionRow> {
    const user = this.opts.getUserContext();
    const album = await this.requireAlbum(projectId, user);
    const title = normalizeSessionTitle(input.title === undefined ? album.title : input.title);
    return this.opts.sessions.createForAlbum({
      id: randomUUID(),
      user_id: user.userId,
      album_id: album.id,
      status: 'active',
      title,
      metadata: { source: 'studio', ...(input.metadata ?? {}) },
      created_by: user.actorId,
      updated_by: user.actorId,
    });
  }

  async getSessionForProject(projectId: string, sessionId: string): Promise<ChatSessionRow> {
    const user = this.opts.getUserContext();
    const album = await this.requireAlbum(projectId, user);
    return this.requireSession(album, user, sessionId);
  }

  async listSessionsForProject(
    projectId: string,
    status?: ChatSessionStatus,
  ): Promise<ChatSessionRow[]> {
    const user = this.opts.getUserContext();
    const album = await this.requireAlbum(projectId, user);
    return this.opts.sessions.listByAlbum(user.userId, album.id, status);
  }

  async updateSessionTitleForProject(
    projectId: string,
    sessionId: string,
    title: string | null,
  ): Promise<ChatSessionRow> {
    const user = this.opts.getUserContext();
    const album = await this.requireAlbum(projectId, user);
    await this.requireSession(album, user, sessionId);
    const updated = await this.opts.sessions.updateTitle(
      user.userId,
      album.id,
      sessionId,
      normalizeSessionTitle(title),
      user.actorId,
    );
    if (!updated) throw sessionNotFound(projectId, sessionId);
    return updated;
  }

  async updateSessionStatusForProject(
    projectId: string,
    sessionId: string,
    status: ChatSessionStatus,
  ): Promise<ChatSessionRow> {
    const user = this.opts.getUserContext();
    const album = await this.requireAlbum(projectId, user);
    await this.requireSession(album, user, sessionId);
    const updated = await this.opts.sessions.updateStatus(
      user.userId,
      album.id,
      sessionId,
      status,
      user.actorId,
    );
    if (!updated) throw sessionNotFound(projectId, sessionId);
    return updated;
  }

  async mergeSessionMetadataForProject(
    projectId: string,
    sessionId: string,
    metadata: JsonObject,
  ): Promise<ChatSessionRow> {
    const user = this.opts.getUserContext();
    const album = await this.requireAlbum(projectId, user);
    await this.requireSession(album, user, sessionId);
    const updated = await this.opts.sessions.mergeMetadata(
      user.userId,
      sessionId,
      metadata,
      user.actorId,
    );
    if (!updated) throw sessionNotFound(projectId, sessionId);
    return updated;
  }

  async getOrCreateSessionForProject(projectId: string, metadata: JsonObject = {}) {
    const user = this.opts.getUserContext();
    const album = await this.requireAlbum(projectId, user);
    const session = await this.getOrCreateSession(album, user);
    if (Object.keys(metadata).length === 0) return session;
    return (
      (await this.opts.sessions.mergeMetadata(user.userId, session.id, metadata, user.actorId)) ??
      session
    );
  }

  async listForProject(projectId: string): Promise<ChatMessageRow[]> {
    const user = this.opts.getUserContext();
    const album = await this.requireAlbum(projectId, user);
    const session = await this.opts.sessions.findActiveByAlbum(user.userId, album.id);
    if (!session) return [];
    return this.opts.messages.listBySession(user.userId, session.id);
  }

  async listForSession(projectId: string, sessionId: string): Promise<ChatMessageRow[]> {
    const user = this.opts.getUserContext();
    const album = await this.requireAlbum(projectId, user);
    const session = await this.requireSession(album, user, sessionId);
    return this.opts.messages.listBySession(user.userId, session.id);
  }

  async appendForProject(
    projectId: string,
    input: PersistedChatMessageInput,
  ): Promise<ChatMessageRow> {
    const user = this.opts.getUserContext();
    const album = await this.requireAlbum(projectId, user);
    const session = await this.getOrCreateSession(album, user);
    return this.appendToSession(album, session, user, input);
  }

  async appendForSession(
    projectId: string,
    sessionId: string,
    input: PersistedChatMessageInput,
  ): Promise<ChatMessageRow> {
    const user = this.opts.getUserContext();
    const album = await this.requireAlbum(projectId, user);
    const session = await this.requireSession(album, user, sessionId);
    if (session.status !== 'active') {
      throw new HtmlVideoError(
        'invalid-input',
        `Chat session ${sessionId} is ${session.status}`,
        false,
        { projectId, sessionId, status: session.status },
      );
    }
    return this.appendToSession(album, session, user, input);
  }

  private async appendToSession(
    album: AlbumRow,
    session: ChatSessionRow,
    user: Readonly<UserContext>,
    input: PersistedChatMessageInput,
  ): Promise<ChatMessageRow> {
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

  private async requireSession(
    album: AlbumRow,
    user: Readonly<UserContext>,
    sessionId: string,
  ): Promise<ChatSessionRow> {
    const session = await this.opts.sessions.findById(user.userId, album.id, sessionId);
    if (!session) throw sessionNotFound(album.source_project_id ?? album.id, sessionId);
    return session;
  }

  private async getOrCreateSession(album: AlbumRow, user: Readonly<UserContext>) {
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

  private async requireAlbum(projectId: string, user: Readonly<UserContext>): Promise<AlbumRow> {
    const bySourceId = await this.opts.albums.findBySourceProjectId(user.userId, projectId);
    const album =
      bySourceId ??
      (isUuid(projectId) ? await this.opts.albums.findById(user.userId, projectId) : null);
    if (!album || album.status === 'deleted') {
      throw new HtmlVideoError('project-not-found', `Project ${projectId} not found`);
    }
    return album;
  }
}

function normalizeSessionTitle(value: string | null): string | null {
  if (value === null) return null;
  const title = value.trim();
  if (title.length > 200) {
    throw new HtmlVideoError('invalid-input', 'Chat session title must be 200 characters or fewer');
  }
  return title || null;
}

function sessionNotFound(projectId: string, sessionId: string): HtmlVideoError {
  return new HtmlVideoError(
    'chat-session-not-found',
    `Chat session ${sessionId} not found for project ${projectId}`,
    false,
    { projectId, sessionId },
  );
}

function defaultMessageType(role: ChatMessageRole): ChatMessageType {
  if (role === 'tool') return 'tool_result';
  if (role === 'system') return 'system_event';
  return 'text';
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
