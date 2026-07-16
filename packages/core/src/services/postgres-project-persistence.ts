import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ContentGraph } from '@html-video/content-graph';
import type { DbClient, TransactionalDbClient } from '../db/client.js';
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
import type {
  HtmlPublication,
  HtmlPublisher,
  ProjectPersistence,
  RevisionedRawHtmlWriteResult,
} from './project-persistence.js';
import type { UserContext } from './user-context.js';
import { safeWorkDirectorySegment } from './work-directory.js';

export interface PostgresProjectPersistenceOptions {
  db: DbClient;
  projectRoot: string;
  getUserContext: () => Readonly<UserContext>;
  albums?: AlbumRepository;
  pages?: AlbumPageRepository;
  publishHtml?: HtmlPublisher;
}

export class PostgresProjectPersistence implements ProjectPersistence {
  private readonly albums: AlbumRepository;
  private readonly pages: AlbumPageRepository;

  constructor(private readonly opts: PostgresProjectPersistenceOptions) {
    this.albums = opts.albums ?? new AlbumRepository(opts.db);
    this.pages = opts.pages ?? new AlbumPageRepository(opts.db);
  }

  async ensureDir(id: string): Promise<string> {
    const user = this.opts.getUserContext();
    const dir = join(
      this.opts.projectRoot,
      '.html-video',
      'tmp',
      'work',
      safeWorkDirectorySegment(user.userId, 'user'),
      safeWorkDirectorySegment(id, 'project'),
    );
    await mkdir(join(dir, 'assets'), { recursive: true });
    return dir;
  }

  async save(project: Project): Promise<void> {
    const user = this.opts.getUserContext();
    await this.saveForUser(project, user);
  }

  private async saveForUser(project: Project, user: Readonly<UserContext>): Promise<void> {
    const existing = await this.findAlbumForProjectId(project.id, user);
    const settings = projectToAlbumSettings(project, existing?.settings ?? {});
    if (existing) {
      await this.albums.update(user.userId, existing.id, {
        title: project.name,
        description: project.intent ?? null,
        status: projectStatusToAlbumStatus(project.status),
        canvas_width: projectCanvasWidth(project),
        canvas_height: projectCanvasHeight(project),
        fps: projectFps(project),
        duration_ms: projectDurationMs(project),
        page_count: project.frames?.length ?? 0,
        settings,
      }, user.actorId);
      return;
    }

    await this.albums.create({
      id: randomUUID(),
      user_id: user.userId,
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
      created_by: user.actorId,
      updated_by: user.actorId,
    });
  }

  async load(id: string): Promise<Project> {
    const user = this.opts.getUserContext();
    return this.loadForUser(id, user);
  }

  private async loadForUser(id: string, user: Readonly<UserContext>): Promise<Project> {
    const album = await this.findAlbumForProjectId(id, user);
    if (!album || album.status === 'deleted') {
      throw new HtmlVideoError('project-not-found', `Project ${id} not found`);
    }
    return albumRowToProject(album);
  }

  async list(): Promise<Project[]> {
    const user = this.opts.getUserContext();
    const albums = await this.albums.listByUser(user.userId);
    return albums.filter(isFormalProjectAlbum).map((album) => albumRowToProject(album));
  }

  async remove(id: string): Promise<void> {
    const user = this.opts.getUserContext();
    const album = await this.requireAlbum(id, user);
    await this.albums.softDelete(user.userId, album.id, user.actorId);
  }

  async readRawHtml(projectId: string): Promise<string | null> {
    const user = this.opts.getUserContext();
    const album = await this.requireAlbum(projectId, user);
    const page = await this.pages.findByNodeId(user.userId, album.id, 'preview')
      ?? await this.pages.findByPageNo(user.userId, album.id, 1);
    return page?.raw_html ?? null;
  }

