import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import {
  AlbumRepository,
  ExportJobRepository,
  type JsonObject,
  type Project,
} from '@html-video/core';
import type { CliContext } from './context.js';

const USER_ID = 'local-dev';
const MAX_ERROR_LENGTH = 4 * 1024;

export interface ExportJobHandle {
  id: string;
  lastProgress: number;
  lastProgressWriteMs: number;
  requestParams: JsonObject;
  pendingUpdate: Promise<void>;
}

export class ExportJobTracker {
  private readonly jobs;
  private readonly albums;

  private constructor(ctx: CliContext) {
    const db = ctx.database!.handle!.db;
    this.jobs = new ExportJobRepository(db);
    this.albums = new AlbumRepository(db);
  }

  static fromContext(ctx: CliContext): ExportJobTracker | null {
    if (ctx.database?.mode !== 'postgres' || !ctx.database.handle) return null;
    return new ExportJobTracker(ctx);
  }

  async start(project: Project, streaming: boolean): Promise<ExportJobHandle | null> {
    try {
      const album = await this.findAlbum(project.id);
      if (!album) {
        this.warn(`album not found for project ${project.id}; export job skipped`);
        return null;
      }
      const resolution = project.preferences.resolution ?? { width: 1920, height: 1080 };
      const fps = project.preferences.fps ?? 60;
      const durationMs = estimateDurationMs(project);
      const id = randomUUID();
      const now = new Date();
      const requestParams: JsonObject = {
        project_id: project.id,
        streaming,
        frame_count: project.frames?.length ?? 0,
        template_id: project.templateId,
        has_music: Boolean(project.soundtrack?.musicAssetId),
        has_narration: Boolean(project.soundtrack?.narrationAssetId),
      };
      await this.jobs.create({
        id,
        user_id: USER_ID,
        album_id: album.id,
        status: 'queued',
        export_format: 'mp4',
        render_profile: `mp4_${resolution.width}x${resolution.height}`,
        width: resolution.width,
        height: resolution.height,
        fps,
        duration_ms: durationMs,
        progress_percent: 0,
        attempt_count: 0,
        request_params: requestParams,
        queued_time: now,
        created_by: USER_ID,
        updated_by: USER_ID,
      });
      const handle: ExportJobHandle = {
        id,
        lastProgress: 0,
        lastProgressWriteMs: now.getTime(),
        requestParams,
        pendingUpdate: Promise.resolve(),
      };
      try {
        await this.jobs.update(USER_ID, id, {
          status: 'running',
          attempt_count: 1,
          started_time: new Date(),
        }, USER_ID);
      } catch (error) {
        this.warn(`could not mark ${id} running: ${errorMessage(error)}`);
      }
      return handle;
    } catch (error) {
      this.warn(`start failed: ${errorMessage(error)}`);
      return null;
    }
  }

  progress(handle: ExportJobHandle | null, percent: number, stage: string): void {
    if (!handle) return;
    const normalized = Math.max(0, Math.min(99, Math.round(percent * 100) / 100));
    const now = Date.now();
    if (normalized < handle.lastProgress + 1 && now - handle.lastProgressWriteMs < 1000) return;
    handle.lastProgress = normalized;
    handle.lastProgressWriteMs = now;
    handle.pendingUpdate = handle.pendingUpdate
      .then(async () => {
        await this.jobs.update(USER_ID, handle.id, {
          progress_percent: normalized,
          request_params: {
            ...handle.requestParams,
            progress_stage: stage.slice(0, 256),
          },
        }, USER_ID);
      })
      .catch((error) => {
        this.warn(`progress update failed for ${handle.id}: ${errorMessage(error)}`);
      });
  }

  async succeed(handle: ExportJobHandle | null, outputPath: string): Promise<void> {
    if (!handle) return;
    await handle.pendingUpdate;
    let fileSizeBytes: number | null = null;
    let checksumSha256: string | null = null;
    try {
      const metadata = await outputMetadata(outputPath);
      fileSizeBytes = metadata.fileSizeBytes;
      checksumSha256 = metadata.checksumSha256;
    } catch (error) {
      this.warn(`output metadata failed for ${handle.id}: ${errorMessage(error)}`);
    }
    try {
      await this.jobs.update(USER_ID, handle.id, {
        status: 'succeeded',
        progress_percent: 100,
        local_output_path: outputPath,
        file_size_bytes: fileSizeBytes,
        checksum_sha256: checksumSha256,
        error_code: null,
        error_message: null,
        finished_time: new Date(),
      }, USER_ID);
    } catch (error) {
      this.warn(`success update failed for ${handle.id}: ${errorMessage(error)}`);
    }
  }

  async fail(handle: ExportJobHandle | null, error: unknown): Promise<void> {
    if (!handle) return;
    await handle.pendingUpdate;
    const code = errorCode(error);
    try {
      await this.jobs.update(USER_ID, handle.id, {
        status: code === 'cancelled' ? 'cancelled' : 'failed',
        error_code: code,
        error_message: errorMessage(error).slice(0, MAX_ERROR_LENGTH),
        finished_time: new Date(),
      }, USER_ID);
    } catch (updateError) {
      this.warn(`failure update failed for ${handle.id}: ${errorMessage(updateError)}`);
    }
  }

  private async findAlbum(projectId: string) {
    const bySourceId = await this.albums.findBySourceProjectId(USER_ID, projectId);
    if (bySourceId) return bySourceId;
    if (!isUuid(projectId)) return null;
    return this.albums.findById(USER_ID, projectId);
  }

  private warn(message: string): void {
    process.stderr.write(`[studio:export-job] ${message}\n`);
  }
}

function estimateDurationMs(project: Project): number | null {
  if (project.frames?.length) {
    return Math.max(0, Math.round(
      project.frames.reduce((total, frame) => total + (frame.durationSec || 0), 0) * 1000,
    ));
  }
  const duration = project.preferences.durationTargetSec;
  return typeof duration === 'number' && Number.isFinite(duration)
    ? Math.max(0, Math.round(duration * 1000))
    : null;
}

async function outputMetadata(path: string): Promise<{ fileSizeBytes: number; checksumSha256: string }> {
  const file = await stat(path);
  const hash = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return {
    fileSizeBytes: file.size,
    checksumSha256: hash.digest('hex'),
  };
}

function errorCode(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && code) return code.slice(0, 128);
  }
  const message = errorMessage(error).toLowerCase();
  if (message.includes('timeout') || message.includes('timed out')) return 'render_timeout';
  if (message.includes('cancel')) return 'cancelled';
  return 'export_failed';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
