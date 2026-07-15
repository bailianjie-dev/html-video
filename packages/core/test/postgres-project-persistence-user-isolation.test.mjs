import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import test from 'node:test';
import {
  AssetStore,
  PostgresProjectPersistence,
  RequestContextStorage,
} from '../dist/index.js';

class MemoryAlbumRepository {
  rows = [];

  async create(input) {
    const now = new Date();
    const row = {
      id: input.id,
      user_id: input.user_id,
      source_project_id: input.source_project_id ?? null,
      title: input.title,
      description: input.description ?? null,
      status: input.status ?? 'draft',
      cover_asset_id: input.cover_asset_id ?? null,
      last_preview_asset_id: input.last_preview_asset_id ?? null,
      last_preview_html_url: input.last_preview_html_url ?? null,
      last_preview_poster_url: input.last_preview_poster_url ?? null,
      canvas_width: input.canvas_width ?? 1080,
      canvas_height: input.canvas_height ?? 1920,
      fps: input.fps ?? 30,
      duration_ms: input.duration_ms ?? 0,
      page_count: input.page_count ?? 0,
      settings: input.settings ?? {},
      created_by: input.created_by,
      updated_by: input.updated_by,
      created_time: now,
      updated_time: now,
    };
    this.rows.push(row);
    return row;
  }

  async findById(userId, id) {
    return this.rows.find((row) => row.user_id === userId && row.id === id) ?? null;
  }

  async findBySourceProjectId(userId, sourceProjectId) {
    return this.rows.find(
      (row) => row.user_id === userId && row.source_project_id === sourceProjectId,
    ) ?? null;
  }

  async listByUser(userId) {
    return this.rows.filter((row) => row.user_id === userId && row.status !== 'deleted');
  }

  async update(userId, id, patch, updatedBy) {
    const row = await this.findById(userId, id);
    if (!row) return null;
    Object.assign(row, patch, { updated_by: updatedBy, updated_time: new Date() });
    return row;
  }

  async softDelete(userId, id, updatedBy) {
    return this.update(userId, id, { status: 'deleted' }, updatedBy);
  }
}

class MemoryAlbumPageRepository {
  rows = [];

  async findByNodeId(userId, albumId, nodeId) {
    return this.rows.find(
      (row) => row.user_id === userId && row.album_id === albumId && row.node_id === nodeId,
    ) ?? null;
  }

  async findByPageNo(userId, albumId, pageNo) {
    return this.rows.find(
      (row) => row.user_id === userId && row.album_id === albumId && row.page_no === pageNo,
    ) ?? null;
  }

  async listByAlbum(userId, albumId) {
    return this.rows
      .filter((row) => row.user_id === userId && row.album_id === albumId && row.status !== 'deleted')
      .sort((left, right) => left.page_no - right.page_no);
  }

  async upsertByAlbumAndNodeId(input) {
    const existing = await this.findByNodeId(input.user_id, input.album_id, input.node_id);
    return this.upsert(existing, input);
  }

  async upsertByAlbumAndPageNo(input) {
    const existing = await this.findByPageNo(input.user_id, input.album_id, input.page_no);
    return this.upsert(existing, input);
  }

  upsert(existing, input) {
    const now = new Date();
    if (existing) {
      Object.assign(existing, input, { updated_time: now });
      return existing;
    }
    const row = {
      id: input.id,
      user_id: input.user_id,
      album_id: input.album_id,
      node_id: input.node_id ?? null,
      page_no: input.page_no,
      title: input.title ?? null,
      status: input.status ?? 'draft',
      template_key: input.template_key ?? null,
      duration_ms: input.duration_ms ?? 3000,
      raw_html: input.raw_html ?? null,
      html_oss_bucket: input.html_oss_bucket ?? null,
      html_oss_key: input.html_oss_key ?? null,
      html_url: input.html_url ?? null,
      html_checksum_sha256: input.html_checksum_sha256 ?? null,
      preview_asset_id: input.preview_asset_id ?? null,
      poster_asset_id: input.poster_asset_id ?? null,
      content: input.content ?? {},
      style: input.style ?? {},
      transition: input.transition ?? {},
      created_by: input.created_by,
      updated_by: input.updated_by,
      created_time: now,
      updated_time: now,
    };
    this.rows.push(row);
    return row;
  }
}

