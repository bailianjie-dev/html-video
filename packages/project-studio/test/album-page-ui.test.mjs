import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const appSource = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const indexSource = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
const studioServerSource = await readFile(
  new URL('../../cli/src/studio-server.ts', import.meta.url),
  'utf8',
);

test('each album page exposes an add-blank action', () => {
  assert.match(appSource, /data-album-page-action="add-blank"/);
  assert.match(appSource, /在此页后新增空白页/);
  assert.match(appSource, /actionName === 'add-blank'/);
});

test('blank page creation has no editable or visible content', () => {
  const helper = appSource.slice(
    appSource.indexOf('function createBlankAlbumPage'),
    appSource.indexOf('function applyLiveAlbumPageAddBlank'),
  );
  assert.match(helper, /cloneNode\(false\)/);
  assert.match(helper, /hv-blank-page-surface/);
  assert.match(helper, /data-hv-blank-page', 'true'/);
  assert.match(helper, /\['data-hv-text', 'data-hv-image', 'data-hv-cta', 'data-hv-key'\]/);
  assert.match(helper, /\^on\/i/);
  assert.doesNotMatch(helper, /textContent|innerHTML/);
});

test('blank pages remain countable in the editor and thumbnail renderer', () => {
  const blankSelector = /data-hv-blank-page=\\?"true\\?".*hv-blank-page/;
  assert.match(appSource, blankSelector);
  assert.match(studioServerSource, blankSelector);
  assert.match(appSource, /pages = findAlbumPageElements\(doc\);\s*activeIndex = nextIndex/s);
});

test('album thumbnails do not execute authored scripts that reset them to page one', () => {
  const thumbServer = studioServerSource.slice(
    studioServerSource.indexOf('function stripAuthoredScriptsForAlbumThumb'),
    studioServerSource.indexOf('async function readBody'),
  );
  assert.match(thumbServer, /html\.replace\(\/<script/);
  assert.match(thumbServer, /const staticHtml = stripAuthoredScriptsForAlbumThumb\(html\)/);
  assert.match(thumbServer, /staticHtml\.replace\('<\/head>'/);
});

test('structural page changes reload authored page scripts and restore selection', () => {
  const renderPreview = appSource.slice(
    appSource.indexOf('function renderPreview('),
    appSource.indexOf('function getAlbumPagesFromIframe'),
  );
  assert.match(renderPreview, /restoreAlbumPageIndex = null/);
  assert.match(renderPreview, /lockAlbumPageNavigation\(restoreAlbumPageIndex, 2000\)/);
  assert.match(renderPreview, /syncAlbumPagesFromPreview/);

  const saveOperation = appSource.slice(
    appSource.indexOf('async function saveAlbumPageOperation'),
    appSource.indexOf('async function performAlbumPageReorder'),
  );
  assert.match(saveOperation, /reloadPreview = false/);
  assert.match(saveOperation, /restoreAlbumPageIndex: state\.activeAlbumPage/);

  const structuralActions = appSource.slice(
    appSource.indexOf('async function performAlbumPageReorder'),
    appSource.indexOf('let activeAlbumPageDeleteDialog'),
  );
  assert.equal((structuralActions.match(/reloadPreview: true/g) || []).length, 2);
  assert.doesNotMatch(structuralActions, /remountRailAfterSave/);
});

test('page actions keep only a small delete control over the thumbnail', () => {
  assert.match(appSource, /class="album-page-delete"/);
  assert.match(appSource, /class="album-page-edit"/);
  assert.match(appSource, /class="album-page-add-after"/);
  assert.match(indexSource, /\.album-page-delete\s*\{[^}]*width:\s*20px/s);
  assert.match(indexSource, /\.album-page-add-after\s*\{[^}]*border-radius:\s*50%/s);
  assert.doesNotMatch(indexSource, /grid-template-columns:\s*repeat\(3, 22px\)/);
});

test('album pages provide deterministic step ordering controls', () => {
  assert.match(appSource, /data-album-page-action="move-up"/);
  assert.match(appSource, /data-album-page-action="move-down"/);
  assert.match(appSource, /function moveAlbumPageByStep\(pageIndex, delta\)/);
  assert.match(appSource, /action === 'move-up'/);
  assert.match(appSource, /action === 'move-down'/);
  assert.match(appSource, /e\.altKey.*ArrowUp.*ArrowDown/s);
  assert.match(indexSource, /\.album-page-move\s*\{/);
});

test('step ordering rebuilds the rail once from authoritative saved HTML', () => {
  const reorder = appSource.slice(
    appSource.indexOf('async function performAlbumPageReorder'),
    appSource.indexOf('async function performAlbumPageAction'),
  );
  assert.match(reorder, /reloadFramesStrip: true/);
  assert.doesNotMatch(reorder, /applyLiveAlbumPageReorder/);
  assert.doesNotMatch(reorder, /reorderAlbumRailDom/);
  assert.doesNotMatch(reorder, /reloadAlbumThumbnails/);
});

test('consecutive step moves wait for preview readiness and tolerate a settling iframe', () => {
  const renderPreview = appSource.slice(
    appSource.indexOf('function renderPreview('),
    appSource.indexOf('function getAlbumPagesFromIframe'),
  );
  assert.match(renderPreview, /onPreviewReady = null/);
  assert.match(renderPreview, /function renderPreviewAndWait/);
  assert.match(renderPreview, /setTimeout\(finish, timeoutMs\)/);

  const saveAndReorder = appSource.slice(
    appSource.indexOf('async function saveAlbumPageOperation'),
    appSource.indexOf('async function performAlbumPageAction'),
  );
  assert.match(saveAndReorder, /await renderPreviewAndWait\(/);
  assert.doesNotMatch(saveAndReorder, /if \(!liveDoc\) throw/);
});

test('restored structural selection hard-focuses the matching centre page', () => {
  const previewLoad = appSource.slice(
    appSource.indexOf("iframe.addEventListener('load'"),
    appSource.indexOf('function renderPreviewAndWait'),
  );
  assert.match(previewLoad, /focusAlbumPreviewPage\(iframe\.contentDocument, restoreAlbumPageIndex\)/);
});

test('the rail edit action opens the selected page editor directly', () => {
  assert.match(appSource, /data-album-page-action="edit"/);
  assert.match(appSource, /action === 'edit'\) startAlbumPageTextEdit\(pageIndex\)/);
});

test('rewiring the generation workbench preserves active page editing', () => {
  const wireGenerationPage = appSource.slice(
    appSource.indexOf('function wireGenerationPage()'),
    appSource.indexOf('async function sendGenerationQuickAdjust'),
  );
  assert.doesNotMatch(wireGenerationPage, /albumPageTextEditActive\s*=\s*false/);

  const startPageEdit = appSource.slice(
    appSource.indexOf('async function startAlbumPageTextEdit'),
    appSource.indexOf('async function selectAlbumPage'),
  );
  assert.match(startPageEdit, /albumPageTextEditActive\s*=\s*true/);
  assert.match(startPageEdit, /setGenerationSideTab\('edit'/);
});

test('edit-page button binds to the authoritative rail selection', () => {
  assert.match(
    appSource,
    /editPageBtn\.onclick\s*=\s*\(\)\s*=>\s*startAlbumPageTextEdit\(state\.activeAlbumPage\)/,
  );
  assert.match(appSource, /lockAlbumPageNavigation\(safeIndex\)/);
  assert.match(appSource, /acceptPreviewAlbumPageSync\(bestIndex\)/);
  assert.match(appSource, /alignAuthoredAlbumPageMarkers\(pages, safeIndex\)/);
});

test('the selected page has an explicit current-page badge and strong outline', () => {
  assert.match(indexSource, /album-page-item\.active button\.album-page-tab/);
  assert.match(indexSource, /border:\s*3px solid #2563eb/);
  assert.match(indexSource, /content:\s*'当前页'/);
  assert.match(
    indexSource,
    /album-page-tab\.active \.order,[\s\S]*album-page-tab\.active \.page-topic\s*\{\s*color:\s*#2563eb/,
  );
  assert.match(appSource, /aria-current/);
});

test('page deletion uses the styled confirmation dialog instead of native confirm', () => {
  const pageActions = appSource.slice(
    appSource.indexOf('async function performAlbumPageAction'),
    appSource.indexOf('async function openGraphModal'),
  );
  assert.match(pageActions, /await confirmAlbumPageDelete\(index\)/);
  assert.doesNotMatch(pageActions, /\bconfirm\s*\(/);
  assert.match(indexSource, /id="album-page-delete-modal"/);
  assert.match(indexSource, /<h2 id="album-page-delete-title">删除页面<\/h2>/);
  assert.match(indexSource, /id="album-page-delete-cancel">取消<\/button>/);
  assert.match(indexSource, /id="album-page-delete-confirm">删除<\/button>/);
});

test('delete dialog supports cancel, backdrop, Escape, and focus restoration', () => {
  const dialog = appSource.slice(
    appSource.indexOf('function confirmAlbumPageDelete'),
    appSource.indexOf('async function openGraphModal'),
  );
  assert.match(dialog, /event\.key === 'Escape'/);
  assert.match(dialog, /event\.target === modal/);
  assert.match(dialog, /previousFocus\.focus/);
  assert.match(indexSource, /\.album-page-delete-modal \.danger\s*\{[^}]*background:\s*#ef2929/s);
});
