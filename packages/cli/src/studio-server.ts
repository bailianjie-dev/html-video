/**
 * HTTP server for the project studio (RFC-05 §UI).
 * Serves @html-video/project-studio static UI + project / template REST APIs.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, copyFile, mkdir } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, relative, resolve, basename, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import type { CliContext } from './context.js';
import {
  AlbumPageRepository,
  AlbumRepository,
  AssetRepository,
  AssetStore,
  ChatMessageRepository,
  ChatSessionRepository,
  generateTts,
  generateMusic,
  PostgresAssetPersistence,
  PostgresChatPersistence,
  PostgresProjectPersistence,
  safeWorkDirectorySegment,
  type Asset,
  type AssetRow,
  type ChatMessageRow,
  type DbAssetType,
  type ExportJobRow,
  type JsonObject,
  type Project,
} from '@html-video/core';
import type { ContentGraph } from '@html-video/content-graph';
import { extractUrls, fetchSource } from './fetch-source.js';
import { detectAll, findAgent, spawnAgent } from '@html-video/runtime';
import { createPgClient, loadDatabaseConfig, maskedDatabaseConfig } from './database-config.js';
import {
  downloadFromAliyunOss,
  loadOssConfig,
  maskedOssConfig,
  uploadFileToAliyunOss,
  uploadToAliyunOss,
} from './oss-config.js';
import {
  createDevAuthToken,
  findAuthUser,
  loadAuthConfig,
  verifyDevAuthToken,
  verifyDevCredentials,
  type AuthConfig,
} from './auth-config.js';
import {
  AiGenerationLogger,
  aiProviderModel,
  type AiGenerationLogHandle,
} from './ai-generation-logger.js';
import {
  ExportJobTracker,
  type ExportArtifactLocation,
  type ExportJobHandle,
} from './export-job-tracker.js';
import { createHtmlOssPublisher } from './html-oss-publisher.js';

interface StudioHandle {
  url: string;
  host: string;
  port: number;
  close: () => void;
}

const REQUIRED_AGENT_ID = 'pi-agent';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.txt': 'text/plain; charset=utf-8',
};

function resolveUiRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, '..', '..', 'project-studio', 'public'),
    resolve(here, '..', 'public'),
    resolve(here, '..', '..', 'storyboard-ui', 'public'),
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  return candidates[0]!;
}

export function isStudioAppRoute(pathname: string): boolean {
  return pathname === '/album-history'
    || pathname === '/image-album'
    || pathname === '/style-templates'
    || /^\/album-studio\/[^/]+\/?$/.test(pathname);
}

export async function startStudioServer(
  ctx: CliContext,
  port: number,
  host = '127.0.0.1',
): Promise<StudioHandle> {
  const uiRoot = resolveUiRoot();

  const handleRequest = async (req: IncomingMessage, res: ServerResponse): Promise<unknown> => {
    try {
      if (!req.url) {
        res.writeHead(400);
        res.end();
        return;
      }
      const url = new URL(req.url, 'http://x');
      const m = req.method ?? 'GET';

      // ============== API ==============

      if (url.pathname === '/api/auth/me' && m === 'GET') {
        return json(res, 200, {
          user: getRequestUser(req, loadAuthConfig(ctx.projectRoot)),
        });
      }

      if (url.pathname === '/api/auth/dev-login' && m === 'POST') {
        const body = await readBody(req).catch(() => ({} as Record<string, unknown>));
        const authConfig = loadAuthConfig(ctx.projectRoot);
        if (!authConfig) {
          return json(res, 503, {
            error: 'Temporary login is not configured. Create .html-video/auth.toml from config/auth.example.toml.',
          });
        }
        const username = typeof body.username === 'string'
          ? body.username
          : typeof body.user_id === 'string'
            ? body.user_id
            : '';
        const password = typeof body.password === 'string' ? body.password : '';
        if (!verifyDevCredentials(authConfig, username, password)) {
          return json(res, 401, { error: 'Invalid username or password' });
        }
        const account = findAuthUser(authConfig, username);
        if (!account) {
          return json(res, 401, { error: 'Invalid username or password' });
        }
        return json(res, 200, {
          user: {
            user_id: account.userId,
            actor_id: account.userId,
            display_name: account.displayName,
            source: 'dev-cookie',
            authenticated: true,
          },
        }, {
          'set-cookie': [
            makeCookie('hv_user_id', account.userId),
            makeCookie('hv_display_name', account.displayName),
            makeCookie('hv_auth', createDevAuthToken(authConfig, account.userId)),
          ],
        });
      }

      if (url.pathname === '/api/auth/logout' && m === 'POST') {
        return json(res, 200, {
          ok: true,
          user: {
            user_id: 'local-dev',
            actor_id: 'local-dev',
            display_name: 'Local Dev User',
            source: 'default',
            authenticated: false,
          },
        }, {
          'set-cookie': [
            clearCookie('hv_user_id'),
            clearCookie('hv_display_name'),
            clearCookie('hv_auth'),
          ],
        });
      }

      if (url.pathname === '/api/dev/persistence-test' && m === 'POST') {
        const cfg = loadDatabaseConfig(ctx.projectRoot);
        if (!cfg) {
          return json(res, 500, {
            ok: false,
            error: 'Database config not found or invalid. Create .html-video/database.toml with a [database] section.',
          });
        }
        if (!cfg.enabled) {
          return json(res, 200, {
            ok: true,
            mode: 'mock',
            config: maskedDatabaseConfig(cfg),
            note: 'database.enabled is false; PostgreSQL write/read was skipped.',
          });
        }

        const handle = ctx.database?.handle && ctx.database.config.sourcePath === cfg.sourcePath
          ? ctx.database.handle
          : createPgClient(cfg);
        const shouldClose = handle !== ctx.database?.handle;
        try {
          const user = ctx.requestContexts.getRequiredUser();
          const repo = new AlbumRepository(handle.db);
          const now = new Date().toISOString();
          const id = randomUUID();
          const sourceProjectId = `dev_persistence_${id.slice(0, 8)}`;
          const created = await repo.create({
            id,
            user_id: user.userId,
            source_project_id: sourceProjectId,
            title: `Persistence Test ${now}`,
            description: 'Created by POST /api/dev/persistence-test',
            status: 'draft',
            settings: { test_route: '/api/dev/persistence-test', created_at: now },
            created_by: user.actorId,
            updated_by: user.actorId,
          });
          const loaded = await repo.findById(user.userId, created.id);
          return json(res, 200, {
            ok: true,
            mode: 'postgres',
            config: maskedDatabaseConfig(cfg),
            created: {
              id: created.id,
              source_project_id: created.source_project_id,
              title: created.title,
              status: created.status,
              created_time: created.created_time,
            },
            loaded: loaded ? {
              id: loaded.id,
              source_project_id: loaded.source_project_id,
              title: loaded.title,
              status: loaded.status,
              created_time: loaded.created_time,
            } : null,
          });
        } catch (err) {
          return json(res, 500, {
            ok: false,
            mode: 'postgres',
            config: maskedDatabaseConfig(cfg),
            error: err instanceof Error ? err.message : String(err),
          });
        } finally {
          if (shouldClose) await handle.close().catch(() => {});
        }
      }

      if (url.pathname === '/api/dev/page-persistence-test' && m === 'POST') {
        const cfg = loadDatabaseConfig(ctx.projectRoot);
        if (!cfg) {
          return json(res, 500, {
            ok: false,
            error: 'Database config not found or invalid. Create .html-video/database.toml with a [database] section.',
          });
        }
        if (!cfg.enabled) {
          return json(res, 200, {
            ok: true,
            mode: 'mock',
            config: maskedDatabaseConfig(cfg),
            note: 'database.enabled is false; PostgreSQL write/read was skipped.',
          });
        }

        const handle = ctx.database?.handle && ctx.database.config.sourcePath === cfg.sourcePath
          ? ctx.database.handle
          : createPgClient(cfg);
        const shouldClose = handle !== ctx.database?.handle;
        try {
          const persistence = new PostgresProjectPersistence({
            db: handle.db,
            projectRoot: ctx.projectRoot,
            getUserContext: () => ctx.requestContexts.getRequiredUser(),
            publishHtml: createHtmlOssPublisher(ctx.projectRoot),
          });
          const user = ctx.requestContexts.getRequiredUser();
          const albums = new AlbumRepository(handle.db);
          const pages = new AlbumPageRepository(handle.db);
          const now = new Date().toISOString();
          const projectId = `dev_page_persistence_${randomUUID().slice(0, 8)}`;
          const project: Project = {
            id: projectId,
            name: `Page Persistence Test ${now}`,
            intent: 'Dev-only test for ai_album_album_pages persistence.',
            assets: [],
            templateId: null,
            variables: {},
            preferences: {
              resolution: { width: 1280, height: 720 },
              fps: 30,
              durationTargetSec: 6,
              format: 'mp4',
            },
            status: 'draft',
            frames: [],
            createdAt: now,
            updatedAt: now,
          };
          const graph: ContentGraph = {
            schemaVersion: 1,
            intent: 'other',
            synopsis: 'Dev test graph with two album pages.',
            nodes: [
              {
                id: 'intro',
                kind: 'text',
                label: 'Intro',
                frameIntent: 'intro',
                durationSec: 3,
                text: 'PostgreSQL page persistence intro',
              },
              {
                id: 'details',
                kind: 'text',
                label: 'Details',
                frameIntent: 'list',
                durationSec: 3,
                text: 'raw-html, content-graph, and frame raw-html are stored in ai_album_album_pages',
              },
            ],
            edges: [{ from: 'intro', to: 'details', kind: 'sequence' }],
          };
          const rawHtml = `<!doctype html><html><head><meta charset="utf-8"><title>${project.name}</title></head><body><main data-test="raw-html">Raw HTML persisted at ${now}</main></body></html>`;
          const introFrameHtml = `<!doctype html><html><head><meta charset="utf-8"><title>intro</title></head><body><section data-frame="intro">Intro frame persisted at ${now}</section></body></html>`;
          const detailsFrameHtml = `<!doctype html><html><head><meta charset="utf-8"><title>details</title></head><body><section data-frame="details">Details frame persisted at ${now}</section></body></html>`;

          await persistence.save(project);
          const rawWrite = await persistence.writeRawHtml(project.id, rawHtml);
          const graphWrite = await persistence.writeContentGraph(project.id, graph);
          const introWrite = await persistence.writeFrameHtml(project.id, 'intro', introFrameHtml, {
            graphNodeId: 'intro',
            htmlPath: '',
            durationSec: 3,
            order: 0,
          });
          const detailsWrite = await persistence.writeFrameHtml(project.id, 'details', detailsFrameHtml, {
            graphNodeId: 'details',
            htmlPath: '',
            durationSec: 3,
            order: 1,
          });

          const loadedProject = await persistence.load(project.id);
          const loadedRawHtml = await persistence.readRawHtml(project.id);
          const loadedGraph = await persistence.readContentGraph(project.id);
          const loadedIntroFrameHtml = await persistence.readFrameHtml(project.id, 'intro');
          const loadedDetailsFrameHtml = await persistence.readFrameHtml(project.id, 'details');
          const album = await albums.findBySourceProjectId(user.userId, project.id);
          const pageRows = album ? await pages.listByAlbum(user.userId, album.id) : [];

          return json(res, 200, {
            ok: true,
            mode: 'postgres',
            config: maskedDatabaseConfig(cfg),
            project: {
              id: loadedProject.id,
              name: loadedProject.name,
              status: loadedProject.status,
              content_graph_path: loadedProject.contentGraphPath ?? null,
              frames: (loadedProject.frames ?? []).map((frame) => ({
                graph_node_id: frame.graphNodeId,
                order: frame.order,
                duration_sec: frame.durationSec,
                html_path: frame.htmlPath,
              })),
            },
            writes: {
              raw_html_path: rawWrite.htmlPath,
              raw_html_url: rawWrite.htmlUrl ?? null,
              content_graph_path: graphWrite.graphPath,
              intro_frame_path: introWrite.frame.htmlPath,
              intro_frame_url: introWrite.htmlUrl ?? null,
              details_frame_path: detailsWrite.frame.htmlPath,
              details_frame_url: detailsWrite.htmlUrl ?? null,
            },
            reads: {
              raw_html: loadedRawHtml,
              content_graph: loadedGraph,
              frame_html: {
                intro: loadedIntroFrameHtml,
                details: loadedDetailsFrameHtml,
              },
            },
            database: {
              album: album ? {
                id: album.id,
                source_project_id: album.source_project_id,
                title: album.title,
                status: album.status,
                page_count: album.page_count,
              } : null,
              pages: pageRows.map((page) => ({
                id: page.id,
                node_id: page.node_id,
                page_no: page.page_no,
                title: page.title,
                status: page.status,
                duration_ms: page.duration_ms,
                has_raw_html: Boolean(page.raw_html),
                has_html_oss: Boolean(page.html_oss_bucket && page.html_oss_key),
                html_url: page.html_url,
                content_keys: Object.keys(page.content),
              })),
            },
          });
        } catch (err) {
          return json(res, 500, {
            ok: false,
            mode: 'postgres',
            config: maskedDatabaseConfig(cfg),
            error: err instanceof Error ? err.message : String(err),
          });
        } finally {
          if (shouldClose) await handle.close().catch(() => {});
        }
      }

      if (url.pathname === '/api/dev/oss-asset-test' && m === 'POST') {
        const dbCfg = loadDatabaseConfig(ctx.projectRoot);
        if (!dbCfg) {
          return json(res, 500, {
            ok: false,
            error: 'Database config not found or invalid. Create .html-video/database.toml with a [database] section.',
          });
        }
        if (!dbCfg.enabled) {
          return json(res, 200, {
            ok: true,
            mode: 'mock',
            database_config: maskedDatabaseConfig(dbCfg),
            note: 'database.enabled is false; OSS upload and asset DB write were skipped.',
          });
        }

        const ossCfg = loadOssConfig(ctx.projectRoot);
        if (!ossCfg) {
          return json(res, 500, {
            ok: false,
            error: 'OSS config not found or invalid. Create .html-video/oss.toml from .html-video/oss.example.toml.',
          });
        }
        if (!ossCfg.enabled) {
          return json(res, 200, {
            ok: true,
            mode: 'mock',
            database_config: maskedDatabaseConfig(dbCfg),
            oss_config: maskedOssConfig(ossCfg),
            note: 'oss.enabled is false; OSS upload and asset DB write were skipped.',
          });
        }

        const handle = ctx.database?.handle && ctx.database.config.sourcePath === dbCfg.sourcePath
          ? ctx.database.handle
          : createPgClient(dbCfg);
        const shouldClose = handle !== ctx.database?.handle;
        try {
          const user = ctx.requestContexts.getRequiredUser();
          const upload = await readDevOssTestUpload(req);
          const objectId = randomUUID();
          const ossKey = [
            ossCfg.prefix,
            'asset-persistence-test',
            objectId,
            safeOssFileName(upload.fileName),
          ].filter(Boolean).join('/');
          const uploaded = await uploadToAliyunOss(ossCfg, {
            key: ossKey,
            body: upload.body,
            contentType: upload.mimeType,
          });

          const repo = new AssetRepository(handle.db);
          const checksumSha256 = createHash('sha256').update(upload.body).digest('hex');
          const created = await repo.create({
            id: objectId,
            user_id: user.userId,
            asset_type: assetTypeFromMime(upload.mimeType),
            usage_type: 'source',
            source: 'upload',
            status: 'available',
            oss_bucket: uploaded.bucket,
            oss_key: uploaded.key,
            url: uploaded.url,
            file_name: upload.fileName,
            mime_type: upload.mimeType,
            file_ext: extname(upload.fileName) || null,
            file_size_bytes: upload.body.byteLength,
            checksum_sha256: checksumSha256,
            metadata: {
              test_route: '/api/dev/oss-asset-test',
              uploaded_at: new Date().toISOString(),
              oss_etag: uploaded.etag,
            },
            created_by: user.actorId,
            updated_by: user.actorId,
          });
          const loaded = await repo.findById(user.userId, created.id);

          return json(res, 200, {
            ok: true,
            mode: 'postgres',
            database_config: maskedDatabaseConfig(dbCfg),
            oss_config: maskedOssConfig(ossCfg),
            uploaded: {
              bucket: uploaded.bucket,
              key: uploaded.key,
              url: uploaded.url,
              etag: uploaded.etag,
            },
            created: summarizeAssetRow(created),
            loaded: loaded ? summarizeAssetRow(loaded) : null,
          });
        } catch (err) {
          return json(res, 500, {
            ok: false,
            mode: 'postgres',
            database_config: maskedDatabaseConfig(dbCfg),
            oss_config: maskedOssConfig(ossCfg),
            error: err instanceof Error ? err.message : String(err),
          });
        } finally {
          if (shouldClose) await handle.close().catch(() => {});
        }
      }

      const albumHealthMatch = url.pathname.match(/^\/api\/dev\/album-persistence-health\/([^/]+)$/);
      if (albumHealthMatch && albumHealthMatch[1] && m === 'GET') {
        const cfg = loadDatabaseConfig(ctx.projectRoot);
        if (!cfg) {
          return json(res, 500, {
            ok: false,
            error: 'Database config not found or invalid. Create .html-video/database.toml with a [database] section.',
          });
        }
        if (!cfg.enabled) {
          return json(res, 200, {
            ok: true,
            mode: 'mock',
            config: maskedDatabaseConfig(cfg),
            note: 'database.enabled is false; PostgreSQL health check was skipped.',
          });
        }

        const handle = ctx.database?.handle && ctx.database.config.sourcePath === cfg.sourcePath
          ? ctx.database.handle
          : createPgClient(cfg);
        const shouldClose = handle !== ctx.database?.handle;
        try {
          const user = ctx.requestContexts.getRequiredUser();
          const projectId = decodeURIComponent(albumHealthMatch[1]);
          const albums = new AlbumRepository(handle.db);
          const album = await findProjectAlbum(albums, projectId, user.userId);
          if (!album) {
            return json(res, 404, {
              ok: false,
              mode: 'postgres',
              config: maskedDatabaseConfig(cfg),
              error: `Album/project ${projectId} not found`,
            });
          }

          const pages = await new AlbumPageRepository(handle.db)
            .listByAlbum(user.userId, album.id, { includeDeleted: true });
          const assets = await new AssetRepository(handle.db)
            .listByAlbum(user.userId, album.id, { includeDeleted: true });
          const contentGraphInSettings = isRecordValue(album.settings.content_graph);
          const contentGraphInPages = pages.some((page) => isRecordValue(page.content.graph_node));
          const rawHtmlPages = pages.filter((page) => Boolean(page.raw_html));

          return json(res, 200, {
            ok: true,
            mode: 'postgres',
            config: maskedDatabaseConfig(cfg),
            album: {
              id: album.id,
              source_project_id: album.source_project_id,
              user_id: album.user_id,
              title: album.title,
              status: album.status,
              page_count: album.page_count,
              duration_ms: album.duration_ms,
              created_time: album.created_time,
              updated_time: album.updated_time,
            },
            pages: {
              count: pages.length,
              active_count: pages.filter((page) => page.status !== 'deleted').length,
              raw_html_count: rawHtmlPages.length,
              has_raw_html: rawHtmlPages.length > 0,
              has_content_graph: contentGraphInSettings || contentGraphInPages,
              content_graph_source: contentGraphInSettings
                ? 'album_settings'
                : contentGraphInPages
                  ? 'album_pages'
                  : null,
              items: pages.map((page) => ({
                id: page.id,
                node_id: page.node_id,
                page_no: page.page_no,
                title: page.title,
                status: page.status,
                has_raw_html: Boolean(page.raw_html),
                raw_html_bytes: page.raw_html ? Buffer.byteLength(page.raw_html, 'utf8') : 0,
                has_html_oss: Boolean(page.html_oss_bucket && page.html_oss_key),
                html_url: page.html_url,
                has_graph_node: isRecordValue(page.content.graph_node),
                content_keys: Object.keys(page.content),
                updated_time: page.updated_time,
              })),
            },
            assets: {
              count: assets.length,
              active_count: assets.filter((asset) => asset.status !== 'deleted').length,
              status_counts: countAssetsByStatus(assets),
              items: assets.map((asset) => ({
                id: asset.id,
                asset_type: asset.asset_type,
                usage_type: asset.usage_type,
                source: asset.source,
                status: asset.status,
                oss_bucket: asset.oss_bucket,
                oss_key: asset.oss_key,
                has_url: Boolean(asset.url),
                file_name: asset.file_name,
                mime_type: asset.mime_type,
                file_size_bytes: asset.file_size_bytes,
                updated_time: asset.updated_time,
              })),
            },
          });
        } catch (err) {
          return json(res, 500, {
            ok: false,
            mode: 'postgres',
            config: maskedDatabaseConfig(cfg),
            error: err instanceof Error ? err.message : String(err),
          });
        } finally {
          if (shouldClose) await handle.close().catch(() => {});
        }
      }

      // List projects
      if (url.pathname === '/api/projects' && m === 'GET') {
        const list = await ctx.orchestrator.list();
        return json(res, 200, { projects: list });
      }

      // Create project
      if (url.pathname === '/api/projects' && m === 'POST') {
        const body = await readBody(req);
        const project = await ctx.orchestrator.create({
          name: (body.name as string) ?? 'Untitled',
          ...(body.intent !== undefined && { intent: body.intent as string }),
          preferences: (body.preferences as Record<string, unknown>) ?? {},
        });
        return json(res, 200, { project });
      }

      const projectExportJobsMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/export-jobs$/);
      if (projectExportJobsMatch && projectExportJobsMatch[1] && m === 'GET') {
        if (ctx.database?.mode !== 'postgres' || !ctx.database.handle) {
          return json(res, 503, {
            error: 'PostgreSQL persistence is not enabled; export jobs are unavailable.',
          });
        }
        const projectId = decodeURIComponent(projectExportJobsMatch[1]);
        const limit = clampInteger(url.searchParams.get('limit'), 1, 100, 50);
        const offset = clampInteger(url.searchParams.get('offset'), 0, 100_000, 0);
        const tracker = ExportJobTracker.fromContext(ctx)!;
        const { album, jobs } = await tracker.listForProject(projectId, { limit, offset });
        return json(res, 200, {
          project_id: projectId,
          album_id: album.id,
          jobs: jobs.map(exportJobResponse),
          pagination: { limit, offset, count: jobs.length },
        });
      }

      const exportJobMatch = url.pathname.match(/^\/api\/export-jobs\/([^/]+)$/);
      if (exportJobMatch && exportJobMatch[1] && m === 'GET') {
        if (ctx.database?.mode !== 'postgres' || !ctx.database.handle) {
          return json(res, 503, {
            error: 'PostgreSQL persistence is not enabled; export jobs are unavailable.',
          });
        }
        const jobId = decodeURIComponent(exportJobMatch[1]);
        const job = await ExportJobTracker.fromContext(ctx)!.findForCurrentUser(jobId);
        if (!job) return json(res, 404, { error: `Export job ${jobId} not found` });
        return json(res, 200, { job: exportJobResponse(job) });
      }

      // Get / update / delete single project
      const projMatch = url.pathname.match(/^\/api\/projects\/([^/]+)$/);
      if (projMatch && projMatch[1]) {
        const id = projMatch[1];
        if (m === 'GET') {
          return json(res, 200, { project: await ctx.orchestrator.load(id) });
        }
        if (m === 'PATCH') {
          const body = await readBody(req);
          const project = await ctx.orchestrator.load(id);
          if (typeof body.name === 'string' && body.name.trim()) {
            project.name = body.name.trim().slice(0, 80);
          }
          if (typeof body.intent === 'string') {
            project.intent = body.intent.slice(0, 280);
          }
          if (body.preferences && typeof body.preferences === 'object' && !Array.isArray(body.preferences)) {
            project.preferences = {
              ...project.preferences,
              ...(body.preferences as Record<string, unknown>),
            };
          }
          await ctx.projects.save(project);
          return json(res, 200, { project: await ctx.orchestrator.load(id) });
        }
        if (m === 'DELETE') {
          await ctx.orchestrator.remove(id);
          MESSAGES.delete(id);
          return json(res, 200, { ok: true });
        }
      }

      // List engines + templates
      if (url.pathname === '/api/templates' && m === 'GET') {
        return json(res, 200, {
          templates: ctx.templates.list().map((t) => {
            // Decide how the gallery should preview this template:
            //  - 'iframe'  → the entry HTML is self-contained; render it live.
            //  - 'poster'  → the entry only references sub-compositions via
            //    data-composition-src and needs the Hyperframes player (not yet
            //    built, v0.9) to show anything, so a live iframe is blank.
            //    Fall back to the shipped poster image instead.
            const { mode, posterUrl } = templatePreviewMode(t);
            return {
              id: t.id,
              name: t.name,
              description: t.description,
              engine: t.engine,
              source_entry: t.source_entry,
              category: t.category,
              tags: t.tags,
              best_for: t.best_for,
              inputs_schema: t.inputs.schema,
              inputs_examples: t.inputs.examples,
              license: t.license,
              provenance: t.provenance,
              preview: t.preview,
              preview_mode: mode,
              poster_url: posterUrl,
              output: t.output,
            };
          }),
        });
      }

      // Add asset (multipart-style via JSON for v0.1: paths or inline content)
      const addAssetMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/assets$/);
      if (addAssetMatch && addAssetMatch[1] && m === 'GET') {
        const id = addAssetMatch[1];
        const project = await ctx.orchestrator.load(id);
        if (ctx.database?.mode !== 'postgres' || !ctx.database.handle) {
          return json(res, 200, { assets: project.assets });
        }
        const assets = await projectAssetPersistence(ctx).listForProject(id);
        return json(res, 200, { assets: assets.map(summarizeAssetRow) });
      }
      if (addAssetMatch && addAssetMatch[1] && m === 'POST') {
        const id = addAssetMatch[1];
        const ct = req.headers['content-type'] ?? '';
        let project;
        if (ct.startsWith('multipart/form-data')) {
          // Save uploaded file to /tmp then add
          const saved = await receiveMultipartFile(req, ct);
          if (shouldPersistUploadedAssetsToOss(ctx)) {
            project = await addFileAssetToOss(ctx, id, saved.filePath, saved.filename);
          } else {
            project = await ctx.orchestrator.addFileAsset(id, saved.filePath);
          }
        } else {
          const body = await readBody(req);
          if (body.kind === 'text') {
            project = await ctx.orchestrator.addInlineAsset(
              id,
              (body.content as string) ?? '',
              'text',
              body.caption as string | undefined,
            );
          } else if (body.kind === 'data') {
            project = await ctx.orchestrator.addInlineAsset(
              id,
              (body.content as string) ?? '',
              'data',
              body.caption as string | undefined,
            );
          } else if (body.kind === 'file' && body.path) {
            if (shouldPersistUploadedAssetsToOss(ctx)) {
              project = await addFileAssetToOss(ctx, id, body.path as string);
            } else {
              project = await ctx.orchestrator.addFileAsset(id, body.path as string);
            }
          } else {
            return json(res, 400, { error: 'Provide kind=text|data|file with content/path' });
          }
        }
        return json(res, 200, { project });
      }

      // Authenticated thumbnail/content proxy for project assets stored in OSS.
      // This lets private buckets still render previews while preserving the
      // request-scoped user/project checks from PostgresAssetPersistence.
      const assetContentMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/assets\/([^/]+)\/content$/);
      if (assetContentMatch && assetContentMatch[1] && assetContentMatch[2] && m === 'GET') {
        const projectId = assetContentMatch[1];
        const assetId = assetContentMatch[2];
        if (ctx.database?.mode !== 'postgres' || !ctx.database.handle) {
          const project = await ctx.orchestrator.load(projectId);
          const asset = project.assets.find((item) => item.id === assetId);
          if (!asset?.path) return json(res, 404, { error: 'Asset not found' });
          const safe = resolve(asset.path);
          const projectsRoot = resolve(ctx.projectRoot, '.html-video', 'projects');
          if (!isPathInside(projectsRoot, safe)) return json(res, 403, { error: 'Forbidden' });
          if (!existsSync(safe)) return json(res, 404, { error: 'Asset file not found' });
          return serveFile(safe, res);
        }
        const assets = await projectAssetPersistence(ctx).listForProject(projectId);
        const asset = assets.find((item) => item.id === assetId && item.status !== 'deleted');
        if (!asset?.oss_key) return json(res, 404, { error: 'Asset not found' });
        const ossConfig = loadOssConfig(ctx.projectRoot);
        if (!ossConfig?.enabled) return json(res, 404, { error: 'OSS is not configured' });
        try {
          const downloaded = await downloadFromAliyunOss(ossConfig, { key: asset.oss_key });
          res.writeHead(200, {
            'Content-Type': asset.mime_type || downloaded.contentType,
            'Content-Length': String(downloaded.contentLength),
            'Cache-Control': 'private, max-age=300',
          });
          return res.end(downloaded.body);
        } catch (error) {
          console.warn('[studio] asset content proxy failed:', error);
          return json(res, 502, { error: 'Asset content unavailable' });
        }
      }

      // Remove asset
      const rmAssetMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/assets\/([^/]+)$/);
      if (rmAssetMatch && rmAssetMatch[1] && rmAssetMatch[2] && m === 'DELETE') {
        const existing = await ctx.orchestrator.load(rmAssetMatch[1]);
        await softDeleteAssetInPostgres(
          ctx,
          rmAssetMatch[1],
          rmAssetMatch[2],
          existing.assets.some((asset) => asset.id === rmAssetMatch[2]),
        );
        const project = await ctx.orchestrator.removeAsset(rmAssetMatch[1], rmAssetMatch[2]);
        return json(res, 200, { project });
      }

      // Set template
      const tplMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/template$/);
      if (tplMatch && tplMatch[1] && m === 'PUT') {
        const body = await readBody(req);
        const project = await ctx.orchestrator.setTemplate(tplMatch[1], body.template_id as string);
        // Auto-seed preview with the template's own example.html so the user sees
        // something immediately (before any chat-driven rewrite).
        const tmpl = ctx.templates.get(body.template_id as string);
        const exampleHtmlPath = join(tmpl.__dir!, tmpl.source_entry);
        if (existsSync(exampleHtmlPath)) {
          const html = await readFile(exampleHtmlPath, 'utf8');
          await ctx.orchestrator.writePreviewHtmlRaw(project.id, html);
        }
        return json(res, 200, { project: await ctx.orchestrator.load(project.id) });
      }

      // Set agent (runtime selection)
      const agentMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/agent$/);
      if (agentMatch && agentMatch[1] && m === 'PUT') {
        const project = await ctx.orchestrator.setAgent(
          agentMatch[1],
          REQUIRED_AGENT_ID,
          null,
        );
        return json(res, 200, { project });
      }

      // Set variables (whole bag)
      const varsMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/variables$/);
      if (varsMatch && varsMatch[1] && m === 'PUT') {
        const body = await readBody(req);
        const project = await ctx.orchestrator.setVariables(
          varsMatch[1],
          (body.variables as Record<string, unknown>) ?? {},
        );
        return json(res, 200, { project });
      }

      // Render preview HTML (legacy; v0.3+ uses chat-driven path)
      const prevMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/preview$/);
      if (prevMatch && prevMatch[1] && m === 'POST') {
        const { project, htmlPath } = await ctx.orchestrator.renderPreviewHtml(prevMatch[1]);
        return json(res, 200, {
          project,
          preview_url: `/preview/${project.id}`,
          html_path: htmlPath,
        });
      }

      // Get raw preview HTML (frontend reads to parse data-hv-text nodes)
      const rawGetMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/raw-html$/);
      if (rawGetMatch && rawGetMatch[1] && m === 'GET') {
        const html = await ctx.orchestrator.readRawHtml(rawGetMatch[1]);
        if (!html) {
          return json(res, 404, { error: 'No preview HTML yet — pick a template or send a chat first' });
        }
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(html);
        return;
      }

      // Download the latest preview as a standalone HTML deliverable. This is
      // useful for interactive outputs such as electronic albums, where the
      // HTML itself is the thing to share rather than an MP4 recording.
      const htmlExportMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/export-html$/);
      if (htmlExportMatch && htmlExportMatch[1] && m === 'GET') {
        const project = await ctx.orchestrator.load(htmlExportMatch[1]);
        const html = await ctx.orchestrator.readRawHtml(htmlExportMatch[1]);
        if (!html) {
          return json(res, 404, { error: 'No preview HTML yet - pick a template or send a chat first' });
        }
        const safeName = sanitizeDownloadName(project.name || project.id || 'album');
        res.writeHead(200, {
          'content-type': MIME['.html']!,
          'content-disposition': contentDispositionForHtml(safeName),
          'cache-control': 'no-store, no-cache, must-revalidate',
          pragma: 'no-cache',
        });
        res.end(hardenAlbumHtml(html));
        return;
      }

      // Write raw preview HTML (frontend posts back the modified HTML
      // after the user edits a data-hv-text field in the middle column)
      if (rawGetMatch && rawGetMatch[1] && m === 'PUT') {
        const project = await ctx.orchestrator.load(rawGetMatch[1]);
        const ct = req.headers['content-type'] ?? '';
        let html: string;
        if (ct.includes('application/json')) {
          const body = await readBody(req);
          html = (body.html as string) ?? '';
        } else {
          html = await readBodyText(req);
        }
        if (!html || !/<\/html>/i.test(html)) {
          return json(res, 400, { error: 'Body must be a complete HTML document' });
        }
        await ctx.orchestrator.writePreviewHtmlRaw(project.id, hardenAlbumHtml(html));
        return json(res, 200, { project: await ctx.orchestrator.load(project.id) });
      }

      // Frame-specific raw HTML — keeps frames[] intact (writePreviewHtmlRaw
      // resets the storyboard, which is wrong for multi-frame edits).
      const frameRawMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/frames\/([^/]+)\/raw-html$/);
      if (frameRawMatch && frameRawMatch[1] && frameRawMatch[2]) {
        const projId = frameRawMatch[1];
        const nodeId = frameRawMatch[2];
        if (m === 'GET') {
          const html = await ctx.orchestrator.readFrameHtml(projId, nodeId);
          if (!html) {
            return json(res, 404, { error: `Frame ${nodeId} not found` });
          }
          res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
          res.end(html);
          return;
        }
        if (m === 'PUT') {
          const ct = req.headers['content-type'] ?? '';
          let html: string;
          if (ct.includes('application/json')) {
            const body = await readBody(req);
            html = (body.html as string) ?? '';
          } else {
            html = await readBodyText(req);
          }
          if (!html || !/<\/html>/i.test(html)) {
            return json(res, 400, { error: 'Body must be a complete HTML document' });
          }
          await ctx.orchestrator.writeFrameHtml(projId, nodeId, html);
          return json(res, 200, { ok: true });
        }
      }

      // Enhance a data frame with a native Remotion template (user-initiated
      // motion enhancement, RFC-08/09). Sets the frame's engine + renders a
      // short single-frame preview MP4 so the studio can play the native
      // animation before a full export. Streams SSE progress like export.
      const enhMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/frames\/([^/]+)\/enhance$/);
      if (enhMatch && enhMatch[1] && enhMatch[2] && m === 'POST') {
        const projectId = enhMatch[1];
        const nodeId = enhMatch[2];
        const body = await readBody(req).catch(() => ({} as Record<string, unknown>));
        const nativeTemplateId = (body.nativeTemplateId as string) || 'frame-data-rollup';
        const wantsStream = (req.headers.accept ?? '').includes('text/event-stream');
        if (!wantsStream) {
          try {
            await ctx.orchestrator.enhanceFrameNative(projectId, nodeId, nativeTemplateId);
            const { project } = await ctx.orchestrator.renderFrameNativePreview({ projectId, graphNodeId: nodeId });
            return json(res, 200, { ok: true, project, node_id: nodeId });
          } catch (err) {
            return json(res, 500, { error: err instanceof Error ? err.message : String(err) });
          }
        }
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        const sse = (obj: unknown) => {
          try { if (!res.writableEnded) res.write(`data: ${JSON.stringify(obj)}\n\n`); }
          catch { /* client gone — work keeps running, result is persisted */ }
        };
        const t0 = Date.now();
        try {
          sse({ type: 'enhance_started' });
          sse({ type: 'enhance_progress', pct: 5, stage: 'preparing' });
          await ctx.orchestrator.enhanceFrameNative(projectId, nodeId, nativeTemplateId);
          const { project } = await ctx.orchestrator.renderFrameNativePreview({
            projectId,
            graphNodeId: nodeId,
            onProgress: (pct, stage) => sse({ type: 'enhance_progress', pct, stage }),
          });
          const ms = Date.now() - t0;
          process.stderr.write(`[studio:enhance] proj=${projectId} frame=${nodeId} done in ${ms}ms\n`);
          sse({ type: 'enhance_done', project, node_id: nodeId, elapsed_ms: ms });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          process.stderr.write(`[studio:enhance] proj=${projectId} frame=${nodeId} failed: ${msg}\n`);
          sse({ type: 'enhance_failed', message: msg });
        }
        res.end();
        return;
      }

      // Revert a frame's native enhancement back to its base hyperframes HTML.
      // Instant (no render) — the original HTML at frame.htmlPath is untouched.
      const unenhMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/frames\/([^/]+)\/unenhance$/);
      if (unenhMatch && unenhMatch[1] && unenhMatch[2] && m === 'POST') {
        try {
          const { project } = await ctx.orchestrator.unenhanceFrame(unenhMatch[1], unenhMatch[2]);
          return json(res, 200, { ok: true, project, node_id: unenhMatch[2] });
        } catch (err) {
          return json(res, 500, { error: err instanceof Error ? err.message : String(err) });
        }
      }

      // Export MP4 — streams progress via SSE so the user sees per-frame
      // recording status during a multi-minute multi-frame export.
      const expMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/export$/);
      if (expMatch && expMatch[1] && m === 'POST') {
        const projectId = expMatch[1];
        // The studio uses the SSE branch by default. A plain POST (curl /
        // tests) gets the legacy blocking response.
        const wantsStream = (req.headers.accept ?? '').includes('text/event-stream');
        const exportTracker = ExportJobTracker.fromContext(ctx);
        let exportJob = null;
        try {
          const project = await ctx.orchestrator.load(projectId);
          exportJob = await exportTracker?.start(project, wantsStream) ?? null;
        } catch {
          // The existing export path reports project lookup/render errors.
        }
        if (!wantsStream) {
          let renderedOutputPath: string | undefined;
          try {
            const { project, outputPath } = await ctx.orchestrator.exportMp4({
              projectId,
              onProgress: (pct, stage) => exportTracker?.progress(exportJob, pct, stage),
            });
            renderedOutputPath = outputPath;
            exportTracker?.progress(exportJob, 99, 'uploading to OSS');
            const artifact = await uploadExportMp4ToOss(ctx, projectId, outputPath, exportJob);
            await exportTracker?.succeed(exportJob, outputPath, artifact ?? undefined);
            return json(res, 200, {
              project,
              output_path: outputPath,
              ...(artifact && { output_url: artifact.outputUrl }),
              ...(exportJob && { job_id: exportJob.id }),
            });
          } catch (err) {
            await exportTracker?.fail(exportJob, err, renderedOutputPath);
            const msg = err instanceof Error ? err.message : String(err);
            return json(res, 500, {
              error: msg,
              ...(exportJob && { job_id: exportJob.id }),
            });
          }
        }
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        const sse = (obj: unknown) => {
          try { if (!res.writableEnded) res.write(`data: ${JSON.stringify(obj)}\n\n`); }
          catch { /* client gone — generation keeps running, result is persisted */ }
        };
        const t0 = Date.now();
        let renderedOutputPath: string | undefined;
        try {
          sse({
            type: 'export_started',
            ...(exportJob && { job_id: exportJob.id }),
          });
          const { project, outputPath } = await ctx.orchestrator.exportMp4({
            projectId,
            onProgress: (pct, stage) => {
              exportTracker?.progress(exportJob, pct, stage);
              sse({ type: 'export_progress', pct, stage });
            },
          });
          renderedOutputPath = outputPath;
          exportTracker?.progress(exportJob, 99, 'uploading to OSS');
          sse({ type: 'export_progress', pct: 99, stage: 'uploading to OSS' });
          const artifact = await uploadExportMp4ToOss(ctx, projectId, outputPath, exportJob);
          await exportTracker?.succeed(exportJob, outputPath, artifact ?? undefined);
          const ms = Date.now() - t0;
          process.stderr.write(
            `[studio:export] proj=${projectId} done in ${ms}ms → ${outputPath}\n`,
          );
          sse({
            type: 'export_done',
            output_path: outputPath,
            ...(artifact && { output_url: artifact.outputUrl }),
            project,
            elapsed_ms: ms,
            ...(exportJob && { job_id: exportJob.id }),
          });
        } catch (err) {
          await exportTracker?.fail(exportJob, err, renderedOutputPath);
          const msg = err instanceof Error ? err.message : String(err);
          process.stderr.write(`[studio:export] proj=${projectId} failed: ${msg}\n`);
          sse({
            type: 'export_failed',
            message: msg,
            ...(exportJob && { job_id: exportJob.id }),
          });
        }
        res.end();
        return;
      }

      // Generate soundtrack: background music (MiniMax music_generation) and/or
      // narration (MiniMax t2a_v2). Streams SSE progress like export. The
      // generated MP3s are stored as project assets; their ids land in
      // project.soundtrack so exportMp4 mixes them in. Generation itself does
      // NOT need ffmpeg — only the export-time mux does.
      const genAudioMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/generate-audio$/);
      if (genAudioMatch && genAudioMatch[1] && m === 'POST') {
        const projectId = genAudioMatch[1];
        const body = (await readBody(req)) as {
          music?: { prompt?: string; instrumental?: boolean; volumeDb?: number };
          narration?: { text?: string; voiceId?: string; volumeDb?: number; languageBoost?: string; byFrame?: Record<string, string> };
          fadeInSec?: number;
          fadeOutSec?: number;
        };
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        const sse = (obj: unknown) => {
          try { if (!res.writableEnded) res.write(`data: ${JSON.stringify(obj)}\n\n`); }
          catch { /* client gone — generation keeps running, result is persisted */ }
        };
        try {
          sse({ type: 'audio_started' });
          const creds = ctx.mediaConfig.resolveMinimax();
          if (!creds) {
            sse({
              type: 'audio_failed',
              message:
                'MiniMax API key not configured — add it in Settings → Audio (or set OD_MINIMAX_API_KEY).',
            });
            res.end();
            return;
          }

          const project = await ctx.orchestrator.load(projectId);
          const soundtrack = { ...(project.soundtrack ?? {}) };
          const wantMusic = !!body.music?.prompt?.trim();
          const wantNarration = !!body.narration?.text?.trim();
          const aiLogger = AiGenerationLogger.fromContext(ctx);
          const operationId = randomUUID();
          if (!wantMusic && !wantNarration) {
            sse({ type: 'audio_failed', message: 'Nothing to generate — provide a music prompt and/or narration text.' });
            res.end();
            return;
          }

          if (wantMusic) {
            sse({ type: 'audio_progress', stage: 'music', message: 'generating background music…' });
            const prompt = body.music!.prompt!.trim();
            const musicLog = await aiLogger?.start({
              projectId,
              generationType: 'music',
              provider: 'minimax',
              model: 'music-1.5',
              prompt,
              operationId,
              attempt: 1,
              requestPayload: {
                operation: 'generate_background_music',
                instrumental: body.music!.instrumental ?? true,
              },
            }) ?? null;
            try {
              const music = await generateMusic({
                prompt,
                instrumental: body.music!.instrumental ?? true,
                creds,
              });
              const { asset } = await ctx.orchestrator.addBufferAsset(
                projectId,
                music.bytes,
                music.ext,
                `background music · ${prompt.slice(0, 60)}`,
              );
              soundtrack.musicAssetId = asset.id;
              soundtrack.musicPrompt = prompt;
              if (body.music!.volumeDb !== undefined) soundtrack.musicVolumeDb = body.music!.volumeDb;
              await aiLogger?.succeed(musicLog, {
                responsePayload: {
                  project_asset_id: asset.id,
                  file_size_bytes: music.bytes.length,
                  file_ext: music.ext,
                  provider_note: music.providerNote,
                },
              });
              sse({ type: 'audio_progress', stage: 'music', message: music.providerNote, asset_id: asset.id });
            } catch (error) {
              await aiLogger?.fail(musicLog, error);
              throw error;
            }
          }

          if (wantNarration) {
            sse({ type: 'audio_progress', stage: 'narration', message: 'generating narration…' });
            const text = body.narration!.text!.trim();
            const narrationLog = await aiLogger?.start({
              projectId,
              generationType: 'audio',
              provider: 'minimax',
              model: 'speech-02-turbo',
              prompt: text,
              operationId,
              attempt: 1,
              requestPayload: {
                operation: 'generate_narration_audio',
                voice_id: body.narration!.voiceId ?? null,
                language_boost: body.narration!.languageBoost ?? null,
                frame_count: body.narration!.byFrame
                  ? Object.keys(body.narration!.byFrame).length
                  : null,
              },
            }) ?? null;
            try {
              const nar = await generateTts({
                text,
                ...(body.narration!.voiceId !== undefined && { voiceId: body.narration!.voiceId }),
                ...(body.narration!.languageBoost !== undefined && { languageBoost: body.narration!.languageBoost }),
                creds,
              });
              const { asset } = await ctx.orchestrator.addBufferAsset(
                projectId,
                nar.bytes,
                nar.ext,
                `narration · ${text.slice(0, 60)}`,
              );
              soundtrack.narrationAssetId = asset.id;
              soundtrack.narrationText = text;
              if (body.narration!.byFrame) soundtrack.narrationByFrame = body.narration!.byFrame;
              if (body.narration!.volumeDb !== undefined) soundtrack.narrationVolumeDb = body.narration!.volumeDb;
              await aiLogger?.succeed(narrationLog, {
                responsePayload: {
                  project_asset_id: asset.id,
                  file_size_bytes: nar.bytes.length,
                  file_ext: nar.ext,
                  duration_sec: nar.durationSec ?? null,
                  provider_note: nar.providerNote,
                },
              });
              sse({ type: 'audio_progress', stage: 'narration', message: nar.providerNote, asset_id: asset.id });
            } catch (error) {
              await aiLogger?.fail(narrationLog, error);
              throw error;
            }
          }

          if (body.fadeInSec !== undefined) soundtrack.fadeInSec = body.fadeInSec;
          if (body.fadeOutSec !== undefined) soundtrack.fadeOutSec = body.fadeOutSec;

          // Persist soundtrack onto the project (reload to avoid clobbering the
          // asset pushes addBufferAsset already saved).
          const fresh = await ctx.orchestrator.load(projectId);
          fresh.soundtrack = soundtrack;
          await ctx.projects.save(fresh);
          sse({ type: 'audio_done', project: fresh, soundtrack });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          process.stderr.write(`[studio:generate-audio] proj=${projectId} failed: ${msg}\n`);
          sse({ type: 'audio_failed', message: msg });
        }
        res.end();
        return;
      }

      // Draft a narration script from the project's already-generated frames.
      // Reads the content-graph (per-frame text) and asks the agent for a short
      // spoken voiceover IN THE SAME LANGUAGE as that text. Returns plain JSON
      // { narration } — the user edits it before generating audio.
      const draftNarrMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/draft-narration$/);
      if (draftNarrMatch && draftNarrMatch[1] && m === 'POST') {
        const projectId = draftNarrMatch[1];
        try {
          // body.frameId set → draft ONLY that frame (single-frame regenerate).
          // unset → draft every frame (global). Either way returns a per-frame map.
          const body = (await readBody(req)) as { frameId?: string };
          const graph = await ctx.orchestrator.readContentGraph(projectId);
          if (!graph || !Array.isArray(graph.nodes) || graph.nodes.length === 0) {
            return json(res, 400, { error: 'No frames yet — generate the video first.' });
          }
          const agentDef = findAgent(REQUIRED_AGENT_ID);
          if (!agentDef) return json(res, 500, { error: 'Pi Agent is not registered' });
          const projectDir = await ctx.projects.ensureDir(projectId);
          // Only TextNode carries copy; fall back to label/id for entity/data.
          const nodeText = (n: typeof graph.nodes[number]): string =>
            (n.kind === 'text' ? n.text : undefined) ?? n.label ?? n.id;
          const allFrames = graph.nodes.map((n, i) => ({ id: n.id, idx: i, text: nodeText(n).replace(/\n/g, ' ').slice(0, 240) }));
          const frameLines = allFrames.map((f) => `${f.idx + 1}. ${f.text}`).join('\n');

          const narrationByFrame: Record<string, string> = {};
          const operationId = randomUUID();

          if (body.frameId) {
            // ---- single frame: narrate just this one, with the rest as context ----
            const target = allFrames.find((f) => f.id === body.frameId);
            if (!target) return json(res, 400, { error: `frame "${body.frameId}" not in content-graph` });
            const prompt = [
              `This is a ${allFrames.length}-frame video. Write the spoken NARRATION for FRAME ${target.idx + 1} ONLY.`,
              ``,
              `All frames (for context):`,
              frameLines,
              ``,
              graph.synopsis ? `Synopsis: ${graph.synopsis}` : '',
              ``,
              `Write ONE short spoken sentence narrating frame ${target.idx + 1} ("${target.text}") specifically — distinct, not generic.`,
              `Same language as the frame text. Plain text only: just the sentence, no numbering, quotes, or markdown.`,
            ].filter((l) => l !== undefined).join('\n');
            const raw = (await callAgentSimple(agentDef, prompt, projectDir, undefined, {
              ctx,
              projectId,
              generationType: 'narration',
              operationId,
              attempt: 1,
              pageNodeId: target.id,
              requestPayload: { operation: 'draft_narration', scope: 'frame' },
            })).trim();
            const line = raw.split('\n').map((l) => l.replace(/^\s*(?:\d+[.)、]|[-*•])\s*/, '').trim()).find((l) => l.length > 0) ?? raw;
            narrationByFrame[target.id] = line;
          } else {
            // ---- global: one line per frame, in order ----
            const prompt = [
              `Write a spoken NARRATION script for this ${allFrames.length}-frame video — ONE line per frame, IN FRAME ORDER.`,
              ``,
              `Frames (in order):`,
              frameLines,
              ``,
              graph.synopsis ? `Synopsis: ${graph.synopsis}` : '',
              ``,
              `Rules:`,
              `- Output EXACTLY ${allFrames.length} lines, one per frame, in the SAME order. Line 1 narrates frame 1, etc.`,
              `- Each line is ONE short spoken sentence about THAT specific frame's content — distinct per frame, not a generic restatement.`,
              `- The lines should still flow as a continuous voiceover read top to bottom.`,
              `- Same language as the frame text. Plain text only: one sentence per line, no numbering, bullets, blank lines, or markdown.`,
            ].filter((l) => l !== undefined).join('\n');
            const raw = (await callAgentSimple(agentDef, prompt, projectDir, undefined, {
              ctx,
              projectId,
              generationType: 'narration',
              operationId,
              attempt: 1,
              requestPayload: { operation: 'draft_narration', scope: 'album' },
            })).trim();
            const lines = raw.split('\n').map((l) => l.replace(/^\s*(?:\d+[.)、]|[-*•])\s*/, '').trim()).filter((l) => l.length > 0);
            // Map lines onto frames positionally; if the model under/over-produced,
            // pair as far as they line up and leave the rest blank.
            allFrames.forEach((f, i) => { if (lines[i]) narrationByFrame[f.id] = lines[i]!; });
          }
          return json(res, 200, { narrationByFrame });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          process.stderr.write(`[studio:draft-narration] proj=${projectId} failed: ${msg}\n`);
          return json(res, 500, { error: msg });
        }
      }

      // Clear a project's soundtrack (keeps the asset files, just drops the
      // references so the next export has no audio).
      const clearAudioMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/soundtrack$/);
      if (clearAudioMatch && clearAudioMatch[1] && m === 'DELETE') {
        const project = await ctx.orchestrator.load(clearAudioMatch[1]);
        delete project.soundtrack;
        await ctx.projects.save(project);
        return json(res, 200, { project });
      }

      // Reveal an exported file in the OS file browser. macOS: `open -R`
      // opens Finder with the file selected. Other platforms fall through
      // to a plain `open` which the OS handles best-effort.
      const revealMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/reveal$/);
      if (revealMatch && revealMatch[1] && m === 'POST') {
        const project = await ctx.orchestrator.load(revealMatch[1]);
        const target = project.lastOutputMp4Path;
        if (!target || !existsSync(target)) {
          return json(res, 404, { error: 'No exported MP4 to reveal' });
        }
        const { spawn } = await import('node:child_process');
        const platform = process.platform;
        const cmd = platform === 'darwin' ? 'open' : platform === 'win32' ? 'explorer' : 'xdg-open';
        const args = platform === 'darwin' ? ['-R', target] : [target];
        spawn(cmd, args, { stdio: 'ignore', detached: true }).unref();
        return json(res, 200, { ok: true, target, platform });
      }

      // MiniMax audio API config — GET status (masked), POST to save, DELETE to clear.
      // Lets users configure the key in the Settings UI instead of env vars.
      if (url.pathname === '/api/config/minimax' && m === 'GET') {
        return json(res, 200, ctx.mediaConfig.getMinimaxStatus());
      }
      if (url.pathname === '/api/config/minimax' && m === 'POST') {
        const body = (await readBody(req)) as { apiKey?: string; baseUrl?: string };
        const key = (body.apiKey ?? '').trim();
        if (!key) return json(res, 400, { error: 'apiKey is required' });
        ctx.mediaConfig.setMinimax(key, body.baseUrl);
        return json(res, 200, ctx.mediaConfig.getMinimaxStatus());
      }
      if (url.pathname === '/api/config/minimax' && m === 'DELETE') {
        ctx.mediaConfig.clearMinimax();
        return json(res, 200, ctx.mediaConfig.getMinimaxStatus());
      }

      // Agents (detected on each call; cheap thanks to the in-process cache)
      if (url.pathname === '/api/agents' && m === 'GET') {
        const force = url.searchParams.get('force') === '1';
        const agents = await detectAll(force ? { force: true } : undefined);
        return json(res, 200, {
          agents: agents.filter((agent) => agent.id === REQUIRED_AGENT_ID),
        });
      }

      // Model selection is intentionally disabled. Pi uses its global default.
      const modelsMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/models$/);
      if (modelsMatch && modelsMatch[1] && m === 'GET') {
        if (modelsMatch[1] !== REQUIRED_AGENT_ID) {
          return json(res, 404, { error: 'Agent not found' });
        }
        return json(res, 200, { models: [], default: null });
      }

      // Agent login — currently AMR/vela only. Spawns `vela login`, which opens
      // the browser for OAuth; we wait for the process to exit (auth complete or
      // cancelled). The user signs in with their OWN Open Design account.
      const loginMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/login$/);
      if (loginMatch && loginMatch[1] && m === 'POST') {
        return json(res, 404, { error: 'Agent login is not available' });
      }

      // Agent smoke test — fires a tiny prompt at the requested agent and
      // reports timing + bytes. Used by the Settings modal so the user can
      // confirm a CLI is actually responding (not just on PATH).
      const testMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/test$/);
      if (testMatch && testMatch[1] && m === 'POST') {
        const agentId = testMatch[1];
        if (agentId !== REQUIRED_AGENT_ID) {
          return json(res, 404, { error: 'Agent not found' });
        }
        const def = findAgent(agentId);
        if (!def) return json(res, 404, { error: `agent "${agentId}" not registered` });
        const prompt = 'Reply with one word: hello.';
        const t0 = Date.now();
        let out = '';
        let err = '';
        const handle = spawnAgent({
          def,
          prompt,
          context: { cwd: process.cwd() },
          onEvent: (ev) => {
            if (ev.type === 'text') out += ev.chunk;
            else if (ev.type === 'error') err = ev.message;
          },
        });
        const exit = await handle.done;
        return json(res, 200, {
          ok: exit.exitCode === 0 && out.trim().length > 0,
          exit_code: exit.exitCode,
          ms: Date.now() - t0,
          bytes: out.length,
          stdout_head: out.slice(0, 200),
          error: err || (out.trim().length === 0 ? 'empty reply' : undefined),
        });
      }

      // Messages: GET history (lazy-loads from messages.json on first hit)
      const msgsMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/messages$/);
      if (msgsMatch && msgsMatch[1] && m === 'GET') {
        const arr = await loadMessages(ctx, msgsMatch[1]);
        return json(res, 200, { messages: arr });
      }

      // Messages: POST = send + stream agent reply via SSE
      // v0.5: accepts multipart (text + files) OR JSON. In PostgreSQL + OSS
      // mode, files use the same durable asset pipeline as /assets; otherwise
      // they retain the local AssetStore compatibility behavior.
      if (msgsMatch && msgsMatch[1] && m === 'POST') {
        const id = msgsMatch[1];
        const ct = req.headers['content-type'] ?? '';
        let userText = '';
        let focusFrameId = '';
        const attachments: Attachment[] = [];

        const project0 = await ctx.orchestrator.load(id);
        if (ct.startsWith('multipart/form-data')) {
          const parts = await receiveMultipart(req, ct);
          for (const p of parts) {
            if (p.kind === 'field' && p.name === 'content') {
              userText = p.value;
            } else if (p.kind === 'field' && p.name === 'focus_frame_id') {
              focusFrameId = p.value;
            } else if (p.kind === 'file') {
              const updatedProject = shouldPersistUploadedAssetsToOss(ctx)
                ? await addFileAssetToOss(ctx, id, p.tmpPath, p.filename)
                : await ctx.orchestrator.addFileAsset(id, p.tmpPath);
              const newAsset = updatedProject.assets[updatedProject.assets.length - 1];
              if (newAsset) {
                const att: Attachment = {
                  path: newAsset.path ?? p.tmpPath,
                  kind: newAsset.type as Attachment['kind'],
                  filename: p.filename,
                  size: newAsset.metadata.sizeBytes ?? 0,
                };
                // Inline small text/data uploads so the agent (incl. HTTP ones)
                // actually sees the content, not just a local path.
                if (newAsset.type === 'text' || newAsset.type === 'data') {
                  try {
                    const txt = await readFile(p.tmpPath, 'utf8');
                    if (txt.length <= 20_000) att.inlineText = txt;
                  } catch { /* fall back to path-only */ }
                }
                attachments.push(att);
              }
            }
          }
        } else {
          const body = await readBody(req);
          userText = (body.content as string) ?? '';
          focusFrameId = (body.focus_frame_id as string) ?? '';
        }

        if (!userText && attachments.length === 0) {
          return json(res, 400, { error: 'content or attachments required' });
        }

        // External content sources: any URL (web article or GitHub repo) in the
        // user's message is fetched server-side and turned into a text asset, so
        // the offline agent can base the video on it. Reuses the attachment
        // pipeline (kind:'text' flows into the prompt downstream). Lossless
        // degradation: a fetch that fails is logged and skipped, never a 400.
        for (const sourceUrl of extractUrls(userText)) {
          try {
            const src = await fetchSource(sourceUrl);
            const label = src.kind === 'repo' ? 'GitHub repo' : 'Web article';
            const updated = await ctx.orchestrator.addInlineAsset(
              id,
              src.markdown,
              'text',
              `${label}: ${src.title || sourceUrl}`,
            );
            const asset = updated.assets[updated.assets.length - 1];
            if (asset?.path) {
              let host = sourceUrl;
              try { host = new URL(sourceUrl).hostname; } catch { /* keep raw */ }
              attachments.push({
                path: asset.path,
                kind: 'text',
                filename: `${host}.md`,
                size: src.markdown.length,
                inlineText: src.markdown,
              });
              process.stderr.write(
                `[studio:fetch-source] ${src.kind} ${sourceUrl} → ${src.markdown.length} chars${src.truncated ? ' (truncated)' : ''}\n`,
              );
            }
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            process.stderr.write(`[studio:fetch-source] skip ${sourceUrl}: ${msg}\n`);
          }
        }

        // Re-fetch project after potential addFileAsset side-effects
        const project = await ctx.orchestrator.load(id);
        const tmpl = project.templateId ? ctx.templates.get(project.templateId) : null;
        // No template required — agent can synthesize from scratch when none picked.

        const agentId = REQUIRED_AGENT_ID;
        if (project.agentId !== REQUIRED_AGENT_ID || project.agentModel !== null) {
          try {
            await ctx.orchestrator.setAgent(id, REQUIRED_AGENT_ID, null);
          } catch {
            /* persistence is best-effort; this request still uses Pi */
          }
        }
        const agentDef = findAgent(agentId);
        if (!agentDef) {
          return json(res, 400, { error: `agent "${agentId}" not registered` });
        }
        // Pi resolves the model from its global ~/.pi/agent/settings.json.
        const agentModel = undefined;

        // Append user message to history (with attachment summary)
        const attachmentSummary = attachments.length > 0
          ? `\n\n📎 ${attachments.length} attachment(s): ${attachments.map((a) => a.filename).join(', ')}`
          : '';
        const history = await loadMessages(ctx, id);
        const userMessage: ChatMessage = {
          role: 'user',
          content: userText + attachmentSummary,
          ts: Date.now(),
        };
        const selection = chatSelectionForMessage(history, userText, focusFrameId);
        // Persist immediately so the user message survives even if the
        // streaming agent call below crashes mid-flight.
        await appendMessage(ctx, id, history, userMessage, selection);

        // Compose prompt — template-aware OR template-free
        const projectDir = await ctx.projects.ensureDir(id);
        // Frame focus: when iterating, the user can pin a specific frame
        // so the next turn only rewrites that frame's HTML instead of the
        // whole-project preview.html.
        const focusFrame = focusFrameId
          ? (project.frames ?? []).find((f) => f.graphNodeId === focusFrameId)
          : undefined;
        const focusFrameHtml = focusFrame && existsSync(focusFrame.htmlPath)
          ? await readFile(focusFrame.htmlPath, 'utf8')
          : '';
        const priorHtmlPath = join(projectDir, 'preview.html');
        const priorHtml = focusFrameHtml
          || (existsSync(priorHtmlPath) ? await readFile(priorHtmlPath, 'utf8') : '');
        let exampleHtml = '';
        if (tmpl) {
          const exampleHtmlPath = join(tmpl.__dir!, tmpl.source_entry);
          if (existsSync(exampleHtmlPath)) {
            exampleHtml = await readFile(exampleHtmlPath, 'utf8');
          }
        }
        const hasGeneratedPreview =
          (project.frames ?? []).length > 0 ||
          !!(priorHtml && (!exampleHtml || priorHtml.trim() !== exampleHtml.trim()));

        // Carry source material across turns: a link/file is usually attached
        // on an early turn (e.g. while picking a content type), but generation
        // happens several turns later with no attachment on that request. Merge
        // the project's stored text/data assets (fetched articles/repos,
        // uploaded docs) into this turn's attachments so they reach the prompt.
        const seenPaths = new Set(attachments.map((a) => a.path));
        for (const asset of project.assets) {
          if ((asset.type === 'text' || asset.type === 'data') && asset.path && !seenPaths.has(asset.path)) {
            let inlineText: string | undefined;
            try {
              const txt = await readFile(asset.path, 'utf8');
              if (txt.length <= 20_000) inlineText = txt;
            } catch { /* path-only fallback */ }
            attachments.push({
              path: asset.path,
              kind: asset.type as Attachment['kind'],
              filename: asset.metadata.filename ?? `${asset.type}-${asset.id.slice(0, 8)}`,
              size: asset.metadata.sizeBytes ?? 0,
              ...(inlineText !== undefined && { inlineText }),
            });
            seenPaths.add(asset.path);
          }
        }

        const openingTopic = resolveOpeningTopic(project, history);
        const fullPrompt = buildHtmlGenerationPrompt({
          tmpl,
          exampleHtml,
          priorHtml,
          history,
          userText,
          attachments,
          focusFrameId: focusFrameId || undefined,
          hasGeneratedPreview,
          openingTopic,
        });
        const phaseInfo = detectPhase(
          history,
          userText,
          !!project.templateId,
          attachments.some((a) => !!a.inlineText),
          focusFrameId,
          hasGeneratedPreview,
        );
        if (phaseInfo.phase === 'generate' || phaseInfo.phase === 'iterate-format') {
          try {
            await persistResolutionFromInputs(ctx, id, phaseInfo.inputs);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            process.stderr.write(`[studio:msg] proj=${id} persist resolution failed: ${msg}\n`);
          }
        }
        const t0 = Date.now();
        const operationId = randomUUID();
        // Save the prompt next to the project so we can inspect what we sent.
        // Also dump the previous one as .prev for diffing across turns.
        const promptDumpPath = join(projectDir, 'last-prompt.txt');
        try {
          if (existsSync(promptDumpPath)) {
            const prev = await readFile(promptDumpPath, 'utf8');
            const fs = await import('node:fs/promises');
            await fs.writeFile(join(projectDir, 'last-prompt.prev.txt'), prev, 'utf8');
          }
          const fs = await import('node:fs/promises');
          await fs.writeFile(promptDumpPath, fullPrompt, 'utf8');
        } catch {/* non-fatal */}
        process.stderr.write(
          `[studio:msg] proj=${id} phase=${phaseInfo.phase} prompt=${fullPrompt.length}B user=${JSON.stringify(userText.slice(0, 80))} attachments=${attachments.length}\n`,
        );

        // Mark this project as generating so a returning client knows the task
        // is still alive. Cleared in the finally below (covers all exit paths).
        const generationKey = runtimeProjectKey(ctx, id);
        GENERATING.add(generationKey);
        try {

        // SSE response
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });

        // Tolerant write: if the client navigated away (switched project) the
        // socket is gone and res.write throws. Swallow it so generation keeps
        // running to completion and still persists to messages.json — the user
        // sees the finished result when they come back, instead of a killed task.
        const sseWrite = (obj: unknown) => {
          try { if (!res.writableEnded) res.write(`data: ${JSON.stringify(obj)}\n\n`); }
          catch { /* client disconnected — keep generating, result is persisted below */ }
        };
        sseWrite({
          type: 'progress',
          stage: 'phase_detected',
          message: `已识别生成阶段：${phaseInfo.phase}，正在准备上下文…`,
        });

        let assistantText = '';
        let textChunks = 0;
        let summaryLine = '';

        // ---- generate-phase: multi-frame path runs split (graph + per-frame) ----
        // Empirically claude --print returns 1 byte ~50% of the time when asked
        // to emit a graph and 4-6 full HTML pages in a single response. Each
        // call individually is reliable, so we orchestrate them ourselves and
        // stream progress events to the UI.
        const routePickedType = phaseInfo.inputs.pickedType ?? lastCardPickByPhase(history, 'type') ?? '';
        const isAlbumGenerate =
          isAlbumType(routePickedType) ||
          project.templateId === 'album-scroll-story' ||
          isAlbumType(openingTopic ?? '') ||
          looksLikeAlbumHtml(priorHtml);
        sseWrite({
          type: 'progress',
          stage: isAlbumGenerate ? 'album_context' : 'video_context',
          message: isAlbumGenerate
            ? '正在整理相册主题、页数、模板和素材…'
            : '正在整理视频分镜、样式和素材…',
        });
        const isMultiGenerate =
          phaseInfo.phase === 'generate' &&
          !isAlbumGenerate &&
          Number(phaseInfo.inputs.collected?.frame_count ?? '1') > 1;

        // Post-generation iteration: the card-driven sub-flow resolved to a
        // concrete change. Re-use the existing storyboard rather than guessing.
        //   restyle         → keep graph text, re-render every frame in the newly
        //                      picked style.
        //   iterate-content → re-plan the whole storyboard around new content.
        //   iterate-format  → re-time and re-render with the new per-frame length.
        const isMultiFrameProject =
          (project.frames ?? []).length > 1 ||
          Number(phaseInfo.inputs.collected?.frame_count ?? '1') > 1;
        let rewriteInputs: PhaseInputs | undefined;
        let restyleOnly = false;
        if (!isAlbumGenerate && phaseInfo.phase === 'restyle' && isMultiFrameProject) {
          // Keep text, change visual style. pickedStyle is the user's new pick.
          restyleOnly = true;
          rewriteInputs = {
            ...phaseInfo.inputs,
            pickedType: lastCardPickByPhase(history, 'type') ?? phaseInfo.inputs.pickedType,
            pickedStyle: phaseInfo.inputs.pickedStyle || userText.trim(),
            contentTurns: collectContentTurns(history),
          };
        } else if (!isAlbumGenerate && phaseInfo.phase === 'iterate-content' && isMultiFrameProject) {
          // Re-plan around the user's new content instruction.
          const turns = [...collectContentTurns(history), userText].filter((s) => !isControlPhrase(s));
          rewriteInputs = {
            ...phaseInfo.inputs,
            pickedType: lastCardPickByPhase(history, 'type') ?? phaseInfo.inputs.pickedType,
            pickedStyle: lastCardPickByPhase(history, 'style') ?? phaseInfo.inputs.pickedStyle ?? '',
            contentTurns: turns,
          };
        } else if (!isAlbumGenerate && phaseInfo.phase === 'iterate-format' && isMultiFrameProject) {
          // New per-frame timing was submitted; keep content + style, re-render.
          restyleOnly = true; // reuse the existing graph text; only timing/visual recompute
          rewriteInputs = {
            ...phaseInfo.inputs,
            pickedType: lastCardPickByPhase(history, 'type') ?? phaseInfo.inputs.pickedType,
            pickedStyle: lastCardPickByPhase(history, 'style') ?? phaseInfo.inputs.pickedStyle ?? '',
            contentTurns: collectContentTurns(history),
          };
        }

        if (isMultiGenerate || rewriteInputs) {
          if (rewriteInputs) {
            const n = (project.frames ?? []).length || Number(phaseInfo.inputs.collected?.frame_count ?? '3');
            const notice = restyleOnly
              ? `🎨 沿用文案，按新风格重做全部 ${n} 帧…\n`
              : `🔄 基于新内容重做全部 ${n} 帧（已手动修改过的帧会被覆盖）…\n`;
            assistantText += notice;
            sseWrite({ type: 'text', chunk: notice });
          }
          try {
            sseWrite({
              type: 'progress',
              stage: 'split_generating',
              message: '正在分步生成分镜与页面，完成后会自动刷新预览…',
            });
            const result = await runSplitMultiFrameGenerate({
              ctx,
              projectId: id,
              projectDir,
              agentDef,
              agentModel,
              tmpl,
              priorHtml,
              inputs: rewriteInputs ?? phaseInfo.inputs,
              attachments,
              openingTopic,
              restyleOnly,
              operationId,
              onProgress: (msg) => {
                assistantText += msg + '\n';
                textChunks += 1;
                sseWrite({ type: 'text', chunk: msg + '\n' });
              },
              onSse: sseWrite,
            });
            summaryLine = rewriteInputs
              ? `✓ ${result.frameCount}-frame storyboard ${restyleOnly ? 'restyled' : 'regenerated'} (intent: ${result.intent})`
              : `✓ ${result.frameCount}-frame storyboard generated (intent: ${result.intent})`;
            sseWrite({ type: 'preview_ready', preview_url: `/preview/${id}`, frames: result.frameCount });
            sseWrite({ type: 'message_end', reason: 'ok' });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            process.stderr.write(`[studio:msg] proj=${id} split-generate failed: ${msg}\n`);
            sseWrite({ type: 'text', chunk: `\n⚠️ Split generate failed: ${msg}` });
            sseWrite({ type: 'message_end', reason: 'error' });
            assistantText = `⚠️ Split generate failed: ${msg}`;
          }
          process.stderr.write(
            `[studio:msg] proj=${id} phase=split-generate done text=${assistantText.length}B\n`,
          );
        } else {
          // ---- single-shot path (all other phases + single-frame generate) ----
          const htmlPhases = new Set(['generate', 'iterate', 'restyle', 'iterate-content', 'iterate-format']);
          let successfulMainLog: AiGenerationLogHandle | null = null;
          let successfulMainOutput = '';
          sseWrite({
            type: 'progress',
            stage: 'model_generating',
            message: htmlPhases.has(phaseInfo.phase)
              ? '正在调用模型生成完整相册 HTML…'
              : '正在调用模型生成回复…',
          });
          const primaryText = await callAgentSimple(agentDef, fullPrompt, projectDir, agentModel, {
            ctx,
            projectId: id,
            generationType: htmlPhases.has(phaseInfo.phase) ? 'page_html' : 'page_copy',
            operationId,
            attempt: 1,
            ...(focusFrameId && { pageNodeId: focusFrameId }),
            requestPayload: {
              operation: 'studio_message',
              phase: phaseInfo.phase,
              attachment_count: attachments.length,
              focused_frame: focusFrameId || null,
            },
            ...(htmlPhases.has(phaseInfo.phase) && {
              validateOutput: (output: string) => (
                extractHtmlDocument(output) || extractContentGraphAndFrames(output)
                  ? null
                  : 'Agent response did not contain valid HTML'
              ),
              invalidOutputCode: 'invalid_html',
            }),
            onSucceeded: (handle, output) => {
              successfulMainLog = handle;
              successfulMainOutput = output;
            },
            onEvent: (ev) => {
              if (ev.type === 'text') {
                textChunks += 1;
                sseWrite(ev);
              } else if (ev.type === 'error' || ev.type === 'message_end') {
                if (ev.type === 'error') {
                  process.stderr.write(`[studio:msg] proj=${id} agent-error: ${ev.message}\n`);
                }
                sseWrite(ev);
              }
            },
          });
          assistantText += primaryText;
          const elapsedMs = Date.now() - t0;
          process.stderr.write(
            `[studio:msg] proj=${id} phase=${phaseInfo.phase} done in ${elapsedMs}ms text=${assistantText.length}B chunks=${textChunks}\n`,
          );

          // Empty-reply retry: if the agent returned almost nothing AND we
          // were on the iterate path with prior HTML, try a tighter prompt
          // that only ships the user's request + a tiny instruction. This
          // catches the 6-8KB-prompt empty-reply mode.
          if (assistantText.trim().length < 32 && phaseInfo.phase === 'iterate' && priorHtml) {
            sseWrite({ type: 'text', chunk: '\n↻ 第一次输出为空，重试中…\n' });
            // Retry without inlining the prior HTML — same observation as
            // the iterate prompt itself: claude --print silently no-ops
            // when fed multi-KB of HTML to rewrite.
            const sum = summariseHtmlForIterate(priorHtml);
            const retryPrompt = [
              `Output ONE complete \`\`\`html block — full self-contained 1920×1080 page. Nothing else.`,
              ``,
              `User request: ${userText.slice(0, 300)}`,
              sum.headline ? `Headline: ${sum.headline}` : '',
              sum.subheads.length ? `Subheads:\n${sum.subheads.slice(0, 4).map((s) => `  · ${s}`).join('\n')}` : '',
              sum.bgColors.length ? `Palette: ${sum.bgColors.join(' / ')}` : '',
              sum.fontFamilies.length ? `Fonts: ${sum.fontFamilies.join(', ')}` : '',
              ``,
              `Begin reply with \`\`\`html. Tag visible text with data-hv-text. No prose outside the block.`,
            ].filter(Boolean).join('\n');
            const retryText = await callAgentSimple(agentDef, retryPrompt, projectDir, agentModel, {
              ctx,
              projectId: id,
              generationType: 'page_html',
              operationId,
              attempt: 2,
              ...(focusFrameId && { pageNodeId: focusFrameId }),
              requestPayload: {
                operation: 'studio_message',
                phase: phaseInfo.phase,
                retry_reason: 'empty_response',
                focused_frame: focusFrameId || null,
              },
              validateOutput: (output) => (
                extractHtmlDocument(output) ? null : 'Agent retry did not contain valid HTML'
              ),
              invalidOutputCode: 'invalid_html',
              onSucceeded: (handle, output) => {
                successfulMainLog = handle;
                successfulMainOutput = output;
              },
              onEvent: (ev) => {
                if (ev.type === 'text') {
                  textChunks += 1;
                  sseWrite(ev);
                } else if (ev.type === 'error' || ev.type === 'message_end') {
                  sseWrite(ev);
                }
              },
            });
            assistantText += retryText;
            process.stderr.write(
              `[studio:msg] proj=${id} retry done text=${retryText.length}B\n`,
            );
          }

          // Single-frame iterate: result HTML goes back to the focused frame
          // only — never overwrites the whole preview.html.
          if (focusFrameId) {
            const extracted = extractHtmlDocument(assistantText);
            if (extracted) {
              try {
                await ctx.orchestrator.writeFrameHtml(id, focusFrameId, isAlbumGenerate ? hardenAlbumHtml(extracted) : extracted);
                sseWrite({ type: 'preview_ready', preview_url: `/preview/${id}`, focused_frame: focusFrameId });
                summaryLine = `✓ frame ${focusFrameId} updated`;
              } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                sseWrite({ type: 'text', chunk: `\n[frame ${focusFrameId} write failed: ${msg}]\n` });
              }
            }
          } else {
            // Multi-frame extraction on the off chance the agent did emit it
            // (e.g. on a free-text iterate turn the user's text triggered it).
            const multi = extractContentGraphAndFrames(assistantText);
            if (!isAlbumGenerate && multi && multi.frames.length > 0) {
              await ctx.orchestrator.writeContentGraph(id, multi.graph);
              for (const f of multi.frames) {
                try {
                  await ctx.orchestrator.writeFrameHtml(id, f.nodeId, f.html);
                } catch (err) {
                  const msg = err instanceof Error ? err.message : String(err);
                  sseWrite({ type: 'text', chunk: `\n[frame ${f.nodeId} skipped: ${msg}]\n` });
                }
              }
              sseWrite({ type: 'preview_ready', preview_url: `/preview/${id}`, frames: multi.frames.length });
              summaryLine = `✓ ${multi.frames.length}-frame storyboard generated (intent: ${multi.graph.intent})`;
            } else {
              let extracted = extractHtmlDocument(assistantText);
              if (isAlbumGenerate && !extracted && priorHtml) {
                sseWrite({ type: 'text', chunk: '\nRetrying as a strict album HTML rewrite...\n' });
                const sum = summariseHtmlForIterate(priorHtml);
                const retryParts = [
                  'The previous answer did not include a usable HTML document.',
                  'Rewrite the CURRENT electronic album now.',
                  '',
                  'Output exactly ONE fenced ```html block containing a complete <!doctype html> document. No prose outside the block.',
                  'Keep the album as an interactive scroll-snap electronic album with page dots/counter/controls and data-hv-text attributes.',
                  'Apply the user request literally. If they asked to add a page, add it. If they provided a CTA URL, wire the button/link to it. If they uploaded images, use their Browser URL in <img src="...">.',
                  'Keep visible text in the user language.',
                  '',
                  `User request: ${userText.slice(0, 1000)}`,
                  sum.headline ? `Current headline: ${sum.headline}` : '',
                  sum.subheads.length ? `Current visible text:\n${sum.subheads.slice(0, 12).map((s) => `- ${s}`).join('\n')}` : '',
                  sum.bgColors.length ? `Palette: ${sum.bgColors.join(' / ')}` : '',
                  sum.fontFamilies.length ? `Fonts: ${sum.fontFamilies.join(', ')}` : '',
                ].filter(Boolean);
                if (attachments.length > 0) {
                  retryParts.push('', 'Attachments:');
                  for (const a of attachments) retryParts.push(...renderAttachment(a));
                }
                const retryText = await callAgentSimple(agentDef, retryParts.join('\n'), projectDir, agentModel, {
                  ctx,
                  projectId: id,
                  generationType: 'page_html',
                  operationId,
                  attempt: 2,
                  requestPayload: {
                    operation: 'album_iteration_retry',
                    phase: phaseInfo.phase,
                    retry_reason: 'missing_html',
                    attachment_count: attachments.length,
                  },
                  validateOutput: (output) => (
                    extractHtmlDocument(output) ? null : 'Album retry did not contain a complete HTML document'
                  ),
                  invalidOutputCode: 'invalid_html',
                  onSucceeded: (handle, output) => {
                    successfulMainLog = handle;
                    successfulMainOutput = output;
                  },
                  onEvent: (ev) => {
                    if (ev.type === 'text') {
                      textChunks += 1;
                      sseWrite(ev);
                    } else if (ev.type === 'error' || ev.type === 'message_end') {
                      sseWrite(ev);
                    }
                  },
                });
                assistantText += retryText;
                extracted = extractHtmlDocument(assistantText);
                process.stderr.write(`[studio:msg] proj=${id} album retry done text=${retryText.length}B extracted=${!!extracted}\n`);
              }
              if (extracted) {
                sseWrite({ type: 'progress', stage: 'saving_preview', message: '模型已返回结果，正在保存预览…' });
                await ctx.orchestrator.writePreviewHtmlRaw(id, isAlbumGenerate ? hardenAlbumHtml(extracted) : extracted);
                if (isAlbumGenerate) {
                  const refreshed = await ctx.projects.load(id);
                  refreshed.frames = [];
                  delete refreshed.contentGraphPath;
                  await ctx.projects.save(refreshed);
                }
                sseWrite({ type: 'preview_ready', preview_url: `/preview/${id}` });
                summaryLine = '✓ updated the HTML preview';
              } else if (isAlbumGenerate) {
                const msg = 'AI did not return a usable album HTML document, so the preview was not changed.';
                sseWrite({ type: 'warning', message: msg });
                assistantText += `\n\n⚠️ ${msg}`;
              }
            }
          }
          const persistedPageNodeId = focusFrameId
            || (summaryLine === '✓ updated the HTML preview' ? 'preview' : '');
          if (successfulMainLog && persistedPageNodeId) {
            await AiGenerationLogger.fromContext(ctx)?.succeed(successfulMainLog, {
              output: successfulMainOutput,
              pageNodeId: persistedPageNodeId,
              responsePayload: { persisted: true },
            });
          }
        }

        // Auto-advance: the content prompt instructs the agent to append
        // <!-- hv-phase:content-question --> when it still needs more info.
        // Absence of that marker means it has enough — immediately run the
        // style phase in the same SSE stream so the user sees the style card
        // without having to send an extra "ok" message.
        if (phaseInfo.phase === 'content' && !/<!--\s*hv-phase:content-question\s*-->/i.test(assistantText)) {
          const autoPickedType = lastCardPickByPhase(history, 'type') ?? phaseInfo.inputs.pickedType ?? '';
          const stylePrompt = buildStylePhasePrompt(autoPickedType);
          const styleText = await callAgentSimple(agentDef, stylePrompt, projectDir, agentModel, {
            ctx,
            projectId: id,
            generationType: 'page_copy',
            operationId,
            attempt: 1,
            requestPayload: {
              operation: 'style_auto_advance',
              phase: 'style',
              picked_type: autoPickedType,
            },
            onEvent: (ev) => {
              if (ev.type === 'text') {
                textChunks += 1;
                sseWrite(ev);
              } else if (ev.type === 'error') {
                process.stderr.write(`[studio:msg] proj=${id} style-autoadvance error: ${ev.message}\n`);
              }
            },
          });
          assistantText += styleText;
        }

        // Persist assistant message — strip the html / graph blocks when present (UI sees summary line)
        let persistText = summaryLine
          ? assistantText
              .replace(/```html[#\w-]*[\s\S]*?```/gi, '')
              .replace(/```json#content-graph[\s\S]*?```/i, '')
              .replace(/```json[\s\S]*?```/i, (m) =>
                /content-graph|"intent"\s*:|"nodes"\s*:/i.test(m) ? '' : m,
              )
              .trim() || summaryLine
          : assistantText;

        // Empty agent reply (no HTML, no graph, no prose) usually means the
        // prompt confused the model into doing nothing. Give the user something
        // actionable instead of a blank speech bubble.
        if (!persistText.trim()) {
          const fallback = '⚠️ The agent returned an empty reply. Try rephrasing your request — e.g. tell it the brand / topic / 1-2 concrete details, or which kind of frame you want first.';
          sseWrite({ type: 'text', chunk: fallback });
          persistText = fallback;
        }
        await appendMessage(ctx, id, history, {
          role: 'assistant',
          agent: agentDef.id,
          content: persistText,
          ts: Date.now(),
        });
        // discard project0 reference to keep TS happy
        void project0;
        res.end();
        return;
        } finally {
          GENERATING.delete(generationKey);
        }
      }

      // Is a generation currently running for this project? Lets a returning
      // client show "still generating…" instead of a blank where the live
      // progress lines used to be.
      const genStatusMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/generating$/);
      if (genStatusMatch && genStatusMatch[1] && m === 'GET') {
        await ctx.orchestrator.load(genStatusMatch[1]);
        return json(res, 200, {
          generating: GENERATING.has(runtimeProjectKey(ctx, genStatusMatch[1])),
        });
      }

      // ============== v0.8: content-graph + frames API ==============

      // GET content graph as JSON
      const cgMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/content-graph$/);
      if (cgMatch && cgMatch[1] && m === 'GET') {
        const graph = await ctx.orchestrator.readContentGraph(cgMatch[1]);
        if (!graph) return json(res, 404, { error: 'No content graph for this project' });
        return json(res, 200, { graph });
      }

      // Re-pace each frame's duration to match the narration: split the total
      // duration across frames in proportion to each frame's narration length
      // (a frame with twice the words holds twice as long), so a generated
      // voiceover and the visuals stay in step. Min 2s per frame.
      const fitMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/fit-durations$/);
      if (fitMatch && fitMatch[1] && m === 'POST') {
        const projectId = fitMatch[1];
        const graph = await ctx.orchestrator.readContentGraph(projectId);
        if (!graph || !Array.isArray(graph.nodes) || graph.nodes.length === 0) {
          return json(res, 400, { error: 'No frames yet — generate the video first.' });
        }
        const byFrame = ((await readBody(req)) as { narrationByFrame?: Record<string, string> }).narrationByFrame ?? {};
        const lenOf = (id: string) => (byFrame[id]?.trim().length ?? 0);
        const totalChars = graph.nodes.reduce((s, n) => s + lenOf(n.id), 0);
        if (totalChars === 0) {
          return json(res, 400, { error: 'No narration yet — draft narration first, then fit.' });
        }
        const MIN = 2;
        // Keep total duration, but if there isn't enough to give every frame the
        // minimum at its char-share, scale the total up so MIN is always honored
        // (≈0.18s of speech per character is a comfortable narration pace).
        const SEC_PER_CHAR = 0.18;
        const currentTotal = graph.nodes.reduce((s, n) => s + (n.durationSec ?? MIN), 0);
        const neededForSpeech = Math.ceil(totalChars * SEC_PER_CHAR);
        const total = Math.max(currentTotal, neededForSpeech, MIN * graph.nodes.length);
        // Proportional by char share, then lift any frame below MIN.
        let durs = graph.nodes.map((n) => ({ n, d: Math.max(MIN, Math.round((lenOf(n.id) / totalChars) * total)) }));
        // Re-normalize so the rounded sum matches `total` (adjust the longest frame).
        const sum = durs.reduce((s, x) => s + x.d, 0);
        if (sum !== total && durs.length) {
          const longest = durs.reduce((a, b) => (b.d > a.d ? b : a));
          longest.d = Math.max(MIN, longest.d + (total - sum));
        }
        for (const { n, d } of durs) n.durationSec = d;
        // preserveFrames: fit only re-times an EXISTING storyboard — must not
        // wipe the rendered frames (that left export with no frames → it fell
        // back to a single 5s template still instead of the multi-frame video).
        await ctx.orchestrator.writeContentGraph(projectId, graph, { preserveFrames: true });
        const durations = Object.fromEntries(graph.nodes.map((n) => [n.id, n.durationSec]));
        return json(res, 200, { ok: true, durations, totalSec: graph.nodes.reduce((s, n) => s + (n.durationSec ?? 0), 0) });
      }

      // ============== File serving ==============

      // Project preview HTML (and any sibling files like assets/)
      const previewServeMatch = url.pathname.match(/^\/preview\/([^/]+)(\/.*)?$/);
      if (previewServeMatch && previewServeMatch[1]) {
        const projId = previewServeMatch[1];
        const sub = previewServeMatch[2] ?? '/preview.html';
        const project = await ctx.orchestrator.load(projId);

        // Phase C: serve an enhanced frame's preview MP4 (native Remotion frames
        // have no HTML). Match the `.mp4` suffix BEFORE the plain HTML frame route.
        const frameMp4Match = sub.match(/^\/frame\/([a-z0-9_-]+)\.mp4$/i);
        if (frameMp4Match && frameMp4Match[1]) {
          const frame = (project.frames ?? []).find((f) => f.graphNodeId === frameMp4Match[1]);
          if (frame?.previewMp4Path && existsSync(frame.previewMp4Path)) {
            return serveFile(frame.previewMp4Path, res);
          }
          res.writeHead(404);
          return res.end('No preview MP4 for frame');
        }

        // v0.8: serve a specific frame HTML by graph node id
        const frameMatch = sub.match(/^\/frame\/([a-z0-9_-]+)$/i);
        if (frameMatch && frameMatch[1]) {
          const nodeId = frameMatch[1];
          const frame = (project.frames ?? []).find((f) => f.graphNodeId === nodeId);
          if (frame && existsSync(frame.htmlPath)) {
            return serveFile(frame.htmlPath, res);
          }
          res.writeHead(404);
          return res.end('Frame not found');
        }

        const baseDir = project.lastPreviewHtmlPath
          ? dirname(project.lastPreviewHtmlPath)
          : null;
        if (!baseDir) {
          res.writeHead(404);
          return res.end('Preview not rendered yet');
        }
        const filePath = sub === '/preview.html' || sub === '/'
          ? project.lastPreviewHtmlPath!
          : join(baseDir, sub);
        if (existsSync(filePath) && statSync(filePath).isFile()) {
          const albumPage = Number(url.searchParams.get('albumPage') || 0);
          if (
            (sub === '/preview.html' || sub === '/')
            && url.searchParams.get('thumb') === '1'
            && Number.isFinite(albumPage)
            && albumPage > 0
            && extname(filePath).toLowerCase() === '.html'
          ) {
            const html = await readFile(filePath, 'utf8');
            return serveHtml(injectAlbumPageThumbMode(html, albumPage - 1), res);
          }
          return serveFile(filePath, res);
        }
        // Fallback: also try project assets/
        const projAssets = join(dirname(baseDir), 'assets', basename(sub));
        if (existsSync(projAssets)) return serveFile(projAssets, res);
        // Fallback 2 (multi-composition templates): hyperframes templates ship
        // with sibling files like compositions/intro.html that the entry
        // index.html references via data-composition-src. Project dir only
        // holds the rewritten preview.html — sibling files live in the
        // template's own dir. Resolve relative to that, but only when the
        // requested path is below the project's selected template (so a
        // project can't read a different template's files).
        if (project.templateId) {
          try {
            const tmpl = ctx.templates.get(project.templateId);
            if (tmpl?.__dir && sub.length > 1) {
              const tmplFile = join(tmpl.__dir, sub.replace(/^\//, ''));
              const tmplResolved = resolve(tmplFile);
              const tmplRoot = resolve(tmpl.__dir);
              if (
                tmplResolved.startsWith(tmplRoot + '/') &&
                existsSync(tmplResolved) &&
                statSync(tmplResolved).isFile()
              ) {
                return serveFile(tmplResolved, res);
              }
            }
          } catch {
            /* template lookup failed → just 404 */
          }
        }
        res.writeHead(404);
        return res.end('Not found');
      }

      // Asset direct serve (so iframe can load image_path etc)
      // /asset?path=<absolute-path>  — must be inside .html-video/projects
      if (url.pathname === '/asset' && m === 'GET') {
        const p = url.searchParams.get('path');
        if (!p) {
          res.writeHead(400);
          return res.end('missing ?path');
        }
        const safe = resolve(p);
        const projectsRoot = resolve(ctx.projectRoot, '.html-video', 'projects');
        const user = ctx.requestContexts.getRequiredUser();
        const allowedRoot = ctx.database?.mode === 'postgres'
          ? resolve(projectsRoot, safeWorkDirectorySegment(user.userId, 'user'))
          : projectsRoot;
        let allowed = isPathInside(allowedRoot, safe);
        if (!allowed && ctx.database?.mode === 'postgres') {
          const projects = await ctx.orchestrator.list();
          allowed = projects.some((project) => project.assets.some(
            (asset) => asset.path !== undefined && resolve(asset.path) === safe,
          ));
        }
        if (!allowed) {
          res.writeHead(403);
          return res.end('forbidden');
        }
        if (existsSync(safe)) return serveFile(safe, res);
        res.writeHead(404);
        return res.end();
      }

      // Template poster (e.g. /template-asset/<id>/preview.png)
      const tplAssetMatch = url.pathname.match(/^\/template-asset\/([^/]+)\/(.+)$/);
      if (tplAssetMatch && tplAssetMatch[1] && tplAssetMatch[2]) {
        const t = ctx.templates.get(tplAssetMatch[1]);
        const rel = tplAssetMatch[2];
        const filePath = join(t.__dir!, rel);
        if (!existsSync(filePath)) {
          res.writeHead(404);
          return res.end();
        }
        // Multi-composition templates ship an entry HTML that only stitches
        // sub-comps via data-composition-src; a raw iframe renders blank
        // because nothing assembles them. For the studio *preview* we inject a
        // tiny client-side player that fetches each composition, instantiates
        // its <template>, wires placeholders, and plays the GSAP timelines so
        // the gallery shows live motion. The template files on disk are never
        // touched — this rewrite happens only on the way out the wire.
        if (extname(filePath).toLowerCase() === '.html') {
          let html = await readFile(filePath, 'utf8');
          if (/data-composition-src/.test(html)) {
            html = injectCompositionPlayer(html);
            res.writeHead(200, {
              'content-type': MIME['.html']!,
              'cache-control': 'no-store, no-cache, must-revalidate',
              pragma: 'no-cache',
            });
            return res.end(html);
          }
        }
        return serveFile(filePath, res);
      }

      // ============== Static UI ==============
      const path = url.pathname === '/' ? '/index.html' : url.pathname;
      const filePath = join(uiRoot, path);
      if (filePath.startsWith(uiRoot) && existsSync(filePath) && statSync(filePath).isFile()) {
        return serveFile(filePath, res);
      }

      if (isStudioAppRoute(url.pathname)) {
        return serveFile(join(uiRoot, 'index.html'), res);
      }

      res.writeHead(404);
      res.end('Not found');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const code = (e as { code?: string }).code ?? 'unknown';
      json(res, httpStatusForErrorCode(code), { error: msg, code });
    }
  };

  const server = createServer(async (req, res) => {
    if (!req.url) {
      await handleRequest(req, res);
      return;
    }

    let url: URL;
    try {
      url = new URL(req.url, 'http://x');
    } catch {
      res.writeHead(400);
      res.end();
      return;
    }

    const apiRoute = url.pathname === '/api' || url.pathname.startsWith('/api/');
    const protectedFileRoute = url.pathname === '/asset' || url.pathname.startsWith('/preview/');
    const authenticatedRoute = apiRoute || protectedFileRoute;
    if (!authenticatedRoute) {
      await handleRequest(req, res);
      return;
    }

    const requestUser = getRequestUser(req, loadAuthConfig(ctx.projectRoot));
    const publicAuthRoute = url.pathname === '/api/auth' || url.pathname.startsWith('/api/auth/');
    if (!publicAuthRoute && !requestUser.authenticated) {
      json(res, 401, {
        error: 'Authentication required',
        code: 'unauthenticated',
      });
      return;
    }

    if (!requestUser.authenticated) {
      await handleRequest(req, res);
      return;
    }

    const source = requestUser.source === 'header' ? 'header' : 'cookie';
    await ctx.requestContexts.run({
      requestId: randomUUID(),
      source,
      user: {
        userId: requestUser.user_id,
        actorId: requestUser.actor_id,
      },
    }, () => handleRequest(req, res));
  });

  return new Promise((resolveFn) => {
    server.listen(port, host, () => {
      const addr = server.address();
      const actualPort = typeof addr === 'object' && addr ? addr.port : port;
      const displayHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
      resolveFn({
        url: `http://${displayHost}:${actualPort}`,
        host,
        port: actualPort,
        close: () => {
          server.close();
          void ctx.database?.handle?.close().catch(() => {});
        },
      });
    });
  });
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function httpStatusForErrorCode(code: string): number {
  if (code === 'project-not-found' || code === 'asset-not-found' || code === 'template-not-found') {
    return 404;
  }
  if (code === 'invalid-input') return 400;
  return 500;
}