function project(id, name) {
  const now = new Date().toISOString();
  return {
    id,
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

function graph(text) {
  return {
    schemaVersion: 1,
    intent: 'other',
    nodes: [{
      id: 'intro',
      kind: 'text',
      label: text,
      frameIntent: 'intro',
      durationSec: 3,
      text,
    }],
    edges: [],
  };
}

async function fixture(t, publishHtml) {
  const projectRoot = await mkdtemp(join(tmpdir(), 'html-video-user-isolation-'));
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  const contexts = new RequestContextStorage();
  const albums = new MemoryAlbumRepository();
  const pages = new MemoryAlbumPageRepository();
  const persistence = new PostgresProjectPersistence({
    db: { query: async () => { throw new Error('Unexpected database query'); } },
    projectRoot,
    getUserContext: () => contexts.getRequiredUser(),
    albums,
    pages,
    ...(publishHtml && { publishHtml }),
  });
  const runAs = (userId, callback) => contexts.run({
    requestId: `request-${userId}`,
    source: 'header',
    user: { userId, actorId: userId },
  }, callback);
  return { albums, pages, persistence, projectRoot, runAs };
}

test('publishes preview and frame HTML with request-scoped user identity', async (t) => {
  const publications = [];
  const { albums, pages, persistence, runAs } = await fixture(t, async (input) => {
    publications.push(input);
    return {
      bucket: 'html-bucket',
      key: `${input.userId}/${input.projectId}/${input.nodeId}.html`,
      url: `https://example.test/${input.userId}/${input.projectId}/${input.nodeId}.html`,
      checksumSha256: 'a'.repeat(64),
    };
  });
  await runAs('alice', () => persistence.save(project('proj_html', 'HTML album')));

  const preview = await runAs(
    'alice',
    () => persistence.writeRawHtml('proj_html', '<html>Alice preview</html>'),
  );
  const frame = await runAs(
    'alice',
    () => persistence.writeFrameHtml('proj_html', 'intro', '<html>Alice frame</html>', {
      graphNodeId: 'intro',
      htmlPath: '',
      durationSec: 3,
      order: 0,
    }),
  );

  assert.deepEqual(publications.map((item) => [item.userId, item.nodeId]), [
    ['alice', 'preview'],
    ['alice', 'intro'],
  ]);
  assert.equal(preview.htmlUrl, 'https://example.test/alice/proj_html/preview.html');
  assert.equal(frame.htmlUrl, 'https://example.test/alice/proj_html/intro.html');
  assert.equal(
    pages.rows.find((row) => row.node_id === 'intro').html_oss_key,
    'alice/proj_html/intro.html',
  );
  assert.equal(
    albums.rows.find((row) => row.user_id === 'alice').last_preview_html_url,
    'https://example.test/alice/proj_html/intro.html',
  );
});

test('isolates projects and page content for two concurrent users', async (t) => {
  const { albums, pages, persistence, runAs } = await fixture(t);

  await Promise.all([
    runAs('alice', () => persistence.save(project('proj_shared', 'Alice album'))),
    runAs('bob', () => persistence.save(project('proj_shared', 'Bob album'))),
  ]);

  const [aliceList, bobList] = await Promise.all([
    runAs('alice', () => persistence.list()),
    runAs('bob', () => persistence.list()),
  ]);
  assert.deepEqual(aliceList.map((item) => item.name), ['Alice album']);
  assert.deepEqual(bobList.map((item) => item.name), ['Bob album']);

  await Promise.all([
    runAs('alice', async () => {
      await persistence.writeRawHtml('proj_shared', '<html>Alice preview</html>');
      await persistence.writeContentGraph('proj_shared', graph('Alice graph'));
      await persistence.writeFrameHtml('proj_shared', 'intro', '<html>Alice frame</html>', {
        graphNodeId: 'intro',
        htmlPath: '',
        durationSec: 3,
        order: 0,
      });
    }),
    runAs('bob', async () => {
      await persistence.writeRawHtml('proj_shared', '<html>Bob preview</html>');
      await persistence.writeContentGraph('proj_shared', graph('Bob graph'));
      await persistence.writeFrameHtml('proj_shared', 'intro', '<html>Bob frame</html>', {
        graphNodeId: 'intro',
        htmlPath: '',
        durationSec: 3,
        order: 0,
      });
    }),
  ]);

  assert.equal(
    await runAs('alice', () => persistence.readRawHtml('proj_shared')),
    '<html>Alice preview</html>',
  );
  assert.equal(
    await runAs('bob', () => persistence.readRawHtml('proj_shared')),
    '<html>Bob preview</html>',
  );
  assert.equal(
    await runAs('alice', () => persistence.readFrameHtml('proj_shared', 'intro')),
    '<html>Alice frame</html>',
  );
  assert.equal(
    (await runAs('bob', () => persistence.readContentGraph('proj_shared'))).nodes[0].text,
    'Bob graph',
  );
  assert.equal(albums.rows.filter((row) => row.user_id === 'alice').length, 1);
  assert.equal(albums.rows.filter((row) => row.user_id === 'bob').length, 1);
  assert.ok(pages.rows.every((row) => row.user_id === 'alice' || row.user_id === 'bob'));
});

test('treats another user project as not found for read, write, and remove', async (t) => {
  const { persistence, runAs } = await fixture(t);
  await runAs('alice', () => persistence.save(project('proj_alice_only', 'Alice private album')));

  const expectNotFound = (operation) => assert.rejects(
    runAs('bob', operation),
    (error) => error?.code === 'project-not-found',
  );

  await expectNotFound(() => persistence.load('proj_alice_only'));
  await expectNotFound(() => persistence.readRawHtml('proj_alice_only'));
  await expectNotFound(() => persistence.writeRawHtml('proj_alice_only', '<html>Bob</html>'));
  await expectNotFound(() => persistence.readFrameHtml('proj_alice_only', 'intro'));
  await expectNotFound(() => persistence.readContentGraph('proj_alice_only'));
  await expectNotFound(() => persistence.remove('proj_alice_only'));

  assert.equal(
    (await runAs('alice', () => persistence.load('proj_alice_only'))).name,
    'Alice private album',
  );
});

test('isolates work directories and local assets for users sharing a project id', async (t) => {
  const { persistence, projectRoot, runAs } = await fixture(t);
  const assets = new AssetStore({
    projectRoot,
    resolveProjectDir: (projectId) => persistence.ensureDir(projectId),
  });

  await Promise.all([
    runAs('alice', () => persistence.save(project('proj_shared', 'Alice album'))),
    runAs('bob', () => persistence.save(project('proj_shared', 'Bob album'))),
  ]);
  const [aliceDir, bobDir, aliceAsset, bobAsset] = await Promise.all([
    runAs('alice', () => persistence.ensureDir('proj_shared')),
    runAs('bob', () => persistence.ensureDir('proj_shared')),
    runAs('alice', () => assets.addInlineAsset('proj_shared', 'Alice private', 'text')),
    runAs('bob', () => assets.addInlineAsset('proj_shared', 'Bob private', 'text')),
  ]);

  assert.notEqual(aliceDir, bobDir);
  assert.match(aliceDir.replaceAll('\\', '/'), /\/tmp\/work\/alice\/proj_shared$/);
  assert.match(bobDir.replaceAll('\\', '/'), /\/tmp\/work\/bob\/proj_shared$/);
  assert.ok(aliceAsset.path.startsWith(aliceDir));
  assert.ok(bobAsset.path.startsWith(bobDir));
});

test('sanitizes unsafe user and project ids without escaping the temp work root', async (t) => {
  const { persistence, projectRoot, runAs } = await fixture(t);
  const workRoot = resolve(projectRoot, '.html-video', 'tmp', 'work');
  const dir = await runAs('../Alice', () => persistence.ensureDir('../../outside'));
  const relativeDir = relative(workRoot, resolve(dir));

  assert.ok(relativeDir);
  assert.equal(relativeDir.startsWith('..'), false);
  assert.equal(relativeDir.includes('..'), false);
  assert.match(dir.replaceAll('\\', '/'), /\/tmp\/work\/alice--[a-f0-9]{12}\/outside--[a-f0-9]{12}$/);
});

test('does not read legacy local preview paths while new writes use user directories', async (t) => {
  const { persistence, projectRoot, runAs } = await fixture(t);
  const legacyDir = join(projectRoot, '.html-video', 'projects', 'proj_legacy');
  const legacyPreview = join(legacyDir, 'preview.html');
  const legacyProject = project('proj_legacy', 'Legacy album');
  legacyProject.lastPreviewHtmlPath = legacyPreview;
  legacyProject.contentGraphPath = join(legacyDir, 'content-graph.json');
  legacyProject.frames = [{
    graphNodeId: 'intro',
    htmlPath: join(legacyDir, 'frames', '01-intro.html'),
    durationSec: 3,
    order: 0,
  }];
  await runAs('alice', () => persistence.save(legacyProject));

  assert.equal(
    await runAs('alice', () => persistence.readRawHtml('proj_legacy')),
    null,
  );
  assert.equal(
    await runAs('alice', () => persistence.readFrameHtml('proj_legacy', 'intro')),
    null,
  );
  assert.equal(
    await runAs('alice', () => persistence.readContentGraph('proj_legacy')),
    null,
  );
  const written = await runAs(
    'alice',
    () => persistence.writeRawHtml('proj_legacy', '<html>Namespaced preview</html>'),
  );
  assert.match(
    written.htmlPath.replaceAll('\\', '/'),
    /\/tmp\/work\/alice\/proj_legacy\/preview\.html$/,
  );
});
