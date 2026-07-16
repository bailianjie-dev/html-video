import type { ContentGraph } from '@html-video/content-graph';
import type { FrameRecord, Project } from '../types/index.js';

export interface HtmlPublication {
  bucket: string;
  key: string;
  url: string;
  checksumSha256: string;
}

export interface HtmlPublishInput {
  userId: string;
  projectId: string;
  nodeId: string;
  html: string;
}

export type HtmlPublisher = (input: HtmlPublishInput) => Promise<HtmlPublication>;

export type RevisionedRawHtmlWriteResult =
  | {
      ok: true;
      project: Project;
      htmlPath: string;
      htmlUrl?: string;
      previousRevision: number;
      revision: number;
    }
  | {
      ok: false;
      currentRevision: number;
    };

/**
 * Persistence boundary for project metadata and project-local working files.
 *
 * Stage 1 keeps the existing JSON-on-disk behavior behind this interface. A
 * PostgreSQL implementation can later preserve the same orchestrator contract
 * while moving structured data into ai_album_* tables.
 */
export interface ProjectPersistence {
  ensureDir(id: string): Promise<string>;
  save(project: Project): Promise<void>;
  load(id: string): Promise<Project>;
  list(): Promise<Project[]>;
  remove(id: string): Promise<void>;

  readRawHtml?(projectId: string): Promise<string | null>;
  writeRawHtml?(projectId: string, html: string): Promise<{
    project: Project;
    htmlPath: string;
    htmlUrl?: string;
  }>;
  writeRawHtmlIfRevision?(
    projectId: string,
    html: string,
    expectedRevision: number,
  ): Promise<RevisionedRawHtmlWriteResult>;

  readFrameHtml?(projectId: string, nodeId: string): Promise<string | null>;
  writeFrameHtml?(
    projectId: string,
    nodeId: string,
    html: string,
    frame: FrameRecord,
  ): Promise<{ project: Project; frame: FrameRecord; htmlUrl?: string }>;

  readContentGraph?(projectId: string): Promise<ContentGraph | null>;
  writeContentGraph?(
    projectId: string,
    graph: ContentGraph,
    opts?: { preserveFrames?: boolean },
  ): Promise<{ project: Project; graphPath: string }>;
}
