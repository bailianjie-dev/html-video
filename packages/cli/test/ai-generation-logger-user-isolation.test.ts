import assert from 'node:assert/strict';
import test from 'node:test';
import { RequestContextStorage } from '@html-video/core';
import { AiGenerationLogger } from '../src/ai-generation-logger.ts';

class MemoryAlbumRepository {
  rows = [
    { id: 'album-alice', user_id: 'alice', source_project_id: 'shared-project' },
    { id: 'album-bob', user_id: 'bob', source_project_id: 'shared-project' },
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

class MemoryPageRepository {
  rows = [
    { id: 'page-alice', user_id: 'alice', album_id: 'album-alice', node_id: 'intro' },
    { id: 'page-bob', user_id: 'bob', album_id: 'album-bob', node_id: 'intro' },
  ];

  async findByNodeId(userId: string, albumId: string, nodeId: string) {
    await delay(userId === 'bob' ? 4 : 1);
    return this.rows.find(
      (row) => row.user_id === userId
        && row.album_id === albumId
        && row.node_id === nodeId,
    ) ?? null;
  }
}

class MemoryLogRepository {
  rows: Array<Record<string, any>> = [];

  async create(input: Record<string, any>) {
    const row = {
      ...input,
      response_payload: input.response_payload ?? {},
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
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('keeps concurrent AI logs isolated and completes them after request scopes end', async () => {
  const contexts = new RequestContextStorage();
  const logs = new MemoryLogRepository();
  const logger = new AiGenerationLogger({
    getUserContext: () => contexts.getRequiredUser(),
    logs,
    albums: new MemoryAlbumRepository(),
    pages: new MemoryPageRepository(),
  });
  const runAs = <T>(userId: string, callback: () => Promise<T>) => contexts.run({
    requestId: `request-${userId}`,
    source: 'header',
    user: { userId, actorId: `${userId}-actor` },
  }, callback);

  const [aliceHandle, bobHandle] = await Promise.all([
    runAs('alice', async () => {
      await delay(3);
      return logger.start({
        projectId: 'shared-project',
        pageNodeId: 'intro',
        generationType: 'page_html',
        provider: 'test-agent',
        model: 'test-model',
        operationId: 'operation-alice',
        attempt: 1,
      });
    }),
    runAs('bob', async () => {
      await delay(1);
      return logger.start({
        projectId: 'shared-project',
        pageNodeId: 'intro',
        generationType: 'page_html',
        provider: 'test-agent',
        model: 'test-model',
        operationId: 'operation-bob',
        attempt: 1,
      });
    }),
  ]);

  assert.ok(aliceHandle);
  assert.ok(bobHandle);
  assert.equal(contexts.get(), undefined);

  await Promise.all([
    logger.succeed(aliceHandle, { output: '<html>Alice</html>' }),
    logger.fail(bobHandle, new Error('Bob generation failed')),
  ]);

  const aliceLog = logs.rows.find((row) => row.user_id === 'alice');
  const bobLog = logs.rows.find((row) => row.user_id === 'bob');
  assert.equal(aliceLog?.album_id, 'album-alice');
  assert.equal(aliceLog?.page_id, 'page-alice');
  assert.equal(aliceLog?.created_by, 'alice-actor');
  assert.equal(aliceLog?.updated_by, 'alice-actor');
  assert.equal(aliceLog?.status, 'succeeded');
  assert.equal(bobLog?.album_id, 'album-bob');
  assert.equal(bobLog?.page_id, 'page-bob');
  assert.equal(bobLog?.created_by, 'bob-actor');
  assert.equal(bobLog?.updated_by, 'bob-actor');
  assert.equal(bobLog?.status, 'failed');
});