function json(res: ServerResponse, code: number, body: unknown, headers: Record<string, string | string[]> = {}): void {
  res.writeHead(code, { 'content-type': MIME['.json']!, ...headers });
  res.end(JSON.stringify(body));
}

function exportJobResponse(job: ExportJobRow): Record<string, unknown> {
  return {
    id: job.id,
    album_id: job.album_id,
    status: job.status,
    export_format: job.export_format,
    render_profile: job.render_profile,
    width: job.width,
    height: job.height,
    fps: job.fps,
    duration_ms: job.duration_ms,
    progress_percent: Number(job.progress_percent),
    attempt_count: job.attempt_count,
    request_params: job.request_params,
    local_output_path: job.local_output_path,
    oss_bucket: job.oss_bucket,
    oss_key: job.oss_key,
    output_url: job.output_url,
    file_size_bytes: job.file_size_bytes,
    checksum_sha256: job.checksum_sha256,
    error_code: job.error_code,
    error_message: job.error_message,
    queued_time: job.queued_time,
    started_time: job.started_time,
    finished_time: job.finished_time,
    created_time: job.created_time,
    updated_time: job.updated_time,
  };
}

function clampInteger(value: string | null, min: number, max: number, fallback: number): number {
  if (value === null || !/^\d+$/.test(value)) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
}

