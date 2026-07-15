import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAlbumPageTargetFromUserText } from '../dist/studio-server.js';

test('parses numbered album page target from Chinese text', () => {
  const target = parseAlbumPageTargetFromUserText(
    '\u7b2c 3 \u9875\u6539\u6210\u5de6\u53f3\u6392\u7248',
    5,
    0,
  );

  assert.equal(target?.index, 2);
  assert.equal(target?.kind, 'numbered');
});

test('parses last album page target from Chinese text', () => {
  const target = parseAlbumPageTargetFromUserText(
    '\u6700\u540e\u4e00\u9875\u5e95\u90e8\u52a0\u56fe\u7247\u4f4d',
    6,
    1,
  );

  assert.equal(target?.index, 5);
  assert.equal(target?.kind, 'last');
});

test('resolves current page wording to selected page index', () => {
  const target = parseAlbumPageTargetFromUserText(
    '\u8fd9\u4e00\u9875\u56fe\u7247\u5927\u4e00\u70b9',
    5,
    3,
  );

  assert.equal(target?.index, 3);
  assert.equal(target?.kind, 'current');
});

test('does not invent a current page target without selected page index', () => {
  assert.equal(
    parseAlbumPageTargetFromUserText('\u8fd9\u4e00\u9875\u56fe\u7247\u5927\u4e00\u70b9', 5),
    null,
  );
});
