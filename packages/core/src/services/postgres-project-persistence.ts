import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ContentGraph } from '@html-video/content-graph';
import type { DbClient } from '../db/client.js';
import type { AlbumPageRow, AlbumRow, JsonObject, JsonValue } from '../db/types.js';
import { HtmlVideoError } from '../errors.js';
import { AlbumPageRepository } from '../repositories/album-page-repository.js';
import { AlbumRepository } from '../repositories/album-repository.js';
import type { FrameRecord, Project } from '../types/index.js';
import {
  albumRowToProject,
  projectCanvasHeight,
  projectCanvasWidth,
  projectDurationMs,
  projectFps,
  projectStatusToAlbumStatus,
  projectToAlbumSettings,
} from './project-mapper.js';
import type { ProjectPersistence } from './project-persistence.js';
import { LOCAL_DEV_USER_CONTEXT, type UserContext } from './user-context.js';

export interface PostgresProjectPersistenceOptions {
  db: DbClient;
  projectRoot: string;
  userContext?: UserContext;
  albums?: AlbumRepository;
  pages?: AlbumPageRepository;
}

export class PostgresProjectPersistence implements ProjectPersistence {
  private readonly albums: AlbumRepository;
  private readonly pages: AlbumPageRepository;
  private readonly userContext: UserContext;

  constructor(private readonly opts: PostgresProjectPersistenceOptions) {
    this.albums = opts.albums ?? new AlbumRepository(opts.db);
    this.pages = opts.pages ?? new AlbumPageRepository(opts.db);
    this.userContext = opts.userContext ?? LOCAL_DEV_USER_CONTEXT;
  }

  async ensureDir(id: string): Promise<string> {
    const dir = join(this.opts.projectRoot, '.html-video', 'projects', id);
    await mkdir(join(dir, 'assets'), { recursive: true });
    return dir;
  }

  async save(project: Project): Promise<void> {
    const existing = await this.findAlbumForProjectId(project.id);
    const settings = projectToAlbumSettings(project, existing?.settings ?? {});
    if (existing) {
      await this.albums.update(this.userContext.userId, existing.id, {
        title: project.name,
        description: project.intent ?? null,
        status: projectStatusToAlbumStatus(project.status),
        canvas_width: projectCanvasWidth(project),
        canvas_height: projectCanvasHeight(project),
        fps: projectFps(project),
        duration_ms: projectDurationMs(project),
        page_count: project.frames?.length ?? 0,
        settings,
      }, this.userContext.actorId);
      return;
    }

    await this.albums.create({
      id: randomUUID(),
      user_id: this.userContext.userId,
      source_project_id: project.id,
      title: project.name,
      description: project.intent ?? null,
      status: projectStatusToAlbumStatus(project.status),
      canvas_width: projectCanvasWidth(project),
      canvas_height: projectCanvasHeight(project),
      fps: projectFps(project),
      duration_ms: projectDurationMs(project),
      page_count: project.frames?.length ?? 0,
      settings,
      created_by: this.userContext.actorId,
      updated_by: this.userContext.actorId,
    });
  }

  async load(id: string): Promise<Project> {
    const album = await this.findAlbumForProjectId(id);
    if (!album || album.status === 'deleted') {
      throw new HtmlVideoError('project-not-found', `Project ${id} not found`);
    }
    return albumRowToProject(album);
  }

  async list(): Promise<Project[]> {
    const albums = await this.albums.listByUser(this.userContext.userId);
    return albums.filter(isFormalProjectAlbum).map((album) => albumRowToProject(album));
  }

  async remove(id: string): Promise<void> {
    const album = await this.findAlbumForProjectId(id);
    if (!album || album.status === 'deleted') return;
    await this.albums.softDelete(this.userContext.userId, album.id, this.userContext.actorId);
  }

  async readRawHtml(projectId: string): Promise<string | null> {
    const album = await this.findAlbumForProjectId(projectId);
    if (!album || album.status === 'deleted') return null;
    const page = await this.pages.findByNodeId(this.userContext.userId, album.id, 'preview')
      ?? await this.pages.findByPageNo(this.userContext.userId, album.id, 1);
    if (page?.raw_html) return page.raw_html;
    return readLocalFile(asString(album.settings.local_last_preview_html_path));
  }