function getRequestUser(req: IncomingMessage, authConfig: AuthConfig | null): {
  user_id: string;
  actor_id: string;
  display_name: string;
  source: 'header' | 'cookie' | 'default';
  authenticated: boolean;
} {
  // Header identity is a local-only escape hatch for development and tests.
  // Remote requests must authenticate through the signed cookie (or a future
  // external identity adapter).
  const headerUserId = isLoopbackAddress(req.socket.remoteAddress)
    ? headerValue(req.headers['x-user-id'])
    : '';
  const normalizedHeaderUserId = normalizeDevUserId(headerUserId);
  if (normalizedHeaderUserId) {
    return {
      user_id: normalizedHeaderUserId,
      actor_id: normalizedHeaderUserId,
      display_name: headerValue(req.headers['x-user-name']) || normalizedHeaderUserId,
      source: 'header',
      authenticated: true,
    };
  }

  const cookies = parseCookies(req.headers.cookie);
  const cookieUserId = normalizeDevUserId(cookies.hv_user_id);
  if (
    authConfig
    && cookieUserId
    && verifyDevAuthToken(authConfig, cookieUserId, cookies.hv_auth)
  ) {
    const account = findAuthUser(authConfig, cookieUserId);
    return {
      user_id: cookieUserId,
      actor_id: cookieUserId,
      display_name: account?.displayName || cookies.hv_display_name || cookieUserId,
      source: 'cookie',
      authenticated: true,
    };
  }

  return {
    user_id: 'local-dev',
    actor_id: 'local-dev',
    display_name: 'Local Dev User',
    source: 'default',
    authenticated: false,
  };
}

