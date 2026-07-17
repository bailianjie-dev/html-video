import assert from 'node:assert/strict';
import test from 'node:test';
import { ChatSessionRepository } from '../dist/index.js';

class RecordingDb {
  queries = [];
  responses = [];

  enqueue(rows) {
    this.responses.push({ rows, rowCount: rows.length });
  }

  async query(sql, params = []) {
    this.queries.push({ sql: String(sql), params: [...params] });
    return this.responses.shift() ?? { rows: [], rowCount: 0 };
  }
}

function session(overrides = {}) {
  const now = new Date();
  return {
    id: 'session-1',
    user_id: 'alice',
    album_id: 'album-1',
    status: 'active',
    title: 'Planning',
    last_message_seq: 0,
    metadata: {},
    created_by: 'alice',
    updated_by: 'alice',
    created_time: now,
    updated_time: now,
    ...overrides,
  };
}

test('finds and lists sessions through user and album ownership coordinates', async () => {
  const db = new RecordingDb();
  const repository = new ChatSessionRepository(db);
  const row = session();
  db.enqueue([row]);
  db.enqueue([row]);

  assert.equal(await repository.findById('alice', 'album-1', 'session-1'), row);
  assert.deepEqual(await repository.listByAlbum('alice', 'album-1', 'active'), [row]);

  assert.match(db.queries[0].sql, /user_id = \$1 AND album_id = \$2 AND id = \$3/);
  assert.deepEqual(db.queries[0].params, ['alice', 'album-1', 'session-1']);
  assert.match(db.queries[1].sql, /status = \$3/);
  assert.match(db.queries[1].sql, /ORDER BY updated_time DESC/);
  assert.deepEqual(db.queries[1].params, ['alice', 'album-1', 'active']);
});

test('keeps the oldest active session as the compatibility default', async () => {
  const db = new RecordingDb();
  const repository = new ChatSessionRepository(db);
  const row = session();
  db.enqueue([row]);

  assert.equal(await repository.findActiveByAlbum('alice', 'album-1'), row);
  assert.match(db.queries[0].sql, /ORDER BY created_time ASC, id ASC LIMIT 1/);
  assert.deepEqual(db.queries[0].params, ['alice', 'album-1']);
});

test('updates title and status only inside the owning album', async () => {
  const db = new RecordingDb();
  const repository = new ChatSessionRepository(db);
  db.enqueue([session({ title: 'Renamed' })]);
  db.enqueue([session({ status: 'archived' })]);

  const renamed = await repository.updateTitle(
    'alice',
    'album-1',
    'session-1',
    'Renamed',
    'alice-actor',
  );
  const archived = await repository.updateStatus(
    'alice',
    'album-1',
    'session-1',
    'archived',
    'alice-actor',
  );

  assert.equal(renamed?.title, 'Renamed');
  assert.equal(archived?.status, 'archived');
  for (const query of db.queries) {
    assert.match(query.sql, /WHERE user_id = \$1 AND album_id = \$2 AND id = \$3/);
    assert.deepEqual(query.params.slice(0, 3), ['alice', 'album-1', 'session-1']);
  }
});

test('createForAlbum preserves explicit session ownership', async () => {
  const db = new RecordingDb();
  const repository = new ChatSessionRepository(db);
  const row = session({ id: 'session-2' });
  db.enqueue([row]);

  const created = await repository.createForAlbum({
    id: row.id,
    user_id: row.user_id,
    album_id: row.album_id,
    status: 'active',
    title: row.title,
    metadata: row.metadata,
    created_by: row.created_by,
    updated_by: row.updated_by,
  });

  assert.equal(created, row);
  assert.match(db.queries[0].sql, /INSERT INTO ai_album_chat_sessions/);
  assert.equal(db.queries[0].params[0], 'session-2');
  assert.equal(db.queries[0].params[1], 'alice');
  assert.equal(db.queries[0].params[2], 'album-1');
});
