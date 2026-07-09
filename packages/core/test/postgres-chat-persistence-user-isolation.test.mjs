import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PostgresChatPersistence,
  RequestContextStorage,
} from '../dist/index.js';

class MemoryAlbumRepository {
  rows = [
    album('album-alice', 'alice'),
    album('album-bob', 'bob'),
  ];

  async findBySourceProjectId(userId, projectId) {
    return this.rows.find(
      (row) => row.user_id === userId && row.source_project_id === projectId,
    ) ?? null;
  }

  async findById(userId, id) {
    return this.rows.find((row) => row.user_id === userId && row.id === id) ?? null;
  }
}

class MemorySessionRepository {
  rows = [];

  async create(input) {
    const now = new Date();
    const row = {
      ...input,
      status: input.status ?? 'active',
      title: input.title ?? null,
      last_message_seq: input.last_message_seq ?? 0,
      metadata: input.metadata ?? {},
      created_time: now,
      updated_time: now,
    };
    this.rows.push(row);
    return row;
  }

  async findActiveByAlbum(userId, albumId) {
    return this.rows.find(
      (row) => row.user_id === userId && row.album_id === albumId && row.status === 'active',
    ) ?? null;
  }

  async nextMessageSequence(userId, sessionId, updatedBy) {
    const row = this.rows.find(
      (item) => item.user_id === userId && item.id === sessionId,
    );
    if (!row) return null;
    row.last_message_seq += 1;
    row.updated_by = updatedBy;
    row.updated_time = new Date();
    return row.last_message_seq;
  }
}

class MemoryMessageRepository {
  rows = [];

  async create(input) {
    const now = new Date();
    const row = {
      ...input,
      request_id: input.request_id ?? null,
      agent: input.agent ?? null,
      tool: input.tool ?? null,
      payload: input.payload ?? {},
      occurred_time: input.occurred_time ?? now,
      created_time: now,
      updated_time: now,
    };
    this.rows.push(row);
    return row;
  }

  async listBySession(userId, sessionId) {
    return this.rows
      .filter((row) => row.user_id === userId && row.session_id === sessionId)
      .sort((left, right) => left.sequence_no - right.sequence_no);
  }
}

function album(id, userId) {
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

function fixture() {
  const contexts = new RequestContextStorage();
  const sessions = new MemorySessionRepository();
  const messages = new MemoryMessageRepository();
  const persistence = new PostgresChatPersistence({
    getUserContext: () => contexts.getRequiredUser(),
    getRequestId: () => contexts.get()?.requestId,
    albums: new MemoryAlbumRepository(),
    sessions,
    messages,
  });
  const runAs = (userId, requestId, callback) => contexts.run({
    requestId,
    source: 'header',
    user: { userId, actorId: `${userId}-actor` },
  }, callback);
  return { messages, persistence, runAs, sessions };
}

test('persists concurrent user conversations with isolated sessions and ordering', async () => {
  const { messages, persistence, runAs, sessions } = fixture();

  await Promise.all([
    runAs('alice', 'request-alice-1', () => persistence.appendForProject(
      'shared-project',
      {
        role: 'user',
        content: '极简风格',
        messageType: 'option_selection',
        payload: {
          selection_type: 'option',
          phase: 'style',
          selection_key: 'label',
          value: { label: '极简风格' },
        },
      },
    )),
    runAs('bob', 'request-bob-1', () => persistence.appendForProject(
      'shared-project',
      {
        role: 'user',
        content: '赛博风格',
        messageType: 'option_selection',
        payload: {
          selection_type: 'option',
          phase: 'style',
          selection_key: 'label',
          value: { label: '赛博风格' },
        },
      },
    )),
  ]);
  await runAs('alice', 'request-alice-2', () => persistence.appendForProject(
    'shared-project',
    { role: 'assistant', content: '已生成', agent: 'test-agent' },
  ));

  const [aliceMessages, bobMessages] = await Promise.all([
    runAs('alice', 'request-alice-list', () => persistence.listForProject('shared-project')),
    runAs('bob', 'request-bob-list', () => persistence.listForProject('shared-project')),
  ]);
  assert.deepEqual(aliceMessages.map((row) => row.content), ['极简风格', '已生成']);
  assert.deepEqual(aliceMessages.map((row) => row.sequence_no), [1, 2]);
  assert.deepEqual(bobMessages.map((row) => row.content), ['赛博风格']);
  assert.equal(sessions.rows.filter((row) => row.user_id === 'alice').length, 1);
  assert.equal(sessions.rows.filter((row) => row.user_id === 'bob').length, 1);
  assert.equal(messages.rows.find((row) => row.user_id === 'alice')?.request_id, 'request-alice-1');
  assert.equal(messages.rows.find((row) => row.role === 'assistant')?.created_by, 'alice-actor');
  assert.equal(messages.rows.find((row) => row.user_id === 'alice')?.payload.phase, 'style');
  assert.equal(messages.rows.find((row) => row.user_id === 'bob')?.payload.value.label, '赛博风格');
});

test('treats another user conversation as a missing project', async () => {
  const { persistence, runAs } = fixture();

  await assert.rejects(
    runAs('charlie', 'request-charlie', () => persistence.listForProject('shared-project')),
    (error) => error?.code === 'project-not-found',
  );
});