function isLoopbackAddress(address: string | undefined): boolean {
  return address === '127.0.0.1'
    || address === '::1'
    || address === '::ffff:127.0.0.1';
}

function isPathInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function headerValue(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? '' : value ?? '';
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    const key = part.slice(0, index).trim();
    if (!key) continue;
    const value = part.slice(index + 1).trim();
    try {
      out[key] = decodeURIComponent(value);
    } catch {
      out[key] = value;
    }
  }
  return out;
}

function normalizeDevUserId(value: string | undefined): string {
  const trimmed = (value ?? '').trim();
  if (!trimmed) return '';
  const safe = trimmed.replace(/[^A-Za-z0-9_.:@-]/g, '_').slice(0, 64);
  return safe || '';
}

function makeCookie(name: string, value: string): string {
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax`;
}

function clearCookie(name: string): string {
  return `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

function sanitizeDownloadName(name: string): string {
  const safe = name
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
  return safe || 'album';
}

function contentDispositionForHtml(name: string): string {
  const utf8Name = `${name}.html`;
  let asciiName = utf8Name
    .normalize('NFKD')
    .replace(/[^\x20-\x7E]/g, '')
    .replace(/[\\"]/g, '-')
    .trim();
  if (!asciiName || asciiName === '.html') asciiName = 'album.html';
  return `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(utf8Name)}`;
}

/**
 * Decide how the gallery should preview a template. Both self-contained
 * entries and multi-composition entries now render live in an iframe: the
 * latter get an injected composition player (see injectCompositionPlayer) that
 * assembles the sub-comps and plays their timelines, so 'iframe' is the right
 * mode for everything that has a readable entry.
 *
 * `posterUrl` is still surfaced (when the poster file exists) so the frontend
 * can fall back to a static poster if the live iframe ever fails to render.
 */
function templatePreviewMode(
  t: import('@html-video/core').TemplateMetadata,
): { mode: 'iframe' | 'poster'; posterUrl: string | null } {
  const posterRel = t.preview?.poster;
  const posterPath = posterRel && t.__dir ? join(t.__dir, posterRel) : null;
  const posterUrl =
    posterPath && existsSync(posterPath)
      ? `/template-asset/${t.id}/${posterRel}`
      : null;
  return { mode: 'iframe', posterUrl };
}

/**
 * Inject a minimal client-side composition player into a multi-comp entry
 * HTML so the studio preview shows live motion instead of a blank iframe.
 *
 * Hyperframes templates declare their scenes as `<div data-composition-src=
 * "compositions/x.html">` placeholders; each composition file is a `<template>`
 * wrapping markup + <style> + a <script> that registers a paused GSAP timeline
 * on `window.__timelines[name]`. The real (v0.9) renderer assembles these for
 * frame-accurate export; this player is a lightweight stand-in that just makes
 * the preview move:
 *   1. swap the two known placeholders so nothing 404s / NaNs,
 *   2. fetch each composition (relative to /template-asset/<id>/), graft its
 *      <template>.content into the placeholder div, and re-run its scripts
 *      (cloned <script> nodes never execute on their own),
 *   3. once every timeline has registered, play them all on a loop.
 * Templates on disk are untouched — this is a serve-time transform only.
 */
function injectCompositionPlayer(html: string): string {
  // 15s is a sane default duration for the preview loop; __VIDEO_SRC__ has no
  // real asset in-repo, so point it at an empty data URI to avoid a 404 fetch.
  let out = html
    .replace(/__VIDEO_DURATION__/g, '15')
    .replace(/__VIDEO_SRC__/g, 'data:video/mp4;base64,');

  // The entry's own inline scripts assign window.__timelines["background"]
  // etc. before the entry ever initialises the registry — in the real HF
  // runtime the player defines it first. Mirror that: seed the registry in
  // <head> so those early assignments don't throw on an undefined object.
  const seed = '<script>window.__timelines = window.__timelines || {};</script>';
  if (/<head[^>]*>/i.test(out)) {
    out = out.replace(/<head[^>]*>/i, (m) => m + '\n' + seed);
  } else {
    out = seed + '\n' + out;
  }

  const player = `
<script>
(function () {
  function reexec(root) {
    // Cloned/innerHTML'd <script> nodes don't run — recreate them so each
    // composition's timeline-registration IIFE actually executes. Skip the
    // external gsap CDN tag: the entry already loaded gsap synchronously, and
    // re-adding it would race (async load) ahead of the inline IIFE that calls
    // gsap.timeline() right after it.
    root.querySelectorAll('script').forEach(function (old) {
      if (old.src) { old.parentNode.removeChild(old); return; }
      var s = document.createElement('script');
      // Each composition's inline script declares top-level \`const tl = ...\`.
      // Re-injecting several into the shared global scope collides ("tl has
      // already been declared"). Wrap each in its own block so those locals
      // stay private; window.__timelines assignments still escape the block.
      s.textContent = '{\\n' + old.textContent + '\\n}';
      old.parentNode.replaceChild(s, old);
    });
  }
  async function mountOne(host) {
    var src = host.getAttribute('data-composition-src');
    if (!src) return;
    try {
      var res = await fetch(src);
      if (!res.ok) return;
      var text = await res.text();
      var holder = document.createElement('div');
      holder.innerHTML = text;
      var tpl = holder.querySelector('template');
      var frag = tpl ? tpl.content.cloneNode(true) : holder;
      host.appendChild(frag);
      reexec(host);
    } catch (e) { /* a missing comp shouldn't blank the whole preview */ }
  }
  async function boot() {
    window.__timelines = window.__timelines || {};
    var hosts = Array.prototype.slice.call(
      document.querySelectorAll('[data-composition-src]'));
    await Promise.all(hosts.map(mountOne));
    // Give the just-injected <script> tags a tick to register timelines.
    setTimeout(function () {
      var tls = window.__timelines || {};
      Object.keys(tls).forEach(function (k) {
        var tl = tls[k];
        if (tl && typeof tl.play === 'function') {
          try { tl.repeat(-1); } catch (e) {}
          tl.play(0);
        }
      });
    }, 120);
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else { boot(); }
})();
</script>`;

  if (out.includes('</body>')) return out.replace('</body>', player + '\n</body>');
  return out + player;
}

async function serveFile(filePath: string, res: ServerResponse): Promise<void> {
  const ext = extname(filePath).toLowerCase();
  const buf = await readFile(filePath);
  res.writeHead(200, {
    'content-type': MIME[ext] ?? 'application/octet-stream',
    // Studio is a local dev tool — always serve fresh so v0.x updates show
    // up immediately on page load instead of being held in disk cache.
    'cache-control': 'no-store, no-cache, must-revalidate',
    pragma: 'no-cache',
  });
  res.end(buf);
}

function serveHtml(html: string, res: ServerResponse): void {
  res.writeHead(200, {
    'content-type': MIME['.html']!,
    'cache-control': 'no-store, no-cache, must-revalidate',
    pragma: 'no-cache',
  });
  res.end(html);
}

function injectAlbumPageThumbMode(html: string, pageIndex: number): string {
  const safeIndex = Math.max(0, Math.floor(pageIndex));
  const payload = JSON.stringify({ pageIndex: safeIndex });
  const snippet = `
<script id="hv-studio-album-thumb-bootstrap">
(() => {
  const config = ${payload};
  const selectors = [
    '[data-page]',
    '[data-album-page]',
    '.album-page',
    'section.page',
    'article.page',
    'main.page',
    '#album > .page',
    '.album > .page',
    '.pages > .page',
    '.album-container > .page',
    '.scroll-container > .page',
    '.story-container > .page',
  ];
  function pages() {
    const seen = new Set();
    const out = [];
    for (const selector of selectors) {
      document.querySelectorAll(selector).forEach((el) => {
        if (seen.has(el)) return;
        seen.add(el);
        out.push(el);
      });
    }
    return out
      .filter((page) => page.querySelector('[data-hv-text], [data-hv-image], [data-hv-cta], img, h1, h2, p, button, a'))
      .filter((page) => !out.some((other) => other !== page && other.contains(page)));
  }
  function apply() {
    const list = pages();
    if (!list.length) return;
    const safe = Math.max(0, Math.min(list.length - 1, config.pageIndex || 0));
    document.documentElement.classList.add('hv-album-thumb');
    document.body?.classList.add('hv-album-thumb');
    list.forEach((page, index) => {
      page.setAttribute('data-hv-thumb-page', String(index));
      if (index === safe) {
        const display = getComputedStyle(page).display;
        page.style.setProperty('display', display && display !== 'none' ? display : 'block', 'important');
        page.style.setProperty('visibility', 'visible', 'important');
        page.style.setProperty('opacity', '1', 'important');
        page.style.setProperty('position', 'relative', 'important');
        page.style.setProperty('inset', 'auto', 'important');
        page.style.setProperty('transform', 'none', 'important');
        page.style.setProperty('width', '100%', 'important');
        page.style.setProperty('min-height', '100vh', 'important');
        page.style.setProperty('height', '100vh', 'important');
        page.style.setProperty('overflow', 'hidden', 'important');
        page.querySelectorAll('*').forEach((child) => {
          child.style.setProperty('animation', 'none', 'important');
          child.style.setProperty('transition', 'none', 'important');
        });
      } else {
        page.style.setProperty('display', 'none', 'important');
      }
    });
    const scroller = document.getElementById('album')
      || document.querySelector('.album, [data-album], .scroll-container, .story-container, .album-container, .pages')
      || document.scrollingElement
      || document.documentElement;
    if (scroller) scroller.scrollTop = 0;
    document.documentElement.scrollTop = 0;
    if (document.body) document.body.scrollTop = 0;
  }
  const css = document.createElement('style');
  css.id = 'hv-studio-album-thumb';
  css.textContent = \`
html.hv-album-thumb, html.hv-album-thumb body {
  margin: 0 !important;
  overflow: hidden !important;
  height: 100% !important;
  min-height: 100% !important;
  background: #0b1220;
}
html.hv-album-thumb #album,
html.hv-album-thumb .album,
html.hv-album-thumb [data-album],
html.hv-album-thumb .scroll-container,
html.hv-album-thumb .story-container,
html.hv-album-thumb .album-container,
html.hv-album-thumb .pages {
  overflow: hidden !important;
  height: 100% !important;
  min-height: 100% !important;
  max-height: 100% !important;
  scroll-snap-type: none !important;
  transform: none !important;
}
html.hv-album-thumb .album-controls,
html.hv-album-thumb .dots,
html.hv-album-thumb nav.album-controls,
html.hv-album-thumb #prevPage,
html.hv-album-thumb #nextPage,
html.hv-album-thumb .prev-btn,
html.hv-album-thumb .next-btn {
  display: none !important;
}
html.hv-album-thumb [data-hv-thumb-page] {
  animation: none !important;
  transition: none !important;
  scroll-snap-align: none !important;
}
\`;
  (document.head || document.documentElement).appendChild(css);
  apply();
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', apply, { once: true });
  window.addEventListener('load', apply, { once: true });
  requestAnimationFrame(apply);
  setTimeout(apply, 80);
  setTimeout(apply, 250);
  setTimeout(apply, 800);
})();
</script>`;
  if (html.includes('</head>')) return html.replace('</head>', `${snippet}\n</head>`);
  if (html.includes('</body>')) return html.replace('</body>', `${snippet}\n</body>`);
  return html + snippet;
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolveFn, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
    });
    req.on('end', () => {
      try {
        resolveFn(data ? JSON.parse(data) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

async function readBodyText(req: IncomingMessage): Promise<string> {
  return new Promise((resolveFn, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
    });
    req.on('end', () => resolveFn(data));
    req.on('error', reject);
  });
}

async function readDevOssTestUpload(req: IncomingMessage): Promise<{
  body: Buffer;
  fileName: string;
  mimeType: string;
}> {
  const contentType = req.headers['content-type'] ?? '';
  if (contentType.startsWith('multipart/form-data')) {
    const parts = await receiveMultipart(req, contentType);
    const file = parts.find((p): p is Extract<MultipartPart, { kind: 'file' }> => p.kind === 'file');
    if (!file) throw new Error('No file field in multipart body');
    const mimePart = parts.find((p): p is Extract<MultipartPart, { kind: 'field' }> =>
      p.kind === 'field' && p.name === 'mime_type',
    );
    return {
      body: await readFile(file.tmpPath),
      fileName: file.filename,
      mimeType: mimePart?.value || mimeTypeFromFileName(file.filename),
    };
  }

  if (contentType.includes('application/json')) {
    const body = await readBody(req).catch(() => ({} as Record<string, unknown>));
    const fileName = typeof body.file_name === 'string' && body.file_name.trim()
      ? body.file_name.trim()
      : 'oss-asset-test.txt';
    const mimeType = typeof body.mime_type === 'string' && body.mime_type.trim()
      ? body.mime_type.trim()
      : mimeTypeFromFileName(fileName);
    if (typeof body.content_base64 === 'string' && body.content_base64) {
      return { body: Buffer.from(body.content_base64, 'base64'), fileName, mimeType };
    }
    if (typeof body.content === 'string') {
      return { body: Buffer.from(body.content, 'utf8'), fileName, mimeType };
    }
  }

  const now = new Date().toISOString();
  return {
    body: Buffer.from(`html-video OSS asset persistence test\ncreated_at=${now}\n`, 'utf8'),
    fileName: `oss-asset-test-${now.replace(/[:.]/g, '-')}.txt`,
    mimeType: 'text/plain; charset=utf-8',
  };
}

function shouldPersistUploadedAssetsToOss(ctx: CliContext): boolean {
  if (ctx.database?.mode !== 'postgres' || !ctx.database.handle) return false;
  const oss = loadOssConfig(ctx.projectRoot);
  return Boolean(oss?.enabled);
}

async function addFileAssetToOss(
  ctx: CliContext,
  projectId: string,
  filePath: string,
  originalFileName?: string,
): Promise<Project> {
  if (!ctx.database?.handle) {
    throw new Error('PostgreSQL database handle is not available');
  }
  if (!existsSync(filePath)) {
    throw new Error(`Source file not found: ${filePath}`);
  }
  const oss = loadOssConfig(ctx.projectRoot);
  if (!oss?.enabled) {
    throw new Error('OSS config is not enabled');
  }

  const project = await ctx.orchestrator.load(projectId);
  const user = ctx.requestContexts.getRequiredUser();
  const bytes = await readFile(filePath);
  const fileName = originalFileName || basename(filePath);
  const { mime, type } = AssetStore.guessMime(fileName);
  const objectId = randomUUID();
  const ossKey = [
    oss.prefix,
    'users',
    safeWorkDirectorySegment(user.userId, 'user'),
    'projects',
    safeWorkDirectorySegment(projectId, 'project'),
    'assets',
    objectId,
    safeOssFileName(fileName),
  ].filter(Boolean).join('/');
  const uploaded = await uploadToAliyunOss(oss, {
    key: ossKey,
    body: bytes,
    contentType: mime,
  });

  const checksumSha256 = createHash('sha256').update(bytes).digest('hex');
  const created = await projectAssetPersistence(ctx).createForProject(projectId, {
    id: objectId,
    asset_type: assetTypeFromMime(mime),
    usage_type: 'source',
    source: 'upload',
    status: 'available',
    oss_bucket: uploaded.bucket,
    oss_key: uploaded.key,
    url: uploaded.url,
    file_name: fileName,
    mime_type: mime,
    file_ext: extname(fileName) || null,
    file_size_bytes: bytes.byteLength,
    checksum_sha256: checksumSha256,
    metadata: {
      upload_route: '/api/projects/:id/assets',
      uploaded_at: new Date().toISOString(),
      oss_etag: uploaded.etag,
      original_local_path: filePath,
    },
  });

  const asset: Asset = {
    id: created.id,
    type,
    path: created.url,
    metadata: {
      filename: fileName,
      mimeType: mime,
      sizeBytes: bytes.byteLength,
    },
    userTags: [],
  };
  if (!project.assets.find((item) => item.id === asset.id)) {
    project.assets.push(asset);
  }
  project.status = 'draft';
  await ctx.projects.save(project);
  return ctx.orchestrator.load(projectId);
}

async function uploadExportMp4ToOss(
  ctx: CliContext,
  projectId: string,
  outputPath: string,
  exportJob: ExportJobHandle | null,
): Promise<ExportArtifactLocation | null> {
  if (ctx.database?.mode !== 'postgres' || !ctx.database.handle || !exportJob) return null;
  const oss = loadOssConfig(ctx.projectRoot);
  if (!oss?.enabled) return null;
  const user = ctx.requestContexts.getRequiredUser();

  const ossKey = [
    oss.prefix,
    'users',
    safeWorkDirectorySegment(user.userId, 'user'),
    'projects',
    safeWorkDirectorySegment(projectId, 'project'),
    'exports',
    exportJob.id,
    'output.mp4',
  ].filter(Boolean).join('/');
  const uploaded = await uploadFileToAliyunOss(oss, {
    key: ossKey,
    filePath: outputPath,
    contentType: MIME['.mp4']!,
  });
  return {
    ossBucket: uploaded.bucket,
    ossKey: uploaded.key,
    outputUrl: uploaded.url,
  };
}

async function softDeleteAssetInPostgres(
  ctx: CliContext,
  projectId: string,
  assetId: string,
  allowMissingDatabaseRow: boolean,
): Promise<void> {
  if (ctx.database?.mode !== 'postgres' || !ctx.database.handle) return;
  await projectAssetPersistence(ctx).softDeleteForProject(projectId, assetId, {
    allowMissingDatabaseRow,
  });
}

function projectAssetPersistence(ctx: CliContext): PostgresAssetPersistence {
  if (!ctx.database?.handle) {
    throw new Error('PostgreSQL database handle is not available');
  }
  return new PostgresAssetPersistence({
    getUserContext: () => ctx.requestContexts.getRequiredUser(),
    albums: new AlbumRepository(ctx.database.handle.db),
    assets: new AssetRepository(ctx.database.handle.db),
  });
}

async function findProjectAlbum(repo: AlbumRepository, projectId: string, userId: string) {
  const bySourceProjectId = await repo.findBySourceProjectId(userId, projectId);
  if (bySourceProjectId) return bySourceProjectId;
  if (!isUuid(projectId)) return null;
  return repo.findById(userId, projectId);
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function summarizeAssetRow(asset: AssetRow): Record<string, unknown> {
  return {
    id: asset.id,
    user_id: asset.user_id,
    album_id: asset.album_id,
    page_id: asset.page_id,
    asset_type: asset.asset_type,
    usage_type: asset.usage_type,
    source: asset.source,
    status: asset.status,
    oss_bucket: asset.oss_bucket,
    oss_key: asset.oss_key,
    url: asset.url,
    file_name: asset.file_name,
    mime_type: asset.mime_type,
    file_ext: asset.file_ext,
    file_size_bytes: asset.file_size_bytes,
    checksum_sha256: asset.checksum_sha256,
    metadata: asset.metadata,
    created_time: asset.created_time,
  };
}

function countAssetsByStatus(assets: AssetRow[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const asset of assets) {
    counts[asset.status] = (counts[asset.status] ?? 0) + 1;
  }
  return counts;
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assetTypeFromMime(mimeType: string): DbAssetType {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType.startsWith('audio/')) return 'audio';
  if (mimeType.includes('json')) return 'data';
  if (mimeType.startsWith('text/')) return 'text';
  if (mimeType.includes('font')) return 'font';
  return 'other';
}

function mimeTypeFromFileName(fileName: string): string {
  const ext = extname(fileName).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.svg') return 'image/svg+xml';
  if (ext === '.mp4') return 'video/mp4';
  if (ext === '.webm') return 'video/webm';
  if (ext === '.mp3') return 'audio/mpeg';
  if (ext === '.wav') return 'audio/wav';
  if (ext === '.json') return 'application/json';
  if (ext === '.txt' || ext === '.md') return 'text/plain; charset=utf-8';
  return 'application/octet-stream';
}

function safeOssFileName(fileName: string): string {
  const fallback = 'upload.bin';
  const base = basename(fileName || fallback).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim();
  return base || fallback;
}

/**
 * Minimal multipart parser — returns ALL parts (fields + files).
 * Files are written to a tmp path and the path is returned.
 * For production switch to formidable / busboy.
 */
type MultipartPart =
  | { kind: 'field'; name: string; value: string }
  | { kind: 'file'; name: string; filename: string; tmpPath: string };

/**
 * Recover the real filename from a multipart part header (issue #9).
 *
 * Two encodings can appear:
 *  - `filename*=UTF-8''%E4%B8%AD%E6%96%87.md` (RFC 5987, percent-encoded) —
 *    decode the percent-escapes after stripping the charset prefix.
 *  - `filename="中文.md"` — the bytes are UTF-8, but the multipart body was
 *    read as a latin1 string, so each UTF-8 byte became one latin1 char. Round
 *    -trip latin1→utf8 to restore the original. If the name was plain ASCII the
 *    round-trip is a no-op.
 */
export function decodeUploadFilename(star: string | undefined, plain: string | undefined): string {
  if (star) {
    // RFC 5987 ext-value: charset "'" [language] "'" value  (e.g.
    // UTF-8''%E4%B8%AD.md  or  UTF-8'zh-CN'%E6%95%B0%E6%8D%AE.json).
    const m = /^[\w-]*'[^']*'(.*)$/.exec(star.trim());
    const enc = m?.[1] ?? star.trim();
    try { return decodeURIComponent(enc); } catch { return enc; }
  }
  if (plain !== undefined) {
    try { return Buffer.from(plain, 'latin1').toString('utf8'); } catch { return plain; }
  }
  return 'upload';
}

async function receiveMultipart(
  req: IncomingMessage,
  contentType: string,
): Promise<MultipartPart[]> {
  const boundaryMatch = contentType.match(/boundary=(.+)/);
  if (!boundaryMatch) throw new Error('No multipart boundary');
  const boundary = `--${boundaryMatch[1]}`;
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const buf = Buffer.concat(chunks);
  const text = buf.toString('binary');
  const parts = text.split(boundary).slice(1, -1);
  const out: MultipartPart[] = [];
  const fs = await import('node:fs/promises');
  for (const part of parts) {
    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd === -1) continue;
    const headers = part.slice(0, headerEnd);
    const bodyRaw = part.slice(headerEnd + 4, part.length - 2);
    const nameMatch = headers.match(/name="([^"]+)"/);
    if (!nameMatch || !nameMatch[1]) continue;
    const name = nameMatch[1];
    // RFC 5987 `filename*=UTF-8''...` (percent-encoded) wins when present;
    // otherwise fall back to the plain `filename="..."`. The plain form carries
    // raw UTF-8 BYTES, but the part was sliced out of a latin1 string above, so
    // a CJK filename arrives mojibake'd — re-decode latin1→utf8 to restore it
    // (issue #9). decodeUploadFilename handles both.
    const fnStarMatch = headers.match(/filename\*=([^;\r\n]+)/i);
    const fnMatch = headers.match(/filename="([^"]*)"/);
    if (fnStarMatch || fnMatch) {
      const filename = decodeUploadFilename(fnStarMatch?.[1], fnMatch?.[1]);
      // Keep the tmp path ASCII-safe; the real (possibly CJK) name rides on the
      // returned part, not the on-disk temp file.
      const ext = (filename.match(/\.[A-Za-z0-9]{1,8}$/)?.[0]) ?? '';
      const tmpPath = join(tmpdir(), `hv-upload-${randomUUID().slice(0, 8)}${ext}`);
      await mkdir(dirname(tmpPath), { recursive: true });
      await fs.writeFile(tmpPath, Buffer.from(bodyRaw, 'binary'));
      out.push({ kind: 'file', name, filename, tmpPath });
    } else {
      // Field — body is utf8 text
      out.push({ kind: 'field', name, value: Buffer.from(bodyRaw, 'binary').toString('utf8') });
    }
  }
  return out;
}

// Backward-compat shim used by the older /api/projects/:id/assets endpoint
async function receiveMultipartFile(
  req: IncomingMessage,
  contentType: string,
): Promise<{ filePath: string; filename: string }> {
  const parts = await receiveMultipart(req, contentType);
  const file = parts.find((p): p is Extract<MultipartPart, { kind: 'file' }> => p.kind === 'file');
  if (!file) throw new Error('No file field in multipart body');
  return { filePath: file.tmpPath, filename: file.filename };
}

// Keep TS aware that copyFile / AssetStore are used somewhere (they're indirectly via orchestrator)
void copyFile;
void AssetStore;

// ---------------------------------------------------------------------------
// Message history. PostgreSQL mode uses normalized session/message/selection
// tables; file mode keeps the legacy in-memory cache + messages.json behavior.
// ---------------------------------------------------------------------------

interface ChatMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  agent?: string;
  tool?: string;
  output?: unknown;
  ts: number;
}