  async writeRawHtml(projectId: string, html: string): Promise<{ project: Project; htmlPath: string }> {
    const album = await this.requireAlbum(projectId);
    const project = albumRowToProject(album);
    const projectDir = await this.ensureDir(project.id);
    const htmlPath = join(projectDir, 'preview.html');
    await writeFile(htmlPath, html, 'utf8');

    project.lastPreviewHtmlPath = htmlPath;
    if ((project.frames?.length ?? 0) === 0) {
      project.frames = [];
      delete project.contentGraphPath;
    }
    if (project.status === 'draft') project.status = 'previewed';

    const existingPreview = await this.pages.findByNodeId(this.userContext.userId, album.id, 'preview');
    const existingPages = existingPreview ? [] : await this.pages.listByAlbum(this.userContext.userId, album.id);
    const previewPageNo = existingPreview?.page_no
      ?? Math.max(0, ...existingPages.map((page) => page.page_no)) + 1;

    await this.pages.upsertByAlbumAndNodeId({
      id: randomUUID(),
      user_id: this.userContext.userId,
      album_id: album.id,
      node_id: 'preview',
      page_no: previewPageNo,
      title: project.name,
      status: 'ready',
      duration_ms: projectDurationMs(project) || 3000,
      raw_html: html,
      content: { kind: 'single_preview', local_html_path: htmlPath },
      created_by: this.userContext.actorId,
      updated_by: this.userContext.actorId,
    });
    await this.save(project);
    return { project: await this.load(project.id), htmlPath };
  }

  async readFrameHtml(projectId: string, nodeId: string): Promise<string | null> {
    const album = await this.findAlbumForProjectId(projectId);
    if (!album || album.status === 'deleted') return null;
    const page = await this.pages.findByNodeId(this.userContext.userId, album.id, nodeId);
    if (page?.raw_html) return page.raw_html;
    const project = albumRowToProject(album);
    const frame = (project.frames ?? []).find((item) => item.graphNodeId === nodeId);
    return readLocalFile(frame?.htmlPath);
  }

  async writeFrameHtml(
    projectId: string,
    nodeId: string,
    html: string,
    frame: FrameRecord,
  ): Promise<{ project: Project; frame: FrameRecord }> {
    const album = await this.requireAlbum(projectId);
    const project = albumRowToProject(album);
    const projectDir = await this.ensureDir(project.id);
    const framesDir = join(projectDir, 'frames');
    await mkdir(framesDir, { recursive: true });
    const safeId = nodeId.replace(/[^a-z0-9_-]/gi, '_');
    const htmlPath = join(framesDir, `${String(frame.order + 1).padStart(2, '0')}-${safeId}.html`);
    await writeFile(htmlPath, html, 'utf8');

    const nextFrame: FrameRecord = {
      ...frame,
      graphNodeId: nodeId,
      htmlPath,
    };
    project.frames = (project.frames ?? []).filter((item) => item.graphNodeId !== nodeId);
    project.frames.push(nextFrame);
    project.frames.sort((a, b) => a.order - b.order);
    if (project.frames[0]?.graphNodeId === nodeId) {
      project.lastPreviewHtmlPath = htmlPath;
    }
    if (project.status === 'draft') project.status = 'previewed';

    const pageNo = await this.pageNoForGraphNode(album.id, nodeId, frame.order);
    await this.pages.upsertByAlbumAndPageNo({
      id: randomUUID(),
      user_id: this.userContext.userId,
      album_id: album.id,
      node_id: nodeId,
      page_no: pageNo,
      title: nodeId,
      status: 'ready',
      template_key: frame.nativeTemplateId ?? null,
      duration_ms: Math.max(1, Math.round(frame.durationSec * 1000)),
      raw_html: html,
      content: stripUndefined({
        graph_node_id: nodeId,
        data: frame.data,
        local_html_path: htmlPath,
        local_preview_mp4_path: frame.previewMp4Path,
      }),
      style: stripUndefined({
        engine: frame.engine,
        native_template_id: frame.nativeTemplateId,
      }),
      created_by: this.userContext.actorId,
      updated_by: this.userContext.actorId,
    });
    await this.save(project);
    return { project: await this.load(project.id), frame: nextFrame };
  }

  async readContentGraph(projectId: string): Promise<ContentGraph | null> {
    const album = await this.findAlbumForProjectId(projectId);
    if (!album || album.status === 'deleted') return null;
    const graphMeta = asObject(album.settings.content_graph);
    if (graphMeta) {
      const pages = await this.pages.listByAlbum(this.userContext.userId, album.id);
      const nodes = pages
        .map((page) => asObject(page.content.graph_node))
        .filter((node): node is JsonObject => node !== null);
      if (nodes.length > 0) {
        return {
          schemaVersion: Number(graphMeta.schemaVersion ?? 1),
          intent: typeof graphMeta.intent === 'string' ? graphMeta.intent : 'other',
          ...(typeof graphMeta.synopsis === 'string' && { synopsis: graphMeta.synopsis }),
          nodes: nodes as unknown as ContentGraph['nodes'],
          edges: Array.isArray(graphMeta.edges) ? graphMeta.edges as unknown as ContentGraph['edges'] : [],
        } as ContentGraph;
      }
    }
    return readJsonFile<ContentGraph>(asString(album.settings.content_graph_path));
  }

