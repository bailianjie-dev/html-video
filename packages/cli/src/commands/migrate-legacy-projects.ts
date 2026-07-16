import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import {
  AlbumPageRepository,
  AlbumRepository,
  AssetRepository,
  AssetStore,
  PostgresProjectPersistence,
  safeWorkDirectorySegment,
  type AssetRow,
  type DbAssetType,
  type JsonObject,
  type Project,
} from '@html-video/core';
import type { ContentGraph } from '@html-video/content-graph';
import type { CliContext } from '../context.js';
import { loadAuthConfig } from '../auth-config.js';
import { createHtmlOssPublisher } from '../html-oss-publisher.js';
import { loadOssConfig, uploadToAliyunOss } from '../oss-config.js';

export interface LegacyProjectMigrationOptions {
  execute?: boolean;
  userId?: string;
  projectId?: string;
  limit?: number;
}

export interface LegacyProjectMigrationResult {
  execute: boolean;
  legacy_root: string;
  scanned_projects: number;
  migrated_projects: number;
  skipped_projects: number;
  uploaded_assets: number;
  reused_assets: number;
  migrated_html_pages: number;
  projects: LegacyProjectMigrationProjectResult[];
}

interface LegacyProjectMigrationProjectResult {
  project_id: string;
  user_id: string | null;
  project_json: string;
  status: 'dry-run' | 'migrated' | 'skipped' | 'failed';
  reason?: string;
  assets_found: number;
  assets_uploaded: number;
  assets_reused: number;
  html_pages: number;
}

interface UploadedLegacyAsset {
  filePath: string;
  row: AssetRow;
}

const MEDIA_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.gif',
  '.svg',
  '.mp3',
  '.wav',
  '.aac',
  '.m4a',
  '.mp4',
  '.webm',
  '.mov',
  '.woff',
  '.woff2',
  '.ttf',
  '.otf',
]);

export async function migrateLegacyProjects(
  ctx: CliContext,
  opts: LegacyProjectMigrationOptions = {},
): Promise<LegacyProjectMigrationResult> {
  if (ctx.database?.mode !== 'postgres' || !ctx.database.handle) {
    throw new Error('Legacy migration requires database.enabled = true.');
  }
  const oss = loadOssConfig(ctx.projectRoot);
  if (opts.execute && !oss?.enabled) {
    throw new Error('Legacy migration with --execute requires oss.enabled = true.');
  }

  const legacyRoot = resolve(ctx.projectRoot, '.html-video', 'projects');
  const projectJsons = existsSync(legacyRoot)
    ? await findProjectJsonFiles(legacyRoot)
    : [];
  const authUsers = loadAuthConfig(ctx.projectRoot)?.users.map((user) => user.userId) ?? [];
  const limited = opts.limit ? projectJsons.slice(0, Math.max(0, opts.limit)) : projectJsons;
  const result: LegacyProjectMigrationResult = {
    execute: Boolean(opts.execute),
    legacy_root: legacyRoot,
    scanned_projects: 0,
    migrated_projects: 0,
    skipped_projects: 0,
    uploaded_assets: 0,
    reused_assets: 0,
    migrated_html_pages: 0,
    projects: [],
  };

  for (const projectJson of limited) {
    const project = JSON.parse(await readFile(projectJson, 'utf8')) as Project;
    if (opts.projectId && project.id !== opts.projectId) continue;
    result.scanned_projects += 1;
    const userId = inferLegacyUserId(projectJson, legacyRoot, opts.userId, authUsers);
    const projectDir = dirname(projectJson);
    const assets = await collectLegacyAssetFiles(projectDir, project);
    const htmlPages = await collectLegacyHtmlPages(projectDir, project);
    const projectResult: LegacyProjectMigrationProjectResult = {
      project_id: project.id,
      user_id: userId,
      project_json: projectJson,
      status: opts.execute ? 'skipped' : 'dry-run',
      assets_found: assets.length,
      assets_uploaded: 0,
      assets_reused: 0,
      html_pages: htmlPages.length,
    };

    if (!userId) {
      projectResult.status = 'skipped';
      projectResult.reason = 'Cannot infer target user. Pass --user <user_id>.';
      result.skipped_projects += 1;
      result.projects.push(projectResult);
      continue;
    }
    if (htmlPages.length === 0 && assets.length === 0) {
      projectResult.status = 'skipped';
      projectResult.reason = 'No preview/frame HTML or media assets found.';
      result.skipped_projects += 1;
      result.projects.push(projectResult);
      continue;
    }
    if (!opts.execute) {
      result.projects.push(projectResult);
      continue;
    }

    try {
      await ctx.requestContexts.run({
        requestId: randomUUID(),
        source: 'external',
        user: { userId, actorId: userId },
      }, async () => {
        const migrated = await migrateOneLegacyProject(ctx, projectDir, project, assets, htmlPages);
        projectResult.assets_uploaded = migrated.assetsUploaded;
        projectResult.assets_reused = migrated.assetsReused;
        projectResult.html_pages = migrated.htmlPages;
      });
      projectResult.status = 'migrated';
      result.migrated_projects += 1;
      result.uploaded_assets += projectResult.assets_uploaded;
      result.reused_assets += projectResult.assets_reused;
      result.migrated_html_pages += projectResult.html_pages;
    } catch (error) {
      projectResult.status = 'failed';
      projectResult.reason = error instanceof Error ? error.message : String(error);
      result.skipped_projects += 1;
    }
    result.projects.push(projectResult);
  }

  return result;
}

