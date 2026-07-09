import {
  AssetRepository,
  AlbumPageRepository,
  ExportJobRepository,
  type AlbumPageRow,
  type AssetRow,
  type ExportJobRow,
} from '@html-video/core';
import type { CliContext } from './context.js';
import {
  deleteFromAliyunOss,
  loadOssConfig,
  type OssConfig,
} from './oss-config.js';

const CLEANUP_ACTOR = 'oss-garbage-collector';

export interface OssGarbageCollectorOptions {
  execute?: boolean;
  retentionDays?: number;
  limit?: number;
  now?: Date;
}

export interface OssGarbageCollectorResult {
  mode: 'dry-run' | 'execute';
  cutoff: string;
  retention_days: number;
  batch_size: number;
  candidates: {
    assets: number;
    html_pages: number;
    exports: number;
    total: number;
  };
  deleted: {
    assets: number;
    html_pages: number;
    exports: number;
    total: number;
  };
  failed: Array<{
    kind: 'asset' | 'html_page' | 'export';
    id: string;
    message: string;
  }>;
}

type AssetCleanupAccess = Pick<
  AssetRepository,
  'listOssGarbageCandidates' | 'deleteGarbageCandidate'
>;
type ExportCleanupAccess = Pick<
  ExportJobRepository,
  'listOssGarbageCandidates' | 'clearOssArtifact'
>;
type PageCleanupAccess = Pick<
  AlbumPageRepository,
  'listHtmlOssGarbageCandidates' | 'clearHtmlOssLocation'
>;

export interface OssGarbageCollectorDependencies {
  config: OssConfig;
  assets: AssetCleanupAccess;
  pages: PageCleanupAccess;
  exports: ExportCleanupAccess;
  deleteObject?: (key: string) => Promise<void>;
}

export async function runOssGarbageCollector(
  ctx: CliContext,
  options: OssGarbageCollectorOptions = {},
): Promise<OssGarbageCollectorResult> {
  if (ctx.database?.mode !== 'postgres' || !ctx.database.handle) {
    throw new Error('PostgreSQL persistence must be enabled for OSS garbage collection');
  }
  const config = loadOssConfig(ctx.projectRoot);
  if (!config?.enabled) {
    throw new Error('OSS must be enabled for OSS garbage collection');
  }
  return collectOssGarbage({
    config,
    assets: new AssetRepository(ctx.database.handle.db),
    pages: new AlbumPageRepository(ctx.database.handle.db),
    exports: new ExportJobRepository(ctx.database.handle.db),
  }, options);
}

export async function collectOssGarbage(
  deps: OssGarbageCollectorDependencies,
  options: OssGarbageCollectorOptions = {},
): Promise<OssGarbageCollectorResult> {
  const retentionDays = boundedInteger(
    options.retentionDays,
    deps.config.garbageRetentionDays,
    0,
    3650,
  );
  const limit = boundedInteger(options.limit, deps.config.garbageBatchSize, 1, 1000);
  const now = options.now ?? new Date();
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);
  const [assets, pages, exports] = await Promise.all([
    deps.assets.listOssGarbageCandidates(cutoff, limit),
    deps.pages.listHtmlOssGarbageCandidates(cutoff, limit),
    deps.exports.listOssGarbageCandidates(cutoff, limit),
  ]);
  const result: OssGarbageCollectorResult = {
    mode: options.execute ? 'execute' : 'dry-run',
    cutoff: cutoff.toISOString(),
    retention_days: retentionDays,
    batch_size: limit,
    candidates: {
      assets: assets.length,
      html_pages: pages.length,
      exports: exports.length,
      total: assets.length + pages.length + exports.length,
    },
    deleted: { assets: 0, html_pages: 0, exports: 0, total: 0 },
    failed: [],
  };
  if (!options.execute) return result;

  const deleteObject = deps.deleteObject
    ?? ((key: string) => deleteFromAliyunOss(deps.config, { key }));
  for (const asset of assets) {
    await cleanAsset(asset, deps, deleteObject, result);
  }
  for (const page of pages) {
    await cleanHtmlPage(page, deps, deleteObject, result);
  }
  for (const job of exports) {
    await cleanExport(job, deps, deleteObject, result);
  }
  result.deleted.total =
    result.deleted.assets + result.deleted.html_pages + result.deleted.exports;
  return result;
}

async function cleanHtmlPage(
  page: AlbumPageRow,
  deps: OssGarbageCollectorDependencies,
  deleteObject: (key: string) => Promise<void>,
  result: OssGarbageCollectorResult,
): Promise<void> {
  if (page.html_oss_bucket !== deps.config.bucket || !page.html_oss_key) {
    result.failed.push(bucketMismatch('html_page', page.id));
    return;
  }
  try {
    await deleteObject(page.html_oss_key);
    const updated = await deps.pages.clearHtmlOssLocation(
      page.user_id,
      page.id,
      CLEANUP_ACTOR,
    );
    if (!updated) throw new Error('album page disappeared before cleanup metadata was updated');
    result.deleted.html_pages += 1;
  } catch (error) {
    result.failed.push(cleanupFailure('html_page', page.id, error));
  }
}

async function cleanAsset(
  asset: AssetRow,
  deps: OssGarbageCollectorDependencies,
  deleteObject: (key: string) => Promise<void>,
  result: OssGarbageCollectorResult,
): Promise<void> {
  if (asset.oss_bucket !== deps.config.bucket) {
    result.failed.push(bucketMismatch('asset', asset.id));
    return;
  }
  try {
    await deleteObject(asset.oss_key);
    const deleted = await deps.assets.deleteGarbageCandidate(asset.user_id, asset.id);
    if (!deleted) throw new Error('asset is no longer an eligible soft-deleted row');
    result.deleted.assets += 1;
  } catch (error) {
    result.failed.push(cleanupFailure('asset', asset.id, error));
  }
}

async function cleanExport(
  job: ExportJobRow,
  deps: OssGarbageCollectorDependencies,
  deleteObject: (key: string) => Promise<void>,
  result: OssGarbageCollectorResult,
): Promise<void> {
  if (job.oss_bucket !== deps.config.bucket || !job.oss_key) {
    result.failed.push(bucketMismatch('export', job.id));
    return;
  }
  try {
    await deleteObject(job.oss_key);
    const updated = await deps.exports.clearOssArtifact(job.user_id, job.id, CLEANUP_ACTOR);
    if (!updated) throw new Error('export job disappeared before cleanup metadata was updated');
    result.deleted.exports += 1;
  } catch (error) {
    result.failed.push(cleanupFailure('export', job.id, error));
  }
}

function bucketMismatch(kind: 'asset' | 'html_page' | 'export', id: string) {
  return {
    kind,
    id,
    message: 'object bucket does not match the configured OSS bucket',
  } as const;
}

function cleanupFailure(
  kind: 'asset' | 'html_page' | 'export',
  id: string,
  error: unknown,
) {
  return {
    kind,
    id,
    message: error instanceof Error ? error.message : String(error),
  };
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`value must be an integer between ${min} and ${max}`);
  }
  return value;
}
