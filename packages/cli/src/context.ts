/**
 * Bootstrap shared CLI context: project root, registries, stores, orchestrator.
 */

import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AssetStore,
  EngineRegistry,
  HtmlVideoError,
  PostgresProjectPersistence,
  ProjectOrchestrator,
  RequestContextStorage,
  TemplateRegistry,
} from '@html-video/core';
import type { ProjectPersistence } from '@html-video/core';
import hfAdapter from '@html-video/adapter-hyperframes';
import remotionAdapter, { remotionInstalled } from '@html-video/adapter-remotion';
import { MediaConfigStore } from './media-config.js';
import {
  createPgClient,
  loadDatabaseConfig,
  type DatabaseConfig,
  type PgClientHandle,
} from './database-config.js';
import { createHtmlOssPublisher } from './html-oss-publisher.js';

export interface CliContext {
  projectRoot: string;
  engines: EngineRegistry;
  templates: TemplateRegistry;
  projects: ProjectPersistence;
  assets: AssetStore;
  orchestrator: ProjectOrchestrator;
  templatesDir: string;
  mediaConfig: MediaConfigStore;
  requestContexts: RequestContextStorage;
  database?: {
    config: DatabaseConfig;
    handle: PgClientHandle;
    mode: 'postgres';
  };
}

export function findProjectRoot(start: string = process.cwd()): string {
  let dir = start;
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, '.html-video'))) return dir;
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    if (existsSync(join(dir, 'package.json')) && existsSync(join(dir, 'templates'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return start;
}

function findTemplatesDir(projectRoot: string): string {
  const candidates = [
    join(projectRoot, 'templates'),
    // packages/cli/dist/context.js → up 3 levels → monorepo root → templates/
    join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'templates'),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return candidates[0]!;
}

export async function bootstrap(opts: {
  cwd?: string;
  /** Explicit dependency injection for isolated tests; never selected by runtime configuration. */
  projects?: ProjectPersistence;
} = {}): Promise<CliContext> {
  const projectRoot = findProjectRoot(opts.cwd);

  const engines = new EngineRegistry();
  engines.register(hfAdapter);
  // Register Remotion only when its peer deps are actually installed, so the
  // registry never lists an engine that would throw on render. (RFC-08)
  if (remotionInstalled()) {
    engines.register(remotionAdapter);
  }

  const templates = new TemplateRegistry();
  const templatesDir = findTemplatesDir(projectRoot);
  await templates.scan(templatesDir);

  const requestContexts = new RequestContextStorage();
  let projects = opts.projects;
  let database: CliContext['database'];
  if (!projects) {
    const databaseConfig = loadDatabaseConfig(projectRoot);
    if (!databaseConfig) {
      throw new HtmlVideoError(
        'invalid-input',
        'PostgreSQL configuration is required. Configure [database] in config/config.toml and config/config.local.toml.',
        false,
        { requirement: 'database-config' },
      );
    }
    const databaseHandle = createPgClient(databaseConfig);
    projects = new PostgresProjectPersistence({
      db: databaseHandle.db,
      projectRoot,
      getUserContext: () => requestContexts.getRequiredUser(),
      publishHtml: createHtmlOssPublisher(projectRoot),
    });
    database = { config: databaseConfig, handle: databaseHandle, mode: 'postgres' };
  }
  const assets = new AssetStore({
    projectRoot,
    resolveProjectDir: (projectId) => projects.ensureDir(projectId),
  });

  const orchestrator = new ProjectOrchestrator({
    projectRoot,
    engines,
    templates,
    projects,
    assets,
  });

  const mediaConfig = new MediaConfigStore(projectRoot);

  return {
    projectRoot,
    engines,
    templates,
    projects,
    assets,
    orchestrator,
    templatesDir,
    mediaConfig,
    requestContexts,
    ...(database && { database }),
  };
}
