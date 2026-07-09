import type { AlbumRow, AlbumStatus, JsonObject, JsonValue } from '../db/types.js';
import type { Asset, FrameRecord, Project, ProjectSoundtrack, ProjectStatus, UserPreferences } from '../types/index.js';

type ProjectSettings = Record<string, JsonValue | undefined>;

export function albumRowToProject(album: AlbumRow): Project {
  const settings = album.settings as ProjectSettings;
  const project: Project = {
    id: album.source_project_id ?? album.id,
    name: album.title,
    assets: asArray<Asset>(settings.legacy_assets),
    templateId: asNullableString(settings.template_id),
    variables: asRecord(settings.variables),
    preferences: mergeRenderPreferences(asRecord(settings.preferences), album),
    status: albumStatusToProjectStatus(album.status),
    createdAt: toIsoString(album.created_time),
    updatedAt: toIsoString(album.updated_time),
  };

  if (album.description !== null) project.intent = album.description;
  if (settings.agent_id !== undefined) project.agentId = asNullableString(settings.agent_id);
  if (settings.agent_model !== undefined) project.agentModel = asNullableString(settings.agent_model);
  if (settings.local_last_preview_html_path !== undefined) {
    const value = asOptionalString(settings.local_last_preview_html_path);
    if (value !== undefined) project.lastPreviewHtmlPath = value;
  }
  if (album.last_preview_html_url) {
    project.lastPreviewHtmlUrl = album.last_preview_html_url;
  }
  if (settings.local_last_preview_poster_path !== undefined) {
    const value = asOptionalString(settings.local_last_preview_poster_path);
    if (value !== undefined) project.lastPreviewPosterPath = value;
  }
  if (settings.local_last_output_mp4_path !== undefined) {
    const value = asOptionalString(settings.local_last_output_mp4_path);
    if (value !== undefined) project.lastOutputMp4Path = value;
  }
  if (settings.content_graph_path !== undefined) {
    const value = asOptionalString(settings.content_graph_path);
    if (value !== undefined) project.contentGraphPath = value;
  }
  const frames = asArray<FrameRecord>(settings.legacy_frames);
  if (frames.length > 0) project.frames = frames;
  const exportsList = asArray<{ path: string; createdAt: string; filename: string }>(settings.legacy_exports);
  if (exportsList.length > 0) project.exports = exportsList;
  const soundtrack = asOptionalRecord(settings.soundtrack) as ProjectSoundtrack | undefined;
  if (soundtrack !== undefined) project.soundtrack = soundtrack;

  return project;
}

export function projectToAlbumSettings(project: Project, previous: JsonObject = {}): JsonObject {
  return stripUndefined({
    ...previous,
    template_id: project.templateId,
    variables: project.variables,
    preferences: project.preferences,
    agent_id: project.agentId ?? null,
    agent_model: project.agentModel ?? null,
    soundtrack: project.soundtrack,
    local_last_preview_html_path: project.lastPreviewHtmlPath,
    local_last_preview_poster_path: project.lastPreviewPosterPath,
    local_last_output_mp4_path: project.lastOutputMp4Path,
    content_graph_path: project.contentGraphPath,
    legacy_frames: project.frames ?? [],
    legacy_assets: project.assets ?? [],
    legacy_exports: project.exports ?? [],
  }) as JsonObject;
}

export function projectStatusToAlbumStatus(status: ProjectStatus): AlbumStatus {
  return status;
}

export function albumStatusToProjectStatus(status: AlbumStatus): ProjectStatus {
  if (status === 'previewed') return 'previewed';
  if (status === 'rendered' || status === 'published' || status === 'archived') return 'rendered';
  return 'draft';
}

export function projectCanvasWidth(project: Project): number {
  return project.preferences.resolution?.width ?? 1080;
}

export function projectCanvasHeight(project: Project): number {
  return project.preferences.resolution?.height ?? 1920;
}

export function projectFps(project: Project): number {
  return project.preferences.fps ?? 30;
}

export function projectDurationMs(project: Project): number {
  const duration = project.preferences.durationTargetSec;
  return typeof duration === 'number' && Number.isFinite(duration) ? Math.max(0, Math.round(duration * 1000)) : 0;
}

function mergeRenderPreferences(raw: Record<string, unknown>, album: AlbumRow): UserPreferences {
  const preferences = raw as UserPreferences;
  return {
    ...preferences,
    resolution: preferences.resolution ?? { width: album.canvas_width, height: album.canvas_height },
    fps: preferences.fps ?? album.fps,
  };
}

function toIsoString(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}

function asNullableString(value: JsonValue | undefined): string | null {
  if (typeof value === 'string') return value;
  return null;
}

function asOptionalString(value: JsonValue | undefined): string | undefined {
  if (typeof value === 'string') return value;
  return undefined;
}

function asRecord(value: JsonValue | undefined): Record<string, unknown> {
  if (isRecord(value)) return value as Record<string, unknown>;
  return {};
}

function asOptionalRecord(value: JsonValue | undefined): Record<string, unknown> | undefined {
  if (isRecord(value)) return value as Record<string, unknown>;
  return undefined;
}

function asArray<T>(value: JsonValue | undefined): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stripUndefined(value: Record<string, unknown>): Record<string, JsonValue> {
  const out: Record<string, JsonValue> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (raw === undefined) continue;
    out[key] = raw as JsonValue;
  }
  return out;
}