async function migrateOneLegacyProject(
  ctx: CliContext,
  projectDir: string,
  project: Project,
  assetFiles: string[],
  htmlPages: LegacyHtmlPage[],
): Promise<{ assetsUploaded: number; assetsReused: number; htmlPages: number }> {
  const db = ctx.database?.handle?.db;
  if (!db) throw new Error('PostgreSQL database handle is not available');
  const user = ctx.requestContexts.getRequiredUser();
  const albums = new AlbumRepository(db);
  const pages = new AlbumPageRepository(db);
  const assets = new AssetRepository(db);
  const persistence = new PostgresProjectPersistence({
    db,
    projectRoot: ctx.projectRoot,
    getUserContext: () => ctx.requestContexts.getRequiredUser(),
    publishHtml: createHtmlOssPublisher(ctx.projectRoot),
  });

  const normalizedProject = normalizeLegacyProjectPaths(projectDir, project);
  await persistence.save(normalizedProject);
  const album = await findProjectAlbum(albums, normalizedProject.id, user.userId);
  if (!album) throw new Error(`Album was not created for project ${normalizedProject.id}`);

  const existingAssets = await assets.listByAlbum(user.userId, album.id, { includeDeleted: true });
  const uploadedAssets: UploadedLegacyAsset[] = [];
  let assetsUploaded = 0;
  let assetsReused = 0;
  for (const filePath of assetFiles) {
    const bytes = await readFile(filePath);
    const checksum = createHash('sha256').update(bytes).digest('hex');
    const existing = findExistingLegacyAsset(existingAssets, filePath, checksum);
    if (existing) {
      uploadedAssets.push({ filePath, row: existing });
      assetsReused += 1;
      continue;
    }
    const created = await uploadLegacyAsset(ctx, assets, album.id, filePath, bytes, checksum);
    existingAssets.push(created);
    uploadedAssets.push({ filePath, row: created });
    assetsUploaded += 1;
  }

  const graphPath = normalizedProject.contentGraphPath;
  if (graphPath && existsSync(graphPath)) {
    const graph = JSON.parse(await readFile(graphPath, 'utf8')) as ContentGraph;
    await persistence.writeContentGraph(normalizedProject.id, graph, { preserveFrames: true });
  }

  let migratedHtmlPages = 0;
  for (const page of htmlPages) {
    const raw = await readFile(page.filePath, 'utf8');
    const rewritten = rewriteLegacyHtmlAssetReferences(raw, {
      projectDir,
      projectId: normalizedProject.id,
      assets: uploadedAssets,
    });
    if (page.kind === 'frame' && page.nodeId && page.frame) {
      await persistence.writeFrameHtml(normalizedProject.id, page.nodeId, rewritten, page.frame);
    } else {
      await persistence.writeRawHtml(normalizedProject.id, rewritten);
    }
    migratedHtmlPages += 1;
  }

  // Keep local path metadata out of the durable DB copy after a successful
  // migration. The runtime can still fall back to files if a future project has
  // not been migrated, but migrated history should be DB/OSS-addressable.
  const latest = await findProjectAlbum(albums, normalizedProject.id, user.userId);
  if (latest) {
    const settings = cleanMigratedAlbumSettings(
      latest.settings,
      normalizedProject.id,
      projectDir,
      uploadedAssets,
    );
    delete settings.local_last_preview_html_path;
    delete settings.local_last_preview_poster_path;
    delete settings.local_last_output_mp4_path;
    delete settings.content_graph_path;
    await albums.updateSettings(user.userId, latest.id, settings, user.actorId);
  }

  // Older page rows may have been created before all HTML was migrated. Refresh
  // content metadata to avoid stale local file hints where possible.
  const migratedPages = await pages.listByAlbum(user.userId, album.id);
  for (const page of migratedPages) {
    const content = { ...page.content };
    delete content.local_html_path;
    delete content.local_preview_mp4_path;
    await pages.update(user.userId, page.id, { content }, user.actorId);
  }

  return { assetsUploaded, assetsReused, htmlPages: migratedHtmlPages };
}