const MESSAGES = new Map<string, ChatMessage[]>();

/** Projects with a generation running right now (detached from any request).
 *  Lets a client that switched away and came back learn the task is still alive
 *  ("⏳ still generating…") instead of seeing the progress lines vanish. */
const GENERATING = new Set<string>();

function runtimeProjectKey(ctx: CliContext, projectId: string): string {
  if (ctx.database?.mode !== 'postgres') return projectId;
  return `${ctx.requestContexts.getRequiredUser().userId}\0${projectId}`;
}

async function loadMessages(ctx: CliContext, projectId: string): Promise<ChatMessage[]> {
  if (ctx.database?.mode === 'postgres' && ctx.database.handle) {
    const rows = await projectChatPersistence(ctx).listForProject(projectId);
    return rows.map(chatRowToMessage);
  }
  const cached = MESSAGES.get(projectId);
  if (cached) return cached;
  const projectDir = await ctx.projects.ensureDir(projectId);
  const filePath = join(projectDir, 'messages.json');
  if (!existsSync(filePath)) {
    MESSAGES.set(projectId, []);
    return MESSAGES.get(projectId)!;
  }
  try {
    const raw = await readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    const arr = Array.isArray(parsed) ? (parsed as ChatMessage[]) : [];
    MESSAGES.set(projectId, arr);
    return arr;
  } catch {
    // Corrupt file — start fresh in memory but don't overwrite the file
    // until the next save (gives the user a chance to recover by hand).
    MESSAGES.set(projectId, []);
    return MESSAGES.get(projectId)!;
  }
}

async function appendMessage(
  ctx: CliContext,
  projectId: string,
  messages: ChatMessage[],
  message: ChatMessage,
  selection?: ChatSelectionData,
): Promise<void> {
  if (ctx.database?.mode === 'postgres' && ctx.database.handle) {
    await projectChatPersistence(ctx).appendForProject(projectId, {
      role: message.role,
      content: message.content,
      messageType: selection
        ? selection.selectionType === 'form'
          ? 'form_submission'
          : selection.selectionType === 'confirmation'
            ? 'confirmation'
            : selection.selectionType === 'option'
              ? 'option_selection'
              : 'text'
        : undefined,
      ...(message.agent && { agent: message.agent }),
      ...(message.tool && { tool: message.tool }),
      payload: jsonObject({
        ...(message.output !== undefined && { output: message.output }),
        ...(selection && {
          selection_type: selection.selectionType,
          phase: selection.phase ?? null,
          selection_key: selection.selectionKey ?? null,
          value: selection.value,
        }),
      }),
      occurredAt: new Date(message.ts),
    });
    messages.push(message);
    return;
  }
  messages.push(message);
  MESSAGES.set(projectId, messages);
  const projectDir = await ctx.projects.ensureDir(projectId);
  const filePath = join(projectDir, 'messages.json');
  const fs = await import('node:fs/promises');
  await fs.writeFile(filePath, JSON.stringify(messages, null, 2), 'utf8');
}

function projectChatPersistence(ctx: CliContext): PostgresChatPersistence {
  if (!ctx.database?.handle) {
    throw new Error('PostgreSQL database handle is not available');
  }
  const db = ctx.database.handle.db;
  return new PostgresChatPersistence({
    getUserContext: () => ctx.requestContexts.getRequiredUser(),
    getRequestId: () => ctx.requestContexts.get()?.requestId,
    albums: new AlbumRepository(db),
    sessions: new ChatSessionRepository(db),
    messages: new ChatMessageRepository(db),
  });
}

function chatRowToMessage(row: ChatMessageRow): ChatMessage {
  const output = row.payload.output;
  return {
    role: row.role,
    content: row.content,
    ...(row.agent && { agent: row.agent }),
    ...(row.tool && { tool: row.tool }),
    ...(output !== undefined && { output }),
    ts: row.occurred_time instanceof Date
      ? row.occurred_time.getTime()
      : new Date(row.occurred_time).getTime(),
  };
}

interface ChatSelectionData {
  selectionType: 'option' | 'form' | 'confirmation' | 'frame_focus';
  phase?: string;
  selectionKey?: string;
  value: JsonObject;
}

function chatSelectionForMessage(
  history: ChatMessage[],
  content: string,
  focusFrameId: string,
): ChatSelectionData | undefined {
  const trimmed = content.trim();
  const previousCard = lastAssistantCardWithMeta(history);
  const form = /^\[hv-form:submit\]\s*\n([\s\S]+)$/.exec(trimmed);
  if (form?.[1]) {
    try {
      return {
        selectionType: 'form',
        phase: previousCard?.metaPhase ?? 'format',
        value: jsonObject(JSON.parse(form[1]) as Record<string, unknown>),
      };
    } catch {
      return {
        selectionType: 'form',
        phase: previousCard?.metaPhase ?? 'format',
        value: { raw: form[1] },
      };
    }
  }
  if (trimmed === '[hv-confirm:generate]' || trimmed === '[hv-confirm:edit]') {
    return {
      selectionType: 'confirmation',
      phase: previousCard?.metaPhase ?? 'confirm',
      selectionKey: 'action',
      value: { action: trimmed === '[hv-confirm:generate]' ? 'generate' : 'edit' },
    };
  }
  if (previousCard?.kind === 'hv-options') {
    return {
      selectionType: 'option',
      ...(previousCard.metaPhase && { phase: previousCard.metaPhase }),
      selectionKey: 'label',
      value: { label: trimmed },
    };
  }
  if (focusFrameId) {
    return {
      selectionType: 'frame_focus',
      phase: 'iterate',
      selectionKey: 'frame_id',
      value: { frame_id: focusFrameId },
    };
  }
  return undefined;
}

function jsonObject(value: Record<string, unknown>): JsonObject {
  return JSON.parse(JSON.stringify(value, (_key, item) => (
    item === undefined || typeof item === 'bigint' || typeof item === 'function'
      ? undefined
      : item
  ))) as JsonObject;
}

// `Attachment` is declared above (at the buildHtmlGenerationPrompt section)

interface BuildPromptArgs {
  tmpl: import('@html-video/core').TemplateMetadata | null;
  exampleHtml: string;
  priorHtml: string;
  history: ChatMessage[];
  userText: string;
  attachments: Attachment[];
  /** When set, iterate-phase prompts target only this frame's HTML. */
  focusFrameId?: string;
  /** True when the project already has a real generated preview, not just a template seed. */
  hasGeneratedPreview?: boolean;
  /** The user's original opening subject, locked across phases. */
  openingTopic?: string;
}

interface Attachment {
  /** absolute path on disk */
  path: string;
  /** type the AssetStore detected */
  kind: 'image' | 'video' | 'audio' | 'data' | 'text' | 'reference-link';
  /** display name */
  filename: string;
  /** byte size */
  size: number;
  /**
   * For text sources (fetched articles/repos, uploaded .md/.txt), the actual
   * content — inlined directly into the prompt. A bare path is useless to HTTP
   * agents (Messages API runs in the cloud, can't read local disk), and even
   * for CLI agents the content should be the source material, not a file ref.
   */
  inlineText?: string;
}

/**
 * v0.5 chat prompt — guidance-first, not write-HTML-immediately.
 *
 * The system prompt tells the agent to:
 *   - On a vague first turn, ask 1–3 sharp questions instead of writing HTML
 *   - When the request + context are concrete enough, generate the full HTML
 *   - Use attachments as references / actual assets
 *   - Never use a fixed 4-question script — judge per turn what's missing
 *
 * Whether the agent writes HTML this turn is up to the agent. The server
 * extracts a fenced ```html block if present; if not, it's just a chat reply.
 */
/**
 * Conversation phases — fully sequential. Each card the assistant emits has
 * a `meta.phase` JSON field so the server can route the user's reply without
 * guessing.
 *
 *   opener  → hv-options{meta.phase:"type"}  → user picks content type
 *   content → free chat: agent asks about topic / headline / data, user
 *             can answer in 1+ turns or say "skip" / "随便"
 *   style   → hv-options{meta.phase:"style"} → user picks style preset
 *             (skipped automatically if a project template is already set)
 *   format  → hv-form{meta.phase:"format"}   → 3 segmented controls
 *             (aspect, duration, frame_count)
 *   confirm → hv-confirm{meta.phase:"confirm"} →  ✓ generate / ✏️ edit
 *   generate → emits HTML / content-graph + frames
 *
 *   info-edit → user clicked edit on confirm; re-emit format hv-form
 *   iterate   → after successful generate, free-form revision pass
 */
type ConvPhase =
  | 'opener'
  | 'content'
  | 'style'
  | 'need-template'
  | 'format'
  | 'format-edit'
  | 'confirm'
  | 'generate'
  | 'iterate'
  // Post-generation iteration sub-flow:
  | 'edit-menu'        // ask what to change (style / content / duration)
  | 'restyle'          // re-render every frame in a new style, text unchanged
  | 'iterate-content'  // re-plan the storyboard around new content
  | 'iterate-format';  // re-time / re-render with a new per-frame length

/** Did the user pick the "choose from design templates" style option? */
function isFromTemplateStyle(style: string): boolean {
  return /^从设计模板选|design template|pick.*template|from template/i.test(style.trim());
}

interface PhaseInputs {
  collected?: Record<string, string>; // last submitted hv-form values (format only)
  pickedType?: string;
  pickedStyle?: string;
  contentTurns?: string[];            // free-text user messages between type-pick and style/format
}

function normalizeAspectLabel(value?: string): string {
  const raw = String(value || '').trim();
  const ratio = /\b(16\s*[:：]\s*9|9\s*[:：]\s*16|1\s*[:：]\s*1|4\s*[:：]\s*5)\b/.exec(raw);
  if (ratio?.[1]) return ratio[1].replace(/\s/g, '').replace('：', ':');
  if (/横屏|landscape|wide/i.test(raw)) return '16:9';
  if (/竖屏|手机|portrait|vertical/i.test(raw)) return '9:16';
  if (/方形|square/i.test(raw)) return '1:1';
  if (/小红书|xiaohongshu|rednote/i.test(raw)) return '4:5';
  return '16:9';
}

function resolutionForAspect(value?: string): { aspect: string; resolution: string; width: number; height: number } {
  const aspect = normalizeAspectLabel(value);
  if (aspect === '9:16') return { aspect, resolution: '1080×1920', width: 1080, height: 1920 };
  if (aspect === '1:1') return { aspect, resolution: '1080×1080', width: 1080, height: 1080 };
  if (aspect === '4:5') return { aspect, resolution: '1080×1350', width: 1080, height: 1350 };
  return { aspect: '16:9', resolution: '1920×1080', width: 1920, height: 1080 };
}

async function persistResolutionFromInputs(
  ctx: CliContext,
  projectId: string,
  inputs: PhaseInputs,
): Promise<void> {
  const aspect = inputs.collected?.aspect;
  if (!aspect) return;
  const { aspect: normalized, width, height } = resolutionForAspect(aspect);
  const proj = await ctx.projects.load(projectId);
  const current = proj.preferences?.resolution;
  const prevMeta = (proj.preferences as { generationMeta?: Record<string, unknown> } | undefined)?.generationMeta;
  const ratioLabel =
    normalized === '9:16' ? '9:16 竖屏'
      : normalized === '1:1' ? '1:1 方形'
        : normalized === '4:5' ? '4:5 小红书'
          : '16:9 横屏';
  const nextMeta = prevMeta && typeof prevMeta === 'object'
    ? { ...prevMeta, ratio: ratioLabel }
    : prevMeta;
  const resolutionUnchanged = current?.width === width && current?.height === height;
  const metaUnchanged = !nextMeta || (prevMeta as { ratio?: unknown } | undefined)?.ratio === ratioLabel;
  if (resolutionUnchanged && metaUnchanged) return;
  proj.preferences = {
    ...proj.preferences,
    resolution: { width, height },
    ...(nextMeta ? { generationMeta: nextMeta } : {}),
  };
  await ctx.projects.save(proj);
}

function configuredOptionLines(collected: Record<string, string>): string[] {
  const rows: Array<[string, string | undefined]> = [
    ['受众 / audience', collected.audience],
    ['场景 / scene', collected.scene],
    ['语气 / tone', collected.tone],
    ['素材使用方式 / material use', collected.material_use],
    ['行动引导 / CTA', collected.cta],
  ];
  return rows
    .filter(([, value]) => !!String(value || '').trim())
    .map(([label, value]) => `- ${label}: ${value}`);
}

/** A phase reached during post-generation iteration carries postGen=true so the
 * prompt builder re-uses a card but bases the final regeneration on the existing
 * storyboard rather than starting fresh. */
type PhaseResult = { phase: ConvPhase; inputs: PhaseInputs; postGen?: boolean };

function parseConfiguredCreateRequest(text: string): PhaseInputs | undefined {
  const hasCreatePageShape =
    /生成要求\s*[:：]/.test(text) &&
    /(?:内容类型|类型)\s*[:：]/.test(text) &&
    /(?:主题和素材说明|相册标题|图片顺序)\s*[:：]/.test(text);
  if (!hasCreatePageShape) return undefined;

  const pickLine = (label: string): string => {
    const re = new RegExp(`${label}\\s*[:：]\\s*([^\\n。]+)`);
    return re.exec(text)?.[1]?.trim() ?? '';
  };
  const pickedType = pickLine('(?:内容类型|类型)') || '电子相册';
  const pickedStyle = pickLine('风格');
  const aspect = pickLine('(?:比例|画面尺寸|尺寸)');
  const pageCount = /(?:页数\/帧数|页数|帧数)\s*[:：]\s*(\d{1,2})/.exec(text)?.[1];
  const topic =
    /主题和素材说明\s*[:：]\s*([\s\S]*?)\n\s*生成要求\s*[:：]/.exec(text)?.[1]?.trim()
    ?? /相册标题\s*[:：]\s*([\s\S]*?)\n\s*补充说明\s*[:：]/.exec(text)?.[1]?.trim()
    ?? '';
  const audience = pickLine('受众');
  const scene = pickLine('场景');
  const tone = pickLine('语气');
  const materialUse = pickLine('素材使用方式');
  const cta = pickLine('行动引导');

  const collected: Record<string, string> = {};
  if (aspect) collected.aspect = aspect;
  if (audience) collected.audience = audience;
  if (scene) collected.scene = scene;
  if (tone) collected.tone = tone;
  if (materialUse) collected.material_use = materialUse;
  if (cta) collected.cta = cta;

  if (/单帧|单画面|标题卡|封面|logo|title.?card|single.?frame|cover|still/i.test(pickedType)) {
    collected.frame_count = '1';
    collected.duration = '5';
  } else if (pageCount) {
    collected.frame_count = pageCount;
    collected.per_frame = '4';
  }

  const details = [
    topic ? `主题和素材说明：${topic}` : '',
    audience ? `受众：${audience}` : '',
    scene ? `场景：${scene}` : '',
    tone ? `语气：${tone}` : '',
    materialUse ? `素材使用方式：${materialUse}` : '',
    cta ? `行动引导：${cta}` : '',
    pageCount ? `页数/帧数：${pageCount}` : '',
  ].filter(Boolean).join('；');

  const inputs: PhaseInputs = {
    collected,
    pickedType,
    contentTurns: [details || text],
  };
  if (pickedStyle) inputs.pickedStyle = pickedStyle;
  return inputs;
}

function detectPhase(
  history: ChatMessage[],
  userText: string,
  hasTemplate: boolean,
  hasSourceMaterial = false,
  focusFrameId = '',
  hasGeneratedPreview = false,
): PhaseResult {
  const trimmed = userText.trim();
  const inputs: PhaseInputs = {};
  const generated = hasGeneratedPreview || hadGenerationYet(history);

  // Explicit markers always win.
  if (trimmed.startsWith('[hv-form:submit]')) {
    const body = trimmed.slice('[hv-form:submit]'.length).trim();
    try { inputs.collected = JSON.parse(body); } catch { /* ignore */ }
    return { phase: 'confirm', inputs };
  }
  if (trimmed === '[hv-confirm:generate]') {
    inputs.collected = lastFormSubmission(history);
    inputs.pickedType = lastCardPickByPhase(history, 'type');
    inputs.pickedStyle = lastCardPickByPhase(history, 'style') ?? '';
    inputs.contentTurns = collectContentTurns(history);
    return { phase: 'generate', inputs };
  }
  if (trimmed === '[hv-confirm:edit]') {
    inputs.collected = lastFormSubmission(history);
    return { phase: 'format-edit', inputs };
  }

  // Free-text format reply rescue (issue #2): if the previous assistant turn
  // was asking for format params (whether it rendered the hv-form card or — as
  // the model sometimes does — just asked in prose), and this user turn parses
  // as a format answer, treat it like a card submit and advance to confirm.
  // This stops the loop where a typed "16:9 横屏 / 5s / 10" goes unrecognised
  // and the flow re-asks the same params in a different shape.
  if (!generated && lastAssistantAskedFormat(history)) {
    const parsed = parseFormatReply(trimmed);
    if (parsed) {
      // Merge over any earlier card submit so partial typed answers keep
      // the defaults the user already had.
      inputs.collected = { ...(lastFormSubmission(history) ?? {}), ...parsed };
      return { phase: 'confirm', inputs };
    }
  }

  if (generated) {
    const previousFormat = lastFormSubmission(history);
    if (previousFormat) inputs.collected = previousFormat;
    const pinned = !!focusFrameId;
    if (pinned) {
      return { phase: 'iterate', inputs };
    }

    inputs.pickedType = lastCardPickByPhase(history, 'type');
    if (/style|template|brutal|cyber|swiss|\u98ce\u683c|\u6837\u5f0f|\u914d\u8272|\u89c6\u89c9|\u4e3b\u9898\u8272|\u6a21\u677f/i.test(trimmed)) {
      inputs.pickedStyle = trimmed;
      return { phase: 'restyle', inputs, postGen: true };
    }

    inputs.pickedStyle = lastCardPickByPhase(history, 'style') ?? '';
    inputs.contentTurns = [...collectContentTurns(history), trimmed].filter((s) => !isControlPhrase(s));
    return { phase: 'iterate-content', inputs, postGen: true };
  }

  // Post-generation iteration. Previously ANY message after a generation was
  // forced to phase 'iterate', which only ever did a vague single-frame rewrite
  // of preview.html — so "换个风格" / "改内容" looked like nothing happened
  // (the user's recurring "后面的指令好像都没用了"). Instead, run a small
  // card-driven sub-flow: a vague "改一下" pops an edit-menu (change style /
  // content / duration); picking an option re-uses the existing style / content
  // / format cards; the final regeneration is based on the existing storyboard.
  if (hadGenerationYet(history)) {
    const last = lastAssistantCardWithMeta(history);
    // Mid-iteration: the user is answering one of the edit sub-flow cards.
    if (last?.metaPhase === 'edit-menu') {
      // Route the menu choice. Match by label keywords (works for clicks, which
      // send the option label, and for free text).
      if (/风格|style|视觉|配色|换个?样子/i.test(trimmed)) {
        inputs.pickedType = lastCardPickByPhase(history, 'type');
        return { phase: 'style', inputs, postGen: true };
      }
      if (/时长|时间|duration|长度|快|慢|秒|节奏/i.test(trimmed)) {
        inputs.pickedType = lastCardPickByPhase(history, 'type');
        return { phase: 'format', inputs, postGen: true };
      }
      // default / "内容 / content / 文案 / 主题 / 重写"
      inputs.pickedType = lastCardPickByPhase(history, 'type');
      inputs.contentTurns = collectContentTurns(history);
      return { phase: 'content', inputs, postGen: true };
    }
    // The user is answering a re-shown card during iteration.
    if (last?.metaPhase === 'style') {
      inputs.pickedType = lastCardPickByPhase(history, 'type');
      inputs.pickedStyle = trimmed;
      return { phase: 'restyle', inputs, postGen: true };
    }
    if (last?.metaPhase === 'format' || last?.kind === 'hv-form') {
      inputs.collected = lastFormSubmission(history);
      return { phase: 'iterate-format', inputs, postGen: true };
    }
    if (last?.kind === 'content-question') {
      inputs.pickedType = lastCardPickByPhase(history, 'type');
      inputs.contentTurns = [...collectContentTurns(history), trimmed];
      return { phase: 'iterate-content', inputs, postGen: true };
    }
    // A fresh post-generation instruction. The DEFAULT is the card-driven
    // sub-flow, not a single-frame rewrite — a whitelist of trigger phrases was
    // the bug (e.g. "换个模板重新生成一下" didn't match and silently fell back to
    // a no-op preview rewrite). So:
    //   - pinned frame  → single-frame iterate (the user explicitly scoped it).
    //   - clearly names style / content / duration → jump straight there.
    //   - everything else (incl. vague "改一下" / "换个模板" / "重新生成") → pop
    //     the edit-menu and ask, rather than guess or no-op.
    const pinned = !!focusFrameId;
    if (pinned) {
      return { phase: 'iterate', inputs: { collected: lastFormSubmission(history) } };
    }
    // Direct shortcuts when the instruction is unambiguous about WHAT to change.
    if (/风格|样式|配色|视觉|主题色|模板|template|style|换个?样子|赛博|极简|杂志|brutal|cyber|swiss/i.test(trimmed)) {
      inputs.pickedType = lastCardPickByPhase(history, 'type');
      return { phase: 'style', inputs, postGen: true };
    }
    if (/时长|时间|duration|时间长度|节奏|快一点|慢一点|更短|更长|多少秒/i.test(trimmed)) {
      inputs.pickedType = lastCardPickByPhase(history, 'type');
      return { phase: 'format', inputs, postGen: true };
    }
    if (/文案|内容|主题|改成|换成|重写|讲|介绍|加.{0,4}(信息|数据|卖点)|text|content|rewrite/i.test(trimmed)) {
      inputs.pickedType = lastCardPickByPhase(history, 'type');
      inputs.contentTurns = [...collectContentTurns(history), trimmed].filter((s) => !isControlPhrase(s));
      return { phase: 'iterate-content', inputs, postGen: true };
    }
    // Default: ask via the edit-menu (never silently no-op).
    return { phase: 'edit-menu', inputs };
  }

  // Walk backwards; what was the most recent CARD with a meta.phase tag?
  // (Skip empty / warning assistant turns.)
  const prev = lastAssistantCardWithMeta(history);

  if (!prev) {
    const configured = parseConfiguredCreateRequest(trimmed);
    if (configured) return { phase: 'generate', inputs: configured };

    // No prior card → opener.
    return { phase: 'opener', inputs };
  }

  // Last card was an opener type-pick → user just answered with their type.
  if (prev.kind === 'hv-options' && prev.metaPhase === 'type') {
    inputs.pickedType = trimmed;
    // With source material already attached, there is nothing more to collect —
    // the article/repo IS the content. Skip the content-question step (which
    // otherwise stalls: the agent emits a statement, not an interactive card,
    // and the flow waits forever for a user reply that never comes) and go
    // straight to format (if a template is picked) or style.
    if (hasSourceMaterial) {
      inputs.contentTurns = collectContentTurns(history);
      return hasTemplate
        ? { phase: 'format', inputs }
        : { phase: 'style', inputs };
    }
    return { phase: 'content', inputs };
  }

  // Last card was a style-pick → user answered with style choice.
  if (prev.kind === 'hv-options' && prev.metaPhase === 'style') {
    inputs.pickedType = lastCardPickByPhase(history, 'type');
    inputs.pickedStyle = trimmed;
    inputs.contentTurns = collectContentTurns(history);
    // "从设计模板选" but no template actually picked → don't silently fall back
    // to a default look; ask the user to pick one (top-bar) or choose a style.
    if (isFromTemplateStyle(trimmed) && !hasTemplate) {
      return { phase: 'need-template', inputs };
    }
    return { phase: 'format', inputs };
  }

  // User was told to pick a template (need-template card is an hv-options).
  if (prev.kind === 'hv-options' && prev.metaPhase === 'need-template') {
    inputs.pickedType = lastCardPickByPhase(history, 'type');
    inputs.contentTurns = collectContentTurns(history);
    // Picked a built-in style instead → use it.
    if (!isFromTemplateStyle(trimmed) && !/^我已选好模板|继续|done|ready|next$/i.test(trimmed)) {
      inputs.pickedStyle = trimmed;
      return { phase: 'format', inputs };
    }
    // Said "I've picked one / continue": proceed only if a template is now set.
    if (hasTemplate) {
      inputs.pickedStyle = '从设计模板选';
      return { phase: 'format', inputs };
    }
    return { phase: 'need-template', inputs }; // still none → ask again
  }

  // Last card was content-question (a plain assistant message asking for content).
  // We detect this by phase metadata in a hidden HTML comment we embed.
  if (prev.kind === 'content-question') {
    // User is replying to content question. Could be (a) more content, or
    // (b) a "skip / I'm done" signal.
    const isSkip = /^(skip|跳过|够了|够|done|next|下一步|ok|好|不知道)$/i.test(trimmed)
      || trimmed.length <= 3;
    // "Free rein" answers — the user is handing the subject's details to the
    // agent ("随便生成 / 随便发挥 / 你定 / 都行 / 随机"). These should advance the
    // flow (and pop the style card) just like a skip, instead of being treated
    // as more content to collect — which left the user stuck re-typing "风格选择".
    // Substring match (not anchored) with a length guard so it doesn't swallow a
    // real sentence that merely contains "随便".
    const isFreeRein =
      trimmed.length <= 16 &&
      /(随便|随机|随意|你定|你来定|你决定|都行|都可以|看着办|自由发挥|发挥|无所谓|任意|随你)/.test(trimmed);
    // With source material attached there's nothing to collect — advance as
    // soon as the user says anything (the article already is the content).
    if (isSkip || isFreeRein || hasSourceMaterial || hasEnoughContent(history, trimmed)) {
      // Move forward: style if no template, else format.
      inputs.pickedType = lastCardPickByPhase(history, 'type');
      inputs.contentTurns = [...collectContentTurns(history), trimmed];
      return hasTemplate
        ? { phase: 'format', inputs }
        : { phase: 'style', inputs };
    }
    // Continue chatting (still in content phase).
    inputs.pickedType = lastCardPickByPhase(history, 'type');
    inputs.contentTurns = [...collectContentTurns(history), trimmed];
    return { phase: 'content', inputs };
  }

  // Default fallback: treat as iterate.
  inputs.collected = lastFormSubmission(history);
  return { phase: 'iterate', inputs };
}