  async writeRawHtml(projectId: string, html: string): Promise<{
    project: Project;
    htmlPath: string;
    htmlUrl?: string;
  }> {
    const user = this.opts.getUserContext();
    const album = await this.requireAlbum(projectId, user);
    const project = albumRowToProject(album);
    const projectDir = await this.ensureDir(project.id);
    const htmlPath = join(projectDir, 'preview.html');
    await writeFile(htmlPath, html, 'utf8');
    const publication = await this.publishHtml(user, project.id, 'preview', html);

    project.lastPreviewHtmlPath = htmlPath;
    if ((project.frames?.length ?? 0) === 0) {
      project.frames = [];
      delete project.contentGraphPath;
    }
    if (project.status === 'draft') project.status = 'previewed';

    const existingPreview = await this.pages.findByNodeId(user.userId, album.id, 'preview');
    const existingPages = existingPreview ? [] : await this.pages.listByAlbum(user.userId, album.id);
    const previewPageNo = existingPreview?.page_no
      ?? Math.max(0, ...existingPages.map((page) => page.page_no)) + 1;

    await this.pages.upsertByAlbumAndNodeId({
      id: randomUUID(),
      user_id: user.userId,
      album_id: album.id,
      node_id: 'preview',
      page_no: previewPageNo,
      title: project.name,
      status: 'ready',
      duration_ms: projectDurationMs(project) || 3000,
      raw_html: html,
      ...publicationFields(publication),
      content: { kind: 'single_preview', local_html_path: htmlPath },
      created_by: user.actorId,
      updated_by: user.actorId,
    });
    if (publication) {
      await this.albums.update(user.userId, album.id, {
        last_preview_html_url: publication.url,
      }, user.actorId);
    }
    await this.saveForUser(project, user);
    return {
      project: await this.loadForUser(project.id, user),
      htmlPath,
      ...(publication && { htmlUrl: publication.url }),
    };
  }

  async writeRawHtmlIfRevision(
    projectId: string,
    html: string,
    expectedRevision: number,
  ): Promise<RevisionedRawHtmlWriteResult> {
    const user = this.opts.getUserContext();
    const initialAlbum = await this.requireAlbum(projectId, user);
    const initialRevision = albumRevision(initialAlbum);
    if (initialRevision !== expectedRevision) {
      return { ok: false, currentRevision: initialRevision };
    }

    const nextRevision = expectedRevision + 1;
    const projectDir = await this.ensureDir(projectId);
    const htmlPath = join(projectDir, `preview-revision-${nextRevision}.html`);
    await writeFile(htmlPath, html, 'utf8');
    let publication: HtmlPublication | null = null;
    try {
      publication = await this.publishHtml(user, projectId, `preview-revision-${nextRevision}`, html);
      const commit = async (
        albums: AlbumRepository,
        pages: AlbumPageRepository,
      ): Promise<{ updated: AlbumRow | null; currentRevision: number }> => {
        const current = await findAlbumForProjectId(albums, user.userId, projectId);
        if (!current || current.status === 'deleted') {
          throw new HtmlVideoError('project-not-found', `Project ${projectId} not found`);
        }
        const project = albumRowToProject(current);
        project.lastPreviewHtmlPath = htmlPath;
        project.albumRevision = nextRevision;
        if ((project.frames?.length ?? 0) === 0) {
          project.frames = [];
          delete project.contentGraphPath;
        }
        if (project.status === 'draft') project.status = 'previewed';
        const settings = projectToAlbumSettings(project, current.settings);
        const updated = await albums.updateIfAlbumRevision(
          user.userId,
          current.id,
          expectedRevision,
          {
            status: projectStatusToAlbumStatus(project.status),
            settings,
            ...(publication && { last_preview_html_url: publication.url }),
          },
          user.actorId,
        );
        if (!updated) {
          const latest = await albums.findById(user.userId, current.id);
          return { updated: null, currentRevision: latest ? albumRevision(latest) : expectedRevision };
        }

        const existingPreview = await pages.findByNodeId(user.userId, current.id, 'preview');
        const existingPages = existingPreview ? [] : await pages.listByAlbum(user.userId, current.id);
        const previewPageNo = existingPreview?.page_no
          ?? Math.max(0, ...existingPages.map((page) => page.page_no)) + 1;
        await pages.upsertByAlbumAndNodeId({
          id: existingPreview?.id ?? randomUUID(),
          user_id: user.userId,
          album_id: current.id,
          node_id: 'preview',
          page_no: previewPageNo,
          title: project.name,
          status: 'ready',
          duration_ms: projectDurationMs(project) || 3000,
          raw_html: html,
          ...(publicationFields(publication)),
          content: { kind: 'single_preview', local_html_path: htmlPath },
          created_by: existingPreview?.created_by ?? user.actorId,
          updated_by: user.actorId,
        });
        return { updated, currentRevision: nextRevision };
      };

      const db = this.opts.db as Partial<TransactionalDbClient>;
      const outcome = typeof db.transaction === 'function'
        ? await db.transaction((tx) => commit(new AlbumRepository(tx), new AlbumPageRepository(tx)))
        : await commit(this.albums, this.pages);
      if (!outcome.updated) {
        await rm(htmlPath, { force: true }).catch(() => {});
        return { ok: false, currentRevision: outcome.currentRevision };
      }
      return {
        ok: true,
        project: albumRowToProject(outcome.updated),
        htmlPath,
        ...(publication && { htmlUrl: publication.url }),
        previousRevision: expectedRevision,
        revision: nextRevision,
      };
    } catch (error) {
      await rm(htmlPath, { force: true }).catch(() => {});
      throw error;
    }
  }

