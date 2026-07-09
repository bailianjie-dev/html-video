import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { RequestContextStorage, type Project } from '@html-video/core';
import { ExportJobTracker } from '../src/export-job-tracker.ts';

class MemoryAlbumRepository {
  rows = [
    album('album-alice', 'alice'),
    album('album-bob', 'bob'),
  ];

  async findBySourceProjectId(userId: string, projectId: string) {
    await delay(userId === 'alice' ? 4 : 1);
    return this.rows.find(
      (row) => row.user_id === userId && row.source_project_id === projectId,
    ) ?? null;
  }

  async findById(userId: string, id: string) {
    return this.rows.find((row) => row.user_id === userId && row.id === id) ?? null;
  }
}

class MemoryExportJobRepository {
  rows: Array<Record<string, any>> = [];

  async create(input: Record<string, any>) {
    const row = {
      ...input,
      created_time: new Date(),
      updated_time: new Date(),
    };
    this.rows.push(row);
    return row;
  }

  async update(
    userId: string,
    id: string,
    patch: Record<string, any>,
    updatedBy: string,
  ) {
    const row = this.rows.find((item) => item.user_id === userId && item.id === id);
    if (!row) return null;
    Object.assign(row, patch, {
      updated_by: updatedBy,
      updated_time: new Date(),
    });
    return row;
  }

  async findById(userId: string, id: string) {
    return this.rows.find(
      (row) => row.user_id === userId && row.id === id,
    ) ?? null;
  }

  async listByAlbum(
    userId: string,
    albumId: string,
    opts: { limit?: number; offset?: number } = {},
  ) {
    const offset = opts.offset ?? 0;
    return this.rows
      .filter((row) => row.user_id === userId && row.album_id === albumId)
      .slice(offset, offset + (opts.limit ?? 100));
  }
}

function album(id: string, userId: string) {
  const now = new Date();
  return {
    id,
    user_id: userId,
    source_project_id: 'shared-project',
    title: `${userId} album`,
    status: 'draft',
    created_time: now,
    updated_time: now,
  };
}

function project(name: string): Project {
  const now = new Date().toISOString();
  return {
    id: 'shared-project',
    name,
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
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('isolates export tracking and queries across asynchronous user requests', async (t) => {
  const outputDir = await mkdtemp(join(tmpdir(), 'html-video-export-job-'));
  t.after(() => rm(outputDir, { recursive: true, force: true }));
  const outputPath = join(outputDir, 'alice.mp4');
  await writeFile(outputPath, Buffer.from('alice-export'));

  const contexts = new RequestContextStorage();
  const jobs = new MemoryExportJobRepository();
  const tracker = new ExportJobTracker({
    getUserContext: () => contexts.getRequiredUser(),
    jobs,
    albums: new MemoryAlbumRepository(),
  });
  const runAs = <T>(userId: string, callback: () => Promise<T>) => contexts.run({
    requestId: `request-${userId}`,
    source: 'header',
    user: { userId, actorId: `${userId}-actor` },
  }, callback);

  const [aliceHandle, bobHandle] = await Promise.all([
    runAs('alice', async () => {
      await delay(3);
      return tracker.start(project('Alice export'), true);
    }),
    runAs('bob', async () => {
      await delay(1);
      return tracker.start(project('Bob export'), false);
    }),
  ]);

  assert.ok(aliceHandle);
  assert.ok(bobHandle);
  assert.equal(contexts.get(), undefined);

  tracker.progress(aliceHandle, 35, 'rendering');
  tracker.progress(bobHandle, 20, 'recording');
  await Promise.all([
    tracker.succeed(aliceHandle, outputPath, {
      ossBucket: 'test-bucket',
      ossKey: `exports/${aliceHandle.id}/output.mp4`,
      outputUrl: `https://example.test/exports/${aliceHandle.id}/output.mp4`,
    }),
    tracker.fail(bobHandle, new Error('Bob render failed')),
  ]);

  const [aliceResult, bobResult] = await Promise.all([
    runAs('alice', () => tracker.listForProject('shared-project')),
    runAs('bob', () => tracker.listForProject('shared-project')),
  ]);
  assert.equal(aliceResult.album.id, 'album-alice');
  assert.deepEqual(aliceResult.jobs.map((job) => job.id), [aliceHandle.id]);
  assert.equal(aliceResult.jobs[0]?.status, 'succeeded');
  assert.equal(aliceResult.jobs[0]?.oss_bucket, 'test-bucket');
  assert.equal(aliceResult.jobs[0]?.oss_key, `exports/${aliceHandle.id}/output.mp4`);
  assert.equal(
    aliceResult.jobs[0]?.output_url,
    `https://example.test/exports/${aliceHandle.id}/output.mp4`,
  );
  assert.equal(aliceResult.jobs[0]?.updated_by, 'alice-actor');
  assert.equal(bobResult.album.id, 'album-bob');
  assert.deepEqual(bobResult.jobs.map((job) => job.id), [bobHandle.id]);
  assert.equal(bobResult.jobs[0]?.status, 'failed');
  assert.equal(bobResult.jobs[0]?.updated_by, 'bob-actor');

  assert.equal(
    await runAs('bob', () => tracker.findForCurrentUser(aliceHandle.id)),
    null,
  );
  assert.equal(
    (await runAs('alice', () => tracker.findForCurrentUser(aliceHandle.id)))?.user_id,
    'alice',
  );
});

test('returns project not found when listing another user project', async () => {
  const contexts = new RequestContextStorage();
  const tracker = new ExportJobTracker({
    getUserContext: () => contexts.getRequiredUser(),
    jobs: new MemoryExportJobRepository(),
    albums: new MemoryAlbumRepository(),
  });

  await assert.rejects(
    contexts.run({
      requestId: 'request-charlie',
      source: 'header',
      user: { userId: 'charlie', actorId: 'charlie' },
    }, () => tracker.listForProject('shared-project')),
    (error) => error?.code === 'project-not-found',
  );
});