/** Heuristic: how many content turns has the user given. Beyond 2 we move on. */
function hasEnoughContent(history: ChatMessage[], pending: string): boolean {
  const turns = collectContentTurns(history);
  return turns.length >= 2 || (turns.length >= 1 && pending.length > 60);
}

/** Find the most recent assistant card with a meta.phase, plus its kind. */
function lastAssistantCardWithMeta(history: ChatMessage[]): {
  kind: 'hv-options' | 'hv-form' | 'hv-confirm' | 'content-question';
  metaPhase: string | null;
} | null {
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i]!;
    if (m.role !== 'assistant') continue;
    const c = m.content;
    if (!c.trim() || /^⚠️/.test(c.trim())) continue;
    // Try each card kind, JSON-parse the body, look for meta.phase.
    const cards: { kind: 'hv-options' | 'hv-form' | 'hv-confirm'; re: RegExp }[] = [
      { kind: 'hv-confirm', re: /```hv-confirm\s*\n([\s\S]*?)```/i },
      { kind: 'hv-form',    re: /```hv-form\s*\n([\s\S]*?)```/i },
      { kind: 'hv-options', re: /```hv-options\s*\n([\s\S]*?)```/i },
    ];
    for (const { kind, re } of cards) {
      const match = re.exec(c);
      if (match && match[1]) {
        let metaPhase: string | null = null;
        try {
          const parsed = JSON.parse(match[1].trim());
          metaPhase = parsed?.meta?.phase ?? null;
        } catch { /* unparseable card body — treat as untagged */ }
        return { kind, metaPhase };
      }
    }
    // No card → was this a content-question? Look for our marker.
    if (/<!--\s*hv-phase:content-question\s*-->/i.test(c)) {
      return { kind: 'content-question', metaPhase: 'content' };
    }
    // A real assistant turn with no card and no marker — bail.
    return null;
  }
  return null;
}

/** Look back for the user message that answered an hv-options card with meta.phase=X. */
function lastCardPickByPhase(history: ChatMessage[], phase: string): string | undefined {
  for (let i = 0; i < history.length - 1; i++) {
    const a = history[i]!;
    const u = history[i + 1]!;
    if (a.role !== 'assistant' || u.role !== 'user') continue;
    const m = /```hv-options\s*\n([\s\S]*?)```/i.exec(a.content);
    if (!m || !m[1]) continue;
    try {
      const parsed = JSON.parse(m[1].trim());
      if (parsed?.meta?.phase === phase) return u.content.trim();
    } catch { /* ignore */ }
  }
  return undefined;
}

/** All free-text user replies during the content phase (between type-pick and style/format). */
/** A short user turn that just nudges the flow forward ("continue", "go",
 *  "下一步", "开始生成") rather than supplying video content. Such turns must
 *  not be collected as content — otherwise they end up as on-screen text. */
function isControlPhrase(t: string): boolean {
  const s = t.trim().toLowerCase().replace(/[。.!！~\s]+$/u, '');
  if (s.length > 12) return false; // real content is longer; keep it
  return /^(继续|继续(刚刚|上次|之前)的?任务|接着|接着(来|做|生成)|下一步|开始(生成)?|生成(吧)?|go|continue|next|start|ok|好的?|行|走|动手|可以|确认)$/u.test(s);
}

function collectContentTurns(history: ChatMessage[]): string[] {
  const out: string[] = [];
  let inContent = false;
  for (let i = 0; i < history.length; i++) {
    const m = history[i]!;
    if (m.role === 'assistant') {
      const c = m.content;
      // Type pick assistant card opens content phase
      const typeMatch = /```hv-options\s*\n([\s\S]*?)```/i.exec(c);
      if (typeMatch && typeMatch[1]) {
        try {
          const parsed = JSON.parse(typeMatch[1].trim());
          if (parsed?.meta?.phase === 'type') { inContent = true; continue; }
          if (parsed?.meta?.phase === 'style') { inContent = false; continue; }
        } catch { /* ignore */ }
      }
      if (/```hv-form\s*\n/i.test(c)) inContent = false;
      continue;
    }
    if (m.role !== 'user') continue;
    if (!inContent) continue;
    const t = m.content.trim();
    if (!t) continue;
    if (t.startsWith('[hv-')) continue; // skip marker messages
    // Skip control phrases ("continue / next / go / 开始生成 …"). These are the
    // user nudging the flow forward, NOT video content — otherwise e.g.
    // "继续刚刚的任务" gets baked in as the opening frame's headline.
    if (isControlPhrase(t)) continue;
    // Skip the "trimmed answer" that picks the type — it's the first user turn
    // immediately after the type card; keep only later ones.
    if (out.length === 0) {
      // The very first user turn after a type card IS the type pick. Skip it.
      // (Subsequent turns in content phase get collected.)
      out.push('__TYPE_PICK__');
      continue;
    }
    out.push(t);
  }
  return out.filter((t) => t !== '__TYPE_PICK__');
}

/**
 * The video's LOCKED subject, in the user's own words. The opening message
 * ("帮我生成一个关于 Open Design 的介绍视频") names the subject, but it never
 * reached the generate / storyboard prompts: collectContentTurns() only keeps
 * turns after the type-pick card, so a later vague answer like "随机" became the
 * entire content input and the video came out about randomness instead of Open
 * Design. This recovers the opening subject so every downstream prompt can lock
 * onto it.
 *
 * Prefer the persisted project.intent, but the studio UI creates projects with
 * a name only (intent is almost always empty), so fall back to the first user
 * message in history — which is the genuine opening request. Strip the
 * attachment summary suffix appended to message content.
 */
function resolveOpeningTopic(project: { intent?: string }, history: ChatMessage[]): string {
  const fromIntent = project.intent?.trim();
  if (fromIntent) return fromIntent.slice(0, 200);
  const firstUser = history.find((m) => m.role === 'user')?.content ?? '';
  const clean = (firstUser.split('\n\n📎')[0] ?? '').trim();
  // Don't lock onto a bare control phrase ("继续" / "ok") if that's somehow first.
  if (!clean || isControlPhrase(clean)) return '';
  return clean.slice(0, 200);
}

// Legacy helper retained for backward calls — now delegates to detectPhase's
// metadata-aware lookup.
function lastAssistantCardKind(history: ChatMessage[]): 'hv-options' | 'hv-form' | 'hv-confirm' | null {
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i]!;
    if (m.role !== 'assistant') continue;
    if (/```hv-confirm\s*\n/i.test(m.content)) return 'hv-confirm';
    if (/```hv-form\s*\n/i.test(m.content)) return 'hv-form';
    if (/```hv-options\s*\n/i.test(m.content)) return 'hv-options';
    // Skip empty / warning-only assistant turns — the live card is one further back.
    if (!m.content.trim()) continue;
    if (/^⚠️/.test(m.content.trim())) continue;
    // A real assistant message with no card resets the search.
    return null;
  }
  return null;
}

function lastFormSubmission(history: ChatMessage[]): Record<string, string> | undefined {
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i]!;
    if (m.role !== 'user') continue;
    const match = /^\[hv-form:submit\]\s*\n([\s\S]+)$/.exec(m.content.trim());
    if (match && match[1]) {
      try { return JSON.parse(match[1]); } catch { /* keep scanning */ }
    }
  }
  return undefined;
}

/** Has a successful generation already happened in this conversation? */
function hadGenerationYet(history: ChatMessage[]): boolean {
  // Only count a real storyboard/video generation, not any assistant turn that
  // happens to contain a "✓". The old broad check (`✓\s`) matched the persisted
  // summary lines of the iteration sub-flow itself, so once you'd generated, the
  // flow could never leave 'iterate'. Look for concrete generation markers.
  return history.some(
    (m) =>
      m.role === 'assistant' &&
      /```json#content-graph|故事板规划完成|storyboard (generated|regenerated|restyled)|帧完成|frame .* (done|完成)/i.test(m.content),
  );
}

/**
 * Was the most recent assistant turn asking the user for format params
 * (aspect / duration / frame count)? True for the proper `hv-form` card AND
 * for the prose fallback the model sometimes emits instead. Used to decide
 * whether a free-text user reply should be parsed as a format answer.
 */
function lastAssistantAskedFormat(history: ChatMessage[]): boolean {
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i]!;
    if (m.role !== 'assistant') continue;
    const c = m.content;
    if (!c.trim() || /^⚠️/.test(c.trim())) continue; // skip empty / warning turns
    // The real hv-form card.
    const form = /```hv-form\s*\n([\s\S]*?)```/i.exec(c);
    if (form?.[1]) {
      try { return JSON.parse(form[1].trim())?.meta?.phase === 'format'; } catch { return true; }
    }
    // Prose fallback: the turn talks about size/duration/frames without a card.
    // Require at least two of the three concepts so an unrelated mention of
    // "时长" elsewhere doesn't trigger it.
    const hits = [/尺寸|横屏|竖屏|方形|aspect|比例/i, /时?长|秒|duration|\bs\b/i, /帧|frames?/i]
      .filter((re) => re.test(c)).length;
    return hits >= 2;
  }
  return false;
}

/**
 * Best-effort parse of format params from a FREE-TEXT user reply.
 *
 * The format step is supposed to render an `hv-form` card (segmented buttons)
 * whose submit carries an explicit `[hv-form:submit]` marker. But the model
 * sometimes ignores that instruction and instead asks for the params in prose
 * ("9:16 竖屏 / 3s / 6 …"); the user then types the answer free-form, with no
 * marker. Without this parser the state machine can't tell the params were
 * already given, so it loops — re-asking the same thing in a different shape
 * (issue #2). We extract aspect / duration / frame_count heuristically so a
 * typed reply is treated the same as a card submit.
 *
 * Returns undefined when the text carries no recognisable format signal, so
 * callers can fall through to other phase logic.
 */
export function parseFormatReply(text: string): Record<string, string> | undefined {
  const t = text.trim();
  if (!t || t.length > 80) return undefined; // long text is content, not a format answer
  const out: Record<string, string> = {};

  // --- aspect: explicit ratio (16:9 / 9:16 / 1:1 / 4:5) or a keyword ---
  const ratio = /\b(16\s*[:：]\s*9|9\s*[:：]\s*16|1\s*[:：]\s*1|4\s*[:：]\s*5)\b/.exec(t);
  const ratioNorm = ratio?.[1]?.replace(/\s/g, '').replace('：', ':');
  if (ratioNorm === '16:9' || /横屏|landscape|宽屏/i.test(t)) out.aspect = '16:9 横屏';
  else if (ratioNorm === '9:16' || /竖屏|手机|portrait|vertical/i.test(t)) out.aspect = '9:16 手机竖屏';
  else if (ratioNorm === '1:1' || /方形|square/i.test(t)) out.aspect = '1:1 方形';
  else if (ratioNorm === '4:5' || /小红书|xiaohongshu|rednote/i.test(t)) out.aspect = '4:5 小红书';

  // --- duration: a number directly tied to seconds (5s / 5秒 / 5 sec) ---
  const dur = /(\d{1,3})\s*(?:s\b|秒|sec)/i.exec(t);
  if (dur?.[1]) out.duration = dur[1];

  // --- frame_count: a number tied to 帧/frame, or the lone trailing number in
  //     a "a / b / c" triple where a=ratio, b=duration. ---
  const fr = /(\d{1,2})\s*(?:帧|frames?)\b/i.exec(t);
  if (fr?.[1]) out.frame_count = fr[1];
  else {
    // "16:9 横屏 / 5s / 10" — after stripping ratio+duration tokens, a bare
    // small integer left over is the frame count.
    const parts = t.split(/[/、,，]+/).map((s) => s.trim()).filter(Boolean);
    if (parts.length >= 2) {
      const last = parts[parts.length - 1]!;
      const bare = /^(\d{1,2})\s*帧?$/.exec(last);
      if (bare?.[1] && !/[:：s秒]/.test(last)) out.frame_count = bare[1];
    }
  }

  // Need at least one positively-identified signal to count as a format reply.
  return Object.keys(out).length > 0 ? out : undefined;
}

function lastTypePick(history: ChatMessage[]): string | undefined {
  // The first user turn that immediately follows the opener hv-options card.
  for (let i = 0; i < history.length - 1; i++) {
    const a = history[i]!;
    const u = history[i + 1]!;
    if (a.role === 'assistant' && u.role === 'user' && /```hv-options\s*\n/i.test(a.content)) {
      return u.content.trim();
    }
  }
  return undefined;
}

/**
 * Render one attachment for the prompt. Text sources with inlined content get
 * their actual content fenced inline (so HTTP agents that can't read local
 * disk still see it); binary/path-only attachments stay a one-line reference.
 */
function renderAttachment(a: Attachment): string[] {
  if (a.inlineText) {
    return [
      `- [${a.kind}] ${a.filename} — full content below:`,
      '```',
      a.inlineText,
      '```',
    ];
  }
  const rows = [`- [${a.kind}] ${a.filename} — ${a.path}`];
  if (a.path && (a.kind === 'image' || a.kind === 'video' || a.kind === 'audio')) {
    const assetUrl = /^https?:\/\//i.test(a.path) ? a.path : `/asset?path=${encodeURIComponent(a.path)}`;
    rows.push(`  Browser URL for HTML src/href: ${assetUrl}`);
    rows.push(`  IMPORTANT: when embedding this asset in generated HTML, use the Browser URL above exactly. Do not use the local filesystem path and do not use only the filename.`);
  }
  return rows;
}

/** A design.md / frame.md / DESIGN.md attachment is a brand + motion SPEC the
 *  video must FOLLOW (palette, type, tokens, pacing/scale/dwell/motion), not
 *  content to be narrated. Detect by filename or by the spec's tell-tale
 *  headings, so users can drop in a design.md (portable design system) or
 *  HeyGen-style frame.md (motion spec). */
function isDesignSpec(a: Attachment): boolean {
  const name = (a.filename || '').toLowerCase();
  if (/(^|\/)(design|frame)\.md$/.test(name) || /\bframe\.md\b|\bdesign\.md\b/.test(name)) return true;
  const txt = a.inlineText ?? '';
  if (!txt) return false;
  // Heading/section fingerprints shared by design.md & frame.md specs.
  return /#\s*(design|frame)\s*[—\-]/i.test(txt)
    || /(^|\n)##\s*(System|Theme|Tokens|Motion|Pacing|Composition)\b/i.test(txt)
    || /\b(pacing|dwell)\b.*\b(scale|motion)\b/i.test(txt);
}

/** Split attachments into design/motion specs vs ordinary source material. */
function partitionAttachments(atts: Attachment[]): { specs: Attachment[]; content: Attachment[] } {
  const specs: Attachment[] = [];
  const content: Attachment[] = [];
  for (const a of atts) (a.inlineText && isDesignSpec(a) ? specs : content).push(a);
  return { specs, content };
}

/** Prompt block telling the agent to OBEY a design/frame spec. */
function renderDesignSpecBlock(specs: Attachment[]): string[] {
  if (!specs.length) return [];
  const out: string[] = [
    `DESIGN SYSTEM / MOTION SPEC (REQUIRED — obey this for every frame): the file(s)`,
    `below define the brand's visual + motion language. Honour their palette,`,
    `typography, tokens, layout AND any motion direction (pacing, scale, dwell,`,
    `motion) over your own defaults. This is HOW the video must look/move; the`,
    `actual subject still comes from the user's content.`,
  ];
  for (const a of specs) {
    out.push(`--- ${a.filename} ---`);
    out.push((a.inlineText ?? '').slice(0, 6000));
  }
  out.push('');
  return out;
}

/** LLMs emit not-quite-valid JSON for the content-graph more often than not:
 *  trailing commas, and (now that we ask them to quote article terms) stray
 *  straight double-quotes inside string values. Try strict parse first, then
 *  escalate through cheap, safe repairs before giving up. */
function parseGraphJsonTolerant(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    /* fall through to repairs */
  }
  // 1) Strip trailing commas before } or ] — the most common LLM slip.
  const noTrailing = raw.replace(/,(\s*[}\]])/g, '$1');
  try {
    return JSON.parse(noTrailing);
  } catch {
    /* fall through */
  }
  // 2) Escape stray straight double-quotes inside synopsis/text string values
  //    (e.g. text: "the "harness" idea"). Operate on the trailing-comma-cleaned
  //    text; for each "<key>": "<value>" pair, re-escape any bare " in <value>.
  const repaired = noTrailing.replace(
    /("(?:synopsis|text)"\s*:\s*")([\s\S]*?)("\s*(?:,|\}|\]))/g,
    (_m, pre: string, val: string, post: string) =>
      pre + val.replace(/\\?"/g, '\\"') + post,
  );
  return JSON.parse(repaired); // if this still throws, caller reports it
}

/** A content type is multi-frame UNLESS it's an explicitly single-frame kind
 *  (title card / cover / single still). Whitelisting "讲解/explainer/…" was too
 *  narrow — e.g. "概念解说短片" (解说, not 讲解) fell through to single-frame.
 *  Inverting the test makes new/renamed multi-frame types default correctly. */
function isMultiFrameType(pickedType: string): boolean {
  if (!pickedType) return false;
  if (isAlbumType(pickedType)) return false;
  const single = /单帧|单画面|标题卡|封面|logo|title.?card|single.?frame|cover|still/i.test(pickedType);
  return !single;
}

function isAlbumType(text: string): boolean {
  return /电子相册|相册|画册|照片集|photo\s*album|photobook|photo\s*book|album|gallery|scroll\s*story/i.test(text);
}

function looksLikeAlbumHtml(html: string): boolean {
  return /ALBUM-SCROLL-STORY|album-scroll-story|scroll-snap-type|data-album-page|albumPage|photo\s*album|electronic\s*album/i.test(html);
}

function buildStylePhasePrompt(pickedType: string): string {
  const p: string[] = [];
  p.push(`The user has shared their content for a "${pickedType}". Now ask them about visual style with ONE hv-options card. JSON shape EXACTLY as shown — keep "meta" verbatim:`);
  p.push('```hv-options');
  p.push(JSON.stringify({
    meta: { phase: 'style' },
    question: '视觉风格怎么定？',
    options: [
      { label: 'Cyberpunk glitch',    hint: '霓虹 / 故障感 / 高对比' },
      { label: 'Swiss minimalist',    hint: '网格 / 无衬线 / 留白' },
      { label: 'Warm-grain magazine', hint: '纸感 / 衬线 / 暖色' },
      { label: 'Mono brutalist',      hint: '黑白 / 块状 / 粗体' },
      { label: '从设计模板选',        hint: '上方挑一个现成模板' },
    ],
    allow_freeform: true,
  }, null, 2));
  p.push('```');
  p.push('');
  p.push(`Add ONE short sentence above the card in the user's language inviting them to pick or describe a vibe. Mention they can also upload a reference image via the 📎 button.`);
  p.push('');
  p.push(`Do NOT write HTML this turn. Do NOT return an empty reply.`);
  return p.join('\n');
}

