import { DEFAULT_FRAME_DURATION_SEC, type ContentGraph } from '@html-video/content-graph';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FrameRecord, Project } from '../types/index.js';
import type { ProjectStore } from '../registry.js';
import type { ProjectPersistence, RevisionedRawHtmlWriteResult } from './project-persistence.js';

/**
 * File-backed ProjectPersistence adapter.
 *
 * This intentionally delegates every operation to the existing ProjectStore so
 * stage 1 changes the dependency shape without changing persistence behavior.
 */
export class FileProjectPersistence implements ProjectPersistence {
  private readonly revisionWriteQueues = new Map<string, Promise<unknown>>();

  constructor(private readonly store: ProjectStore) {}

  ensureDir(id: string): Promise<string> {
    return this.store.ensureDir(id);
  }

  save(project: Project): Promise<void> {
    return this.store.save(project);
  }

  load(id: string): Promise<Project> {
    return this.store.load(id);
  }

  list(): Promise<Project[]> {
    return this.store.list();
  }

  remove(id: string): Promise<void> {
    return this.store.remove(id);
  }

  async readRawHtml(projectId: string): Promise<string | null> {
    const project = await this.store.load(projectId);
    if (!project.lastPreviewHtmlPath || !existsSync(project.lastPreviewHtmlPath)) return null;
    return readFile(project.lastPreviewHtmlPath, 'utf8');
  }

  async writeRawHtml(projectId: string, html: string): Promise<{ project: Project; htmlPath: string }> {
    const project = await this.store.load(projectId);
    const projectDir = await this.store.ensureDir(projectId);
    const htmlPath = join(projectDir, 'preview.html');
    await writeFile(htmlPath, html, 'utf8');
    project.lastPreviewHtmlPath = htmlPath;
    if ((project.frames?.length ?? 0) === 0) {
      project.frames = [];
      delete project.contentGraphPath;
    }
    if (project.status === 'draft') project.status = 'previewed';
    await this.store.save(project);
    return { project, htmlPath };
  }

  async writeRawHtmlIfRevision(
    projectId: string,
    html: string,
    expectedRevision: number,
  ): Promise<RevisionedRawHtmlWriteResult> {
    return this.withRevisionWriteQueue(projectId, async () => {
      let project = await this.store.load(projectId);
      let currentRevision = projectAlbumRevision(project);
      if (currentRevision !== expectedRevision) return { ok: false, currentRevision };

      const projectDir = await this.store.ensureDir(projectId);
      const htmlPath = join(projectDir, 'preview.html');
      const tempPath = join(projectDir, `.preview-revision-${expectedRevision + 1}-${Date.now()}.tmp`);
      const previousHtml = existsSync(htmlPath) ? await readFile(htmlPath, 'utf8') : null;
      await writeFile(tempPath, html, 'utf8');
      try {
        // Reload immediately before replacing the artifact so external metadata
        // changes observed by file mode are not silently overwritten.
        project = await this.store.load(projectId);
        currentRevision = projectAlbumRevision(project);
        if (currentRevision !== expectedRevision) {
          await rm(tempPath, { force: true });
          return { ok: false, currentRevision };
        }
        await rename(tempPath, htmlPath);
        project.lastPreviewHtmlPath = htmlPath;
        if ((project.frames?.length ?? 0) === 0) {
          project.frames = [];
          delete project.contentGraphPath;
        }
        if (project.status === 'draft') project.status = 'previewed';
        project.albumRevision = expectedRevision + 1;
        await this.store.save(project);
      } catch (error) {
        await rm(tempPath, { force: true }).catch(() => {});
        if (previousHtml === null) await rm(htmlPath, { force: true }).catch(() => {});
        else await writeFile(htmlPath, previousHtml, 'utf8').catch(() => {});
        throw error;
      }
      return {
        ok: true,
        project,
        htmlPath,
        previousRevision: expectedRevision,
        revision: expectedRevision + 1,
      };
    });
  }

  private async withRevisionWriteQueue<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.revisionWriteQueues.get(projectId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(fn);
    this.revisionWriteQueues.set(projectId, current);
    try {
      return await current;
    } finally {
      if (this.revisionWriteQueues.get(projectId) === current) {
        this.revisionWriteQueues.delete(projectId);
      }
    }
  }

  async readFrameHtml(projectId: string, nodeId: string): Promise<string | null> {
    const project = await this.store.load(projectId);
    const frame = (project.frames ?? []).find((f) => f.graphNodeId === nodeId);
    if (!frame || !existsSync(frame.htmlPath)) return null;
    return readFile(frame.htmlPath, 'utf8');
  }

  async writeFrameHtml(
    projectId: string,
    nodeId: string,
    html: string,
    frame: FrameRecord,
  ): Promise<{ project: Project; frame: FrameRecord }> {
    const project = await this.store.load(projectId);
    const projectDir = await this.store.ensureDir(projectId);
    const framesDir = join(projectDir, 'frames');
    await mkdir(framesDir, { recursive: true });

    const order = frame.order;
    const safeId = nodeId.replace(/[^a-z0-9_-]/gi, '_');
    const filename = `${String(order + 1).padStart(2, '0')}-${safeId}.html`;
    const htmlPath = join(framesDir, filename);
    await writeFile(htmlPath, html, 'utf8');

    const nextFrame: FrameRecord = {
      ...frame,
      graphNodeId: nodeId,
      htmlPath,
      durationSec: frame.durationSec ?? DEFAULT_FRAME_DURATION_SEC,
      order,
    };
    project.frames = (project.frames ?? []).filter((f) => f.graphNodeId !== nodeId);
    project.frames.push(nextFrame);
    project.frames.sort((a, b) => a.order - b.order);
    if (project.frames[0]?.graphNodeId === nodeId) {
      project.lastPreviewHtmlPath = htmlPath;
    }
    if (project.status === 'draft') project.status = 'previewed';
    await this.store.save(project);
    return { project, frame: nextFrame };
  }

  async readContentGraph(projectId: string): Promise<ContentGraph | null> {
    const project = await this.store.load(projectId);
    if (!project.contentGraphPath || !existsSync(project.contentGraphPath)) return null;
    return JSON.parse(await readFile(project.contentGraphPath, 'utf8')) as ContentGraph;
  }

  async writeContentGraph(
    projectId: string,
    graph: ContentGraph,
    opts: { preserveFrames?: boolean } = {},
  ): Promise<{ project: Project; graphPath: string }> {
    const project = await this.store.load(projectId);
    const projectDir = await this.store.ensureDir(projectId);
    const graphPath = join(projectDir, 'content-graph.json');
    await writeFile(graphPath, JSON.stringify(graph, null, 2), 'utf8');
    project.contentGraphPath = graphPath;
    await mkdir(join(projectDir, 'frames'), { recursive: true });

    if (opts.preserveFrames) {
      const byId = new Map(graph.nodes.map((node) => [node.id, node.durationSec]));
      project.frames = (project.frames ?? []).map((frame) => ({
        ...frame,
        durationSec: byId.get(frame.graphNodeId) ?? frame.durationSec,
      }));
    } else {
      project.frames = [];
      if (project.status !== 'rendered') project.status = 'draft';
    }

    await this.store.save(project);
    return { project, graphPath };
  }
}

function projectAlbumRevision(project: Project): number {
  return Number.isSafeInteger(project.albumRevision) && Number(project.albumRevision) >= 0
    ? Number(project.albumRevision)
    : 0;
}
