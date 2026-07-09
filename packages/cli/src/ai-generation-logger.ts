import { createHash, randomUUID } from 'node:crypto';
import {
  AiGenerationLogRepository,
  AlbumPageRepository,
  AlbumRepository,
  type AiGenerationType,
  type JsonObject,
  type JsonValue,
  type UserContext,
} from '@html-video/core';
import type { CliContext } from './context.js';

const MAX_PROMPT_LENGTH = 64 * 1024;
const MAX_RESPONSE_EXCERPT_LENGTH = 2 * 1024;
const MAX_ERROR_LENGTH = 4 * 1024;

export interface AiGenerationLogStart {
  projectId: string;
  generationType: AiGenerationType;
  provider: string;
  model: string;
  prompt?: string;
  operationId: string;
  attempt: number;
  pageNodeId?: string;
  requestPayload?: Record<string, unknown>;
}

export interface AiGenerationLogHandle {
  id: string;
  albumId: string;
  userId: string;
  actorId: string;
  pageNodeId?: string;
  startedAtMs: number;
}

export interface AiGenerationLogSuccess {
  output?: string;
  pageNodeId?: string;
  generatedAssetId?: string;
  responsePayload?: Record<string, unknown>;
}

type AiGenerationLogAccess = Pick<AiGenerationLogRepository, 'create' | 'update'>;
type AlbumAccess = Pick<AlbumRepository, 'findById' | 'findBySourceProjectId'>;
type AlbumPageAccess = Pick<AlbumPageRepository, 'findByNodeId'>;

export interface AiGenerationLoggerOptions {
  getUserContext: () => Readonly<UserContext>;
  logs: AiGenerationLogAccess;
  albums: AlbumAccess;
  pages: AlbumPageAccess;
}

export class AiGenerationLogger {
  private readonly opts: AiGenerationLoggerOptions;

  constructor(opts: AiGenerationLoggerOptions) {
    this.opts = opts;
  }

  static fromContext(ctx: CliContext): AiGenerationLogger | null {
    if (ctx.database?.mode !== 'postgres' || !ctx.database.handle) return null;
    const db = ctx.database.handle.db;
    return new AiGenerationLogger({
      getUserContext: () => ctx.requestContexts.getRequiredUser(),
      logs: new AiGenerationLogRepository(db),
      albums: new AlbumRepository(db),
      pages: new AlbumPageRepository(db),
    });
  }

  async start(input: AiGenerationLogStart): Promise<AiGenerationLogHandle | null> {
    try {
      const user = this.opts.getUserContext();
      const album = await this.findAlbum(user.userId, input.projectId);
      if (!album) {
        this.warn(`album not found for project ${input.projectId}; log skipped`);
        return null;
      }
      const page = input.pageNodeId
        ? await this.opts.pages.findByNodeId(user.userId, album.id, input.pageNodeId)
        : null;
      const now = new Date();
      const id = randomUUID();
      await this.opts.logs.create({
        id,
        user_id: user.userId,
        album_id: album.id,
        page_id: page?.id ?? null,
        generation_type: input.generationType,
        provider: input.provider || 'unknown',
        model: input.model || 'unknown',
        status: 'running',
        prompt: sanitizePrompt(input.prompt),
        request_payload: toJsonObject({
          ...input.requestPayload,
          operation_id: input.operationId,
          attempt: input.attempt,
          ...(input.pageNodeId && { page_node_id: input.pageNodeId }),
        }),
        started_time: now,
        created_by: user.actorId,
        updated_by: user.actorId,
      });
      return {
        id,
        albumId: album.id,
        userId: user.userId,
        actorId: user.actorId,
        ...(input.pageNodeId && { pageNodeId: input.pageNodeId }),
        startedAtMs: now.getTime(),
      };
    } catch (error) {
      this.warn(`start failed: ${errorMessage(error)}`);
      return null;
    }
  }