function buildHtmlGenerationPrompt(args: BuildPromptArgs): string {
  const { tmpl, exampleHtml, priorHtml, history, userText, attachments, openingTopic, hasGeneratedPreview } = args;

  // When a template is selected, its own source HTML is the style ground truth —
  // NOT a prior render. Otherwise a project that was previously rendered in some
  // other look would keep feeding that stale look back in as "the style to draw
  // from", and the freshly-picked template gets ignored. Only fall back to
  // priorHtml (iterate-on-last-render) when no template is in play.
  const baseHtml = tmpl
    ? exampleHtml
    : (priorHtml && priorHtml !== exampleHtml ? priorHtml : exampleHtml);
  const trimmed = userText.trim();
  // A fetched article / repo / uploaded doc carries inlined content — that IS
  // the topic, so we should not interrogate the user about what the video is
  // about. The source rides into every phase's prompt via `attachments`.
  const hasSourceMaterial = attachments.some((a) => !!a.inlineText);
  const { phase, inputs } = detectPhase(history, userText, !!tmpl, hasSourceMaterial, args.focusFrameId ?? '', !!hasGeneratedPreview);
  const isAlbumIteration =
    !!hasGeneratedPreview &&
    !args.focusFrameId &&
    (
      isAlbumType(inputs.pickedType ?? '') ||
      tmpl?.id === 'album-scroll-story' ||
      isAlbumType(openingTopic ?? '') ||
      looksLikeAlbumHtml(baseHtml ?? '')
    );

  // ---- edit-menu: post-generation "what do you want to change?" card ----
  if (phase === 'edit-menu') {
    const em: string[] = [];
    em.push(`The user wants to change the already-generated video but hasn't said what. Reply with ONE short line in their language asking what to change, then ONE fenced \`\`\`hv-options block. Use this EXACT JSON — keep "meta" verbatim:`);
    em.push('```hv-options');
    em.push(JSON.stringify({
      meta: { phase: 'edit-menu' },
      question: '想改哪方面？',
      options: [
        { label: '🎨 换风格', hint: '保留内容，换一套视觉风格' },
        { label: '✏️ 改内容', hint: '改文案 / 主题 / 重写脚本' },
        { label: '⏱️ 改时长', hint: '调整每帧时长 / 节奏' },
      ],
      allow_freeform: true,
    }, null, 2));
    em.push('```');
    em.push('');
    em.push(`Do NOT write HTML this turn. Do NOT return an empty reply. The hv-options block is REQUIRED.`);
    return em.join('\n');
  }

  // ---- opener: hv-options card with meta.phase = "type" ----
  if (phase === 'opener') {
    const opener: string[] = [];
    opener.push(
      `The user just opened a project and said "${trimmed}". You are an HTML-video creation assistant.`,
    );
    opener.push('');
    opener.push(`Reply with TWO things, in this exact order:`);
    opener.push(`1. ONE friendly opening sentence in the user's language (≤ 25 chars).`);
    opener.push(`2. A fenced \`\`\`hv-options block with the 5 content-type choices below. JSON shape EXACTLY as shown — do not change keys or omit "meta":`);
    opener.push('```hv-options');
    opener.push(JSON.stringify({
      meta: { phase: 'type' },
      question: '想做哪种内容？',
      options: [
        { label: '单帧标题卡',   hint: 'logo / 封面 / 单画面 - 5-10s' },
        { label: '多帧预告片',   hint: '产品 / 活动 teaser, 3-6 帧' },
        { label: '数据大字报',   hint: '1-2 个核心数字, 社媒爆款风' },
        { label: '电子相册',     hint: 'HTML / 图片 / 素材变成可下滑浏览的交互相册' },
        { label: '概念解说短片', hint: '几帧讲清一个 idea / feature' },
      ],
      allow_freeform: true,
    }, null, 2));
    opener.push('```');
    opener.push('');
    if (tmpl) {
      opener.push(
        `Note: a template "${tmpl.name}" is currently selected (${tmpl.description}). Treat it as a visual style reference only — content type still drives the structure.`,
      );
      opener.push('');
    }
    opener.push(`Do NOT write HTML this turn. Do NOT return an empty reply. The hv-options block is REQUIRED.`);
    return opener.join('\n');
  }

  // ---- content: free chat asking about topic / headline / data ----
  if (phase === 'content') {
    const pickedType = inputs.pickedType ?? '';
    const turns = inputs.contentTurns ?? [];
    const p: string[] = [];

    // Source material present → DON'T interrogate. The article/repo content is
    // the topic; acknowledge it and let the flow advance to style/format.
    if (hasSourceMaterial) {
      p.push(`The user is making a ${pickedType ? `"${pickedType}"` : 'video'} based on the source material below — do NOT ask them what it's about, the content is already provided.`);
      p.push('');
      for (const a of attachments) p.push(...renderAttachment(a));
      p.push('');
      p.push(`In the user's language, write ONE short line that names the actual topic/title you read from the source and states the video will be built from it (e.g. "好，我读完了《…》这篇文章 — 这就基于它生成。下一步选风格。"). Do NOT ask the user to retype or summarize anything. End with this hidden marker on its own line:`);
      p.push('<!-- hv-phase:content-question -->');
      p.push('');
      p.push(`Plain text + the marker only. NO code blocks. NO questions. Do NOT return an empty reply.`);
      return p.join('\n');
    }

    p.push(`The user is making a ${pickedType ? `"${pickedType}"` : 'video'}. Collect concrete content for it via natural conversation — DO NOT emit any code block, hv-options, hv-form, or hv-confirm. End your reply with this hidden marker on its own line so the server knows you're still in the content phase:`);
    p.push('<!-- hv-phase:content-question -->');
    p.push('');
    p.push(`Goal: surface what the video is ABOUT (topic, brand / project name, headline / tagline, key numbers or data points). The user can answer, partially answer, or say "随便发挥 / skip / 不知道" — accept whatever they give and move on.`);
    p.push('');
    // The user's opening request already names the subject (e.g. "做一个 Open
    // Design 推广视频"). Lock onto it: don't let a vague follow-up answer like
    // "随机/随便/anything" silently become a literal NEW topic — that's how a
    // "promote Open Design" request turned into a probability explainer.
    {
      const openingTopic = history.find((m) => m.role === 'user')?.content?.trim().slice(0, 200);
      if (openingTopic) {
        p.push(`The user's ORIGINAL opening request was: "${openingTopic}". Treat this as the LOCKED subject of the video unless the user clearly asks to change it.`);
        p.push(`If the user's answer this turn CONTRADICTS or seems unrelated to that subject (e.g. they opened with a product/brand video but now answer with an off-topic word), do NOT silently switch topics. Ask ONE short clarifying question: keep the original subject (with the new word as a detail/example/angle), or genuinely change the subject? Treat vague answers like "随机 / 随便 / anything / 你定 / whatever" as "you decide the details, KEEP the original subject" — never as a literal new topic.`);
        p.push('');
      }
    }
    if (turns.length === 0) {
      p.push(`This is the first content turn. Ask 1–3 short, sharp questions, in the user's language. Keep it under 60 words. Mention they can answer fully, partially, or just say "skip" / "随便".`);
    } else {
      p.push(`The user has already shared:`);
      for (const t of turns) p.push(`  - ${t.slice(0, 200)}`);
      p.push('');
      p.push(`Two options:`);
      p.push(`- If you still need more info: ask ONE clarifying question and end your reply with the marker on its own line: <!-- hv-phase:content-question -->`);
      p.push(`- If you have enough: write ONLY a one-line confirmation in the user's language (e.g. "好，我有思路了，下一步是风格。" / "Got it. Next: style."). Do NOT add the marker — the server will advance to style automatically.`);
    }
    p.push('');
    p.push(`Reply in plain text. NO code blocks. Do NOT return an empty reply.`);
    return p.join('\n');
  }

  // ---- style: hv-options card with style presets + "pick template" + freeform ----
  if (phase === 'style') {
    return buildStylePhasePrompt(inputs.pickedType ?? '');
  }

  // ---- need-template: user chose "from design template" but hasn't picked one
  if (phase === 'need-template') {
    const p: string[] = [];
    p.push(`The user chose "从设计模板选" (use a design template) but has NOT selected a template yet. Do NOT generate. Tell them — in their language, ONE short friendly line — to pick a template from the top-bar 模板 / Template dropdown, then offer this card so they can confirm once they've picked, or switch to a built-in style instead. JSON shape EXACTLY — keep "meta" verbatim:`);
    p.push('```hv-options');
    p.push(JSON.stringify({
      meta: { phase: 'need-template' },
      question: '先在顶部「模板」里选一个模板，选好后点下面继续；或直接选一种内置风格：',
      options: [
        { label: '我已选好模板，继续', hint: '用顶部选中的模板生成' },
        { label: 'Cyberpunk glitch',   hint: '霓虹 / 故障感 / 高对比' },
        { label: 'Swiss minimalist',   hint: '网格 / 无衬线 / 留白' },
        { label: 'Warm-grain magazine',hint: '纸感 / 衬线 / 暖色' },
        { label: 'Mono brutalist',     hint: '黑白 / 块状 / 粗体' },
      ],
      allow_freeform: true,
    }, null, 2));
    p.push('```');
    p.push('');
    p.push(`Do NOT write HTML this turn. Do NOT return an empty reply.`);
    return p.join('\n');
  }

  // ---- format / format-edit: hv-form with 3 segmented controls ----
  if (phase === 'format' || phase === 'format-edit') {
    const isEdit = phase === 'format-edit';
    const pre = inputs.collected ?? {};
    const pickedType = isEdit
      ? lastCardPickByPhase(history, 'type') ?? ''
      : (inputs.pickedType ?? '');
    const isMulti = !!pickedType && isMultiFrameType(pickedType);
    const defaults = {
      aspect:      pre.aspect      ?? '16:9 横屏',
      duration:    pre.duration    ?? (isMulti ? '15' : '5'),
      frame_count: pre.frame_count ?? (isMulti ? '4' : '1'),
      // Per-frame pacing default 4s — comfortable, avoids the "rushed" feel a
      // short total ÷ many frames produces. Total is derived from this × frames.
      per_frame:   pre.per_frame   ?? '4',
    };
    const p: string[] = [];
    if (isEdit) {
      p.push(`The user wants to revise the format. Re-emit the SAME hv-form card with each \`default\` set to their last answer so they only need to change what they want.`);
    } else {
      p.push(`Now ask about format with ONE hv-form card — three segmented controls, no text inputs. JSON shape EXACTLY as shown — keep "meta" verbatim:`);
    }
    // The card is the ONLY acceptable way to ask this. Asking in prose makes
    // the user type a free-form answer with no submit marker, which the flow
    // then fails to recognise and re-asks (issue #2).
    p.push(`IMPORTANT: emit the hv-form card below — do NOT ask for size / duration / frames in plain prose, and do NOT list example answers for the user to type.`);
    p.push('```hv-form');
    p.push(JSON.stringify({
      meta: { phase: 'format' },
      title: isEdit ? '改一下格式' : (isMulti ? '最后一步：尺寸 / 每帧时长 / 帧数' : '最后一步：选个尺寸 / 时长'),
      fields: [
        {
          key: 'aspect', label: '画面尺寸', kind: 'buttons', required: true,
          default: defaults.aspect,
          options: [
            { value: '16:9 横屏',     label: '16:9 横屏' },
            { value: '9:16 手机竖屏', label: '9:16 竖屏' },
            { value: '1:1 方形',      label: '1:1 方形' },
            { value: '4:5 小红书',    label: '4:5 小红书' },
          ],
        },
        // Multi-frame: pace by PER-FRAME duration (total = per_frame × frames,
        // shown live). Single-frame: just a total duration.
        ...(isMulti
          ? [
              {
                key: 'per_frame', label: '每帧时长 (秒)', kind: 'buttons', required: true,
                default: defaults.per_frame,
                hint: '总时长 = 每帧时长 × 帧数',
                options: ['2', '3', '4', '5', '6', '8'].map((v) => ({ value: v, label: `${v}s` })),
              },
              {
                key: 'frame_count', label: '帧数', kind: 'buttons', required: true,
                default: defaults.frame_count,
                options: ['2', '3', '4', '5', '6', '7', '8', '9', '10'].map((v) => ({ value: v, label: v })),
              },
              // Opt-in: render data frames natively with Remotion (numbers roll,
              // bars grow) instead of static hyperframes HTML. Default OFF —
              // Remotion is a user-chosen enhancement, the AI never flips it.
              {
                key: 'remotion_enhance', label: '⚡ 数据帧用 Remotion', kind: 'buttons', required: false,
                default: '关',
                hint: '数据帧用原生 Remotion 渲染（数字滚动 / 柱子生长）；其余帧仍走 Hyperframes',
                options: [
                  { value: '关', label: '关' },
                  { value: '开', label: '开 · Remotion' },
                ],
              },
            ]
          : [
              {
                key: 'duration', label: '时长 (秒)', kind: 'buttons', required: true,
                default: defaults.duration,
                options: ['3', '5', '10', '15'].map((v) => ({ value: v, label: `${v}s` })),
              },
            ]),
      ],
      allow_attachments: false,
    }, null, 2));
    p.push('```');
    p.push('');
    p.push(`Do NOT write HTML this turn. Do NOT return an empty reply.`);
    return p.join('\n');
  }

  // ---- confirm: emit hv-confirm summarising what was collected ----
  if (phase === 'confirm') {
    const collected = inputs.collected ?? {};
    const pickedType = lastCardPickByPhase(history, 'type') ?? '';
    const pickedStyle = lastCardPickByPhase(history, 'style') ?? '';
    const contentTurns = collectContentTurns(history);
    const summaryRows: { label: string; value: string }[] = [];
    if (pickedType) summaryRows.push({ label: '类型', value: pickedType });
    if (contentTurns.length > 0) {
      summaryRows.push({ label: '内容', value: contentTurns.join(' · ').slice(0, 240) });
    }
    if (pickedStyle) summaryRows.push({ label: '风格', value: pickedStyle });
    if (tmpl) summaryRows.push({ label: '模板', value: tmpl.name });
    const labelMap: Record<string, string> = {
      aspect: '尺寸', duration: '时长', frame_count: '帧数', per_frame: '每帧时长',
    };
    // When pacing by per-frame, show per-frame + frames + derived total.
    const pf = Number(collected.per_frame ?? '') || 0;
    const keys = pf > 0 ? ['aspect', 'per_frame', 'frame_count'] : ['aspect', 'duration', 'frame_count'];
    for (const k of keys) {
      const v = collected[k];
      if (v) summaryRows.push({ label: labelMap[k] ?? k, value: k === 'per_frame' ? `${v}s` : v });
    }
    if (pf > 0) {
      const frames = Number(collected.frame_count ?? '4') || 4;
      summaryRows.push({ label: '总时长', value: `${pf * frames}s` });
    }
    if (attachments.length > 0) {
      summaryRows.push({ label: '素材', value: attachments.map((a) => a.filename).join(', ') });
    }

    const p: string[] = [];
    p.push(`The user has chosen the format. Emit ONE \`\`\`hv-confirm block (no other code blocks) summarising what you've got, in the user's language. Use this exact JSON — keep "meta":`);
    p.push('');
    p.push('```hv-confirm');
    p.push(JSON.stringify({
      meta: { phase: 'confirm' },
      title: '按这些信息生成？',
      summary: summaryRows,
      actions: ['generate', 'edit'],
    }, null, 2));
    p.push('```');
    p.push('');
    // Soft gate: if the subject is too thin to make a meaningful video, nudge
    // the user to add a concrete topic/brand/number — but never block, the card
    // still ships with both actions so they can proceed as-is.
    const contentBlob = contentTurns.join(' ').trim();
    const topicThin =
      attachments.length === 0 &&
      (contentBlob.replace(/\s/g, '').length < 8 ||
        /^(随机|随便|anything|random|whatever|都行|你定|skip|不知道)$/i.test(contentBlob));
    if (topicThin) {
      p.push(`NOTE: the collected content ("${contentBlob || '(empty)'}") is very thin / vague. BEFORE the hv-confirm block, add ONE short friendly sentence in the user's language gently flagging that the topic is sparse and inviting them to add a concrete subject / brand / key number for a stronger video — but STILL emit the hv-confirm block exactly as above so they can generate anyway if they want.`);
      p.push('');
    }
    p.push(`Do NOT write HTML this turn. Do NOT return an empty reply. The hv-confirm block is REQUIRED.`);
    return p.join('\n');
  }

  // ---- generate: actually write the HTML / content-graph ----
  if (phase === 'generate') {
    const collected = inputs.collected ?? {};
    const pickedType = inputs.pickedType ?? '';
    const pickedStyle = inputs.pickedStyle ?? '';
    const contentTurns = inputs.contentTurns ?? [];
    const { aspect, resolution } = resolutionForAspect(collected.aspect);
    const [w, h] = aspect.includes(':') ? aspect.split(':').map(Number) : [16, 9];
    const wantsAlbum = isAlbumType(pickedType)
      || tmpl?.id === 'album-scroll-story'
      || isAlbumType(openingTopic ?? '')
      || isAlbumType(userText);
    const isMulti = !wantsAlbum && (isMultiFrameType(pickedType)
      || Number(collected.frame_count ?? '1') > 1
      || Number(collected.per_frame ?? '0') > 0);

    const styleLabel = pickedStyle && /^从设计模板选|template/i.test(pickedStyle)
      ? (tmpl ? `(use the selected template "${tmpl.name}" — ${tmpl.description})` : '(let the model choose)')
      : pickedStyle;

    const p: string[] = [];
    p.push(`Generate the HTML video file(s) the user just confirmed.`);
    p.push('');
    // Lock the subject to the user's opening request. The content turns below
    // can be as thin as "随机" — without this the video drifts onto that literal
    // word (a "promote Open Design" request became a randomness explainer).
    if (openingTopic) {
      p.push(`VIDEO SUBJECT (LOCKED): the user opened with "${openingTopic}". The video MUST be about THIS subject.`);
      p.push(`If a content line below is a vague placeholder like "随机 / 随便 / anything / 你定 / whatever", it means "YOU choose the concrete details (selling points, framing, copy) — but the SUBJECT stays "${openingTopic}"". NEVER treat "随机" as the literal topic; do NOT make a video about randomness.`);
      p.push('');
    }
    p.push(`Inputs (use these LITERALLY — do NOT make up brand names or facts beyond what is stated):`);
    p.push(`- 类型 / type: ${pickedType || '(未指定)'}`);
    p.push(`- Output language: use the user's language for ALL visible text. If the request is Chinese, every visible title, label, CTA, hint, and section heading must be Chinese. English is allowed only for proper nouns, URLs, product names, or deliberately requested bilingual copy.`);
    if (contentTurns.length > 0) {
      p.push(`- 内容 / content (what the user told us in the chat):`);
      for (const t of contentTurns) p.push(`  · ${t.replace(/\n/g, ' ').slice(0, 280)}`);
    } else {
      p.push(`- 内容 / content: (the user did not specify; pick a sensible default that fits the type, but keep it generic — no fake brand names)`);
    }
    if (styleLabel) p.push(`- 风格 / style: ${styleLabel}`);
    const optionLines = configuredOptionLines(collected);
    if (optionLines.length > 0) {
      p.push(`- 首页已选配置 / configured options:`);
      p.push(...optionLines.map((line) => `  ${line}`));
    }
    p.push(`- 画面尺寸: ${aspect} (${resolution})`);
    p.push(`- 时长: ${collected.duration ?? '?'} 秒`);
    p.push(`- 帧数: ${collected.frame_count ?? (isMulti ? '4' : '1')}`);
    p.push('');
    if (attachments.length > 0) {
      const { specs, content } = partitionAttachments(attachments);
      // A design.md / frame.md is a style+motion spec to OBEY, surfaced first.
      p.push(...renderDesignSpecBlock(specs));
      if (content.length > 0 || specs.length === 0) {
        p.push(`Attachments:`);
        for (const a of (content.length ? content : attachments)) p.push(...renderAttachment(a));
        p.push(`Use binary attachments (images, data files) as actual assets where appropriate (logo, screenshot, data file). The inlined text/article/repo content above is the SOURCE MATERIAL — base the video's actual content (facts, names, numbers, narrative) on it, don't just decorate with it.`);
        p.push('');
      }
    }
    if (wantsAlbum) {
      p.push(`Electronic album requirements (REQUIRED):`);
      p.push(`- Output ONE standalone interactive HTML document, not a content-graph and not multiple html#frame blocks.`);
      p.push(`- Treat the frame/page count as album page count. Prefer 4-6 pages unless the user specified otherwise.`);
      p.push(`- Mark every album page container with data-album-page or data-page, for example <section class="page" data-album-page="cover">...</section>, so Studio can edit one page at a time.`);
      p.push(`- Mobile layout (REQUIRED, narrow screens): vertical full-viewport pages with scroll-snap; hide desktop prev/next chrome if needed; keep dots; one page per screen.`);
      p.push(`- Desktop / PC layout (REQUIRED, wide screens): show Previous/Next controls, page counter, and dots; support Arrow/Page keyboard navigation; allow a more spacious multi-column page layout.`);
      p.push(`- Deliver BOTH layouts in ONE HTML file via CSS media queries. Do NOT output only mobile or only desktop; opening the same file on phone and PC must both work.`);
      p.push(`- Mobile interaction: vertical scroll with scroll-snap; each page fills one viewport and the next page is reached by swiping/down-scrolling.`);
      p.push(`- Desktop interaction: visible Previous/Next controls, page dots or counter, and keyboard navigation for Arrow/Page keys.`);
      p.push(`- Use uploaded images/screenshots/materials as real album media. For image attachments, put the provided "Browser URL for HTML src/href" into <img src="..."> exactly; never use a Windows/local filesystem path and never use only the filename.`);
      p.push(`- If the user asks for image-to-album, preserve the uploaded image order: first image = first page, second image = second page, and so on.`);
      p.push(`- If the source is HTML, extract its visible content and visual structure into album pages.`);
      p.push(`- Tag visible text with data-hv-text keys so Studio can edit it after generation.`);
      p.push(`- Tag every replaceable album image with data-hv-image using stable keys such as cover.hero_image, page_2.photo, logo. For background-photo blocks, put data-hv-image on the element that owns the inline background-image.`);
      p.push(`- Tag primary action buttons, contact buttons, phone/wechat/email links, and purchase/booking/contact actions with data-hv-cta. The CTA visible copy must remain editable text. Prefer real <a href="..."> links (target=_blank) when a URL exists; do not leave outbound URLs only on inert <button> tags.`);
      p.push(`- Define theme colors in :root CSS variables, including --primary-color. Use var(--primary-color) for primary buttons, highlights, active dots, and brand accents instead of hardcoded repeated colors.`);
      p.push('');
    }
    p.push(`Editable HTML contract (REQUIRED): tag every visible text node with data-hv-text set to a stable English key (brand_name, headline, item_1, cta...), tag replaceable images with data-hv-image, tag action/contact/purchase buttons or links with data-hv-cta, and define :root { --primary-color: ... } plus any related theme variables. Use CSS variables for primary colors throughout.`);
    p.push(`Constraints: full-bleed ${resolution}, opens with an animation timeline, inline CSS + JS, single complete <!doctype html>...</html> document(s). CDN imports (Tailwind, GSAP) are fine. Keep visible text in the user's language. No prose outside code blocks.`);
    p.push('');
    // Frame-count safety: claude --print can truncate / stall on very large
    // multi-frame batches. Cap at 10 (high frame counts get progressively
    // less reliable in a single pass), and tell the model so it can plan.
    const requestedFrames = Math.max(1, Math.min(10, Number(collected.frame_count ?? '4') || 4));
    // ⚠️ FALLBACK ONLY. Real multi-frame generation goes through
    // runSplitMultiFrameGenerate (the server routes frame_count>1 there before
    // ever reaching this single-shot prompt). This branch only fires if that
    // routing is bypassed. If you change multi-frame grounding / template /
    // source-material rules, change runSplitMultiFrameGenerate — that's the
    // path users actually hit. Keep the two in sync.
    if (isMulti) {
      p.push(`Output (multi-frame storyboard) — emit IN THIS EXACT ORDER and SHAPE:`);
      p.push(`1. ONE \`\`\`json#content-graph block.`);
      p.push(`2. ONE \`\`\`html#<nodeId> block per node.`);
      p.push('');
      p.push(`Aim for ${requestedFrames} frames. Each frame should be self-contained, full-bleed ${resolution}, with its own opening animation. Nothing between blocks.`);
      p.push('');
      if (attachments.length > 0) {
        // The agent has, in practice, been handed the full article yet fallen
        // back to generic "first-principles / see-the-essence" filler. Force it
        // to ground every node in the source material's actual specifics.
        p.push(`GROUNDING (REQUIRED — the source material above is the script, not decoration):`);
        p.push(`- EVERY node's "text" MUST quote or paraphrase a SPECIFIC fact, name, number, product, or claim from the source material. Pull the real proper nouns (product names, companies, metrics, version numbers) verbatim.`);
        p.push(`- The "synopsis" MUST name the article's actual subject — not "AI/technology trends" or any vague category.`);
        p.push(`- BANNED: generic motivational filler with no tie to the source ("看清本质", "第一性原理", "复杂表象之下", "you really understand…", "the logic behind…"). If a line would fit ANY article, it is wrong — replace it with something that could ONLY come from THIS source.`);
        p.push(`- A reader who knows the article must recognize each frame as being about it; a reader who doesn't must learn its specific points.`);
        p.push('');
      }
      // Skeleton for multi-frame — empirically claude --print returns 1 byte
      // without an example, ~10KB with one. Show the exact shape, even with
      // placeholder content; the model fills it in.
      p.push(`Skeleton (replace placeholders with the inputs above; expand styling per the chosen type / style):`);
      p.push('```json#content-graph');
      p.push(JSON.stringify({
        schemaVersion: 1,
        intent: 'explainer',
        synopsis: '<one-line description>',
        nodes: Array.from({ length: requestedFrames }, (_, i) => ({
          id: `frame_${i + 1}`,
          kind: i === 0 ? 'text' : i === requestedFrames - 1 ? 'entity' : (i % 2 ? 'data' : 'text'),
          durationSec: Math.max(2, Math.floor(Number(collected.duration ?? '15') / requestedFrames)),
        })),
        edges: Array.from({ length: requestedFrames - 1 }, (_, i) => ({
          from: `frame_${i + 1}`,
          to: `frame_${i + 2}`,
          kind: 'sequence',
        })),
      }, null, 2));
      p.push('```');
      p.push('');
      p.push('```html#frame_1');
      p.push(`<!doctype html>
<html><head><meta charset="utf-8"><style>
html,body{margin:0;height:100%;background:#000;color:#fff;overflow:hidden;font-family:system-ui,sans-serif}
.stage{width:100vw;height:100vh;display:grid;place-items:center;text-align:center;padding:6vw}
h1{font-size:8vw;letter-spacing:-.03em;animation:in 1s ease forwards;opacity:0;transform:translateY(24px)}
@keyframes in{to{opacity:1;transform:none}}
</style></head><body>
<div class="stage"><h1 data-hv-text="headline">PLACEHOLDER</h1></div>
</body></html>`);
      p.push('```');
      p.push('');
      p.push(`(continue with the same shape for the remaining frames — \`\`\`html#frame_2 … \`\`\`html#frame_${requestedFrames})`);
      if (baseHtml && baseHtml.length > 0) {
        p.push('');
        p.push(tmpl
          ? `Template HTML — this is the REQUIRED visual style. Reuse its palette, layout, typography, and animation approach; change only the text/data to fit the source material. Do NOT switch to a different look (no dark "cosmic particle" default, etc.):`
          : `Prior preview HTML to draw style from:`);
        p.push('```html');
        p.push(baseHtml.slice(0, 3000));
        p.push('```');
      }
    } else {
      p.push(`Output (single-frame): begin your reply with \`\`\`html and end with \`\`\`. Nothing outside the block.`);
      p.push('');
      if (baseHtml && baseHtml.length > 0) {
        p.push(tmpl
          ? `Template HTML — this is the REQUIRED visual style. Reuse its palette, layout, typography, and animation approach; change only the text/data to fit the source material. Do NOT switch to a different look:`
          : `Prior preview HTML (iterate on its visual style if it fits, or replace if a different vibe is better):`);
        p.push('```html');
        p.push(baseHtml.slice(0, 4000));
        p.push('```');
      } else {
        p.push(`Skeleton to extend (replace placeholder with the inputs above; expand styling per the chosen type / style):`);
        p.push('```html');
        p.push(`<!doctype html>
<html><head><meta charset="utf-8"><style>
html,body{margin:0;height:100%;background:#000;color:#fff;overflow:hidden;font-family:system-ui,sans-serif}
.stage{width:100vw;height:100vh;display:grid;place-items:center;text-align:center;padding:6vw}
h1{font-size:8vw;letter-spacing:-.03em;animation:in 1.2s ease forwards;opacity:0;transform:translateY(24px)}
@keyframes in{to{opacity:1;transform:none}}
</style></head><body>
<div class="stage"><h1 data-hv-text="headline">PLACEHOLDER</h1></div>
</body></html>`);
        p.push('```');
      }
    }
    p.push('');
    if (tmpl) {
      p.push(`Template visual signature (REQUIRED): ${tmpl.name} — ${tmpl.description}. Match this look — it is the whole reason the template was chosen. Only a single explicit user style note may override it; "based on this article" is NOT such an override.`);
      p.push('');
    }
    p.push(`Do NOT return an empty reply. Do NOT emit any of \`\`\`hv-options / \`\`\`hv-form / \`\`\`hv-confirm — those are over.`);
    // discard variable since some lints complain
    void w; void h;
    return p.join('\n');
  }

  // ---- iterate: post-generation free-form revision ----
  // claude --print is unreliable when fed 6KB+ of HTML and asked to emit
  // 6KB+ back — it silently no-ops in ~50% of attempts. Instead of feeding
  // the whole HTML, we extract the visible text + style summary and let
  // the model REWRITE rather than EDIT. Output is bounded by the same
  // skeleton trick used by generate-phase.
  const it: string[] = [];
  if (args.focusFrameId) {
    it.push(`The user has pinned frame "${args.focusFrameId}" and wants to revise ONLY that frame. Apply their request below — write a fresh complete HTML page that delivers the same content, in roughly the same visual style, but with the requested change.`);
  } else if (isAlbumIteration) {
    it.push(`The user is iterating on an existing electronic album HTML. Apply their request below by rewriting the CURRENT album as ONE complete standalone interactive HTML document.`);
    it.push(`Preserve the current album's visual style and existing content unless the user explicitly asks to change them. If the user asks to add a page, add a new scroll-snap album page. If they provide a CTA URL, make the relevant button/link point to that URL. If they attach an image, use its Browser URL as a real <img> asset in the album. Preserve or add data-hv-text, data-hv-image, data-hv-cta, and :root --primary-color so Studio can edit the result.`);
  } else {
    it.push(`The user is iterating on an existing HTML video. Apply their request below — write a fresh complete HTML page that delivers the same content, in roughly the same visual style, but with the requested change.`);
  }
  it.push('');
  it.push(`# User request`);
  it.push(userText);
  it.push('');
  if (attachments.length > 0) {
    it.push(`# Attachments`);
    for (const a of attachments) it.push(...renderAttachment(a));
    it.push('');
  }
  if (baseHtml) {
    // IMPORTANT: do NOT inline the raw HTML. Empirically, including 6-8KB
    // of reference HTML in an iterate prompt makes `claude --print` return
    // 1 byte ~70% of the time (verified by hand). A summary of the
    // existing content + palette is enough to anchor a clean rewrite.
    const summary = summariseHtmlForIterate(baseHtml);
    it.push(isAlbumIteration ? `# Current album — what's there now` : `# Current frame — what's there now`);
    if (summary.headline) it.push(`Headline: ${summary.headline}`);
    if (summary.subheads.length) it.push(`Sub-text:\n${summary.subheads.map((s) => `  · ${s}`).join('\n')}`);
    if (summary.dataPoints.length) it.push(`Data points:\n${summary.dataPoints.map((s) => `  · ${s}`).join('\n')}`);
    if (summary.bgColors.length) it.push(`Palette: ${summary.bgColors.join(' / ')}`);
    if (summary.fontFamilies.length) it.push(`Fonts: ${summary.fontFamilies.join(', ')}`);
    it.push('');
  }
  const iterateResolution = resolutionForAspect(inputs.collected?.aspect).resolution;
  if (isAlbumIteration) {
    it.push(`Electronic album output requirements: ONE complete <!doctype html> document in a fenced \`\`\`html block. Keep BOTH mobile and PC layouts in the same file via CSS media queries: mobile = vertical scroll-snap pages; PC = visible prev/next controls + keyboard paging. Keep page dots/counter or controls, and editable tags: data-hv-text for visible text, data-hv-image for replaceable images/background images, data-hv-cta for action/contact links, and :root --primary-color for theme color. Use the current aspect/resolution (${iterateResolution}). All visible text must stay in the user's language; for Chinese requests, translate/avoid English labels like "BRAND STRENGTH" unless they are proper nouns. No prose outside the block. Do NOT return an empty reply.`);
  } else {
    it.push(`Output: ONE complete HTML document. Begin your reply with \`\`\`html and end with \`\`\`. Inline all CSS / JS. Full-bleed ${iterateResolution}. Preserve or add editable markers: data-hv-text for visible text, data-hv-image for replaceable images/background images, data-hv-cta for action/contact links, and :root --primary-color for theme color. All visible text must stay in the user's language. No prose outside the block. Do NOT return an empty reply.`);
  }
  it.push('');
  it.push(`Skeleton to extend (replace with the real content + visual style):`);
  it.push('```html');
  it.push(`<!doctype html>
<html><head><meta charset="utf-8"><style>
html,body{margin:0;height:100%;background:#000;color:#fff;overflow:hidden;font-family:system-ui,sans-serif}
.stage{width:100vw;height:100vh;display:grid;place-items:center;text-align:center;padding:6vw}
h1{font-size:8vw;letter-spacing:-.03em;animation:in 1s ease forwards;opacity:0;transform:translateY(24px)}
@keyframes in{to{opacity:1;transform:none}}
</style></head><body>
<div class="stage"><h1 data-hv-text="headline">PLACEHOLDER</h1></div>
</body></html>`);
  it.push('```');
  return it.join('\n');
}

/** Pull headline / subheads / data values / palette / fonts from a frame's HTML. */
function summariseHtmlForIterate(html: string): {
  headline: string;
  subheads: string[];
  dataPoints: string[];
  bgColors: string[];
  fontFamilies: string[];
} {
  const subheads: string[] = [];
  const dataPoints: string[] = [];
  // Visible text in tagged elements
  const textRe = /data-hv-text="([^"]+)"[^>]*>([^<]{1,160})</gi;
  let m: RegExpExecArray | null;
  let headline = '';
  while ((m = textRe.exec(html)) !== null) {
    const key = m[1] ?? '';
    const val = (m[2] ?? '').trim();
    if (!val) continue;
    if (/headline|title|hero/i.test(key) && !headline) headline = val;
    else if (/data|stat|value|number/i.test(key)) dataPoints.push(`${key}: ${val}`);
    else subheads.push(`${key}: ${val}`);
  }
  // Body / stage background colour (rough)
  const bgColors = Array.from(
    html.matchAll(/background[^:]*:\s*(#[0-9a-f]{3,8}|rgb[a]?\([^)]+\)|hsla?\([^)]+\))/gi),
  ).slice(0, 3).map((x) => x[1]!).filter(Boolean);
  // Font families (first occurrence in css)
  const fontFamilies = Array.from(
    new Set(
      Array.from(html.matchAll(/font-family\s*:\s*([^;}]+)/gi))
        .map((x) => (x[1] ?? '').trim().slice(0, 80))
        .filter(Boolean),
    ),
  ).slice(0, 2);
  return {
    headline,
    subheads: subheads.slice(0, 6),
    dataPoints: dataPoints.slice(0, 6),
    bgColors,
    fontFamilies,
  };
}

/**
 * Extract a full HTML document from agent output.
 * Tries (1) `\`\`\`html ... \`\`\`` block, (2) bare `<!doctype html>...</html>`.
 */
function extractHtmlDocument(text: string): string | null {
  // Plain ```html``` block (no node-id tag — single-frame fast path)
  const fence = /```html\s*\n([\s\S]*?)```/i.exec(text);
  if (fence && fence[1]) {
    const html = fence[1].trim();
    if (/<\/html>/i.test(html)) return html;
  }
  const bare = /<!doctype html[\s\S]*?<\/html>/i.exec(text);
  if (bare) return bare[0];
  return null;
}

function hardenAlbumHtml(html: string): string {
  let out = html;
  if (!out.includes('id="hv-album-safety"') && !out.includes("id='hv-album-safety'")) {
    const css = `
<style id="hv-album-safety">
  /* Studio safety patch: generated album pages sometimes leave non-cover media
     in the initial .reveal animation state, which makes uploaded photos look
     like black panels. Keep generated visuals, but guarantee album media shows. */
  .album-page:not(.cover) .reveal,
  [data-page]:not(.cover) .reveal {
    opacity: 1 !important;
    transform: none !important;
    visibility: visible !important;
  }
  .album-page img,
  [data-page] img,
  .media img,
  figure img {
    opacity: 1 !important;
    visibility: visible !important;
    display: block !important;
  }
  a.cta-btn,
  a.cta-outline,
  a[data-hv-cta] {
    text-decoration: none;
    box-sizing: border-box;
  }
</style>`;
    if (/<\/head>/i.test(out)) out = out.replace(/<\/head>/i, `${css}\n</head>`);
    else if (/<\/style>/i.test(out)) out = out.replace(/<\/style>/i, `</style>\n${css}`);
    else out = `${css}\n${out}`;
  }

  // CTA buttons often only carry data-href after Studio edits; make them clickable.
  if (!out.includes('id="hv-album-cta-nav"') && !out.includes("id='hv-album-cta-nav'")) {
    const script = `
<script id="hv-album-cta-nav">
(function () {
  function normalizeHref(href) {
    var s = String(href || '').trim();
    if (!s) return '';
    if (/^(https?:|mailto:|tel:|sms:|\\/\\/|\\/|#)/i.test(s)) return s;
    if (/^[\\w.-]+\\.[a-z]{2,}([/:?#].*)?$/i.test(s)) return 'https://' + s;
    return s;
  }
  document.addEventListener('click', function (e) {
    var el = e.target && e.target.closest && e.target.closest('[data-hv-cta]');
    if (!el) return;
    if (el.tagName === 'A' && el.getAttribute('href')) return;
    var href = normalizeHref(el.getAttribute('href') || el.getAttribute('data-href') || '');
    if (!href) return;
    e.preventDefault();
    e.stopPropagation();
    if (/^(mailto|tel|sms):/i.test(href)) window.location.href = href;
    else window.open(href, '_blank', 'noopener,noreferrer');
  }, true);
})();
</script>`;
    if (/<\/body>/i.test(out)) out = out.replace(/<\/body>/i, `${script}\n</body>`);
    else out = `${out}\n${script}`;
  }

  return out;
}