interface LegacyHtmlPage {
  kind: 'preview' | 'frame';
  filePath: string;
  nodeId?: string;
  frame?: NonNullable<Project['frames']>[number];
}

async function collectLegacyHtmlPages(projectDir: string, project: Project): Promise<LegacyHtmlPage[]> {
  const pages: LegacyHtmlPage[] = [];
  const previewPath = resolveLegacyPath(projectDir, project.lastPreviewHtmlPath) ?? join(projectDir, 'preview.html');
  if (existsSync(previewPath)) pages.push({ kind: 'preview', filePath: previewPath });
  for (const frame of project.frames ?? []) {
    const framePath = resolveLegacyPath(projectDir, frame.htmlPath);
    if (!framePath || !existsSync(framePath)) continue;
    pages.push({
      kind: 'frame',
      filePath: framePath,
      nodeId: frame.graphNodeId,
      frame: { ...frame, htmlPath: framePath },
    });
  }
  return pages;
}

async function collectLegacyAssetFiles(projectDir: string, project: Project): Promise<string[]> {
  const files = new Set<string>();
  for (const asset of project.assets ?? []) {
    const assetPath = resolveLegacyPath(projectDir, asset.path);
    if (assetPath && existsSync(assetPath) && MEDIA_EXTENSIONS.has(extname(assetPath).toLowerCase())) {
      files.add(assetPath);
    }
  }
  for (const filePath of await listFiles(projectDir)) {
    if (MEDIA_EXTENSIONS.has(extname(filePath).toLowerCase())) files.add(resolve(filePath));
  }
  return [...files].sort();
}

async function uploadLegacyAsset(
  ctx: CliContext,
  repo: AssetRepository,
  albumId: string,
  filePath: string,
  bytes: Buffer,
  checksum: string,
): Promise<AssetRow> {
  const oss = loadOssConfig(ctx.projectRoot);
  if (!oss?.enabled) throw new Error('OSS config is not enabled');
  const user = ctx.requestContexts.getRequiredUser();
  const id = randomUUID();
  const fileName = basename(filePath);
  const { mime } = AssetStore.guessMime(fileName);
  const key = [
    oss.prefix,
    'users',
    safeWorkDirectorySegment(user.userId, 'user'),
    'projects',
    safeWorkDirectorySegment(albumId, 'album'),
    'assets',
    id,
    safeOssFileName(fileName),
  ].filter(Boolean).join('/');
  const uploaded = await uploadToAliyunOss(oss, {
    key,
    body: bytes,
    contentType: mime,
  });
  return repo.create({
    id,
    user_id: user.userId,
    album_id: albumId,
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
    checksum_sha256: checksum,
    metadata: {
      migration: 'legacy-html-video-projects',
      migrated_at: new Date().toISOString(),
      original_legacy_path: filePath,
      oss_etag: uploaded.etag,
    },
    created_by: user.actorId,
    updated_by: user.actorId,
  });
}