  async readFrameHtml(projectId: string, nodeId: string): Promise<string | null> {
    const user = this.opts.getUserContext();
    const album = await this.requireAlbum(projectId, user);
    const page = await this.pages.findByNodeId(user.userId, album.id, nodeId);
    return page?.raw_html ?? null;
  }

  async writeFrameHtml(
    projectId: string,
    nodeId: string,
    html: string,
    frame: FrameRecord,
  ): Promise<{ project: Project; frame: FrameRecord; htmlUrl?: string }> {
    const user = this.opts.getUserContext();
    const album = await this.requireAlbum(projectId, user);
    const project = albumRowToProject(album);
    const projectDir = await this.ensureDir(project.id);
    const framesDir = join(projectDir, 'frames');
    await mkdir(framesDir, { recursive: true });
    const safeId = nodeId.replace(/[^a-z0-9_-]/gi, '_');
    const htmlPath = join(framesDir, `${String(frame.order + 1).padStart(2, '0')}-${safeId}.html`);
    await writeFile(htmlPath, html, 'utf8');
    const publication = await this.publishHtml(user, project.id, nodeId, html);

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

    const existingPage = await this.pages.findByNodeId(user.userId, album.id, nodeId);
    const pageNo = existingPage?.page_no
      ?? await this.pageNoForGraphNode(album.id, nodeId, frame.order, user);
    await this.pages.upsertByAlbumAndPageNo({
      id: existingPage?.id ?? randomUUID(),
      user_id: user.userId,
      album_id: album.id,
      node_id: nodeId,
      page_no: pageNo,
      title: nodeId,
      status: 'ready',
      template_key: frame.nativeTemplateId ?? null,
      duration_ms: Math.max(1, Math.round(frame.durationSec * 1000)),
      raw_html: html,
      ...publicationFields(publication),
      content: {
        ...(existingPage?.content ?? {}),
        ...stripUndefined({
          graph_node_id: nodeId,
          data: frame.data,
          local_html_path: htmlPath,
          local_preview_mp4_path: frame.previewMp4Path,
        }),
      },
      style: stripUndefined({
        engine: frame.engine,
        native_template_id: frame.nativeTemplateId,
      }),
      created_by: user.actorId,
      updated_by: user.actorId,
    });
    if (publication && frame.order === 0) {
      await this.albums.update(user.userId, album.id, {
        last_preview_html_url: publication.url,
      }, user.actorId);
    }
    await this.saveForUser(project, user);
    return {
      project: await this.loadForUser(project.id, user),
      frame: nextFrame,
      ...(publication && { htmlUrl: publication.url }),
    };
  }

  private async publishHtml(
    user: Readonly<UserContext>,
    projectId: string,
    nodeId: string,
    html: string,
  ): Promise<HtmlPublication | null> {
    if (!this.opts.publishHtml) return null;
    return this.opts.publishHtml({
      userId: user.userId,
      projectId,
      nodeId,
      html,
    });
  }

