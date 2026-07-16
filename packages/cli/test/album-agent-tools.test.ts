import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createAlbumGenerateTool,
  createAlbumReadTools,
  normalizeAlbumViewStateInput,
  shouldRequireAlbumOverwrite,
  type AlbumReadModel,
} from '../dist/album-agent-tools.js';
import { parseAlbumPagesForAgent } from '../dist/studio-server.js';

const album: AlbumReadModel = {
  exists: true,
  pageCount: 3,
  templateId: 'album-scroll-story',
  previewAvailable: true,
  pages: [
    { index: 0, pageNumber: 1, summary: '封面', textFields: { title: '毕业纪念' } },
    { index: 1, pageNumber: 2, summary: '同学时光', textFields: { headline: '一起走过' } },
    { index: 2, pageNumber: 3, summary: '结束页', textFields: { cta: '再见' } },
  ],
};

test('normalizes view state against authoritative page count', () => {
  const normalized = normalizeAlbumViewStateInput({
    input: {
      activePageIndex: 1,
      pageCount: 99,
      previewRevision: 4,
      clientRevision: 10,
    },
    pageCount: 3,
    previous: null,
    now: '2026-07-16T00:00:00.000Z',
  });

  assert.equal(normalized.accepted, true);
  assert.equal(normalized.state?.pageCount, 3);
  assert.equal(normalized.state?.activePageIndex, 1);
});

test('rejects stale view revisions without replacing current page', () => {
  const previous = {
    activePageIndex: 2,
    pageCount: 3,
    previewRevision: 4,
    clientRevision: 10,
    updatedAt: '2026-07-16T00:00:00.000Z',
  };
  const normalized = normalizeAlbumViewStateInput({
    input: { activePageIndex: 0, clientRevision: 9 },
    pageCount: 3,
    previous,
  });

  assert.equal(normalized.accepted, false);
  assert.equal(normalized.state, previous);
});

test('get_current_page returns the selected page from session view state', async () => {
  const tools = createAlbumReadTools({
    getAlbumState: async () => album,
    getViewState: async () => ({
      activePageIndex: 1,
      pageCount: 3,
      previewRevision: 1,
      clientRevision: 2,
      updatedAt: '2026-07-16T00:00:00.000Z',
    }),
  });
  const tool = tools.find((item) => item.name === 'get_current_page');
  assert.ok(tool);

  const result = await tool.execute('call-1', {}, undefined, undefined, {} as never);
  assert.equal(result.details.known, true);
  assert.equal(result.details.page_number, 2);
  assert.equal(result.details.summary, '同学时光');
});

test('get_album_page uses current page when page_number is omitted', async () => {
  const tools = createAlbumReadTools({
    getAlbumState: async () => album,
    getViewState: async () => ({
      activePageIndex: 2,
      pageCount: 3,
      previewRevision: 1,
      clientRevision: 2,
      updatedAt: '2026-07-16T00:00:00.000Z',
    }),
  });
  const tool = tools.find((item) => item.name === 'get_album_page');
  assert.ok(tool);

  const result = await tool.execute('call-2', {}, undefined, undefined, {} as never);
  assert.equal(result.details.page_number, 3);
  assert.deepEqual(result.details.text_fields, { cta: '再见' });
});

test('server read model recognizes unmarked direct children of an album container', () => {
  const pages = parseAlbumPagesForAgent(`<!doctype html><main id="album">
    <section><h1 data-hv-text="page_1.title">毕业纪念</h1></section>
    <section><h2 data-hv-text="page_2.headline">同学时光</h2><p data-hv-text="page_2.copy">一起走过</p></section>
    <nav class="dots"><button>1</button><button>2</button></nav>
  </main>`);

  assert.equal(pages.length, 2);
  assert.equal(pages[0]?.summary, '毕业纪念');
  assert.deepEqual(pages[1]?.textFields, {
    'page_2.headline': '同学时光',
    'page_2.copy': '一起走过',
  });
});

test('generate_album forwards requirements without accepting HTML as a protocol field', async () => {
  let received: Record<string, unknown> | null = null;
  const tool = createAlbumGenerateTool({
    executeGenerate: async (_toolCallId, input) => {
      received = input;
      return { ok: true, revision: 1, album_changed: true };
    },
  });

  const result = await tool.execute('generate-1', {
    request: 'Create a graduation album',
    page_count: 6,
    style: 'editorial',
  }, undefined, undefined, {} as never);

  assert.equal(result.details.ok, true);
  assert.deepEqual(received, {
    request: 'Create a graduation album',
    page_count: 6,
    style: 'editorial',
  });
  assert.equal('html' in (tool.parameters as { properties?: Record<string, unknown> }).properties!, false);
});

test('generate_album requires an explicit decision for a confirmation action', async () => {
  let called = false;
  const tool = createAlbumGenerateTool({
    executeGenerate: async () => {
      called = true;
      return { ok: true };
    },
  });

  const result = await tool.execute('generate-2', {
    confirmation_action_id: 'action-1',
  }, undefined, undefined, {} as never);

  assert.equal(result.details.code, 'CONFIRMATION_DECISION_REQUIRED');
  assert.equal(called, false);
});

test('overwrite confirmation ignores an untouched template seed', () => {
  const templateHtml = '<!doctype html><main id="album"><section data-album-page="1"></section></main>';
  assert.equal(shouldRequireAlbumOverwrite({
    albumExists: true,
    albumRevision: 0,
    frameCount: 0,
    currentHtml: `\n${templateHtml}\n`,
    templateHtml,
  }), false);
  assert.equal(shouldRequireAlbumOverwrite({
    albumExists: true,
    albumRevision: 0,
    frameCount: 0,
    currentHtml: templateHtml.replace('</section>', '<h1>Generated</h1></section>'),
    templateHtml,
  }), true);
  assert.equal(shouldRequireAlbumOverwrite({
    albumExists: true,
    albumRevision: 1,
    frameCount: 0,
    currentHtml: templateHtml,
    templateHtml,
  }), true);
});