function rewriteLegacyHtmlAssetReferences(
  html: string,
  opts: { projectDir: string; projectId: string; assets: UploadedLegacyAsset[] },
): string {
  let out = html;
  for (const asset of opts.assets) {
    const target = `/api/projects/${encodeURIComponent(opts.projectId)}/assets/${encodeURIComponent(asset.row.id)}/content`;
    const variants = legacyAssetReferenceVariants(opts.projectDir, asset.filePath);
    for (const variant of variants.sort((a, b) => b.length - a.length)) {
      out = out.split(variant).join(target);
    }
  }
  return out;
}

function cleanMigratedAlbumSettings(
  settings: JsonObject,
  projectId: string,
  projectDir: string,
  assets: UploadedLegacyAsset[],
): JsonObject {
  const next = { ...settings };
  if (Array.isArray(next.legacy_assets)) {
    next.legacy_assets = next.legacy_assets.map((raw) => {
      if (!isJsonObject(raw)) return raw;
      const item = { ...raw };
      if (typeof item.path === 'string') {
        const replacement = migratedAssetProxyForPath(projectDir, projectId, item.path, assets);
        if (replacement) item.path = replacement;
        else if (isLegacyLocalPath(projectDir, item.path)) delete item.path;
      }
      return item;
    });
  }
  if (Array.isArray(next.legacy_frames)) {
    next.legacy_frames = next.legacy_frames.map((raw) => {
      if (!isJsonObject(raw)) return raw;
      const item = { ...raw };
      if (typeof item.graphNodeId === 'string') {
        item.htmlPath = `/preview/${encodeURIComponent(projectId)}/frame/${encodeURIComponent(item.graphNodeId)}`;
      } else if (typeof item.htmlPath === 'string' && isLegacyLocalPath(projectDir, item.htmlPath)) {
        delete item.htmlPath;
      }
      if (typeof item.previewMp4Path === 'string' && isLegacyLocalPath(projectDir, item.previewMp4Path)) {
        delete item.previewMp4Path;
      }
      return item;
    });
  }
  if (Array.isArray(next.legacy_exports)) {
    next.legacy_exports = next.legacy_exports.filter((raw) => {
      if (!isJsonObject(raw)) return true;
      return typeof raw.path !== 'string' || !isLegacyLocalPath(projectDir, raw.path);
    });
  }
  return next;
}

function migratedAssetProxyForPath(
  projectDir: string,
  projectId: string,
  rawPath: string,
  assets: UploadedLegacyAsset[],
): string | null {
  const resolved = resolveLegacyPath(projectDir, rawPath);
  if (!resolved) return null;
  const matched = assets.find((asset) => resolve(asset.filePath) === resolve(resolved));
  if (!matched) return null;
  return `/api/projects/${encodeURIComponent(projectId)}/assets/${encodeURIComponent(matched.row.id)}/content`;
}

function isLegacyLocalPath(projectDir: string, rawPath: string): boolean {
  const resolved = resolveLegacyPath(projectDir, rawPath);
  return Boolean(resolved && isPathInside(projectDir, resolved));
}

