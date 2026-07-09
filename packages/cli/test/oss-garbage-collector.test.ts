import assert from 'node:assert/strict';
import test from 'node:test';
import type { AlbumPageRow, AssetRow, ExportJobRow } from '@html-video/core';
import {
  collectOssGarbage,
} from '../dist/oss-garbage-collector.js';
import type {
  OssGarbageCollectorDependencies,
} from '../src/oss-garbage-collector.ts';
import type { OssConfig } from '../src/oss-config.ts';

const config: OssConfig = {
  enabled: true,
  provider: 'aliyun',
  endpoint: 'oss.example.test',
  bucket: 'cleanup-bucket',
  accessKeyId: 'test-id',
  accessKeySecret: 'test-secret',
  publicBaseUrl: 'https://cleanup-bucket.oss.example.test',
  prefix: 'html-video/test',
  garbageRetentionDays: 7,
  garbageBatchSize: 100,
  sourcePath: 'oss.test.toml',
};

class MemoryAssets {
  rows: AssetRow[];
  deletedIds: string[] = [];

  constructor(rows: AssetRow[]) {
    this.rows = rows;
  }

  async listOssGarbageCandidates() {
    return this.rows;
  }

  async deleteGarbageCandidate(userId: string, id: string) {
    const row = this.rows.find(
      (item) => item.user_id === userId && item.id === id && item.status === 'deleted',
    ) ?? null;
    if (row) this.deletedIds.push(id);
    return row;
  }
}

class MemoryExports {
  rows: ExportJobRow[];
  clearedIds: string[] = [];

  constructor(rows: ExportJobRow[]) {
    this.rows = rows;
  }

  async listOssGarbageCandidates() {
    return this.rows;
  }

  async clearOssArtifact(userId: string, id: string) {
    const row = this.rows.find((item) => item.user_id === userId && item.id === id) ?? null;
    if (row) {
      row.oss_bucket = null;
      row.oss_key = null;
      row.output_url = null;
      this.clearedIds.push(id);
    }
    return row;
  }
}

class MemoryPages {
  rows: AlbumPageRow[];
  clearedIds: string[] = [];

  constructor(rows: AlbumPageRow[] = []) {
    this.rows = rows;
  }

  async listHtmlOssGarbageCandidates() {
    return this.rows;
  }

  async clearHtmlOssLocation(userId: string, id: string) {
    const row = this.rows.find((item) => item.user_id === userId && item.id === id) ?? null;
    if (row) {
      row.html_oss_bucket = null;
      row.html_oss_key = null;
      row.html_url = null;
      row.html_checksum_sha256 = null;
      this.clearedIds.push(id);
    }
    return row;
  }
}

test('dry-run reports expired asset and export candidates without deleting objects', async () => {
  const assets = new MemoryAssets([asset('asset-1')]);
  const exports = new MemoryExports([exportJob('export-1')]);
  const deletedKeys: string[] = [];

  const result = await collectOssGarbage(deps(assets, exports, async (key) => {
    deletedKeys.push(key);
  }), {
    now: new Date('2026-07-09T00:00:00.000Z'),
  });

  assert.equal(result.mode, 'dry-run');
  assert.equal(result.cutoff, '2026-07-02T00:00:00.000Z');
  assert.deepEqual(result.candidates, {
    assets: 1,
    html_pages: 0,
    exports: 1,
    total: 2,
  });
  assert.deepEqual(result.deleted, {
    assets: 0,
    html_pages: 0,
    exports: 0,
    total: 0,
  });
  assert.deepEqual(deletedKeys, []);
  assert.deepEqual(assets.deletedIds, []);
  assert.deepEqual(exports.clearedIds, []);
});

