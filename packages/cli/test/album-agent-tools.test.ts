import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createAlbumAssetTools,
  createAlbumGenerateTool,
  createAlbumReadTools,
  createAlbumUpdateTools,
  normalizeAlbumViewStateInput,
  shouldRequireAlbumOverwrite,
  type AlbumReadModel,
} from '../dist/album-agent-tools.js';
import {
  diffAlbumHtmlChanges,
  isolateAlbumPageUpdate,
  isFullAlbumReplacementRequest,
  parseAlbumPagesForAgent,
  replaceAlbumImageAssetInHtml,
  replayAlbumToolResult,
  resolveAlbumUpdatePageIndex,
} from '../dist/studio-server.js';

const album: AlbumReadModel = {
  exists: true,
  revision: 4,
  pageCount: 3,
  templateId: 'album-scroll-story',
  previewAvailable: true,
  pages: [
    { index: 0, pageNumber: 1, summary: '封面', textFields: { title: '毕业纪念' }, imageKeys: ['page_1.hero'] },
    { index: 1, pageNumber: 2, summary: '同学时光', textFields: { headline: '一起走过' }, imageKeys: ['page_2.photo'] },
    { index: 2, pageNumber: 3, summary: '结束页', textFields: { cta: '再见' }, imageKeys: [] },
  ],
  imageAssets: [
    { assetId: 'asset-apple', filename: 'apple.png' },
    { assetId: 'asset-campus', filename: 'campus.jpg' },
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
  assert.equal(result.details.album_revision, 4);
  assert.equal(result.details.summary, '同学时光');
});

test('get_album_state exposes the authoritative album revision', async () => {
  const tools = createAlbumReadTools({
    getAlbumState: async () => album,
    getViewState: async () => null,
  });
  const tool = tools.find((item) => item.name === 'get_album_state');
  assert.ok(tool);
  const result = await tool.execute('state-1', {}, undefined, undefined, {} as never);
  assert.equal(result.details.album_revision, 4);
  assert.deepEqual(result.details.image_assets, [
    { asset_id: 'asset-apple', filename: 'apple.png' },
    { asset_id: 'asset-campus', filename: 'campus.jpg' },
  ]);
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
  assert.equal(result.details.album_revision, 4);
  assert.deepEqual(result.details.text_fields, { cta: '再见' });
  assert.deepEqual(result.details.image_keys, []);
});

test('replace_album_assets exposes only explicit project asset coordinates', async () => {
  let received: Record<string, unknown> | null = null;
  const [tool] = createAlbumAssetTools({
    executeAssetReplacement: async (_toolCallId, input) => {
      received = input;
      return { ok: true, album_changed: true, revision: 5 };
    },
  });
  assert.ok(tool);
  const properties = (tool.parameters as { properties: Record<string, unknown> }).properties;
  assert.deepEqual(Object.keys(properties).sort(), [
    'asset_id',
    'expected_revision',
    'page_number',
    'target_key',
  ]);
  assert.deepEqual(
    [...((tool.parameters as { required?: string[] }).required ?? [])].sort(),
    ['asset_id', 'expected_revision', 'page_number', 'target_key'],
  );
  for (const forbidden of ['html', 'path', 'local_path', 'url', 'browser_url']) {
    assert.equal(forbidden in properties, false);
  }
  const result = await tool.execute('replace-1', {
    page_number: 2,
    target_key: 'page_2.photo',
    asset_id: 'asset-campus',
    expected_revision: 4,
  }, undefined, undefined, {} as never);
  assert.equal(result.details.ok, true);
  assert.deepEqual(received, {
    page_number: 2,
    target_key: 'page_2.photo',
    asset_id: 'asset-campus',
    expected_revision: 4,
  });
});

test('replace_album_assets rejects paths, URLs, HTML, and unknown fields', async () => {
  let calls = 0;
  const [tool] = createAlbumAssetTools({
    executeAssetReplacement: async () => { calls += 1; return { ok: true }; },
  });
  assert.ok(tool);
  const urlResult = await tool.execute('replace-url', {
    page_number: 1,
    target_key: 'page_1.hero',
    asset_id: 'https://example.com/photo.jpg',
    expected_revision: 4,
  }, undefined, undefined, {} as never);
  assert.equal(urlResult.details.code, 'ASSET_ID_MUST_NOT_BE_PATH_OR_URL');
  const htmlResult = await tool.execute('replace-html', {
    page_number: 1,
    target_key: 'page_1.hero',
    asset_id: 'asset-apple',
    expected_revision: 4,
    html: '<img>',
  }, undefined, undefined, {} as never);
  assert.equal(htmlResult.details.code, 'UNSUPPORTED_ASSET_INPUT_FIELD');
  assert.equal(calls, 0);
});

