import { DEFAULT_FRAME_DURATION_SEC, type ContentGraph } from '@html-video/content-graph';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FrameRecord, Project } from '../types/index.js';
import type { ProjectStore } from '../registry.js';
import type { ProjectPersistence } from './project-persistence.js';

/**
 * File-backed ProjectPersistence adapter.
 *
 * This intentionally delegates every operation to the existing ProjectStore so
 * stage 1 changes the dependency shape without changing persistence behavior.
 */
export class FileProjectPersistence implements ProjectPersistence {
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
