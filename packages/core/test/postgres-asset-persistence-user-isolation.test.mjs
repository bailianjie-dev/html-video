import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PostgresAssetPersistence,
  RequestContextStorage,
} from '../dist/index.js';

class MemoryAlbumRepository {
  rows = [];

  async findById(userId, id) {
    return this.rows.find(
      (row) => row.user_id === userId && row.id === id,
    ) ?? null;
  }

  async findBySourceProjectId(userId, sourceProjectId) {
    return this.rows.find(
      (row) => row.user_id === userId && row.source_project_id === sourceProjectId,
    ) ?? null;
  }
}

class MemoryAssetRepository {
  rows = [];

  async create(input) {
    const now = new Date();
    const row = {
      ...input,
      album_id: input.album_id ?? null,
      page_id: input.page_id ?? null,
      usage_type: input.usage_type ?? 'source',
      source: input.source ?? 'upload',
      status: input.status ?? 'available',
      oss_bucket: input.oss_bucket ?? null,
      thumbnail_url: input.thumbnail_url ?? null,
      file_name: input.file_name ?? null,
      mime_type: input.mime_type ?? null,
      file_ext: input.file_ext ?? null,
      file_size_bytes: input.file_size_bytes ?? null,
      width: input.width ?? null,
      height: input.height ?? null,
      duration_ms: input.duration_ms ?? null,
      checksum_sha256: input.checksum_sha256 ?? null,
      metadata: input.metadata ?? {},
      created_time: now,
      updated_time: now,
    };
    this.rows.push(row);
    return row;
  }

  async findById(userId, id) {
    return this.rows.find(
      (row) => row.user_id === userId && row.id === id,
    ) ?? null;
  }

  async listByAlbum(userId, albumId, opts = {}) {
    return this.rows.filter(
      (row) => row.user_id === userId
        && row.album_id === albumId
        && (opts.includeDeleted || row.status !== 'deleted'),
    );
  }

  async softDelete(userId, id, updatedBy) {
    const row = await this.findById(userId, id);
    if (!row) return null;
    row.status = 'deleted';
    row.updated_by = updatedBy;
    row.updated_time = new Date();
    return row;
  }
}

function album(id, userId) {
  const now = new Date();
  return {
    id,
    user_id: userId,
    source_project_id: 'shared-project',
    title: `${userId} album`,
    description: null,
    status: 'draft',
    cover_asset_id: null,
    last_preview_asset_id: null,
    last_preview_html_url: null,
    last_preview_poster_url: null,
    canvas_width: 1280,
    canvas_height: 720,
    fps: 30,
    duration_ms: 0,
    page_count: 0,
    settings: {},
    created_by: userId,
    updated_by: userId,
    created_time: now,
    updated_time: now,
  };
}

function fixture() {
  const contexts = new RequestContextStorage();
  const albums = new MemoryAlbumRepository();
  const assets = new MemoryAssetRepository();
  albums.rows.push(album('album-alice', 'alice'), album('album-bob', 'bob'));
  const persistence = new PostgresAssetPersistence({
    getUserContext: () => contexts.getRequiredUser(),
    albums,
    assets,
  });
  const runAs = (userId, callback) => contexts.run({
    requestId: `request-${userId}`,
    source: 'header',
    user: { userId, actorId: `${userId}-actor` },
  }, callback);
  return { assets, persistence, runAs };
}

function assetInput(id, fileName) {
  return {
    id,
    asset_type: 'image',
    oss_key: `projects/shared-project/assets/${id}/${fileName}`,
    url: `https://example.invalid/${id}/${fileName}`,
    file_name: fileName,
  };
}

test('creates and lists project assets for two concurrent request users', async () => {
  const { assets, persistence, runAs } = fixture();

  await Promise.all([
    runAs('alice', () => persistence.createForProject(
      'shared-project',
      assetInput('asset-alice', 'alice.png'),
    )),
    runAs('bob', () => persistence.createForProject(
      'shared-project',
      assetInput('asset-bob', 'bob.png'),
    )),
  ]);

  const [aliceAssets, bobAssets] = await Promise.all([
    runAs('alice', () => persistence.listForProject('shared-project')),
    runAs('bob', () => persistence.listForProject('shared-project')),
  ]);

  assert.deepEqual(aliceAssets.map((item) => item.id), ['asset-alice']);
  assert.deepEqual(bobAssets.map((item) => item.id), ['asset-bob']);
  assert.equal(assets.rows.find((item) => item.id === 'asset-alice').album_id, 'album-alice');
  assert.equal(assets.rows.find((item) => item.id === 'asset-alice').created_by, 'alice-actor');
  assert.equal(assets.rows.find((item) => item.id === 'asset-bob').user_id, 'bob');
});

test('returns not found instead of exposing or deleting another user asset', async () => {
  const { assets, persistence, runAs } = fixture();
  await runAs('alice', () => persistence.createForProject(
    'shared-project',
    assetInput('asset-alice', 'private.png'),
  ));

  await assert.rejects(
    runAs('bob', () => persistence.softDeleteForProject('shared-project', 'asset-alice')),
    (error) => error?.code === 'asset-not-found',
  );
  assert.equal(assets.rows[0].status, 'available');

  const deleted = await runAs(
    'alice',
    () => persistence.softDeleteForProject('shared-project', 'asset-alice'),
  );
  assert.equal(deleted.status, 'deleted');
  assert.equal(deleted.updated_by, 'alice-actor');
  assert.deepEqual(
    await runAs('alice', () => persistence.listForProject('shared-project')),
    [],
  );
});

test('returns project not found when the current user cannot access the album', async () => {
  const { persistence, runAs } = fixture();

  await assert.rejects(
    runAs('charlie', () => persistence.listForProject('shared-project')),
    (error) => error?.code === 'project-not-found',
  );
});

test('allows removal of a legacy project asset without a database row', async () => {
  const { persistence, runAs } = fixture();

  assert.equal(
    await runAs('alice', () => persistence.softDeleteForProject(
      'shared-project',
      'legacy-local-asset',
      { allowMissingDatabaseRow: true },
    )),
    null,
  );
});
