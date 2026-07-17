import assert from 'node:assert/strict';
import test from 'node:test';

import {
  albumPageNavigationTarget,
  createAlbumPageNavigationLock,
  decidePreviewAlbumPageSync,
} from '../public/album-page-navigation.js';

test('rejects a stale first-page callback while a rail click targets page two', () => {
  const lock = createAlbumPageNavigationLock(1, 1000, 1000);
  assert.deepEqual(decidePreviewAlbumPageSync(lock, 0, 1200), {
    accept: false,
    nextLock: lock,
  });
  assert.equal(albumPageNavigationTarget(lock, 1200), 1);
});

test('accepts the selected page and releases the navigation lock', () => {
  const lock = createAlbumPageNavigationLock(1, 1000, 1000);
  assert.deepEqual(decidePreviewAlbumPageSync(lock, 1, 1250), {
    accept: true,
    nextLock: null,
  });
});

test('restores native preview synchronization after the lock expires', () => {
  const lock = createAlbumPageNavigationLock(2, 1000, 500);
  assert.equal(albumPageNavigationTarget(lock, 1501), null);
  assert.deepEqual(decidePreviewAlbumPageSync(lock, 0, 1501), {
    accept: true,
    nextLock: null,
  });
});
