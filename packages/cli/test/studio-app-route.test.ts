import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isStudioAppRoute } from '../dist/studio-server.js';

test('studio app routes are served by the single page app shell', () => {
  assert.equal(isStudioAppRoute('/album-history'), true);
  assert.equal(isStudioAppRoute('/image-album'), true);
  assert.equal(isStudioAppRoute('/style-templates'), true);
  assert.equal(isStudioAppRoute('/album-studio/proj_a5873436-c3d'), true);
  assert.equal(isStudioAppRoute('/album-studio/proj_a5873436-c3d/'), true);
});

test('non-app routes are not treated as studio app routes', () => {
  assert.equal(isStudioAppRoute('/api/projects'), false);
  assert.equal(isStudioAppRoute('/asset'), false);
  assert.equal(isStudioAppRoute('/preview/proj_a5873436-c3d/preview.html'), false);
  assert.equal(isStudioAppRoute('/album-studio'), false);
  assert.equal(isStudioAppRoute('/album-studio/proj_a5873436-c3d/edit'), false);
});