  async readContentGraph(projectId: string): Promise<ContentGraph | null> {
    const user = this.opts.getUserContext();
    const album = await this.requireAlbum(projectId, user);
    const graphMeta = asObject(album.settings.content_graph);
    const pages = await this.pages.listByAlbum(user.userId, album.id);
    const nodes = pages
      .map((page) => asObject(page.content.graph_node))
      .filter((node): node is JsonObject => node !== null);
    if (nodes.length === 0) return null;
    return {
      schemaVersion: Number(graphMeta?.schemaVersion ?? 1),
      intent: typeof graphMeta?.intent === 'string' ? graphMeta.intent : 'other',
      ...(typeof graphMeta?.synopsis === 'string' && { synopsis: graphMeta.synopsis }),
      nodes: nodes as unknown as ContentGraph['nodes'],
      edges: Array.isArray(graphMeta?.edges) ? graphMeta.edges as unknown as ContentGraph['edges'] : [],
    } as ContentGraph;
  }

  async writeContentGraph(
    projectId: string,
    graph: ContentGraph,
    opts: { preserveFrames?: boolean } = {},
  ): Promise<{ project: Project; graphPath: string }> {
    const user = this.opts.getUserContext();
    const album = await this.requireAlbum(projectId, user);
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
      const existing = await this.pages.findByNodeId(user.userId, album.id, node.id);
      const pageNo = existing?.page_no ?? await this.pageNoForGraphNode(album.id, node.id, i, user);
      await this.pages.upsertByAlbumAndPageNo({
        id: existing?.id ?? randomUUID(),
        user_id: user.userId,
        album_id: album.id,
        node_id: node.id,
        page_no: pageNo,
        title: titleFromGraphNode(node),
        status: existing?.raw_html ? 'ready' : 'draft',
        duration_ms: Math.max(1, Math.round((node.durationSec ?? 3) * 1000)),
        raw_html: opts.preserveFrames ? existing?.raw_html ?? null : null,
        html_oss_bucket: existing?.html_oss_bucket ?? null,
        html_oss_key: existing?.html_oss_key ?? null,
        html_url: existing?.html_url ?? null,
        html_checksum_sha256: existing?.html_checksum_sha256 ?? null,
        content: {
          ...(existing?.content ?? {}),
          graph_node: node as unknown as JsonValue,
        },
        style: existing?.style ?? {},
        transition: existing?.transition ?? {},
        created_by: user.actorId,
        updated_by: user.actorId,
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
    await this.albums.update(user.userId, album.id, {
      page_count: graph.nodes.length,
      settings,
    }, user.actorId);
    return { project: await this.loadForUser(project.id, user), graphPath };
  }

  private async findAlbumForProjectId(id: string, user: Readonly<UserContext>): Promise<AlbumRow | null> {
    const bySourceProjectId = await this.albums.findBySourceProjectId(user.userId, id);
    if (bySourceProjectId) return bySourceProjectId;
    if (!isUuid(id)) return null;
    return this.albums.findById(user.userId, id);
  }

  private async requireAlbum(id: string, user: Readonly<UserContext>): Promise<AlbumRow> {
    const album = await this.findAlbumForProjectId(id, user);
    if (!album || album.status === 'deleted') {
      throw new HtmlVideoError('project-not-found', `Project ${id} not found`);
    }
    return album;
  }

  private async pageNoForGraphNode(
    albumId: string,
    nodeId: string,
    order: number,
    user: Readonly<UserContext>,
  ): Promise<number> {
    const existing = await this.pages.findByNodeId(user.userId, albumId, nodeId);
    if (existing) return existing.page_no;
    const preview = await this.pages.findByNodeId(user.userId, albumId, 'preview');
    return order + 1 + (preview ? 1 : 0);
  }
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

async function findAlbumForProjectId(
  albums: AlbumRepository,
  userId: string,
  projectId: string,
): Promise<AlbumRow | null> {
  const bySourceProjectId = await albums.findBySourceProjectId(userId, projectId);
  if (bySourceProjectId) return bySourceProjectId;
  if (!isUuid(projectId)) return null;
  return albums.findById(userId, projectId);
}

function albumRevision(album: AlbumRow): number {
  const value = Number(album.settings.album_revision ?? 0);
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function isFormalProjectAlbum(album: AlbumRow): boolean {
  return album.source_project_id === null || album.source_project_id.startsWith('proj_');
}

function publicationFields(publication: HtmlPublication | null) {
  return publication
    ? {
        html_oss_bucket: publication.bucket,
        html_oss_key: publication.key,
        html_url: publication.url,
        html_checksum_sha256: publication.checksumSha256,
      }
    : {};
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