  async writeContentGraph(
    projectId: string,
    graph: ContentGraph,
    opts: { preserveFrames?: boolean } = {},
  ): Promise<{ project: Project; graphPath: string }> {
    const album = await this.requireAlbum(projectId);
    const project = albumRowToProject(album);
    const projectDir = await this.ensureDir(project.id);
    const graphPath = join(projectDir, 'content-graph.json');
    await writeFile(graphPath, JSON.stringify(graph, null, 2), 'utf8');
    await mkdir(join(projectDir, 'frames'), { recursive: true });

    project.contentGraphPath = graphPath;
    if (opts.preserveFrames) {
      const byId = new Map(graph.nodes.map((node) => [node.id, node.durationSec]));
      project.frames = (project.frames ?? []).map((item) => ({
        ...item,
        durationSec: byId.get(item.graphNodeId) ?? item.durationSec,
      }));
    } else {
      project.frames = [];
      if (project.status !== 'rendered') project.status = 'draft';
    }

    for (let i = 0; i < graph.nodes.length; i++) {
      const node = graph.nodes[i]!;
      const existing = await this.pages.findByNodeId(this.userContext.userId, album.id, node.id);
      const pageNo = existing?.page_no ?? await this.pageNoForGraphNode(album.id, node.id, i);
      await this.pages.upsertByAlbumAndPageNo({
        id: existing?.id ?? randomUUID(),
        user_id: this.userContext.userId,
        album_id: album.id,
        node_id: node.id,
        page_no: pageNo,
        title: titleFromGraphNode(node),
        status: existing?.raw_html ? 'ready' : 'draft',
        duration_ms: Math.max(1, Math.round((node.durationSec ?? 3) * 1000)),
        raw_html: opts.preserveFrames ? existing?.raw_html ?? null : null,
        content: {
          ...(existing?.content ?? {}),
          graph_node: node as unknown as JsonValue,
        },
        style: existing?.style ?? {},
        transition: existing?.transition ?? {},
        created_by: this.userContext.actorId,
        updated_by: this.userContext.actorId,
      });
    }

    const settings = {
      ...projectToAlbumSettings(project, album.settings),
      content_graph: stripUndefined({
        schemaVersion: graph.schemaVersion,
        intent: graph.intent,
        synopsis: graph.synopsis,
        edges: graph.edges,
      }),
    };
    await this.albums.update(this.userContext.userId, album.id, {
      page_count: graph.nodes.length,
      settings,
    }, this.userContext.actorId);
    return { project: await this.load(project.id), graphPath };
  }

  private async findAlbumForProjectId(id: string): Promise<AlbumRow | null> {
    const bySourceProjectId = await this.albums.findBySourceProjectId(this.userContext.userId, id);
    if (bySourceProjectId) return bySourceProjectId;
    if (!isUuid(id)) return null;
    return this.albums.findById(this.userContext.userId, id);
  }

  private async requireAlbum(id: string): Promise<AlbumRow> {
    const album = await this.findAlbumForProjectId(id);
    if (!album || album.status === 'deleted') {
      throw new HtmlVideoError('project-not-found', `Project ${id} not found`);
    }
    return album;
  }

  private async pageNoForGraphNode(albumId: string, nodeId: string, order: number): Promise<number> {
    const existing = await this.pages.findByNodeId(this.userContext.userId, albumId, nodeId);
    if (existing) return existing.page_no;
    const preview = await this.pages.findByNodeId(this.userContext.userId, albumId, 'preview');
    return order + 1 + (preview ? 1 : 0);
  }
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function isFormalProjectAlbum(album: AlbumRow): boolean {
  return album.source_project_id === null || album.source_project_id.startsWith('proj_');
}

async function readLocalFile(path: string | undefined): Promise<string | null> {
  if (!path || !existsSync(path)) return null;
  return readFile(path, 'utf8');
}

async function readJsonFile<T>(path: string | undefined): Promise<T | null> {
  const raw = await readLocalFile(path);
  return raw ? JSON.parse(raw) as T : null;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asObject(value: unknown): JsonObject | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as JsonObject : null;
}

function stripUndefined(value: Record<string, unknown>): JsonObject {
  const out: Record<string, JsonValue> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (raw === undefined) continue;
    out[key] = raw as JsonValue;
  }
  return out;
}

function titleFromGraphNode(node: ContentGraph['nodes'][number]): string | null {
  const record = node as unknown as Record<string, unknown>;
  if (typeof record.text === 'string' && record.text.trim()) return record.text.trim().slice(0, 200);
  if (typeof record.label === 'string' && record.label.trim()) return record.label.trim().slice(0, 200);
  return node.id;
}