test('execute removes OSS objects before purging asset rows and clearing export locations', async () => {
  const assets = new MemoryAssets([asset('asset-1')]);
  const exports = new MemoryExports([exportJob('export-1')]);
  const pages = new MemoryPages([htmlPage('page-1')]);
  const deletedKeys: string[] = [];

  const result = await collectOssGarbage(deps(assets, exports, async (key) => {
    deletedKeys.push(key);
  }, pages), { execute: true });

  assert.deepEqual(deletedKeys, [
    'projects/project-1/assets/asset-1/image.png',
    'projects/project-1/html/page-1.html',
    'projects/project-1/exports/export-1/output.mp4',
  ]);
  assert.deepEqual(assets.deletedIds, ['asset-1']);
  assert.deepEqual(pages.clearedIds, ['page-1']);
  assert.deepEqual(exports.clearedIds, ['export-1']);
  assert.deepEqual(result.deleted, {
    assets: 1,
    html_pages: 1,
    exports: 1,
    total: 3,
  });
  assert.deepEqual(result.failed, []);
});

test('execute keeps database metadata when OSS deletion fails or the bucket mismatches', async () => {
  const assets = new MemoryAssets([
    asset('asset-fails'),
    asset('asset-other-bucket', 'another-bucket'),
  ]);
  const exports = new MemoryExports([]);

  const result = await collectOssGarbage(deps(assets, exports, async () => {
    throw new Error('temporary OSS failure');
  }), { execute: true });

  assert.deepEqual(assets.deletedIds, []);
  assert.equal(result.deleted.total, 0);
  assert.deepEqual(result.failed.map((item) => item.id), [
    'asset-fails',
    'asset-other-bucket',
  ]);
});

function deps(
  assets: MemoryAssets,
  exports: MemoryExports,
  deleteObject: (key: string) => Promise<void>,
  pages = new MemoryPages(),
): OssGarbageCollectorDependencies {
  return { config: { ...config }, assets, pages, exports, deleteObject };
}

function asset(id: string, bucket = config.bucket): AssetRow {
  const now = new Date('2026-06-01T00:00:00.000Z');
  return {
    id,
    user_id: 'user-1',
    album_id: 'album-1',
    page_id: null,
    asset_type: 'image',
    usage_type: 'source',
    source: 'upload',
    status: 'deleted',
    oss_bucket: bucket,
    oss_key: `projects/project-1/assets/${id}/image.png`,
    url: `https://example.test/${id}`,
    thumbnail_url: null,
    file_name: 'image.png',
    mime_type: 'image/png',
    file_ext: '.png',
    file_size_bytes: 10,
    width: null,
    height: null,
    duration_ms: null,
    checksum_sha256: null,
    metadata: {},
    created_by: 'user-1',
    updated_by: 'user-1',
    created_time: now,
    updated_time: now,
  };
}

function htmlPage(id: string): AlbumPageRow {
  const now = new Date('2026-06-01T00:00:00.000Z');
  return {
    id,
    user_id: 'user-1',
    album_id: 'album-1',
    node_id: 'preview',
    page_no: 1,
    title: 'Preview',
    status: 'ready',
    template_key: null,
    duration_ms: 3000,
    raw_html: '<html></html>',
    html_oss_bucket: config.bucket,
    html_oss_key: `projects/project-1/html/${id}.html`,
    html_url: `https://example.test/${id}.html`,
    html_checksum_sha256: null,
    preview_asset_id: null,
    poster_asset_id: null,
    content: {},
    style: {},
    transition: {},
    created_by: 'user-1',
    updated_by: 'user-1',
    created_time: now,
    updated_time: now,
  };
}

function exportJob(id: string): ExportJobRow {
  const now = new Date('2026-06-01T00:00:00.000Z');
  return {
    id,
    user_id: 'user-1',
    album_id: 'album-1',
    status: 'succeeded',
    export_format: 'mp4',
    render_profile: 'mp4_1920x1080',
    width: 1920,
    height: 1080,
    fps: 30,
    duration_ms: 5000,
    progress_percent: 100,
    attempt_count: 1,
    request_params: {},
    local_output_path: null,
    oss_bucket: config.bucket,
    oss_key: `projects/project-1/exports/${id}/output.mp4`,
    output_url: `https://example.test/${id}.mp4`,
    file_size_bytes: 10,
    checksum_sha256: null,
    error_code: null,
    error_message: null,
    queued_time: now,
    started_time: now,
    finished_time: now,
    created_by: 'user-1',
    updated_by: 'user-1',
    created_time: now,
    updated_time: now,
  };
}