function isPathInside(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`));
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function legacyAssetReferenceVariants(projectDir: string, filePath: string): string[] {
  const absolute = resolve(filePath);
  const relativePath = relative(projectDir, absolute);
  const relPosix = relativePath.split(sep).join('/');
  const relWindows = relativePath.split('/').join('\\');
  const encodedAbs = encodeURIComponent(absolute);
  const encodedForwardAbs = encodeURIComponent(absolute.split(sep).join('/'));
  const variants = new Set<string>([
    absolute,
    absolute.split(sep).join('/'),
    `/asset?path=${encodedAbs}`,
    `asset?path=${encodedAbs}`,
    `/asset?path=${encodedForwardAbs}`,
    `asset?path=${encodedForwardAbs}`,
    relPosix,
    relWindows,
  ]);
  if (!relativePath.includes(sep) && !relativePath.includes('/')) {
    variants.add(basename(filePath));
  }
  return [...variants].filter(Boolean);
}

function normalizeLegacyProjectPaths(projectDir: string, project: Project): Project {
  const next: Project = {
    ...project,
    assets: (project.assets ?? []).map((asset) => ({
      ...asset,
      ...(asset.path ? { path: resolveLegacyPath(projectDir, asset.path) ?? asset.path } : {}),
    })),
    frames: (project.frames ?? []).map((frame) => ({
      ...frame,
      htmlPath: resolveLegacyPath(projectDir, frame.htmlPath) ?? frame.htmlPath,
    })),
  };
  const previewPath = resolveLegacyPath(projectDir, project.lastPreviewHtmlPath);
  if (previewPath) next.lastPreviewHtmlPath = previewPath;
  const posterPath = resolveLegacyPath(projectDir, project.lastPreviewPosterPath);
  if (posterPath) next.lastPreviewPosterPath = posterPath;
  const graphPath = resolveLegacyPath(projectDir, project.contentGraphPath);
  if (graphPath) next.contentGraphPath = graphPath;
  return next;
}

function resolveLegacyPath(projectDir: string, value: string | undefined): string | undefined {
  if (!value) return undefined;
  const direct = resolve(value);
  if (existsSync(direct)) return direct;
  const byBasename = resolve(projectDir, basename(value));
  if (existsSync(byBasename)) return byBasename;
  const relativeToProject = resolve(projectDir, value);
  if (existsSync(relativeToProject)) return relativeToProject;
  return direct;
}

function findExistingLegacyAsset(
  assets: AssetRow[],
  filePath: string,
  checksum: string,
): AssetRow | null {
  const active = assets.filter((asset) => asset.status !== 'deleted');
  return active.find((asset) => {
    const metadata = asset.metadata as JsonObject;
    return metadata.original_legacy_path === filePath;
  }) ?? active.find((asset) => (
    asset.checksum_sha256 === checksum && asset.file_name === basename(filePath)
  )) ?? null;
}

async function findProjectJsonFiles(root: string): Promise<string[]> {
  const files = await listFiles(root);
  return files
    .filter((file) => basename(file) === 'project.json')
    .sort();
}

async function listFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...await listFiles(full));
    } else if (entry.isFile()) {
      out.push(resolve(full));
    }
  }
  return out;
}

function inferLegacyUserId(
  projectJson: string,
  legacyRoot: string,
  explicitUserId: string | undefined,
  authUserIds: string[],
): string | null {
  if (explicitUserId) return explicitUserId;
  const rel = relative(legacyRoot, projectJson).split(sep);
  const first = rel[0] ?? '';
  if (authUserIds.includes(first)) return first;
  if (authUserIds.includes('admin')) return 'admin';
  if (authUserIds.length === 1) return authUserIds[0]!;
  return null;
}

async function findProjectAlbum(repo: AlbumRepository, projectId: string, userId: string) {
  const bySourceProjectId = await repo.findBySourceProjectId(userId, projectId);
  if (bySourceProjectId) return bySourceProjectId;
  if (!isUuid(projectId)) return null;
  return repo.findById(userId, projectId);
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{12}$/i.test(value);
}

function safeOssFileName(fileName: string): string {
  const cleaned = fileName.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 180);
  return cleaned || 'asset.bin';
}

function assetTypeFromMime(mime: string): DbAssetType {
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('font/') || /font|woff|ttf|opentype/i.test(mime)) return 'font';
  if (mime === 'application/json' || mime.includes('csv')) return 'data';
  if (mime.startsWith('text/')) return 'text';
  return 'other';
}