  async succeed(handle: AiGenerationLogHandle | null, result: AiGenerationLogSuccess = {}): Promise<void> {
    if (!handle) return;
    try {
      const pageNodeId = result.pageNodeId ?? handle.pageNodeId;
      const page = pageNodeId
        ? await this.opts.pages.findByNodeId(handle.userId, handle.albumId, pageNodeId)
        : null;
      const output = result.output ?? '';
      const htmlOutput = isHtmlOutput(output);
      await this.opts.logs.update(handle.userId, handle.id, {
        status: 'succeeded',
        ...(page?.id && { page_id: page.id }),
        ...(result.generatedAssetId && { generated_asset_id: result.generatedAssetId }),
        response_payload: toJsonObject({
          ...result.responsePayload,
          duration_ms: Date.now() - handle.startedAtMs,
          output_length: output.length,
          ...(output && { output_sha256: sha256(output) }),
          output_kind: htmlOutput ? 'html' : 'text',
          ...(!htmlOutput && output && {
            output_excerpt: truncate(output, MAX_RESPONSE_EXCERPT_LENGTH),
          }),
        }),
        finished_time: new Date(),
        error_code: null,
        error_message: null,
      }, handle.actorId);
    } catch (error) {
      this.warn(`success update failed for ${handle.id}: ${errorMessage(error)}`);
    }
  }

  async fail(
    handle: AiGenerationLogHandle | null,
    error: unknown,
    errorCode = classifyError(error),
    responsePayload: Record<string, unknown> = {},
  ): Promise<void> {
    if (!handle) return;
    try {
      await this.opts.logs.update(handle.userId, handle.id, {
        status: 'failed',
        response_payload: toJsonObject({
          duration_ms: Date.now() - handle.startedAtMs,
          ...responsePayload,
        }),
        error_code: truncate(errorCode, 128) ?? 'generation_failed',
        error_message: truncate(errorMessage(error), MAX_ERROR_LENGTH),
        finished_time: new Date(),
      }, handle.actorId);
    } catch (logError) {
      this.warn(`failure update failed for ${handle.id}: ${errorMessage(logError)}`);
    }
  }

  private async findAlbum(userId: string, projectId: string) {
    const bySourceId = await this.opts.albums.findBySourceProjectId(userId, projectId);
    if (bySourceId) return bySourceId;
    if (!isUuid(projectId)) return null;
    return this.opts.albums.findById(userId, projectId);
  }

  private warn(message: string): void {
    process.stderr.write(`[studio:ai-log] ${message}\n`);
  }
}

export function aiProviderModel(
  agent: { id: string; defaultModel?: string },
  selectedModel?: string,
): { provider: string; model: string } {
  return {
    provider: agent.id,
    model: selectedModel || agent.defaultModel || 'unknown',
  };
}

export function classifyError(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && code) return code.slice(0, 128);
  }
  const message = errorMessage(error).toLowerCase();
  if (message.includes('timeout') || message.includes('timed out')) return 'timeout';
  if (message.includes('content-graph')) return 'invalid_content_graph';
  if (message.includes('html')) return 'invalid_html';
  if (message.includes('empty')) return 'empty_response';
  return 'generation_failed';
}

function toJsonObject(value: Record<string, unknown>): JsonObject {
  return JSON.parse(JSON.stringify(value, (_key, item) => (
    item === undefined || typeof item === 'bigint' || typeof item === 'function'
      ? undefined
      : item
  ))) as Record<string, JsonValue>;
}

function isHtmlOutput(output: string): boolean {
  return /<!doctype\s+html|<html[\s>]|```html/i.test(output);
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sanitizePrompt(value: string | undefined): string | null {
  const truncated = truncate(value, MAX_PROMPT_LENGTH);
  if (!truncated) return truncated;
  return truncated
    .replace(
      /\b(api[_-]?key|access[_-]?key|secret|password|authorization|bearer|token)\b(\s*[:=]\s*|\s+)(["']?)[^\s,"'}]+/gi,
      (_match, key: string, separator: string) => `${key}${separator}[REDACTED]`,
    );
}

function truncate(value: string | undefined, max: number): string | null {
  if (value === undefined) return null;
  return value.length > max ? value.slice(0, max) : value;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