/**
 * v0.8: extract a content-graph JSON block + N tagged html#<nodeId> blocks
 * from a single agent response.
 *
 * Expected agent output format for multi-frame:
 *   ```json#content-graph
 *   { "schemaVersion": 1, "intent": "explainer", "nodes": [...], "edges": [...] }
 *   ```
 *   ```html#node_1
 *   <!doctype html>...
 *   ```
 *   ```html#node_2
 *   <!doctype html>...
 *   ```
 *
 * Returns null when no content-graph block is found (caller falls back to
 * single-frame extraction).
 */
function extractContentGraphAndFrames(
  text: string,
): { graph: import('@html-video/content-graph').ContentGraph; frames: { nodeId: string; html: string }[] } | null {
  // Find a fenced JSON block tagged as content-graph.
  const graphMatch = /```json#content-graph\s*\n([\s\S]*?)```/i.exec(text);
  if (!graphMatch || !graphMatch[1]) return null;
  let graph: import('@html-video/content-graph').ContentGraph;
  try {
    graph = parseGraphJsonTolerant(graphMatch[1].trim()) as import('@html-video/content-graph').ContentGraph;
  } catch {
    return null;
  }
  if (!graph || !Array.isArray((graph as { nodes?: unknown[] }).nodes)) return null;

  // Find tagged html blocks: ```html#<nodeId>
  const frames: { nodeId: string; html: string }[] = [];
  const re = /```html#([a-z0-9_-]+)\s*\n([\s\S]*?)```/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const nodeId = match[1];
    const html = match[2]?.trim() ?? '';
    if (nodeId && /<\/html>/i.test(html)) {
      frames.push({ nodeId, html });
    }
  }

  return { graph, frames };
}

// ---------------------------------------------------------------------------
// Split multi-frame generate
//
// `claude --print` is unreliable when asked to emit a content-graph PLUS
// 4-6 full HTML pages in one shot — it tends to time out at 100s+ with 1
// byte of output. Each call individually is fine, so we orchestrate:
//
//   1. one short call → graph JSON
//   2. one short call per node → frame HTML
//
// Each step writes its result to disk and pushes an SSE event so the UI
// can show "frame N/M" progress.
// ---------------------------------------------------------------------------
interface SplitGenerateArgs {
  ctx: CliContext;
  projectId: string;
  projectDir: string;
  agentDef: import('@html-video/runtime').AgentDef;
  agentModel?: string | undefined;
  tmpl: import('@html-video/core').TemplateMetadata | null;
  priorHtml: string;
  inputs: PhaseInputs;
  attachments: Attachment[];
  /** The user's original opening subject, locked across phases. */
  openingTopic?: string;
  /**
   * Restyle mode: keep the EXISTING content-graph text verbatim and only
   * re-render each frame's HTML in the new style. Skips the Step-1 graph
   * re-plan. Used by the post-generation "换风格 / 改时长" sub-flows.
   */
  restyleOnly?: boolean;
  operationId: string;
  /** Called for human-readable progress lines. */
  onProgress: (msg: string) => void;
  /** Called for structured SSE events. */
  onSse: (obj: unknown) => void;
}

// NOTE: the old classifyIterateIntent (LLM guesses rewrite-all/edit-visual/
// edit-frame from one sentence) was removed. The post-generation flow no longer
// guesses: detectPhase routes a vague "改一下" to an explicit edit-menu card
// (style / content / duration) and the user's pick drives restyle /
// iterate-content / iterate-format.

async function runSplitMultiFrameGenerate(
  args: SplitGenerateArgs,
): Promise<{ frameCount: number; intent: string }> {
  const { ctx, projectId, projectDir, agentDef, agentModel, tmpl, priorHtml, inputs, attachments, openingTopic, restyleOnly, operationId, onProgress, onSse } = args;
  const collected = inputs.collected ?? {};
  const pickedType = inputs.pickedType ?? '';
  const pickedStyle = inputs.pickedStyle ?? '';
  const contentTurns = inputs.contentTurns ?? [];
  // When a template is selected, its OWN source HTML is the style ground truth —
  // every frame must reuse its palette/typography/layout/motion. Previously
  // split-generate only passed the template's one-line description, so a picked
  // template (e.g. Swiss Grid: light grey + black/gold serif) came out as a
  // generic dark theme. Read the real source once and force it into each frame.
  let templateHtml = '';
  if (tmpl?.__dir && tmpl.source_entry) {
    try {
      const { readFileSync } = await import('node:fs');
      const p = join(tmpl.__dir, tmpl.source_entry);
      if (existsSync(p)) templateHtml = readFileSync(p, 'utf8');
    } catch { /* fall back to description-only */ }
  }
  const { aspect, resolution, width, height } = resolutionForAspect(collected.aspect);
  const frameCountReq = Math.max(2, Math.min(10, Number(collected.frame_count ?? '4') || 4));
  // Opt-in (format card): render data frames natively with Remotion. When on,
  // the planner must give every data node structured items, and after each
  // data frame's HTML is written we enhance it in place (best-effort).
  const enhanceData = (collected.remotion_enhance ?? '').startsWith('开');
  // Prefer per-frame pacing (total = per_frame × frames) — set by the format
  // card so a short total ÷ many frames can't produce a rushed clip. Fall back
  // to total ÷ frames for older projects that only stored `duration`.
  const perFrameInput = Number(collected.per_frame ?? '') || 0;
  const perFrameDurationSec = perFrameInput > 0
    ? Math.max(2, perFrameInput)
    : Math.max(2, Math.floor((Number(collected.duration ?? '15') || 15) / frameCountReq));
  const totalDurationSec = perFrameInput > 0
    ? perFrameDurationSec * frameCountReq
    : (Number(collected.duration ?? '15') || 15);
  // Persist the chosen resolution on the project so EXPORT records at the right
  // aspect (it reads project.preferences.resolution; without this it defaulted
  // to 1920×1080 and squashed a 4:5 / 9:16 frame into a 16:9 canvas).
  {
    const proj = await ctx.projects.load(projectId);
    proj.preferences = { ...proj.preferences, resolution: { width, height } };
    await ctx.projects.save(proj);
  }

  const styleLabel = pickedStyle && /^从设计模板选|template/i.test(pickedStyle)
    ? (tmpl ? `(use the selected template "${tmpl.name}" — ${tmpl.description})` : '(let the model choose)')
    : pickedStyle;

  // ---- Step 1: obtain the content graph ----
  let graph: import('@html-video/content-graph').ContentGraph;
  if (restyleOnly) {
    // Restyle / re-time: keep the EXISTING storyboard text verbatim, skip the
    // re-plan entirely. Only Step 2 (per-frame HTML) re-runs, in the new style.
    const existing = await ctx.orchestrator.readContentGraph(projectId);
    if (!existing || !Array.isArray(existing.nodes) || existing.nodes.length === 0) {
      throw new Error('restyle requested but the project has no existing storyboard to reuse');
    }
    graph = existing as import('@html-video/content-graph').ContentGraph;
    onProgress(`✓ 沿用现有文案：${graph.nodes.length} 帧`);
    onSse({ type: 'plan_ready', frame_count: graph.nodes.length, intent: graph.intent });
  } else {
  onProgress(`📋 规划 ${frameCountReq} 帧的故事板…`);
  const graphPromptParts: string[] = [];
  graphPromptParts.push(`Plan a ${frameCountReq}-frame HTML video storyboard. Output ONLY a content-graph JSON in a fenced \`\`\`json#content-graph block — no HTML, no prose outside.`);
  graphPromptParts.push('');
  graphPromptParts.push(`Inputs (use literally — do NOT invent brand names or facts beyond these):`);
  graphPromptParts.push(`- 类型 / type: ${pickedType || '(unspecified)'} (this is the FORMAT, NOT the subject — never make the video be "about" the type itself)`);
  // Lock the storyboard to the user's opening subject (unless a SOURCE MATERIAL
  // block below supersedes it). This is the path the user actually hits, and
  // where "随机" turned into a randomness explainer instead of the Open Design
  // promo they asked for.
  if (openingTopic && !attachments.some((a) => !!a.inlineText)) {
    graphPromptParts.push(`- 主题 / subject (LOCKED): the user opened with "${openingTopic}". The synopsis and EVERY node MUST be about this subject. If the content line below is a vague word like "随机 / 随便 / anything / 你定", it means "you choose the concrete angle and points — but keep the subject = "${openingTopic}"". NEVER make the video about randomness or the literal word.`);
  }
  if (contentTurns.length > 0) {
    graphPromptParts.push(`- 内容 / content:`);
    for (const t of contentTurns) graphPromptParts.push(`  · ${t.replace(/\n/g, ' ').slice(0, 280)}`);
  }
  // Inline the fetched article / repo / uploaded text — THIS is the subject of
  // the video. Without it the planner only sees the type word and invents a
  // video "about 概念解说" instead of about the user's actual source.
  const { specs: designSpecs, content: contentAtts } = partitionAttachments(attachments);
  if (designSpecs.length > 0) graphPromptParts.push('', ...renderDesignSpecBlock(designSpecs));
  const sourceTexts = contentAtts.filter((a) => !!a.inlineText);
  if (sourceTexts.length > 0) {
    graphPromptParts.push('');
    graphPromptParts.push(`SOURCE MATERIAL — the video MUST be about THIS content (real facts, names, numbers from it). This is the subject, not the type:`);
    for (const a of sourceTexts) {
      graphPromptParts.push(`--- ${a.filename} ---`);
      graphPromptParts.push((a.inlineText ?? '').slice(0, 6000));
    }
  }
  if (styleLabel) graphPromptParts.push(`- 风格 / style: ${styleLabel}`);
  const optionLines = configuredOptionLines(collected);
  if (optionLines.length > 0) {
    graphPromptParts.push(`- 首页已选配置 / configured options:`);
    graphPromptParts.push(...optionLines.map((line) => `  ${line}`));
  }
  graphPromptParts.push(`- 画面尺寸 / aspect: ${aspect} (${resolution})`);
  graphPromptParts.push(`- 总时长: ${totalDurationSec}s split across ${frameCountReq} frames (~${perFrameDurationSec}s each)`);
  graphPromptParts.push('');
  if (sourceTexts.length > 0) {
    graphPromptParts.push(`GROUNDING (REQUIRED): every node's text must come from the SOURCE MATERIAL above — quote its real product names, facts, numbers. The synopsis must name the source's actual subject. BANNED: generic filler about the content TYPE (e.g. "什么是概念解说", "信息密度×传播效率") that would fit any video. If a line could fit any topic, it's wrong.`);
    graphPromptParts.push('');
  }
  graphPromptParts.push(`Schema (keep all keys; one node per frame; nodes[].id should be a short readable slug like "intro" / "stat_users" / "outro"):`);
  graphPromptParts.push('```json#content-graph');
  graphPromptParts.push(JSON.stringify({
    schemaVersion: 1,
    intent: 'explainer',
    synopsis: '<one-line description of the video>',
    nodes: Array.from({ length: frameCountReq }, (_, i) => {
      const kind = i === 0 ? 'text' : i === frameCountReq - 1 ? 'entity' : 'data';
      const node: Record<string, unknown> = {
        id: `frame_${i + 1}`,
        kind,
        durationSec: perFrameDurationSec,
        text: '<headline / subtitle for this frame>',
      };
      // Every data node carries structured items so it can be rendered natively
      // with Remotion (numbers roll, bars grow) — whether the user opted in now
      // or enhances the frame later from the strip. A data frame without numbers
      // is just a text frame.
      if (kind === 'data') {
        node.data = {
          title: '<short chart title>',
          unit: '<optional unit, e.g. K / % / ★>',
          items: [
            { label: '<label>', value: 0 },
            { label: '<label>', value: 0 },
          ],
        };
      }
      return node;
    }),
    edges: Array.from({ length: frameCountReq - 1 }, (_, i) => ({
      from: `frame_${i + 1}`,
      to: `frame_${i + 2}`,
      kind: 'sequence',
    })),
  }, null, 2));
  graphPromptParts.push('```');
  graphPromptParts.push('');
  graphPromptParts.push(`Replace the placeholder text in each node with concrete content from the inputs. Adjust intent to match (single-frame|explainer|data-viz|promo|comparison|other). Keep node ids unique. Do NOT return an empty reply. Do NOT emit any HTML this turn.`);
  graphPromptParts.push(`DATA FRAMES: every \`kind:"data"\` node MUST carry a \`data\` object \`{ title?, unit?, items: [{ label, value }] }\` with at least 2 items and numeric \`value\`s drawn from the inputs/source — real figures, not placeholders (they can be animated with rolling counters / growing bars). The node's \`text\` still holds the headline. If a frame genuinely has no quantitative data, make it a \`text\` node instead of \`data\`.`);
  graphPromptParts.push(`DATA FRAME QUALITY: (1) Items in ONE data frame must be COMPARABLE — the same unit and a similar order of magnitude. Do NOT mix wildly different scales in one chart (e.g. 61,000 GitHub stars next to 142 plugins) — one giant bar makes the rest invisible. If figures have different units or scales, split them across separate data frames, or pick the 2-4 that genuinely compare. (2) \`unit\` is OPTIONAL and only for a real shared unit (e.g. "%", "K", "★", "ms"). If the numbers are plain counts with no meaningful unit, OMIT \`unit\` entirely — never use filler like "count" / "个" / "次".`);
  graphPromptParts.push(`STRICT JSON: the block must be valid JSON. Inside string values do NOT use straight double-quotes ("…") — if you need to quote a term or title, use 「」 or 《》 or single quotes. No trailing commas. No comments.`);

  const graphPrompt = graphPromptParts.join('\n');
  const graphText = await callAgentSimple(agentDef, graphPrompt, projectDir, agentModel, {
    ctx,
    projectId,
    generationType: 'album_outline',
    operationId,
    attempt: 1,
    requestPayload: {
      operation: restyleOnly ? 'reuse_content_graph' : 'generate_content_graph',
      requested_frame_count: frameCountReq,
    },
    validateOutput: validateContentGraphOutput,
    invalidOutputCode: 'invalid_content_graph',
  });
  const graphMatch = /```json#content-graph\s*\n([\s\S]*?)```/i.exec(graphText)
    ?? /```json\s*\n([\s\S]*?)```/i.exec(graphText);
  if (!graphMatch || !graphMatch[1]) {
    throw new Error(`agent did not return a content-graph (got ${graphText.length} bytes, head: ${graphText.slice(0, 80)})`);
  }
  try {
    graph = parseGraphJsonTolerant(graphMatch[1].trim()) as import('@html-video/content-graph').ContentGraph;
  } catch (e) {
    throw new Error(`graph JSON failed to parse: ${e instanceof Error ? e.message : e}`);
  }
  if (!graph || !Array.isArray(graph.nodes) || graph.nodes.length === 0) {
    throw new Error('graph has no nodes');
  }
  await ctx.orchestrator.writeContentGraph(projectId, graph);
  onProgress(`✓ 故事板规划完成：${graph.nodes.length} 帧 (${graph.intent})`);
  onSse({ type: 'plan_ready', frame_count: graph.nodes.length, intent: graph.intent });
  }

  // ---- Step 2: one call per node, output a single ```html block ----
  for (let i = 0; i < graph.nodes.length; i++) {
    const node = graph.nodes[i]!;
    const nodeId = node.id;
    onProgress(`🎬 生成第 ${i + 1}/${graph.nodes.length} 帧 (${nodeId})…`);
    onSse({ type: 'frame_started', node_id: nodeId, order: i, total: graph.nodes.length });

    const frameContext = describeNode(node);
    const fp: string[] = [];
    fp.push(`Generate ONE complete HTML page for frame "${nodeId}" of a ${graph.nodes.length}-frame video. Output ONE \`\`\`html block, nothing else.`);
    fp.push('');
    fp.push(`Frame ${i + 1} of ${graph.nodes.length}: ${frameContext}`);
    if (restyleOnly) {
      // Keep the exact words; only the visual style changes.
      fp.push(`RESTYLE: keep this frame's TEXT EXACTLY as given above — same headline, subtitle, numbers, wording. Do NOT rewrite, translate, or reword anything. Change ONLY the visual style (layout, colour, typography, motion) to: ${styleLabel || pickedStyle || '(the new style)'}.`);
    }
    if (openingTopic && !attachments.some((a) => !!a.inlineText)) {
      fp.push(`Subject (locked): "${openingTopic}". This frame is about this subject; "随机/随便" anywhere in the inputs means you pick details, not a new topic.`);
    }
    fp.push(`Duration: ${node.durationSec ?? perFrameDurationSec}s`);
    fp.push(`Type: ${pickedType}`);
    if (styleLabel) fp.push(`Style: ${styleLabel}`);
    fp.push(`Resolution: ${aspect} (${resolution})`);
    fp.push('');
    if (contentTurns.length > 0) {
      fp.push(`Source material from the user (use literally; do NOT invent facts):`);
      for (const t of contentTurns) fp.push(`  · ${t.replace(/\n/g, ' ').slice(0, 280)}`);
      fp.push('');
    }
    // Fetched article/repo text — keep the per-frame HTML grounded in the real
    // source, not just the one-line graph node. (Graph step gets the full text;
    // give each frame a trimmed slice so it can pull accurate specifics.)
    const { specs: frameSpecs, content: frameContentAtts } = partitionAttachments(attachments);
    if (frameSpecs.length > 0) fp.push(...renderDesignSpecBlock(frameSpecs));
    const frameSourceTexts = frameContentAtts.filter((a) => !!a.inlineText);
    if (frameSourceTexts.length > 0) {
      fp.push(`SOURCE MATERIAL (the video's real subject — use its actual facts/names/numbers, never generic filler about the content type):`);
      for (const a of frameSourceTexts) fp.push((a.inlineText ?? '').slice(0, 3000));
      fp.push('');
    }
    fp.push(`Output: begin with \`\`\`html and end with \`\`\`. Inline CSS + JS, full-bleed ${resolution}, opens with an animation timeline. Tag visible text with data-hv-text, replaceable images with data-hv-image, CTA/contact/purchase actions with data-hv-cta, and define :root --primary-color for theme color. CDN imports (Tailwind, GSAP) fine. No prose outside the block.`);
    fp.push('');
    if (templateHtml) {
      // A template is selected → its HTML is the REQUIRED look for every frame.
      fp.push(`Template HTML — this is the REQUIRED visual style for THIS frame. Reuse its exact palette, background, typography, layout structure and animation approach; only swap in this frame's text/data. Do NOT invent a different theme (no generic dark background unless the template itself is dark):`);
      fp.push('```html');
      fp.push(templateHtml.slice(0, 4000));
      fp.push('```');
      fp.push('');
      fp.push(`Keep all ${graph.nodes.length} frames visually consistent with this template so they read as one video.`);
    } else {
      fp.push(`Skeleton to extend (replace placeholder, expand styling per type / style):`);
      fp.push('```html');
      fp.push(`<!doctype html>
<html><head><meta charset="utf-8"><style>
html,body{margin:0;height:100%;background:#000;color:#fff;overflow:hidden;font-family:system-ui,sans-serif}
.stage{width:100vw;height:100vh;display:grid;place-items:center;text-align:center;padding:6vw}
h1{font-size:8vw;letter-spacing:-.03em;animation:in 1s ease forwards;opacity:0;transform:translateY(24px)}
@keyframes in{to{opacity:1;transform:none}}
</style></head><body>
<div class="stage"><h1 data-hv-text="headline">PLACEHOLDER</h1></div>
</body></html>`);
      fp.push('```');
      if (priorHtml && priorHtml.length > 0) {
        fp.push('');
        fp.push(`Visual style reference (mine for palette / typography / motion vocabulary, do not copy literally):`);
        fp.push('```html');
        fp.push(priorHtml.slice(0, 2400));
        fp.push('```');
      }
    }
    if (i === 0 && attachments.length > 0) {
      fp.push('');
      fp.push(`User attachments (binary = assets; inlined text = source material to base content on):`);
      for (const a of attachments) fp.push(...renderAttachment(a));
    }
    fp.push('');
    fp.push(`Do NOT return an empty reply. Output the full HTML.`);

    const framePrompt = fp.join('\n');
    let frameText = await callAgentSimple(agentDef, framePrompt, projectDir, agentModel, {
      ctx,
      projectId,
      generationType: 'page_html',
      operationId,
      attempt: 1,
      pageNodeId: nodeId,
      requestPayload: {
        operation: restyleOnly ? 'restyle_frame_html' : 'generate_frame_html',
        frame_index: i,
        frame_count: graph.nodes.length,
      },
      validateOutput: (output) => (
        extractHtmlDocument(output) ? null : `Frame "${nodeId}" response did not contain valid HTML`
      ),
      invalidOutputCode: 'invalid_html',
    });
    let extracted = /```html\s*\n([\s\S]*?)```/i.exec(frameText)?.[1]?.trim()
      ?? /<!doctype html[\s\S]*?<\/html>/i.exec(frameText)?.[0];

    // One retry on empty: shorter prompt, just the skeleton call.
    if (!extracted) {
      onProgress(`  ↻ 第 ${i + 1} 帧首试为空，重试…`);
      const retryPrompt = `Output ONE complete HTML video frame in a fenced \`\`\`html block. Frame purpose: ${frameContext}. Style: ${styleLabel || 'tasteful default'}. Resolution: ${resolution}. ${contentTurns.length ? `Content: ${contentTurns.join(' / ').slice(0, 200)}` : ''} \n\nBegin your reply with \`\`\`html. Inline CSS, opens with animation, tag text with data-hv-text. No prose.`;
      frameText = await callAgentSimple(agentDef, retryPrompt, projectDir, agentModel, {
        ctx,
        projectId,
        generationType: 'page_html',
        operationId,
        attempt: 2,
        pageNodeId: nodeId,
        requestPayload: {
          operation: restyleOnly ? 'restyle_frame_html' : 'generate_frame_html',
          retry_reason: 'empty_or_invalid_html',
          frame_index: i,
          frame_count: graph.nodes.length,
        },
        validateOutput: (output) => (
          extractHtmlDocument(output) ? null : `Frame "${nodeId}" retry did not contain valid HTML`
        ),
        invalidOutputCode: 'invalid_html',
      });
      extracted = /```html\s*\n([\s\S]*?)```/i.exec(frameText)?.[1]?.trim()
        ?? /<!doctype html[\s\S]*?<\/html>/i.exec(frameText)?.[0];
    }
    if (!extracted) {
      throw new Error(`frame "${nodeId}" generation returned empty (${frameText.length}B)`);
    }
    await ctx.orchestrator.writeFrameHtml(projectId, nodeId, extracted);
    // Native Remotion enhancement (opt-in via format card). The frame now has a
    // FrameRecord, so enhanceFrameNative can set engine/nativeTemplateId/data in
    // place. Best-effort: if the data node lacks usable {label,value} items it
    // throws — we keep the hyperframes HTML and warn rather than fail the run.
    // 'frame-data-rollup' is the only native template today (TODO: picker).
    if (enhanceData && node.kind === 'data') {
      try {
        // Two steps, same as the manual enhance endpoint: (1) set the frame's
        // engine/data, (2) actually RENDER the preview MP4. Without step 2 the
        // frame is flagged remotion but has no previewMp4Path, so the studio
        // tries to play a <video> that 404s → black thumbnail + preview.
        await ctx.orchestrator.enhanceFrameNative(projectId, nodeId, 'frame-data-rollup');
        onProgress(`  ⚡ 第 ${i + 1} 帧渲染 Remotion 动效 (数字滚动 / 柱子生长)…`);
        await ctx.orchestrator.renderFrameNativePreview({ projectId, graphNodeId: nodeId });
        onSse({ type: 'frame_enhanced', node_id: nodeId, order: i });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        process.stderr.write(`[studio:split-generate] proj=${projectId} frame=${nodeId} enhance skipped: ${msg}\n`);
        onProgress(`  ⚠️ 第 ${i + 1} 帧无法用 Remotion 增强（回落静态 HTML）：${msg}`);
        // Revert the engine flag so the frame falls back to its hyperframes HTML
        // (the <iframe> path) instead of showing a broken <video>.
        try { await ctx.orchestrator.unenhanceFrame(projectId, nodeId); } catch { /* ignore */ }
      }
    }
    onProgress(`  ✓ 第 ${i + 1}/${graph.nodes.length} 帧完成 (${nodeId})`);
    onSse({ type: 'frame_done', node_id: nodeId, order: i, total: graph.nodes.length });
  }

  return { frameCount: graph.nodes.length, intent: graph.intent };
}

/** Describe a node's purpose for prompt context. */
function describeNode(node: import('@html-video/content-graph').Node): string {
  const bits: string[] = [];
  if (node.label) bits.push(node.label);
  if ((node as { text?: string }).text) bits.push(`text: ${(node as { text: string }).text.slice(0, 200)}`);
  if (node.kind === 'data' && (node as { data?: unknown }).data !== undefined) {
    bits.push(`data: ${JSON.stringify((node as { data: unknown }).data).slice(0, 200)}`);
  }
  if (node.kind === 'entity' && (node as { props?: unknown }).props !== undefined) {
    bits.push(`entity props: ${JSON.stringify((node as { props: unknown }).props).slice(0, 200)}`);
  }
  if (node.frameIntent) bits.push(`intent: ${node.frameIntent}`);
  if (bits.length === 0) bits.push(`(${node.kind} frame "${node.id}")`);
  return bits.join('; ');
}

/** Spawn the agent, collect all stdout text, return when done. */
async function callAgentSimple(
  def: import('@html-video/runtime').AgentDef,
  prompt: string,
  cwd: string,
  model?: string,
  logging?: {
    ctx: CliContext;
    projectId: string;
    generationType: import('@html-video/core').AiGenerationType;
    operationId: string;
    attempt: number;
    pageNodeId?: string;
    requestPayload?: Record<string, unknown>;
    onEvent?: (event: import('@html-video/runtime').AgentEvent) => void;
    validateOutput?: (output: string) => string | null;
    invalidOutputCode?: string;
    onSucceeded?: (handle: AiGenerationLogHandle | null, output: string) => void;
  },
): Promise<string> {
  let buf = '';
  let agentError = '';
  const logger = logging ? AiGenerationLogger.fromContext(logging.ctx) : null;
  const providerModel = aiProviderModel(def, model);
  const logHandle = logging ? await logger?.start({
    projectId: logging.projectId,
    generationType: logging.generationType,
    provider: providerModel.provider,
    model: providerModel.model,
    prompt,
    operationId: logging.operationId,
    attempt: logging.attempt,
    ...(logging.pageNodeId && { pageNodeId: logging.pageNodeId }),
    requestPayload: logging.requestPayload,
  }) ?? null : null;
  const handle = spawnAgent({
    def,
    prompt,
    context: { cwd, ...(model && { model }) },
    onEvent: (ev) => {
      if (ev.type === 'text') buf += ev.chunk;
      else if (ev.type === 'error') agentError = ev.message;
      logging?.onEvent?.(ev);
    },
  });
  const exit = await handle.done;
  const validationError = logging?.validateOutput?.(buf) ?? null;
  if (agentError || exit.exitCode !== 0 || !buf.trim() || validationError) {
    const code = agentError
      ? 'agent_event_error'
      : exit.exitCode !== 0
        ? 'agent_exit_nonzero'
        : !buf.trim()
          ? 'empty_response'
          : logging?.invalidOutputCode ?? 'invalid_response';
    await logger?.fail(
      logHandle,
      agentError
        || validationError
        || `Agent exited with code ${exit.exitCode}${buf.trim() ? '' : ' and returned an empty response'}`,
      code,
      { exit_code: exit.exitCode, output_length: buf.length },
    );
  } else {
    await logger?.succeed(logHandle, {
      output: buf,
      ...(logging?.pageNodeId && { pageNodeId: logging.pageNodeId }),
      responsePayload: { exit_code: exit.exitCode },
    });
    logging?.onSucceeded?.(logHandle, buf);
  }
  return buf;
}

function validateContentGraphOutput(output: string): string | null {
  const match = /```json#content-graph\s*\n([\s\S]*?)```/i.exec(output)
    ?? /```json\s*\n([\s\S]*?)```/i.exec(output);
  if (!match?.[1]) return 'Agent response did not contain a content-graph';
  try {
    const graph = parseGraphJsonTolerant(match[1].trim()) as { nodes?: unknown[] };
    return Array.isArray(graph.nodes) && graph.nodes.length > 0
      ? null
      : 'Agent content-graph did not contain any nodes';
  } catch (error) {
    return `Agent content-graph was invalid: ${error instanceof Error ? error.message : String(error)}`;
  }
}
