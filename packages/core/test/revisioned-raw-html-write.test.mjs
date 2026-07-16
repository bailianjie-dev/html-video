import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  AlbumRepository,
  FileProjectPersistence,
  ProjectStore,
} from '../dist/index.js';

function project(id) {
  const now = new Date().toISOString();
  return {
    id,
    name: 'Revision album',
    assets: [],
    templateId: null,
    variables: {},
    preferences: {},
    status: 'previewed',
    albumRevision: 0,
    createdAt: now,
    updatedAt: now,
  };
}

async function fileFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'html-video-revision-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new ProjectStore(root);
  const persistence = new FileProjectPersistence(store);
  await persistence.save(project('proj_revision'));
  await persistence.writeRawHtml('proj_revision', '<html>revision zero</html>');
  return persistence;
}

test('revisioned file write succeeds once and stale conflict has zero artifact writes', async (t) => {
  const persistence = await fileFixture(t);
  const first = await persistence.writeRawHtmlIfRevision(
    'proj_revision',
    '<html>revision one</html>',
    0,
  );
  assert.equal(first.ok, true);
  assert.equal(first.previousRevision, 0);
  assert.equal(first.revision, 1);

  const stale = await persistence.writeRawHtmlIfRevision(
    'proj_revision',
    '<html>must not be written</html>',
    0,
  );
  assert.deepEqual(stale, { ok: false, currentRevision: 1 });
  assert.equal(await persistence.readRawHtml('proj_revision'), '<html>revision one</html>');
  assert.equal((await persistence.load('proj_revision')).albumRevision, 1);
});

test('concurrent writes with the same expected revision allow only one winner', async (t) => {
  const persistence = await fileFixture(t);
  const results = await Promise.all([
    persistence.writeRawHtmlIfRevision('proj_revision', '<html>winner A</html>', 0),
    persistence.writeRawHtmlIfRevision('proj_revision', '<html>winner B</html>', 0),
  ]);
  assert.equal(results.filter((result) => result.ok).length, 1);
  assert.equal(results.filter((result) => !result.ok).length, 1);
  assert.equal((await persistence.load('proj_revision')).albumRevision, 1);
  assert.match(await persistence.readRawHtml('proj_revision'), /winner [AB]/);
});

test('PostgreSQL album CAS update guards settings.album_revision in the UPDATE predicate', async () => {
  const calls = [];
  const repository = new AlbumRepository({
    async query(sql, params) {
      calls.push({ sql, params });
      return { rows: [], rowCount: 0 };
    },
  });
  const result = await repository.updateIfAlbumRevision(
    'user-1',
    'album-1',
    7,
    { settings: { album_revision: 8 } },
    'actor-1',
  );
  assert.equal(result, null);
  assert.match(calls[0].sql, /settings->>'album_revision'/);
  assert.match(calls[0].sql, /= \$3/);
  assert.deepEqual(calls[0].params.slice(0, 3), ['user-1', 'album-1', 7]);
});