test('asset replacement changes only the exact page and data-hv-image key', () => {
  const original = `<!doctype html><html><body><main id="album">
    <section data-album-page="1"><img data-hv-image="page_1.hero" src="/old-one.jpg"></section>
    <section data-album-page="2"><div data-hv-image="page_2.photo" style="background-image:url('/old-two.jpg')"></div></section>
  </main></body></html>`;
  const result = replaceAlbumImageAssetInHtml({
    html: original,
    pageNumber: 2,
    targetKey: 'page_2.photo',
    assetId: 'asset-campus',
    assetUrl: '/api/projects/proj-1/assets/asset-campus/content',
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.match(result.html, /data-hv-image="page_2\.photo"[^>]*data-hv-asset-id="asset-campus"/);
  assert.match(result.html, /background-image:url\('\/api\/projects\/proj-1\/assets\/asset-campus\/content'\) !important/);
  assert.match(result.html, /data-hv-image="page_1\.hero" src="\/old-one\.jpg"/);
  assert.deepEqual(diffAlbumHtmlChanges(original, result.html), {
    changedPages: [2],
    changedTextKeys: [],
    changedImageKeys: ['page_2.photo'],
    changedCtaKeys: [],
    changedStyleVariables: [],
    structuralChange: false,
  });
});

test('asset replacement rejects missing or duplicate target keys instead of guessing', () => {
  const html = `<!doctype html><main id="album"><section data-album-page="1">
    <img data-hv-image="page_1.photo" src="/a.jpg">
    <img data-hv-image="page_1.photo" src="/b.jpg">
  </section></main>`;
  assert.deepEqual(replaceAlbumImageAssetInHtml({
    html,
    pageNumber: 1,
    targetKey: 'page_1.missing',
    assetId: 'asset-a',
    assetUrl: '/api/projects/p/assets/asset-a/content',
  }), { ok: false, code: 'IMAGE_TARGET_NOT_FOUND' });
  assert.deepEqual(replaceAlbumImageAssetInHtml({
    html,
    pageNumber: 1,
    targetKey: 'page_1.photo',
    assetId: 'asset-a',
    assetUrl: '/api/projects/p/assets/asset-a/content',
  }), { ok: false, code: 'IMAGE_TARGET_AMBIGUOUS' });
});

test('asset replacement supports data-hv-image on the album page root', () => {
  const html = `<!doctype html><main id="album">
    <section data-album-page="1" data-hv-image="page_1.background" style="background:#111"></section>
  </main>`;
  const result = replaceAlbumImageAssetInHtml({
    html,
    pageNumber: 1,
    targetKey: 'page_1.background',
    assetId: 'asset-background',
    assetUrl: '/api/projects/p/assets/asset-background/content',
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.match(result.html, /data-hv-image="page_1\.background"[^>]*background-image:url\('/);
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

test('update tools forward natural-language intent without exposing an HTML field', async () => {
  let pageInput: Record<string, unknown> | null = null;
  let albumInput: Record<string, unknown> | null = null;
  const tools = createAlbumUpdateTools({
    executePageUpdate: async (_toolCallId, input) => {
      pageInput = input;
      return { ok: true, revision: 2, album_changed: true };
    },
    executeAlbumUpdate: async (_toolCallId, input) => {
      albumInput = input;
      return { ok: true, revision: 3, album_changed: true };
    },
  });

  const pageTool = tools.find((tool) => tool.name === 'update_album_page');
  const albumTool = tools.find((tool) => tool.name === 'update_album');
  assert.ok(pageTool);
  assert.ok(albumTool);
  await pageTool.execute('update-page-1', {
    request: 'Make the title shorter',
    page_number: 2,
    expected_revision: 4,
  }, undefined, undefined, {} as never);
  await albumTool.execute('update-album-1', {
    request: 'Use a quieter visual style on all pages',
    expected_revision: 4,
  }, undefined, undefined, {} as never);

  assert.deepEqual(pageInput, { request: 'Make the title shorter', page_number: 2, expected_revision: 4 });
  assert.deepEqual(albumInput, { request: 'Use a quieter visual style on all pages', expected_revision: 4 });
  assert.equal('html' in (pageTool.parameters as { properties: Record<string, unknown> }).properties, false);
  assert.equal('html' in (albumTool.parameters as { properties: Record<string, unknown> }).properties, false);
  assert.ok('expected_revision' in (pageTool.parameters as { properties: Record<string, unknown> }).properties);
  assert.ok('expected_revision' in (albumTool.parameters as { properties: Record<string, unknown> }).properties);
  assert.ok((pageTool.parameters as { required?: string[] }).required?.includes('expected_revision'));
  assert.ok((albumTool.parameters as { required?: string[] }).required?.includes('expected_revision'));
});

test('update tools reject requests without a revision before invoking the host', async () => {
  let calls = 0;
  const tools = createAlbumUpdateTools({
    executePageUpdate: async () => { calls += 1; return { ok: true }; },
    executeAlbumUpdate: async () => { calls += 1; return { ok: true }; },
  });
  const pageTool = tools.find((tool) => tool.name === 'update_album_page');
  assert.ok(pageTool);
  const result = await pageTool.execute(
    'update-page-no-revision',
    { request: 'Change the title' },
    undefined,
    undefined,
    {} as never,
  );
  assert.equal(result.details.code, 'EXPECTED_REVISION_REQUIRED');
  assert.equal(calls, 0);
});

test('page update target uses an explicit page or the authoritative session page', () => {
  assert.deepEqual(resolveAlbumUpdatePageIndex({
    pageNumber: 3,
    activePageIndex: 0,
    pageCount: 4,
  }), { ok: true, pageIndex: 2 });
  assert.deepEqual(resolveAlbumUpdatePageIndex({
    activePageIndex: 1,
    pageCount: 4,
  }), { ok: true, pageIndex: 1 });
  assert.deepEqual(resolveAlbumUpdatePageIndex({
    activePageIndex: null,
    pageCount: 4,
  }), { ok: false, code: 'CURRENT_PAGE_UNKNOWN' });
});

test('single-page isolation keeps the document shell and non-target pages byte-identical', () => {
  const original = `<!doctype html><html><head><style>.page{color:red}</style></head><body><main id="album">
    <section class="page" data-album-page="1"><h1 data-hv-text="page_1.title">One</h1></section>
    <section class="page" data-album-page="2"><h1 data-hv-text="page_2.title">Two</h1></section>
    <section class="page" data-album-page="3"><h1 data-hv-text="page_3.title">Three</h1></section>
  </main><script>const pageCount=3;</script></body></html>`;
  const candidate = `\`\`\`html
<!doctype html><html><head><style>.page{color:blue}</style></head><body><main id="album">
    <section class="page" data-album-page="1"><h1 data-hv-text="page_1.title">Changed by mistake</h1></section>
    <section class="page" data-album-page="2" style="background:black"><h1 data-hv-text="page_2.title">Updated two</h1></section>
    <section class="page" data-album-page="3"><h1 data-hv-text="page_3.title">Changed by mistake</h1></section>
  </main><script>const pageCount=99;</script></body></html>
\`\`\``;

  const result = isolateAlbumPageUpdate(original, candidate, 1);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.match(result.html, /page_2\.title">Updated two/);
  assert.match(result.html, /page_1\.title">One/);
  assert.match(result.html, /page_3\.title">Three/);
  assert.match(result.html, /\.page\{color:red\}/);
  assert.match(result.html, /const pageCount=3/);
  assert.doesNotMatch(result.html, /Changed by mistake|color:blue|pageCount=99/);
});

test('whole-album replacement wording is routed back to confirmed generation', () => {
  assert.equal(isFullAlbumReplacementRequest('Regenerate the entire album from scratch'), true);
  assert.equal(isFullAlbumReplacementRequest('Use a quieter visual style on every page'), false);
});

test('tool call replay preserves the completed revision without reporting another write', () => {
  assert.deepEqual(replayAlbumToolResult({
    ok: true,
    album_changed: true,
    previous_revision: 4,
    revision: 5,
  }), {
    ok: true,
    album_changed: false,
    previous_revision: 4,
    revision: 5,
    idempotent_replay: true,
  });
});

test('HTML diff derives changed pages, editable keys, style variables, and structure', () => {
  const oldHtml = `<!doctype html><html><head><style>:root{--primary-color:red}</style></head><body><main id="album">
    <section data-album-page="1"><h1 data-hv-text="page_1.title">One</h1><img data-hv-image="page_1.hero" src="/one.jpg"></section>
    <section data-album-page="2"><a data-hv-cta="page_2.cta" href="/old">Open</a></section>
  </main></body></html>`;
  const newHtml = `<!doctype html><html><head><style>:root{--primary-color:blue}</style></head><body><main id="album">
    <section data-album-page="1"><h1 data-hv-text="page_1.title">Updated</h1><img data-hv-image="page_1.hero" src="/two.jpg"></section>
    <section data-album-page="2"><a data-hv-cta="page_2.cta" href="/new">Open</a><p data-hv-text="page_2.note">New</p></section>
  </main></body></html>`;
  assert.deepEqual(diffAlbumHtmlChanges(oldHtml, newHtml), {
    changedPages: [1, 2],
    changedTextKeys: ['page_1.title', 'page_2.note'],
    changedImageKeys: ['page_1.hero'],
    changedCtaKeys: ['page_2.cta'],
    changedStyleVariables: ['--primary-color'],
    structuralChange: true,
  });
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
