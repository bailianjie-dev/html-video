import assert from 'node:assert/strict';
import test from 'node:test';
import { PostgresChatPersistence, RequestContextStorage } from '../dist/index.js';

class MemoryAlbumRepository {
  rows = [
    album('album-alice', 'alice'),
    album('album-alice-other', 'alice', 'alice-other-project'),
    album('album-bob', 'bob'),
  ];

  async findBySourceProjectId(userId, projectId) {
    return (
      this.rows.find((row) => row.user_id === userId && row.source_project_id === projectId) ?? null
    );
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

  async createForAlbum(input) {
    return this.create(input);
  }

  async findById(userId, albumId, sessionId) {
    return (
      this.rows.find(
        (row) => row.user_id === userId && row.album_id === albumId && row.id === sessionId,
      ) ?? null
    );
  }

  async listByAlbum(userId, albumId, status) {
    return this.rows
      .filter(
        (row) =>
          row.user_id === userId && row.album_id === albumId && (!status || row.status === status),
      )
      .sort((left, right) => right.updated_time.getTime() - left.updated_time.getTime());
  }

  async findActiveByAlbum(userId, albumId) {
    return (
      this.rows.find(
        (row) => row.user_id === userId && row.album_id === albumId && row.status === 'active',
      ) ?? null
    );
  }

  async mergeMetadata(userId, sessionId, metadata, updatedBy) {
    const row = this.rows.find((item) => item.user_id === userId && item.id === sessionId);
    if (!row) return null;
    row.metadata = { ...row.metadata, ...metadata };
    row.updated_by = updatedBy;
    row.updated_time = new Date();
    return row;
  }

  async updateTitle(userId, albumId, sessionId, title, updatedBy) {
    const row = await this.findById(userId, albumId, sessionId);
    if (!row) return null;
    row.title = title;
    row.updated_by = updatedBy;
    row.updated_time = new Date();
    return row;
  }

  async updateStatus(userId, albumId, sessionId, status, updatedBy) {
    const row = await this.findById(userId, albumId, sessionId);
    if (!row) return null;
    row.status = status;
    row.updated_by = updatedBy;
    row.updated_time = new Date();
    return row;
  }

  async nextMessageSequence(userId, sessionId, updatedBy) {
    const row = this.rows.find((item) => item.user_id === userId && item.id === sessionId);
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

function album(id, userId, sourceProjectId = 'shared-project') {
  const now = new Date();
  return {
    id,
    user_id: userId,
    source_project_id: sourceProjectId,
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
  const runAs = (userId, requestId, callback) =>
    contexts.run(
      {
        requestId,
        source: 'header',
        user: { userId, actorId: `${userId}-actor` },
      },
      callback,
    );
  return { messages, persistence, runAs, sessions };
}

test('persists concurrent user conversations with isolated sessions and ordering', async () => {
  const { messages, persistence, runAs, sessions } = fixture();

  await Promise.all([
    runAs('alice', 'request-alice-1', () =>
      persistence.appendForProject('shared-project', {
        role: 'user',
        content: '极简风格',
        messageType: 'option_selection',
        payload: {
          selection_type: 'option',
          phase: 'style',
          selection_key: 'label',
          value: { label: '极简风格' },
        },
      }),
    ),
    runAs('bob', 'request-bob-1', () =>
      persistence.appendForProject('shared-project', {
        role: 'user',
        content: '赛博风格',
        messageType: 'option_selection',
        payload: {
          selection_type: 'option',
          phase: 'style',
          selection_key: 'label',
          value: { label: '赛博风格' },
        },
      }),
    ),
  ]);
  await runAs('alice', 'request-alice-2', () =>
    persistence.appendForProject('shared-project', {
      role: 'assistant',
      content: '已生成',
      agent: 'test-agent',
    }),
  );

  const [aliceMessages, bobMessages] = await Promise.all([
    runAs('alice', 'request-alice-list', () => persistence.listForProject('shared-project')),
    runAs('bob', 'request-bob-list', () => persistence.listForProject('shared-project')),
  ]);
  assert.deepEqual(
    aliceMessages.map((row) => row.content),
    ['极简风格', '已生成'],
  );
  assert.deepEqual(
    aliceMessages.map((row) => row.sequence_no),
    [1, 2],
  );
  assert.deepEqual(
    bobMessages.map((row) => row.content),
    ['赛博风格'],
  );
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

test('creates an agent session and merges runtime metadata', async () => {
  const { persistence, runAs } = fixture();

  const session = await runAs('alice', 'request-agent-session', () =>
    persistence.getOrCreateSessionForProject('shared-project', {
      model: 'qwen3.7-plus',
      system_prompt_version: 'album-agent-v1-phase1',
      toolset_version: 'album-tools-v1-none',
    }),
  );

  assert.equal(session.metadata.model, 'qwen3.7-plus');
  assert.equal(session.metadata.system_prompt_version, 'album-agent-v1-phase1');
  assert.equal(session.metadata.toolset_version, 'album-tools-v1-none');
});

test('creates multiple active sessions for one album with isolated message ordering', async () => {
  const { persistence, runAs, sessions } = fixture();

  const [planning, editing] = await runAs('alice', 'request-create-sessions', async () =>
    Promise.all([
      persistence.createSessionForProject('shared-project', {
        title: 'Planning',
        metadata: { model: 'qwen3.7-plus' },
      }),
      persistence.createSessionForProject('shared-project', { title: 'Editing' }),
    ]),
  );

  await Promise.all([
    runAs('alice', 'request-planning-message', () =>
      persistence.appendForSession('shared-project', planning.id, {
        role: 'user',
        content: 'Plan the album',
      }),
    ),
    runAs('alice', 'request-editing-message', () =>
      persistence.appendForSession('shared-project', editing.id, {
        role: 'user',
        content: 'Edit page one',
      }),
    ),
  ]);

  const [planningMessages, editingMessages, activeSessions] = await runAs(
    'alice',
    'request-list-sessions',
    () =>
      Promise.all([
        persistence.listForSession('shared-project', planning.id),
        persistence.listForSession('shared-project', editing.id),
        persistence.listSessionsForProject('shared-project', 'active'),
      ]),
  );

  assert.deepEqual(
    planningMessages.map((row) => row.content),
    ['Plan the album'],
  );
  assert.deepEqual(
    editingMessages.map((row) => row.content),
    ['Edit page one'],
  );
  assert.equal(planningMessages[0].sequence_no, 1);
  assert.equal(editingMessages[0].sequence_no, 1);
  assert.deepEqual(
    new Set(activeSessions.map((row) => row.id)),
    new Set([planning.id, editing.id]),
  );
  assert.equal(
    sessions.rows.filter((row) => row.user_id === 'alice' && row.status === 'active').length,
    2,
  );
});

test('updates one session without changing sibling session state', async () => {
  const { persistence, runAs } = fixture();
  const [first, second] = await runAs('alice', 'request-create-two', () =>
    Promise.all([
      persistence.createSessionForProject('shared-project', { title: 'First' }),
      persistence.createSessionForProject('shared-project', { title: 'Second' }),
    ]),
  );

  await runAs('alice', 'request-update-first', async () => {
    await persistence.updateSessionTitleForProject('shared-project', first.id, 'Renamed');
    await persistence.mergeSessionMetadataForProject('shared-project', first.id, {
      view_state: { activePageIndex: 2 },
    });
    await persistence.updateSessionStatusForProject('shared-project', first.id, 'archived');
  });

  const [archived, untouched] = await runAs('alice', 'request-read-two', () =>
    Promise.all([
      persistence.getSessionForProject('shared-project', first.id),
      persistence.getSessionForProject('shared-project', second.id),
    ]),
  );
  assert.equal(archived.title, 'Renamed');
  assert.equal(archived.status, 'archived');
  assert.deepEqual(archived.metadata.view_state, { activePageIndex: 2 });
  assert.equal(untouched.title, 'Second');
  assert.equal(untouched.status, 'active');

  await assert.rejects(
    runAs('alice', 'request-append-archived', () =>
      persistence.appendForSession('shared-project', first.id, {
        role: 'user',
        content: 'Should fail',
      }),
    ),
    (error) => error?.code === 'invalid-input',
  );
});

test('rejects session ids that belong to another project or user', async () => {
  const { persistence, runAs } = fixture();
  const otherProjectSession = await runAs('alice', 'request-other-project-session', () =>
    persistence.createSessionForProject('alice-other-project', { title: 'Other project' }),
  );
  const aliceSession = await runAs('alice', 'request-alice-session', () =>
    persistence.createSessionForProject('shared-project', { title: 'Alice only' }),
  );

  await assert.rejects(
    runAs('alice', 'request-cross-project', () =>
      persistence.getSessionForProject('shared-project', otherProjectSession.id),
    ),
    (error) => error?.code === 'chat-session-not-found',
  );
  await assert.rejects(
    runAs('bob', 'request-cross-user', () =>
      persistence.getSessionForProject('shared-project', aliceSession.id),
    ),
    (error) => error?.code === 'chat-session-not-found',
  );
});
